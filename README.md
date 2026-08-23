# AutoDial 一键拨号系统 v4.14

> 仓库：github.com/ztj555/autodial | 最后更新：2026-08-22 11:10
>
> **版本号现状**：本仓库各端独立演进，版本号不统一——云中继 API 报 `4.10`（dashboard 面板标 v6.0）、Chrome 扩展 manifest `5.0.0`、Android `versionName 4.53`、Electron `package.json 3.0.0`（页面内标 v6.x）。本文的 v4.x 叙事指系统整体迭代批次，与单端版本号不一一对应。

## 项目概述

AutoDial 是一套跨屏一键拨号+来访登记系统。用户在 CRM 网页中点击手机号自动拨号；右键悬浮按钮即可完成客户登记，数据实时同步云端和手机端。

**v4.14 更新（全链路修复 + 安全加固）**：
- **全链路链路修复**：云端设备授权 REST 路径修复（`auth/respond` NameError）；授权响应增加归属校验（防手机自批/越权）；`reconnect_request` 纳入云中继转发白名单并兼容 name/PIN 两种 targetDevice，PC 云端唤醒离线手机恢复可用；`INSERT OR REPLACE` 不再抹掉设备默认 PIN/别名；SQLite 所有连接统一 `busy_timeout`；Go ACK 定时器竞态修复；Android 通话列表刷新、日期格式线程安全、日志脱敏；Electron PIN 错误反馈打通；扩展授权弹窗携带 PIN
- **安全加固**：PC 端本地端口（35432）增加回环 Host + 可信来源校验（防任意网页静默拨号/DNS rebinding）；云中继敏感读端点全部纳入管理员鉴权；管理员密码哈希存储 + 登录限频；多处 innerHTML XSS 修复
- **部署**：Docker 数据库落持久卷（`AUTODIAL_DB_PATH`）

**v4.13 更新**：
- **云中继并发/DB 性能 P0 修复**：SQLite WAL 模式、DB 操作移出事件循环（线程池 executor）、智能调度 `_schedule_async`，50 并发压力测试全指标通过（WS 100/100 连接、REST P50=16ms）
- **扩展 UI 对齐手机端**：Chrome 扩展 v4.2.0 天空蓝默认主题（共 9 套主题），修复状态文字着色、清理硬编码旧主题色

**v4.12 更新**：
- **管理后台安全加固**：管理员账号密码登录 + 会话令牌（24h过期），保护敏感操作端点
- **PC端安全增强**：Go 监听地址改为 `127.0.0.1`，修复闭包和并发数据竞争
- **多端 Bug 修复**：Electron 剪贴板检测、Chrome 扩展按钮反馈、Android 同步 URL 超长
- **工程整理**：删除废弃文件，更新构建脚本和 Dockerfile 引用

**v4.11 更新**：
- **同步登记列表全链路修复**：修复 3 个 Bug（选择器/列数/时间索引），新增自动翻页抓取
- **纯增量去重**：`mobile + visit_time` 精确匹配，跨天同步不重复
- **右键一键同步**：CRM 页面右键 / 扩展图标右键 直接触发全量同步
- **增量反馈**：新增/跳过/失败 分状态 toast 提示
- **Web 管理面板增强**：来访时间列、CRM同步来源筛选、CSV导出升级

**v4.10 更新**（管理面板重大升级）：
- 新增 6 个管理 API（设备清单/通话记录/踢出/对账/事件日志/连接历史）
- Dashboard 新增 3 个 Tab：通话记录、设备管理、对账面板
- 手机端云中转数据同步系统（4 张新表、3 个 API）

**v4.5 更新**：
- 云服务器管理：别名系统、连接状态显示、默认 `101.34.65.254:35430`
- 设置页全面重构：卡片拆分+折叠箭头+动态副标题+策略标签
- 状态大盘优化：连接状态整合、失败原因提示、连接策略一键可见
- 新签名密钥（RSA2048）防止华为误报，CI 双构建 Release+Debug

## 系统架构

