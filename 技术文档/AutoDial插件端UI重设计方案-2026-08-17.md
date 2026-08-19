# AutoDial 浏览器插件端 UI 重设计方案

> 版本：2026-08-17 | 目标版本 v5.0.0
> 适用目录：`AutoDial-Extension/`
> 设计基准：手机端 `ThemeManager` sky-blue × light（与《AutoDial手机端UI技术文档-2026-07-11》对齐）
> 性质：**整体重设计**（结构调整 + 组件规范重建），不是现有样式的缝补

---

## 一、现状审计（为什么需要重设计）

### 1.1 扩展端 UI 面清单

| 文件 | UI 面 | 现状 |
|---|---|---|
| `popup.html` | 弹窗（340px） | v4.2.0 已套用天空蓝色板，但结构是"一功能一张卡"的堆叠，无视觉主次 |
| `auth.html` | 设备授权页 | 同款色板，独立维护一份 CSS（与 popup 重复） |
| `content-script.js` | 拨号悬浮球 `__ad_float` | 内联样式，emoji 📞 当图标 |
| 同上 | 挂断悬浮钮 `__ad_hangup` | 椭圆 + 缩放手柄，样式与拨号球不统一 |
| 同上 | 手动拨号条 `__ad_manual` | 圆角 8/12 混用 |
| 同上 | 右键菜单 `__ad_ctxmenu` | 圆角 10px，emoji 菜单图标（🖥📍🎨⚙） |
| 同上 | 主题菜单 `__ad_thememenu` | 与右键菜单规范不一致 |
| 同上 | 位置提示 `__ad_position_tip` | 用了 `monospace` 字体，与全局脱节 |
| 同上 | 设置弹窗 `__ad_settings` | 圆角 14px，又一套按钮写法 |

### 1.2 核心问题

1. **三套并行样式体系**：popup/auth 的 CSS 变量、content-script 的 `EXT_THEMES`、以及各悬浮组件各自为政的圆角/阴影/字号，互不一致。
2. **popup 固定天空蓝，content-script 有 9 套主题**：两处主题数据重复定义且不同步。
3. **功能图标用 emoji**：违反手机端规范第 8 节（功能图标禁止 emoji，统一 Phosphor 风格矢量图标）。
4. **圆角体系混乱**：6/8/10/12/14/16/18/20/24px 全都有；手机端规范是卡片 14–16(dp)、输入框/按钮 12–14(dp)。
5. **无 motion 设计**：除了状态点 pulse，没有 hover/press/入场过渡，质感停留在"能用的表单"。

---

## 二、设计目标

1. **一套设计系统**：popup、auth、content-script 悬浮组件共享同一套 token（色板、圆角、阴影、字号、间距）。
2. **结构对齐手机端**：分组列表卡（settingGroup/settingRow）替代"每功能一张卡"；状态大盘 + 主操作一体化（对齐手机端 heroCard 内含输入框+连接按钮的模式）。
3. **现代化质感**：柔和投影、backdrop 模糊、hover 抬升 / press 下沉、面板切换过渡、脉冲状态环。
4. **图标矢量绘**：全部功能图标换内联 SVG（24 viewBox、stroke 1.8、round 线帽，Phosphor 风格），emoji 只保留在状态文案里。
5. **零功能回归**：所有 DOM id、消息类型、storage key、拖拽/缩放逻辑、z-index 一律不动（见第八节冻结清单）。

---

## 三、设计 Token（唯一权威值，全部取自手机端）

### 3.1 色板（sky-blue × light，ThemeManager.kt L256 + drawable 实测）

