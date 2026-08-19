# AutoDial 云端管理面板 UI 重设计方案

> 版本：2026-08-19 | 目标版本 v6.0
> 适用文件：`cloud-relay/python/dashboard.html`（唯一改动对象，单文件架构不动）
> 设计基准：手机端 `ThemeManager` sky-blue（light 为默认）+ 扩展端 v5 已落地的 Web 化 Token（`AutoDial-Extension/popup.html`、`themes.js`）
> 性质：**整体重设计**（布局结构 + 组件规范 + 主题系统全部重建），不是现有样式的缝补
> 配套文档：《AutoDial插件端UI重设计方案-2026-08-17》（云端 Token 与其同源，可直接对照）

---

## 一、现状审计（为什么需要重设计）

### 1.1 现状清单

当前 `dashboard.html`（约 1360 行）是 2023 年风格的"模板后台"：

| 部位 | 现状 | 问题 |
|---|---|---|
| 头部 | 深藏青渐变横幅 `#1a1a2e→#0f3460` + 紫色渐变标题字 | 与全项目任何一端都无关联，视觉上像别人的产品 |
| 主色 | `#667eea / #764ba2` 紫罗兰 | 手机端/扩展端默认主题是天空蓝 `#2B6CC4`，云端自成一派 |
| 导航 | 顶部横排 8 个 Tab + 登录/退出按钮挤在一行 | 1366px 宽度下已经换行/滚动，无法再扩展 |
| 统计卡 | 白卡 + 左侧 4px 色条 | 十年前的 AdminLTE 手法，手机端早已是"图标底座+大数字居中" |
| 图标 | 全量 emoji（🚀📊📱📞🏠👤🔑📋⚙️🔐…） | 违反手机端规范：功能图标统一 Phosphor 风格矢量图标 |
| 反馈 | `alert()` / `confirm()` 原生弹窗 | 最破坏现代感的点，手机端是 Toast + BottomSheet |
| 内联样式 | JS 拼接 HTML 里大量 `style="..."` 硬编码颜色（`#e74c3c`、`#2ecc71`、`rgba(244,67,54,0.06)`…） | 无法主题化，改色要改几十处 |
| 主题 | 只有固定浅色一套，无暗色 | 手机端 16 主题 ×7 亮度，扩展端 9 主题，云端为 0 |
| 细节 | 无 motion（仅一个 pulse）、无自定义滚动条、表格无斑马/悬浮反馈层级 | 质感停留在"能用的表单" |

### 1.2 必须保留的资产

- 全部业务逻辑、API 调用、Chart.js 图表、15 秒自动刷新、批量导入解析器、会话令牌登录流程 —— **逻辑零改动，只换皮与骨架**。
- 单文件架构：`cloud_relay_v2.py` 通过 `load_dashboard_html()` 读取本文件，无构建工具、无外部 CSS/JS 文件（Chart.js CDN 除外）。重设计**必须仍是这一个 HTML 文件**。

### 1.3 测试现状（重要）

`test_cloud_relay_v2.py::TestDashboardHTML` 当前有 1 个用例**本来就失败**：`test_seven_tabs` 期望 7 个 `.page`，实际已有 8 个（v4.12 加了 `page-admin-accounts` 但测试没跟上）。本方案顺手修正该测试（见第九节）。

---

## 二、设计目标

1. **一套设计系统**：所有颜色/圆角/阴影/字号/间距来自 Token 表（第三节），JS 拼接的 HTML 一律用 class，禁止内联硬编码颜色。
2. **结构现代化**：顶部横幅 + 横排 Tab → **左侧导航栏 + 顶部工具栏**的 App Shell（桌面端管理台的标准形态，也是手机端底部导航在桌面端的对应物）。
3. **质感现代化**：柔和分层阴影、hover 抬升 / press 下沉、面板切换过渡、弹窗 backdrop 模糊、自定义滚动条、Toast 通知、骨架/空状态插画位。
4. **图标矢量化**：功能图标全部换内联 SVG（24 viewBox、stroke 1.8、round 线帽，Phosphor 风格，与手机端 `ic_ph_*` 同源）；emoji 只允许出现在日志文本等业务数据里。
5. **主题化**：默认天空蓝·亮色（与手机端/扩展端默认一致），内置暗色 + 扩展端其余 8 套主题，顶栏一键切换，`localStorage` 持久化。
6. **零功能回归**：所有 DOM id、全局函数名、API URL、CSV 导出列序、Chart canvas id 一律不动（见第九节冻结清单）。

