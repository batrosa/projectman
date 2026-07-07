import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @AppStorage("appearance") private var appearanceRaw = Appearance.system.rawValue
    @State private var confirmLogout = false

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

                    Link(destination: URL(string: "https://projectmanteko.vercel.app")!) {
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
                Text("Организация")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                Text(appState.organizationName.isEmpty ? "—" : appState.organizationName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
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
