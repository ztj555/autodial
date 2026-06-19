# AutoDial 技术文档 v3

> 基于实际代码 | 最后更新：2026-06-19  
> 包含 v2 (PIN) 和 v3 (JWT) 双版本协议

---

## 一、版本关系

| 版本 | 云中继 | 端口 | 认证 | 客户端 |
|------|--------|------|------|--------|
| **v3** | `cloud_relay_v3.py` | 35440 WS + 35441 REST | JWT (手机号+密码) | 新 Android、Chrome 插件 v3 |
| **v2** | `cloud_relay_v2.py` | 35430 WS + 35431 Web | PIN 4位配对码 | 老 Android、老 PC 端 |

新老版本通过**端口分离**实现共存，互不干扰。v3 的核心变化是：**去掉 PC 桌面软件**, 浏览器插件通过 REST API 直连云中继拨号。

---

## 二、v3 JWT 认证体系

### 2.1 数据库设计（SQLite, aiosqlite, WAL 模式）

```sql
-- users: 用户表 -- bcrypt 哈希存储密码
CREATE TABLE users (id INTEGER PK, phone TEXT UNIQUE, password TEXT, name TEXT, created_at TEXT);
-- refresh_tokens: 续期令牌（只存 SHA-256 哈希）
CREATE TABLE refresh_tokens (id INTEGER PK, user_id INTEGER FK, token_hash TEXT, expires_at TEXT, revoked INTEGER DEFAULT 0);
CREATE INDEX idx_rt_hash ON refresh_tokens(token_hash);
-- devices: 设备注册（原子 upsert）
CREATE TABLE devices (id INTEGER PK, user_id INTEGER FK, device_name TEXT, device_type TEXT, last_heartbeat TEXT, is_active INTEGER DEFAULT 1, UNIQUE(user_id, device_name));
-- audit_log: 审计日志
CREATE TABLE audit_log (id INTEGER PK, user_id INTEGER, action TEXT, detail TEXT, ip TEXT, created_at TEXT);
```

### 2.2 JWT 密钥管理

三层优先级：
1. 环境变量 `AUTODIAL_JWT_SECRET`
2. 密钥文件 `.jwt_secret`（程序目录，Windows 上通过 icacls 设只读）
3. 自动生成（`secrets.token_hex(32)`）

### 2.3 Token 生命周期

```
注册/登录 → bcrypt(password) → 返回 JWT(15min) + refresh_token(30天, 存SHA-256哈希)
         ↓
自动续期 → POST /api/v1/auth/refresh(body: {refresh_token}) → 新JWT + 新refresh_token(旧吊销)
         ↓
改密码/强制下线 → UPDATE refresh_tokens SET revoked=1 WHERE user_id=?
```

### 2.4 防爆破限流

- 维度：IP + 手机号独立限流
- 规则：同一 key 15 分钟内最多 5 次失败
- 超过阈值返回 HTTP 429
- 登录成功后重置限流计数器

---

## 三、v3 REST API（端口 35441）

### 3.1 响应格式

```json
{"ok": true,  "data": {...}, "error": ""}
{"ok": false, "data": null,  "error": "描述信息"}
```

### 3.2 认证端点

**POST `/api/v1/auth/register`**
```json
// Request
{"phone": "13800138000", "password": "123456"}
// Response 201
{"ok": true, "data": {"token": "<JWT>", "refresh_token": "<raw>", "phone": "13800138000"}}
```

**POST `/api/v1/auth/login`**
```json
// Request
{"phone": "13800138000", "password": "123456"}
// Response 200
{"ok": true, "data": {"token": "<JWT>", "refresh_token": "<raw>", "phone": "13800138000"}}
// 失败 401
{"ok": false, "error": "手机号或密码错误"}
```

**POST `/api/v1/auth/refresh`**
```json
// Request
{"refresh_token": "<上次登录获得的 refresh_token>"}
// Response 200
{"ok": true, "data": {"token": "<新JWT>", "refresh_token": "<新refresh_token>"}}
```

