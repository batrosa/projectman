import SwiftUI

struct ProjectsView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var projectsStore: ProjectsStore
    @StateObject private var projectTasksStore = ProjectTasksStore()
    @State private var selectedMode: ProjectOverviewMode = .projects
    @State private var showNewProject = false
    @State private var path = NavigationPath()

    private var displayedTasks: [TaskItem] {
        let activeTasks = projectTasksStore.tasks.filter { $0.boardStatus != .done }
        switch selectedMode {
        case .projects:
            return []
        case .allTasks:
            return activeTasks
        case .weekTasks:
            return activeTasks.filter(isDueInNextSevenDays)
        }
    }

    private var assignedTasks: [TaskItem] {
        displayedTasks.filter { $0.boardStatus == .assigned }
    }

    private var inProgressTasks: [TaskItem] {
        displayedTasks.filter { $0.boardStatus == .inProgress }
    }

    private var reviewTasks: [TaskItem] {
        displayedTasks.filter { $0.boardStatus == .review }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if !projectsStore.loaded {
                    ProgressView().tint(Theme.primary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    switch selectedMode {
                    case .projects:
                        projectsContent
                    case .allTasks, .weekTasks:
                        tasksContent
                    }
                }
            }
            .screenBackground()
            .navigationTitle(selectedMode.navigationTitle)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 10) {
                        if projectsStore.loaded && canCreateProject && selectedMode == .projects {
                            createProjectButton
                        }
                        filterMenu
                    }
                }
            }
            .sheet(isPresented: $showNewProject) {
                NewProjectView()
                    .environmentObject(appState)
                    .environmentObject(projectsStore)
            }
            .navigationDestination(for: String.self) { projectId in
                if let project = projectsStore.projects.first(where: { $0.id == projectId }) {
                    ProjectBoardView(project: project)
                }
            }
            .onAppear { syncProjectTasksSubscription() }
            .onDisappear { projectTasksStore.stop() }
            .onChange(of: selectedMode) { syncProjectTasksSubscription() }
            .onChange(of: projectsStore.loaded) { syncProjectTasksSubscription() }
            .onChange(of: projectsStore.projects) { syncProjectTasksSubscription() }
            .onReceive(NotificationCenter.default.publisher(for: .hmAgentOpenProject)) { note in
                guard let projectId = note.userInfo?["projectId"] as? String,
                      projectsStore.projects.contains(where: { $0.id == projectId }) else { return }
                selectedMode = .projects
                path = NavigationPath()
                path.append(projectId)
            }
        }
    }

    private var canCreateProject: Bool {
        guard let role = appState.user?.orgRole else { return false }
        return role == "owner" || role == "admin"
    }

    @ViewBuilder
    private var projectsContent: some View {
        if projectsStore.projects.isEmpty {
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

    @ViewBuilder
    private var tasksContent: some View {
        if !projectTasksStore.loaded {
            ProgressView().tint(Theme.primary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if displayedTasks.isEmpty {
            EmptyStateView(
                icon: selectedMode.emptyIcon,
                title: selectedMode.emptyTitle,
                message: selectedMode.emptyMessage
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if !assignedTasks.isEmpty {
                        taskSectionHeader(
                            "Назначенные",
                            count: assignedTasks.count,
                            color: Theme.statusAssigned
                        )
                        ForEach(assignedTasks, id: \.statusRenderId) { task in
                            taskLink(task)
                        }
                    }

                    if !inProgressTasks.isEmpty {
                        taskSectionHeader(
                            "В работе",
                            count: inProgressTasks.count,
                            color: Theme.statusInProgress
                        )
                        .padding(.top, assignedTasks.isEmpty ? 0 : 8)
                        ForEach(inProgressTasks, id: \.statusRenderId) { task in
                            taskLink(task)
                        }
                    }

                    if !reviewTasks.isEmpty {
                        taskSectionHeader(
                            "На проверке",
                            count: reviewTasks.count,
                            color: Theme.statusReview
                        )
                        .padding(.top, (assignedTasks.isEmpty && inProgressTasks.isEmpty) ? 0 : 8)
                        ForEach(reviewTasks, id: \.statusRenderId) { task in
                            taskLink(task)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        }
    }

    private func taskSectionHeader(_ title: String, count: Int, color: Color) -> some View {
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

    private var filterMenu: some View {
        Menu {
            ForEach(ProjectOverviewMode.allCases) { mode in
                Button {
                    selectedMode = mode
                } label: {
                    Label(mode.title, systemImage: selectedMode == mode ? "checkmark.circle.fill" : mode.icon)
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle.fill")
                .font(.title3)
                .foregroundStyle(Theme.primary)
        }
        .accessibilityLabel("Фильтр проектов")
    }

    private var createProjectButton: some View {
        Button {
            showNewProject = true
        } label: {
            Image(systemName: "plus.circle.fill")
                .font(.title3)
                .foregroundStyle(Theme.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Создать проект")
    }

    private func taskLink(_ task: TaskItem) -> some View {
        let project = projectsStore.projects.first { $0.id == task.projectId }
        return NavigationLink {
            ProjectTaskDetailWrapper(task: task, project: project)
        } label: {
            ProjectTaskCard(task: task, projectName: project?.name ?? "Проект")
        }
        .id(task.statusRenderId)
        .buttonStyle(PressableStyle())
    }

    private func isDueInNextSevenDays(_ task: TaskItem) -> Bool {
        guard task.boardStatus != .done, let date = task.deadlineDate else { return false }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        guard let end = calendar.date(byAdding: .day, value: 7, to: today) else { return false }
        return date >= today && date <= end
    }

    private func syncProjectTasksSubscription() {
        guard selectedMode != .projects else {
            projectTasksStore.stop()
            return
        }
        guard projectsStore.loaded else { return }
        guard let user = appState.user else { return }
        projectTasksStore.subscribe(
            projects: projectsStore.projects,
            organizationId: user.organizationId ?? "",
            uid: user.uid,
            isOwner: user.orgRole == "owner"
        )
    }
}

private extension TaskItem {
    var statusRenderId: String {
        "\(id)-\(status)-\(subStatus ?? "none")-\(assigneeCompleted)"
    }
}

private enum ProjectOverviewMode: String, CaseIterable, Identifiable {
    case projects
    case allTasks
    case weekTasks

    var id: String { rawValue }

    var title: String {
        switch self {
        case .projects: return "Проекты"
        case .allTasks: return "Все задачи"
        case .weekTasks: return "7 дней"
        }
    }

    var navigationTitle: String {
        switch self {
        case .projects: return "Проекты"
        case .allTasks: return "Все задачи"
        case .weekTasks: return "Задачи недели"
        }
    }

    var icon: String {
        switch self {
        case .projects: return "folder.fill"
        case .allTasks: return "list.bullet.rectangle"
        case .weekTasks: return "calendar.badge.clock"
        }
    }

    var emptyIcon: String {
        switch self {
        case .projects: return "folder.badge.questionmark"
        case .allTasks: return "tray"
        case .weekTasks: return "calendar.badge.exclamationmark"
        }
    }

    var emptyTitle: String {
        switch self {
        case .projects: return "Пока нет проектов"
        case .allTasks: return "Нет активных задач"
        case .weekTasks: return "Нет задач на 7 дней"
        }
    }

    var emptyMessage: String {
        switch self {
        case .projects:
            return "Проекты появятся здесь, когда владелец или админ их создаст."
        case .allTasks:
            return "Назначенные задачи, задачи в работе и на проверке появятся здесь."
        case .weekTasks:
            return "Здесь будут активные задачи со сроком в ближайшие 7 дней."
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
        let text = DateFormatter.dayMonthYear.string(from: date)
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

private struct ProjectTaskCard: View {
    let task: TaskItem
    let projectName: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Theme.color(for: task.boardStatus))
                .frame(width: 4)

            VStack(alignment: .leading, spacing: 10) {
                Text(task.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    projectChip
                    Spacer(minLength: 6)
                    DeadlineChip(deadline: task.deadline, isOverdue: task.isOverdue)
                }

                HStack(spacing: 8) {
                    assigneeChip
                    Spacer(minLength: 6)
                    StatusChip(status: task.boardStatus, compact: true)
                }
            }
        }
        .padding(.vertical, 13)
        .padding(.horizontal, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var projectChip: some View {
        HStack(spacing: 5) {
            Image(systemName: "folder.fill")
                .font(.system(size: 9, weight: .semibold))
            Text(projectName)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Theme.primary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Theme.primary.opacity(0.12), in: Capsule())
    }

    private var assigneeChip: some View {
        HStack(spacing: 6) {
            if task.assignee == "Не назначен" {
                Image(systemName: "person.slash")
                    .font(.system(size: 10, weight: .semibold))
            } else {
                AvatarView(name: task.assignee, size: 22)
            }
            Text(task.assignee)
                .font(.caption)
                .lineLimit(1)
        }
        .foregroundStyle(Theme.textSecondary)
    }
}

private struct ProjectTaskDetailWrapper: View {
    let task: TaskItem
    let project: Project?
    @StateObject private var tasksStore = TasksStore()
    @EnvironmentObject private var appState: AppState

    var body: some View {
        TaskDetailView(
            task: task,
            project: project ?? Project(id: task.projectId, name: "Проект", description: "", deadline: nil)
        )
        .environmentObject(tasksStore)
        .onAppear {
            tasksStore.subscribe(
                projectId: task.projectId,
                organizationId: appState.user?.organizationId ?? "",
                uid: appState.user?.uid ?? "",
                isOwner: appState.user?.orgRole == "owner"
            )
        }
        .onDisappear { tasksStore.stop() }
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
            .onAppear {
                tasksStore.subscribe(
                    projectId: project.id,
                    organizationId: appState.user?.organizationId ?? "",
                    uid: appState.user?.uid ?? "",
                    isOwner: appState.user?.orgRole == "owner"
                )
            }
            .onDisappear { tasksStore.stop() }
    }
}
