import SwiftUI

// Канбан: вкладки-статусы со «скользящим» индикатором + свайп между
// колонками (TabView .page). Цвета статусов — как на web-доске.
struct BoardView: View {
    let project: Project
    @EnvironmentObject private var tasksStore: TasksStore
    @State private var column: BoardStatus
    @Namespace private var tabIndicator

    init(project: Project, initialColumn: BoardStatus = .assigned) {
        self.project = project
        _column = State(initialValue: initialColumn)
    }

    var body: some View {
        VStack(spacing: 0) {
            statusTabs
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 10)

            if !tasksStore.loaded {
                Spacer()
                ProgressView().tint(Theme.primary)
                Spacer()
            } else {
                TabView(selection: $column.animation(.spring(duration: 0.32, bounce: 0.2))) {
                    ForEach(BoardStatus.allCases) { status in
                        columnView(status)
                            .tag(status)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
            }
        }
    }

    // MARK: — вкладки

    private var statusTabs: some View {
        HStack(spacing: 6) {
            ForEach(BoardStatus.allCases) { status in
                let isActive = column == status
                let count = tasksStore.tasks(in: status).count
                Button {
                    withAnimation(.spring(duration: 0.32, bounce: 0.2)) { column = status }
                } label: {
                    VStack(spacing: 5) {
                        Text("\(count)")
                            .font(.system(.callout, design: .rounded).weight(.bold))
                            .foregroundStyle(isActive ? Theme.color(for: status) : Theme.textPrimary)
                            .contentTransition(.numericText())
                        Text(status.titleRu)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(isActive ? Theme.color(for: status) : Theme.textSecondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background {
                        if isActive {
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .fill(Theme.color(for: status).opacity(0.13))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                                        .stroke(Theme.color(for: status).opacity(0.35), lineWidth: 1)
                                )
                                .matchedGeometryEffect(id: "tab", in: tabIndicator)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5)
        .card(cornerRadius: 18)
    }

    // MARK: — колонка

    @ViewBuilder
    private func columnView(_ status: BoardStatus) -> some View {
        let tasks = tasksStore.tasks(in: status)
        if tasks.isEmpty {
            EmptyStateView(
                icon: emptyIcon(for: status),
                title: "«\(status.titleRu)» — пусто",
                message: emptyMessage(for: status)
            )
        } else {
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(tasks) { task in
                        NavigationLink {
                            TaskDetailView(task: task, project: project)
                                .environmentObject(tasksStore)
                        } label: {
                            TaskCardView(task: task)
                        }
                        .buttonStyle(PressableStyle())
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 2)
                .padding(.bottom, 16)
            }
        }
    }

    private func emptyIcon(for status: BoardStatus) -> String {
        switch status {
        case .assigned: return "tray"
        case .inProgress: return "hammer"
        case .review: return "eye"
        case .done: return "checkmark.seal"
        }
    }

    private func emptyMessage(for status: BoardStatus) -> String {
        switch status {
        case .assigned: return "Новые задачи появятся в этой колонке."
        case .inProgress: return "Здесь будут задачи, взятые в работу."
        case .review: return "Задачи, отправленные на проверку, появятся здесь."
        case .done: return "Принятые задачи попадают в архив «Готово»."
        }
    }
}

struct TaskCardView: View {
    let task: TaskItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Theme.color(for: task.boardStatus))
                .frame(width: 4)

            VStack(alignment: .leading, spacing: 10) {
                Text(task.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    if task.assignee != "Не назначен" {
                        HStack(spacing: 6) {
                            AvatarView(name: task.assignee, size: 22)
                            Text(task.assignee)
                                .font(.caption)
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                        }
                    } else {
                        HStack(spacing: 5) {
                            Image(systemName: "person.slash")
                                .font(.system(size: 10))
                            Text("Не назначен")
                                .font(.caption)
                        }
                        .foregroundStyle(Theme.textSecondary.opacity(0.7))
                    }

                    Spacer(minLength: 6)

                    DeadlineChip(deadline: task.deadline, isOverdue: task.isOverdue)
                }
            }
        }
        .padding(.vertical, 13)
        .padding(.horizontal, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}
