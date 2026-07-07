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
    @FocusState private var inputFocused: Bool

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
                        HStack(spacing: 5) {
                            Image(systemName: "folder.fill")
                                .font(.system(size: 11))
                            Text(targetProject?.name ?? "Проект")
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .bold))
                        }
                        .foregroundStyle(Theme.primary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Theme.primary.opacity(0.12), in: Capsule())
                    }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Готово") { inputFocused = false }
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
    }

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if entries.isEmpty {
                        VStack(spacing: 14) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .fill(Theme.primaryGradient)
                                    .frame(width: 64, height: 64)
                                    .shadow(color: Theme.primary.opacity(0.3), radius: 14, y: 6)
                                Image(systemName: "sparkles")
                                    .font(.system(size: 26, weight: .semibold))
                                    .foregroundStyle(.white)
                            }
                            Text("ИИ Руководитель проекта")
                                .font(.headline)
                                .foregroundStyle(Theme.textPrimary)
                            Text("Спросите о проектах, задачах и сроках.\nМогу создавать и удалять задачи —\nс карточкой подтверждения.")
                                .font(.footnote)
                                .foregroundStyle(Theme.textSecondary)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 70)
                        .padding(.horizontal, 30)
                    }

                    ForEach(entries) { entry in
                        entryView(entry)
                            .id(entry.id)
                    }

                    if isSending {
                        TypingIndicator()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .id("typing")
                    }
                }
                .padding(.vertical, 10)
            }
            .scrollDismissesKeyboard(.interactively)
            .contentShape(Rectangle())
            .onTapGesture { inputFocused = false }
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
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Theme.primaryGradient, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 56)
                .padding(.trailing, 12)
                .transition(.scale(scale: 0.95, anchor: .bottomTrailing).combined(with: .opacity))
        case .assistant(_, let text):
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(Theme.hairline, lineWidth: 1)
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 40)
                .padding(.leading, 12)
                .transition(.scale(scale: 0.95, anchor: .bottomLeading).combined(with: .opacity))
        case .error(_, let text):
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle.fill")
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.footnote)
            .foregroundStyle(Theme.danger)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Сообщение агенту…", text: $input, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(inputFocused ? Theme.primary.opacity(0.5) : Theme.hairline, lineWidth: 1)
                )
                .foregroundStyle(Theme.textPrimary)
                .focused($inputFocused)
                .submitLabel(.send)
                .onSubmit { send() }
                .animation(.easeInOut(duration: 0.15), value: inputFocused)

            Button {
                send()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Theme.primaryGradient, in: Circle())
            }
            .buttonStyle(PressableStyle())
            .disabled(isSending || input.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(isSending || input.trimmingCharacters(in: .whitespaces).isEmpty ? 0.45 : 1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.background)
    }

    private func send() {
        let message = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !isSending else { return }
        input = ""
        inputFocused = false
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

// Анимированный индикатор «агент печатает» — три пульсирующие точки
private struct TypingIndicator: View {
    @State private var animate = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Theme.textSecondary)
                    .frame(width: 7, height: 7)
                    .scaleEffect(animate ? 1 : 0.55)
                    .opacity(animate ? 1 : 0.4)
                    .animation(
                        .easeInOut(duration: 0.5)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.16),
                        value: animate
                    )
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Theme.hairline, lineWidth: 1)
        )
        .onAppear { animate = true }
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "wand.and.stars")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.primary)
                Text("Создание задач · «\(proposal.projectName)»")
                    .font(.subheadline.bold())
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 0) {
                ForEach(Array(proposal.tasks.enumerated()), id: \.element.id) { index, task in
                    proposalRow(task)
                    if index < proposal.tasks.count - 1 {
                        Divider().overlay(Theme.hairline)
                    }
                }
            }
            .padding(.vertical, 2)

            let okCount = proposal.tasks.filter(\.ok).count
            if proposal.canCreate && okCount > 0 && !done {
                Button {
                    confirm()
                } label: {
                    if isBusy {
                        ProgressView().tint(.white)
                    } else {
                        Text("Создать: \(okCount)")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isBusy)
            } else if done {
                Label("Задачи созданы", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.statusDone)
            } else if !proposal.canCreate {
                Text("Создавать задачи может владелец, админ или модератор с доступом к проекту.")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .card()
    }

    @ViewBuilder
    private func proposalRow(_ task: AgentProposalTask) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: task.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(task.ok ? Theme.statusDone : Theme.warning)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(task.deadline ?? "без срока") · \(task.assigneeDisplay)"
                     + (task.ok ? "" : " · \(task.reason ?? "не будет создана")"))
                    .font(.caption2)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "trash.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.danger)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Удаление задач · «\(proposal.projectName)»")
                        .font(.subheadline.bold())
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !proposal.filterLabel.isEmpty {
                        Text("Условие: \(proposal.filterLabel) · необратимо")
                            .font(.caption2)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }

            VStack(spacing: 0) {
                ForEach(Array(proposal.tasks.enumerated()), id: \.element.id) { index, task in
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: "minus.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(Theme.danger.opacity(0.8))
                            .padding(.top, 2)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(task.title)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("\(task.statusLabel ?? "") · \(task.deadline ?? "без срока") · \(task.assigneeDisplay)")
                                .font(.caption2)
                                .foregroundStyle(Theme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 7)
                    if index < proposal.tasks.count - 1 {
                        Divider().overlay(Theme.hairline)
                    }
                }
            }
            .padding(.vertical, 2)

            if proposal.canDelete && !done {
                Button {
                    confirm()
                } label: {
                    if isBusy {
                        ProgressView().tint(.white)
                    } else {
                        Text("Удалить: \(proposal.tasks.count)")
                    }
                }
                .buttonStyle(PrimaryButtonStyle(tint: Theme.danger))
                .disabled(isBusy)
            } else if done {
                Label("Задачи удалены", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.statusDone)
            }

            if let errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Theme.danger.opacity(0.3), lineWidth: 1)
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
