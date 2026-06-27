# AutoDial 一键拨号系统 v4.0.0

> 整合版：4/11 位 PIN 兼容，零 JWT 依赖

## 项目概述

AutoDial 是一套跨屏一键拨号系统。用户在 CRM 网页中点击手机号，自动触发手机完成拨号。

**v4.0.0 整合版**：统一为**单一 PIN 体系**：
- 去掉了复杂的 JWT/密码/SQLite 认证栈
- 兼容 4 位配对码（老版 PC 端）和 11 位手机号（新版）
- 单文件云中继部署，零数据库依赖
- 扩展自动检测坐席手机号，无需手动登录

## 系统架构

```
                       ┌──────────────────────────┐
                       │   云中继 (端口 35430)       │
                       │   cloud_relay_v2.py       │
                       │                          │
     GET + Header PIN  │   WebSocket 中继           │
   ┌───────────────────│   REST API (dial/hangup)  │──────────────────┐
   │                   │   Web 管理面板             │                  │
   │                   └──────────────────────────┘                  │
   ▼                                                                 ▼
┌──────────────────┐                                        ┌──────────────────┐
│ Chrome 扩展 v4    │         HTTP 35432                    │ Android 手机端     │
│                  │◄──────────────────────────────────────│                  │
│ PIN 自动检测      │          Go PC 端（零改动）             │ WS 连接云中继     │
│ 双模路由         │                                        │ 接收 dial/hangup  │
│ 主题/浮动按钮     │                                        │ 发送 dial_result  │
└──────────────────┘                                        └──────────────────┘
```

## 端口配置

| 端口 | 协议 | 用途 |
|------|------|------|
| **35430** | WebSocket + HTTP | 云中继（WS 中继 + REST API + Web 管理面板） |
| 35432 | HTTP + WebSocket | PC 端主服务（局域网直连） |

> 旧版 v3 JWT 端口 35440/35441 已废弃，统一到 35430。

## 目录结构

```
├── cloud-relay/python/
│   ├── cloud_relay_v2.py            # ★ 云中继（WS 中继 + REST 端点 + Web 面板）
│   └── dashboard.html               # Web 管理界面
├── AutoDial-Extension/              # ★ Chrome 扩展 v4
│   ├── background.js                # PIN 管理 + 双模路由
│   ├── content-script.js            # 8 套主题 + 浮动按钮 + CRM 检测
│   ├── popup.js / popup.html        # PIN 设置 + 服务器配置
│   └── manifest.json                # MV3 清单
├── pc-app-go/                       # Go PC 端（局域网直连）
│   └── server.go                    # HTTP API + WebSocket + 4/11 位 PIN 校验
├── android/                         # Android 手机端
└── docs/                            # 补充文档
```

## 快速启动

### 1. 云中继

```bash
cd cloud-relay\python
pip install websockets pystray Pillow
python cloud_relay_v2.py
```

启动后：
- WebSocket 中继：`ws://localhost:35430`
- REST API：`http://localhost:35430`
- Web 管理面板：`http://localhost:35430`（浏览器打开）

### 2. Chrome 扩展

1. Chrome 打开 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"，选择 `AutoDial-Extension/` 目录
4. 点击扩展图标 → 设置服务器地址（默认 `http://IP:35430`）→ 确认 PIN
5. 打开 CRM 页面，自动检测坐席手机号为 PIN

### 3. Go PC 端

```bash
cd pc-app-go
go build -o autodial-pc.exe server.go
autodial-pc.exe
```

### 4. Android 手机端

使用 Android Studio 打开 `android/` 目录构建。

## REST API（端口 35430）

所有响应：`{"ok": bool, "code": "xxx", "message": "xxx"}`

PIN 通过 `X-AutoDial-PIN` Header 传递，号码通过 URL query。

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/dial?number=13900139000` | 拨号 → `ACCEPTED` |
| GET | `/api/v1/hangup` | 挂断 → `ACCEPTED` |
| GET | `/api/v1/status` | 查询 PC/手机在线状态 |
| GET | `/health` | 健康检查（含 CORS，供 popup 测试连接） |
| GET | `/api/status` | 仪表盘状态（内部管理用） |
| GET | `/api/clients` | 客户端列表 |
| GET | `/api/stats` | 流量统计 |
| GET | `/api/logs` | 系统日志 |

### 错误码

| code | 含义 |
|------|------|
| `ACCEPTED` | 指令已接受 |
| `INVALID_PIN` | PIN 非 4 位或 11 位数字 |
| `PHONE_OFFLINE` | 手机未连接云中继 |
| `PC_CONNECTED` | PC 在线，应走本地直连 |
| `DUPLICATE_DIAL` | 5 秒内同号码重复 |
| `INVALID_NUMBER` | 号码不合法 |

## 双模路由

```
扩展拨号:
1. 尝试 http://127.0.0.1:35432/dial  → PC 在线 → 走本地
2. PC 不可达 → GET 云中继 /api/v1/dial (Header PIN) 
   ├─ PC_CONNECTED → 切回本地
   ├─ PHONE_OFFLINE → 提示手机未连
   └─ ACCEPTED → 完成
```

## 全链路 PIN 校验

| 环节 | 校验 | 位置 |
|------|------|------|
| 扩展设置 PIN | `/^\d{4}$\|^\d{11}$/` 正则 | popup.js |
| 扩展请求云端 | X-AutoDial-PIN Header | background.js |
| 云中继 REST | `validate_pin()` → 4位或11位纯数字 | cloud_relay_v2.py |
| 云中继 WS | 同上 | cloud_relay_v2.py |
| Go PC 端 | `isValidPhonePIN()` → 4位或11位纯数字 | devices.go |

## 部署依赖

| 组件 | 依赖 | 文件数 |
|------|------|:---:|
| 云中继 | `websockets pystray Pillow` | 1 |
| Go PC 端 | Go 1.21+ | 1 |
| Chrome 扩展 | 无 | 6 |

## 注意事项

1. 云中继端口 35430 需防火墙放行（程序启动时自动配置）
2. Android 端需授予拨号、通话记录、通知等权限
3. MIUI/HyperOS 需将应用加入电池白名单
4. Xiaomi 设备在"设置→无障碍"中开启 AutoDial 服务
5. PC 端和云中继可同时运行，扩展自动优先走 PC 直连
