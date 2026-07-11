# AutoDial v4.1.0 更新日志

> 最后修改：2026-07-04 18:50

---

## 2026-07-11 — 手机端 V3 UI 原生化与交互补全

- 四个手机页面按 V3 原型调整卡片层级、字号、留白和圆角。
- 默认主题明确为天空蓝亮白；功能图标统一使用项目矢量资源。
- 通话页恢复标题栏右侧财运/财气红紫统计，并加入手动拨号 BottomSheet。
- 财库页保留红紫今日数据和红橙黄绿青蓝紫七日趋势。
- 设置页新增可切换的底部导航顺序。
- 连接动作按钮支持连接、取消、断开、重连。
- 设置展开区改为外层卡片 + 内部平直设置行。
- 新增云服务器管理 BottomSheet 与拨号模式说明 BottomSheet。
- 设置齿轮、云端、主题、同步等图标更新为细线矢量资源。
- 新增 `技术文档/AutoDial手机端UI技术文档-2026-07-11.md` 和同名 HTML 文档。
- 详细提交记录见 `optimization/CHANGELOG-2026-07-11.md`。

---

## 2026-07-04 — UI 大改版：设置页重构 + 双通道状态 + 多项 Bug 修复

### 🎨 设置页三大板块重构

原设置页「当前连接状态」「高级设置」「其他设置」混乱堆叠，重构为清晰的三大板块体系：

**▶ 跨屏连接设置**（原「高级设置」改名，合并通道状态）
- 局域网/云中转通道 → 移入此板块最前
- 连接策略（自动/仅LAN/仅云端）
- 自动连接（开关）
- 云服务器（管理/获取列表/PC同步）

**▶ APP拨号设置**（原「其他设置」改名）
- 拨号模式
- 电池优化（从跨屏连接移入——影响拨号后台保活）
- 自动复制号码
- 拨号动画效果
- 动画显示文字
- 导出日志

**▶ 主题/弹窗设置**（新增独立板块）
- 主题（16套主题×7级亮度 + 更换）
- 复制弹窗提醒（开关）

**实现方式**：`ConnectFragment.kt` 新增 `rearrangeSections()` 方法，在 `onViewCreated` 时动态重组视图层级，避免大规模 XML 改写风险。

### 📡 配对码区文案优化
- 标题：`配对码↓` → `↓你的系统手机号↓`
- 输入框 hint：`4位配对码 或 11位手机号` → `请填入11位手机号`
- 发现提示：`🔍 输入4位配对码或11位手机号开始搜索` → `填入手机号后点击右上角连接按钮`

### 🟢 状态大盘：PC/扩展双通道显示

**问题**：Chrome 扩展通过 REST API 拨号时，手机端永远显示「等待PC上线」——云中继只通过 WS 感知 PC 桌面端，不知道扩展的存在。

**方案**：利用现有扩展的 REST API 调用轨迹，无需修改扩展代码。

| 改动 | 文件 |
|------|------|
| 云中继新增 `last_ext_activity[pin]` 字典 | `cloud_relay_v2.py` |
| REST dial/hangup/visit 端点调用 `track_ext_activity(pin)` | `cloud_relay_v2.py` |
| `phone_hello` auth_ok 回包加 `ext_online` 字段 | `cloud_relay_v2.py` |
| `/api/v1/status` 加 `extOnline` 字段 | `cloud_relay_v2.py` |
| 5 分钟内有 REST 请求 → 扩展视为在线 | `cloud_relay_v2.py` |
| Android `ConnectionManager` 新增 `extOnline` | `ConnectionManager.kt` |
| Android `DialService` 新增 `isExtOnline` | `DialService.kt` |

**手机端状态显示三态**：

| 状态 | 颜色 | 主文字 | 副文字 |
|------|:---:|--------|--------|
| PC桌面在线 | 🟢 | **PC就绪** | 🖥 已连接 |
| 插件活跃 | 🟢 | **已就绪** | 🌐 浏览器在线 |
| 云端已连但双方都不在 | 🟡 | **云端已连接，等待拨号** | 请在电脑上点击拨打 |

