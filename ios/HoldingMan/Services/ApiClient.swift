import Foundation
import FirebaseAuth

// Все серверные операции идут через те же Vercel-endpoints, что и web-версия.
// Клиент никогда не решает вопросы прав сам — сервер перепроверяет всё
// (создание/удаление задач, смену организации и т.д.).
enum ApiError: LocalizedError {
    case notAuthenticated
    case server(String)
    case network

    var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Не авторизован"
        case .server(let message): return message
        case .network: return "Ошибка сети. Попробуйте ещё раз."
        }
    }
}

struct ApiClient {
    static let baseURL = URL(string: "https://projectmanteko.vercel.app")!

    // POST с Bearer idToken текущего пользователя Firebase.
    static func post(_ path: String, body: [String: Any], authorized: Bool = true) async throws -> [String: Any] {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 75

        if authorized {
            guard let user = Auth.auth().currentUser else { throw ApiError.notAuthenticated }
            let token = try await user.getIDToken()
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw ApiError.network
        }

        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status < 200 || status >= 300 {
            throw ApiError.server(json["error"] as? String ?? "Ошибка сервера (\(status))")
        }
        return json
    }

    // ===== Организации (api/org — те же действия, что в web callOrgApi) =====

    static func listOrganizations() async throws -> [Organization] {
        let json = try await post("api/org", body: ["action": "list"])
        let raw = json["organizations"] as? [[String: Any]] ?? []
        return raw.compactMap { dict in
            guard let id = dict["id"] as? String else { return nil }
            return Organization(
                id: id,
                name: dict["name"] as? String ?? "Организация",
                orgRole: dict["orgRole"] as? String,
                membersCount: dict["membersCount"] as? Int
            )
        }
    }

    static func switchOrganization(id: String) async throws {
        _ = try await post("api/org", body: ["action": "switch", "organizationId": id])
    }

    static func joinOrganization(inviteCode: String) async throws {
        _ = try await post("api/join-org", body: ["inviteCode": inviteCode.uppercased()])
    }

    // Создание организации: сервер проверяет уникальность имени, генерирует
    // код приглашения и делает вызывающего владельцем (как web createOrganization).
    static func createOrganization(name: String) async throws -> Organization {
        let json = try await post("api/org", body: ["action": "create", "name": name])
        guard let dict = json["organization"] as? [String: Any], let id = dict["id"] as? String else {
            throw ApiError.server("Не удалось создать организацию")
        }
        return Organization(
            id: id,
            name: dict["name"] as? String ?? name,
            orgRole: "owner",
            membersCount: dict["membersCount"] as? Int
        )
    }

    // Превью организации по коду приглашения (имя + число участников) —
    // прежде чем вступать (как карточка предпросмотра в web).
    static func previewOrganization(inviteCode: String) async throws -> Organization? {
        let json = try await post("api/org", body: ["action": "preview", "inviteCode": inviteCode.uppercased()])
        guard let dict = json["organization"] as? [String: Any], let id = dict["id"] as? String else {
            return nil
        }
        return Organization(
            id: id,
            name: dict["name"] as? String ?? "Организация",
            orgRole: nil,
            membersCount: dict["membersCount"] as? Int
        )
    }

    // Смена роли участника (owner/admin; те же серверные ограничения, что в
    // веб-админке: владельца не трогаем, админ не управляет админами).
    static func updateMemberRole(userId: String, role: String) async throws {
        _ = try await post("api/org", body: ["action": "updateMemberRole", "userId": userId, "orgRole": role])
    }

    static func removeMember(userId: String) async throws {
        _ = try await post("api/org", body: ["action": "removeMember", "userId": userId])
    }

    // ===== Telegram-бот логин (та же пара endpoints, что в web) =====

    struct TelegramLoginStart {
        var code: String
        var botUrl: URL
        var expiresAt: Date
    }

