import Foundation
import CoreImage
import OSLog
import ReplayKit
import UIKit

final class SampleHandler: RPBroadcastSampleHandler, URLSessionWebSocketDelegate {
    private let ciContext = CIContext(options: nil)
    private let logger = Logger(subsystem: "IOSStreamViewer", category: "BroadcastUploadExtension")
    private var webSocketSession: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var sequenceNumber = 0
    private var lastSentAt = Date.distantPast
    private let minimumSendInterval: TimeInterval = 0.12

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        updateDiagnostics(status: "广播启动中")

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

        guard let task = webSocketTask,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let payload = makeFramePayload(from: pixelBuffer)
        else {
            return
        }

        lastSentAt = now
        task.send(.string(payload)) { [weak self] error in
            if let error {
                self?.logger.error("Failed to send frame: \(error.localizedDescription, privacy: .public)")
                self?.updateDiagnostics(status: "发送帧失败", error: error.localizedDescription)
                self?.finishBroadcastWithError(error)
                return
            }

            self?.updateDiagnostics(
                status: "推流中",
                sentFrameCount: self?.sequenceNumber,
                lastFrameAt: ISO8601DateFormatter().string(from: Date())
            )
        }
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
            updateDiagnostics(status: "已连接到服务端")
            logger.log("Publisher is ready")
        case "warning":
            let warning = json["message"] as? String ?? "未知警告"
            updateDiagnostics(status: "服务端警告", error: warning)
            logger.warning("Server warning: \(warning, privacy: .public)")
        case "error":
            let errorMessage = json["message"] as? String ?? "未知错误"
            updateDiagnostics(status: "服务端返回错误", error: errorMessage)
            logger.error("Server error: \(errorMessage, privacy: .public)")
        default:
            break
        }
    }

    private func updateDiagnostics(status: String, error: String? = nil, sentFrameCount: Int? = nil, lastFrameAt: String? = nil) {
        guard let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier) else {
            return
        }

        defaults.set(status, forKey: StreamDefaults.diagnosticsStatusKey)
        defaults.set(ISO8601DateFormatter().string(from: Date()), forKey: StreamDefaults.diagnosticsUpdatedAtKey)

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
        updateDiagnostics(status: "WebSocket 已打开")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        logger.log("WebSocket closed with code \(closeCode.rawValue), reason: \(reasonText, privacy: .public)")
        updateDiagnostics(status: "WebSocket 已关闭", error: reasonText)
    }
}