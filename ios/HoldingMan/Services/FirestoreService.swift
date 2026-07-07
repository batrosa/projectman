import Foundation
import FirebaseAuth
import FirebaseFirestore

// Живые подписки на те же коллекции и с теми же фильтрами, что web-клиент:
// проекты по organizationId, задачи по projectId, уведомления по uid+org.
// Firestore rules — общие, iOS не получает ничего сверх web-доступа.
@MainActor
final class ProjectsStore: ObservableObject {
    @Published var projects: [Project] = []
    @Published var loaded = false
    private var listener: ListenerRegistration?

    func subscribe(organizationId: String, user: UserDoc) {
        listener?.remove()
        loaded = false
        listener = Firestore.firestore().collection("projects")
            .whereField("organizationId", isEqualTo: organizationId)
            .addSnapshotListener { [weak self] snapshot, _ in
                Task { @MainActor [weak self] in
                    guard let self, let snapshot else { return }
                    let all = snapshot.documents.map { Project.from(id: $0.documentID, data: $0.data()) }
                    // Как getFilteredProjects в web: доступ по allowedProjects
                    self.projects = all
                        .filter { user.canSee(projectId: $0.id) }
                        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                    self.loaded = true
                }
            }
    }

    func stop() {
        listener?.remove()
        listener = nil
        projects = []
        loaded = false
    }

    #if DEBUG
    func loadDemo() {
        projects = DemoData.projects
        loaded = true
    }
    #endif
}

@MainActor
final class TasksStore: ObservableObject {
    @Published var tasks: [TaskItem] = []
    @Published var loaded = false
    private var listener: ListenerRegistration?

    func subscribe(projectId: String) {
        #if DEBUG
        if DemoData.isEnabled {
            tasks = DemoData.tasks.filter { $0.projectId == projectId }
            loaded = true
            return
        }
        #endif
        listener?.remove()
        loaded = false
        tasks = []
        listener = Firestore.firestore().collection("tasks")
            .whereField("projectId", isEqualTo: projectId)
            .addSnapshotListener { [weak self] snapshot, _ in
                Task { @MainActor [weak self] in
                    guard let self, let snapshot else { return }
                    self.tasks = snapshot.documents.map { TaskItem.from(id: $0.documentID, data: $0.data()) }
                    self.loaded = true
                }
            }
    }

    func stop() {
        listener?.remove()
        listener = nil
        tasks = []
        loaded = false
    }

    func tasks(in column: BoardStatus) -> [TaskItem] {
        tasks
            .filter { $0.boardStatus == column }
            .sorted { ($0.deadline ?? "9999") < ($1.deadline ?? "9999") }
    }

    // «Взять в работу» — та же форма записи, что updateTaskSubStatus('in_work')
    // в web-клиенте (правила рассчитаны именно на неё).
    func takeToWork(task: TaskItem, byName: String) async throws {
        let updates: [String: Any] = [
            "subStatus": "in_work",
            "status": "in-progress",
            "takenToWorkAt": ISO8601DateFormatter().string(from: Date()),
            "takenToWorkBy": byName,
            "completedAt": NSNull(),
            "completionComment": NSNull(),
            "completionProof": NSNull(),
            "completionProofs": NSNull(),
            "completedBy": NSNull(),
            "archivedAt": NSNull(),
            "archivedBy": NSNull(),
        ]
        try await Firestore.firestore().collection("tasks").document(task.id).updateData(updates)
    }

    // Удаление задачи менеджером — как в web deleteTask(): просто удаление
    // документа, правила проверяют canManageProject.
    func delete(task: TaskItem) async throws {
        try await Firestore.firestore().collection("tasks").document(task.id).delete()
    }

    // Создание задачи менеджером — форма полей ровно как createTask() в web
    // (включая многосоставные assignee / assigneeEmail при нескольких
    // исполнителях). Каждому исполнителю уходит событие task_created
    // (Telegram при наличии + push + лента «Уведомления»).
    func create(projectId: String, projectName: String, organizationId: String, title: String,
                descriptionText: String, deadline: String?, creator: UserDoc,
                assignees: [OrgUser]) async throws {
        let assigneeDisplay = assignees.isEmpty
            ? "Не назначен"
            : assignees.map(\.displayName).joined(separator: ", ")
        let data: [String: Any] = [
            "projectId": projectId,
            "organizationId": organizationId,
            "title": title,
            "description": descriptionText,
            "assignee": assigneeDisplay,
            "assigneeEmail": assignees.map(\.email).filter { !$0.isEmpty }.joined(separator: ","),
            "assigneeIds": assignees.map(\.id),
            "deadline": deadline as Any,
            "status": "in-progress",
            "subStatus": "assigned",
            "assigneeCompleted": false,
            "assignedAt": FieldValue.serverTimestamp(),
            "attachments": [Any](),
            "createdAt": FieldValue.serverTimestamp(),
            "createdBy": creator.displayName,
            "createdByEmail": creator.email,
            "createdByUid": creator.uid,
        ]
        let ref = try await Firestore.firestore().collection("tasks").addDocument(data: data)

        let text = """
        📋 <b>Новая задача!</b>

        <b>Задача:</b> \(title)
        <b>Проект:</b> \(projectName)
        <b>Срок:</b> \(deadline ?? "Не указан")
        """
        for assignee in assignees {
            let uid = assignee.id
            Task {
                try? await ApiClient.sendTaskEvent(
                    recipientUid: uid, text: text,
                    type: "task_created", taskId: ref.documentID, projectId: projectId
                )
            }
        }
    }

