# AutoDial 扩展端 content-script 模块化拆分方案

- **基线**：扩展 v6.0.1 · `content-script.js` 1879 行
- **拟稿**：2026-09-15
- **状态**：待确认后执行
- **目标**：按职责拆成 8 个文件，**不改任何业务逻辑、不改界面、不改运行结果**

---

## 0. 一句话概括

把 1879 行的单文件按职责切成 8 个文件，每一刀都独立验证、独立提交点、可一键回滚。
拆分本身**不产生任何用户体验变化**，收益是"以后改一处不会碰坏另一处"。

---

## 1. 现状实测（不是估算，是脚本算出来的）

### 1.1 作用域结构

| 作用域 | 行号 | 行数 | 说明 |
|---|---|---|---|
| IIFE 顶层 | L1–L257 + L1673–L1880 | 465 | 共享工具、主题、Toast、iframe 模块 |
| `if (isTopFrame) {` 主块 | L258–L1672 | **1415** | 全部 UI 挂件、菜单、弹窗、业务逻辑 |

> ⚠️ 关键事实：iframe 段（L1673+）**缩进是 2 空格**，它在 IIFE 顶层作用域，不是主块的延续。
> 它之所以只在子 iframe 里跑，是因为主块末尾 L1671 有 `return;` —— **是靠 return 跳过的，不是靠作用域隔离**。

### 1.2 依赖矩阵（脚本静态分析结果）

**① 顶层函数 → 主块符号：`(none)`**

没有任何顶层函数引用主块内部的东西。这是拆分可行性的核心前提 —— 不需要设计"反向回调"。

**② 主块函数 → 顶层符号**（必须保留的桥接面，共 8 个）

| 顶层符号 | 被多少个主块函数使用 |
|---|---|
| `T()` 主题取值 | 13 |
| `adIcon()` 图标 | 12 |
| `showToast()` 提示 | 2（showRegisterConfirm 等） |
| `applyTheme` / `applyMode` | 1（showThemeMenu） |
| `hideContextMenu` | 1（showContextMenu） |
| `getMyPhoneAndNameFromCRM` | 1（detectPin） |

**③ 主块内部调用图**（枢纽节点）

```
onDomReady ──> createFloat / createHangupBtn / createManualDial / detectPin
showContextMenu ──> 12 个函数（最大枢纽）
flashFloat ──> updatePhone ──> escHtml
                        ↑
   createFloat / openDesktopApp / toggleFloatbar / sendSms 都调 flashFloat
```

**④ 主块 8 个状态变量，各自只被 1~2 个函数使用**

| 变量 | 使用者 | 结论 |
|---|---|---|
| `hangupSize` / `HANGUP_MIN/MAX` | createHangupBtn, flashHangup | 可随挂件一起搬走 |
| `_ctxMousedownHandler` | showContextMenu | 随菜单搬走 |
| `SECTION_ICON` | mkSection | 随弹窗搬走 |
| `_adAskSeq` | refreshActivePhone | 随业务搬走 |
| `_lastPhone` / `_pinRegistered` | detectPin | 随业务搬走 |
| `_debounceTimer` | onDomReady | 随启动搬走 |

**没有任何变量被 3 个以上函数共享** ⇒ 拆分后**不存在跨模块共享状态**。

### 1.3 副作用注册点（顺序敏感）

| 位置 | 内容 | 所在模块 |
|---|---|---|
| L10-11 | `window.__adv2` 防重入守卫 | core |
| L1603-1604 | `onDomReady()` / DOMContentLoaded | boot |
| L1607 | `chrome.runtime.onMessage.addListener` | boot |
| L1638 | `chrome.storage.onChanged.addListener`（跨页换肤） | boot |
| L1655 | `window.addEventListener('message')` 收姓名 | boot |
| L1663-1669 | `setInterval` 残留号码保鲜（5s） | boot |
| L1671 | `return;` ← **顶层页面到此为止** | boot |
| L1682 | `window.addEventListener('message')` iframe 换肤 | iframe |
| L1858-1865 | `scan()` + `setTimeout` + `setInterval(scan, 5000)` | iframe |
| L1867-1878 | `MutationObserver` | iframe |

---

## 2. 技术方案（MV3 约束下的唯一可行做法）

