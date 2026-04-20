import Foundation
import Observation
import ZIPFoundation

struct AutomationPackageMetadata: Decodable {
    struct Revision: Decodable {
        let revision: Int
        let name: String
        let createdAt: String
        let zipSize: Int
        let imageCount: Int
        let stepCount: Int
        let downloadUrl: String
    }

    let packageId: String
    let name: String
    let latestRevision: Int
    let activeRevision: Int?
    let revisions: [Revision]
}

@MainActor
@Observable
final class AutomationPackageManager {
    private(set) var status: String = "未下载"
    private(set) var activeSummary: String = AutomationPackageManager.loadActiveSummary()
    private(set) var isDownloading = false

    func refreshActiveSummary() {
        activeSummary = Self.loadActiveSummary()
    }

    func downloadLatest(serverURL: String, packageId: String) async {
        let trimmedPackageId = packageId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPackageId.isEmpty else {
            status = "Package ID 为空"
            return
        }

        guard let metadataURL = makeAutomationMetadataURL(serverURL: serverURL, packageId: trimmedPackageId) else {
            status = "服务端地址无效"
            return
        }

        isDownloading = true
        defer { isDownloading = false }

        do {
            status = "正在读取方案元数据..."
            let metadata = try await fetchMetadata(from: metadataURL)
            guard metadata.latestRevision > 0,
                  let revision = metadata.revisions.first(where: { $0.revision == metadata.latestRevision })
            else {
                status = "服务端没有可下载的 revision"
                return
            }

            let packageDirectory = try packageDirectoryURL(packageId: metadata.packageId, revision: revision.revision)
            let automationFile = packageDirectory.appendingPathComponent("automation.json")
            if FileManager.default.fileExists(atPath: automationFile.path),
               isActivePackage(packageId: metadata.packageId, revision: revision.revision) {
                status = "本地已有 \(metadata.packageId) r\(revision.revision)，已复用"
                refreshActiveSummary()
                return
            }

            guard let downloadURL = makeDownloadURL(serverURL: serverURL, downloadPath: revision.downloadUrl) else {
                status = "下载地址无效"
                return
            }

            status = "正在下载 \(metadata.packageId) r\(revision.revision)..."
            let zipData = try await fetchData(from: downloadURL)
            try install(zipData: zipData, packageId: metadata.packageId, revision: revision.revision)
            status = "已安装 \(metadata.packageId) r\(revision.revision)"
            refreshActiveSummary()
        } catch {
            status = "下载失败: \(error.localizedDescription)"
        }
    }

    private func fetchMetadata(from url: URL) async throws -> AutomationPackageMetadata {
        let data = try await fetchData(from: url)
        return try JSONDecoder().decode(AutomationPackageMetadata.self, from: data)
    }

    private func fetchData(from url: URL) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode)
        else {
            throw URLError(.badServerResponse)
        }

        return data
    }

    private func install(zipData: Data, packageId: String, revision: Int) throws {
        let fileManager = FileManager.default
        let directory = try packageDirectoryURL(packageId: packageId, revision: revision)
        let zipURL = directory.appendingPathComponent("package.zip")
        let extractedURL = directory.appendingPathComponent("extracted")

        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try zipData.write(to: zipURL, options: .atomic)

        if fileManager.fileExists(atPath: extractedURL.path) {
            try fileManager.removeItem(at: extractedURL)
        }
        try fileManager.createDirectory(at: extractedURL, withIntermediateDirectories: true)
        try fileManager.unzipItem(at: zipURL, to: extractedURL)

        let automationFile = extractedURL.appendingPathComponent("automation.json")
        guard fileManager.fileExists(atPath: automationFile.path) else {
            throw NSError(domain: "IOSStreamViewer", code: -20, userInfo: [NSLocalizedDescriptionKey: "ZIP 中缺少 automation.json"])
        }

        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            throw NSError(domain: "IOSStreamViewer", code: -21, userInfo: [NSLocalizedDescriptionKey: "无法写入 App Group"])
        }

        defaults.set(packageId, forKey: StreamDefaults.automationPackageIDKey)
        defaults.set(packageId, forKey: StreamDefaults.automationActivePackageIDKey)
        defaults.set(revision, forKey: StreamDefaults.automationActiveRevisionKey)
        defaults.set(extractedURL.path, forKey: StreamDefaults.automationActivePackagePathKey)
        defaults.set("已安装 \(packageId) r\(revision)", forKey: StreamDefaults.automationLastStatusKey)
    }

    private func isActivePackage(packageId: String, revision: Int) -> Bool {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return false
        }

        return defaults.string(forKey: StreamDefaults.automationActivePackageIDKey) == packageId &&
            defaults.integer(forKey: StreamDefaults.automationActiveRevisionKey) == revision
    }

    private func packageDirectoryURL(packageId: String, revision: Int) throws -> URL {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: StreamDefaults.appGroupIdentifier) else {
            throw NSError(domain: "IOSStreamViewer", code: -22, userInfo: [NSLocalizedDescriptionKey: "无法访问 App Group 容器"])
        }

        return container
            .appendingPathComponent("AutomationPackages", isDirectory: true)
            .appendingPathComponent(packageId, isDirectory: true)
            .appendingPathComponent(String(revision), isDirectory: true)
    }

    private func makeAutomationMetadataURL(serverURL: String, packageId: String) -> URL? {
        guard var components = URLComponents(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }

        if components.scheme == "ws" {
            components.scheme = "http"
        }

        if components.scheme == "wss" {
            components.scheme = "https"
        }

        components.queryItems = nil
        components.path = "/api/automation/packages/\(packageId)"
        return components.url
    }

    private func makeDownloadURL(serverURL: String, downloadPath: String) -> URL? {
        guard let baseURL = URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }

        if let absoluteURL = URL(string: downloadPath), absoluteURL.scheme != nil {
            return absoluteURL
        }

        var components = URLComponents()
        components.scheme = baseURL.scheme == "wss" ? "https" : (baseURL.scheme == "ws" ? "http" : baseURL.scheme)
        components.host = baseURL.host
        components.port = baseURL.port
        components.path = downloadPath
        return components.url
    }

    private static func loadActiveSummary() -> String {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return "无法访问 App Group"
        }

        let packageId = defaults.string(forKey: StreamDefaults.automationActivePackageIDKey) ?? ""
        let revision = defaults.integer(forKey: StreamDefaults.automationActiveRevisionKey)
        guard !packageId.isEmpty, revision > 0 else {
            return "暂无 active package"
        }

        return "\(packageId) r\(revision)"
    }
}
