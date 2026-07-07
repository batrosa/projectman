import SwiftUI

struct NotificationsView: View {
    @EnvironmentObject private var notificationsStore: NotificationsStore

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
                Text(note.text)
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

            if unread {
                Circle()
                    .fill(Theme.primary)
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)
            }
        }
        .padding(13)
        .card()
        .contentShape(Rectangle())
        .onTapGesture { notificationsStore.markRead(note) }
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
        if text.lowercased().contains("не взята") || text.lowercased().contains("не взял") { return "exclamationmark.circle.fill" }
        return "bell.fill"
    }
}