**说明**：PC 在线时扩展走本地 `127.0.0.1:35432`，不会同时出现在云端，因此不会出现「PC+插件都在」的混淆状态。

### ⚙️ 状态横幅删除

`connectionBanner`（连接成功横幅）与状态大盘信息完全重复，已从 `ConnectFragment.kt` 和 `fragment_connect.xml` 中移除。

### 🐞 Bug 修复：记录页空白

**根因**：`CallLogFragment` 的 `lastDataFingerprint` 在 `onDestroyView()` 中未重置。ViewPager 切 Tab 后切回时，数据指纹不变 → 跳过 `loadCallLog()` 的 adapter 绑定 → RecyclerView 空白。

**修复**：`CallLogFragment.onDestroyView()` 中加 `lastDataFingerprint = ""` + `callLogAdapter = null`。

### 🐞 Bug 修复：轮选/相反模式无法识别历史通话

**根因**：`getLastDialInfo()` 和 `getLastSimSlotGlobal()` 的 SQL 查询过滤 `status = 'ok'`。在部分机型上 `placeCall` 失败后走 `ACTION_CALL` 兜底→双方都失败→记录 `status = 'error'`→轮选查不到→不弹窗。

**修复**：去除两个查询函数中的 `AND status = 'ok'` 过滤条件。insertDial 的 error 状态保留用于调试，查询不受影响。

### 🐞 Bug 修复：OPPOSITE 模式注释/说明/代码三处不一致

| 位置 | 修复前 | 修复后 |
|------|--------|--------|
| 注释 | 超过2天按**弹窗**处理 | 超过2天按**循环交替**处理 |
| 说明文案 | 超过2天按**轮选**处理 | 超过2天按**循环交替**处理 |
| 实际代码 | 循环交替（一直是对的） | 不变 |

### 🧹 代码清理
- 删除 `cloud-relay/python/auth.py`、`cloud_relay_v3.py`、`db.py`、`test_cloud_relay_v3.py`（v3 JWT 废弃模块）
- `ConnectFragment.kt` 删除 JWT 自动登录相关代码，统一使用 PIN 认证

---

## 2026-06-30 — 登记页对标 saoma.html 重构 + 云端管理升级


### 🔴 根因修复：登记 CRM 不生效

CRM 网页 `saoma.html` 改版，POST 参数从 `kefu_tel`（姓名）变为 `kid`（顾问内部 ID）。
项目所有端（插件/手机/云端）此前发 `kefu_tel`，CRM API 忽略该字段返回 `{"code":-1,"msg":"请选择顾问！"}`，
导致登记「假成功」——显示成功但 CRM 无记录。

**修复**：所有端改为两步提交——先调 `/bserve/search` 将顾问姓名转为 `kid`（内部ID），再带 `kid` POST。

| 端 | 文件 | 改动 |
|----|------|------|
| 云中继 | `cloud_relay_v2.py` | `_lookup_kid()` 新增；`_sync_to_crm()` 改两步提交 |
| Android | `RegisterFragment.kt` | `lookupKid()` 新增；`submitRegistration()` 带 kid |
| Chrome 扩展 | `background.js` | `lookupKidFromCrm()` 新增；`registerVisit()` 直连 CRM |

### 📱 登记页 UI 适配

| 改动 | 文件 | 说明 |
|------|------|------|
| 顾问字段变更 | `fragment_register.xml`, `RegisterFragment.kt` | 「顾问手机号(只读PIN)」→「接待顾问姓名(可编辑)」，持久化到 SharedPreferences |
| 来访事由固定 | 同上 | 固定「贷款咨询」，不可更改 |

### 👤 CRM 姓名自动检测

Chrome 插件从 CRM 页面自动检测业务员姓名（`.user-name` + `.user-phone` CSS 选择器，TreeWalker 兜底），
无需手动输入。`background.js` 上传到云中继 `/api/v1/advisor/register`，手机端按 PIN 自动获取。

