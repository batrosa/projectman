import SwiftUI

// Организации: вход в свою, вступление по коду приглашения (с живым
// предпросмотром: имя + число участников до вступления) и создание новой.
// Все операции — те же серверные действия, что web (api/org list / switch /
// preview / create, api/join-org); после успеха слушатель user-doc в AppState
// сам переводит приложение в рабочее состояние.
struct OrgSelectView: View {
    @EnvironmentObject private var appState: AppState

    @State private var organizations: [Organization] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var busyOrgId: String?

    @State private var mode: Mode = .join
    @Namespace private var modeIndicator

    // Вступление по коду
    @State private var inviteCode = ""
    @State private var preview: Organization?
    @State private var previewState: PreviewState = .idle
    @State private var previewTask: Task<Void, Never>?

    // Создание
    @State private var newOrgName = ""

    @FocusState private var focusedField: Field?

    private enum Mode: String, CaseIterable, Identifiable {
        case join, create
        var id: String { rawValue }
        var titleRu: String { self == .join ? "Вступить по коду" : "Создать свою" }
        var icon: String { self == .join ? "key.fill" : "plus.circle.fill" }
    }

    private enum PreviewState { case idle, searching, found, notFound }
    private enum Field { case code, name }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    header
                        .padding(.top, 8)

                    if isLoading {
                        ProgressView().tint(Theme.primary)
                            .padding(.vertical, 30)
                    } else {
                        if !organizations.isEmpty {
                            myOrganizations
                        }

                        actionCard
                    }

