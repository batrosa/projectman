import SwiftUI

struct LoginView: View {
    @StateObject private var auth = AuthService()
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 22) {
                    VStack(spacing: 10) {
                        Image(systemName: "building.2.fill")
                            .font(.system(size: 46))
                            .foregroundStyle(Theme.primary)
                        Text("HoldingMan")
                            .font(.largeTitle.bold())
                            .foregroundStyle(Theme.textPrimary)
                        Text("Проекты, задачи и сроки холдинга под контролем")
                            .font(.subheadline)
                            .foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 60)

                    VStack(spacing: 12) {
                        TextField("Email", text: $email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(14)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(Theme.textPrimary)

                        SecureField("Пароль", text: $password)
                            .textContentType(.password)
                            .padding(14)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(Theme.textPrimary)

                        Button {
                            Task { await auth.signIn(email: email, password: password) }
                        } label: {
                            Text("Войти")
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(auth.isBusy || email.isEmpty || password.isEmpty)

                        HStack {
                            Rectangle().fill(Theme.textSecondary.opacity(0.25)).frame(height: 1)
                            Text("или").font(.caption).foregroundStyle(Theme.textSecondary)
                            Rectangle().fill(Theme.textSecondary.opacity(0.25)).frame(height: 1)
                        }
                        .padding(.vertical, 4)

                        Button {
                            Task { await auth.startTelegramLogin() }
                        } label: {
                            Label("Войти через Telegram", systemImage: "paperplane.fill")
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                        }
                        .buttonStyle(.bordered)
                        .disabled(auth.isBusy)
                    }
                    .padding(.horizontal, 24)

                    if let message = auth.statusMessage {
                        HStack(spacing: 8) {
                            if auth.isBusy && !auth.statusIsSuccess {
                                ProgressView().tint(Theme.primary)
                            }
                            Text(message)
                                .font(.footnote)
                                .foregroundStyle(auth.statusIsSuccess ? Theme.statusDone : Theme.danger)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity)
                        .background(
                            (auth.statusIsSuccess ? Theme.statusDone : Theme.danger).opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 10)
                        )
                        .padding(.horizontal, 24)
                        .transition(.opacity)
                    }

                    Spacer(minLength: 40)
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: auth.statusMessage)
    }
}
