# AutoDial 技术文档

> 合并自原《AutoDial总技术文档》《AutoDial云端技术文档》《AutoDial-手机端技术文档》《AutoDial浏览器插件端技术文档》《AutoDial电脑端技术文档》。修订：2026-08-22 | v4.14（全链路修复 + 安全加固）

## 版本现状（各端独立演进）

| 组件 | 版本号 | 技术栈 | 认证方式 |
|------|--------|--------|----------|
| **Electron PC 端** | **v3.0.0** | Node.js + Electron | PIN（4位或11位纯数字） |
| **Go/Wails PC 端** | **v1.0.0** | Go + Wails v2.12 | PIN（4位或11位纯数字） |
| **云中继（主）** | **v4.14**（`/health` API 报 4.10） | Python + websockets + SQLite | PIN（4位或11位纯数字） |
| **Chrome 扩展** | **v5.0.0** | MV3 + Service Worker | X-AutoDial-PIN Header |
| **Android 端** | **v4.53** | Kotlin + OkHttp | PIN + WS 双通道 |
| **云端管理面板** | **v6.0**（Sky Design System） | dashboard.html + Chart.js | 管理员账号（SHA-256 加盐哈希） |

> 各端版本号不统一（云端 API 报 4.10 / 面板 v6.0 / 扩展 5.0.0 / Android 4.53，代码注释中 v4.57 系开发批次号 / Electron 3.0.0）。文中的 v4.x 叙事指系统整体迭代批次。
>
> **v4.14**：全链路修复（授权归属校验、`reconnect_request` 转发白名单、`INSERT OR REPLACE`→`ON CONFLICT DO UPDATE`、统一 busy_timeout、Go ACK 竞态）+ 安全加固（PC 端 35432 回环 Host + 可信来源校验、敏感读端点鉴权、管理员密码哈希 + 登录限频、XSS 修复）+ Docker 数据库持久卷。**v4.13**：云中继并发/DB 性能 P0 修复（WAL、DB 线程池、`_schedule_async`）、扩展 9 套主题。**v4.11**：同步登记列表全链路修复 + 纯增量去重 + 右键一键同步。

---

## 一、系统架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  CRM网页      │────→│ Chrome扩展    │────→│  PC端         │
│ (zhudai/     │     │ background.js│     │ Electron v3   │
│  rxhcrm等)   │     │ content.js   │     │ 或 Go v1      │
│ 一键登记 →   │     │ 📝 右键登记   │     │              │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                    │
                    优先: HTTP 35432       LAN: WS 35432
                    降级: REST 35430     Cloud: WS 35430
                    登记: GET /api/v1/visit
                            │                    │
                            └────────┬───────────┘
                                     │
                            ┌────────▼──────────┐
                            │   云中继 (35430)   │
                            │   cloud_relay_v2.py│
                            │   PinGroup 分组     │
                            │   SQLite 8 表       │
                            │   Web 面板 v6.0     │
                            └────────┬──────────┘
                                     │
                            ┌────────▼──────────┐
                            │   Android 手机端    │
                            │   DialService      │
                            │   录上门·统计·通话  │
                            └───────────────────┘
