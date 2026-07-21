import SwiftUI

// Создание проекта по тем же полям, что web-модалка:
// название, описание и опциональный срок проекта.
struct NewProjectView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var projectsStore: ProjectsStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var descriptionText = ""
    @State private var hasDeadline = false
    @State private var deadline = Date()
    @State private var isBusy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Проект") {
                    TextField("Название проекта", text: $name)
                        .foregroundStyle(Theme.textPrimary)
                        .listRowBackground(Theme.surface)
                    TextField("Описание (необязательно)", text: $descriptionText, axis: .vertical)
                        .lineLimit(3...6)
                        .foregroundStyle(Theme.textPrimary)
                        .listRowBackground(Theme.surface)
                }

                Section("Срок") {
                    Toggle("Установить срок", isOn: $hasDeadline.animation())
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
            .navigationTitle("Новый проект")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: create) {
                        AsyncButtonLabel(
                            title: "Создать",
                            isLoading: isBusy,
                            progressTint: Theme.primary,
                            fillsWidth: false
                        )
                    }
                    .disabled(isBusy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func create() {
        guard let user = appState.user, let orgId = user.organizationId else {
            errorMessage = "Организация ещё не загружена"
            return
        }

        isBusy = true
        errorMessage = nil
        let deadlineString = hasDeadline ? DateFormatter.isoDay.string(from: deadline) : nil

        Task {
            defer { isBusy = false }
            do {
                try await projectsStore.create(
                    organizationId: orgId,
                    user: user,
                    name: name,
                    description: descriptionText,
                    deadline: deadlineString
                )
                dismiss()
            } catch {
                errorMessage = "Не удалось создать проект: \(error.localizedDescription)"
            }
        }
    }
}