| Token | 值 | 来源 |
|---|---|---|
| `--bg` | `#EBF4FF` | 页面底色 colors.bg |
| `--surface` | `#FFFFFF` | 卡片 colors.bg2 / bg_v3_card |
| `--surface-2` | `#D8ECFC` | 深层背景 colors.bg3 |
| `--input-bg` | `#F4F8FC` | 输入框 bg_v3_input |
| `--icon-tile` | `#EDF5FD` | 图标底座 bg_v3_icon |
| `--border` | `#DCEAF7` | 卡片描边 |
| `--border-input` | `#DFEBF6` | 输入框描边 |
| `--divider` | `#E4EBF1` | 行内分割线 |
| `--hero-border` | `#BFD9F2` | 大盘描边（blend(primary, bg2, 56%) 实测近似） |
| `--text` | `#162840` | 主文字 |
| `--text-2` | `#5880A8` | 辅助文字 |
| `--primary` | `#2B6CC4` | |
| `--primary-light` | `#4A90E0` | |
| `--primary-dark` | `#1A56A8` | |
| `--green` | `#40C057` | |
| `--red` | `#F03E3E` | |
| `--banner-info-bg` | `#E3EEFB` | infoBanner |
| `--banner-info-border` | `#C4DAF3` | |

主按钮渐变（手机端 primaryBtn = 垂直渐变 primaryLight→primaryDark，18dp 圆角）：
`linear-gradient(180deg, #4A90E0 0%, #1A56A8 100%)`

大盘渐变（手机端 heroCard = blend(bg2, primaryDark, 8%) → bg2，26dp 圆角 + 1px 描边）：
`linear-gradient(180deg, #EDF4FC 0%, #FFFFFF 100%)` + `border: 1px solid #BFD9F2`

### 3.2 圆角体系（收敛到 4 档）

| 档位 | 值 | 用途 |
|---|---|---|
| `--r-sm` | `10px` | 输入框、小按钮、图标底座、菜单项 |
| `--r-md` | `14px` | 菜单/弹窗/拨号条等浮层卡 |
| `--r-lg` | `18px` | 内容卡、分组卡、主按钮 |
| `--r-pill` | `999px` | 悬浮球、chip、版本徽章、状态点 |

### 3.3 阴影体系（收敛到 3 档）

```css
--shadow-card:  0 1px 2px rgba(22,40,64,.04), 0 4px 14px rgba(43,108,196,.07);
--shadow-float: 0 6px 24px rgba(43,108,196,.18), 0 0 0 1px rgba(43,108,196,.10);
--shadow-btn:   0 3px 10px rgba(43,108,196,.28);
```

### 3.4 字号体系

| 用途 | 字号/字重 |
|---|---|
| 大盘状态标题 | 15px / 700 |
| 卡片标题、弹窗标题 | 14px / 700 |
| 正文、按钮 | 13px / 500–600 |
| 辅助说明、标签 | 12px / 400–500 |
| 状态行、徽章 | 11px / 500 |

全局：`font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; letter-spacing: .02em;`

### 3.5 间距体系

页面边距 14px（对齐手机端）；卡片内边距 14px；卡片间距 12px；行内垂直间距 10px。

### 3.6 Motion

| 场景 | 参数 |
|---|---|
| hover 抬升 | `transform: translateY(-1px)`，150ms |
| press 下沉 | `transform: translateY(1px) scale(.98)`，80ms |
| 输入框 focus | border 变 `--primary` + `box-shadow: 0 0 0 3px rgba(43,108,196,.14)` |
| 面板切换 | `opacity 0→1 + translateY(4px→0)`，200ms ease-out |
| 状态点脉冲 | 外圈 3px→6px 扩散呼吸，2s 循环（沿用并保留现有 keyframes） |
| 弹窗入场 | `scale(.96)→1 + opacity`，180ms ease-out |

---

## 四、popup.html 重设计（结构级重做）

**所有 id 不变**（见第八节），只改结构与样式。宽度 340px → `360px`，padding 14px。

### 4.1 新结构线框

