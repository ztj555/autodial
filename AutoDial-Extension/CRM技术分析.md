# 浏览器扩展 v3.1 — CRM 集成说明

## 概述

AutoDial 浏览器扩展 v3.1 在 CRM 网页中运行，实现号码检测、浮动按钮、主题系统和手机号自动登录。

## 目标 CRM

扩展内容脚本匹配 `guwen.zhudaicms.com` / `*.zhudaicms.com` / `*.rxhcrm.com` / `*.rongxinhui.com`，同时支持所有 `all_frames`，可扫描嵌套 iframe。

## 号码检测

### 坐席手机号检测（顶层页面，v3.1 改）

融鑫汇 CRM 的坐席手机号是**裸 StaticText 节点**，位于页面顶部用户信息区，无 class/id 包裹：

```
RXH 融鑫汇
├── generic (无class)
│   ├── "左廷军"       ← 用户名
│   ├── "15397033187"  ← 坐席手机号（纯文本）
│   ├── "所在部门"
│   └── ...
```

因此 **CSS 选择器方案不可行**。v3.1 改为纯 TreeWalker 扫描：

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
| 用户点击拨号但未登录 | background 发送 `reDetect` 指令，content-script 重新扫描 |
| 右键菜单点击"点击登录" | 立刻扫描 + 自动登录 |
| SPA 页面切换 | MutationObserver + 500ms debounce |

### 客户手机号检测（子 iframe）

在子 iframe 中扫描 DOM，查找"手机号码："标签后的手机号，拦截"点击拨打"链接。逻辑未变。

## 自动登录流程 (v3.1)

基本原则：**手机号就是账号。** 检测到坐席手机号 → 立即上报云端 → 保持登录直到换号。

```
页面加载 → 检测到 15397033187
  └→ selfPhoneDetected → autoLogin
       └→ POST /api/v1/auth/auto-login { phone: "15397033187" }
            └→ 云端返回 JWT token → 保存
                 └→ 后续拨号携带 token

页面切换/刷新 → 重新检测 → 同号跳过 / 换号重新登录

Token 过期 → 点拨号时静默续期 → 无需用户操作
```

## 用户可感知的状态

| 位置 | 状态 | 显示 |
|------|------|------|
| 右键菜单 | 已登录 | `👤 15397033187`（灰色） |
| 右键菜单 | 未登录 | `🔴 点击登录`（红色加粗，点击即扫号+登录） |
| 拨号按钮 | 未登录 | `✗ 未登录，请右键菜单登录` |
| 拨号按钮 | 服务器不通 | `✗ 服务器不可达 (端口35441)` |
| 拨号按钮 | 失败反馈 | 6 秒后自动恢复（不再永久挂起） |
| popup 弹窗 | 已登录 | `15397033187` / `● 已登录` |
| popup 弹窗 | 未登录 + 检测到号 | `检测到 15397033187，请点击登录` |

## 浮动按钮

### 拨号按钮
- 位置：页面右侧固定，可拖动（仅左右边缘 18% 区域启动拖动）
- 显示检测到的客户手机号
- 点击触发拨号（未登录时自动触发检测+登录）
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

## PC 检测策略 (v3.1 改)

PC 端仅**页面加载时检测一次**，结果缓存到页面关闭。后续拨号直接用缓存，不再每次 ping 等 2 秒。

## 依赖的服务端

| 服务 | 端口 | 说明 |
|------|------|------|
| Cloud Relay | 35440 | WebSocket 中继 |
| REST API | 35441 | JWT 认证 + 拨号/短信 API |
| PC 端 | 35432 | 本地 HTTP API（可选） |

## 云端超时分析（待优化）

当前所有云端 `fetch` 调用均无显式超时：

| fetch 位置 | 当前行为 | localhost | 公网（腾讯云） |
|-----------|---------|-----------|---------------|
| `isPcAlive()` | 有 AbortController 2s | 2s | 2s ✅ |
| `autoLogin()` | **无超时** | 毫秒级拒绝 | **30-120s** ❌ |
| `dial()` | **无超时** | 毫秒级拒绝 | **30-120s** ❌ |
| `pollDialResult()` | 3s 轮询 | 3s | 3s ✅ |

**结论**：localhost 部署无影响（端口关闭时 TCP 层立刻拒绝），但部署到腾讯云等公网时，服务器宕机会导致 `autoLogin` 和 `dial` 阻塞半分钟以上。届时需给这两个 fetch 加 5s AbortController 超时。
