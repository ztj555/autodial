# AutoDial 技术文档

> 合并自原《AutoDial总技术文档》《AutoDial云端技术文档》《AutoDial-手机端技术文档》《AutoDial浏览器插件端技术文档》《AutoDial电脑端技术文档》。修订：2026-09-11 | v4.21.2（第二梯队：授权不误踢 + 切服务器立即重连 + REST 重端点线程池 + 面板凭据出网址 + 13 项打磨）

## 版本现状（各端独立演进）

| 组件 | 版本号 | 技术栈 | 认证方式 |
|------|--------|--------|----------|
| **Electron PC 端** | **v3.0.0** | Node.js + Electron | PIN（4位或11位纯数字） |
| **Go/Wails PC 端** | **v1.0.0** | Go + Wails v2.12 | PIN（4位或11位纯数字） |
| **云中继（主）** | **v4.23**（`/health` 报 4.23，`APP_VERSION` 单一来源） | Python + websockets + SQLite | PIN（4位或11位纯数字） |
| **Chrome 扩展** | **v5.0.0** | MV3 + Service Worker | X-AutoDial-PIN Header |
| **Android 端** | **v4.53** | Kotlin + OkHttp | PIN + WS 双通道 |
| **云端管理面板** | **v6.0**（Sky Design System） | dashboard.html + Chart.js | 管理员账号（SHA-256 加盐哈希） |

