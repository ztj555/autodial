# AutoDial 跨屏拨号系统 — 技术文档

> 版本: v6 / 生成日期: 2026-06-12 / 基于实际代码分析

---

## 1. 系统概述

AutoDial 是一套**跨屏拨号系统**，实现 PC 端控制 Android 手机拨打电话和发送短信。支持局域网直连和云中继两种通信模式。

### 1.1 组件架构

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器扩展                            │
│              (Chrome Extension, Manifest V3)                 │
│     CRM 页面注入浮动按钮 → HTTP API 调用本地 PC             │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (127.0.0.1:35432)
┌──────────────────────────▼──────────────────────────────────┐
│                      PC 端 (Electron 28)                     │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────┐   │
│  │ HTTP Server │  │  PhoneConnection │  │  Cloud WS    │   │
│  │ (拨号API)   │  │  Manager (心跳)  │  │  Client      │   │
│  └─────────────┘  └──────────────────┘  └──────────────┘   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  本地 WebSocket Server (35432) ← 局域网手机直连     │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────┬───────────────────────────────┬──────────────────┘
           │ LAN (UDP 35433 + WS 35432)   │ Cloud (WS 35430)
┌──────────▼──────────┐     ┌─────────────▼──────────────────┐
│   Android 手机       │     │     云中继 (Python)            │
│  ┌────────────────┐ │     │  ┌──────────────────────────┐ │
│  │ DialService    │ │     │  │ WebSocket Server (35430) │ │
│  │ (前台服务)     │ │     │  │ PIN 分组转发            │ │
│  │ ConnectionMgr  │ │     │  │ HTTP 管理界面            │ │
│  │ DialEngine     │ │     │  │ 系统托盘                 │ │
│  └────────────────┘ │     │  └──────────────────────────┘ │
│  版本: 4.52         │     │  版本: 2.0.0                   │
└─────────────────────┘     └────────────────────────────────┘
```

---

## 2. PC 端 (Electron)

### 2.1 基本信息

| 项目 | 值 |
|------|-----|
| 框架 | Electron 28.3.3 |
| 入口 | `main.js` (主进程) + `renderer/index.html` (渲染进程) |
| 窗口 | 无边框, 420×780, 可调整大小 |
| IPC | contextBridge + ipcRenderer/ipcMain |
| 构建 | `@electron/packager`, 输出 exe (ASAR) |

### 2.2 主进程 (main.js)

**文件**: `pc-app/main.js` (约 2100 行)

#### 端口分配

| 端口 | 用途 |
|------|------|
| 35432 | HTTP API + 本地 WebSocket Server (手机直连) |
| 35433 | UDP 广播发现 |

#### HTTP API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/dial?number=xxx` | GET | 触发拨号 |
| `/hangup` | GET | 挂断电话 |
| `/sms?number=xxx` | GET | 打开短信窗口 |
| `/open` | GET | 打开主窗口 |
| `/toggle-floatbar` | GET | 切换悬浮横条 |
| `/cloud-servers` | GET | 获取云服务器列表 |
| `/health` (relay) | GET | 云端 relay 健康检查 |

#### UDP 广播发现

- 发送端口: 35433
- 消息格式: 广播 `{"type":"discover","pin":"<4位PIN>","hostname":"..."}` → 255.255.255.255
- 响应: `{"type":"found","ip":"<phone_ip>","pin":"<PIN>"}`

#### 云端连接

- WebSocket 客户端 (ws 库)
- 支持多服务器列表遍历连接
- 认证: `{"type":"pc_hello","pin":"<PIN>","hostname":"..."}` → `{"type":"pc_auth_ok"}`
- 心跳: 每 15s 发 `{"type":"ping"}`, 20s 无 pong 判超时
- TCP KeepAlive: 10s 间隔

#### 文件日志

