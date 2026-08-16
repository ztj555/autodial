# AutoDial 云端技术文档

> 最后修改：2026-08-01 | Python | SQLite 8表 | 管理面板 5.0 | 管理员鉴权 | 41个API端点 | 纯增量去重 | 并发/DB性能优化

---

## 一、云端代码结构

```
cloud-relay/
├── start.bat                    ← Windows 启动脚本
├── Dockerfile / docker-compose.yml  ← Docker 容器化部署
└── python/
    ├── cloud_relay_v2.py        ← ★ 主中继（v4.13，2787行，41个API端点）
    ├── dashboard.html           ← Web 管理面板 5.0（8 Tab页 + Chart.js + 管理员登录）
    ├── build.bat                ← PyInstaller 构建脚本（打包为 EXE）
    ├── install.bat              ← Python 依赖安装脚本
    ├── requirements.txt         ← Python 依赖（websockets, pystray, Pillow）
    ├── test_cloud_relay.py      ← WebSocket 协议测试
    └── test_server_start.py     ← 服务器启动测试
```

---

## 二、主中继：cloud_relay_v2.py（v4.13）

### 2.1 概述

- **版本**：v4.13
- **端口**：35430（WebSocket + HTTP REST API + Web 管理界面 共用）
- **依赖**：`websockets pystray Pillow`
- **认证**：PIN（4 位或 11 位纯数字）
- **部署**：`python cloud_relay_v2.py` 单命令启动
- **管理鉴权**：鉴权始终启用，管理账号存于 `admin_accounts` 表，首次启动自动创建默认账号

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
- `dial{number}` → `forward_to_phones(group, msg)` → 广播给组内所有手机
- `dial_result{status}` → `forward_to_pcs(group, msg)` → 广播给组内所有 PC
- 组内设备全部断开时自动清理 `del pin_groups[pin]`

### 2.3 WebSocket 协议

#### 手机端握手
```
→ {"type": "phone_hello", "pin": "13800138000", "deviceName": "Redmi K40"}
← {"type": "auth_ok", "pin": "13800138000", "pcCount": 1, "pc_present": true}

验证失败:
← {"type": "auth_fail", "reason": "配对码须为4位或11位数字"}
```

#### PC 端握手
```
→ {"type": "pc_hello", "pin": "13800138000", "hostname": "DESKTOP-ABC"}
← {"type": "pc_auth_ok", "pin": "13800138000", "phoneCount": 1}

验证失败:
← {"type": "pc_auth_fail", "reason": "配对码须为4位或11位数字"}
```

#### PC 在线/离线通知
```
云 → 手机:
← {"type": "pc_online", "pin": "13800138000"}
← {"type": "pc_offline", "pin": "13800138000"}
```

### 2.4 REST API

REST 端点**默认带 CORS**（`Access-Control-Allow-Origin: *`），MV3 Chrome 扩展通过 `host_permissions` 绕过。管理接口（写操作）需管理员鉴权。

#### GET /api/v1/dial
```
请求: GET /api/v1/dial?number=13900139000
Header: X-AutoDial-PIN: 13800138000

响应: {"ok": true, "code": "ACCEPTED"}
```

