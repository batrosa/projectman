import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var confirmLogout = false

    var body: some View {
        NavigationStack {
            List {
                if let user = appState.user {
                    Section {
                        HStack(spacing: 14) {
                            ZStack {
                                Circle().fill(Theme.primary.opacity(0.25))
                                Text(String(user.displayName.prefix(1)).uppercased())
                                    .font(.title2.bold())
                                    .foregroundStyle(Theme.primary)
                            }
                            .frame(width: 54, height: 54)

                            VStack(alignment: .leading, spacing: 3) {
                                Text(user.displayName)
                                    .font(.headline)
                                    .foregroundStyle(Theme.textPrimary)
                                if !user.email.isEmpty {
                                    Text(user.email)
                                        .font(.caption)
                                        .foregroundStyle(Theme.textSecondary)
                                }
                                Text(user.roleRu)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Theme.primary)
                            }
                        }
                        .padding(.vertical, 4)
                        .listRowBackground(Theme.surface)
                    }

                    Section("Организация") {
                        HStack {
                            Text("Текущая")
                                .foregroundStyle(Theme.textSecondary)
                            Spacer()
                            Text(appState.organizationName.isEmpty ? "—" : appState.organizationName)
                                .foregroundStyle(Theme.textPrimary)
                        }
                        .listRowBackground(Theme.surface)
                    }
                }

                Section("О приложении") {
                    HStack {
                        Text("Push-уведомления")
                            .foregroundStyle(Theme.textSecondary)
                        Spacer()
                        Text("после подключения APNs")
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary.opacity(0.7))
                    }
                    .listRowBackground(Theme.surface)

                    Link(destination: URL(string: "https://projectmanteko.vercel.app")!) {
                        HStack {
                            Text("Открыть веб-версию")
                                .foregroundStyle(Theme.textPrimary)
                            Spacer()
                            Image(systemName: "arrow.up.right.square")
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .listRowBackground(Theme.surface)
                }

                Section {
                    Button(role: .destructive) {
                        confirmLogout = true
                    } label: {
                        Label("Выйти", systemImage: "rectangle.portrait.and.arrow.right")
                            .frame(maxWidth: .infinity)
                    }
                    .listRowBackground(Theme.danger.opacity(0.12))
                }
            }
            .screenBackground()
            .navigationTitle("Профиль")
            .confirmationDialog("Выйти из аккаунта?", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("Выйти", role: .destructive) { appState.signOut() }
                Button("Отмена", role: .cancel) {}
            }
        }
    }
}
