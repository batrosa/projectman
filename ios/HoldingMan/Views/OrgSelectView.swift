import SwiftUI

// Выбор/вступление в организацию — те же серверные действия, что web
// (api/org list/switch, api/join-org). После switch слушатель user-doc в
// AppState сам переведёт приложение в рабочее состояние.
struct OrgSelectView: View {
    @EnvironmentObject private var appState: AppState
    @State private var organizations: [Organization] = []
    @State private var isLoading = true
    @State private var inviteCode = ""
    @State private var errorMessage: String?
    @State private var busyOrgId: String?
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if isLoading {
                        ProgressView().tint(Theme.primary)
                            .padding(.top, 80)
                    } else {
                        if organizations.isEmpty {
                            VStack(spacing: 10) {
                                Image(systemName: "building.2")
                                    .font(.system(size: 34, weight: .light))
                                    .foregroundStyle(Theme.textSecondary.opacity(0.7))
                                Text("Вы пока не состоите ни в одной организации")
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.textSecondary)
                                    .multilineTextAlignment(.center)
                            }
                            .padding(.vertical, 30)
                        } else {
                            sectionTitle("Мои организации")
                            ForEach(organizations) { org in
                                orgCard(org)
                            }
                        }

                        sectionTitle("Вступить по коду")
                            .padding(.top, 8)
                        joinCard
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(Theme.danger)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .screenBackground()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Организация")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Выйти") { appState.signOut() }
                        .foregroundStyle(Theme.danger)
                }
            }
        }
        .task { await load() }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.bold))
            .foregroundStyle(Theme.textSecondary)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 2)
    }

    private func orgCard(_ org: Organization) -> some View {
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
                    HStack(spacing: 6) {
                        if let role = org.orgRole {
                            Text(roleRu(role))
                                .font(.caption)
                                .foregroundStyle(Theme.primary)
                        }
                        if let count = org.membersCount {
                            Text("· \(count) чел.")
                                .font(.caption)
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                }

                Spacer(minLength: 6)

                if busyOrgId == org.id {
                    ProgressView().tint(Theme.primary)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.textSecondary.opacity(0.6))
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
        .buttonStyle(PressableStyle())
        .disabled(busyOrgId != nil)
    }

    private var joinCard: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "key.fill")
                    .font(.subheadline)
                    .foregroundStyle(codeFocused ? Theme.primary : Theme.textSecondary)
                TextField("Код приглашения", text: $inviteCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .foregroundStyle(Theme.textPrimary)
                    .focused($codeFocused)
            }
            .padding(.horizontal, 14)
            .frame(height: 50)
            .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 13, style: .continuous))

            Button {
                codeFocused = false
                join()
            } label: {
                if busyOrgId == "join" {
                    ProgressView().tint(.white)
                } else {
                    Text("Присоединиться")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(inviteCode.trimmingCharacters(in: .whitespaces).isEmpty || busyOrgId != nil)
            .opacity(inviteCode.trimmingCharacters(in: .whitespaces).isEmpty ? 0.55 : 1)
        }
        .padding(14)
        .card()
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            organizations = try await ApiClient.listOrganizations()
        } catch {
            errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось загрузить организации"
        }
    }

    private func enter(_ org: Organization) {
        busyOrgId = org.id
        errorMessage = nil
        Task {
            defer { busyOrgId = nil }
            do {
                try await ApiClient.switchOrganization(id: org.id)
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

    private func roleRu(_ role: String) -> String {
        switch role {
        case "owner": return "Владелец"
        case "admin": return "Администратор"
        case "moderator": return "Модератор"
        case "reader": return "Наблюдатель"
        default: return "Исполнитель"
        }
    }
}
