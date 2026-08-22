# AutoDial 更新日志

## 2026-08-22

### 第四批 P2/P3 清理修复（QA 独立回归 13/13 PASS）— 完成于 2026-08-22 11:00

死代码清理 / QA 遗留观察项 / 轻量优化，每处删除均先 grep 全量确认无调用者。

**云中继**
- [Q1] `dashboard.html` `delAdminAccount` 迁移为 data-action 事件委托（与第二批 S3 统一，消除最后一处拼接式 onclick）
- [Q2] `cloud_relay_v2.py` 登录成功清空该 (user,ip) 失败计数（限频不再跨成功保留）
- [Q3] `get_logs` 改为文件尾部倒读（PY-P1-2 轻量缓解，不再全量读入 10MB 日志；8 例边界实测通过）
- [Q4] 死代码删除：`check_heartbeats` / `_sync_to_crm` / `_lookup_kid` / http.server import；注释对齐（热更新、5 分钟→1 分钟）

**Chrome 扩展**
- [Q5] 死代码删除：`tabPhones` / `reDetectPhone` / `_lastAuthPollTime` / `checkIsAdmin` 分支 / `getMyPhoneFromCRM` / `adStyles` / `showPosition`

**Go PC 端**
- [Q6] 死代码删除：`generatePinCode` / `onUpdate` 回调；go.mod 清理 EDY 残留注释

**Electron PC 端**
- [Q7] 删除无调用方的 `fetchCloudServers` 函数与 `fetch-cloud-servers` IPC 注册
- [Q8] 删除无发送方的监听：floatbar `menu-dial`/`menu-hangup`、index.html `error`/`open-settings-tab`/`open-sms-tab`
- [Q9] 删除 `index.html` 死代码 fetch `/api/set-pin`（实际走 IPC）；`discovery.js` 未使用变量
- [Q10] `pack.js` 硬编码 EDY 缓存路径 → `os.homedir()` 动态路径

**Android**
- [Q11] `DialService.kt` 删除未使用 pin 变量
- [Q12] `CallLogDb.kt` 异常文案指向真实存在的 `getInstance(context)`
- [Q13] 删除死代码 `rebuildV3ConnectionHeader` / `showDialModeDialog`；`autoTestServersOnStart` 经 grep 确认有调用者、正确保留

**QA 独立回归**：13/13 PASS / 0 FAIL；前序修复（dashboard 委托 9 action、authorized 授权标记、登录限频、Electron IPC 通道）兼容性抽查通过。
**遗留观察项**（非阻塞，后续顺手可清）：floatbar.html:412 `error` 监听无发送方；main.js 7 个无调用方 ipcMain 处理器；get_logs 全空行文件边界（实际无影响）；discovery.js 未使用解构。

**四批累计修复 49 点**（18 + 12 + 6 + 13）。剩余建议单独立项：PY-P1-2（REST 线程池化）、AN-P1-3（HTTPS 迁移）；EX-P1-2（PIN 误检测，设计取舍）。

### 第三批修复：资源泄漏 / data race / 体验（QA 独立回归 R1-R6 全 PASS）— 完成于 2026-08-22 10:30

**Go PC 端**
- [R1] `server.go` ACK 定时器超时路径补 `delete(pendAcks, msgID)`（GO-P1-1，消除每次拨号超时的 AckEntry 泄漏；与 handleAck 幂等共存）
- [R2] `devices.go` removeDevice 补关连接（GO-P1-6），并经 QA 发现后**收敛**：仅关闭 LAN Ws（独立读 goroutine 防泄漏）；共享 CloudWs 生死归 cloud.go pong 看门狗，单台云手机超时不再引发全体云设备闪断重连
- [R3] `settings.go` 全局 appSettings 加读写锁 + tmp/rename 原子写（GO-P1-8；23 处引用全量覆盖，锁序无嵌套、无重入）

**Electron PC 端**
- [R4] `cloud.js` 替换旧连接时清理旧 `_pingTimer`（EL-P1-3，消除重连定时器泄漏）

**Android**
- [R5] `CloudCtrl.kt` testServer 用 try/finally 统一释放 OkHttpClient（AN-P1-8，覆盖成功/失败/取消全出口）

**Chrome 扩展**
- [R6] `content-script.js` showToast 上提到 IIFE 顶层（EX-P1-3，顶层同步进度不再回退阻塞式 alert）

**QA 独立回归**：R1-R6 全部 PASS / 0 FAIL；前两批兼容性抽查 3 项 PASS。gofmt/vet/build 与 node --check 通过（frontend/dist embed 缺失为既有环境问题）。

