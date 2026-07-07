import SwiftUI

struct MainTabView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var projectsStore = ProjectsStore()
    @StateObject private var myTasksStore = MyTasksStore()
    @StateObject private var notificationsStore = NotificationsStore()
    @StateObject private var orgUsersStore = OrgUsersStore()
    @State private var selectedTab: String
    @State private var pushRoute: TaskRoute?
    @Environment(\.scenePhase) private var scenePhase

    init(initialTab: String = "projects") {
        _selectedTab = State(initialValue: initialTab)
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            ProjectsView()
                .tabItem { Label("Проекты", systemImage: "folder.fill") }
                .tag("projects")

            MyTasksView()
                .tabItem { Label("Мои задачи", systemImage: "checklist") }
                .tag("mytasks")

            AgentChatView()
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
        .sheet(item: $pushRoute) { route in
            TaskRouteLoaderView(taskId: route.taskId, projectId: route.projectId)
                .environmentObject(appState)
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
        myTasksStore.subscribe(uid: user.uid, organizationId: orgId)
        notificationsStore.subscribe(uid: user.uid, organizationId: orgId)
        orgUsersStore.subscribe(organizationId: orgId)
    }
}
