# AutoDial API 文档

## v3 REST API（云中继端口 35441）

所有 v3 API 以 `/api/v1/` 为前缀。响应统一格式：`{"ok": true/false, "data": {...}, "error": "..."}`。

需要 JWT 认证的端点需在请求头携带 `Authorization: Bearer <JWT>`。

### 认证

#### POST /api/v1/auth/register — 注册

**无需认证**

```json
// Request
{"phone": "13800138000", "password": "123456"}
// Response 201
{"ok": true, "data": {"token": "eyJ...", "refresh_token": "abc...", "phone": "13800138000"}}
// 错误 409
{"ok": false, "error": "该手机号已注册"}
```

#### POST /api/v1/auth/login — 登录

**无需认证**。IP + 手机号双维度限流，15 分钟内最多 5 次失败。

```json
// Request
{"phone": "13800138000", "password": "123456"}
// Response 200
{"ok": true, "data": {"token": "eyJ...", "refresh_token": "abc...", "phone": "13800138000"}}
// 错误 401
{"ok": false, "error": "手机号或密码错误"}
// 错误 429
{"ok": false, "error": "请求过于频繁，请15分钟后再试"}
```

#### POST /api/v1/auth/refresh — 续期

```json
// Request
{"refresh_token": "上次登录获得的 refresh_token"}
// Response 200
{"ok": true, "data": {"token": "新JWT", "refresh_token": "新refresh_token"}}
// refresh_token 只能用一次，续期后旧 token 立即吊销
```

### 业务

#### GET /api/v1/status — 设备状态

**需要 JWT 认证**

```json
// Response 200
{"ok": true, "data": {"phone_online": true, "device_name": "Redmi K40"}}
```

#### POST /api/v1/dial — 拨号

**需要 JWT 认证**

```json
// Request
{"phone": "13800138000"}
// Response 202（手机在线）
{"ok": true, "data": {"req_id": "a1b2c3d4", "status": "pending"}}
// 错误 409（手机离线）
{"ok": false, "error": "没有在线的手机"}
// 错误 401（未登录）
{"ok": false, "error": "未登录"}
```

#### GET /api/v1/dial/result?req_id=xxx — 查拨号结果

**需要 JWT 认证**。只能查自己的拨号结果。

```json
// Response 200
{"ok": true, "data": {"status": "ok", "number": "13800138000"}}
// status 可能值: "pending" | "ok" | "error" | "timeout" | "unknown"
```

#### POST /api/v1/hangup — 挂断

**需要 JWT 认证**

```json
// Response 202
{"ok": true, "data": {}}
```

#### POST /api/v1/sms — 发短信

**需要 JWT 认证**

```json
// Request
{"phone": "13800138000"}
// Response 202
{"ok": true, "data": {}}
```

---

## v2 HTTP API（PC 端端口 35432）

过渡期保留，供 PC 直连模式使用。无需认证。

| 端点 | 说明 |
|------|------|
| `GET /dial?number=xxx` | 拨号 |
| `GET /hangup` | 挂断 |
| `GET /sms?number=xxx&content=xxx` | 短信 |
| `GET /open` | 打开 PC 端主窗口 |
| `GET /` | 获取 PC 端状态 |

## 浏览器扩展集成

扩展 v3 在 `background.js` 中实现双模路由：

```
拨号请求
  ├── 检测 PC 可用（GET 127.0.0.1:35432/）
  │   ├── PC 在线 → 使用 v2 HTTP API
  │   └── PC 离线 → 使用 v3 REST API (JWT)
  │        └── POST /api/v1/dial → 202 → pollDialResult(req_id, 3000)
  └── 无 JWT → 提示登录
```
