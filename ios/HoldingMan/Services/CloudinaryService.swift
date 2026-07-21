import Foundation
import UniformTypeIdentifiers

// Файл хранит либо legacy URL, либо защищённую ссылку на authenticated asset.
// Подпись загрузки и временная ссылка скачивания выдаются только сервером.
struct FileRef: Identifiable, Equatable {
    var id = UUID()
    var name: String
    var url: String
    var type: String // pdf | word | excel | image | archive | other — как web getFileType()
    var size: Int
    var storageProvider: String? = nil
    var assetId: String? = nil
    var publicId: String? = nil
    var resourceType: String? = nil
    var deliveryType: String? = nil
    var format: String? = nil
    var projectId: String? = nil
    var uploadIntentId: String? = nil
    var uploadedAt: String? = nil

    var dict: [String: Any] {
        var value: [String: Any] = ["name": name, "type": type, "size": size]
        if !url.isEmpty { value["url"] = url }
        if let storageProvider { value["storageProvider"] = storageProvider }
        if let assetId { value["assetId"] = assetId }
        if let publicId { value["publicId"] = publicId }
        if let resourceType { value["resourceType"] = resourceType }
        if let deliveryType { value["deliveryType"] = deliveryType }
        if let format { value["format"] = format }
        if let projectId { value["projectId"] = projectId }
        if let uploadIntentId { value["uploadIntentId"] = uploadIntentId }
        if let uploadedAt { value["uploadedAt"] = uploadedAt }
        return value
    }

    static func from(_ dict: [String: Any]) -> FileRef? {
        let url = dict["url"] as? String ?? ""
        let publicId = dict["publicId"] as? String
        guard !url.isEmpty || !(publicId ?? "").isEmpty else { return nil }
        return FileRef(
            name: dict["name"] as? String ?? "Файл",
            url: url,
            type: dict["type"] as? String ?? "other",
            size: dict["size"] as? Int ?? 0,
            storageProvider: dict["storageProvider"] as? String,
            assetId: dict["assetId"] as? String,
            publicId: publicId,
            resourceType: dict["resourceType"] as? String,
            deliveryType: dict["deliveryType"] as? String,
            format: dict["format"] as? String,
            projectId: dict["projectId"] as? String,
            uploadIntentId: dict["uploadIntentId"] as? String,
            uploadedAt: dict["uploadedAt"] as? String
        )
    }
}

enum CloudinaryService {
    static let maxFileSize = 10 * 1024 * 1024 // 10 МБ — как в web

    // Ровно web getFileType()
    static func fileType(for filename: String) -> String {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch ext {
        case "pdf": return "pdf"
        case "doc", "docx": return "word"
        case "xls", "xlsx": return "excel"
        case "jpg", "jpeg", "png", "gif", "webp": return "image"
        case "zip", "rar", "7z": return "archive"
        default: return "other"
        }
    }

    static func upload(data: Data, filename: String, projectId: String, purpose: String) async throws -> FileRef {
        guard data.count <= maxFileSize else {
            throw ApiError.server("Файл слишком большой. Максимум 10 МБ.")
        }

        let signed = try await ApiClient.post("api/files", body: [
            "action": "signUpload",
            "purpose": purpose,
            "projectId": projectId,
            "filename": filename,
            "mimeType": "application/octet-stream",
            "sizeBytes": data.count,
            "fileType": fileType(for: filename),
        ])
        guard let uploadURLString = signed["uploadUrl"] as? String,
              let uploadURL = URL(string: uploadURLString),
              let apiKey = signed["apiKey"] as? String,
              let intentId = signed["intentId"] as? String,
              let fields = signed["fields"] as? [String: Any] else {
            throw ApiError.server("Сервер не выдал подпись загрузки")
        }

        let boundary = "projectman-\(UUID().uuidString)"
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func appendField(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        for (key, value) in fields {
            appendField(key, String(describing: value))
        }
        appendField("api_key", apiKey)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        let safeFilename = filename
            .replacingOccurrences(of: "\r", with: "_")
            .replacingOccurrences(of: "\n", with: "_")
            .replacingOccurrences(of: "\"", with: "_")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeFilename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        let (responseData, response): (Data, URLResponse)
        do {
            (responseData, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw ApiError.network
        }

        let json = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status >= 200, status < 300 else {
            let message = (json["error"] as? [String: Any])?["message"] as? String
            throw ApiError.server(message ?? "Не удалось загрузить файл")
        }
        let finalized = try await ApiClient.post("api/files", body: [
            "action": "finalizeUpload",
            "intentId": intentId,
        ])
        guard let file = finalized["file"] as? [String: Any], let ref = FileRef.from(file) else {
            throw ApiError.server("Сервер не подтвердил загруженный файл")
        }
        return ref
    }
}