- 路径: `%APPDATA%/autodial-logs/autodial-pc-YYYY-MM-DD.log`
- 滚动: 10MB 单文件上限, 保留 7 天
- 格式: `[时间] [级别] [模块] [PIN] 内容`

### 2.3 渲染进程 (renderer/index.html)

单页面应用, 纯 HTML/CSS/JS, 无框架。

#### 核心状态变量

```javascript
isConnected     // 手机是否连接
activePin       // 当前活跃手机 PIN
lastDialPin     // 上一次拨号的 PIN (重连优先级)
currentPhones   // 手机列表
```

#### IPC 事件监听

| 事件 | 方向 | 用途 |
|------|------|------|
| `status-update` | 主→渲染 | 手机连接状态变化 |
| `phones-update` | 主→渲染 | 多手机列表更新 |
| `force-reconnect-result` | 主→渲染 | 强制重连结果 |
| `dial-sent` / `dial-result` | 主→渲染 | 拨号发送/结果 |
| `dial-timeout` | 主→渲染 | 拨号超时 (30s) |
| `dial-waking` | 主→渲染 | 正在唤醒手机 |
| `server-log` | 主→渲染 | 服务端日志 |
| `info-push` | 主→渲染 | IP/PIN 信息推送 |

#### 按钮状态逻辑

- **未连接** + 有号码 → "重连手机", 点击触发 `force-reconnect`
- **未连接** + 无号码 → 拨号按钮可点击但 Toast 提示
- **已连接** + 有号码 → 正常拨号
- **已连接** + 无号码 → 拨号按钮禁用
- 挂断按钮仅在已连接时可用

### 2.4 PhoneConnectionManager

**文件**: `pc-app/phone-connection-manager.js`

| 参数 | 值 |
|------|-----|
| 最大手机连接数 | 2 |
| 心跳超时 | 120s |
| 邻居表 TTL | 30s |
| ACK 超时 | 3s |
| 拨号队列超时 | 30s |

#### 设备状态机

```
DISCONNECTED → DISCOVERING → CONNECTING → CONNECTED
                                       ↘ stale → DISCONNECTED
```

#### 双通道发送

LAN 优先, 失败时降级到 Cloud。关键消息 (dial/hangup/sms) 走 ACK 确认机制, 3s 超时后尝试备选通道。

---

## 3. 云中继 (Python)

### 3.1 基本信息

| 项目 | 值 |
|------|-----|
| 文件 | `cloud-relay/python/cloud_relay_v2.py` |
| 语言 | Python 3.11 |
| 依赖 | websockets, pystray, Pillow |
| 默认端口 | 35430 |
| 打包 | PyInstaller → 单文件 exe (27.8 MB) |

### 3.2 架构

```
WebSocket Server (0.0.0.0:35430)
    │
    ├── health_check_handler (HTTP 路由)
    │   ├── WebSocket Upgrade → None (放行)
    │   ├── /health → JSON 状态
    │   ├── /api/status → 仪表盘数据
    │   ├── /api/clients → 客户端列表
    │   ├── /api/stats → 统计数据
    │   ├── /api/logs → 最近 100 条日志
    │   └── / → Web 管理界面 HTML
    │
    └── handle_connection (WebSocket)
        ├── phone_hello → 手机认证
        ├── pc_hello → PC 认证
        ├── phone→PC 转发 (dial_result, sms_result, ping, ack...)
        ├── PC→手机 转发 (auth_ok, dial, sms, hangup...)
        └── ping → pong (通用)
```

### 3.3 PIN 分组

- 每个 PIN 对应一个 `PinGroup`, 包含 `pcs` 和 `phones` 两个集合
- 同 PIN 的 PC 和手机之间消息自动转发
- 组内无连接时自动清理

### 3.4 WebSocket 配置

| 参数 | 值 | 说明 |
|------|-----|------|
| ping_interval | 30s | WebSocket 协议层 ping |
| ping_timeout | 90s | 协议层 pong 超时 |
| close_timeout | 10s | 优雅关闭等待 |

