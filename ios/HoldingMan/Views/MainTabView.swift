import SwiftUI

struct MainTabView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var projectsStore = ProjectsStore()
    @StateObject private var myTasksStore = MyTasksStore()
    @StateObject private var notificationsStore = NotificationsStore()
    @StateObject private var orgUsersStore = OrgUsersStore()

    var body: some View {
        TabView {
            ProjectsView()
                .tabItem { Label("Проекты", systemImage: "folder.fill") }

            MyTasksView()
                .tabItem { Label("Мои задачи", systemImage: "checklist") }

            AgentChatView()
                .tabItem { Label("ИИ-агент", systemImage: "sparkles") }

            NotificationsView()
                .tabItem { Label("Уведомления", systemImage: "bell.fill") }
                .badge(notificationsStore.unreadCount)

            SettingsView()
                .tabItem { Label("Профиль", systemImage: "person.crop.circle") }
        }
        .environmentObject(projectsStore)
        .environmentObject(myTasksStore)
        .environmentObject(notificationsStore)
        .environmentObject(orgUsersStore)
        .onAppear { resubscribe() }
        .onChange(of: appState.user?.organizationId) { resubscribe() }
    }

    private func resubscribe() {
        guard let user = appState.user, let orgId = user.organizationId else { return }
        projectsStore.subscribe(organizationId: orgId, user: user)
        myTasksStore.subscribe(uid: user.uid, organizationId: orgId)
        notificationsStore.subscribe(uid: user.uid, organizationId: orgId)
        orgUsersStore.subscribe(organizationId: orgId)
    }
}
