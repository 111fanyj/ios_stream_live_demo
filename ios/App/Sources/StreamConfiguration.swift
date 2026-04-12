import Foundation

enum StreamDefaults {
    static let appGroupIdentifier = "group.com.example.IOSStreamViewer.shared"
    static let serverURLKey = "stream.serverURL"
    static let roomIDKey = "stream.roomID"
    static let tokenKey = "stream.token"
    static let defaultServerURL = "http://192.168.1.10:3000"
    static let defaultRoomID = "demo-room"
    static let diagnosticsStatusKey = "stream.diagnostics.status"
    static let diagnosticsLastErrorKey = "stream.diagnostics.lastError"
    static let diagnosticsUpdatedAtKey = "stream.diagnostics.updatedAt"
    static let diagnosticsSentFrameCountKey = "stream.diagnostics.sentFrameCount"
    static let diagnosticsLastFrameAtKey = "stream.diagnostics.lastFrameAt"
}

struct StreamConfiguration: Codable {
    var serverURL: String
    var roomID: String
    var token: String

    static let fallback = StreamConfiguration(
        serverURL: StreamDefaults.defaultServerURL,
        roomID: StreamDefaults.defaultRoomID,
        token: ""
    )

    static func load() -> StreamConfiguration {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return fallback
        }

        return StreamConfiguration(
            serverURL: defaults.string(forKey: StreamDefaults.serverURLKey) ?? StreamDefaults.defaultServerURL,
            roomID: defaults.string(forKey: StreamDefaults.roomIDKey) ?? StreamDefaults.defaultRoomID,
            token: defaults.string(forKey: StreamDefaults.tokenKey) ?? ""
        )
    }

    func save() {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        defaults.set(serverURL, forKey: StreamDefaults.serverURLKey)
        defaults.set(roomID, forKey: StreamDefaults.roomIDKey)
        defaults.set(token, forKey: StreamDefaults.tokenKey)
    }
}

struct StreamDiagnostics {
    var status: String
    var lastError: String
    var updatedAt: String
    var sentFrameCount: Int
    var lastFrameAt: String

    static let empty = StreamDiagnostics(
        status: "未开始",
        lastError: "",
        updatedAt: "",
        sentFrameCount: 0,
        lastFrameAt: ""
    )

    static func load() -> StreamDiagnostics {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return empty
        }

        return StreamDiagnostics(
            status: defaults.string(forKey: StreamDefaults.diagnosticsStatusKey) ?? empty.status,
            lastError: defaults.string(forKey: StreamDefaults.diagnosticsLastErrorKey) ?? empty.lastError,
            updatedAt: defaults.string(forKey: StreamDefaults.diagnosticsUpdatedAtKey) ?? empty.updatedAt,
            sentFrameCount: defaults.integer(forKey: StreamDefaults.diagnosticsSentFrameCountKey),
            lastFrameAt: defaults.string(forKey: StreamDefaults.diagnosticsLastFrameAtKey) ?? empty.lastFrameAt
        )
    }
}