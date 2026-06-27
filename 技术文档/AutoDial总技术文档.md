# AutoDial 技术文档（当前版本）

> 基于实际代码 | PIN 单一认证体系 | 2026-06-26 更新

---

## 一、版本现状

| 组件 | 版本号 | 技术栈 | 认证方式 |
|------|--------|--------|----------|
| **Electron PC 端** | **v3.0.0** | Node.js + Electron | 11 位 PIN |
| **Go/Wails PC 端** | **v1.0.0** | Go + Wails v2.12 | 11 位 PIN |
| **云中继（主）** | **v2** | Python + websockets | PIN（4位或11位手机号） |
| **云中继（v3 JWT）** | **v0.02** | Python + aiosqlite + bcrypt + PyJWT | JWT + PIN 双模 |
| **Chrome 扩展** | **v4.0.0** | MV3 + Service Worker | X-AutoDial-PIN Header |
| **Android 端** | **v4.53** | Kotlin + OkHttp | PIN + JWT 双兼容 |

> **说明**：Electron PC 端和 Go PC 端是两个功能等价的并行实现，可互换使用。云中继主版本为 v2 PIN 中继（`cloud_relay.py`），v3 JWT 版本（`cloud_relay_v3.py` + `auth.py` + `db.py`）作为并存模块保留在代码库中，运行在独立端口 35440/35441，供有 JWT 需求的场景选用。

---

## 二、系统架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  CRM网页      │────→│ Chrome扩展    │────→│  PC端         │
│ (zhudai/     │     │ background.js│     │ Electron v3   │
│  rxhcrm等)   │     │ content.js   │     │ 或 Go v1      │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                    │
                    优先: HTTP 35432       LAN: WS 35432
                    降级: REST 35430     Cloud: WS 35430
                            │                    │
                            └────────┬───────────┘
                                     │
                            ┌────────▼──────────┐
                            │   云中继 (35430)   │
                            │   cloud_relay.py   │
                            │   PinGroup 分组     │
                            └────────┬──────────┘
                                     │
                            ┌────────▼──────────┐
                            │   Android 手机端    │
                            │   DialService      │
                            │   ConnectionMgr    │
                            └───────────────────┘
```

**双通道设计**：PC 端和手机端均支持 LAN 直连（WebSocket 35432）和 Cloud 中继（WebSocket 35430）双通道，由 PhoneConnectionManager（Electron）/ ConnectionManager（Android）自动管理优先级和降级切换。

---

## 三、云中继（端口 35430）

### 3.1 架构

主中继为 `cloud_relay.py`（v2），零数据库依赖，仅需 `websockets pystray Pillow` 包。

```
cloud_relay.py
├── WebSocket 中继（PIN 认证）
│   ├── phone_hello → PinGroup 管理
│   ├── pc_hello → PinGroup 管理
│   ├── dial/hangup/sms → 转发到手机
│   ├── dial_result/sms_result → 转发到 PC
│   ├── pc_online/pc_offline → 通知手机
│   └── ack → 双向转发
├── REST API（GET + X-AutoDial-PIN Header）
│   ├── /api/v1/dial?number=xxx
│   ├── /api/v1/hangup
│   └── /api/v1/status
├── 管理 API
│   ├── /health（含 CORS）
│   ├── /api/status /api/clients /api/stats /api/logs
│   └── / （Web 管理面板 HTML，端口 35431）
└── 系统托盘（pystray，启停/日志）
```

### 3.2 PinGroup 分组管理

```python
class PinGroup:
    def __init__(self):
        self.pcs = set()       # PC WebSocket 连接
        self.phones = set()    # 手机 WebSocket 连接
        self.last_dial = {}    # {number: timestamp} REST 并发保护