### 3.5 频率限制

- 每个 IP 每分钟最多 5 次 `phone_hello` / `pc_hello` 请求
- 超频返回 `auth_fail`，1 分钟后自动重置

### 3.6 消息统计

`record_message()` 记录所有转发消息, 按 PIN、消息类型、日期分类统计, 通过 `/api/stats` 暴露。

### 3.7 系统托盘

- 绿色圆点: 运行中
- 灰色圆点: 已停止
- 菜单: 启停服务器、打开 Web 管理界面、打开日志、退出

---

## 4. Android 端

### 4.1 基本信息

| 项目 | 值 |
|------|-----|
| 包名 | `com.autodial.app` |
| 版本 | 4.52 (versionCode 452) |
| 语言 | Kotlin |
| minSdk / targetSdk | 24 / 34 |
| WebSocket | OkHttp 4.12.0 |

### 4.2 核心组件

| 类 | 职责 |
|-----|------|
| `DialService` | 前台服务, 管理连接生命周期, START_STICKY |
| `ConnectionManager` | 双通道管理 (LAN + Cloud), 心跳, 重连 |
| `CloudCtrl` | 云服务器配置 CRUD, 连通性测试, Gist 同步 |
| `DialEngine` | SIM 卡选择 + 拨号执行 (TelecomManager) |
| `PrefCtrl` | SharedPreferences 设置 + ConnectionStrategy 枚举 |
| `ConnectFragment` | 连接选项卡 UI (发现、配对、云服务器) |
| `CallLogDb` | SQLite 通话记录 + SIM 缓存 |

### 4.3 连接策略

```kotlin
enum class ConnectionStrategy {
    AUTO("auto", "自动(LAN优先)"),    // 同时尝试 LAN + Cloud
    LAN_ONLY("lan_only", "仅局域网"),
    CLOUD_ONLY("cloud_only", "仅云中转")
}
```

### 4.4 发现与连接

#### LAN 发现

- UDP 广播: `255.255.255.255:35433`
- 消息: `{"type":"discover","pin":"<PIN>"}`
- 重试: 3 次, 200ms 间隔, 8s 超时
- 发现后连接: `ws://<ip>:35432`

#### Cloud 连接

- 多服务器列表, 按顺序尝试
- 默认服务器: `ws://262ao85kz470.vicp.fun:55535`
- 支持 Gist/Gitee 同步服务器列表
- 认证: `{"type":"phone_hello","pin":"<PIN>","deviceName":"..."}`

### 4.5 心跳机制

双层心跳:

| 层级 | 机制 | 间隔 | 超时 |
|------|------|------|------|
| 协议层 | OkHttp WebSocket ping | 30s | 45s (readTimeout) |
| 应用层 | `{"type":"ping"}` → `{"type":"pong"}` | 30s | 15s |

### 4.6 拨号引擎

拨号模式 (DialMode):
- `POPUP`: 每次弹窗选卡
- `ROUND_SELECT`: 10 天内打过则弹窗, 否则轮选
- `OPPOSITE`: 2 天内反向选卡
- `SIM1` / `SIM2`: 始终指定卡
- `ALTERNATE`: 交替
- `SYSTEM`: 系统默认

拨号流程:
1. 调用 `TelecomManager.placeCall()` (推荐)
2. 失败时回退到 `ACTION_CALL` intent
3. 无障碍服务辅助点击小米 SIM 选择弹窗

### 4.7 保活机制

- **前台服务**: `startForeground()` + PARTIAL_WAKE_LOCK
- **开机自启**: BootReceiver
- **网络监控**: ConnectivityManager.NetworkCallback → 触发重连
- **亮屏检查**: SCREEN_ON / USER_PRESENT → wakeAndReconnect()
- **电池优化**: 提示用户关闭电池优化

### 4.8 重连策略

