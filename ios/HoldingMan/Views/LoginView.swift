import SwiftUI
import AuthenticationServices

struct LoginView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var auth = AuthService()
    @State private var mode: EmailMode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var passwordConfirmation = ""
    @FocusState private var focusedField: Field?

    private enum EmailMode: Equatable { case login, register }
    private enum Field { case email, password, confirmation }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 22) {
                        Spacer(minLength: 24)
                        header

                        if auth.pendingVerificationEmail != nil {
                            verificationCard
                        } else {
                            emailCard
                            providerSection
                        }

                        if auth.isBusy {
                            ProgressView()
                                .tint(Theme.primary)
                        }

                        statusBanner
                        Spacer(minLength: 28)
                    }
                    .padding(.horizontal, 20)
                    .frame(maxWidth: 560)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: geometry.size.height)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .animation(.spring(duration: 0.3), value: auth.statusMessage)
        .animation(.spring(duration: 0.3), value: auth.pendingVerificationEmail)
        .onAppear {
            Task {
                await auth.resumeEmailVerificationIfNeeded()
                await auth.resumeTelegramLoginIfNeeded()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    if auth.pendingVerificationEmail != nil {
                        await auth.checkEmailVerification(silent: true)
                    }
                    await auth.resumeTelegramLoginIfNeeded()
                }
            }
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            BrandLogoView(size: 78)

            VStack(spacing: 5) {
                Text("ProjectMan")
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .foregroundStyle(Theme.textPrimary)
                Text(auth.pendingVerificationEmail == nil
                     ? "Войдите в рабочее пространство"
                     : "Подтвердите регистрацию")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private var emailCard: some View {
        VStack(spacing: 16) {
            HStack(spacing: 4) {
                modeButton("Вход", target: .login)
                modeButton("Регистрация", target: .register)
            }
            .padding(4)
            .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 13, style: .continuous))

            VStack(spacing: 11) {
                authField(
                    title: "Корпоративная или личная почта",
                    systemImage: "envelope",
                    text: $email,
                    field: .email,
                    secure: false
                )
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .submitLabel(.next)
                .onSubmit { focusedField = .password }

                authField(
                    title: "Пароль",
                    systemImage: "lock",
                    text: $password,
                    field: .password,
                    secure: true
                )
                .textContentType(mode == .login ? .password : .newPassword)
                .submitLabel(mode == .login ? .go : .next)
                .onSubmit {
                    if mode == .login { submitEmailForm() }
                    else { focusedField = .confirmation }
                }

                if mode == .register {
                    authField(
                        title: "Повторите пароль",
                        systemImage: "lock.rotation",
                        text: $passwordConfirmation,
                        field: .confirmation,
                        secure: true
                    )
                    .textContentType(.newPassword)
                    .submitLabel(.go)
                    .onSubmit { submitEmailForm() }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }

            Button(action: submitEmailForm) {
                Text(mode == .login ? "Войти" : "Создать аккаунт")
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(auth.isBusy)

            if mode == .login {
                Button("Забыли пароль?") {
                    focusedField = nil
                    Task { await auth.sendPasswordReset(email: email) }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.primary)
                .disabled(auth.isBusy)
            } else {
                Label("После регистрации мы отправим письмо. Подтвердите email — затем откроется ввод имени и фамилии. Если письма нет во входящих, проверьте папку «Спам».", systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(18)
        .card(cornerRadius: 20)
    }

    private var providerSection: some View {
        VStack(spacing: 13) {
            HStack(spacing: 12) {
                Rectangle().fill(Theme.hairline).frame(height: 1)
                Text("или войдите через")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize()
                Rectangle().fill(Theme.hairline).frame(height: 1)
            }

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
                    GoogleLogoView().frame(width: 22, height: 22)
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
    }

    private var verificationCard: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle()
                    .fill(Theme.primary.opacity(0.12))
                    .frame(width: 68, height: 68)
                Image(systemName: "envelope.badge")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(Theme.primary)
            }

            VStack(spacing: 7) {
                Text("Проверьте почту")
                    .font(.title3.bold())
                    .foregroundStyle(Theme.textPrimary)
                Text("Мы отправили ссылку подтверждения на")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                Text(auth.pendingVerificationEmail ?? "")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.center)
            }

            Text("Перейдите по ссылке в письме, вернитесь в приложение и нажмите кнопку ниже. После подтверждения откроется ввод имени и фамилии. Если письма нет во входящих, обязательно проверьте папку «Спам».")
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Button("Я подтвердил email") {
                Task { await auth.checkEmailVerification() }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(auth.isBusy)

            HStack(spacing: 18) {
                Button("Отправить ещё раз") {
                    Task { await auth.resendEmailVerification() }
                }
                Button("Другой email") {
                    auth.useDifferentEmail()
                    password = ""
                    passwordConfirmation = ""
                }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.primary)
            .disabled(auth.isBusy)
        }
        .padding(22)
        .card(cornerRadius: 20)
    }

    private func modeButton(_ title: String, target: EmailMode) -> some View {
        Button {
            mode = target
            password = ""
            passwordConfirmation = ""
            auth.statusMessage = nil
        } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(mode == target ? Theme.textPrimary : Theme.textSecondary)
                .frame(maxWidth: .infinity)
                .frame(height: 38)
                .background(
                    mode == target ? Theme.surface : Color.clear,
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .shadow(color: mode == target ? Color.black.opacity(0.06) : .clear, radius: 6, y: 2)
        }
        .buttonStyle(.plain)
    }

    private func authField(
        title: String,
        systemImage: String,
        text: Binding<String>,
        field: Field,
        secure: Bool
    ) -> some View {
        HStack(spacing: 11) {
            Image(systemName: systemImage)
                .frame(width: 20)
                .foregroundStyle(focusedField == field ? Theme.primary : Theme.textSecondary)
            Group {
                if secure {
                    SecureField(title, text: text)
                } else {
                    TextField(title, text: text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .foregroundStyle(Theme.textPrimary)
            .focused($focusedField, equals: field)
        }
        .padding(.horizontal, 14)
        .frame(height: 52)
        .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(focusedField == field ? Theme.primary.opacity(0.58) : Theme.hairline, lineWidth: 1)
        )
    }

    private func submitEmailForm() {
        focusedField = nil
        Task {
            if mode == .login {
                await auth.signInWithEmail(email: email, password: password)
            } else {
                await auth.registerWithEmail(
                    email: email,
                    password: password,
                    confirmation: passwordConfirmation
                )
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
