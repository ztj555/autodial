# AutoDial 电脑端技术文档

> 基于实际代码 | Electron v3.0.0 + Go/Wails v1.0.0 | 双实现并行

---

## 一、双实现概述

AutoDial 提供两个功能等价的 PC 端实现。两者共享相同的通信协议，Android 手机端和 Chrome 扩展在通信层面无法区分连接的是哪个版本。

| 特征 | Electron 版 | Go/Wails 版 |
|------|------------|-------------|
| 版本 | v3.0.0 | v1.0.0 |
| 技术栈 | Node.js + Electron | Go + Wails v2.12 |
| 运行时体积 | ~150MB（含 Electron） | ~10MB（单文件 exe） |
| 窗口数 | 4 个独立窗口 | 1 个（内嵌设置/短信） |
| 最大手机连接 | 10 台 | 10 台 |
| 系统托盘 | Electron Tray API | 原生 Win32 API |
| 前端渲染 | Chromium | WebView2 |
| PIN 校验 | 11 位手机号强校验 | 11 位手机号强校验（v1.0.1） |
| 号码校验 | 3-20 位，支持 *#+ | 3-20 位，支持 *#+ |

---

## 二、Electron 版（v3.0.0）详细架构

### 2.1 文件结构

单文件架构，`main.js` 约 2238 行，内聚了日志/设置/网络/UDP/HTTP/WS/云中转/托盘/窗口/防火墙全部逻辑：

```
pc-app-Electron/
├── main.js (2238行)            ← 主进程入口：全部逻辑内聚于此文件
├── phone-connection-manager.js ← 设备连接管理器（独立模块，双通道 LAN+Cloud）
├── preload.js                  ← contextBridge IPC 桥接
├── renderer/
│   ├── index.html (44KB)       ← 主界面（内联 CSS+JS，8 套主题）
│   ├── floatbar.html (16KB)    ← 悬浮条窗口
│   ├── settings.html (28KB)    ← 设置窗口
│   └── sms.html (21KB)         ← 短信窗口
└── themes/
    └── theme-data.js (53KB)    ← 8 套主题定义
```

> **架构说明**：当前为单文件巨石架构，`phone-connection-manager.js` 是唯一已独立的模块。代码可按职责逻辑区分为多个段：日志系统、设置管理、网络工具、UDP 发现、HTTP/WS 服务、云中转状态机、系统托盘、窗口管理、防火墙等。日后可参考 Go 版进行模块化拆分。

### 2.2 核心逻辑段

`main.js` 内部按功能可划分为以下逻辑段：

| 逻辑段 | 行号范围 | 职责 |
|--------|---------|------|
| 日志系统 | ~25-120 | 10MB 轮转、5级备份、7天清理、环形缓冲降级 |
| 设置管理 | ~122-170 | settings.json 读写、向后兼容处理 |
| 网络常量 | ~312-336 | PORT=35432、DISCOVERY_PORT=35433、IP 获取 |
| PhoneConnectionManager | ~338-377 | 设备连接管理初始化 |
| 系统托盘 | ~392-514 | 16×16 PNG 手写编码金色电话图标 |
| 窗口创建 | ~516-617 | 主窗口/悬浮条/设置窗口/短信窗口 |
| IPC 处理 | ~619-1272 | 37 个 IPC 通道（设置/主题/拨号/设备/云端） |
| HTTP/WS 服务 | ~1274-1664 | dial/hangup/sms/open/toggle-floatbar 端点 |
| UDP 发现 | ~1665-1711 | announce 广播 + discover 响应 |
| 云中转 | ~1713-2103 | generation 防竞态 + 阶梯退避重连 |
| 防火墙 | ~2125-2141 | netsh 入站规则 |
| 启动流程 | ~2143-2201 | app.whenReady 启动序列 |

### 2.3 核心服务

#### HTTP 服务器（端口 35432）