指数退避延迟: `0 → 1s → 3s → 5s(x3) → 10s(x4) → 30s(x5) → 60s(x5) → 5min`
- LAN 最多 30 次
- Cloud 最多 8 次
- Cloud 在线时定期尝试 LAN (间隔 60s, 最多 10 次)

---

## 5. 浏览器扩展

### 5.1 基本信息

| 项目 | 值 |
|------|-----|
| 框架 | Chrome Extension Manifest V3 |
| 版本 | 2.1.0 |
| 权限 | activeTab, storage, clipboardWrite |
| 主机权限 | `guwen.zhudaicms.com`, `127.0.0.1:35432` |

### 5.2 核心文件

| 文件 | 职责 |
|------|------|
| `background.js` | Service Worker, HTTP API 代理 |
| `content-script.js` | CRM 页面注入, 浮动按钮, 号码扫描 |
| `popup.html` / `popup.js` | 工具栏弹窗, 状态轮询 |

### 5.3 功能

#### 浮动按钮

- 可拖拽拨号按钮, 显示检测到的号码
- 可拖拽挂断按钮, 支持左下角拖拽缩放
- 右键菜单: 打开 PC 端、切换悬浮窗、切换主题 (8 种)

#### 号码扫描

- 自动扫描 CRM 页面中的手机号 (正则: `1[3-9]\d{9}`)
- 子 iframe 中也扫描 (关键字: `"手机号码："`)
- 拦截 `<a>` 链接替换为 AutoDial 拨号

#### HTTP API 调用

| 端点 | 用途 |
|------|------|
| `GET /dial?number=xxx` | 拨号 |
| `GET /hangup` | 挂断 |
| `GET /sms?number=xxx` | 短信 |
| `GET /open` | 打开 PC 主界面 |
| `GET /toggle-floatbar` | 切换悬浮横条 |
| `GET /` | 状态检查 (3s 轮询) |

---

## 6. 通信协议

### 6.1 WebSocket 消息类型

#### 认证握手

```
手机 → PC/Relay:  {"type":"phone_hello","pin":"1234","deviceName":"Xiaomi 14"}
PC → Relay:      {"type":"pc_hello","pin":"1234","hostname":"DESKTOP-ABC"}
Relay → 手机:     {"type":"auth_ok","pin":"1234","pcCount":1}
Relay → PC:      {"type":"pc_auth_ok","pin":"1234","phoneCount":1}
```

#### 拨号 / 短信 / 挂断

```
PC → 手机:  {"type":"dial","number":"13800138000","messageId":"ack_..."}
PC → 手机:  {"type":"sms","number":"13800138000","content":"你好"}
PC → 手机:  {"type":"hangup"}
手机 → PC:  {"type":"ack","messageId":"ack_...","originalType":"dial"}
手机 → PC:  {"type":"dial_result","number":"13800138000","status":"ok"}
手机 → PC:  {"type":"sms_result","number":"13800138000","status":"sent"}
```

#### 心跳

```
手机 → PC/Relay:  {"type":"ping"}
PC/Relay → 手机:  {"type":"pong"}
PC → Relay:      {"type":"ping"}
Relay → PC:      {"type":"pong"}
```

#### 重连唤醒

```
PC → Relay:  {"type":"reconnect_request","targetDevice":"<deviceName>"}
Relay → 手机: 转发 reconnect_request
```

### 6.2 UDP 发现

```
端口: 35433 (双向)
PC 广播:  {"type":"discover","pin":"1234","hostname":"PC-NAME"}
手机响应: {"type":"found","ip":"192.168.1.100","pin":"1234"}
手机广播: {"type":"discover","pin":"1234"}
PC 响应:  {"type":"announce","ip":"192.168.1.50","pin":"1234","port":35432}
```

### 6.3 HTTP API

全部通过 PC 端 `127.0.0.1:35432` 提供:

