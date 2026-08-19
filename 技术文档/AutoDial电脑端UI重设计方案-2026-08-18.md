# AutoDial 电脑端 UI 重设计方案

> 版本：2026-08-18 | 目标：电脑端 v6.1（UI 重设计）
> 适用目录：`pc-app-go/frontend/`（Wails 单文件版；Electron 版移植见附录 B）
> 设计基准：手机端 `ThemeManager`（android-app）+ 插件端 v5 规范（`AutoDial-Extension/popup.html`、`themes.js`，见《AutoDial插件端UI重设计方案-2026-08-17》）
> 性质：**整体重设计**（设计 token 重建 + 主窗口结构重组 + 设置面板修复重建），不是现有样式的缝补
> 执行模型：deepseek-flash 等低成本模型。本方案已把所有决策做完，实现者**只照做、不自由发挥**

---

## 〇、给实现者的执行提示（先读这个）

1. 本方案改动 4 个前端文件 + 2 个 Go 文件（各 2 行）：
   - `pc-app-go/frontend/index.html`（主战场：CSS 全重写 + HTML 重排 + 补齐设置面板 JS）
   - `pc-app-go/frontend/js/theme.js`（变量注入升级）
   - `pc-app-go/frontend/themes/theme-data.js`（只改最后 2 行默认值）
   - `pc-app-go/frontend/wails-adapter.js`（只加 1 个 case）
   - `pc-app-go/app.go`（GetSettings 补 2 个字段）
   - `pc-app-go/settings.go`（默认主题 2 行）
2. **所有 DOM id 一律保留**（第九节冻结清单）。本方案是"换皮 + 重组 + 修复"，不是重写业务逻辑。
3. 只允许新增/修改第九节明确列出的 JS 文案点和第七节列出的新函数；其余 JS 一行不动。
4. 每完成一步，按第十节的验证方法确认后再做下一步。
5. 禁止引入任何框架/构建工具/外部字体/图标库。图标全部用第八节给的内联 SVG。

---

## 一、现状审计（为什么需要重设计）

### 1.1 电脑端 UI 面清单（pc-app-go/frontend/index.html，1844 行单文件）

| 区域 | 现状 |
|---|---|
| 自定义标题栏 `.titlebar` | 36px，金色渐变 logo 块 + emoji 📞，字距 2px 的"HUD"风格 |
| 状态栏 `.header` | IP / 配对码两个 chip + 状态点 + 2 个重启图标 + 置顶开关，一条 10 个元素挤在一起 |
| 大状态区 `.status-display` | 60px 圆形 emoji 图标（📵/✅）+ 大字状态，与状态栏**重复表达同一状态** |
| 连接横幅 `.banner` | 第三条状态表达（绿色横条），连接后界面出现三层"已连接" |
| 手机选择器 `.phone-selector` | tag 样式，active 态用硬编码 `rgba(201,168,76,*)` 金色 |
| 号码卡 `.number-box` | 2px 粗边框 + 9px 大写微标签（letter-spacing 1px） |
| 拨号盘 `.dialpad` | 默认折叠，按钮 r18 圆角 |
| 拨打/挂断 `.call-btn/.hangup-btn` | 渐变按钮可用，但 **disabled 态是红字**（语义错误：禁用≠危险） |
| 短信入口 `.sms-btn` | 虚线描边按钮 + 模板 chip |
| 日志 `.log-section` | 折叠卡，样式可用但语言不统一 |
| 设置浮层 `#settingsOverlay` | **全部内联样式**（约 30 处 `style="..."`），且 JS 函数 `setSelect/selectMode/settingChanged/saveAllSettings/renderThemeGrid` **全部缺失**——主题网格渲染不出来、保存按钮是死的 |
| 短信浮层 `#smsOverlay` | 类样式但发送按钮**硬编码金色渐变**，16 套主题下只有金色系正常 |
| 模板管理 `#tplManagerOverlay` | 可用，语言不统一 |
| 悬浮条 `#floatbar` + 右键菜单 `#fbMenu` | 毛玻璃风格（全端唯一亮点），但按钮全靠 emoji，菜单硬编码暗色 |

### 1.2 核心问题

1. **主题系统名存实亡（Go 版）**：`theme.js` 调 `window.api.invoke('get-theme-setting')`，但 `wails-adapter.js` 没有实现这个通道 → 永远回退到 `DEFAULT_THEME='dark-gold'` + `DEFAULT_MODE='dark'`。而 Go 端 `settings.go` 默认值是 `lavender/light`，`theme-data.js` 默认是 `dark-gold/dark`，**三处默认值互不一致**。用户看到的永远是暗金暗色，16×7 主题数据形同虚设。
2. **设置面板是坏的**：HTML 里引用的 5 个 JS 函数不存在（主题网格空、模式选择死、保存死）。
3. **硬编码金色渗透全文件**：`rgba(201,168,76,…)` 出现 15+ 处，`#C9A84C/#8B6914/#F0C040` 写死在短信发送按钮等处——换任何非金主题都露馅。
4. **变量命名是 dark-gold 时代的遗物**：`--gold/--gold-light/--gold-dark`，与手机端/插件端的 `--primary*` 语义体系不一致。
5. **emoji 当功能图标**：📞📵💬📝☁⟳📋✅🔍📱⚙🌑 等 20+ 处，违反手机端规范（功能图标必须矢量）。
6. **三重状态条**（header 点 + status-display 大字 + banner 横幅）重复表达连接状态，浪费纵向空间（窗口只有 420×780）。
7. **风格老化**：9px 大写微标签、2px 粗边框、虚线按钮、28px 超大圆角混杂 10px 小圆角，无统一阴影/圆角/motion 体系。

---

## 二、设计目标

1. **一套设计系统**：与插件端 v5 / 手机端同源——同一套 token 名、同一套派生规则、同一套圆角/阴影/字号/motion。
2. **主窗口结构重组**：三重状态条合并为一个 **Hero 状态大盘**（对齐手机端 heroCard），信息归组，主操作突出。
3. **修复并重建设置面板**：主题网格 + 7 模式选择 + 保存全部可用，外观对齐插件端分组卡规范。
4. **16×7 主题真正生效**：所有颜色只来自 token，禁止硬编码色值（`currentColor`、白字、状态色除外）；默认主题统一为 **sky-blue × light**（对齐手机端默认）。
5. **零功能回归**：所有 DOM id、IPC 通道、拖拽/缩放/轮询逻辑、z-index 不动（见第九节冻结清单）。