```
                       ┌──────────────────────────────────┐
                       │   云中继 cloud_relay_v2.py         │
                       │   端口 35430 (WS + HTTP)           │
                       │                                  │
     REST API          │   WebSocket 中继                   │
   ┌───────────────────│   visit 登记 API                   │──────────────────┐
   │                   │   SQLite (visits/pins/stats/log)  │                  │
   │   一键登记 + 同步  │   Web 管理面板 (dashboard.html)    │                  │
   │                   └────────────┬─────────────────────┘                  │
   ▼                                │  WS visit_record                      ▼
┌──────────────────┐                │                       ┌──────────────────┐
│ Chrome 扩展       │  HTTP 35432   │                       │ Android 手机端     │
│ (MV3)            │◄──────────────┼───────────────────────│                  │
│ PIN 自动检测      │   Go / Electron│                       │ WS 连云中继       │
│ 双模路由(Ping)   │    PC 端        │                       │ 收发 dial/hangup  │
│ 浮动按钮 9 主题   │               │                       │ 4 Tab 界面        │
│ 一键登记+确认弹窗 │               │                       │ 16 主题+7 亮度    │
└──────────────────┘               │                       └──────────────────┘
                                    │
                           手机离线 → pending_visits → 重连补推
```

## 端口配置

| 端口 | 协议 | 用途 |
|------|------|------|
| **35430** | WS + HTTP | 云中继（WS 中继 + REST API + Web 面板） |
| 35432 | HTTP + WS | PC 端主服务（局域网直连 + 扩展连接） |
| 35433 | UDP | PC 端设备发现（局域网广播/唤醒） |

## 目录结构

