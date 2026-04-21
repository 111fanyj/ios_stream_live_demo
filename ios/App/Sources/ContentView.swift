import Network
import SwiftUI
import UIKit

struct ContentView: View {
    @State private var configuration = StreamConfiguration.load()
    @State private var diagnostics = StreamDiagnostics.load()
    @State private var signalProbe = SignalProbe()
    @State private var automationPackageManager = AutomationPackageManager()
    @State private var automationPackageID = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier)?.string(forKey: StreamDefaults.automationPackageIDKey) ?? "demo"
    @State private var isSaved = false
    @State private var connectionTestResult = "未测试"
    @State private var isTestingConnection = false
    @State private var localNetworkPermissionResult = "未请求"
    @State private var isRequestingLocalNetworkPermission = false
    @State private var replayFrameOCRQuery = ""
    @State private var replayFrameOCRStatus = "尚未识别"
    @State private var replayFrameOCRResult: ReplayFrameOCRResult?
    @State private var isRunningReplayFrameOCR = false
    private let diagnosticsDateFormatter = ISO8601DateFormatter()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("iOS 实时屏幕推流")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                        Text("先保存服务端地址，再通过系统屏幕录制入口启动 Broadcast Extension。扩展会通过 WebRTC 视频轨道把屏幕画面直接推给网页查看端。")
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        Text("推流配置")
                            .font(.headline)

                        TextField("http://192.168.1.10:3000", text: $configuration.serverURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)

                        TextField("房间 ID", text: $configuration.roomID)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)

                        SecureField("Token，可选", text: $configuration.token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)

                        Button("保存到广播扩展") {
                            configuration.save()
                            isSaved = true
                            refreshDiagnostics()
                        }
                        .buttonStyle(.borderedProminent)

                        if isSaved {
                            Text("已保存。接下来从控制中心长按屏幕录制，选择 IOSStreamViewer 后开始广播。")
                                .font(.footnote)
                                .foregroundStyle(.green)
                        }

                        Button(isTestingConnection ? "正在测试服务端..." : "测试服务端连通性") {
                            Task {
                                await testServerConnection()
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(isTestingConnection)

                        Text("连通性测试: \(connectionTestResult)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        Button(isRequestingLocalNetworkPermission ? "正在请求本地网络权限..." : "请求本地网络权限") {
                            Task {
                                await requestLocalNetworkPermission()
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(isRequestingLocalNetworkPermission)

                        Text("本地网络权限: \(localNetworkPermissionResult)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        Button("打开系统设置") {
                            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                                return
                            }
                            UIApplication.shared.open(url)
                        }
                        .buttonStyle(.bordered)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("主动信令诊断")
                            .font(.headline)

                        Text("这个按钮直接从主 App 发起 probe WebSocket 连接，不依赖屏幕广播扩展，也不会参与实际 WebRTC 推流。")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)

                        Text("连接状态: \(signalProbe.state.rawValue)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        HStack {
                            Button(signalProbe.isConnectedOrConnecting ? "断开主动连接" : "主动连接信令服务") {
                                if signalProbe.isConnectedOrConnecting {
                                    signalProbe.disconnect(reason: "用户手动断开")
                                } else {
                                    signalProbe.connect(configuration: configuration)
                                }
                            }
                            .buttonStyle(.borderedProminent)

                            Button("清空主动诊断日志") {
                                signalProbe.clearLogs()
                            }
                            .buttonStyle(.bordered)
                        }

                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(signalProbe.logs.enumerated()), id: \.offset) { _, logLine in
                                    Text(logLine)
                                        .font(.caption)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                        .frame(minHeight: 120, maxHeight: 220)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("自动化方案")
                            .font(.headline)

                        Text("主 App 负责从服务端下载方案 ZIP，并缓存到 App Group。Broadcast Extension 启动后会读取 active package 本地执行。")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)

                        TextField("Package ID，例如 demo", text: $automationPackageID)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)

                        HStack {
                            Button(automationPackageManager.isLoadingPackageList ? "正在获取列表..." : "获取可用方案列表") {
                                Task {
                                    await automationPackageManager.getList(serverURL: configuration.serverURL)
                                }
                            }
                            .buttonStyle(.bordered)
                            .disabled(automationPackageManager.isLoadingPackageList)

                            Button(automationPackageManager.isDownloading ? "正在下载方案..." : "下载并设为 active package") {
                                Task {
                                    await automationPackageManager.downloadLatest(
                                        serverURL: configuration.serverURL,
                                        packageId: automationPackageID
                                    )
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(automationPackageManager.isDownloading)
                        }

                        if !automationPackageManager.availablePackages.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("可用方案")
                                    .font(.subheadline)
                                    .foregroundStyle(.primary)

                                ForEach(automationPackageManager.availablePackages) { package in
                                    Button {
                                        automationPackageID = package.packageId
                                    } label: {
                                        HStack {
                                            Text(package.latestSummary)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                            Text("选择")
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                        }

                        Text("Active package: \(automationPackageManager.activeSummary)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        Text("方案状态: \(automationPackageManager.status)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("扩展诊断")
                                .font(.headline)

                            Spacer()

                            Button("刷新") {
                                refreshDiagnostics()
                            }
                            .buttonStyle(.bordered)
                        }

                        Text("链路判断: \(broadcastDiagnosticSummary)")
                            .foregroundStyle(.primary)

                        Text("扩展运行状态: \(extensionRuntimeSummary)")
                        Text("状态: \(diagnostics.status)")
                        Text("广播启动时间: \(diagnostics.broadcastStartedAt.isEmpty ? "暂无" : diagnostics.broadcastStartedAt)")
                        Text("扩展心跳: \(diagnostics.extensionHeartbeatAt.isEmpty ? "暂无" : diagnostics.extensionHeartbeatAt)")
                        Text("最近更新时间: \(diagnostics.updatedAt.isEmpty ? "暂无" : diagnostics.updatedAt)")
                        Text("最近 sample: \(sampleSummaryText)")
                        Text("视频 sample 数: \(diagnostics.videoSampleCount)")
                        Text("应用音频 sample 数: \(diagnostics.appAudioSampleCount)")
                        Text("麦克风 sample 数: \(diagnostics.micAudioSampleCount)")
                        Text("已提交视频帧数: \(diagnostics.encodedFrameCount)")
                        Text("最后提交时间: \(diagnostics.lastEncodedFrameAt.isEmpty ? "暂无" : diagnostics.lastEncodedFrameAt)")
                        Text("已发送帧数: \(diagnostics.sentFrameCount)")
                        Text("最后一帧时间: \(diagnostics.lastFrameAt.isEmpty ? "暂无" : diagnostics.lastFrameAt)")
                        Text("最后错误: \(diagnostics.lastError.isEmpty ? "无" : diagnostics.lastError)")

                        if diagnostics.recentEvents.isEmpty {
                            Text("最近事件: 暂无")
                        } else {
                            Text("最近事件")
                                .font(.subheadline)
                                .foregroundStyle(.primary)

                            ForEach(Array(diagnostics.recentEvents.enumerated()), id: \.offset) { _, event in
                                Text(event)
                                    .font(.caption)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 12) {
                        Text("最新画面 OCR 调试")
                            .font(.headline)

                        Text("输入要查找的文字后点击识别。主 App 会读取 Broadcast Extension 最近写入 App Group 的 replay 画面截图，本地执行 OCR，并把命中的位置框出来。留空则直接展示当前截图里的全部 OCR 结果。")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)

                        TextField("例如 企业微信；留空则展示全部 OCR", text: $replayFrameOCRQuery)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)

                        HStack {
                            Button(isRunningReplayFrameOCR ? "正在识别最新画面..." : "识别最新画面") {
                                runReplayFrameOCR()
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isRunningReplayFrameOCR)

                            Button("清空结果") {
                                replayFrameOCRResult = nil
                                replayFrameOCRStatus = "尚未识别"
                            }
                            .buttonStyle(.bordered)
                        }

                        Text("最新截图时间: \(latestReplayFrameSummaryText)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        Text("识别状态: \(replayFrameOCRStatus)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        if let result = replayFrameOCRResult {
                            Text("截图尺寸: \(Int(result.imageSize.width)) x \(Int(result.imageSize.height))")
                                .font(.footnote)
                                .foregroundStyle(.secondary)

                            Image(uiImage: result.annotatedImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 16)
                                        .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                                }

                            if !result.matches.isEmpty {
                                Text("命中文字")
                                    .font(.subheadline)
                                ForEach(result.matches.prefix(12)) { candidate in
                                    Text("\(candidate.text) / 置信度 \(formatConfidence(candidate.confidence))")
                                        .font(.caption)
                                        .textSelection(.enabled)
                                }
                            }

                            if !result.candidates.isEmpty {
                                Text(result.matches.isEmpty ? "OCR 识别到的文字" : "完整 OCR 结果")
                                    .font(.subheadline)
                                ForEach(result.candidates.prefix(20)) { candidate in
                                    Text("\(candidate.text) / 置信度 \(formatConfidence(candidate.confidence))")
                                        .font(.caption)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("启动直播")
                            .font(.headline)
                        Text("优先用下面这个系统广播按钮测试。它会直接指定当前 App 对应的 Broadcast Extension。")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)

                        Text("扩展 Bundle ID: " + (StreamDefaults.broadcastExtensionBundleIdentifier ?? "无法解析"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        BroadcastPickerButton()
                            .frame(height: 50)
                            .background(
                                RoundedRectangle(cornerRadius: 14)
                                    .fill(Color.orange)
                            )
                            .overlay {
                                Text("打开系统广播选择器")
                                    .foregroundStyle(.white)
                                    .fontWeight(.semibold)
                                    .allowsHitTesting(false)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("使用说明")
                            .font(.headline)

                        Text("1. 手机与服务端保持网络可达。")
                        Text("2. 先保存服务端地址，例如 http://你的电脑IP:3000。")
                        Text("3. 浏览器打开服务端首页，填同一个房间 ID，页面会通过 WebRTC 等待发布端。")
                        Text("4. 长按系统屏幕录制按钮，选择 IOSStreamViewer 并开始广播。")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                .padding(24)
            }
            .navigationTitle("Stream Viewer")
            .onAppear {
                refreshDiagnostics()
                automationPackageManager.refreshActiveSummary()
            }
            .task {
                while !Task.isCancelled {
                    refreshDiagnostics()
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
    }

    private var sampleSummaryText: String {
        guard !diagnostics.lastSampleAt.isEmpty else {
            return "暂无"
        }

        let sampleType = diagnostics.lastSampleType.isEmpty ? "unknown" : diagnostics.lastSampleType
        return "\(sampleType) / \(diagnostics.lastSampleAt)"
    }

    private var extensionRuntimeSummary: String {
        guard !diagnostics.broadcastStartedAt.isEmpty else {
            return "未看到广播扩展启动"
        }

        guard let heartbeatDate = diagnosticsDateFormatter.date(from: diagnostics.extensionHeartbeatAt) else {
            return "已启动，但没有可用心跳时间"
        }

        let age = Date().timeIntervalSince(heartbeatDate)
        if age <= 5 {
            return "扩展运行中"
        }

        return "扩展最近没有心跳，可能已退出或挂起"
    }

    private var broadcastDiagnosticSummary: String {
        guard !diagnostics.broadcastStartedAt.isEmpty else {
            return "还没有检测到广播扩展启动；先确认系统广播面板里已真正开始广播。"
        }

        if diagnostics.videoSampleCount == 0 {
            return "扩展已启动，但还没有收到任何视频 sample buffer；说明 ReplayKit 还没有把屏幕帧送进 processSampleBuffer(.video)。"
        }

        if diagnostics.encodedFrameCount == 0 {
            return "已经收到视频 sample buffer，但还没有开始提交到 WebRTC 视频源；问题在视频帧处理阶段。"
        }

        if diagnostics.sentFrameCount == 0 {
            return "已经开始向 WebRTC 视频轨道提交帧，但还没有形成稳定下行；通常是查看端尚未完成 WebRTC 视频连接。"
        }

        return "广播扩展已经收到视频数据，并且正在通过 WebRTC 视频轨道向查看端发送画面。"
    }

    private var latestReplayFrameSummaryText: String {
        guard let imageURL = StreamDefaults.latestReplayFrameURL(), FileManager.default.fileExists(atPath: imageURL.path) else {
            return "暂无可用截图"
        }

        let defaults = UserDefaults(suiteName: StreamDefaults.appGroupIdentifier)
        let timestamp = defaults?.string(forKey: StreamDefaults.latestReplayFrameUpdatedAtKey) ?? ""
        return timestamp.isEmpty ? "文件已存在，但还没有时间戳" : timestamp
    }

    private func refreshDiagnostics() {
        diagnostics = StreamDiagnostics.load()
    }

    private func runReplayFrameOCR() {
        let query = replayFrameOCRQuery
        isRunningReplayFrameOCR = true
        replayFrameOCRStatus = "正在读取最新截图并执行 OCR..."

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let result = try ReplayFrameOCRInspector.inspectLatestFrame(query: query)
                let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
                let status: String
                if trimmedQuery.isEmpty {
                    status = "OCR 完成，共识别 \(result.candidates.count) 条文本"
                } else if result.matches.isEmpty {
                    status = "没有命中“\(trimmedQuery)”，OCR 共识别 \(result.candidates.count) 条文本"
                } else {
                    status = "命中“\(trimmedQuery)”共 \(result.matches.count) 条"
                }

                DispatchQueue.main.async {
                    replayFrameOCRResult = result
                    replayFrameOCRStatus = status
                    isRunningReplayFrameOCR = false
                }
            } catch {
                DispatchQueue.main.async {
                    replayFrameOCRResult = nil
                    replayFrameOCRStatus = error.localizedDescription
                    isRunningReplayFrameOCR = false
                }
            }
        }
    }

    private func formatConfidence(_ confidence: Float) -> String {
        String(format: "%.3f", confidence)
    }

    private func testServerConnection() async {
        isTestingConnection = true
        defer { isTestingConnection = false }

        guard let healthURL = healthCheckURL(from: configuration.serverURL) else {
            connectionTestResult = "地址格式无效"
            return
        }

        do {
            let (data, response) = try await URLSession.shared.data(from: healthURL)
            guard let httpResponse = response as? HTTPURLResponse else {
                connectionTestResult = "服务端响应无效"
                return
            }

            let body = String(data: data, encoding: .utf8) ?? ""
            connectionTestResult = "HTTP \(httpResponse.statusCode) \(body.prefix(80))"
        } catch {
            connectionTestResult = mapConnectionError(error)
        }
    }

    private func requestLocalNetworkPermission() async {
        isRequestingLocalNetworkPermission = true
        defer { isRequestingLocalNetworkPermission = false }

        let result = await LocalNetworkAuthorizer.requestAuthorization()
        switch result {
        case .granted:
            localNetworkPermissionResult = "已允许"
        case .denied:
            localNetworkPermissionResult = "已拒绝，请去系统设置开启“本地网络”"
        case .failed(let message):
            localNetworkPermissionResult = message
        }
    }

    private func mapConnectionError(_ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorNotConnectedToInternet {
            return "本地网络被系统拒绝。先点“请求本地网络权限”；如果此前拒绝过，请去系统设置开启 IOSStreamViewer 的“本地网络”。"
        }

        return error.localizedDescription
    }

    private func healthCheckURL(from serverURL: String) -> URL? {
        guard var components = URLComponents(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }

        if components.scheme == "ws" {
            components.scheme = "http"
        }

        if components.scheme == "wss" {
            components.scheme = "https"
        }

        components.queryItems = nil
        components.path = "/health"
        return components.url
    }
}

private enum LocalNetworkAuthorizationResult {
    case granted
    case denied
    case failed(String)
}

private final class LocalNetworkAuthorizationState: @unchecked Sendable {
    private let lock = NSLock()
    private var hasFinished = false

    func markFinished() -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard !hasFinished else {
            return false
        }

        hasFinished = true
        return true
    }
}

private enum LocalNetworkAuthorizer {
    static func requestAuthorization() async -> LocalNetworkAuthorizationResult {
        await withCheckedContinuation { continuation in
            let serviceType = "_iosstreamviewer._tcp"
            let parameters = NWParameters.tcp
            parameters.includePeerToPeer = true

            let listener: NWListener
            do {
                listener = try NWListener(using: parameters)
            } catch {
                continuation.resume(returning: .failed("无法创建本地网络监听: \(error.localizedDescription)"))
                return
            }

            let browser = NWBrowser(for: .bonjour(type: serviceType, domain: nil), using: parameters)
            let queue = DispatchQueue(label: "IOSStreamViewer.LocalNetworkAuthorization")
            let state = LocalNetworkAuthorizationState()

            let finish: @Sendable (LocalNetworkAuthorizationResult) -> Void = { result in
                guard state.markFinished() else {
                    return
                }

                browser.cancel()
                listener.cancel()
                continuation.resume(returning: result)
            }

            listener.service = NWListener.Service(name: UUID().uuidString, type: serviceType)
            listener.newConnectionHandler = { connection in
                connection.cancel()
            }
            listener.stateUpdateHandler = { state in
                if case .failed(let error) = state {
                    finish(.failed("监听失败: \(error.localizedDescription)"))
                }
            }

            browser.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(.granted)
                case .failed(let error):
                    if isPolicyDenied(error) {
                        finish(.denied)
                    } else {
                        finish(.failed("浏览失败: \(error.localizedDescription)"))
                    }
                default:
                    break
                }
            }
            browser.browseResultsChangedHandler = { _, _ in
                finish(.granted)
            }

            listener.start(queue: queue)
            browser.start(queue: queue)

            queue.asyncAfter(deadline: .now() + 8) {
                finish(.failed("未收到系统权限结果，请检查设置中的“本地网络”"))
            }
        }
    }

    private static func isPolicyDenied(_ error: NWError) -> Bool {
        switch error {
        case .dns(let dnsError):
            return dnsError == -65570
        default:
            return false
        }
    }
}

#Preview {
    ContentView()
}