---

## 三、设计 Token（唯一权威值）

### 3.1 基础色（运行时由 theme.js 从 THEME_DATA 注入，不硬编码）

| 新 token | 来源字段（THEME_DATA 每个 mode） | 旧 token（废弃） |
|---|---|---|
| `--bg` | `bg` | `--bg`（保留） |
| `--surface` | `bg2` | `--bg2`（改名） |
| `--surface-2` | `bg3` | `--bg3`（改名） |
| `--text` | `text` | `--text`（保留） |
| `--text-2` | `text2` | `--text2`（改名） |
| `--primary` | `gold` | `--gold`（改名） |
| `--primary-light` | `goldLight` | `--gold-light`（改名） |
| `--primary-dark` | `goldDark` | `--gold-dark`（改名） |
| `--green` / `--red` | `green` / `red` | 保留 |
| `--floatbar-bg/-border/-blur` | `floatbarBg/Border/Blur` | 保留 |
| `--gradient-green` / `--gradient-red` | `style.gradientGreen/Red` | 保留（拨打/挂断按钮用） |

### 3.2 派生色（theme.js 运行时 blend 计算，规则与插件端 `themes.js` 逐字一致）

`blend(a,b,p) = a×(100−p)/100 + b×p/100`（按 RGB 通道，四舍五入）：

| token | 规则 | 用途 |
|---|---|---|
| `--input-bg` | blend(surface, surface-2, 55) | 输入框底色 |
| `--icon-tile` | blend(surface, primary, 8) | 图标底座 |
| `--border` | blend(surface, text-2, 26) | 卡片描边 |
| `--border-input` | blend(surface, text-2, 20) | 输入框描边 |
| `--divider` | blend(surface, text-2, 14) | 行内分割线 |
| `--hero-border` | blend(surface, primary, 52) | 大盘描边 |
| `--hero-top` | blend(surface, primary, 5) | 大盘渐变顶 |
| `--banner-info-bg` | blend(surface, primary, 10) | 信息横幅底 |
| `--banner-info-border` | blend(surface, primary, 32) | 信息横幅边 |
| `--primary-rgb` | primary 的 `r,g,b` 三元组 | rgba() 用 |
| `--grad-btn` | `linear-gradient(180deg, primary-light, primary-dark)` | 主按钮 |
| `--grad-hero` | `linear-gradient(180deg, hero-top, surface)` | 大盘 |

sky-blue × light 下各派生值（`index.html` 的 `:root` 兜底值照抄这一行组，与插件端 popup.html 相同）：

```css
--bg:#EBF4FF; --surface:#FFFFFF; --surface-2:#D8ECFC;
--input-bg:#F4F8FC; --icon-tile:#EDF5FD; --border:#DCEAF7;
--border-input:#DFEBF6; --divider:#E4EBF1;
--hero-border:#BFD9F2; --hero-top:#EDF4FC;
--text:#162840; --text-2:#5880A8;
--primary:#2B6CC4; --primary-light:#4A90E0; --primary-dark:#1A56A8;
--green:#40C057; --red:#F03E3E;
--banner-info-bg:#E3EEFB; --banner-info-border:#C4DAF3;
--primary-rgb:43,108,196;
```
（运行时 blend 计算值与兜底值允许 ±3 色差，属正常。）

### 3.3 圆角体系（固定 4 档，**不随主题变化**，不再消费 THEME_DATA.style 的 radius*）

| 档位 | 值 | 用途 |
|---|---|---|
| `--r-sm` | `10px` | 输入框、小按钮、图标底座、chip |
| `--r-md` | `14px` | 浮层卡、拨号键、菜单 |
| `--r-lg` | `18px` | 内容卡、大盘、主按钮 |
| `--r-pill` | `999px` | 状态点、版本徽章、悬浮条、toast |

### 3.4 阴影体系（固定 3 档，用 `--primary-rgb` 随主题变色）

```css
--shadow-card:  0 1px 2px rgba(22,40,64,.04), 0 4px 14px rgba(var(--primary-rgb),.07);
--shadow-float: 0 6px 24px rgba(var(--primary-rgb),.18), 0 0 0 1px rgba(var(--primary-rgb),.10);
--shadow-btn:   0 3px 10px rgba(var(--primary-rgb),.28);
```

### 3.5 字号体系

| 用途 | 字号/字重 |
|---|---|
| 大盘状态标题 | 15px / 700 |
| 浮层标题、卡标题 | 14px / 700 |
| 正文、按钮 | 13px / 500–600 |
| 辅助说明 | 12px / 400–500 |
| 状态行、徽章 | 11px / 500 |
| 号码输入框 | 24px / 700（保留现状） |

全局：`font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; letter-spacing:.02em;`
**废除** 9px/10px 大写微标签写法（`text-transform:uppercase; letter-spacing:1~2px`）。

### 3.6 间距

窗口内容区 padding 14px；卡片间距 12px；卡片内边距 14px；行内垂直间距 10px；行 gap 10px。

### 3.7 Motion

| 场景 | 参数 |
|---|---|
| hover | `filter:brightness(1.06)` 或底色变浅，150ms |
| press | `transform:translateY(1px) scale(.98)`，80ms |
| 输入框 focus | border 变 `--primary` + `box-shadow:0 0 0 3px rgba(var(--primary-rgb),.14)` |
| 浮层入场 | `opacity 0→1`，180ms ease-out |
| 状态点脉冲 | 外圈 3px→6px 呼吸，2s 循环（沿用现有 keyframes） |
| 拨号键 press | `scale(.93)`（沿用） |

---

## 四、主题系统改造

### 4.1 `js/theme.js` 改造（唯一 JS 逻辑改动点）

**(a) COLOR_MAP 改名**（值是注入后的 CSS 变量名）：

```js
const COLOR_MAP = {
  gold: 'primary', goldLight: 'primary-light', goldDark: 'primary-dark',
  bg: 'bg', bg2: 'surface', bg3: 'surface-2',
  text: 'text', text2: 'text-2',
  green: 'green', red: 'red',
  floatbarBg: 'floatbar-bg', floatbarBorder: 'floatbar-border', floatbarBlur: 'floatbar-blur'
};
```

