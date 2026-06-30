# AutoDial 云端技术文档

> 最后修改：2026-06-30 21:15 | Python | SQLite 4表 | 管理面板2.0 | CRM kid同步

---

## 一、云端代码结构

```
cloud-relay/
├── start.bat                    ← Windows 启动脚本
├── package.json                 ← npm 元数据（部分已弃用）
├── server.js.deprecated         ← 旧 JS 实现（已弃用）
├── launcher.cpp / Launcher.cs   ← C++/C# 托盘启动器
└── python/
    ├── cloud_relay.py           ← ★ 主中继（v2 PIN-only，纯 WS 中继，约20KB）
    ├── cloud_relay_v2.py        ← v2 增强版（集成 Web 管理界面，约54KB，同端口35430）
    ├── cloud_relay_v3.py        ← v3 JWT 双模中继（并存，非生产主用，端口35440/35441）
    ├── auth.py                  ← v3 JWT + bcrypt 认证模块
    ├── db.py                    ← v3 SQLite 数据库模块（aiosqlite）
    ├── web_server.py            ← Web 管理面板（端口 35431）
    ├── dashboard.html           ← 管理面板 HTML
    ├── requirements.txt         ← Python 依赖
    ├── test_cloud_relay.py      ← v2 测试
    └── test_cloud_relay_v3.py   ← v3 测试
```

---

## 二、主中继：cloud_relay.py（v2 PIN-only）

### 2.1 概述

- **版本**：v2
- **端口**：35430（WebSocket + HTTP REST API 共用）
- **依赖**：`websockets pystray Pillow`（无数据库）
- **认证**：PIN（建议 11 位手机号，最低 4 位）
- **部署**：`python cloud_relay.py` 单命令启动

### 2.2 核心机制：PinGroup 分组

```python
class PinGroup:
    def __init__(self):
        self.pcs = set()       # 同 PIN 的 PC WebSocket 连接集合
        self.phones = set()    # 同 PIN 的手机 WebSocket 连接集合
        self.last_dial = {}    # {number: timestamp} — REST 并发去重
```

**路由逻辑**：
- `phone_hello{pin, deviceName}` → 手机加入 `pin_groups[pin].phones`
- `pc_hello{pin, hostname}` → PC 加入 `pin_groups[pin].pcs`
- `dial{nubmer}` → `forward_to_phones(group, msg)` → 广播给组内所有手机
- `dial_result{status}` → `forward_to_pcs(group, msg)` → 广播给组内所有 PC
- 组内设备全部断开时自动清理 `del pin_groups[pin]`

### 2.3 WebSocket 协议

#### 手机端握手
```
→ {"type": "phone_hello", "pin": "13800138000", "deviceName": "Redmi K40"}
← {"type": "auth_ok", "pin": "13800138000", "pcCount": 1, "pc_present": true}

验证失败:
← {"type": "auth_fail", "reason": "配对码无效（需4位或11位手机号）"}
```

#### PC 端握手
```
→ {"type": "pc_hello", "pin": "13800138000", "hostname": "DESKTOP-ABC"}
← {"type": "pc_auth_ok", "pin": "13800138000", "phoneCount": 1}

验证失败:
← {"type": "pc_auth_fail", "reason": "PIN格式不正确"}
```

#### PC 在线/离线通知
```
云 → 手机:
← {"type": "pc_online", "pin": "13800138000"}
← {"type": "pc_offline", "pin": "13800138000"}
```

### 2.4 REST API

REST 端点**不设 CORS**（MV3 Chrome 扩展通过 `host_permissions` 绕过）。仅 `/health` 有 CORS（供 popup 测试连接使用）。

#### GET /api/v1/dial
```
请求: GET /api/v1/dial?number=13900139000
Header: X-AutoDial-PIN: 13800138000

响应: {"ok": true, "code": "ACCEPTED"}
```

