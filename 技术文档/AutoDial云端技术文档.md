# AutoDial 云端技术文档

> 最后修改：2026-07-21 23:30 | Python | SQLite 8表 | 管理面板 v4.11 | 32个API端点 | 纯增量去重

---

## 一、云端代码结构

```
cloud-relay/
├── start.bat                    ← Windows 启动脚本
├── package.json                 ← npm 元数据（部分已弃用）
├── server.js.deprecated         ← 旧 JS 实现（已弃用）
├── launcher.cpp / Launcher.cs   ← C++/C# 托盘启动器
├── Dockerfile / docker-compose.yml  ← Docker 容器化部署
└── python/
    ├── cloud_relay_v2.py        ← ★ 主中继（最新版，1989行，32个API端点）
    ├── cloud_relay.py           ← v1 旧版中继
    ├── dashboard.html           ← Web 管理面板 v4.10（10 Tab页 + Chart.js）
    ├── web_server.py            ← 旧版独立 Web 管理（端口35431，已废弃）
    ├── requirements.txt         ← Python 依赖（websockets, pystray, Pillow）
    ├── test_cloud_relay.py      ← 单元测试
    └── test_server_start.py     ← 服务器启动测试
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

### 2.6 管理 API（Dashboard 专用）

| 端点 | 说明 |
|------|------|
| `GET /api/status` | 全局状态：连接数、分组数、消息统计、运行时间 |
| `GET /api/clients` | 所有在线客户端详情（PIN、角色、IP、连接时间） |
| `GET /api/stats` | 消息转发统计 + by_type（消息类型分布）+ by_pin（按PIN统计）+ 按天流量 |
| `GET /api/logs?n=100&q=关键词` | 系统日志（支持行数和关键词搜索） |
| `GET /api/v1/devices` | 已注册设备清单（含在线状态 + IP 标注） |
| `GET /api/v1/calls?device_id=&pin=&date_from=&date_to=&number=&limit=50&offset=0` | 通话记录查询（分页） |
| `GET /api/v1/kick?pin=&role=` | 踢出指定在线客户端 |
| `GET /api/v1/phone-stats?device_id=` | 每日对账数据（server_dial/phone_dial/match_status） |
| `GET /api/v1/events?device_id=&event_type=&limit=100` | 手机行为事件日志 |
| `GET /api/history` | 连接数历史数据（最近4小时，每30秒一个数据点） |

### 2.7 数据上报 API（手机端→云端）

| 端点 | 说明 |
|------|------|
| `GET /api/v1/calls/batch?device_id=&pin=&data=<json>` | 通话记录批量上传（幂等去重） |
| `GET /api/v1/events/log?device_id=&event_type=&pin=&detail=` | 行为事件记录 |
| `GET /api/v1/stats/report?device_id=&pin=&model=&version=&count=&duration=&connected=` | 每日统计快照（服务器重算并对比） |

### 2.8 业务 API

| 端点 | 说明 |
|------|------|
| `GET /api/v1/dial?number=` (Header: X-AutoDial-PIN) | REST 拨号 |
| `GET /api/v1/hangup` (Header: X-AutoDial-PIN) | REST 挂断 |
| `GET /api/v1/status` (Header: X-AutoDial-PIN) | 按 PIN 查询连接状态 |
| `GET /api/v1/advisor/register?pin=&name=` | 顾问姓名注册 |
| `GET /api/v1/advisor/name?pin=` | 顾问姓名查询 |
| `GET /api/v1/advisor/is_admin?pin=` | 管理员检查 |
| `GET /api/v1/advisor/set_admin?pin=` | 设为管理员 |
| `GET /api/v1/advisor/del_admin?pin=` | 取消管理员 |
| `GET /api/v1/pins` | PIN/顾问列表 |
| `GET /api/v1/pin/set_group?pin=&group_id=` | 设置 PIN 分组 |
| `GET /api/v1/groups` | 分组列表 |
| `GET /api/v1/group/add?name=` | 添加分组 |
| `GET /api/v1/group/del?id=` | 删除分组 |
| `GET /api/v1/visit?name=&mobile=&kefu_tel=&visit_type=&source=&visit_time=` | 创建访问登记（v4.11: visit_time 精确去重） |
| `GET /api/v1/visits?pin=&group=` | 查询访问记录 |
| `GET /api/v1/visit/delete?id=` | 删除访问记录 |
| `GET /api/v1/visit/update?id=&name=&mobile=&kefu_tel=&visit_type=` | 更新访问记录 |

**总计 32 个 API 端点**，全部为 GET 方法（兼容 websockets process_request 仅支持 path+headers）。

### 2.9 系统托盘

使用 `pystray` + `Pillow` 实现 Windows 系统托盘：
- 绿色圆点 = 运行中，灰色圆点 = 已停止
- 右键菜单：启停服务器 / 打开 Web 管理界面 / 打开日志 / 退出
- 托盘 title 显示当前端口号

### 2.10 数据库

`visits.db` (SQLite)，8 张表：

| 表 | 用途 |
|----|------|
| `visits` | 上门登记（pin, name, mobile, kefu_tel, visit_type, source, visit_time, crm_synced） |
| `advisor_names` | 顾问姓名映射（pin→name） |
| `admins` | 管理员标记 |
| `pin_groups` | PIN 分组管理 |
| `phones` | 设备注册（device_id, model, version, first_seen, last_seen） |
| `call_records_raw` | 原始通话记录（device_id+local_id 联合主键，幂等去重） |
| `phone_events` | 手机行为事件日志（login 等） |
| `phone_daily_stats` | 每日对账（server_dial/phone_dial/match_status） |

### 2.11 纯增量去重（v4.11）

**问题**：旧去重逻辑 `WHERE mobile=? AND created_at LIKE '今天%'` 只按入库当天去重，跨天同步会重复入库。

**方案**：引入 `visit_time`（CRM 真实来访时间）。

```python
# v4.11: 优先用 CRM 来访时间精确去重
if visit_time:
    SELECT id FROM visits WHERE mobile=? AND visit_time=?  # 真·纯增量
