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

    // Живая версия задачи из стора (обновляется листенером)
    private var current: TaskItem { tasksStore.tasks.first(where: { $0.id == task.id }) ?? task }

    private var isAssignee: Bool {
        guard let uid = appState.user?.uid else { return false }
        return current.assigneeIds.contains(uid)
    }

    private var canManage: Bool {
        appState.user?.canManage(projectId: project.id) == true
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text(current.title)
                        .font(.title3.bold())
                        .foregroundStyle(Theme.textPrimary)

                    HStack(spacing: 6) {
                        Circle()
                            .fill(Theme.color(for: current.boardStatus))
                            .frame(width: 9, height: 9)
                        Text(current.boardStatus.singleRu)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.color(for: current.boardStatus))
                        if current.isOverdue {
                            Text("• просрочена")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.danger)
                        }
                    }
                }
                .listRowBackground(Theme.surface)
            }

            Section("Детали") {
                row("Проект", project.name)
                row("Ответственный", current.assignee)
                if let deadline = current.deadline,
                   let date = DateFormatter.isoDay.date(from: deadline) {
                    row("Срок", DateFormatter.dayMonthYear.string(from: date))
                } else {
                    row("Срок", "Без срока")
                }
                if let created = current.createdAt {
                    row("Создана", DateFormatter.dateTime.string(from: created))
                }
                if !current.createdBy.isEmpty {
                    row("Постановщик", current.createdBy)
                }
            }

            if !current.descriptionText.isEmpty {
                Section("Описание") {
                    Text(current.descriptionText)
                        .foregroundStyle(Theme.textPrimary)
                        .listRowBackground(Theme.surface)
                }
            }

            if !current.attachments.isEmpty {
                Section("Вложения") {
                    ForEach(current.attachments) { file in
                        fileLink(file)
                    }
                }
            }

            if let comment = current.completionComment, !comment.isEmpty {
                Section("Отчёт исполнителя") {
                    Text(comment)
                        .foregroundStyle(Theme.textPrimary)
                        .listRowBackground(Theme.surface)
                }
            }

            if !current.completionProofs.isEmpty {
                Section("Файлы подтверждения") {
                    ForEach(current.completionProofs) { file in
                        fileLink(file)
                    }
                }
            }

            if let reason = current.revisionReason, !reason.isEmpty {
                Section("Возвращена на доработку") {
                    Text(reason)
                        .foregroundStyle(Theme.warning)
                        .listRowBackground(Theme.surface)
                }
            }

            Section {
                if isAssignee && current.boardStatus == .assigned {
                    Button {
                        takeToWork()
                    } label: {
                        Label("Взять в работу", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy)
                    .listRowBackground(Color.clear)
                }

                if isAssignee && current.boardStatus == .inProgress {
                    Button {
                        showCompletionSheet = true
                    } label: {
                        Label("Завершить задачу", systemImage: "checkmark.seal.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.statusDone)
                    .disabled(isBusy)
                    .listRowBackground(Color.clear)
                }

                if canManage && current.boardStatus == .review {
                    Button {
                        confirmAccept = true
                    } label: {
                        Label("Принять в «Готово»", systemImage: "checkmark.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.statusDone)
                    .disabled(isBusy)
                    .listRowBackground(Color.clear)

                    Button {
                        revisionReason = ""
                        showRevisionPrompt = true
                    } label: {
                        Label("Вернуть на доработку", systemImage: "arrow.uturn.backward")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(Theme.warning)
                    .disabled(isBusy)
                    .listRowBackground(Color.clear)
                }

                if canManage {
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Label("Удалить задачу", systemImage: "trash")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(isBusy)
                    .listRowBackground(Theme.danger.opacity(0.12))
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .listRowBackground(Color.clear)
            }
        }
        .screenBackground()
        .navigationTitle("Задача")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Удалить задачу «\(current.title)»? Действие необратимо.",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Удалить", role: .destructive) { deleteTask() }
            Button("Отмена", role: .cancel) {}
        }
        .confirmationDialog(
            "Принять задачу в «Готово»? Исполнителям начислится XP.",
            isPresented: $confirmAccept,
            titleVisibility: .visible
        ) {
            Button("Принять") { acceptDone() }
            Button("Отмена", role: .cancel) {}
        }
        .alert("Причина возврата", isPresented: $showRevisionPrompt) {
            TextField("Что нужно доработать", text: $revisionReason)
            Button("Вернуть", role: .destructive) { returnForRevision() }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Задача вернётся исполнителю в статус «В работе».")
        }
        .sheet(isPresented: $showCompletionSheet) {
            CompletionSheet(task: current) { comment, proofs in
                guard let user = appState.user else { throw ApiError.notAuthenticated }
                try await tasksStore.completeWithProofs(
                    task: current, comment: comment, proofs: proofs, byName: user.displayName
                )
            }
        }
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
            .listRowBackground(Theme.surface)
        }
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Theme.textSecondary)
            Spacer()
            Text(value)
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.trailing)
        }
        .listRowBackground(Theme.surface)
    }

    private func takeToWork() {
        guard let user = appState.user else { return }
        isBusy = true
        errorMessage = nil
        Task {
            defer { isBusy = false }
            do {
                try await tasksStore.takeToWork(task: current, byName: user.displayName)
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
                try await tasksStore.acceptDone(task: current, byName: user.displayName)
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
            } catch {
                errorMessage = "Не удалось вернуть задачу: \(error.localizedDescription)"
            }
        }
    }
}
