# AutoDial UI 设计文档

> 合并自原《AutoDial手机端UI技术文档-2026-07-11》《AutoDial插件端UI重设计方案-2026-08-17》《AutoDial云端UI重设计方案-2026-08-19》《AutoDial电脑端UI重设计方案-2026-08-18》《AutoDial手机端UI重设计方案-2026-08-17.txt》。修订：2026-08-22
>
> **落地状态**：云端面板 v6.0（Sky Design System）与扩展 v5.0.0 已实现落地；电脑端 v6.1 方案部分实现；手机端 V3 为现行 UI 基准，评审意见供后续迭代。

---

## 〇、设计总纲（全端统一）

- **设计基准**：手机端 `ThemeManager` sky-blue × light（默认主题），主色 `#2B6CC4`、亮色 `#4A90E0`。
- **一套设计系统**：各端共享同一 token 体系（色板、圆角、阴影、字号、间距、motion），JS 拼接 HTML 禁止内联硬编码颜色。
- **图标规范**：功能图标统一内联 SVG（`viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`，Phosphor 风格），emoji 只允许出现在状态文案/日志文本里。
- **字体**：`system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; letter-spacing: .02em`；数字 `tabular-nums`。
- **零功能回归**：所有 DOM id、全局函数名、API URL、storage key、拖拽/缩放/z-index 逻辑冻结不动。

### 0.1 统一设计 Token（sky-blue × light）

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#EBF4FF` | 页面底色 |
| `--surface` | `#FFFFFF` | 卡片 |
| `--surface-2` | `#D8ECFC` | 深层背景/表头 |
| `--input-bg` | `#F4F8FC` | 输入框底色 |
| `--icon-tile` | `#EDF5FD` | 图标底座 |
| `--border` | `#DCEAF7` | 卡片描边 |
| `--border-input` | `#DFEBF6` | 输入框描边 |
| `--divider` | `#E4EBF1` | 行内分割线 |
| `--hero-border` | `#BFD9F2` | Hero 描边 |
| `--hero-top` | `#EDF4FC` | Hero 渐变顶 |
| `--text` | `#162840` | 主文字 |
| `--text-2` | `#5880A8` | 辅助文字 |
| `--primary` | `#2B6CC4` | 主色 |
| `--primary-light` | `#4A90E0` | 渐变亮端 |
| `--primary-dark` | `#1A56A8` | 渐变暗端 |
| `--green` | `#40C057` | 成功/在线 |
| `--red` | `#F03E3E` | 危险/离线 |
| `--orange` | `#F08C00` | 警告 |
| `--purple` | `#7B2CBF` | 手机角色徽章 |
| `--banner-info-bg` / `--banner-info-border` | `#E3EEFB` / `#C4DAF3` | 信息横幅 |
| `--primary-rgb` | `43,108,196` | rgba() 叠加用 |

- 固定语义色（不随主题）：财运红 `#E53935`、幸运紫 `#7B2CBF`、成功绿 `#2ECC71`、危险红 `#E74C3C`
- 主按钮渐变：`linear-gradient(180deg, #4A90E0 0%, #1A56A8 100%)`；Hero 大盘渐变：`linear-gradient(180deg, #EDF4FC 0%, #FFFFFF 100%)` + `1px solid #BFD9F2`
- 圆角 4~5 档：`--r-sm:10px`（输入框/小按钮/图标底座）、`--r-md:14px`（浮层卡/菜单/拨号键）、`--r-lg:18px`（内容卡/主按钮）、`--r-xl:22px`（页面级大卡/Hero，云端用）、`--r-pill:999px`（悬浮球/chip/状态点/徽章）
- 阴影 3 档：`--shadow-card: 0 1px 2px rgba(22,40,64,.04), 0 4px 14px rgba(var(--primary-rgb),.07)`；`--shadow-float: 0 6px 24px rgba(var(--primary-rgb),.18), 0 0 0 1px rgba(var(--primary-rgb),.10)`；`--shadow-btn: 0 3px 10px rgba(var(--primary-rgb),.28)`
- 字号：大盘状态标题 15px/700；卡/浮层标题 14px/700；正文/按钮 13px/500–600；辅助 12px/400–500；徽章 11px/500；统计大数字 30px/700
- Motion：hover 抬升 `translateY(-1px)` 150ms；press 下沉 `translateY(1px) scale(.98)` 80ms；输入框 focus `border 变 primary + 0 0 0 3px rgba(primary-rgb,.14)`；面板切换 `opacity+translateY(4px→0)` 200~220ms；弹窗入场 `scale(.96)→1 + opacity` 180ms；状态点脉冲 3px→6px 2s 循环