---

## 三、设计 Token（唯一权威值）

### 3.1 色板 · 天空蓝 light（默认主题，与 popup.html 逐字一致）

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
| `--orange` | `#F08C00` | 警告（新增语义色） |
| `--purple` | `#7B2CBF` | 手机角色徽章（取手机端 fortune_purple） |
| `--banner-info-bg` | `#E3EEFB` | 信息横幅底 |
| `--banner-info-border` | `#C4DAF3` | 信息横幅边 |
| `--primary-rgb` | `43,108,196` | 透明叠加用 |

固定语义色（不随主题变，与手机端 `ACCENT_*` 一致）：财运红 `#E53935`、幸运紫 `#7B2CBF`、成功绿 `#2ECC71`、危险红 `#E74C3C`。

### 3.2 色板 · 天空蓝 dark（暗色，取自 ThemeManager.kt L250 + 扩展端 blend 公式推导）

| Token | 值 | Token | 值 |
|---|---|---|---|
| `--bg` | `#0C1220` | `--hero-top` | `#172341` |
| `--surface` | `#141E38` | `--text` | `#E4EEFF` |
| `--surface-2` | `#1C2A4C` | `--text-2` | `#7696BD` |
| `--input-bg` | `#182543` | `--primary` | `#4682E6` |
| `--icon-tile` | `#182646` | `--primary-light` | `#74A5F8` |
| `--border` | `#2E3D5B` | `--primary-dark` | `#2563EB` |
| `--border-input` | `#283653` | `--green` | `#60C571` |
| `--divider` | `#222F4B` | `--red` | `#FF6B6B` |
| `--hero-border` | `#2E5293` | `--primary-rgb` | `70,130,230` |

dark 下阴影调深：`--shadow-card: 0 1px 2px rgba(0,0,0,.3), 0 4px 14px rgba(0,0,0,.25)`。

### 3.3 渐变（手机端原样翻译）

```css
--grad-btn:  linear-gradient(180deg, var(--primary-light) 0%, var(--primary-dark) 100%);  /* primaryBtn */
--grad-hero: linear-gradient(180deg, var(--hero-top) 0%, var(--surface) 100%);            /* heroCard */
```

### 3.4 圆角（收敛 5 档，对应手机端 dp）

| 档位 | 值 | 用途 | 手机端来源 |
|---|---|---|---|
| `--r-sm` | `10px` | 小按钮、输入框、徽章、图标底座 | inputField 内层 |
| `--r-md` | `14px` | 输入框、outlineBtn、菜单 | outlineBtn 14dp |
| `--r-lg` | `18px` | 内容卡、主按钮、弹窗 | primaryBtn 18dp |
| `--r-xl` | `22px` | 页面级大卡、Hero | bg2 卡 22dp / heroCard 26dp 取近似 |
| `--r-pill` | `999px` | chip、状态点、开关、版本徽章 | chip/switch 999dp |

### 3.5 阴影（3 档，与扩展端一致）

```css
--shadow-card:  0 1px 2px rgba(22,40,64,.04), 0 4px 14px rgba(var(--primary-rgb),.07);
--shadow-float: 0 6px 24px rgba(var(--primary-rgb),.18), 0 0 0 1px rgba(var(--primary-rgb),.10);
--shadow-btn:   0 3px 10px rgba(var(--primary-rgb),.28);
```

### 3.6 字号 / 字体

