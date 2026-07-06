import Foundation
import FirebaseAuth
import UIKit

// Вход: email/пароль (Firebase Auth) и Telegram-бот — тот же серверный флоу,
// что в web (start → открыть бота → poll status → custom token).
@MainActor
final class AuthService: ObservableObject {
    @Published var isBusy = false
    @Published var statusMessage: String?
    @Published var statusIsSuccess = false

    private var telegramAttempt = 0

    func signIn(email: String, password: String) async {
        isBusy = true
        setStatus(nil)
        defer { isBusy = false }
        do {
            try await Auth.auth().signIn(withEmail: email, password: password)
        } catch {
            setStatus(Self.ruAuthError(error))
        }
    }

    func startTelegramLogin() async {
        telegramAttempt += 1
        let attempt = telegramAttempt
        isBusy = true
        setStatus("Открываю Telegram-бота...")
        defer { if attempt == telegramAttempt { isBusy = false } }

        do {
            let start = try await ApiClient.startTelegramBotLogin()
            await UIApplication.shared.open(start.botUrl)
            setStatus("Нажмите Start в Telegram-боте. После подтверждения вход завершится автоматически.")

            var delay: UInt64 = 0
            while attempt == telegramAttempt && Date() < start.expiresAt {
                if delay > 0 { try await Task.sleep(nanoseconds: delay) }
                delay = min(delay + 500_000_000, 2_000_000_000)
                guard let token = try await ApiClient.pollTelegramBotLogin(code: start.code) else { continue }
                setStatus("Вход подтверждён. Загружаем рабочее пространство...", success: true)
                try await Auth.auth().signIn(withCustomToken: token)
                return
            }
            if attempt == telegramAttempt {
                setStatus("Ссылка для входа устарела. Нажмите «Войти через Telegram» ещё раз.")
            }
        } catch {
            if attempt == telegramAttempt {
                setStatus((error as? ApiError)?.errorDescription ?? "Не удалось войти через Telegram-бота.")
            }
        }
    }

    func cancelTelegramLogin() {
        telegramAttempt += 1
        isBusy = false
        setStatus(nil)
    }

    private func setStatus(_ message: String?, success: Bool = false) {
        statusMessage = message
        statusIsSuccess = success
    }

    private static func ruAuthError(_ error: Error) -> String {
        let code = AuthErrorCode(rawValue: (error as NSError).code)
        switch code {
        case .wrongPassword, .invalidCredential: return "Неверный email или пароль."
        case .invalidEmail: return "Некорректный email."
        case .userNotFound: return "Пользователь не найден."
        case .tooManyRequests: return "Слишком много попыток. Подождите и попробуйте снова."
        case .networkError: return "Ошибка сети. Проверьте подключение."
        default: return "Не удалось войти. Попробуйте ещё раз."
        }
    }
}
