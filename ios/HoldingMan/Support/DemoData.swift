#if DEBUG
import Foundation

// Демо-режим для визуальной проверки экранов в симуляторе БЕЗ входа в
// реальный аккаунт: `xcrun simctl launch <sim> com.holdingman.ios --demo`.
// Только DEBUG-сборки; в продакшен-бинарь не попадает.
enum DemoData {
    static var isEnabled: Bool { CommandLine.arguments.contains("--demo") }

    // --demo-screen board|task|mytasks|notifications|chat|settings — открыть
    // конкретный экран сразу (для скриншотов из CLI, где нет тапов)
    static var screen: String? {
        guard let index = CommandLine.arguments.firstIndex(of: "--demo-screen"),
              CommandLine.arguments.indices.contains(index + 1) else { return nil }
        return CommandLine.arguments[index + 1]
    }

    static let user = UserDoc(
        uid: "demo-user",
        email: "",
        firstName: "Тэко",
        lastName: "Исаев",
        organizationId: "demo-org",
        orgRole: "owner",
        allowedProjects: [],
        level: 3,
        totalXP: 175,
        completedTasksCount: 12
    )

    static let projects: [Project] = [
        Project(id: "p1", name: "Елисеевский парк", description: "Благоустройство набережной", deadline: iso(days: 40)),
        Project(id: "p2", name: "Абрау-Дюрсо", description: "Реконструкция гостевых домов", deadline: iso(days: 5)),
        Project(id: "p3", name: "ЖК «Северный»", description: "", deadline: nil),
    ]

    static let tasks: [TaskItem] = [
        demoTask("t1", "Получить изменённый ГПЗУ", "p1", sub: nil, deadline: iso(days: -2), assignee: "Эльдар Исаев"),
        demoTask("t2", "Разработать проект планировки территории", "p1", sub: "in_work", deadline: iso(days: 3), assignee: "Амирхан Абигасанов"),
        demoTask("t3", "Согласовать фасадные решения с главным архитектором города", "p1", sub: "in_work", deadline: iso(days: 9), assignee: "Тэко Исаев"),
        demoTask("t4", "Подготовить смету на инженерные сети", "p1", sub: "completed", deadline: iso(days: 1), assignee: "Вера Соколова"),
        demoTask("t5", "Заключить договор с подрядчиком", "p1", sub: nil, deadline: iso(days: 14), assignee: "Не назначен"),
        demoTask("t6", "Собрать исходно-разрешительную документацию", "p1", status: "done", sub: "completed", deadline: iso(days: -6), assignee: "Эльдар Исаев"),
        demoTask("t7", "Провести геодезическую съёмку участка", "p2", sub: "in_work", deadline: iso(days: 0), assignee: "Тэко Исаев"),
    ]

    static var myTasks: [TaskItem] {
        tasks.filter { $0.assignee == "Тэко Исаев" && $0.status != "done" }
    }

    static let orgUsers: [OrgUser] = [
        OrgUser(id: "demo-user", email: "", displayName: "Тэко Исаев", orgRole: "owner", allowedProjects: [], telegramChatId: "1"),
        OrgUser(id: "u2", email: "eldar@x.com", displayName: "Эльдар Исаев", orgRole: "moderator", allowedProjects: [], telegramChatId: "2"),
        OrgUser(id: "u3", email: "amir@x.com", displayName: "Амирхан Абигасанов", orgRole: "employee", allowedProjects: [], telegramChatId: nil),
        OrgUser(id: "u4", email: "vera@x.com", displayName: "Вера Соколова", orgRole: "employee", allowedProjects: [], telegramChatId: "4"),
    ]

    static let notifications: [AgentNotification] = [
        AgentNotification(id: "n1", text: "🆕 Новая задача: «Согласовать фасадные решения». Проект «Елисеевский парк». Срок: \(iso(days: 9) ?? "")", taskId: "t3", projectId: "p1", createdAt: Date().addingTimeInterval(-25 * 60), readAt: nil),
        AgentNotification(id: "n2", text: "🔥 Просрочена задача «Получить изменённый ГПЗУ» — срок истёк 2 дня назад. Ответственный: Эльдар Исаев.", taskId: "t1", projectId: "p1", createdAt: Date().addingTimeInterval(-3 * 3600), readAt: nil),
        AgentNotification(id: "n3", text: "⏰ Остался 1 день до дедлайна задачи «Подготовить смету на инженерные сети».", taskId: "t4", projectId: "p1", createdAt: Date().addingTimeInterval(-26 * 3600), readAt: Date()),
    ]

    private static func demoTask(
        _ id: String, _ title: String, _ projectId: String,
        status: String = "in-progress", sub: String?, deadline: String?, assignee: String
    ) -> TaskItem {
        TaskItem(
            id: id, projectId: projectId, title: title,
            descriptionText: "Создано для демонстрации интерфейса.",
            assignee: assignee,
            assigneeIds: assignee == "Тэко Исаев" ? ["demo-user"] : (assignee == "Не назначен" ? [] : ["u2"]),
            deadline: deadline, status: status, subStatus: sub,
            assigneeCompleted: sub == "completed",
            createdAt: Date().addingTimeInterval(-6 * 86_400),
            createdBy: "Тэко Исаев",
            completionComment: sub == "completed" ? "Смета готова, приложил файл." : nil,
            revisionReason: nil,
            attachments: [],
            completionProofs: sub == "completed"
                ? [FileRef(name: "смета-v2.pdf", url: "https://example.com/f.pdf", type: "pdf", size: 12000)]
                : []
        )
    }

    private static func iso(days: Int) -> String? {
        let date = Calendar.current.date(byAdding: .day, value: days, to: Date())!
        return DateFormatter.isoDay.string(from: date)
    }
}

import SwiftUI

// Прямые роуты на экраны для скриншотов (--demo-screen …)
struct DemoScreenRouter: View {
    let screen: String
    @StateObject private var tasksStore = TasksStore()
    @StateObject private var projectsStore = ProjectsStore()
    @StateObject private var myTasksStore = MyTasksStore()
    @StateObject private var notificationsStore = NotificationsStore()
    @StateObject private var orgUsersStore = OrgUsersStore()

    var body: some View {
        Group {
            switch screen {
            case "board":
                NavigationStack {
                    ProjectBoardView(project: DemoData.projects[0])
                }
            case "task":
                NavigationStack {
                    TaskDetailView(task: DemoData.tasks[1], project: DemoData.projects[0])
                        .environmentObject(tasksStore)
                        .onAppear { tasksStore.subscribe(projectId: "p1") }
                }
            case "team":
                NavigationStack { TeamView() }
            default:
                MainTabView(initialTab: screen)
            }
        }
        .environmentObject(projectsStore)
        .environmentObject(myTasksStore)
        .environmentObject(notificationsStore)
        .environmentObject(orgUsersStore)
        .onAppear {
            projectsStore.loadDemo()
            myTasksStore.loadDemo()
            notificationsStore.loadDemo()
            orgUsersStore.loadDemo()
        }
    }
}
#endif
