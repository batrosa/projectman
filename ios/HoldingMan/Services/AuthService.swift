import Foundation
import FirebaseAuth
import FirebaseCore
import GoogleSignIn
import AuthenticationServices
import CryptoKit
import Security
import UIKit

// Взаимоисключающие способы входа. Провайдеры не привязываются друг к
// другу: выбранный при регистрации способ сохраняется в профиле сервером.
@MainActor
final class AuthService: ObservableObject {
    @Published var isBusy = false
    @Published var statusMessage: String?
    @Published var statusIsSuccess = false
    @Published var pendingVerificationEmail: String?

    private let telegramPendingKey = "holdingman.telegramLogin.pending"
    private var telegramAttempt = 0
    private var currentNonce: String?

    private struct PendingTelegramLogin: Codable {
        let code: String
        let expiresAt: Date
    }

    func registerWithEmail(email: String, password: String, confirmation: String) async {
        guard !isBusy else { return }
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.looksLikeEmail(normalizedEmail) else {
            setStatus("Введите корректный email.")
            return
        }
        guard password.count >= 8 else {
            setStatus("Пароль должен содержать минимум 8 символов.")
            return
        }
        guard password == confirmation else {
            setStatus("Пароли не совпадают.")
            return
        }

        isBusy = true
        setStatus(nil)
        defer { isBusy = false }
        do {
            let result = try await Auth.auth().createUser(withEmail: normalizedEmail, password: password)
            pendingVerificationEmail = result.user.email ?? normalizedEmail
            try await result.user.sendEmailVerification()
            setStatus("Письмо отправлено. Подтвердите email, чтобы продолжить.", success: true)
        } catch {
            setStatus(Self.ruAuthError(error))
        }
    }

    func signInWithEmail(email: String, password: String) async {
        guard !isBusy else { return }
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.looksLikeEmail(normalizedEmail), !password.isEmpty else {
            setStatus("Введите email и пароль.")
            return
        }

        isBusy = true
        setStatus(nil)
        defer { isBusy = false }
        do {
            let result = try await Auth.auth().signIn(withEmail: normalizedEmail, password: password)
            if Self.isUnverifiedEmailUser(result.user) {
                pendingVerificationEmail = result.user.email ?? normalizedEmail
                setStatus("Подтвердите регистрацию по ссылке из письма.", success: true)
                return
            }
            try await bootstrapOrSignOut()
        } catch {
            setStatus(Self.ruAuthError(error))
        }
    }

    func sendPasswordReset(email: String) async {
        guard !isBusy else { return }
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.looksLikeEmail(normalizedEmail) else {
            setStatus("Введите email, на который отправить ссылку.")
            return
        }
        isBusy = true
        setStatus(nil)
        defer { isBusy = false }
        do {
            try await Auth.auth().sendPasswordReset(withEmail: normalizedEmail)
            setStatus("Ссылка для восстановления пароля отправлена на почту.", success: true)
        } catch {
            setStatus(Self.ruAuthError(error))
        }
    }

    func resumeEmailVerificationIfNeeded() async {
        guard let user = Auth.auth().currentUser, Self.isEmailUser(user) else {
            pendingVerificationEmail = nil
            return
        }
        if Self.isUnverifiedEmailUser(user) {
            pendingVerificationEmail = user.email
            return
        }
        pendingVerificationEmail = nil
        do {
            try await bootstrapOrSignOut()
        } catch {
            setStatus(Self.ruAuthError(error))
        }
    }

    func checkEmailVerification(silent: Bool = false) async {
        guard !isBusy, let user = Auth.auth().currentUser, Self.isEmailUser(user) else { return }
        isBusy = true
        if !silent { setStatus(nil) }
        defer { isBusy = false }
        do {
            try await user.reload()
            guard user.isEmailVerified else {
                if !silent { setStatus("Email ещё не подтверждён. Перейдите по ссылке из письма.") }
                return
            }
            _ = try await user.getIDTokenResult(forcingRefresh: true)
            pendingVerificationEmail = nil
            setStatus("Email подтверждён. Готовим профиль…", success: true)
            try await bootstrapOrSignOut()
        } catch {
            setStatus(Self.ruAuthError(error))
        }
    }

    func resendEmailVerification() async {
        guard !isBusy, let user = Auth.auth().currentUser, Self.isUnverifiedEmailUser(user) else { return }
        isBusy = true
        setStatus(nil)
        defer { isBusy = false }
        do {
            try await user.sendEmailVerification()
            setStatus("Новое письмо отправлено.", success: true)
        } catch {
            setStatus(Self.ruAuthError(error))
        }
    }

