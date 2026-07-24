import SwiftUI

private enum TaskDetailActionKind {
    case take
    case complete
    case accept
    case revision
    case delete
    case deadline
}

struct TaskDetailView: View {
    let task: TaskItem
    let project: Project
    private let onLocalTaskChange: ((TaskItem) -> Void)?
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var tasksStore: TasksStore
    @Environment(\.dismiss) private var dismiss

    @State private var errorMessage: String?
    @State private var isBusy = false
    @State private var busyAction: TaskDetailActionKind?
    @State private var confirmDelete = false
    @State private var showCompletionSheet = false
    @State private var showRevisionPrompt = false
    @State private var revisionReason = ""
    @State private var confirmAccept = false
    @State private var showDeadlineRequestSheet = false
    @State private var selectedFile: FileRef?

    init(
        task: TaskItem,
        project: Project,
        onLocalTaskChange: ((TaskItem) -> Void)? = nil
    ) {
        self.task = task
        self.project = project
        self.onLocalTaskChange = onLocalTaskChange
    }

    private var current: TaskItem { tasksStore.tasks.first(where: { $0.id == task.id }) ?? task }

    private var isAssignee: Bool {
        guard let uid = appState.user?.uid else { return false }
        return current.assigneeIds.contains(uid)
    }

    private var canManage: Bool {
        appState.user?.canManage(projectId: project.id) == true
    }

    // Доп. постановщик задачи: получает уведомления постановщика и может
    // принять / вернуть на доработку независимо от орг-роли (как в web).
    private var isCoCreator: Bool {
        guard let uid = appState.user?.uid else { return false }
        return current.coCreatorIds.contains(uid)
    }

    // Создатель задачи: исполнитель имеет права постановщика на СВОИ задачи
    private var isTaskCreator: Bool {
        guard let uid = appState.user?.uid else { return false }
        return current.createdByUid == uid
    }

    // Право действовать как постановщик этой задачи: менеджер проекта,
    // СОЗДАТЕЛЬ задачи или доп. постановщик (редактировать/удалять/принять/
    // вернуть). Чужие задачи исполнитель только исполняет.
    private var canActAsCreator: Bool {
        canManage || isCoCreator || isTaskCreator
    }

