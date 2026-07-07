import SwiftUI

struct LoginView: View {
    @StateObject private var auth = AuthService()
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 28) {
                    header
                        .padding(.top, 64)

                    VStack(spacing: 12) {
                        inputField(
                            icon: "envelope.fill",
                            placeholder: "Email",
                            text: $email,
                            field: .email
                        )
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .onSubmit { focusedField = .password }

                        secureInputField

                        Button {
                            focusedField = nil
                            Task { await auth.signIn(email: email, password: password) }
                        } label: {
                            if auth.isBusy {
                                ProgressView().tint(.white)
                            } else {
                                Text("Войти")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(auth.isBusy || email.isEmpty || password.isEmpty)
                        .opacity(email.isEmpty || password.isEmpty ? 0.55 : 1)

                        HStack(spacing: 12) {
                            line
                            Text("или")
                                .font(.caption)
                                .foregroundStyle(Theme.textSecondary)
                            line
                        }
                        .padding(.vertical, 2)

                        Button {
                            focusedField = nil
                            Task { await auth.startTelegramLogin() }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "paperplane.fill")
                                Text("Войти через Telegram")
                            }
                        }
                        .buttonStyle(SoftButtonStyle(tint: Color(hex: 0x0EA5E9)))
                        .disabled(auth.isBusy)
                    }
                    .padding(.horizontal, 24)

                    statusBanner

                    Spacer(minLength: 40)
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .animation(.spring(duration: 0.3), value: auth.statusMessage)
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
                Text("Проекты, задачи и сроки холдинга\nпод контролем")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var line: some View {
        Rectangle()
            .fill(Theme.hairline)
            .frame(height: 1)
    }

    private func inputField(icon: String, placeholder: String, text: Binding<String>, field: Field) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundStyle(focusedField == field ? Theme.primary : Theme.textSecondary)
                .frame(width: 20)
            TextField(placeholder, text: text)
                .foregroundStyle(Theme.textPrimary)
                .focused($focusedField, equals: field)
        }
        .padding(.horizontal, 14)
        .frame(height: 52)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(focusedField == field ? Theme.primary.opacity(0.55) : Theme.hairline, lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.15), value: focusedField)
    }

    private var secureInputField: some View {
        HStack(spacing: 10) {
            Image(systemName: "lock.fill")
                .font(.subheadline)
                .foregroundStyle(focusedField == .password ? Theme.primary : Theme.textSecondary)
                .frame(width: 20)
            SecureField("Пароль", text: $password)
                .textContentType(.password)
                .foregroundStyle(Theme.textPrimary)
                .focused($focusedField, equals: .password)
                .submitLabel(.go)
                .onSubmit {
                    guard !email.isEmpty, !password.isEmpty else { return }
                    Task { await auth.signIn(email: email, password: password) }
                }
        }
        .padding(.horizontal, 14)
        .frame(height: 52)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(focusedField == .password ? Theme.primary.opacity(0.55) : Theme.hairline, lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.15), value: focusedField)
    }

    @ViewBuilder
    private var statusBanner: some View {
        if let message = auth.statusMessage {
            HStack(spacing: 10) {
                if auth.isBusy && !auth.statusIsSuccess {
                    ProgressView().tint(Theme.primary)
                } else {
                    Image(systemName: auth.statusIsSuccess ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(auth.statusIsSuccess ? Theme.statusDone : Theme.danger)
                }
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