**(b) 新增派生注入**（放在 `setCSSVars(colorVars);` 之后）：

```js
// —— 派生 token（规则与插件端 themes.js 一致）——
function _hexRgb(h){ const n=parseInt(h.slice(1),16); return [(n>>16)&255,(n>>8)&255,n&255]; }
function _blend(a,b,p){
  const A=_hexRgb(a),B=_hexRgb(b);
  return '#'+[0,1,2].map(i=>{
    const v=Math.round(A[i]*(100-p)/100+B[i]*p/100);
    return v.toString(16).padStart(2,'0');
  }).join('').toUpperCase();
}
// applyTheme 内，colors 取出后追加：
const derived = {
  inputBg:      _blend(colors.bg2, colors.bg3, 55),
  iconTile:     _blend(colors.bg2, colors.gold, 8),
  border:       _blend(colors.bg2, colors.text2, 26),
  borderInput:  _blend(colors.bg2, colors.text2, 20),
  divider:      _blend(colors.bg2, colors.text2, 14),
  heroBorder:   _blend(colors.bg2, colors.gold, 52),
  heroTop:      _blend(colors.bg2, colors.gold, 5),
  bannerInfoBg:    _blend(colors.bg2, colors.gold, 10),
  bannerInfoBorder:_blend(colors.bg2, colors.gold, 32),
};
setCSSVars(derived);
const root = document.documentElement;
root.style.setProperty('--primary-rgb', _hexRgb(colors.gold).join(','));
root.style.setProperty('--grad-btn',  `linear-gradient(180deg, ${colors.goldLight}, ${colors.goldDark})`);
root.style.setProperty('--grad-hero', `linear-gradient(180deg, ${derived.heroTop}, ${colors.bg2})`);
```

**(c) STYLE_MAP 不动**（继续注入 `--radius-*` 等，新 CSS 不消费即可，无害）。`glowText`、`update-bg-color` 通知逻辑不动。

### 4.2 `themes/theme-data.js`：只改最后 2 行

```js
var DEFAULT_THEME = 'sky-blue';   // 原 'dark-gold'
var DEFAULT_MODE  = 'light';      // 原 'dark'
```
16 套主题数据一字不动。

### 4.3 Go 版接线修复（让主题真正生效）

| 文件 | 改动 | 说明 |
|---|---|---|
| `wails-adapter.js` `invoke()` | 加 1 个 case：`case 'get-theme-setting': return await window.go.main.App.GetSettings();` | theme.js 的 initTheme 不改就能拿到 `{theme, mode}` |
| `app.go` `GetSettings()` | 返回 map 补 2 个键：`"mode": appSettings.Mode,` `"silentStart": appSettings.SilentStart,` | 现状漏了这两个字段 |
| `settings.go` `defaultSettings()` | `Theme: "sky-blue",`（原 lavender） | 三处默认值统一为 sky-blue/light |

### 4.4 全文变量替换校验表

index.html 的 CSS 重写后，全文禁止再出现：`--gold`、`--gold-light`、`--gold-dark`、`--bg2`、`--bg3`、`--text2`、`--radius-sm/md/lg`、`--shadow)`（单阴影变量）、`rgba(201,168,76`、`#C9A84C`、`#8B6914`、`#F0C040`。替换关系见 3.1/3.2。

---

## 五、主窗口重设计（index.html 上半部分）

**结构原则**：`.header` + `.status-display` + `.banner` 三条合并为一个 Hero 大盘；所有 id 保留（9 节冻结清单），只改 HTML 排布与 CSS。

### 5.1 新结构线框（窗口 420×780，最小 360×600 不变）

```
┌ .titlebar（36px，surface 底，1px divider 下边框）─────────────┐
│ [图标底座20·grad-btn·r-sm·电话SVG] AutoDial      [⚙][—][✕] │
├ .body（padding 14，gap 12，纵向滚动）─────────────────────────┤
│ ┌ Hero 大盘 .hero-card（grad-hero + hero-border + r-lg + ───┐ │
│ │ shadow-card，pad 14）                                     │ │
│ │ 行1: [40px 圆底座 #statusIcon]  #statusTextLarge 15/700   │ │
│ │      #statusSubtext 12/text-2        [置顶 pill 开关]     │ │
│ │ 行2(信息 chip 行): (●#statusDot #statusText)              │ │
│ │      [IP #localIP] [配对码 #pinCode(可点)]  [☁][⟳]        │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ #banner（连接成功才显示，绿底 tint 卡，r-md）─────────────┐ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ #phoneSelector（多手机才显示）────────────────────────────┐ │
│ │ (●)手机A(备注) [⟳]   (●)手机B [⟳]   ← pill tag 横向排列  │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ 号码卡 .number-box（surface + r-lg + shadow-card，pad 12）┐ │
│ │ 号码                              #clipHint（剪贴板提示） │ │
│ │ 13800138000________________  ← 24px/700，无边框           │ │
│ │ [清除 ghost-sm]              [☎ 拨号盘 ghost-sm 可折叠]   │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ #dialpad（grid 3列 gap 8，折叠态不变）───────────────────┐ │
│ │ [1] [2 ABC] [3 DEF] … ← surface 卡键，r-md，press .93    │ │
│ └──────────────────────────────────────────────────────────┘ │
│ [ 📞 拨打 (gradient-green, r-md, h46) ] [ 📵 挂断 (gradient-red) ] │
│ [ 💬 发短信 ghost pill（实线边框，废虚线） ]                 │
│ [模板chip] [模板chip] [模板chip] …  ← input-bg pill          │
│ ┌ 日志卡（surface + r-lg）────────────────────────────────┐ │
│ │ 📝 日志                                              [▼] │ │
│ │ （展开后）12:00:01 已发送: 138…   ← 左 2px 语义色条      │ │
│ └──────────────────────────────────────────────────────────┘ │
└ .toast（pill，surface + shadow-float，底部居中）─────────────┘
```

### 5.2 逐区域规格