> 各端版本号不统一（面板 v6.0 / 扩展 5.0.0 / Android 4.53，代码注释中 v4.57 系开发批次号 / Electron 3.0.0）。文中的 v4.x 叙事指系统整体迭代批次。云中继自 v4.23 起由 `APP_VERSION` 常量统一供 `/health`、`/api/status` 与面板"系统信息"展示。
>
> **v4.23 后续批次（2026-09-12 同日追加，P2 与收尾，CI 全绿）**：云端——托盘路径退出改 `os._exit(0)` 防僵尸进程（Y-10）、`configure_firewall()` 非 Windows 直接跳过（Y-14）、日志/stats 走 `AUTODIAL_DATA_DIR` 环境变量（Y-11，docker-compose 已指向挂载卷）、来访去重 SELECT→INSERT 用进程内 `threading.Lock` 原子化（Y-4，实测 10 并发同号请求恰好 1 入库 9 判重）、`/api/status` 两段 DB 查询合并经 `_run_db` 卸载线程池（Y-12）；PC Electron——单实例锁 `requestSingleInstanceLock`（P-3）、`get-info` 补 `connected`/`firewall` 字段（P-1）、启动横幅与 set-pin 日志 PIN 脱敏（P-10）、设置原子写+损坏备份（P-9）；Android——同号 4 秒防双拨窗口（A-10）、拨号提示查询移出主线程（A-13）、电池优化引导 7 天冷却不再每次启动弹（A-9）、同步失败 toast 带异常原因；扩展——离线队列 promise 链串行化防丢（E-9）、拨号结果/号码更新广播全部帧（E-5，iframe 浮窗不再收不到）、`escHtml` 补引号转义（E-11）；面板——Esc 关闭弹窗（M-6）、`phoneHistoryCache` 60 秒 TTL（M-3）、搜索防抖定时器切页清理（M-4）、登出 token 改走 Authorization 头不再拼 URL（M-2，与服务端 Y-7 配套）、`.td-muted` 12px（M-7）、"系统信息"服务版本改从 `/api/status` 动态显示（M-8）。**刻意不修**（理由详见《未闭环问题清单》闭环状态总表）：Y-5（空 IP 限流——反代场景会 429 风暴）、Y-6、Y-8（哈希升级有锁死管理员风险，建议换口令时顺带）、Y-9、M-5、M-8 其余整洁度项、A-1（isConnected 门控语义）、A-3（补推触发点属生命周期重构）、A-12（HTTPS 属部署决策）、E-2/E-6/E-7/E-8/E-10（结构性/外观）、Go 端 G-1~G-9（整端废弃）。
>
> **使用场景约束（2026-09-12 管理员确认，影响所有定级与设计决策）**：公司内部约 20 人小范围使用；**客服会用手机流量拨号**（人不在公司 WiFi）→ 云端必须是公网可达的服务（腾讯云，纯 HTTP、端口全网放行），不能用"安全组限 IP"方案，安全项必须改代码解决；PC 端发的是**文件夹版**（非单文件便携版）→ Electron `getPath('exe')` 自启逻辑正确（"便携版自启失效"为误报）；手机**机型不统一**（非全小米）→ 厂商相关兼容逻辑（如自动选卡预布防）必须覆盖全厂商；双实例（35430 主 / 35440 备）各自独立 DB → 跨进程数据竞态不存在，进程内锁即足够。
>
> **v4.23（2026-09-12，场景化复核修复，CI 编译通过）**：安全收口——`/api/v1/visits` 按分组或无筛选必须管理员令牌（原 `?pin=任意&group=N` 免鉴权可读整组客户数据，单 PIN 精确查询仍免鉴权供手机端同步）；calls/batch、events/log 要求设备已注册且 pin 与登记 PIN 一致（伪造 device_id 返回 403），并支持 POST body（GET 保留兼容，新版 App 优先 POST 使凭据不进 URL）；`/api/v1/login` 仅接受 POST body（GET 通道关闭，误用返回 401 并提示）；logout 令牌优先走 Authorization 头（query 保留兼容）；压测脚本 `test_stress_live.py` 改 `--host/--port/--dry-run/preflight`，默认拒绝公网目标。体验修复——PC Electron：短信失败/超时回执（窗口不再卡死）、settings 原子写+损坏备份、云重连 30 次后转 5 分钟低频重试、removeDevice 连接归属校验、LAN 重连不覆盖 isCloud、关闭即退出清悬浮条、剪贴板同值不覆写；Android：KeepAliveReceiver 保活自查（进程被杀 15 分钟内复活，`setExactAndAllowWhileIdle`，exact alarm 属 Android 12+ FGS 后台启动豁免场景）、simHandleCache 绑定 subscriptionId（换卡不再拨错卡）、自动选卡预布防扩展到全厂商（非小米走"仅新窗口弹出"严格模式防误点通话界面）、manual_disconnect 不再被 Activity 重建复位、拨号盘/详情页拨号统一走 DialEngine（新增 DIAL action）、onCreate 异常路径补 startDataSync（幂等）、统计页 READ_CALL_LOG 去授权横幅、云端空响应不清空本地记录、上报改 POST；扩展：点击拨打实时读取号码（SPA 复用节点不再拨错人）、浮窗 2 秒防连点、测试连接与 uploadAdvisorName 加 8 秒超时；面板：recent-clients pin/ip 转义、通话记录设备筛选每次进页刷新且保留已选值。**v4.21（2026-09-11，综合复核 P0 批 + 管理员拍板追加，随 v4.23 于 2026-09-12 一并部署生效）**：REST 限流按端点分级（认证类 60 / 轮询类 240 / 业务类 600 每分钟/IP，解决"20 人共用出口 IP 被扩展轮询打爆、上门登记被 429"）；`/api/v1/visits/batch` 支持 POST body（websockets 对 HTTP 请求行 8192 字节硬上限，原 GET 200 条 JSON 约 20 行即整批静默失败），`_PeerProtocol.read_http_request()` 放行 POST；init_db 全新库初始化必炸修复（v4.17 潜伏雷：索引建在建表前，新库落 `:memory:` 数据重启即丢）；面板未登录/过期停止自动刷新；批量导入改 POST + 20 条/批；扩展授权轮询 5s→30s + 429 退避；扩展 dial/hangup/sms 读取响应体（PC 手机未连时 `200 {success:false}` 不再误报"已拨出/已挂断"，dial 落云端兜底）；Android `logEvent()` 接线（原零调用致 phone_events 恒空，拨号/短信结果上报）+ 通话同步权限缺失/上报失败可观测 + 首传水位线 DESC（先报最近记录）。**拍板追加（v4.21.1）**：局域网直连修通（Electron 监听 0.0.0.0 + WS verifyClient 改"带 Origin 必须可信/无 Origin 放行 + PIN 握手兜底"，HTTP 层回环校验保留，"检查防火墙"文案改准确指引）；PC `uncaughtException` 不再退出应用（记日志+弹一次提示继续运行）；PC 直连 `/dial` 补 5 秒同号去重（原仅云端有，双击会真拨两次）；本地库 50 台压测设备已清。**第二梯队（v4.21.2）**：C-4 授权握手改"配对成功再踢旧机"（待授权设备不再顶掉同 PIN 真机）；A-2 切换云服务器立即重连（"当前服务器"排到队首 + switchCloudServer）；C-1 REST 六个重端点（登记/列表/两个导出/设备/通话）DB 段移入线程池（导出期间不再卡全员 WS）；D-8 登录/加账号/改密码改 POST body、导出改 Authorization 头 + blob（凭据不再进网址）；面板 13 项打磨（hash 路由、自定义确认弹窗、改密下拉选账号、删假"详情"列、列宽 92→72、表头 12px、次要色对比度达 AA、定时软刷新不重置分页/筛选/展开、列表请求序号防覆盖、横幅错误计数、未登录中性文案）。复核实况：Android 14 前台服务（specialUse）已修无需动；配对码 deviceId（v4.16）已实施。**v4.19/v4.20**：面板状态可信度整改（统一请求层 + 401/429/断网全局横幅、假保存移除、通话导出服务端全量、自动刷新暂停/跳过编辑、表格横向滚动、搜索防抖、密码框遮罩）；云端 `/api/v1/calls/export` + 新设备广播 TypeError 修复。**v4.18**：面板分页/服务端导出 + REST 全局限频 + 顾问姓名 DO NOTHING。**v4.17**：登记 crm_id 唯一去重 + 2 小时窗口 + 离线补推重写 + 统计翻倍三重修复。**v4.16.1**：设备自动注册（未注册设备首连自动绑定当前 PIN 放行，env `AUTODIAL_AUTO_REGISTER=0` 关闭）；跨 PIN 授权文案改可操作提示。**v4.16**：设备唯一键改用 `deviceId`（Android 端复用 device_uuid，旧 APK 回退 deviceName）；Android 端 `auth_pending` 等待授权 UI（此前被静默丢弃只能干等 120s）；后台登录门禁（未登录仅显示登录页）；35440 Docker 数据库落持久卷（此前落在容器内，重建即丢）。设计原则：20 人内部使用、便捷优先于安全、单管理员、双实例容灾（35430 主 / 35440 备）。**v4.14**：全链路修复（授权归属校验、`reconnect_request` 转发白名单、`INSERT OR REPLACE`→`ON CONFLICT DO UPDATE`、统一 busy_timeout、Go ACK 竞态）+ 安全加固（PC 端 35432 回环 Host + 可信来源校验、敏感读端点鉴权、管理员密码哈希 + 登录限频、XSS 修复）+ Docker 数据库持久卷。**v4.13**：云中继并发/DB 性能 P0 修复（WAL、DB 线程池、`_schedule_async`）、扩展 9 套主题。**v4.11**：同步登记列表全链路修复 + 纯增量去重 + 右键一键同步。

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

