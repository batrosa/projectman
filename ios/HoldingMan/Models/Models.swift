import Foundation
import FirebaseFirestore

// Статус задачи в терминах колонок доски. Семантика ровно как в web
// (boardViewForTask в script.js), включая миграцию старых задач без subStatus.
enum BoardStatus: String, CaseIterable, Identifiable {
    case assigned
    case inProgress
    case review
    case done

    var id: String { rawValue }

    var titleRu: String {
        switch self {
        case .assigned: return "Назначенные"
        case .inProgress: return "В работе"
        case .review: return "На проверке"
        case .done: return "Готово"
        }
    }

    var singleRu: String {
        switch self {
        case .assigned: return "Назначена"
        case .inProgress: return "В работе"
        case .review: return "На проверке"
        case .done: return "Готово"
        }
    }
}

struct UserDoc {
    var uid: String
    var email: String
    var firstName: String
    var lastName: String
    var authProvider: String
    var profileCompleted: Bool
    var organizationId: String?
    var orgRole: String // owner / admin / moderator / employee
    var allowedProjects: [String]
    var level: Int
    var totalXP: Int
    var completedTasksCount: Int

    var displayName: String {
        let full = "\(firstName) \(lastName)".trimmingCharacters(in: .whitespaces)
        return full.isEmpty ? (email.isEmpty ? "Пользователь" : email) : full
    }

    // Как в web: owner/admin — всё; пустой allowedProjects — все проекты;
    // sentinel "__no_access__" — ни одного.
    var canManageAnyProject: Bool { orgRole == "owner" || orgRole == "admin" }

    func canManage(projectId: String) -> Bool {
        if canManageAnyProject { return true }
        guard orgRole == "moderator" else { return false }
        if allowedProjects.isEmpty { return true }
        return allowedProjects.contains(projectId)
    }

    func canSee(projectId: String) -> Bool {
        if canManageAnyProject { return true }
        if allowedProjects.isEmpty { return true }
        if allowedProjects == ["__no_access__"] { return false }
        return allowedProjects.contains(projectId)
    }

    var roleRu: String {
        switch orgRole {
        case "owner": return "Владелец"
        case "admin": return "Администратор"
        case "moderator": return "Модератор"
        default: return "Исполнитель"
        }
    }

    var authProviderTitle: String {
        switch authProvider {
        case "apple.com": return "Apple"
        case "google.com": return "Google"
        case "password": return "Email"
        case "telegram": return "Telegram"
        default: return "HoldingMan"
        }
    }

    var authProviderIcon: String {
        switch authProvider {
        case "apple.com": return "apple.logo"
        case "telegram": return "paperplane.fill"
        default: return "person.crop.circle.badge.checkmark"
        }
    }

    static func from(uid: String, data: [String: Any]) -> UserDoc {
        UserDoc(
            uid: uid,
            email: data["email"] as? String ?? "",
            firstName: data["firstName"] as? String ?? "",
            lastName: data["lastName"] as? String ?? "",
            authProvider: data["authProvider"] as? String ?? "",
            profileCompleted: data["profileCompleted"] as? Bool ?? false,
            organizationId: data["organizationId"] as? String,
            orgRole: data["orgRole"] as? String ?? "employee",
            allowedProjects: data["allowedProjects"] as? [String] ?? [],
            level: data["level"] as? Int ?? 1,
            totalXP: data["totalXP"] as? Int ?? 0,
            completedTasksCount: data["completedTasksCount"] as? Int ?? 0
        )
    }
}

struct Organization: Identifiable {
    var id: String
    var name: String
    var orgRole: String?
    var membersCount: Int?
}

struct Project: Identifiable, Equatable {
    var id: String
    var name: String
    var description: String
    var deadline: String? // YYYY-MM-DD

    static func from(id: String, data: [String: Any]) -> Project {
        Project(
            id: id,
            name: data["name"] as? String ?? "Проект",
            description: data["description"] as? String ?? "",
            deadline: (data["deadline"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(10)) }
        )
    }
}

struct DeadlineChangeRequest: Equatable {
    var id: String
    var currentDeadline: String
    var requestedDeadline: String
    var comment: String
    var requestedByUid: String
    var requestedByName: String
    var createdByUid: String