```
┌──────────────────────────────────────┐
│ Topbar                               │
│ [图标底座34] AutoDial  (v5 pill)  [⋮]│   ← 右侧预留主题/关于入口（本期可不放按钮）
├──────────────────────────────────────┤
│ 状态页 #statusPanel                  │
│ ┌─ Hero 大盘（渐变+蓝描边 r18）─────┐ │
│ │ (●脉冲) PIN 已就绪               │ │
│ │         ● PC在线 | 手机在线(1)    │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ [⟳] 同步登记列表（渐变主按钮） │ │ │  ← 主操作内置于大盘，对齐手机端
│ │ └──────────────────────────────┘ │ │
│ └──────────────────────────────────┘ │
│ ┌─ 信息分组卡（r18）────────────────┐ │
│ │ [底座] 坐席手机号      138…  ›   │ │  ← 行=图标底座22+标签+值，行间 1px divider
│ │ [底座] 接待顾问        张三  ›   │ │
│ │ [底座] 云端地址        1.2.3.4 › │ │
│ └──────────────────────────────────┘ │
│ [ 修改服务器 ]        [ 清除 PIN ]    │   ← ghost pill + danger pill 并排
├──────────────────────────────────────┤
│ 设置页 #setupPanel                   │
│ ┌─ Hint 横幅（infoBanner）─────────┐ │
│ │ (i) 打开 CRM 页面，插件自动检测…  │ │
│ └──────────────────────────────────┘ │
│ ┌─ 分组设置卡（r18，一张卡装全部）──┐ │
│ │ [底座] 云中继地址                 │ │
│ │ ┌──────────────┐ [测试]          │ │
│ │ │ input        │                 │ │
│ │ └──────────────┘                 │ │
│ │ status 行                        │ │
│ │ ───────── divider ────────────── │ │
│ │ [底座] 配对码        4位或11位    │ │
│ │ ┌──────────────┐ [保存]          │ │
│ │ ───────── divider ────────────── │ │
│ │ [底座] 接待顾问姓名               │ │
│ │ ┌──────────────┐ [保存]          │ │
│ └──────────────────────────────────┘ │
│ [← 返回]（仅修改服务器模式显示）      │
└──────────────────────────────────────┘
```

### 4.2 关键改动点

1. **三张设置卡合并为一张分组卡**：`.section` 从"三张独立卡"改为"一张卡 + 组间 divider"，对齐手机端 settingGroup/settingRow 模式。这是与现状最直观的结构差异。
2. **主按钮移入 Hero 大盘底部**，大盘内边距 14px，按钮与状态区间隔 12px。
3. **信息行增加 22px 图标底座**（`#EDF5FD` 底、10px 圆角、内嵌 14px SVG），可点击行右侧加 `›` 指示，hover 行底色 `#F4F8FC`。
4. **版本徽章** `v4` → `v5`，pill 样式不变。
5. **次操作按钮**：`修改服务器` = ghost pill（白底+边框），`清除 PIN` = danger pill（白底+红字+红边框30%），两者等高 38px、`--r-pill` 圆角。
6. **面板切换动画**：`#statusPanel` / `#setupPanel` 显示时加 `.panel-in` class（opacity+translateY 过渡）。注意：现有 JS 用 `style.display` 切换，实现时用「先 display 再 rAF 加 class」即可，不改 JS 逻辑。
7. 新增全局 `::selection` 淡蓝、细滚动条（6px，`#D8ECFC` 滑块）兜底高度超限。

### 4.3 popup.html 重写要求（给实现者）

- `<style>` 整体重写，只允许保留：`@keyframes pulse` 及状态点双色规则。
- CSS 变量严格按 3.1–3.5 定义，禁止出现变量表之外的硬编码色值（SVG `currentColor` 除外）。
- SVG 图标统一 24 viewBox、stroke=`currentColor`、stroke-width 1.8、round 线帽：
  - 坐席手机号=手机轮廓；接待顾问=人像；云端地址=云；同步=循环箭头（沿用现有同步 SVG 即可）。
