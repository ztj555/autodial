# AutoDial 一键拨号系统

## 项目概述

AutoDial 是一套跨屏一键拨号系统。用户在 CRM 网页中点击手机号，自动触发手机完成拨号，无需手动操作手机。

系统已升级至 **v3 架构**：从 PIN 配对码升级为 **JWT 账号体系**，支持云端注册登录、自动续期、多设备管理。旧版 PIN 体系与新 JWT 体系**共存运行**，互不干扰。

## 系统架构（v3 双版本共存）

```
                    ┌─────────────────────────────────┐
                    │        云中继服务器               │
                    │                                  │
  JWT 设备 ────→   │  35440 (JWT WebSocket)     ←── JWT 设备
                    │  35441 (REST API)               │
                    │                                  │
  老 PIN 设备 ──→  │  35430 (PIN WebSocket)     ←── 老 PIN 设备
                    │  35431 (Web 管理面板)            │
                    └─────────────────────────────────┘
                              ↑               ↑
                              │               │
                    手机 / 插件 / PC        手机 / 老 PC
```

| 版本 | 端口 | 认证 | 客户端 |
|------|------|------|--------|
| **v3 (新)** | 35440 WS + 35441 REST | JWT (手机号+密码 → bcrypt → 15min JWT + 30天 refresh_token) | 新 Android、Chrome 插件 |
| **v2 (旧)** | 35430 WS + 35431 Web | PIN 4位配对码 | 老 Android、老 PC 端 |

> 💡 新老端口分离，两套同时运行，互不干扰。老用户无感，新用户走 JWT。

## 组件列表

| 组件 | 技术栈 | v3 状态 |
|------|--------|---------|
| **新版云中继 v3** | Python (aiohttp + websockets + aiosqlite) | ✅ 已实现 |
| **旧版云中继 v2** | Python (websockets) | ✅ 保留运行（35430） |
| **Android 手机端** | Kotlin | ✅ 支持 PIN + JWT 双模 |
| **Chrome 扩展 v3** | MV3 (background.js + content-script.js + popup.js) | ✅ 已重写 |
| **PC 端 Electron 版** | Electron + Node.js | 保留（过渡期） |
| **PC 端 Go 版** | Go + Wails v2 | 保留（过渡期） |

### 架构演进

```
v1/v2:  CRM → 浏览器插件 → PC端(35432) → 手机
                              └── 云中继(35430) ──→ 手机（跨网络）

v3:     CRM → 浏览器插件 → 云中继 v3(35441 REST) → 云中继 v3(35440 WS) → 手机
             ↑ JWT 认证                                ↑ JWT 握手
```

> 去 PC 端：v3 的核心变化是去掉中间的 PC 桌面软件，浏览器插件直接通过云端 REST API 拨号。

## 目录结构

```
├── android/                         # Android 手机端（Kotlin）
├── cloud-relay/python/
│   ├── cloud_relay_v3.py            # ★ v3 云中继（JWT WebSocket + REST API）
│   ├── cloud_relay_v2.py            # v2 云中继（PIN WebSocket，保留兼容）
│   ├── auth.py                      # ★ v3 JWT 认证（bcrypt + 限流）
│   ├── db.py                        # ★ v3 数据库层（aiosqlite）
│   ├── requirements.txt             # Python 依赖
│   └── test_cloud_relay_v3.py       # v3 单元测试（pytest）
├── AutoDial-Extension/              # ★ Chrome 扩展 v3
│   ├── background.js                # JWT 管理 + 双模路由 + 拨号轮询
│   ├── content-script.js            # 8 套主题 + 浮动按钮 + CRM 检测
│   ├── popup.js                     # 登录界面
│   └── popup.html                   # 弹出页
├── pc-app/                          # PC 端 Electron 版（过渡期保留）
├── pc-app-go/                       # PC 端 Go/Wails 版（过渡期保留）
└── docs/                            # 补充文档
```

## 端口配置

| 端口 | 协议 | 版本 | 用途 |
|------|------|------|------|
| **35440** | WebSocket | v3 | JWT 认证的 WS 中继 |
| **35441** | HTTP REST | v3 | JWT REST API（登录/注册/拨号/状态） |
| 35430 | WebSocket + HTTP | v2 | PIN 认证的 WS 中继 + Web 管理面板 |
| 35432 | HTTP + WebSocket | v2 | PC 端主服务（过渡期） |
| 35433 | UDP | v2 | PC 端局域网设备发现 |

## 快速启动

### 1. 新版云中继 v3

```bash
cd cloud-relay\python
pip install -r requirements.txt
python cloud_relay_v3.py
```