    // «Завершить задачу» исполнителем — ровно web updateTaskSubStatus
    // ('completed', {comment, proofs}): серверный completedAt (правила требуют
    // request.time), отчёт + файлы подтверждения, очистка полей доработки.
    // Постановщику уходит событие task_completed («задача на проверке»).
    func completeWithProofs(task: TaskItem, projectName: String, comment: String,
                            proofs: [FileRef], byName: String) async throws {
        let updates: [String: Any] = [
            "subStatus": "completed",
            "status": "in-progress",
            "assigneeCompleted": true,
            "completedAt": FieldValue.serverTimestamp(),
            "completionComment": comment,
            "completionProofs": proofs.map(\.dict),
            "completionProof": NSNull(),
            "completedBy": byName,
            "revisionReason": NSNull(),
            "revisionReturnedBy": NSNull(),
            "revisionReturnedAt": NSNull(),
        ]
        try await Firestore.firestore().collection("tasks").document(task.id).updateData(updates)

        if let creatorUid = task.createdByUid {
            let text = """
            📤 <b>Задача на проверке</b>

            <b>Проект:</b> \(projectName)
            <b>Задача:</b> \(task.title)
            <b>Исполнитель:</b> \(byName)

            Пожалуйста, проверьте выполнение задачи.
            """
            Task {
                try? await ApiClient.sendTaskEvent(
                    recipientUid: creatorUid, text: text,
                    type: "task_completed", taskId: task.id, projectId: task.projectId
                )
            }
        }
    }

    // «Принять в Готово» менеджером — web updateTaskSubStatus('done') + XP
    // начисляется СЕРВЕРОМ (api/award-xp). Исполнителям уходит task_done.
    func acceptDone(task: TaskItem, projectName: String, byName: String) async throws {
        let updates: [String: Any] = [
            "status": "done",
            "subStatus": "completed",
            "archivedAt": ISO8601DateFormatter().string(from: Date()),
            "archivedBy": byName,
            "completedOnTime": false,
            "xpAwarded": true,
        ]
        try await Firestore.firestore().collection("tasks").document(task.id).updateData(updates)
        try await ApiClient.awardXp(taskId: task.id)

        let text = """
        ✅ <b>Задача принята!</b>

        <b>Проект:</b> \(projectName)
        <b>Задача:</b> \(task.title)

        Руководитель принял выполнение. Отличная работа!
        """
        for uid in task.assigneeIds {
            Task {
                try? await ApiClient.sendTaskEvent(
                    recipientUid: uid, text: text,
                    type: "task_done", taskId: task.id, projectId: task.projectId
                )
            }
        }
    }

    // «Вернуть на доработку» менеджером — web updateTaskSubStatus('in_work',
    // null, revisionData): задача снова в работе с причиной возврата.
    // Исполнителям уходит task_revision.
    func returnForRevision(task: TaskItem, reason: String, byName: String) async throws {
        let updates: [String: Any] = [
            "subStatus": "in_work",
            "status": "in-progress",
            "takenToWorkAt": ISO8601DateFormatter().string(from: Date()),
            "takenToWorkBy": byName,
            "completedAt": NSNull(),
            "completionComment": NSNull(),
            "completionProof": NSNull(),
            "completionProofs": NSNull(),
            "completedBy": NSNull(),
            "archivedAt": NSNull(),
            "archivedBy": NSNull(),
            "revisionReason": reason,
            "revisionReturnedBy": byName,
            "revisionReturnedAt": ISO8601DateFormatter().string(from: Date()),
            "wasReturned": true,
        ]
        try await Firestore.firestore().collection("tasks").document(task.id).updateData(updates)

        let text = """
        🔄 <b>Задача возвращена на доработку</b>

        <b>Задача:</b> \(task.title)

        <b>Причина:</b>
        \(reason)

        <b>Вернул:</b> \(byName)
        """
        for uid in task.assigneeIds {
            Task {
                try? await ApiClient.sendTaskEvent(
                    recipientUid: uid, text: text,
                    type: "task_revision", taskId: task.id, projectId: task.projectId
                )
            }
        }
    }
}

