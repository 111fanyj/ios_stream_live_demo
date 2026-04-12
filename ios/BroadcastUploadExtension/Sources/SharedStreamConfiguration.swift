import Foundation

enum StreamDefaults {
    static let appGroupIdentifier = "group.com.example.IOSStreamViewer.shared"
    static let serverURLKey = "stream.serverURL"
    static let roomIDKey = "stream.roomID"
    static let tokenKey = "stream.token"
    static let diagnosticsStatusKey = "stream.diagnostics.status"
    static let diagnosticsLastErrorKey = "stream.diagnostics.lastError"
    static let diagnosticsUpdatedAtKey = "stream.diagnostics.updatedAt"
    static let diagnosticsSentFrameCountKey = "stream.diagnostics.sentFrameCount"
    static let diagnosticsLastFrameAtKey = "stream.diagnostics.lastFrameAt"
}

struct StreamConfiguration {
    let serverURL: String
    let roomID: String
    let token: String
}