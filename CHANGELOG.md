# AutoDial 更新日志

## 2026-09-17（人员管理「刷新名单」：名册可从 CRM 源头同步 · v4.33）

> 需求：面板「人员管理」标题栏加一个**刷新名单**按钮，点一下就从源头（CRM 顾问列表）重新拉取人员名册。
> 改动 `cloud_relay_v2.py` + `dashboard.html`，**配色一行未动**。

**一、名册的定位变了：从"硬编码唯一源"改成"DB 权威 + 内置兜底"**

v4.26 起名册是写死在代码里的 11 人常量 `ADVISOR_ROSTER`（注释原话："不再动态拉取，不依赖外网、离线可用"）。
现在名册落库 `advisor_roster` 表：**DB 有数据就以 DB 为准**，空表（全新实例 / 清库后没刷新过）才回退内置表。
于是"刷新过"和"没刷新过"语义清晰可分，内置表降级为**出厂种子 + 离线兜底**（断网也照常显示，不是空页）。

**二、新接口 `GET /api/v1/roster/refresh`（管理员鉴权）**

拉 `POST https://guwen.zhudaicms.com/bserve/search`（`keyword=&brand=1833`，与插件端一键登记用的是同一份名单）。

🔴 **必须走线程池**：本服务的 HTTP 请求跑在 asyncio 事件循环里，直接在 handler 里做阻塞网络请求会让
**整个服务停摆**（拨号、WS 心跳、其他面板请求全部一起卡住）。实测慢 CRM（6 秒无响应）期间 `/health`
仍 **0.002s** 返回 —— 隔离生效。

🔴 **刷新失败必须无损**（第一原则）。逐项拒绝：连不上 / HTTP 非 200 / 返回的不是 JSON（被登录页或网关拦截）/
`code != 1` / `data` 为空 / 全部成员无效 —— 任意一条都**不碰数据库**（先取后写，不先删），并回明确原因。
否则一次网络抖动就会把名册清空、人员管理整页变空白，而用户完全看不出为什么。
写库中途失败也不怕：事务未 commit、连接关闭即回滚，名册仍是刷新前那份。

脏数据过滤：空 `id`、空 `name`、重复 `id`、非对象条目一律跳过，不让脏数据进名册。

**三、其它**

- `/api/v1/pins` 增返 `roster_synced_at`（上次同步时间；为空 = 从没同步过、当前是内置名单），面板据此提示。
- 新增环境变量（换域名 / 测试指向桩服务）：`AUTODIAL_CRM_ROSTER_URL`、`AUTODIAL_CRM_BRAND`、`AUTODIAL_CRM_TIMEOUT`。
- 前端：按钮点击期间禁用并显示「刷新中…」，结果用 toast 如实汇报（新增/移除/改名**带姓名**，如
  `名单已同步：共 3 人，新增 3 人（张三、李四、王五），移除 11 人（补录上门账号、韩俊、洪钰梅 等）`）；
  失败提示带「（现有名册未改动）」。

**四、实测**

| 层 | 项数 | 结果 |
|---|---|---|
| 隔离实例接口（真实 CRM + 桩 CRM） | 20 | 全过 |
| 真实浏览器 CDP（点按钮 → toast/DOM 断言） | 22 | 全过 |

覆盖：无 token 401、真实 CRM 拉到 11 人且无增删（0.27s）、落库后**重启实例名册仍在**、
非 JSON/空名单/业务错误/超时四类失败**均不改动名册**、脏数据只留有效项、慢 CRM 期间事件循环不被冻结、
按钮禁用→复原、失败后按钮可再点、表头列数==数据格数、无未捕获 JS 异常。

⚠️ **未验证**：生产服务器（腾讯云）**出网是否可达该 CRM 域名** —— 本机直连 200/0.22s 已确认，
但生产出网受限（只放通了镜像源），上线前必须在服务器上实测一次；若不通，按钮会如实报"无法连接 CRM"并保留原名册。

## 2026-09-17（安全门禁补齐 + 首页统计口径统一 · v4.32）

> 来源：本地压测与可靠性体检发现的两个问题（见 `技术文档/AutoDial-本地压测与可靠性体检-2026-09-17.html`）。
> 只改 `cloud_relay_v2.py`，三处；**`dashboard.html` 与配色一行未动**。

**一、P0 安全：`stats/report` 补设备注册门禁**

v4.23 给 `calls/batch`、`events/log` 加了「设备必须已注册」校验，但漏了 `/api/v1/stats/report` ——
这个端点既不要管理员身份、也不校验设备注册，**却会往 `phones` 表插一行**，于是成了后门：

| 步骤 | 修复前 | 修复后 |
|---|---|---|
| 未注册设备 `calls/batch` | 403 | 403 |
| 未注册设备 `events/log` | 403 | 403 |
| **无 token 调 `stats/report`** | **200 ← 设备被写进库** | **403** |
| 再调 `calls/batch`（同一设备） | **200 inserted=1 ← 校验被绕过** | 403 |
| 伪造设备出现在面板设备清单 | 是（机型「伪造机型」） | 否 |

改法：补上**同一道** `_device_registered()` 判断。
⚠️ **不能**改成「要求管理员 token」—— 手机端没有管理凭据，那样会打断正常上报。
**为什么不会误伤正常机**：手机端 `syncDailyStats()` 受 `if (!isConnected) { … return }` 门控，
只在 WS 连上后才跑；而 `phone_hello` 在那之前已把 `device_id` 写进 `phones`。

**二、首页「今日通话」口径统一**

此前 `WHERE date(server_time)=今天`（**入库时间**）；而面板通话列显示的是 `dial_time`、手机管理页「每日对账」
也用 `dial_time` —— 首页是**孤例**。手机离线几天后补传时，那几天的量会全算进「今天」：
实测首页 **14,306** vs 对账合计 **1,970**（差 7 倍）。现在首页改用 `dial_time` 区间 → **2,006**，
与 `dial_time` 区间直算**完全相等**；与对账的 36 条差额已逐台核对，全部来自一台**没有对账快照**的备用机。

顺带吃到索引：`EXPLAIN QUERY PLAN` 由 `SCAN call_records_raw` 变
`SEARCH … USING COVERING INDEX idx_call_records_dial`，单次 **3.27 ms → 0.10 ms**
（`/api/status` 是面板每 15 秒轮询的端点）。

**三、首页「今日上门」口径对齐（今天是零行为变化）**

`date(created_at)` → `date(COALESCE(NULLIF(visit_time,''),created_at))`，与**上门列表的日期筛选完全同口径**。
插件端在线登记不传 `visit_time` ⇒ 今天行为一模一样；但**批量导入的 Excel 带「上门时间」列**时会落进 `visit_time`，
原先首页会与列表页错开，现在不会。

**四、实测**

| 项 | 结果 |
|---|---|
| 攻击探测 A 段（7 项） | 全部 403 / 伪造设备未进清单 / 0 条脏记录 |
| 真实设备非回归 C 段 | `stats/report`、`calls/batch`、`events/log` 均 **200** |
| 探测数据残留 | `phones` **字段级 md5 前后一致**，零残留 |
| 项目自带测试 | **70 + 33 + 6 + 6** 项全过（`test_auth.py` 缺 `aiohttp`，环境问题，与本次无关） |
| 首页统计 vs DB 直算 | 完全相等（2006 = 2006） |

**五、工具**

`audit_probe.py` 升级为**三段式**（A 攻击面 / B 口径一致性 / C 真实设备非回归），并修掉一个自身缺陷：
`stats/report` 会 `ON CONFLICT DO UPDATE` 改写 `phones` 行的
`device_model`/`app_version`/`last_pin`/`last_seen`，只还原统计表不够 —— 现在连 `phones` 一起快照还原。

**状态**：**未推送线上**。本地实例由 `dev.bat` 热重载已到 v4.32。

## 2026-09-17（面板表格瘦身 + 数字列可读性 · v4.31）

**一、通话记录：9 列 → 7 列**

- 删除「模型」「版本」两列，信息收进**设备列的悬停提示**（`设备号 · 型号 · 版本`）。
  原因：设备列无别名时本身已显示「型号 · 尾4」，再单列一个「机型」会与设备列写**同一个型号**（视觉重复）。
- 「设备」列（无别名时）由裸 16 位设备号改为 **「型号 · 尾号」**（如 `OPPO A12 · 1000`）。
  尾号取**末尾连续字母数字最多 4 位** —— 直接 `slice(-4)` 会把连字符带进来（`e2e-device-001` → `-001`，读着像负数）。
  设了别名仍优先显示别名（别名是给你的手机起的名字，最直观）。手机设备表里查不到的标识（PC 端连接等）原样显示。

**二、数字列可读性**

- 「时长(秒)」列 **右对齐 + 等宽数字**（`font-variant-numeric: tabular-nums`，与首页统计卡数字同一套做法）。
  左对齐时 `7 / 128 / 0` 个位不齐，一列数字读不出量级差。
- **未接来电的时长显示「—」**：未接的时长也是 0，与「真的只通了 0 秒」同形分不开。表头同步右对齐。

**三、上门登记：11 列 → 10 列**

删除「ID」列（日常不看），**ID 挪到整行悬停提示**，报障要 ID 时 hover 即得。

**四、实测**

| 项 | 结果 |
|---|---|
| 上门页表格横向溢出 | **12px → 0** |
| 通话页窄屏（1024） | 容器宽 = 内容宽 = 854，无溢出 |
| 静态体检 / 执行级冒烟 / 真实浏览器 | 4 项 + 85 项 + 29 项，全过 |
| 列数一致性 | 「表头列数 == 数据格数」对通话表(7)、上门表(10) 均断言通过 |

⚠️ 实施注意：`colspan` 的**数值会被多个表共用** —— 上门表的 `11` 只有它自己用（可整体替换），
但通话表原本的 `9` 与**手机管理页共用同一个值**，必须逐处精确改，不能 `replace_all`。
另外**面板 HTML 是服务启动时读入内存的**，改完必须重启进程才生效（刷新浏览器无效）。

## 2026-09-17（面板设备列只讲设备 · v4.30）

**一、通话/列表页「设备」列不再显示人名**

设备没设别名时，这列原来会回退显示**「当前登录人」**（= 此刻谁在登录这台手机）。
下午手机换登同事的 PIN 后，同一行会同时出现两个人名：
「设备」列显示**借用人**，「顾问」列显示**手机主人** —— 纯误导。

现在 `deviceLabelOf()` 只认**别名 → 设备号**，删除 `current_name` 回退；
设备号显示长度与手机管理页的「设备ID」列统一（16 字符 + `…`）。
影响范围：通话记录页「设备」列、首页「最近连接记录」设备列、通话页设备筛选下拉（口径统一）。
「手机管理」页的「当前登录人」列**保持原样**——那页是设备详情，本来就该看到谁在用。

**二、历史数据不回填**

上一条 v4.29 的「代登记归属」改动只对新记录生效。用户确认**没有历史数据**（有的话也会清空），
故不做批量回填。

**三、版本号** `APP_VERSION` 4.29 → 4.30（便于区分线上跑的是哪一版）。

**验证**：静态体检 4 项全绿 · DOM 桩执行级 82 项全过 · 真实浏览器（CDP）27 项全过、零未捕获异常。
A/B 已确认：同一台无别名设备，旧代码「设备」列显示「韩俊」，新代码显示 `e2e-device-001`。

## 2026-09-17（归属口径修正：通话认「手机主人」· 上门认「接待顾问」 · v4.29）

问题来源：用户重申真实业务场景后逐条比对，发现两处**归属口径与真实业务不符**。

**业务事实（用户口述）**：手机不换人，但**上午用本人 CRM 的 PIN 打自己的客户，下午 15:00-16:00
改用同事的 PIN** 打同事 CRM 的客户（换人打提效）；上门登记则是**顾问是谁就归谁**。

### 一、通话记录认人：`last_pin` → `default_pin`

| 项 | 旧行为 | 新行为 |
|---|---|---|
| 归属字段 | `phones.last_pin` | `phones.default_pin`（= 手机主人，即手机管理页的「默认PIN」列） |
| 后果 | 下午一换 PIN，该机**上午的记录整体漂移到同事名下** | 归属稳定在手机主人 |
| 边界 | —— | 从未握手注册、只走过上报的设备 `default_pin` 为空 ⇒ `COALESCE` 回退 `last_pin` |

**改动**：后端新增常量 `_OWNER_PIN_SQL = COALESCE(NULLIF(p.default_pin,''), p.last_pin)`；
`/api/v1/calls` 与 `/api/v1/calls/export` 的 SELECT / WHERE 共 6 处统一改用它，
并 `LEFT JOIN advisor_names` 带出顾问姓名。面板通话页新增「顾问」列与「顾问（手机主人）」筛选，CSV 导出新增「顾问」列。

### 二、上门归属：登记人 → 接待顾问

| 项 | 旧行为 | 新行为 |
|---|---|---|
| `visits.pin` | 提交时插件端的 PIN（= 登记人） | 按 `kefu_tel`（接待顾问**姓名**）反查 `advisor_names` 得到的顾问 PIN |
| 代登记 | A 在自己电脑上帮 B 登记，仍归 A | **归 B** |
| 兜底 | —— | 顾问尚未用插件登记过（无 PIN）⇒ 回退登记人 PIN，记录不丢 |

**顺带修掉三处由此暴露的老问题**：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `/api/v1/visit` 落库后 | 原会把「登记人 PIN → 接待顾问姓名」写进 `advisor_names`（DO NOTHING）⇒ 代登记时污染人员表。**该兜底写入已删除** |
| 2 | `/api/v1/visits` 补姓名 | 用 `WHERE pin IN (姓名…)` 查 ⇒ 永远匹配不上，「顾问姓名」列**恒为空**。改为按 `name` 匹配 |
| 3 | `/api/v1/visits/export` | 同样按 pin 误查 ⇒ 导出该列整列空白。改为直接回填 |

**面板**：上门页表头「顾问(电话)」→「接待顾问」（该字段存的其实是姓名，不是电话），并新增「归属PIN」列
（= 落库归属键）——两列一姓名一号码，互补而非重复。

### 三、分组

用户明确：分组只是「方便人员管理、统计小组人数」，**可暂缓** ⇒ 本次**未改动**分组相关逻辑。

**验证**：`py_compile` ✅ · 自带测试 70 + 33 项全过 ✅ · 归属逻辑单测 13 项 ✅ ·
真实 HTTP 端到端 16 项 ✅ · 真实浏览器（CDP）21 项，含「表头列数 == 数据格数」防错位断言 ✅ · 无未捕获异常 ✅

---

## 2026-09-17（修复：登录失败提示指错方向 · v4.28）

问题来源：用户反馈截图 —— 用 `admin/admin` 登录得到「**登录失败：网络错误，请确认中继服务正在运行**」，
但中继服务其实正常。排查后确认**不是登录逻辑的问题**（`curl` 与真实浏览器用正确凭据都能拿到 token），
而是**错误提示把用户指向了错误的方向**。

根因：面板是同源相对路径设计（`const API_BASE = ''`、`const VISIT_API_BASE = window.location.origin`）。
只要有谁把 `dashboard.html` 当**普通文件**打开（编辑器的「文件预览」面板、直接拖进浏览器、
被别的服务器托管），页面就落在与中继**不同的 origin** 上，于是：

| 步骤 | 实际发生 |
|---|---|
| `POST /api/v1/login` | 打到那个静态服务器 → 回 403/404，body 不是 JSON |
| `await r.json()` | 抛 `SyntaxError` |
| `doLogin` 的 `catch` | 一律归成「网络错误，请确认中继服务正在运行」 |
| 用户的结果 | **中继明明活着，却被指去查服务**；真正该改的是打开方式 |

**改动（`dashboard.html` + 版本号）**：

| # | 位置 | 改动 |
|---|---|---|
| 1 | 新增 `checkEnv()` | 启动时自检 `/health`（该接口无需登录），核对 `service === 'AutoDial Cloud Relay'` 签名 |
| 2 | 失败原因细分 | 分三种：`nojson`/`other`（**有响应但不是中继** ⇒ 页面不是中继提供的）、`unreachable`（**压根连不上** ⇒ 服务没起）。两种给**不同的话**，不再混成一句 |
| 3 | 门禁初始化挂钩 | 未登录时立即把结论写进登录框内的 `#login-err`（该容器在遮罩**内部**，门禁态可见）—— **不用先登一次才看到提示** |
| 4 | `envErrHint()` | 登录失败按真实原因分因：`SecurityError`（存储被禁，保留 v4.25 语义）→ 自检结论 → `SyntaxError` → 兜底网络文案。自检已有结论时优先用它 |
| 5 | 建议地址 | 自检通过时把中继源存进 `AD_STORE('__ad_relay_origin')`，失败时据此给出「请改用 http://… 打开」 |

**验证**：

| 项 | 结果 |
|---|---|
| DOM 桩执行级冒烟 | **81/81 通过**（62 → 81，新增 19 项；桩同时加了 `throwOn` 以表达「网络层直接失败」） |
| A/B 反证 | 变体 A（`checkEnv` 退回「一律判为不是中继提供」）→ **精确失败 3 项**；变体 B（catch 退回旧三元 + 门禁不挂钩）→ **精确失败 2 项** |
| 静态体检 | 四项全绿（id 103/0、标签 0、CSS 变量 0、内联事件 45/0） |
| 真实浏览器 · 非中继托管 | 本地起静态服务器托管同一份 `dashboard.html`：**加载即提示**「当前页面不是由中继服务提供的（地址 …35499）…请改用 …35430 打开」；点登录后同一句话 —— 与用户截图的误导提示形成对照 |
| 真实浏览器 · 正常中继 | 加载时无任何环境提示、登录成功（`locked:false`、token 已写）、徽标 **v4.28**、无未捕获异常 |
| 项目自带单测 | `test_cloud_relay_v2` **70/70 通过** |

⚠️ 附带教训（已写入技能 `autodial-panel-verify` §3）：**交付面板时不要把 `dashboard.html` 当文件卡片抛给用户** ——
桌面端会把它静态托管在另一个 origin，等于亲手制造上面这个场景。正确做法是先起服务、传 `http://127.0.0.1:35430` **URL**。

## 2026-09-17（修复：外部 UX 报告逐条核验后的 7 项 · v4.27）

来源：第三方对 `dashboard.html` + `cloud_relay_v2.py` 的 UX 报告（桌面 `AutoDial-云端面板UX分析报告.md`）。
**逐条读实现体核验**后发现：行号与结论绝大多数成立，但 **1 处误判**（报告说「通话页 chips 初始全不亮」——
实测 `_loadCallsInternal` 内部就调 `_syncChips`，日期为空时命中 `'all'`、「全部」是亮着的）、
**1 处漏报真 bug**（趋势图横轴 UTC 错位，即下面第 1 条）。

