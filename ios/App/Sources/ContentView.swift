import Network
import SwiftUI
import UIKit

struct ContentView: View {
    @State private var configuration = StreamConfiguration.load()
    @State private var diagnostics = StreamDiagnostics.load()
    @State private var isSaved = false
    @State private var connectionTestResult = "未测试"
    @State private var isTestingConnection = false
    @State private var localNetworkPermissionResult = "未请求"
    @State private var isRequestingLocalNetworkPermission = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("iOS 实时屏幕推流")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                        Text("先保存服务端地址，再通过系统屏幕录制入口启动 Broadcast Extension。扩展会通过 WebRTC DataChannel 把屏幕帧发给网页查看端。")
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

                        Text("状态: \(diagnostics.status)")
                        Text("最近更新时间: \(diagnostics.updatedAt.isEmpty ? "暂无" : diagnostics.updatedAt)")
                        Text("已发送帧数: \(diagnostics.sentFrameCount)")
                        Text("最后一帧时间: \(diagnostics.lastFrameAt.isEmpty ? "暂无" : diagnostics.lastFrameAt)")
                        Text("最后错误: \(diagnostics.lastError.isEmpty ? "无" : diagnostics.lastError)")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

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
            }
        }
    }

    private func refreshDiagnostics() {
        diagnostics = StreamDiagnostics.load()
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