浏览器插件的 content script **不支持 `import`**，多文件只能靠 manifest 的
`content_scripts[0].js` 数组**按顺序加载**。每个文件是独立脚本，**顶层作用域互相私有**。

所以共享必须走一个显式的命名空间对象：

```js
// 每个文件统一这个骨架
(function (AD) {
  'use strict';                       // ← 每个文件都要写，不能只写在第一个
  if (window.__adv2) return;          // ← 防重入守卫也要每个文件都查

  function 某个函数() { ... }          // 原封不动搬过来
  AD.某个函数 = 某个函数;               // ← 只加这一行"出口"

  // 需要立即执行的副作用，放在文件末尾
})(window.__ADCS = window.__ADCS || {});
```

**四条硬约束（实施时逐条核对）**

1. 每个文件顶部都要 `'use strict'` —— 少一个，该文件就退回 sloppy mode，
   块内 `function` 声明会走 Annex B 提升，**行为与原文件不一致**（v6.0.1 的坑）。
2. 每个文件都要查 `window.__adv2` —— 否则重复注入时只有第一个文件会跳过。
3. **函数的"出口赋值"要在定义之后、副作用之前**。否则 `if (isTopFrame) return;`
   会把出口也跳掉，导致别的模块拿到 `undefined`。
4. `themes.js` / `addr.js` 必须排在最前（它们提供 `AD_THEMES` / `AD_ADDR`）。

---

## 3. 文件划分（8 个）

| # | 文件 | 职责 | 来源行号 | 行数 | 依赖 |
|---|---|---|---|---|---|
| 1 | `cs-00-core.js` | 防重入守卫、`isTopFrame`、`isOwnUiNode`、`getMyPhoneAndNameFromCRM`、`AD_ICON`+`adIcon`、`escHtml` | L8-119, L1455-1459 | ~118 | themes/addr |
| 2 | `cs-10-theme.js` | `currentMode`/`EXT_THEMES`/`rebuildThemes`、`currentThemeId`/`T`、6 个挂件句柄、`applyMode`、`applyTheme`、`showToast` | L85-256 | ~175 | core |
| 3 | `cs-20-widgets.js` | 浮动按钮、挂断按钮+缩放、手动拨号条、`updatePhone`、`flashFloat`、`restoreFloatLabel` | L258-695, L1382-1454 | ~560 | core, theme |
| 4 | `cs-30-menu.js` | 右键菜单、主题子菜单、`refreshContextMenuLabels` | L696-1039 | ~345 | core, theme, widgets, dialogs, biz |
| 5 | `cs-40-dialogs.js` | 设置弹窗（PIN+云地址）、一键登记弹窗、`mkSection`/`mkBtn`、`openDesktopApp`/`toggleFloatbar`/`sendSms` | L1040-1346, L1461-1543 | ~495 | core, theme, widgets, biz |
| 6 | `cs-50-biz.js` | `detectPin`、账号/号码读取、`refreshActivePhone`、`broadcastToFrames` | L1347-1583 | ~237 | core, theme |
| 7 | `cs-60-iframe.js` | iframe 全部：`isFrameActive`、详情页号码/姓名、`scan`、MutationObserver、心跳 | L1673-1879 | ~207 | core |
| 8 | `cs-70-boot.js` | 主块初始化编排：`onDomReady` + 4 处事件注册 + 保鲜定时器 | L1584-1672 | ~89 | 其余全部 |

合计约 **2226 行**（比原 1879 增约 18%，全是"文件头 + 命名空间出口"样板，无业务代码变化）。

> 依赖表里的"循环引用"（如 30 依赖 40、40 依赖 30）**不构成问题** ——
> 因为是运行时通过 `AD.xxx` 查找，只要加载顺序保证"定义全部完成后再调用"即可。
> 唯一的顺序硬要求：`cs-70-boot.js` 放最后。

### manifest 变更

```json
"js": ["themes.js", "addr.js",
       "cs-00-core.js", "cs-10-theme.js", "cs-20-widgets.js",
       "cs-30-menu.js", "cs-40-dialogs.js", "cs-50-biz.js",
       "cs-60-iframe.js", "cs-70-boot.js"]
```

---

## 4. 风险清单与对策

