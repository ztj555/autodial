# 浏览器扩展 v3 — CRM 集成说明

## 概述

AutoDial 浏览器扩展 v3 在 CRM 网页中运行，实现号码检测、浮动按钮、主题系统和 JWT 自动登录。

## 目标 CRM

扩展内容脚本匹配 `guwen.zhudaicms.com`（在 manifest.json 中配置），同时支持所有 `all_frames`，可扫描嵌套 iframe。

## 号码检测

### 客户手机号检测（子 iframe）

内容脚本在子 iframe 中扫描 DOM，查找"手机号码："标签后的手机号：
- 通过 `TreeWalker` 遍历文本节点，匹配 `1[3-9]\d{9}` 正则
- 检测到号码后拦截"点击拨打"链接

### 坐席手机号检测（顶层页面）

顶层页面通过 CSS 选择器优先检测当前用户的手机号：

```javascript
const selectors = [
  '.user-info-bar span.phone',
  '[data-field="user_phone"]',
  '.header-user .phone-number',
  '.sidebar .user-profile .phone',
];
```

检测到坐席手机号后，自动通知 background 尝试静默 JWT 续期。

### SPA 页面变化监听

`MutationObserver` + 500ms debounce 监控 DOM 变化，在 SPA 路由切换时重新检测号码。

## 浮动按钮

### 拨号按钮
- 位置：页面右侧固定，可拖动（仅左右边缘 18% 区域启动拖动）
- 显示检测到的手机号
- 点击触发拨号
- 拨号成功后 2.5 秒恢复原状态

### 挂断按钮
- 拨号成功后自动显示（30 秒后自动隐藏）
- 点击挂断
- 左下角缩放手柄调整大小（36-100px 范围）

## 主题系统

8 套主题，在右键菜单中切换，存储于 `localStorage['__ad_theme']`。切换后通知所有 iframe 更新链接颜色。

配色方案各含：accent / accentLight / accentDark / bg / bg2 / bg3 / text / text2 / green / red 及对应 grad 渐变。

## 右键菜单

拨号/挂断按钮右键弹出菜单：
- 打开电脑端主界面
- 显示/隐藏悬浮窗
- 拨打当前号码
- 发短信
- 切换主题（展开子菜单）
