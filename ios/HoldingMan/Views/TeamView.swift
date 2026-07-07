import SwiftUI

// Команда организации: список участников, смена ролей и исключение — через
// те же серверные действия, что веб-админка (api/org updateMemberRole /
// removeMember). Ограничения (владельца не трогаем, админ не управляет
// админами) сервер проверяет сам; UI их зеркалит, чтобы не показывать
// заведомо запрещённые действия.
struct TeamView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var orgUsersStore: OrgUsersStore

    @State private var busyUserId: String?
    @State private var errorMessage: String?
    @State private var memberToRemove: OrgUser?

    private let assignableRoles: [(role: String, title: String)] = [
        ("admin", "Администратор"),
        ("moderator", "Модератор"),
        ("employee", "Исполнитель"),
        ("reader", "Наблюдатель"),
    ]

    private var callerRole: String { appState.user?.orgRole ?? "employee" }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                ForEach(orgUsersStore.users) { member in
                    memberCard(member)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .screenBackground()
        .navigationTitle("Команда")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Исключить «\(memberToRemove?.displayName ?? "")» из организации?",
            isPresented: Binding(
                get: { memberToRemove != nil },
                set: { if !$0 { memberToRemove = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Исключить", role: .destructive) {
                if let member = memberToRemove { remove(member) }
            }
            Button("Отмена", role: .cancel) {}
        }
    }

    // MARK: — карточка участника

    private func memberCard(_ member: OrgUser) -> some View {
        let isSelf = member.id == appState.user?.uid
        let editable = canEdit(member) && !isSelf

        return HStack(spacing: 12) {
            AvatarView(name: member.displayName, size: 44)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(member.displayName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if isSelf {
                        Text("вы")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.surfaceSecondary, in: Capsule())
                    }
                }
                HStack(spacing: 6) {
                    roleChip(member.orgRole)
                    if member.telegramChatId != nil {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(Color(hex: 0x0EA5E9))
                    }
                }
            }

            Spacer(minLength: 6)

            if busyUserId == member.id {
                ProgressView().tint(Theme.primary)
            } else if editable {
                Menu {
                    Section("Роль") {
                        ForEach(availableRoles(for: member), id: \.role) { option in
                            Button {
                                changeRole(member, to: option.role)
                            } label: {
                                if member.orgRole == option.role {
                                    Label(option.title, systemImage: "checkmark")
                                } else {
                                    Text(option.title)
                                }
                            }
                        }
                    }
                    Divider()
                    Button(role: .destructive) {
                        memberToRemove = member
                    } label: {
                        Label("Исключить из организации", systemImage: "person.fill.xmark")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
            }
        }
        .padding(13)
        .card()
    }

    private func roleChip(_ role: String) -> some View {
        let (title, color): (String, Color) = {
            switch role {
            case "owner": return ("Владелец", Theme.warning)
            case "admin": return ("Администратор", Theme.primary)
            case "moderator": return ("Модератор", Color(hex: 0x0EA5E9))
            case "reader": return ("Наблюдатель", Theme.textSecondary)
            default: return ("Исполнитель", Theme.statusDone)
            }
        }()
        return Text(title)
            .font(.caption2.weight(.bold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
    }

    // Зеркало серверных ограничений: владельца не трогаем; админ не управляет
    // админами (менять роль на «Администратор» может только владелец).
    private func canEdit(_ member: OrgUser) -> Bool {
        guard ["owner", "admin"].contains(callerRole) else { return false }
        if member.orgRole == "owner" { return false }
        if callerRole == "admin" && member.orgRole == "admin" { return false }
        return true
    }

    private func availableRoles(for member: OrgUser) -> [(role: String, title: String)] {
        assignableRoles.filter { option in
            if option.role == "admin" && callerRole != "owner" { return false }
            return true
        }
    }

    // MARK: — действия

    private func changeRole(_ member: OrgUser, to role: String) {
        guard member.orgRole != role else { return }
        busyUserId = member.id
        errorMessage = nil
        Task {
            defer { busyUserId = nil }
            do {
                try await ApiClient.updateMemberRole(userId: member.id, role: role)
                // Список обновится живым слушателем OrgUsersStore
            } catch {
                errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось изменить роль"
            }
        }
    }

    private func remove(_ member: OrgUser) {
        busyUserId = member.id
        errorMessage = nil
        Task {
            defer { busyUserId = nil }
            do {
                try await ApiClient.removeMember(userId: member.id)
            } catch {
                errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось исключить участника"
            }
        }
    }
}