**改动（全部集中在 `dashboard.html`，仅版本号改到 `cloud_relay_v2.py`）**：

| # | 位置 | 改动 |
|---|---|---|
| 1 | 趋势图 `renderVisitChart` | 横轴 key 由 `toISOString()`（世界时）改为本地日期 `_shiftDay()`。原实现每天 **00:00–08:00** 整条横轴日期整体偏一天、当天柱子恒为 0（记录时间戳是服务端本地时间，两套基准对不上），8 点后自愈 |
| 2 | 通话页设备下拉 | 由「截断 20 位的 device_id + 型号」改为「**别名** · 型号」（`deviceLabelOf`），与同页表格列口径一致；同时把 `_deviceList` 同步过来做映射源 |
| 3 | 批量导入 | `BATCH_SIZE` 20 → **200**（与提示文案「每批最多 200 条」对齐）。原来的 20 是 GET 时代的遗留值：8KB 上限只卡**请求行**，而 batch 端点 v4.21 起走 POST body（服务端 `readexactly(content_length)` 直读、无条数上限、`serve()` 未设 `max_size`）⇒ 往返次数少 10 倍 |
| 4 | 首页快捷入口 | 「导出今日」→「**导出今日登记**」（该按钮实际导的是上门登记，`quickExportToday`），补 `title` 说明 |
| 5 | 系统日志页 | 刷新不再无条件拽回底部：贴底（≤24px）才跟随最新，**正在上翻历史日志时保持原位置**（原来 15 秒一次的自动刷新会反复打断排查） |
| 6 | 全局 toast | 错误类提示 3.2s → **6s**；鼠标悬停暂停消失（=正在读），移开 1.5s 后收尾 |
| 7 | 会话失效（401） | 抽 `applyAuthUI()`：会话失效时**顶栏立刻出现「管理员登录」**（原来只有页面加载时切换一次按钮，用户看到「请重新登录」却找不到入口）；补齐 `visits`/`pins` 两个 401 点漏掉的 `clearSessionToken()`；横幅文案改为指明入口。另抽 `loadPageData()` 供 `showPage` 与「重新登录后恢复现场」共用，面板内重登**不再整页重载**、筛选与页码都留着 |

**验证**（详见《AutoDial-云端面板改版方案》§九）：

| 项 | 结果 |
|---|---|
| 两块内联脚本 `node --check` | 语法 OK |
| DOM 桩执行级冒烟 | **62/62 通过**（新增 Chart 桩 + 假时钟，能真断言图表横轴与分派行为；旧项无回归） |
| A/B 反证（4 处修复还原成旧写法） | **精确失败 9 项**，其中「本地 03:00 时当天 3 条只落到 2 条、最后一根柱变成昨天」正好复现用户看到的现象 |
| 静态体检 | id 引用 103 / 缺失 0；HTML 标签 0 问题；CSS 变量 0 未定义；内联事件 45 / 0 未定义 |
| 真实浏览器（CDP） | 登录后连切上门/通话/手机/日志四页：上门 50 行、分页「第 1 / 55 页 · 共 2720 条」、今天 chip 高亮；日志页真实布局下上翻刷新停 120、贴底跟到 5868；**全程无未捕获异常** |
| 端到端（本地隔离实例 35455） | POST 批量导入单批 20/200/500/2000 条全部 `inserted` 相符（200 条 = 36.5 KB / 0.03s）；**GET 兼容路径 21.8 KB URL 仍被拒 400** ⇒ 批次只能改 POST 那条路 |
| 项目自带单测 | `test_cloud_relay_v2` **70/70 通过**（原来 69/70：`test_new_stat_cards_exist` 还在断言 v4.24 已按设计移除的 `stat-active-names`，本次改为断言当前真实存在的 `conn-bar`/`alert-bar`）、`test_batch_import` 33/33 通过 |

**⚠️ 验证过程中自查出的一个真缺陷（已修，值得记）**：把 showPage 的 if-else 分派链抽成
`loadPageData()` 时，第 2 处 Edit 的 `old_string` 命中了**刚插入的那一份**，
结果写成 `function loadPageData(id){ loadPageData(id); }`（自调用死循环），而 showPage 的链原封不动。
后果是**静态体检全绿、59 项断言全过、CDP 也正常**，但 `enterPanel()`（重新登录路径）会栈溢出。
发现方式：核对「还原基线」时发现文件里只剩一处 `loadPageData(id)`。已修，并补了断言
「调用 `loadPageData('calls')` 必须真的发出 `/api/v1/calls` 请求」——把该缺陷还原后跑同一套断言会直接
抛 `Maximum call stack size exceeded`。**教训：抽函数类改动的护栏必须是「调用后真的分派了」，不能只断言函数存在。**

**回滚基线**：本轮改前的 v4.26 原样文件已按改动记录反向还原为
`cloud-relay/python/dashboard.html.bak-v4.26-pre-v4.27`（3210 行；已用「重新应用改动后与当前文件 MD5
逐字节一致」校验，并 `node --check` 通过）。另：`dashboard.html.bak-20260916-124630` 是 v4.24 的更早备份。

**版本**：`APP_VERSION` 4.26 → **4.27**（与面板注释里的 v4.27 对齐，避免再次出现「注释版本 ≠ 服务版本」）。

**未做（附理由）**：
- 通话页默认改「今天」——**不做**。查通话的高频诉求是「刚才那通」（往往不在今天），默认全量最新 50 条更顺手；报告还把「chips 无 active 态」当成理由，该前提不成立。
- 报告其余项：首页请求并行化（15s 轮询下感知差异极小）、趋势图服务端聚合、WS 推送、单文件拆分、别名加确认框、CSP/安全头 —— 均按自用场景**不做**。

**待用户确认**：源码目录里的 `dashboard.html.bak-20260916-124630`（v4.24 改版前的回滚点，已被 v4.25/4.26/4.27 超越）是否清理。

---

## 2026-09-16（功能：人员管理改为「固定人员名册」为准 · v4.26）

需求：「人员管理」要参考插件端「一键登记」用的那份人员来源；**这批人就是全部人员，不会有其他人**，
直接内置进云端代码。

**人员来源**：插件端「一键登记」弹窗的「接待顾问」下拉框，取自 CRM 顾问列表
（`https://guwen.zhudaicms.com/bserve/search`，`brand=1833`）。**该接口无需登录即可读取**，实测：
```bash
curl -s -X POST https://guwen.zhudaicms.com/bserve/search \
     -H 'Content-Type: application/x-www-form-urlencoded' -d 'keyword=&brand=1833'
# → {"code":1,"data":[{"id":"170745","name":"韩俊"}, ...]}  共 11 条
```

**改动**：

| 文件 | 改动 |
|---|---|
| `cloud_relay_v2.py` | 新增 `ADVISOR_ROSTER` 常量（11 条，含 CRM 工号 + 姓名，保留 CRM 原序）；`APP_VERSION` 4.23 → **4.26** |
| `cloud_relay_v2.py` | `/api/v1/pins` 改为**名册逐条展开 + 与已注册记录按姓名合并**：新增 `roster/roster_id/bound` 字段与 `roster_size/bound_count` 统计；名册外确实注册过的人（改名/试岗/姓名兜底成手机号）仍保留，避免数据凭空消失 |
| `dashboard.html` | 「人员管理」页加名册说明行（共 N 人 / 已绑定 / 未绑定）；行渲染分三态：已绑定（PIN + 分组可选）、名册未绑定（PIN 显示「未绑定」、分组显示「—」、姓名只读带「名册」标记）、名册外（姓名可手填） |
| `dashboard.html` | 上门登记的「按人员筛选」下拉**跳过无 PIN 的行**（否则与「不限（全部）」的 `value=""` 撞车） |

**⚠️ 设计取舍（用户已确认）**：名册里未绑定的人**无法设置分组** —— 分组存在 `advisor_names.group_id`，
主键是 PIN，而 CRM 名单只有 `id + 姓名`、没有手机号。该人员首次用插件登记后会自动绑定并可以分组。
两个汇总账号（补录上门账号 / 融鑫汇总账号）按用户要求**保留**在名册内。

**验证**：

| 项 | 结果 |
|---|---|
| `/health` | version = 4.26 |
| `/api/v1/pins`（空库） | 11 行、`bound_count=0`、全部「未绑定」✓ |
| 绑定路径 | 模拟插件上报 `pin=13800001111&name=韩俊` → 该行绑定成功（`roster=True, bound=True`）；名册外 `测试试岗` → 独立成行（`roster=False`）✓ |
| 真实浏览器（CDP） | 登录 → 人员管理：11 行、说明行正确、名册未绑定行分组列为「—」✓ |
| 回归 | 面板冒烟 40 项 / 静态体检（id 103、标签 0 问题、CSS 变量 0 未定义、内联事件 45）/ 登录探针 24 项 全绿 |
| 项目自带单测 | `test_cloud_relay_v2.py` 70 项，**69 通过**；唯一失败 `test_new_stat_cards_exist`（找 `id="stat-active-names"`）是**既存问题**——该元素在 v4.24 面板改版时被移除（用户 12:46 备份里还在），与本次改动无关 |

**已清理**：验证用的两条测试数据（`13800001111` / `13900002222`）已从本地 `.devdata/visits.db` 删除。

## 2026-09-16（修复：登录失败时的提示被 CSS 藏掉 → 表现为「点登录没反应」）

现象：用户在浏览器打开 http://127.0.0.1:35430/ ，点「登 录」**屏幕上毫无反馈**。

**根因**：登录门禁规则 `body.locked > *:not(.login-overlay) { visibility: hidden !important; }`
会把 body 的其它直接子元素一并隐藏，而**提示用的 `#toast-container` 正是 body 的直接子元素**。
于是账号密码错 / 网络错时，`doLogin()` 里 `toast('登录失败: …')` 生成的提示**存在但不可见**：

```
bodyClass:              locked
toastText:              "登录失败: 账号或密码错误"
toastVisibility:        hidden        ← 关键：提示其实生成了，只是看不见
```

> 另外 `#toast-container` 的 `z-index: 2000` 低于登录遮罩的 `9999`，即便不隐藏也会被盖住。

**修复**（`cloud-relay/python/dashboard.html`，v4.25.1）：

| # | 改动 | 说明 |
|---|---|---|
| 1 | `body.locked > *:not(.login-overlay):not(#toast-container)` | 门禁规则豁免 toast 容器 |
| 2 | `#toast-container { z-index: 10000 }` | 提到登录遮罩（9999）之上 |
| 3 | 新增 `loginErr(msg)`，`doLogin()` 失败/异常改走它 | 错误显示在**登录框内部**（与「请输入账号」同一个 `#login-err`，必然可见） |
| 4 | 两个输入框加 `oninput="loginErr('')"` | 重新输入时自动清掉上一次的错误 |
| 5 | `submitLogin()` 的两处校验也改走 `loginErr()` | 统一提示通道 |

**验证**（真实 Chrome CDP 驱动，四场景）：

| 场景 | 结果 |
|---|---|
| 正常环境 + 正确密码 | `locked` → 进入面板 ✓ |
| 正常环境 + 错误密码 | 登录框内红字「登录失败：账号或密码错误」（`computed visibility=visible`）✓ |
| 禁本地存储 + 正确密码 | 就地进入面板（v4.25 降级路径）✓ |
| 禁本地存储 + 错误密码 | 登录框内红字可见 ✓ |

回归：面板冒烟 40 项 / 登录探针 24 项 / 静态体检（id 102、标签 0 问题、CSS 变量 0 未定义、内联事件 45 个）全绿。

## 2026-09-16（修复：受限环境下「点登录没反应」）

现象：「打开 http://127.0.0.1:35430/，点击登录没反应」。

**根因**（用 Chrome CDP 直连真实浏览器，注入 `localStorage` 抛错复现确认）：
面板有 7 处裸调 `localStorage`。在内嵌预览面板 / 沙箱 iframe / 隐私模式下，
`localStorage` 一访问就抛 `SecurityError`，于是：

- 「登录门禁」IIFE 首行 `isLoggedIn()` 就抛错 → `body.locked` 与登录框 `show` 都没加上，
  页面既不锁定也不弹登录框；
- 点「登 录」时 `setSessionToken()` 抛错，异常被 `catch` 吞成**误导性的「登录失败: 网络错误」**，
  且登录框不关闭、页面不跳转 —— 用户看到的就是「怎么点都没反应」。

> 排查结论：前端逻辑、服务端接口（token 签发/校验/401）、真实浏览器登录全流程本身都是**正常**的，
> 只有存储受限这一条路径会坏。登录探针 24 项 + 面板冒烟 40 项在修复前就已全绿 ——
> 说明这两个用例集**覆盖不到**入口脚本块（`panel_smoke.js` 只执行 `blocks[0]`，登录逻辑在 `blocks[1]`）。

**修复**（`cloud-relay/python/dashboard.html`，v4.25）：

- 新增 `AD_STORE` 安全存储封装：先探测，可用走 `localStorage`，不可用**自动降级为内存存储**；
  7 处调用（主题 ×4、会话 ×3）全部改走它。
- `doLogin` 成功分支：持久存储可用才 `location.reload()`；降级时改调新增的 `enterPanel()`
  **就地进入面板** —— 否则 reload 会把内存里的 token 丢掉、又被弹回登录框。
- 错误提示区分「存储被禁用」与「真网络错误」，不再误导。
- 门禁 IIFE 整体加 `try/catch` 兜底：万一抛错也会把登录框放出来，不留「无门禁」的空白态。
- 登录框新增 `#login-store-hint`，受限环境自动显示「刷新后需重新登录，建议用独立窗口打开」。

**验证**（同一受限环境下前后对比）：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 未捕获异常 | 2 个 `SecurityError` | **0 个**（降为 console.warning） |
| 页面状态 | 无门禁、登录框 `display:none` | `locked` + 登录框 `display:flex` |
| 点「登 录」 | 登录框纹丝不动 | **关闭登录框、进入面板** |
| 提示语 | 「登录失败: 网络错误」 | 「当前环境禁止本地存储，已直接进入（刷新后需重新登录）」 |

回归：登录探针 24 项 + 面板冒烟 40 项全绿；正常环境（`localStorage` 可用）流程不变。

## 2026-09-16（新增本地开发运行器 dev.bat / devwatch.py）

背景：「本地电脑运行，有没有方便的命令，这样我修改后更方便检查修改」。

核心痛点：`dashboard.html` 由 `load_dashboard_html()` 在**模块导入时**读一次
（`HTML_CONTENT = load_dashboard_html()`，第 1358 行）——**改面板必须重启进程**，刷新浏览器无效。

- 新增 `cloud-relay/dev.bat`（纯 ASCII，负责建 venv + 装依赖）+ `cloud-relay/devwatch.py`
  （纯标准库，330 行，零侵入不碰业务代码）。用法：执行/双击 `dev.bat`，之后改任意
  `python/*.py` 或 `dashboard.html` 保存即自动重启；支持 `--port` / `--no-watch` /
  `--no-open` / `--db`。
- 开发态数据隔离到 `cloud-relay/.devdata/`（日志 + SQLite），子进程一律带 `-B` 不写
  `__pycache__` —— 实测源码目录零污染；`.gitignore` 补 `.venv/`、`.devdata/`、
  `*.db-wal`、`*.db-shm`。
- 开发态管理员固定 `admin` / `admin`，避开「未设 `AUTODIAL_ADMIN_PASS` 则随机生成且只打在日志里」的分支。
- 端口预检按 `0.0.0.0` 探测并识别占用者版本，避免 `main()` 弹 Windows 对话框阻塞。

### 实测踩到并已修复的两个坑

1. **端口预检用 `127.0.0.1` 会漏检**：Windows 下已有 socket 绑 `0.0.0.0:35430` 时，另一个
   socket 仍能成功绑到 `127.0.0.1:35430`（两个地址不被视为冲突）⇒ 表现为「预检通过、
   子进程一启动就崩」。已改为绑 `0.0.0.0`（Windows 另加 `SO_EXCLUSIVEADDRUSE`），
   并在 `main()` 绑 `127.0.0.1`（原实现）这一处留下同样的隐患备注。
2. **bat 文件里不能出现中文**：cmd.exe 解析含多字节字符的 bat 会错乱行边界，实测连锁出现
   `set` 被吞掉、`goto deps` 变成执行 `deps`、`%VENV_PY%` 未定义。`dev.bat` 已改为纯 ASCII，
   中文提示全部由 `devwatch.py` 输出（`chcp 65001` + `PYTHONUTF8=1`）。

**验证（全部实跑）**：改 `dashboard.html` → 自动重启且新内容生效（uptime 33 → 0）、
还原后 MD5 与线上一致（`5af0e4e4`）；对入口注入语法错误 → 不重启且旧服务继续运行
（uptime 30 → 38），还原后自动恢复（md5 `1bb90de0` 一致）；端口被占 → 预检拦截、
报出占用者版本、退出码 1。

文档：README「快速启动 → 云中继」与目录结构；技术文档新增 §2.13。

## 2026-09-16（云端部署刷新 · 双实例对齐 v4.23 + 面板换 v6.0 主题 + 数据清零）

背景：「之前在云端 1Panel 做过部署配置旧版，现在本地代码更新了」，要求刷新腾讯云
101.34.65.254 并把累积数据清干净。

**代码侧只差一个文件**：`cloud_relay_v2.py` 线上/本地 MD5 均为 `1bb90de0`（线上早已是 v4.23，
无需重传）；只有 `dashboard.html` 落后 —— 逐行 diff 确认 6 处改动**全部是 v6.0「色相 × 明暗」
主题重构**（9 套钉死明暗 → 16 色相 × 亮白/暗夜，与扩展端 `themes.js` 同源），无夹带。

- **主实例 35430**：`dashboard.html` 173261 B → **182871 B**（MD5 `5af0e4e4`），原子替换后
  `supervisorctl` 重启，`/health` = 4.23。
- **备用实例 35440（原落后 13 个版本）**：v4.10 → **v4.23**。新镜像
  `autodial-cloud-relay:v4.23`（158 MB），容器带 `--restart=always` 重建并 **healthy**；
  容器内 `/app/{cloud_relay_v2.py,dashboard.html}` 指纹与本地逐字节一致。
