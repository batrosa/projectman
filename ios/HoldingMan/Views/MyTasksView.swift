import SwiftUI

struct MyTasksView: View {
    @EnvironmentObject private var myTasksStore: MyTasksStore
    @EnvironmentObject private var projectsStore: ProjectsStore

    var body: some View {
        NavigationStack {
            Group {
                if myTasksStore.tasks.isEmpty {
                    ContentUnavailableView(
                        "Нет активных задач",
                        systemImage: "checkmark.circle",
                        description: Text("Задачи, где вы назначены исполнителем, появятся здесь.")
                    )
                    .background(Theme.background)
                } else {
                    List(myTasksStore.tasks) { task in
                        let project = projectsStore.projects.first { $0.id == task.projectId }
                        NavigationLink {
                            MyTaskDetailWrapper(task: task, project: project)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(task.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.textPrimary)
                                    .lineLimit(2)
                                HStack(spacing: 10) {
                                    if let project {
                                        Label(project.name, systemImage: "folder")
                                            .font(.caption)
                                            .foregroundStyle(Theme.textSecondary)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    HStack(spacing: 5) {
                                        Circle()
                                            .fill(Theme.color(for: task.boardStatus))
                                            .frame(width: 7, height: 7)
                                        Text(task.boardStatus.singleRu)
                                            .font(.caption)
                                            .foregroundStyle(Theme.color(for: task.boardStatus))
                                    }
                                    if let deadline = task.deadline,
                                       let date = DateFormatter.isoDay.date(from: deadline) {
                                        Text(DateFormatter.dayMonth.string(from: date))
                                            .font(.caption.weight(.medium))
                                            .foregroundStyle(task.isOverdue ? Theme.danger : Theme.textSecondary)
                                    }
                                }
                            }
                            .padding(.vertical, 2)
                        }
                        .listRowBackground(Theme.surface)
                    }
                    .screenBackground()
                }
            }
            .navigationTitle("Мои задачи")
        }
    }
}

// «Мои задачи» открывает деталь задачи со своей подпиской на проект,
// чтобы работали «Взять в работу» и живые обновления.
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