```

**双通道设计**：PC 端和手机端均支持 LAN 直连（WebSocket 35432）和 Cloud 中继（WebSocket 35430）双通道，由 PhoneConnectionManager（Electron）/ ConnectionManager（Android）自动管理优先级和降级切换。

**连接路径矩阵**：

| 场景 | 路径 | 说明 |
|------|------|------|
| 全本地（PC+手机同网络） | 扩展 → HTTP localhost:35432 → PC → WS 直连 → 手机 | 延迟 < 10ms，零外部依赖 |
| 异地（扩展+手机不同网络） | 扩展 → REST 35430 → 云中继 → WS 35430 → 手机 | 走云中继转发 |
| 混合（PC 连云，扩展走本地） | 扩展 → HTTP localhost:35432 → PC → WS 35430（云中继）→ 手机 | PC 作桥梁，最灵活的生产模式 |
| Go PC 替代 Electron | 扩展 → HTTP localhost:35432 → Go PC → WS → 手机 | 协议完全兼容，扩展端透明 |

**连接能力矩阵**：

| 连接路径 | Electron PC | Go PC | 扩展 | 手机 |
|----------|:---:|:---:|:---:|:---:|
| 局域网直连 (35432) | ✅ | ✅ | ✅ (HTTP) | ✅ |
| 云中继 v2 (35430) | ✅ | ✅ | ✅ (REST) | ✅ |

---

## 二、云中继（端口 35430）

### 2.1 架构

主中继 `cloud_relay_v2.py`（v4.14，2857 行，41 个 REST 端点），Python 标准库 sqlite3，依赖 `websockets pystray Pillow`（websockets 需锁上界 `>=12,<14`，见 README「部署」章节已知部署坑）。

```
cloud_relay_v2.py
├── WebSocket 中继（PIN 认证）
│   ├── phone_hello / pc_hello → PinGroup 管理
│   ├── dial/hangup/sms → 转发到手机
│   ├── visit_record → 推送登记记录
│   ├── phone_hello 补推 pending_visits
│   ├── auth_response / reconnect_request → 授权响应 + 离线唤醒（v4.14 纳入转发白名单）
│   └── ack → 双向转发
├── REST API（GET + X-AutoDial-PIN Header，41 端点）
│   ├── /api/v1/dial、/hangup、/status
│   ├── /api/v1/visit、/visits、/visit/update、/visit/delete
│   ├── /api/v1/advisor/*、/pins、/pin/set_group、/groups、/group/add、/group/del
│   ├── /api/v1/login、/logout、/admin/*
│   ├── /api/v1/devices、/calls、/phone-stats、/events、/device-*、/kick
│   ├── /api/v1/auth/pending、/auth/respond、/visits/batch
│   ├── /api/status、/clients、/stats、/logs、/history、/health
│   └── /（Web 管理面板 dashboard.html）
├── SQLite 数据库（8 张表）
│   ├── visits：登记记录（含 visit_time / crm_synced）
│   ├── advisor_names：PIN→姓名映射（含 group_id）
│   ├── admin_accounts：管理员账号（SHA-256 加盐哈希）
│   ├── pin_groups：分组定义
│   ├── phones：设备注册
│   ├── call_records_raw：原始通话记录
│   ├── phone_events：手机行为事件日志
│   └── phone_daily_stats：每日对账
└── 系统托盘（pystray，启停/日志/Web面板）
```

> 原「CRM 后台同步」模块（`_lookup_kid`/`_sync_to_crm`）经审计为死代码，已于 2026-08-22 第四批清理（Q4）删除；登记去重/同步由 REST 端点直接完成。

### 2.2 PinGroup 分组管理

```python
class PinGroup:
    def __init__(self):
        self.pcs = set()       # PC WebSocket 连接
        self.phones = set()    # 手机 WebSocket 连接
        self.last_dial = {}    # {number: timestamp} REST 并发保护
```

- 同一 PIN 的设备自动归入同一组；双向转发 `forward_to_phones()` / `forward_to_pcs()`
- 组内设备全部断开时自动清理 `del pin_groups[pin]`；手机重连后自动 flushPendingSyncs() 补推离线登记

### 2.3 REST 端点设计

- **为何用 GET + Header**：`websockets` 的 `process_request(path, request_headers)` 只接收 path 和 headers，不接收 body → PIN 走自定义 Header `X-AutoDial-PIN`（大小写不敏感），参数走 URL query。
- **为何用 `_schedule_async()`**：process_request 是同步回调，不能直接 await 异步转发；`_schedule_async()`（事件循环内 create_task / 跨线程 run_coroutine_threadsafe）将转发调度出去，同步返回 HTTP 200 + `{"ok": true, "code": "ACCEPTED"}`。

### 2.4 完整 REST API 端点表（41 个，全部 GET）

**核心拨号**

| 端点 | 说明 |
|------|------|
| `/api/v1/dial?number=xxx`（Header PIN） | 拨号 → `ACCEPTED`/`PHONE_OFFLINE`/`PC_CONNECTED` |
| `/api/v1/hangup`（Header PIN） | 挂断 → `ACCEPTED` |
| `/api/v1/status`（Header PIN） | 查询 PC/手机/扩展在线状态 |

**登记管理**

| 端点 | 说明 |
|------|------|
| `/api/v1/visit?name=&mobile=&kefu_tel=&visit_type=&visit_time=` | 一键登记（支持 visit_time 纯增量去重） |
| `/api/v1/visits?pin=&group=` | 查询登记列表（API 仅支持 pin/group 参数；unsynced、日期筛选是 dashboard 前端过滤；无 pin 时需管理员令牌） |
| `/api/v1/visit/update?id=N&...` | 更新登记记录（🔐） |
| `/api/v1/visit/delete?id=N` | 删除登记记录（🔐） |
| `/api/v1/visits/batch?data=<JSON>&token=` | CRM 批量导入（🔐） |

**顾问 / PIN 分组**

| 端点 | 说明 |
|------|------|
| `/api/v1/advisor/register?pin=&name=` | 注册顾问 |
| `/api/v1/advisor/name?pin=` | 查询顾问姓名 |
| `/api/v1/advisor/update?pin=&name=` | 更新顾问姓名（🔐） |
| `/api/v1/pins` | 所有 PIN 列表（🔐） |
| `/api/v1/pin/set_group?pin=&group_id=` | 设置 PIN 分组（🔐） |
| `/api/v1/groups` | 分组列表（🔐） |
| `/api/v1/group/add?name=` / `/api/v1/group/del?id=` | 添加/删除分组（🔐） |

**管理后台认证（v4.12+）**

| 端点 | 说明 |
|------|------|
| `/api/v1/login?user=&pass=` | 管理员登录（返回令牌；限频 60s/5 次失败按 username+IP 维度，超限返回 429 `RATE_LIMITED`） |
| `/api/v1/logout?token=` | 登出 |
| `/api/v1/admin/accounts` / `/add` / `/del` / `/chpwd` | 账号管理（🔐） |

> v4.14 起管理员密码 SHA-256 加盐哈希存储（登录兼容旧明文并自动迁移）；敏感读端点（`/api/status`、`/api/clients`、`/api/stats`、`/api/logs`、`/api/history`、`/api/v1/pins`、`/api/v1/groups`、`/api/v1/devices`、`/api/v1/device-history`、`/api/v1/calls`、`/api/v1/phone-stats`、`/api/v1/events`）同样需要管理员令牌；手机端上报端点（calls/batch、events/log、stats/report）无需令牌。

**设备与数据同步（v4.10+）**

| 端点 | 说明 |
|------|------|
| `/api/v1/devices` | 已注册设备清单（含在线状态） |
| `/api/v1/device-history?device_id=` | 设备 PIN 历史 |
| `/api/v1/device-set-default-pin?device_id=&default_pin=` | 设置设备默认 PIN |
| `/api/v1/device/update?device_id=&label=` | 设置设备别名 |
| `/api/v1/calls?device_id=&pin=&date_from=&date_to=&number=&limit=&offset=` | 通话记录查询+分页 |
| `/api/v1/calls/batch?device_id=&pin=&data=<json>` | 批量通话记录上传（幂等去重，无需令牌） |
| `/api/v1/phone-stats?device_id=` | 每日对账数据（OK/MISMATCH） |
| `/api/v1/events?device_id=&event_type=&limit=` | 手机行为事件日志 |
| `/api/v1/events/log?device_id=&event_type=&pin=&detail=` | 上报行为事件（无需令牌） |
| `/api/v1/stats/report?device_id=&pin=&count=&duration=&connected=` | 每日统计快照（服务器重算并对比，无需令牌） |
| `/api/v1/kick?pin=&role=` | 踢出在线客户端 |
| `/api/v1/auth/pending?pin=` | 查询挂起授权请求（同时登记扩展在线） |
| `/api/v1/auth/respond?request_id=&allow=1\|0&pin=` | 响应授权请求（pin 须与请求一致，防越权） |

**运维**

| 端点 | 说明 |
|------|------|
| `/health` | 健康检查（含 CORS；version 字段硬编码 4.10） |
| `/api/status` | 仪表盘状态（🔐） |
| `/api/clients` | 在线客户端列表（🔐） |
| `/api/stats` | 流量统计（含 by_type/by_pin，🔐） |
| `/api/logs?n=N&q=关键词` | 最近日志（可搜索；文件尾部倒读，🔐） |
| `/api/history` | 连接数历史（服务端保留 24h/2880 点快照，API 返回最近约 2.4 小时/288 点，🔐） |
| `/` | Web 管理面板（dashboard.html v6.0） |

### 2.5 响应格式与错误码

- 多数业务端点返回 `{"ok": bool, "code": "xxx", "message": "xxx"}`；`/api/v1/visits` 成功返回裸 JSON 数组；`/health`、`/api/status`、`/api/stats`、`/api/clients`、`/api/history` 返回各自状态对象。

| code | 含义 |
|------|------|
| `ACCEPTED` | 指令已接受 |
| `INVALID_PIN` | PIN 格式无效（非 4 位或 11 位数字） |
| `INVALID_NUMBER` | 号码为空或不合法（非 3~20 位数字，允许 `+*#`） |
| `PHONE_OFFLINE` | 手机未连接云中继 |
| `PC_CONNECTED` | PC 在线，应走本地直连 |
| `DUPLICATE_DIAL` | 5 秒内同号码重复拨号 |
| `MISSING_FIELDS` / `MISSING` / `MISSING_PARAM` | 缺少必填参数 |
| `INVALID_PARAM` | 参数格式不合法（v4.12） |
| `MISSING_ID` / `MISSING_DATA` | 缺少记录 ID / data 参数（v4.10） |
| `DB_ERROR` | 数据库操作失败 |
| `NOT_FOUND` | 记录未找到（v4.10） |
| `UNAUTHORIZED` | 需要管理权限（v4.12） |
| `LOGIN_FAILED` | 账号或密码错误（v4.12） |
| `DUPLICATE` | 账号已存在（v4.12） |
| `LAST_ACCOUNT` | 不能删除最后一个管理账号（v4.12） |
| `EXPIRED` | 授权请求已过期（v4.12） |
| `INVALID_JSON` | JSON 格式错误（v4.10） |
| `SERVER_ERROR` | 服务器内部错误（v4.10） |
| `NO_FIELDS` | 没有要更新的字段（v4.10） |
| `DELETED` / `UPDATED` | 删除/更新成功（v4.10） |
| `RATE_LIMITED` | 登录失败过于频繁（60s/5 次，HTTP 429，v4.14） |

### 2.6 WebSocket 协议

**手机端握手**：
```json
→ {"type": "phone_hello", "pin": "13800138000", "deviceName": "Redmi K40"}
← {"type": "auth_ok", "pin": "13800138000", "pcCount": 1, "pc_present": true}
← {"type": "auth_fail", "reason": "配对码须为4位或11位数字"}
```

**PC 端握手**：
```json
→ {"type": "pc_hello", "pin": "13800138000", "hostname": "DESKTOP-ABC"}
← {"type": "pc_auth_ok", "pin": "13800138000", "phoneCount": 1}
← {"type": "pc_auth_fail", "reason": "配对码须为4位或11位数字"}
```

**消息类型**：

| type | 方向 | 说明 |
|------|------|------|
| `phone_hello` / `pc_hello` | 客户端→云 | 上线握手（同 PIN 双手机连接时云中继无条件 close 旧手机 ws，4001 duplicate_reconnect） |
| `auth_ok` / `auth_fail` / `pc_auth_ok` / `pc_auth_fail` | 云→客户端 | 认证结果 |
| `auth_pending` / `auth_response` | 云⇌扩展 | 设备授权请求/响应（仅 PC 端可响应，防手机自批） |
| `reconnect_request` | 云→手机 | 离线唤醒（v4.14 纳入转发白名单，targetDevice 兼容设备名/当前 PIN） |
| `dial` / `dial_result` | PC/云→手机 / 手机→云→PC | 拨号指令 / 结果 |
| `hangup` | PC/云→手机 | 挂断 |
| `sms` / `sms_result` | PC⇌云⇌手机 | 短信指令/结果 |
| `ping` / `pong` | 双向 | 心跳（30s 间隔，90s 超时） |
| `ack` | 手机→PC | ACK 确认（messageId 回显） |
| `pc_online` / `pc_offline` | 云→手机 | PC 上下线通知 |
| `visit_record` | 云→手机 | 访问登记记录推送 |

### 2.7 数据库（SQLite 8 张表）

| 表 | 用途 |
|----|------|
| `visits` | 上门登记（pin, name, mobile, kefu_tel, visit_type, source, visit_time, crm_synced） |
| `advisor_names` | 顾问姓名映射（pin→name，含 group_id） |
| `admin_accounts` | 管理员账号（SHA-256 加盐哈希） |
| `pin_groups` | PIN 分组定义 |
| `phones` | 设备注册（device_id, model, version, first_seen, last_seen, default_pin, label） |
| `call_records_raw` | 原始通话记录（device_id+local_id 联合主键，幂等去重） |
| `phone_events` | 手机行为事件日志 |
| `phone_daily_stats` | 每日对账（server_dial/phone_dial/match_status: OK/MISMATCH） |

> 性能（v4.13）：SQLite WAL 模式 + `synchronous=NORMAL` + `busy_timeout=5000`；DB 操作经 8 线程 `_db_executor` 卸载出事件循环。v4.14 统一 `_connect_db()` 入口（timeout=5 + busy_timeout）。`events/log`、`stats/report` 对 phones 表用 `ON CONFLICT DO UPDATE`，不再抹掉管理员预设 default_pin/别名。

### 2.8 纯增量去重（v4.11）

```python
# 优先用 CRM 来访时间精确去重（真·纯增量）
if visit_time:
    SELECT id FROM visits WHERE mobile=? AND visit_time=?
else:
    SELECT id FROM visits WHERE mobile=? AND created_at LIKE ?  # 兼容旧调用
```

同一客户 + 同一天 CRM 来访记录永远只存一条。调用方：CRM 同步列表传 visit_time（source=crm_sync）；一键登记/手机端不传（回退旧逻辑，source=plugin/phone）。

### 2.9 内存管理与自动清理

每 10 分钟 `cleanup_memory()`：`message_count_by_pin` 保留 Top 200；`last_ext_activity` 1h 过期；`pending_visits` 每 PIN 上限 100；`PinGroup.last_dial` 10 分钟过期；`daily_stats` 保留 90 天；`connection_history` 环形数组上限 2880 点（24h）。

### 2.10 并发保护

| 机制 | 实现 |
|------|------|
| PC_CONNECTED 去重 | REST 端点检查 `group.pcs` 非空 → 返回 `PC_CONNECTED`，让扩展走本地 |
| DUPLICATE_DIAL 去重 | `PinGroup.last_dial[number]`，5 秒内同号码拒绝 |
| 频率限制 | WS 握手每 IP 每分钟 5 次；管理登录 60s/5 次（username+IP 维度） |
| 心跳超时 | WebSocket 内置 ping/pong（30s 间隔，90s 超时） |
| 优雅关闭 | `shutdown()` → 向每个连接 `ws.close(1001)` |
| 授权防越权 | WS `auth_response` 仅 PC 端可响应；REST `auth/respond` 必须携带与请求一致的 pin |

### 2.11 Web 管理面板（dashboard.html v6.0）

单文件架构（无构建工具，Chart.js CDN 除外），侧边栏 App Shell + 8 个页面：

| 页面 | 功能 |
|------|------|
| 首页总览 | Hero 状态横幅 + 统计卡 + 连接趋势折线图 + 消息类型饼图 + 最近客户端 |
| 手机管理 | 设备清单/别名/默认PIN/在线状态 + 历史 PIN 记录 |
| 通话记录 | 设备/号码筛选 + 分页 + CSV 导出（call_records_raw） |
| 上门登记 | 记录管理 + 14 天趋势图 + CRM 批量导入 |
| 人员管理 | PIN + 姓名 + 分组管理 |
| 管理账号 | 账号增删 + 修改密码 |
| 系统日志 | 关键词搜索 + 行数选择 + 流量统计 |
| 设置 | 端口/日志级别 + 系统信息 |

自动刷新 15s；连接历史每 30s 快照保留 24h；v6.0 起 10 套主题（9 套 + 天空蓝暗色）顶栏切换、localStorage 持久化；管理员登录限频；敏感查询统一携带会话令牌（withToken）；含用户数据的动态 onclick 全部 data-action 事件委托（防注入）。

### 2.12 部署要点

```bash
pip install "websockets>=12,<14" pystray Pillow   # websockets 需锁上界（legacy API 14.0 弃用但从未移除）
python cloud_relay_v2.py                           # 单命令启动，WS+REST+面板共用 35430
```

- Docker 部署：`AUTODIAL_DB_PATH=/app/data/visits.db`（v4.14 起容器 entrypoint 默认设置，数据库与日志落持久卷）
- 管理员默认账号 `18335162275 / 123456`（SHA-256 加盐哈希存储），首次登录后立即修改
- 详细部署见根目录 README「部署」章节

---

## 三、Chrome 扩展（v5.0.0，MV3）

### 3.1 项目结构

```
AutoDial-Extension/
├── manifest.json           ← MV3 清单（v5.0.0，host_permissions + content_scripts）
├── background.js           ← Service Worker：双模路由 + PIN 管理 + 拨号 + 右键同步
├── content-script.js       ← 内容脚本：CRM 浮动按钮 + 号码扫描 + 主题应用（数据取自 themes.js）
├── themes.js               ← 9 套主题唯一定义源 AD_THEMES（v5 起与 popup 共用，manifest 首个注入）
├── popup.html / popup.js   ← 弹窗：云服务器 + PIN 配置 + 状态大盘
├── auth.html / auth.js     ← 设备授权页（外部脚本规避 MV3 CSP，v4.14 修复）
├── icons/                  ← 扩展图标（icon16/48/128.png）
├── AutoDial-API.md / README.md
└── create-icons.ps1
```

**manifest 关键点**：`permissions: ["activeTab","storage","clipboardWrite","alarms","contextMenus"]`；`host_permissions` 含 `http://127.0.0.1:35432/*` 使扩展可绕过 CORS 访问本地 PC；content_scripts 仅注入三类 CRM 域名（guwen.zhudaicms.com / *.zhudaicms.com / *.rxhcrm.com / *.rongxinhui.com），`js: ["themes.js", "content-script.js"]`（顺序敏感），`run_at: document_idle`，`all_frames: true`。

### 3.2 background.js — Service Worker

**双模路由**：

```
拨号请求
  ├── 1. 检测 PC（localhost:35432，500ms 超时，PC_PING_TIMEOUT）
  │     ├── PC 在线 → HTTP 35432/dial → 完成
  │     └── PC 不在线 → 步骤 2
  └── 2. 云中继（配置的云端地址，REST API）
        └── GET /api/v1/dial?number=xxx + X-AutoDial-PIN Header
```

- **PC 检测缓存（35s TTL）**：检测结果缓存 35 秒（比后台 15s 探测间隔长），超时自动重新探测。
- **PC_CONNECTED 反向兜底**：云端发现 PC 在线 → 返回 `PC_CONNECTED` → 扩展刷新缓存切回本地。
- **getPin() 优先级**：popup 手动设置的 PIN → content-script 自动检测的坐席手机号（selfPhoneDetected）→ 空字符串。PIN 为空时返回 error「请先在扩展中设置 PIN」，不发送无效请求。
- 拨号 fetch 走 `X-AutoDial-PIN` Header；PC 直连 fetch 无来源限制（chrome-extension 来源放行）。

**右键菜单（v4.11）**：🔁 一键同步上门数据（任意 CRM 页面，自动跳转+同步）/ 同步登记列表当前页（仅列表页右键）/ 🔁 扩展图标右键同款；`chrome.contextMenus.removeAll()` 防 MV3 service worker 重启时菜单重复。

### 3.3 content-script.js — 内容脚本

| 功能 | 说明 |
|------|------|
| 号码检测 | TreeWalker 扫描页面文本节点，正则 `1[3-9]\d{9}` 匹配手机号 |
| 坐席号检测 | 优先 CSS 选择器 `.user-phone`（div.user-phone），失效后回退 TreeWalker 取第一个匹配 |
| 浮动拨号按钮 | 可拖拽（36-100px 缩放手柄），检测 CRM 号码自动高亮 |
| 挂断按钮 | 拨号后显示，可拖拽带缩放手柄 |
| 手动拨号条 | 独立悬浮条：输入框（不限长度/支持*#）+ 清空 + 拨号 |
| 设置弹窗 | PIN 设置 + 云端服务器（测试连接/一键获取），与 popup.html 双向同步 |
| 右键菜单 | 主题切换、手动拨号、设置、拨号、短信、PC 状态、PIN 显示 |
| 9 套主题 | 默认「天空蓝」+ 8 套（dark-gold 暗金 / cyber-frost 冰蓝冷峻 / deep-space 深空紫 / cyberpunk 赛博朋克 / minimalist 极简白 / forest-green 森林绿 / energetic-orange 活力橙 / ocean-blue 海洋蓝） |

**号码格式**：支持任意号码（手机号、固话、10086、400/800、*100# 等），最小 3 位、最长 20 位，允许 `+ * #` 和格式化字符（空格、`-`、括号）；端到端校验点在云中继和 PC 端 HTTP handler，插件端不做拦截。

**同步登记列表（v4.11 全链路修复）**：

- 数据提取 `extractVisits`：`form[name="fdsf"] ~ table tr`（兄弟元素，非子元素）；列位：cells[0]=crm_id、[1]=name、[2]=mobile、[4]=visit_type、[5]=advisor_phone、[6]=advisor_name、[10]=visit_time（CRM 真实来访时间）
- 自动翻页：扫描分页链接 → `fetch(url, {credentials:'include'})` + DOMParser 逐页解析 → 去重排序合并；单页失败跳过不中断
- 提交：`GET /api/v1/visit?...&visit_time=&source=crm_sync` + X-AutoDial-PIN；云中继 mobile+visit_time 精确去重
- 增量反馈 toast：`✅ 同步完成：共 120 条，新增 80 条，跳过 35 条（已存在），失败 5 条`
- 触发入口：CRM 页面右键 / 扩展图标右键 / Popup 按钮（content-script 已去掉主管校验，任何坐席均可同步）

### 3.4 popup.html / popup.js

- PIN 设置（4 位或 11 位手机号校验 `/^\d{4}$|^\d{11}$/`）；云服务器地址配置（`ws://xxx:35430`）；连通性测试 `GET /health`；状态查询 `GET /api/v1/status`；一键获取服务器列表（GitHub Gist / Gitee）
- 配置存储 `chrome.storage.local`：`pin`、`selfPhone`、`cloudServer`、`cloudServers`、`manager_name`、`__ad_theme`
- v4.13 起天空蓝亮色默认主题（与手机端/云端面板一致）

### 3.5 错误处理与注意事项

| 错误码 | 用户提示 |
|--------|---------|
| `INVALID_PIN` | 请检查配对码格式 |
| `PHONE_OFFLINE` | 手机未连接，请检查手机端 |
| `PC_CONNECTED` | 自动切回 localhost 直连（对用户透明） |
| `DUPLICATE_DIAL` | 静默忽略 |
| `INVALID_NUMBER` | 无效的电话号码 |
| 网络超时 | 自动降级：PC 不可达 → 走云端 |

1. MV3 Service Worker 闲置 30s 后被终止，状态经 `chrome.storage` 持久化，另用 `chrome.alarms` 每 15s 保活 + `runtime.onMessage` 唤醒
2. fetch 超时：PC 直连探测 AbortController 500ms（PC_PING_TIMEOUT）；云端/列表拉取 8s
3. 云中继所有 JSON 响应统一 `Access-Control-Allow-Origin: *`；扩展经 host_permissions 不受 CORS 限制
4. 扩展自动更新后需刷新 CRM 页面才能注入新版 content-script

---

## 四、PC 端（Electron v3.0.0 + Go/Wails v1.0.0）

两个功能等价的 PC 端实现，共享相同通信协议，Android 手机端和 Chrome 扩展在通信层面无法区分连接的是哪个版本。

| 特征 | Electron 版 | Go/Wails 版 |
|------|------------|-------------|
| 技术栈 | Node.js + Electron | Go + Wails v2.12 |
| 运行时体积 | ~150MB（含 Electron） | ~10MB（单文件 exe） |
| 窗口数 | 4 个独立窗口 | 1 个（内嵌设置/短信） |
| 最大手机连接 | 10 台 | 10 台 |
| 系统托盘 | Electron Tray API | 原生 Win32 API |
| 前端渲染 | Chromium | WebView2 |
| PIN 校验 | 与 `PIN_CODE` 比对（无格式强校验） | `isValidPhonePIN()` 4 位或 11 位纯数字 |
| 号码校验 | 3-20 位，支持 *#+ | `isValidDialNumber()` 3-20 位，支持 *#+ |
| 防火墙 | netsh 自动添加规则 | 仅检测端口可达性 |
| 日志 | rename 轮转 | zip 压缩旧日志 |
| 通信协议 | **完全相同** | **完全相同** |

### 4.1 本地服务（两版一致，端口 35432/35433）

**HTTP 服务器（35432，仅监听 127.0.0.1）**：

| 端点 | 用途 |
|------|------|
| `/dial?number=xxx` | 拨号（插件调用），自动唤醒 + 排队 |
| `/hangup` | 挂断 |
| `/sms?number=xxx&content=xxx` | 触发短信窗口 |
| `/open` | 打开主窗口 |
| `/toggle-floatbar?show=true` | 切换悬浮条显隐 |
| `/cloud-servers` | 同步 PC 云服务器配置给手机端 |
| `/` | 返回状态信息 |
| `/api/set-pin`（Go） | 设置 PIN（4 位或 11 位数字；修改 PIN 时主动断开旧 PIN 全部设备连接并清空 devices） |

> **来源校验（v4.14 安全加固）**：要求回环 Host（`127.0.0.1`/`localhost`/`::1`，防 DNS rebinding）+ 可信来源（`chrome-extension://` 等；空/`null` Origin 拒绝，URL 解析后精确比对 host，杜绝 `localhost.evil.com` 前缀绕过），HTTP 与 WS 均覆盖，外部网页无法静默拨号。

**WebSocket 服务器（同端口）**：`phone_hello{pin, deviceName}` LAN 握手、`plugin_hello` 扩展连接、`dial`/`hangup`/`sms` 指令、`dial_result` 回传、`ping/pong` 心跳、`ack{messageId}` 确认、`file_upload_start/chunk/complete/error` 文件上传协议。

**UDP 发现（35433）**：每 10s 广播 `{type:"announce", pin, ip, port}` 到 `255.255.255.255`；收到 `{type:"discover", pin}` 回复 `{type:"found",...}`；拨号触发时发 `{type:"wake_connect",...}` 唤醒离线设备。

**双通道发送（PhoneConnectionManager）**：LAN (ws) 优先 → Cloud (cloudWs) 降级；ACK 3s 超时自动切备通道重试；手机离线时拨号请求入队（30s 超时），重连后 `flushDialQueue()` 补发；心跳 120s 超时 + 30s TTL 清理僵尸设备；`MAX_PHONE_CONNECTIONS = 10`。

### 4.2 Electron 版详细架构

模块化架构，`main.js`（949 行）编排，10 个功能模块按职责拆分，依赖注入、零循环引用：

```
pc-app-Electron/
├── main.js (949行)             ← IPC 处理器 + 生命周期 + 跨模块胶水
├── phone-connection-manager.js ← 设备连接管理（独立模块，双通道 LAN+Cloud）
├── preload.js                  ← contextBridge IPC 桥接
├── modules/
│   ├── logger.js               ← 文件日志（10MB 轮转、5级备份、7天清理、环形缓冲降级）
│   ├── settings.js             ← settings.json 读写、云服务器列表同步
│   ├── network.js              ← PORT=35432、DISCOVERY_PORT=35433、PIN_CODE 状态
│   ├── phone-notes.js          ← 手机备注 CRUD
│   ├── tray.js                 ← 16×16 PNG 手写编码金色电话图标 + 右键菜单
│   ├── windows.js              ← 主窗口/悬浮条/设置窗口/短信窗口工厂
│   ├── firewall.js             ← netsh 入站规则（TCP 35432 + UDP 35433）
│   ├── discovery.js            ← UDP announce (10s) + discover 响应
│   ├── cloud.js                ← 云中转状态机（generation 防竞态 + 阶梯退避 + pong 20s 超时）
│   └── server.js               ← HTTP + WebSocket（回环 Host + 可信来源校验）
├── renderer/                   ← index.html / floatbar.html / settings.html / sms.html（+ js/theme.js）
└── themes/theme-data.js        ← 16 套主题数据
```

**云中转状态机（cloud.js）**：`_cloudTraversalGeneration` 递增防旧连接事件覆盖新状态；阶梯退避重连 0→1s→3s→5s→10s→30s→60s→5min，上限 30 次后停止等待手动触发；pong 超时 20s 判死；服务器列表按序尝试，失败自动重排重连链（v4.14 修复 failover generation 单次递增；v4.13 修复 error 分支与"从未认证成功"路径的重连恢复）。

**窗口管理**：

| 窗口 | 尺寸 | 特性 |
|------|------|------|
| 主窗口 | 420×780，最小 210×350 | 无边框，可拖拽，自定义标题栏 |
| 悬浮条 | 440×48，缩放 0.7-1.5x | alwaysOnTop，可拖拽，skipTaskbar |
| 设置窗口 | 380×420，最小 320×350 | 无边框，云端配置 + 主题 + 自启动 |
| 短信窗口 | 420×680，最小 320×400 | 无边框，短信模板 + 发送 |

**主题系统**：16 套主题（dark-gold 暗金 / cyber-frost 冰蓝冷峻 / minimalist 极简白 / glassmorphism 毛玻璃 / energetic-orange 活力橙 / rounded-candy 圆润糖果 / deep-space 深空紫 / forest-green 森林绿 / cyberpunk 赛博朋克 / warm-cream 暖光米色 / ocean-blue 海洋蓝 / teal-gradient 蓝绿渐变 / mint-fresh 薄荷清新 / coral-sunset 珊瑚日落 / lavender 薰衣草 / sky-blue 天空蓝），存于 `themes/theme-data.js`，切换广播 `theme-changed` 到所有窗口。

**设置持久化**：`{userData}/settings.json`——`closeAction`、`trayExit`、`autoStart`、`silentStart`、`theme`、`mode`、`pinCode`、`phoneNotes`、`cloudServer`、`cloudEnabled`、`cloudServers`；`cloudServer` 自动同步到 `cloudServers` 数组（向后兼容）。

**IPC 通道清单（38 个）**：
- Handle（invoke 模式，5 个）：`get-settings`、`get-theme-setting`、`get-info`、`read-clipboard`、`test-cloud-servers`
- On（send 模式，33 个）：`change-theme`、`update-bg-color`、`save-setting`、`set-pin`、`set-auto-start`、`open-settings`、`close-settings`、`toggle-floatbar`、`set-floatbar-scale`、`update-floatbar-scale`、`floatbar-resize`、`floatbar-move`、`floatbar-show-main`、`floatbar-context-menu`、`window-control`、`set-topmost`、`dial`、`hangup`、`open-sms`、`close-sms`、`send-sms`、`save-phone-note`、`rename-device`、`rename-phone`、`delete-device`、`set-active-phone`、`select-phone`、`update-cloud-config`、`connect-cloud-specific`、`force-reconnect`、`restart-app`、`restart-cloud`、`dial-failed-trigger-recovery`
- `fetch-cloud-servers` 通道已于 2026-08-22 第四批清理（Q7）删除

### 4.3 Go/Wails 版详细架构

```
pc-app-go/
├── main.go (60行)              ← Wails 启动：无边框窗口 420×780（最小 360×600）
├── app.go (712行)              ← 40+ 个 Go→前端绑定方法（App 结构体）
├── server.go (645行)           ← HTTP + WebSocket 服务器（监听 127.0.0.1）
├── security.go (64行)          ← Origin/来源校验（回环 Host + 可信来源，v4.14 新增）
├── cloud.go (344行)            ← 云中转连接管理（generation 防竞态；云端 phone_hello 增加 PIN 校验）
├── devices.go (556行)          ← 设备管理 + 常量/工具函数（ACK 定时器竞态修复）
├── tray.go (483行)             ← 原生 Win32 API 系统托盘
├── udp.go (158行)              ← UDP 局域网发现
├── settings.go (124行)         ← JSON 设置持久化（读写锁 + tmp/rename 原子写）
├── logger.go (140行)           ← 文件日志（旧日志 zip 压缩 + sync.Mutex）
├── wails.json                  ← Wails 构建配置（frontend:build 为空，需手动放 frontend/dist）
└── frontend/                   ← index.html + js/theme.js + themes/theme-data.js + wailsjs/ + wails-adapter.js
```

**Wails 绑定层（app.go）**：`SendDial/SendHangup/SendSMS/GetInfo/GetSettings/SaveSettings/SetPin/GetPhoneList/GetCloudStatus/ConnectCloud/DisconnectCloud/FetchCloudServers/TestCloudServers` 等 40+ 个方法；Go→前端经 `wailsRuntime.EventsEmit`。

**wails-adapter.js（兼容层）**：前端 HTML 原为 Electron IPC 编写，适配层将 `window.api.send/invoke/on` 映射到 Wails 绑定——send 映射 16 通道、invoke 映射 3 通道、on 事件 14 个（1s 轮询 + EventsOn 混合）。

**系统托盘（tray.go）**：直接调用 Win32 API（user32/shell32/gdi32），托盘操作经 `wailsRuntime.EventsEmit(ctx, "tray-action", action)` 回主线程处理。

**与 Electron 版差异补充**：设备注释 key 为 `pin`（仅用 PIN）；悬浮条为窗口缩放 400×52；TCP KeepAlive 10s 间隔；默认主题 sky-blue/light（`settings.go` 与 `theme-data.js` 一致）。

### 4.4 构建

```bash
# Electron
cd pc-app-Electron && npm install && npm start   # 开发；npm run build 打包 exe
# Go/Wails（需 Go 1.23+ 与 Wails CLI）
cd pc-app-go && go mod tidy && wails dev         # 开发热重载
wails build                                      # 输出 build/bin/AutoDial.exe
```

**防火墙要求**：35432 TCP 入站（PC 主服务）、35433 UDP 入站（LAN 发现）、35430 TCP 出站（云中继）。

---

## 五、Android 端（v4.53，Kotlin，包名 com.autodial.app）

### 5.1 项目结构

```
android-app/app/src/main/java/com/autodial/app/
├── MainActivity.kt             # 主界面（ViewPager2 + 4 Tab + 底部导航）
├── ViewPagerAdapter.kt         # ViewPager2 适配器
├── ConnectFragment.kt          # 设置页（连接/策略/主题/通知）
├── CallLogFragment.kt          # 通话页
├── StatsFragment.kt            # 财库统计页
├── RegisterFragment.kt         # 录上门页
├── ConnectionManager.kt        # WS 连接状态机 + LAN/Cloud 双通道
├── DialService.kt              # 拨号前台服务（主入口）+ 数据同步
├── DialEngine.kt               # 拨号执行引擎 + SIM 选择（7 种模式）
├── CloudCtrl.kt                # 云服务器 CRUD + Gist 同步 + 连通测试
├── CloudServerSheet.kt         # 云服务器管理弹窗（增删/测试/恢复默认）
├── ThemeManager.kt             # 16 套主题 + 7 级亮度
├── ThemeDialog.kt              # 主题选择弹窗
├── DialMode.kt / DialModeSheet.kt        # 拨号模式枚举 / 选择弹窗
├── ConnectionStrategySheet.kt            # 连接策略弹窗
├── DialAnimationOverlay.kt / AnimationSheet.kt  # 拨号动画悬浮窗 / 选择
├── CallDetailSheet.kt          # 通话详情弹窗
├── DialPadSheet.kt             # 手动拨号盘
├── DialAccessibilityService.kt # 无障碍服务（Xiaomi SIM 自动点击）
├── SimSelectOverlay.kt         # SIM 选卡悬浮窗
├── SmsConfirmActivity.kt       # 短信确认 Activity
├── CallLogDb.kt                # 通话记录 SQLite
├── BootReceiver.kt             # 开机自启
├── FileLogger.kt               # 文件日志
├── NotifyHelper.kt             # 通知辅助
└── PrefCtrl.kt                 # SharedPrefs 封装
```

**4 Tab 导航**（顺序可在主题设置切换）：通话 → 录上门 → 财库 → 设置；或设置优先。

### 5.2 连接方式（PIN 认证）

云中继地址转换：`ws://server:35430 → http://server:35430`（`wss:// → https://`）。

```kotlin
enum class ConnectionStrategy { AUTO, LAN_ONLY, CLOUD_ONLY }
```

- **LAN 发现**：UDP 广播 `255.255.255.255:35433`，3 次 discover 间隔 200ms，等待 8s；发现序列首次 60s 后每 120s（最多 4 次）
- **LAN 连接**：OkHttp WebSocket，连接超时 5s、读超时 45s、ping 30s、TCP KeepAlive 15s idle/5s interval/3 probes；握手 `phone_hello{pin, deviceName}`
- **云端连接**：独立 client，连接超时 6s，从 `cloud_servers` 列表遍历尝试；握手 `phone_hello{pin, deviceName, messageId}`；`auth_ok` 中 `pc_present=false` 时发起 PC 探活（8s 超时等 ACK）
- **PC 真探活**：`phone_hello` 携带 `messageId="probe_<ts>"` → PC 回 `ack{messageId}` → `pcConfirmedOnline=true`；8s 无 ACK 保持 false
- **公开属性**：`isConnected`、`isPcReachable`（LAN已连 或 Cloud已连且 pcConfirmedOnline）、`isLanConnected`、`isCloudConnected`、`transportMode`（"lan"/"cloud"/"lan+cloud"）
- **重连退避**：1→3→5→10→30→60→300s（LAN 最大 30 次，Cloud 最大 8 次；网络变化重置，2s 防抖）
- **网络监控**：`ConnectivityManager.NetworkCallback`，onAvailable 触发重连、onLost 停止 LAN 发现、WiFi 开关联动发现序列

### 5.3 DialService — 前台服务

**生命周期**：BootReceiver/MainActivity.startService() → onCreate（FileLogger.init → callLogDb 初始化 → startForeground → wakeLock(12h) → syncFromSystemCallLog → registerCallStateListener → ConnectionManager → registerNetworkMonitor → registerScreenOnReceiver → loadSavedConfig 自动连接）→ onStartCommand 处理 Intent。

**Intent Actions**：`ACTION_EXECUTE_PENDING_DIAL`（通知点击执行待拨号码）、`CONNECT`（携带 ip、pin）、`DISCONNECT`、`DIAL_WITH_SIM`（携带 number、sim_slot）、`DIAL_CANCELLED`。

**通知管理**：
- 前台通知（1001）：标题 `Auto融鑫汇`，内容 `已连接` + 今日数据（`今日财运：+12 接通6 · 67%`），静默无振动；通知栏不显示 PIN 明文（v4.14 AN-P1-2）
- 后台拨号通知（1002）：全屏 Intent 拉起 Activity，3 秒自动取消
- 后台短信通知（2001）：PendingIntent → SmsConfirmActivity
- 通知渠道：`IMPORTANCE_DEFAULT`，名为「跨屏拨号 服务」（CHANNEL_ID=autodial_service）

**广播通信**（DialService → UI）：`CONNECTION_CHANGE`（connected, mode, reason）、`NEW_DIAL`（number）、`CALL_ENDED`、`LAST_CALL_HINT`（number, hint）、`SHOW_SIM_SELECT`（number, last_sim_slot, last_dial_time）、`SHOW_SMS_CONFIRM`（number, content）、`CLOUD_STATUS`（connected, mode）。

### 5.4 ConnectionManager — 连接状态机

```
DISCONNECTED ──→ DISCOVERING ──→ CONNECTING ──→ CONNECTED
     ↑                                              │
     └──────────── 断线/超时 ──────────────────────┘
```

- LAN 连接：OkHttp WS、超时 5s、读超时 45s、ping 30s、KeepAlive 15s/5s/3；云端连接超时 6s、列表遍历
- 同 PIN 挤下线：`onClosed(code=4001)` 通知 `Disconnected("kicked")`，`lastDisconnectReason` 防止覆盖
- 日志 PIN/手机号脱敏（v4.14）；Android 14+ 广播 `RECEIVER_NOT_EXPORTED`（v4.14 修复崩溃）

### 5.5 DialEngine — 拨号执行引擎

**7 种拨号模式**（`resolveSimSlot()`）：

| 模式 | key | 逻辑 |
|------|-----|------|
| POPUP | `popup` | 始终 -1（弹窗） |
| ROUND_SELECT | `round_select` | 10 天内打过→-1；否则轮流 |
| OPPOSITE | `opposite` | 2 天内打过→反向卡；否则轮流 |
| SIM1 / SIM2 | `sim1`/`sim2` | 始终 0 / 1 |
| ALTERNATE | `alternate` | 全局交替（与上次相反） |
| SYSTEM | `system` | -2（系统拨号器） |

**SIM 解析**：`getPhoneAccountHandle(simSlot)` 经 SubscriptionManager.activeSubscriptionInfoList → telecomManager.callCapablePhoneAccounts → 匹配 subscriptionId/iccId/simSlotIndex → 回退已知组件名（AOSP/Xiaomi/MTK/华为）。

**拨号流程**：

```
dialNumber(number)
  ├── 检查 CALL_PHONE 权限
  ├── resolveSimSlot(number)
  │     ├── -2 (SYSTEM) → ACTION_CALL intent
  │     ├── >=0 (指定卡) → performDial(number, simSlot)
  │     └── -1 (弹窗) → 发送 SHOW_SIM_SELECT 广播 / 显示悬浮窗
  └── performDial(number, simSlot)
        ├── getPhoneAccountHandle(simSlot)
        ├── [Xiaomi] DialAccessibilityService.expectSimPicker(simSlot)
        ├── telecomManager.placeCall(uri, extras)  ← 主路径
        └── 失败 → fallback: ACTION_CALL intent
onDialSuccess: onDialResult("ok") 回 PC → callLogDb.insertDial → notifyNewDial → 剪贴板复制 → 拨号动画
```

**挂断**：`Build.VERSION.SDK_INT >= P` 时 `telecomManager.endCall()`。

**已知注意点**：`dialNumber()` 不检查当前通话状态（通话中再次拨号可能失败）；`resolveSimSlot()` 不检查 SIM 可用性（SIM 无信号可能拨号失败）——均属低风险设计取舍。

### 5.6 CallLogDb — 通话记录数据库

SQLite `autodial.db`，DCL 单例，版本 2：
- `dial_log` 表：`_id` PK、`number`、`dial_time`、`sim_slot`、`status`（"ok"/"error"）
- `sim_cache` 表：`number` PK、`sim_slot`、`call_time`（从系统通话记录同步）

查询层级：dial_log（APP 自身）→ sim_cache（系统同步缓存）→ 系统 CallLog（实时，需 Context）。初始化时异步 `syncFromSystemCallLog()` 写 sim_cache 上限 500 条。写入 try-catch 保护（磁盘满不崩溃）。

### 5.7 辅助功能

- **DialAccessibilityService**：Xiaomi/HyperOS 自动点击系统 SIM 选择器（检测包名 com.android.phone，找"卡1"/"卡2"或运营商名，8s 超时清除）；需用户手动在系统设置开启（AndroidManifest 中声明已注释，华为禁用/小米需用时取消注释）
- **SimSelectOverlay**：自定义选卡悬浮窗，需 SYSTEM_ALERT_WINDOW 权限，显示号码历史 SIM+时间
- **DialAnimationOverlay**：MODE_BOUNCE（弹跳）/ MODE_PULSE（脉冲）/ MODE_OFF；AnimationSheet 共 11 种效果（关闭/弹跳/烟花/组合/脉冲/星光/滑入/缩放/抖动/翻转/心跳）
- **SmsConfirmActivity**：后台收到短信请求 → 通知栏提示点击确认；前台直接广播触发

### 5.8 CloudCtrl — 云服务器配置

- 存储：SharedPreferences `cloud_servers`（JSON Array）；默认 `101.34.65.254:35430`（别名「融鑫汇腾讯云专线」）；兼容旧 `cloud_server` 单字符串
- 连通测试：WebSocket 全链路认证测试（连接超时 3s，发假 PIN → 收 auth_ok/auth_fail 即可达；try/finally 释放 OkHttpClient）
- Gist 同步：GitHub Gist → Gitee 备选，多源并发获取去重（`distinctBy { url }`）

### 5.9 FileLogger — 文件日志

三级路径回退：`/sdcard/Download/AutoDial/logs/` → `/sdcard/Android/data/com.autodial.app/files/autodial-logs/` → 内部存储 `filesDir/autodial-logs/`。文件名 `autodial-YYYY-MM-DD.log`，格式 `[HH:mm:ss.SSS] [I/W/E/D] [Module] content`；7 天自动清理；10MB 上限滚动 `.1.log`；HandlerThread 异步写入 3s 刷缓冲；连续失败 3 次降级内存环形缓冲（1000 条）；同时输出 Logcat。

### 5.10 权限需求

| 权限 | 用途 | 版本要求 |
|------|------|---------|
| CALL_PHONE | 执行拨号 | 所有 |
| READ_PHONE_STATE | 监听通话状态 | 所有 |
| READ_CALL_LOG | 同步系统通话记录 | 所有 |
| SEND_SMS | 发送短信 | 所有 |
| ANSWER_PHONE_CALLS | 接听电话 | API 28+ |
| POST_NOTIFICATIONS | 前台通知 | API 33+ |
| READ_PHONE_NUMBERS | 读取本机号码 | API 23+ |
| SYSTEM_ALERT_WINDOW | SIM 选卡悬浮窗 | API 23+ |
| RECEIVE_BOOT_COMPLETED | 开机自启 | - |
| FOREGROUND_SERVICE | 前台服务 | API 28+ |
| BIND_ACCESSIBILITY_SERVICE | SIM 自动点击 | - |

### 5.11 构建配置

- `android/app/build.gradle`：versionCode 453 / versionName "4.53"
- 签名：`autodial-release.p12`（RSA 2048/SHA256/25 年），**v4.14 起密码禁止硬编码**，仅从项目根 `keystore.properties` 或环境变量（KEYSTORE_PASSWORD/KEY_PASSWORD/KEY_ALIAS/KEYSTORE_FILE，env 优先）读取，缺失时报错；`keystore.properties.example` 为模板
- GitHub Actions：自动构建 Release + Debug APK；Secrets：KEYSTORE_BASE64、KEYSTORE_PASSWORD、KEY_ALIAS、KEY_PASSWORD

### 5.12 录上门登记流程（RegisterFragment）

1. 「接待顾问姓名」可编辑输入，也可按 PIN 从云中继自动查询（`/api/v1/advisor/name`）
2. 来访事由固定「贷款咨询」；客户称呼与手机号为必填
3. 提交 → `lookupKid()` 调 `/bserve/search` 姓名→ID → POST CRM API（`kid` 替代 `kefu_tel`；`API_URL = https://guwen.zhudaicms.com/bserve/saoma_indb.html`）
4. 成功后按钮「✅ 登记成功」+ 2 秒恢复；后台 `syncToCloudRelay()` 同步云端，失败 `savePendingVisit()` 入本地队列
5. 云端 WS 重连后 `flushPendingSyncs()` 补推离线记录
6. 上门统计：`registration_timestamps`（逗号分隔 epoch millis，保留 66 天）；visit_record WS 推送自动存入 + 系统通知；监听 `com.autodial.VISIT_RECORDED` 广播刷新

---

## 六、全链路 PIN 校验

| 环节 | 校验方式 | 位置 |
|------|---------|------|
| 扩展设置 | 4 位或 11 位数字正则（`/^\d{4}$|^\d{11}$/`） | popup.js |
| 扩展请求 | X-AutoDial-PIN Header（服务端大小写不敏感） | background.js |
| 扩展请求 PC 端 | 同 Header（Go/Electron 端校验） | background.js |
| Electron PC | 与 `PIN_CODE` 比对 | main.js |
| Go PC | `isValidPhonePIN()` 4 位或 11 位纯数字 | devices.go / app.go |
| 云中继 REST | `validate_pin()` 4 位或 11 位纯数字 | cloud_relay_v2.py |
| 云中继 WS | 同上 | cloud_relay_v2.py |
| Android | 4 位配对码或 11 位手机号 | ConnectFragment.kt |

---

## 七、安全设计

| 机制 | 说明 |
|------|------|
| PIN 强校验 | 全链路兼容 4 位/11 位 |
| 并发保护 | PC_CONNECTED 去重 + DUPLICATE_DIAL 5s 去重 |
| 频率限制 | WS 握手每 IP 每分钟 5 次；管理登录 60s/5 次（username+IP 维度，HTTP 429） |
| 心跳超时 | WebSocket ping/pong（云端 30s/90s；PC 端 15s/20s） |
| 空 PIN 守卫 | PC 端未设置 PIN 时拒绝一切连接 |
| 本地端口来源校验 | PC 端 35432 仅接受回环 Host + 可信来源（chrome-extension://、本机程序），防外部网页静默拨号/DNS rebinding（v4.14） |
| 管理员鉴权 | 敏感读端点需会话令牌（24h 过期）；密码 SHA-256 加盐哈希存储 + 登录兼容旧明文自动迁移（v4.14） |
| 授权归属校验 | WS auth_response 仅 PC 端可响应；REST auth/respond 必须携带与请求一致的 pin，防手机自批/越权（v4.14） |
| generation 防竞态 | PC 端云中转递增 generation 防旧连接事件覆盖新状态 |
| ACK 确认 | 拨号/挂断指令 3s ACK 超时自动切通道重试 |
| XSS 防护 | dashboard 动态 onclick 委托化 + escA 转义；Electron addLog/短信模板 innerHTML 转义 |

**已知风险与注意事项**：

| # | 风险 | 严重度 |
|---|------|--------|
| 1 | 手机同时连 LAN + Cloud 双路拨号 | 低（ACK 去重） |
| 2 | `resolveSimSlot()` 不检查 SIM 可用性 | 低 |
| 3 | `dialNumber()` 不检查当前通话状态 | 低 |
| 4 | Android 省电模式后台 WS 可能被冻结 | 中（需加入电池白名单） |
| 5 | 自动检测坐席手机号依赖页面扫描顺序 | 低（可手动修正） |

---

## 八、端口体系

| 端口 | 协议 | 用途 | 组件 |
|------|------|------|------|
| **35430** | WS + HTTP | 云中继主端口（中继 + REST API + Web 面板 + 访问登记 API） | cloud_relay_v2.py |
| **35432** | HTTP + WS | PC 端主服务（LAN 直连 + 扩展连接，仅监听 127.0.0.1） | Electron/Go PC |
| **35433** | UDP | LAN 设备发现（广播 announce + 响应 discover） | 全部组件 |