```
├── cloud-relay/
│   ├── python/
│   │   ├── cloud_relay_v2.py        # ★ 云中继主程序（WS + REST + Web面板）
│   │   ├── dashboard.html           # Web 管理面板（v6.0 Sky Design System）
│   │   ├── requirements.txt         # Python 依赖
│   │   ├── install.bat / build.bat  # 安装/构建脚本
│   │   ├── test_cloud_relay_v2.py / test_cloud_relay.py / test_auth.py / test_batch_import.py / test_server_start.py / test_stress_50_users.py  # pytest 测试集
│   │   └── docs/                    # 架构设计文档（Mermaid图）
│   ├── Dockerfile / docker-compose.yml  # Docker 部署
│   ├── start.bat                    # 快速启动脚本
│   └── AutoDial-Cloud-Relay.exe     # PyInstaller 打包产物
├── AutoDial-Extension/              # ★ Chrome 扩展 (MV3)
│   ├── manifest.json                # MV3 配置（v5.0.0）
│   ├── background.js                # Service Worker：PIN/路由/登记
│   ├── content-script.js            # 全帧注入：扫号/按钮/菜单（主题数据取自 themes.js）
│   ├── popup.html + popup.js        # 弹窗：配置 PIN + 服务器
│   ├── auth.html + auth.js          # 设备授权弹窗（外部脚本规避 MV3 CSP）
│   ├── themes.js                    # 扩展主题变量（9 套主题唯一定义源 AD_THEMES）
│   ├── AutoDial-API.md + README.md  # API文档 + 使用说明
│   └── icons/                       # 扩展图标 (16/48/128)
├── pc-app-Electron/                 # Electron PC 端
│   ├── main.js / preload.js         # 主进程 + 预加载
│   ├── pack.js                      # 打包脚本
│   ├── phone-connection-manager.js  # 手机连接管理
│   ├── modules/
│   │   ├── cloud.js                 # 云中继同步
│   │   ├── server.js                # 本地 HTTP+WS 服务（回环 Host + 可信来源校验）
│   │   ├── settings.js              # 服务器/配置同步
│   │   ├── discovery.js             # UDP 设备发现
│   │   ├── firewall.js              # 防火墙规则管理
│   │   ├── logger.js                # 日志模块
│   │   ├── network.js               # 网络监控
│   │   ├── phone-notes.js           # 手机备注
│   │   ├── tray.js                  # 系统托盘
│   │   └── windows.js               # 窗口管理
│   ├── renderer/                    # 前端界面（index.html/settings.html/sms.html/floatbar.html）
│   └── themes/                      # 主题数据
├── pc-app-go/                       # Go PC 端（Wails 桌面应用）
│   ├── main.go                      # 应用入口
│   ├── app.go                       # Wails 绑定方法 + 启动/剪贴板
│   ├── server.go                    # HTTP/WS 服务核心（路由/转发，监听 127.0.0.1）
│   ├── security.go                  # Origin/来源校验（回环 Host + 可信来源）
│   ├── cloud.go                     # 云中继连接/同步
│   ├── devices.go                   # 设备/PIN 校验 + 多手机管理
│   ├── settings.go                  # 持久化配置
│   ├── logger.go                    # 文件日志
│   ├── tray.go                      # 系统托盘（Win32 原生）
│   ├── udp.go                       # UDP 设备发现
│   ├── wails.json                   # Wails 框架配置
│   ├── frontend/                    # 前端界面（index.html + JS/主题）
│   └── build/                       # 构建产物（图标/清单）
├── android-app/                     # Android 手机端
│   └── app/src/main/java/com/autodial/app/
│       ├── MainActivity.kt          # 4 Tab + ViewPager + 底部导航
│       ├── ViewPagerAdapter.kt      # Tab 适配器
│       ├── ConnectFragment.kt       # 设置页（连接/策略/主题/通知）
│       ├── CallLogFragment.kt       # 通话记录
│       ├── RegisterFragment.kt      # 录上门
│       ├── StatsFragment.kt         # 财库统计
│       ├── ConnectionManager.kt     # WS 连接管理（核心）
│       ├── DialService.kt           # 拨号前台服务 + 数据同步
│       ├── DialEngine.kt            # 拨号引擎
│       ├── CloudCtrl.kt             # 云服务器管理 CRUD + 同步
│       ├── CloudServerSheet.kt      # 云服务器管理弹窗
│       ├── ThemeManager.kt          # 16 套主题 + 7 级亮度
│       ├── ThemeDialog.kt           # 主题选择弹窗
│       ├── DialMode.kt / DialModeSheet.kt        # 拨号模式
│       ├── ConnectionStrategySheet.kt             # 连接策略
│       ├── DialAnimationOverlay.kt / AnimationSheet.kt  # 拨号动画
│       ├── CallDetailSheet.kt       # 通话详情
│       ├── DialPadSheet.kt          # 拨号盘
│       ├── DialAccessibilityService.kt  # 无障碍拨号
│       ├── SimSelectOverlay.kt      # SIM 卡选择浮层
│       ├── SmsConfirmActivity.kt    # 短信确认
│       ├── CallLogDb.kt             # 通话记录 SQLite
│       ├── BootReceiver.kt          # 开机自启
│       ├── FileLogger.kt            # 文件日志
│       ├── NotifyHelper.kt          # 通知辅助
│       └── PrefCtrl.kt              # SharedPrefs 封装
├── 技术文档/
│   ├── README.md             # 文档导航（文档体系索引）
│   ├── AutoDial技术文档.md    # ★ 全端技术细节（架构/REST/WS/协议/DB）
│   └── AutoDial-UI设计文档.md  # UI 设计规范与重设计方案（含落地状态）
├── 测试与质量.md               # 场景测试 50 例 + 检测报告 + QA 待验证清单
└── CHANGELOG.md               # 版本更新日志
```

## 快速启动

### 1. 云中继

```bash
cd cloud-relay/python
pip install "websockets>=12,<14" pystray Pillow
python cloud_relay_v2.py
```

> ⚠️ **依赖版本提示**：代码使用 `websockets.legacy.server`（14.0 起弃用但**从未移除**，最新版仍可导入，不会 `ImportError`）。建议安装时钉死 `websockets<14` 以锁定仍受支持的版本（防御性）。云中继 `Dockerfile` 中 `pip install ... websockets>=12.0 ...` 未加引号，`>` 会被 shell 解析为重定向、版本约束实际不生效（详见《Bug检查报告-2026-08-21.md》PY-P0-2，已降级为 P2）。

