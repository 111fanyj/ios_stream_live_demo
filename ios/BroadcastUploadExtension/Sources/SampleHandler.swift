import CoreImage
import CoreMedia
import Foundation
import OSLog
import ReplayKit
import WebRTC

final class SampleHandler: RPBroadcastSampleHandler, URLSessionWebSocketDelegate {
    private final class ViewerPeerState {
        let viewerID: String
        let peerConnection: RTCPeerConnection
        let videoTrack: RTCVideoTrack
        let videoSender: RTCRtpSender
        var hasRemoteDescription = false
        var pendingCandidates: [RTCIceCandidate] = []

        init(
            viewerID: String,
            peerConnection: RTCPeerConnection,
            videoTrack: RTCVideoTrack,
            videoSender: RTCRtpSender
        ) {
            self.viewerID = viewerID
            self.peerConnection = peerConnection
            self.videoTrack = videoTrack
            self.videoSender = videoSender
        }
    }

    private struct PendingAutomationCheckCommand {
        let sessionID: String
        let requestID: String
        let step: AutomationStep
    }

    private struct PendingAutomationCheckResult {
        let sessionID: String
        let requestID: String
        let stepID: String
        let status: String
        let payload: [String: Any]?
        let error: String?
    }

    private struct CalibrationExpectedColor {
        let stepID: String
        let label: String
        let colorHex: String
        let red: Int
        let green: Int
        let blue: Int
    }

    private struct CalibrationColorBlob {
        let count: Int
        let sumX: Int
        let sumY: Int
        let minX: Int
        let minY: Int
        let maxX: Int
        let maxY: Int
    }

