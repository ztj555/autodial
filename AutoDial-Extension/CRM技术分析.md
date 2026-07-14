# 浏览器扩展 v4.0.0 — CRM 集成说明

## 概述

AutoDial 浏览器扩展 v4.0.0 在 CRM 网页中运行，实现号码检测、浮动按钮、主题系统和坐席手机号自动识别（作为 PIN）。

## 目标 CRM

扩展内容脚本匹配 `guwen.zhudaicms.com` / `*.zhudaicms.com` / `*.rxhcrm.com` / `*.rongxinhui.com`，同时支持所有 `all_frames`，可扫描嵌套 iframe。

## 号码检测

### 坐席手机号检测（顶层页面，v4.0.0）

融鑫汇 CRM 的坐席手机号是**裸 StaticText 节点**，位于页面顶部用户信息区，无 class/id 包裹：

```
RXH 融鑫汇
├── generic (无class)
│   ├── "左廷军"       ← 用户名
│   ├── "15397033187"  ← 坐席手机号（纯文本）
│   ├── "所在部门"
│   └── ...
```

因此 **CSS 选择器方案不可行**。v4.0.0 改为纯 TreeWalker 扫描：

```javascript
function getMyPhoneFromCRM() {
    const PHONE_RE = /1[3-9]\d{9}/;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
        const m = w.currentNode.textContent.match(PHONE_RE);
        if (m) return m[0];  // body 中第一个手机号即坐席
    }
    return null;
}
```

> 顶层 frame 的 TreeWalker 不会跨入客户列表所在的 iframe，因此不会误匹配。

### 检测触发时机

| 场景 | 触发方式 |
|------|---------|
| 页面加载 | DOM 就绪后立即检测，SPA 异步渲染则 500ms / 1500ms 延迟重试 |
| 用户点击拨号但未检测到号 | background 发送 `reDetect` 指令，content-script 重新扫描 |
| 右键菜单点击"未检测到坐席号" | 立刻扫描 + 自动存储 |
| SPA 页面切换 | MutationObserver + 500ms debounce |

### 客户手机号检测（子 iframe）

在子 iframe 中扫描 DOM，查找"手机号码："标签后的手机号，拦截"点击拨打"链接。逻辑未变。

## 自动识别流程 (v4.0.0)

基本原则：**坐席手机号就是 PIN。** 检测到坐席手机号 → 立即存为 PIN → 后续拨号自动携带。

```
页面加载 → 检测到 15397033187
  └→ selfPhoneDetected → chrome.storage.local 存储 self_phone（即 PIN）
       └→ 后续拨号携带 X-AutoDial-PIN Header

页面切换/刷新 → 重新检测 → 同号跳过 / 换号自动更新 PIN
```

## 用户可感知的状态

| 位置 | 状态 | 显示 |
|------|------|------|
| 右键菜单 | PIN 已设置 | `👤 PIN: 15397033187`（灰色） |
| 右键菜单 | 未检测到号 | `⚡ 未检测到坐席号`（红色，点击即扫号） |
| 拨号按钮 | 无 PIN | `✗ 未检测到坐席手机号` |
| 拨号按钮 | 服务器不通 | `✗ 服务器不可达 (端口35430)` |
| 拨号按钮 | 失败反馈 | 6 秒后自动恢复（不再永久挂起） |
| popup 弹窗 | PIN 已设置 | `15397033187` / `● PC在线 | 手机在线` |
| popup 弹窗 | 未检测到号 | `打开 CRM 页面自动检测` |

## 浮动按钮

### 拨号按钮
- 位置：页面右侧固定，可拖动（仅左右边缘 18% 区域启动拖动）
- 显示检测到的客户手机号
- 点击触发拨号（无 PIN 时自动触发检测）
- 反馈提示：成功 2.5 秒恢复，失败 6 秒恢复

### 挂断按钮
- 拨号成功后自动显示（30 秒后自动隐藏）
- 点击挂断
- 左下角缩放手柄调整大小（36-100px 范围）

## 主题系统

8 套主题，在右键菜单中切换，存储于 `localStorage['__ad_theme']`。

## 右键菜单

拨号/挂断按钮右键弹出菜单：
- 当前登录账号（已登录显示号码，未登录显示红色"点击登录"）
- 打开电脑端主界面
- 显示/隐藏悬浮窗
- 拨打当前号码
- 发短信
- 切换主题

## PC 检测策略 (v4.0.0)

PC 端仅**页面加载时检测一次**，结果缓存到页面关闭。后续拨号直接用缓存，不再每次 ping 等 2 秒。

## 依赖的服务端

| 服务 | 端口 | 说明 |
|------|------|------|
| Cloud Relay | 35430 | WebSocket 中继 + REST API |
| PC 端 | 35432 | 本地 HTTP API（可选） |

## 云端超时分析

当前云端 `fetch` 调用均含超时保护：

| fetch 位置 | 超时 | 说明 |
|-----------|:---:|------|
| `isPcAlive()` | 2s | AbortController |
| `dial()` 云端分支 | 5s | AbortSignal.timeout(5000) |
| `hangup()` 云端分支 | 5s | AbortSignal.timeout(5000) |
| `sendSms()` PC 分支 | 2s | 超时后重置缓存 |

> v4.0.0 已修复 v3 时代的超时遗漏问题。