启动后 WebSocket + REST API + Web 面板均监听 35430 端口。生产部署建议使用 Docker 或 Supervisor（见下文「部署」章节）。

### 2. Chrome 扩展

1. Chrome 打开 `chrome://extensions/` → 开启"开发者模式"
2. 点击"加载已解压的扩展程序"，选择 `AutoDial-Extension/` 目录
3. 打开 CRM 页面（guwen.zhudaicms.com），自动检测坐席手机号为 PIN
4. 点击扩展图标可配置服务器地址

### 3. Go / Electron PC 端

```bash
# Go 版（Wails 桌面应用）
cd pc-app-go && wails build

# Electron 版
cd pc-app-Electron && npm install && npm start
```

### 4. Android 手机端

使用 Android Studio 打开 `android-app/` 构建，或下载 GitHub Actions 自动构建的 APK。

## REST API（云中继 35430）

- 业务端点（dial/hangup/status/visit 等）的 PIN 通过 **`X-AutoDial-PIN` 请求头**传递（服务端按大小写不敏感方式匹配，发送大写/小写均可）；其余参数走 URL query。
- 响应格式：多数业务端点返回 `{"ok": bool, "code": "xxx", "message": "xxx"}`；`/api/v1/visits` 成功时返回裸 JSON 数组，`/health`、`/api/status`、`/api/stats`、`/api/clients`、`/api/history` 等运维端点返回各自的状态对象。

### 核心拨号

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/dial?number=xxx` | 拨号 → `ACCEPTED` / `PHONE_OFFLINE` / `PC_CONNECTED` |
| GET | `/api/v1/hangup` | 挂断 → `ACCEPTED` |
| GET | `/api/v1/status` | 查询 PC/手机/扩展在线状态 |

### 登记管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/visit?name=...&mobile=...&kefu_tel=...&visit_type=...&visit_time=...` | 一键登记（支持visit_time去重） |
| GET | `/api/v1/visits?pin=...` | 查询登记列表（API 仅支持 `pin`/`group` 参数；`unsynced`、日期筛选是 dashboard 前端过滤，直接调 API 无效；无 pin 时需管理员令牌） |
| GET | `/api/v1/visit/update?id=N&...` | 更新登记记录（🔐 管理员） |
| GET | `/api/v1/visit/delete?id=N` | 删除登记记录（🔐 管理员） |

### 顾问管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/advisor/register?pin=...&name=...` | 注册顾问 |
| GET | `/api/v1/advisor/name?pin=...` | 查询顾问姓名 |
| GET | `/api/v1/advisor/update?pin=...&name=...` | 更新顾问姓名（🔐 管理员） |

### PIN 分组管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/pins` | 所有 PIN 列表 |
| GET | `/api/v1/pin/set_group?pin=...&group_id=N` | 设置 PIN 分组 |
| GET | `/api/v1/groups` | 分组列表 |
| GET | `/api/v1/group/add?name=...` | 添加分组 |
| GET | `/api/v1/group/del?id=N` | 删除分组 |

### 管理后台认证（v4.12 新增）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/login?user=...&pass=...` | 管理员登录（返回令牌；限频 60s/5 次失败） |
| GET | `/api/v1/logout?token=...` | 登出 |
| GET | `/api/v1/admin/accounts` | 管理账号列表（🔐） |
| GET | `/api/v1/admin/add?user=...&pass=...` | 添加管理账号（🔐） |
| GET | `/api/v1/admin/del?id=N` | 删除管理账号（🔐） |
| GET | `/api/v1/admin/chpwd?id=N&newpass=...` | 修改密码（🔐） |

> v4.14 起管理员密码以 SHA-256 加盐哈希存储（登录兼容旧明文并自动迁移）；敏感读端点（`/api/status`、`/api/clients`、`/api/stats`、`/api/logs`、`/api/history`、`/api/v1/pins`、`/api/v1/groups`、`/api/v1/devices`、`/api/v1/device-history`、`/api/v1/calls`、`/api/v1/phone-stats`、`/api/v1/events`）同样需要管理员令牌。

