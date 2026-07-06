import SwiftUI
import FirebaseCore

@main
struct HoldingManApp: App {
    @StateObject private var appState = AppState()

    init() {
        FirebaseApp.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .tint(Theme.primary)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Group {
            switch appState.phase {
            case .loading:
                ZStack {
                    Theme.background.ignoresSafeArea()
                    VStack(spacing: 14) {
                        Image(systemName: "building.2.fill")
                            .font(.system(size: 42))
                            .foregroundStyle(Theme.primary)
                        Text("HoldingMan")
                            .font(.title2.bold())
                            .foregroundStyle(Theme.textPrimary)
                        ProgressView()
                            .tint(Theme.primary)
                    }
                }
            case .signedOut:
                LoginView()
            case .needsOrganization:
                OrgSelectView()
            case .ready:
                MainTabView()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: phaseKey)
        .onAppear { appState.start() }
    }

    private var phaseKey: Int {
        switch appState.phase {
        case .loading: return 0
        case .signedOut: return 1
        case .needsOrganization: return 2
        case .ready: return 3
        }
    }
}