**(a) `.titlebar`**：底 `var(--surface)`，下边框 `1px solid var(--divider)`（废掉 gold-dark 边框）。logo 改为：20px r-sm 图标底座（`background:var(--grad-btn)`，内嵌 12px 白色电话 SVG，第八节）+ "AutoDial" 13px/700 `var(--text)`（废 letter-spacing:2px、废 gold-light 色）。窗口按钮宽 40px 高 36px，`color:var(--text-2)`，hover `background:var(--input-bg); color:var(--text)`，close hover `#C42B1C` 保留。`--wails-draggable` 属性保留。

**(b) Hero 大盘 `.hero-card`**（新 class；HTML 由 `.header` 和 `.status-display` 的内容合并而成）：
- 容器：`background:var(--grad-hero); border:1px solid var(--hero-border); border-radius:var(--r-lg); box-shadow:var(--shadow-card); padding:14px;`
- `#statusIcon`：40px 圆形底座 `background:var(--icon-tile)`，内嵌电话 SVG（`color:var(--primary)`）；`.connected` 时改绿色描边环 `box-shadow:0 0 0 3px rgba(green,.16), 0 0 12px rgba(green,.35)` + 现有 pulse 动画。**JS 里两处 `statusIcon.textContent = '📵'/'✅'` 允许改为 innerHTML SVG**（见 5.4）。
- `#statusTextLarge` 15px/700 `var(--text)`；`#statusSubtext` 12px `var(--text-2)`。
- 信息 chip 行：每个 chip = `display:inline-flex; align-items:center; gap:6px; background:var(--surface); border:1px solid var(--border); border-radius:var(--r-pill); padding:4px 10px; font-size:11px; color:var(--text-2);`，值 `color:var(--text); font-weight:600`。`#pinCode` 保留 cursor:pointer 与点击改 PIN 逻辑。
- `#statusDot`（8px 圆点，`.on` 绿色发光 + pulse）与 `#statusText`（11px）放入第一个 chip。
- `#restartCloudIcon`/`#restartAppIcon`：22px r-sm 图标底座按钮（`background:var(--icon-tile); color:var(--text-2)`，hover `color:var(--primary)`），emoji ☁/⟳ 换成 SVG（第八节），保留 `.spinning` 动画与 id。
- `.topmost-switch`：轨道改 `background:var(--surface-2); border:1px solid var(--border)`，checked 时 `background:var(--primary); border-color:var(--primary)`，滑块白色。结构/id 不动。

**(c) `#banner`**：改为 `background:rgba(green,.10)` → 用 `color-mix` 或固定写法：`background:var(--banner-info-bg); border:1px solid var(--green); color:var(--green); border-radius:var(--r-md); padding:8px 12px; font-size:12px; font-weight:600; text-align:center;`。显隐 class 逻辑（`.show`）不动。

**(d) `#phoneSelector` / `.phone-tag`**：tag 改 pill：`border-radius:var(--r-pill); background:var(--surface); border:1px solid var(--border); padding:6px 12px; font-size:12px; color:var(--text-2);`。`.active` 态：`border-color:var(--primary); color:var(--primary); background:rgba(var(--primary-rgb),.08);`（**废掉全部硬编码 rgba(201,168,76,…)**）。`.phone-dot`、`.phone-note-hint`、`.phone-reconnect-btn`（hover `color:var(--primary); border-color:var(--primary)`）、`.phone-rename-input`（input 规范：input-bg + border-input + focus ring）保留 class 与行为，只换 token。

**(e) `.number-box`**：`background:var(--surface); border:1px solid var(--border); border-radius:var(--r-lg); box-shadow:var(--shadow-card); padding:12px 14px;`（**废 2px 粗边框**）。`:focus-within` 改 `border-color:var(--primary); box-shadow:0 0 0 3px rgba(var(--primary-rgb),.14);`。`.number-lbl` 改 12px/500 `var(--text-2)`（废 9px 大写）。`#clipHint` 11px `var(--primary)`，保留 `.flash` 动画。`.number-input` 24px/700、`caret-color:var(--primary)` 保留。`.btn-clear` 改 ghost 小按钮：`background:var(--surface); border:1px solid var(--border); color:var(--text-2); border-radius:var(--r-sm); padding:6px 14px; font-size:12px;`，hover `border-color:var(--red); color:var(--red);`。
**拨号盘折叠开关 `.dialpad-toggle` 移入号码卡底部按钮行**（HTML 位置移动，id `dialpadToggle` 不变，JS 不用改）：样式与 `.btn-clear` 相同的 ghost 小按钮 + 右侧 ▼ SVG（保留 `.expanded` 旋转）。

**(f) `#dialpad .dial-btn`**：`background:var(--surface); border:1px solid var(--border); border-radius:var(--r-md); padding:9px 0;`。hover `background:var(--input-bg); border-color:var(--border-input);`。`:active` 保留 `scale(.93)` + `border-color:var(--primary); background:rgba(var(--primary-rgb),.08);`。`.num` 18px/600；`.sub` 9px `var(--text-2)`（保留大写字母但去掉 letter-spacing:2px→1px）。`.del .num` 红保留。

**(g) `.call-btn` / `.hangup-btn`**：`border-radius:var(--r-md); height:46px; font-size:15px; font-weight:700; letter-spacing:.02em;`（废 1px 字距）。渐变沿用 `var(--gradient-green)` / `var(--gradient-red)`，hover 保留 brightness(1.15) + 阴影。**`:disabled` 改为 `background:var(--surface-2); color:var(--text-2); opacity:.7; cursor:default;`（废红字）**。

**(h) `.sms-btn`**：ghost pill：`background:var(--surface); border:1px solid var(--border); color:var(--primary); border-radius:var(--r-pill); padding:9px; font-size:13px; font-weight:600;`（**废虚线**）。hover `background:rgba(var(--primary-rgb),.06); border-color:var(--primary);`。`.index-tpl-tag`：`background:var(--input-bg); border:1px solid var(--border-input); border-radius:var(--r-pill); padding:5px 11px; font-size:11px; color:var(--text-2);`，hover `color:var(--primary); border-color:var(--primary);`。

