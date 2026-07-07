import SwiftUI

// Создание задачи менеджером. Форма полей повторяет createTask() web-клиента,
// включая нескольких исполнителей; назначенным уходит Telegram-уведомление
// (тот же api/notify-telegram, что в web).
struct NewTaskView: View {
    let project: Project
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var tasksStore: TasksStore
    @EnvironmentObject private var orgUsersStore: OrgUsersStore
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var descriptionText = ""
    @State private var hasDeadline = false
    @State private var deadline = Date()
    @State private var selectedAssignees: [OrgUser] = []
    @State private var isBusy = false
    @State private var errorMessage: String?

    private var assignableUsers: [OrgUser] {
        orgUsersStore.assignable(projectId: project.id)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Задача") {
                    TextField("Название", text: $title)
                        .foregroundStyle(Theme.textPrimary)
                        .listRowBackground(Theme.surface)
                    TextField("Описание (необязательно)", text: $descriptionText, axis: .vertical)
                        .lineLimit(3...6)
                        .foregroundStyle(Theme.textPrimary)
                        .listRowBackground(Theme.surface)
                }

                Section("Ответственные") {
                    if assignableUsers.isEmpty {
                        Text("Нет участников с доступом к проекту")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .listRowBackground(Theme.surface)
                    }
                    ForEach(assignableUsers) { user in
                        let isSelected = selectedAssignees.contains { $0.id == user.id }
                        Button {
                            if isSelected {
                                selectedAssignees.removeAll { $0.id == user.id }
                            } else {
                                selectedAssignees.append(user)
                            }
                        } label: {
                            HStack(spacing: 10) {
                                AvatarView(name: user.displayName, size: 30)
                                Text(user.displayName)
                                    .foregroundStyle(Theme.textPrimary)
                                Spacer()
                                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(isSelected ? Theme.primary : Theme.textSecondary.opacity(0.5))
                            }
                        }
                        .listRowBackground(Theme.surface)
                    }
                }

                Section("Срок") {
                    Toggle("Указать срок", isOn: $hasDeadline.animation())
                        .listRowBackground(Theme.surface)
                    if hasDeadline {
                        DatePicker("Дедлайн", selection: $deadline, displayedComponents: .date)
                            .listRowBackground(Theme.surface)
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
            .navigationTitle("Новая задача")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isBusy {
                        ProgressView().tint(Theme.primary)
                    } else {
                        Button("Создать") { create() }
                            .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
    }

    private func create() {
        guard let user = appState.user, let orgId = user.organizationId else { return }
        isBusy = true
        errorMessage = nil
        let deadlineString = hasDeadline ? DateFormatter.isoDay.string(from: deadline) : nil
        let taskTitle = title.trimmingCharacters(in: .whitespaces)
        let assignees = selectedAssignees

        Task {
            defer { isBusy = false }
            do {
                try await tasksStore.create(
                    projectId: project.id,
                    organizationId: orgId,
                    title: taskTitle,
                    descriptionText: descriptionText.trimmingCharacters(in: .whitespaces),
                    deadline: deadlineString,
                    creator: user,
                    assignees: assignees
                )
                // Telegram каждому назначенному — как web
                // sendNewTaskNotificationToAssignee(); fire-and-forget.
                for assignee in assignees {
                    guard let chatId = assignee.telegramChatId else { continue }
                    let text = """
                    📋 <b>Новая задача!</b>

                    <b>Задача:</b> \(taskTitle)
                    <b>Проект:</b> \(project.name)
                    <b>Срок:</b> \(deadlineString ?? "Не указан")

                    Откройте HoldingMan для подробностей.
                    """
                    Task { try? await ApiClient.notifyTelegram(chatId: chatId, text: text) }
                }
                dismiss()
            } catch {
                errorMessage = "Не удалось создать задачу: \(error.localizedDescription)"
            }
        }
    }
}