| # | 风险 | 会发生什么 | 对策 | 影响用户吗 |
|---|---|---|---|---|
| R1 | `'use strict'` 漏写 | 该文件的块内 function 行为变化，可能静默错位 | 每个文件顶部固定骨架，脚本刷检 | 可能 |
| R2 | 出口赋值被 `return` 跳过 | 别的模块拿到 `undefined`，点按钮报错 | 出口放"定义后、副作用前"，探针逐个断言 `typeof AD.xxx === 'function'` | 会 |
| R3 | 漏搬一个函数 | 运行时 `AD.xxx is not a function` | 脚本核对：拆分前所有顶层符号 vs 拆分后全部出口，逐个点名比对 | 会 |
| R4 | 加载顺序错 | 初始化跑在定义之前 | manifest 数组顺序固定；boot 放最后 | 会 |
| R5 | 防重入守卫只在第一个文件 | 重复注入时后续文件重复执行，挂件翻倍 | 每个文件都查 `window.__adv2` | 会 |
| R6 | 主块 `return` 语义丢失 | 顶层页面也跑 iframe 的 scan，号码乱跳 | `cs-70-boot` 用 `if (!AD.isTopFrame) return;`；`cs-60-iframe` 副作用用 `if (AD.isTopFrame) return;` | 会 |
| R7 | 缩进/dedent 搞乱模板字符串 | HTML 里的多行模板被改，样式错乱 | 用脚本按行号切割、只删 2 空格前缀；不手工复制 | 可能会 |
| R8 | 探针没覆盖到的交互 | 拆分后某功能静默失效 | 实机清单逐项点一遍（见 §6.3） | 会 |

---

## 5. 执行阶段（每阶段一个验证门，不过门不往下走）

### 阶段 0 · 冻结与备料（不改项目代码）

1. 备份 `content-script.js` + `manifest.json` 到 `%TEMP%\adpopup\v6.0.1-backup\`
2. 跑现有全部测试台，记录基线数字（应为 **442/442**）
3. **改造 `cs_probe.js`**：从"加载 1 个文件"升级为"按 manifest 数组顺序加载 N 个文件"。
   用旧单文件跑一遍，确认改造后探针结论与改造前一致

> **验证门**：探针在旧代码上仍然 PASS，基线数字与备份一致。

### 阶段 1 · 试点两刀（core + theme）

搬 `cs-00-core.js`、`cs-10-theme.js`，改 manifest，删掉原文件中对应部分。

> **验证门**：`node --check` 全绿 + 探针 PASS + **实机验证清单**（§6.3）跑通。
> 这一阶段的意义是验证"整条流水线"能不能跑通。**任何一项不过，立刻回滚。**

### 阶段 2 · 挂件层（cs-20-widgets）

搬浮动按钮 / 挂断按钮 / 手动拨号条 / `updatePhone` / `flashFloat`。

> **验证门**：同上 + 专项验证挂件（拖动、拨号、挂断、缩放、保鲜）

### 阶段 3 · 菜单 + 弹窗层（cs-30, cs-40）

搬右键菜单 / 主题菜单 / 设置弹窗 / 登记弹窗。

> **验证门**：同上 + 专项验证菜单与弹窗

### 阶段 4 · 业务 + iframe（cs-50, cs-60）

搬 `detectPin` / `refreshActivePhone` / iframe 全段。

> **验证门**：同上 + 专项验证号码识别与多客户切换

### 阶段 5 · 收尾（cs-70-boot）

原 `content-script.js` 只剩 boot 编排 → 重命名为 `cs-70-boot.js`，原文件删除。

> **验证门**：全量测试台 + 完整实机清单 + 更新 README 文件表 + 升版本号 6.1.0

---

## 6. 验证链

### 6.1 静态检查（每阶段跑，秒级）

```bash
node --check 每个新文件                       # 语法
python verify_symbols.py                      # 符号守恒：拆分前 N 个 vs 拆分后 N 个，逐个点名
python verify_links.py <扩展目录>              # 跨模块链接：AD.* 断链 + 裸函数调用（v6.1.1 新增，必跑）
grep -c "'use strict'" cs-*.js                # 每个文件都得有
grep -c "window.__adv2" cs-*.js               # 每个文件都得有
```

`verify_links.py` 是 v6.1.1 新增的护栏：按 manifest 顺序读全部内容脚本，列出
**所有 `AD.xxx` 引用中"从未被任何文件赋值"的符号**（就是"调用方改了前缀、被调用方忘了导出"
这类断链），顺带检查裸函数调用与模块守卫。**每阶段拆完必须跑，退出码非 0 即停。**

`verify_symbols.py` 是关键护栏：把拆分前的所有顶层符号列成清单，
逐项检查"拆分后是否恰好存在一份、且挂在 `AD.` 上"。

### 6.2 自动化回归（每阶段跑）

`cs_probe.js`（Node `vm` + DOM 桩，**真跑代码**）：
- 按 manifest 顺序加载全部文件
- 断言：所有预期出口 `typeof AD.xxx === 'function'`
- 断言：`createFloat()` 后 `applyTheme(A)` → `applyTheme(B)`，浮窗背景真的跟着变
- 断言：`showContextMenu` / `showSettingsDialog` / `showThemeMenu` 调用不抛错
- **断言：真实派发挂件事件**（v6.1.1 新增）—— `trigger('contextmenu')` 后断言菜单元素
  真的建出来了、`trigger('click')` 后断言真的向客户帧发出了取号请求。
  事件回调里的断链**只有派发才能暴露**，"出口烟测"看不到（拿不到就打印"未导出，跳过"）
- 回归：`addr_test` 56 + `theme_test` 101 + `panel_test` 173 + `demo_test` 103
  + `cs_iframe_probe.js`（iframe 段行为验证）

### 6.3 实机验证清单（每阶段由你在浏览器执行）

1. `chrome://extensions` 重载扩展 → 打开 CRM 页面，**浮动按钮出现且位置/颜色正常**
2. 点浮动按钮 → 拨号成功
3. **右键浮动按钮 → 菜单弹出、12 项齐全、点空白处关闭**
4. **右键 → 点主题色块 → 菜单自动关闭 + 挂件当场变色**
5. 右键 → 点「亮白 / 暗夜」→ 就地重建菜单 + 选中态正确
6. 打开详情页 → 号码被识别、浮窗显示客户号码
7. 挂断按钮出现 → 点击挂断、左下角拖动缩放、刷新后尺寸保持
8. 手动拨号条 → 输入号码拨号
9. 设置弹窗 → PIN 保存、云地址保存/测试
10. 一键登记 → 弹窗正常、提交成功
11. **弹窗里换主题 → 已打开的 CRM 页面挂件跟着变色**（v6.0.1 刚修的功能）
12. 切换多个客户 → 号码跟随当前客户、不来回跳