### 0.2 派生色规则（暗色/多主题运行时 blend 计算）

`blend(a,b,p) = a×(100−p)/100 + b×p/100`（按 RGB 通道四舍五入）：

| token | 规则 |
|---|---|
| `--input-bg` | blend(surface, surface-2, 55) |
| `--icon-tile` | blend(surface, primary, 8) |
| `--border` / `--border-input` / `--divider` | blend(surface, text-2, 26/20/14) |
| `--hero-border` / `--hero-top` | blend(surface, primary, 52/5) |
| `--banner-info-bg` / `--banner-info-border` | blend(surface, primary, 10/32) |

天空蓝 dark 基础色：`--bg:#0C1220; --surface:#141E38; --surface-2:#1C2A4C; --input-bg:#182543; --icon-tile:#182646; --border:#2E3D5B; --border-input:#283653; --divider:#222F4B; --hero-border:#2E5293; --hero-top:#172341; --text:#E4EEFF; --text-2:#7696BD; --primary:#4682E6; --primary-light:#74A5F8; --primary-dark:#2563EB; --green:#60C571; --red:#FF6B6B; --primary-rgb:70,130,230`（dark 阴影加深 `rgba(0,0,0,.3)`）。

---

## 一、手机端 UI 规范（V3 原生 Android，现行基准）

> 适用：`android-app/app/src/main`。面向约 50 人内顾问团队，UI 以高频操作效率为主，保留"财运、财气、财库"内部趣味表达。不改变 CRM、云中继、拨号和登记接口；原生 View、XML 与 BottomSheetDialog；默认主题 sky-blue + light。

### 1.1 页面与导航

| 页面 | Fragment | 主要功能 |
|---|---|---|
| 通话 | `CallLogFragment` | 连接状态、财运/财气、拨号模式、记录筛选、手动拨号 |
| 录上门 | `RegisterFragment` | 客户信息、顾问选择、CRM 登记 |
| 财库 | `StatsFragment` | 今日/周/月统计、上门统计、七日趋势 |
| 设置 | `ConnectFragment` | 跨屏连接、APP 拨号、主题、通知、日志 |

导航顺序可在「主题/弹窗设置」切换（通话优先 / 设置优先），Fragment 索引不变只重排底部 Tab，保存于 `navigation_order`。卡片 14–16dp 圆角、输入框/按钮 12–14dp、页面边距约 14dp、底部导航 64dp。

### 1.2 主题系统

`ThemeManager.kt` 提供 16 套主题 × 7 种亮度，默认 sky-blue/light。常用 View tag：`bg`（页面背景）、`bg2/bg3`（卡片与次级背景）、`topBar/navBar`、`settingGroup/settingRow/settingDivider`（设置展开区）、`inputField`、`primaryBtn/primaryBtnText`、`chip`。主题板块支持卡片透明度（0/25/50/75/100%）、卡片边框、连接通知、登记通知、上次通话提示时长（2s/3s/5s/8s）。

### 1.3 各页要点