| 用途 | 字号/字重 |
|---|---|
| 顶栏产品名 | 16px / 700 |
| 页面标题 | 20px / 700 |
| 卡片标题 | 15px / 600 |
| 统计大数字 | 30px / 700，等宽数字 |
| 正文/按钮 | 13px / 500–600 |
| 表格、辅助 | 12–13px / 400–500 |
| 徽章、状态 | 11–12px / 500 |

全局 `font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; letter-spacing: .02em`（手机端同款字距）；数字用 `font-variant-numeric: tabular-nums`（对齐手机端 monospace 数字风）。日志终端保留等宽字体栈。

### 3.7 间距

页面左右 padding 24px；卡片内边距 20px；卡片间距 16px；统计卡网格 `repeat(auto-fit,minmax(210px,1fr))` gap 16px；筛选项 gap 10px。

### 3.8 Motion

| 场景 | 参数 |
|---|---|
| hover 抬升（卡片/按钮） | `translateY(-1px)`，150ms |
| press 下沉 | `translateY(1px) scale(.98)`，80ms |
| 输入框 focus | 边框变 `--primary` + `box-shadow: 0 0 0 3px rgba(var(--primary-rgb),.14)`，底色变 `--surface` |
| 页面切换 | `opacity 0→1 + translateY(4px→0)`，220ms ease-out |
| 弹窗入场 | `scale(.96)→1 + opacity`，180ms ease-out；遮罩 `backdrop-filter: blur(4px)` |
| 状态点脉冲 | 外圈 3px→6px 呼吸，2s 循环（沿用现有 keyframes） |
| Toast 入场 | 从右上 `translateX(24px)→0 + opacity`，250ms |

---

## 四、整体结构重设计（App Shell）

### 4.1 新骨架线框

```
┌────────────────────────────────────────────────────────────────────┐
│ 侧边栏 240px（dark 渐变，全高固定） │ 顶栏 64px（surface，sticky）      │
│ ┌──────────────────────────────┐ │ ┌──────────────────────────────┐│
│ │ [logo底座36] AutoDial 云中转  │ │ │ 页面标题    [状态pill][刷新] ││
│ │              v6.0 pill       │ │ │        [主题切换][登录/退出] ││
│ ├──────────────────────────────┤ │ └──────────────────────────────┘│
│ │ 导航（icon+文字，r-md 圆角项）│ │ ┌──────────────────────────────┐│
│ │  ◇ 首页总览   （active=左竖条│ │ │                              ││
│ │  ◇ 手机管理     +渐变底+主色)│ │ │      内容区 page-*            ││
│ │  ◇ 通话记录                  │ │ │   max-width 1400px 居中       ││
│ │  ◇ 上门登记                  │ │ │                              ││
│ │  ◇ 人员管理                  │ │ └──────────────────────────────┘│
│ │  ◇ 管理账号                  │ │                                   │
│ │  ◇ 系统日志                  │ │                                   │
│ │  ◇ 设置                      │ │                                   │
│ ├──────────────────────────────┤ │                                   │
│ │ 底部:运行状态卡(小)           │ │                                   │
│ │ ● 运行中 · 端口35430          │ │                                   │
│ │ 运行 2时3分 · 连接 5          │ │  ← hdr-port/hdr-uptime/hdr-conn  │
│ └──────────────────────────────┘ │      从旧 header 搬到这里         │
└────────────────────────────────────────────────────────────────────┘
```

**响应式**：≤1100px 侧边栏收成 72px 纯图标（label 隐藏）；≤768px 侧边栏变 off-canvas 抽屉，顶栏出汉堡钮。

### 4.2 结构改动要点