主中继 `cloud_relay_v2.py`（v4.16.1，2964 行，41 个 REST 端点），Python 标准库 sqlite3，依赖 `websockets pystray Pillow`（websockets 需锁上界 `>=12,<14`，见 README「部署」章节已知部署坑）。

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

### 2.4 完整 REST API 端点表（41 个；写入类端点 v4.21/v4.23 起支持或要求 POST，凭据不再进 URL）

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
| `/api/v1/visits?pin=&group=` | 查询登记列表（API 仅支持 pin/group 参数；unsynced、日期筛选是 dashboard 前端过滤）。**鉴权（v4.23）**：单 `pin` 精确查询免鉴权（手机端同步路径）；按 `group` 或无筛选必须管理员令牌 |
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
| `/api/v1/login` | 管理员登录，**POST body** `{"user":"","pass":""}`（返回令牌；限频 60s/5 次失败按 username+IP 维度，超限返回 429 `RATE_LIMITED`）。**v4.23 起仅接受 POST body**，GET query 通道关闭（误用返回 401 并提示改 POST） |
| `/api/v1/logout` | 登出。v4.23 起令牌优先走 `Authorization: Bearer` 头（`?token=` query 保留兼容旧客户端） |
| `/api/v1/admin/accounts` / `/add` / `/del` / `/chpwd` | 账号管理（🔐） |