### 设备与数据同步（v4.10+ 新增）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/devices` | 已注册设备清单（含在线状态） |
| GET | `/api/v1/device-history?device_id=...` | 设备 PIN 历史 |
| GET | `/api/v1/device-set-default-pin?device_id=...&default_pin=...` | 设置设备默认 PIN |
| GET | `/api/v1/device/update?device_id=...&label=...` | 设置设备别名 |
| GET | `/api/v1/calls?device_id=&pin=&date_from=&date_to=&number=&limit=&offset=` | 通话记录查询+分页 |
| GET | `/api/v1/calls/batch?device_id=...&pin=...&data=<json>` | 批量通话记录上传 |
| GET | `/api/v1/phone-stats?device_id=...` | 每日对账数据 |
| GET | `/api/v1/events?device_id=&event_type=&limit=` | 手机行为事件日志 |
| GET | `/api/v1/events/log?device_id=...&event_type=...` | 上报行为事件 |
| GET | `/api/v1/stats/report?device_id=...&...` | 每日统计快照 |
| GET | `/api/v1/kick?pin=...&role=...` | 踢出在线客户端 |
| GET | `/api/v1/visits/batch?data=<JSON>&token=...` | 批量导入登记 |
| GET | `/api/v1/auth/pending?pin=...` | 查询挂起授权请求 |
| GET | `/api/v1/auth/respond?request_id=...&allow=1\|0&pin=...` | 响应授权请求（pin 须与请求一致，防越权） |

### 运维

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（含 CORS） |
| GET | `/api/status` | 仪表盘状态 |
| GET | `/api/clients` | 在线客户端列表 |
| GET | `/api/stats` | 流量统计（含 by_type/by_pin） |
| GET | `/api/logs?n=N&q=关键词` | 最近日志（可搜索） |
| GET | `/api/history` | 连接数历史（服务端保留 24h 快照，API 返回最近约 2.4 小时/288 点） |
| GET | `/` | Web 管理面板 (dashboard.html) |

### 错误码

| code | 含义 |
|------|------|
| `ACCEPTED` | 指令已接受 |
| `INVALID_PIN` | PIN 格式无效（非 4 位或 11 位数字） |
| `INVALID_NUMBER` | 号码为空或不合法（非 3~20 位数字） |
| `PHONE_OFFLINE` | 手机未连接云中继 |
| `PC_CONNECTED` | PC 在线，应走本地直连 |
| `DUPLICATE_DIAL` | 5 秒内同号码重复拨号 |
| `MISSING_FIELDS` | 缺少必填字段 |
| `MISSING_PIN` | 缺少 PIN 参数 |
| `MISSING` | 缺少必要参数（与 MISSING_PARAM 并存的旧写法） |
| `MISSING_PARAM` | 缺少必要参数（v4.12） |
| `INVALID_PARAM` | 参数格式不合法（v4.12） |
| `MISSING_ID` | 缺少记录 ID（v4.10） |
| `MISSING_DATA` | 缺少 data 参数（v4.10） |
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
| `DELETED` | 删除成功（v4.10） |
| `UPDATED` | 更新成功（v4.10） |
| `RATE_LIMITED` | 登录失败过于频繁，60 秒后再试（v4.14，HTTP 429） |

## 双模路由

```
扩展拨号:
1. 尝试 HTTP 127.0.0.1:35432 (PC 直连，可达性探测 500ms 超时)
2. PC 不可达 → 云中继 /api/v1/dial (Header PIN)
   ├─ PC_CONNECTED → 提示切回本地
   ├─ PHONE_OFFLINE → 提示手机离线
   └─ ACCEPTED → 拨号成功
```

> ⚠️ 注意：500ms 超时仅覆盖 PC 可达性探测（ping）；实际的拨号/挂断/登记 fetch 请求当前未设置超时，PC 端 TCP 建连成功但不回包时请求可能长时间挂起。

## 连接策略（Android）