**(i) 日志卡**：`.log-toggle` 改 `background:var(--surface); border:1px solid var(--border); border-radius:var(--r-lg); padding:10px 14px; font-size:13px; font-weight:600; color:var(--text);`（展开时 `border-radius:var(--r-lg) var(--r-lg) 0 0`）。`.log-body` 同卡续接，`border-top:1px solid var(--divider)`。`.log-entry` `background:var(--input-bg); border-radius:var(--r-sm);` 左 2px 语义色条保留（info 色 `var(--gold)`→`var(--primary)`）。

**(j) `.toast`**：`background:var(--surface); border:1px solid var(--border); border-radius:var(--r-pill); box-shadow:var(--shadow-float); padding:9px 18px; font-size:12px; font-weight:500;`。success/error 态保留（字色变 green/red + 边框同色）。

### 5.3 拨号盘/日志/短信按钮上的 emoji 文案

`.dialpad-toggle` 的 `📞`、`.log-toggle` 的 `📝`、`.sms-btn` 的 `💬` 换成第八节 SVG 图标（HTML 内联，flex 布局 gap 6px）。`.number-lbl`「号码」文案保留。

### 5.4 允许改动的 JS 文案点（仅限以下 6 处字符串，其余 JS 不动）

| 位置 | 现状 | 改为 |
|---|---|---|
| `setPhoneConnected()` | `statusIcon.textContent = '✅' / '📵'` | `statusIcon.innerHTML = ICON_PHONE_ON / ICON_PHONE_OFF`（两个 SVG 字符串常量，定义在 script 顶部） |
| `updateCallBtnText()` | `'🔍 请输入号码'` `'🔄 重连手机'` `'📞 拨号'` | 纯文字 `'请输入号码'` `'重连手机'` `'拨 号'`（按钮左侧 SVG 放 HTML 静态部分，disabled 切换不清空它——实现方式：按钮 HTML 改为 `<svg…></svg><span id="callBtnLabel">`，JS 只改 label 文字。hangup 同理加 `hangupBtnLabel`） |
| `updateHangupBtnText()` | `'📱 请连接手机'` `'📵 挂断'` | `'请连接手机'` / `'挂断'`（同上 label 方案） |
| `dial()` | `'⏳ 正在唤醒手机...'` | `'正在唤醒手机…'` |
| `updateFbBtnText()` | 见 7.3 | 见 7.3 |
| `addLog` 调用点的 emoji 前缀 | `📞 已发送:` 等 | 保留不动（状态文案允许 emoji） |

> 注意：`callBtn`/`hangupBtn` 的 MutationObserver 监听 `disabled` 后重写 textContent——改为 label span 方案后，observer 回调里只写 `document.getElementById('callBtnLabel').textContent = …`，`btn.disabled`/`btn.style.pointerEvents` 逻辑原样。

---

## 六、设置浮层重设计 + 缺失 JS 补齐（修复性重建）

### 6.1 结构规格

`#settingsOverlay` 保留 id 与 `display:none/flex` 切换方式。结构改为：

```
┌ 顶栏（44px，surface，1px divider 下边框）──────────────────┐
│ [22px 图标底座 gear SVG] 设置 14/700              [✕ 关闭] │
├ #settingsContent（flex:1，滚动，padding 14，gap 12）───────┤
│ ┌ 分组卡1「窗口行为」（surface + r-lg + shadow-card）─────┐ │
│ │ 行: 关闭按钮行为 + 副标题        [最小化|退出] 段选      │ │
│ │ ─ divider ─                                            │ │
│ │ 行: 托盘图标退出 + 副标题                    [switch]  │ │
│ └────────────────────────────────────────────────────────┘ │
│ ┌ 分组卡2「启动」────────────────────────────────────────┐ │
│ │ 开机自启动 [switch] ─ divider ─ 隐藏界面启动 [switch]  │ │
│ └────────────────────────────────────────────────────────┘ │
│ ┌ 分组卡3「云中转」──────────────────────────────────────┐ │
│ │ 启用云中转 [switch]                                    │ │
│ │ ─ divider ─                                            │ │
│ │ #cloudSection: 摘要/状态/服务器列表/[+添加][测试][获取]│ │
│ └────────────────────────────────────────────────────────┘ │
│ ┌ 分组卡4「外观」────────────────────────────────────────┐ │
│ │ 主题  #themeGrid（grid 4列 gap 8：色点+名称小卡）       │ │
│ │ ─ divider ─                                            │ │
│ │ 显示模式 #modeSelect（7 个 pill 段选，grid 4列）        │ │
│ └────────────────────────────────────────────────────────┘ │
│ [ 💾 保存设置 (grad-btn 主按钮 r-md h44) ] [ 取消 ghost ] │
└ AutoDial v3.4 → 版本号改 v6.1 ─────────────────────────────┘
```

样式规范：
- 分组卡行 = `.set-row`：`display:flex; align-items:center; justify-content:space-between; padding:11px 14px;`，行间 `1px solid var(--divider)`；主标题 13px/600，副标题 11px `var(--text-2)`。
- 段选 `.set-opt`：`background:var(--input-bg); border:1px solid var(--border-input); border-radius:var(--r-sm); padding:5px 12px; font-size:11px; color:var(--text-2);`，`.active`：`background:var(--primary); border-color:var(--primary); color:#fff; font-weight:600;`（废 gold 写法）。
- switch 复用 `.topmost-switch` 的样式语言（轨道 surface-2，checked primary）。
- 按钮：`+ 添加服务器`/`获取列表` = `background:var(--grad-btn); color:#fff; border-radius:var(--r-sm); padding:8px 12px; font-size:12px;`；`测试全部` = ghost。服务器行 `.cloud-server-row` 保留 class，颜色换 token。
- 主题网格项 `.theme-item`：`background:var(--input-bg); border:1px solid var(--border-input); border-radius:var(--r-sm); padding:8px 4px; font-size:11px; color:var(--text-2); text-align:center; cursor:pointer;`，内含 14px 圆形色点；`.active`：`border-color:var(--primary); color:var(--primary); box-shadow:0 0 0 2px rgba(var(--primary-rgb),.18);`。
- **全部内联 `style="…"` 清空**，改为 `<style>` 里的 `.set-*` class。

### 6.2 需新增的 JS（HTML 里已引用但缺失，逐一补全）

放在 index.html 主 script 末尾（云服务器管理 IIFE 之后）。以下代码可直接照抄：