| 文件 | 改动 |
|------|------|
| `content-script.js` | `getMyPhoneAndNameFromCRM()` 升级 CSS 选择器 |
| `background.js` | `uploadAdvisorName()` 上传姓名 |
| `RegisterFragment.kt` | `fetchManagerNameFromCloud()` 按 PIN 查姓名 |

### ☁️ 云端管理面板重构

| 功能 | 说明 |
|------|------|
| **PIN 管理** | 新增「PIN管理」标签页，列表显示所有已注册业务员（姓名/PIN/分组/管理员/更新时间） |
| **分组管理** | 新建/删除分组，PIN 拖拽分配到分组；`pin_groups` 数据表 |
| **管理员开关** | 点击按钮设为/取消管理员（纯手动，无权限校验） |
| **筛选升级** | PIN 筛选从文本框→下拉列表（不限/按PIN/按分组），支持「未同步」筛选 |
| **CRM同步状态** | 每行显示 ✅已同步 / ⚠未同步，未同步行红色背景；`crm_synced` 列 |
| **CSV 导出** | 一键导出当前筛选结果为 UTF-8 CSV |
| **趋势图** | 最近14天上门数柱状图（Chart.js） |
| **右键同步** | Chrome 右键菜单「同步登记列表」：主管在 CRM 来访列表页抓取全量记录推入云端 |

### 🔄 手机端离线补推

云端断连期间手机登记的记录自动入本地队列，WebSocket 重连后 `flushPendingSyncs()` 逐条补推。

| 文件 | 改动 |
|------|------|
| `RegisterFragment.kt` | `savePendingVisit()` + `flushPendingSyncs()` |
| `ConnectionManager.kt` | Cloud `onOpen` 时调用 `flushPendingSyncs()` |

### 📡 新增 API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/v1/advisor/register?pin=&name=` | 注册/更新顾问姓名 |
| `GET /api/v1/advisor/name?pin=` | 查询顾问姓名 |
| `GET /api/v1/advisor/is_admin?pin=` | 检查是否为管理员 |
| `GET /api/v1/advisor/set_admin?pin=` | 设为管理员 |
| `GET /api/v1/advisor/del_admin?pin=` | 取消管理员 |
| `GET /api/v1/pins` | 所有已注册 PIN 列表 |
| `GET /api/v1/groups` | 分组列表 |
| `GET /api/v1/group/add?name=` | 添加分组 |
| `GET /api/v1/group/del?id=N` | 删除分组 |
| `GET /api/v1/pin/set_group?pin=&group_id=N` | 设置 PIN 分组 |
| `GET /api/v1/visits?group=N` | 按分组查询上门记录 |

### 🐛 Bug 修复

| Bug | 位置 | 问题 | 修复 |
|-----|------|------|------|
| 🔴 | `cloud_relay_v2.py` | `_sync_to_crm` 残留两个连续 else（语法错误） | 删除重复分支 |
| 🔴 | `manifest.json` | 缺少 `contextMenus` 权限，右键菜单不显示 | 添加权限 |
| 🟠 | `dashboard.html` | `loadVisits()` 未同步筛选代码重复 | 删除死代码 |
| 🟠 | `content-script.js` | iframe 同步未传 toastFn，退化为 alert() | 传入 `iframeToast` |
| 🟡 | `RegisterFragment.kt` | `optString("name", null)` 返回字面串 "null" | 显式判空再返 null |
| 🟡 | `RegisterFragment.kt` | `syncToCloudRelay` 只看 HTTP 状态不读 JSON body | 增加 `ok` 字段检查 |

### 📂 涉及文件

`cloud_relay_v2.py` `dashboard.html` `manifest.json` `background.js` `content-script.js` `popup.html` `popup.js` `RegisterFragment.kt` `fragment_register.xml` `ConnectionManager.kt`

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

### 1. 录上门模块（Android 第 2 个 Tab）

**文件**：`RegisterFragment.kt`, `fragment_register.xml`

- 新增「录上门」Tab，顾问帮客户填写来访信息
- 顾问姓名从 CRM 列表点击选择
- 来访事由固定「贷款咨询」
- 提交时按钮置灰 + 加载态，成功后显示「✅登记成功」+ 2 秒恢复，失败 Toast 提示
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