- **管理员账号不再靠"从日志里捞随机密码"**：supervisor conf 与容器 `-e` 双双注入
  `AUTODIAL_ADMIN_USER=18335162275` / `AUTODIAL_ADMIN_PASS=123456`。清库后
  `_seed_default_admin()` 按注入值重建。（🔴 改口令必须同步改这两处，否则下次重启随机化。）
- **数据清零**（用户明确要求不留备份）：主库 `visits` 2639 → 0、`phones` 102 → 0、
  `advisor_names` 20 → 0；备用库本就空壳。同步清掉 `__pycache__`、宿主
  `/home/ubuntu/autodial-cloud-relay/{stats.json,cloud-relay.log}`、supervisor 与
  `/var/log/autodial.log`。清后两库均 102400 B、仅 `admin_accounts` 1 行。

### ⚠️ 踩到并已定位的新坑：生产服务器出网受限

第一次 `docker build` 挂了（日志无输出、7 分钟无果），定位后确认**不是基础镜像的问题**：

| 目标 | 实测结果 |
|---|---|
| `registry-1.docker.io` 直连 | ❌ 超时 |
| `mirror.ccs.tencentyun.com`（daemon.json 已配） | ✅ HTTP 200，0.07 s |
| `pypi.org/simple/` | ❌ 失败 |
| `pypi.tuna.tsinghua.edu.cn/simple/` | ✅ 4.4 MB/s |

⇒ 构建失败卡在**容器内 `pip install`**。服务器改用
`/opt/autodial/docker-build/Dockerfile`（= 仓库 Dockerfile + 清华 pypi 源 + 用 python 写健康
检查替代 `apt-get install curl`，少一个 Debian 源依赖），**仓库那份 Dockerfile 在这台机器上
无法直接构建**，已在 README「已知部署坑」补第 3 条。

### 验证（全部实跑）

- 双实例 `/health` 均 `version=4.23`（本机 + 公网各测一遍）；面板 HTTP 200 / 182871 B
- v6.0 主题特征串（`AD_THEME_MODES`/`AD_SEMANTIC`/`tm-mode`）两实例各命中 11 处
- `POST /api/v1/login` 两实例均 `ok:true`；未授权 `/api/status` 均 **401**
- 两库逐表点数全 0（仅 `admin_accounts` 1 行）
- 运维脚本同步更新：`scripts/build-docker.sh`（新增）、`scripts/rebuild-docker.sh`（镜像 tag
  v2 → v4.23 + 补全 `TZ`/`AUTODIAL_DATA_DIR`/`AUTODIAL_ADMIN_*`），旧版留 `.bak-`
- 旧镜像 `:v1` / `:v2` 保留，可一键回滚；代码旧版留
  `*.bak-pre-v6.0theme_20260915`

## 2026-09-15（扩展 v6.3.4 · 成功挂断后按钮留在原位）

反馈：「希望成功挂断后按钮留在原位。」

- **删掉「成功挂断 2 秒后收起按钮」的旧行为**（v4.15 引入）。原先点击成功后按钮会
  `display:none`，要等 `updatePhone` 收到新号码才恢复 —— 用户看到的就是"按完按钮不见了"。
  现在按钮始终在位，由 `flashHangup` 自带的 2 秒复位把它带回空心常态，**不需要等新号码
  出现才能再按一次**。
- `updatePhone` 里那条"发现 `display:none` 就恢复"的逻辑**保留为兜底**（当前已无任何代码
  会隐藏它），注释已说明是历史状态自愈，不是主流程。
- 清理：`window.__ad_hangup_timer` 随之废弃，已无引用。

验证（全部实跑）：

- 主探针 `cs_probe.js` 新增**端到端点击断言**（第 8 节 ⑧）：把 `chrome.runtime.sendMessage`
  换成同步回调 `success`，再把点击期间排定的定时器**全部立刻执行**（等于快进 2 秒），
  断言按钮仍在原位 + 状态回 `idle` + 文案回「挂断」。**103 项全过**。
- A/B 反证增至 **7 例**：新增第 ⑦ 例把"2 秒收起按钮"注回去，探针立刻变红（捕获后完整还原）。
- 回归 433 项 + `cs_iframe_probe.js` 全绿；`manifest.json` 6.3.3 → **6.3.4**

## 2026-09-15（扩展 v6.3.3 · 挂断按钮改「空心」常态 + 点击 2 秒回常态）

反馈：「没点击的常态不应该实心，改成空心 + 主题色文字压卡片底。另外点下去后状态停留 2s
就可以返回常态了。」

- **常态由实心改空心**：底色 = 卡片底（`AD.adSolidHex(t.bg2, t.bg)`，毛玻璃档的半透明
  bg2 先合成为实色）、描边与文字 = 主题色。与拨号浮窗同色系，不再出现"两个色块分不清"。
- **「主题色」不能直接当文字**：亮白档卡片底接近纯白，而 16 套主题色里 10 套是中等明度
  —— 实测 `t.red` 与 `t.accent` 各 **16/32 组低于 AA 4.5:1**（最差 `t.accent` 2.30:1、
  `t.red` 3.06:1）。所以新增 `AD.adInk(color, cardBg, pageBg)`：**保留色相，只调明度**
  （按卡片底明暗决定加深 / 提亮），逐档混到刚好 ≥4.5:1。
  16 套 × 2 档实测 **4.50~15.88:1，32 组全部达标 AA**，观感仍是主题色。
- **点击反馈态不变**：仍是实心红 + 白字（沿用 v6.3.2 的 `AD.adDangerFill` 26% scrim），
  与空心常态一眼可分。
- **停留时长 1.8s → 2s，且成功 / 失败一律复位**（用户要求）。这**推翻了 v6.3.2 的
  "失败提示保留到下次操作"**策略 —— 若要恢复，改 `flashHangup` 一处即可（注释已标注）。
- **换肤不打断反馈**：新增 `AD.hangupState`（`idle` / `flash`）。`applyTheme` 只在非
  `flash` 时重绘，避免用户点完挂断正好切主题（或跨页同步换肤）时把那 2 秒反馈刷掉。
- **缩放手柄**：白三角（为压红底而设）改回主题色 —— 常态已是卡片底，白的反而看不见。
- **常态颜色只定义一处**：`cs-10-theme.js` 的 `applyTheme` 不再自己写一套颜色，改为转调
  `AD.resetHangupLabel()`，杜绝"创建处与 applyTheme 各写一套、改一处忘一处"。
- 更新配色对比页 `ui-demo-hangup-color.html`（v6.3.2 / v6.3.3 并排，颜色直接调用
  `cs-00-core.js` 的真实 `adSolidHex` / `adInk`，不在预览里另写一份等价算法）。

验证（全部实跑）：

- `node --check` ✅ ｜ 符号守恒 ✅ ｜ 跨模块断链 0 ✅
- 主探针 `cs_probe.js` **98 项全过**（第 8 节重写为「空心 / 闪示 / 定时器 / 状态机」四组）
- A/B 反证 **6 例全被捕获**：① 外层 span 写死红字 ② `adInk` 不调明度 ③ 常态底色改回实心红
  ④ 删掉 26% scrim ⑤ 复位延时改回 1800ms ⑥ `applyTheme` 无条件重绘（捕获后文件完整还原）
- 回归 433 项 + `cs_iframe_probe.js` 全绿；`manifest.json` 6.3.2 → **6.3.3**

> ✅ 当时遗留的「成功挂断后是否留在原位」已在 **v6.3.4** 按用户要求改为**留在原位**（不再 2 秒收起）。

## 2026-09-15（扩展 v6.3.2 · 挂断按钮配色修正：修掉"红字压红底"）

反馈：「挂断按钮的字是红色，浮窗也是红色，不太符合人因工程」。查证后确认是**真实缺陷**
（不是主观感受），外加一处配色取舍。

- **根因缺陷**：`cs-10-theme.js` 的 `applyTheme` 把 `t.red` 作为内联色写在挂断按钮的
  **外层包裹 span** 上。内联色优先级高于继承，于是 `flashHangup` 写在容器上的 `#FFFFFF`
  被悄悄覆盖 → 点挂断后呈现**红字压红色渐变底**，实测对比度 **1.19~1.25:1**，文字等于消失。
  16 套色相 × 2 档**全部如此**。
  修法：外层 span 不再写 color（历史遗留的内联色一并清掉），文字色只由容器决定。
- **常态配色**：卡片底 + 红字（3.06~6.79:1，亮白档普遍低于 AA 4.5）
  → **实心红底 + 白字**（手机通话界面"挂断"的通用样式）。
- **底色压深 26%**：主题红只保证"当文字"够清楚，拿来"当底"再压白字就不够
  （亮白 3.84:1、暗夜 3.46:1）。新增 `AD.adDangerFill()` 在主题红渐变上叠 26% 中性黑
  （scrim，材质设计的常规手法，不引入任何色相）。
  16 套 × 2 档实测 **4.90~9.56:1，全部达标 AA**。
- **失败提示不再自动消失**：旧版任何结果都 1.8 秒后复位。挂断失败意味着电话还通着，
  业务员错过提示会误以为已挂断 —— 改为保留到下次点击或号码变化（对齐浮窗 v4.15 的策略）。
- **缩放手柄**：红色三角压在红底上看不见 → 改白色系。
- 附配色对比页 `ui-demo-hangup-color.html`（改前/改后并排，数值取自主题权威 token）。

验证（全部实跑）：

- `node --check` × 14 ✅ ｜ 符号守恒 ✅ ｜ 跨模块断链 0 ✅
- 主探针新增 **15 项**挂断配色断言，含「两套色相 × 两档对比度 ≥4.4」
  「失败态不得排定复位定时器」「外层 span 不得持有内联色」
- A/B 反证 4 例全被捕获：① 外层 span 写死红字 ② 常态退回卡片底 + 红字
  ③ 失败态也自动复位 ④ 删掉 26% scrim（捕获后文件完整还原）
- 回归 433 项 + 切客户探针全绿；`manifest.json` 6.3.1 → **6.3.2**

## 2026-09-15（扩展 v6.3.1 · content-script 模块化拆分第五期：主文件改名收尾）

拆分收尾。`content-script.js` → **`cs-70-boot.js`**，至此 1879 行单文件 → 10 个模块，
拆分方案全部落地（主文件只剩 81 行启动编排）。

- `AutoDial-Extension/content-script.js` → `cs-70-boot.js`：**纯改名（`mv`），内容零改动**
  （改名后 md5 `b2fd02ff…` 与改名前一致），随后仅补一句头注释说明其来历
- `manifest.json`：`js` 顺序末位 `content-script.js` → `cs-70-boot.js`；version 6.3.0 → **6.3.1**
- 注释同步：`cs-20-widgets.js`（加载顺序行 + 对外出口行）、`cs-30-menu.js`、`cs-40-dialogs.js`；
  `cs-50-biz.js` / `cs-60-iframe.js` 原本就写的是 `cs-70-boot.js`，改名后自动对齐
- `cs_probe.js`：锚点注入改为同时认新旧两个文件名（`cs-70-boot.js` / `content-script.js`），
  这样它既能测项目现状，也能用 `EXT` 环境变量指向旧快照做 A/B
- 验证：10 个内容脚本 `node --check` ✅ · 符号守恒 ✅ · 断链 0 ✅ · 主探针（含阶段 4 专项 8 项）✅ ·
  切客户 A/B 探针 ✅ · 基础回归 433 项 ✅
- 附：全仓 `executeScript` / `getURL('*.js')` **零命中**，即没有任何"按文件名加载脚本"的运行时依赖
  → 改名不涉及行为变更。浏览器侧唯一影响：扩展重新加载后，已打开的 CRM 页面需刷新一次
- 文档同步：`技术文档/AutoDial技术文档.md`（文件树补齐 8 个模块 + 主题改 16 色相×2 档 + 3.3 节改为
  「cs-*.js 8 模块职责表」）、`技术文档/AutoDial-UI设计文档.md`（2.3 节标注组件现所属模块）、
  根 `README.md` 文件树、`测试与质量.md` 与 `未闭环问题清单-2026-09-12.md`（补 v6.3.1 说明，
  E-1~E-11 的旧行号改为「现所在模块」——旧单文件已不存在，原行号无法定位）

## 2026-09-15（扩展 v6.3.0 · content-script 模块化拆分第四期：业务层 + 子 iframe）

### 拆分（业务逻辑零改动）
- 🆕 `cs-50-biz.js`（156 行）：实时取号（`refreshActivePhone` / `broadcastToFrames`）、
  坐席号检测（`detectPin`）、DOM 就绪编排（`onDomReady`）、后台消息监听注册（`registerContentListeners`）
- 🆕 `cs-60-iframe.js`（278 行）：子 iframe 全段 —— 激活态判定（`isFrameActive` / `isFrameShown`）、
  详情页号码与姓名提取、5 秒心跳上报、切客户即时刷新轮询、DOM 变化触发扫描
- `content-script.js`：477 → **81 行**，只剩顶层启动编排
- `manifest.json`：`js` 顺序追加 `cs-50-biz.js → cs-60-iframe.js`（仍在 `content-script.js` 之前）

### 本次的关键设计点
- **cs-60 的顶层短路**：原主块末尾的 `return;` 是靠「顶层页面提前返回」才让 iframe 段只在子帧跑。
  拆成独立文件后，这段语义改由文件顶部 `if (AD.isTopFrame) return;` 承接 —— 若漏写，
  顶层页面会开始扫描并上报号码（最严重的串号事故）。
- **反向导出改为正向导出**：`refreshActivePhone` / `detectPin` 原先需要从主文件块内反向挂到 `AD`，
  现在直接由 cs-50 自己导出，主文件那两行随之删除。
- **清理 6 个已失效的本地别名**（`isOwnUiNode` / `adIcon` / `escHtml` / `applyMode` / `showToast` /
  `toggleManualDial`）：调用点已随模块搬走，别名不再被引用。

### 验证
- **逐行重构等价**：cs-50 三段（34+54+25 行）、cs-60 全段（232 行）、boot 尾段（35 行）
  与原文件比对**差异均为 0 行**（连续行块匹配，允许 ±2 缩进）
- **预期变更白名单主动验证**：6 个被删别名逐一确认「boot 中已无引用」、
  2 个反向导出逐一确认「cs-50 出口已存在」
- 符号守恒：37 函数 / 36 变量，缺失 0、重复 0（`verify_symbols.py` 升级为**动态扫描全部模块**）
- **静态链接检查**：46 个 `AD.*` 引用全部有对应赋值、无断链；10 个内容脚本模块守卫齐全
- **探针新增「阶段 4 专项」（8 项）**：cs-50 五个出口齐全、`registerContentListeners()` 真的注册了
  onMessage、派发 `dialResult` 消息 → 浮窗文案变「已拨出」、`refreshActivePhone` → 广播
  `__ad_ask_phone`、客户帧回话 → 号码即刻回填、cs-60 在顶层帧零监听器零上报
- **A/B 反证（判据 = 护栏整体由 PASS 翻转为 FAIL）**：
  - 删掉 cs-60 的顶层短路 → 探针报「加载 cs-60 后 message 监听器 0 → 2」
  - 注释掉 boot 的 `registerContentListeners()` → 探针报「onMessage 监听器没注册」
  - 删掉 cs-50 的 `AD.detectPin` 导出 → `verify_links` 报断链
- 全量回归 addr 56 / theme 101 / panel 173 / demo 103 + 两套探针（iframe 切客户 A/B 229ms / 184ms），全绿

### 过程中修正的两个自身缺陷
- **探针断言一度恒真**：原本只看 `phoneDetected` 上报，但探针 body 为空、扫不到号码，
  无论短路是否生效都不会上报 → A/B 抓不到 A1。已改为「加载 cs-60 前后 window 上 message
  监听器数量差分」，A1 随即被捕获。
- **`verify_symbols.py` 硬编码 3 个文件**：自阶段 2/3 起就在误报（把已迁走的符号报成「缺失」），
  本次改为按目录动态发现 `cs-*.js`。

## 2026-09-15（扩展 v6.2.0 · content-script 模块化拆分第三期：菜单层 + 弹窗层）

### 拆分（业务逻辑零改动）
- 🆕 `cs-30-menu.js`（368 行）：自定义右键菜单、菜单项文案刷新（`refreshContextMenuLabels`）、
  主题选择子菜单（`showThemeMenu`）
- 🆕 `cs-40-dialogs.js`（415 行）：设置弹窗（PIN + 云地址）、一键登记确认弹窗、
  区块/按钮辅助（`mkSection` / `mkBtn`）、`openDesktopApp` / `toggleFloatbar` / `sendSms`
- `content-script.js`：1207 → **477 行**，只剩「业务层（实时取号 + 检测 PIN + DOM 就绪编排）」+「子 iframe 号码扫描」
- `manifest.json`：`js` 顺序 = `themes.js → addr.js → cs-00-core.js → cs-10-theme.js → cs-20-widgets.js → cs-30-menu.js → cs-40-dialogs.js → content-script.js`

### 本次搬迁的跨模块引用处理
- **cs-30** 内改写 18 处为 `AD.` 前缀（`adIcon` / `escHtml` / `T` / `applyMode` / `applyTheme` /
  `toggleManualDial` / `flashFloat` / `refreshActivePhone` / `detectPin` / `sendSms` / `showRegisterConfirm`）
- **cs-30** 中 3 处「菜单项 action 指向 cs-40 函数」改为箭头函数转发（防御性写法，不依赖 items 的构造时机）
- **cs-40** 内改写 29 处（`adIcon` / `escHtml` / `T` / `showToast` / `flashFloat`）
- 主文件新增反向导出 `AD.detectPin`（cs-30 菜单账号行点击后需要），移除已迁走的 `AD.showContextMenu`

### 验证
- **逐行重构等价**：cs-30 正文 343 行、cs-40 正文 390 行、主文件 477 行，与原文件比对**差异均为 0 行**
- 符号守恒：全部符号零减少；`let AD.` 非法声明 0、`AD..` 双点 0
- **静态链接检查**：43 个 `AD.*` 引用全部有对应赋值，无断链；无可疑裸调用
- **探针新增「阶段 3 专项」（5 项）**：菜单渲染出 13 行、点菜单「设置」→ 设置弹窗建出、
  点「切换主题」→ 主题子菜单建出、一键登记弹窗建出、8 个跨模块动作符号齐全
- **A/B 验证**（证明护栏有效）：模拟「cs-40 漏导出 `showSettingsDialog`」→ 探针精确报出
  `TypeError: AD.showSettingsDialog is not a function @ cs-30-menu.js:110:51`，
  静态检查器同时报 `[FAIL] cs-30-menu.js 引用了未定义的 showSettingsDialog`
- 全量回归 addr 56 / theme 101 / panel 173 / demo 103 + 两套探针，全绿