else:
    SELECT id FROM visits WHERE mobile=? AND created_at LIKE ?  # 兼容旧调用
```

**效果**：同一客户 + 同一天 CRM 来访记录 → 永远只存一条，无论同步多少次。

**调用方适配**：
| 调用方 | 是否传 visit_time | 来源 source |
|--------|-------------------|-------------|
| CRM 同步列表 | ✅ 是 | `crm_sync` |
| 一键登记 | ❌ 否（回退旧逻辑） | `plugin` |
| 手机端登记 | ❌ 否（回退旧逻辑） | `phone` |

### 2.12 内存管理与自动清理

每 10 分钟执行 `cleanup_memory()`：
- `message_count_by_pin` → 保留 Top 200
- `last_ext_activity` → 超过 1 小时未活跃的清除
- `pending_visits` → 每 PIN 最多 100 条
- `PinGroup.last_dial` → 超过 10 分钟的清理
- `daily_stats` → 保留最近 90 天
- `_pin_attempts` → 过期条目随清理清除
- `connection_history` → 环形数组上限 2880 点（24小时）

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

## 四、Web 管理面板（端口 35430，与 WebSocket 同端口）

`dashboard.html` 提供基于浏览器的全功能管理界面（版本 v4.11）：

### 页面功能（10个Tab页）

| Tab | 功能 |
|-----|------|
| 📊 仪表盘 | 6个统计卡片 + 连接趋势折线图(总/PC/手机) + 消息类型饼图 + 最近客户端 |
| 👥 客户端管理 | 在线设备列表 + 角色筛选 + 设备名搜索 + **踢出功能** |
| 📞 通话记录 | 日期/设备/号码筛选 + 分页 + CSV导出（数据来自 call_records_raw 表） |
| 📱 设备管理 | 已注册设备清单 + 在线状态(绿/灰点) + 型号/版本 + 首次/最后在线 |
| 📈 流量统计 | 每日流量趋势 + 按PIN统计(Top10) + 每日明细表 |
| 📋 日志 | 关键词搜索 + 行数选择(100/200/500/1000) |
| 🏠 上门记录 | CRUD + 日期/来源筛选 + CSV导出 + 14天趋势图 |
| 📊 对账面板 | 服务端 vs 手机端数据对比（OK/MISMATCH高亮） |
| 👤 PIN管理 | 分组管理 + 管理员标记 + 顾问姓名映射 |
| ⚙️ 设置 | 端口/日志级别配置 + 系统信息 |

### 技术特性
- 自动刷新：每15秒刷新当前页面
- 可视化：Chart.js 折线图/饼图/柱状图
- 实时数据：连接数历史每30秒记录，保留24小时
- 无外部依赖（除 Chart.js CDN）

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