    private let logger = Logger(subsystem: "IOSStreamViewer", category: "BroadcastUploadExtension")
    private var webSocketSession: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?
    private var diagnosticsHeartbeatTimer: DispatchSourceTimer?
    private let pingQueue = DispatchQueue(label: "IOSStreamViewer.BroadcastUploadExtension.WebSocketPing")
    private let diagnosticsQueue = DispatchQueue(label: "IOSStreamViewer.BroadcastUploadExtension.Diagnostics")
    private var sequenceNumber = 0
    private var lastSubmittedAt = Date.distantPast
    private var lastNoViewerLogAt = Date.distantPast
    private var lastFrameProcessingFailureLogAt = Date.distantPast
    private var videoSampleCount = 0
    private var appAudioSampleCount = 0
    private var micAudioSampleCount = 0
    private var lastSampleTypeName = ""
    private var lastSampleAtText = ""
    private var lastSampleStatsWriteAt = Date.distantPast
    private var lastSubmittedStatsWriteAt = Date.distantPast
    private var adaptedVideoWidth = 0
    private var adaptedVideoHeight = 0
    private let targetFrameRate = 12
    private let targetMaxLongEdge = 960
    private let targetMaxBitrateBps = 1_200_000
    private let targetMinBitrateBps = 300_000
    private let calibrationAnalysisMaxLongEdge = 960
    private let calibrationColorMaxChannelDelta = 28
    private let calibrationColorMaxTotalDelta = 56
    private let minimumSendInterval: TimeInterval = 1.0 / 12.0
    private let isoFormatter = ISO8601DateFormatter()
    private let automationCommandQueue = DispatchQueue(label: "IOSStreamViewer.BroadcastUploadExtension.RemoteAutomation")
    private let replayFrameSnapshotContext = CIContext(options: [.cacheIntermediates: false])
    private lazy var peerConnectionFactory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }()
    private lazy var screenVideoSource: RTCVideoSource = {
        peerConnectionFactory.videoSource(forScreenCast: true)
    }()
    private lazy var screenVideoCapturer = RTCVideoCapturer(delegate: screenVideoSource)
    private var viewerPeers: [String: ViewerPeerState] = [:]
    private var peerConnectionToViewerID: [ObjectIdentifier: String] = [:]
    private var remoteAutomationInspector = RemoteAutomationInspector()
    private var activeAutomationSessionID: String?
    private var pendingAutomationCheckCommand: PendingAutomationCheckCommand?
    private var latestVideoPixelBuffer: CVPixelBuffer?
    private var lastReplayFrameSnapshotAt = Date.distantPast

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        resetDiagnosticsSession()
        startDiagnosticsHeartbeatLoop()
        updateDiagnostics(status: "广播启动中")
        logEvent("广播扩展启动")
        resetPeerConnections()

        guard let configuration = loadConfiguration() else {
            let error = NSError(domain: "IOSStreamViewer", code: -1, userInfo: [NSLocalizedDescriptionKey: "无法读取共享配置，请先在主 App 中保存服务端地址"])
            updateDiagnostics(status: "配置读取失败", error: error.localizedDescription)
            logEvent("配置读取失败: \(error.localizedDescription)")
            finishBroadcastWithError(error)
            return
        }

        logEvent("读取配置 server=\(configuration.serverURL) room=\(configuration.roomID) token=\(configuration.token.isEmpty ? "<empty>" : "<set>")")
        automationCommandQueue.sync {
            activeAutomationSessionID = nil
            pendingAutomationCheckCommand = nil
            latestVideoPixelBuffer = nil
            remoteAutomationInspector.stop()
        }
        updateAutomationStatus("远程执行模式待命")
        logEvent("已切换到远程执行模式，等待 server 下发检查命令")

        guard let url = buildPublisherURL(configuration: configuration) else {
            let error = NSError(domain: "IOSStreamViewer", code: -2, userInfo: [NSLocalizedDescriptionKey: "服务端地址无效"])
            updateDiagnostics(status: "服务端地址无效", error: error.localizedDescription)
            logEvent("服务端地址无效: \(configuration.serverURL)")
            finishBroadcastWithError(error)
            return
        }

        logger.log("Broadcast started, connecting to \(url.absoluteString, privacy: .public)")
        updateDiagnostics(status: "正在连接 \(url.host ?? configuration.serverURL)")
        logEvent("准备连接 WebSocket: \(url.absoluteString)")
        logEvent("低延迟预设: 最长边 \(targetMaxLongEdge)px / \(targetFrameRate)fps / \(targetMinBitrateBps / 1000)-\(targetMaxBitrateBps / 1000)kbps")

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        webSocketSession = session
        let task = session.webSocketTask(with: url)
        task.resume()
        webSocketTask = task
        receiveLoop(for: task)
    }

    override func broadcastPaused() {
        updateDiagnostics(status: "广播已暂停")
        logEvent("广播暂停")
    }

    override func broadcastResumed() {
        updateDiagnostics(status: "广播已恢复")
        logEvent("广播恢复")
    }

    override func broadcastFinished() {
        updateDiagnostics(status: "广播结束")
        logEvent("广播结束")
        stopWebSocketPingLoop()
        stopDiagnosticsHeartbeatLoop()
        flushSampleDiagnostics(force: true)
        flushSubmittedFrameDiagnostics(force: true)
        automationCommandQueue.sync {
            activeAutomationSessionID = nil
            pendingAutomationCheckCommand = nil
            latestVideoPixelBuffer = nil
            remoteAutomationInspector.stop()
        }
        resetPeerConnections()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        webSocketSession?.invalidateAndCancel()
        webSocketSession = nil
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        let now = Date()
        recordSampleBuffer(sampleBufferType, at: now)

        guard sampleBufferType == .video else {
            return
        }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            logFrameProcessingFailureIfNeeded(message: "视频 sampleBuffer 中没有可用的 image buffer", at: now)
            return
        }

        automationCommandQueue.sync {
            latestVideoPixelBuffer = pixelBuffer
        }
        processPendingAutomationCheckIfNeeded(pixelBuffer: pixelBuffer)
        persistLatestReplayFrameIfNeeded(pixelBuffer: pixelBuffer, at: now)

        guard !viewerPeers.isEmpty else {
            if now.timeIntervalSince(lastNoViewerLogAt) >= 5 {
                lastNoViewerLogAt = now
                logEvent("收到视频 sampleBuffer，但当前没有查看端连接")
            }
            return
        }

        guard now.timeIntervalSince(lastSubmittedAt) >= minimumSendInterval else {
            return
        }

        submitVideoFrame(from: pixelBuffer, sampleBuffer: sampleBuffer, at: now)
        lastSubmittedAt = now
        if sequenceNumber == 1 || sequenceNumber % 30 == 0 {
            logEvent("已提交第 \(sequenceNumber) 帧到 WebRTC 视频轨道，查看端 \(viewerPeers.count) 个")
        }
        updateDiagnostics(
            status: "推流中（WebRTC 视频）",
            sentFrameCount: sequenceNumber,
            lastFrameAt: isoFormatter.string(from: now)
        )
    }

    private func loadConfiguration() -> StreamConfiguration? {
        let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier)
        let serverURL = defaults?.string(forKey: StreamDefaults.serverURLKey) ?? ""
        let roomID = defaults?.string(forKey: StreamDefaults.roomIDKey) ?? ""
        let token = defaults?.string(forKey: StreamDefaults.tokenKey) ?? ""

        guard !serverURL.isEmpty, !roomID.isEmpty else {
            return nil
        }

        return StreamConfiguration(serverURL: serverURL, roomID: roomID, token: token)
    }

    private func buildPublisherURL(configuration: StreamConfiguration) -> URL? {
        guard var components = URLComponents(string: configuration.serverURL) else {
            return nil
        }

        if components.scheme == "http" {
            components.scheme = "ws"
        }

        if components.scheme == "https" {
            components.scheme = "wss"
        }

        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "type", value: "publisher"))
        queryItems.append(URLQueryItem(name: "roomId", value: configuration.roomID))
        if !configuration.token.isEmpty {
            queryItems.append(URLQueryItem(name: "token", value: configuration.token))
        }
        components.queryItems = queryItems
        return components.url
    }

    private func resetPeerConnections() {
        for viewerPeer in viewerPeers.values {
            viewerPeer.peerConnection.removeTrack(viewerPeer.videoSender)
            viewerPeer.peerConnection.close()
        }

        if !viewerPeers.isEmpty {
            logEvent("重置 \(viewerPeers.count) 个查看端连接")
        }

        viewerPeers.removeAll()
        peerConnectionToViewerID.removeAll()
    }

    private func startPeerConnection(for viewerID: String) {
        guard viewerPeers[viewerID] == nil else {
            logEvent("查看端 \(viewerID) 已存在，跳过重复建连")
            return
        }

        logEvent("开始为查看端 \(viewerID) 创建 PeerConnection")

        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherContinually
        configuration.iceServers = [
            RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])
        ]

        let connectionConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peerConnection = peerConnectionFactory.peerConnection(
            with: configuration,
            constraints: connectionConstraints,
            delegate: self
        ) else {
            logger.error("Failed to create peer connection for \(viewerID, privacy: .public)")
            logEvent("创建 PeerConnection 失败: \(viewerID)")
            return
        }

        let videoTrack = peerConnectionFactory.videoTrack(
            with: screenVideoSource,
            trackId: "screen-track-\(viewerID)"
        )
        videoTrack.isEnabled = true

        guard let videoSender = peerConnection.add(videoTrack, streamIds: ["screen-stream-\(viewerID)"]) else {
            logger.error("Failed to add video track for \(viewerID, privacy: .public)")
            logEvent("附加视频轨道失败: \(viewerID)")
            peerConnection.close()
            return
        }

        configureVideoSender(videoSender, viewerID: viewerID)

        let viewerPeer = ViewerPeerState(
            viewerID: viewerID,
            peerConnection: peerConnection,
            videoTrack: videoTrack,
            videoSender: videoSender
        )

        viewerPeers[viewerID] = viewerPeer
        peerConnectionToViewerID[ObjectIdentifier(peerConnection)] = viewerID
        logEvent("已为查看端 \(viewerID) 绑定视频轨道")

        let offerConstraints = RTCMediaConstraints(
            mandatoryConstraints: [
                "OfferToReceiveAudio": "false",
                "OfferToReceiveVideo": "false"
            ],
            optionalConstraints: nil
        )

        peerConnection.offer(for: offerConstraints) { [weak self] sessionDescription, error in
            guard let self else {
                return
            }

            if let error {
                self.logger.error("Failed to create offer for \(viewerID, privacy: .public): \(error.localizedDescription, privacy: .public)")
                self.logEvent("创建 offer 失败: \(viewerID) \(error.localizedDescription)")
                self.closePeerConnection(for: viewerID)
                return
            }

            guard let sessionDescription else {
                self.logger.error("Offer is missing for \(viewerID, privacy: .public)")
                self.logEvent("offer 为空: \(viewerID)")
                self.closePeerConnection(for: viewerID)
                return
            }

            peerConnection.setLocalDescription(sessionDescription) { [weak self] error in
                guard let self else {
                    return
                }

                if let error {
                    self.logger.error("Failed to set local description for \(viewerID, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    self.logEvent("设置本地 offer 失败: \(viewerID) \(error.localizedDescription)")
                    self.closePeerConnection(for: viewerID)
                    return
                }

                self.logEvent("本地 offer 已生成并准备发送: \(viewerID)")

                self.sendSignal(
                    to: viewerID,
                    signal: [
                        "type": "offer",
                        "sdp": sessionDescription.sdp
                    ]
                )
            }
        }
    }

    private func closePeerConnection(for viewerID: String) {
        guard let viewerPeer = viewerPeers.removeValue(forKey: viewerID) else {
            return
        }

        logEvent("关闭查看端连接: \(viewerID)")

        peerConnectionToViewerID.removeValue(forKey: ObjectIdentifier(viewerPeer.peerConnection))
        viewerPeer.peerConnection.removeTrack(viewerPeer.videoSender)
        viewerPeer.peerConnection.close()
    }

    private func submitVideoFrame(from pixelBuffer: CVPixelBuffer, sampleBuffer: CMSampleBuffer, at now: Date) {
        adaptVideoSourceIfNeeded(for: pixelBuffer)

        let presentationTimestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timeStampNs: Int64
        if presentationTimestamp.isValid {
            timeStampNs = Int64(CMTimeGetSeconds(presentationTimestamp) * 1_000_000_000)
        } else {
            timeStampNs = Int64(now.timeIntervalSince1970 * 1_000_000_000)
        }

        let rtcPixelBuffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let frame = RTCVideoFrame(buffer: rtcPixelBuffer, rotation: ._0, timeStampNs: timeStampNs)

        sequenceNumber += 1
        screenVideoCapturer.delegate?.capturer(screenVideoCapturer, didCapture: frame)
        recordSubmittedFrame(at: now)
    }

    private func adaptVideoSourceIfNeeded(for pixelBuffer: CVPixelBuffer) {
        let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
        let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
        let targetSize = preferredOutputSize(forWidth: sourceWidth, height: sourceHeight)
        let width = targetSize.width
        let height = targetSize.height

        guard adaptedVideoWidth != width || adaptedVideoHeight != height else {
            return
        }

        screenVideoSource.adaptOutputFormat(toWidth: Int32(width), height: Int32(height), fps: Int32(targetFrameRate))
        adaptedVideoWidth = width
        adaptedVideoHeight = height
        if sourceWidth != width || sourceHeight != height {
            logEvent("更新视频输出格式: \(sourceWidth)x\(sourceHeight) -> \(width)x\(height) @ \(targetFrameRate)fps")
        } else {
            logEvent("更新视频输出格式: \(width)x\(height) @ \(targetFrameRate)fps")
        }
    }

    private func preferredOutputSize(forWidth width: Int, height: Int) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else {
            return (width: width, height: height)
        }

        let longestSide = max(width, height)
        guard longestSide > targetMaxLongEdge else {
            return (width: evenDimension(width), height: evenDimension(height))
        }

        let scale = Double(targetMaxLongEdge) / Double(longestSide)
        let scaledWidth = max(2, Int((Double(width) * scale).rounded()))
        let scaledHeight = max(2, Int((Double(height) * scale).rounded()))
        return (width: evenDimension(scaledWidth), height: evenDimension(scaledHeight))
    }

    private func evenDimension(_ value: Int) -> Int {
        let clamped = max(2, value)
        return clamped.isMultiple(of: 2) ? clamped : clamped - 1
    }

    private func configureVideoSender(_ videoSender: RTCRtpSender, viewerID: String) {
        let parameters = videoSender.parameters
        parameters.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainFramerate.rawValue)

        for encoding in parameters.encodings {
            encoding.isActive = true
            encoding.maxBitrateBps = NSNumber(value: targetMaxBitrateBps)
            encoding.minBitrateBps = NSNumber(value: targetMinBitrateBps)
            encoding.maxFramerate = NSNumber(value: targetFrameRate)
            encoding.bitratePriority = 1.0
            encoding.networkPriority = .high
        }

        videoSender.parameters = parameters
        logEvent("已应用低延迟发送参数: \(viewerID)")
    }

    private func receiveSignal(from viewerID: String, signal: [String: Any]) {
        guard let type = signal["type"] as? String else {
            return
        }

        switch type {
        case "answer":
            logEvent("收到 answer: \(viewerID)")
            applyAnswer(signal, from: viewerID)
        case "candidate":
            applyRemoteCandidate(signal, from: viewerID)
        default:
            logger.warning("Unsupported signal type from viewer \(viewerID, privacy: .public): \(type, privacy: .public)")
            logEvent("收到未知 signal: \(type) from \(viewerID)")
        }
    }

    private func applyAnswer(_ signal: [String: Any], from viewerID: String) {
        guard let viewerPeer = viewerPeers[viewerID],
              let sdp = signal["sdp"] as? String
        else {
            return
        }

        let answer = RTCSessionDescription(type: .answer, sdp: sdp)
        viewerPeer.peerConnection.setRemoteDescription(answer) { [weak self] error in
            guard let self else {
                return
            }

            if let error {
                self.logger.error("Failed to set remote answer for \(viewerID, privacy: .public): \(error.localizedDescription, privacy: .public)")
                self.logEvent("设置远端 answer 失败: \(viewerID) \(error.localizedDescription)")
                self.closePeerConnection(for: viewerID)
                return
            }

            viewerPeer.hasRemoteDescription = true
            let pendingCandidates = viewerPeer.pendingCandidates
            viewerPeer.pendingCandidates.removeAll()
            for candidate in pendingCandidates {
                self.addRemoteCandidate(candidate, to: viewerID, using: viewerPeer.peerConnection)
            }

            self.logEvent("远端 answer 已应用: \(viewerID)，补发 \(pendingCandidates.count) 个候选")
            self.updateDiagnostics(status: "WebRTC 已连接查看端")
        }
    }

    private func applyRemoteCandidate(_ signal: [String: Any], from viewerID: String) {
        guard let viewerPeer = viewerPeers[viewerID],
              let candidatePayload = signal["candidate"] as? [String: Any],
              let sdp = candidatePayload["candidate"] as? String
        else {
            return
        }

        let sdpMid = candidatePayload["sdpMid"] as? String
        let sdpMLineIndex: Int32
        if let value = candidatePayload["sdpMLineIndex"] as? NSNumber {
            sdpMLineIndex = value.int32Value
        } else if let value = candidatePayload["sdpMLineIndex"] as? Int {
            sdpMLineIndex = Int32(value)
        } else {
            sdpMLineIndex = 0
        }

        let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid)

        if viewerPeer.hasRemoteDescription {
            addRemoteCandidate(candidate, to: viewerID, using: viewerPeer.peerConnection)
        } else {
            viewerPeer.pendingCandidates.append(candidate)
            logEvent("远端 candidate 已缓存: \(viewerID)")
        }
    }

    private func addRemoteCandidate(_ candidate: RTCIceCandidate, to viewerID: String, using peerConnection: RTCPeerConnection) {
        peerConnection.add(candidate) { [weak self] error in
            guard let self else {
                return
            }

            if let error {
                self.logger.error("Failed to add remote candidate for \(viewerID, privacy: .public): \(error.localizedDescription, privacy: .public)")
                self.logEvent("远端 candidate 添加失败: \(viewerID) \(error.localizedDescription)")
                return
            }

            self.logEvent("远端 candidate 已添加: \(viewerID)")
        }
    }

    private func sendSignal(to targetID: String, signal: [String: Any]) {
        guard let task = webSocketTask,
              let payload = makeJSONString(from: [
                  "type": "signal",
                  "targetId": targetID,
                  "signal": signal
              ])
        else {
            logEvent("信令发送前置条件不满足，目标 \(targetID)")
            return
        }

        if let signalType = signal["type"] as? String {
            logEvent("发送 signal \(signalType) -> \(targetID)")
        }

        task.send(.string(payload)) { [weak self] error in
            if let error {
                self?.logger.error("Failed to send signal to \(targetID, privacy: .public): \(error.localizedDescription, privacy: .public)")
                self?.updateDiagnostics(status: "信令发送失败", error: error.localizedDescription)
                self?.logEvent("发送 signal 失败 -> \(targetID): \(error.localizedDescription)")
            }
        }
    }

    private func sendAutomationEvent(_ event: [String: Any]) {
        guard let task = webSocketTask,
              let payload = makeJSONString(from: [
                  "type": "automation_event",
                  "event": event
              ])
        else {
            logEvent("自动化事件发送前置条件不满足")
            return
        }

        task.send(.string(payload)) { [weak self] error in
            if let error {
                self?.logger.error("Failed to send automation event: \(error.localizedDescription, privacy: .public)")
                self?.logEvent("自动化事件发送失败: \(error.localizedDescription)")
            }
        }
    }

    private func sendAutomationResult(
        sessionID: String,
        requestID: String,
        method: String,
        stepID: String? = nil,
        status: String,
        payload: [String: Any]? = nil,
        error: String? = nil
    ) {
        guard let task = webSocketTask else {
            logEvent("自动化结果发送前置条件不满足")
            return
        }

        var message: [String: Any] = [
            "type": "automation_result",
            "sessionId": sessionID,
            "requestId": requestID,
            "method": method,
            "status": status
        ]
        if let stepID {
            message["stepId"] = stepID
        }
        if let payload {
            message["payload"] = payload
        }
        if let error {
            message["error"] = error
        }

        guard let json = makeJSONString(from: message) else {
            logEvent("自动化结果序列化失败")
            return
        }

        task.send(.string(json)) { [weak self] sendError in
            if let sendError {
                self?.logEvent("自动化结果发送失败: \(sendError.localizedDescription)")
                return
            }

            self?.logEvent("已发送自动化结果: \(method) / \(status) / \(stepID ?? "-")")
        }
    }

    private func sendDebugFrameResult(
        requestID: String,
        status: String,
        payload: [String: Any]? = nil,
        error: String? = nil
    ) {
        guard let task = webSocketTask else {
            logEvent("调试帧结果发送前置条件不满足")
            return
        }

        var message: [String: Any] = [
            "type": "debug_frame_result",
            "requestId": requestID,
            "status": status
        ]
        if let payload {
            message["payload"] = payload
        }
        if let error {
            message["error"] = error
        }

        guard let json = makeJSONString(from: message) else {
            logEvent("调试帧结果序列化失败")
            return
        }

        task.send(.string(json)) { [weak self] sendError in
            if let sendError {
                self?.logEvent("调试帧结果发送失败: \(sendError.localizedDescription)")
                return
            }

            self?.logEvent("已发送调试帧结果: \(requestID) / \(status)")
        }
    }

    private func sendCalibrationColorFrameResult(
        sessionID: String,
        requestID: String,
        status: String,
        payload: [String: Any]? = nil,
        error: String? = nil
    ) {
        guard let task = webSocketTask else {
            logEvent("彩色标定帧结果发送前置条件不满足")
            return
        }

        var message: [String: Any] = [
            "type": "calibration_color_frame_result",
            "sessionId": sessionID,
            "requestId": requestID,
            "status": status
        ]
        if let payload {
            message["payload"] = payload
        }
        if let error {
            message["error"] = error
        }

        guard let json = makeJSONString(from: message) else {
            logEvent("彩色标定帧结果序列化失败")
            return
        }

        task.send(.string(json)) { [weak self] sendError in
            if let sendError {
                self?.logEvent("彩色标定帧结果发送失败: \(sendError.localizedDescription)")
                return
            }

            self?.logEvent("已发送彩色标定帧结果: \(requestID) / \(status)")
        }
    }

    private func handleDebugFrameRequestMessage(_ json: [String: Any]) {
        guard let requestID = json["requestId"] as? String, !requestID.isEmpty else {
            return
        }

        let query = (json["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let pixelBuffer = automationCommandQueue.sync(execute: { latestVideoPixelBuffer }) else {
            logEvent("调试帧请求失败: 当前没有可用视频帧")
            sendDebugFrameResult(
                requestID: requestID,
                status: "error",
                error: "当前还没有可用的 ReplayKit 视频帧"
            )
            return
        }

        var payload = remoteAutomationInspector.makeDebugOCRPayload(pixelBuffer: pixelBuffer, query: query)
        guard let imagePayload = makeDebugFrameImagePayload(pixelBuffer: pixelBuffer) else {
            logEvent("调试帧请求失败: 图片编码失败")
            sendDebugFrameResult(
                requestID: requestID,
                status: "error",
                error: "内存帧转图片失败"
            )
            return
        }

        for (key, value) in imagePayload {
            payload[key] = value
        }
        payload["capturedAt"] = isoFormatter.string(from: Date())

        logEvent("收到调试帧请求: \(requestID) query=\(query.isEmpty ? "<empty>" : query)")
        sendDebugFrameResult(requestID: requestID, status: "ok", payload: payload)
    }

    private func handleCalibrationColorFrameRequestMessage(_ json: [String: Any]) {
        guard let sessionID = json["sessionId"] as? String,
              let requestID = json["requestId"] as? String,
              !sessionID.isEmpty,
              !requestID.isEmpty
        else {
            return
        }

        let startedAt = Date()
        logEvent("开始处理彩色标定帧请求: \(requestID)")

        guard let pixelBuffer = automationCommandQueue.sync(execute: { latestVideoPixelBuffer }) else {
            logEvent("彩色标定帧请求失败: 当前没有可用视频帧 \(requestID)")
            sendCalibrationColorFrameResult(
                sessionID: sessionID,
                requestID: requestID,
                status: "error",
                error: "当前还没有可用的 ReplayKit 视频帧"
            )
            return
        }

        let expectedColors = decodeCalibrationExpectedColors(json["expectedColors"] as? [[String: Any]] ?? [])
        guard !expectedColors.isEmpty else {
            logEvent("彩色标定帧请求失败: expectedColors 为空 \(requestID)")
            sendCalibrationColorFrameResult(
                sessionID: sessionID,
                requestID: requestID,
                status: "error",
                error: "彩色标定请求缺少 expectedColors"
            )
            return
        }

        logEvent("收到彩色标定帧请求: \(requestID) colors=\(expectedColors.count)")

        guard let payload = makeCalibrationColorFramePayload(pixelBuffer: pixelBuffer, expectedColors: expectedColors) else {
            let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            logEvent("彩色标定帧分析失败: \(requestID) elapsedMs=\(elapsedMs)")
            sendCalibrationColorFrameResult(
                sessionID: sessionID,
                requestID: requestID,
                status: "error",
                error: "彩色标定帧分析失败"
            )
            return
        }

        let detectionCount = (payload["detections"] as? [[String: Any]])?.count ?? 0
        let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        logEvent("已完成彩色标定帧分析: \(requestID) colors=\(expectedColors.count) detections=\(detectionCount) elapsedMs=\(elapsedMs)")
        sendCalibrationColorFrameResult(sessionID: sessionID, requestID: requestID, status: "ok", payload: payload)
    }

    private func makeDebugFrameImagePayload(pixelBuffer: CVPixelBuffer) -> [String: Any]? {
        let sourceWidth = max(1, CVPixelBufferGetWidth(pixelBuffer))
        let sourceHeight = max(1, CVPixelBufferGetHeight(pixelBuffer))
        let sourceLongEdge = max(sourceWidth, sourceHeight)
        let scale = min(1.0, Double(targetMaxLongEdge) / Double(sourceLongEdge))
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let outputImage: CIImage
        let outputWidth: Int
        let outputHeight: Int

        if scale < 0.999 {
            outputImage = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            outputWidth = max(1, Int((Double(sourceWidth) * scale).rounded()))
            outputHeight = max(1, Int((Double(sourceHeight) * scale).rounded()))
        } else {
            outputImage = image
            outputWidth = sourceWidth
            outputHeight = sourceHeight
        }

        do {
            guard let data = try replayFrameSnapshotContext.jpegRepresentation(
                of: outputImage,
                colorSpace: CGColorSpaceCreateDeviceRGB(),
                options: [:]
            ) else {
                return nil
            }

            return [
                "imageDataURL": "data:image/jpeg;base64,\(data.base64EncodedString())",
                "imageSize": [
                    "width": outputWidth,
                    "height": outputHeight
                ],
                "sourceFrameSize": [
                    "width": sourceWidth,
                    "height": sourceHeight
                ]
            ]
        } catch {
            logger.error("Failed to encode debug frame image: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func decodeCalibrationExpectedColors(_ values: [[String: Any]]) -> [CalibrationExpectedColor] {
        values.compactMap { value in
            guard let stepID = value["stepId"] as? String,
                  let colorHex = value["color"] as? String,
                  let rgb = parseHexColor(colorHex)
            else {
                return nil
            }

            return CalibrationExpectedColor(
                stepID: stepID,
                label: value["label"] as? String ?? stepID,
                colorHex: colorHex,
                red: rgb.red,
                green: rgb.green,
                blue: rgb.blue
            )
        }
    }

    private func parseHexColor(_ hex: String) -> (red: Int, green: Int, blue: Int)? {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") {
            value.removeFirst()
        }

        guard value.count == 6, let rgb = Int(value, radix: 16) else {
            return nil
        }

        return (red: (rgb >> 16) & 0xff, green: (rgb >> 8) & 0xff, blue: rgb & 0xff)
    }

    private func makeCalibrationColorFramePayload(
        pixelBuffer: CVPixelBuffer,
        expectedColors: [CalibrationExpectedColor]
    ) -> [String: Any]? {
        let sourceWidth = max(1, CVPixelBufferGetWidth(pixelBuffer))
        let sourceHeight = max(1, CVPixelBufferGetHeight(pixelBuffer))
        let sourceLongEdge = max(sourceWidth, sourceHeight)
        let analysisScale = min(1.0, Double(calibrationAnalysisMaxLongEdge) / Double(sourceLongEdge))
        let width = max(1, Int((Double(sourceWidth) * analysisScale).rounded()))
        let height = max(1, Int((Double(sourceHeight) * analysisScale).rounded()))
        let bytesPerPixel = 4
        var bytes = [UInt8](repeating: 0, count: width * height * bytesPerPixel)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let sourceImage = CIImage(cvPixelBuffer: pixelBuffer)
        let image: CIImage

        if analysisScale < 0.999 {
            image = sourceImage.transformed(by: CGAffineTransform(scaleX: analysisScale, y: analysisScale))
        } else {
            image = sourceImage
        }

        bytes.withUnsafeMutableBytes { buffer in
            replayFrameSnapshotContext.render(
                image,
                toBitmap: buffer.baseAddress!,
                rowBytes: width * bytesPerPixel,
                bounds: CGRect(x: 0, y: 0, width: width, height: height),
                format: .RGBA8,
                colorSpace: colorSpace
            )
        }

        let minimumArea = max(6, Int((12.0 * analysisScale * analysisScale).rounded()))
        var detections: [[String: Any]] = []

        for expected in expectedColors {
            guard let blob = largestCalibrationColorBlob(
                in: bytes,
                width: width,
                height: height,
                bytesPerPixel: bytesPerPixel,
                expected: expected,
                minimumArea: minimumArea
            ) else {
                continue
            }

            detections.append([
                "stepId": expected.stepID,
                "label": expected.label,
                "color": expected.colorHex,
                "centerPx": [
                    "x": Double(blob.sumX) / Double(blob.count),
                    "y": Double(blob.sumY) / Double(blob.count)
                ],
                "area": blob.count,
                "bounds": [
                    "x": blob.minX,
                    "y": blob.minY,
                    "width": max(1, blob.maxX - blob.minX + 1),
                    "height": max(1, blob.maxY - blob.minY + 1)
                ]
            ])
        }

        return [
            "imageSize": [
                "width": width,
                "height": height
            ],
            "sourceFrameSize": [
                "width": width,
                "height": height
            ],
            "originalFrameSize": [
                "width": sourceWidth,
                "height": sourceHeight
            ],
            "detections": detections,
            "capturedAt": isoFormatter.string(from: Date())
        ]
    }

    private func largestCalibrationColorBlob(
        in bytes: [UInt8],
        width: Int,
        height: Int,
        bytesPerPixel: Int,
        expected: CalibrationExpectedColor,
        minimumArea: Int
    ) -> CalibrationColorBlob? {
        let pixelCount = width * height
        var matching = [Bool](repeating: false, count: pixelCount)
        var visited = [Bool](repeating: false, count: pixelCount)

        for y in 0..<height {
            let rowStart = y * width
            let byteRowStart = y * width * bytesPerPixel
            for x in 0..<width {
                let offset = byteRowStart + x * bytesPerPixel
                matching[rowStart + x] = calibrationPixelMatches(
                    bytes: bytes,
                    offset: offset,
                    expected: expected
                )
            }
        }

        var bestBlob: CalibrationColorBlob?
        var queue = [Int]()
        queue.reserveCapacity(256)

        for index in 0..<pixelCount {
            guard matching[index], !visited[index] else {
                continue
            }

            visited[index] = true
            queue.removeAll(keepingCapacity: true)
            queue.append(index)

            var cursor = 0
            var count = 0
            var sumX = 0
            var sumY = 0
            var minX = width
            var minY = height
            var maxX = 0
            var maxY = 0

            while cursor < queue.count {
                let current = queue[cursor]
                cursor += 1

                let x = current % width
                let y = current / width
                count += 1
                sumX += x
                sumY += y
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)

                if x > 0 {
                    enqueueCalibrationNeighbor(current - 1, matching: matching, visited: &visited, queue: &queue)
                }
                if x + 1 < width {
                    enqueueCalibrationNeighbor(current + 1, matching: matching, visited: &visited, queue: &queue)
                }
                if y > 0 {
                    enqueueCalibrationNeighbor(current - width, matching: matching, visited: &visited, queue: &queue)
                }
                if y + 1 < height {
                    enqueueCalibrationNeighbor(current + width, matching: matching, visited: &visited, queue: &queue)
                }
            }

            guard count >= minimumArea else {
                continue
            }

            let blob = CalibrationColorBlob(
                count: count,
                sumX: sumX,
                sumY: sumY,
                minX: minX,
                minY: minY,
                maxX: maxX,
                maxY: maxY
            )

            if bestBlob == nil || count > bestBlob!.count {
                bestBlob = blob
            }
        }

        return bestBlob
    }

    private func calibrationPixelMatches(
        bytes: [UInt8],
        offset: Int,
        expected: CalibrationExpectedColor
    ) -> Bool {
        let red = Int(bytes[offset])
        let green = Int(bytes[offset + 1])
        let blue = Int(bytes[offset + 2])
        let redDelta = abs(red - expected.red)
        let greenDelta = abs(green - expected.green)
        let blueDelta = abs(blue - expected.blue)
        let totalDelta = redDelta + greenDelta + blueDelta

        return redDelta <= calibrationColorMaxChannelDelta &&
            greenDelta <= calibrationColorMaxChannelDelta &&
            blueDelta <= calibrationColorMaxChannelDelta &&
            totalDelta <= calibrationColorMaxTotalDelta
    }

    private func enqueueCalibrationNeighbor(
        _ index: Int,
        matching: [Bool],
        visited: inout [Bool],
        queue: inout [Int]
    ) {
        guard matching[index], !visited[index] else {
            return
        }

        visited[index] = true
        queue.append(index)
    }

    private func decodeAutomationStep(from value: Any) throws -> AutomationStep {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        return try JSONDecoder().decode(AutomationStep.self, from: data)
    }

    private func handleAutomationCommandMessage(_ json: [String: Any]) {
        guard let sessionID = json["sessionId"] as? String,
              let requestID = json["requestId"] as? String,
              let method = json["method"] as? String
        else {
            return
        }

        let payload = json["payload"] as? [String: Any] ?? [:]

        switch method {
        case "startCheckItem":
            automationCommandQueue.sync {
                activeAutomationSessionID = sessionID
                pendingAutomationCheckCommand = nil
                remoteAutomationInspector.start(sessionID: sessionID)
            }
            updateAutomationStatus("远程检查会话已启动")
            logEvent("收到 startCheckItem: \(sessionID)")
            sendAutomationResult(
                sessionID: sessionID,
                requestID: requestID,
                method: method,
                status: "ok",
                payload: payload.isEmpty ? nil : payload
            )
        case "StopCheck":
            automationCommandQueue.sync {
                if activeAutomationSessionID == sessionID {
                    activeAutomationSessionID = nil
                    pendingAutomationCheckCommand = nil
                }
                remoteAutomationInspector.stop(sessionID: sessionID)
            }
            updateAutomationStatus("远程检查会话已停止")
            logEvent("收到 StopCheck: \(sessionID)")
            sendAutomationResult(
                sessionID: sessionID,
                requestID: requestID,
                method: method,
                status: "ok"
            )
        case "checkNextItem":
            guard let stepValue = payload["step"] else {
                sendAutomationResult(
                    sessionID: sessionID,
                    requestID: requestID,
                    method: method,
                    status: "error",
                    error: "缺少 step 参数"
                )
                return
            }

            let step: AutomationStep
            do {
                step = try decodeAutomationStep(from: stepValue)
            } catch {
                sendAutomationResult(
                    sessionID: sessionID,
                    requestID: requestID,
                    method: method,
                    status: "error",
                    error: "step 解码失败: \(error.localizedDescription)"
                )
                return
            }

            let accepted = automationCommandQueue.sync { () -> Bool in
                guard activeAutomationSessionID == sessionID else {
                    return false
                }
                pendingAutomationCheckCommand = PendingAutomationCheckCommand(
                    sessionID: sessionID,
                    requestID: requestID,
                    step: step
                )
                return true
            }

            guard accepted else {
                sendAutomationResult(
                    sessionID: sessionID,
                    requestID: requestID,
                    method: method,
                    stepID: step.id,
                    status: "error",
                    error: "远程检查会话未激活"
                )
                return
            }

            updateAutomationStatus("等待视频帧执行检查: \(step.id)")
            logEvent("收到 checkNextItem: \(step.id)")

            if let latestPixelBuffer = automationCommandQueue.sync(execute: { latestVideoPixelBuffer }) {
                logEvent("使用最近一帧立即执行检查: \(step.id)")
                processPendingAutomationCheckIfNeeded(pixelBuffer: latestPixelBuffer)
            } else {
                logEvent("当前没有可用视频帧，等待下一帧执行检查: \(step.id)")
            }
        default:
            sendAutomationResult(
                sessionID: sessionID,
                requestID: requestID,
                method: method,
                status: "error",
                error: "未知的远程命令: \(method)"
            )
        }
    }

    private func processPendingAutomationCheckIfNeeded(pixelBuffer: CVPixelBuffer) {
        let result = automationCommandQueue.sync { () -> PendingAutomationCheckResult? in
            guard let pendingCommand = pendingAutomationCheckCommand else {
                return nil
            }

            pendingAutomationCheckCommand = nil
            do {
                let payload = try remoteAutomationInspector.evaluate(
                    step: pendingCommand.step,
                    sessionID: pendingCommand.sessionID,
                    pixelBuffer: pixelBuffer
                )
                return PendingAutomationCheckResult(
                    sessionID: pendingCommand.sessionID,
                    requestID: pendingCommand.requestID,
                    stepID: pendingCommand.step.id,
                    status: "ok",
                    payload: payload,
                    error: nil
                )
            } catch {
                return PendingAutomationCheckResult(
                    sessionID: pendingCommand.sessionID,
                    requestID: pendingCommand.requestID,
                    stepID: pendingCommand.step.id,
                    status: "error",
                    payload: nil,
                    error: error.localizedDescription
                )
            }
        }

        guard let result else {
            return
        }

        if result.status == "ok" {
            updateAutomationStatus("已返回检查结果: \(result.stepID)")
        } else {
            updateAutomationStatus("检查失败: \(result.error ?? result.stepID)")
        }

        sendAutomationResult(
            sessionID: result.sessionID,
            requestID: result.requestID,
            method: "checkNextItem",
            stepID: result.stepID,
            status: result.status,
            payload: result.payload,
            error: result.error
        )
    }

    private func persistLatestReplayFrameIfNeeded(pixelBuffer: CVPixelBuffer, at now: Date) {
        guard now.timeIntervalSince(lastReplayFrameSnapshotAt) >= 1 else {
            return
        }

        guard let snapshotURL = StreamDefaults.latestReplayFrameURL() else {
            return
        }

        let image = CIImage(cvPixelBuffer: pixelBuffer)
        do {
            guard let data = try replayFrameSnapshotContext.jpegRepresentation(
                of: image,
                colorSpace: CGColorSpaceCreateDeviceRGB(),
                options: [:]
            ) else {
                return
            }
            try FileManager.default.createDirectory(
                at: snapshotURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: nil
            )
            try data.write(to: snapshotURL, options: Data.WritingOptions.atomic)
            lastReplayFrameSnapshotAt = now
            let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier)
            defaults?.set(isoFormatter.string(from: now), forKey: StreamDefaults.latestReplayFrameUpdatedAtKey)
        } catch {
            logger.error("Failed to persist latest replay frame: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func startWebSocketPingLoop(for task: URLSessionWebSocketTask) {
        stopWebSocketPingLoop()

        let timer = DispatchSource.makeTimerSource(queue: pingQueue)
        timer.schedule(deadline: .now() + 15, repeating: 15)
        timer.setEventHandler { [weak self, weak task] in
            guard let self, let task else {
                return
            }

            task.sendPing { [weak self] error in
                guard let self, let error else {
                    return
                }

                self.logger.error("WebSocket ping failed: \(error.localizedDescription, privacy: .public)")
                self.logEvent("WebSocket ping 失败: \(error.localizedDescription)")
            }
        }
        pingTimer = timer
        timer.resume()
        logEvent("已启动 WebSocket 保活 ping")
    }

    private func stopWebSocketPingLoop() {
        pingTimer?.setEventHandler {}
        pingTimer?.cancel()
        pingTimer = nil
    }

    private func startDiagnosticsHeartbeatLoop() {
        stopDiagnosticsHeartbeatLoop()

        let timer = DispatchSource.makeTimerSource(queue: diagnosticsQueue)
        timer.schedule(deadline: .now(), repeating: 1)
        timer.setEventHandler { [weak self] in
            self?.updateExtensionHeartbeat()
        }
        diagnosticsHeartbeatTimer = timer
        timer.resume()
    }

    private func stopDiagnosticsHeartbeatLoop() {
        diagnosticsHeartbeatTimer?.setEventHandler {}
        diagnosticsHeartbeatTimer?.cancel()
        diagnosticsHeartbeatTimer = nil
    }

    private func resetDiagnosticsSession() {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        let nowText = isoFormatter.string(from: Date())
        sequenceNumber = 0
        lastSubmittedAt = .distantPast
        lastNoViewerLogAt = .distantPast
        lastFrameProcessingFailureLogAt = .distantPast
        videoSampleCount = 0
        appAudioSampleCount = 0
        micAudioSampleCount = 0
        lastSampleTypeName = ""
        lastSampleAtText = ""
        lastSampleStatsWriteAt = .distantPast
        lastSubmittedStatsWriteAt = .distantPast
        adaptedVideoWidth = 0
        adaptedVideoHeight = 0

        defaults.set([], forKey: StreamDefaults.diagnosticsRecentEventsKey)
        defaults.set("", forKey: StreamDefaults.diagnosticsLastErrorKey)
        defaults.set(nowText, forKey: StreamDefaults.diagnosticsBroadcastStartedAtKey)
        defaults.set(nowText, forKey: StreamDefaults.diagnosticsExtensionHeartbeatAtKey)
        defaults.set("", forKey: StreamDefaults.diagnosticsLastSampleAtKey)
        defaults.set("", forKey: StreamDefaults.diagnosticsLastSampleTypeKey)
        defaults.set(0, forKey: StreamDefaults.diagnosticsVideoSampleCountKey)
        defaults.set(0, forKey: StreamDefaults.diagnosticsAppAudioSampleCountKey)
        defaults.set(0, forKey: StreamDefaults.diagnosticsMicAudioSampleCountKey)
        defaults.set(0, forKey: StreamDefaults.diagnosticsEncodedFrameCountKey)
        defaults.set("", forKey: StreamDefaults.diagnosticsLastEncodedFrameAtKey)
        defaults.set(0, forKey: StreamDefaults.diagnosticsSentFrameCountKey)
        defaults.set("", forKey: StreamDefaults.diagnosticsLastFrameAtKey)
        defaults.set(nowText, forKey: StreamDefaults.diagnosticsUpdatedAtKey)
    }

    private func updateExtensionHeartbeat() {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        let nowText = isoFormatter.string(from: Date())
        defaults.set(nowText, forKey: StreamDefaults.diagnosticsExtensionHeartbeatAtKey)
        defaults.set(nowText, forKey: StreamDefaults.diagnosticsUpdatedAtKey)
    }

    private func recordSampleBuffer(_ sampleBufferType: RPSampleBufferType, at now: Date) {
        switch sampleBufferType {
        case .video:
            videoSampleCount += 1
            lastSampleTypeName = "video"
            if videoSampleCount == 1 || videoSampleCount % 120 == 0 {
                logEvent("收到视频 sampleBuffer，第 \(videoSampleCount) 个")
            }
        case .audioApp:
            appAudioSampleCount += 1
            lastSampleTypeName = "audioApp"
            if appAudioSampleCount == 1 {
                logEvent("收到应用音频 sampleBuffer")
            }
        case .audioMic:
            micAudioSampleCount += 1
            lastSampleTypeName = "audioMic"
            if micAudioSampleCount == 1 {
                logEvent("收到麦克风音频 sampleBuffer")
            }
        @unknown default:
            lastSampleTypeName = "unknown"
        }

        lastSampleAtText = isoFormatter.string(from: now)
        flushSampleDiagnostics(force: false)
    }

    private func flushSampleDiagnostics(force: Bool) {
        let now = Date()
        guard force || now.timeIntervalSince(lastSampleStatsWriteAt) >= 1 else {
            return
        }

        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        defaults.set(videoSampleCount, forKey: StreamDefaults.diagnosticsVideoSampleCountKey)
        defaults.set(appAudioSampleCount, forKey: StreamDefaults.diagnosticsAppAudioSampleCountKey)
        defaults.set(micAudioSampleCount, forKey: StreamDefaults.diagnosticsMicAudioSampleCountKey)
        defaults.set(lastSampleTypeName, forKey: StreamDefaults.diagnosticsLastSampleTypeKey)
        defaults.set(lastSampleAtText, forKey: StreamDefaults.diagnosticsLastSampleAtKey)
        lastSampleStatsWriteAt = now
    }

    private func recordSubmittedFrame(at now: Date) {
        flushSubmittedFrameDiagnostics(force: sequenceNumber == 1 || sequenceNumber % 30 == 0 || now.timeIntervalSince(lastSubmittedStatsWriteAt) >= 1)
    }

    private func flushSubmittedFrameDiagnostics(force: Bool) {
        guard force else {
            return
        }

        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        defaults.set(sequenceNumber, forKey: StreamDefaults.diagnosticsEncodedFrameCountKey)
        if sequenceNumber > 0 {
            defaults.set(isoFormatter.string(from: Date()), forKey: StreamDefaults.diagnosticsLastEncodedFrameAtKey)
        } else {
            defaults.set("", forKey: StreamDefaults.diagnosticsLastEncodedFrameAtKey)
        }
        lastSubmittedStatsWriteAt = Date()
    }

    private func logFrameProcessingFailureIfNeeded(message: String, at now: Date) {
        guard now.timeIntervalSince(lastFrameProcessingFailureLogAt) >= 5 else {
            return
        }

        lastFrameProcessingFailureLogAt = now
        logEvent(message)
    }

    private func logEvent(_ message: String) {
        logger.log("[diagnostics] \(message, privacy: .public)")

        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        let timestamp = isoFormatter.string(from: Date())
        var events = defaults.stringArray(forKey: StreamDefaults.diagnosticsRecentEventsKey) ?? []
        events.append("[\(timestamp)] \(message)")
        if events.count > 25 {
            events.removeFirst(events.count - 25)
        }
        defaults.set(events, forKey: StreamDefaults.diagnosticsRecentEventsKey)
        defaults.set(timestamp, forKey: StreamDefaults.diagnosticsUpdatedAtKey)
    }

    private func makeJSONString(from object: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
              let json = String(data: data, encoding: .utf8)
        else {
            return nil
        }

        return json
    }

    private func serialize(candidate: RTCIceCandidate) -> [String: Any] {
        var payload: [String: Any] = [
            "candidate": candidate.sdp,
            "sdpMLineIndex": Int(candidate.sdpMLineIndex)
        ]

        if let sdpMid = candidate.sdpMid {
            payload["sdpMid"] = sdpMid
        }

        return payload
    }

    private func receiveLoop(for task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            switch result {
            case .success(let message):
                self?.handleIncomingMessage(message)
                self?.receiveLoop(for: task)
            case .failure(let error):
                self?.logger.error("Receive loop failed: \(error.localizedDescription, privacy: .public)")
                self?.updateDiagnostics(status: "连接中断", error: error.localizedDescription)
                self?.stopWebSocketPingLoop()
                self?.stopDiagnosticsHeartbeatLoop()
                self?.logEvent("接收循环失败: \(error.localizedDescription)")
                self?.finishBroadcastWithError(error)
            }
        }
    }

    private func handleIncomingMessage(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message,
              let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else {
            return
        }

        switch type {
        case "publisher_ready":
            updateDiagnostics(status: "已连接到 WebRTC 信令服务")
            logger.log("Publisher is ready for WebRTC signaling")
            let viewerCount = (json["viewerIds"] as? [String])?.count ?? (json["viewerIds"] as? [Any])?.count ?? 0
            logEvent("服务端确认 publisher_ready，当前查看端 \(viewerCount) 个")

            if let viewerIDs = json["viewerIds"] as? [String] {
                for viewerID in viewerIDs {
                    startPeerConnection(for: viewerID)
                }
            } else if let viewerIDs = json["viewerIds"] as? [Any] {
                for viewerID in viewerIDs.compactMap({ $0 as? String }) {
                    startPeerConnection(for: viewerID)
                }
            }
        case "viewer_joined":
            guard let viewerID = json["viewerId"] as? String else {
                return
            }
            logger.log("Viewer joined: \(viewerID, privacy: .public)")
            logEvent("查看端加入: \(viewerID)")
            startPeerConnection(for: viewerID)
        case "viewer_left":
            guard let viewerID = json["viewerId"] as? String else {
                return
            }
            logger.log("Viewer left: \(viewerID, privacy: .public)")
            logEvent("查看端离开: \(viewerID)")
            closePeerConnection(for: viewerID)
        case "signal":
            guard let viewerID = json["sourceId"] as? String,
                  let signal = json["signal"] as? [String: Any]
            else {
                return
            }
            logEvent("收到服务端转发的 signal \((signal["type"] as? String) ?? "unknown") from \(viewerID)")
            receiveSignal(from: viewerID, signal: signal)
        case "room_state":
            let viewerCount = json["viewerCount"] as? Int ?? 0
            let hasPublisher = json["hasPublisher"] as? Bool ?? true
            logEvent("房间状态: hasPublisher=\(hasPublisher) viewers=\(viewerCount)")
            if viewerCount == 0 {
                updateDiagnostics(status: "已连接信令服务，等待查看端")
            }
        case "warning":
            let warning = json["message"] as? String ?? "未知警告"
            updateDiagnostics(status: "服务端警告", error: warning)
            logger.warning("Server warning: \(warning, privacy: .public)")
            logEvent("服务端警告: \(warning)")
        case "automation_command":
            logEvent("收到远程自动化命令: \((json["method"] as? String) ?? "unknown")")
            handleAutomationCommandMessage(json)
        case "debug_frame_request":
            handleDebugFrameRequestMessage(json)
        case "calibration_color_frame_request":
            handleCalibrationColorFrameRequestMessage(json)
        case "error":
            let errorMessage = json["message"] as? String ?? "未知错误"
            updateDiagnostics(status: "服务端返回错误", error: errorMessage)
            logger.error("Server error: \(errorMessage, privacy: .public)")
            logEvent("服务端错误: \(errorMessage)")
        case "publisher_left":
            updateDiagnostics(status: "发布端已断开")
            logEvent("服务端通知发布端已断开")
        default:
            logEvent("收到未处理消息类型: \(type)")
            break
        }
    }

    private func updateDiagnostics(status: String, error: String? = nil, sentFrameCount: Int? = nil, lastFrameAt: String? = nil) {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        defaults.set(status, forKey: StreamDefaults.diagnosticsStatusKey)
        defaults.set(isoFormatter.string(from: Date()), forKey: StreamDefaults.diagnosticsUpdatedAtKey)

        if let error {
            defaults.set(error, forKey: StreamDefaults.diagnosticsLastErrorKey)
        }

        if let sentFrameCount {
            defaults.set(sentFrameCount, forKey: StreamDefaults.diagnosticsSentFrameCountKey)
        }

        if let lastFrameAt {
            defaults.set(lastFrameAt, forKey: StreamDefaults.diagnosticsLastFrameAtKey)
        }
    }

    private func updateAutomationStatus(_ status: String) {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        defaults.set(status, forKey: StreamDefaults.automationLastStatusKey)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        logger.log("WebSocket opened")
        updateDiagnostics(status: "WebRTC 信令已打开")
        startWebSocketPingLoop(for: webSocketTask)
        logEvent("WebSocket 已打开")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        logger.log("WebSocket closed with code \(closeCode.rawValue), reason: \(reasonText, privacy: .public)")
        updateDiagnostics(status: "WebSocket 已关闭", error: reasonText)
        stopWebSocketPingLoop()
        logEvent("WebSocket 已关闭 code=\(closeCode.rawValue) reason=\(reasonText.isEmpty ? "<empty>" : reasonText)")
    }
}

