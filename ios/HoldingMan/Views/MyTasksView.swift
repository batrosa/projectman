import SwiftUI

struct MyTasksView: View {
    @EnvironmentObject private var myTasksStore: MyTasksStore
    @EnvironmentObject private var projectsStore: ProjectsStore
    @State private var selectedFilter: MyTasksFilter = .all

    private var displayedTasks: [TaskItem] {
        myTasksStore.tasks.filter { selectedFilter.matches($0.boardStatus) }
    }

    private var assigned: [TaskItem] { displayedTasks.filter { $0.boardStatus == .assigned } }
    private var inProgress: [TaskItem] { displayedTasks.filter { $0.boardStatus == .inProgress } }
    private var review: [TaskItem] { displayedTasks.filter { $0.boardStatus == .review } }

    var body: some View {
        NavigationStack {
            Group {
                if displayedTasks.isEmpty {
                    EmptyStateView(
                        icon: selectedFilter.emptyIcon,
                        title: selectedFilter.emptyTitle,
                        message: selectedFilter.emptyMessage
                    )
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            if !assigned.isEmpty {
                                sectionHeader("Назначенные", count: assigned.count, color: Theme.statusAssigned, icon: BoardStatus.assigned.icon)
                                ForEach(assigned, id: \.statusRenderId) { task in
                                    taskLink(task)
                                }
                            }
                            if !inProgress.isEmpty {
                                sectionHeader("В работе", count: inProgress.count, color: Theme.statusInProgress, icon: BoardStatus.inProgress.icon)
                                    .padding(.top, assigned.isEmpty ? 0 : 8)
                                ForEach(inProgress, id: \.statusRenderId) { task in
                                    taskLink(task)
                                }
                            }
                            if !review.isEmpty {
                                sectionHeader("На проверке", count: review.count, color: Theme.statusReview, icon: BoardStatus.review.icon)
                                    .padding(.top, (assigned.isEmpty && inProgress.isEmpty) ? 0 : 8)
                                ForEach(review, id: \.statusRenderId) { task in
                                    taskLink(task)
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                    }
                }
            }
            .screenBackground()
            .navigationTitle("Мои задачи")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    filterMenu
                }
            }
        }
    }

    private var filterMenu: some View {
        Menu {
            ForEach(MyTasksFilter.allCases) { filter in
                Button {
                    selectedFilter = filter
                } label: {
                    Label(
                        filter.title,
                        systemImage: filter.icon
                    )
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle.fill")
                .font(.title3)
                .foregroundStyle(Theme.primary)
        }
        .accessibilityLabel("Фильтр задач")
        .accessibilityValue(selectedFilter.title)
    }

    private func sectionHeader(_ title: String, count: Int, color: Color, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(color)
            Text(title)
                .font(.footnote.weight(.bold))
                .foregroundStyle(color)
                .textCase(.uppercase)
            Text("\(count)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(color)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(color.opacity(0.12), in: Capsule())
        }
        .padding(.leading, 2)
    }

    private func taskLink(_ task: TaskItem) -> some View {
        let project = projectsStore.projects.first { $0.id == task.projectId }
        return NavigationLink {
            MyTaskDetailWrapper(task: task, project: project)
        } label: {
            MyTaskCard(task: task, projectName: project?.name)
        }
        .id(task.statusRenderId)
        .buttonStyle(PressableStyle())
    }
}

private enum MyTasksFilter: String, CaseIterable, Identifiable {
    case all
    case assigned
    case inProgress
    case review

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "Все"
        case .assigned: return "Назначенные"
        case .inProgress: return "В работе"
        case .review: return "На проверке"
        }
    }

    var icon: String {
        switch self {
        case .all: return "list.bullet.rectangle"
        case .assigned: return "exclamationmark.circle"
        case .inProgress: return "briefcase.fill"
        case .review: return "clock.fill"
        }
    }

    var emptyIcon: String {
        switch self {
        case .all: return "checkmark.circle"
        case .assigned: return "tray"
        case .inProgress: return "briefcase"
        case .review: return "clock"
        }
    }

    var emptyTitle: String {
        switch self {
        case .all: return "Нет активных задач"
        case .assigned: return "Нет назначенных задач"
        case .inProgress: return "Нет задач в работе"
        case .review: return "Нет задач на проверке"
        }
    }

    var emptyMessage: String {
        switch self {
        case .all:
            return "Задачи, где вы назначены исполнителем, появятся здесь."
        case .assigned:
            return "Новые задачи, ожидающие принятия в работу, появятся здесь."
        case .inProgress:
            return "Принятые в работу задачи появятся здесь."
        case .review:
            return "Задачи, отправленные на проверку, появятся здесь."
        }
    }

    func matches(_ status: BoardStatus) -> Bool {
        switch self {
        case .all: return status != .done
        case .assigned: return status == .assigned
        case .inProgress: return status == .inProgress
        case .review: return status == .review
        }
    }
}

private extension TaskItem {
    var statusRenderId: String {
        "\(id)-\(status)-\(subStatus ?? "none")-\(assigneeCompleted)"
    }
}

private struct MyTaskCard: View {
    let task: TaskItem
    let projectName: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Theme.color(for: task.boardStatus))
                .frame(width: 4)

            VStack(alignment: .leading, spacing: 9) {
                Text(task.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    if let projectName {
                        HStack(spacing: 4) {
                            Image(systemName: "folder.fill")
                                .font(.system(size: 9))
                            Text(projectName)
                                .font(.caption)
                                .lineLimit(1)
                        }
                        .foregroundStyle(Theme.textSecondary)
                    }
                    StatusChip(status: task.boardStatus, compact: true)
                    Spacer(minLength: 4)
                    DeadlineChip(deadline: task.deadline, isOverdue: task.isOverdue)
                }
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

// «Мои задачи» открывает деталь задачи со своей подпиской на проект,
// чтобы работали действия и живые обновления.
private struct MyTaskDetailWrapper: View {
    let task: TaskItem
    let project: Project?
    @EnvironmentObject private var myTasksStore: MyTasksStore
    @StateObject private var tasksStore = TasksStore()

    var body: some View {
        TaskDetailView(
            task: task,
            project: project ?? Project(id: task.projectId, name: "Проект", description: "", deadline: nil),
            onLocalTaskChange: { myTasksStore.replaceLocal($0) }
        )
        .environmentObject(tasksStore)
        .onAppear { tasksStore.subscribe(projectId: task.projectId) }
        .onDisappear { tasksStore.stop() }
    }
}
