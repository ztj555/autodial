# AutoDial PC 端 (Go/Wails 版)

基于 Go + Wails v2 的 PC 端实现，功能与 Electron 版一致。

## 技术栈

- Go 1.21+
- Wails v2 (GUI 框架)
- gorilla/websocket (WebSocket)
- golang.org/x/sys (Windows 注册表等)

## 目录结构

```
pc-app-go/
├── main.go         # Wails 应用入口
├── app.go          # Wails 绑定方法（GetInfo, SendDial, UpdateSettings 等）
├── server.go       # HTTP + WebSocket 服务器
├── devices.go      # 设备注册与管理（PIN 标识、ACK 机制、拨号队列）
├── cloud.go        # 云中继客户端连接
├── udp.go          # UDP 广播发现
├── settings.go     # JSON 持久化设置
├── logger.go       # 文件日志系统
├── tray.go         # 系统托盘（右键菜单）
├── wails.json      # Wails 项目配置
├── frontend/       # 前端资源（HTML/JS）
└── build/          # 构建资源（图标等）
```

## 快速启动

### 开发模式

```bash
cd pc-app-go
go mod tidy
wails dev
```

### 构建发布版

```bash
wails build
# 输出: build/bin/autodial-pc.exe
```

## 核心功能

### Wails 绑定方法（`app.go`）

| 方法 | 说明 |
|------|------|
| `GetInfo()` | 返回 IP、PIN、连接状态 |
| `GetSettings()` / `UpdateSettings()` | 设置读写 |
| `SendDial(number)` | 发起拨号（含 ACK 确认、唤醒、排队） |
| `SendHangup()` | 挂断通话 |
| `SendSMS(number, content)` | 发送短信 |
| `SelectPhone(pin)` / `RenamePhone(pin, note)` | 设备管理 |
| `ForceReconnect(pin)` | 通过云端强制唤醒手机 |
| `ConnectCloudServer(server)` | 手动连接指定云服务器 |
| `TestCloudServers(servers)` | TCP 连通性测试 |
| `RestartCloud()` / `RestartApp()` | 重启云端连接 / 重启应用 |
| `SetTopmost(enabled)` / `MinimizeWindow()` / `CloseWindow()` | 窗口控制 |
| `MinimizeToFloatbar()` / `RestoreMainWindow()` | 悬浮条模式切换 |
| `ReadClipboard()` | 读取系统剪贴板 |

### HTTP API（`server.go`）

与 Electron 版一致的 REST API（端口 35432）：

- `GET /dial?number=xxx` — 拨号
- `GET /hangup` — 挂断
- `GET /sms?number=xxx&content=xxx` — 短信
- `GET /open` — 显示窗口
- `GET /toggle-floatbar` — 切换悬浮条
- `GET /cloud-servers` — 云端服务器列表
- `GET /` — 状态 JSON

### 设备管理（`devices.go`）

- 以 PIN 为键管理设备连接
- LAN 优先，Cloud 降级的双通道发送
- ACK 确认机制（3 秒超时，备选通道重试）
- 拨号待发队列（30 秒超时）
- 心跳检测（120 秒超时）

### 云中继客户端（`cloud.go`）

- `connectCloudServer(server)` — 连接云中继
- Telegram 风格重连策略（阶梯降频）
- `pc_hello` 握手 + ping/pong 保活（15s 间隔，20s 超时）
- TCP keepalive（10s 间隔）

### 设置持久化（`settings.go`）

JSON 存储于 `{executableDir}/autodial-settings.json`：

```json
{
  "theme": "dark-gold",
  "mode": "dark",
  "closeAction": "minimize",
  "autoStart": false,
  "silentStart": false,
  "cloudEnabled": false,
  "cloudServers": [],
  "phoneNotes": {}
}
```

## 与 Electron 版的主要差异

| 特性 | Electron 版 | Go/Wails 版 |
|------|-------------|-------------|
| GUI 框架 | Electron 28 | Wails v2 |
| 安装包大小 | ~150MB | ~10MB |
| 悬浮条 | 独立 BrowserWindow | 主窗口缩放为 400x52 |
| 设置窗口 | 独立 BrowserWindow | 嵌入主窗口 Tab |
| IPC | Electron contextBridge | Wails Bindings + Events |
| 自启动 | Windows 注册表 | Windows 注册表 |
