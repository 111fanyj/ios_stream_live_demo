import CoreImage
import ReplayKit
import UIKit

final class SampleHandler: RPBroadcastSampleHandler {
    private let ciContext = CIContext(options: nil)
    private var webSocketTask: URLSessionWebSocketTask?
    private var sequenceNumber = 0
    private var lastSentAt = Date.distantPast
    private let minimumSendInterval: TimeInterval = 0.12

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard let configuration = loadConfiguration() else {
            finishBroadcastWithError(NSError(domain: "IOSStreamViewer", code: -1, userInfo: [NSLocalizedDescriptionKey: "无法读取共享配置，请先在主 App 中保存服务端地址"]))
            return
        }

        guard let url = buildPublisherURL(configuration: configuration) else {
            finishBroadcastWithError(NSError(domain: "IOSStreamViewer", code: -2, userInfo: [NSLocalizedDescriptionKey: "服务端地址无效"] ))
            return
        }

        let session = URLSession(configuration: .default)
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
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
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
                self?.finishBroadcastWithError(error)
            }
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
            case .success:
                self?.receiveLoop(for: task)
            case .failure(let error):
                self?.finishBroadcastWithError(error)
            }
        }
    }
}