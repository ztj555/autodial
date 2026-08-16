# AutoDial v4 API 文档

> 最后修改：2026-08-01 | 云中继端口 35430 | 4/11 位 PIN 兼容 | 管理员鉴权 | 含顾问管理/分组/PIN管理/鉴权 API

## REST API（云中继 35430）

所有端点均为 GET（`process_request` 只处理 query 参数，不接收 POST body）。PIN 通过 `X-AutoDial-PIN` Header 传递，其余参数走 URL query。

错误响应统一为 `{"ok": false, "code": "xxx", "message": "xxx"}`；成功响应多为 `{"ok": true, ...}`，少数返回裸数据（如 `/api/v1/visits` 返回 JSON 数组，`/health`、`/api/status` 返回状态对象）。

### 业务端点

#### GET /api/v1/dial?number=13900139000 — 拨号

```
Header: X-AutoDial-PIN: 13800138000
```

```json
// 成功
{"ok": true, "code": "ACCEPTED"}
// PIN 格式错误
{"ok": false, "code": "INVALID_PIN", "message": "PIN 格式错误，须为4位或11位数字"}
// PC 在线，应走本地
{"ok": false, "code": "PC_CONNECTED", "message": "PC 端在线，请走本地直连"}
// 手机离线
{"ok": false, "code": "PHONE_OFFLINE", "message": "手机未连接"}
// 5 秒内同号码
{"ok": false, "code": "DUPLICATE_DIAL", "message": "相同号码正在拨号中"}
// 号码不合法
{"ok": false, "code": "INVALID_NUMBER", "message": "号码不合法"}
```

处理流程：PIN 强校验 → 号码校验 → 检查 PC 在线 → 检查手机在线 → 5s 去重 → 异步转发 → 返回 ACCEPTED。

#### GET /api/v1/hangup — 挂断

```
Header: X-AutoDial-PIN: 13800138000
```

```json
{"ok": true, "code": "ACCEPTED"}
```

错误码同 dial：`INVALID_PIN` / `PC_CONNECTED` / `PHONE_OFFLINE`。

#### GET /api/v1/visit — 一键登记

```
Header: X-AutoDial-PIN: 13800138000
Query: ?name=张三&mobile=13900139000&kefu_tel=13800138000&visit_type=贷款咨询&source=plugin&visit_time=2026-07-23 10:00
```

```json
// 成功
{"ok": true, "code": "ACCEPTED", "id": 1}
// 当日重复（跳过）
{"ok": true, "skipped": true, "reason": "duplicate"}
// 缺少字段
{"ok": false, "code": "MISSING_FIELDS", "message": "缺少必填字段: name, mobile, kefu_tel"}
// PIN 格式错误
{"ok": false, "code": "INVALID_PIN", "message": "PIN 格式错误，须为4位或11位数字"}
```

处理流程：PIN 校验 → 必填字段校验 → 去重（visit_time 或当日同号）→ SQLite 存储 + 自动登记顾问姓名映射 → WS 推送 `visit_record` 给手机（离线则堆积到 pending_visits）。客户端已直接提交 CRM，云端仅做记录与推送，不再重复提交 CRM。

#### GET /api/v1/visits?pin=xxx[&group=N] — 查询登记列表

返回登记记录 JSON 数组（非 `{ok}` 包裹），按 `created_at` 降序。`pin` 查单个顾问，`group` 查整组；两者均缺省时返回最近 500 条。

#### GET /api/v1/visit/update?id=N&name=...&mobile=...&kefu_tel=...&visit_type=... — 更新记录（🔐 管理员）

返回 `{"ok": true, "code": "UPDATED", "id": N}`；未命中返回 `{"ok": false, "code": "NOT_FOUND", "id": N}`。

#### GET /api/v1/visit/delete?id=N — 删除记录（🔐 管理员）

