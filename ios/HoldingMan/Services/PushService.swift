import Foundation
import UIKit
import FirebaseAuth
import FirebaseFirestore
import FirebaseMessaging
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

    private var deviceId: String {
        UIDevice.current.identifierForVendor?.uuidString ?? "unknown-device"
    }

    // Вызывается после входа: запросить разрешение, зарегистрироваться в APNs.
    func enable() {
        UNUserNotificationCenter.current().delegate = self
        Messaging.messaging().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
        // Если токен уже есть (повторный вход) — сохранить сразу
        Messaging.messaging().token { [weak self] token, _ in
            guard let token else { return }
            Task { @MainActor [weak self] in self?.saveToken(token) }
        }
    }

    private func saveToken(_ token: String) {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        guard token != lastSavedToken else { return }
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
}

// APNs-токен пробрасывается в FCM через AppDelegate (SwiftUI adaptor).
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("push: APNs registration failed —", error.localizedDescription)
    }
}