```js
// ==================== 设置面板（v6.1 补齐） ====================
let _pendingTheme = null, _pendingMode = null;

function renderThemeGrid() {
  var grid = document.getElementById('themeGrid');
  if (!grid || typeof THEME_DATA === 'undefined') return;
  grid.innerHTML = '';
  THEME_DATA.forEach(function(t) {
    var colors = t[t.defaultMode] || t.dark;
    var el = document.createElement('div');
    el.className = 'theme-item' + ((_pendingTheme || (window.ThemeEngine && ThemeEngine.getCurrentThemeInfo().id)) === t.id ? ' active' : '');
    el.innerHTML = '<span style="display:block;width:14px;height:14px;border-radius:50%;margin:0 auto 4px;background:' + colors.gold + ';"></span>' + t.name;
    el.addEventListener('click', function() {
      _pendingTheme = t.id;
      grid.querySelectorAll('.theme-item').forEach(function(x){ x.classList.remove('active'); });
      el.classList.add('active');
      // 即时预览（不保存）
      if (window.ThemeEngine) ThemeEngine.applyTheme(t.id, _pendingMode || undefined);
    });
    grid.appendChild(el);
  });
}

function setSelect(group, val) {
  var map = { closeAction: 'setCloseAction' };
  var box = document.getElementById(map[group]);
  if (!box) return;
  box.querySelectorAll('.set-opt').forEach(function(o) {
    o.classList.toggle('active', o.getAttribute('data-val') === val);
  });
}

function selectMode(mode) {
  _pendingMode = mode;
  document.querySelectorAll('#modeSelect .set-opt').forEach(function(o) {
    o.classList.toggle('active', o.getAttribute('data-val') === mode);
  });
  if (window.ThemeEngine) ThemeEngine.applyTheme(undefined, mode); // 即时预览
}

function settingChanged() { /* 控件状态已体现在 DOM，保存时统一读取 */ }

function saveAllSettings() {
  var closeAction = (document.querySelector('#setCloseAction .set-opt.active') || {}).dataset ? document.querySelector('#setCloseAction .set-opt.active').getAttribute('data-val') : 'minimize';
  var payload = {
    closeAction: closeAction,
    trayExit:    document.getElementById('setTrayExit').checked,
    autoStart:   document.getElementById('setAutoStart').checked,
    silentStart: document.getElementById('setSilentStart').checked,
    cloudEnabled: _cloudEnabled,
    cloudServers: _cloudServers,
    theme: _pendingTheme || (window.ThemeEngine ? ThemeEngine.getCurrentThemeInfo().id : 'sky-blue'),
    mode:  _pendingMode  || (window.ThemeEngine ? ThemeEngine.getCurrentThemeInfo().mode : 'light')
  };
  if (window.go && window.go.main && window.go.main.App) {
    window.go.main.App.UpdateSettings(payload).then(function() {
      showToast('设置已保存', 'success');
    }).catch(function(e) { showToast('保存失败: ' + e, 'error'); });
  }
  if (window.ThemeEngine) ThemeEngine.applyTheme(payload.theme, payload.mode);
  closeSettings();
}

function loadSettingsIntoUI() {
  if (!(window.go && window.go.main && window.go.main.App)) return;
  window.go.main.App.GetSettings().then(function(s) {
    if (!s) return;
    setSelect('closeAction', s.closeAction || 'minimize');
    document.getElementById('setTrayExit').checked = !!s.trayExit;
    document.getElementById('setAutoStart').checked = !!s.autoStart;
    document.getElementById('setSilentStart').checked = !!s.silentStart;
    _pendingTheme = s.theme || null; _pendingMode = s.mode || null;
    if (_pendingMode) {
      document.querySelectorAll('#modeSelect .set-opt').forEach(function(o) {
        o.classList.toggle('active', o.getAttribute('data-val') === _pendingMode);
      });
    }
    renderThemeGrid();
  }).catch(function() {});
}
```

并在现有 `openSettings()` 里追加一行 `loadSettingsIntoUI();`（这是唯一一处对既有函数的修改）。

`#modeSelect` 的 emoji（🌑🌆🌅🌇🌤🌥☀）**保留**——它们是模式名称的一部分，与手机端 `ModeInfo` 的 icon 一致，不算功能图标。

### 6.3 版本号

设置浮层底部 `AutoDial v3.4` → `AutoDial v6.1`。

---

## 七、其余浮层与悬浮条

### 7.1 短信浮层 `#smsOverlay`

- 头部 `.sms-ov-header`：44px，surface + divider 边框；💬 emoji 换 message SVG +「发送短信」14/700；右侧 ✕ 换 close SVG。
- `.sms-ov-input` / `.sms-ov-textarea`：`background:var(--input-bg); border:1px solid var(--border-input); border-radius:var(--r-sm); color:var(--text);`（**废 gold 字色**），focus：`border-color:var(--primary); box-shadow:0 0 0 3px rgba(var(--primary-rgb),.14);`。
- `.sms-ov-tpl-tag`：同 `.index-tpl-tag`（pill 规范）。
- `.sms-ov-send`：**废硬编码金色渐变**，可用态 `background:var(--grad-btn); color:#fff; border-radius:var(--r-md); box-shadow:var(--shadow-btn);`，disabled `background:var(--surface-2); color:var(--text-2);`。
- 结构/id/JS 不动。

### 7.2 模板管理弹窗 `#tplManagerOverlay`

- 遮罩 `rgba(0,0,0,.45)` 保留；`.tpl-mgr-box`：`background:var(--surface); border:1px solid var(--border); border-radius:var(--r-lg); box-shadow:var(--shadow-float); padding:16px;`，标题 14/700 `var(--text)`（废 gold-light）。
- `.tpl-mgr-name` 色 `var(--primary)`；输入框/按钮按统一规范（input-bg / grad-btn / ghost）。
- 结构/id/JS 不动。

### 7.3 悬浮条 `#floatbar`