返回 `{"ok": true, "code": "DELETED", "id": N}`；未命中返回 `{"ok": false, "code": "NOT_FOUND", "id": N}`。

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
  "phoneCount": 1,
  "extOnline": true
}
```

### 监控端点

| 端点 | 说明 |
|------|------|
| GET `/health` | 健康检查（服务名/版本/端口/运行时间/连接数/分组数） |
| GET `/api/status` | 仪表盘状态（服务/端口/消息数/流量/今日拨号/今日登记/最近活跃） |
| GET `/api/clients` | 客户端列表（设备名/角色/PIN/IP/连接时间） |
| GET `/api/stats` | 流量统计（总消息数/上下行流量/按天/按类型/按 PIN） |
| GET `/api/logs` | 系统日志（默认最近 100 条，支持 `?n=500&q=关键词`） |
| GET `/api/history` | 连接数历史（最近 4 小时） |
| GET `/` | Web 管理面板 HTML |

> 所有 JSON 端点均返回 `Access-Control-Allow-Origin: *`（`JSON_HDR` 统一携带 CORS），供 popup 测试连接。

### 顾问姓名 / PIN / 分组

| 端点 | 说明 | 鉴权 |
|------|------|:---:|
| GET `/api/v1/advisor/register?pin=&name=` | 注册/更新顾问姓名（扩展检测到姓名后调用） | — |
| GET `/api/v1/advisor/name?pin=` | 按 PIN 查询顾问姓名 | — |
| GET `/api/v1/advisor/update?pin=&name=` | 更新顾问姓名 | 🔐 |
| GET `/api/v1/pins` | 所有已注册 PIN（含姓名/分组） | — |
| GET `/api/v1/pin/set_group?pin=&group_id=` | 设置 PIN 分组 | 🔐 |
| GET `/api/v1/groups` | 分组列表 | — |
| GET `/api/v1/group/add?name=` | 添加分组 | 🔐 |
| GET `/api/v1/group/del?id=` | 删除分组 | 🔐 |

### 设备授权 / 设备管理

| 端点 | 说明 | 鉴权 |
|------|------|:---:|
| GET `/api/v1/auth/pending?pin=` | 查询挂起的授权请求（扩展每 5s 轮询） | — |
| GET `/api/v1/auth/respond?request_id=&allow=1|0` | 响应授权请求 | — |
| GET `/api/v1/devices` | 设备清单（含在线状态/IP/PIN/姓名） | — |
| GET `/api/v1/device-history?device_id=` | 设备 PIN 历史 | — |
| GET `/api/v1/device-set-default-pin?device_id=&default_pin=` | 设置设备默认 PIN | 🔐 |
| GET `/api/v1/device/update?device_id=&label=` | 设置设备别名 | 🔐 |
| GET `/api/v1/kick?pin=&role=` | 踢出在线客户端 | 🔐 |

### 手机上报 / 统计

| 端点 | 说明 |
|------|------|
| GET `/api/v1/calls/batch?device_id=&pin=&data=<json>` | 批量上传通话记录 |
| GET `/api/v1/events/log?device_id=&event_type=&pin=&detail=` | 上报行为事件 |
| GET `/api/v1/stats/report?device_id=&pin=&model=&version=&count=&duration=&connected=` | 上报每日统计快照 |
| GET `/api/v1/calls?device_id=&pin=&date_from=&date_to=&number=&limit=&offset=` | 通话记录查询 |
| GET `/api/v1/phone-stats?device_id=` | 每日对账 |
| GET `/api/v1/events?device_id=&event_type=&limit=` | 手机事件日志 |
| GET `/api/v1/visits/batch?data=<json数组>` | 批量导入登记记录 | 🔐 |

### 错误码枚举

| code | 含义 | 扩展处理 |
|------|------|---------|
| `ACCEPTED` | 指令已接受 | 正常 |
| `INVALID_PIN` | PIN 非 4 位或 11 位数字 | 提示检查 PIN 设置 |
| `PHONE_OFFLINE` | PIN 组存在但手机不在线 | 提示手机未连接云中继 |
| `PC_CONNECTED` | PC 在线，应走本地 | 刷新缓存，切回 localhost |
| `DUPLICATE_DIAL` | 5 秒内同号码重复 | 忽略 |
| `INVALID_NUMBER` | 号码不合法 | 提示用户 |
| `MISSING_FIELDS` | 缺少必填字段 | 补全后再试 |
| `MISSING_PIN` | 缺少 PIN 参数 | 补 PIN 后再试 |
| `DB_ERROR` | 数据库操作失败 | 联系管理员 |

> 其它端点还会返回：`UNAUTHORIZED`（管理员鉴权失败）、`LOGIN_FAILED`（登录失败）、`EXPIRED`（授权请求过期）、`NOT_FOUND`、`MISSING`、`MISSING_PARAM`、`INVALID_PARAM`、`DUPLICATE`、`LAST_ACCOUNT`、`MISSING_ID`、`NO_FIELDS`、`INVALID_JSON`、`SERVER_ERROR` 等，详见各端点。频率限制仅在 WebSocket 握手时以 `auth_fail` 返回，无独立 REST 错误码。

---

## PC 端 HTTP API（端口 35432）

局域网直连，无需认证。

| 端点 | 说明 |
|------|------|
| `GET /dial?number=xxx` | 拨号 |
| `GET /hangup` | 挂断 |
| `GET /sms?number=xxx&content=xxx` | 发短信（仅 PC 直连支持） |
| `GET /open` | 打开 PC 端主窗口 |
| `GET /toggle-floatbar` | 切换悬浮条 |
| `GET /cloud-servers` | 云端服务器列表 |
| `GET /` | 获取 PC 端状态（JSON） |
| `POST /api/set-pin` | 设置 PIN（body: `{"pin":"13800138000"}`，4位或11位） |

---

## WebSocket 协议（端口 35430）

### 消息类型

| type | 方向 | 说明 |
|------|------|------|
| `phone_hello` | 手机→云 | PIN 握手（含 deviceName） |
| `pc_hello` | PC→云 | PC 注册（含 hostname） |
| `auth_ok` | 云→手机 | 手机认证成功（含 pcCount / pc_present） |
| `pc_auth_ok` | 云→PC | PC 认证成功（含 phoneCount） |
| `auth_fail` | 云→客户端 | 认证失败 |
| `auth_request` / `auth_pending` | 云→PC / 云→手机 | 设备授权请求 / 等待扩展授权 |
| `auth_response` / `auth_response_ack` | 双向 | 授权响应 / 确认 |
| `dial` | PC/云→手机 | 拨号指令（含 number） |
| `dial_result` | 手机→云→PC | 拨号结果 |
| `hangup` | PC/云→手机 | 挂断 |
| `sms` / `sms_result` | PC⇌手机 | 短信 |
| `ping` / `pong` | 双向 | 心跳（30s 间隔） |
| `ack` | 手机→PC | 确认 |
| `pc_online` / `pc_offline` | 云→手机 | PC 上线/离线通知 |
| `phone_offline` | 云→PC | 手机离线通知 |
| `visit_record` | 云→手机 | 访问登记记录推送 |

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

---

## 管理员鉴权 API 🔐

管理接口（写操作）需管理员登录后方可调用。鉴权始终启用：通过 `Authorization: Bearer <token>` 或 `?token=<token>` 传递会话令牌（登录后 24h 有效，重启失效）。

> 无 `AUTODIAL_ADMIN_PASS` 环境变量机制。管理员账号存于 SQLite `admin_accounts` 表，首次启动自动创建默认账号（用户名 `18335162275`，密码 `123456`），请登录后尽快修改。

| 端点 | 说明 | 鉴权 |
|------|------|------|
| `GET /api/v1/login?user=&pass=` | 管理员登录，返回 `{"ok":true,"token":...,"username":...}` | - |
| `GET /api/v1/logout?token=` | 管理员登出 | - |
| `GET /api/v1/admin/accounts` | 列出管理账号 | 🔐 |
| `GET /api/v1/admin/add?user=&pass=` | 添加管理账号 | 🔐 |
| `GET /api/v1/admin/del?id=` | 删除管理账号（不可删最后一个） | 🔐 |
| `GET /api/v1/admin/chpwd?id=&newpass=` | 修改管理账号密码 | 🔐 |
| `GET /api/v1/advisor/update?pin=&name=` | 更新顾问姓名 | 🔐 |
| `GET /api/v1/pin/set_group?pin=&group_id=` | 设置 PIN 分组 | 🔐 |
| `GET /api/v1/group/add?name=` | 添加分组 | 🔐 |
| `GET /api/v1/group/del?id=` | 删除分组 | 🔐 |
| `GET /api/v1/visit/delete?id=` | 删除访问记录 | 🔐 |
| `GET /api/v1/visit/update?id=&name=&mobile=&kefu_tel=&visit_type=` | 更新访问记录 | 🔐 |
| `GET /api/v1/visits/batch?data=<json数组>` | 批量导入登记记录 | 🔐 |
| `GET /api/v1/device-set-default-pin?device_id=&default_pin=` | 设置设备默认 PIN | 🔐 |
| `GET /api/v1/device/update?device_id=&label=` | 设置设备别名 | 🔐 |
| `GET /api/v1/kick?pin=&role=` | 踢出在线客户端 | 🔐 |