    static func startTelegramBotLogin() async throws -> TelegramLoginStart {
        let json = try await post("api/telegram-bot-login-start", body: [:], authorized: false)
        guard json["ok"] as? Bool == true,
              let code = json["code"] as? String,
              let botUrlString = json["botUrl"] as? String,
              let botUrl = URL(string: botUrlString) else {
            throw ApiError.server(json["error"] as? String ?? "Не удалось начать вход через бота.")
        }
        let expires = (json["expiresAt"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
            ?? Date().addingTimeInterval(5 * 60)
        return TelegramLoginStart(code: code, botUrl: botUrl, expiresAt: expires)
    }

    // Возвращает custom token, когда бот подтвердил вход; nil — ещё ждём.
    static func pollTelegramBotLogin(code: String) async throws -> String? {
        let json = try await post("api/telegram-bot-login-status", body: ["code": code], authorized: false)
        let status = json["status"] as? String
        if status == "pending" { return nil }
        if json["ok"] as? Bool == true, status == "confirmed", let token = json["token"] as? String {
            return token
        }
        throw ApiError.server(json["error"] as? String ?? "Telegram-бот не подтвердил вход.")
    }

    // ===== ИИ-агент (api/agent-chat — тот же протокол, что в web) =====

    struct AgentReply {
        var answer: String?
        var createProposal: AgentTaskProposal?
        var deleteProposal: AgentDeleteProposal?
    }

    static func agentChat(message: String, history: [[String: String]], projectId: String, projectName: String) async throws -> AgentReply {
        let today = DateFormatter.isoDay.string(from: Date())
        let json = try await post("api/agent-chat", body: [
            "message": message,
            "history": history,
            "projectId": projectId,
            "projectName": projectName,
            "clientToday": today,
        ])
        guard json["ok"] as? Bool == true else {
            throw ApiError.server(json["error"] as? String ?? "Агент не ответил, попробуйте ещё раз.")
        }
        var reply = AgentReply()
        if let dict = json["taskProposal"] as? [String: Any] {
            reply.createProposal = AgentTaskProposal.from(dict)
        } else if let dict = json["deleteProposal"] as? [String: Any] {
            reply.deleteProposal = AgentDeleteProposal.from(dict)
        } else {
            reply.answer = json["answer"] as? String
        }
        return reply
    }

    // Фаза 2 создания: тот же payload, что confirmAgentTaskProposal в web.
    static func agentCreateTasks(proposal: AgentTaskProposal) async throws -> Int {
        let okTasks = proposal.tasks.filter(\.ok)
        let json = try await post("api/agent-chat", body: [
            "action": "create_tasks",
            "projectId": proposal.projectId,
            "file": proposal.source == "text" ? "" : (proposal.file ?? ""),
            "tasks": okTasks.map { t in
                [
                    "title": t.title,
                    "deadline": t.deadline as Any,
                    "assigneeUid": t.assigneeUid as Any,
                ] as [String: Any]
            },
        ])
        guard json["ok"] as? Bool == true, let created = json["created"] as? Int else {
            throw ApiError.server(json["error"] as? String ?? "Не удалось создать задачи")
        }
        return created
    }

    // Фаза 2 удаления: тот же payload, что confirmAgentDeleteProposal в web.
    static func agentDeleteTasks(proposal: AgentDeleteProposal) async throws -> Int {
        let ids = proposal.tasks.compactMap(\.taskId)
        let json = try await post("api/agent-chat", body: [
            "action": "delete_tasks",
            "projectId": proposal.projectId,
            "taskIds": ids,
        ])
        guard json["ok"] as? Bool == true, let deleted = json["deleted"] as? Int else {
            throw ApiError.server(json["error"] as? String ?? "Не удалось удалить задачи")
        }
        return deleted
    }

    static func deleteAgentNotification(id: String) async throws {
        _ = try await post("api/agent-chat", body: ["action": "delete_notification", "id": id])
    }

    // XP начисляет сервер при принятии задачи в «Готово» (транзакционно,
    // идемпотентно) — тот же вызов, что в web updateTaskSubStatus('done').
    static func awardXp(taskId: String) async throws {
        _ = try await post("api/award-xp", body: ["taskId": taskId])
    }

    // Telegram-уведомление участнику — тот же endpoint и payload, что web
    // sendTelegramNotification(). Fire-and-forget у вызывающих.
    static func notifyTelegram(chatId: String, text: String) async throws {
        _ = try await post("api/notify-telegram", body: [
            "chatId": chatId,
            "text": text,
            "parseMode": "HTML",
        ])
    }
}