**至此三批累计修复 36 点**（第一批 18 + 第二批 12 + 第三批 6）。剩余未修：PY-P1-2（REST 线程池化，大改建议单独立项）、AN-P1-3（HTTPS 迁移，单独立项）、EX-P1-2（PIN 误检测，依赖 CRM 页面，需用户决策）及 P2/P3 低危项。

### 审计报告 P0/P1 最小改动修复（软件开发团队协作，QA 回归通过）— 完成于 2026-08-22 08:35

依据《Bug检查报告-2026-08-21.md》修复 18 点（工程师寇豆码执行、QA 严过关独立回归：17 PASS / 1 风险 / 0 FAIL）。所有改动遵循最小 diff，未引入新依赖。

**云中继**
- [A1] `cloud_relay_v2.py` init_db `:memory:` 降级分支补建 phones/call_records_raw/phone_events/phone_daily_stats 4 张表（修复 PY-P0-1 漏建表）
- [A2] `_seed_default_admin()` try 前预置 `conn = None`，杜绝 finally NameError（PY-P1-5）
- [A3] `dashboard.html` loadPins 两个 fetch 补管理 token（PY-P1-3，"人员管理"页恢复可用）
- [A4] `escA()` 补反斜杠转义（PY-P1-4；残余风险见下）
- [A5] REST `/api/v1/auth/respond` 踢旧手机补 `close`（PY-P1-6，消除幽灵连接）

**Chrome 扩展**
- [B1] `auth.html` 内联脚本与 onclick 抽到外部 `auth.js`（EX-P0-1，规避 MV3 CSP，设备授权弹窗恢复可用）

**Go PC 端**
- [C1] `security.go` Origin 校验：空/`null` 拒绝 + 精确 host 校验（GO-P0-1，堵前缀绕过与空 Origin 放行）
- [C2] WebSocket 并发写锁：设备级 `wsMu` + 全局 `cloudWsMu` 统一串行化所有写路径（GO-P0-2；QA 死锁专项审查通过）
- [C3] `cloud.go` 读循环补 `case "ack"`，与本地共用 handleAck（GO-P0-3，云通道拨号不再误超时/重复拨号）
- [C4] `RestartCloud` 异步化（GO-P1-4）
- [C5] 悬浮条状态接通 `updateFloatbarStatus`（GO-P1-5，拨号/挂断按钮恢复可用）

**Electron PC 端**
- [D1] `cloud.js` failover generation 单次递增（EL-P0-1，多服务器遍历恢复）
- [D2] `main.js` 托盘创建移到窗口创建之后（EL-P1-1，托盘菜单恢复可用）

**Android**
- [E1] `build.gradle` 移除硬编码签名密码，改 env/keystore.properties 必填（AN-P0-1）
- [E2] `DialService` 亮屏 receiver 补 RECEIVER_NOT_EXPORTED（AN-P0-2，Android 14+ 不再崩溃）
- [E3] 通知栏移除 PIN 明文（AN-P1-2）
- [E4] `MainActivity` 三个广播改 RECEIVER_NOT_EXPORTED（AN-P1-4）
- [E5] `RegisterFragment` flushPendingSyncs 线程池 finally shutdown（AN-P1-5）

**已知残余**：
- A4 未完全覆盖 onclick 单引号属性注入（`&#39;` 被属性解析器解码还原），建议后续将 dashboard 内联 onclick 迁移到 addEventListener + data-* 属性；本次已按报告要求堵住反斜杠向量
- EL-P0-2（Electron 仅监听回环导致 LAN 直连失效）属 v4.14 有意安全收窄，未改
- 其余报告 P1/P2/P3 项未在本次范围，见报告

### 第二批修复：安全 5 + 功能 4 + 崩溃 2 + 构建 1（QA 独立回归 12/12 PASS）— 完成于 2026-08-22 09:40

**安全**
- [S1] `server.js` Electron 端来源校验与 Go 对齐：空/`null` 来源拒绝 + URL 精确 host（EL-P1-4，堵 `<img>` 静默拨号）；HTTP 与 WS verifyClient 同步收紧；renderer 依赖核查无本地端口真实依赖
- [S2] `cloud_relay_v2.py` 授权绕过封堵（PY-P1-1）：新增 `meta['authorized']` 标记，未授权手机的消息不再转发给 PC（心跳 ping/pong 不受影响；等待授权链路保持可收 auth_ok）
- [S3] `dashboard.html` 8 处含用户数据的动态 onclick 全部委托化为 data-action + 事件委托（A4 残余加固，彻底消除 onclick 单引号注入）
- [S4] `cloud.go` 云端 phone_hello 增加 PIN 校验（GO-P1-7）：readPin() 空/格式/与配对码不符均拒绝注册；QA 评估不会误伤合法多手机
- [S5] `cloud_relay_v2.py` 登录限频改按 (username, client_ip) 维度（PY-P1-7，消除全局 DoS）