extension SampleHandler: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        guard let viewerID = peerConnectionToViewerID[ObjectIdentifier(peerConnection)] else {
            return
        }

        logEvent("SignalingState 变更: \(viewerID) -> \(String(describing: stateChanged))")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        guard let viewerID = peerConnectionToViewerID[ObjectIdentifier(peerConnection)] else {
            return
        }

        logEvent("ICE 连接状态: \(viewerID) -> \(String(describing: newState))")

        switch newState {
        case .failed, .closed, .disconnected:
            logger.warning("ICE connection ended for \(viewerID, privacy: .public) with state \(String(describing: newState), privacy: .public)")
            closePeerConnection(for: viewerID)
        default:
            break
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        guard let viewerID = peerConnectionToViewerID[ObjectIdentifier(peerConnection)] else {
            return
        }

        logEvent("ICE 收集状态: \(viewerID) -> \(String(describing: newState))")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard let viewerID = peerConnectionToViewerID[ObjectIdentifier(peerConnection)] else {
            return
        }

        logEvent("生成本地 candidate: \(viewerID)")

        sendSignal(
            to: viewerID,
            signal: [
                "type": "candidate",
                "candidate": serialize(candidate: candidate)
            ]
        )
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        guard let viewerID = peerConnectionToViewerID[ObjectIdentifier(peerConnection)] else {
            return
        }

        logEvent("收到意外 DataChannel: \(viewerID) -> \(dataChannel.label)")
    }
}