---

## 7. 回滚方案

本地目录不是 git 仓库，回滚靠文件备份：

```bash
# 一键回滚（任一步骤出问题）
cp %TEMP%\adpopup\v6.0.1-backup/content-script.js   AutoDial-Extension/
cp %TEMP%\adpopup\v6.0.1-backup/manifest.json       AutoDial-Extension/
# 删除新增的 cs-*.js
```

回滚后重载扩展即恢复原状。**每个阶段开始前都会刷新一次备份**。

---

## 8. 明确不做的事（防止范围蔓延）

- ❌ 不改任何业务逻辑、不改文案、不改颜色、不改交互
- ❌ 不顺手改 `background.js` / `popup.js`
- ❌ 不引入 `registerThemeTarget` 注册表（那是另一件事，等拆完再说）
- ❌ 不收敛 PIN 正则、不集中存储 key（同上，独立任务）
- ❌ 不合并 `themes.js` / `addr.js`（它们已经是好模块）
- ❌ 不做"按需懒加载"之类的优化（会改变时序，属于新风险）

---

## 9. 工作量与收益对照

| 项 | 说明 |
|---|---|
| 改动性质 | 纯搬运 + 加包装，业务代码零改动 |
| 改动量 | 新增 8 个文件，删除 1 个文件，manifest 改 1 行 |
| 用户体验变化 | **零**（拆分不改变任何行为） |
| 直接收益 | 改一处功能时，复查范围从 1879 行缩到单个模块 |
| 间接收益 | 消除"跨作用域引用"这类 Bug 的土壤（v6.0.1 修的正是这类） |
| 风险 | 中低，靠"分阶段 + 每阶段验证门 + 可回滚"控制 |

---

## 10. 执行进度

### ✅ 阶段 0：冻结基线（已完成）

