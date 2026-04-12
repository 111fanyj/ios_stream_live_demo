import Foundation

enum StreamDefaults {
    static let appGroupIdentifier = "group.com.example.IOSStreamViewer.shared"
    static let serverURLKey = "stream.serverURL"
    static let roomIDKey = "stream.roomID"
    static let tokenKey = "stream.token"
    static let defaultServerURL = "ws://192.168.1.10:3000"
    static let defaultRoomID = "demo-room"
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