- **设置页**：状态卡单动作按钮（未连接=连接 / 连接中=取消 / 已连接=断开 / 意外断开=重连）；跨屏连接设置采用"外层卡片 + 内部设置行"；`CloudServerSheet` 支持增删/设为当前/单台测速/全部测速/恢复默认/网络获取；`DialModeSheet` 7 种模式；`AnimationSheet` 11 种效果（关闭/弹跳/烟花/组合/脉冲/星光/滑入/缩放/抖动/翻转/心跳）
- **通话页**：今日财运（红）/财气（紫）固定语义色；拨号模式快捷栏 7 模式；筛选 全部/已接通/未接；条目左侧状态色条、号码脱敏、SIM/时间/类型/时长；右下 FAB（42dp）开 DialPadSheet；点击记录开 CallDetailSheet
- **财库页**：今日拨号红、今日通时紫；周统计双卡；本月财运/财气主蓝强调卡；上门统计 3×2 网格数字可点看明细；七日趋势红橙黄绿青蓝紫；同步用矢量刷新图标
- **登记页**：表单卡 16dp 内边距、输入框 48dp/12dp 圆角；称呼与手机号必填；顾问字段 BottomSheet 选择；事由固定「贷款咨询」；按钮状态机 完成登记→提交中→登记成功/失败→恢复

### 1.4 交互与持久化（PrefCtrl.kt）

字段：`dial_mode`、`dial_animation_mode`、`dial_animation_text`、`auto_reconnect`、`auto_copy_number`、`copy_toast`、`card_opacity`、`card_border`、`notify_conn_state`、`notify_register`、`last_call_hint_duration`、`navigation_order`。

### 1.5 手机端评审意见（2026-08-17，供后续迭代）

1. **颜色硬编码收敛**：`#FF4D4F/#7B2CBF/#2ECC71/#E53935/#FF4444/#8E44AD` 等散落布局（statsTodayCount 用 #FF4444、todayLuckText 用 #FF4D4F 两个红不一致；duration 用 #8E44AD、fortuneText 用 #7B2CBF 两个紫不一致）→ 强调色只在 colors.xml 定义一次或 ThemeManager 统一注入
2. **#888888 占位背景过多（40+ 处）**：ThemeManager 漏配即显灰 → themes.xml 默认主题定好默认背景，XML 引用 `?attr/colorSurface`
3. **空状态文字硬编码**：callLogEmpty 标题 #1A1A1A / 副标题 #888888 暗色不可读 → 纳入主题管理
4. **财库分割线过深**：statsMonthCallCard/statsMonthDurationCard 之间 #22262F → 用 text2 色 + 透明度
5. **拨号模式栏选中态**：加底部 2dp 指示条或加粗+背景高亮；筛选 chip 选中加粗边框/饱和度提升，高度 28dp→32dp
6. **FAB 偏小**：dialFab 42dp → 建议 48~56dp
7. **细节对齐**：todayLuckText/todayFortuneText marginEnd 25dp/8dp 不统一；lastCallHintBanner 文字 17sp→15sp；etManagerName 加下拉箭头提示可点
8. **设置页图标 tint 硬编码**：ic_tab_settings 的 `#2B6CC4` 切"森林绿"主题仍显蓝 → 用 `?attr/colorPrimary`
9. **七日趋势容器**：statsChartContainer 给 minHeight 120dp 防布局跳动；日期标签 text2 + 11sp

---

## 二、插件端 UI 重设计（v5.0.0，✅ 已落地）

> 适用：`AutoDial-Extension/`。核心问题：三套并行样式体系（popup/auth CSS 变量 vs content-script EXT_THEMES vs 各悬浮组件自定）、主题数据两处重复不同步、功能图标用 emoji、圆角 6~24px 混乱、无 motion。

### 2.1 popup.html（结构级重做，360px）

- 结构：Topbar（图标底座 34 + AutoDial + v5 pill）→ 状态页 `#statusPanel`（Hero 大盘渐变含状态 + 主按钮「同步登记列表」内置；信息分组卡：坐席手机号/接待顾问/云端地址三行，22px 图标底座 + › 指示 + divider）→ 设置页 `#setupPanel`（Hint 横幅 + 一张分组设置卡装全部：云中继地址+测试 / 配对码+保存 / 接待顾问姓名+保存，组间 divider）→ 次操作「修改服务器」ghost pill +「清除 PIN」danger pill
- 三张设置卡合并为一张分组卡（对齐手机端 settingGroup/settingRow）；主按钮移入 Hero 大盘底部；版本徽章 v4→v5；面板切换加 `.panel-in` 动画（不改 JS display 逻辑）
- **冻结 id**：`statusPanel setupPanel statusDot statusText cloudStatus myPhone myMgrName cloudAddr syncBtn editServerBtn clearPinBtn setupHint serverInput testServerBtn serverStatus backToStatusBtn pinInput savePinBtn pinStatus mgrNameInput saveMgrNameBtn mgrNameStatus`