```

- 同一 PIN 的设备自动归入同一组
- 双向转发：`forward_to_phones()` / `forward_to_pcs()`
- 所有设备断开时自动清理组

### 3.3 REST 端点设计

**为何用 GET + Header 而非 POST body？**

`websockets` 的 `process_request(path, request_headers)` 回调只接收 path 和 headers 两个参数，不接收 request body。解决方案：PIN 通过自定义 Header `X-AutoDial-PIN` 传递，号码通过 URL query `?number=`。

**为何用 `asyncio.ensure_future()`？**

`process_request` 是同步回调，不能直接 `await` 异步的 `forward_to_phones()`。用 `asyncio.ensure_future()` 将异步转发调度出去，同步返回 `202 ACCEPTED`。

### 3.4 并发保护

| 机制 | 实现 |
|------|------|
| PC_CONNECTED 去重 | REST 端点检查 `group.pcs` 非空 → 返回 `PC_CONNECTED`，让扩展走本地 |
| DUPLICATE_DIAL 去重 | `PinGroup.last_dial[number]`，5 秒内同号码拒绝 |
| 频率限制 | `check_rate_limit()`，每 IP 每分钟 5 次尝试 |
| 心跳超时 | WebSocket 内置 ping/pong（30s 间隔，90s 超时） |

### 3.5 v3 JWT 并存模块（端口 35440/35441）

代码库中保留完整的 v3 JWT 双模中继，位于独立端口：

```
cloud_relay_v3.py (WS 35440)
├── auth.py — JWT + bcrypt + 防爆破限流
├── db.py  — SQLite (aiosqlite) 用户/设备/审计
└── 双模握手：JWT 优先 → PIN 降级
```

> **注意**：v3 模块代码保留但**不作为主中继**使用。主中继为 cloud_relay.py (v2 PIN-only)。v3 的 `requirements.txt` 中包含了 `bcrypt`、`PyJWT`、`aiosqlite` 等依赖，这些仅用于 v3 模块，主中继不需要。

---

## 四、REST API（端口 35430）

### 4.1 响应格式

```json
{"ok": true,  "code": "ACCEPTED"}
{"ok": false, "code": "INVALID_PIN", "message": "PIN 格式错误"}
```

### 4.2 错误码

| code | 含义 | 扩展处理 |
|------|------|---------|
| `ACCEPTED` | 指令已接受 | — |
| `INVALID_PIN` | PIN 格式错误（需4位或11位） | 提示检查 PIN |
| `PHONE_OFFLINE` | 手机未连接 | 提示手机未连接 |
| `PC_CONNECTED` | PC 在线，应走本地 | 切回 localhost |
| `DUPLICATE_DIAL` | 5 秒内同号码重复 | 忽略 |
| `RATE_LIMITED` | 频率限制 | 1 分钟后重试 |
| `INVALID_NUMBER` | 号码不合法（需 3-20 位数字，允许 *#+） | 提示用户 |

---

## 五、WebSocket 协议（端口 35430）

### 5.1 握手协议

**手机端握手**：
```json
→ {"type": "phone_hello", "pin": "13800138000", "deviceName": "Redmi K40"}
← {"type": "auth_ok", "pin": "13800138000", "pcCount": 1, "pc_present": true}
← {"type": "auth_fail", "reason": "配对码无效（需4位或11位手机号）"}
```

**PC 端握手**：
```json
→ {"type": "pc_hello", "pin": "13800138000", "hostname": "DESKTOP-ABC"}
← {"type": "pc_auth_ok", "pin": "13800138000", "phoneCount": 1}
```

### 5.2 消息类型

| type | 方向 | 说明 |
|------|------|------|
| `phone_hello` | 手机→云→PC | 手机上线 |
| `pc_hello` | PC→云→手机 | PC 上线 |
| `auth_ok` / `auth_fail` / `pc_auth_ok` / `pc_auth_fail` | 云→客户端 | 认证结果 |
| `dial` | PC/云→手机 | 拨号指令 |
| `dial_result` | 手机→云→PC | 拨号结果 |
| `hangup` | PC/云→手机 | 挂断 |
| `sms` / `sms_result` | PC⇌云⇌手机 | 短信指令/结果 |
| `ping` / `pong` | 双向 | 心跳 |
| `ack` | 手机→PC | ACK 确认 |
| `pc_online` / `pc_offline` | 云→手机 | PC 上下线通知 |

---

## 六、Electron PC 端（v3.0.0）

### 6.1 架构特点

模块化架构，`main.js` 约 919 行作为编排文件，10 个功能模块按职责拆分：

```
pc-app-Electron/
├── main.js (919行)             ← IPC 处理器 + 生命周期 + 跨模块胶水
├── phone-connection-manager.js ← 设备连接管理（独立模块，双通道 LAN+Cloud）
├── preload.js                  ← contextBridge IPC 桥接
├── modules/
│   ├── logger.js               ← 文件日志（10MB 轮转、环形缓冲降级）
│   ├── settings.js             ← JSON 设置持久化
│   ├── network.js              ← 网络工具 + PIN_CODE 可变状态
│   ├── phone-notes.js          ← 手机备注
│   ├── tray.js                 ← 系统托盘（16×16 PNG 手写编码）
│   ├── windows.js              ← 窗口工厂（纯创建）
│   ├── firewall.js             ← netsh 防火墙规则
│   ├── discovery.js            ← UDP 广播发现（10s 保活）
│   ├── cloud.js                ← 云中转状态机
│   └── server.js               ← HTTP + WebSocket 服务器
└── renderer/                   ← 前端界面（index.html, floatbar.html, settings.html, sms.html）
```

> **设计模式**：采用依赖注入，所有模块通过工厂函数接收外部依赖，零循环引用。

### 6.2 核心特性

| 功能 | 说明 |
|------|------|
| **HTTP 服务器** | 端口 35432，处理 `/dial` `/hangup` `/sms` `/open` `/toggle-floatbar` `/cloud-servers` |
| **WebSocket 服务器** | 同端口，手机 LAN 直连 + 插件连接 |
| **UDP 发现** | 端口 35433，10s 广播 announce + 响应 discover |
| **云中转** | generation 防竞态、阶梯退避重连（0→1s→3s→5s→…→5min）、pong 超时 20s |
| **双通道发送** | LAN (ws) 优先，Cloud (cloudWs) 降级，ACK 3s 超时自动切通道 |
| **拨号队列** | 手机离线时暂存拨号请求（30s 超时），重连后自动补发 |
| **心跳** | 120s 超时 + 30s TTL 清理僵尸设备 |
| **系统托盘** | 金色电话图标，右键菜单（显隐主窗口/悬浮条/退出） |
| **多窗口** | 主窗口 420×780 + 悬浮条 440×48 + 设置窗口 + 短信窗口 |
| **8 套主题** | dark-gold（默认）/ cyber-frost / deep-space / cyberpunk / minimalist / forest-green / energetic-orange / ocean-blue |

### 6.3 连接上限

`MAX_PHONE_CONNECTIONS = 10`（PhoneConnectionManager，Electron 与 Go 版一致）

---

## 七、Go/Wails PC 端（v1.0.0）

### 7.1 架构

```
pc-app-go/
├── main.go (61行)          ← Wails 启动 + 窗口生命周期
├── app.go (660行)           ← 40+ 个 Go→前端绑定方法
├── server.go (533行)        ← HTTP + WebSocket 服务器
├── cloud.go (320行)         ← 云中转连接管理
├── devices.go (488行)       ← 设备管理 + 常量定义
├── tray.go (484行)          ← Win32 API 原生系统托盘
├── udp.go (159行)           ← UDP 局域网发现
├── settings.go (77行)       ← 设置持久化
├── logger.go (141行)        ← 文件日志（含 zip 压缩）
└── frontend/                ← WebView2 渲染的 HTML 界面
    └── wails-adapter.js     ← Electron API → Wails API 适配层
