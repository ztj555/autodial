# 2026-07-11 手机端 V3 UI 改动记录

## UI 与布局

- 默认天空蓝亮白主题保持不变，完成通话、财库、登记、设置页 V3 密度与圆角调整。
- 通话页财运/财气移回标题栏右侧，保持红色与紫色寓意配色。
- 财库今日数据采用红紫色，七日趋势采用红橙黄绿青蓝紫。
- 底部导航增加选中底座，并支持“通话优先/设置优先”两种顺序。
- 设置齿轮替换为细线矢量图标，模块功能图标统一为 Phosphor 风格。
- 设置展开区改为外层卡片 + 内部设置行，移除大胶囊嵌套和黑色粗分割线。

## 设置页交互

- 连接按钮统一显示连接、取消、断开、重连状态。
- 布尔开关统一为轨道圆点样式。
- 新增独立 `CloudServerSheet`：添加、删除、设为当前、测速、PC 同步、网络获取。
- 新增 `DialModeSheet`：7 种拨号模式及说明。
- 保留并调整 `AnimationSheet`、主题选择、透明度、边框、通知和提示时长设置。

## 新增文件

- `CloudServerSheet.kt`
- `DialModeSheet.kt`
- `bg_v3_card.xml`、`bg_v3_input.xml`、`bg_v3_nav.xml`、`bg_v3_icon.xml`
- `ic_ph_palette.xml`、`ic_ph_cloud.xml`、`ic_ph_arrows_clockwise.xml`
- 手机端 UI Markdown/HTML 技术文档

## 修复

- 修复连接动作按钮被状态更新逻辑隐藏。
- 修复通话模式 UI 同步索引错误。
- 修复设置展开区每一行被主题引擎渲染成独立圆角卡片。
- 修复 BottomSheet 主题变量与 `GradientDrawable.colors` 属性冲突导致的 Kotlin 编译错误。
- 修复使用说明重复文案。

## 验证

- XML 资源完成静态解析检查。
- Android Release 构建通过 GitHub Actions 验证后方可发布。
