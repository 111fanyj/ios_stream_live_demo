import Foundation
import CoreImage
import OSLog
import ReplayKit
import UIKit
import WebRTC

final class SampleHandler: RPBroadcastSampleHandler, URLSessionWebSocketDelegate {
    private final class ViewerPeerState {
        let viewerID: String
        let peerConnection: RTCPeerConnection
        let dataChannel: RTCDataChannel
        var hasRemoteDescription = false
        var pendingCandidates: [RTCIceCandidate] = []

        init(viewerID: String, peerConnection: RTCPeerConnection, dataChannel: RTCDataChannel) {
            self.viewerID = viewerID
            self.peerConnection = peerConnection
            self.dataChannel = dataChannel
        }
    }

    private let ciContext = CIContext(options: nil)
    private let logger = Logger(subsystem: "IOSStreamViewer", category: "BroadcastUploadExtension")
    private var webSocketSession: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var sequenceNumber = 0
    private var lastSentAt = Date.distantPast
    private let minimumSendInterval: TimeInterval = 0.12
    private let isoFormatter = ISO8601DateFormatter()
    private lazy var peerConnectionFactory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }()
    private var viewerPeers: [String: ViewerPeerState] = [:]
    private var peerConnectionToViewerID: [ObjectIdentifier: String] = [:]
    private var dataChannelToViewerID: [ObjectIdentifier: String] = [:]

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        updateDiagnostics(status: "广播启动中")
        resetPeerConnections()

        guard let configuration = loadConfiguration() else {
            let error = NSError(domain: "IOSStreamViewer", code: -1, userInfo: [NSLocalizedDescriptionKey: "无法读取共享配置，请先在主 App 中保存服务端地址"])
            updateDiagnostics(status: "配置读取失败", error: error.localizedDescription)
            finishBroadcastWithError(error)
            return
        }

        guard let url = buildPublisherURL(configuration: configuration) else {
            let error = NSError(domain: "IOSStreamViewer", code: -2, userInfo: [NSLocalizedDescriptionKey: "服务端地址无效"])
            updateDiagnostics(status: "服务端地址无效", error: error.localizedDescription)
            finishBroadcastWithError(error)
            return
        }

        logger.log("Broadcast started, connecting to \(url.absoluteString, privacy: .public)")
        updateDiagnostics(status: "正在连接 \(url.host ?? configuration.serverURL)")

        let sessionConfiguration = URLSessionConfiguration.default
        sessionConfiguration.timeoutIntervalForRequest = 15
        sessionConfiguration.timeoutIntervalForResource = 15

        let session = URLSession(configuration: sessionConfiguration, delegate: self, delegateQueue: nil)
        webSocketSession = session
        let task = session.webSocketTask(with: url)
        task.resume()
        webSocketTask = task
        receiveLoop(for: task)
    }

    override func broadcastPaused() {
    }

    override func broadcastResumed() {
    }

    override func broadcastFinished() {
        updateDiagnostics(status: "广播结束")
        resetPeerConnections()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        webSocketSession?.invalidateAndCancel()
        webSocketSession = nil
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else {
            return
        }

        let now = Date()
        guard now.timeIntervalSince(lastSentAt) >= minimumSendInterval else {
            return
        }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let payload = makeFramePayload(from: pixelBuffer)
        else {
            return
        }

        let deliveredViewerCount = deliverFramePayload(payload)
        guard deliveredViewerCount > 0 else {
            return
        }

        lastSentAt = now
        updateDiagnostics(
            status: "推流中（WebRTC）",
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

    private func makeFramePayload(from pixelBuffer: CVPixelBuffer) -> String? {
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let extent = ciImage.extent.integral
        guard let cgImage = ciContext.createCGImage(ciImage, from: extent) else {
            return nil
        }

        let image = UIImage(cgImage: cgImage)
        guard let jpegData = image.jpegData(compressionQuality: 0.45) else {
            return nil
        }

        sequenceNumber += 1

        let payload: [String: Any] = [
            "type": "frame",
            "mimeType": "image/jpeg",
            "width": Int(extent.width),
            "height": Int(extent.height),
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            "sequence": sequenceNumber,
            "imageData": jpegData.base64EncodedString()
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8)
        else {
            return nil
        }

        return json
    }

    private func deliverFramePayload(_ payload: String) -> Int {
        let buffer = RTCDataBuffer(data: Data(payload.utf8), isBinary: false)
        var deliveredViewerCount = 0

        for viewerPeer in viewerPeers.values {
            guard viewerPeer.dataChannel.readyState == .open else {
                continue
            }

            if viewerPeer.dataChannel.sendData(buffer) {
                deliveredViewerCount += 1
            } else {
                logger.error("Failed to send frame over data channel for \(viewerPeer.viewerID, privacy: .public)")
            }
        }

        return deliveredViewerCount
    }

    private func resetPeerConnections() {
        for viewerPeer in viewerPeers.values {
            viewerPeer.peerConnection.close()
        }

        viewerPeers.removeAll()
        peerConnectionToViewerID.removeAll()
        dataChannelToViewerID.removeAll()
    }

    private func startPeerConnection(for viewerID: String) {
        guard viewerPeers[viewerID] == nil else {
            return
        }

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
            return
        }

        let dataChannelConfiguration = RTCDataChannelConfiguration()
        dataChannelConfiguration.isOrdered = false

        guard let dataChannel = peerConnection.dataChannel(forLabel: "frames", configuration: dataChannelConfiguration) else {
            logger.error("Failed to create data channel for \(viewerID, privacy: .public)")
            return
        }

        dataChannel.delegate = self

        let viewerPeer = ViewerPeerState(
            viewerID: viewerID,
            peerConnection: peerConnection,
            dataChannel: dataChannel
        )

        viewerPeers[viewerID] = viewerPeer
        peerConnectionToViewerID[ObjectIdentifier(peerConnection)] = viewerID
        dataChannelToViewerID[ObjectIdentifier(dataChannel)] = viewerID

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
                self.closePeerConnection(for: viewerID)
                return
            }

            guard let sessionDescription else {
                self.logger.error("Offer is missing for \(viewerID, privacy: .public)")
                self.closePeerConnection(for: viewerID)
                return
            }

            peerConnection.setLocalDescription(sessionDescription) { [weak self] error in
                guard let self else {
                    return
                }

                if let error {
                    self.logger.error("Failed to set local description for \(viewerID, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    self.closePeerConnection(for: viewerID)
                    return
                }

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

        peerConnectionToViewerID.removeValue(forKey: ObjectIdentifier(viewerPeer.peerConnection))
        dataChannelToViewerID.removeValue(forKey: ObjectIdentifier(viewerPeer.dataChannel))
        viewerPeer.peerConnection.close()
    }

    private func receiveSignal(from viewerID: String, signal: [String: Any]) {
        guard let type = signal["type"] as? String else {
            return
        }

        switch type {
        case "answer":
            applyAnswer(signal, from: viewerID)
        case "candidate":
            applyRemoteCandidate(signal, from: viewerID)
        default:
            logger.warning("Unsupported signal type from viewer \(viewerID, privacy: .public): \(type, privacy: .public)")
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
                self.closePeerConnection(for: viewerID)
                return
            }

            viewerPeer.hasRemoteDescription = true
            let pendingCandidates = viewerPeer.pendingCandidates
            viewerPeer.pendingCandidates.removeAll()
            for candidate in pendingCandidates {
                viewerPeer.peerConnection.add(candidate)
            }

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
            viewerPeer.peerConnection.add(candidate)
        } else {
            viewerPeer.pendingCandidates.append(candidate)
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
            return
        }

        task.send(.string(payload)) { [weak self] error in
            if let error {
                self?.logger.error("Failed to send signal to \(targetID, privacy: .public): \(error.localizedDescription, privacy: .public)")
                self?.updateDiagnostics(status: "信令发送失败", error: error.localizedDescription)
            }
        }
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
            startPeerConnection(for: viewerID)
        case "viewer_left":
            guard let viewerID = json["viewerId"] as? String else {
                return
            }
            logger.log("Viewer left: \(viewerID, privacy: .public)")
            closePeerConnection(for: viewerID)
        case "signal":
            guard let viewerID = json["sourceId"] as? String,
                  let signal = json["signal"] as? [String: Any]
            else {
                return
            }
            receiveSignal(from: viewerID, signal: signal)
        case "room_state":
            let viewerCount = json["viewerCount"] as? Int ?? 0
            if viewerCount == 0 {
                updateDiagnostics(status: "已连接信令服务，等待查看端")
            }
        case "warning":
            let warning = json["message"] as? String ?? "未知警告"
            updateDiagnostics(status: "服务端警告", error: warning)
            logger.warning("Server warning: \(warning, privacy: .public)")
        case "error":
            let errorMessage = json["message"] as? String ?? "未知错误"
            updateDiagnostics(status: "服务端返回错误", error: errorMessage)
            logger.error("Server error: \(errorMessage, privacy: .public)")
        case "publisher_left":
            updateDiagnostics(status: "发布端已断开")
        default:
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

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        logger.log("WebSocket opened")
        updateDiagnostics(status: "WebRTC 信令已打开")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        logger.log("WebSocket closed with code \(closeCode.rawValue), reason: \(reasonText, privacy: .public)")
        updateDiagnostics(status: "WebSocket 已关闭", error: reasonText)
    }
}

extension SampleHandler: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
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

        switch newState {
        case .failed, .closed, .disconnected:
            logger.warning("ICE connection ended for \(viewerID, privacy: .public) with state \(String(describing: newState), privacy: .public)")
            closePeerConnection(for: viewerID)
        default:
            break
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard let viewerID = peerConnectionToViewerID[ObjectIdentifier(peerConnection)] else {
            return
        }

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
        dataChannel.delegate = self
        if let viewerID = peerConnectionToViewerID[ObjectIdentifier(peerConnection)] {
            dataChannelToViewerID[ObjectIdentifier(dataChannel)] = viewerID
        }
    }
}

extension SampleHandler: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        guard let viewerID = dataChannelToViewerID[ObjectIdentifier(dataChannel)] else {
            return
        }

        switch dataChannel.readyState {
        case .open:
            logger.log("Data channel opened for \(viewerID, privacy: .public)")
            updateDiagnostics(status: "WebRTC 数据通道已连接")
        case .closed:
            logger.log("Data channel closed for \(viewerID, privacy: .public)")
            closePeerConnection(for: viewerID)
        default:
            break
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    }
}