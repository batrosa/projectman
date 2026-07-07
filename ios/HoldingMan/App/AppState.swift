import Foundation
import FirebaseAuth
import FirebaseFirestore

// Глобальное состояние: авторизация + собственный документ пользователя.
// Слушатель own user doc — как в web (subscribeToOwnUserDoc): ловит смену
// роли/организации без перезахода. Кэшовые снапшоты не считаются отзывом
// доступа (тот же урок, что в web-версии).
@MainActor
final class AppState: ObservableObject {
    enum Phase {
        case loading        // ждём восстановления сессии Firebase
        case signedOut
        case needsOrganization
        case ready
    }

    @Published var phase: Phase = .loading
    @Published var user: UserDoc?
    @Published var organizationName: String = ""

    private var authHandle: AuthStateDidChangeListenerHandle?
    private var userDocListener: ListenerRegistration?

    var isManager: Bool {
        guard let role = user?.orgRole else { return false }
        return ["owner", "admin", "moderator"].contains(role)
    }

    func start() {
        #if DEBUG
        if DemoData.isEnabled {
            user = DemoData.user
            organizationName = "NF Group"
            phase = .ready
            return
        }
        #endif
        guard authHandle == nil else { return }
        authHandle = Auth.auth().addStateDidChangeListener { [weak self] _, firebaseUser in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let firebaseUser {
                    self.subscribeToOwnUserDoc(uid: firebaseUser.uid)
                } else {
                    self.userDocListener?.remove()
                    self.userDocListener = nil
                    self.user = nil
                    self.organizationName = ""
                    self.phase = .signedOut
                }
            }
        }
    }

    private func subscribeToOwnUserDoc(uid: String) {
        userDocListener?.remove()
        userDocListener = Firestore.firestore().collection("users").document(uid)
            .addSnapshotListener { [weak self] snapshot, _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    guard let snapshot else { return }
                    guard snapshot.exists, let data = snapshot.data() else {
                        // Документа ещё нет (первый вход через Telegram создаёт
                        // его на сервере) — ждём серверный снапшот.
                        if !snapshot.metadata.isFromCache { self.phase = .needsOrganization }
                        return
                    }
                    let doc = UserDoc.from(uid: uid, data: data)
                    self.user = doc
                    if let orgId = doc.organizationId, !orgId.isEmpty {
                        let becameReady = self.phase != .ready
                        self.phase = .ready
                        self.loadOrganizationName(orgId: orgId)
                        // Push: разрешение + регистрация токена после входа
                        if becameReady { PushService.shared.enable() }
                    } else {
                        self.phase = .needsOrganization
                    }
                }
            }
    }

    private func loadOrganizationName(orgId: String) {
        Firestore.firestore().collection("organizations").document(orgId)
            .getDocument { [weak self] snapshot, _ in
                Task { @MainActor [weak self] in
                    self?.organizationName = snapshot?.data()?["name"] as? String ?? ""
                }
            }
    }

    func signOut() {
        Task {
            // Отвязать push-токен устройства ДО выхода (после signOut правила
            // Firestore уже не пустят запись в users/{uid}/devices)
            await PushService.shared.unregister()
            try? Auth.auth().signOut()
        }
    }
}
