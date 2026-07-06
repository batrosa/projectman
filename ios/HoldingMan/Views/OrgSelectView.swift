import SwiftUI

// Выбор/вступление в организацию — через те же серверные действия api/org и
// api/join-org, что и web. После switch собственный user-doc слушатель в
// AppState сам переведёт приложение в рабочее состояние.
struct OrgSelectView: View {
    @EnvironmentObject private var appState: AppState
    @State private var organizations: [Organization] = []
    @State private var isLoading = true
    @State private var inviteCode = ""
    @State private var errorMessage: String?
    @State private var busyOrgId: String?

    var body: some View {
        NavigationStack {
            List {
                if isLoading {
                    HStack {
                        Spacer()
                        ProgressView().tint(Theme.primary)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                } else if organizations.isEmpty {
                    Text("Вы пока не состоите ни в одной организации. Вступите по коду приглашения.")
                        .foregroundStyle(Theme.textSecondary)
                        .listRowBackground(Theme.surface)
                } else {
                    Section("Мои организации") {
                        ForEach(organizations) { org in
                            Button {
                                enter(org)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(org.name)
                                            .font(.headline)
                                            .foregroundStyle(Theme.textPrimary)
                                        if let role = org.orgRole {
                                            Text(roleRu(role))
                                                .font(.caption)
                                                .foregroundStyle(Theme.textSecondary)
                                        }
                                    }
                                    Spacer()
                                    if busyOrgId == org.id {
                                        ProgressView().tint(Theme.primary)
                                    } else {
                                        Image(systemName: "chevron.right")
                                            .font(.caption)
                                            .foregroundStyle(Theme.textSecondary)
                                    }
                                }
                            }
                            .listRowBackground(Theme.surface)
                        }
                    }
                }

                Section("Вступить по коду приглашения") {
                    HStack {
                        TextField("Код приглашения", text: $inviteCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .foregroundStyle(Theme.textPrimary)
                        Button("Вступить") { join() }
                            .disabled(inviteCode.trimmingCharacters(in: .whitespaces).isEmpty || busyOrgId != nil)
                    }
                    .listRowBackground(Theme.surface)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .listRowBackground(Color.clear)
                }
            }
            .screenBackground()
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
                // Дальше сработает слушатель user-doc в AppState
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
