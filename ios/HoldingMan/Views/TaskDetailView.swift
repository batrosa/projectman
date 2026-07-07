import SwiftUI

struct TaskDetailView: View {
    let task: TaskItem
    let project: Project
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var tasksStore: TasksStore
    @Environment(\.dismiss) private var dismiss

    @State private var errorMessage: String?
    @State private var isBusy = false
    @State private var confirmDelete = false
    @State private var showCompletionSheet = false
    @State private var showRevisionPrompt = false
    @State private var revisionReason = ""
    @State private var confirmAccept = false

    private var current: TaskItem { tasksStore.tasks.first(where: { $0.id == task.id }) ?? task }

    private var isAssignee: Bool {
        guard let uid = appState.user?.uid else { return false }
        return current.assigneeIds.contains(uid)
    }

    private var canManage: Bool {
        appState.user?.canManage(projectId: project.id) == true
    }

    private var hasActions: Bool {
        canManage
        || (isAssignee && current.boardStatus == .assigned)
        || (isAssignee && current.boardStatus == .inProgress)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                headerCard
                detailCard

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
                try await tasksStore.completeWithProofs(
                    task: current, projectName: project.name,
                    comment: comment, proofs: proofs, byName: user.displayName
                )
            } onFinished: {
                showCompletionSheet = false
                dismiss()
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
        VStack(spacing: 10) {
            if isAssignee && current.boardStatus == .assigned {
                taskActionButton("Взять в работу", icon: "play.fill", tint: Theme.primary) {
                    takeToWork()
                }
            }

            if isAssignee && current.boardStatus == .inProgress {
                taskActionButton("Завершить задачу", icon: "checkmark.seal.fill", tint: Theme.statusDone) {
                    showCompletionSheet = true
                }
            }

            if canManage && current.boardStatus == .review {
                taskActionButton("Принять в «Готово»", icon: "checkmark.circle.fill", tint: Theme.statusDone) {
                    confirmAccept = true
                }
                // Диалог привязан к кнопке — появляется над ней, не в центре экрана
                .confirmationDialog(
                    "Принять задачу в «Готово»? Исполнителям начислится XP.",
                    isPresented: $confirmAccept,
                    titleVisibility: .visible
                ) {
                    Button("Принять") { acceptDone() }
                    Button("Отмена", role: .cancel) {}
                }

                taskActionButton("Вернуть на доработку", icon: "arrow.uturn.backward", tint: Theme.warning, filled: false) {
                    revisionReason = ""
                    showRevisionPrompt = true
                }
            }

            if canManage {
                taskActionButton("Удалить задачу", icon: "trash", tint: Theme.danger, filled: false, role: .destructive) {
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
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private func fileLink(_ file: FileRef) -> some View {
        if let url = URL(string: file.url) {
            Link(destination: url) {
                HStack {
                    Image(systemName: file.type == "image" ? "photo" : "doc.fill")
                        .foregroundStyle(Theme.primary)
                    Text(file.name)
                        .font(.footnote)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "arrow.up.right.square")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .padding(12)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
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
            Circle()
                .fill(Theme.color(for: status))
                .frame(width: 8, height: 8)
            Text(status.singleRu)
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(Theme.color(for: status))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Theme.color(for: status).opacity(0.14), in: Capsule())
        .overlay(Capsule().stroke(Theme.color(for: status).opacity(0.36), lineWidth: 1))
    }

    private func taskActionButton(
        _ title: String,
        icon: String,
        tint: Color,
        filled: Bool = true,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role) {
            action()
        } label: {
            HStack(spacing: 10) {
                if isBusy {
                    ProgressView().tint(filled ? .white : tint)
                } else {
                    Image(systemName: icon)
                        .font(.headline)
                    Text(title)
                        .font(.headline.weight(.semibold))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .foregroundStyle(filled ? .white : tint)
            .background(
                filled ? tint : tint.opacity(0.13),
                in: RoundedRectangle(cornerRadius: 14)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(filled ? .clear : tint.opacity(0.35), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }

    private func takeToWork() {
        guard let user = appState.user else { return }
        isBusy = true
        errorMessage = nil
        Task {
            defer { isBusy = false }
            do {
                try await tasksStore.takeToWork(task: current, byName: user.displayName)
                dismiss()
            } catch {
                errorMessage = "Не удалось взять задачу в работу: \(error.localizedDescription)"
            }
        }
    }

    private func deleteTask() {
        isBusy = true
        errorMessage = nil
        Task {
            defer { isBusy = false }
            do {
                try await tasksStore.delete(task: current)
                dismiss()
            } catch {
                errorMessage = "Не удалось удалить задачу: \(error.localizedDescription)"
            }
        }
    }

    private func acceptDone() {
        guard let user = appState.user else { return }
        isBusy = true
        errorMessage = nil
        Task {
            defer { isBusy = false }
            do {
                try await tasksStore.acceptDone(task: current, projectName: project.name, byName: user.displayName)
                dismiss()
            } catch {
                errorMessage = "Не удалось принять задачу: \(error.localizedDescription)"
            }
        }
    }

    private func returnForRevision() {
        let reason = revisionReason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty, let user = appState.user else { return }
        isBusy = true
        errorMessage = nil
        Task {
            defer { isBusy = false }
            do {
                try await tasksStore.returnForRevision(task: current, reason: reason, byName: user.displayName)
                dismiss()
            } catch {
                errorMessage = "Не удалось вернуть задачу: \(error.localizedDescription)"
            }
        }
    }
}
