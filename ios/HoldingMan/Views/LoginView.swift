import SwiftUI
import AuthenticationServices

struct LoginView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var auth = AuthService()

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 28) {
                        Spacer(minLength: 28)

                        header

                    VStack(spacing: 12) {
                        SignInWithAppleButton(.signIn) { request in
                            auth.prepareAppleRequest(request)
                        } onCompletion: { result in
                            Task { await auth.completeAppleSignIn(result) }
                        }
                        .environment(\.locale, Locale(identifier: "ru_RU"))
                        .signInWithAppleButtonStyle(.whiteOutline)
                        .frame(height: 54)
                        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .disabled(auth.isBusy)
                        .accessibilityLabel("Войти через Apple")

                        Button {
                            Task { await auth.signInWithGoogle() }
                        } label: {
                            HStack(spacing: 10) {
                                GoogleLogoView()
                                    .frame(width: 22, height: 22)
                                Text("Войти через Google")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(ProviderButtonStyle(tint: Color(hex: 0x4285F4)))
                        .disabled(auth.isBusy)

                        Button {
                            Task { await auth.startTelegramLogin() }
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "paperplane.fill")
                                    .font(.system(size: 17, weight: .semibold))
                                Text("Войти через Telegram")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(ProviderButtonStyle(tint: Color(hex: 0x229ED9)))
                        .disabled(auth.isBusy)
                    }
                    .padding(.horizontal, 24)

                    if auth.isBusy {
                        ProgressView()
                            .tint(Theme.primary)
                    }

                    statusBanner
                        Spacer(minLength: 28)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: geometry.size.height)
                }
            }
        }
        .animation(.spring(duration: 0.3), value: auth.statusMessage)
        .onAppear { Task { await auth.resumeTelegramLoginIfNeeded() } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await auth.resumeTelegramLoginIfNeeded() }
            }
        }
    }

    private var header: some View {
        VStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Theme.primaryGradient)
                    .frame(width: 84, height: 84)
                    .shadow(color: Theme.primary.opacity(0.35), radius: 18, y: 8)
                Image(systemName: "building.2.fill")
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(.white)
            }

            VStack(spacing: 6) {
                Text("HoldingMan")
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .foregroundStyle(Theme.textPrimary)
                Text("Выберите один способ входа")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    @ViewBuilder
    private var statusBanner: some View {
        if let message = auth.statusMessage {
            HStack(spacing: 10) {
                Image(systemName: auth.statusIsSuccess ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundStyle(auth.statusIsSuccess ? Theme.statusDone : Theme.danger)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(auth.statusIsSuccess ? Theme.statusDone : Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                (auth.statusIsSuccess ? Theme.statusDone : Theme.danger).opacity(0.1),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .padding(.horizontal, 24)
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }
}

private struct ProviderButtonStyle: ButtonStyle {
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(tint)
            .frame(height: 54)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(tint.opacity(0.45), lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}

struct GoogleLogoView: View {
    var body: some View {
        ZStack {
            Circle().trim(from: 0.04, to: 0.28).stroke(Color(hex: 0x4285F4), style: stroke)
            Circle().trim(from: 0.28, to: 0.50).stroke(Color(hex: 0x34A853), style: stroke)
            Circle().trim(from: 0.50, to: 0.72).stroke(Color(hex: 0xFBBC05), style: stroke)
            Circle().trim(from: 0.72, to: 0.96).stroke(Color(hex: 0xEA4335), style: stroke)
            Rectangle()
                .fill(Color(hex: 0x4285F4))
                .frame(width: 9, height: 4)
                .offset(x: 5, y: 1)
        }
        .rotationEffect(.degrees(-35))
        .accessibilityHidden(true)
    }

    private var stroke: StrokeStyle {
        StrokeStyle(lineWidth: 4.2, lineCap: .butt)
    }
}
