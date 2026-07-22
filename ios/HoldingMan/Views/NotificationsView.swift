import SwiftUI

struct NotificationsView: View {
    @EnvironmentObject private var notificationsStore: NotificationsStore
    @State private var route: TaskRoute?
    @State private var confirmDeleteAll = false
    @State private var isDeletingAll = false
    @State private var deleteError: String?

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "ru_RU")
        f.unitsStyle = .short
        return f
    }()

    var body: some View {
        NavigationStack {
            Group {
                if notificationsStore.notifications.isEmpty {
                    EmptyStateView(
                        icon: "bell.slash",
                        title: "Нет уведомлений",
                        message: "Новые задачи, возвраты на доработку и напоминания о сроках появятся здесь."
                    )
                } else {
                    List {
                        ForEach(notificationsStore.notifications) { note in
                            noteRow(note)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .screenBackground()
            .navigationTitle("Уведомления")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            notificationsStore.markAllRead()
                        } label: {
                            Label("Прочитать все", systemImage: "checkmark.circle")
                        }
                        .disabled(notificationsStore.unreadCount == 0)

                        Button(role: .destructive) {
                            confirmDeleteAll = true
                        } label: {
                            Label("Удалить все", systemImage: "trash")
                        }
                        .disabled(notificationsStore.notifications.isEmpty || isDeletingAll)
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Theme.primary)
                    }
                    .accessibilityLabel("Действия с уведомлениями")
                }
            }
            .confirmationDialog(
                "Удалить все уведомления? Действие необратимо.",
                isPresented: $confirmDeleteAll,
                titleVisibility: .visible
            ) {
                Button("Удалить все", role: .destructive) { deleteAllNotifications() }
                Button("Отмена", role: .cancel) {}
            }
            .alert("Не удалось удалить уведомления", isPresented: Binding(
                get: { deleteError != nil },
                set: { if !$0 { deleteError = nil } }
            )) {
                Button("ОК", role: .cancel) { deleteError = nil }
            } message: {
                Text(deleteError ?? "Неизвестная ошибка")
            }
            .sheet(item: $route) { route in
                TaskRouteLoaderView(taskId: route.taskId, projectId: route.projectId, taskCollection: route.taskCollection)
            }
        }
    }

    private func noteRow(_ note: AgentNotification) -> some View {
        let unread = note.readAt == nil
        return HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(unread ? Theme.primary.opacity(0.14) : Theme.surfaceSecondary)
                Image(systemName: iconFor(note.text))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(unread ? Theme.primary : Theme.textSecondary)
            }
            .frame(width: 38, height: 38)

            VStack(alignment: .leading, spacing: 5) {
                Text(DateFormatter.displayIsoDays(in: note.text))
                    .font(.subheadline)
                    .foregroundStyle(unread ? Theme.textPrimary : Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let created = note.createdAt {
                    Text(Self.relative.localizedString(for: created, relativeTo: Date()))
                        .font(.caption2)
                        .foregroundStyle(Theme.textSecondary.opacity(0.75))
                }
            }

            Spacer(minLength: 4)

            VStack(alignment: .trailing, spacing: 6) {
                if unread {
                    Circle()
                        .fill(Theme.primary)
                        .frame(width: 8, height: 8)
                }
                if note.hasTaskLink {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.textSecondary.opacity(0.5))
                }
            }
            .padding(.top, 6)
        }
        .padding(13)
        .card()
        .contentShape(Rectangle())
        .onTapGesture {
            notificationsStore.markRead(note)
            // Тап по уведомлению с задачей — открыть её в разделе статуса
            if let taskId = note.taskId, let projectId = note.projectId, note.hasTaskLink {
                route = TaskRoute(taskId: taskId, projectId: projectId, taskCollection: note.taskCollection)
            }
        }
        .swipeActions {
            Button(role: .destructive) {
                Task { try? await ApiClient.deleteAgentNotification(id: note.id) }
            } label: {
                Label("Удалить", systemImage: "trash")
            }
        }
    }

    private func iconFor(_ text: String) -> String {
        if text.contains("🆕") || text.lowercased().contains("новая задача") { return "plus.circle.fill" }
        if text.contains("🔄") || text.lowercased().contains("доработ") { return "arrow.uturn.backward.circle.fill" }
        if text.lowercased().contains("просроч") { return "flame.fill" }
        if text.lowercased().contains("дедлайн") || text.lowercased().contains("срок") { return "clock.fill" }
        if text.lowercased().contains("нет ответственного") { return "person.crop.circle.badge.exclamationmark" }
        if text.lowercased().contains("не взята") || text.lowercased().contains("не взял") { return "exclamationmark.circle.fill" }
        return "bell.fill"
    }

    private func deleteAllNotifications() {
        guard !isDeletingAll else { return }
        isDeletingAll = true
        Task {
            defer { isDeletingAll = false }
            do {
                try await notificationsStore.deleteAll()
            } catch {
                deleteError = error.localizedDescription
            }
        }
    }
}