1. 废弃 `.header`（深藏青横幅）和顶部 `.nav`，改为 `<aside class="sidebar">` + `<header class="topbar">` + `<main class="content">` 三件套；最外层 `body` 用 `display:flex`。
2. 8 个 `.page` 容器、`showPage(id)` 机制原样保留（导航按钮仍然 `onclick="showPage('xxx')"`，只是从顶栏搬到侧边栏，class 从 `nav-btn` 换成 `side-item`，`showPage` 内部选择器同步改为 `.side-item`）。
3. 原 `.refresh-bar` 并入顶栏右侧：状态 pill（自动刷新 · 每15秒 / 上次刷新时间，id `refresh-label`、`last-refresh` 保留）+ 圆形图标刷新按钮。
4. 登录/退出按钮（`login-btn`/`logout-btn`）搬到顶栏右侧，改成小按钮样式。
5. 顶栏左侧显示当前页标题：`showPage()` 里加一行 `document.getElementById('topbar-title').textContent = 标题映射[id]`（新增 id `topbar-title`，不影响测试）。

---

## 五、组件规范（全部用 class，消灭内联样式）

### 5.1 统计卡 `.stat-card`（对齐手机端 StatsFragment）

废弃"左侧色条"。新结构：

```
┌─────────────────────┐
│ [图标底座36px]  标题 │  ← 图标底座 .stat-ico（--icon-tile 底 + --primary 图标，r-sm）
│       30px 大数字    │  ← .stat-value（tabular-nums，色按语义：默认 --text）
│       副标题 12px    │  ← .stat-sub（--text-2）
└─────────────────────┘
```

CSS：`background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--shadow-card); padding: 18px; transition: transform .15s, box-shadow .15s;` hover 时 `translateY(-2px) + var(--shadow-float)`。
语义变体只做图标底座配色（`.tone-green/.tone-red/.tone-orange/.tone-purple` 控制底座底色与图标色），**不做整卡染色**。

### 5.2 Hero 状态横幅（首页新增，对齐手机端 heroCard / 扩展端 hero-card）

首页顶部统计卡之上插入 Hero：`background: var(--grad-hero); border: 1px solid var(--hero-border); border-radius: var(--r-xl); box-shadow: var(--shadow-card); padding: 20px 24px;`
内容：左侧 44px 脉冲状态点（沿用 pulse keyframes）+ "云中继运行中"（15px/700）+ 副行 `端口 35430 · 已运行 X · 当前连接 N`；右侧放"立即刷新"渐变主按钮。原有 `hdr-port/hdr-uptime/hdr-conn` 三个 id 移到侧边栏底部状态卡（第四节），Hero 里用新 id（如 `hero-conn`）或复用同一数据源渲染，二者都允许——**但旧 id 必须存在于 DOM 且仍被赋值**。

### 5.3 按钮（4 种，对齐手机端 primaryBtn / outlineBtn / chip）

```css
.btn { border:none; cursor:pointer; font:inherit; font-size:12px; font-weight:600;
       border-radius: var(--r-md); padding: 7px 14px; letter-spacing:.02em;
       transition: filter .15s, transform .08s, box-shadow .15s, background .15s; }
.btn:active { transform: translateY(1px) scale(.98); }
.btn-primary { background: var(--grad-btn); color:#fff; box-shadow: var(--shadow-btn); }
.btn-primary:hover { filter: brightness(1.06); }
.btn-outline { background: var(--surface); border:1px solid var(--border-input); color: var(--text-2); }
.btn-outline:hover { color: var(--primary); border-color: var(--primary); }
.btn-danger  { background: var(--surface); border:1px solid rgba(240,62,62,.3); color: var(--red); }
.btn-danger:hover { background: rgba(240,62,62,.06); }
.btn-success { background: linear-gradient(180deg, #4CC264, #2F9E46); color:#fff; }  /* 导出用 */
.btn-sm { padding: 4px 10px; font-size: 11px; border-radius: var(--r-sm); }
```

### 5.4 表格 `.data-table`