| 端点 | 方法 | 用途 |
|------|------|------|
| `/cloud-servers` | GET | 同步 PC 云服务器配置给手机端 |
| `/dial?number=xxx` | GET | 拨号（插件调用），自动唤醒 + 排队 |
| `/hangup` | GET | 挂断 |
| `/sms?number=xxx&content=xxx` | GET | 触发短信窗口 |
| `/open` | GET | 打开主窗口 |
| `/toggle-floatbar?show=true` | GET | 切换悬浮条显隐 |
| `/` | GET | 返回状态信息 |

#### WebSocket 服务器（同端口）

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `phone_hello{pin, deviceName}` | 手机→PC | LAN 握手 |
| `plugin_hello` | 扩展→PC | 插件连接 |
| `dial{nubmer}` | 扩展→PC→手机 | 拨号指令 |
| `dial_result{status}` | 手机→PC→扩展 | 拨号结果回传 |
| `hangup` | 扩展→PC→手机 | 挂断 |
| `sms{nubmer, content}` | — | 短信指令/结果 |
| `ping` / `pong` | 双向 | 心跳 |
| `ack{messageId}` | 双向 | ACK 确认 |
| `file_upload_start/chunk/complete/error` | 手机→PC | 文件上传协议 |

#### UDP 发现（端口 35433）

- **广播 announce**：每 10s 发送 `{type: "announce", pin, ip, port}` 到 `255.255.255.255`
- **响应 discover**：收到 `{type: "discover", pin}` 后回复 `{type: "found", pin, ip, port}`
- **wake_connect**：拨号触发时发送 `{type: "wake_connect", pin, ip, port}` 唤醒离线设备

#### 云中转连接

**状态机设计**：
- `_cloudTraversalGeneration` 递增防止旧连接事件覆盖新连接状态
- 阶梯退避重连：0 → 1s → 3s → 5s → 10s → 30s → 60s → 5min
- 重连次数上限 30 次后停止，等待手动触发
- pong 超时 20s 判死（云中继 ping 间隔 15s）

**服务器列表遍历**：按 `cloudServers` 列表顺序尝试连接，成功后停止遍历。全部失败后自动重新调度重连，不会中断重连链。

### 2.4 设备连接管理（PhoneConnectionManager）

独立模块，管理最多 10 台手机的双通道连接。

| 功能 | 说明 |
|------|------|
| **双通道发送** | LAN (ws) 优先 → Cloud (cloudWs) 降级 |
| **ACK 机制** | 3 秒超时 → 自动切备通道重试 → 再超时返回失败 |
| **拨号队列** | 手机离线时暂存拨号请求（30s 超时），重连后 `flushDialQueue()` 自动补发 |
| **心跳检测** | 120s 超时 + 30s TTL 清理僵尸设备 |
| **ReconnectScheduler** | 阶梯退避重连（与云端重连策略一致） |

### 2.5 日志系统

- **文件路径**：`{userData}/autodial-logs/autodial-pc-YYYY-MM-DD.log`
- **格式**：`[HH:mm:ss.SSS] [I/W/E] [Module] [PIN] content`
- **轮转**：单文件 10MB 上限，5 级编号轮转（.1 → .2 → … → .5）
- **清理**：7 天前日志自动删除（6 小时间隔巡检）
- **降级**：连续写入失败 3 次后自动切换为内存环形缓冲（1000 条上限）
- **控制台劫持**：`console.log/warn/error` 自动转发到渲染进程日志区

### 2.6 窗口管理

| 窗口 | 尺寸 | 特性 |
|------|------|------|
| 主窗口 | 420×780，最小 210×350 | 无边框，可拖拽，自定义标题栏 |
| 悬浮条 | 440×48，缩放 0.7-1.5x | alwaysOnTop，可拖拽，skipTaskbar |
| 设置窗口 | 380×420，最小 320×350 | 无边框，云端配置 + 主题 + 自启动 |
| 短信窗口 | 420×680，最小 320×400 | 无边框，短信模板 + 发送 |

### 2.7 主题系统

8 套主题，存储在 `themes/theme-data.js`：

| 主题 ID | 名称 |
|---------|------|
| `dark-gold` | 暗金（默认） |
| `cyber-frost` | 赛博霜寒 |
| `deep-space` | 深空 |
| `cyberpunk` | 赛博朋克 |
| `minimalist` | 极简 |
| `forest-green` | 森林绿 |
| `energetic-orange` | 活力橙 |
| `ocean-blue` | 海洋蓝 |

