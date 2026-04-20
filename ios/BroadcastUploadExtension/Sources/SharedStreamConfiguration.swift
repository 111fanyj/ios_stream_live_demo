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
    static let automationPackageIDKey = "automation.packageID"
    static let automationActivePackageIDKey = "automation.activePackageID"
    static let automationActiveRevisionKey = "automation.activeRevision"
    static let automationActivePackagePathKey = "automation.activePackagePath"
    static let automationRunRequestedKey = "automation.runRequested"
    static let automationRunRequestIDKey = "automation.runRequestID"
    static let automationLastStatusKey = "automation.lastStatus"
}

struct StreamConfiguration {
    let serverURL: String
    let roomID: String
    let token: String
}
