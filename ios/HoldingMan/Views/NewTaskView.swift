import SwiftUI

// Создание задачи менеджером. Форма полей повторяет createTask() web-клиента;
// задача создаётся «Не назначен» — назначение исполнителей и файлы остаются в
// web-версии (или через ИИ-агента, который умеет назначать по именам).
struct NewTaskView: View {
    let project: Project
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var tasksStore: TasksStore
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var descriptionText = ""
    @State private var hasDeadline = false
    @State private var deadline = Date()
    @State private var isBusy = false
    @State private var errorMessage: String?

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

                Section("Срок") {
                    Toggle("Указать срок", isOn: $hasDeadline.animation())
                        .listRowBackground(Theme.surface)
                    if hasDeadline {
                        DatePicker("Дедлайн", selection: $deadline, displayedComponents: .date)
                            .listRowBackground(Theme.surface)
                    }
                }

                Section {
                    Text("Исполнителей и файлы можно назначить в веб-версии или попросить ИИ-агента: «поставь задачу … Ивану в проект \(project.name)».")
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .listRowBackground(Color.clear)
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
        .preferredColorScheme(.dark)
    }

    private func create() {
        guard let user = appState.user, let orgId = user.organizationId else { return }
        isBusy = true
        errorMessage = nil
        Task {
            defer { isBusy = false }
            do {
                try await tasksStore.create(
                    projectId: project.id,
                    organizationId: orgId,
                    title: title.trimmingCharacters(in: .whitespaces),
                    descriptionText: descriptionText.trimmingCharacters(in: .whitespaces),
                    deadline: hasDeadline ? DateFormatter.isoDay.string(from: deadline) : nil,
                    creator: user
                )
                dismiss()
            } catch {
                errorMessage = "Не удалось создать задачу: \(error.localizedDescription)"
            }
        }
    }
}
