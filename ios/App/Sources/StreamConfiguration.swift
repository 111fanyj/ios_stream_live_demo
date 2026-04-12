import Foundation

enum StreamDefaults {
    static let appGroupIdentifier = "group.com.example.IOSStreamViewer.shared"
    static let broadcastExtensionSuffix = ".BroadcastUploadExtension"
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
    static let diagnosticsRecentEventsKey = "stream.diagnostics.recentEvents"
    static let diagnosticsBroadcastStartedAtKey = "stream.diagnostics.broadcastStartedAt"
    static let diagnosticsExtensionHeartbeatAtKey = "stream.diagnostics.extensionHeartbeatAt"
    static let diagnosticsLastSampleAtKey = "stream.diagnostics.lastSampleAt"
    static let diagnosticsLastSampleTypeKey = "stream.diagnostics.lastSampleType"
    static let diagnosticsVideoSampleCountKey = "stream.diagnostics.videoSampleCount"
    static let diagnosticsAppAudioSampleCountKey = "stream.diagnostics.appAudioSampleCount"
    static let diagnosticsMicAudioSampleCountKey = "stream.diagnostics.micAudioSampleCount"
    static let diagnosticsEncodedFrameCountKey = "stream.diagnostics.encodedFrameCount"
    static let diagnosticsLastEncodedFrameAtKey = "stream.diagnostics.lastEncodedFrameAt"

    static var broadcastExtensionBundleIdentifier: String? {
        guard let appBundleIdentifier = Bundle.main.bundleIdentifier else {
            return nil
        }

        return appBundleIdentifier + broadcastExtensionSuffix
    }
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
    var recentEvents: [String]
    var broadcastStartedAt: String
    var extensionHeartbeatAt: String
    var lastSampleAt: String
    var lastSampleType: String
    var videoSampleCount: Int
    var appAudioSampleCount: Int
    var micAudioSampleCount: Int
    var encodedFrameCount: Int
    var lastEncodedFrameAt: String

    static let empty = StreamDiagnostics(
        status: "未开始",
        lastError: "",
        updatedAt: "",
        sentFrameCount: 0,
        lastFrameAt: "",
        recentEvents: [],
        broadcastStartedAt: "",
        extensionHeartbeatAt: "",
        lastSampleAt: "",
        lastSampleType: "",
        videoSampleCount: 0,
        appAudioSampleCount: 0,
        micAudioSampleCount: 0,
        encodedFrameCount: 0,
        lastEncodedFrameAt: ""
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
            lastFrameAt: defaults.string(forKey: StreamDefaults.diagnosticsLastFrameAtKey) ?? empty.lastFrameAt,
            recentEvents: defaults.stringArray(forKey: StreamDefaults.diagnosticsRecentEventsKey) ?? empty.recentEvents,
            broadcastStartedAt: defaults.string(forKey: StreamDefaults.diagnosticsBroadcastStartedAtKey) ?? empty.broadcastStartedAt,
            extensionHeartbeatAt: defaults.string(forKey: StreamDefaults.diagnosticsExtensionHeartbeatAtKey) ?? empty.extensionHeartbeatAt,
            lastSampleAt: defaults.string(forKey: StreamDefaults.diagnosticsLastSampleAtKey) ?? empty.lastSampleAt,
            lastSampleType: defaults.string(forKey: StreamDefaults.diagnosticsLastSampleTypeKey) ?? empty.lastSampleType,
            videoSampleCount: defaults.integer(forKey: StreamDefaults.diagnosticsVideoSampleCountKey),
            appAudioSampleCount: defaults.integer(forKey: StreamDefaults.diagnosticsAppAudioSampleCountKey),
            micAudioSampleCount: defaults.integer(forKey: StreamDefaults.diagnosticsMicAudioSampleCountKey),
            encodedFrameCount: defaults.integer(forKey: StreamDefaults.diagnosticsEncodedFrameCountKey),
            lastEncodedFrameAt: defaults.string(forKey: StreamDefaults.diagnosticsLastEncodedFrameAtKey) ?? empty.lastEncodedFrameAt
        )
    }
}