**功能**
- [F1] `cloud.js` 自动重连恢复（EL-P1-2）：error 分支与"从未认证成功"路径均调度重连，与 D1 generation 兼容
- [F2] `content-script.js` syncVisitList 顶层监听器不抢答（EX-P1-4，iframe 布局下同步恢复）
- [F3] `content-script.js` 分页识别限定容器 + 纯数字≤4 位 + http(s) 协议（EX-P1-5，不再把手机号链接当页码）
- [F4] `app.go` + `server.go` dialQueue 覆盖时 Stop 旧 Timer（GO-P1-3，消除连续拨号号码被误删）

**崩溃 / 构建**
- [C1] `RegisterFragment.kt` / `StatsFragment.kt` 后台线程 requireContext 改主线程预取 appCtx（AN-P1-1）
- [C2] `MainActivity.kt` postDelayed 弹窗加 isFinishing/isDestroyed 守卫（AN-P1-7）
- [B1] `package.json` build.files 补 `themes/**/*`（EL-P1-5，修复 electron-builder 打包缺主题）

**QA 独立回归**：12/12 PASS / 0 FAIL；与第一批兼容性抽查 3 项（D1+F1、A1/A2/A5+S2/S5、S1+扩展 fetch）全部 PASS。非阻塞观察：dashboard L1166 `delAdminAccount(a.id)` 拼接式 onclick 仅含 DB 自增整数、风险低，可后续统一。

## 2026-08-21（深夜）

### 报告全量复核修订（只改文档，未动代码）

对《Bug检查报告-2026-08-21.md》全部约 183 条论断逐条复查（5 复核代理 + 关键点人工实测 + 官方 changelog 核证，另经第三方 AI 独立验证 8 项核心修正全部确认）：

- **PY-P0-2 降级 P0→P2**：websockets.legacy 实测（12.0/16.0/16.1.1）与官方 changelog 确认**从未移除**（14.0 弃用、15/16/17 均保留），"新环境部署必崩 ImportError"不成立；Dockerfile `>` 重定向机制属实但后果为"依赖未锁定 + 弃用 API"
- **PY-P2-b 误报移除**：REST header 大小写敏感不成立（websockets Headers 内部键全小写，实测命中）；README 对应警示已撤销
- **数字修正**：PY-P0-1 漏建 4 张表（非 5 张）；MISSING 计数 6 处（非 7）；`/api/history` 返回约 2.4 小时（非 4 小时）
- **措辞修正**：AN-P1-1（L626/660 有 try-catch，真无保护在 L690）、AN-P0-2 子项、AN-P2-e 30 次上限、EX-P1-3/4、EL-P2-a
- **严重性补充**：GO-P0-1 空 Origin 直接放行（`<img>` no-cors 即可触发，比原判定更严重）
- P0 有效清单 10→**9** 项；P2 合计 60→61；复核统计 ✅161 / ❌3 / ⚠️19
- 同步修订：`README.md`（撤销 header 大小写警示、history 2.4h）、`部署指南.md`（websockets 坑措辞："未锁定"非"必崩"）

## 2026-08-21

### 全量代码复审（只读）+ 文档规整

**审计**（未修改任何代码）
- 五端（云中继 Python / Chrome 扩展 / Go PC 端 / Electron PC 端 / Android 端）全量静态审查
- 新增《Bug检查报告-2026-08-21.md》：P0×10（均已二次核验）、P1×33、P2×60、P3×82
- 重点结论：扩展 auth.html 被 MV3 CSP 阻断（授权流程死亡）；Go 端 Origin 前缀匹配可绕过；Electron 云 failover 永不切换；Android 签名密码硬编码 + Android 14 必崩；websockets 依赖未锁定
- 核验 v4.14 声称修复项：Android 三项属实；授权链路/来源校验/ACK 竞态修复均不完整或被绕过

