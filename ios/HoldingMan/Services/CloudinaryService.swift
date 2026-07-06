import Foundation
import UniformTypeIdentifiers

// Загрузка файлов в Cloudinary — тот же unsigned preset, что и web-клиент
// (script.js cloudinaryConfig). Возвращает {name,url,type,size} — форма
// элементов attachments / completionProofs в задачах.
struct FileRef: Identifiable, Equatable {
    var id = UUID()
    var name: String
    var url: String
    var type: String // pdf | word | excel | image | archive | other — как web getFileType()
    var size: Int

    var dict: [String: Any] { ["name": name, "url": url, "type": type, "size": size] }

    static func from(_ dict: [String: Any]) -> FileRef? {
        guard let url = dict["url"] as? String, !url.isEmpty else { return nil }
        return FileRef(
            name: dict["name"] as? String ?? "Файл",
            url: url,
            type: dict["type"] as? String ?? "other",
            size: dict["size"] as? Int ?? 0
        )
    }
}

enum CloudinaryService {
    static let cloudName = "dwoa1lqz1"
    static let uploadPreset = "projectman"
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

    static func upload(data: Data, filename: String) async throws -> FileRef {
        guard data.count <= maxFileSize else {
            throw ApiError.server("Файл слишком большой. Максимум 10 МБ.")
        }

        let boundary = "holdingman-\(UUID().uuidString)"
        var request = URLRequest(url: URL(string: "https://api.cloudinary.com/v1_1/\(cloudName)/auto/upload")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func appendField(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        appendField("upload_preset", uploadPreset)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
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
        guard status >= 200, status < 300, let secureUrl = json["secure_url"] as? String else {
            let message = (json["error"] as? [String: Any])?["message"] as? String
            throw ApiError.server(message ?? "Не удалось загрузить файл")
        }
        return FileRef(name: filename, url: secureUrl, type: fileType(for: filename), size: data.count)
    }
}