### 3.3 业务端点

**GET `/api/v1/status`** — 查手机在线状态
```json
// Header: Authorization: Bearer <JWT>
// Response
{"ok": true, "data": {"phone_online": true, "device_name": "Redmi K40"}}
```

**POST `/api/v1/dial`** — 拨号（202 Accepted）
```json
// Header: Authorization: Bearer <JWT>
// Request
{"phone": "13800138000"}
// Response 202
{"ok": true, "data": {"req_id": "a1b2c3d4", "status": "pending"}}
// 手机离线 409
{"ok": false, "error": "没有在线的手机"}
```

**GET `/api/v1/dial/result?req_id=a1b2c3d4`** — 查拨号结果
```json
{"ok": true, "data": {"status": "ok", "number": "13800138000"}}
// status 可能值: pending | ok | error | timeout | unknown
```

**POST `/api/v1/hangup`**
```json
// Header: Authorization: Bearer <JWT>
// Response 202
{"ok": true, "data": {}}
```

**POST `/api/v1/sms`**
```json
// Header: Authorization: Bearer <JWT>
// Request
{"phone": "13800138000"}
// Response 202
{"ok": true, "data": {}}
```

### 3.4 注册页面

浏览器打开 `http://服务器:35441/register` 呈现内置 HTML 注册页面。

---

## 四、v3 WebSocket 协议（端口 35440）

### 4.1 握手协议

v3 WebSocket 同时支持 JWT 和旧 PIN 两种认证方式，通过 `auth_method` 字段区分。

**JWT 握手**：
```json
// 手机端发送
{"type": "phone_hello", "auth_method": "jwt", "token": "<JWT>", "deviceName": "Redmi K40"}
// 云端回复
{"type": "auth_ok", "user_id": 42, "phone": "13800138000"}
// 或失败
{"type": "auth_fail", "reason": "Token无效"}
```

**PIN 握手（兼容老设备）**：
```json
// 手机端发送
{"type": "phone_hello", "pin": "1234", "deviceName": "Redmi K40"}
// 云端回复（含 pc_present 字段）
{"type": "auth_ok", "pin": "1234", "pcCount": 1, "pc_present": true}
```

**JWT 插件（扩展）握手**：
```json
{"type": "pc_hello", "auth_method": "jwt", "token": "<JWT>", "hostname": "DESKTOP-ABC"}
→ {"type": "pc_auth_ok", "user_id": 42, "phone": "13800138000"}
```

### 4.2 JWT 路由

- JWT 设备通过 `user_id` 路由，而非 PIN
- `forward_to_user_phones(user_id, msg)` — 发给该用户的所有手机
- `forward_to_user_pcs(user_id, msg)` — 发给该用户的所有插件连接

### 4.3 拨号确认流程（`dial_ack`）

```
插件 → REST /api/v1/dial → 云端生成 req_id → WS 发给手机
手机拨出 → WS 回 {"type":"dial_ack", "req_id":"xxx", "status":"ok"}
云端更新 dial_results[req_id]
插件轮询 GET /api/v1/dial/result → 拿到结果
```

### 4.4 心跳

- WebSocket 内置 ping/pong：30s 间隔，90s 超时
- 应用层心跳也保留：45s 超时检查

---

## 五、v2 PIN 协议（端口 35430）

（保留原有的 v2 协议完整支持，供老设备使用。详见上一版技术文档。）

**关键消息类型**：