**文档规整**（依据实际代码修订）
- `README.md`：修正错误码表（补 `MISSING`）、响应格式说明、`/api/v1/visits` 筛选参数、`/api/history` 保留时长、双模路由超时描述（仅探测 500ms）、扩展版本号（5.0.0）、目录结构（补 themes.js、auth.html 定位）、PIN header 传递方式；新增版本号现状说明与依赖坑警示
- `部署指南.md`：新增"已知部署坑"（websockets<14 上界 + Dockerfile shell 重定向缺陷）
- `待验证问题.md`：新增 2026-08-21 复审待验证项（B1-B5）

## 2026-08-19

### v4.14 全链路修复 + 安全加固

**云中继 cloud_relay_v2.py**
- 修复 `GET /api/v1/auth/respond` 引用未定义 `default_pin` 的 NameError（扩展端授权流程恢复可用）
- 授权防越权：REST `auth/respond` 必须携带与请求一致的 `pin`（错误返回 `UNAUTHORIZED` 且不消耗请求）；WebSocket `auth_response` 仅允许 PC 端响应——封死等待授权的手机自批
- `reconnect_request` 纳入 `PC_TO_PHONE_TYPES` 转发白名单（此前被静默丢弃，PC 云端唤醒离线手机完全失效）；`forward_to_phones` 的 `targetDevice` 兼容设备名与设备当前 PIN
- `events/log`、`stats/report` 的 `INSERT OR REPLACE INTO phones` 改为 `ON CONFLICT DO UPDATE`，不再抹掉管理员预设的 `default_pin`/别名（设备绑定被手机上报静默破坏的问题）
- 新增 `_connect_db()` 统一连接入口（39 处替换），每个连接显式 `timeout=5` + `PRAGMA busy_timeout=5000`，消除低版本 Python 下并发写 `database is locked`
- 管理员安全：密码 SHA-256 加盐哈希存储（`_hash_pwd`，登录兼容旧明文并自动迁移）；登录限频（60s/5 次失败返回 `429 RATE_LIMITED`）
- 鉴权收紧：`/api/status`、`/api/clients`、`/api/stats`、`/api/logs`、`/api/history`、`/api/v1/pins`、`/api/v1/groups`、`/api/v1/devices`、`/api/v1/device-history`、`/api/v1/calls`、`/api/v1/phone-stats`、`/api/v1/events` 及 `/api/v1/visits`（无 pin 时）要求管理员令牌
- `AUTODIAL_DB_PATH` 环境变量支持（Docker 数据库落持久卷）

**dashboard.html**
- 敏感查询统一携带会话令牌（`withToken`）；PIN 下拉框 `p.pin` 转义防 Stored XSS

**PC 端（Go + Electron）**
- 本地端口 35432 增加回环 Host + 可信来源校验（扩展/Electron 页面/本机工具放行；外部网页与 DNS rebinding 拒绝），HTTP 与 WebSocket 均覆盖
- Go：`sendToPhone` ACK 定时器写入改为非阻塞 select（消除竞态 goroutine 泄漏）；`/sms` 补号码格式校验；`server.go`/`devices.go` 格式化
- Electron：`set-pin` 错误通过 `pin-error` 通道回显（前端监听 + 校验对齐），消除"假保存成功"；`addLog`/短信模板 innerHTML 转义防 XSS

**Chrome 扩展**
- 授权弹窗 `respondAuth` 携带 PIN（配合云中继归属校验）

**Android**
- `MainActivity` 权限回调下标修复（通话列表刷新）；`CallLogDb` 日期格式改 ThreadLocal（消除跨线程竞争）；`ConnectionManager` 日志 PIN/手机号脱敏

**测试**
- `test_auth.py` 场景4 的 respond 请求补 `pin` 参数，与新版协议一致

**文档**
- 更新 `README.md`、`AutoDial-API.md`、`部署指南.md`、`待验证问题.md`（本文档）

## 2026-08-01

### 云中继并发 / DB 性能 P0 修复 + 测试脚本

**cloud_relay_v2.py**
- 新增专用 DB 线程池 `_db_executor`（8 线程），将同步 SQLite 查询卸载到线程池，避免阻塞事件循环
- SQLite 启用 WAL 模式（`journal_mode=WAL`）、`synchronous=NORMAL`、`busy_timeout=5000`，缓解写锁阻塞读
- localhost 请求不限频（健康检查、管理面板自身调用）
- `forward_to_phones` 遍历前创建快照，避免迭代过程中集合被并发修改
- `_schedule_async` 优化：事件循环内用 `create_task`，跨线程用 `run_coroutine_threadsafe`
- REST 拨号转发、`visit_record` 推送统一改用 `_schedule_async`

