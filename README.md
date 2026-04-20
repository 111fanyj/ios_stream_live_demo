# IOS Stream Viewer

这是一个最小可用方案：

- iOS 主 App 负责配置服务器地址并触发系统屏幕广播。
- ReplayKit Broadcast Upload Extension 抓取当前屏幕画面。
- Node.js 服务端通过 WebSocket 转发 WebRTC 信令。
- Broadcast Extension 与浏览器查看端通过 WebRTC DataChannel 点对点传输 JPEG 帧。

## 项目结构

- `server/`: Node.js 服务端和查看网页。
- `ios/`: 使用 XcodeGen 描述的 iOS App + Broadcast Extension 工程。

## 1. 启动服务端

```bash
npm install
npm start
```

默认启动在 `http://0.0.0.0:3000`。

可选安全项：

```bash
STREAM_TOKEN=your-token npm start
```

浏览器打开：

- `http://你的电脑IP:3000/`

## 2. 生成 iOS 工程

需要本机安装 XcodeGen：

```bash
brew install xcodegen
cd ios
xcodegen generate
open IOSStreamViewer.xcodeproj
```

首次生成工程时，Xcode 会解析 `WebRTC` Swift Package，请保持网络可用。

## 3. iOS 侧必须修改的配置

当前仓库使用的是示例标识，首次打开工程后请修改：

- App 的 Bundle ID
- Broadcast Extension 的 Bundle ID
- App Group，默认值为 `group.com.example.IOSStreamViewer.shared`
- Signing Team

同时确保：

- App target 和 Extension target 都开启同一个 App Group。
- 主 App 中的 `StreamDefaults.appGroupIdentifier` 与 Extension 保持一致。

对应源码位置：

- `ios/App/Sources/StreamConfiguration.swift`
- `ios/BroadcastUploadExtension/Sources/SharedStreamConfiguration.swift`

## 4. 使用流程

1. 手机和服务端位于可互通网络。
2. 主 App 中填写 `http://你的电脑IP:3000` 或 `ws://你的电脑IP:3000`。
3. 填写相同的房间 ID，点击保存。
4. 浏览器打开服务端页面并填写相同房间 ID。
5. iPhone 打开控制中心，长按“屏幕录制”，选择 `IOSStreamViewer`，点击开始广播。
6. 服务端负责转发 offer、answer、ICE candidate 等信令。
7. 浏览器收到 DataChannel 帧后即可看到实时画面。

## 5. 自动化方案流程

浏览器首页现在也是自动化方案编辑器：

1. 连接同一个房间并看到 iOS 画面。
2. 在“方案编辑”里添加 `waitForText`、`waitForImage`、`tap`、`drag` 动作。
3. 图片识别可以上传 PNG，也可以从当前视频帧按归一化区域截取模板。
4. 点击“保存并发布 ZIP”，服务端会保存 `automation.json` 和 `images/`，并生成可下载 ZIP。
5. iOS 主 App 的“自动化方案”区域填写 Package ID，点击下载并设为 active package。
6. 下一次启动 Broadcast Extension 时，会从 App Group 读取本地 active package，用 ReplayKit 帧做本地识别，并把 tap/drag 命令先发送回网页显示。

第一版不会注入真实系统触摸，也不会直接控制硬件；网页上显示的点击点和拖拽轨迹就是后续硬件控制层要消费的归一化坐标。

## 6. 当前实现说明

这是一个为了尽快跑通 WebRTC 链路的版本：

- 服务端不再中继图像帧，只负责房间管理、鉴权和 WebRTC 信令转发。
- 实际承载仍然是 JPEG 帧，但它们现在走的是 WebRTC DataChannel。
- 优点是改造量小，先把传输层切到 WebRTC，便于继续向真正的视频轨演进。
- 缺点是带宽和流畅度仍然受 JPEG 编码限制，尚未切换到 H.264/VP8 等实时视频编码。

如果你后续要升级为生产可用版本，建议下一步替换为：

- iOS 端使用 `RTCVideoSource` 或 VideoToolbox 输出真正的视频轨
- 服务端改成 WebRTC SFU 或接入现成媒体服务器
- 浏览器端改用 `<video>` 播放 MediaStream，而不是接收 DataChannel 中的 JPEG 帧