保留毛玻璃（`--floatbar-bg/-border/-blur` 每主题已有值）与全部拖拽/缩放/右键 JS。改动：
- `.float-bar`：`border-radius:var(--r-pill);`（原 24px 基本等价），`box-shadow:var(--shadow-float);`，hover 边框 `var(--primary)`（废硬编码金色 rgba）。
- 按钮 emoji → 内联 SVG（14px）+ 文字：`fbClearBtn`（trash）、`fbDialBtn`（phone）、`fbHangupBtn`（phone-off）、`fbSmsBtn`（message）、`fbRestoreBtn`（up-arrow）、`fbCloseBtn`（close）。HTML 静态部分改为 `<svg…></svg><span id="fbDialLabel">拨打</span>` 的 label 结构。
- `updateFbBtnText()`（允许改动点）：只写 label span 文字——`'请输入号码'`/`'请连接手机'`/`'拨打'`、`'挂断'`。
- `.fb-input`：`background:var(--input-bg); border:1px solid var(--border-input); color:var(--text); border-radius:var(--r-sm);`，focus primary。`fbDialBtn/fbHangupBtn` 保留绿/红渐变，disabled 改 `background:var(--surface-2); color:var(--text-2);`（废红字）。`.fb-sep` 用 `var(--divider)`。
- `.fb-toast`、`.fb-resize-handle` 金色描边 → `var(--primary)`。

### 7.4 右键菜单 `#fbMenu`

- 容器内联样式改为 class `.fb-menu`：`background:var(--surface); border:1px solid var(--border); border-radius:var(--r-md); box-shadow:var(--shadow-float); backdrop-filter:var(--floatbar-blur);`（**废硬编码暗色底**）。
- 菜单项：图标(14px SVG) + 文字 flex 行，`padding:8px 12px; border-radius:var(--r-sm); margin:0 4px; font-size:12px;`，hover `background:var(--input-bg);`，危险项 `color:var(--red)`。`.fb-menu-sep` 用 `var(--divider)`。
- emoji（🏠⚙📞📵💬✕⟳）全部换第八节 SVG。

### 7.5 `body.floatbar-mode` 隐藏清单

CSS 里的 class 名随新结构同步更新（`.header`/`.status-display` 不存在了 → 换成 `.hero-card`；`.wrap`、`.banner`、`.phone-selector` 等保留）。

---

## 八、图标规范（SVG 替换 emoji）

统一：`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`。功能图标禁用 emoji。

| 名称 | path（照抄） | 用于 |
|---|---|---|
| phone | `M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.4 21 3 13.6 3 4c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.1 2.2z` | logo、拨打、拨号盘、状态图标(online) |
| phone-off | phone 的 path + `<line x1="4" y1="4" x2="20" y2="20"/>` | 挂断、状态图标(offline) |
| message | `M20 5v10a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z` | 短信 |
| gear | `<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>` | 设置 |
| cloud | `M7 18a4 4 0 0 1-.5-7.97A5 5 0 0 1 16 9.5 3.5 3.5 0 0 1 17.5 18H7z` | 云端重连 |
| refresh | `M20 12a8 8 0 0 1-8 8 8 8 0 0 1-6.7-3.8M4 12a8 8 0 0 1 8-8 8 8 0 0 1 6.7 3.8M20 4v4h-4M4 20v-4h4` | 重启、重连 |
| wifi | `M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10 10 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01` | IP chip |
| hash | `M9 4L7 20M17 4l-2 16M4 9h17M3 15h17` | 配对码 chip |
| doc | `M6 3h8l4 4v14H6zM9 12h6M9 16h6` | 日志 |
| trash | `M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13` | 清空/清除 |
| close | `M6 6l12 12M18 6L6 18` | 关闭 |
| minimize | `M5 12h14` | 最小化 |
| up | `M12 19V5M5 12l7-7 7 7` | 恢复主界面 |
| chevron-down | `M6 9l6 6 6-6` | 折叠箭头（替换 ▼，可用 CSS 旋转） |
| clipboard | `<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4a3 3 0 0 1 6 0"/>` | 剪贴板提示（可选） |

**替换点全表**（index.html）：titlebar logo 📞→phone；设置钮已有 SVG 保留；`#statusIcon` 📵/✅→phone-off/phone（5.4）；`#restartCloudIcon` ☁→cloud；`#restartAppIcon` ⟳→refresh；`.dialpad-toggle` 📞→phone；`.call-btn` 📞→phone；`.hangupBtn` 📵→phone-off；`.sms-btn` 💬→message；`.log-toggle` 📝→doc + ▼→chevron-down；`.dialpad-toggle` ▼→chevron-down；设置浮层标题 ⚙→gear、✕→close；短信浮层标题 💬→message、✕→close；模板弹窗标题 📋→clipboard；悬浮条按钮（7.3）；`#fbMenu`（7.4）。**保留**：`#modeSelect` 模式 emoji、`addLog` 文案内 emoji、banner 的 ✅（状态文案）。

---

## 九、冻结清单（实现者严禁改动）

1. **全部 DOM id**：`btnSettings btnMinimize btnClose localIP pinCode statusDot statusText restartCloudIcon restartAppIcon topmostToggle statusDisplay statusIcon statusTextLarge statusSubtext banner phoneSelector phoneList numberInput clipHint btnClear dialpadToggle dialpad callBtn hangupBtn smsBtn indexTplList logToggle logBody toast settingsOverlay settingsContent setCloseAction setTrayExit setAutoStart setSilentStart setCloudEnabled cloudSection cloudSummary cloudStatus cloudServerList themeGrid modeSelect smsOverlay smsToInput smsContentInput smsCharCount smsOvlTplList smsSendBtn tplManagerOverlay tplMgrList tplNameInput tplContentInput floatbar floatBar fbDot fbClearBtn fbInput fbDialBtn fbHangupBtn fbSmsBtn fbRestoreBtn fbCloseBtn fbResizeHandle fbToast fbMenu`（`statusDisplay` 若结构合并后消失，需保留一个 `display:none` 的空壳 div 承载该 id 或直接保留区域——由实现者选择，但 id 必须在 DOM 中可查询到）。
2. **JS 业务逻辑**：除 5.4（6 处文案）、6.2（新增函数）、`openSettings()` 加 1 行外，所有事件绑定、IPC 调用、轮询、拖拽、缩放、MutationObserver、剪贴板检测、模板 CRUD 一行不动。
3. **IPC 通道与绑定**：`window.api.send/invoke/on` 全部通道名、`window.go.main.App.*` 调用、wails-adapter 的轮询与事件转发（只加 4.3 的 1 个 case）。
4. **THEME_DATA 数据**（16×7 全部颜色值）与 `style` 块；`js/theme.js` 的 `applyTheme/initTheme/getCurrentThemeInfo` 对外签名。
5. **窗口参数**（main.go 420×780/360×600）、`--wails-draggable` 属性、z-index 层级（floatbar 8888 / toast 999 / settings 9999 / sms 9998 / tplMgr 10001）。
6. **localStorage key** `autodial_sms_templates`、settings.json 字段名。
7. Go 端除 4.3 列出的 3 处（GetSettings 2 字段 + 默认主题 1 行）外一行不动。