每次主题切换会广播 `theme-changed` 事件到所有窗口。

### 2.8 设置持久化

文件：`{userData}/settings.json`

```json
{
  "closeAction": "minimize",
  "trayExit": true,
  "autoStart": false,
  "silentStart": false,
  "theme": "dark-gold",
  "mode": "dark",
  "pinCode": "13800138000",
  "phoneNotes": {},
  "cloudServer": "262ao85kz470.vicp.fun:55535",
  "cloudEnabled": false,
  "cloudServers": []
}
```

**向后兼容**：`cloudServer` 自动同步到 `cloudServers` 数组。

---

## 三、Go/Wails 版（v1.0.0）详细架构

### 3.1 文件结构

```
pc-app-go/
├── main.go (61行)              ← Wails 启动：无边框窗口 420×780
├── app.go (660行)              ← 40+ 个 Go→前端绑定方法（App 结构体）
├── server.go (533行)           ← HTTP + WebSocket 服务器
├── cloud.go (320行)            ← 云中转连接管理（generation 防竞态）
├── devices.go (488行)          ← 设备管理 + 常量/工具函数
├── tray.go (484行)             ← 原生 Win32 API 系统托盘
├── udp.go (159行)              ← UDP 局域网发现
├── settings.go (77行)          ← JSON 设置持久化
├── logger.go (141行)           ← 文件日志（旧日志 zip 压缩）
├── go.mod / go.sum             ← Go 模块依赖
├── wails.json                  ← Wails 构建配置
└── frontend/
    ├── index.html (80KB)       ← 主界面（单文件，内嵌设置/短信）
    ├── js/                     ← 前端 JS 逻辑
    ├── themes/                 ← 主题定义
    ├── wailsjs/                ← Wails 自动生成的绑定代码
    └── wails-adapter.js        ← Electron API → Wails API 适配层
```

### 3.2 Wails 绑定层（app.go）

`App` 结构体通过 Wails 框架将 40+ 个 Go 方法暴露给前端：

| 方法 | 前端调用 | 用途 |
|------|---------|------|
| `SendDial(number)` | `window.go.main.App.SendDial(n)` | 拨号 |
| `SendHangup()` | `window.go.main.App.SendHangup()` | 挂断 |
| `GetInfo()` | `window.go.main.App.GetInfo()` | 获取系统信息 |
| `GetSettings()` | `window.go.main.App.GetSettings()` | 获取设置 |
| `SaveSettings(json)` | `window.go.main.App.SaveSettings(j)` | 保存设置 |
| `SetPin(pin)` | `window.go.main.App.SetPin(p)` | 设置 PIN |
| `GetPhoneList()` | `window.go.main.App.GetPhoneList()` | 获取设备列表 |
| `GetCloudStatus()` | `window.go.main.App.GetCloudStatus()` | 获取云端状态 |
| `ConnectCloud(server)` | `window.go.main.App.ConnectCloud(s)` | 连接云服务器 |
| `DisconnectCloud()` | `window.go.main.App.DisconnectCloud()` | 断开云端 |
| `FetchCloudServers()` | `window.go.main.App.FetchCloudServers()` | 一键获取云服务器列表 |
| `TestCloudServers(json)` | `window.go.main.App.TestCloudServers(j)` | 测试云服务器连通性 |

**前端事件推送**：Go → 前端通过 `wailsRuntime.EventsEmit("event-name", data)`。

### 3.3 wails-adapter.js（兼容层）

前端 HTML 最初为 Electron IPC 编写，使用 `window.api.send()` / `window.api.invoke()` / `window.api.on()`。`wails-adapter.js` 将此映射到 Wails 绑定：