### 2.2 auth.html

结构不变（卡片居中），样式与 popup 同源：顶部 48px 圆角方形红色警告底座（内嵌警告三角 SVG）、`--r-lg` 卡 + 入场动画、信息卡分组化、拒绝=ghost pill / 允许=渐变主按钮 pill 高 42px；`:root` token 块与 popup 逐字一致。

### 2.3 content-script.js 悬浮组件

约束：无 CSS 文件，全部 `Object.assign(el.style,…)` 内联；id/class、拖拽、缩放、消息逻辑、z-index 不动。

- 新增 `adStyles(t)` helper（从 token 派生 card/input/btnPrimary/btnGhost 片段）+ `adIcon(pathD,size)` SVG helper（phone/phoneX/monitor/mapPin/palette/gear/clipboard/sync）
- 拨号球 `__ad_float`：borderRadius→999px；idle=白底+text 色+`1px solid accent33`；有号码=gradAccent+白字+发光 `0 6px 20px accent59`；hover 抬升、press scale(.97)；图标 emoji📞→16px SVG
- 挂断钮 `__ad_hangup`：idle=白底红字+phoneX 图标（语义"挂断=红"）；点击后 gradRed+白字；缩放手柄三角 accent66→red55
- 手动拨号条 `__ad_manual`：套 adStyles(card)，input 高 34px focus 变色，清空=btnGhost、拨号=btnPrimary，显隐加过渡
- 右键菜单/主题菜单：圆角 14px、「16px SVG + 文字」flex 行、hover 底 accent14、危险项 t.red；主题菜单 active=行底 accent1A + 右侧 ✓
- 位置提示去掉 monospace；设置弹窗圆角 16px、标题行「20px 图标底座 + 15/700 + ×」
- **主题数据收口**：新建 `themes.js`（`AD_THEMES` = 原 EXT_THEMES 搬入）；manifest `js: ["themes.js","content-script.js"]`（顺序敏感）；content-script 改 `const EXT_THEMES = AD_THEMES`；popup/auth 引入 themes.js 同步变暗；storage key `__ad_theme`
- **冻结清单**：content-script id（`__ad_float`、`__ad_dial_label`、`__ad_hangup`、`__ad_manual`、`.__ad_manual_paste`、`.__ad_manual_dial`、`__ad_ctxmenu`、`__ad_ctxmenu_overlay`、`__ad_thememenu`、`__ad_position_tip`、`__ad_settings`、`__ad_settings_overlay`）；storage key（`cloud_api`、`cloud_apis_fetched`、`self_phone`、`pin`、`manager_name`、`__ad_theme`、`__ad_hangup_size`）；拖拽边缘 DRAG_EDGE 0.18、缩放 36–100、`window.__adv2` 防重入；`background.js` 一行不改

---

## 三、云端管理面板 UI 重设计（v6.0，✅ 已落地）

> 适用：`cloud-relay/python/dashboard.html`（单文件架构，逻辑零改动只换皮）。设计稿确认：8 页、80 DOM id、66 全局函数、API URL、CSV 列序、Chart canvas id 全部冻结。

### 3.1 App Shell 骨架

顶部横幅 + 横排 Tab → **左侧 240px 侧边栏（dark 渐变）+ 顶部 64px 工具栏 + 内容区 max-width 1400px**。响应式：≤1100px 侧栏收 72px 纯图标；≤768px off-canvas 抽屉 + 汉堡钮。侧边栏底部运行状态卡（hdr-port/hdr-uptime/hdr-conn）。

