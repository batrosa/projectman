import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// «Завершить задачу»: обязательный комментарий-отчёт + 1-3 файла
// подтверждения (фото из галереи или документ) — те же требования, что в web
// (правила Firestore требуют непустой completionProofs).
struct CompletionSheet: View {
    let task: TaskItem
    let onSubmit: (String, [FileRef]) async throws -> Void
    var onFinished: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var comment = ""
    @State private var proofs: [FileRef] = []
    @State private var isUploading = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @FocusState private var commentFocused: Bool

    private let maxProofs = 3

    var body: some View {
        NavigationStack {
            Form {
                Section("Отчёт о выполнении") {
                    TextField("Что сделано…", text: $comment, axis: .vertical)
                        .lineLimit(3...8)
                        .foregroundStyle(Theme.textPrimary)
                        .listRowBackground(Theme.surface)
                        .focused($commentFocused)
                }

                Section("Файлы подтверждения (1–\(maxProofs))") {
                    ForEach(proofs) { proof in
                        HStack {
                            Image(systemName: "doc.fill")
                                .foregroundStyle(Theme.primary)
                            Text(proof.name)
                                .font(.footnote)
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                            Spacer()
                            Button {
                                guard !isUploading, !isSubmitting else { return }
                                proofs.removeAll { $0.id == proof.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(Theme.textSecondary)
                            }
                            .disabled(isUploading || isSubmitting)
                        }
                        .listRowBackground(Theme.surface)
                    }

                    if isUploading {
                        HStack {
                            ProgressView().tint(Theme.primary)
                            Text("Загрузка файла…")
                                .font(.footnote)
                                .foregroundStyle(Theme.textSecondary)
                        }
                        .listRowBackground(Theme.surface)
                    }

                    if proofs.count < maxProofs && !isUploading {
                        PhotosPicker(selection: $photoItem, matching: .images) {
                            Label("Фото из галереи", systemImage: "photo")
                        }
                        .listRowBackground(Theme.surface)

                        Button {
                            guard !isUploading, !isSubmitting else { return }
                            showFileImporter = true
                        } label: {
                            Label("Файл (PDF, документ…)", systemImage: "paperclip")
                        }
                        .listRowBackground(Theme.surface)
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .listRowBackground(Color.clear)
                }
            }
            .screenBackground()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Завершение задачи")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                        .disabled(isUploading || isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSubmitting {
                        ProgressView().tint(Theme.primary)
                    } else {
                        Button("На проверку") { submit() }
                            .disabled(comment.trimmingCharacters(in: .whitespaces).isEmpty
                                      || proofs.isEmpty || isUploading)
                    }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Готово") { commentFocused = false }
                        .font(.subheadline.weight(.semibold))
                }
            }
            .onChange(of: photoItem) { uploadPickedPhoto() }
            .fileImporter(
                isPresented: $showFileImporter,
                allowedContentTypes: [.pdf, .image, .data],
                allowsMultipleSelection: false
            ) { result in
                if case .success(let urls) = result, let url = urls.first {
                    uploadFile(at: url)
                }
            }
            .interactiveDismissDisabled(isUploading || isSubmitting)
        }
    }

    private func uploadPickedPhoto() {
        guard !isUploading, !isSubmitting, proofs.count < maxProofs,
              let item = photoItem else { return }
        photoItem = nil
        isUploading = true
        errorMessage = nil
        Task {
            defer { isUploading = false }
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    errorMessage = "Не удалось прочитать фото"
                    return
                }
                let name = "photo-\(Int(Date().timeIntervalSince1970)).jpg"
                let ref = try await CloudinaryService.upload(data: data, filename: name)
                proofs.append(ref)
            } catch {
                errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось загрузить фото"
            }
        }
    }

    private func uploadFile(at url: URL) {
        guard !isUploading, !isSubmitting, proofs.count < maxProofs else { return }
        isUploading = true
        errorMessage = nil
        Task {
            defer { isUploading = false }
            do {
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                let ref = try await CloudinaryService.upload(data: data, filename: url.lastPathComponent)
                proofs.append(ref)
            } catch {
                errorMessage = (error as? ApiError)?.errorDescription ?? "Не удалось загрузить файл"
            }
        }
    }

    private func submit() {
        let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isSubmitting, !isUploading, !trimmed.isEmpty, !proofs.isEmpty else { return }
        commentFocused = false
        isSubmitting = true
        errorMessage = nil
        Task {
            defer { isSubmitting = false }
            do {
                try await onSubmit(trimmed, proofs)
                dismiss()
                onFinished()
            } catch {
                errorMessage = "Не удалось отправить на проверку: \(error.localizedDescription)"
            }
        }
    }
}