**测试脚本**
- 新增 `test_cloud_relay_v2.py`、`test_stress_50_users.py`

**文档**
- 更新 `README.md`、`部署指南.md`、`待验证问题.md`

## 2026-07-31

### 扩展端 UI 对齐手机端「天空蓝 · 亮白」(v4.13)

**Chrome 扩展**
- `popup.html` 弹窗整体改版：暗金主题 → 天空蓝亮色主题，与手机端默认主题（ThemeManager sky-blue/light）一致
  - 页面底色 #EBF4FF、白色卡片 + #DCEAF7 描边、输入框 #F4F8FC、主按钮 #4A90E0→#1A56A8 蓝渐变
  - 状态大盘改为浅蓝渐变卡片，在线状态点增加脉冲动画
  - 设置项改为白卡分区 + 图标小块（#EDF5FD），与手机端设置页一致
- `auth.html` 设备授权页同步改版为天空蓝亮色
- `content-script.js` 新增「天空蓝」主题并设为默认（localStorage 已选主题的用户不受影响）
  - 修复亮色主题下拨号按钮文字对比度（新增 textOnAccent 字段）
  - 清理 5 处硬编码旧主题色（#2ECC71/#E74C3C），改用主题变量
- `popup.js` 修复状态文字 class 名不匹配（server-status → field-status），成功/失败着色此前未生效
- 扩展版本号 4.1.0 → 4.2.0

## 2026-07-23

### 安全加固 + Bug 修复 (v4.12)

**云中继**
- 管理后台增加管理员鉴权（账号密码登录 + 会话令牌，24h 过期）
- 管理员账号存于 `admin_accounts` 表，鉴权始终启用（`_check_admin`）；`GET /api/v1/login` 发放 24h 会话令牌
- 保护端点：添加/删除管理账号、分组增删、登记增删改、踢出设备
- 修复会话令牌永不过期 bug、登录状态验证用错接口 bug

**PC 端 (Go)**
- 监听地址从 `0.0.0.0` 改为 `127.0.0.1`（防止局域网直接访问拨号接口）
- 修复 `activePin` 闭包问题（切换手机后定时器可能删除错误队列）
- `msgCounter` 改用 `atomic.Uint64`（消除并发数据竞争）

**Electron**
- 修复剪贴板检测不工作（main.js 返回字符串，渲染层错误读取 `d.text`）
- `pack.js` TLS 证书校验恢复（仅在构建期间临时放行，构建后恢复）

**Chrome 扩展**
- 修复挂断/短信/拨号 `sendResponse` 不调用（导致按钮无反馈）

**Android**
- 批量同步通话记录从 50 条限制为 20 条（避免 URL 超长）

**工程整理**
- 删除废弃文件：`cloud_relay.py`（旧版）、`web_server.py`；`package.json` 未删除（仍存在于 `pc-app-Electron/`）
- 更新 `build.bat`、`start.bat`、`Dockerfile` 引用到 `cloud_relay_v2.py`
- 清理过时/冗余文档 3 份，更新技术文档 3 份

## 2026-07-21

### 同步登记列表全链路修复 + 纯增量去重 (v4.11)

**核心问题**：扩展端"同步登记列表"功能完全失效（3个bug），且云中继去重逻辑导致跨天重复入库。

**content-script.js** — 修复 3 个 Bug + 自动翻页
- **Bug #1**（严重）选择器错误：`form[name="fdsf"] table tr` 匹配了搜索表单（1行）而非数据表格（22行），导致循环从未执行
  - 修复：`form[name="fdsf"] ~ table tr`
- **Bug #2** 列数过滤错误：`cells.length < 12`，实际表格只有 11 列，所有行被过滤
  - 修复：`cells.length < 11`
- **Bug #3** 时间列索引错误：`cells[11]` 超出范围，应为 `cells[10]`
  - 修复：`cells[10]`
- **新增** 自动翻页抓取：从分页链接扫描所有页码，用 `fetch + DOMParser` 逐页解析，合并全量记录
- **新增** 增量反馈 toast：`✅ 同步完成：共 120 条，新增 80 条，跳过 35 条（当日已存在），失败 5 条`

**background.js** — 右键菜单增强 + visit_time 传参 + 分状态计数
- **新增** 3个右键菜单入口：
  - 🔁 一键同步上门数据（任意CRM页面右键 → 自动跳转+同步）
  - 同步登记列表当前页（仅列表页右键）
  - 🔁 一键同步上门数据（扩展图标右键）
