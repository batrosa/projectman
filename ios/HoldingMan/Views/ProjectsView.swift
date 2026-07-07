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
                } else if projectsStore.projects.isEmpty {
                    EmptyStateView(
                        icon: "folder.badge.questionmark",
                        title: "Пока нет проектов",
                        message: "Проекты появятся здесь, когда владелец или админ их создаст."
                    )
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(projectsStore.projects) { project in
                                NavigationLink(value: project.id) {
                                    ProjectCard(project: project)
                                }
                                .buttonStyle(PressableStyle())
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                    }
                }
            }
            .screenBackground()
            .navigationTitle("Проекты")
            .toolbar {
                if !appState.organizationName.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Text(appState.organizationName)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                }
            }
            .navigationDestination(for: String.self) { projectId in
                if let project = projectsStore.projects.first(where: { $0.id == projectId }) {
                    ProjectBoardView(project: project)
                }
            }
        }
    }
}

private struct ProjectCard: View {
    let project: Project

    private var deadlineInfo: (text: String, color: Color)? {
        guard let deadline = project.deadline,
              let date = DateFormatter.isoDay.date(from: deadline) else { return nil }
        let days = Calendar.current.dateComponents(
            [.day],
            from: Calendar.current.startOfDay(for: Date()),
            to: date
        ).day ?? 0
        let text = DateFormatter.dayMonthShortRu.string(from: date)
        if days < 0 { return ("просрочен · \(text)", Theme.danger) }
        if days <= 7 { return ("до \(text)", Theme.warning) }
        return ("до \(text)", Theme.textSecondary)
    }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.primaryGradient)
                    .opacity(0.9)
                Image(systemName: "folder.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 4) {
                Text(project.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                if let info = deadlineInfo {
                    HStack(spacing: 4) {
                        Image(systemName: "clock")
                            .font(.system(size: 10))
                        Text(info.text)
                            .font(.caption)
                    }
                    .foregroundStyle(info.color)
                } else if !project.description.isEmpty {
                    Text(project.description)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.textSecondary.opacity(0.6))
        }
        .padding(14)
        .card()
    }
}

// Экран проекта: канбан-доска (Гант — в веб-версии)
struct ProjectBoardView: View {
    let project: Project
    @EnvironmentObject private var appState: AppState
    @StateObject private var tasksStore = TasksStore()
    @State private var showNewTask = false

    var body: some View {
        BoardView(project: project)
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
                            Image(systemName: "plus.circle.fill")
                                .font(.title3)
                                .foregroundStyle(Theme.primary)
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