- 外层容器即 `.card`（r-lg + 描边 + shadow-card），表格 `border-collapse: separate; border-spacing: 0;`。
- 表头：`background: var(--input-bg); color: var(--text-2); font-size:11px; letter-spacing:.05em; text-transform:uppercase;` 首/末单元格带 10px 圆角；去掉强制大写对中文无影响，保留。
- 行：`border-bottom: 1px solid var(--divider)`；hover `background: var(--input-bg)`；展开行 `background: var(--banner-info-bg)`。
- 行内联输入框（别名/默认PIN/姓名那三个）：统一 `.cell-input` class（`--input-bg` 底 + `--border-input` 边 + r-sm + focus 环），替换现有的 `style="width:90px;padding:4px 6px;..."` 内联串。
- 未同步标记行：`background: rgba(240,62,62,.05)`（保留语义，换成变量写法 `.row-warn`）。

### 5.5 徽章 `.badge`（全部 pill 化）

`border-radius: var(--r-pill); padding: 3px 10px; font-size: 11px; font-weight: 600;`，色板（light / dark 自动随变量）：

| 徽章 | 底色 | 字色 |
|---|---|---|
| PC | `rgba(var(--primary-rgb),.12)` | `--primary` |
| 手机 | `rgba(123,44,191,.12)` | `--purple` |
| 在线/插件/对账OK | `rgba(64,192,87,.14)` | `--green` |
| 离线 | `var(--surface-2)` | `--text-2` |
| 手机来源 | `rgba(240,140,0,.13)` | `--orange` |
| CRM同步 | `rgba(var(--primary-rgb),.10)` | `--primary-dark` |
| 对账异常 | `rgba(240,62,62,.12)` | `--red` |

### 5.6 输入框 / 下拉

```css
.input, select.input {
  height: 36px; background: var(--input-bg); border: 1px solid var(--border-input);
  border-radius: var(--r-md); padding: 0 12px; font: inherit; font-size: 13px;
  color: var(--text); outline: none; transition: border-color .15s, box-shadow .15s, background .15s;
}
.input:focus { border-color: var(--primary); background: var(--surface);
               box-shadow: 0 0 0 3px rgba(var(--primary-rgb),.14); }
```

筛选区 `.filters` 的 label 改为 `11px / 600 / --text-2`，不再 `text-transform: uppercase`（中文无大写，纯多余）。

### 5.7 弹窗 `.modal`（含登录框、编辑框、导入框）

- 遮罩：`rgba(12,18,32,.45) + backdrop-filter: blur(4px)`。
- 框体：`border-radius: var(--r-xl); box-shadow: var(--shadow-float); padding: 28px;` 顶部带 8px 高 `var(--grad-btn)` 渐变条（`::before`），标题 17px/700 左 + 关闭 × 图标钮右。
- 表单 label `12px/600/--text-2`；输入框用 5.6 规范；按钮组右对齐，主按钮渐变。
- 登录框加品牌头：logo 底座 + "AutoDial 云中转" + 副标题，其余同上。

### 5.8 日志终端

保留深色终端但收进设计系统：`background: #0D1526`（固定深空蓝，不随主题）、`border-radius: var(--r-md)`、4 级配色 `info:#7EB6FF / warn:#F0B429 / error:#FF6B6B / 默认:#C9D6E8`、自定义滚动条（6px，`--surface-2` 滑块）。

### 5.9 Toast 通知系统（新增，替换全部 alert/confirm 的成功/失败提示）

```js
function toast(msg, type) { /* type: success|error|info，右上角堆叠，3s 自动消失，可点 × 关闭 */ }
```

样式：`--surface` 卡 + 左侧 3px 语义色条 + 图标 + `box-shadow: var(--shadow-float)` + r-md。
**注意**：`confirm()` 保留（删除确认需要阻塞选择，改为自定义确认弹窗属于可选加分项，非必须）；`alert()` 全部替换为 `toast()`——被替换的 alert 字符串文案不变。函数 `showAdminMsg`、`settings-msg`、`import-result` 等原位行内提示保留不动。

### 5.10 空状态 / 加载

