import SwiftUI

// Чат с ИИ-агентом — тот же серверный протокол, что web: обычные ответы,
// карточка создания задач и карточка удаления с подтверждением кнопкой.
struct AgentChatView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var projectsStore: ProjectsStore

    @State private var entries: [AgentChatEntry] = []
    @State private var history: [[String: String]] = []
    @State private var input = ""
    @State private var isSending = false
    @State private var targetProject: Project?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                messagesList
                inputBar
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("ИИ-агент")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Без проекта") { targetProject = nil }
                        ForEach(projectsStore.projects) { project in
                            Button(project.name) { targetProject = project }
                        }
                    } label: {
                        Label(targetProject?.name ?? "Проект", systemImage: "folder")
                            .font(.caption)
                    }
                }
            }
        }
    }

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if entries.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "sparkles")
                                .font(.largeTitle)
                                .foregroundStyle(Theme.primary)
                            Text("ИИ Руководитель проекта")
                                .font(.headline)
                                .foregroundStyle(Theme.textPrimary)
                            Text("Спросите о проектах, задачах и сроках. Могу создавать задачи («поставь задачу … в проект …») и удалять их с подтверждением («удали все назначенные задачи из проекта …»).")
                                .font(.footnote)
                                .foregroundStyle(Theme.textSecondary)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.top, 60)
                        .padding(.horizontal, 30)
                    }

                    ForEach(entries) { entry in
                        entryView(entry)
                            .id(entry.id)
                    }

                    if isSending {
                        HStack {
                            ProgressView().tint(Theme.primary)
                            Text("Агент печатает…")
                                .font(.footnote)
                                .foregroundStyle(Theme.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                        .id("typing")
                    }
                }
                .padding(.vertical, 10)
            }
            .onChange(of: entries.count) {
                if let last = entries.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    @ViewBuilder
    private func entryView(_ entry: AgentChatEntry) -> some View {
        switch entry {
        case .user(_, let text):
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.white)
                .padding(12)
                .background(Theme.primary, in: RoundedRectangle(cornerRadius: 14))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 60)
                .padding(.trailing, 12)
        case .assistant(_, let text):
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.textPrimary)
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 40)
                .padding(.leading, 12)
        case .error(_, let text):
            Text(text)
                .font(.footnote)
                .foregroundStyle(Theme.danger)
                .padding(10)
                .background(Theme.danger.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 12)
        case .createProposal(_, let proposal):
            AgentCreateProposalCard(proposal: proposal) { resultText in
                appendAssistant(resultText)
            }
            .padding(.horizontal, 12)
        case .deleteProposal(_, let proposal):
            AgentDeleteProposalCard(proposal: proposal) { resultText in
                appendAssistant(resultText)
            }
            .padding(.horizontal, 12)
        }
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Сообщение агенту…", text: $input, axis: .vertical)
                .lineLimit(1...4)
                .padding(10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(Theme.textPrimary)

            Button {
                send()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(Theme.primary)
            }
            .disabled(isSending || input.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.background)
    }

    private func send() {
        let message = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !isSending else { return }
        input = ""
        entries.append(.user(id: UUID(), text: message))
        let historyForRequest = history
        history.append(["role": "user", "content": message])
        isSending = true

        Task {
            defer { isSending = false }
            do {
                let reply = try await ApiClient.agentChat(
                    message: message,
                    history: historyForRequest,
                    projectId: targetProject?.id ?? "",
                    projectName: targetProject?.name ?? ""
                )
                if let proposal = reply.createProposal {
                    entries.append(.createProposal(id: UUID(), proposal: proposal))
                    let ok = proposal.tasks.filter(\.ok).count
                    history.append(["role": "assistant",
                                    "content": "Предложены задачи: к созданию \(ok) из \(proposal.tasks.count)."])
                } else if let proposal = reply.deleteProposal {
                    entries.append(.deleteProposal(id: UUID(), proposal: proposal))
                    history.append(["role": "assistant",
                                    "content": "Предложено удаление задач: \(proposal.tasks.count). Проект «\(proposal.projectName)»."])
                } else {
                    let answer = reply.answer ?? "Агент не ответил, попробуйте ещё раз."
                    appendAssistant(answer)
                }
                trimHistory()
            } catch {
                entries.append(.error(id: UUID(),
                                      text: (error as? ApiError)?.errorDescription ?? "Ошибка сети. Попробуйте ещё раз."))
            }
        }
    }

    private func appendAssistant(_ text: String) {
        entries.append(.assistant(id: UUID(), text: text))
        history.append(["role": "assistant", "content": text])
        trimHistory()
    }

    private func trimHistory() {
        if history.count > 12 { history.removeFirst(history.count - 12) }
    }
}