- **send 映射**：16 个 IPC 通道 → Go App 方法（dial→SendDial, hangup→SendHangup 等）
- **invoke 映射**：3 个 IPC 通道 → Go App 方法（get-info, get-settings, read-clipboard）
- **on 事件**：14 个事件回调（phones-update, status-update, dial-result, sms-result 等），通过 1s 轮询 + `wailsRuntime.EventsOn` 混合实现
- **EventsOn 转发**：监听 Wails 后端 pushToRenderer 事件并转发到对应的前端回调（dial-sent, dial-result, sms-result, sms-sent, hangup-sent, dial-waking, dial-timeout, force-reconnect-result, error, server-log, info-push）
```

### 3.4 原生 Win32 系统托盘（tray.go）

直接调用 Windows API（不使用第三方托盘库）：
- `user32.dll`：CreateWindowExW, RegisterClassExW, GetMessageW
- `shell32.dll`：Shell_NotifyIconW
- `gdi32.dll`：CreateBitmap（32×32 金色电话图标）

托盘操作通过 `wailsRuntime.EventsEmit(ctx, "tray-action", action)` 发事件到主线程处理（Wails 窗口操作必须在主线程调用）。

### 3.5 日志系统增强

相比 Electron 版，Go 版日志增加了：
- **zip 压缩**：旧日志轮转后自动 zip 压缩（后台 goroutine）
- **sync.Mutex**：保护日志写入（Electron 版依赖 `appendFileSync` 原子性）

### 3.6 与 Electron 版的差异

| 维度 | Electron v3.0.0 | Go v1.0.0 |
|------|----------------|-----------|
| 运行时 | 需要 Electron 环境 | 单文件 exe |
| 前端事件 | IPC 双向事件驱动 | Wails 绑定 + wails-adapter 适配层 + 1s 轮询 |
| 号码校验 | 正则 3-20 位，支持 *#+ | `isValidDialNumber()` 3-20 位，支持 *#+ |
| 设备注释 key | `pin\|name` | `pin`（仅用 PIN） |
| 悬浮条 | 独立窗口 440×48 | 窗口缩放为 400×52 |
| 连接上限 | 10 台 | 10 台 |
| TCP KeepAlive | `socket.setKeepAlive` 在 open 回调设置 | `TCPConn.SetKeepAlivePeriod(10s)` |
| PIN 校验 | 11 位手机号强校验 | 11 位手机号强校验 |
| 防火墙 | netsh 自动添加规则 | 仅检测端口可达性 |
| 通信协议 | **完全相同** | **完全相同** |

---

## 四、IPC 通道清单（Electron 版）

主进程通过 37 个 IPC 通道与渲染进程通信：

**Handle（invoke/handle 模式，7个）**：
`get-settings`, `get-theme-setting`, `get-info`, `read-clipboard`, `get-cloud-status`, `floatbar-get-scale`, `test-cloud-servers`

**On（send/on 模式，30个）**：
`change-theme`, `update-bg-color`, `save-setting`, `set-pin`, `set-auto-start`,
`open-settings`, `close-settings`, `dial`, `hangup`, `send-sms`, `open-sms`,
`set-topmost`, `toggle-floatbar`, `floatbar-show-main`, `window-control`,
`floatbar-position`, `floatbar-move`, `floatbar-get-position`,
`floatbar-resize`, `floatbar-resize-to`, `floatbar-context-menu`,
`select-phone`, `rename-phone`,
`update-cloud-config`, `fetch-cloud-servers`, `connect-cloud-specific`,
`force-reconnect`, `restart-app`, `restart-cloud`, `dial-failed-trigger-recovery`

---

## 五、部署与构建

### Electron 版

```bash
cd pc-app-Electron
npm install
npm start          # 开发运行
npm run build      # 打包为 exe
```

### Go/Wails 版

```bash
cd pc-app-go
# 前置条件：安装 Go 1.21+ 和 Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails build         # 构建单文件 exe
wails dev           # 开发模式（热重载）
```

> **注意**：Go 版当前 `wails.json` 中 `frontend:build` 为空，需要手动将前端文件放到 `frontend/dist/` 目录。

---

## 六、防火墙要求

| 端口 | 协议 | 用途 |
|------|------|------|
| 35432 | TCP（入站） | PC 端主服务 |
| 35433 | UDP（入站） | LAN 设备发现 |
| 35430 | TCP（出站） | 云中继连接 |
