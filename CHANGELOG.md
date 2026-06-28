# AutoDial v4.1.0 更新日志

> 最后修改：2026-06-29 00:25

---

## 2026-06-29 00:25 — PC 端 UI 美化 + 文档同步

### PC 端 UI 优化

| 优化 | 文件 | 说明 |
|------|------|------|
| Electron PC 圆角阴影 | `pc-app-Electron/renderer/index.html` | 圆角 5/10/24→10/18/28dp + 深阴影 + flash 动画优化 |
| Go PC 圆角阴影 | `pc-app-go/frontend/index.html` | 同上（阴影适配亮色底）+ 保留亮色默认主题 |

### 文档时间戳更新

全部 9 个文档同步到 `2026-06-29 00:25`，含 PC 端 UI 改动。

---

## 2026-06-29 00:08 — UI 美化 + 性能优化

### UI 美化（6 项）

| 优化 | 文件 | 说明 |
|------|------|------|
| SVG 图标替代 emoji | `res/drawable/ic_tab_*.xml` × 4 + `activity_main.xml` | 底部导航 🔗📋📊📝 → WiFi/日历/柱状图/笔 矢量图标 |
| 连接状态脉冲动画 | `ConnectFragment.kt` | 绿点外圈呼吸扩散效果（ValueAnimator + pulseRing） |
| Toggle 开关过渡 | `ThemeManager.kt` | 开关切换 200ms Argb 颜色渐变 |
| 卡片 slide-up 入场 | `CallLogFragment.kt` + `slide_up_item.xml` | 列表逐条滑入（50ms stagger） |
| SIM 标签加图标 | `item_call_log.xml` + `ic_phone_small.xml` | chip 旁添加小电话 SVG 图标 |
| 空状态升级 | `fragment_call_log.xml` | 圆形插图 + 标题/副标题 + 「立即拨号」CTA 按钮 |

### 性能优化

| 优化 | 文件 | 说明 |
|------|------|------|
| PC 检测后台化 | `background.js` + `manifest.json` | `chrome.alarms` 15s 定时探测，拨号直接读缓存（2s 卡顿 → 0s） |
| 拨号动画提前 | `DialEngine.kt` | `showDialAnimation()` 移到 `placeCall()` 前，点击即见反馈 |
| SIM handle 缓存 | `DialEngine.kt` | `simHandleCache` 避免每次拨号查 SubscriptionManager（省 50-100ms） |

### 新增文件

`ic_tab_connect.xml` `ic_tab_records.xml` `ic_tab_stats.xml` `ic_tab_register.xml` `ic_phone_small.xml` `empty_state_bg.xml` `pulse_ring_bg.xml` `slide_up_item.xml` `设计文档/手机端UI设计规范.md` `设计文档/before-after.html`

### 文档更新

`README.md` `AutoDial-Extension/README.md` `AutoDial-Extension/AutoDial-API.md` `技术文档/AutoDial总技术文档.md` `技术文档/AutoDial-手机端技术文档.md` `CHANGELOG.md`

---

## 2026-06-27 — 初始交付

## 新增功能

### 1. 来访登记模块（Android 第 4 个 Tab）

**文件**：`RegisterFragment.kt`, `fragment_register.xml`

- 新增「📝 登记」Tab，顾问帮客户填写来访信息
- 顾问手机号自动从 PIN 填入（只读）
- 来访事由固定「贷款咨询」
- 提交时按钮置灰 + 加载态，成功后显示「✅ 登记成功」+ 2 秒恢复，失败 Toast 提示
- 提交到 CRM API：`POST https://guwen.zhudaicms.com/bserve/saoma_indb.html`

### 2. 上门统计卡片（统计页）

**文件**：`StatsFragment.kt`, `fragment_stats.xml`

- 新增「📊 上门统计」卡片，展示 6 个维度
- 今日 / 本周 / 近 7 天 / 当月 / 上月 / 近 30 天
- 登记时间戳存储在 SharedPreferences，保留最近 66 天
- 插件端登记和手机端登记数据实时互通（通过云中继 WS 推送）

### 3. 一键登记（Chrome 扩展）

**文件**：`content-script.js`, `background.js`

- CRM 客户详情页自动识别客户姓名（「姓名：」标签后提取）和手机号
- 右键悬浮按钮新增「📝 一键登记 张三 139xxxx」
- 确认弹窗显示：客户姓名、手机号、顾问手机号、事由
- 登记通过云中继 `/api/v1/visit` 接口，云中继自动后台同步 CRM

### 4. 云中继访问登记存储 + 同步