- **新增** `visit_time` 参数传递到云中继
- **改进** `batchSyncVisits` 区分 `synced / skipped / failed` 三种状态
- **去除** 重复的 `VISIT_LIST_URL` 局部声明，提升为模块常量
- **修复** 使用 `chrome.contextMenus.removeAll()` 防止 MV3 service worker 重启时菜单重复

**cloud_relay_v2.py** — 纯增量去重 + visit_time 支持
- **新增** `visit_time` 字段：DB迁移 + CREATE TABLE + INSERT + visit_record推送
- **改进** 去重逻辑：有 `visit_time` → `WHERE mobile=? AND visit_time=?`（真·纯增量）；无 `visit_time` → 回退旧逻辑（兼容一键登记/手机端）
- **关键变化**：同一客户同一天的 CRM 来访记录，无论同步多少次，只存一条

**dashboard.html** — Web 管理面板增强
- **新增** 表格"来访时间"列（第9列）
- **改进** 日期筛选优先按 CRM 来访时间（`visit_time || created_at`）
- **新增** 来源筛选增加"CRM同步"选项 + 独立 badge 样式（`.badge-crm` 蓝紫色）
- **改进** CSV 导出增加"来访时间"列
- **更新** 所有 colspan 9→10

### 全链路数据流

```
CRM list_user_visit.html
  → extractVisits() + 自动翻页
  → batchSyncVisits (name/mobile/kefu_tel/visit_type/visit_time)
  → Cloud Relay (/api/v1/visit) → mobile+visit_time 精确去重
  → SQLite INSERT (含 visit_time)
  → WebSocket push {type:'visit_record', data:{...}} → Android
  → Dashboard 查看/编辑/删除/导出
```

### 触发方式

| 入口 | 路径 |
|------|------|
| CRM 页面右键 | 🔁 一键同步上门数据 |
| 扩展图标右键 | 🔁 一键同步上门数据 |
| Popup 按钮 | 同步登记列表 |

---

## 2026-07-20

### 管理面板重大升级 (v4.10) + P0/P1 缺陷修复

**cloud_relay_v2.py** (1736→1989行)
- 新增 6 个管理 API 端点：
  - `GET /api/v1/devices` — 已注册设备清单（含在线状态标注）
  - `GET /api/v1/calls?device_id=&pin=&date_from=&date_to=&number=&limit=&offset=` — 通话记录查询+分页
  - `GET /api/v1/kick?pin=&role=` — 踢出在线客户端
  - `GET /api/v1/phone-stats?device_id=` — 每日对账数据（服务端 vs 手机端，OK/MISMATCH）
  - `GET /api/v1/events?device_id=&event_type=&limit=` — 手机行为事件日志
  - `GET /api/history` — 连接数历史（供仪表盘趋势图）
- `/api/stats` 扩展：新增 `by_type`（消息类型分布）和 `by_pin`（按PIN统计）字段
- `/api/logs` 扩展：支持 `?n=N` 行数和 `?q=关键词` 搜索
- 新增连接数历史追踪系统：每30秒快照，环形数组保留24小时(2880点)
- 新增 `cleanup_memory()` 定期清理机制（每10分钟）：message_count_by_pin(Top200)、last_ext_activity(1h过期)、pending_visits(上限100)、last_dial(10min过期)、daily_stats(90天)、_pin_attempts过期条目
- **P0修复**：`/api/v1/calls/batch`、`/api/v1/events/log`、`/api/v1/stats/report` 三个端点补全 `try/finally` 确保数据库连接释放
- **P1修复**：`save_stats()`/`load_stats()` 失败增加日志输出；CRM同步更新失败记日志

**dashboard.html** (817→864行，完全重写)
- 新增 3 个 Tab 页：📞 通话记录、📱 设备管理、📊 对账面板
- 仪表盘增强：6个统计卡片（含在线PC/手机计数）+ 连接趋势折线图 + 消息类型饼图
- 客户端管理：踢出功能真正实现（不再弹"暂未实现"）+ 角色筛选 + 设备名搜索
- 通话记录：日期/设备/号码筛选 + 分页 + CSV导出
- 设备管理：在线状态(绿/灰点) + 手机型号/版本 + 首次/最后在线
- 对账面板：OK/MISMATCH 高亮标记
- 日志增强：关键词搜索 + 行数选择(100/200/500/1000)
- 流量统计：新增消息类型饼图 + 按PIN柱状图(Top10)
- UI 现代化：卡片阴影/渐变动画/响应式布局/自动刷新15秒