    func useDifferentEmail() {
        try? Auth.auth().signOut()
        pendingVerificationEmail = nil
        setStatus(nil)
    }

    func signInWithGoogle() async {
        guard !isBusy else { return }
        isBusy = true
        setStatus(nil)
        defer { isBusy = false }

        do {
            guard let clientID = FirebaseApp.app()?.options.clientID, !clientID.isEmpty else {
                throw FederatedAuthError.googleClientMissing
            }
            guard let presenter = Self.presentingViewController() else {
                throw FederatedAuthError.presenterMissing
            }

            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
            guard let idToken = result.user.idToken?.tokenString else {
                throw FederatedAuthError.tokenMissing
            }
            let credential = GoogleAuthProvider.credential(
                withIDToken: idToken,
                accessToken: result.user.accessToken.tokenString
            )
            _ = try await Auth.auth().signIn(with: credential)
            try await bootstrapOrSignOut()
        } catch {
            if (error as NSError).code == GIDSignInError.canceled.rawValue { return }
            setStatus(Self.ruAuthError(error))
        }
    }

    func prepareAppleRequest(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = Self.randomNonceString()
        currentNonce = nonce
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(nonce)
    }

    func completeAppleSignIn(_ result: Result<ASAuthorization, Error>) async {
        guard !isBusy else { return }
        isBusy = true
        setStatus(nil)
        defer {
            isBusy = false
            currentNonce = nil
        }

        do {
            let authorization = try result.get()
            guard let appleIDCredential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let nonce = currentNonce,
                  let tokenData = appleIDCredential.identityToken,
                  let idToken = String(data: tokenData, encoding: .utf8) else {
                throw FederatedAuthError.tokenMissing
            }
            let credential = OAuthProvider.appleCredential(
                withIDToken: idToken,
                rawNonce: nonce,
                fullName: appleIDCredential.fullName
            )
            _ = try await Auth.auth().signIn(with: credential)
            try await bootstrapOrSignOut()
        } catch {
            if (error as? ASAuthorizationError)?.code == .canceled { return }
            setStatus(Self.ruAuthError(error))
        }
    }