## 2026-09-15（扩展 v6.1.1 · 修复：右键菜单与点击浮窗失效）

### 问题
v6.1.0 拆分第二期把挂件搬进 `cs-20-widgets.js` 时，浮窗「点击拨号」与「右键菜单」两个回调
调用了 `AD.showContextMenu` / `AD.refreshActivePhone` —— 加 `AD.` 前缀是对的，但主文件
**漏做了反向导出**，两个符号在 `window.__ADCS` 上始终是 `undefined`。

表现：右键浮窗/挂断按钮**没有菜单**，点击浮窗**没反应**（挂断按钮点击不受影响，因为它只调
`chrome.runtime.sendMessage`，不跨模块）。事件回调里的 `TypeError` 是静默的，控制台之外看不到。

### 修复
`content-script.js` 主块内补 2 行反向导出（函数声明在本块内提升，写在块首即可用）：
- `AD.showContextMenu = showContextMenu`
- `AD.refreshActivePhone = refreshActivePhone`

业务逻辑零改动，挂件代码零改动。

### 新增护栏（防止同类问题再发生）
1. **`verify_links.py`**：静态扫描「被引用但从未被赋值」的 `AD.*` 符号 + 裸函数调用检查。
   本 bug 在修复前被它精准报出（`cs-20-widgets.js 引用了未定义的 refreshActivePhone, showContextMenu`）。
2. **探针补事件派发能力**：`cs_probe.js` 的 DOM 桩原先 `addEventListener` 是**空实现**，
   事件回调从未被执行 —— 这正是本 bug 全绿漏网的原因。现已支持真实派发 `contextmenu` /
   `pointerdown` / `click`，并断言真实副作用（菜单元素是否建出、是否向客户帧发出取号请求）。
   修复前 3 项 FAIL（行号精确指向 `cs-20-widgets.js:117/130/207`），修复后 3 项 PASS。

### 验证
修复前 3 FAIL → 修复后全 PASS；全量回归 addr 56 / theme 101 / panel 173 / demo 103 +
两套探针全绿；静态链接检查 33 个导出符号无断链；全部内容脚本 `node --check` 通过。

## 2026-09-15（扩展 v6.1.0 · content-script 模块化拆分第一期+第二期 + 切客户号码即时刷新）

### 1. 模块化拆分（业务逻辑零改动）
把 1879 行的 `content-script.js` 按职责切成多个文件，靠 manifest 的 `content_scripts.js`
数组顺序加载（MV3 无打包工具，文件之间不能 `import`，共享符号统一挂 `window.__ADCS`）。

**第一期（core + theme）**
- 🆕 `cs-00-core.js`（126 行）：防重入守卫、`isTopFrame`、`isOwnUiNode`、
  `getMyPhoneAndNameFromCRM`、矢量图标表、HTML 转义
- 🆕 `cs-10-theme.js`（170 行）：主题表、`applyTheme` / `applyMode`、Toast、挂件句柄

**第二期（挂件层）**
- 🆕 `cs-20-widgets.js`（537 行）：浮动按钮、挂断按钮（含左下角拖拽缩放）、手动拨号条、
  号码刷新与状态反馈（`updatePhone` / `flashFloat` / `restoreFloatLabel`）
- 跨模块引用显式改写 21 处（`T` / `adIcon` / `escHtml` / `showContextMenu` / `refreshActivePhone` → 加 `AD.` 前缀）

**结果**
- `content-script.js`：1879 → **1201 行**，只剩「菜单 / 弹窗 / 业务」+「子 iframe 号码扫描」
- 两个拆分点各加「本地别名」若干行，使下方数十处调用点**一行未改**
- `manifest.json`：`js` 顺序 = `themes.js → addr.js → cs-00-core.js → cs-10-theme.js → cs-20-widgets.js → content-script.js`
  ⚠️ 新模块必须排在 `content-script.js` **之前**

**验证**（两期都跑了全套）
- **逐行重构等价**：cs-20 正文 505 行、主文件 1202 行，与原文件比对**差异均为 0 行**
  （即每行只发生了「去缩进 + `AD.` 前缀」或「删除 + 插入别名」这两种机械变换）
- 模板字符串内容比对：37 → 37 个，**多重集完全一致**（去缩进没有吃掉 HTML 模板里的空格）
- 符号守恒：5 个改写项总数**完全相等**（22 / 15 / 16 / 3 / 3）
- 探针：`cs_probe.js`（含新增「阶段 2 专项：真实副作用」6 项断言）+ `cs_iframe_probe.js` 全 PASS
- 回归：addr 56 / theme 101 / panel 173 / demo 103 = **433/433**

### 2. 修复：切换客户后，浮窗号码最多滞后 5 秒才更新
**症状**：在 CRM 里点另一位客户的标签页后，浮窗上显示的还是上一位客户的号码，
要等约 5 秒才换过来（旧版体感更快）。

**根因**（两条上报通路同时被堵死）：
1. 多客户场景下 CRM 是靠改**父文档里 `<iframe>` 的 `opacity` / `z-index`** 来切换显示的，
   被切出来的那一帧**自身文档没有任何 DOM 变化** → 它的 `MutationObserver` 不触发；
2. 该帧在「仍处于隐藏态」时完成加载/渲染的那一次 `scan()`，会被 `isFrameActive()`
   正当拦下（这是 v5.2 为防多客户串号加的守卫，不能放开）。

于是唯一还能上报的路径就只剩 5 秒心跳 —— 这正是「等 5 秒才换过来」的来源。

**修复**：补上缺失的「激活态跃迁」事件源。新增 `isFrameShown()`（`isFrameActive()` 的轻量版，
只读 `opacity` / `zIndex`，不读 `innerWidth/innerHeight`，因此不触发重排），
每 300ms 采样一次；仅在**隐藏 → 可见**的那一瞬间真正执行一次 `scan()`。
空闲时零上报、零网络消息。

- `AutoDial-Extension/content-script.js`（新增 `isFrameShown()` + 激活态监听，+46 行）
- 实测效果：切客户后 **约 180~230ms** 上报（原来最多 5000ms）
- 串号守卫未放宽：隐藏帧在任何情况下都不上报（探针有断言）
- `AutoDial-Extension/manifest.json`（6.0.1 → 6.1.0）

## 2026-09-15（扩展 v6.0.1 · 修复主题切换「看着没反应」：applyTheme 跨块作用域 ReferenceError）

### 症状（很容易误判成"主题没做对"）
在 CRM 页面上切主题时看起来没生效：
- 右键浮窗 → 点主题色块：**菜单不自动关闭**，浮窗 / 挂断按钮颜色当场不变，得刷新页面才生效
- 点「亮白 / 暗夜」明暗档按钮：同上
- 在扩展弹窗里换主题：已打开的 CRM 页面悬浮挂件**不跟随**
  —— 即 README 里写的"实时同步给已打开的 CRM 页面悬浮挂件"实际是失效的

### 根因：顶层函数引用了深处块级变量
`AutoDial-Extension/content-script.js` 中 `applyTheme()` / `applyMode()` 定义在 **IIFE 顶层作用域**，
但它们要操作的挂件句柄 `floatEl` / `currentPhone` / `hangupEl` / `hangupResizeHandle` /
`manualDialBar` / `hideContextMenu`，全部用 `let` / `function` 声明在下方 `if (isTopFrame) {` **块内部**。

JS 里 `let` 与**块内函数声明**都是块级作用域（该文件顶部是 `'use strict'`，不会走 Annex B 的
兼容提升），顶层函数根本看不到这些绑定 —— 于是 `applyTheme()` 一被调用就在第一行
`if (floatEl)` 抛 `ReferenceError: floatEl is not defined`。

因为抛错发生在函数中部，**调用点之后的语句被整体跳过**，一连串功能被静默废掉：
菜单 `remove()`、明暗档按钮的"就地重建"、`storage.onChanged` 的实时换肤。
popup / auth 侧不受影响（它们走 `themes.js` 的 `AD_APPLY_THEME`，那份实现是正确的）。

### 修复
把这 6 个绑定统一上提到 IIFE 顶层声明，块内只做赋值（`function hideContextMenu() {}` 改为
`hideContextMenu = function () {}` 形式，避免再次遮蔽回块内）。**`applyTheme` 的换肤逻辑本身一行未改。**
- `AutoDial-Extension/content-script.js`（+17 / -11）
- `AutoDial-Extension/manifest.json`（5.6.0 之后的补丁位：6.0.0 → 6.0.1）

### 验证：这次是**真跑起来**测的，不是静态推断
此前 4 个测试台对 `content-script.js` 只做**字符串断言**（`cs.indexOf(...) > 0`），
从未真实执行过它，所以 433 项全绿也没能发现这个 Bug。

本次新增 `cs_probe.js`：用 Node `vm` + 最小 DOM 桩**真实加载并执行** `content-script.js`，
再把块内的 `applyTheme/applyMode/hideContextMenu/createFloat` 导出到断言上下文。
- 修复前：`ReferenceError: floatEl is not defined @ content-script.js:144` → 2 项 FAIL
- 修复后：作用域 3 项 + 端到端 4 项全过
  - 端到端断言：`createFloat()` 后连续 `applyTheme(A)` → `applyTheme(B)`，
    断言浮窗 `style.background` 确实随之改变，且等于新主题的 `bg2`（证明用的是新 token）
  - `localStorage.__ad_theme` 落盘为新主题
- 回归：`addr_test` 56 · `theme_test` 101 · `panel_test` 173 · `demo_test` 103 · `cs_probe` 9
  = **442 / 442 通过，0 失败**

## 2026-09-14（扩展 v6.0.0 · 主题重构为「色相 × 亮暗」两个维度）

> 用户反馈：「主题感觉有的是暗的、有的是亮色系的，切换没有逻辑，不如搞 2 套，然后可以切换亮暗」。

### 根因：色相与明暗被压成了一维

| 端 | 色相套数 | 明暗档 |
|---|---|---|
| Android `ThemeManager.kt` | 16 | 7（dark/dusk/dawn/twilight/warm/mist/light）|
| PC-go / PC-Electron `theme-data.js` | 16 | 7 |
| **扩展 `themes.js`（改前）** | **9** | **1 —— 没有这个维度** |

其他三端都是「先选色相，再选明暗」两个正交维度，扩展端只有色相，而那 9 套各自的固定明暗是
散着定的：**只有天空蓝、森林绿是亮底，其余 7 套全暗**。在一排色块里点，等于在
「亮·暗·暗·暗·暗·暗·亮·暗·暗」里跳 —— 这就是"没有逻辑"的来源。

最扎眼的一处：**「极简白」的 `bg` 实际是 `#1A1A1A`（纯暗）**，名字叫白却是暗的。

### 新架构

- **色相 16 套 × 明暗 2 档（亮白 / 暗夜）= 32 种外观**，两个维度各自持久化：
  `__ad_theme`（色相）+ `__ad_theme_mode`（明暗），后者与其他端约定一致
- **配色数据不再手写**：新增转录脚本从 `pc-app-go/frontend/themes/theme-data.js`
  （16 套 × 7 档，唯一权威源）取 `light` / `dark` 两端档位，
  因此扩展端与手机端、PC 端在**同一色相、同一档位下颜色逐字节一致**
  （校验：天空蓝 light 的 10 个基础色与 v5.x 完全一致）
- 色相补齐到 16 套，与 Android / PC 完全对齐：新增毛玻璃、圆润糖果、暖光米色、
  蓝绿渐变、薄荷清新、珊瑚日落、薰衣草

### 兼容性（重点）

| 项 | 处理 |
|---|---|
| v5.x 的 9 套色相 | 一套没丢，顺序不变，天空蓝仍在首位 |
| 默认态视觉 | `sky-blue × light` 的 22 个派生 token 走原权威表，与手机端/云端逐字一致 |
| 其他端存的 7 档 | `AD_MODE_FROM_ANY` 自动折叠：`warm/mist/light → 亮`，其余 → `暗`；两端默认档都是 light，折叠后不变 |
| 旧值 `sky-blue-dark`（云端历史 id） | `AD_HAS_THEME` 判定失败自动回退 `sky-blue`，不报错 |
| 内容脚本 60+ 处 `t.accent` 消费点 | **一行未改** —— 新增 `AD_FLAT_ALL(mode)` 在切换时重建扁平缓存 |

### 新增：顶栏刷新按钮

顶栏右侧新增刷新按钮 `#refreshBtn`，一键重读存储并强制重查，覆盖**主题 + 连接状态 + 地址**。

**三个防坑设计**（也是"会不会引入新 bug"的答案）：

1. **只复用现成函数，不新增网络调用** —— `AD_APPLY_THEME(id, mode)` 是幂等的，
   `refreshConnectivity` 本就支持 `force` 参数绕探针缓存，因此刷新不碰网络候选池
   （那是「从网络获取」独立按钮的职责）
2. **一律重读 storage，不沿用内存里的 `currentTheme`** —— 否则在别的入口
   （右键菜单 / 云端 dashboard / 另一弹窗）改过主题后，点刷新反而刷不出来
3. **并发保护** —— 刷新期间 `refreshing` 置位并禁用按钮 + 图标转圈（`@keyframes adSpin`），
   连点只跑一次探针（回归测试断言「连点两次与单次请求数完全相同」）；
   未设 PIN 时按 `hero:false` 只刷设置页那一行，不白打业务查询

### UI 变化

- 弹窗「外观」卡片：色块由 9 个横排改为 **16 个 8 列 × 2 行网格**，右上角新增
  亮白 / 暗夜**分段开关**，下方显示当前组合「天空蓝 · 亮白」
- CRM 页面悬浮挂件的主题菜单：明暗开关 + **4 列色相网格**（v5.x 是 9 行竖排列表，
  16 套竖排会撑满整屏），并加 `max-height` 防溢出
- 云端 dashboard 顶栏菜单同步该形态，移除历史遗留的 `sky-blue-dark` 特例条目

### 顺带修复

- **毛玻璃主题会导致整片白屏**：`glassmorphism` 的 `bg2` / `bg3` 是 `rgba()` 半透明值，
  而颜色工具只做 `parseInt('#..', 16)` —— 一遇到 rgba 就得到 `NaN`，
  派生出的 `inputBg` / `border` / `heroBorder` 等 CSS 变量全部作废。
  现 `_adParse` 同时支持 `#RRGGBB` 与 `rgba()`，alpha 参与插值，输出保持半透明
- 演示页 `ui-demo-extension.html` 增加 `themes.js` 缺失时的兜底定义，
  避免单独拷走预览时整页脚本因 ReferenceError 中断

### 五端同步

`AutoDial-Extension/themes.js`（重写 637 行）· `popup.html` · `popup.js` ·
`content-script.js` · `auth.js` · `theme-init.js` · `manifest.json`（6.0.0）·
`cloud-relay/python/dashboard.html` · `ui-demo-extension.html`

### 验证

- `theme_test.js` **101/101** —— 含 ★32 组派生 token 无 NaN、★16 套明暗分档亮度合理、
  ★天空蓝 light 与 v5.x 逐字节一致、★7 档折叠正确、★32 种外观里恰好 16 种亮底
- `panel_test.js` **173/173** · `demo_test.js` **103/103** · `addr_test.js` **56/56** —— 合计 **433/433**

## 2026-09-14（扩展 v5.6.1 · 状态区改为「云端 / PC / 手机」三行独立状态）

> 用户反馈：「图上 PIN 已就绪我觉得不好，旁边总是红色，到底和云端连没连成功，
> 我无法第一眼获取信息」。排查后确认是**信息架构**问题，不是配色问题。

### 原来的三处错误

| # | 位置 | 问题 |
|---|---|---|
| 1 | `popup.js` 的 Hero 渲染 | 大圆点取 `pcConnected \|\| phoneConnected` —— **只看有没有设备在线，完全不看云端**。云端明明已连通，只要设备离线就显示红点 |
| 2 | `popup.html` 的 `#statusText` | 大标题「PIN 已就绪」是**写死的静态文案**，没有任何代码去改它 —— 云端断没断它都说"已就绪" |
| 3 | `popup.js` 的副标题 class | 离线时 class 不带 `ok`，用主题的 `--text-2` 着色（森林绿主题是 `#5E8A5E` 灰绿）—— 「PC离线」看着反而像"正常" |

三者叠加 → 红色来自"设备离线"（与云端无关），而"已就绪"永远不说真话，**两个信号互相掩盖**。

### 新方案：一个维度一行，各自着色

| 行 | 数据来源 | 取值 |
|---|---|---|
| 云端中继 | `AD_ADDR.probe()` 的 `/health` | 已连接 / 连接失败 |
| PC 客户端 | `/api/v1/status` 的 `pcConnected` | 在线 / 离线 / 未查询 / 未知 |
| 手机 | 同上，`phoneConnected` + `phoneCount` | 在线 N 台 / 离线 / 未查询 / 未知 |

**颜色语义（关键）**：

| 颜色 | 含义 | 出现场景 |
|---|---|---|
| 绿 | 正常 | 云端已连接 / 设备在线 |
| 灰 | **中性**，非故障 | 设备离线、云端不通时的"未查询" —— 手机没开机不该算错误 |
| 红 | 故障 | **只有云端真的连不上才出现** —— 红色重新成为强信号 |

- 大圆点与大标题改为**只反映云端连通性**：`云端未连接`（红）/ `云端已连接` / `服务正常`（绿）
- 新增 `.status-dot.unknown` 中性灰态，用于探测未出结果前（不动画，避免误报故障）
- 云端不通时 PC/手机显示「未查询」而非「离线」，不误导
- 副标题 `:empty` 时不占行（云端已连接时无需副标题，三行清单已说明一切）

### 顺带修正

- `content-script.js` 右键菜单的「PC 状态」行：原来**只在 PC 在线时才插入**，
  离线时整行不显示 → 改为在线/离线都显示（离线用中性灰，与 popup 语义一致）
- `ui-demo-extension.html` 同步（含 `renderConn` 与探测过程模拟）

### 验证

- `panel_test.js` **151/151** —— 含 ★云端通+设备离线时圆点必须为绿（回归本次核心 bug）、
  ★云端断时 PC/手机显示「未查询」、★标题不再出现写死的「PIN 已就绪」、
  ★离线行 CSS 不含红色
- `demo_test.js` **90/90**、`addr_test.js` **56/56**（合计 297）
- 静态：`node --check` 全过；`popup.html` div 39/39、demo 40/40

## 2026-09-14（扩展 v5.6.0 · 云中继地址逻辑重构：单一权威实现 + 测试/保存分离）

