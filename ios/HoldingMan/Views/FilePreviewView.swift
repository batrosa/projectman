import SwiftUI
import QuickLook

private enum FilePreviewState {
    case loading
    case ready(URL)
    case failed(String)
}

struct FilePreviewView: View {
    let file: FileRef

    @Environment(\.dismiss) private var dismiss
    @State private var state: FilePreviewState = .loading

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading:
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("Загружаем файл…")
                            .font(.subheadline)
                            .foregroundStyle(Theme.textSecondary)
                    }
                case .ready(let localURL):
                    if localURL.pathExtension.lowercased() == "md" {
                        MarkdownFilePreview(url: localURL)
                    } else {
                        QuickLookPreview(url: localURL)
                            .ignoresSafeArea(edges: .bottom)
                    }
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Не удалось открыть файл", systemImage: "doc.badge.exclamationmark")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Попробовать ещё раз") {
                            state = .loading
                            Task { await load() }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Закрыть") { dismiss() }
                }
            }
        }
        .task { await load() }
        .onDisappear { removeDownloadedFile() }
    }

    @MainActor
    private func load() async {
        do {
            let url = try await RemoteFilePreviewLoader.download(file: file)
            guard !Task.isCancelled else { return }
            state = .ready(url)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func removeDownloadedFile() {
        guard case .ready(let url) = state else { return }
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
}

private enum RemoteFilePreviewLoader {
    static let maxBytes = 25 * 1024 * 1024

    static func download(file: FileRef) async throws -> URL {
        guard let remoteURL = URL(string: file.url), remoteURL.scheme?.lowercased() == "https" else {
            throw ApiError.server("Некорректная или небезопасная ссылка на файл.")
        }

        var request = URLRequest(url: remoteURL)
        request.timeoutInterval = 60
        request.cachePolicy = .returnCacheDataElseLoad
        let (temporaryURL, response): (URL, URLResponse)
        do {
            (temporaryURL, response) = try await URLSession.shared.download(for: request)
        } catch {
            throw ApiError.network
        }

        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            throw ApiError.server("Сервер файла вернул ошибку.")
        }
        if response.expectedContentLength > Int64(maxBytes) {
            throw ApiError.server("Файл слишком большой для предпросмотра.")
        }

        let values = try temporaryURL.resourceValues(forKeys: [.fileSizeKey])
        guard (values.fileSize ?? 0) <= maxBytes else {
            throw ApiError.server("Файл слишком большой для предпросмотра.")
        }

        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("HoldingManPreview", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(safeFilename(file.name, remoteURL: remoteURL))
        try FileManager.default.moveItem(at: temporaryURL, to: destination)
        return destination
    }

    private static func safeFilename(_ raw: String, remoteURL: URL) -> String {
        let fallback = remoteURL.lastPathComponent.isEmpty ? "Файл" : remoteURL.lastPathComponent
        let source = raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? fallback : raw
        let lastComponent = URL(fileURLWithPath: source).lastPathComponent
        let cleaned = lastComponent
            .unicodeScalars
            .filter { !CharacterSet.controlCharacters.contains($0) && $0.value != 47 && $0.value != 92 }
            .map(String.init)
            .joined()
        return cleaned.isEmpty ? "Файл" : String(cleaned.prefix(180))
    }
}

private struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}

private struct MarkdownFilePreview: View {
    let url: URL
    @State private var text = AttributedString("Загрузка…")

    var body: some View {
        ScrollView {
            Text(text)
                .font(.body)
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
        }
        .task(id: url) {
            guard let source = try? String(contentsOf: url, encoding: .utf8) else {
                text = AttributedString("Не удалось прочитать Markdown-файл.")
                return
            }
            text = (try? AttributedString(markdown: source)) ?? AttributedString(source)
        }
    }
}