### 3.2 关键组件

- **统计卡 `.stat-card`**（对齐手机端）：图标底座 36px（--icon-tile 底 + 主色图标）+ 标题 + 30px tabular-nums 大数字 + 12px 副标题；hover `translateY(-2px)`；语义变体只做底座配色（.tone-green/red/orange/purple），不做整卡染色
- **Hero 状态横幅**（首页顶部）：grad-hero 渐变 + hero-border + r-xl + 44px 脉冲状态点 + 副行 + 「立即刷新」渐变主按钮
- **按钮 4 种**：btn-primary（grad-btn 渐变 + shadow-btn）、btn-outline（surface + border-input）、btn-danger（红描边 30%）、btn-success（绿渐变，导出用）；`btn:active translateY(1px) scale(.98)`
- **表格 `.data-table`**：表头 input-bg + 11px 大写 label（首/末 10px 圆角）、行 divider + hover input-bg、展开行 banner-info-bg、行内联输入 `.cell-input`、未同步行 `.row-warn`
- **徽章 `.badge`** 全 pill 化：PC=primary 底 12%、手机=purple、在线/对账OK=green、离线=surface-2、手机来源=orange、CRM同步=primary-dark、对账异常=red
- **弹窗 `.modal`**：遮罩 `rgba(12,18,32,.45)` + blur(4px)，框体 r-xl + shadow-float + 顶部 8px 渐变条
- **日志终端**：固定深空蓝 `#0D1526`，4 级配色 info:#7EB6FF / warn:#F0B429 / error:#FF6B6B / 默认:#C9D6E8
- **Toast 通知系统**：`toast(msg, type)` 右上角堆叠 3s 自动消失；`alert()` 全部替换（文案不变），`confirm()` 保留（删除确认需阻塞）
- **图表**：`cssVar()` 读取 CSS 变量取主题色，柱状 borderRadius 6、网格 rgba(120,140,170,.12)、切主题时销毁重建

### 3.3 主题系统

复制扩展 `themes.js` 的 `AD_THEMES`（9 套）+ `_adHexRgb`/`_adBlend`/`AD_THEME_VARS` 进 dashboard，再补天空蓝 dark 变体（共 10 项）。`applyTheme(id)`：映射到 CSS 变量 → `dataset.theme = id` → `localStorage.__ad_theme`（与扩展同一 key）。顶栏调色板图标下拉切换，当前项打勾 + 渐变圆点 swatch。保底方案：至少交付「天空蓝 light + dark」两套 + 日月切换钮。

### 3.4 测试同步（实现时允许的唯一测试改动）

`test_cloud_relay_v2.py::TestDashboardHTML`：`test_seven_tabs` 期望值 7→8（v4.12 已上线第 8 页测试没跟上，本就红着）；`test_tab_names` 追加 `'admin-accounts'`。

---

## 四、电脑端 UI 重设计（目标 v6.1，📋 部分实现）

> 适用：`pc-app-go/frontend/`（Electron 移植见附录）。核心问题：主题系统名存实亡（wails-adapter 未实现 get-theme-setting 通道 → 永远回退 dark-gold/dark，且 settings.go=lavender/light、theme-data.js=dark-gold/dark 三处默认值互不一致）；设置面板 5 个 JS 函数缺失（主题网格空、模式选择死、保存死）；硬编码金色渗透 15+ 处；emoji 图标 20+ 处；三重状态条重复表达。

### 4.1 主题系统修复（核心接线）

- `theme.js`：COLOR_MAP 改名（gold→primary、bg2→surface、bg3→surface-2、text2→text-2…）；新增派生注入 `_hexRgb/_blend` 计算 inputBg/iconTile/border/borderInput/divider/heroBorder/heroTop/bannerInfo* 并 setProperty，另设 `--primary-rgb`、`--grad-btn`、`--grad-hero`
- `themes/theme-data.js`：最后 2 行默认值 `DEFAULT_THEME='sky-blue'`、`DEFAULT_MODE='light'`（16 套主题数据一字不动）
- 接线：`wails-adapter.js` invoke 加 `case 'get-theme-setting': return App.GetSettings()`；`app.go GetSettings()` 补 `mode`、`silentStart` 字段；`settings.go defaultSettings()` Theme 改 sky-blue
- 全文变量替换校验表：禁止残留 `--gold`、`--gold-light/dark`、`--bg2`、`--bg3`、`--text2`、`--radius-sm/md/lg`、`rgba(201,168,76`、`#C9A84C`、`#8B6914`、`#F0C040`