    private var hasActions: Bool {
        canActAsCreator
        || (isAssignee && current.boardStatus == .assigned)
        || (isAssignee && current.boardStatus == .inProgress)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                headerCard
                detailCard

                if canRequestDeadlineChange {
                    Button {
                        guard !isBusy else { return }
                        showDeadlineRequestSheet = true
                    } label: {
                        Label("Запросить перенос срока", systemImage: "calendar.badge.plus")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                    }
                    .buttonStyle(.bordered)
                    .tint(Theme.primary)
                    .disabled(isBusy)
                }

                if let request = current.deadlineChangeRequest {
                    deadlineRequestBlock(request)
                }

                if !current.descriptionText.isEmpty {
                    infoBlock(title: "Описание", text: current.descriptionText)
                }

                if !current.attachments.isEmpty {
                    filesBlock(title: "Вложения", files: current.attachments)
                }

                if let comment = current.completionComment, !comment.isEmpty {
                    infoBlock(title: "Отчёт исполнителя", text: comment)
                }

                if !current.completionProofs.isEmpty {
                    filesBlock(title: "Файлы подтверждения", files: current.completionProofs)
                }

                if let reason = current.revisionReason, !reason.isEmpty {
                    infoBlock(title: "Возвращена на доработку", text: reason, tint: Theme.warning)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.danger.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 18)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Задача")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if hasActions { actionPanel }
        }
        .alert("Причина возврата", isPresented: $showRevisionPrompt) {
            TextField("Что нужно доработать", text: $revisionReason)
            Button("Вернуть", role: .destructive) { returnForRevision() }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Задача вернётся исполнителю в статус «В работе».")
        }
        #if DEBUG
        .onAppear {
            // --demo-screen task-delete-confirm: сразу открыть диалог удаления
            // (проверка позиционирования диалога над кнопкой в скриншотах)
            if DemoData.isEnabled && DemoData.screen == "task-delete-confirm" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { confirmDelete = true }
            }
        }
        #endif
        .sheet(isPresented: $showCompletionSheet) {
            CompletionSheet(task: current) { comment, proofs in
                guard let user = appState.user else { throw ApiError.notAuthenticated }
                let taskForUpdate = current
                let previous = applyLocalUpdate {
                    $0.subStatus = "completed"
                    $0.status = "in-progress"
                    $0.assigneeCompleted = true
                    $0.completionComment = comment
                    $0.completionProofs = proofs
                    $0.revisionReason = nil
                }
                do {
                    try await tasksStore.completeWithProofs(
                        task: taskForUpdate, projectName: project.name,
                        comment: comment, proofs: proofs, byName: user.displayName
                    )
                } catch {
                    restoreLocal(previous)
                    throw error
                }
            } onFinished: {
                showCompletionSheet = false
                dismiss()
            }
        }
        .sheet(isPresented: $showDeadlineRequestSheet) {
            DeadlineRequestSheet(task: current) { requestedDeadline, comment in
                try await ApiClient.requestDeadlineChange(
                    taskId: current.id,
                    taskCollection: current.taskCollection,
                    requestedDeadline: requestedDeadline,
                    comment: comment
                )
            }
        }
        .sheet(item: $selectedFile) { file in
            FilePreviewView(file: file)
        }
    }

    private var canRequestDeadlineChange: Bool {
        guard isAssignee,
              current.status != "done",
              current.deadlineDate != nil,
              current.deadlineChangeRequest == nil else { return false }
        return true
    }

    private func deadlineRequestBlock(_ request: DeadlineChangeRequest) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Запрос переноса срока", systemImage: "calendar.badge.clock")
                .font(.headline)
                .foregroundStyle(Theme.primary)
            Text("\(request.requestedByName): \(formattedDay(request.currentDeadline)) → \(formattedDay(request.requestedDeadline))")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(request.comment)
                .font(.body)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            if request.createdByUid == appState.user?.uid || isCoCreator {
                HStack(spacing: 10) {
                    Button("Отказать") { decideDeadline(request, approve: false) }
                        .buttonStyle(.bordered)
                        .tint(Theme.warning)
                    Button("Подтвердить") { decideDeadline(request, approve: true) }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.primary)
                }
                .disabled(isBusy)
            } else {
                Text("Ожидает решения постановщика")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.primary.opacity(0.25)))
    }

    private func formattedDay(_ value: String) -> String {
        guard let date = DateFormatter.isoDay.date(from: value) else { return value }
        return DateFormatter.dayMonthYear.string(from: date)
    }

    private func decideDeadline(_ request: DeadlineChangeRequest, approve: Bool) {
        guard !isBusy else { return }
        isBusy = true
        busyAction = .deadline
        errorMessage = nil
        Task {
            defer {
                isBusy = false
                busyAction = nil
            }
            do {
                try await ApiClient.decideDeadlineChange(requestId: request.id, approve: approve)
            } catch {
                errorMessage = "Не удалось обработать перенос срока: \(error.localizedDescription)"
            }
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(current.title)
                .font(.title3.bold())
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                statusPill(current.boardStatus)
                if current.isOverdue {
                    Label("Просрочена", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.danger)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    }

    private var detailCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            detailRow("Проект", project.name)
            divider
            detailRow("Ответственный", current.assignee)
            divider
            detailRow("Срок", formattedDeadline)
            if let created = current.createdAt {
                divider
                detailRow("Создана", DateFormatter.dateTime.string(from: created))
            }
            if !current.createdBy.isEmpty {
                divider
                detailRow("Постановщик", current.createdBy)
            }
            if !current.coCreators.isEmpty {
                divider
                detailRow("Доп. постановщики", current.coCreators)
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    }

    private var divider: some View {
        Divider()
            .background(Theme.textSecondary.opacity(0.18))
            .padding(.horizontal, 14)
    }

    private var formattedDeadline: String {
        guard let deadline = current.deadline,
              let date = DateFormatter.isoDay.date(from: deadline) else {
            return "Без срока"
        }
        return DateFormatter.dayMonthYear.string(from: date)
    }

    private var actionPanel: some View {
        HStack(alignment: .bottom) {
            if canActAsCreator {
                actionCircleButton(
                    "Удалить",
                    icon: "trash.fill",
                    tint: Theme.danger,
                    filled: false,
                    showsTitle: false,
                    role: .destructive,
                    kind: .delete
                ) {
                    confirmDelete = true
                }
                .confirmationDialog(
                    "Удалить задачу «\(current.title)»? Действие необратимо.",
                    isPresented: $confirmDelete,
                    titleVisibility: .visible
                ) {
                    Button("Удалить", role: .destructive) { deleteTask() }
                    Button("Отмена", role: .cancel) {}
                }
            }

            Spacer(minLength: 12)

            HStack(alignment: .bottom, spacing: 18) {
                if isAssignee && current.boardStatus == .assigned {
                    actionCircleButton("В работу", icon: "briefcase.fill", tint: Theme.primary, kind: .take) {
                        takeToWork()
                    }
                }

                if isAssignee && current.boardStatus == .inProgress {
                    actionCircleButton("Завершить", icon: "clock.fill", tint: Theme.statusReview, kind: .complete) {
                        showCompletionSheet = true
                    }
                }

                if canActAsCreator && current.boardStatus == .review {
                    actionCircleButton(
                        "Вернуть",
                        icon: "arrow.uturn.backward",
                        tint: Theme.warning,
                        filled: false,
                        kind: .revision
                    ) {
                        revisionReason = ""
                        showRevisionPrompt = true
                    }

                    actionCircleButton("Принять", icon: "checkmark", tint: Theme.statusDone, kind: .accept) {
                        confirmAccept = true
                    }
                    .confirmationDialog(
                        "Принять задачу в «Готово»? Исполнителям начислится XP.",
                        isPresented: $confirmAccept,
                        titleVisibility: .visible
                    ) {
                        Button("Принять") { acceptDone() }
                        Button("Отмена", role: .cancel) {}
                    }
                }
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    @ViewBuilder
    private func actionCircleButton(
        _ title: String,
        icon: String,
        tint: Color,
        filled: Bool = true,
        showsTitle: Bool = true,
        role: ButtonRole? = nil,
        kind: TaskDetailActionKind,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role) {
            action()
        } label: {
            VStack(spacing: 7) {
                ZStack {
                    actionCircleSurface(tint: tint, filled: filled)
                    Circle()
                        .stroke(filled ? .clear : tint.opacity(0.48), lineWidth: 1.2)

                    if busyAction == kind {
                        ProgressView()
                            .tint(filled ? .white : tint)
                    } else {
                        Image(systemName: icon)
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(filled ? .white : tint)
                    }
                }
                .frame(width: 58, height: 58)
                .shadow(color: filled ? tint.opacity(0.28) : .clear, radius: 12, y: 6)

                if showsTitle {
                    Text(title)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(tint)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(width: 76)
                } else {
                    Color.clear
                        .frame(width: 76, height: 12)
                        .accessibilityHidden(true)
                }
            }
        }
        .accessibilityLabel(title)
        .buttonStyle(PressableStyle())
        .disabled(isBusy)
    }

    @ViewBuilder
    private func actionCircleSurface(tint: Color, filled: Bool) -> some View {
        if filled {
            Circle()
                .fill(tint)
        } else if #available(iOS 26.0, *) {
            Circle()
                .fill(tint.opacity(0.08))
                .glassEffect(.regular.tint(tint.opacity(0.18)).interactive(), in: .circle)
        } else {
            Circle()
                .fill(.ultraThinMaterial)
                .overlay(Circle().fill(tint.opacity(0.10)))
        }
    }

    @ViewBuilder
    private func fileLink(_ file: FileRef) -> some View {
        Button {
            guard !isBusy else { return }
            selectedFile = file
        } label: {
            HStack {
                Image(systemName: filePreviewIcon(file))
                    .foregroundStyle(Theme.primary)
                Text(file.name)
                    .font(.footnote)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Spacer()
                Image(systemName: "eye.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .buttonStyle(.plain)
        .padding(12)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel("Открыть файл \(file.name)")
        .disabled(isBusy)
    }

    private func filePreviewIcon(_ file: FileRef) -> String {
        switch file.type {
        case "image": return "photo.fill"
        case "pdf": return "doc.richtext.fill"
        case "word": return "doc.text.fill"
        case "excel": return "tablecells.fill"
        case "archive": return "archivebox.fill"
        default: return file.name.lowercased().hasSuffix(".md") ? "text.document.fill" : "doc.fill"
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize() // метка не переносится по слогам («Ответствен-ный»)
                .layoutPriority(1)
            Spacer(minLength: 12)
            Text(value)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
    }

    private func infoBlock(title: String, text: String, tint: Color = Theme.textPrimary) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.textSecondary)
            Text(text)
                .font(.body)
                .foregroundStyle(tint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
        }
    }

    private func filesBlock(title: String, files: [FileRef]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.textSecondary)
            VStack(spacing: 8) {
                ForEach(files) { file in
                    fileLink(file)
                }
            }
        }
    }

    private func statusPill(_ status: BoardStatus) -> some View {
        HStack(spacing: 6) {
            Image(systemName: status.icon)
                .font(.system(size: 10, weight: .bold))
            Text(status.singleRu)
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(Theme.color(for: status))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Theme.color(for: status).opacity(0.14), in: Capsule())
        .overlay(Capsule().stroke(Theme.color(for: status).opacity(0.36), lineWidth: 1))
    }

    private func takeToWork() {
        guard !isBusy, let user = appState.user else { return }
        isBusy = true
        busyAction = .take
        errorMessage = nil
        let taskForUpdate = current
        let previous = applyLocalUpdate {
            $0.subStatus = "in_work"
            $0.status = "in-progress"
            $0.assigneeCompleted = false
            $0.completionComment = nil
            $0.completionProofs = []
            $0.revisionReason = nil
        }
        Task {
            defer {
                isBusy = false
                busyAction = nil
            }
            do {
                try await tasksStore.takeToWork(task: taskForUpdate, byName: user.displayName)
                dismiss()
            } catch {
                restoreLocal(previous)
                errorMessage = "Не удалось взять задачу в работу: \(error.localizedDescription)"
            }
        }
    }

    private func deleteTask() {
        guard !isBusy else { return }
        isBusy = true
        busyAction = .delete
        errorMessage = nil
        Task {
            defer {
                isBusy = false
                busyAction = nil
            }
            do {
                try await tasksStore.delete(task: current)
                dismiss()
            } catch {
                errorMessage = "Не удалось удалить задачу: \(error.localizedDescription)"
            }
        }
    }

    private func acceptDone() {
        guard !isBusy, let user = appState.user else { return }
        isBusy = true
        busyAction = .accept
        errorMessage = nil
        let taskForUpdate = current
        let previous = applyLocalUpdate {
            $0.status = "done"
            $0.subStatus = "completed"
            $0.assigneeCompleted = true
        }
        Task {
            defer {
                isBusy = false
                busyAction = nil
            }
            do {
                try await tasksStore.acceptDone(task: taskForUpdate, projectName: project.name, byName: user.displayName)
                dismiss()
            } catch {
                restoreLocal(previous)
                errorMessage = "Не удалось принять задачу: \(error.localizedDescription)"
            }
        }
    }

    private func returnForRevision() {
        let reason = revisionReason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isBusy, !reason.isEmpty, let user = appState.user else { return }
        isBusy = true
        busyAction = .revision
        errorMessage = nil
        let taskForUpdate = current
        let previous = applyLocalUpdate {
            $0.subStatus = "in_work"
            $0.status = "in-progress"
            $0.assigneeCompleted = false
            $0.revisionReason = reason
        }
        Task {
            defer {
                isBusy = false
                busyAction = nil
            }
            do {
                try await tasksStore.returnForRevision(task: taskForUpdate, reason: reason, byName: user.displayName)
                dismiss()
            } catch {
                restoreLocal(previous)
                errorMessage = "Не удалось вернуть задачу: \(error.localizedDescription)"
            }
        }
    }

    private func applyLocalUpdate(_ mutate: (inout TaskItem) -> Void) -> TaskItem {
        let previous = current
        var next = current
        mutate(&next)
        tasksStore.replaceLocal(next)
        onLocalTaskChange?(next)
        return previous
    }

    private func restoreLocal(_ task: TaskItem) {
        tasksStore.replaceLocal(task)
        onLocalTaskChange?(task)
    }
}

private struct DeadlineRequestSheet: View {
    let task: TaskItem
    let onSubmit: (String, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var requestedDate: Date
    @State private var comment = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var minimumDate: Date {
        Calendar.current.date(byAdding: .day, value: 1, to: task.deadlineDate ?? Date()) ?? Date()
    }

    init(task: TaskItem, onSubmit: @escaping (String, String) async throws -> Void) {
        self.task = task
        self.onSubmit = onSubmit
        let base = task.deadlineDate ?? Date()
        _requestedDate = State(initialValue: Calendar.current.date(byAdding: .day, value: 1, to: base) ?? base)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Срок") {
                    LabeledContent("Текущий", value: task.deadlineDate.map(DateFormatter.dayMonthYear.string) ?? "Не указан")
                    DatePicker(
                        "Желаемый *",
                        selection: $requestedDate,
                        in: minimumDate...,
                        displayedComponents: .date
                    )
                }

                Section("Причина переноса *") {
                    TextEditor(text: $comment)
                        .frame(minHeight: 120)
                    Text("Комментарий и новый срок обязательны.")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("Перенос срока")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Отправить") { submit() }
                        .disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
                }
            }
            .interactiveDismissDisabled(isSubmitting)
        }
    }

    private func submit() {
        let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isSubmitting, !trimmed.isEmpty else { return }
        isSubmitting = true
        errorMessage = nil
        Task {
            do {
                try await onSubmit(DateFormatter.isoDay.string(from: requestedDate), trimmed)
                dismiss()
            } catch {
                isSubmitting = false
                errorMessage = error.localizedDescription
            }
        }
    }
}
