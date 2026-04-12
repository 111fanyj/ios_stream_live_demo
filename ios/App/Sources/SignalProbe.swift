import Foundation
import Observation

@MainActor
@Observable
final class SignalProbe {
    enum ProbeState: String {
        case idle = "未连接"
        case connecting = "连接中"
        case connected = "已连接"
        case disconnected = "已断开"
        case failed = "失败"
    }

    private(set) var state: ProbeState = .idle
    private(set) var logs: [String] = ["等待主动连接..."]

    var isConnectedOrConnecting: Bool {
        state == .connecting || state == .connected
    }

    private var session: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private let isoFormatter = ISO8601DateFormatter()

    func connect(configuration: StreamConfiguration) {
        disconnect(resetLogs: false, reason: "开始新的主动诊断连接")
        logs.removeAll()

        let trimmedServerURL = configuration.serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedRoomID = configuration.roomID.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedServerURL.isEmpty else {
            state = .failed
            appendLog("服务端地址为空")
            return
        }

        guard !trimmedRoomID.isEmpty else {
            state = .failed
            appendLog("房间 ID 为空")
            return
        }

        let normalizedConfiguration = StreamConfiguration(
            serverURL: trimmedServerURL,
            roomID: trimmedRoomID,
            token: configuration.token.trimmingCharacters(in: .whitespacesAndNewlines)
        )

        guard let url = buildProbeURL(configuration: normalizedConfiguration) else {
            state = .failed
            appendLog("服务端地址格式无效: \(trimmedServerURL)")
            return
        }

        state = .connecting
        appendLog("准备连接 probe WebSocket: \(url.absoluteString)")

        let session = URLSession(configuration: .default, delegate: ProbeDelegate(owner: self), delegateQueue: nil)
        self.session = session

        let task = session.webSocketTask(with: url)
        webSocketTask = task
        task.resume()
        receiveLoop(for: task)
    }

    func disconnect(resetLogs: Bool = false, reason: String = "手动断开") {
        if resetLogs {
            logs = ["等待主动连接..."]
        }

        if webSocketTask != nil || session != nil {
            appendLog("断开 probe WebSocket: \(reason)")
        }

        stopPingLoop()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil

        if state != .idle {
            state = .disconnected
        }
    }

    func clearLogs() {
        logs = ["等待主动连接..."]
    }

    private func buildProbeURL(configuration: StreamConfiguration) -> URL? {
        guard var components = URLComponents(string: configuration.serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }

        if components.scheme == "http" {
            components.scheme = "ws"
        }

        if components.scheme == "https" {
            components.scheme = "wss"
        }

        var queryItems = components.queryItems ?? []
        queryItems.removeAll { item in
            ["type", "roomId", "token"].contains(item.name)
        }
        queryItems.append(URLQueryItem(name: "type", value: "probe"))
        queryItems.append(URLQueryItem(name: "roomId", value: configuration.roomID))
        if !configuration.token.isEmpty {
            queryItems.append(URLQueryItem(name: "token", value: configuration.token))
        }
        components.queryItems = queryItems
        return components.url
    }

    private func receiveLoop(for task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, self.webSocketTask === task else {
                    return
                }

                switch result {
                case .success(let message):
                    self.handle(message: message)
                    self.receiveLoop(for: task)
                case .failure(let error):
                    self.stopPingLoop()
                    self.state = .failed
                    self.appendLog("接收失败: \(error.localizedDescription)")
                }
            }
        }
    }

    private func handle(message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            appendLog("收到消息: \(text)")
            updateState(from: text)
        case .data(let data):
            appendLog("收到二进制消息: \(data.count) bytes")
        @unknown default:
            appendLog("收到未知消息类型")
        }
    }

    private func updateState(from text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else {
            return
        }

        switch type {
        case "probe_ready":
            state = .connected
            appendLog("probe_ready: hasPublisher=\(json["hasPublisher"] as? Bool ?? false) viewerCount=\(json["viewerCount"] as? Int ?? 0)")
        case "room_state":
            state = .connected
            appendLog("room_state: hasPublisher=\(json["hasPublisher"] as? Bool ?? false) viewerCount=\(json["viewerCount"] as? Int ?? 0) probeCount=\(json["probeCount"] as? Int ?? 0)")
        case "warning":
            appendLog("服务端警告: \((json["message"] as? String) ?? "")")
        case "error":
            state = .failed
            appendLog("服务端错误: \((json["message"] as? String) ?? "")")
        default:
            appendLog("未特殊处理的消息类型: \(type)")
        }
    }

    private func appendLog(_ message: String) {
        let timestamp = isoFormatter.string(from: Date())
        logs.append("[\(timestamp)] \(message)")
        if logs.count > 40 {
            logs.removeFirst(logs.count - 40)
        }
    }

    private func startPingLoop() {
        stopPingLoop()

        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in
            guard let self, let task = self.webSocketTask else {
                return
            }

            task.sendPing { [weak self] error in
                Task { @MainActor [weak self] in
                    guard let self else {
                        return
                    }

                    if let error {
                        self.appendLog("WebSocket ping 失败: \(error.localizedDescription)")
                    }
                }
            }
        }

        pingTimer = timer
        RunLoop.main.add(timer, forMode: .common)
        appendLog("已启动 WebSocket 保活 ping")
    }

    private func stopPingLoop() {
        pingTimer?.invalidate()
        pingTimer = nil
    }

    fileprivate func didOpen() {
        state = .connected
        appendLog("WebSocket 已打开")
        startPingLoop()
    }

    fileprivate func didClose(code: URLSessionWebSocketTask.CloseCode, reason: String) {
        stopPingLoop()
        state = .disconnected
        appendLog("WebSocket 已关闭 code=\(code.rawValue) reason=\(reason.isEmpty ? "<empty>" : reason)")
    }

    fileprivate func didFail(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }

        stopPingLoop()
        state = .failed
        appendLog("连接失败: \(error.localizedDescription)")
    }
}

private final class ProbeDelegate: NSObject, URLSessionWebSocketDelegate {
    weak var owner: SignalProbe?

    init(owner: SignalProbe) {
        self.owner = owner
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor [weak owner] in
            owner?.didOpen()
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        Task { @MainActor [weak owner] in
            owner?.didClose(code: closeCode, reason: reasonText)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else {
            return
        }

        Task { @MainActor [weak owner] in
            owner?.didFail(error)
        }
    }
}