`.empty-state`：48px 线性 SVG 图标（--text-2，30% 透明度）+ 13px 文案；加载中统一转圈 SVG 动画（不新增依赖，CSS keyframes 旋转）。

### 5.11 图表（Chart.js 配置改造，canvas id 全部不变）

新增辅助函数读 CSS 变量，所有图表色板改为运行时取主题色：

```js
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
// 主色系列：cssVar('--primary')、'--primary-light'、'--green'、'--red'、'--orange'、'--purple'
// 网格线：rgba(var(--primary-rgb) 不行，直接用) —— 网格用固定 rgba(120,140,170,.12)，坐标轴文字用 cssVar('--text-2')
// 折线填充：primary 渐变（ctx.createLinearGradient 从 primary@18% 到 0%）
// 圆角：柱状图 borderRadius: 6（手机端圆角语言的延伸）
// 字体：Chart.defaults.font.family 设为全局栈，size 11
```

主题切换时销毁重建当前页图表（各 render 函数已有 destroy 逻辑，直接重调即可）。

---

## 六、页面级重设计要点（8 页，id 全保留）

| 页面 | 结构改动 |
|---|---|
| 首页总览 `page-dashboard` | 顶部新增 Hero 横幅（5.2）；统计卡 5 张按 5.1 重做；两张图表卡 + 最近连接表不变（表换 5.4 样式） |
| 手机管理 `page-phones` | 筛选条收进卡片头部一行（状态 select + 搜索框带图标前缀 + 刷新图标钮）；表格 10 列不变；展开行样式用 `--banner-info-bg`；`showPhoneDetail` 的 alert 改 toast 或小型详情弹窗 |
| 通话记录 `page-calls` | 筛选条 6 控件一行排布（≤1100px 换行）；分页条改 pill 按钮组；导出按钮 btn-success |
| 上门登记 `page-visits` | 筛选条同上；表格 11 列不变；"未同步"从 ✅/⚠ 文字改成 badge（已同步=绿 pill，未同步=红 pill）；趋势图卡不变 |
| 人员管理 `page-pins` | 头部工具行（分组筛选 + 新建分组输入 + 两个按钮）收进卡片 header；行内 select/input 换 `.cell-input` |
| 管理账号 `page-admin-accounts` | 两卡（账号列表 + 改密码）布局不变，表单控件全部换规范样式 |
| 系统日志 `page-logs` | 搜索框 + 条数 select 收一行；终端 5.8；下方统计卡/图表/明细表换规范样式 |
| 设置 `page-settings` | 改卡片分组（服务器设置组 / 系统信息组），系统信息表改定义列表样式（label 左 --text-2，值右等宽）；`saveSettings` 行为不变 |

---

## 七、主题系统（多主题，低成本高收益）

### 7.1 数据源

直接**复制** `AutoDial-Extension/themes.js` 的 `AD_THEMES`（9 套：天空蓝/暗金/冰蓝冷峻/深空紫/赛博朋克/极简白/森林绿/活力橙/海洋蓝）、`_adHexRgb`、`_adBlend`、`AD_THEME_VARS` 四个成员进 dashboard.html 的 `<script>`（约 130 行，已在线上验证过）。再补一个天空蓝 dark 变体（3.2 表的值）。

### 7.2 应用机制

```js
function applyTheme(id) {
  var v = AD_THEME_VARS(id);              // 扩展端同款派生
  var r = document.documentElement.style;
  // 把 v 映射到第三节的 CSS 变量名并 r.setProperty(...)
  // --bg/--surface/--surface-2/--input-bg/--icon-tile/--border/--border-input/
  // --divider/--hero-border/--hero-top/--text/--text-2/--primary/--primary-light/
  // --primary-dark/--green/--red/--banner-info-bg/--banner-info-border/--primary-rgb
  document.documentElement.dataset.theme = id;   // 供暗色微调选择器用
  localStorage.setItem('__ad_theme', id);        // 与扩展端同一 storage key 名
}
```