- 备份 `content-script.js`（md5 `6ce11df5…`）+ `manifest.json`（md5 `6b4df41b…`）到 `%TEMP%\adpopup\v6.0.1-backup\`
- 基线测试：addr 56 / theme 101 / panel 173 / demo 103 = **433 全绿**
- `cs_probe.js` 升级为**按 manifest 数组顺序加载 N 个文件**，并新增：模块出口完整性检查、
  10 项"出口烟测"（存在即调用，不抛错为准）
- 升级后先在**旧单文件**上复跑，结论与升级前一致（PASS）

### ✅ 阶段 1：抽出 core + theme（已完成，**实机验证通过**：原清单 1-8 项全绿）

产出：

| 文件 | 行数 | 内容 |
|---|---|---|
| `cs-00-core.js` | 127 | 守卫 / `isTopFrame` / `isOwnUiNode` / `getMyPhoneAndNameFromCRM` / `AD_ICON`+`adIcon` / `escHtml` |
| `cs-10-theme.js` | 171 | 主题表+`rebuildThemes` / `T` / 6 个挂件句柄 / `applyTheme` / `applyMode` / `showToast` |
| `content-script.js` | 1649 | 主块 + iframe 段（含 10 行本地别名，使数十处调用点零改动） |
| `manifest.json` | — | `js` 数组：`themes.js → addr.js → cs-00-core.js → cs-10-theme.js → content-script.js` |

验证结果：

| 项 | 结果 |
|---|---|
| `node --check` × 3 文件 | ✅ |
| 符号守恒（37 个函数 / 36 个变量） | ✅ 缺失 0、重复 0 |
| 变量替换守恒（10 个跨模块变量） | ✅ theme 替换数 + main 替换数 = 原出现数（如 `floatEl` 7+51=58） |
| 探针（真实执行 + 出口完整性 + 端到端重绘 + 10 项烟测） | ✅ PASS |
| 回归：addr 56 / theme 101 / panel 173 / demo 103 | ✅ 433/433 |
| 体积 | 86938 → 89959 字节（**+3.5%**，全是模块包装样板） |

### ✅ 阶段 2：抽出挂件层（已完成；实机验证发现 2 处断链，v6.1.1 已修）

切割区间（**行号是阶段 1 之后的新编号**）：`A = L37-469`（浮动按钮 / 挂断按钮+缩放 / 手动拨号条）、
`B = L1157-1227`（`updatePhone` / `flashFloat` / `restoreFloatLabel`）。

| 文件 | 行数 | 内容 |
|---|---|---|
| `cs-20-widgets.js` | 🆕 537 | 浮动按钮、挂断按钮（含左下角拖拽缩放）、手动拨号条、号码刷新与状态反馈 |
| `content-script.js` | 1696 → **1201** | 主块（菜单/弹窗/业务）+ iframe 段；加 6 行本地别名 |
| `manifest.json` | — | `js` 数组插入 `cs-20-widgets.js`（在 `cs-10-theme.js` 之后） |

**跨模块引用改写（显式白名单，共 21 处）**：`T`(10) / `adIcon`(5) / `escHtml`(3) /
`showContextMenu`(2) / `refreshActivePhone`(1) → 加 `AD.` 前缀。
**留在主文件里的 6 个函数加本地别名**：`createFloat` / `createHangupBtn` / `createManualDial` /
`toggleManualDial` / `updatePhone` / `flashFloat`。

验证结果：

| 项 | 结果 |
|---|---|
| `node --check` × 2 文件 | ✅ |
| **逐行重构等价**（cs-20 正文 505 行） | ✅ **0 处差异** —— 证明每个非空行 = 原行去 4 空格 + 5 处 `AD.` 前缀 |
| **主文件重构等价** | ✅ 0 处差异 = 删 A/B 两段 + 插 6 行别名 + 1 行迁移标记，其余逐字未动 |
| 符号守恒（口径：裸名 + `AD.` 前缀名） | ✅ 全部非减；5 个改写项总数**完全相等**（22 / 15 / 16 / 3 / 3） |
| 模板字符串内容比对（风险 R7） | ✅ 37 → 37 个，**多重集完全一致**（去缩进没吃掉模板内空格） |
| 探针（含新增"阶段 2 专项：真实副作用"6 项断言） | ✅ PASS |
| 回归：addr 56 / theme 101 / panel 173 / demo 103 | ✅ 433/433 |

> 阶段 2 新增探针断言的用意：挂件层的失败模式**大多是静默的** —— 例如句柄没接上时
> `updatePhone` 第 2 行就 `return`，不抛错、也无效果，只做"不抛错"烟测会全绿漏掉。
> 所以改成断言**真实副作用**：`#__ad_dial_label` 文案真的变了、`flashFloat(成功)` 后背景
> 真的等于 `T().gradGreen`、`#__ad_hangup` / `#__ad_manual` 元素真的建出来了。

