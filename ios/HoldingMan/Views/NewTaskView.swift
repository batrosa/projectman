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
    @State private var selectedCoCreators: [OrgUser] = []
    @State private var isPrivate = false
    @State private var activePeoplePicker: TaskPeoplePickerKind?
    @State private var isBusy = false
    @State private var errorMessage: String?

    private var assignableUsers: [OrgUser] {
        orgUsersStore.assignable(projectId: project.id)
    }

    // Кандидаты в доп. постановщики: те же участники с доступом к проекту,
    // кроме самого создателя (он основной постановщик).
    private var coCreatorCandidates: [OrgUser] {
        assignableUsers.filter { $0.id != appState.user?.uid }
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
                    } else {
                        PeopleSelectionRow(
                            title: "Выбрать исполнителей",
                            systemImage: "person.2.fill",
                            selectedUsers: selectedAssignees
                        ) {
                            activePeoplePicker = .assignees
                        }
                        .listRowBackground(Theme.surface)
                    }
                }

                Section("Доп. постановщики") {
                    if coCreatorCandidates.isEmpty {
                        Text("Нет участников с доступом к проекту")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .listRowBackground(Theme.surface)
                    } else {
                        PeopleSelectionRow(
                            title: "Выбрать постановщиков",
                            systemImage: "person.badge.plus",
                            selectedUsers: selectedCoCreators
                        ) {
                            activePeoplePicker = .coCreators
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

                Section {
                    Toggle(isOn: $isPrivate) {
                        Label("Приватная задача", systemImage: "lock.fill")
                    }
                    .tint(Theme.primary)
                    .listRowBackground(Theme.surface)

                    Text("Видна владельцу организации, постановщикам и исполнителям этой задачи")
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .listRowBackground(Theme.surface)
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
        .sheet(item: $activePeoplePicker) { picker in
            switch picker {
            case .assignees:
                TaskPeoplePickerView(
                    title: "Ответственные",
                    users: assignableUsers,
                    selectedUsers: $selectedAssignees
                )
            case .coCreators:
                TaskPeoplePickerView(
                    title: "Доп. постановщики",
                    users: coCreatorCandidates,
                    selectedUsers: $selectedCoCreators
                )
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
                // События task_created исполнителям (Telegram + push + лента)
                // отправляет TasksStore.create через сервер
                try await tasksStore.create(
                    projectId: project.id,
                    projectName: project.name,
                    organizationId: orgId,
                    title: taskTitle,
                    descriptionText: descriptionText.trimmingCharacters(in: .whitespaces),
                    deadline: deadlineString,
                    creator: user,
                    assignees: assignees,
                    coCreators: selectedCoCreators,
                    isPrivate: isPrivate
                )
                dismiss()
            } catch {
                errorMessage = "Не удалось создать задачу: \(error.localizedDescription)"
            }
        }
    }
}

private enum TaskPeoplePickerKind: String, Identifiable {
    case assignees
    case coCreators

    var id: String { rawValue }
}

private struct PeopleSelectionRow: View {
    let title: String
    let systemImage: String
    let selectedUsers: [OrgUser]
    let action: () -> Void

    private var selectionSummary: String {
        guard !selectedUsers.isEmpty else { return "Нажмите, чтобы выбрать" }

        let visibleNames = selectedUsers.prefix(2).map(\.displayName).joined(separator: ", ")
        let remainingCount = selectedUsers.count - min(selectedUsers.count, 2)
        return remainingCount > 0 ? "\(visibleNames) и ещё \(remainingCount)" : visibleNames
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.primary)
                    .frame(width: 38, height: 38)
                    .background(Theme.primary.opacity(0.12), in: RoundedRectangle(cornerRadius: 11))

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text(selectionSummary)
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 8)

                if !selectedUsers.isEmpty {
                    Text("\(selectedUsers.count)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Theme.primary, in: Capsule())
                }

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textSecondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(selectedUsers.isEmpty ? "Ничего не выбрано" : "Выбрано: \(selectedUsers.count)")
    }
}

private struct TaskPeoplePickerView: View {
    let title: String
    let users: [OrgUser]
    @Binding var selectedUsers: [OrgUser]

    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""

    private var filteredUsers: [OrgUser] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return users }

        return users.filter { user in
            user.displayName.localizedCaseInsensitiveContains(query)
                || user.email.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if filteredUsers.isEmpty {
                    ContentUnavailableView(
                        searchText.isEmpty ? "Нет доступных участников" : "Ничего не найдено",
                        systemImage: searchText.isEmpty ? "person.2.slash" : "magnifyingglass",
                        description: Text(searchText.isEmpty
                            ? "Для этого проекта нет доступных участников."
                            : "Попробуйте изменить поисковый запрос.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    Section("Выбрано: \(selectedUsers.count)") {
                        ForEach(filteredUsers) { user in
                            let isSelected = selectedUsers.contains { $0.id == user.id }
                            Button {
                                toggle(user)
                            } label: {
                                HStack(spacing: 12) {
                                    AvatarView(name: user.displayName, size: 36)

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(user.displayName)
                                            .font(.body.weight(.medium))
                                            .foregroundStyle(Theme.textPrimary)
                                        if !user.email.isEmpty {
                                            Text(user.email)
                                                .font(.caption)
                                                .foregroundStyle(Theme.textSecondary)
                                                .lineLimit(1)
                                        }
                                    }

                                    Spacer(minLength: 8)

                                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                                        .font(.title2)
                                        .foregroundStyle(isSelected ? Theme.primary : Theme.textSecondary.opacity(0.5))
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(Theme.surface)
                            .accessibilityLabel(user.displayName)
                            .accessibilityValue(isSelected ? "Выбран" : "Не выбран")
                        }
                    }
                }
            }
            .screenBackground()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $searchText,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Поиск по имени или почте"
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !selectedUsers.isEmpty {
                        Button("Очистить", role: .destructive) {
                            selectedUsers.removeAll()
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func toggle(_ user: OrgUser) {
        if selectedUsers.contains(where: { $0.id == user.id }) {
            selectedUsers.removeAll { $0.id == user.id }
        } else {
            selectedUsers.append(user)
        }
    }
}