                    if let errorMessage {
                        errorBanner(errorMessage)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .screenBackground()
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Выйти") { appState.signOut() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.danger)
                }
            }
        }
        .animation(.spring(duration: 0.32), value: previewState)
        .animation(.spring(duration: 0.32), value: mode)
        .task { await load() }
        #if DEBUG
        .onAppear {
            guard DemoData.isEnabled else { return }
            if DemoData.screen == "orgs-preview" {
                inviteCode = "NFG-7K2M"
                preview = Organization(id: "demo", name: "Строй-Инвест", orgRole: nil, membersCount: 12)
                previewState = .found
            } else if DemoData.screen == "orgs-create" {
                mode = .create
            }
        }
        #endif
    }

    // MARK: — шапка

    private var header: some View {
        VStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 19, style: .continuous)
                    .fill(Theme.primaryGradient)
                    .frame(width: 72, height: 72)
                    .shadow(color: Theme.primary.opacity(0.32), radius: 16, y: 7)
                Image(systemName: "building.2.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.white)
            }

            VStack(spacing: 4) {
                Text("Привет, \(appState.user?.displayName.components(separatedBy: " ").first ?? "коллега")!")
                    .font(.title2.bold())
                    .foregroundStyle(Theme.textPrimary)
                Text("Выберите организацию, вступите по коду\nили создайте свою")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: — мои организации

    private var myOrganizations: some View {
        VStack(spacing: 10) {
            sectionTitle("Мои организации")
            ForEach(organizations) { org in
                Button {
                    enter(org)
                } label: {
                    HStack(spacing: 13) {
                        AvatarView(name: org.name, size: 44)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(org.name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Theme.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack(spacing: 5) {
                                if let role = org.orgRole {
                                    Text(roleRu(role))
                                        .font(.caption)
                                        .foregroundStyle(Theme.primary)
                                }
                                if let count = org.membersCount {
                                    Text("· \(membersRu(count))")
                                        .font(.caption)
                                        .foregroundStyle(Theme.textSecondary)
                                }
                            }
                        }

                        Spacer(minLength: 6)

                        if busyOrgId == org.id {
                            ProgressView().tint(Theme.primary)
                        } else {
                            HStack(spacing: 4) {
                                Text("Войти")
                                    .font(.footnote.weight(.bold))
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 11, weight: .bold))
                            }
                            .foregroundStyle(Theme.primary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(Theme.primary.opacity(0.12), in: Capsule())
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card()
                }
                .buttonStyle(PressableStyle())
                .disabled(busyOrgId != nil)
            }
        }
    }

    // MARK: — вступить / создать

    private var actionCard: some View {
        VStack(spacing: 14) {
            // Переключатель режима со «скользящей» подложкой
            HStack(spacing: 6) {
                ForEach(Mode.allCases) { option in
                    let isActive = mode == option
                    Button {
                        withAnimation(.spring(duration: 0.32, bounce: 0.2)) { mode = option }
                        focusedField = nil
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: option.icon)
                                .font(.system(size: 12, weight: .semibold))
                            Text(option.titleRu)
                                .font(.footnote.weight(.semibold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.85)
                        }
                        .foregroundStyle(isActive ? Theme.primary : Theme.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background {
                            if isActive {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(Theme.primary.opacity(0.12))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                                            .stroke(Theme.primary.opacity(0.35), lineWidth: 1)
                                    )
                                    .matchedGeometryEffect(id: "mode", in: modeIndicator)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(4)
            .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 15, style: .continuous))

            switch mode {
            case .join: joinContent
            case .create: createContent
            }
        }
        .padding(14)
        .card()
    }

    // MARK: — вступление по коду (с живым предпросмотром)

    private var joinContent: some View {
        VStack(spacing: 12) {
            inputRow(
                icon: "key.fill",
                placeholder: "Код приглашения",
                text: $inviteCode,
                field: .code
            )
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .font(.system(.body, design: .monospaced).weight(.semibold))
            .onChange(of: inviteCode) { schedulePreview() }

            switch previewState {
            case .idle:
                Text("Код выдаёт владелец или администратор организации")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)

            case .searching:
                HStack(spacing: 8) {
                    ProgressView().tint(Theme.primary).controlSize(.small)
                    Text("Ищем организацию…")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

            case .notFound:
                HStack(spacing: 8) {
                    Image(systemName: "questionmark.circle.fill")
                        .foregroundStyle(Theme.warning)
                    Text("Организация с таким кодом не найдена")
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            case .found:
                if let preview {
                    VStack(spacing: 12) {
                        HStack(spacing: 12) {
                            AvatarView(name: preview.name, size: 42)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(preview.name)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Theme.textPrimary)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let count = preview.membersCount {
                                    Text(membersRu(count))
                                        .font(.caption)
                                        .foregroundStyle(Theme.textSecondary)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "checkmark.seal.fill")
                                .foregroundStyle(Theme.statusDone)
                        }
                        .padding(12)
                        .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 13, style: .continuous))

                        Button {
                            focusedField = nil
                            join()
                        } label: {
                            if busyOrgId == "join" {
                                ProgressView().tint(.white)
                            } else {
                                Text("Вступить в «\(preview.name)»")
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(busyOrgId != nil)
                    }
                    .transition(.scale(scale: 0.96).combined(with: .opacity))
                }
            }
        }
    }

    // MARK: — создание организации

    private var createContent: some View {
        VStack(spacing: 12) {
            inputRow(
                icon: "building.2",
                placeholder: "Название организации",
                text: $newOrgName,
                field: .name
            )

            Text("Вы станете владельцем: полный доступ к проектам, участникам и коду приглашения.")
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                focusedField = nil
                create()
            } label: {
                if busyOrgId == "create" {
                    ProgressView().tint(.white)
                } else {
                    Text("Создать организацию")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(newOrgName.trimmingCharacters(in: .whitespaces).count < 2 || busyOrgId != nil)
            .opacity(newOrgName.trimmingCharacters(in: .whitespaces).count < 2 ? 0.55 : 1)
        }
    }

    // MARK: — общие элементы

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.bold))
            .foregroundStyle(Theme.textSecondary)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 2)
    }

    private func inputRow(icon: String, placeholder: String, text: Binding<String>, field: Field) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundStyle(focusedField == field ? Theme.primary : Theme.textSecondary)
                .frame(width: 20)
            TextField(placeholder, text: text)
                .foregroundStyle(Theme.textPrimary)
                .focused($focusedField, equals: field)
        }
        .padding(.horizontal, 14)
        .frame(height: 50)
        .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(focusedField == field ? Theme.primary.opacity(0.5) : .clear, lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.15), value: focusedField)
    }

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote)
        .foregroundStyle(Theme.danger)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .transition(.opacity)
    }

    // MARK: — данные

    private func load() async {
        #if DEBUG
        if DemoData.isEnabled {
            organizations = [Organization(id: "o1", name: "NF Group", orgRole: "owner", membersCount: 6)]
            isLoading = false
            return
        }
        #endif
        isLoading = true
        defer { isLoading = false }
        do {
            organizations = try await ApiClient.listOrganizations()
        } catch {
            errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось загрузить организации"
        }
    }

    // Живой предпросмотр: дебаунс 450 мс, устаревшие запросы отменяются
    private func schedulePreview() {
        previewTask?.cancel()
        errorMessage = nil
        let code = inviteCode.trimmingCharacters(in: .whitespaces)
        guard code.count >= 4 else {
            previewState = .idle
            preview = nil
            return
        }
        previewState = .searching
        previewTask = Task {
            try? await Task.sleep(nanoseconds: 450_000_000)
            guard !Task.isCancelled else { return }
            do {
                let found = try await ApiClient.previewOrganization(inviteCode: code)
                guard !Task.isCancelled else { return }
                if let found {
                    preview = found
                    previewState = .found
                } else {
                    preview = nil
                    previewState = .notFound
                }
            } catch {
                guard !Task.isCancelled else { return }
                preview = nil
                previewState = .notFound
            }
        }
    }

    private func enter(_ org: Organization) {
        busyOrgId = org.id
        errorMessage = nil
        Task {
            defer { busyOrgId = nil }
            do {
                try await ApiClient.switchOrganization(id: org.id)
                // Дальше — слушатель user-doc в AppState
            } catch {
                errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось войти в организацию"
            }
        }
    }

    private func join() {
        busyOrgId = "join"
        errorMessage = nil
        Task {
            defer { busyOrgId = nil }
            do {
                try await ApiClient.joinOrganization(inviteCode: inviteCode.trimmingCharacters(in: .whitespaces))
            } catch {
                errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось вступить в организацию"
            }
        }
    }

    private func create() {
        busyOrgId = "create"
        errorMessage = nil
        Task {
            defer { busyOrgId = nil }
            do {
                _ = try await ApiClient.createOrganization(name: newOrgName.trimmingCharacters(in: .whitespaces))
                // Сервер уже сделал нас владельцем — user-doc слушатель переключит экран
            } catch {
                errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось создать организацию"
            }
        }
    }

    private func roleRu(_ role: String) -> String {
        switch role {
        case "owner": return "Владелец"
        case "admin": return "Администратор"
        case "moderator": return "Модератор"
        case "reader": return "Наблюдатель"
        default: return "Исполнитель"
        }
    }

    private func membersRu(_ count: Int) -> String {
        let mod10 = count % 10, mod100 = count % 100
        let word: String
        if mod10 == 1 && mod100 != 11 { word = "участник" }
        else if (2...4).contains(mod10) && !(12...14).contains(mod100) { word = "участника" }
        else { word = "участников" }
        return "\(count) \(word)"
    }
}