### 4.2 主窗口重组（420×780）

三重状态条（`.header` + `.status-display` + `.banner`）合并为一个 **Hero 大盘 `.hero-card`**：40px 圆底座 #statusIcon（connected 绿描边环 + pulse）、#statusTextLarge 15/700、信息 chip 行（状态点 + IP + 配对码可点 + 云端/重启图标底座钮）、置顶开关 pill 化。号码卡 1px 描边（废 2px 粗边框）+ focus-within 光环；拨号盘 surface 卡键 r-md press .93；拨打/挂断按钮 `:disabled` 改灰（**废红字，禁用≠危险**）；短信入口 ghost pill（废虚线）；日志卡 surface + r-lg；`.toast` pill 底部居中。**允许改动的 JS 文案点仅 6 处**（statusIcon innerHTML 换 SVG、callBtn/hangupBtn 改 label span 方案等）。

### 4.3 设置浮层修复重建（#settingsOverlay）

分组卡结构：窗口行为（关闭按钮行为段选 + 托盘退出 switch）/ 启动（开机自启 + 隐藏启动）/ 云中转（开关 + 服务器列表增删测获）/ 外观（`#themeGrid` 16 主题网格 4 列 + `#modeSelect` 7 模式段选）。补齐缺失 JS：`renderThemeGrid`、`setSelect`、`selectMode`、`settingChanged`、`saveAllSettings`、`loadSettingsIntoUI`（openSettings 追加 1 行调用）；即时预览不保存、保存走 `App.UpdateSettings`。`#modeSelect` 模式 emoji（🌑🌆🌅…）保留（属模式名称）。

### 4.4 其余浮层

- 短信浮层 `#smsOverlay`：**废硬编码金色渐变**，可用态 grad-btn、disabled 灰；input/textarea 规范样式
- 模板管理 `#tplManagerOverlay`：surface + r-lg + shadow-float
- 悬浮条 `#floatbar`：保留毛玻璃（--floatbar-* 每主题已有值），r-pill + shadow-float；按钮 emoji → 内联 SVG + label span（fbDialLabel 等）；disabled 改灰
- 右键菜单 `#fbMenu`：废硬编码暗色底，surface + r-md + backdrop blur；菜单项 14px SVG + 文字

### 4.5 图标 path 库（第八节，可直接照抄）

phone / phone-off（phone path + 斜线）/ message / gear / cloud / refresh / wifi / hash / doc / trash / close / minimize / up / chevron-down / clipboard，统一 24 viewBox / stroke 1.8 / round。替换点全表：titlebar logo、#statusIcon、#restartCloudIcon（☁→cloud）、#restartAppIcon（⟳→refresh）、拨号盘/拨打/挂断/短信/日志按钮、设置/短信/模板浮层标题与关闭、悬浮条 6 按钮、#fbMenu 菜单。保留：模式 emoji、addLog 文案 emoji、banner ✅。

### 4.6 冻结清单摘要

全部 DOM id（btnSettings…fbMenu 共 70+）；除 6 处文案 + 新增函数 + openSettings 1 行外 JS 一行不动；IPC 通道、THEME_DATA 16×7、窗口参数（420×780/360×600）、z-index（floatbar 8888 / toast 999 / settings 9999 / sms 9998 / tplMgr 10001）、localStorage `autodial_sms_templates`；Go 端仅 3 处改动。Electron 移植映射：index.html→renderer/index.html、设置浮层→settings.html、短信→sms.html、悬浮条→floatbar.html、theme-data.js/theme.js 同名同改。
