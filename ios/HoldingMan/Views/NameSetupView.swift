import SwiftUI

struct NameSetupView: View {
    @EnvironmentObject private var appState: AppState
    @State private var firstName = ""
    @State private var lastName = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    private enum Field { case firstName, lastName }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(Theme.primaryGradient)
                                .frame(width: 76, height: 76)
                            Image(systemName: "person.text.rectangle.fill")
                                .font(.system(size: 31, weight: .semibold))
                                .foregroundStyle(.white)
                        }

                        Text("Как вас зовут?")
                            .font(.title2.bold())
                            .foregroundStyle(Theme.textPrimary)
                        Text("Укажите имя и фамилию — так вас будут видеть коллеги в задачах.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 56)

                    VStack(spacing: 12) {
                        nameField("Имя", text: $firstName, field: .firstName)
                            .textContentType(.givenName)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .lastName }

                        nameField("Фамилия", text: $lastName, field: .lastName)
                            .textContentType(.familyName)
                            .submitLabel(.done)
                            .onSubmit { save() }

                        Button(action: save) {
                            if isSaving {
                                ProgressView().tint(.white)
                            } else {
                                Text("Продолжить")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(!isValid || isSaving)
                        .opacity(isValid ? 1 : 0.55)

                        if let errorMessage {
                            Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                                .font(.footnote)
                                .foregroundStyle(Theme.danger)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(18)
                    .card()

                    Button("Выйти из аккаунта") { appState.signOut() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.danger)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 30)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear {
            firstName = appState.user?.firstName ?? ""
            lastName = appState.user?.lastName ?? ""
            focusedField = firstName.count >= 2 ? .lastName : .firstName
        }
    }

    private var isValid: Bool {
        firstName.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 &&
        lastName.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
    }

    private func nameField(_ title: String, text: Binding<String>, field: Field) -> some View {
        TextField(title, text: text)
            .foregroundStyle(Theme.textPrimary)
            .textInputAutocapitalization(.words)
            .autocorrectionDisabled()
            .focused($focusedField, equals: field)
            .padding(.horizontal, 14)
            .frame(height: 52)
            .background(Theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(focusedField == field ? Theme.primary.opacity(0.55) : Theme.hairline, lineWidth: 1)
            )
    }

    private func save() {
        guard isValid, !isSaving else { return }
        focusedField = nil
        isSaving = true
        errorMessage = nil
        let first = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let last = lastName.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                try await ApiClient.completeAuthProfile(firstName: first, lastName: last)
            } catch {
                errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось сохранить имя и фамилию."
            }
            isSaving = false
        }
    }
}
