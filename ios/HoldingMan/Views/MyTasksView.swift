import SwiftUI

struct MyTasksView: View {
    @EnvironmentObject private var myTasksStore: MyTasksStore
    @EnvironmentObject private var projectsStore: ProjectsStore

    private var overdue: [TaskItem] { myTasksStore.tasks.filter(\.isOverdue) }
    private var active: [TaskItem] { myTasksStore.tasks.filter { !$0.isOverdue } }

    var body: some View {
        NavigationStack {
            Group {
                if myTasksStore.tasks.isEmpty {
                    EmptyStateView(
                        icon: "checkmark.circle",
                        title: "Нет активных задач",
                        message: "Задачи, где вы назначены исполнителем, появятся здесь."
                    )
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            if !overdue.isEmpty {
                                sectionHeader("Просроченные", count: overdue.count, color: Theme.danger)
                                ForEach(overdue) { task in
                                    taskLink(task)
                                }
                            }
                            if !active.isEmpty {
                                sectionHeader("В плане", count: active.count, color: Theme.textSecondary)
                                    .padding(.top, overdue.isEmpty ? 0 : 8)
                                ForEach(active) { task in
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
        }
    }

    private func sectionHeader(_ title: String, count: Int, color: Color) -> some View {
        HStack(spacing: 8) {
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
        .buttonStyle(PressableStyle())
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
    @StateObject private var tasksStore = TasksStore()

    var body: some View {
        TaskDetailView(
            task: task,
            project: project ?? Project(id: task.projectId, name: "Проект", description: "", deadline: nil)
        )
        .environmentObject(tasksStore)
        .onAppear { tasksStore.subscribe(projectId: task.projectId) }
        .onDisappear { tasksStore.stop() }
    }
}
