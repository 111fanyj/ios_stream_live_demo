# IOS Stream Viewer

这是一个最小可用方案：

- iOS 主 App 负责配置服务器地址并触发系统屏幕广播。
- ReplayKit Broadcast Upload Extension 抓取当前屏幕画面。
- Node.js 服务端通过 WebSocket 接收帧并转发给浏览器查看端。

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
2. 主 App 中填写 `ws://你的电脑IP:3000`。
3. 填写相同的房间 ID，点击保存。
4. 浏览器打开服务端页面并填写相同房间 ID。
5. iPhone 打开控制中心，长按“屏幕录制”，选择 `IOSStreamViewer`，点击开始广播。
6. 浏览器中即可看到实时画面。

## 5. 当前实现说明

这是一个为了尽快跑通链路的版本：

- 传输格式不是 H.264/WebRTC，而是 JPEG 帧流。
- 优点是实现简单，便于验证 ReplayKit 到服务端的整条链路。
- 缺点是带宽更高，延迟和流畅度不如真正的视频编码方案。

如果你后续要升级为生产可用版本，建议下一步替换为：

- iOS 端使用 VideoToolbox 编码 H.264
- 服务端改成 WebRTC SFU 或 RTMP/WebRTC 网关
- 浏览器端使用 `<video>` 实时播放而不是 `<img>` 刷帧