- `<body>` 内结构按 4.1 线框重排，**所有 id 原样保留**：`statusPanel`、`setupPanel`、`statusDot`、`statusText`、`cloudStatus`、`myPhone`、`myMgrName`、`cloudAddr`、`syncBtn`、`editServerBtn`、`clearPinBtn`、`setupHint`、`serverInput`、`testServerBtn`、`serverStatus`、`backToStatusBtn`、`pinInput`、`savePinBtn`、`pinStatus`、`mgrNameInput`、`saveMgrNameBtn`、`mgrNameStatus`。

---

## 五、auth.html 重设计

结构不变（卡片居中），样式与 popup 同源：

1. 顶部 56px 圆形红底图标 → **48px 圆角方形底座**（`rgba(240,62,62,.10)` 底、`--r-md` 圆角、内嵌 24px 警告三角 SVG），与 popup 图标底座语言一致。
2. 卡片：`--r-lg` + `--shadow-card` + 入场动画（scale .96→1）。
3. 信息卡改为分组卡样式（白底、`--r-md`、行间 divider），与 popup 信息卡一致。
4. 按钮行：拒绝=ghost pill、允许=渐变主按钮 pill，高 42px。
5. **与 popup 共享 token**：将 3.1–3.5 的 `:root` 块原样复制（两文件保持逐字一致，后续可抽公共文件，本期不抽，避免 manifest/构建变动）。

---

## 六、content-script.js 悬浮组件重设计

约束：无 CSS 文件，全部 `Object.assign(el.style, …)` 内联；所有 id/class、拖拽、缩放、消息发送逻辑不动；z-index 不动。

### 6.1 新增样式 helper（文件顶部、紧邻 EXT_THEMES）

```js
// 统一组件样式片段（从 token 派生），所有悬浮组件必须从这里取值
function adStyles(t) {
  return {
    card: {
      background: t.bg2, borderRadius: '14px',
      boxShadow: `0 6px 24px ${t.accent}2E, 0 0 0 1px ${t.accent}1A`,
      backdropFilter: 'blur(16px)', fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    },
    input: {
      background: t.bg3, border: `1px solid ${t.accent}33`, borderRadius: '10px',
      color: t.text, outline: 'none',
    },
    btnPrimary: {
      background: t.gradAccent, color: '#FFFFFF', border: 'none',
      borderRadius: '10px', fontWeight: '700', cursor: 'pointer',
    },
    btnGhost: {
      background: 'transparent', color: t.text2, border: `1px solid ${t.accent}44`,
      borderRadius: '10px', fontWeight: '600', cursor: 'pointer',
    },
  };
}
```

### 6.2 新增 SVG 图标 helper（替换全部功能性 emoji）

```js
function adIcon(pathD, size) { /* 返回 svg 字符串：24 viewBox、stroke=currentColor、stroke-width=1.8、fill=none、round 线帽 */ }
// 至少提供：phone、phoneX、monitor、mapPin、palette、gear、clipboard、sync
```

替换点：`__ad_dial_label` 的 `📞`、挂断钮文字旁加 phoneX 图标、右键菜单各项的 `🖥/📍/🎨/⚙`、位置提示标题的 `📍`、复制按钮的 `📋`、主题菜单标题的 `🎨`、设置弹窗标题的 `⚙`。**状态文案中的 ✓/✗/● 保留。**

### 6.3 拨号悬浮球 `__ad_float`

| 属性 | 旧值 | 新值 |
|---|---|---|
| borderRadius | 24px | `999px` |
| padding | 10px 20px | `10px 18px` |
| 无号码(idle) | gradIdle 渐变 | `#FFFFFF` 底 + text 色字 + `1px solid ${accent}33` |
| 有号码 | gradAccent | gradAccent 不变 + 白字 + 发光 `0 6px 20px ${accent}59` |
| 阴影 | `0 4px 16px accent22` | idle: `0 4px 14px accent1F`；active: 上述发光 |
| hover | 无 | `translateY(-1px)` + 阴影加深 |
| press | 无 | `scale(.97)` |
| 图标 | emoji 📞 | `adIcon(phone)` 16px + label，flex gap 6px，图标 `pointerEvents:none` |

