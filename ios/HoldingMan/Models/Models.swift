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
        case .inProgress: return "В процессе"
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
    var organizationId: String?
    var orgRole: String // owner / admin / moderator / employee / reader
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
        case "reader": return "Наблюдатель"
        default: return "Исполнитель"
        }
    }

    static func from(uid: String, data: [String: Any]) -> UserDoc {
        UserDoc(
            uid: uid,
            email: data["email"] as? String ?? "",
            firstName: data["firstName"] as? String ?? "",
            lastName: data["lastName"] as? String ?? "",
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
    var completionComment: String?
    var revisionReason: String?
    var attachments: [FileRef]
    var completionProofs: [FileRef]

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
            completionComment: data["completionComment"] as? String,
            revisionReason: data["revisionReason"] as? String,
            attachments: (data["attachments"] as? [[String: Any]] ?? []).compactMap(FileRef.from),
            completionProofs: (data["completionProofs"] as? [[String: Any]] ?? []).compactMap(FileRef.from)
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
    var taskId: String?
    var projectId: String?
    var createdAt: Date?
    var readAt: Date?

    static func from(id: String, data: [String: Any]) -> AgentNotification {
        AgentNotification(
            id: id,
            text: data["text"] as? String ?? "",
            taskId: data["taskId"] as? String,
            projectId: data["projectId"] as? String,
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

    var id: UUID {
        switch self {
        case .user(let id, _), .assistant(let id, _), .error(let id, _),
             .createProposal(let id, _), .deleteProposal(let id, _):
            return id
        }
    }
}

struct AgentProposalTask: Identifiable {
    var id = UUID()
    var taskId: String?      // для карточки удаления
    var title: String
    var deadline: String?
    var assigneeDisplay: String
    var assigneeUid: String?
    var ok: Bool
    var reason: String?
    var statusLabel: String? // для карточки удаления

    static func fromCreate(_ dict: [String: Any]) -> AgentProposalTask {
        AgentProposalTask(
            taskId: nil,
            title: dict["title"] as? String ?? "",
            deadline: dict["deadline"] as? String,
            assigneeDisplay: dict["assigneeDisplay"] as? String
                ?? dict["assigneeName"] as? String ?? "Не назначен",
            assigneeUid: dict["assigneeUid"] as? String,
            ok: dict["ok"] as? Bool ?? false,
            reason: dict["reason"] as? String,
            statusLabel: nil
        )
    }

    static func fromDelete(_ dict: [String: Any]) -> AgentProposalTask {
        AgentProposalTask(
            taskId: dict["id"] as? String,
            title: dict["title"] as? String ?? "",
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
    var projectId: String
    var projectName: String
    var source: String // "text" | имя файла
    var file: String?
    var truncated: Bool
    var canCreate: Bool
    var tasks: [AgentProposalTask]

    static func from(_ dict: [String: Any]) -> AgentTaskProposal? {
        guard let projectId = dict["projectId"] as? String,
              let rawTasks = dict["tasks"] as? [[String: Any]] else { return nil }
        return AgentTaskProposal(
            projectId: projectId,
            projectName: dict["projectName"] as? String ?? "",
            source: dict["source"] as? String ?? "text",
            file: dict["file"] as? String,
            truncated: dict["truncated"] as? Bool ?? false,
            canCreate: dict["canCreate"] as? Bool ?? false,
            tasks: rawTasks.map(AgentProposalTask.fromCreate)
        )
    }
}

struct AgentDeleteProposal {
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
            projectId: projectId,
            projectName: dict["projectName"] as? String ?? "",
            filterLabel: dict["filterLabel"] as? String ?? "",
            truncated: dict["truncated"] as? Bool ?? false,
            canDelete: dict["canDelete"] as? Bool ?? false,
            tasks: rawTasks.map(AgentProposalTask.fromDelete)
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
}
