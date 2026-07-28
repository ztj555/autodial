# AutoDial 手机端 UI 技术文档

> 版本：2026-07-11 V3 原生 Android UI
> 默认主题：天空蓝 / 亮白
> 适用目录：`android-app/app/src/main`

## 1. 设计目标

AutoDial 是公司内部跨屏拨号工具，面向约 50 人以内的顾问团队。UI 以高频操作效率为主，同时保留“财运、财气、财库”等内部趣味表达。

- 不改变 CRM、云中继、拨号和登记接口。
- 使用原生 Android View、XML 与 BottomSheetDialog。
- 默认主题为 `sky-blue + light`，主色 `#2B6CC4`，亮色 `#4A90E0`。
- 功能图标统一使用项目内 Phosphor 风格矢量资源，避免 emoji 和厂商字体差异。
- 卡片采用 14–16dp 圆角；输入框、按钮采用 12–14dp 圆角。
- 页面左右安全边距约 14dp，底部导航高度 64dp。

## 2. 页面与导航

| 页面 | Fragment | XML | 主要功能 |
|---|---|---|---|
| 通话 | `CallLogFragment` | `fragment_call_log.xml` | 连接状态、财运/财气、拨号模式、记录筛选、手动拨号 |
| 录上门 | `RegisterFragment` | `fragment_register.xml` | 客户信息、顾问选择、CRM 登记 |
| 财库 | `StatsFragment` | `fragment_stats.xml` | 今日/周/月统计、上门统计、七日趋势 |
| 设置 | `ConnectFragment` | `fragment_connect.xml` | 跨屏连接、APP 拨号、主题、通知、日志 |

导航顺序可在“主题 / 弹窗设置”中切换：

- 通话优先：通话 → 录上门 → 财库 → 设置。
- 设置优先：设置 → 通话 → 财库 → 录上门。

页面 Fragment 索引保持不变，只动态重排底部 Tab，设置保存于 `navigation_order`。

## 3. 主题系统

`ThemeManager.kt` 提供 16 套主题、7 种亮度模式。默认值：

```text
DEFAULT_THEME_ID = sky-blue
DEFAULT_MODE = light
```

常用 View tag：

| Tag | 用途 |
|---|---|
| `bg` | 页面背景 |
| `bg2` / `bg3` | 卡片与次级背景 |
| `topBar` / `navBar` | 顶部栏与底部导航 |
| `settingGroup` | 设置展开区外层卡片 |
| `settingRow` | 设置卡片内部平直行 |
| `settingDivider` | 浅色细分割线 |
| `inputField` | 输入框 |
| `primaryBtn` | 主按钮 |
| `primaryBtnText` | 描边次按钮 |
| `chip` | 筛选标签 |

主题板块支持卡片透明度、卡片边框、连接通知、登记通知和上次通话提示时长。

## 4. 设置页

### 4.1 连接状态

状态卡右侧使用单一动作按钮：

| 状态 | 按钮 | 动作 |
|---|---|---|
| 未连接 | 连接 | 使用 PIN/手机号建立连接 |
| 连接中 | 取消 | 取消当前连接 |
| 已连接 | 断开 | 手动断开并暂停自动行为 |
| 意外断开 | 重连 | 使用当前配置重新连接 |

### 4.2 跨屏连接设置

采用“外层卡片 + 内部设置行”结构，包含局域网、云中转、连接策略、自动连接和云服务器。

云服务器点击后打开 `CloudServerSheet`，支持：

- 查看服务器与当前节点；
- 添加、删除、设为当前；
- 单台测速、全部测速；
- PC 同步、网络获取。

### 4.3 APP 拨号设置

- 电池优化；
- 拨号模式；
- 自动复制号码；
- 复制提示；
- 拨号动画及动画文字；
- 日志查看与导出。

`DialModeSheet` 展示 7 种模式及说明：弹窗选卡、智能轮选、相反、卡1、卡2、循环、系统默认。

`AnimationSheet` 以双列卡片展示关闭、弹跳、烟花、组合、脉冲、星光、滑入、缩放、抖动、翻转、心跳 11 种效果。

### 4.4 主题与通知

- 主题选择：`ThemeDialog`；
- 卡片透明度：0/25/50/75/100%；
- 卡片边框开关；
- 底部导航顺序；
- 连接状态通知；
- 登记结果通知；
- 上次通话提示：5秒/10秒/30秒/一直。

## 5. 通话页

- 顶部显示“通话”、连接状态和连接按钮。
- 今日财运、今日财气位于标题栏右侧，分别固定使用红色和紫色。
- 拨号模式栏提供 7 种模式快捷切换。
- 筛选项：全部、已接通、未接。
- 通话条目使用左侧状态色条；号码按隐私规则脱敏；显示 SIM、时间、通话类型和时长。
- 右下悬浮按钮打开 `DialPadSheet`，支持手动输入和拨号。
- 点击记录打开 `CallDetailSheet`。

## 6. 财库页

- 今日拨号使用红色，今日通时使用紫色。
- 周统计采用紧凑双卡布局。
- 本月财运/财气使用主蓝强调卡。
- 上门统计为 3×2 网格，数字可点击查看明细。
- 七日趋势固定使用红、橙、黄、绿、青、蓝、紫。
- 同步按钮使用矢量刷新图标，不使用 emoji 功能图标。

## 7. 登记页

- 表单卡片 16dp 内边距；输入框高 48dp、12dp 圆角。
- 客户称呼与手机号为必填项。
- 顾问字段打开 BottomSheet 选择 CRM 顾问。
- 来访事由固定为“贷款咨询”。
- 按钮状态：完成登记 → 提交中 → 登记成功/失败 → 恢复。

## 8. 图标规范

- 图标文件位于 `res/drawable`，以 `ic_ph_` 为主要前缀。
- 顶部和底部设置图标使用细线 `ic_tab_settings.xml`。
- 模块图标使用 30dp 浅蓝圆角底座 `bg_v3_icon.xml`。
- 功能图标禁止使用 emoji；激励文案允许保留趣味 emoji。

## 9. 交互与状态持久化

偏好由 `PrefCtrl.kt` 管理，主要字段包括：

`dial_mode`、`dial_animation_mode`、`dial_animation_text`、`auto_reconnect`、`auto_copy_number`、`copy_toast`、`card_opacity`、`card_border`、`notify_conn_state`、`notify_register`、`last_call_hint_duration`、`navigation_order`。

## 10. 维护约束

1. 重构 XML 时必须保留 Kotlin 引用的 View ID。
2. 设置展开区内部行使用 `settingRow`，不能使用 `bg2`，否则每行会被渲染成独立大圆角卡片。
3. 新增 BottomSheet 时主题变量不要命名为 `colors` 并在 `GradientDrawable.apply` 中直接引用，以免与 Drawable 属性冲突。
4. 所有改动必须通过 GitHub Actions `assembleRelease`。
5. UI 验收以真机截图为准，HTML 原型仅作为设计参照。

## 11. 主要文件

`MainActivity.kt`、`ConnectFragment.kt`、`CallLogFragment.kt`、`StatsFragment.kt`、`RegisterFragment.kt`、`ThemeManager.kt`、`PrefCtrl.kt`、`CloudServerSheet.kt`、`DialModeSheet.kt`、`AnimationSheet.kt`、`DialPadSheet.kt`、`CallDetailSheet.kt` 以及对应布局和 drawable 资源。