处理流程：
1. 从 Header 读取并校验 PIN（4 位纯数字 或 11 位手机号 `1[3-9]xxxxxxxxx`）
2. 校验号码（3-20 位数字，允许 `+` `*` `#`，兼容 10086/固话/400/*100#）
3. 检查 PinGroup.pcs → PC 在线 → 返回 `PC_CONNECTED`（让扩展走本地）
4. 检查 PinGroup.phones → 无手机 → 返回 `PHONE_OFFLINE`
5. 5 秒去重检查 → 同号码 → 返回 `DUPLICATE_DIAL`
6. `asyncio.ensure_future(forward_to_phones(...))` → 返回 `ACCEPTED`

#### GET /api/v1/hangup
```
Header: X-AutoDial-PIN: 13800138000
→ {"ok": true, "code": "ACCEPTED"}
```

#### GET /api/v1/status
```
Header: X-AutoDial-PIN: 13800138000
→ {"ok": true, "pin": "13800138000", "pcConnected": true, "phoneConnected": true, "phoneCount": 1}
```

#### GET /health
```
→ {"status": "ok", "timestamp": "...", "version": "2.0.0", "uptime": 3600}
```
此端点**有 CORS**（允许页面端测试连接）。

### 2.5 错误码

| code | 含义 |
|------|------|
| `ACCEPTED` | 指令已接受 |
| `INVALID_PIN` | PIN 格式错误（需4位或11位手机号） |
| `PHONE_OFFLINE` | 手机未连接 |
| `PC_CONNECTED` | PC 在线，扩展应走本地 |
| `DUPLICATE_DIAL` | 5 秒内同号码重复 |
| `RATE_LIMITED` | IP 频率限制（每分钟 5 次握手） |
| `INVALID_NUMBER` | 号码格式不合法 |

### 2.6 管理 API

| 端点 | 说明 |
|------|------|
| `GET /api/status` | 全局状态：分组数、设备数、消息统计 |
| `GET /api/clients` | 所有客户端详情（PIN、类型、连接时间） |
| `GET /api/stats` | 消息转发统计 |
| `GET /api/logs` | 最近日志（内存环形缓冲） |

### 2.7 系统托盘

使用 `pystray` + `Pillow` 实现 Windows 系统托盘：
- 右键菜单：显示 Web 面板 / 查看状态 / 显示日志 / 退出
- 图标：程序化生成金色电话图标

---

## 三、v3 JWT 中继（并存模块）

### 3.1 概述

- **文件**：`cloud_relay_v3.py` + `auth.py` + `db.py`
- **端口**：WS 35440 + HTTP 35441（与 v2 35430 隔离）
- **版本**：0.02
- **依赖**：`aiosqlite bcrypt PyJWT`（增量依赖）
- **认证**：JWT + PIN 双模

### 3.2 双模握手

```python
if auth_method == "jwt":
    # JWT 验证 → jwt_devices 分组
    verify_jwt(token)
elif auth_method == "pin":
    # PIN 验证 → pin_groups 分组
    verify_pin(pin)
```

JWT 设备走 `jwt_devices[user_id]` 路由，PIN 设备走 `pin_groups[pin]` 路由，两组数据结构独立。

### 3.3 认证模块（auth.py）

```python
# 依赖: bcrypt + PyJWT (HS256)
- POST /api/v1/auth/login       → 手机号 + 密码 → JWT + refresh_token
- POST /api/v1/auth/auto-login  → 手机号 → JWT（免密码快速登录）
- POST /api/v1/auth/refresh     → refresh_token → 新 JWT
- 防爆破限流：每 IP 每分钟 3 次失败 → 锁定 5 分钟
```

### 3.4 数据库模块（db.py）

`aiosqlite` 异步 SQLite，包含以下表：

| 表 | 用途 |
|----|------|
| `users` | 用户账号（手机号 + bcrypt 密码哈希） |
| `refresh_tokens` | JWT 刷新令牌（支持轮换） |
| `devices` | 用户设备注册 |
| `audit_log` | 操作审计日志 |

### 3.5 状态说明

> **v3 JWT 模块不作为主中继使用**。主中继由 cloud_relay.py (v2 PIN-only) 承担。v3 代码保留在代码库中供有 JWT 认证需求的场景选用，运行在独立端口 35440/35441，不影响主中继。

---

## 四、Web 管理面板（端口 35431）

`web_server.py` + `dashboard.html` 提供基于浏览器的管理界面：

- 实时连接状态（PinGroup 列表、设备数）
- 消息转发统计（今日/总计）
- 客户端详情（PIN、类型、IP、连接时长）
- 在线日志查看
- 版本：2.0.0

---

## 五、部署说明

### 5.1 主中继（推荐）

```bash
pip install websockets pystray Pillow
python cloud_relay.py
```

### 5.2 含 v3 可选模块

```bash
pip install websockets pystray Pillow aiohttp aiosqlite bcrypt PyJWT
# 主中继
python cloud_relay.py &
# v3 JWT 中继（可选，独立端口）
python cloud_relay_v3.py &
```

### 5.3 防火墙要求

| 端口 | 协议 | 用途 |
|------|------|------|
| 35430 | TCP | 主中继（WS + REST） |
| 35431 | TCP | Web 管理面板 |
| 35440 | TCP | v3 JWT WebSocket（可选） |
| 35441 | TCP | v3 JWT REST API（可选） |

---

## 六、与 PC 端/手机端的交互

```
PC/手机 → cloud_relay.py:35430 (WS phone_hello/pc_hello)
         ← auth_ok 认证成功
         ← 消息双向转发（同 PIN 组内）

扩展   → cloud_relay.py:35430 (REST /api/v1/dial)
         ← ACCEPTED → PinGroup 转发给手机

管理   → web_server.py:35431 (Web 面板)
```