#### ⚠️ 阶段 2 的交付缺陷与修复（v6.1.1）

> **实机症状**：右键浮窗/挂断按钮**没有菜单**、点击浮窗**没反应**；点挂断按钮正常。

**根因**：`cs-20-widgets.js` 里两处回调写的是 `AD.showContextMenu(...)` / `AD.refreshActivePhone(...)`，
前缀改对了，但这两个函数**定义在主文件块内、从没被导出过** → `undefined is not a function`。
事件回调里的异常不会冒泡到用户可见的地方，所以表现成"点了没反应"。
点挂断按钮正常，是因为它只调 `chrome.runtime.sendMessage`，不跨模块。

**为什么 442 项断言全绿也没抓到**（两个原因，都已补上护栏）：
1. `verify_symbols.py` 只核对"拆分前后的符号数量守恒"，**不检查 `AD.*` 的赋值↔引用是否配对**；
2. `cs_probe.js` 的 DOM 桩 `addEventListener` 是**空实现** —— 事件回调从未真正被执行；
   而出口烟测对 `pick()` 拿不到的符号只打印"未导出，跳过"。

**修复**：主文件主块内补 2 行反向导出（零业务改动）：
`AD.showContextMenu = showContextMenu;` / `AD.refreshActivePhone = refreshActivePhone;`
（函数声明在本块内提升，写在块首即可用。）

**验证**：新增 `verify_links.py` 在修复前精准报出这 2 个断链；
探针补 `trigger()` 派发能力后，修复前 3 项 FAIL（行号 `cs-20-widgets.js:117/130/207`）→ 修复后 3 项 PASS。

### ✅ 阶段 3：抽出菜单层 + 弹窗层（代码完成，**待实机验证**）

产出：

| 文件 | 行数 | 内容 |
|---|---|---|
| `cs-30-menu.js` | 368 | 右键菜单 + `refreshContextMenuLabels` + 主题子菜单 + `AD.hideContextMenu` 实体 |
| `cs-40-dialogs.js` | 415 | 设置弹窗 + 登记弹窗 + `mkSection`/`mkBtn` + `openDesktopApp`/`toggleFloatbar`/`sendSms` |
| `content-script.js` | 477 | 业务层（`broadcastToFrames` / `refreshActivePhone` / `detectPin` / `onDomReady`）+ iframe 段 |

切割点（相对阶段 2 完成态）：`A = L52-395` → cs-30；`B = L396-701` + `C = L740-822` → cs-40。

跨模块处理：cs-30 改写 18 处 + 3 处菜单项 action 箭头转发；cs-40 改写 29 处；
主文件补 `AD.detectPin` 反向导出、移除已迁走的 `AD.showContextMenu`。

验证结果：

| 项 | 结果 |
|---|---|
| 逐行重构等价 | ✅ cs-30 正文 343 行 / cs-40 正文 390 行 / 主文件 477 行，差异均 **0 行** |
| 符号守恒 | ✅ 全项零减少；`let AD.` 0 处、`AD..` 0 处 |
| `verify_links.py` | ✅ 43 个 `AD.*` 引用无断链、无可疑裸调用 |
| 探针（新增阶段 3 专项 5 项） | ✅ 含「点菜单『设置』→ 弹窗建出」的**跨模块链路**断言 |
| A/B（证明护栏有效） | ✅ 模拟漏导出 → 探针精确报 `TypeError: AD.showSettingsDialog is not a function @ cs-30-menu.js:110:51` |
| 回归 433 项 + 两套探针 | ✅ |

**阶段 3 新增经验**：`cs-30` 的菜单项 `action` 引用 `cs-40` 的函数时，用箭头函数转发
（`action: () => AD.showSettingsDialog()`）而非直接取函数值 —— 虽然后者在当前代码里
（`items` 在 `showContextMenu()` 内构造，运行时求值）恰好也能工作，但箭头写法不依赖
"数组构造时机"这个隐含前提。**探针的「阶段 3 专项」是唯一能验证这条链路的手段** ——
静态检查只能看"符号是否存在"，无法证明"点下去真能跑通"。