`applyTheme()` 中对应刷新逻辑同步更新（idle/active 两态背景都刷新）。

### 6.4 挂断悬浮钮 `__ad_hangup`

- 椭圆形态、缩放手柄、拖拽全部保留。
- idle：白底 + `t.red` 文字 + phoneX 图标（现状是主题色底+文字"挂断"，与"挂断=红"的语义不符）。
- 点击后：`t.gradRed` + 白字（现状文字色不变，在白底渐变上可能看不清，补上 `color:'#FFFFFF'`；恢复时还原）。
- 缩放手柄三角颜色 `${accent}66` → `${t.red}55`（与按钮语义一致）。

### 6.5 手动拨号条 `__ad_manual`

- 容器套用 `adStyles(t).card`，padding `8px`，gap `8px`。
- input 套用 `adStyles(t).input`，高 34px；focus 时 `borderColor = t.accent`（加 focus/blur 监听）。
- 清空按钮 → `adStyles(t).btnGhost`；拨号按钮 → `adStyles(t).btnPrimary`。
- 出现/消失加过渡：`opacity + translateY(6px)`（`toggleManualDial` 里 display 切换后用 rAF 触发，不改显隐逻辑）。

### 6.6 右键菜单 `__ad_ctxmenu` / 主题菜单 `__ad_thememenu`

- 容器：`borderRadius 10px→14px`，padding `4px 0→6px`，阴影用 `--shadow-float` 等价值，保留 `backdropFilter`。
- 菜单项：padding `8px 14px→8px 10px`，加 `borderRadius:8px`、`margin:0 2px`，结构改为「16px SVG 图标 + 文字」flex 行，hover 底色 `${accent}12→${accent}14`。
- 分组小标题（如 PIN 状态行）：字号 11px、`text2`、`letterSpacing:1px`、padding `6px 12px 2px`。
- 危险项（断开等）保持 `t.red` + 600。
- 主题菜单：容器改 `t.bg→t.bg2`（与右键菜单一致），active 行从"左边框 3px"改为「行底色 `${accent}1A` + 右侧 ✓」，swatch 加 `box-shadow: 0 0 0 2px ${bg2}, 0 0 0 4px ${accent}55`（active 时）。

### 6.7 位置提示 `__ad_position_tip` / 设置弹窗 `__ad_settings`

- 去掉 `fontFamily: monospace`（坐标行可用 `letterSpacing:.5px` 的常规字体）。
- 容器套用 `adStyles(t).card`，`__ad_settings` 圆角 `14px→16px`，padding `24px→20px`。
- 标题行统一为「20px 图标底座 + 15px/700 标题 + 右侧 × 关闭」；按钮统一走 `adStyles` 的 btnPrimary/btnGhost；输入框统一 `adStyles(t).input`。
- `mkSection` / `mkBtn` 内部样式改为读取 `adStyles(t)`，不改函数签名。

### 6.8 主题数据收口（解决"两套主题"）

1. 新建 `AutoDial-Extension/themes.js`：内容 = `var AD_THEMES = { … }`，即现有 `EXT_THEMES` 原样搬入。
2. `manifest.json` 的 `content_scripts.js` 改为 `["themes.js", "content-script.js"]`（顺序敏感）。
3. `content-script.js` 中 `const EXT_THEMES = {...}` 替换为 `const EXT_THEMES = AD_THEMES;`（其余引用不变）。
4. `applyTheme()` 末尾追加：`try { chrome.storage.local.set({ __ad_theme: id }); } catch(e) {}`。
5. `popup.html` / `auth.html` 引入 `<script src="themes.js"></script>` + 一小段内联脚本：读 `chrome.storage.local.__ad_theme`，把 `AD_THEMES[id]` 的颜色写入 `document.documentElement` 的 CSS 变量（暗色主题下 popup 同步变暗）。变量映射：accent→primary、accentLight→primary-light、accentDark→primary-dark、bg→bg、bg2→surface、bg3→surface-2、text→text、text2→text-2、green/red 同名。
   - 暗色主题下 `input-bg`/`icon-tile`/`border` 等派生值在 `themes.js` 里为每套主题预定义好（实现者按"bg2 与 bg 之间取中间色"原则补全即可），popup 只消费变量。