启动后：
- JWT WebSocket 中继：`ws://localhost:35440`
- REST API：`http://localhost:35441`
- 注册页面：`http://localhost:35441/register`

环境变量配置：
- `AUTODIAL_JWT_SECRET`：JWT 签名密钥（优先级最高）
- `AUTODIAL_WS_PORT`：WebSocket 端口（默认 35440）
- `AUTODIAL_HTTP_PORT`：REST API 端口（默认 35441）

首次启动自动生成 `.jwt_secret` 文件，数据库文件 `autodial.db` 自动创建。

### 2. 旧版云中继 v2（兼容老用户）

```bash
cd cloud-relay\python
python cloud_relay_v2.py
# 端口 35430 (WS) + 35431 (Web 管理面板)
```

### 3. Chrome 扩展

1. Chrome 打开 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"，选择 `AutoDial-Extension/` 目录
4. 点击扩展图标 → 设置服务器地址 → 登录

### 4. Android 手机端

使用 GitHub Actions 自动构建，或 Android Studio 打开 `android/` 目录手动构建。

## 首次使用（v3 JWT 方式）

1. **部署云中继 v3**：启动 `cloud_relay_v3.py`
2. **注册账号**：浏览器打开 `http://服务器IP:35441/register`，输入手机号和密码
3. **安装扩展**：Chrome 加载 `AutoDial-Extension/`
4. **登录**：点击扩展图标 → 设置服务器地址（如 `http://服务器IP:35441`）→ 输入手机号密码登录
5. **手机连接**：手机端输入手机号密码登录，自动通过 JWT 连接云中继
6. **开始使用**：在 CRM 页面点击号码 → 自动拨号

### 自动登录（日常无感）

- 登录成功后，扩展自动保存 `refresh_token`（30 天有效）
- 每次打开浏览器自动静默续期，无需再次输入密码
- CRM 页面检测到坐席手机号时自动静默续期

## v3 核心协议

### REST API（端口 35441）

所有响应统一格式：`{"ok": true/false, "data": {...}, "error": "..."}`

| 方法 | 路径 | 用途 | 认证 |
|------|------|------|------|
| POST | `/api/v1/auth/register` | 注册 | 无 |
| POST | `/api/v1/auth/login` | 登录 → JWT + refresh_token | 无 |
| POST | `/api/v1/auth/refresh` | 续期 → 新 JWT + 新 refresh_token | refresh_token |
| GET | `/api/v1/status` | 查手机在线状态 | Bearer JWT |
| POST | `/api/v1/dial` | 拨号 → 202 Accepted + req_id | Bearer JWT |
| GET | `/api/v1/dial/result?req_id=xxx` | 查拨号结果 | Bearer JWT |
| POST | `/api/v1/hangup` | 挂断 | Bearer JWT |
| POST | `/api/v1/sms` | 发短信 | Bearer JWT |

### WebSocket 握手（端口 35440）

**v3 JWT 方式**：
```json
{"type": "phone_hello", "auth_method": "jwt", "token": "<JWT>", "deviceName": "Redmi K40"}
→ {"type": "auth_ok", "user_id": 42, "phone": "13800138000"}
```

**v2 PIN 兼容**（同一端口也支持）：
```json
{"type": "phone_hello", "auth_method": "pin", "pin": "1234", "deviceName": "Redmi K40"}
→ {"type": "auth_ok", "pin": "1234", "pcCount": 1, "pc_present": true}
```

### 拨号确认流程（v3）

```
插件 POST /api/v1/dial → 云中继返回 202 {req_id, status:"pending"}
云中继 WS → 手机 {type:"dial", number, req_id}
手机拨出 → WS 回 {type:"dial_ack", req_id, status:"ok"}
插件轮询 GET /api/v1/dial/result?req_id=xxx → {status:"ok"}
```

## 安全设计

| 机制 | 说明 |
|------|------|
| **bcrypt** | 密码只存哈希，原文不落地 |
| **JWT 短有效期** | 15 分钟过期，用完即弃 |
| **refresh_token** | 30 天有效，存 SHA-256 哈希，可 DB 吊销 |
| **防爆破** | IP + 手机号双维度限流，5次/15分钟 |
| **密钥管理** | 环境变量 > 权限锁文件(.jwt_secret) > 自动生成 |

## 注意事项

1. Android 端需授予拨号、通话记录、通知等权限
2. 云中继 v3 端口 35440/35441 需防火墙放行
3. MIUI/HyperOS 需将应用加入电池白名单
4. Xiaomi 设备在"设置→无障碍"中开启 AutoDial 服务以支持 SIM 自动选择
5. v2 PC 端和 v3 云中继可同时运行，互不干扰