顶栏主题入口：调色板 SVG 图标钮，点击展开下拉（10 项 = 9 主题 + 天空蓝·暗），当前项打勾，swatch 用主题渐变圆点（参考 content-script.js L1097-1145 的主题菜单写法）。初始化：`applyTheme(localStorage.getItem('__ad_theme') || 'sky-blue')`。
切换主题后：若当前页图表存在则重调对应 render 函数重建（色板随主题）。

### 7.3 降级

若实现者对 7.1 的变量映射没有把握，**允许只交付"天空蓝 light + 天空蓝 dark"两套手写变量块 + 顶栏日月切换钮**，其余 8 套列为后续迭代。这是保底方案，不影响本方案其他所有章节成立。

---

## 八、版本号

`<title>` 与登录框/侧边栏版本文案：`管理面板 v5.0` → `v6.0`；系统信息页 `5.0 (UX Redesign)` → `6.0 (Sky Design System)`。README 端口表、CHANGELOG 由维护者另行更新，实现者不管。

---

## 九、冻结清单（实现者严禁改动）+ 测试同步

### 9.1 DOM id（80 个，一个不能少、不能改名）

`page-dashboard page-phones page-calls page-visits page-pins page-logs page-settings page-admin-accounts`、
`hdr-port hdr-uptime hdr-conn refresh-label last-refresh api-url`、
`stat-today-dials stat-today-visits stat-phones stat-pcs stat-active-names recent-clients conn-chart msg-chart`、
`phone-count phone-status-filter phone-search phones-list`、
`calls-total call-device-filter call-date-from call-date-to call-number calls-list calls-pagination`、
`visit-filter-pin visit-filter-group visit-filter-date-from visit-filter-date-to visit-filter-source visits-list visit-chart`、
`visit-edit-modal visit-edit-id visit-edit-name visit-edit-mobile visit-edit-kefu_tel visit-edit-type`、
`import-modal import-raw import-parse-msg import-preview-area import-submit-btn import-count-label import-result`、
`pins-list pin-group-filter new-group-name`、
`admin-accounts-list new-admin-user new-admin-pass chpwd-id chpwd-newpass admin-msg`、
`log-search log-lines log-container stats-total-msg stats-bytes-sent stats-bytes-recvd log-daily-chart log-pin-chart daily-stats`、
`setting-port setting-log-level settings-msg`、
`login-overlay login-user login-pass login-err login-btn logout-btn`。

### 9.2 全局函数（66 个，onclick/onchange 引用，必须仍挂在全局作用域）

`showPage refreshAll loadDashboard loadPhones loadCalls loadVisits loadPins loadLogs loadLogStats loadAdminAccounts loadPinDropdown loadCallDeviceOptions onPinFilterChange callSearchDebounce togglePhoneHistory showPhoneDetail setDeviceLabel setDeviceDefaultPin openEditModal closeEditModal saveVisitEdit deleteVisit exportCSV exportCallsCSV showImportModal closeImportModal parseImportData renderImportPreview editImportCell updateImportCount submitImport setPinGroup setAdvisorName addGroup delGroup addAdminAccount delAdminAccount chpwdAdminAccount showAdminMsg saveSettings showLogin hideLogin submitLogin doLogin doLogout getSessionToken setSessionToken clearSessionToken isLoggedIn apiGet withToken esc escA fmtBytes fmtUptime timeAgo mapHeader detectDelimiter renderConnChart renderMsgChart renderLogDailyChart renderLogPinChart renderPhoneHistoryDetail renderVisitChart _loadCallsInternal startAutoRefresh`（另有全局变量 `callsOffset` 必须保留）。

### 9.3 行为契约

