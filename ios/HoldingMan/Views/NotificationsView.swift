import SwiftUI

struct NotificationsView: View {
    @EnvironmentObject private var notificationsStore: NotificationsStore

    var body: some View {
        NavigationStack {
            Group {
                if notificationsStore.notifications.isEmpty {
                    ContentUnavailableView(
                        "Нет уведомлений",
                        systemImage: "bell.slash",
                        description: Text("Новые задачи, возвраты на доработку и напоминания о сроках появятся здесь.")
                    )
                    .background(Theme.background)
                } else {
                    List {
                        ForEach(notificationsStore.notifications) { note in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(note.text)
                                    .font(.subheadline)
                                    .foregroundStyle(
                                        note.readAt == nil ? Theme.textPrimary : Theme.textSecondary
                                    )
                                if let created = note.createdAt {
                                    Text(DateFormatter.dateTime.string(from: created))
                                        .font(.caption2)
                                        .foregroundStyle(Theme.textSecondary.opacity(0.7))
                                }
                            }
                            .padding(.vertical, 3)
                            .listRowBackground(
                                note.readAt == nil ? Theme.primary.opacity(0.10) : Theme.surface
                            )
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
                    }
                    .screenBackground()
                }
            }
            .navigationTitle("Уведомления")
        }
    }
}
