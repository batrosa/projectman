import SwiftUI
import Foundation

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
    @State private var sessionGeneration = UUID()
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
            }
        }
        .onChange(of: appState.user?.organizationId) {
            resetConversationForOrganizationChange()
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
                            Text("ИИ Агент")
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
            AgentMarkdownView(text: text)
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
        case .actionProposal(_, let proposal):
            AgentActionProposalCard(proposal: proposal) { resultText in
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
        let requestGeneration = sessionGeneration
        history.append(["role": "user", "content": message])
        isSending = true

        Task {
            defer {
                if requestGeneration == sessionGeneration { isSending = false }
            }
            do {
                let reply = try await ApiClient.agentChat(
                    message: message,
                    history: historyForRequest,
                    projectId: targetProject?.id ?? "",
                    projectName: targetProject?.name ?? ""
                )
                guard requestGeneration == sessionGeneration else { return }
                if let navigation = reply.navigation {
                    performNavigation(navigation)
                    appendAssistant(reply.answer ?? "Раздел открыт.")
                } else if let proposal = reply.actionProposal {
                    entries.append(.actionProposal(id: UUID(), proposal: proposal))
                    history.append(["role": "assistant",
                                    "content": "Подготовлено действие: \(proposal.title). Ожидается подтверждение."])
                } else if let proposal = reply.createProposal {
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
                guard requestGeneration == sessionGeneration else { return }
                entries.append(.error(id: UUID(),
                                      text: (error as? ApiError)?.errorDescription ?? "Ошибка сети. Попробуйте ещё раз."))
            }
        }
    }

    private func resetConversationForOrganizationChange() {
        sessionGeneration = UUID()
        entries.removeAll()
        history.removeAll()
        targetProject = nil
        input = ""
        isSending = false
        inputFocused = false
    }

    private func appendAssistant(_ text: String) {
        entries.append(.assistant(id: UUID(), text: text))
        history.append(["role": "assistant", "content": text])
        trimHistory()
    }

    private func trimHistory() {
        if history.count > 12 { history.removeFirst(history.count - 12) }
    }

    private func performNavigation(_ navigation: AgentNavigation) {
        NotificationCenter.default.post(
            name: .hmAgentNavigate,
            object: nil,
            userInfo: [
                "target": navigation.target,
                "projectId": navigation.projectId ?? "",
                "taskId": navigation.taskId ?? "",
            ]
        )
    }
}

private struct AgentMarkdownView: View {
    let text: String

    private var blocks: [AgentMarkdownBlock] {
        parseAgentMarkdown(DateFormatter.displayIsoDays(in: text))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks) { block in
                switch block.kind {
                case .paragraph(let lines):
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            AgentInlineMarkdownText(line)
                        }
                    }
                case .heading(let value):
                    AgentInlineMarkdownText(value)
                        .font(.headline.weight(.semibold))
                        .padding(.top, 2)
                case .list(let ordered, let items):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(ordered ? "\(index + 1)." : "•")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.textSecondary)
                                    .frame(width: ordered ? 24 : 12, alignment: .trailing)
                                AgentInlineMarkdownText(item)
                            }
                        }
                    }
                case .code(let value):
                    Text(value)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Theme.textPrimary)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.background.opacity(0.65), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                case .table(let header, let rows):
                    AgentMarkdownTable(header: header, rows: rows)
                }
            }
        }
        .font(.subheadline)
        .foregroundStyle(Theme.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct AgentInlineMarkdownText: View {
    let raw: String

    init(_ raw: String) {
        self.raw = raw
    }

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: raw,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(stripInlineMarkdown(raw))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct AgentMarkdownTable: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        AgentInlineMarkdownText(cell)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .frame(minWidth: 120, alignment: .leading)
                            .background(Theme.primary.opacity(0.12))
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<max(header.count, row.count), id: \.self) { index in
                            AgentInlineMarkdownText(index < row.count ? row[index] : "")
                                .font(.caption)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .frame(minWidth: 120, alignment: .leading)
                                .background(Theme.background.opacity(0.35))
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Theme.hairline, lineWidth: 1)
            )
        }
    }
}

private struct AgentMarkdownBlock: Identifiable {
    let id = UUID()
    let kind: Kind

    enum Kind {
        case paragraph([String])
        case heading(String)
        case list(ordered: Bool, items: [String])
        case code(String)
        case table(header: [String], rows: [[String]])
    }
}

private func parseAgentMarkdown(_ text: String) -> [AgentMarkdownBlock] {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n")
        .components(separatedBy: "\n")
    var blocks: [AgentMarkdownBlock] = []
    var index = 0

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.isEmpty {
            index += 1
            continue
        }

        if trimmed.hasPrefix("```") {
            index += 1
            var code: [String] = []
            while index < lines.count && !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                code.append(lines[index])
                index += 1
            }
            if index < lines.count { index += 1 }
            blocks.append(.init(kind: .code(code.joined(separator: "\n"))))
            continue
        }

        if line.contains("|"), index + 1 < lines.count, isMarkdownTableSeparator(lines[index + 1]) {
            let header = splitMarkdownTableRow(line)
            index += 2
            var rows: [[String]] = []
            while index < lines.count && lines[index].contains("|") && !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                rows.append(splitMarkdownTableRow(lines[index]))
                index += 1
            }
            blocks.append(.init(kind: .table(header: header, rows: rows)))
            continue
        }

        if let heading = markdownHeading(line) {
            blocks.append(.init(kind: .heading(heading)))
            index += 1
            continue
        }

        if isMarkdownListItem(line) {
            let ordered = isOrderedMarkdownListItem(line)
            var items: [String] = []
            while index < lines.count, isMarkdownListItem(lines[index]), isOrderedMarkdownListItem(lines[index]) == ordered {
                items.append(stripMarkdownListMarker(lines[index]))
                index += 1
            }
            blocks.append(.init(kind: .list(ordered: ordered, items: items)))
            continue
        }

        var paragraph: [String] = []
        while index < lines.count {
            let current = lines[index]
            let currentTrimmed = current.trimmingCharacters(in: .whitespaces)
            if currentTrimmed.isEmpty || isMarkdownBlockStart(lines, index) { break }
            paragraph.append(current)
            index += 1
        }
        if !paragraph.isEmpty {
            blocks.append(.init(kind: .paragraph(paragraph)))
        } else {
            index += 1
        }
    }

    return blocks.isEmpty ? [.init(kind: .paragraph([text]))] : blocks
}

