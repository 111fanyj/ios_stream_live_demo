import Foundation

enum StreamDefaults {
    static let appGroupIdentifier = "group.com.example.IOSStreamViewer.shared"
    static let serverURLKey = "stream.serverURL"
    static let roomIDKey = "stream.roomID"
    static let tokenKey = "stream.token"
}

struct StreamConfiguration {
    let serverURL: String
    let roomID: String
    let token: String
}