// Карточка «что я создам» — аналог web appendAgentTaskProposal.
struct AgentCreateProposalCard: View {
    let proposal: AgentTaskProposal
    let onResult: (String) -> Void
    @State private var isBusy = false
    @State private var done = false
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(proposal.source == "text"
                 ? "Задачи из текстового запроса — проект «\(proposal.projectName)»"
                 : "Задачи из документа «\(proposal.file ?? "")» — проект «\(proposal.projectName)»")
                .font(.subheadline.bold())
                .foregroundStyle(Theme.textPrimary)

            ForEach(proposal.tasks) { task in
                proposalRow(task)
            }

            let okCount = proposal.tasks.filter(\.ok).count
            if proposal.canCreate && okCount > 0 && !done {
                Button {
                    confirm()
                } label: {
                    if isBusy {
                        ProgressView().tint(.white).frame(maxWidth: .infinity)
                    } else {
                        Text("Создать \(okCount) задач(и)")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isBusy)
            } else if !proposal.canCreate {
                Text("Создавать задачи может владелец, админ или модератор с доступом к проекту.")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }

            if let errorText {
                Text(errorText).font(.caption).foregroundStyle(Theme.danger)
            }
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder
    private func proposalRow(_ task: AgentProposalTask) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: task.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(task.ok ? Theme.statusDone : Theme.warning)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text("\(task.deadline ?? "без срока") • \(task.assigneeDisplay)"
                     + (task.ok ? "" : " • \(task.reason ?? "не будет создана")"))
                    .font(.caption2)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .opacity(task.ok ? 1 : 0.6)
    }

    private func confirm() {
        isBusy = true
        errorText = nil
        Task {
            defer { isBusy = false }
            do {
                let created = try await ApiClient.agentCreateTasks(proposal: proposal)
                done = true
                onResult("✅ Создано задач: \(created). Проект «\(proposal.projectName)», раздел «Назначенные».")
            } catch {
                errorText = (error as? ApiError)?.errorDescription ?? "Не удалось создать задачи"
            }
        }
    }
}

// Карточка удаления — аналог web appendAgentDeleteProposal: список найденных
// задач + красная кнопка подтверждения; удаление необратимо.
struct AgentDeleteProposalCard: View {
    let proposal: AgentDeleteProposal
    let onResult: (String) -> Void
    @State private var isBusy = false
    @State private var done = false
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Удаление задач — проект «\(proposal.projectName)»")
                .font(.subheadline.bold())
                .foregroundStyle(Theme.textPrimary)
            if !proposal.filterLabel.isEmpty {
                Text("Условие: \(proposal.filterLabel)")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
            Text("⚠️ Действие необратимо")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.danger)

            ForEach(proposal.tasks) { task in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "trash")
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(task.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.textPrimary)
                        Text("\(task.statusLabel ?? "") • \(task.deadline ?? "без срока") • \(task.assigneeDisplay)")
                            .font(.caption2)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
            }

            if proposal.canDelete && !done {
                Button(role: .destructive) {
                    confirm()
                } label: {
                    if isBusy {
                        ProgressView().tint(.white).frame(maxWidth: .infinity)
                    } else {
                        Text("Удалить \(proposal.tasks.count) задач(и)")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.danger)
                .disabled(isBusy)
            }

            if let errorText {
                Text(errorText).font(.caption).foregroundStyle(Theme.danger)
            }
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Theme.danger.opacity(0.35), lineWidth: 1)
        )
    }

    private func confirm() {
        isBusy = true
        errorText = nil
        Task {
            defer { isBusy = false }
            do {
                let deleted = try await ApiClient.agentDeleteTasks(proposal: proposal)
                done = true
                onResult("🗑️ Удалено задач: \(deleted). Проект «\(proposal.projectName)».")
            } catch {
                errorText = (error as? ApiError)?.errorDescription ?? "Не удалось удалить задачи"
            }
        }
    }
}
