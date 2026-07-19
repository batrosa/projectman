import Foundation
import FirebaseAuth
import FirebaseFirestore

private func telegramHTML(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
}

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

    func create(
        organizationId: String,
        user: UserDoc,
        name: String,
        description: String,
        deadline: String?
    ) async throws {
        guard user.orgRole == "owner" || user.orgRole == "admin" else {
            throw ApiError.server("Недостаточно прав для создания проекта")
        }

        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            throw ApiError.server("Введите название проекта")
        }

        #if DEBUG
        if DemoData.isEnabled {
            projects.append(Project(
                id: UUID().uuidString,
                name: trimmedName,
                description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                deadline: deadline
            ))
            projects.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            loaded = true
            return
        }
        #endif

        var data: [String: Any] = [
            "name": trimmedName,
            "description": description.trimmingCharacters(in: .whitespacesAndNewlines),
            "organizationId": organizationId,
            "createdAt": FieldValue.serverTimestamp()
        ]
        if let deadline {
            data["deadline"] = deadline
        }

        _ = try await Firestore.firestore().collection("projects").addDocument(data: data)
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

    func replaceLocal(_ task: TaskItem) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        } else {
            tasks.append(task)
        }
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

        <b>Задача:</b> \(telegramHTML(title))
        <b>Проект:</b> \(telegramHTML(projectName))
        <b>Срок:</b> \(telegramHTML(DateFormatter.displayDay(deadline, fallback: "Не указан")))
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

            <b>Проект:</b> \(telegramHTML(projectName))
            <b>Задача:</b> \(telegramHTML(task.title))
            <b>Исполнитель:</b> \(telegramHTML(byName))

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

        <b>Проект:</b> \(telegramHTML(projectName))
        <b>Задача:</b> \(telegramHTML(task.title))

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

        <b>Задача:</b> \(telegramHTML(task.title))

        <b>Причина:</b>
        \(telegramHTML(reason))

        <b>Вернул:</b> \(telegramHTML(byName))
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

// Сводная лента задач по доступным проектам. Читаем не по organizationId,
// а чанками projectId, потому что Firestore rules проверяют доступ через проект.
@MainActor
final class ProjectTasksStore: ObservableObject {
    @Published var tasks: [TaskItem] = []
    @Published var loaded = false
    private var listeners: [ListenerRegistration] = []
    private var chunkResults: [Int: [TaskItem]] = [:]
    private var expectedChunks = 0

    func subscribe(projects: [Project]) {
        stopListeners()
        let projectIds = projects.map(\.id)
        guard !projectIds.isEmpty else {
            tasks = []
            loaded = true
            return
        }

        #if DEBUG
        if DemoData.isEnabled {
            tasks = DemoData.tasks
                .filter { projectIds.contains($0.projectId) }
                .sorted(by: Self.sortByDeadline)
            loaded = true
            return
        }
        #endif

        loaded = false
        tasks = []
        let chunks = stride(from: 0, to: projectIds.count, by: 10).map {
            Array(projectIds[$0..<min($0 + 10, projectIds.count)])
        }
        expectedChunks = chunks.count

        for (index, chunk) in chunks.enumerated() {
            let listener = Firestore.firestore().collection("tasks")
                .whereField("projectId", in: chunk)
                .addSnapshotListener { [weak self] snapshot, error in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if let error {
                            print("project-tasks listener error (chunk \(index)):", error.localizedDescription)
                            self.chunkResults[index] = []
                            self.rebuild()
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
            .sorted(by: Self.sortByDeadline)
        loaded = chunkResults.count >= expectedChunks
    }

    private static func sortByDeadline(_ lhs: TaskItem, _ rhs: TaskItem) -> Bool {
        let left = lhs.deadline ?? "9999-12-31"
        let right = rhs.deadline ?? "9999-12-31"
        if left != right { return left < right }
        return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
    }

    private func stopListeners() {
        listeners.forEach { $0.remove() }
        listeners = []
        chunkResults = [:]
        expectedChunks = 0
    }

    func stop() {
        stopListeners()
        tasks = []
        loaded = false
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

    func replaceLocal(_ task: TaskItem) {
        for key in chunkResults.keys {
            guard let index = chunkResults[key]?.firstIndex(where: { $0.id == task.id }) else { continue }
            if task.assigneeIds.contains(currentUid), task.status != "done" {
                chunkResults[key]?[index] = task
            } else {
                chunkResults[key]?.remove(at: index)
            }
            rebuild()
            return
        }

        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            if task.assigneeIds.contains(currentUid), task.status != "done" {
                tasks[index] = task
            } else {
                tasks.remove(at: index)
            }
            tasks.sort { ($0.deadline ?? "9999") < ($1.deadline ?? "9999") }
            return
        }

        if task.assigneeIds.contains(currentUid), task.status != "done" {
            tasks.append(task)
            tasks.sort { ($0.deadline ?? "9999") < ($1.deadline ?? "9999") }
        }
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

    func markAllRead() {
        let unread = notifications.filter { $0.readAt == nil }
        guard !unread.isEmpty else { return }

        #if DEBUG
        if DemoData.isEnabled {
            let now = Date()
            for index in notifications.indices where notifications[index].readAt == nil {
                notifications[index].readAt = now
            }
            return
        }
        #endif

        let now = Date()
        for index in notifications.indices where notifications[index].readAt == nil {
            notifications[index].readAt = now
        }

        let db = Firestore.firestore()
        let batch = db.batch()
        for notification in unread {
            let ref = db.collection("agentNotifications").document(notification.id)
            batch.updateData(["readAt": FieldValue.serverTimestamp()], forDocument: ref)
        }
        batch.commit { error in
            if let error {
                print("notifications mark all read failed:", error.localizedDescription)
            }
        }
    }

    func deleteAll() async throws {
        let ids = notifications.map(\.id)
        guard !ids.isEmpty else { return }

        #if DEBUG
        if DemoData.isEnabled {
            notifications = []
            return
        }
        #endif

        try await ApiClient.deleteAgentNotifications(ids: ids)
    }

    #if DEBUG
    func loadDemo() { notifications = DemoData.notifications }
    #endif
}