> 用户反馈：「关于服务器地址，获取和测试等的逻辑不太对，感觉用的云里雾里」。
> 排查后确认不是错觉 —— 同一个「当前生效地址」被**三套代码用三套规则**算出来。

### 修复的六处自相矛盾

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| 1 | 「测试」按钮顺带把地址写进 `storage` | `popup.js` 旧实现 | 只想测一下，地址已被改 |
| 2 | 挂件「测试连接」却不保存 | `content-script.js` | 同名按钮两种行为 |
| 3 | 挂件输入框只读 `cloud_api`，不读候选列表 | `content-script.js` | 看到的值 ≠ 实际生效的值 |
| 4 | 「一键获取」无条件 `set({cloud_api: servers[0]})` | `content-script.js` | 点一次就永久钉死在第 1 台机器 |
| 5 | 打开弹窗自动发两次请求（`/health` + `/api/v1/status`） | `popup.js` 旧实现 | 同一弹窗两处结论可能互相矛盾 |
| 6 | 失败一律提示「无法连接」 | 两处 `catch` | 分不清是地址错、端口不通还是服务不对 |

### 新增：`AutoDial-Extension/addr.js`（云中继地址唯一权威实现）

三端共用同一份（popup 用 `<script>`、挂件用 manifest `content_scripts.js`、
background 用 `importScripts`）：

- 常量：`AD_DEFAULT_PORT = 35430`、`AD_DEFAULT_ADDR` —— 端口默认值从 6 处收敛到 1 处
- 纯函数：`cleanAddr` / `fullUrl` / `parseLine` / `parseList` / `sourceLabel`
- 读写唯一入口：`readActive()` / `setManual()` / `applyAuto()` —— 取代原先的
  `storedAddr`（popup）、`fixUrl` + `getCloudApi`（background）、挂件里的内联判断
- 探针：`probe()` 返回结构化结果，`kind` ∈ `ok | invalid | timeout | refused | http | not-autodial`；
  `probeMessage()` 转人话；`statusOf()` 查业务态
- `fetchList()` 从 Gist/Gitee 拉候选（多源自动回落）

### 数据模型：引入「来源标记」

| 键 | 含义 |
|---|---|
| `cloud_api` | 唯一权威地址（纯 `host:port`） |
| `cloud_api_source`（**新增**） | `'manual'` / `'auto'` / `''` |
| `cloud_apis_fetched` | 候选池（附 `cloud_apis_fetched_at`） |

- **自动获取只刷新候选池，永不自动切换生效地址**（生效地址只由「保存」决定）
- 兼容老数据：有 `cloud_api` 但无 `cloud_api_source` 时按 `manual` 处理（最保守）

### UI 变更

- **弹窗**（`popup.html` / `popup.js`）
  - 「云中继地址」组拆成 **测试**（`btn-ghost`，只测不存、显示耗时与具体失败原因）+
    **保存**（`btn-primary`，唯一的写入动作）
  - 新增**来源徽标**（手动 / 自动 / 默认）
  - 新增**候选服务器下拉浮层**：输入框右侧 ▾ 展开（`position:absolute` 覆盖下方内容，
    **不撑高面板**），点某一项只填入输入框（需再点「保存」才生效），当前生效那台带「当前」标记；
    「从网络获取」并入浮层底部脚注，脚注同时显示候选个数与更新时间。
    云中继分组高度由约 **172px 降至约 70px**
    （初版曾把候选铺成 flex-wrap 的 pill 列表，5 个地址在 340px 弹窗里折成 3 行、
    单独吃掉约 100px，而 Chrome 扩展弹窗总高上限仅 600px）
  - 打开弹窗**只跑一次探针**（30 秒 TTL 缓存），状态页 Hero 与设置页状态行共用结果；
    探通才继续查 `/api/v1/status`
  - 状态页「云端地址」行改为 `地址 · 来源`
- **挂件**（`content-script.js`）
  - 输入框初值改为**真实生效地址**，并显示来源行
  - 「测试连接」改走 `AD_ADDR.probe`，失败按原因区分
  - 「一键获取」→「**获取候选**」：只刷新候选池、不再劫持 `cloud_api`
  - 副标题「默认端口 35430，可保留为空走直连」→「默认端口 35430 · 留空则用自动获取的地址」
    （原文案与实现不符：清空后 `getCloudApi()` 仍会回落到候选首位）
- **background**（`background.js`）
  - `getCloudApi()` 改用 `AD_ADDR.readActive()`
  - `fetchCloudList()` 改为只写候选池 + **10 分钟节流**（读取 `cloud_apis_fetched_at`，
    避免 SW 每次唤醒 / 每次 CRM 上报都打 Gist）
- `manifest.json`：`content_scripts.js` 加入 `addr.js`；版本 `5.5.2` → `5.6.0`

### 验证

- `addr_test.js` **56/56**（地址归一化 / 老数据兼容 / ★ `applyAuto` 不覆盖手动地址 /
  探针六种结果分类 / 多源回落 / `statusOf`）
- `panel_test.js` **118/118**（含 ★「测试」不写存储、★「保存」才写、★ 探针 30 秒内只跑一次、
  ★ 候选池刷新后生效地址不变、★ 浮层 ▾ 开合 / 点外部与 Esc 收起 / 选中候选即收起）
- `demo_test.js` **72/72**（`ui-demo-extension.html` 行为与真实 popup 一致）

## 2026-09-14（扩展 v5.5.2 · 「清除 PIN」改为「修改 PIN」+ 补上「返回」）

> 用户反馈两条：①「清除 PIN」应该改成「修改 PIN」，点进去不要把配对码清空；
> ② 进去之后**没有返回按钮，回不去**。

### Chrome 扩展

- **「清除 PIN」→「修改 PIN」**（`popup.html` / `popup.js`）
  - 按钮 `#clearPinBtn` 更名为 `#editPinBtn`，样式由 `btn-danger`（红色危险）改为 `btn-ghost`
    ——它已不是破坏性操作
  - **点击后不再清空配对码**：不再执行 `chrome.storage.local.remove(['pin','self_phone'])`，
    输入框保留当前值并自动聚焦 + 全选，直接输入即可覆盖，点「保存」生效
- **修复：进入设置页后无法返回**（根因：只有「修改服务器」这个 handler 会显示「返回」按钮，
  「清除 PIN」进来的路径从头到尾没有按钮可点）
  - 两个入口（`#editServerBtn` / `#editPinBtn`）进入设置页时**都会**显示 `#backToStatusBtn`
  - 点「返回」＝ 放弃本次修改：`pinInput` 的值还原为已保存的 PIN，再回到状态页
  - `showStatus()` 内统一隐藏「返回」按钮，避免状态残留
  - 未设置 PIN 时（首次打开弹窗）仍不显示「返回」——没有状态页可回
  - **「返回」按钮位置改到设置面板顶部**（原先在面板最底部、主题卡片之上）——返回类操作放底部不符合习惯
- **新增：点状态页「坐席手机号」行＝修改 PIN**（`popup.html` / `popup.js`）
  - `#myPhone` 由 `.value` 改为 `.value.link`（与同卡片「接待顾问」「云端地址」两行的可点样式一致），
    `showStatus()` 内挂 `onclick = () => $('editPinBtn').click()`
  - 三行现在都复用同一个 handler（`editServerBtn` / `editPinBtn` 的 `click()`），
    不再出现「某一条路径少改一段 DOM」这类问题
- 副作用说明：**清除 PIN 的能力随之移除**（「修改 PIN」保存时仍校验 4/11 位数字，不接受空值）
- 版本号 `5.5.1` → `5.5.2`

## 2026-09-14（扩展 v5.5.1 · 回退 v5.5 的面板状态机改写）

> 决策：v5.5 引入的「面板状态单一出口 `renderPanel(mode)`」改写体感不好，回退到 v5.4 及以前的
> 三 handler 写法。**与面板无关的两项 v5.5 改进保留**（配色走主题变量、弹窗主题切换卡片）。

### Chrome 扩展

- **回退：面板切换改回原写法**（`popup.js` / `popup.html`）
  - 删除 `renderPanel(mode)` / `SHOW_PIN_GROUP` 状态机与 `#pinGroup` 包裹层，恢复 `showSetup()` /
    `showStatus()` 两个函数 + `editServerBtn` / `clearPinBtn` / `backToStatusBtn` 三个 handler 各改一段 DOM
  - 「修改服务器」：进入设置页，隐藏配对码输入框/保存按钮/状态行，显示「返回」按钮（配对码标题保留，与原版一致）
  - 「清除 PIN」：恢复**一点即清**（去掉 3 秒二次确认），清空后进入完整设置页并聚焦配对码输入框
  - 「返回」：恢复配对码输入区显示并回到状态页
- **保留**：状态副标题配色走 `.hero-sub.ok` / `.hero-sub.err` + `--green-rgb` / `--red-rgb`（不再内联硬编码天空蓝值）
- **保留**：底部常驻「外观」主题切换卡片，以及 `content-script.js` 的挂件实时跟随主题
- **保留**：`#setupPanel` 初始 `display:none`（避免弹窗打开瞬间闪现设置页；不影响两个按钮的行为）
- 版本号 `5.5.0` → `5.5.1`

## 2026-09-13（扩展 v5.5.0 · 弹窗配色/按钮修复 + 主题切换入口 + 森林绿改浅色）

> 用户反馈两条：①「森林绿」主题太阴间、配色不对劲；②「清除 PIN」与「修改服务器」点完界面看起来一样。

### Chrome 扩展

- **修复：状态副标题颜色硬编码**（`popup.js`）—— `#cloudStatus` 的文字色原为内联写死的天空蓝值
  （`#40C057` / `#5880A8` / `#F03E3E`），换任何主题都不跟随。在深色/绿色主题下会出现"蓝灰配绿"的错色，
  这正是"配色不对劲"的直接来源。现改为走 CSS 类 `.hero-sub.ok` / `.hero-sub.err`（消费 `--green` / `--red`）。
- **修复：半透明同色也跟随主题** —— 状态点呼吸光晕与危险按钮底色原先硬编码 `rgba(64,192,87,…)` /
  `rgba(240,62,62,…)`。新增派生变量 `--green-rgb` / `--red-rgb`（`themes.js` 的 `AD_THEME_VARS`
  同时产出 `greenRgb` / `redRgb`）。
- **修复：「修改服务器」与「清除 PIN」界面看起来一样**（根因：面板显示状态被三个 handler 各改一半）
  - `setupPanel` 里「配对码」整组（含其上分割线）收进 `#pinGroup` —— 此前只隐藏输入框/按钮，
    会残留一个没有输入框的"配对码"空标题
  - 新增唯一出口 `renderPanel(mode)`：`status`（状态页）/ `setup`（完整设置，含配对码）/
    `server`（仅云中继与姓名，带返回按钮）。`clearPin` / `editServer` / `backToStatus` 三个入口全部改走它
  - 「仅服务器」模式下同时隐藏顶部 PIN 检测提示语（避免误导）
  - 「清除 PIN」加二次确认（3 秒内再点一次才生效，按钮文案变为"确认清除？"）——
    原先一点即清且清完没有返回按钮，等于把用户困在设置页
  - 清空后落点明确为「完整设置页 + 聚焦配对码输入框」
- **新增：弹窗内置主题切换**（`popup.html` / `popup.js`）—— 底部新增常驻「外观」卡片，
  9 套主题以色块横排展示，点击即时换肤并写入 `chrome.storage.local.__ad_theme`。
  此前只能进 CRM 页面、点悬浮条菜单才能换主题。
- **新增：悬浮挂件实时跟随主题**（`content-script.js`）—— 顶层帧新增 `chrome.storage.onChanged` 监听，
  在弹窗里换主题后，已打开的 CRM 页面悬浮挂件立即换色，不必刷新页面。
  （此前 `currentThemeId` 只在脚本注入时读一次 localStorage。）
- **重构：CSS 变量映射表收口** —— `themes.js` 新增 `AD_APPLY_THEME(id)`（唯一权威实现），
  `theme-init.js` 与 `auth.js` 原先各自抄了一份同样的 MAP，现均改为调用它。
- **森林绿主题改版：墨绿 → 森林晨雾（浅色）** —— 原配色 `bg #0E1810` 近乎纯黑，
  是九套主题里最压抑的一套，且文字/数值/图标全为同一族绿，观感发闷。
  现统一为 `accent #4CAF50 / bg #F0F8F0 / bg2 #FFFFFF / bg3 #E8F4E8 / text #1E3A1E /
  text2 #5E8A5E / green #2FA75F / red #E53935`。深色档在带多档明暗的客户端上仍保留可选。
- 版本号 `5.4.0` → `5.5.0`

### 其他客户端（保持多端主题一致）

- `android-app/.../ThemeManager.kt`：`forest-green` 的 `defaultMode` `dark` → `light`；亮白档 `green` `#00E676` → `#2FA75F`
- `pc-app-go/frontend/themes/theme-data.js`、`pc-app-Electron/themes/theme-data.js`：同上
- `cloud-relay/python/dashboard.html`：`AD_THEMES['forest-green']` 换为浅色（需重新部署 dashboard 才生效）

## 2026-09-13（扩展 v5.4.0 · 移除「同步登记列表」功能，云端接口保留）

> 决策：插件端不再承担"抓取 CRM 来访列表页 → 批量补录历史数据到云端"的职责，该功能整体移除。
> 云端接口全部保留不变，手机端同步与 dashboard 登记列表照常工作。

### Chrome 扩展

- **移除 popup「同步登记列表」按钮**：`popup.html` 的 `#syncBtn` 与 `popup.js` 中 `triggerSync` 发送方一并删除
- **移除 3 个右键菜单项**（`background.js`）：🔁 一键同步上门数据（CRM 页面）/ 同步登记列表（当前页）/ 🔁 一键同步上门数据（扩展图标），以及 `VISIT_LIST_URL` 常量与 `contextMenus.onClicked` 分发
  - 保留一次 `chrome.contextMenus.removeAll()`，用于清掉旧版本遗留在浏览器中的菜单项
- **移除 content-script 抓取链路**：`handleSyncVisitList()`（分页抓取 `form[name="fdsf"] ~ table tr` + 逐页 `fetch` + 汇总）、顶层与 iframe 两处 `syncVisitList` 消息监听、仅供其使用的 `iframeToast()`
- **移除 background 批量上报处理器**：`batchSyncVisits`（逐条 `GET /api/v1/visit?...&source=crm_sync`）与 `triggerSync`
- **不受影响**：`registerVisit()`「一键登记」（当前客户登记 → 提交 CRM + 写入云端）保持原样；`showToast()` 保留（一键登记在用）
- 版本号 `5.3.0` → `5.4.0`

### 云端

- **未改动**。`/api/v1/visit`、`/api/v1/visits`、`/api/v1/visits/batch`、`visit_record` 推送等接口与鉴权逻辑全部保留。

## 2026-09-13（扩展 v5.3.0 · 拨号/右键时实时读取"当前激活客户帧"号码）

> 背景：v5.2.0 用 `isFrameActive()` 挡住了隐藏的旧客户帧，串号问题解决，但号码刷新仍依赖子 iframe **每 5 秒心跳**——切客户后若立即点击，浮窗最多滞后 5 秒，可能拨到上一位客户。
> 处理：把号码获取从"被动等心跳"改成"动作驱动的即时查询"。

### Chrome 扩展

- **[P1] 浮窗/拨打按钮左击：拨号前先取实时号码**：点击瞬间向所有子帧广播一次询问，只有 `isFrameActive()` 为真的帧（= 眼前这个客户）应答，拿到最新号码再拨，**彻底消除 5 秒滞后**，拿不到才提示"未检测到号码"
- **[P1] 浮动条右键：弹出右键菜单时同步刷新**：`showContextMenu()` 内触发一次实时查询，菜单**先弹出不阻塞手感**，号码回来后**就地更新**菜单里的"拨打 / 发短信 / 一键登记"三项文案
  - 拨号浮窗与挂断浮窗的右键都走同一个 `showContextMenu()`，因此两个入口一并生效
- **实现**：顶层新增 `refreshActivePhone(cb)` + `broadcastToFrames()`，沿用既有 子→父 `postMessage` 通道，新增 父→子 请求 `__ad_ask_phone` / 子→父 应答 `__ad_phone_reply`
  - **隐藏帧不应答**：子帧收到询问后先过 `isFrameActive()` 守卫，与 `scan()` 同一道判断，旧客户帧彻底闭嘴
  - **多层 iframe 兼容**：`__ad_ask_phone` 逐层向下转发，`__ad_phone_reply` 逐层向上冒泡
  - **超时兜底（300ms）**：无任何帧应答（如插件刚更新、旧帧未加载新代码）时沿用现有 `currentPhone`，退回旧行为，不会更糟
- 版本号 `5.2.0` → `5.3.0`

## 2026-09-13（扩展 v5.2.0 · 修复多客户标签下号码/姓名来回串）

> 现象：同时打开多个客户时，浮窗号码与姓名在多个客户之间来回跳——当前客户是贾康康（15268581961），浮窗却停在上一客户杨文安（18757152162），"一键登记"也成了杨文安。老版 v4.2.0 无此问题。
> 核实方式：登录真实 CRM（`guwen.zhudaicms.com`，即"融鑫汇-客户管理系统"），实际打开 2 个客户后用 CDP 读取每个 iframe 的可见性属性（见下"验证"）。

### Chrome 扩展

- **[P0] 多客户 iframe 同时上报，浮窗号码来回跳**：该 CRM 为每个打开的客户保留一个 iframe，切走的客户 iframe 只被设为 `opacity:0 / z-index:-999` 叠在下方，**display、visibility、innerWidth、document.visibilityState 全都不变**，其 DOM 依旧完全可读。而 v4.15 为子 iframe 引入的 `setInterval(scan, 5000)` 心跳会让**每个已打开客户**都持续上报自己那份「手机号码：」→ background 收到任意帧就 `updatePhone` 广播整个 tab → 浮窗在两个号码之间来回跳。姓名同理：旧 iframe 仍在 `postMessage({type:'nameDetected'})`，把顶层 `__adCustomerName` 覆盖回旧客户
  - 新增 `isFrameActive()`：同源时用 `window.frameElement` 取到父文档中承载自己的 `<iframe>`，逐层向上检查 `display:none` / `visibility:hidden` / `opacity:0` / `z-index<0`；顶层（无 frameElement）恒为激活；跨域取不到时保守放行
  - `scan()` 开头 `if (!isFrameActive()) return;`——**隐藏帧不上报号码、不上报 null、也不发姓名**
  - 保留心跳：切回某客户时若 DOM 恰好没变动，仍需靠心跳重新 hook 拨打链接并上报
