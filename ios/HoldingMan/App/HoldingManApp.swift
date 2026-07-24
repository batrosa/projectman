import SwiftUI
import FirebaseCore
import UIKit

private struct KeyboardDismissInstaller: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        DispatchQueue.main.async { context.coordinator.install(from: view) }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        DispatchQueue.main.async { context.coordinator.install(from: uiView) }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.uninstall()
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private weak var installedWindow: UIWindow?
        private var recognizer: UITapGestureRecognizer?

        func install(from view: UIView) {
            guard let window = view.window else { return }
            if installedWindow === window, recognizer != nil { return }
            uninstall()
            let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            window.addGestureRecognizer(tap)
            installedWindow = window
            recognizer = tap
        }

        func uninstall() {
            if let recognizer { installedWindow?.removeGestureRecognizer(recognizer) }
            recognizer = nil
            installedWindow = nil
        }

        @objc private func dismissKeyboard() {
            installedWindow?.endEditing(true)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view = touch.view
            while let current = view {
                if current is UITextField || current is UITextView { return false }
                view = current.superview
            }
            return true
        }
    }
}

@main
struct ProjectSferaApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @StateObject private var appState = AppState()
    @AppStorage("appearance") private var appearanceRaw = Appearance.system.rawValue

    init() {
        FirebaseApp.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .tint(Theme.primary)
                .preferredColorScheme((Appearance(rawValue: appearanceRaw) ?? .system).colorScheme)
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
                        BrandLogoView(size: 76)
                        Text("ProjectSfera")
                            .font(.title2.bold())
                            .foregroundStyle(Theme.textPrimary)
                        ProgressView()
                            .tint(Theme.primary)
                    }
                }
            case .signedOut:
                LoginView()
            case .needsProfile:
                NameSetupView()
            case .needsOrganization:
                OrgSelectView()
            case .ready:
                #if DEBUG
                if DemoData.isEnabled, let screen = DemoData.screen {
                    DemoScreenRouter(screen: screen)
                } else {
                    MainTabView()
                }
                #else
                MainTabView()
                #endif
            }
        }
        .background {
            KeyboardDismissInstaller()
                .frame(width: 0, height: 0)
        }
        .animation(.easeInOut(duration: 0.25), value: phaseKey)
        .onAppear { appState.start() }
    }

    private var phaseKey: Int {
        switch appState.phase {
        case .loading: return 0
        case .signedOut: return 1
        case .needsProfile: return 2
        case .needsOrganization: return 3
        case .ready: return 4
        }
    }
}