**文件**：`cloud_relay_v2.py`, `dashboard.html`

- SQLite `visits.db` 存储全部登记记录，启动时自动建表
- REST API（全部在端口 35430）：
  - `GET /api/v1/visit?name=...&mobile=...` — 创建登记
  - `GET /api/v1/visits?pin=...` — 查询列表
  - `GET /api/v1/visit/update?id=...&...` — 更新记录
  - `GET /api/v1/visit/delete?id=...` — 删除记录
- Web 管理面板新增「🏠 上门记录」Tab（筛选/编辑/删除）
- 登记后 WS 实时推送 `visit_record` 给手机
- 手机离线时堆积到 `pending_visits`，重连后补推（失败保留队列）
- 登记后后台同步 CRM 系统

---

## Bug 修复

| Bug ID | 文件 | 问题 | 修复 |
|--------|------|------|------|
| P0-1 | `cloud_relay_v2.py` | `init_db()` 无异常保护，只读目录崩溃 | try-except 降级到内存数据库 |
| P0-2 | `cloud_relay_v2.py` | pending_visits 推送 fire-and-forget 数据丢失 | await 确认后再清除，失败保留重试 |
| P0-4 | `cloud_relay_v2.py` | 内嵌 HTML 缺少上门记录 Tab | 改为从外部 `dashboard.html` 动态加载 |
| P0-5 | `StatsFragment.kt` | 广播 RECEIVER_EXPORTED 安全漏洞 | 改为 RECEIVER_NOT_EXPORTED |
| P0-7 | `CallLogDb.kt` | `instance!!` 崩溃信息不友好 | 改为明确抛 IllegalStateException |
| P1-2 | `RegisterFragment.kt` | 登记时间戳无限增长 | 66 天上限过滤 |
| P1-9 | `ThemeDialog.kt` | onConfirm 回调不触发，主题切换 UI 不同步 | 补上 `onConfirm?.invoke()` |

---

## 性能优化

| 优化 | 文件 | 改动 | 效果 |
|------|------|------|------|
| PC 检测后台化 | `background.js` | `chrome.alarms` 每 15 秒定时探测，拨号直接读缓存 | PC 离线时从 2 秒卡顿 → 0 秒等待 |
| PC 超时降低 | `background.js` | `PC_PING_TIMEOUT` 2000→500ms | 本地 ping 500ms 足够 |
| 拨号动画提前 | `DialEngine.kt` | `showDialAnimation()` 移到 `placeCall()` 之前 | 点击即见动画，无感知等待 |
| handle 缓存 | `DialEngine.kt` | `simHandleCache` 缓存 PhoneAccountHandle | 每次省 50-100ms |

---

## API 变更

### 新增端点（全部端口 35430）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/visit?name=...&mobile=...` | 创建登记 |
| GET | `/api/v1/visits?pin=...` | 查询登记列表 |
| GET | `/api/v1/visit/update?id=N&...` | 更新记录 |
| GET | `/api/v1/visit/delete?id=N` | 删除记录 |

### 新增 WS 消息类型

| type | 方向 | 说明 |
|------|------|------|
| `visit_record` | 云→手机 | 访问登记记录推送 |

### 新增错误码

| code | 含义 |
|------|------|
| `MISSING_FIELDS` | 缺少必填字段 |
| `MISSING_PIN` | 缺少 PIN 参数 |
| `DB_ERROR` | 数据库操作失败 |

---

## 扩展权限变更

- `manifest.json` 新增 `"alarms"` 权限（后台定时 PC 探测）
- 版本号升级至 4.1.0

---

## 数据同步流程

```
插件端登记 / 手机端登记
        ↓
  云中继 SQLite 存储（visits 表）
        ├─ 后台同步 CRM 系统
        └─ WS 推送 visit_record 给手机
            ├─ 手机在线 → 实时收到 + 通知 + 统计刷新
            └─ 手机离线 → pending_visits 堆积
                           ↓
                      重连 phone_hello
                           ↓
                      await 补推（失败保留重试）
```

---

## 配置文件

| 文件 | 说明 |
|------|------|
| `visits.db` | SQLite 数据库，与 `cloud_relay_v2.py` 同目录，自动创建 |
| `dashboard.html` | 独立 HTML 文件，云中继启动时动态加载（支持热更新） |

---

## 已知限制

- 云中继重启后 `pending_visits` 丢失（内存队列）
- `placeCall()` 200-500ms 延迟为 Android 系统 IPC 开销，不可优化
- 登记时间戳上限 66 天，超期自动丢弃