---

## 十、实施顺序（给实现模型分 5 步提交）

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | 第四章全部：theme.js 派生注入 + theme-data 默认值 + adapter case + Go 2 处 | `wails build`（或 `go build`）通过；启动后界面呈 sky-blue/light；DevTools 控制台执行 `ThemeEngine.applyTheme('dark-gold','dark')` → 全界面（含派生色）变暗金 |
| 2 | 第五章：index.html 主窗口 CSS 全重写 + HTML 重排（不动设置/短信/模板/悬浮条区域） | 冻结清单 id 逐个 `document.getElementById` 非空；拨号/挂断/拨号盘/日志/置顶/改 PIN 功能正常；控制台无报错 |
| 3 | 第六章：设置浮层重建 + 6.2 JS + openSettings 挂接 | 打开设置 → 主题网格 16 项、模式 7 项、控件回显正确；换主题即时预览；保存后重启应用主题保持 |
| 4 | 第七章：短信/模板/悬浮条/右键菜单 + 第八章图标替换 | 短信浮层发送按钮随主题变色；悬浮条最小化/恢复/拖拽/右键正常；全文无功能性 emoji |
| 5 | 全文校验 + 版本号 | 按 4.4 校验表全文搜索无残留；按第十一节验收 |

每步完成后必须：重新构建运行、连接一部手机（或确认等待连接态）、控制台无报错。

---

## 十一、验收清单

- [ ] 默认启动 = sky-blue × light，与手机端/插件端默认视觉一致
- [ ] 主窗口只剩一个 Hero 状态大盘（无三重状态条），布局与 5.1 线框一致
- [ ] 连接全流程：等待连接 → 已连接 → 多手机 tag → banner，各态视觉正确
- [ ] 设置面板：16 主题网格可点可预览、7 模式可切、保存后重启保持、云服务器增删测正常
- [ ] 随机切 3 套非金主题（如 deep-space/dark、forest-green/dark、cyberpunk/dark）全界面无金色残留、无对比度事故
- [ ] disabled 按钮不再是红字；输入框 focus 有 primary 光环
- [ ] 全文无 `rgba(201,168,76`、`--gold`、`--bg2`、`--text2` 残留（4.4 校验表）
- [ ] 功能图标全 SVG；状态文案 emoji 保留
- [ ] 悬浮条拖拽/缩放/右键/拨号/短信/恢复/退出全部正常
- [ ] 冻结清单逐项 diff 确认零改动；拨号、挂断、短信、剪贴板跟随、日志全流程回归通过

---

## 附录 A：新 `:root` 完整兜底块（index.html `<style>` 开头照抄）

```css
:root {
  /* 基础色（sky-blue × light 兜底，运行时由 theme.js 覆盖） */
  --bg:#EBF4FF; --surface:#FFFFFF; --surface-2:#D8ECFC;
  --input-bg:#F4F8FC; --icon-tile:#EDF5FD; --border:#DCEAF7;
  --border-input:#DFEBF6; --divider:#E4EBF1;
  --hero-border:#BFD9F2; --hero-top:#EDF4FC;
  --text:#162840; --text-2:#5880A8;
  --primary:#2B6CC4; --primary-light:#4A90E0; --primary-dark:#1A56A8;
  --green:#40C057; --red:#F03E3E;
  --banner-info-bg:#E3EEFB; --banner-info-border:#C4DAF3;
  --primary-rgb:43,108,196;
  /* 圆角 4 档 */
  --r-sm:10px; --r-md:14px; --r-lg:18px; --r-pill:999px;
  /* 阴影 3 档 */
  --shadow-card:0 1px 2px rgba(22,40,64,.04), 0 4px 14px rgba(var(--primary-rgb),.07);
  --shadow-float:0 6px 24px rgba(var(--primary-rgb),.18), 0 0 0 1px rgba(var(--primary-rgb),.10);
  --shadow-btn:0 3px 10px rgba(var(--primary-rgb),.28);
  /* 渐变 */
  --grad-btn:linear-gradient(180deg, var(--primary-light), var(--primary-dark));
  --grad-hero:linear-gradient(180deg, var(--hero-top), var(--surface));
  /* 保留：拨打/挂断渐变 + 悬浮条（主题注入覆盖） */
  --gradient-green:linear-gradient(135deg, #27AE60, #1E8449);
  --gradient-red:linear-gradient(135deg, #C0392B, #96281B);
  --floatbar-bg:rgba(255,255,255,.85);
  --floatbar-border:rgba(43,108,196,.25);
  --floatbar-blur:blur(20px);
  --font-family:system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
```

## 附录 B：Electron 版移植映射（可选，本期可不做）

Go 版验证通过后，同样改动可平移到 `pc-app-Electron/`：

| Go 版 | Electron 版 |
|---|---|
| `frontend/index.html` 主窗口部分 | `renderer/index.html` |
| `frontend/index.html` 设置浮层 | `renderer/settings.html` |
| `frontend/index.html` 短信浮层 | `renderer/sms.html` |
| `frontend/index.html` 悬浮条+菜单 | `renderer/floatbar.html` |
| `frontend/themes/theme-data.js` | `themes/theme-data.js`（同名同改） |
| `frontend/js/theme.js` | `renderer/js/theme.js`（同名同改） |
| `wails-adapter.js` | 无需改（Electron preload 原生支持 `get-theme-setting` 类 IPC，需对照 `main.js` 确认通道名） |
| `renderer/index_temp.js` | 半成品残留，忽略，不并入 |