```

### 7.2 与 Electron 版的差异

| 维度 | Electron 版 | Go/Wails 版 |
|------|------------|-------------|
| 版本 | v3.0.0 | v1.0.0 |
| 运行时依赖 | Electron (~150MB) | 单文件 exe (~10MB) |
| 窗口数 | 4 个独立窗口 | 1 个（内嵌设置/短信） |
| 最大连接数 | 10 台手机 | 10 台手机 |
| 系统托盘 | Electron Tray API | 原生 Win32 API |
| 日志压缩 | 无（rename 轮转） | zip 压缩旧日志 |
| 通信协议 | **完全相同** | **完全相同** |

> Go 版和 Electron 版的通信协议完全兼容（相同的端口、PIN 格式、消息类型），Android 手机端和 Chrome 扩展在通信层面无法区分连接的是哪个版本。

---

## 八、Chrome 扩展（v4.0.0）

### 8.1 架构

MV3 Service Worker 架构：

```
AutoDial-Extension/
├── manifest.json           ← host_permissions, content_scripts
├── background.js           ← Service Worker：双模路由 + PIN 管理
├── content-script.js       ← 内容脚本：CRM 浮动按钮 + 号码检测
├── popup.html / popup.js   ← 弹窗：云服务器 + PIN 配置
└── themes/                 ← 8 套主题 CSS
```

### 8.2 双模路由

- PC 直连优先（2s 超时），不可达时自动切云端
- 云端通过 `X-AutoDial-PIN` Header 认证
- PC 缓存失效时自动重置检测

### 8.3 CRM 支持

匹配域名：`zhudaicms.com`、`rxhcrm.com`、`rongxinhui.com`

内容脚本功能：
- TreeWalker 扫描页面电话号码 → 自动检测坐席手机号
- 浮动拨号按钮（可拖动，可缩放 36-100px）
- 右键菜单：主题切换、拨号、短信、PC 状态、PIN 显示

---

## 九、Android 端（v4.53）

### 9.1 核心组件

| 组件 | 职责 |
|------|------|
| `DialService.kt` | 前台服务（主入口），生命周期管理 |
| `ConnectionManager.kt` | 连接状态机 + LAN/Cloud 双通道管理 |
| `DialEngine.kt` | 拨号执行引擎 + SIM 选择（7 种模式） |
| `CallLogDb.kt` | SQLite 通话记录数据库 |
| `CloudCtrl.kt` | 云服务器 CRUD + Gist 同步 + 连通测试 |
| `DialAccessibilityService.kt` | Xiaomi/HyperOS SIM 自动点击 |
| `FileLogger.kt` | 文件日志（10MB 轮转 + 环形缓冲降级） |

### 9.2 连接策略

```kotlin
enum class ConnectionStrategy {
    AUTO,       // 同时发起 LAN 发现 + 云端连接，先到先用
    LAN_ONLY,   // 仅 LAN
    CLOUD_ONLY  // 仅云端
}
```

### 9.3 LAN 发现

- UDP 广播到 `255.255.255.255:35433`
- 发送 3 次 discover 请求，间隔 200ms，等待 8s
- 发现序列：首次 60s 后，后续每 120s

### 9.4 重连退避（与 PC 端一致）

```
尝试次数:  1    2    3    4-6   7-10  11-15  16-20   21+
延迟:     0s   1s   3s   5s    10s   30s    60s    300s
```

---

## 十、全链路 PIN 校验

| 环节 | 校验方式 | 位置 |
|------|---------|------|
| 扩展设置 | 11 位手机号正则（popup），云中继兼容 4 位 PIN | popup.js |
| 扩展请求 | X-AutoDial-PIN Header | background.js |
| Electron PC | `if (msg.pin !== PIN_CODE)` | main.js |
| Go PC | 11 位手机号强校验 | server.go / app.go |
| 云中继 REST | `is_valid_pin()`: 4 位纯数字 或 11 位手机号 | cloud_relay.py |
| 云中继 WS | 同上 | cloud_relay.py |
| Android | 11 位数字强校验 | ConnectionManager.kt |

---

## 十一、安全设计

| 机制 | 说明 |
|------|------|
| **PIN 强校验** | 全链路校验：PC/Android 端 11 位手机号，云中继兼容 4 位/11 位 |
| **并发保护** | PC_CONNECTED 去重 + DUPLICATE_DIAL 5s 去重 |
| **频率限制** | 每 IP 每分钟 5 次握手尝试 |
| **心跳超时** | WebSocket ping/pong（30s/90s 云端；15s/20s PC端） |
| **空 PIN 守卫** | PC 端未设置 PIN 时拒绝一切连接 |
| **generation 防竞态** | PC 端云中转使用递增 generation 防止旧连接事件覆盖新状态 |
| **ACK 确认** | 拨号/挂断指令 3s ACK 超时，自动切通道重试 |

---

## 十二、部署

| 组件 | 依赖 | 启动方式 |
|------|------|---------|
| 云中继 v2 | `websockets pystray Pillow` | `python cloud_relay.py` |
| 云中继 v3（可选） | `+ aiosqlite bcrypt PyJWT` | `python cloud_relay_v3.py` |
| Electron PC | Node.js + npm | `npm start` 或打包后 exe |
| Go PC | Go 1.21+ | `wails build` → 单文件 exe |
| Chrome 扩展 | 无 | Chrome 加载已解压 |
| Android | Kotlin + Gradle | Android Studio 构建或 GitHub Actions |

---

## 十三、端口体系

| 端口 | 协议 | 用途 | 组件 |
|------|------|------|------|
| **35430** | WS + HTTP | 云中继主端口（PinGroup 中继 + REST API） | cloud_relay.py |
| 35431 | HTTP | Web 管理面板 | web_server.py |
| **35432** | HTTP + WS | PC 端主服务（LAN 直连 + 扩展连接） | Electron/Go PC |
| **35433** | UDP | LAN 设备发现（广播 announce + 响应 discover） | 全部组件 |
| 35440 | WS | v3 JWT 云中继（并存，非主用） | cloud_relay_v3.py |
| 35441 | HTTP | v3 JWT REST API（并存，非主用） | cloud_relay_v3.py |