private func isMarkdownBlockStart(_ lines: [String], _ index: Int) -> Bool {
    let line = lines[index]
    return line.trimmingCharacters(in: .whitespaces).hasPrefix("```")
        || markdownHeading(line) != nil
        || isMarkdownListItem(line)
        || (line.contains("|") && index + 1 < lines.count && isMarkdownTableSeparator(lines[index + 1]))
}

private func markdownHeading(_ line: String) -> String? {
    guard let range = line.range(of: #"^\s*#{1,6}\s+(.+)$"#, options: .regularExpression) else { return nil }
    let matched = String(line[range])
    return matched.replacingOccurrences(of: #"^\s*#{1,6}\s+"#, with: "", options: .regularExpression)
}

private func isMarkdownListItem(_ line: String) -> Bool {
    line.range(of: #"^\s*([-*•]|\d+[.)])\s+\S"#, options: .regularExpression) != nil
}

private func isOrderedMarkdownListItem(_ line: String) -> Bool {
    line.range(of: #"^\s*\d+[.)]\s+\S"#, options: .regularExpression) != nil
}

private func stripMarkdownListMarker(_ line: String) -> String {
    line.replacingOccurrences(of: #"^\s*([-*•]|\d+[.)])\s+"#, with: "", options: .regularExpression)
}

private func isMarkdownTableSeparator(_ line: String) -> Bool {
    line.range(of: #"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$"#, options: .regularExpression) != nil
        || line.range(of: #"^\s*\|\s*:?-{2,}:?\s*\|\s*$"#, options: .regularExpression) != nil
}

private func splitMarkdownTableRow(_ line: String) -> [String] {
    var value = line.trimmingCharacters(in: .whitespaces)
    if value.hasPrefix("|") { value.removeFirst() }
    if value.hasSuffix("|") { value.removeLast() }
    return value.split(separator: "|", omittingEmptySubsequences: false)
        .map { String($0).trimmingCharacters(in: .whitespaces) }
}

private func stripInlineMarkdown(_ value: String) -> String {
    value
        .replacingOccurrences(of: #"\*\*([^*]+)\*\*"#, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"__([^_]+)__"#, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"\*([^*\n]+)\*"#, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"_([^_\n]+)_"#, with: "$1", options: .regularExpression)
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
                if !task.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(task.description)
                        .font(.caption2)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 2)
                }
                Text((proposal.multiProject ? "\(task.projectName ?? "проект") · " : "")
                     + "\(DateFormatter.displayDay(task.deadline)) · \(task.assigneeDisplay)"
                     + (task.coCreatorDisplay.map { " · доп. постановщики: \($0)" } ?? "")
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
                let scope = proposal.multiProject
                    ? "Распределены по доступным проектам"
                    : "Проект «\(proposal.projectName)»"
                onResult("✅ Создано задач: \(created). \(scope), раздел «Назначенные».")
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
                            Text("\(task.statusLabel ?? "") · \(DateFormatter.displayDay(task.deadline)) · \(task.assigneeDisplay)")
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

struct AgentActionProposalCard: View {
    let proposal: AgentActionProposal
    let onResult: (String) -> Void
    @State private var isBusy = false
    @State private var done = false
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                Image(systemName: proposal.destructive ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                    .foregroundStyle(proposal.destructive ? Theme.danger : Theme.primary)
                Text(proposal.title)
                    .font(.subheadline.bold())
                    .foregroundStyle(Theme.textPrimary)
            }
            Text(DateFormatter.displayIsoDays(in: proposal.summary))
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if !done {
                Button {
                    confirm()
                } label: {
                    if isBusy {
                        ProgressView().tint(.white)
                    } else {
                        Text(proposal.confirmLabel)
                    }
                }
                .buttonStyle(PrimaryButtonStyle(tint: proposal.destructive ? Theme.danger : Theme.primary))
                .disabled(isBusy)
            } else {
                Label("Действие выполнено", systemImage: "checkmark.circle.fill")
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
                .stroke((proposal.destructive ? Theme.danger : Theme.primary).opacity(0.3), lineWidth: 1)
        )
    }

    private func confirm() {
        isBusy = true
        errorText = nil
        Task {
            defer { isBusy = false }
            do {
                let result = try await ApiClient.executeAgentAction(proposal)
                done = true
                onResult("✅ \(result)")
            } catch {
                errorText = (error as? ApiError)?.errorDescription ?? "Не удалось выполнить действие"
            }
        }
    }
}
