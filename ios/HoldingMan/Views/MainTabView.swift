import SwiftUI

struct MainTabView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var projectsStore = ProjectsStore()
    @StateObject private var myTasksStore = MyTasksStore()
    @StateObject private var notificationsStore = NotificationsStore()
    @StateObject private var orgUsersStore = OrgUsersStore()
    @State private var selectedTab: String
    @State private var pushRoute: TaskRoute?
    @State private var showAgentTeam = false
    @Environment(\.scenePhase) private var scenePhase

    private var assignedMyTasksCount: Int {
        myTasksStore.tasks.filter { $0.boardStatus == .assigned }.count
    }

    init(initialTab: String = "projects") {
        _selectedTab = State(initialValue: initialTab)
    }

    private var agentLockedView: some View {
        VStack(spacing: 14) {
            Image(systemName: "lock.fill")
                .font(.system(size: 40))
                .foregroundStyle(Theme.textSecondary)
            Text("ИИ-агент недоступен")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text("Доступен ролям от модератора и выше.\nОбратитесь к владельцу или администратору организации.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .screenBackground()
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            ProjectsView()
                .tabItem { Label("Проекты", systemImage: "folder.fill") }
                .tag("projects")

            MyTasksView()
                .tabItem { Label("Мои задачи", systemImage: "checklist") }
                .badge(assignedMyTasksCount)
                .tag("mytasks")

            // ИИ-агент — только от модератора и выше (экономия OpenRouter-
            // кредитов); сервер дублирует запрет 403-ом. Исполнителю вместо
            // чата показывается заглушка.
            Group {
                if ["owner", "admin", "moderator"].contains(appState.user?.orgRole ?? "") {
                    AgentChatView()
                } else {
                    agentLockedView
                }
            }
            .tabItem { Label("ИИ-агент", systemImage: "sparkles") }
            .tag("chat")

            NotificationsView()
                .tabItem { Label("Уведомления", systemImage: "bell.fill") }
                .badge(notificationsStore.unreadCount)
                .tag("notifications")

            SettingsView()
                .tabItem { Label("Профиль", systemImage: "person.crop.circle") }
                .tag("settings")
        }
        .environmentObject(projectsStore)
        .environmentObject(myTasksStore)
        .environmentObject(notificationsStore)
        .environmentObject(orgUsersStore)
        .onAppear { resubscribe() }
        .onChange(of: appState.user?.organizationId) { resubscribe() }
        // «Мои задачи» слушают задачи ПО ПРОЕКТАМ (как web) — пересобираем
        // подписку, когда список доступных проектов загрузился/изменился
        .onChange(of: projectsStore.projects) { resubscribeMyTasks() }
        // Возврат из фона: пересобрать подписки (мёртвый после долгого фона
        // слушатель = «замёрзшие» списки)
        .onChange(of: scenePhase) {
            if scenePhase == .active { resubscribe() }
        }
        // Тап по системному push (данные taskId/projectId) → открыть задачу
        .onReceive(NotificationCenter.default.publisher(for: .hmOpenTask)) { note in
            guard let taskId = note.userInfo?["taskId"] as? String,
                  let projectId = note.userInfo?["projectId"] as? String else { return }
            pushRoute = TaskRoute(taskId: taskId, projectId: projectId)
        }
        .onReceive(NotificationCenter.default.publisher(for: .hmAgentNavigate)) { note in
            guard let target = note.userInfo?["target"] as? String else { return }
            let projectId = note.userInfo?["projectId"] as? String ?? ""
            let taskId = note.userInfo?["taskId"] as? String ?? ""
            switch target {
            case "my_tasks": selectedTab = "mytasks"
            case "notifications": selectedTab = "notifications"
            case "team": showAgentTeam = true
            case "profile", "calendar": selectedTab = "settings"
            case "task":
                selectedTab = "projects"
                if !projectId.isEmpty, !taskId.isEmpty {
                    pushRoute = TaskRoute(taskId: taskId, projectId: projectId)
                }
            case "project":
                selectedTab = "projects"
                if !projectId.isEmpty {
                    DispatchQueue.main.async {
                        NotificationCenter.default.post(
                            name: .hmAgentOpenProject,
                            object: nil,
                            userInfo: ["projectId": projectId]
                        )
                    }
                }
            default: selectedTab = "projects"
            }
        }
        .sheet(item: $pushRoute) { route in
            TaskRouteLoaderView(taskId: route.taskId, projectId: route.projectId)
                .environmentObject(appState)
        }
        .sheet(isPresented: $showAgentTeam) {
            TeamView()
                .environmentObject(appState)
                .environmentObject(orgUsersStore)
        }
    }

    private func resubscribe() {
        #if DEBUG
        if DemoData.isEnabled {
            projectsStore.loadDemo()
            myTasksStore.loadDemo()
            notificationsStore.loadDemo()
            orgUsersStore.loadDemo()
            return
        }
        #endif
        guard let user = appState.user, let orgId = user.organizationId else { return }
        projectsStore.subscribe(organizationId: orgId, user: user)
        resubscribeMyTasks()
        notificationsStore.subscribe(uid: user.uid, organizationId: orgId)
        orgUsersStore.subscribe(organizationId: orgId)
    }

    private func resubscribeMyTasks() {
        #if DEBUG
        if DemoData.isEnabled { return }
        #endif
        guard let user = appState.user else { return }
        myTasksStore.subscribe(uid: user.uid, projects: projectsStore.projects)
    }
}