> v4.14 起管理员密码 SHA-256 加盐哈希存储（登录兼容旧明文并自动迁移）；敏感读端点（`/api/status`、`/api/clients`、`/api/stats`、`/api/logs`、`/api/history`、`/api/v1/pins`、`/api/v1/groups`、`/api/v1/devices`、`/api/v1/device-history`、`/api/v1/calls`、`/api/v1/phone-stats`、`/api/v1/events`）同样需要管理员令牌；`/api/v1/visits` 按分组或无筛选也要求管理员令牌（v4.23）；手机端上报端点无需管理员令牌，但 **calls/batch、events/log 自 v4.23 起要求设备已注册且 pin 与登记 PIN 一致**（伪造 device_id 返回 403；stats/report 暂不校验）。

**设备与数据同步（v4.10+）**

| 端点 | 说明 |
|------|------|
| `/api/v1/devices` | 已注册设备清单（含在线状态） |
| `/api/v1/device-history?device_id=` | 设备 PIN 历史 |
| `/api/v1/device-set-default-pin?device_id=&default_pin=` | 设置设备默认 PIN |
| `/api/v1/device/update?device_id=&label=` | 设置设备别名 |
| `/api/v1/calls?device_id=&pin=&date_from=&date_to=&number=&limit=&offset=` | 通话记录查询+分页 |
| `/api/v1/calls/batch` | 批量通话记录上传（幂等去重）。**POST body** `{"device_id","pin","data":[...]}`（v4.23 起，推荐）或 GET `?device_id=&pin=&data=<json>`（兼容）。要求设备已注册且 pin 归属一致，否则 403（v4.23） |
| `/api/v1/phone-stats?device_id=` | 每日对账数据（OK/MISMATCH） |
| `/api/v1/events?device_id=&event_type=&limit=` | 手机行为事件日志 |
| `/api/v1/events/log` | 上报行为事件。**POST body**（v4.23 起）或 GET `?device_id=&event_type=&pin=&detail=`（兼容）。鉴权同 calls/batch（v4.23） |
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
→ {"type": "phone_hello", "pin": "13800138000", "deviceName": "Redmi K40", "deviceId": "<device_uuid>"}
← {"type": "auth_ok", "pin": "13800138000", "pcCount": 1, "pc_present": true}
← {"type": "auth_pending", "reason": "...", "messageId": "..."}
← {"type": "auth_fail", "reason": "配对码须为4位或11位数字"}
```

> **设备身份与绑定（v4.16/v4.16.1）**：云端以 `deviceId` 为设备唯一键查/写 `phones` 表并做设备-PIN 绑定（`deviceName` 仅作展示，旧 APK 缺字段时回退 deviceName，Android 端复用 `PrefCtrl.getDeviceId()` 的 device_uuid）。绑定规则：`default_pin` 未设置的设备（未注册）首次连接**自动注册**——绑定到当前所用 PIN 并放行（`AUTO_REGISTER_DEVICE`，env `AUTODIAL_AUTO_REGISTER=0` 可关）；已绑定设备用默认 PIN 连接直接放行，换用其他 PIN 则进入 `auth_pending` 等待对应 PIN 的浏览器插件（CRM 页面需打开）授权，120s 无响应 `auth_fail`。授权通过仅本次会话有效，不修改 `default_pin`。老 APK（型号名身份）过渡期间同型号多台共享一条绑定，新 APK 发放后按设备唯一。

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
| `auth_pending` / `auth_response` | 云⇌扩展 / 云→手机 | 设备授权请求/响应（仅 PC 端可响应，防手机自批）；v4.16 起云→手机同样透传 `auth_pending`，Android 端显示等待授权 UI |
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
| 来访去重原子化（v4.23 Y-4） | `_visit_insert_lock`（`threading.Lock`）包住 SELECT 判重→INSERT 整段，消除 DB 线程池 8 线程的 check-then-insert 竞态（实测 10 并发同号恰好 1 入库 9 判重） |
| DB 查询卸载（v4.23 Y-12） | `/api/status` 两段 DB 查询合并经 `_run_db` 进线程池，DB 卡顿不再阻塞事件循环；此前 C-1 已卸载 6 个重端点 |
| 频率限制 | WS 握手每 IP 每分钟 5 次；REST 按端点分级（v4.21）：认证类 60 / 轮询类 240 / 业务类 600 每分钟/IP；管理登录 60s/5 次（username+IP 维度） |
| 心跳超时 | WebSocket 内置 ping/pong（30s 间隔，90s 超时） |
| 优雅关闭 | `shutdown()` 向每个连接 `ws.close(1001)`；v4.23 起托盘子线程路径改 `os._exit(0)` 结束进程（Y-10，防 `sys.exit` 只杀线程留下僵尸托盘进程） |
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

自动刷新 15s；连接历史每 30s 快照保留 24h；v6.0 起 10 套主题（9 套 + 天空蓝暗色）顶栏切换、localStorage 持久化；管理员登录限频；敏感查询统一携带会话令牌（withToken）；含用户数据的动态 onclick 全部 data-action 事件委托（防注入）。**2026-09-10 起登录门禁**：浏览器无会话 token 打开 `/` 时 `body.locked` 隐藏登录框以外全部界面并强制弹出登录框（不可点空白关闭），登录成功/登出/401 自动回登录页——数据 API 侧 `_check_admin` 鉴权之外补齐"界面本身不外泄"。**v4.23 体验与安全项**：Esc 按优先级关闭弹窗（确认框 > 导入 > 编辑，M-6）；手机历史缓存 60s TTL（M-3）；切页清理搜索防抖定时器（M-4）；登出走 `Authorization: Bearer` 头不再拼 URL（M-2）；toast/客户端列表输出统一 `esc()` 转义（含引号）；"系统信息"服务版本改从 `/api/status` 动态显示真实 `APP_VERSION`（M-8）；次要文字 12px（M-7）。

### 2.12 部署要点

```bash
pip install "websockets>=12,<14" pystray Pillow   # websockets 需锁上界（legacy API 14.0 弃用但从未移除）
python cloud_relay_v2.py                           # 单命令启动，WS+REST+面板共用 35430
```

- **生产环境（101.34.65.254 腾讯云，双实例容灾）**：35430 主实例（supervisor 进程 `autodial`，`/usr/bin/python3` 直跑 `/opt/autodial/cloud_relay_v2.py`，DB `/opt/autodial/visits.db`）+ 35440 备用实例（Docker 容器 `autodial-relay`，DB 落挂载卷 `/opt/autodial/data/visits.db`）。两套数据各自独立是**有意的容灾设计**——主实例故障时切备用实例继续打电话（核心功能）；运维脚本在 `/opt/autodial/scripts/`（status/restart-35430/restart-35440/rebuild-docker）。每次变更前备份旧版（`*.bak.*` 后缀留存于 /opt/autodial/）
- **部署实况（2026-09-12）**：v4.23 已上线（公网 `/health` 实测 version=4.23、未授权 `/api/status` 401）。服务器上的 1Panel/OpenResty 仅占 80/443 默认站，**与 AutoDial 无关**（配置中无 35430 反代）——面板入口历来是 `:35430` 直连。部署流程：备份 → 上传 → MD5 核对 → `py_compile` 预检 → `supervisorctl restart autodial` → `/health` 验证
- Docker 部署：`AUTODIAL_DB_PATH=/app/data/visits.db`（2026-09-10 修复：Dockerfile 补 `ENV AUTODIAL_DB_PATH` 并以 `-e` 传入容器，数据库落持久卷；此前 DB 落在容器内 `/app/visits.db`，重建即丢）
- 数据目录（v4.23 Y-11）：日志与 stats.json 路径可由 `AUTODIAL_DATA_DIR` 环境变量指定，docker-compose 已设为挂载卷 `/app/data`——容器重建不再丢日志/统计；未设置时保持原回退链
- 设备自动注册开关：`AUTODIAL_AUTO_REGISTER=0` 关闭（默认开启，未注册设备首连自动绑定当前 PIN）
- 管理员默认账号 `18335162275 / 123456`（SHA-256 加盐哈希存储），首次登录后立即修改
- 版本展示（v4.23 M-8）：`/health`、`/api/status` 与面板"系统信息"统一读代码内 `APP_VERSION` 常量（单一来源），不再有 4.10/6.0 各说各话的历史问题
- 详细部署见根目录 README「部署」章节与《部署核对单-v4.23.md》

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
- **离线队列串行化（v4.23 E-9）**：`queueCloudVisit`/`flushCloudVisits` 走 `_visitQueueChain` promise 链逐个执行——flush 期间新入队的记录不再被 `storage.set` 覆盖丢失。
- **消息广播全帧（v4.23 E-5）**：拨号结果/号码更新 `chrome.tabs.sendMessage` 不再限定 `frameId: 0`，iframe 内注入的浮窗同样收得到（CRM 站点大量使用 iframe）；无监听的帧静默忽略。

**右键菜单（v5.4 起已清空）**：原 v4.11 的 3 个菜单项（🔁 一键同步上门数据（CRM 页面）/ 同步登记列表当前页（仅列表页）/ 🔁 扩展图标右键同款）已随「同步登记列表」功能一并移除。启动时仅保留一次 `chrome.contextMenus.removeAll()`，用于清理旧版本遗留在浏览器中的菜单项；本扩展不再注册任何右键菜单。

### 3.3 content-script.js — 内容脚本

| 功能 | 说明 |
|------|------|
| 号码检测 | TreeWalker 扫描页面文本节点，正则 `1[3-9]\d{9}` 匹配手机号。**v4.23（E-1）点击拨打时实时读取**链接 href/节点文本重新匹配——SPA 复用 DOM 节点时不再拨出闭包固化的旧号码 |
| 坐席号检测 | 优先 CSS 选择器 `.user-phone`（div.user-phone），失效后回退 TreeWalker 取第一个匹配 |
| 浮动拨号按钮 | 可拖拽（36-100px 缩放手柄），检测 CRM 号码自动高亮 |
| 挂断按钮 | 拨号后显示，可拖拽带缩放手柄 |
| 手动拨号条 | 独立悬浮条：输入框（不限长度/支持*#）+ 清空 + 拨号 |
| 设置弹窗 | PIN 设置 + 云端服务器（测试连接/一键获取），与 popup.html 双向同步 |
| 右键菜单 | 主题切换、手动拨号、设置、拨号、短信、PC 状态、PIN 显示 |
| 9 套主题 | 默认「天空蓝」+ 8 套（dark-gold 暗金 / cyber-frost 冰蓝冷峻 / deep-space 深空紫 / cyberpunk 赛博朋克 / minimalist 极简白 / forest-green 森林绿 / energetic-orange 活力橙 / ocean-blue 海洋蓝） |

**号码格式**：支持任意号码（手机号、固话、10086、400/800、*100# 等），最小 3 位、最长 20 位，允许 `+ * #` 和格式化字符（空格、`-`、括号）；端到端校验点在云中继和 PC 端 HTTP handler，插件端不做拦截。