### ✅ 阶段 4：抽出业务层 + 子 iframe（代码完成，**待实机验证**）

切割点（相对阶段 3 完成态 477 行）：
- `cs-50-biz.js` ← L55-88（实时取号）+ L94-151（detectPin + onDomReady）+ L157-181（onMessage，**包成 `registerContentListeners()`**）
- `cs-60-iframe.js` ← L224-476（整段，原样保留缩进，顶部加 `if (AD.isTopFrame) return;` 承接原主块末尾的 `return;`）
- `content-script.js` ← 其余（启动编排），并清理 6 个已失效别名、删掉 2 行反向导出

| 文件 | 行数 | 内容 |
|---|---|---|
| `cs-50-biz.js` | 🆕 156 | `broadcastToFrames` / `refreshActivePhone` / `detectPin` / `onDomReady` / `registerContentListeners` |
| `cs-60-iframe.js` | 🆕 278 | 激活态判定 / 详情页号码与姓名 / `scan` 心跳 / 切客户轮询 / MutationObserver |
| `content-script.js` | 477 → **81** | 顶层启动编排（挂件与业务启动 / 跨页换肤 / 姓名接收 / 保鲜定时器） |

验证结果：

| 项 | 结果 |
|---|---|
| `node --check` × 3 | ✅ |
| 逐行重构等价 | ✅ cs-50 三段 113 行 / cs-60 232 行 / boot 尾段 35 行，差异均 **0 行** |
| 预期变更白名单 | ✅ 6 个删除别名逐一验证「boot 无引用」、2 个反向导出验证「cs-50 出口已存在」 |
| 符号守恒（37 函数 / 36 变量） | ✅ 缺失 0、重复 0（脚本升级为动态扫描全部模块） |
| `verify_links.py` | ✅ 46 个 `AD.*` 引用无断链、10 个模块守卫齐全 |
| 探针（新增阶段 4 专项 8 项） | ✅ 含「派发 dialResult → 浮窗变『已拨出』」「广播取号 → 收到回话即刻回填」 |
| A/B 反证 | ✅ 三个注入（cs-60 短路失效 / boot 漏调注册 / cs-50 漏导出）**全部由 PASS 翻转为 FAIL** |
| 回归 433 项 + 两套探针 | ✅ |

**阶段 4 新增经验（写入护栏）**：
1. **断言必须能区分「短路生效/失效」** —— 最初用「有无 `phoneDetected` 上报」判 cs-60 是否偷跑，
   但探针 DOM 是空的、根本扫不到号码，于是**两种情况下都不上报，断言恒真**，A/B 直接抓不到。
   改为「加载 cs-60 前后 window 上 `message` 监听器数量的差分」后立刻有效。
   → **规则：新断言写完必须做 A/B 反证，恒真的护栏等于没有护栏。**
2. **A/B 的判据应是「护栏结论翻转」**（PASS → FAIL），而不是「某个报错关键字出现」——
   后者会漏掉「报了错但不是你预期的那个」的情况。
3. **每阶段都要跑 A/B**：阶段 3 只跑了探针 A/B，阶段 4 补上了 `verify_links` 的 A/B。

### ✅ 阶段 5：收尾（`content-script.js` → `cs-70-boot.js` 改名 + 原文件删除）

执行方式：`mv content-script.js cs-70-boot.js`（**纯改名，内容零改动** —— 改名后 md5
`b2fd02ff…` 与改名前一致，随后仅补一句头注释说明来历）。

| 改动点 | 内容 |
|---|---|
| `manifest.json` | `js` 数组末位 `content-script.js` → `cs-70-boot.js`（**唯一有功能影响的一处**） |
| `cs-20-widgets.js` | 加载顺序行 + 对外出口注释行 |
| `cs-30-menu.js` / `cs-40-dialogs.js` | 加载顺序行 |
| `cs-70-boot.js` | 头注释补充"即原 content-script.js" |
| `cs_probe.js` | 锚点注入改为**同时认新旧两个文件名**，使探针既能测现状、也能用 `EXT` 指旧快照做 A/B |
| 文档 | 扩展 README 文件表 + 注入顺序、根 README 文件树、CHANGELOG |

