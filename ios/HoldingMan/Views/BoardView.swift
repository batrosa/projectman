import SwiftUI

// Канбан: горизонтальный пейджинг по колонкам (мобильный аналог вкладок
// web-доски), внутри — карточки задач.
struct BoardView: View {
    let project: Project
    @EnvironmentObject private var tasksStore: TasksStore
    @State private var column: BoardStatus = .assigned

    var body: some View {
        VStack(spacing: 0) {
            // Вкладки-статусы с количеством, цвета как на web-доске
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(BoardStatus.allCases) { status in
                        let count = tasksStore.tasks(in: status).count
                        Button {
                            withAnimation(.easeInOut(duration: 0.18)) { column = status }
                        } label: {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(Theme.color(for: status))
                                    .frame(width: 8, height: 8)
                                Text(status.titleRu)
                                    .font(.subheadline.weight(.semibold))
                                Text("\(count)")
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(Theme.color(for: status).opacity(0.25), in: Capsule())
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(
                                column == status
                                    ? Theme.color(for: status).opacity(0.28)
                                    : Theme.surface,
                                in: RoundedRectangle(cornerRadius: 11)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 11)
                                    .stroke(
                                        column == status
                                            ? Theme.color(for: status).opacity(0.6)
                                            : .clear,
                                        lineWidth: 1
                                    )
                            )
                            .foregroundStyle(Theme.textPrimary)
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
            }

            let tasks = tasksStore.tasks(in: column)
            if !tasksStore.loaded {
                Spacer()
                ProgressView().tint(Theme.primary)
                Spacer()
            } else if tasks.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "tray")
                        .font(.title)
                        .foregroundStyle(Theme.textSecondary)
                    Text("В колонке «\(column.titleRu)» пусто")
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(tasks) { task in
                            NavigationLink {
                                TaskDetailView(task: task, project: project)
                                    .environmentObject(tasksStore)
                            } label: {
                                TaskCardView(task: task)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                }
            }
        }
    }
}

struct TaskCardView: View {
    let task: TaskItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(task.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.leading)
                .lineLimit(3)

            HStack(spacing: 10) {
                Label(task.assignee, systemImage: "person")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)

                Spacer()

                if let deadline = task.deadline,
                   let date = DateFormatter.isoDay.date(from: deadline) {
                    Label(DateFormatter.dayMonth.string(from: date), systemImage: "calendar")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(task.isOverdue ? Theme.danger : Theme.textSecondary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Theme.color(for: task.boardStatus))
                .frame(width: 3)
                .padding(.vertical, 8)
                .padding(.leading, 1)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(task.isOverdue ? Theme.danger.opacity(0.55) : .clear, lineWidth: 1)
        )
    }
}