- 版本号 `5.1.0` → `5.2.0`

### 验证

- `node --check`：`content-script.js` 通过
- 真实 CRM 实测（CDP，打开"刘洪江"（100631867）+ "尹华"（99590275）两个客户）：
  - iframe 列表：`我的客户`(opacity 0) / `刘洪江`(opacity 0, 15158106834) / `尹华`(opacity 1, 17816152885)
  - 旧客户 iframe 虽被隐藏，仍能读到 `手机号码：15158106834` —— 证实心跳会把旧号码一起上报
  - `isFrameActive()` 判定：我的客户 `false`、刘洪江 `false`、尹华 `true`、顶层 `true` ✅
  - 隐藏信号实测：`opacity:0` + `z-index:-999`（`display` / `visibility` 均为正常值，故不能用它们判断）

## 2026-09-13（扩展 v5.1.0 · 修复"插件端识别不到坐席手机号" + PIN 注册时机）

> 现象：新版扩展在 CRM 上识别不到坐席手机号（拨号/登记时报"未检测到坐席手机号"），换回 `autodial-old0520` 的 v4.2.0 即恢复正常。
> 核实方式：登录真实 CRM（`guwen.zhudaicms.com`）核对 DOM，并用 CDP 把扩展脚本注入已登录页面做行为实测（见下"验证"）。

### Chrome 扩展

- **[P0] `getPin()` 的 `self_phone_precise` 门禁误伤正常路径**：v5.0.0 为修 P1「误判号码可能成为生效 PIN」，给 `getPin()` 加了 `if (stored.self_phone && stored.self_phone_precise !== false)`，而 `precise` 仅在 CSS 选择器 `.user-phone` 命中时才为 `true`。另一套 CRM（融鑫汇）的手机号是裸 StaticText、**没有 `.user-phone`**，永远走 TreeWalker 兜底 → `precise` 恒为 `false` → `getPin()` 直接返回 `null`，即使 `self_phone` 里的号码完全正确也拿不到 PIN → 拨号/一键登记全部失败
  - 改为 `pin || self_phone` 无条件兜底，并把"能不能注册 PIN"的判据从**选择器命中**换成**识别时机**（见下条）
- **[P0] 那条 P1 的真实机理是"UI 自污染"，现已从根上封死**：`detectPin()` 的 TreeWalker 扫的是顶层 `document.body`，而本插件的浮窗号码标签 `#__ad_dial_label` 展示的正是**客户号码**（来自 iframe 的 `phoneDetected` → `updatePhone()`），登记弹窗 `autodial-register-overlay` 里还有"客户手机号：xxx"——二者都 append 在同一个 body 里。于是"我们自己写进去的客户号码"会被 TreeWalker 当成坐席号读回来。实测对照：把客户号码放进普通 `div` 会被识别（`phone:15158106834`），放进带插件前缀的挂件则不会
  - 新增 `isOwnUiNode()`：TreeWalker 的 `acceptNode` 跳过落在 `[id^="__ad_"]` / `[id^="autodial-"]` 子树内的文本节点；CSS 选择器路径同样校验
- **[P1] PIN 注册时机收紧为"CRM 刷新后的首次识别"**：原实现由 `MutationObserver({childList,subtree})` 持续触发 `detectPin()`，使用过程中任何一次识别变化都可能改写 `self_phone` 甚至 PIN
  - `detectPin()` 新增 `_pinRegistered`：**只有本次页面加载（= CRM 刷新）的首次命中**才写 `self_phone` 并上报 `initial: true`；之后的变化只打日志
  - `selfPhoneDetected` 按 `initial` 分流：非刷新期识别一律跳过，不动 PIN；`maybeSwitchPin()` 只在 `initial` 时被调用，并去掉其 `precise` 依赖（否则融鑫汇那套永远切不了 PIN）
  - 语义即：**刷新注册一次 / 面板手动改一次，其余时候沿用上次的 PIN**；换人场景由"新坐席登录 CRM 后刷新"覆盖
- 版本号 `5.0.0` → `5.1.0`

### 验证

- `node --check`：`content-script.js` / `background.js` 通过
- 真实 CRM 实测（CDP 注入 + `chrome.*` 桩件，抓取脚本实际发出的消息）：
  - 顶层 frame：`{type:'selfPhoneDetected', phone:'15397033187', name:'左廷军', precise:true, initial:true}` ✅ `.user-phone` 服务端渲染，选择器路径正常
  - 客户详情 iframe：`{type:'phoneDetected', phone:'15158106834'}` ✅ 并成功拦截"点击拨打"链接
  - 用例 A（去掉 `.user-phone` 的 class，模拟融鑫汇裸文本）：`{phone:'15397033187', precise:false, initial:true}` ✅ **改前必挂的场景现已识别**
  - 用例 B（无坐席号 + 客户号放进插件挂件）：无任何检测消息 ✅ 自污染已封闭
  - 用例 C（对照：客户号放进普通 `div`）：`{phone:'15158106834', initial:true}` ✅ 证明 B 非侥幸
- `chrome --pack-extension` 对新旧 manifest 均打包成功（配置合法）

## 2026-09-12（文档治理 · 报告类文档整合清理）

> v4.23 全部批次完成后，按"没改的列出来、改过的删掉或整合"原则对报告类文档做最终清理。依据：《未闭环问题清单》已把 13 份报告的每一条问题逐条回源码核实并附闭环状态总表（43 闭环 / 24 维持不修及理由）。

- **删除 15 份报告类文档**：`docs/archive/` 全部 11 份 + 根目录《综合复核报告-2026-09-11》《验证报告-v4.21综合复核修复-2026-09-11》《场景化复核报告-2026-09-12》《场景化复核报告-人话版-2026-09-12》——所有条目已完成核实、修复或拍板不修，需要原文可从 git 历史（`4a8e941` 之前）恢复
- **整合进《技术文档》**：使用场景约束（20 人内部 / 手机流量拨号→云端必须公网可达且安全靠代码 / PC 文件夹版 / 机型不统一 / 双实例独立 DB）+ v4.23 后续批次叙事 + 云中继版本现状改为 `APP_VERSION` 4.23
- **更新导航与引用**：《技术文档/README》根目录文档表与版本号表现状刷新、注明已删报告及恢复方式；根 `README.md` 与《测试与质量》中 3 处对已删《Bug检查报告-2026-08-21》的引用改为就地表述；审计结论 PY-P0-2 已在引用处就地保留
- **保留的真源**：《未闭环问题清单-2026-09-12.md》（唯一问题追踪）、《部署核对单-v4.23.md》（上线运维）、`CHANGELOG.md`、`README.md`、`测试与质量.md`、`技术文档/` 4 份
- 抽查验证：Android 14 `FOREGROUND_SERVICE_SPECIAL_USE` 权限（清单已声明）、面板 toast XSS（`esc(msg)` 已转义）、Go 端 `go build` 不可用（废弃决策在案）——均属实且已有去向

## 2026-09-12（第四批 · 场景化复核修复 v4.23）

> 依据《场景化复核报告-2026-09-12.md》按「内部 20 人 + 手机流量可用 + 机型不统一 + 文件夹版 PC」的真实使用场景重新定级后，修复 P0/P1 中确认的体验与安全条目。PC Go 端确认为废弃实验版（`go build` 不可用），其 9 条全部不修；Electron「便携版自启失效」经确认为误报（文件夹版 `getPath('exe')` 行为正确），不修。
> 验证情况：云端 `py_compile` + 本地隔离实例 8+4 项接口实测（含越权 401、正常同步 200、幂等不重复）；PC Electron `node --check` + settings 原子写行为测试；扩展/面板 JS `node --check`；Android 侧随本次提交推送 GitHub Actions 编译验证（`.github/workflows/android-build.yml`，push 自动触发）。

### 云中继 `cloud_relay_v2.py`（安全，按场景定为必修）

- **[P0] 越权读整组客户数据**：`GET /api/v1/visits?pin=随便填&group=1` 无需管理员令牌即可读出整个分组的客户姓名/手机号/来访事由。根因：鉴权只在 `pin` 为空时校验，而分组分支优先级更高。现按分组或无筛选访问一律要求管理员令牌；单 PIN 精确查询（手机端同步路径）保持免鉴权
- **[P0] 上报接口无鉴权**：`/api/v1/calls/batch`、`/api/v1/events/log` 任意伪造 `device_id` 即可写入/伪造数据。现要求设备已注册（phones 表存在）且 `pin` 与该设备登记的 `last_pin` 一致，否则 403
- **[P1] 上报通道支持 POST body**：`calls/batch`、`events/log` 同时接受 JSON body（`{device_id, pin, data|event_type, detail}`），GET query 通道保留向后兼容；新版 App 优先 POST，PIN 与记录不再出现在 URL
- **[P1] 关闭登录/登出的 GET query 通道**：`/api/v1/login` 仅接受 POST body（口令不进网址/访问日志）；`/api/v1/logout` 令牌从 Authorization 头读取
- **[P1] 压测脚本防误伤生产**：`test_stress_live.py` 不再硬编码生产地址；新增 `--host/--port/--dry-run/preflight`，默认拒绝公网地址（仅允许私网/localhost），preflight 缺 `--host` 直接退出

### PC Electron

- **[P0] 短信失败/超时窗口永久卡死**：手机 ACK 超时/发送失败不回 `sms-result`，短信窗口停在"等待手机确认" → 失败与超时都会给窗口回执
- **[P0] 配置静默损坏即全丢**：`settings.json` 一旦写入中断/损坏，加载失败回退默认并立即写回，用户配置无痕清空 → 读写改原子写（tmp + rename）；加载失败自动备份现场为 `settings.json.corrupt-*`，且不再用默认值覆盖原文件
- **[P0] 云端重连 30 次后彻底放弃**：夜间网络抖动，白天回来不自愈 → 30 次快速重试后转入 5 分钟一次的低频重试，连上即恢复
- **[P1] `removeDevice` 无连接归属校验**：旧连接的 close 事件能把刚重连的新设备状态清掉（"显示在线却拨不出去"）→ 只有当注册表里的连接就是触发者本人时才清理；stale 设备清理同步收紧
- **[P1] LAN 重连覆盖 `isCloud` 标志**：云端模式手机走 LAN hello 重连会被登记成局域网设备，后续按局域网发消息发不出去 → LAN 重连保留原有 `isCloud` 状态
- **[P2] "关闭即退出"残留进程**：主窗口走 exit 分支时悬浮条窗口未销毁 → 退出前统一关闭
- **[P2] 每次拨号无条件覆写剪贴板**：现在号码已在剪贴板（内容相同）时不重复写，尊重用户复制内容

### Android

- **[P0] 进程被杀后不自愈**（A-14）：`START_STICKY` 在国产 ROM 杀后台后可能迟迟不重启 → 新增 `KeepAliveReceiver`：15 分钟周期自查（`setExactAndAllowWhileIdle`），服务不在且用户未手动断开时 `startForegroundService` 复活；系统拦截后台启动时退化为原行为，无副作用
- **[P0] `simHandleCache` 永不失效**（A-5）：换卡/热插拔后一直拿旧卡 handle，拨错卡 → 缓存绑定 subscriptionId，subId 变化自动失效重建
- **[P0] 自动选卡只认小米**（A-11）：机型不统一 → 预布防扩展到全部厂商；非小米启用严格模式（仅响应"新窗口弹出"事件），避免在通话界面上误点；小米保持原行为
- **[P1] 手动断开形同虚设**（A-7）：`MainActivity.onCreate` 无条件清 `manual_disconnect`，Activity 重建即悄悄恢复自动重连 → 清零只保留在连接/重连按钮两处显式动作
- **[P1] 通话记录/拨号盘绕过主拨号链路**（A-6）：拨号盘与通话详情"立即拨号"裸走 `ACTION_CALL`——不走选卡弹层、不写本地记录、不给 PC 回执 → 新增 DialService `"DIAL"` action，统一走 `DialEngine.dialNumber`
- **[P1] `onCreate` 异常恢复路径漏 `startDataSync`**（A-4）：补上；`startDataSync` 加幂等保护防重复调度
- **[P1] READ_CALL_LOG 被拒无感知**（A-2）：统计页顶部新增"去授权"横幅（点击发起授权，成功自动消失并刷新）
- **[P1] 云端空响应清空本地上门记录**（A-8）：同步返回空数组不再覆写本地，提示"本地记录已保留"
- **[P2] 通话记录上报改 POST**：配合云端新增的 POST 通道，PIN 与记录不再进 URL；旧版云端自动回退 GET，两种部署顺序都兼容

### Chrome 扩展

- **[P0] "点击拨打"闭包固化旧号码**（E-1）：SPA 复用 `<a>` 节点时闭包里是首次拦截的旧号码，换客户后拨错人 → 点击时从 href/文本实时读取号码，闭包值仅作兜底
- **[P1] 浮窗连点双拨**（E-4）：2 秒窗口去重
- **[P1] 两处 fetch 无超时**（E-3）：「测试连接」加 8 秒超时（地址填错不再永久停在"测试中"）；`uploadAdvisorName` 改用已有 `fetchWithTimeout`

### 管理面板 `dashboard.html`

- **[P1] `recent-clients` 的 PIN/IP 未转义**（M-1）→ 补 `esc()`
- **[P2] 通话记录设备筛选只在启动时加载一次**（M-9）：新登记的手机要重启面板才出现在筛选里 → 每次切到通话记录页刷新选项，且保留用户已选中的筛选值

### 第二批 P2 顺手修（同日追加）

- **[P2] 云端 `shutdown()` 协程内 `sys.exit(0)`**（Y-10）：托盘路径下事件循环跑在子线程，`SystemExit` 只杀线程——托盘图标残留成僵尸进程、服务已死 → 清理（落盘+停服）完成后改 `os._exit(0)` 结束整个进程
- **[P2] 云端 `configure_firewall()` 无平台判断**（Y-14）：Linux/Docker 每次启动白跑两趟 `netsh` 并刷 error 日志 → 非 Windows 直接跳过
- **[P2] PC 无单实例锁**（P-3）：双开后第二个实例抢同一 LAN/发现端口，手机连到谁全凭运气 → `requestSingleInstanceLock`，二次启动拉起已有实例主窗口
- **[P2] 面板弹窗不支持 Esc 关闭**（M-6）→ Esc 按确认 > 导入 > 编辑的优先级关最上层弹窗；确认弹窗走取消回调，Promise 正常 resolve(false)
- **[P2] 扩展离线队列读改写竞态**（E-9）：flush 一次跑数秒，期间 `queueCloudVisit` 的写入会被 flush 结尾的 `set(remain)` 覆盖，补推期间新登记的记录直接丢失 → promise 链把队列读写串行化

### 第三批 P2 顺手修（同日追加）

- **[P2] 安卓同号防双拨兜底**（A-10）：messageId 去重依赖 PC 每次带 id，浮窗连点/插件重试可产生两个不同 id 的同号请求 → 真拨两次。现 4 秒窗口内同号请求直接忽略
- **[P2] 安卓拨号路径主线程查通话记录**（A-13）：`notifyLastCallHint` 的 ContentResolver 查询从 `onStartCommand("DIAL")` 进来时在主线程 → 挪到专用单线程池，结果广播延后几百毫秒无感知
- **[P2] PC `get-info` 补齐 `connected`/`firewall` 字段**（P-1）：渲染端首屏一直在读这两个字段做状态展示与防火墙提示，主进程从未返回——纯死代码。`firewall.hasFirewallWarning()` 早已实现只是没人接
- **[P2] PC 日志明文打印配对码**（P-10）：配对码即客服本人手机号，`set-pin` 与启动横幅改脱敏（`138****1234`）
- **[P2] 面板 `phoneHistoryCache` 永不过期**（M-3）：设备历史刚被顶号/换 PIN 后展开行一直显示陈旧数据 → 60 秒 TTL
- **[P2] 面板搜索防抖定时器跨页存活**（M-4）：切页后仍触发旧页搜索请求 → 切页时统一清理
- **[P2] 云端日志/stats.json 在 Docker 重建即丢**（Y-11）：路径固定 `APPDATA or ~`（容器内）→ 新增 `AUTODIAL_DATA_DIR` 环境变量，docker-compose 已指向挂载卷 `/app/data`

### 第四批 P2 顺手修（同日追加）

- **[P2] 云端来访去重 check-then-insert 竞态**（Y-4）：`/api/v1/visit` 判重是"SELECT 后再 INSERT"两步，DB 线程池 8 线程可并发进入——同一客户并发登记可能各插一条（同号 2 小时窗口路径无唯一索引兜底）→ 进程内 `threading.Lock` 把判重+写入原子化（双实例各自独立 DB，跨进程竞态不存在；登记频率极低，串行化无感知）。已实测：10 个并发同号请求 → 恰好 1 条入库 + 9 条 skipped + 0 错误
- **[P2] 云端 `/api/status` 协程内同步查库**（Y-12）：今日拨号/登记数与 advisor_names 补全两段 DB 查询直接跑在事件循环里，DB 卡顿会拖住全部连接 → 合并为一个同步函数经 `_run_db` 卸载到线程池（与来访上报同等待遇），逻辑与响应结构不变
- **[P2] 安卓电池优化引导每次启动都弹**（A-9）：用户点"稍后"后依旧每次启动骚扰 → 7 天冷却（弹出即记录时间），「其他设置」里的电池优化入口始终可手动设置
- **[P2] 面板 `.td-muted` 11px 过小**（M-7）：次要信息字号提到 12px，改善可读性
- **[P2] 服务版本三处打架**（M-8 子项）：面板"系统信息"写死"6.0 (Sky Design System)"、接口硬编码 `'4.10'`，排查问题时易误判线上版本 → 新增 `APP_VERSION` 单一来源（当前 4.23），`/health`、`/api/status` 引用；面板改从状态接口动态显示真实服务版本
- **[P2] 安卓同步失败不显示原因**（A-9 剩余子项）：统一提示"请检查云端连接"，超时/口令错误/地址填错分不清 → toast 带上异常摘要（截断 60 字符）

### 文档与残留收尾（同日追加）