6. popup 默认（无存储时）= sky-blue，行为与现状一致。

---

## 七、版本号

`manifest.json`：`"version": "4.2.0"` → `"5.0.0"`；popup 顶栏徽章 `v4` → `v5`。description 等其他字段不动。

---

## 八、冻结清单（实现者严禁改动）

1. **DOM id**（popup.html 全量 id 见 4.3 末尾；content-script：`__ad_float`、`__ad_dial_label`、`__ad_hangup`、`__ad_manual`、`.__ad_manual_paste`、`.__ad_manual_dial`、`__ad_ctxmenu`、`__ad_ctxmenu_overlay`、`__ad_thememenu`、`__ad_position_tip`、`__ad_settings`、`__ad_settings_overlay`）。
2. `popup.js` 全部逻辑（只允许在"面板切换动画"处加 class 切换，若做不到则完全不动 popup.js，动画用 CSS `:not([style*="none"])` 兜底或直接放弃该动画）。
3. 消息类型与字段：`dial`、`hangup`、`respondAuth`、`triggerSync`。
4. storage key：`cloud_api`、`cloud_apis_fetched`、`self_phone`、`pin`、`manager_name`、`__ad_theme`、`__ad_hangup_size`。
5. 拖拽边缘判定（DRAG_EDGE 0.18）、挂断缩放范围（36–100）、z-index 层级、`window.__adv2` 防重入。
6. manifest 的 permissions / host_permissions / matches。
7. `background.js` 一行不改。

---

## 九、实施顺序（建议给实现模型分 4 步提交）

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | popup.html 重写（纯 HTML/CSS） | chrome://extensions 重载，两种状态截图 |
| 2 | auth.html 重写 | 触发一次设备授权或直接用浏览器打开 auth.html 目测 |
| 3 | content-script.js 组件重样式（含 adStyles/adIcon） | CRM 页面逐组件检查：拨号球、挂断、手动条、右键菜单、主题菜单、位置提示、设置弹窗 |
| 4 | themes.js 抽取 + 主题同步 + 版本号 | 右键菜单切暗色主题 → popup 同步变暗；切回天空蓝还原 |

每步完成后必须：重载扩展、开 CRM 页面、确认控制台无报错、点击/拖拽/缩放悬浮球功能正常。

---

## 十、验收清单

- [ ] popup 两种状态（已设 PIN / 未设 PIN）与第四节线框一致，圆角/阴影/字号全部来自 token 表
- [ ] popup 全文无 emoji 功能图标；SVG 图标风格统一（24 viewBox、stroke 1.8）
- [ ] auth 页与 popup 视觉同源
- [ ] 拨号球 idle=白底、检测到号码=蓝渐变发光；hover 抬升、press 下沉
- [ ] 挂断钮 idle=白底红字，点击后红渐变白字，1.8s 后还原
- [ ] 右键菜单/主题菜单/设置弹窗/位置提示圆角统一 14–16px、阴影统一、无 emoji 图标
- [ ] 切主题后 popup/auth 同步（storage 驱动），默认仍是天空蓝
- [ ] 冻结清单逐项 diff 确认零改动
- [ ] 拨号、挂断、手动拨号、同步登记、PIN 保存/清除、服务器测试全流程回归通过
