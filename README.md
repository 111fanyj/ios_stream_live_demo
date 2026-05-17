# IOS Stream Viewer

这是一个最小可用方案：

- iOS 主 App 负责配置服务器地址并触发系统屏幕广播。
- ReplayKit Broadcast Upload Extension 抓取当前屏幕画面。
- Node.js 服务端通过 WebSocket 转发 WebRTC 信令。
- Broadcast Extension 与浏览器查看端通过 WebRTC 视频轨点对点传输实时画面。

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

### React 前端开发态

当前仓库已经接入 React + Vite，React 工作台和 React OCR 调试页都可直接使用。现阶段仍保留旧版静态页面，作为对照和回归入口：

```bash
npm install
npm run dev
```

- Node/Express 仍在 `http://127.0.0.1:3000`
- Vite 开发服务器默认在 `http://127.0.0.1:5173`
- 新 React 工作台路由：`/`
- 新 React OCR 调试路由：`/debug-ocr`
- 旧版页面对照入口：`/legacy/` 与 `/legacy/debug-ocr.html`

说明：

- `npm start` 仍默认托管旧版静态页面。
- React 是当前主要开发入口，适合继续推进工作台和调试页功能。

如果要用 Express 直接托管 React 构建产物，先构建，再用 React 模式启动：

```bash
npm run build
npm run start:react
```

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

如果看到 `Embedded binary is not signed with the same certificate as the parent app` 或类似完整性校验错误，优先检查 App target 和 Broadcast Extension target 是否都切到了同一个本机可用的 Team，而不是继续使用仓库里的示例签名状态。

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
7. 浏览器收到 WebRTC 视频轨后即可看到实时画面。

## 5. 自动化方案流程

浏览器首页现在同时承担方案编辑和远程执行入口：

1. 连接同一个房间并看到 iOS 画面。
2. 在“方案编辑”里添加 `waitForText`、`waitForImage`、`tap`、`drag` 动作。
3. 图片识别可以上传 PNG，也可以从当前视频帧按像素区域截取模板。
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
- iOS Broadcast Extension 负责 WebRTC 视频轨推流，并按 server 命令执行 OCR 或图片匹配。
- 真实点击、拖拽由独立 executor 执行，当前推荐实现是 ESP32 BLE HID + USB 串口 bridge。
- React 工作台已经支持查看视频、叠加 overlay、截取模板、选择 revision、开始或停止执行、编辑并发布方案。
- React OCR 调试页已经支持 probe 通道、调试帧预览、OCR 候选查看、标定摘要和标定参考图叠层。
- 旧版静态页面继续保留在 `/legacy/`，便于对照 React 页面行为和做回归检查。

如果你后续要升级为生产可用版本，建议下一步替换为：

- 让 React 构建产物成为默认托管入口，逐步收缩 legacy 页面职责
- 服务端改成 WebRTC SFU 或接入现成媒体服务器
- 补齐生产级鉴权、观测和错误恢复策略