| 策略 | 说明 |
|------|------|
| 自动 (LAN优先) | 先尝试局域网直连 PC，不可用则走云中继 |
| 仅局域网 | 只连同一局域网内的 PC，不启用云中转 |
| 仅云中转 | 仅通过云服务器连接，适合不同网络环境 |

## 全链路 PIN 校验

| 环节 | 校验 | 位置 |
|------|------|------|
| 扩展设置 PIN | `/^\d{4}$|^\d{11}$/` | popup.js |
| 扩展请求云端 | `X-AutoDial-PIN` Header | background.js |
| 扩展请求 PC 端 | 同 Header（Go/Electron 端校验） | background.js |
| 云中继 REST | `validate_pin()` → 4/11 位纯数字 | cloud_relay_v2.py |
| Go PC 端 | `isValidPhonePIN()` → 4/11 位纯数字 | devices.go |

## 数据同步

- 插件/手机端登记 → 云中继 SQLite → WS `visit_record` 推手机
- 手机在线 → 实时收到 + 通知 + 统计刷新
- 手机离线 → pending_visits 堆积 → 重连时补推
- `cloud_server` 空时自动选列表第一台为当前服务器

## 部署

> 生产环境：腾讯云 101.34.65.254 | Ubuntu 22.04 | 1Panel v2.0.15

### ⚠️ 已知部署坑（修复前必读）

1. **websockets 版本未锁定（弃用 API）**：代码依赖 `websockets.legacy.server`。实测（12.0/16.0/16.1.1）与官方 changelog 确认：legacy 自 14.0 起**弃用但从未移除**（15/16/17 均保留可导入），不会 `ImportError`。但 `requirements.txt` 声明 `websockets>=12.0` 无上界，未来版本一旦移除 legacy 将导致启动失败。**建议：安装时钉死 `pip install "websockets>=12,<14"`**（防御性措施）。
2. **Dockerfile 版本约束失效**：`RUN pip install --no-cache-dir websockets>=12.0 aiohttp>=3.11` 中 `>` 被 /bin/sh 解析为输出重定向（在 /app 下生成垃圾文件 `=12.0`），版本约束完全失效。修复前请勿直接 `docker build`；建议改为 `pip install --no-cache-dir "websockets>=12,<14" "aiohttp>=3.11"`。

### 一、云中继部署

环境要求：Ubuntu 22.04+ / Python 3.10+ / `"websockets>=12,<14" pystray Pillow`（生产可仅装 `websockets aiohttp`）。

**Docker 部署（推荐）**：

```bash
docker run -d --restart=always --name autodial-relay \
  -p 35430:35430 \
  -v /opt/autodial/data:/app/data \
  autodial/cloud-relay
```

> **数据持久化（v4.14 起）**：容器内 entrypoint.py 默认设置 `AUTODIAL_DB_PATH=/app/data/visits.db`，数据库与日志（APPDATA=/app/data）均落在挂载卷，容器重建不丢数据。自定义位置：`-e AUTODIAL_DB_PATH=/app/data/visits.db`。

**Supervisor 部署**：

```bash
cd /opt/autodial/cloud-relay/python
pip install "websockets>=12,<14" pystray Pillow

# /etc/supervisor/conf.d/autodial.conf
[program:autodial-relay]
command=/usr/bin/python3 /opt/autodial/cloud-relay/python/cloud_relay_v2.py
directory=/opt/autodial/cloud-relay/python
autostart=true
autorestart=true
user=root
stdout_logfile=/var/log/autodial-relay.log
stderr_logfile=/var/log/autodial-relay-err.log

supervisorctl reread && supervisorctl update && supervisorctl start autodial-relay
```

**验证**：

```bash
curl http://localhost:35430/health
# 预期: {"service": "AutoDial Cloud Relay", "version": "4.10", "port": 35430, ...}
```