| 端点 | 方式 | 参数 | 响应 |
|------|------|------|------|
| `/dial` | GET | `number` | `{"success":true,"number":"..."}` |
| `/hangup` | GET | — | `{"success":true}` |
| `/sms` | GET | `number` | 打开 PC 端短信窗口 |
| `/open` | GET | — | 打开 PC 端主窗口 |
| `/toggle-floatbar` | GET | — | `{"success":true,"visible":bool}` |
| `/cloud-servers` | GET | — | `{"servers":["url1","url2"]}` |
| `/` | GET | — | `{"pin":"1234","ip":"...","connected":bool}` |

所有响应均带 `Access-Control-Allow-Origin: *` CORS 头。

---

## 7. 连接模式对比

| 特性 | LAN 直连 | 云中继 |
|------|----------|--------|
| 延迟 | < 5ms | 50-200ms |
| 网络要求 | 同局域网 | 有公网 IP 或 DDNS |
| 手机发现 | UDP 广播 | WebSocket 直连 relay |
| 多 PC 支持 | ❌ (单机) | ✅ (PIN 分组) |
| 安全性 | 局域网隔离 | 依赖 relay 认证 |
| 可靠性 | 高 | 依赖 relay 稳定性 |

---

## 8. 项目文件结构

```
6-7bug/
├── pc-app/                          # PC 端 (Electron)
│   ├── main.js                      # 主进程 (~2100行)
│   ├── preload.js                   # contextBridge IPC
│   ├── phone-connection-manager.js  # 手机连接管理
│   ├── pack.js                      # 打包脚本
│   ├── renderer/
│   │   ├── index.html               # 主界面 (HTML+CSS+JS)
│   │   ├── sms.html                 # 短信窗口
│   │   ├── settings.html            # 设置窗口
│   │   └── floatbar.html           # 悬浮横条
│   ├── themes/                      # 主题资源
│   └── run.bat                      # 开发启动脚本
│
├── cloud-relay/                     # 云中继 (Python)
│   ├── python/
│   │   ├── cloud_relay_v2.py        # 主程序 (1000+行)
│   │   ├── requirements.txt         # 依赖
│   │   └── AutoDial-Cloud-Relay-v2.spec  # PyInstaller 配置
│   └── dist/
│       └── AutoDial-Cloud-Relay-v2.exe    # 打包后 exe
│
├── android/                         # Android 端 (Kotlin)
│   └── app/src/main/java/com/autodial/app/
│       ├── DialService.kt           # 前台服务
│       ├── ConnectionManager.kt     # 连接管理 v7
│       ├── CloudCtrl.kt             # 云服务器配置
│       ├── DialEngine.kt            # 拨号引擎
│       ├── PrefCtrl.kt              # 设置管理
│       └── ...                      # 其他 UI/工具类
│
├── AutoDial-Extension/              # 浏览器扩展 (Chrome)
│   ├── manifest.json                # Manifest V3
│   ├── background.js                # Service Worker
│   ├── content-script.js            # 页面注入脚本
│   ├── popup.html / popup.js        # 弹出窗口
│   └── AutoDial-API.md              # API 文档
│
└── docs/                            # 文档
```

---

## 9. 已知参数速查表

| 参数 | PC 端 | 云中继 | Android |
|------|-------|--------|---------|
| 应用层 ping 间隔 | 15s | — | 30s |
| pong 超时 | 20s | — | 15s |
| WebSocket ping 间隔 | — | 30s | 30s (OkHttp) |
| WebSocket ping 超时 | — | 90s | 45s (readTimeout) |
| 手机心跳超时 | 120s (PC判断) | — | — |
| UDP 发现端口 | 35433 | — | 35433 |
| WebSocket 端口 | 35432 | 35430 | — |
| 最大手机连接数 | 2 | 无限制 | — |
| 频率限制 | — | 5次/分钟/IP | — |
| 重连最大次数 | 20 | — | LAN:30, Cloud:8 |
