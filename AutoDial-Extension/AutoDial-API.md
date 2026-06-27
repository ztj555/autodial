# AutoDial v4 API 文档

> 整合版 | 云中继端口 35430 | 4/11 位 PIN 兼容

## REST API（云中继 35430）

所有响应：`{"ok": bool, "code": "xxx", "message": "xxx"}`

PIN 通过 `X-AutoDial-PIN` Header 传递，号码通过 URL query 传递。全部使用 GET 方法（`process_request` 不接收 POST body）。

### 业务端点

#### GET /api/v1/dial?number=13900139000 — 拨号

```
Header: X-AutoDial-PIN: 13800138000
```

```json
// 成功
{"ok": true, "code": "ACCEPTED"}
// PIN 格式错误
{"ok": false, "code": "INVALID_PIN", "message": "PIN 格式错误"}
// PC 在线，应走本地
{"ok": false, "code": "PC_CONNECTED", "message": "PC 端在线，请走本地直连"}
// 手机离线
{"ok": false, "code": "PHONE_OFFLINE", "message": "手机未连接"}
// 5 秒内同号码
{"ok": false, "code": "DUPLICATE_DIAL", "message": "相同号码正在拨号中"}
// 号码不合法
{"ok": false, "code": "INVALID_NUMBER", "message": "号码不合法"}
```

处理流程：PIN 强校验 → 检查 PC 在线 → 检查手机在线 → 5s 去重 → 异步转发 → 返回 ACCEPTED。

#### GET /api/v1/hangup — 挂断

```
Header: X-AutoDial-PIN: 13800138000
```

```json
{"ok": true, "code": "ACCEPTED"}
```

错误码同 dial：`INVALID_PIN` / `PC_CONNECTED` / `PHONE_OFFLINE`。

#### GET /api/v1/visit — 一键登记（v4.1 新增）

```
Header: X-AutoDial-PIN: 13800138000
Query: ?name=张三&mobile=13900139000&kefu_tel=13800138000&visit_type=贷款咨询&source=plugin
```

```json
// 成功
{"ok": true, "code": "ACCEPTED", "id": 1}
// 缺少字段
{"ok": false, "code": "MISSING_FIELDS", "message": "缺少必填字段: name, mobile, kefu_tel"}
// PIN 格式错误
{"ok": false, "code": "INVALID_PIN", "message": "PIN 格式错误，须为4位或11位数字"}
```

处理流程：PIN 校验 → SQLite 存储 → 后台同步 CRM → WS 推送 `visit_record` 给手机（离线则堆积到 pending_visits）。

#### GET /api/v1/visits?pin=xxx — 查询登记列表（v4.1 新增）

返回该 PIN 的所有登记记录 JSON 数组，按 `created_at` 降序。

#### GET /api/v1/visit/update?id=N&name=...&... — 更新记录（v4.1 新增）

#### GET /api/v1/visit/delete?id=N — 删除记录（v4.1 新增）

#### GET /api/v1/status — 设备状态

```
Header: X-AutoDial-PIN: 13800138000
```

```json
{
  "ok": true,
  "pin": "13800138000",
  "pcConnected": true,
  "phoneConnected": true,
  "phoneCount": 1
}
```

### 管理端点

| 端点 | 说明 | CORS |
|------|------|:---:|
| GET `/health` | 健康检查（版本/端口/运行时间/连接数） | ✅ |
| GET `/api/status` | 仪表盘状态（服务/端口/消息数/流量） | — |
| GET `/api/clients` | 客户端列表（设备名/角色/PIN/IP/连接时间） | — |
| GET `/api/stats` | 流量统计（总消息数/上下行流量/按天） | — |
| GET `/api/logs` | 系统日志（最近 100 条） | — |
| GET `/` | Web 管理面板 HTML | — |

> 仅 `/health` 有 CORS（供 popup 测试连接）。其余端点不加——MV3 扩展 `background.js` 的 `fetch()` 有 `host_permissions` 时不受 CORS 限制。

### 错误码枚举

| code | 含义 | 扩展处理 |
|------|------|---------|
| `ACCEPTED` | 指令已接受 | 正常 |
| `INVALID_PIN` | PIN 非 4 位或 11 位数字 | 提示检查 PIN 设置 |
| `PHONE_OFFLINE` | PIN 组存在但手机不在线 | 提示手机未连接云中继 |
| `PC_CONNECTED` | PC 在线，应走本地 | 刷新缓存，切回 localhost |
| `DUPLICATE_DIAL` | 5 秒内同号码重复 | 忽略 |
| `RATE_LIMITED` | 频率限制 | 1 分钟后重试 |
| `INVALID_NUMBER` | 号码不合法 | 提示用户 |
| `MISSING_FIELDS` | 缺少必填字段 | 补全后再试 |
| `MISSING_PIN` | 缺少 PIN 参数 | 补 PIN 后再试 |
| `DB_ERROR` | 数据库操作失败 | 联系管理员 |

---

## PC 端 HTTP API（端口 35432）

局域网直连，无需认证。

| 端点 | 说明 |
|------|------|
| `GET /dial?number=xxx` | 拨号 |
| `GET /hangup` | 挂断 |
| `GET /sms?number=xxx` | 发短信（仅 PC 直连支持） |
| `GET /open` | 打开 PC 端主窗口 |
| `GET /` | 获取 PC 端状态 |
| `POST /api/set-pin` | 设置 PIN（body: `{"pin":"13800138000"}`，4位或11位） |

---

## WebSocket 协议（端口 35430）

### 消息类型

| type | 方向 | 说明 |
|------|------|------|
| `phone_hello` | 手机→云 | PIN 握手（含 deviceName） |
| `pc_hello` | PC→云 | PC 注册（含 hostname） |
| `auth_ok` | 云→客户端 | 认证成功 |
| `auth_fail` | 云→客户端 | 认证失败 |
| `dial` | PC/云→手机 | 拨号指令（含 number） |
| `dial_result` | 手机→云→PC | 拨号结果 |
| `hangup` | PC/云→手机 | 挂断 |
| `sms` / `sms_result` | PC⇌手机 | 短信 |
| `ping` / `pong` | 双向 | 心跳（30s 间隔） |
| `ack` | 手机→PC | 确认 |
| `pc_online` / `pc_offline` | 云→手机 | PC 上线/离线通知 |
| `visit_record` | 云→手机 | **v4.1新增** 访问登记记录推送 |

### 握手示例

```
→ {"type": "phone_hello", "pin": "13800138000", "deviceName": "Redmi K40"}
← {"type": "auth_ok", "pin": "13800138000", "pcCount": 1, "pc_present": true}

→ {"type": "pc_hello", "pin": "13800138000", "hostname": "DESKTOP-ABC"}
← {"type": "pc_auth_ok", "pin": "13800138000", "phoneCount": 0}
```

## 扩展双模路由

```
拨号请求
├── 检测 PC 可用（GET 127.0.0.1:35432/，缓存复用）
│   ├── PC 在线 → GET /dial?number=xxx（局域网直连）
│   └── PC 离线/超时 → GET 云中继 /api/v1/dial?number=xxx（X-AutoDial-PIN Header）
│        ├── code=PC_CONNECTED → PC 实际在线，切回本地
│        ├── code=PHONE_OFFLINE → 提示手机未连
│        └── code=ACCEPTED → 完成
└── 无 PIN → 提示打开 CRM 页面自动检测
```

> 短信仅支持 PC 直连模式。云端无短信转发端点（`process_request` 不接收 POST body）。