前置检查（决定"能不能安全改名"）：
```bash
grep -rn "executeScript\|getURL('.*\.js'" AutoDial-Extension/*.js   # → 零命中
```
**结论：没有任何"按文件名加载脚本"的运行时依赖**（MV3 的 content_scripts 走 manifest 数组），
所以改名不涉及行为变更。浏览器侧唯一影响：扩展重新加载后，已打开的 CRM 页面需刷新一次。

验证结果：

| 项 | 结果 |
|---|---|
| 改名后 md5 vs 改名前 | ✅ 一致（`b2fd02ff…`） |
| `node --check` × 10（themes/addr + 8 个 cs-*） | ✅ |
| 符号守恒 / 断链 0 / 模块守卫 | ✅ |
| 主探针（含阶段 4 专项 8 项） | ✅ |
| 切客户 A/B 探针（`cs-60-iframe.js`） | ✅ |
| 基础回归 433 项 | ✅ |

**阶段 5 新增经验：**
8. ⚠️ **改名要分两步查**：① 有没有"运行时按文件名加载"的地方（`executeScript` / `getURL('x.js')`）
   —— 有就不能简单 `mv`；② 改名后要同步**四类引用**：manifest `js` 数组（功能性）、
   模块头注释的"加载顺序"行、探针里的文件名判断、README/文档文件表。
9. ⚠️ **只 grep 旧文件名会漏**：`cs-50-biz.js` / `cs-60-iframe.js` 的头注释**早就写成了
   `cs-70-boot.js`**（阶段 4 时按计划预留），改名后自动对齐 —— 所以改动清单要"反向也查一遍"
   （grep 新文件名，看哪些地方已经提到它）。
10. 📌 **回归防线目前在系统临时目录**（`%TEMP%\adpopup\`），有被清理风险。建议迁入仓库
   （如 `AutoDial-Extension/tools/`）后，这份拆分才算真正有可持续的护栏。

### ⚠️ 本次踩到的 7 个坑（后续阶段务必沿用对策）

1. **生成器必须读"不可变的源"** —— 项目里的 `content-script.js` 落盘后已被覆盖，
   重跑生成器若仍读项目文件，会拿拆分后的半成品当输入（已改为固定读 v6.0.1 备份）。
2. **`let currentMode = …` 会被替换成 `let AD.currentMode = …`（语法错误）**
   —— 变量改挂命名空间后，声明形式必须一并变成纯赋值（`fix_decl()` 处理）。
3. **注释里的历史报错原文会被误替换** —— 如 `ReferenceError: floatEl is not defined`。
   对策：**先改注释，再做变量替换**，顺序不能反。
4. **模块需要显式导入它用到的共享符号** —— `cs-10-theme.js` 的 `applyTheme` 里用到
   `isTopFrame`，漏了导入 → 探针立刻报 `ReferenceError`（这正是探针存在的意义）。
5. **`theme_test.js` 的字符串断言要适配多文件** —— 它原本只读 `content-script.js`，
   断言范围已改为"全部内容脚本拼接"（渐进拆分下只纳入实际存在的文件）。
   另：探针的 DOM 桩补了两项能力才测得动 `showRegisterConfirm`
   （`set id` 时登记到可查表、`innerHTML` 赋值时解析出其中的 `id="…"`）。
6. ⚠️ **反向导出：模块能调用的东西，主文件必须显式挂到 `AD` 上**（v6.1.1 血泪）。
   把 `showContextMenu` / `refreshActivePhone` 改写成 `AD.xxx` 只是"调用方"改对了，
   被调用方还住在主文件块内、**从没导出过** → 事件回调里 `TypeError`，且是静默的。
   对策：**每阶段跑 `verify_links.py`**，它会列出所有"被引用但从未被赋值"的 `AD.*`。
7. ⚠️ **探针的 `addEventListener` 不能是空实现**（同一次教训的根因）。
   桩若不记住监听器，挂件的事件回调（右键菜单 / 点击拨号）根本不会被执行，
   于是"右键没菜单、点浮窗没反应"这类 bug 在 442 项断言下**全绿漏网**。
   现已支持 `trigger()` 真实派发，并断言真实副作用。
   → **规则：凡涉及事件的改动，必须用 `trigger()` 派发验证，不能只断言"元素建出来了"。**