**「同步登记列表」（v5.4 起已移除）**：

- 原「同步登记列表 / 一键同步上门数据」功能整体移除：插件端不再抓取 CRM 来访列表页（`list_user_visit.html`）的分页数据，也不再批量上报云端
- 移除点：popup `#syncBtn`、3 个右键菜单项、content-script `handleSyncVisitList()` / `iframeToast()` / 两处 `syncVisitList` 监听、background `batchSyncVisits` / `triggerSync`
- **云端接口保留**：`/api/v1/visit`、`/api/v1/visits`、`/api/v1/visits/batch` 与 `visit_record` 推送不变；手机端同步与 dashboard 登记列表照常工作
- 当前客户登记仍走「一键登记」`registerVisit()`（提交 CRM + 写入云端）

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
2. fetch 超时：PC 直连探测 AbortController 500ms（PC_PING_TIMEOUT）；云端/列表/测试连接/顾问姓名上传均 8s（v4.23 补齐测试连接与 uploadAdvisorName，防止无限等待）
3. 浮窗/结果 DOM 输出统一经 `escHtml()`（v4.23 E-11 补引号转义，属性位置不再可注入）
4. 云中继所有 JSON 响应统一 `Access-Control-Allow-Origin: *`；扩展经 host_permissions 不受 CORS 限制
5. 扩展自动更新后需刷新 CRM 页面才能注入新版 content-script

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
│   ├── settings.js             ← settings.json 读写、云服务器列表同步（v4.23 P-9：tmp+rename 原子写 + 损坏自动备份 settings.json.corrupt-*）
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