- **[P2] 面板登出仍把 token 拼 URL**（M-2）：服务端 Y-7 修复时注释声称"面板已改为请求头方式"，实际面板从没改过——又一条"声称已改" → `doLogout()` 改走 `Authorization: Bearer` 头，与配套
- **[P2] 扩展拨号结果只广播到顶层帧**（E-5）：`notifyTab` 与 `phoneDetected` 转发两处限定 `frameId: 0`，iframe 内浮窗收不到结果、号码不更新 → 改为广播全部帧（无监听帧静默忽略）
- **[P2] 扩展 `escHtml` 不转义引号**（E-11）：输出落在 HTML 属性内（如 title/value）时可注入 → 补 `"` 与 `'` 转义（文本场景渲染回原字符，无副作用）
- **文档治理**：《未闭环问题清单》顶部新增 v4.23 闭环状态总表（43 条闭环 / 24 条维持不修及理由 / 行号为修复前快照）；《场景化复核报告》及人话版头部标注处置结果，避免日后误读为"未修"

### 刻意维持不修（本轮重评后再次确认）

- **Y-5 限流空 IP 直接放行**：改成"共享桶限流"的失败模式更糟——若日后加反代但没传 X-Forwarded-For，全部流量挤进一个桶会引发 429 风暴；当前直连部署不会产生空 IP，维持现状
- **Y-8 口令哈希单轮 SHA-256 + 硬编码盐**：升级需动管理员登录链路，实现有误会把管理员锁在面板外；认证端点已有限频（爆破窗口很窄），内部 20 人工具下收益不抵风险。建议日后更换口令时顺带升级方案
- **A-3 补推仅 WS 重连触发**：改触发点（前台/周期）涉及生命周期重构，且补推本身有云端三级去重兜底，积压场景罕见
- **A-12 云同步明文 HTTP**：需服务器配 TLS 证书，属部署决策而非代码问题
- **Y-6 / Y-9 / M-5 / E-2 / E-5 / E-6 / E-7 / E-8 / E-10 / A-1**：维持原判（接口行为变更或结构性重构，收益不抵"引入新问题"的风险）

## 2026-09-12（第三批 · 外部复核结论修复 v4.22）

> 依据一份外部源码核查结论（逐条回源核实后确认全部属实），修复了 4 个端"文档声称已修、实际未生效"与"半落地"的问题。
> 验证情况：云端 `pytest` 109 通过（新增 `test_p0_fixes.py` 6 例专门覆盖 P0）、`py_compile` 通过、dashboard 内联脚本经 `node --check` 通过、扩展 JS 经 `node --check` 通过。**Android 侧未做编译验证**——本机 Gradle wrapper 不可用（`gradlew` 报 `Please run: gradle wrapper --gradle-version 8.2`，且无系统 gradle），改动请在有 Android SDK 的机器上跑一次 `./gradlew compileDebugKotlin` 再合并。
> **尚未部署到线上。**

### 云中继 `cloud_relay_v2.py`

- **[P0] Docker/headless 路径下所有异步任务被静默丢弃**（`run_server()` 用局部变量接收 `get_running_loop()`，函数未 `global loop`，而全局 `loop` 恒为 `None`）。Docker entrypoint 走的是 `asyncio.run(run_server())`，从不经过 `run_server_thread()`，因此 `_schedule_async`（REST 拨号 / 挂断 / 登记推送 / 踢人 / 授权回调）全部落到 else 分支只打一条 warning。表现是"服务看着在跑、界面能点，实际什么也没执行"。
  - `run_server()` 改为 `global ... loop` 并在启动时登记事件循环（`run_server_thread` 路径行为不变）
  - 新增 `run_headless()`：headless 专用入口，登记全局 loop + 接管 SIGTERM/SIGINT
  - 新增 `shutdown_gracefully()`：退出时落盘统计 → 取消周期任务 → 关闭所有 WS 连接 → 停服
- **[P0] 分页 limit 只钳上限不钳下限**：SQLite 中 `LIMIT -1` 表示"不限量"，`/api/v1/calls?limit=-1`、`/api/v1/events?limit=-1` 可一次拖走全表（同时打满内存与事件循环）；`/api/logs?n=-1` 同类问题
  - 新增 `_safe_limit(value, default, maximum)`（夹到 `[1, maximum]`）与 `_safe_offset`（负数归零），三处调用点统一替换
- **[P0] `:memory:` 降级分支实际不可用**：每次 `_connect_db()` 都新建一个独立空内存库，`init_db` 建的表后续 44 处连接看不到 → 降级不是"重启丢数据"而是"整个后端直接不可用"
  - 改用 shared-cache 内存库（`file:autodial_memdb?mode=memory&cache=shared`）+ 常驻 anchor 连接（anchor 关闭则库被回收，故永不关闭），所有连接共享同一内存库
- **[P1] 离线登记"无痕丢失"**：组内有手机但连接已死（僵尸连接）时 `forward_to_phones` 吞异常返回，既不发送也不落 pending；补推时删 pending 与"送达"脱钩，补推失败也照样删
  - `forward_to_phones` 现在返回实际送达数；`_push_visit_to_phone` 在送达数为 0 时落 pending；`phone_hello` 补推循环仅在真正送达后删除 pending
- **[P1] `new_device_join` 通知分支不可达**：踢旧机在广播之前执行，遍历 `group.phones` 时集合已空 → 改为使用踢机前的快照
- **[P1] 导出 CSV"顾问姓名"整列为空**：`SELECT * FROM visits` 没有 `kefu_name` 列，`r.get('kefu_name','')` 恒为空字符串 → 按 `kefu_tel` 关联 `advisor_names` 补全（`kefu_tel` 本身是姓名时直接使用）
- **[P1] 登录限频信任可伪造的 `X-Forwarded-For`**：任何客户端换个假 IP 即可绕过。改为默认取 TCP 对端地址（`_peer_ip`），仅当显式设置 `AUTODIAL_TRUST_PROXY=1` 时才采信代理头
- **[P1] REST `auth/respond` 可被手机自批**：原来只校验 `caller_pin == 请求 pin`，而等待授权的手机自己就知道这个 PIN，先调一次 `auth/pending`（也会登记扩展活跃）再调 `auth/respond` 就能给自己放行。现增加：该 PIN 的插件须在线（5 分钟内轮询过）+ 响应方 IP 须与插件轮询 IP 一致
- **[P1] 无优雅退出 / 周期任务叠加 / 会话不回收**：`import signal` 从未使用（`docker stop` 只能硬杀）；服务器重启时 `periodic_*` 任务重复叠加；`_admin_sessions` 只增不减
  - 新增 `_periodic_tasks` 统一记录并在重启前取消、退出时取消；`cleanup_memory()` 增加过期会话清理
- **[P2] Dockerfile `pip install websockets>=12.0` 未加引号**：shell 把 `>` 当重定向，实际装的是无版本约束的包并在工作目录留下垃圾文件 → 已加引号并改用 `printf` 生成 entrypoint
- **[P2] `docker-compose.yml` 未注入管理员账号密码**：代码支持 `AUTODIAL_ADMIN_USER`/`AUTODIAL_ADMIN_PASS`，但 compose 没传 —— 首次启动生成随机密码只打在日志里，用户拿不到就登不进去 → 已补环境变量与 `stop_grace_period`

### 管理面板 `dashboard.html`

- **[P1] 令牌仍大量出现在 URL 里**（"凭据出网址"只做了一半）：`apiGet` 拼 `?token=`，20 余处 `fetch(withToken(url))` 直接调用原生 fetch
  - `apiGet` 改走 `Authorization: Bearer`；新增全局 `fetch` 包装，对所有 `/api/` 请求自动注入 Authorization 头（一次性消灭所有死角，含遗漏的调用点）；`withToken` 保留为恒等函数仅供兼容
- **[P1] 反射型 XSS 面**：`toast()` 与 `setApiBanner()` 直接把消息拼进 `innerHTML` → 统一用已有的 `esc()` 转义
- **[P2] 人员管理表格有「操作」列表头但单元格恒空**（删功能留下的残骸）→ 移除该列，并同步修正 4 处 `colspan="5"` → `4`
- **[P2] 手机管理设备列表无分页、全量渲染**（每台设备还带一行展开详情，设备多时明显卡顿）→ 新增 50 条/页的客户端分页（分页脚注渲染在表格内，不改动页面布局），筛选条件变化自动回到第 1 页
- **[P2] `loadVisits` 绕过统一请求层**：自己 fetch，缺少 429/断网横幅 → 补上 429、非 2xx 与网络异常的提示

### Chrome 扩展

- **[P0] 429 退避是死代码**：`setInterval(pollAuthRequests, INTERVAL * _authPollBackoff)` 的间隔在创建时就固定，429 时只改 `_authPollBackoff` 不重建定时器 → 退避永不生效，始终 30 秒硬撞限流桶。新增 `applyAuthPollBackoff()`：变更倍数即清掉旧定时器、用新间隔重建
  - 注：v4.21 的更新日志把"429 退避"记为已修复，实际只是写了一个没人再读的变量
- **[P0] popup 主题被 MV3 CSP 拦截**：主题初始化为 `popup.html` 内联脚本，MV3 默认 CSP（`script-src 'self'`）拒绝执行且不报错 → 抽成 `theme-init.js` 外部文件（与 `auth.html` 的 `auth.js` 同思路），并在 `manifest.json` 显式声明 `content_security_policy`
- **[P1] 误判号码可能成为生效 PIN**：`getPin()` 无条件兜底 `self_phone`，而 `self_phone` 会被 TreeWalker 的非精确识别覆盖 → 新增 `self_phone_precise` 标记，非精确识别不参与 PIN 兜底（手动 `setPin` 视为精确）
- **[P1] 批量同步漏传 `crm_id`**：云端按 `crm_id` 唯一去重，漏传会导致重复点"同步"把同一条来访反复写库 → 已补
- **[P1] CRM 请求缺 `credentials:'include'`**：扩展页面是 `chrome-extension://` 源，默认不附带 Cookie，CRM 会当成未登录返回登录页（表现为"CRM 登录已过期"）；顺带标注 `Origin`/`Referer` 属浏览器禁改头、设置会被忽略
- **[P1] PC 返回 `success:false` 后未复位 `pcAvailable`**：35 秒缓存窗口内每次拨号都要先白等 3 秒超时 → 失败即复位
- **[P2] 补推队列无间隔重放**：`flushCloudVisits` 逐条之间加 150ms 间隔，遇 429 立即停止并把剩余留到下次（暂存上限 500 条，无间隔重放会继续打爆限流桶）

### Android

- **[P0] 通话记录批量上传水位线逻辑错误**（`DialService.syncCallRecords`）：查询是 `_ID > 水位线` 且 `ORDER BY _ID DESC LIMIT 20`，水位线却取"本批最小 id" —— 水位线落到 81 后下一轮 `_ID > 81` 又把最近 20 条（82..100）捞回来，每轮只前移 1 条，永远在最近 20 条里打转，`id <= 80` 的老记录一条都传不上去
  - 改为**双向水位线**：`highId`（`_ID > highId`，ASC，向上补新）+ `floorId`（`_ID < floorId`，DESC，向下补旧历史），两条线各自单调向外扩张；首次启动把边界对齐到当前最大 id（`floorId = maxId + 1`）
  - 云端 `call_records_raw` 以 `(device_id, local_id)` 为主键且 `INSERT OR IGNORE`，重报幂等，故升级后少量重报不会产生脏数据
  - 抽出 `currentMaxCallLogId()` / `readCallLogBatch()` / `uploadCallBatch()` 三个方法
- **[P0] Manifest 缺 `FOREGROUND_SERVICE_SPECIAL_USE`**：服务声明了 `phoneCall|specialUse`，targetSdk 34 下 `startForeground()` 会抛 `SecurityException` → 开机自启/后台保活全部失效。已补权限声明
- **[P0] 无障碍服务整段被注释**：`DialEngine.kt:178` 在小米机型上调用 `DialAccessibilityService.expectSimPicker()`，但 manifest 里服务未注册 → 自动选卡回退完全失效。已恢复声明（服务仍需用户在系统设置里手动开启，不会强制启用）
- **[P1] 内联"连接"把云地址当 LAN IP 写入**：`putExtra("ip", server)` 传入的是 `ws://host:port`，会污染 `lastLanIp` 与 `prefs["ip"]`，之后局域网直连全部失效 → 不再传 `ip`；`DialService` 侧同时加防御（带 `://` 的值一律忽略，空值不再覆盖已保存的 LAN IP）
- **[P1] 连接中点"取消"不下发 DISCONNECT**：只改本地标志位，后台仍在继续建连，出现"按钮显示未连接、实际已连上"的状态错乱 → 已在下发取消时发送 DISCONNECT
- **[P1] "自动连接"开关与运行时状态相反且不驱动运行时**：UI 默认 `false`（`PrefCtrl`），运行时默认 `true`（`ConnectionManager.loadSavedConfig`），且运行时只在服务创建时读一次 pref → 统一为 `PrefCtrl.KEY_AUTO_CONNECT` / `DEFAULT_AUTO_CONNECT`（取 `true`，保持既有行为），并把 `autoReconnect` 改为实时读 pref 的计算属性，开关立即生效
- **[P2] `allowBackup="true"`** → 改为 `false`（应用数据含 PIN、云端地址、通话记录，不应被系统备份带走）

### 文档同步

- `README.md`：`/api/v1/dial` 的 `PC_CONNECTED` 已于 v4.15 移除（文档与状态码表仍写着）；`/api/v1/visits` 已支持 `days`/`source`/`d_from`/`d_to` 与 `page`/`page_size` 服务端分页（旧文档称"API 仅支持 pin/group、日期筛选是前端过滤"）
- `AutoDial-Extension/AutoDial-API.md`：补充 `auth/respond` 三重归属校验；管理员初始密码说明改为环境变量机制（旧文档称"无 `AUTODIAL_ADMIN_PASS` 环境变量机制、初始密码 123456"，与代码不符）；补充 `AUTODIAL_TRUST_PROXY`
- `技术文档/AutoDial技术文档.md`：授权归属校验条目同步
- 新增 `cloud-relay/python/test_p0_fixes.py`：6 个回归用例覆盖 limit 钳制、内存降级共享、`run_server` 登记全局 loop

## 2026-09-11（第二批 · 综合复核 P0 修复 v4.21）

> 依据《综合复核报告-2026-09-11.md》《综合复核报告-实际使用场景-2026-09-11.md》，逐项对照实际代码核实后修复。全部改动已通过本地验证（pytest 103 通过、E2E 批量导入实测、Kotlin Gradle 编译通过），**尚未部署到线上**（部署需按既有流程 MD5 校验 + py_compile 预检 + supervisorctl restart）。

### 云中继 `cloud_relay_v2.py`

- **[C-01] REST 限流按端点分级**（此前所有 `/api/v1/` 共享 60/min/IP，被扩展授权轮询打爆，线上已实际拦截 `/api/v1/visit` 上门登记）：
  - 认证/管理类（login/admin×/auth/respond）：60/min/IP（维持严格防爆破）
  - 高频轮询类（auth/pending）：240/min/IP 独立配额
  - 业务类（dial/visit/calls/events/stats/devices…）：600/min/IP
- **[C-02] 批量导入改 POST body**：`/api/v1/visits/batch` 新增 POST 方式（请求体 `{"data":[...]}`），绕开 websockets 对 HTTP 请求行 8192 字节硬上限（GET URL 约 20 行中文即超限，整批静默失败）；GET 兼容保留
  - `_PeerProtocol.read_http_request()` 放行 POST 方法（websockets 原版硬编码只接受 GET，POST 在解析请求行即被拒 400）；请求体经 `_request_body` ContextVar 传给 handler
- **[潜伏雷] init_db 全新库初始化必炸修复**：v4.17 引入的 `idx_call_records_dial` 索引建在 `create_call_records` 之前——全新 DB 首次初始化必抛 `no such table`，落入 `:memory:` 降级分支（分支同样先建索引再失败），所有数据落内存库、进程重启即丢。线上因旧库带表未触发。已修正两处分支建表顺序，并用内存 DB 实测验证

### 管理面板 `dashboard.html`

- **[D-2] 未登录/登录过期时停止自动刷新**：锁定态下定时器此前仍每 15 秒触发一轮全 401 的请求，白白消耗限流配额（全员同一出口 IP 时与业务请求互相挤兑）
- **[C-02] 批量导入改 POST + 每批 20 条**（原 BATCH_SIZE=200 拼 GET URL 必超 8KB 上限）

### Chrome 扩展 `background.js`

- **[X-01] 授权轮询降频**：5 秒 → 30 秒（授权请求云端保留 120 秒，30 秒轮询最坏 30 秒内弹窗，体验可接受）；20 台电脑的轮询量从 ≈240 次/分降至 ≈40 次/分
- **[X-01] 429 退避**：被限流后轮询间隔逐次加倍（封顶 8 倍），恢复后回落
- **[G-3] 拨号/挂断/短信不再被"假成功"误导**：PC 端在手机未连接时返回 `200 {success:false, error:'手机未连接'}`，扩展此前只看 HTTP 状态码即报"已拨出/已挂断"——现在读取响应体，`success:false` 时如实报错（dial 失败还会落入云端兜底重试）

### Android `DialService.kt`

- **[P0-B] `logEvent()` 接线**（原函数全仓库零调用，云端 `phone_events` 表永远为空）：拨号结果（ok/error/cancelled）、短信结果全部上报 `/api/v1/events/log`
- **[P0-B] 通话记录上报可观测性**：READ_CALL_LOG 权限缺失不再裸 return（打 FileLogger 日志）；上报失败记录 HTTP 状态码；异常不再无痕吞掉
- **[P0-B] 首传水位线改 DESC**：从最新通话记录开始上报（原 ASC 从最老开始爬，存量大的手机要数小时~数天才能报到"今天"，且先入库陈年数据污染时间线）；DESC 下水位线取本批最小 local_id，逐步向老记录补爬
- 同步策略本身未改：仍要求 WS 已认证在线（isConnected 门控）——离线手机用登记补推通道，通话记录等待重连后自动同步

### 复核实况（未改代码，结论）