**pc-app-Electron/modules/cloud.js** (481→484行)
- **P0修复**：error 事件不再提前设置 `_cleanedUp = true`，改用 `_errorHandled` 标记
- close 事件中检查 `_errorHandled`，跳过重复UI清理但仍触发自动重连
- 修复了"error先于close触发时自动重连永不执行"的bug

## 2026-07-19

### 手机端云中转数据同步系统（新功能）
**cloud_relay_v2.py**
- 新建 4 张数据库表：
  - `phones` — 设备注册（device_id, label, last_pin, model, version, first_seen, last_seen）
  - `call_records_raw` — 原始通话记录（device_id+local_id 联合主键，幂等去重）
  - `phone_events` — 行为事件日志
  - `phone_daily_stats` — 每日统计 + 服务器重算对账（match_status: OK/MISMATCH）
- 新增 3 个 REST API 端点：
  - `GET /api/v1/calls/batch?device_id=&pin=&data=` — 增量通话记录批量上传
  - `GET /api/v1/events/log?device_id=&event_type=&pin=&detail=` — 行为事件记录
  - `GET /api/v1/stats/report?device_id=&pin=&count=&duration=&connected=` — 每日统计快照（服务器从 raw 重算并对比）
- 新增 `today_start_ms()` / `today_end_ms()` 时间工具函数

**PrefCtrl.kt**
- `getDeviceId()` — 首次调用自动生成 UUID 并持久化到 SharedPreferences

**DialService.kt**
- `startDataSync()` — 启动定时同步，首次立即触发，之后每 5 分钟
- `syncCallRecords()` — 从系统 CallLog 增量查询（`_id > last_synced_id`），批量 50 条，通过 GET 上传
- `syncDailyStats()` — 上传今日财运/通时/接通数快照
- `logEvent(eventType, detail)` — 异步记录行为事件到服务器
- `normalizeHttpUrl()` — ws:// 转 http:// 工具方法
- `onDestroy()` 新增清理定时任务和线程池

### 云服务器管理优化
**CloudCtrl.kt**
- `testServer()` 重写：从 HTTP GET 改为 WebSocket 全链路认证测试（发 auth → 收 auth_fail 即成功）
- `resetToDefault()` — 清除已保存服务器列表，回退到代码内置默认
- `getTodayConnectedCount()` — 查询今日接通次数（呼出且 duration > 0）
- `getConnectedCountSince()` — 按时间段查询接通次数
- `DayStats` 新增 `connectedCount` 字段，`getDailyDurationStats()` 中统计
- 默认服务器别名设为 `融鑫汇腾讯云专线`
- 修复：`resume()` 需要 `onCancellation` 空 lambda，补 `java.net.URL` import

**CloudServerSheet.kt**
- 删除按钮增加二次确认弹窗
- `PC 同步` 改为 `恢复默认`（清除列表，回退到代码内置默认）
- `测速` 改为 `测试`，全部测速改为 `全部测试`
- 添加对话框：新增格式说明（`IP或域名:端口，无需加 ws://`）+ 示例 + 别名字段
- 按钮 `别名` → `点击修改别名`
- 未连接状态：🟡 → 🔴，颜色 `primaryLight` → `red`
- 测试点击反馈：Toast + 测后显示 ✅ 可达 / ❌ 不可达（Line 4）
- 网络获取：先 GitHub Gist 后 Gitee 备选，`distinctBy { url }` 去重

### 设置页优化
**ConnectFragment.kt**
- 设置页顶栏显示当前云服务器别名（连上断开都显示）
- 服务器别名 `<TextView>` 插入 `disconnectBtn` 前，`updateConnectionUI` 中更新
- `rebuildV3ConnectionHeader` 未调用问题修复
- `上次通话提示` 时长选项：5s/10s/30s/一直 → 2s/3s/5s/8s
- 修复：`colors` 和 `Gravity` 作用域问题

**DialService.kt — 同 PIN 挤下线修复**
- `ConnectionManager.onClosed(code=4001)` 新增 `notifyError(Disconnected("kicked"))`
- `lastDisconnectReason` 变量防止 `onStateChanged(DISCONNECTED)` 用 "disconnected" 覆盖 "kicked"
- `notifyConnectionChange()` 自动记录最后断连原因