1. 所有 API URL、请求参数、`token` 附加方式（`withToken`/`apiGet`）一字不改。
2. `exportCSV`/`exportCallsCSV` 依赖 `#visits-list tr td` / `#calls-list tr td` 的**列数与列序**取 `textContent`——表格列不得增删换序。
3. `localStorage` key `__ad_session_token` 不变；新增 `__ad_theme` 是允许的新增项。
4. Chart.js CDN 标签保留（测试断言 `chart.js` 字样）。
5. JS 里禁止出现 `{{`、禁止 `document.write`、模板字符串反引号必须配平、至少使用 const/let（现有测试断言）。
6. 表头文字 `当前登录人`、`当前PIN` 保留（测试断言）。
7. 非 `<script>` 区域内 `<div>` 开闭数量必须相等（现有测试断言）。

### 9.4 测试同步（本方案唯一允许的测试改动）

`test_cloud_relay_v2.py::TestDashboardHTML`：
- `test_seven_tabs`：期望值 `7` → `8`，方法名/文档字符串改为 "exactly 8 tab pages"。
- `test_tab_names`：`expected_tabs` 列表追加 `'admin-accounts'`。
原因：v4.12 已上线第 8 页，测试漏更（当前本就红着）。改完应全绿。

---

## 十、实施顺序（建议分 5 步提交，每步可独立验收）

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | `<style>` 全量重写：Token 变量块（light + dark）+ App Shell + 全部组件 class；HTML 骨架改为 sidebar/topbar/content | 浏览器打开，8 页切换正常、无横向滚动、两档响应式正常 |
| 2 | JS 拼接 HTML 去内联样式化（loadPhones/loadVisits/loadPins/loadAdminAccounts/renderImportPreview 等），接 `.cell-input`/`.badge`/`.row-warn` | 各页数据渲染与改前一致，CSV 导出内容一致 |
| 3 | SVG 图标集替换 emoji（导航 8 枚 + 卡片标题 + 按钮 + 状态）；Toast 替换 alert | 全文无功能性 emoji；操作反馈均 Toast |
| 4 | 主题系统（applyTheme + 顶栏切换 + localStorage + 图表取色 cssVar 化 + 切主题重建图表） | 切暗色/其他主题全站生效，刷新后保持 |
| 5 | 修 9.4 两条测试 + 全量回归 | `pytest test_cloud_relay_v2.py -k "Dashboard or JavaScript"` 全绿 |

---

## 十一、验收清单

- [ ] 默认打开 = 天空蓝亮色，与手机端默认主题同源；切到暗色/其余主题全站无硬编码残留色
- [ ] 布局为侧边栏 App Shell；1366×768 与 1920×1080 下无换行/溢出；≤1100px 收图标栏，≤768px 抽屉
- [ ] 统计卡为"图标底座+大数字"手机端样式，hover 抬升；首页有 Hero 状态横幅
- [ ] 全文无 emoji 功能图标；SVG 统一 24 viewBox / stroke 1.8 / round
- [ ] 所有按钮/输入框/表格/徽章/弹窗样式来自 Token；JS 拼接 HTML 无内联颜色
- [ ] alert 全部变 Toast；删除确认仍可用 confirm
- [ ] 8 页全部功能回归：登录/退出、15s 自动刷新、手机展开历史、通话分页/导出、登记筛选/编辑/删除/导出/批量导入、人员分组、日志搜索、设置保存提示
- [ ] 冻结清单 80 id + 66 函数逐项 diff 确认零丢失
- [ ] `pytest test_cloud_relay_v2.py` 全绿（含修正后的 8-tab 断言）

---

## 十二、给实现模型的硬性约束（贴在任务开头）

1. 只改 `cloud-relay/python/dashboard.html` 一个文件 + `test_cloud_relay_v2.py` 两条断言；其余文件一行不动。
2. 不引入任何新外部依赖/框架/构建步骤；只允许保留 Chart.js CDN；全部 CSS/JS 内联在该 HTML 内。
3. 先复制现有文件备份为 `dashboard.html.bak` 再动手。
4. 严格保留第九节全部 id、函数名、API URL、表格列序。
5. 每完成一步在浏览器（或简单 HTTP 静态服务）打开检查控制台零报错。
