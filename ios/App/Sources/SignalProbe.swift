import Foundation
import Observation

struct CalibrationPoint: Equatable {
    let x: Double
    let y: Double
}

struct CalibrationCommandState: Equatable {
    let sessionID: String
    let stepID: String
    let label: String
    let phase: String
    let targetFramePx: CalibrationPoint?
    let colorHex: String
    let rawMoveDX: Int?
    let rawMoveDY: Int?
}

struct CalibrationTapMarker: Equatable {
    let stepID: String
    let label: String
    let point: CalibrationPoint
    let colorHex: String
}

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
    private(set) var calibrationStatus = "标定通道未激活"
    private(set) var calibrationCommand: CalibrationCommandState?
    private(set) var isCalibrationTapArmed = false
    private(set) var isCalibrationSessionActive = false
    private(set) var lastCalibrationTap: CalibrationPoint?
    private(set) var calibrationTapMarkers: [CalibrationTapMarker] = []
    private(set) var calibrationResultSummary = "暂无标定结果"

    var isConnectedOrConnecting: Bool {
        state == .connecting || state == .connected
    }

    private var session: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private let isoFormatter = ISO8601DateFormatter()
    private var didSendCalibrationRegistration = false

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
        didSendCalibrationRegistration = false
        calibrationCommand = nil
        isCalibrationTapArmed = false
        isCalibrationSessionActive = false
        lastCalibrationTap = nil
        calibrationTapMarkers.removeAll()

        if state != .idle {
            state = .disconnected
        }
    }

    func clearLogs() {
        logs = ["等待主动连接..."]
    }

    func clearCalibrationState() {
        calibrationCommand = nil
        isCalibrationTapArmed = false
        lastCalibrationTap = nil
        calibrationTapMarkers.removeAll()
        calibrationStatus = isCalibrationSessionActive
            ? "标定进行中"
            : (state == .connected ? "标定通道已连接" : "标定通道未激活")
        calibrationResultSummary = "暂无标定结果"
        appendLog("已清空标定状态")
    }

    func reportCalibrationTap(_ point: CalibrationPoint, surfaceSize: CGSize) {
        guard state == .connected else {
            appendLog("标定点击已忽略：probe 未连接")
            return
        }

        guard let command = calibrationCommand, isCalibrationTapArmed else {
            appendLog("标定点击已忽略：当前没有待采集步骤")
            return
        }

        guard let payload = makeJSONString(from: [
            "type": "calibration_result",
            "sessionId": command.sessionID,
            "stepId": command.stepID,
            "point": [
                "x": point.x,
                "y": point.y
            ],
            "surfaceSize": [
                "width": surfaceSize.width,
                "height": surfaceSize.height
            ],
            "reportedAt": isoFormatter.string(from: Date())
        ]) else {
            appendLog("标定点击上报失败：消息序列化失败")
            return
        }

        webSocketTask?.send(.string(payload)) { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self else {
                    return
                }

                if let error {
                    self.appendLog("标定点击上报失败: \(error.localizedDescription)")
                    return
                }

                self.lastCalibrationTap = point
                self.calibrationTapMarkers.append(CalibrationTapMarker(
                    stepID: command.stepID,
                    label: command.label,
                    point: point,
                    colorHex: command.colorHex
                ))
                self.isCalibrationTapArmed = false
                self.calibrationStatus = "已上报 \(command.label) 点击: (\(format(point.x)), \(format(point.y)))"
                self.calibrationResultSummary = self.calibrationStatus
                self.appendLog("已上报标定点击 \(command.stepID): x=\(format(point.x)) y=\(format(point.y))")
            }
        }
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
            registerCalibrationRoleIfNeeded()
        case "room_state":
            state = .connected
            appendLog("room_state: hasPublisher=\(json["hasPublisher"] as? Bool ?? false) viewerCount=\(json["viewerCount"] as? Int ?? 0) probeCount=\(json["probeCount"] as? Int ?? 0) hasCalibrationApp=\(json["hasCalibrationApp"] as? Bool ?? false)")
        case "calibration_registered":
            calibrationStatus = "已注册为标定 App"
            calibrationResultSummary = "服务端已识别当前 App 可接收标定点击"
            appendLog("calibration_registered: role=app")
        case "calibration_command":
            handleCalibrationCommand(json)
        case "calibration_status":
            handleCalibrationStatus(json)
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

    private func registerCalibrationRoleIfNeeded() {
        guard !didSendCalibrationRegistration else {
            return
        }

        didSendCalibrationRegistration = true
        guard let payload = makeJSONString(from: [
            "type": "calibration_register",
            "role": "app"
        ]) else {
            appendLog("标定角色注册失败：消息序列化失败")
            return
        }

        webSocketTask?.send(.string(payload)) { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self else {
                    return
                }

                if let error {
                    self.appendLog("标定角色注册失败: \(error.localizedDescription)")
                    return
                }

                self.appendLog("已向服务端注册标定 App 角色")
            }
        }
    }

    private func handleCalibrationCommand(_ json: [String: Any]) {
        let method = json["method"] as? String ?? ""
        switch method {
        case "armTapCapture":
            guard let sessionID = json["sessionId"] as? String,
                  let stepID = json["stepId"] as? String,
                  let label = json["label"] as? String,
                  let phase = json["phase"] as? String
            else {
                appendLog("收到无效的 calibration_command")
                return
            }

            let targetFramePx = decodeCalibrationPoint(json["targetFramePx"] as? [String: Any])

            calibrationCommand = CalibrationCommandState(
                sessionID: sessionID,
                stepID: stepID,
                label: label,
                phase: phase,
                targetFramePx: targetFramePx,
                colorHex: json["color"] as? String ?? "#34c759",
                rawMoveDX: json["dx"] as? Int ?? (json["dx"] as? NSNumber)?.intValue,
                rawMoveDY: json["dy"] as? Int ?? (json["dy"] as? NSNumber)?.intValue
            )
            isCalibrationSessionActive = true
            isCalibrationTapArmed = true
            calibrationStatus = "等待采集 \(label) 点击"
            if let targetFramePx {
                calibrationResultSummary = "目标截图像素: (\(format(targetFramePx.x)), \(format(targetFramePx.y))) / phase=\(phase)"
                appendLog("calibration_command armTapCapture step=\(stepID) targetFramePx=(\(format(targetFramePx.x)), \(format(targetFramePx.y)))")
            } else {
                calibrationResultSummary = "phase=\(phase)"
                appendLog("calibration_command armTapCapture step=\(stepID)")
            }
        case "clearTapCapture":
            calibrationCommand = nil
            isCalibrationTapArmed = false
            isCalibrationSessionActive = false
            calibrationStatus = json["reason"] as? String ?? "标定采集已结束"
            appendLog("calibration_command clearTapCapture")
        default:
            appendLog("未处理的 calibration_command: \(method)")
        }
    }

    private func handleCalibrationStatus(_ json: [String: Any]) {
        let status = json["status"] as? String ?? "unknown"
        let message = json["message"] as? String ?? ""
        calibrationStatus = message.isEmpty ? status : "\(status): \(message)"

        if status == "starting" {
            calibrationTapMarkers.removeAll()
            lastCalibrationTap = nil
        }

        if ["starting", "prepared", "arming", "dispatching", "awaiting_tap", "captured", "analyzing", "solved"].contains(status) {
            isCalibrationSessionActive = true
        }

        if status == "completed" || status == "error" || status == "stopped" {
            calibrationCommand = nil
            isCalibrationTapArmed = false
            isCalibrationSessionActive = false
        }

        if let detail = json["detail"] as? [String: Any],
           let summaryData = try? JSONSerialization.data(withJSONObject: detail, options: [.prettyPrinted]),
           let summary = String(data: summaryData, encoding: .utf8) {
            calibrationResultSummary = summary
        } else {
            calibrationResultSummary = message.isEmpty ? status : message
        }

        appendLog("calibration_status: \(status) \(message)")
    }

    private func decodeCalibrationPoint(_ value: [String: Any]?) -> CalibrationPoint? {
        guard let value else {
            return nil
        }

        guard let x = value["x"] as? Double ?? (value["x"] as? NSNumber)?.doubleValue,
              let y = value["y"] as? Double ?? (value["y"] as? NSNumber)?.doubleValue
        else {
            return nil
        }

        return CalibrationPoint(x: x, y: y)
    }

    private func makeJSONString(from object: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }

    private func format(_ value: Double) -> String {
        String(format: "%.3f", value)
    }

    fileprivate func didOpen() {
        state = .connected
        appendLog("WebSocket 已打开")
        startPingLoop()
    }

    fileprivate func didClose(code: URLSessionWebSocketTask.CloseCode, reason: String) {
        stopPingLoop()
        state = .disconnected
        isCalibrationSessionActive = false
        isCalibrationTapArmed = false
        calibrationCommand = nil
        appendLog("WebSocket 已关闭 code=\(code.rawValue) reason=\(reason.isEmpty ? "<empty>" : reason)")
    }

    fileprivate func didFail(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }

        stopPingLoop()
        state = .failed
        isCalibrationSessionActive = false
        isCalibrationTapArmed = false
        calibrationCommand = nil
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