// Участники организации — для выбора исполнителей и Telegram-уведомлений.
@MainActor
final class OrgUsersStore: ObservableObject {
    @Published var users: [OrgUser] = []
    private var listener: ListenerRegistration?

    func subscribe(organizationId: String) {
        listener?.remove()
        listener = Firestore.firestore().collection("users")
            .whereField("organizationId", isEqualTo: organizationId)
            .addSnapshotListener { [weak self] snapshot, _ in
                Task { @MainActor [weak self] in
                    guard let self, let snapshot else { return }
                    self.users = snapshot.documents
                        .map { OrgUser.from(uid: $0.documentID, data: $0.data()) }
                        .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
                }
            }
    }

    func stop() {
        listener?.remove()
        listener = nil
        users = []
    }

    func assignable(projectId: String) -> [OrgUser] {
        users.filter { $0.canBeAssigned(projectId: projectId) }
    }

    #if DEBUG
    func loadDemo() { users = DemoData.orgUsers }
    #endif
}

// «Мои задачи»: активные задачи, где текущий пользователь — исполнитель.
// КАК В WEB: подписки по projectId доступных проектов (чанки where-in по 10)
// с клиентским фильтром «я в assigneeIds». Прямой запрос по всей организации
// (organizationId == + assigneeIds contains) ПРАВИЛА FIRESTORE НЕ ПРОПУСКАЮТ:
// правило read проверяет доступ через get(projects/{resource.data.projectId}),
// что вычислимо только при зафиксированном в запросе projectId — серверный
// слушатель всегда получал permission-denied и список жил на кэше
// (прод-баг «обновляется только после перезапуска»).
@MainActor
final class MyTasksStore: ObservableObject {
    @Published var tasks: [TaskItem] = []
    private var listeners: [ListenerRegistration] = []
    private var chunkResults: [Int: [TaskItem]] = [:]
    private var currentUid = ""

    func subscribe(uid: String, projects: [Project]) {
        stopListeners()
        currentUid = uid
        guard !uid.isEmpty, !projects.isEmpty else {
            tasks = []
            return
        }

        let projectIds = projects.map(\.id)
        let chunks = stride(from: 0, to: projectIds.count, by: 10).map {
            Array(projectIds[$0..<min($0 + 10, projectIds.count)])
        }

        for (index, chunk) in chunks.enumerated() {
            let listener = Firestore.firestore().collection("tasks")
                .whereField("projectId", in: chunk)
                .addSnapshotListener { [weak self] snapshot, error in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if let error {
                            print("my-tasks listener error (chunk \(index)):", error.localizedDescription)
                            return
                        }
                        guard let snapshot else { return }
                        self.chunkResults[index] = snapshot.documents.map {
                            TaskItem.from(id: $0.documentID, data: $0.data())
                        }
                        self.rebuild()
                    }
                }
            listeners.append(listener)
        }
    }

    private func rebuild() {
        tasks = chunkResults.values.flatMap { $0 }
            .filter { $0.assigneeIds.contains(currentUid) && $0.status != "done" }
            .sorted { ($0.deadline ?? "9999") < ($1.deadline ?? "9999") }
    }

    private func stopListeners() {
        listeners.forEach { $0.remove() }
        listeners = []
        chunkResults = [:]
    }

    func stop() {
        stopListeners()
        tasks = []
    }

    #if DEBUG
    func loadDemo() { tasks = DemoData.myTasks }
    #endif
}

@MainActor
final class NotificationsStore: ObservableObject {
    @Published var notifications: [AgentNotification] = []
    private var listener: ListenerRegistration?

    var unreadCount: Int { notifications.filter { $0.readAt == nil }.count }

    func subscribe(uid: String, organizationId: String) {
        listener?.remove()
        listener = Firestore.firestore().collection("agentNotifications")
            .whereField("uid", isEqualTo: uid)
            .whereField("organizationId", isEqualTo: organizationId)
            .order(by: "createdAt", descending: true)
            .limit(to: 100)
            .addSnapshotListener { [weak self] snapshot, _ in
                Task { @MainActor [weak self] in
                    guard let self, let snapshot else { return }
                    self.notifications = snapshot.documents.map {
                        AgentNotification.from(id: $0.documentID, data: $0.data())
                    }
                }
            }
    }

    func stop() {
        listener?.remove()
        listener = nil
        notifications = []
    }

    func markRead(_ notification: AgentNotification) {
        guard notification.readAt == nil else { return }
        #if DEBUG
        if DemoData.isEnabled {
            if let index = notifications.firstIndex(where: { $0.id == notification.id }) {
                notifications[index].readAt = Date()
            }
            return
        }
        #endif
        Firestore.firestore().collection("agentNotifications")
            .document(notification.id)
            .updateData(["readAt": FieldValue.serverTimestamp()])
    }

    #if DEBUG
    func loadDemo() { notifications = DemoData.notifications }
    #endif
}
