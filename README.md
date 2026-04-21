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

浏览器首页现在同时承担方案编辑和远程执行入口：

1. 连接同一个房间并看到 iOS 画面。
2. 在“方案编辑”里添加 `waitForText`、`waitForImage`、`tap`、`drag` 动作。
3. 图片识别可以上传 PNG，也可以从当前视频帧按归一化区域截取模板。
4. 点击“保存并发布 ZIP”，服务端会保存 `automation.json` 和 `images/`。
5. 在“方案执行”里选择 package 和 revision，点击“开始执行”。
6. 服务端会按步骤编排流程：
	- 对 `waitForText`、`waitForImage`，通过 WebSocket 向 iOS Broadcast Extension 下发 `startCheckItem`、`checkNextItem`、`StopCheck` 等命令。
	- iOS 端只返回 OCR 候选结果或图片匹配结果，不再在手机本地推进整条步骤逻辑。
	- 服务端根据返回的基础数据完成匹配、变量保存、步骤推进和超时控制。
7. 对 `tap`、`drag` 这类交互命令，服务端现在会把动作转发给独立的 `executor` 客户端；推荐用 `esp32_c3_gpt5.4/tools/hid_room_bridge.py` 通过 USB 串口控制 ESP32，再由 ESP32 作为 BLE HID 真实操作 iPhone。
8. 服务端只有在收到 `executor_result=ok` 之后才会推进到下一步，从而形成“动作执行 -> 屏幕观察 -> 结果确认”的闭环。

## 6. 当前实现说明

这是一个以“远程编排”为主的演示版本：

- 服务端负责房间管理、鉴权、WebRTC 信令转发，以及自动化流程编排。
- iOS Broadcast Extension 保留视频推流与基础检查原语，按 server 命令执行 OCR 或图片匹配。
- 真实点击、拖拽由独立 executor 执行，当前推荐实现是 ESP32 BLE HID + USB 串口 bridge。
- Web 前端可以选择方案并开始、停止执行，同时继续保留编辑和发布 ZIP 的能力。
- 浏览器工作台会显示 publisher、executor 是否在线，以及最近一次动作请求和动作结果。

如果你后续要升级为生产可用版本，建议下一步替换为：

- iOS 端使用 `RTCVideoSource` 或 VideoToolbox 输出真正的视频轨
- 服务端改成 WebRTC SFU 或接入现成媒体服务器
- 浏览器端改用 `<video>` 播放 MediaStream，而不是接收 DataChannel 中的 JPEG 帧
