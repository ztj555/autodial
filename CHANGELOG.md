# GoDial 更新日志

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