**DialService.kt — 通知栏**
- 标题：`跨屏拨号` → `Auto融鑫汇`
- 内容简化为 `已连接`，追加今日数据：`今日财运：+12 接通6 · 67%`
- 连接状态文字：`已连接到电脑(cloud)` → `已连接`
- 初始状态文字：`跨屏拨号 运行中` → `运行中`

### 统计页优化
**StatsFragment.kt**
- 计数卡片（今日/一周/本月财运）：数字+单位合并一行，底部新增接通率副行
- 通时卡片保留独立单位行（左右卡片等高）
- 一周/本月标题可点击弹出每日明细弹窗（整张卡片可点）
- 明细弹窗：`BottomSheetDialog` 全宽，`NestedScrollView` 400dp，列名小标题，日期近→远
- `showVisitDetail` 弹窗同样改造：`NestedScrollView` + `isDraggable = false`
- 弹窗 `window.setLayout(MATCH_PARENT, WRAP_CONTENT)`，从底部自然滑出

**fragment_stats.xml**
- `statsTodayCount` → `0次`，`statsTotalCount` → `0次`，`statsTodayLuck` → `0次`
- `statsTodayDuration`/`statsTotalDuration` 恢复独立 `分钟` 行
- 新增 `statsTodayConnect`/`statsWeekConnect`/`statsMonthConnect`
- 月度分隔线高度 60dp → 72dp
- 4 个标题加 ID：`statsWeekCallLabel`/`statsWeekDurationLabel`/`statsMonthCallLabel`/`statsMonthDurationLabel`
- 4 个卡片容器加 ID 和 `clickable="true"`
- 修复 Kotlin 三元运算符（`?:` → `if-else`）

### 通话记录页优化
**CallLogFragment.kt**
- 卡1 SIM 标签颜色：`colors.text2` → `colors.text`（与号码颜色一致）
- 已接通话右侧：呼出/呼入 + 时长（如 `呼出3m15s`）
- 今日财运数字前加 `+` 号
- 连接状态文字：`未连接电脑` → `未连接`
- 重连 Pin 检查：`== 4` → `>= 4`（兼容 6 位 Pin）
- `connectionStatusBar` 发送广播方式改为 `LocalBroadcastManager`

**item_call_log.xml**
- 主题色占位改动（来自 07-18 的全局清理）

**DialPadSheet.kt**
- 删除按钮移至输入框右侧
- 禁止系统输入法弹出：`showSoftInputOnFocus = false`

**dialFab** → 52dp → 42dp

### 扩展端改动
**AutoDial-Extension/content-script.js**
- 去掉主管限制：移除 `checkIsAdmin` 检查，任何人可同步
- `handleSyncVisitList` 结构扁平化

### 云中转改动
**cloud_relay_v2.py**
- `POST /api/v1/visit` 新增去重：同一手机号当天已有记录返回 `{skipped: true}`
- 所有 API 改为 GET + query params（websockets process_request 仅支持 path+headers）

### 应用信息
- 应用名称：`A跨屏拨号` → `Auto融鑫汇`
- 通知 channel：`Auto融鑫汇通知`
- 无障碍服务描述：`Auto融鑫汇辅助服务`
- 无障碍服务声明已注释（华为禁用/小米需开启）

## 2026-07-18

### 主题色清理（91 处）
**所有 layout XML**
- 主题 tag 驱动的硬编码颜色统一替换为中性 `#888888`
- 改动文件：`activity_main.xml` / `fragment_call_log.xml` / `fragment_connect.xml` / `fragment_register.xml` / `fragment_stats.xml` / `item_call_log.xml`

### 华为设备兼容
**MainActivity.kt**
- 权限请求延迟 800ms（避免华为吞掉系统对话框）
- 悬浮窗权限双层保障：直接跳转 + 1500ms 后弹 AlertDialog 引导

**AndroidManifest.xml**
- 无障碍服务声明已注释（华为暂时关闭，小米需要时手动取消注释即可）

### 弹窗滚动修复
**StatsFragment.kt**
- `ScrollView` → `NestedScrollView`（配合 BottomSheet 避免下滑直接关闭弹窗）
- `dialog.behavior.isDraggable = false` 禁止下滑关闭

### 筛选芯片行优化
**fragment_call_log.xml + CallLogFragment.kt**
- 筛选芯片行右侧增加今日接通数和接通率显示
- 数据随通话列表刷新自动更新（ContentObserver 监听）

### 拨号盘图标
**ic_dialpad.xml + fragment_call_log.xml**
- FAB 按钮 52dp → 42dp
- 九宫格圆点间距调整（列距 7dp→5dp，行距 6dp→5dp），后恢复