- **[A-4] Android 14 前台服务**：核实**已修**——`startForegroundCompat` 按 SDK 选 `specialUse` 类型（34+），manifest 已声明 `FOREGROUND_SERVICE_PHONE_CALL` + `phoneCall|specialUse` 双类型 + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`，无需再改
- **[B] 配对码 deviceId**：核实**已实施**（v4.16）——LAN/Cloud 两处 `phone_hello` 均已携带 `deviceId`（复用 device_uuid），云端以 deviceId 作绑定/去重唯一键
- **[P0-C] 生产库压测数据**：本机 `visits.db` 中 50 台 `StressTest-Phone-*` 均为压测残留；线上 101 台设备中 100 台 `ZZLOADTEST-*` 待管理员确认后清理（清理脚本需登录服务器操作，涉及删数据未擅动）
- **[主线1 局域网直连]**：核实为死链路（PC 只监听 127.0.0.1），维持报告建议"砍掉入口"待拍板，未动代码

### 验证记录

- pytest：103 通过（2 失败为历史遗留 async 测试需要 pytest-asyncio，与本批改动无关，改动前同样失败）
- E2E：真启动服务器（隔离内存 DB）POST 30 行批量导入全量入库 + GET 小批量兼容通过
- 限流分级单元验证：三档配额精确生效、桶互相独立、拒绝不占槽
- Kotlin：`gradle compileDebugKotlin` 通过（本机验证用，kotlin_version 1.9.20 为缓存版本、已还原）
- 扩展 JS：`node --check` 通过；面板两段内联脚本提取后 `node --check` 通过

### 管理员拍板后追加修复（v4.21.1，2026-09-11 晚）

**局域网直连修通（功能保留）**
- `pc-app-Electron/main.js`：HTTP/WS 端口改监听 `0.0.0.0`（原 127.0.0.1 导致手机 UDP 发现后 `ws://<PC局域网IP>:35432` 永远被拒——LAN 直连自始至终不可用）
- `pc-app-Electron/modules/server.js` WS `verifyClient` 重构：
  - 带 Origin 的连接（浏览器发起，无法省略）必须可信 → "任意网页静默连 WS 拨号"的防线不变（S1 目标保持）
  - 无 Origin 放行（Android OkHttp 不发 Origin），身份由 `phone_hello` 的 PIN 校验兜底（配对码错 → auth_fail 断开）
  - 移除 WS 回环 Host 校验（LAN 手机 Host 是 PC 局域网 IP）
- HTTP 层保留回环 Host + 可信 Origin 校验（扩展只从本机访问，不受影响；防 DNS rebinding 依旧）
- Android `ConnectFragment.kt`："检查防火墙"误导文案改为准确指引（同一 WiFi + PC 运行中 + 首次启动允许防火墙）
- PC Windows 防火墙：首次监听外网卡系统会弹授权框，允许即可；被拒时手机 LAN 仍连不上（属正常安全机制）

**PC 端未捕获异常不再退出（P-1）**
- `pc-app-Electron/main.js` `uncaughtException` 由"记日志→退出应用"改为"记录日志 + 弹一次提示，程序继续运行"；同类异常去重防弹窗轰炸

**双击防双拨（PC 直连路径补齐）**
- 复核确认：云端 `/api/v1/dial` 已有 5 秒同号去重（DUPLICATE_DIAL），但 PC 直连 `/dial` 没有——双击浮窗会真拨两次
- `pc-app-Electron/modules/server.js`：HTTP 拨号入口加 5 秒同号去重（在线直发与离线排队两条路径共用一道闸），行为与云端对齐

**数据清理（管理员拍板：直接删不备份）**
- 本地 `visits.db`：50 台 `StressTest-Phone-*` 压测设备及其通话/事件/统计残留已清空（phones 余 0）
- 线上 `101.34.65.254` 100 台 `ZZLOADTEST-*`：本机无 SSH 凭据未执行，留给管理员跑一条命令（见《验证报告-v4.21综合复核修复》第四节）

### 第二梯队修复（v4.21.2，2026-09-11 深夜）

> 依据管理员逐项拍板：8 修、10 配对成功再踢、11 修、12 修、13 修；9 正常不动、14 Go 版不动、15 安全收尾不动。

**C-4 授权握手不再误踢真机（管理员："配对成功再踢下线"）**
- `cloud_relay_v2.py` 手机握手路径：踢旧机从"授权判定之前"推迟到"授权判定成功之后"（`_kick_old_phones` 在 `auth_ok` 前调用）。待授权设备（默认 PIN 不匹配、等待/被拒）不再顶掉该 PIN 正在线的手机；授权通过的两条路径（WS auth_response / REST auth/respond）本就在通过后才踢，行为统一
- 实测：B 设备用他人 PIN 连接被拒后，A 仍在组内并可正常收拨号指令

**A-2 切换云服务器立即生效**
- `ConnectionManager.kt`：`refreshCloudServerList()` 把用户指定的"当前服务器"稳定排序到尝试队首；新增 `switchCloudServer()`——已连接云端时断开并以新服务器立即重连（原先"设为当前"只写偏好、界面切了实际还连旧的）
- `CloudServerSheet.kt`："设为当前"回调触发 `switchCloudServer()`

**C-1 REST 重端点移入线程池（导出/列表不再卡全员）**
- `cloud_relay_v2.py` 新增 `_run_db(fn)` 通用助手；6 个重端点 DB/CSV 段迁入共享线程池：`/api/v1/visit`（登记写）、`/api/v1/visits`（列表）、`/api/v1/visits/export`、`/api/v1/devices`、`/api/v1/calls`、`/api/v1/calls/export`。导出 ≤20 万行 + 内存拼 CSV 期间，事件循环继续跑 WS 拨号/心跳（此前全体卡顿的根因）
- 顺带修复 REST `/api/v1/auth/respond` 中 `conn3` 未定义时 `finally` 抛 NameError 的隐患（该查询同时移入线程池）

**D-8 面板凭据不再进网址（12a）**
- 服务端 `login` / `admin/add` / `admin/chpwd` 兼容 POST body（`_request_body` 机制），前端登录/加账号/改密码改 POST JSON body——明文凭据不再出现在 URL / 访问日志 / 浏览器历史
- 两处导出由 `window.open(带token URL)` 改 `fetch` + `Authorization: Bearer` 头 + blob 下载，token 不进地址栏与历史

**面板 13 项打磨**
- hash 路由（`#/visits` 等）：F5/收藏/分享保留当前页（原先必回首页）
- 危险操作自定义确认弹窗（替换 3 处原生 `confirm`，回显账号 ID / 记录 ID / 分组 ID）
- 改密码"手输账号 ID"改下拉选择（loadAdminAccounts 填充）
- 删除手机页名不副实的"详情"按钮及其空列（列 10→9，真正的历史靠点行展开）
- 表格最小列宽 92px→72px（1280 屏不再无谓横向滚动）
- 表头字号 11px→12px；浅色主题次要色 `#5880A8`→`#456B8F`（对比度 ~3.8:1 → ~5.0:1，达 WCAG AA）
- 定时刷新不再重置用户上下文：`_timerRefresh` 软刷新标记——通话页翻页保留、上门页筛选下拉不重建、手机页已展开行自动恢复（`phoneExpanded`/`phoneRowMap`）
- 列表请求加序号（`_loadSeq`），慢响应后到不再覆盖新数据（手机/通话/上门）
- 顶部横幅"成功即灭"改为错误计数（并发下一次成功不再吹灭别的失败提示）；未登录时 401 文案改中性"请先登录"
- 切页清除"上次刷新 · 已跳过"残留提示

## 2026-09-11

### 云端管理面板状态可信度整改（v4.19 + v4.20，合入 9-11autodial-master.zip 分支）

**云中继 `cloud_relay_v2.py`**
- 新增 `/api/v1/calls/export`（管理员鉴权）：按 `device_id/pin/date_from/date_to/number` 同套筛选条件服务端导出**全部匹配记录**（LIMIT 200000），CSV 带 BOM + 防公式注入 + 附件头（与 `visits/export` 同风格）
- 修复线上存活 BUG：新设备加入已有组的广播分支 `list(group.pcs) | list(group.phones)` 必抛 TypeError（sets 先 list 再 | ）→ 改为 `list(group.pcs | group.phones)`；该分支位于"PC 已在线时手机接入"的常见路径，此前加入通知整体发不出

**dashboard.html**
- 统一请求层：新增顶部全局横幅 `#api-banner`——401（清 token+重新登录）/429（限流）/非 2xx（显示状态码）/断网 分类提示，成功自动收起；请求失败不再被渲染成"暂无数据"；登记页/人员页原生 fetch 补 401 处理
- 移除假"保存设置"（原 `saveSettings()` 不发请求只弹提示）；端口/日志级别改只读，`refreshSettingsInfo()` 走 `/api/status` 显示真实运行端口 + 服务器端修改指引
- 通话记录导出改服务端全量（前端拼 CSV 只导当前页 50 行，年底对账静默缺数据）
- 补 4 处静默 `catch{}`：内联编辑保存失败 toast 明确报错，分组/姓名失败自动重拉保证"界面显示=服务端真实值"，成功给反馈
- 8 张 data-table 自动包裹 `.table-wrap` 横向滚动容器（列数×92px 最小宽），窄屏/多列表格不再挤压变形
- 手机搜索、系统日志关键词搜索统一 400ms 防抖（原先每按一键全量请求一次）
- 管理员密码/新密码输入框改 `type="password"` + `autocomplete="new-password"`（防旁视泄露）
- 自动刷新防误伤（v4.20）：正在表格内联编辑/弹窗填写时自动跳过本轮刷新；顶部"自动刷新"徽标可点击暂停/恢复，长时间录入不被打断

**文档**
- 新增 6 份 2026-09-11 报告：面板 UX 排查、代码审查（实际使用问题）、修复清单（第一批）、验证报告×3（第一批整改/P0 修复实测/面板真实数据实测）

## 2026-09-10（第三批）

### 管理面板性能/导出 + REST 限频 + 姓名翻转修复（v4.18）

**云中继 `cloud_relay_v2.py`**
- [D1] `/api/v1/visits` 支持分页：`page`/`page_size`（1-200）返回 `{ok,total,page,page_size,rows}`；不带 `page` 保持返回数组（手机端同步完全兼容）；新增 `days`/`d_from`/`d_to`/`source` 服务端过滤（来源=unsynced 映射 crm_synced=0）
- [D1] 新增 `/api/v1/visits/export`（管理员鉴权）：按当前筛选条件服务端导出**全部匹配记录**（不再只导屏幕已渲染行），CSV 带 BOM（Excel 中文不乱码）+ 防 CSV 公式注入（=+-@ 前置单引号）+ 附件头
- [E] REST 全局限频：`MAX_REST_PER_MINUTE=60/IP`（localhost 豁免），通过 `create_protocol` 协议子类在握手时捕获对端 IP（legacy process_request 拿不到地址），堵住公网 PIN 枚举/管理口令爆破/接口滥用；`_rest_attempts` 纳入周期清理
- [D4] `/api/v1/visit` 顾问姓名映射改为 `ON CONFLICT DO NOTHING`——登记的"接待顾问"不再覆写扩展上传的"业务员本人"姓名，人员管理姓名不再来回翻转

**dashboard.html**
- [D1] 登记列表分页（每页 50，上一页/下一页/页码/总数显示），15 秒自动刷新只拉当前页——一年 10 万行后面板不再卡死；兼容旧版服务端（数组退回全量渲染）
- [D1] 上门趋势图只拉最近 14 天（此前每 15 秒全量拉整表两次）
- [D1] 导出 CSV 改为服务端按筛选条件导出全量

**已知取舍**
- `/api/v1/calls` 按设备换人后历史归属问题（D5）未动——需数据模型决策，暂缓

## 2026-09-10（第二批）

### 登记数据正确性修复（v4.17）— C 类数据错账 + D2/D3 零成本安全项

**云中继 `cloud_relay_v2.py`**
- [C3] `/api/v1/visit` 新增 `crm_id` 参数：客户端唯一 id，重发/补推按唯一索引精确去重（同一物理来访只入库一次）；visit_record 推送携带 crm_id
- [C2] 无 visit_time 的回退去重从"当日同号"改为"**同号 2 小时内**"——原逻辑会静默吞掉同客户当天第二次真实上门（CRM 有两条、云端只有一条）
- [D2] `/api/v1/advisor/register` 免鉴权端点加校验：PIN 格式 + 姓名长度≤32 + 拒收 HTML 特殊字符
- [D3] 新增 `idx_visits_mobile`、`idx_call_records_dial` 索引，去重/翻页查询不再全表扫描；visit 字段加长度上限
- [D2] `dashboard.html` 两处存储型 XSS 修复：登记列表 `visit_time`、人员管理 `pin` 渲染前 esc() 转义（此前可经 /api/v1/visit 与 advisor/register 注入管理员浏览器）

**Chrome 扩展**
- [C1] CRM 提交严格校验：HTTP 非 2xx（登录过期 401/302、5xx）直接判失败；返回非 JSON（登录页 HTML）不再视为成功；`code` 缺失不再算成功——此前"假成功"导致 CRM 实际未写入
- [C3] CRM 成功但云端不可达时，登记入 chrome.storage 暂存队列（上限 500 条）；SW 启动与下次登记成功时自动补推（crm_id 保证云端去重）
- [C7] 顾问匹配移除"兜底取第一个"——无精确匹配直接报"未找到顾问"，不再把客户挂到同名/相似顾问名下；CRM search 请求加 8s 超时

**Android**
- [C4] 统计翻倍修复（三管齐下）：①提交不再双写 registration_timestamps，统计只读 visit_records；②云端回推按 crm_id 抑制（本机已登记的 echo 直接跳过）；③统计合并加 2 秒簇去重（兼容历史双写数据）
- [C5] 离线补推重写：补推并发保护（AtomicBoolean）+ 每条重读队列 + 成功按 crm_id 原子删除一条——补推期间新保存的记录不再被整体覆写丢失；旧快照写回竞态消除
- [C4] 周起始修正：所有 `set(DAY_OF_WEEK, MONDAY)` 前先 `firstDayOfWeek = MONDAY`，修复周日"本周"统计归零
- [C3] 手机自登记生成 `ph-<pin>-<ts>` crm_id：云端去重 + 本机 seen_crm_ids 抑制回推双计；补推复用同一 id
- [C7] 顾问列表加载失败不再无限"正在加载"——15 秒内明确提示"加载失败，请检查网络或 CRM 登录状态"

**已知取舍**
- CRM 批量同步导入（/api/v1/visits/batch）与插件手工登记之间仍无跨源去重（插件无 visit_time 无法精确匹配）——重发类重复已由 crm_id 消灭，跨源重复需业务层关联，暂缓
- REST 全局限频暂未加（websockets legacy handler 无法直接取对端 IP，需协议层改造），advisor/register 已加校验降低注入面

## 2026-09-10

### 配对码遗留问题修复（v4.16）+ 设备自动注册（v4.16.1）+ 后台登录门禁 + 35440 数据落卷 — 完成于 2026-09-10

设计原则：20 人内部使用、便捷优先于安全、单管理员、双实例容灾（35430 主 / 35440 备，两套数据为预期）。

**云中继 `cloud_relay_v2.py`**
- [B1] `phone_hello` 改用 `deviceId` 作为设备唯一键（`meta['device_id'] = msg.get('deviceId') or deviceName`，旧 APK 缺字段自动回退 deviceName，零破坏）；设备-PIN 绑定查询、踢旧连接、AUTH/PHONE_HELLO 日志全部改用 device_id
- [B2] 同步修正三处遗漏的 deviceId 传递：转发 PC 的 hello（原 831 行）、RESEND 给新连 PC（原 884 行）、WS 授权通过后的转发；`/api/v1/devices` 的 `online_map` 在线判断改按 device_id 匹配；`/api/v1/auth/pending` 返回体补 device_id
- [A1] **设备自动注册（v4.16.1）**：`AUTO_REGISTER_DEVICE` 默认开启，未注册设备首次连接自动绑定当前 PIN 并放行，取消"联系管理员预设"硬门槛；换 PIN 仍走插件授权（防误输顶号）；env `AUTODIAL_AUTO_REGISTER=0` 可恢复严格模式。服务器实测：模拟未注册手机 → AUTO_REGISTER 日志 → DB 生成绑定 → auth_ok
- [A2] 跨 PIN 授权文案改为可操作提示：插件/CRM 未打开 → "需对方授权：请对方（PIN xxx）在电脑上打开 CRM 界面后，重新点击「连接」"；120s 超时 → "授权超时：对方未在 CRM 界面确认。请对方打开 CRM 页面后，重新点击「连接」"

**Android**
- [B1'] `ConnectionManager.kt` LAN / Cloud 两处 `phone_hello` 增加 `deviceId`（复用 `PrefCtrl.getDeviceId()` 的 device_uuid；deviceName 保持型号仅作展示）
- [A1'] `ConnectionManager.kt` Cloud 消息 when 显式新增 `auth_pending` 分支并透传上层（修复：此前落入 `DialService.onMessageReceived` 被静默丢弃，只能干等 120 秒）
- [A2'] `DialService.kt` 新增 `ACTION_AUTH_PENDING` 广播（带 message/default_name，不走 notifyConnectionChange 避免误触发重连）
- [A3'] `ConnectFragment.kt` 注册 `authPendingReceiver`，等待授权显示橙点脉冲 + "等待授权中…（原因）"；等待期间"取消"真正断开连接（云端 finally 自动清理挂起请求）；doConnect 3 秒提示不再覆盖等待文案

**后台前端 `dashboard.html`**
- [G1] 登录门禁：未登录（无会话 token）时 body.locked 隐藏登录框以外全部内容 + 禁滚动 + 强制弹出登录框（不可点空白关闭）；登录成功/登出/401 均自动回登录页。数据 API 服务端 `_check_admin` 原本就有，此改动补齐"界面本身不外泄"一层

**部署（101.34.65.254）**
- v4.16 / v4.16.1 / 文案修订 / 登录门禁分四批上线，双实例（35430 supervisor + 35440 Docker 镜像 v2）均验证 /health 正常；逐行 diff 确认服务器无本地缺失的独有配置，纯升级无回退；各步均有备份（`cloud_relay_v2.py.bak.pre-v4.16_20260910`、`.bak.v4.16_20260910`、`dashboard.html.bak.pre-login-gate_20260910`、Docker 镜像 v1）
- [D1] **35440 数据落卷修复**：Dockerfile 漏设 `AUTODIAL_DB_PATH`，数据库原落在容器内 `/app/visits.db`，重建即清零（当天已发生数轮）。容器重建加 `-e AUTODIAL_DB_PATH=/app/data/visits.db` + Dockerfile 补 ENV 行；验证 DB 已落挂载卷 `/opt/autodial/data/visits.db`，双实例独立容灾设计不变
- 注：/health 返回的 `version: "4.10"` 为代码内版本常量未更新，实际已是 v4.16.1，不影响功能

**备注**
- Kotlin 改动本机无 Java/Android SDK 未编译验证，需 GitHub Actions 构建确认；旧 APK 缺 deviceId 自动回退，无需强制升级
- 旧 APK 以型号名作设备键期间，同型号多台共享一条绑定（首连者定 PIN）；新 APK（device_uuid）发放后按设备唯一。老 APK 将弃用
- 待办（B3）：后台给各设备预设 default_pin 的一次性动作，随新 APK 发放视需要执行

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