**云中转状态机（cloud.js）**：`_cloudTraversalGeneration` 递增防旧连接事件覆盖新状态；阶梯退避重连 0→1s→3s→5s→10s→30s→60s→5min，v4.23 起失败 30 次后不再停摆而是**转 5 分钟低频重试**（P-4，断网过夜恢复后自动回来）；pong 超时 20s 判死；服务器列表按序尝试，失败自动重排重连链（v4.14 修复 failover generation 单次递增；v4.13 修复 error 分支与"从未认证成功"路径的重连恢复）。

**生命周期与安全（v4.23）**：单实例锁 `app.requestSingleInstanceLock()`（P-3，二次启动唤起既有窗口而非双开）；`get-info` 补 `connected`/`firewall` 字段（P-1，激活渲染端状态条）；启动横幅与 set-pin 日志 PIN 脱敏 `_maskPin()`（P-10）；短信 ACK 超时/异常回 `notifySmsResult`（P-5，短信窗口不再卡死）；removeDevice/cleanupStaleDevices/_purgeDeadZombies 连接归属校验（P-8）。

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

> ⚠️ **整端已废弃（2026-09-12 拍板）**：`go build` 不可用且 Electron 版功能完整覆盖，不再维护、不再修复（遗留问题 G-1~G-9 逐条记录于《未闭环问题清单》）。以下内容仅作历史存档。

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

