import SwiftUI
import FirebaseFirestore

// Переход к задаче из уведомления (тап по карточке в ленте или по системному
// push): грузим задачу и проект по id, открываем доску проекта на колонке
// статуса задачи и поверх — саму задачу.
struct TaskRoute: Identifiable {
    let taskId: String
    let projectId: String
    var id: String { taskId }
}

extension Notification.Name {
    static let hmOpenTask = Notification.Name("hmOpenTask")
}

struct TaskRouteLoaderView: View {
    let taskId: String
    let projectId: String
    @Environment(\.dismiss) private var dismiss

    @State private var task: TaskItem?
    @State private var project: Project?
    @State private var failed = false

    var body: some View {
        Group {
            if let task, let project {
                TaskRouteView(task: task, project: project)
            } else if failed {
                VStack(spacing: 14) {
                    EmptyStateView(
                        icon: "questionmark.circle",
                        title: "Задача не найдена",
                        message: "Возможно, её уже удалили или у вас больше нет доступа к проекту."
                    )
                    Button("Закрыть") { dismiss() }
                        .buttonStyle(SoftButtonStyle())
                        .padding(.horizontal, 60)
                        .padding(.bottom, 30)
                }
                .background(Theme.background.ignoresSafeArea())
            } else {
                ZStack {
                    Theme.background.ignoresSafeArea()
                    ProgressView().tint(Theme.primary)
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let db = Firestore.firestore()
            async let taskSnap = db.collection("tasks").document(taskId).getDocument()
            async let projectSnap = db.collection("projects").document(projectId).getDocument()
            let (t, p) = try await (taskSnap, projectSnap)
            guard t.exists, let taskData = t.data(),
                  p.exists, let projectData = p.data() else {
                failed = true
                return
            }
            task = TaskItem.from(id: t.documentID, data: taskData)
            project = Project.from(id: p.documentID, data: projectData)
        } catch {
            failed = true
        }
    }
}

private struct TaskRouteView: View {
    let task: TaskItem
    let project: Project
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @StateObject private var tasksStore = TasksStore()
    @State private var showTask = false

    var body: some View {
        NavigationStack {
            BoardView(project: project, initialColumn: task.boardStatus)
                .background(Theme.background.ignoresSafeArea())
                .navigationTitle(project.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Закрыть") { dismiss() }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                .navigationDestination(isPresented: $showTask) {
                    TaskDetailView(task: task, project: project)
                        .environmentObject(tasksStore)
                }
        }
        .environmentObject(tasksStore)
        .onAppear {
            tasksStore.subscribe(projectId: project.id)
            // Небольшая пауза, чтобы push внутрь стека выглядел естественно
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { showTask = true }
        }
        .onDisappear { tasksStore.stop() }
    }
}
