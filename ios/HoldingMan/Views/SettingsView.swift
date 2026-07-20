import SwiftUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @AppStorage("appearance") private var appearanceRaw = Appearance.system.rawValue
    @State private var confirmLogout = false
    @State private var showOrgScreen = false
    @State private var showNameEditor = false

    private var appearance: Appearance {
        get { Appearance(rawValue: appearanceRaw) ?? .system }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let user = appState.user {
                        profileCard(user)
                    }

                    appearanceCard

                    organizationCard

                    if let user = appState.user,
                       let organizationId = user.organizationId,
                       user.orgRole == "owner" || user.orgRole == "admin" {
                        OrganizationInviteCard(
                            organizationId: organizationId,
                            organizationName: appState.organizationName
                        )
                        .id(organizationId)
                    }

                    if let user = appState.user {
                        loginMethodCard(user)
                    }

                    if appState.user?.orgRole == "owner" || appState.user?.orgRole == "admin" {
                        NavigationLink {
                            TeamView()
                        } label: {
                            settingsRow(
                                icon: "person.2.fill",
                                iconColor: Theme.primary,
                                title: "Команда",
                                subtitle: "Участники и роли"
                            )
                        }
                        .buttonStyle(PressableStyle())
                    }

                    Link(destination: URL(string: "https://projectman.online")!) {
                        settingsRow(
                            icon: "safari.fill",
                            iconColor: Color(hex: 0x0EA5E9),
                            title: "Веб-версия",
                            subtitle: "Гант, календарь, рейтинг, файлы проектов"
                        )
                    }
                    .buttonStyle(PressableStyle())

                    Button {
                        confirmLogout = true
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .font(.headline)
                            Text("Выйти из аккаунта")
                                .font(.headline.weight(.semibold))
                        }
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(Theme.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    }
                    .buttonStyle(PressableStyle())
                    // Диалог привязан к кнопке выхода — появляется над ней
                    .confirmationDialog("Выйти из аккаунта?", isPresented: $confirmLogout, titleVisibility: .visible) {
                        Button("Выйти", role: .destructive) { appState.signOut() }
                        Button("Отмена", role: .cancel) {}
                    }
                    .padding(.top, 6)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .screenBackground()
            .navigationTitle("Профиль")
            .sheet(isPresented: $showNameEditor) {
                if let user = appState.user {
                    EditProfileNameView(user: user)
                }
            }
        }
    }

    // MARK: — карточки

    private func profileCard(_ user: UserDoc) -> some View {
        VStack(spacing: 14) {
            HStack(spacing: 14) {
                AvatarView(name: user.displayName, size: 62)

                VStack(alignment: .leading, spacing: 4) {
                    Text(user.displayName)
                        .font(.title3.bold())
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !user.email.isEmpty {
                        Text(user.email)
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Text(user.roleRu)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Theme.primary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(Theme.primary.opacity(0.12), in: Capsule())
                }
                Spacer(minLength: 0)
                Button {
                    showNameEditor = true
                } label: {
                    Image(systemName: "pencil")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.primary)
                        .frame(width: 38, height: 38)
                        .background(Theme.primary.opacity(0.10), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("Изменить имя и фамилию")
            }

            HStack(spacing: 10) {
                statTile(value: "\(user.level)", label: "Уровень", icon: "star.fill", color: Theme.warning)
                statTile(value: "\(user.totalXP)", label: "XP", icon: "bolt.fill", color: Theme.primary)
                statTile(value: "\(user.completedTasksCount)", label: "Завершено", icon: "checkmark.seal.fill", color: Theme.statusDone)
            }
        }
        .padding(16)
        .card()
    }

    private func statTile(value: String, label: String, icon: String, color: Color) -> some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(color)
                Text(value)
                    .font(.system(.body, design: .rounded).weight(.bold))
                    .foregroundStyle(Theme.textPrimary)
            }
            Text(label)
                .font(.caption2)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var appearanceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Оформление")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.textSecondary)
                .textCase(.uppercase)

            HStack(spacing: 8) {
                ForEach(Appearance.allCases) { option in
                    let isActive = appearanceRaw == option.rawValue
                    Button {
                        withAnimation(.spring(duration: 0.3)) { appearanceRaw = option.rawValue }
                    } label: {
                        VStack(spacing: 6) {
                            Image(systemName: option.icon)
                                .font(.system(size: 17, weight: .semibold))
                            Text(option.titleRu)
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(isActive ? Theme.primary : Theme.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(
                            isActive ? Theme.primary.opacity(0.12) : Theme.surfaceSecondary,
                            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .stroke(isActive ? Theme.primary.opacity(0.4) : .clear, lineWidth: 1)
                        )
                    }
                    .buttonStyle(PressableStyle())
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var organizationCard: some View {
        Button {
            showOrgScreen = true
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(Theme.primary.opacity(0.12))
                    Image(systemName: "building.2.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.primary)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(appState.organizationName.isEmpty ? "Организация" : appState.organizationName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Сменить, вступить по коду или создать")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.textSecondary.opacity(0.6))
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
        .buttonStyle(PressableStyle())
        .sheet(isPresented: $showOrgScreen) {
            OrgSelectView(embedded: true)
        }
    }

    private func loginMethodCard(_ user: UserDoc) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Способ входа")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.textSecondary)
                .textCase(.uppercase)

            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(Theme.primary.opacity(0.12))
                    if user.authProvider == "google.com" {
                        GoogleLogoView().frame(width: 20, height: 20)
                    } else {
                        Image(systemName: user.authProviderIcon)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Theme.primary)
                    }
                }
                .frame(width: 42, height: 42)

                Text(user.authProviderTitle)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 0)
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(Theme.statusDone)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func settingsRow(icon: String, iconColor: Color, title: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(iconColor.opacity(0.12))
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(iconColor)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.textSecondary.opacity(0.6))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

private struct OrganizationInviteCard: View {
    let organizationId: String
    let organizationName: String

    @State private var inviteCode: String?
    @State private var isLoading = true
    @State private var isRegenerating = false
    @State private var errorMessage: String?
    @State private var didCopy = false
    @State private var confirmRegeneration = false

    private var inviteURL: URL? {
        guard let inviteCode else { return nil }
        var components = URLComponents(url: ApiClient.baseURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "invite", value: inviteCode)]
        return components?.url
    }

    private var resolvedOrganizationName: String {
        organizationName.isEmpty ? "организацию" : "«\(organizationName)»"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(Theme.primary.opacity(0.12))
                    Image(systemName: "person.badge.plus")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.primary)
                }
                .frame(width: 42, height: 42)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Приглашение в организацию")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text("Отправьте код или ссылку новому участнику")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer(minLength: 0)
            }

            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                        .tint(Theme.primary)
                    Spacer()
                }
                .frame(height: 82)
            } else if let errorMessage {
                VStack(spacing: 10) {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Button("Повторить") {
                        Task { await loadInviteCode() }
                    }
                    .buttonStyle(SoftButtonStyle())
                }
            } else if let inviteCode {
                VStack(spacing: 7) {
                    Text("КОД ОРГАНИЗАЦИИ")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Theme.textSecondary)
                        .tracking(1.1)
                    Text(inviteCode)
                        .font(.system(size: 27, weight: .bold, design: .monospaced))
                        .foregroundStyle(Theme.textPrimary)
                        .tracking(2.2)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Theme.primary.opacity(0.22), lineWidth: 1)
                )

                HStack(spacing: 10) {
                    Button {
                        UIPasteboard.general.string = inviteCode
                        withAnimation(.easeInOut(duration: 0.2)) { didCopy = true }
                        Task { @MainActor in
                            try? await Task<Never, Never>.sleep(for: .seconds(2))
                            withAnimation(.easeInOut(duration: 0.2)) { didCopy = false }
                        }
                    } label: {
                        Label(didCopy ? "Скопировано" : "Копировать", systemImage: didCopy ? "checkmark" : "doc.on.doc")
                    }
                    .buttonStyle(SoftButtonStyle())

                    if let inviteURL {
                        ShareLink(
                            item: inviteURL,
                            subject: Text("Приглашение в ProjectMan"),
                            message: Text("Присоединяйтесь в ProjectMan к \(resolvedOrganizationName). Код организации: \(inviteCode)")
                        ) {
                            Label("Поделиться", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(SoftButtonStyle())
                    }
                }

                Button {
                    confirmRegeneration = true
                } label: {
                    HStack(spacing: 7) {
                        if isRegenerating {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        Text("Сменить код приглашения")
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PressableStyle())
                .disabled(isRegenerating)
            } else {
                Label("Код приглашения недоступен", systemImage: "lock.fill")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .task(id: organizationId) {
            await loadInviteCode()
        }
        .confirmationDialog(
            "Сменить код приглашения?",
            isPresented: $confirmRegeneration,
            titleVisibility: .visible
        ) {
            Button("Сменить код", role: .destructive) {
                Task { await regenerateInviteCode() }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Старый код и ссылка перестанут работать.")
        }
    }

    @MainActor
    private func loadInviteCode() async {
        isLoading = true
        errorMessage = nil
        do {
            let organization = try await ApiClient.currentOrganization(id: organizationId)
            inviteCode = organization.inviteCode
        } catch {
            inviteCode = nil
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    @MainActor
    private func regenerateInviteCode() async {
        isRegenerating = true
        errorMessage = nil
        do {
            inviteCode = try await ApiClient.regenerateOrganizationInviteCode()
            didCopy = false
        } catch {
            errorMessage = error.localizedDescription
        }
        isRegenerating = false
    }
}

private struct EditProfileNameView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var firstName: String
    @State private var lastName: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    private enum Field { case firstName, lastName }

    init(user: UserDoc) {
        _firstName = State(initialValue: user.firstName)
        _lastName = State(initialValue: user.lastName)
    }

    private var trimmedFirstName: String {
        firstName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedLastName: String {
        lastName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        trimmedFirstName.count >= 2 && trimmedLastName.count >= 2 && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Имя", text: $firstName)
                        .textContentType(.givenName)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .firstName)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .lastName }

                    TextField("Фамилия", text: $lastName)
                        .textContentType(.familyName)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .lastName)
                        .submitLabel(.done)
                        .onSubmit { save() }
                } header: {
                    Text("Данные профиля")
                } footer: {
                    Text("Новое имя будет показано участникам ваших организаций.")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("Имя и фамилия")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        save()
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("Сохранить")
                        }
                    }
                    .disabled(!canSave)
                }
            }
            .interactiveDismissDisabled(isSaving)
            .onAppear { focusedField = .firstName }
        }
    }

    private func save() {
        guard canSave else { return }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await ApiClient.completeAuthProfile(
                    firstName: trimmedFirstName,
                    lastName: trimmedLastName
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSaving = false
            }
        }
    }
}