> 注：2026-09-10 代码已并入 v4.16 改动（握手带 deviceId、auth_pending 等待授权 UI），`versionName` 仍为 4.53 待下次发版更新；旧 APK 缺 deviceId 时云端自动回退 deviceName，无需强制升级。

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
├── KeepAliveReceiver.kt        # 保活自查闹钟（v4.23 A-14：进程被杀 15 分钟内复活服务）
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
- **LAN 连接**：OkHttp WebSocket，连接超时 5s、读超时 45s、ping 30s、TCP KeepAlive 15s idle/5s interval/3 probes；握手 `phone_hello{pin, deviceName, deviceId}`
- **云端连接**：独立 client，连接超时 6s，从 `cloud_servers` 列表遍历尝试；握手 `phone_hello{pin, deviceName, deviceId, messageId}`（v4.16 起 deviceId 复用 `PrefCtrl.getDeviceId()` 的 device_uuid）；`auth_ok` 中 `pc_present=false` 时发起 PC 探活（8s 超时等 ACK）；收到 `auth_pending` 透传上层（ConnectionManager 显式分支 → DialService `ACTION_AUTH_PENDING` 广播 → ConnectFragment 橙点脉冲"等待授权中…"，可取消断开）
- **PC 真探活**：`phone_hello` 携带 `messageId="probe_<ts>"` → PC 回 `ack{messageId}` → `pcConfirmedOnline=true`；8s 无 ACK 保持 false
- **公开属性**：`isConnected`、`isPcReachable`（LAN已连 或 Cloud已连且 pcConfirmedOnline）、`isLanConnected`、`isCloudConnected`、`transportMode`（"lan"/"cloud"/"lan+cloud"）
- **重连退避**：1→3→5→10→30→60→300s（LAN 最大 30 次，Cloud 最大 8 次；网络变化重置，2s 防抖）
- **网络监控**：`ConnectivityManager.NetworkCallback`，onAvailable 触发重连、onLost 停止 LAN 发现、WiFi 开关联动发现序列

### 5.3 DialService — 前台服务

**生命周期**：BootReceiver/MainActivity.startService() → onCreate（FileLogger.init → callLogDb 初始化 → startForeground → wakeLock(12h) → syncFromSystemCallLog → registerCallStateListener → ConnectionManager → registerNetworkMonitor → registerScreenOnReceiver → loadSavedConfig 自动连接）→ onStartCommand 处理 Intent。

**Intent Actions**：`ACTION_EXECUTE_PENDING_DIAL`（通知点击执行待拨号码）、`CONNECT`（携带 ip、pin）、`DISCONNECT`、`DIAL_WITH_SIM`（携带 number、sim_slot）、`DIAL`（v4.23 A-6：通话页/详情页拨号入口统一走 `dialEngine.dialNumber`，配 `ContextCompat.startForegroundService`）、`DIAL_CANCELLED`。

**保活自查（v4.23 A-14）**：`scheduleKeepAliveWatchdog()` 用 `AlarmManager.setExactAndAllowWhileIdle` 每 15 分钟自检（requestCode 2001，onDestroy 取消）——服务进程被系统杀死后 15 分钟内自动复活（exact alarm 属 Android 12+ FGS 后台启动豁免场景）；复活条件：DialService 未运行、PIN 非空、非手动断开。`startDataSync()` 加幂等保护（A-4）。

