# GoDial 更新日志

## 2026-07-23

### 安全加固 + Bug 修复 (v4.12)

**云中继**
- 管理后台增加管理员鉴权（账号密码登录 + 会话令牌，24h 过期）
- 设 `AUTODIAL_ADMIN_PASS` 环境变量启用，不设则调试模式免登录
- 保护端点：设为/取消管理员、分组增删、登记增删改、踢出设备
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
- 删除废弃文件：`cloud_relay.py`（旧版 v2）、`web_server.py`、`package.json`
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