处理流程：
1. 从 Header 读取并校验 PIN（4 位或 11 位纯数字）
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
→ {"ok": true, "pin": "13800138000", "pcConnected": true, "phoneConnected": true, "phoneCount": 1, "extOnline": true}
```

#### GET /health
```
→ {"service": "AutoDial Cloud Relay", "version": "4.13", "port": 35430, "uptime_seconds": 3600, "total_connections": 0, "total_groups": 0}
```
此端点**有 CORS**（允许页面端测试连接）。注：代码中 `version` 字段当前硬编码为 `4.10`，与系统版本 v4.13 不同步，建议下次发版更新。

### 2.5 错误码

| code | 含义 |
|------|------|
| `ACCEPTED` | 指令已接受 |
| `INVALID_PIN` | PIN 格式错误（需4位或11位手机号） |
| `PHONE_OFFLINE` | 手机未连接 |
| `PC_CONNECTED` | PC 在线，扩展应走本地 |
| `DUPLICATE_DIAL` | 5 秒内同号码重复 |
| `RATE_LIMITED` | IP 频率限制（每分钟 5 次，仅 WS 握手返回 auth_fail） |
| `INVALID_NUMBER` | 号码格式不合法 |

### 2.6 管理 API（Dashboard 专用，写操作需管理员鉴权 🔐）

| 端点 | 说明 | 鉴权 |
|------|------|------|
| `GET /api/status` | 全局状态：连接数、分组数、消息统计、运行时间 | - |
| `GET /api/clients` | 所有在线客户端详情 | - |
| `GET /api/stats` | 消息转发统计 + by_type + by_pin + 按天流量 | - |
| `GET /api/logs?n=100&q=关键词` | 系统日志 | - |
| `GET /api/v1/devices` | 已注册设备清单 | - |
| `GET /api/v1/calls` | 通话记录查询（分页） | - |
| `GET /api/v1/kick?pin=&role=` | 踢出在线客户端 | 🔐 |
| `GET /api/v1/phone-stats` | 每日对账数据 | - |
| `GET /api/v1/events` | 手机行为事件日志 | - |
| `GET /api/history` | 连接数历史数据（最近4小时） | - |
| `GET /api/v1/login?user=&pass=` | 管理员登录，返回会话令牌 | - |
| `GET /api/v1/logout?token=` | 管理员登出 | - |
| `GET /api/v1/admin/accounts` | 管理账号列表 | 🔐 |
| `GET /api/v1/admin/add?user=&pass=` | 添加管理账号 | 🔐 |
| `GET /api/v1/admin/del?id=` | 删除管理账号 | 🔐 |
| `GET /api/v1/admin/chpwd?id=&newpass=` | 修改管理账号密码 | 🔐 |
| `GET /api/v1/auth/pending?pin=` | 查询挂起的设备授权请求 | - |
| `GET /api/v1/auth/respond?request_id=&allow=` | 响应设备授权请求 | - |
| `GET /api/v1/device-history?device_id=` | 设备历史 PIN 记录 | - |
| `GET /api/v1/device-set-default-pin?device_id=&default_pin=` | 设置设备默认 PIN | 🔐 |
| `GET /api/v1/device/update?device_id=&label=` | 更新设备别名 | 🔐 |

### 2.7 数据上报 API（手机端→云端）

| 端点 | 说明 |
|------|------|
| `GET /api/v1/calls/batch?device_id=&pin=&data=<json>` | 通话记录批量上传（幂等去重） |
| `GET /api/v1/events/log?device_id=&event_type=&pin=&detail=` | 行为事件记录 |
| `GET /api/v1/stats/report?device_id=&pin=&model=&version=&count=&duration=&connected=` | 每日统计快照（服务器重算并对比） |
| `GET /api/v1/visits/batch?data=<JSON数组>&token=` | CRM 上门记录批量导入 | 🔐 |

### 2.8 业务 API

| 端点 | 说明 |
|------|------|
| `GET /api/v1/dial?number=` (Header: X-AutoDial-PIN) | REST 拨号 |
| `GET /api/v1/hangup` (Header: X-AutoDial-PIN) | REST 挂断 |
| `GET /api/v1/status` (Header: X-AutoDial-PIN) | 按 PIN 查询连接状态 |
| `GET /api/v1/advisor/register?pin=&name=` | 顾问姓名注册 |
| `GET /api/v1/advisor/name?pin=` | 顾问姓名查询 |
| `GET /api/v1/advisor/update?pin=&name=` | 更新顾问姓名 | 🔐 |
| `GET /api/v1/pins` | PIN/顾问列表 |
| `GET /api/v1/pin/set_group?pin=&group_id=` | 设置 PIN 分组 | 🔐 |
| `GET /api/v1/groups` | 分组列表 |
| `GET /api/v1/group/add?name=` | 添加分组 | 🔐 |
| `GET /api/v1/group/del?id=` | 删除分组 | 🔐 |
| `GET /api/v1/visit?name=&mobile=&kefu_tel=&visit_type=&source=&visit_time=` | 创建访问登记（v4.11: visit_time 精确去重） |
| `GET /api/v1/visits?pin=&group=` | 查询访问记录 |
| `GET /api/v1/visit/delete?id=` | 删除访问记录 | 🔐 |
| `GET /api/v1/visit/update?id=&name=&mobile=&kefu_tel=&visit_type=` | 更新访问记录 | 🔐 |

**总计 41 个 API 端点**，全部为 GET 方法（通过 websockets `process_request` 处理，仅支持 path+headers）。

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
| `admin_accounts` | 管理员账号（username/password） |
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

## 三、v3 JWT 中继（已移除）

> **v3 JWT 双模中继（`cloud_relay_v3.py` + `auth.py` + `db.py`，端口 35440/35441，依赖 `aiosqlite bcrypt PyJWT`）已于 2026-07-04 全量移除**，仓库中不再存在这些文件。当前唯一主中继为 `cloud_relay_v2.py`（端口 35430），统一使用 PIN（4 位或 11 位）认证，无 JWT 通道。

---

## 四、Web 管理面板（端口 35430，与 WebSocket 同端口）

`dashboard.html` 提供基于浏览器的全功能管理界面（版本 5.0 (UX Redesign)）：

### 页面功能（8个Tab页）

| Tab | 功能 |
|-----|------|
| 📊 首页总览 | 统计卡片 + 最近客户端 + 手机设备一览 |
| 📱 手机管理 | 设备清单/别名/默认PIN/在线状态 + 历史PIN记录 |
| 📞 通话记录 | 设备/号码筛选 + CSV导出（数据来自 call_records_raw 表） |
| 🏠 上门登记 | 记录管理 + 14天趋势图 + CRM批量导入 |
| 👤 人员管理 | PIN + 姓名 + 分组管理 |
| 🔑 管理账号 | 账号增删 + 修改密码 |
| 📋 系统日志 | 关键词搜索 + 流量统计 |
| ⚙️ 设置 | 端口/日志级别配置 + 系统信息 |

### 技术特性
- 自动刷新：每15秒刷新当前页面
- 可视化：Chart.js 折线图/饼图/柱状图
- 实时数据：连接数历史每30秒记录，保留24小时
- 无外部依赖（除 Chart.js CDN）

---

## 五、部署说明

### 5.1 主中继（唯一部署方式）

```bash
pip install websockets pystray Pillow
python cloud_relay_v2.py
```

> 管理员鉴权始终启用（管理账号存于 `admin_accounts` 表，首次启动自动创建默认账号）；无环境变量开关、无 v3 JWT 可选模块（已移除）。

### 5.2 防火墙要求

| 端口 | 协议 | 用途 |
|------|------|------|
| 35430 | TCP | 主中继（WS + REST + Web 管理面板） |

---

## 六、与 PC 端/手机端的交互

```
PC/手机 → cloud_relay_v2.py:35430 (WS phone_hello/pc_hello)
         ← auth_ok 认证成功
         ← 消息双向转发（同 PIN 组内）

扩展   → cloud_relay_v2.py:35430 (REST /api/v1/dial)
         ← ACCEPTED → PinGroup 转发给手机

管理   → cloud_relay_v2.py:35430 (Web 管理面板 + 管理员鉴权)
```
