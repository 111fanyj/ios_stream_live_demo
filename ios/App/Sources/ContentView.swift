import SwiftUI

struct ContentView: View {
    @State private var configuration = StreamConfiguration.load()
    @State private var isSaved = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("iOS 实时屏幕推流")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                        Text("先保存服务端地址，再通过系统屏幕录制入口启动 Broadcast Extension。Server 收到后可以在网页里实时查看当前画面。")
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        Text("推流配置")
                            .font(.headline)

                        TextField("ws://192.168.1.10:3000", text: $configuration.serverURL)
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
                        }
                        .buttonStyle(.borderedProminent)

                        if isSaved {
                            Text("已保存。接下来从控制中心长按屏幕录制，选择 IOSStreamViewer 后开始广播。")
                                .font(.footnote)
                                .foregroundStyle(.green)
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("启动直播")
                            .font(.headline)
                        Text("系统按钮会直接调起 ReplayKit 的广播选择器。")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)

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
                        Text("2. 先保存 ws 服务地址，例如 ws://你的电脑IP:3000。")
                        Text("3. 浏览器打开服务端首页，填同一个房间 ID。")
                        Text("4. 长按系统屏幕录制按钮，选择 IOSStreamViewer 并开始广播。")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                .padding(24)
            }
            .navigationTitle("Stream Viewer")
        }
    }
}

#Preview {
    ContentView()
}