**安全配置（v4.14 起）**：管理员默认账号 `18335162275` / 初始密码 `123456`（SHA-256 加盐哈希存储），**首次登录后立即修改**；登录限频 60s/5 次（超限返回 `RATE_LIMITED`）；除 `/health`、`/`、`/api/v1/dial`、`/api/v1/visit` 等业务端点外，管理/统计/客户数据读端点均需管理员令牌（`?token=` 或 `Authorization: Bearer`）；手机端上报端点（calls/batch、events/log、stats/report）无需令牌。

**双实例部署（35430 + 35440）**：`python cloud_relay_v2.py --port 35430 &` + `python cloud_relay_v2.py --port 35440 &`（1Panel 两容器或 Supervisor 两进程）。

### 二、Android APK 构建

GitHub Actions 自动构建，产物：`app-release`（正式签名）/ `app-debug`（Debug 签名）。本地构建：

```bash
cd android-app
cp keystore.properties.example keystore.properties   # 填入真实密钥后
./gradlew assembleRelease    # 需密钥（keystore.properties 或环境变量）
./gradlew assembleDebug      # 无需密钥
```

> **v4.14 起（AN-P0-1 修复）**：签名密码禁止硬编码，仅从项目根 `keystore.properties` 或环境变量（`KEYSTORE_PASSWORD`/`KEY_PASSWORD`/`KEY_ALIAS`/`KEYSTORE_FILE`，env 优先）读取，缺失时构建报错。密钥文件 `android-app/autodial-release.p12`（RSA 2048 / SHA256 / 25 年）；GitHub Actions Secrets：`KEYSTORE_BASE64` + `KEYSTORE_PASSWORD` + `KEY_ALIAS` + `KEY_PASSWORD`。

### 三、Chrome 扩展分发

1. 加载已解压：`chrome://extensions/` → 开发者模式 → 加载 `AutoDial-Extension/`
2. 打包 .crx：扩展管理页 → 打包扩展 → 选择目录
3. 私钥文件 `.pem` 妥善保管，用于后续版本更新

### 四、服务器列表管理

- 默认服务器：首次启动自动使用 `101.34.65.254:35430`（App/插件端可修改）
- 远程列表：GitHub Gist `https://gist.githubusercontent.com/ztj555/cb6a6bb0ddbe3d4e651d5bb3411777d5/raw/AutoDialservers.txt`；Gitee `https://gitee.com/zuo-tingjun/AutoDialserverslist/raw/master/servers.txt`
- 格式：`[old]` 段旧站、`[new]` 段新站，支持行末别名，四端自动兼容：

```
[old]
262ao85kz470.vicp.fun:55535 旧主站
[new]
101.34.65.254:35430 腾讯云主站
```

### 五、防火墙与监控

```bash
ufw allow 35430/tcp        # 云中继端口（腾讯云安全组另加入站规则）
```

- `/health` 端点监控（UptimeRobot 等）；SQLite `visits.db` 定期备份；日志 `/var/log/autodial-relay.log` 已内置 RotatingFileHandler 轮转

## 注意事项

1. 云中继端口 35430 需防火墙放行
2. Android 端需授予拨号、通话记录、通知权限
3. MIUI/HyperOS 需加入电池白名单
4. Xiaomi 设备在"设置→无障碍"中开启 AutoDial 服务
5. PC 端和云中继可同时运行，扩展自动优先 PC 直连
6. 管理员默认账号 `18335162275 / 123456`（哈希存储），首次登录后请立即修改
7. PC 端本地端口 35432 仅接受回环 Host + 可信来源（Chrome 扩展/本机程序），外部网页无法直接拨号
8. 2026-08-22 已依据《Bug检查报告-2026-08-21.md》完成四批 49 点修复（P0 有效 9 项全部处理 + 精选 P1 + 中危清理），详见 CHANGELOG.md；剩余建议单独立项项（REST 线程池化、HTTPS 迁移、PIN 误检测设计取舍）见 CHANGELOG 与报告
9. 文档体系：技术细节见 `技术文档/AutoDial技术文档.md`，UI 规范见 `技术文档/AutoDial-UI设计文档.md`，测试场景/审计/QA 清单见 `测试与质量.md`，导航见 `技术文档/README.md`
