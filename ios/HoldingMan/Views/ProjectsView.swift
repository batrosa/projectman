import SwiftUI

struct ProjectsView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var projectsStore: ProjectsStore

    var body: some View {
        NavigationStack {
            Group {
                if !projectsStore.loaded {
                    ProgressView().tint(Theme.primary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.background)
                } else if projectsStore.projects.isEmpty {
                    ContentUnavailableView(
                        "Нет проектов",
                        systemImage: "folder",
                        description: Text("Проекты появятся здесь, когда владелец или админ их создаст.")
                    )
                    .background(Theme.background)
                } else {
                    List(projectsStore.projects) { project in
                        NavigationLink(value: project.id) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(project.name)
                                    .font(.headline)
                                    .foregroundStyle(Theme.textPrimary)
                                if let deadline = project.deadline,
                                   let date = DateFormatter.isoDay.date(from: deadline) {
                                    Label(DateFormatter.dayMonthYear.string(from: date), systemImage: "clock")
                                        .font(.caption)
                                        .foregroundStyle(deadlineColor(date))
                                }
                            }
                            .padding(.vertical, 2)
                        }
                        .listRowBackground(Theme.surface)
                    }
                    .screenBackground()
                }
            }
            .navigationTitle(appState.organizationName.isEmpty ? "Проекты" : appState.organizationName)
            .navigationDestination(for: String.self) { projectId in
                if let project = projectsStore.projects.first(where: { $0.id == projectId }) {
                    ProjectBoardView(project: project)
                }
            }
        }
    }

    private func deadlineColor(_ date: Date) -> Color {
        let days = Calendar.current.dateComponents(
            [.day],
            from: Calendar.current.startOfDay(for: Date()),
            to: date
        ).day ?? 0
        if days < 0 { return Theme.danger }
        if days <= 7 { return Theme.warning }
        return Theme.textSecondary
    }
}

// Экран проекта: как в web — переключатель «Канбан / Гант» и содержимое.
struct ProjectBoardView: View {
    let project: Project
    @EnvironmentObject private var appState: AppState
    @StateObject private var tasksStore = TasksStore()
    @State private var view: ProjectViewKind = .kanban
    @State private var showNewTask = false

    enum ProjectViewKind: String, CaseIterable, Identifiable {
        case kanban, gantt
        var id: String { rawValue }
        var titleRu: String { self == .kanban ? "Канбан" : "Гант" }
        var icon: String { self == .kanban ? "square.grid.3x1.below.line.grid.1x2" : "chart.bar.doc.horizontal" }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Вид", selection: $view.animation(.easeInOut(duration: 0.2))) {
                ForEach(ProjectViewKind.allCases) { kind in
                    Label(kind.titleRu, systemImage: kind.icon).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            switch view {
            case .kanban:
                BoardView(project: project)
                    .transition(.opacity)
            case .gantt:
                GanttView(project: project)
                    .transition(.opacity)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .environmentObject(tasksStore)
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if appState.user?.canManage(projectId: project.id) == true {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewTask = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showNewTask) {
            NewTaskView(project: project)
                .environmentObject(tasksStore)
        }
        .onAppear { tasksStore.subscribe(projectId: project.id) }
        .onDisappear { tasksStore.stop() }
    }
}