    static func from(_ data: [String: Any]?) -> DeadlineChangeRequest? {
        guard let data,
              let id = data["id"] as? String, !id.isEmpty,
              let requestedDeadline = data["requestedDeadline"] as? String else { return nil }
        return DeadlineChangeRequest(
            id: id,
            currentDeadline: data["currentDeadline"] as? String ?? "",
            requestedDeadline: requestedDeadline,
            comment: data["comment"] as? String ?? "",
            requestedByUid: data["requestedByUid"] as? String ?? "",
            requestedByName: data["requestedByName"] as? String ?? "Исполнитель",
            createdByUid: data["createdByUid"] as? String ?? ""
        )
    }
}

struct TaskItem: Identifiable, Equatable {
    var id: String
    var projectId: String
    var title: String
    var descriptionText: String
    var assignee: String
    var assigneeIds: [String]
    var deadline: String? // YYYY-MM-DD
    var status: String    // 'in-progress' | 'done'
    var subStatus: String?
    var assigneeCompleted: Bool
    var createdAt: Date?
    var createdBy: String
    var createdByUid: String?
    // Доп. постановщики: уведомления постановщика + право принять/вернуть
    var coCreatorIds: [String] = []
    var coCreators: String = ""
    var completionComment: String?
    var revisionReason: String?
    var attachments: [FileRef]
    var completionProofs: [FileRef]
    var deadlineChangeRequest: DeadlineChangeRequest? = nil

    // Ровно boardViewForTask из web-клиента
    var boardStatus: BoardStatus {
        if status == "done" { return .done }
        let sub = subStatus ?? (assigneeCompleted ? "completed" : "assigned")
        if sub == "completed" { return .review }
        if sub == "in_work" { return .inProgress }
        return .assigned
    }

    var deadlineDate: Date? {
        guard let deadline else { return nil }
        return DateFormatter.isoDay.date(from: deadline)
    }

    var isOverdue: Bool {
        guard boardStatus != .done, let d = deadlineDate else { return false }
        return d < Calendar.current.startOfDay(for: Date())
    }

