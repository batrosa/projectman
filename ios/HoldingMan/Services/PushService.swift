import Foundation
import UIKit
import FirebaseAuth
import FirebaseFirestore
import FirebaseMessaging
import GoogleSignIn
import UserNotifications

// Push-инфраструктура (roadmap Этап 3):
//   APNs -> FCM token -> users/{uid}/devices/{deviceId} -> серверная отправка
//   (lib/push-send.js) при создании agentNotifications.
// Токен привязывается к устройству (identifierForVendor), при logout —
// отвязывается. Доставка заработает после загрузки APNs-ключа в Firebase
// Console (см. ios/README.md); до этого всё деградирует тихо.
@MainActor
final class PushService: NSObject, ObservableObject {
    static let shared = PushService()

    private var lastSavedToken: String?
    private var isConfigured = false

    private var deviceId: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "unknown-device"
    }

    // Вызывается после входа: запросить разрешение, зарегистрироваться в APNs.
    func enable() {
        isConfigured = true
        UNUserNotificationCenter.current().delegate = self
        Messaging.messaging().delegate = self

        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
                    if let error { print("push: authorization request failed —", error.localizedDescription) }
                    guard granted else {
                        print("push: authorization denied")
                        return
                    }
                    Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
                }
            case .authorized, .provisional, .ephemeral:
                Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
            case .denied:
                print("push: authorization denied in iOS settings")
            @unknown default:
                Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
            }
        }

        // Если APNs уже привязан к Firebase Messaging (например, повторный вход
        // без перезапуска приложения), сохраняем текущий FCM-токен сразу.
        refreshAndSaveToken(reason: "enable", forceWrite: false)
    }

    func handleAPNsDeviceToken(_ deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
        // Критично: FCM-токен, полученный ДО APNs-токена, может не доставлять
        // уведомления через APNs. После APNs callback перечитываем и
        // пересохраняем токен, даже если строка токена визуально не изменилась.
        refreshAndSaveToken(reason: "apns", forceWrite: true)
    }

    private func refreshAndSaveToken(reason: String, forceWrite: Bool) {
        guard isConfigured else { return }
        Messaging.messaging().token { [weak self] token, error in
            if let error {
                print("push: FCM token fetch failed (\(reason)) —", error.localizedDescription)
                return
            }
            guard let token else { return }
            Task { @MainActor [weak self] in self?.saveToken(token, force: forceWrite) }
        }
    }

    private func saveToken(_ token: String, force: Bool = false) {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        guard force || token != lastSavedToken else { return }
        lastSavedToken = token
        Firestore.firestore()
            .collection("users").document(uid)
            .collection("devices").document(deviceId)
            .setData([
                "fcmToken": token,
                "platform": "ios",
                "updatedAt": FieldValue.serverTimestamp(),
            ], merge: true) { error in
                if let error { print("push: token save failed —", error.localizedDescription) }
            }
    }

    // При logout токен отвязывается ДО signOut (после — правила не пустят).
    func unregister() async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        lastSavedToken = nil
        isConfigured = false
        try? await Firestore.firestore()
            .collection("users").document(uid)
            .collection("devices").document(deviceId)
            .delete()
    }
}

extension PushService: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        Task { @MainActor in self.saveToken(fcmToken) }
    }
}

extension PushService: UNUserNotificationCenterDelegate {
    // Показ баннера, когда приложение открыто
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    // Тап по системному push: сервер кладёт taskId/projectId в data —
    // открываем задачу прямо в нужном разделе (см. MainTabView.onReceive)
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let taskId = userInfo["taskId"] as? String
        let projectId = userInfo["projectId"] as? String
        Task { @MainActor in
            if let taskId, let projectId, !taskId.isEmpty, !projectId.isEmpty {
                NotificationCenter.default.post(
                    name: .hmOpenTask,
                    object: nil,
                    userInfo: ["taskId": taskId, "projectId": projectId]
                )
            }
            completionHandler()
        }
    }
}

// APNs-токен пробрасывается в FCM через AppDelegate (SwiftUI adaptor).
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ app: UIApplication,
                     open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            PushService.shared.handleAPNsDeviceToken(deviceToken)
        }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("push: APNs registration failed —", error.localizedDescription)
    }
}