    func startTelegramLogin() async {
        if loadPendingTelegramLogin() != nil {
            await resumeTelegramLoginIfNeeded()
            return
        }
        telegramAttempt += 1
        let attempt = telegramAttempt
        isBusy = true
        setStatus("Открываю Telegram-бота...")
        defer { if attempt == telegramAttempt { isBusy = false } }

        do {
            let start = try await ApiClient.startTelegramBotLogin()
            savePendingTelegramLogin(code: start.code, expiresAt: start.expiresAt)
            await UIApplication.shared.open(start.botUrl)
            setStatus("Нажмите Start в Telegram-боте, затем вернитесь в приложение.")

            // Если Telegram открылся поверх приложения без полноценного ухода в
            // фон, эта отложенная проверка завершит вход. Если приложение ушло в
            // фон, задача продолжится при возврате; LoginView также дернёт resume.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await self?.resumeTelegramLoginIfNeeded()
            }
        } catch {
            if attempt == telegramAttempt {
                setStatus((error as? ApiError)?.errorDescription ?? "Не удалось войти через Telegram-бота.")
            }
        }
    }

    func resumeTelegramLoginIfNeeded() async {
        guard let pending = loadPendingTelegramLogin() else { return }
        guard !isBusy else { return }
        if Date() >= pending.expiresAt {
            clearPendingTelegramLogin()
            setStatus("Ссылка для входа устарела. Нажмите «Войти через Telegram» ещё раз.")
            return
        }
        telegramAttempt += 1
        let attempt = telegramAttempt
        isBusy = true
        setStatus("Проверяю подтверждение в Telegram...")
        defer { if attempt == telegramAttempt { isBusy = false } }

        var delay: UInt64 = 0
        while attempt == telegramAttempt && Date() < pending.expiresAt {
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            delay = min(delay + 700_000_000, 2_000_000_000)
            do {
                guard let token = try await ApiClient.pollTelegramBotLogin(code: pending.code) else { continue }
                clearPendingTelegramLogin()
                setStatus(nil)
                try await Auth.auth().signIn(withCustomToken: token)
                try await bootstrapOrSignOut()
                return
            } catch ApiError.network {
                // Во время перехода Telegram -> ProjectMan iOS может отменить
                // один polling-запрос. Не показываем ложную ошибку, продолжаем
                // проверку до истечения кода.
                continue
            } catch {
                if attempt == telegramAttempt {
                    clearPendingTelegramLogin()
                    setStatus((error as? ApiError)?.errorDescription ?? "Не удалось войти через Telegram-бота.")
                }
                return
            }
        }
        if attempt == telegramAttempt {
            clearPendingTelegramLogin()
            setStatus("Ссылка для входа устарела. Нажмите «Войти через Telegram» ещё раз.")
        }
    }

    func cancelTelegramLogin() {
        telegramAttempt += 1
        isBusy = false
        clearPendingTelegramLogin()
        setStatus(nil)
    }

    private func setStatus(_ message: String?, success: Bool = false) {
        statusMessage = message
        statusIsSuccess = success
    }

    private func bootstrapOrSignOut() async throws {
        do {
            try await ApiClient.bootstrapAuthProfile()
        } catch {
            try? Auth.auth().signOut()
            throw error
        }
    }

    private enum FederatedAuthError: Error {
        case googleClientMissing
        case presenterMissing
        case tokenMissing
    }

    private static func ruAuthError(_ error: Error) -> String {
        if let local = error as? FederatedAuthError {
            switch local {
            case .googleClientMissing:
                return "Google-вход ещё не настроен: обновите GoogleService-Info.plist в Firebase."
            case .presenterMissing:
                return "Не удалось открыть окно входа. Попробуйте ещё раз."
            case .tokenMissing:
                return "Сервис входа не вернул токен. Попробуйте ещё раз."
            }
        }
        let code = AuthErrorCode(rawValue: (error as NSError).code)
        if let apiError = error as? ApiError, let message = apiError.errorDescription {
            return message
        }
        switch code {
        case .emailAlreadyInUse:
            return "Аккаунт с этой почтой уже существует. Войдите или восстановите пароль."
        case .invalidEmail:
            return "Введите корректный email."
        case .weakPassword:
            return "Пароль слишком простой. Используйте минимум 8 символов."
        case .wrongPassword, .userNotFound, .invalidCredential:
            return "Неверный email или пароль."
        case .tooManyRequests:
            return "Слишком много попыток. Подождите и попробуйте ещё раз."
        case .credentialAlreadyInUse:
            return "Этот вход уже относится к другому аккаунту. Автоматическое объединение запрещено для защиты данных."
        case .accountExistsWithDifferentCredential:
            return "Аккаунт с этой почтой уже существует. Войдите способом, выбранным при регистрации."
        case .operationNotAllowed:
            return "Этот способ входа ещё не включён в Firebase."
        case .networkError:
            return "Ошибка сети. Проверьте подключение."
        default:
            return "Не удалось выполнить вход. Попробуйте ещё раз."
        }
    }

    private static func isEmailUser(_ user: FirebaseAuth.User) -> Bool {
        user.providerData.contains { $0.providerID == "password" }
    }

    private static func isUnverifiedEmailUser(_ user: FirebaseAuth.User) -> Bool {
        isEmailUser(user) && !user.isEmailVerified
    }

    private static func looksLikeEmail(_ value: String) -> Bool {
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".")
    }

    private static func presentingViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let root = scenes.flatMap(\.windows).first(where: { $0.isKeyWindow })?.rootViewController
        var current = root
        while let presented = current?.presentedViewController { current = presented }
        return current
    }

    private static func randomNonceString(length: Int = 32) -> String {
        precondition(length > 0)
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remainingLength = length
        while remainingLength > 0 {
            var randoms = [UInt8](repeating: 0, count: 16)
            let status = SecRandomCopyBytes(kSecRandomDefault, randoms.count, &randoms)
            precondition(status == errSecSuccess)
            for random in randoms where remainingLength > 0 {
                if Int(random) < charset.count {
                    result.append(charset[Int(random)])
                    remainingLength -= 1
                }
            }
        }
        return result
    }

    private static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func savePendingTelegramLogin(code: String, expiresAt: Date) {
        let pending = PendingTelegramLogin(code: code, expiresAt: expiresAt)
        if let data = try? JSONEncoder().encode(pending) {
            UserDefaults.standard.set(data, forKey: telegramPendingKey)
        }
    }

    private func loadPendingTelegramLogin() -> PendingTelegramLogin? {
        guard let data = UserDefaults.standard.data(forKey: telegramPendingKey),
              let pending = try? JSONDecoder().decode(PendingTelegramLogin.self, from: data) else {
            return nil
        }
        return pending
    }

    private func clearPendingTelegramLogin() {
        UserDefaults.standard.removeObject(forKey: telegramPendingKey)
    }
}