    static func from(id: String, data: [String: Any]) -> TaskItem {
        TaskItem(
            id: id,
            projectId: data["projectId"] as? String ?? "",
            title: data["title"] as? String ?? "Без названия",
            descriptionText: data["description"] as? String ?? "",
            assignee: data["assignee"] as? String ?? "Не назначен",
            assigneeIds: data["assigneeIds"] as? [String] ?? [],
            deadline: (data["deadline"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(10)) },
            status: data["status"] as? String ?? "in-progress",
            subStatus: data["subStatus"] as? String,
            assigneeCompleted: data["assigneeCompleted"] as? Bool ?? false,
            createdAt: (data["createdAt"] as? Timestamp)?.dateValue(),
            createdBy: data["createdBy"] as? String ?? "",
            createdByUid: (data["createdByUid"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            coCreatorIds: data["coCreatorIds"] as? [String] ?? [],
            coCreators: data["coCreators"] as? String ?? "",
            completionComment: data["completionComment"] as? String,
            revisionReason: data["revisionReason"] as? String,
            attachments: (data["attachments"] as? [[String: Any]] ?? []).compactMap(FileRef.from),
            completionProofs: (data["completionProofs"] as? [[String: Any]] ?? []).compactMap(FileRef.from),
            deadlineChangeRequest: DeadlineChangeRequest.from(data["deadlineChangeRequest"] as? [String: Any])
        )
    }
}

// Участник организации — для выбора исполнителей (та же семантика доступа,
// что userHasProjectAccessForAssignment на сервере).
struct OrgUser: Identifiable, Equatable {
    var id: String // uid
    var email: String
    var displayName: String
    var orgRole: String
    var allowedProjects: [String]
    var telegramChatId: String?

    func canBeAssigned(projectId: String) -> Bool {
        if orgRole == "owner" || orgRole == "admin" { return true }
        if allowedProjects.isEmpty { return true }
        return allowedProjects.contains(projectId)
    }

    static func from(uid: String, data: [String: Any]) -> OrgUser {
        let first = data["firstName"] as? String ?? ""
        let last = data["lastName"] as? String ?? ""
        let full = "\(first) \(last)".trimmingCharacters(in: .whitespaces)
        let email = data["email"] as? String ?? ""
        let display = data["displayName"] as? String ?? ""
        let chatIdValue = data["telegramChatId"]
        let chatId = (chatIdValue as? String) ?? (chatIdValue as? Int).map(String.init) ?? (chatIdValue as? Int64).map(String.init)
        return OrgUser(
            id: uid,
            email: email,
            displayName: display.isEmpty ? (full.isEmpty ? (email.isEmpty ? "Участник" : email) : full) : display,
            orgRole: data["orgRole"] as? String ?? "employee",
            allowedProjects: data["allowedProjects"] as? [String] ?? [],
            telegramChatId: (chatId?.isEmpty == false) ? chatId : nil
        )
    }
}

struct AgentNotification: Identifiable {
    var id: String
    var text: String
    var type: String?
    var taskId: String?
    var projectId: String?
    var createdAt: Date?
    var readAt: Date?

    var hasTaskLink: Bool {
        (taskId?.isEmpty == false) && (projectId?.isEmpty == false)
    }

    static func from(id: String, data: [String: Any]) -> AgentNotification {
        AgentNotification(
            id: id,
            text: data["text"] as? String ?? "",
            type: data["type"] as? String,
            taskId: (data["taskId"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            projectId: (data["projectId"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            createdAt: (data["createdAt"] as? Timestamp)?.dateValue(),
            readAt: (data["readAt"] as? Timestamp)?.dateValue()
        )
    }
}

// ===== Агент: сообщения чата и карточки подтверждения =====

enum AgentChatEntry: Identifiable {
    case user(id: UUID, text: String)
    case assistant(id: UUID, text: String)
    case error(id: UUID, text: String)
    case createProposal(id: UUID, proposal: AgentTaskProposal)
    case deleteProposal(id: UUID, proposal: AgentDeleteProposal)
    case actionProposal(id: UUID, proposal: AgentActionProposal)

    var id: UUID {
        switch self {
        case .user(let id, _), .assistant(let id, _), .error(let id, _),
             .createProposal(let id, _), .deleteProposal(let id, _), .actionProposal(let id, _):
            return id
        }
    }
}

struct AgentProposalTask: Identifiable {
    var id = UUID()
    var taskId: String?      // для карточки удаления
    var projectId: String?
    var projectName: String?
    var title: String
    var description: String
    var deadline: String?
    var assigneeDisplay: String
    var assigneeUid: String?
    var coCreatorUids: [String] = []
    var coCreatorDisplay: String?
    var ok: Bool
    var reason: String?
    var statusLabel: String? // для карточки удаления

    static func fromCreate(_ dict: [String: Any]) -> AgentProposalTask {
        AgentProposalTask(
            taskId: nil,
            projectId: dict["projectId"] as? String,
            projectName: dict["projectName"] as? String,
            title: dict["title"] as? String ?? "",
            description: dict["description"] as? String ?? "",
            deadline: dict["deadline"] as? String,
            assigneeDisplay: dict["assigneeDisplay"] as? String
                ?? dict["assigneeName"] as? String ?? "Не назначен",
            assigneeUid: dict["assigneeUid"] as? String,
            coCreatorUids: dict["coCreatorUids"] as? [String] ?? [],
            coCreatorDisplay: (dict["coCreatorDisplay"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            ok: dict["ok"] as? Bool ?? false,
            reason: dict["reason"] as? String,
            statusLabel: nil
        )
    }

    static func fromDelete(_ dict: [String: Any]) -> AgentProposalTask {
        AgentProposalTask(
            taskId: dict["id"] as? String,
            projectId: dict["projectId"] as? String,
            projectName: dict["projectName"] as? String,
            title: dict["title"] as? String ?? "",
            description: "",
            deadline: dict["deadline"] as? String,
            assigneeDisplay: dict["assigneeDisplay"] as? String ?? "Не назначен",
            assigneeUid: nil,
            ok: true,
            reason: nil,
            statusLabel: dict["statusLabel"] as? String
        )
    }
}

struct AgentTaskProposal {
    var proposalId: String?
    var projectId: String
    var projectName: String
    var source: String // "text" | имя файла
    var file: String?
    var truncated: Bool
    var canCreate: Bool
    var multiProject: Bool
    var tasks: [AgentProposalTask]

    static func from(_ dict: [String: Any]) -> AgentTaskProposal? {
        guard let projectId = dict["projectId"] as? String,
              let rawTasks = dict["tasks"] as? [[String: Any]] else { return nil }
        return AgentTaskProposal(
            proposalId: dict["proposalId"] as? String,
            projectId: projectId,
            projectName: dict["projectName"] as? String ?? "",
            source: dict["source"] as? String ?? "text",
            file: dict["file"] as? String,
            truncated: dict["truncated"] as? Bool ?? false,
            canCreate: dict["canCreate"] as? Bool ?? false,
            multiProject: dict["multiProject"] as? Bool ?? false,
            tasks: rawTasks.map(AgentProposalTask.fromCreate)
        )
    }
}

struct AgentDeleteProposal {
    var proposalId: String?
    var projectId: String
    var projectName: String
    var filterLabel: String
    var truncated: Bool
    var canDelete: Bool
    var tasks: [AgentProposalTask]

    static func from(_ dict: [String: Any]) -> AgentDeleteProposal? {
        guard let projectId = dict["projectId"] as? String,
              let rawTasks = dict["tasks"] as? [[String: Any]] else { return nil }
        return AgentDeleteProposal(
            proposalId: dict["proposalId"] as? String,
            projectId: projectId,
            projectName: dict["projectName"] as? String ?? "",
            filterLabel: dict["filterLabel"] as? String ?? "",
            truncated: dict["truncated"] as? Bool ?? false,
            canDelete: dict["canDelete"] as? Bool ?? false,
            tasks: rawTasks.map(AgentProposalTask.fromDelete)
        )
    }
}

struct AgentNavigation {
    var target: String
    var projectId: String?
    var taskId: String?

    static func from(_ dict: [String: Any]) -> AgentNavigation? {
        guard let target = dict["target"] as? String, !target.isEmpty else { return nil }
        return AgentNavigation(
            target: target,
            projectId: dict["projectId"] as? String,
            taskId: dict["taskId"] as? String
        )
    }
}

struct AgentActionProposal {
    var proposalId: String?
    var action: String
    var title: String
    var summary: String
    var confirmLabel: String
    var destructive: Bool
    var payload: [String: Any]

    static func from(_ dict: [String: Any]) -> AgentActionProposal? {
        guard let action = dict["action"] as? String,
              let payload = dict["payload"] as? [String: Any] else { return nil }
        return AgentActionProposal(
            proposalId: dict["proposalId"] as? String,
            action: action,
            title: dict["title"] as? String ?? "Подтверждение действия",
            summary: dict["summary"] as? String ?? "",
            confirmLabel: dict["confirmLabel"] as? String ?? "Подтвердить",
            destructive: dict["destructive"] as? Bool ?? false,
            payload: payload
        )
    }
}

extension DateFormatter {
    static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        return f
    }()

    static let dayMonth: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "dd.MM"
        f.locale = Locale(identifier: "ru_RU")
        return f
    }()

    static let dayMonthYear: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "dd.MM.yyyy"
        f.locale = Locale(identifier: "ru_RU")
        return f
    }()

    static let dateTime: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "dd.MM.yyyy HH:mm"
        f.locale = Locale(identifier: "ru_RU")
        return f
    }()

    static func displayDay(_ value: String?, fallback: String = "без срока") -> String {
        guard let value, let date = isoDay.date(from: String(value.prefix(10))) else { return fallback }
        return dayMonthYear.string(from: date)
    }

    static func displayIsoDays(in text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"\b(\d{4})-(\d{2})-(\d{2})\b"#) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var result = text
        for match in regex.matches(in: text, range: range).reversed() {
            guard match.numberOfRanges == 4,
                  let whole = Range(match.range(at: 0), in: result),
                  let year = Range(match.range(at: 1), in: result),
                  let month = Range(match.range(at: 2), in: result),
                  let day = Range(match.range(at: 3), in: result) else { continue }
            let replacement = "\(result[day]).\(result[month]).\(result[year])"
            result.replaceSubrange(whole, with: replacement)
        }
        return result
    }
}