**防双拨（v4.23 A-10）**：WS "dial" 分支同号 4 秒窗口（`SystemClock.elapsedRealtime`，`lastDialAtByNumber` 超 32 条按时间淘汰）——PC/扩展连点不再真拨两次。

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
        ├── DialAccessibilityService.expectSimPicker(simSlot, windowStateOnly = !isXiaomi)
        │     ← v4.23 A-11 全厂商预布防；simHandleCache 绑定 subscriptionId（A-5，换卡后旧缓存失效不再拨错卡）
        ├── telecomManager.placeCall(uri, extras)  ← 主路径
        └── 失败 → fallback: ACTION_CALL intent
onDialSuccess: onDialResult("ok") 回 PC → callLogDb.insertDial → notifyNewDial → 剪贴板复制 → 拨号动画
拨号提示查询走独立 hintExecutor 单线程池（A-13），不阻塞拨号主流程
```

**挂断**：`Build.VERSION.SDK_INT >= P` 时 `telecomManager.endCall()`。

**已知注意点**：`dialNumber()` 不检查当前通话状态（通话中再次拨号可能失败）；`resolveSimSlot()` 不检查 SIM 可用性（SIM 无信号可能拨号失败）——均属低风险设计取舍。

### 5.6 CallLogDb — 通话记录数据库

SQLite `autodial.db`，DCL 单例，版本 2：
- `dial_log` 表：`_id` PK、`number`、`dial_time`、`sim_slot`、`status`（"ok"/"error"）
- `sim_cache` 表：`number` PK、`sim_slot`、`call_time`（从系统通话记录同步）

查询层级：dial_log（APP 自身）→ sim_cache（系统同步缓存）→ 系统 CallLog（实时，需 Context）。初始化时异步 `syncFromSystemCallLog()` 写 sim_cache 上限 500 条。写入 try-catch 保护（磁盘满不崩溃）。

### 5.7 辅助功能

- **DialAccessibilityService**：Xiaomi/HyperOS 自动点击系统 SIM 选择器（检测包名 com.android.phone，找"卡1"/"卡2"或运营商名，8s 超时清除）；**v4.23（A-11）预布防扩展到全厂商**——非小米走"仅监听 TYPE_WINDOW_STATE_CHANGED"的严格模式（`pendingWindowStateOnly`，事件开头先过滤类型），降低误点通话界面风险；需用户手动在系统设置开启（AndroidManifest 中声明已注释，华为禁用/小米需用时取消注释）
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
- 云端远程构建全流程 + CI 排错经验：见 `CI构建与排错指南.md`（触发方式 / Secrets 配置 / 产物下载 / 六轮排错复盘 / 陷阱速查）

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
| 频率限制 | WS 握手每 IP 每分钟 5 次；管理登录 60s/5 次（username+IP 维度，HTTP 429）；REST 按端点分级限频（v4.21）：认证/管理类 60、轮询类（auth/pending）240、业务类 600 每分钟/IP，localhost 豁免 |
| 心跳超时 | WebSocket ping/pong（云端 30s/90s；PC 端 15s/20s） |
| 空 PIN 守卫 | PC 端未设置 PIN 时拒绝一切连接 |
| 本地端口来源校验 | PC 端 35432 仅接受回环 Host + 可信来源（chrome-extension://、本机程序），防外部网页静默拨号/DNS rebinding（v4.14） |
| 管理员鉴权 | 敏感读端点需会话令牌（24h 过期）；密码 SHA-256 加盐哈希存储 + 登录兼容旧明文自动迁移（v4.14） |
| 授权归属校验 | WS auth_response 仅 PC 端可响应；REST auth/respond 三重校验：pin 一致 + 该 PIN 的扩展在线 + 响应 IP 与扩展轮询 IP 一致（防手机自批/越权，v4.14 / v4.22） |
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
| **35440** | WS + HTTP | 云中继容灾备用实例（对外映射 Docker 容器内 35430，主实例故障时备用；数据独立落宿主机卷） | autodial-relay 容器 |
| **35432** | HTTP + WS | PC 端主服务（LAN 直连 + 扩展连接，仅监听 127.0.0.1） | Electron/Go PC |
| **35433** | UDP | LAN 设备发现（广播 announce + 响应 discover） | 全部组件 |