| type | 方向 | 说明 |
|------|------|------|
| `phone_hello` | 手机→PC/云 | PIN 握手 + deviceName |
| `pc_hello` | PC→云 | PC 注册到云中继 |
| `auth_ok` | PC/云→手机 | 认证成功，云版含 `pc_present` |
| `auth_fail` | →手机 | 认证失败 |
| `dial` | PC→手机 | 拨号指令 |
| `dial_result` | 手机→PC | 拨号结果 |
| `sms` / `sms_result` | PC⇌手机 | 短信指令/结果 |
| `hangup` | PC→手机 | 挂断 |
| `ping` / `pong` | 双向 | 心跳 |
| `ack` | 手机→PC | ACK 确认 |
| `reconnect_request` | PC→云→手机 | 云端唤醒 |
| `pc_online` / `pc_offline` | 云→手机 | PC 上下线通知 |

---

## 六、Chrome 扩展 v3 实现

### 6.1 background.js（Service Worker）

**双模路由**：
- PC 直连优先（每 15s 重检），3 次失败后切云端
- 云端通过 REST API + JWT 认证

**JWT 管理**：
- `getToken()`：优先内存缓存 → 检查 chrome.storage → `isTokenExpired()` → 自动 refresh
- 永不缓存密码，自动续期靠 `refresh_token`
- CRM 自检测到坐席手机号时自动静默续期

**拨号确认**：
- 云端拨号 → 202 Accepted → `pollDialResult(req_id, 3000ms)` 轮询等待手机确认

### 6.2 content-script.js（内容脚本）

**8 套主题**（支持运行时切换）：
dark-gold / cyber-frost / deep-space / cyberpunk / minimalist / forest-green / energetic-orange / ocean-blue

**浮动按钮**：
- 拨号按钮：右上角悬浮，可拖动，显示检测到的号码
- 挂断按钮：椭圆形，可拖拽 + 左下角缩放手柄（36-100px）

**CRM 检测**：
- CSS 选择器优先检测坐席手机号
- `MutationObserver` + 500ms debounce 监控 SPA 页面变化
- 检测到本机手机号 → 自动静默续期 JWT

### 6.3 popup.js（弹窗）

- 服务器地址配置 + 连通性测试
- 手机号 + 密码登录
- 登录状态显示（已登录手机号、连接模式）

---

## 七、Android 端 v3 改造

### 7.1 JWT 支持

**ConnectionManager**：
- `phone_hello` 支持 `auth_method: "jwt"` 模式
- 有 JWT token 时自动使用 JWT 认证，fallback PIN

**ConnectFragment**：
- 输入 11 位手机号 → 检测是否有 JWT token
- 有 token → 直接用 JWT 连接云中继 v3
- 无 token → 弹出登录对话框 → POST `/api/v1/auth/login` → 保存 JWT + refresh_token

**PrefCtrl**：
- `getJwtToken()` / `setJwtToken()`
- `getRefreshToken()` / `setRefreshToken()`
- `getLoginPhone()` / `setLoginPhone()`
- `getCloudServer()` — 兼容旧的 cloud_server 配置

### 7.2 云中继地址自动转换

```kotlin
// ws://server:35440 → http://server:35441
fun getCloudApiUrl(): String {
    val server = prefs.getString("cloud_server", "") ?: ""
    if (server.isNotEmpty()) {
        return server.replace("ws://", "http://").replace("wss://", "https://")
            .replace(":35440", ":35441")
    }
    return "http://262ao85kz470.vicp.fun:35441"
}
```

---

## 八、安全架构总结

| 层面 | v3 (JWT) | v2 (PIN) |
|------|----------|----------|
| 认证 | bcrypt 哈希 + JWT(HS256, 15min) | 4 位数字 PIN |
| 续期 | refresh_token (SHA-256 哈希, 30天, 可吊销) | 无，手动重连 |
| 防爆破 | IP + 手机号双维度, 5次/15min | IP 频率限制, 5次/分钟 |
| 密钥 | 环境变量 > 0600 文件 > 自动生成 | 无（PIN 够简单） |
| 吊销 | `UPDATE refresh_tokens SET revoked=1` | 改端上的 PIN |
| 审计 | audit_log 表记录 login/dial/register 等 | 日志文件 |
