# PC 端界面与功能说明

> 基于实际代码 | Electron v3.0.0 + Go/Wails v1.0.0 | 2026-06-26 更新

---

## 一、Electron 版界面

### 主窗口（420×780，最小 210×350）

- 无边框设计，自定义标题栏，可拖拽
- 状态栏显示：本机 IP、配对码（PIN）、端口号、连接状态
- 拨号盘 + 拨号按钮 + 挂断按钮
- 短信按钮 + 快捷模板
- 可折叠的实时日志区（console 输出劫持转发）
- 手机设备列表（显示名称/IP/备注/连接方式）
- 8 套主题可切换（dark-gold 默认）

### 悬浮条（440×48，可缩放 0.7-1.5x，最小 280px）

- `alwaysOnTop` 置顶，`skipTaskbar` 不显示任务栏图标
- 可拖拽移动
- 显示最近拨号记录 + 快捷拨号
- 右键菜单：显隐主窗口、固定大小、退出
- 缩放由 IPC `update-floatbar-scale` 控制

### 设置窗口（380×420，最小 320×350）

- 无边框，独立窗口
- 云端配置：启用/禁用、服务器列表管理、连通性测试、一键获取
- 主题选择：8 套主题 + 显示模式（dark/dusk/dawn/twilight/warm/mist/light）
- 配对码设置：11 位手机号输入 + 格式校验
- 开机自启动开关
- 隐藏启动开关
- 关闭行为：最小化到托盘 vs 直接退出

### 短信窗口（420×680，最小 320×400）

- 无边框，独立窗口
- 号码输入 + 短信内容编辑
- 快捷模板
- 发送状态反馈

---

## 二、Go/Wails 版界面

### 主窗口（420×780，frameless）

- 功能与 Electron 版一致
- 设置和短信通过内嵌标签页实现（单窗口架构）
- 悬浮条通过窗口缩放实现（400×52，小窗口模式）
- 前端通过 `wails-adapter.js` 兼容 Electron IPC 接口

### 与 Electron 版的界面差异

| 维度 | Electron 版 | Go/Wails 版 |
|------|------------|-------------|
| 窗口数量 | 4 个独立窗口 | 1 个（内嵌标签页） |
| 悬浮条 | 独立窗口 440×48 | 窗口缩放 400×52 |
| 渲染引擎 | Chromium | WebView2 |
| 字体渲染 | 一致 | 一致 |
| 动画性能 | 60fps GPU 加速 | 60fps GPU 加速 |

---

## 三、设置持久化

文件路径：`{userData}/settings.json`

```json
{
  "closeAction": "minimize",
  "trayExit": true,
  "autoStart": false,
  "silentStart": false,
  "theme": "dark-gold",
  "mode": "dark",
  "pinCode": "13800138000",
  "phoneNotes": {},
  "cloudServer": "262ao85kz470.vicp.fun:55535",
  "cloudEnabled": false,
  "cloudServers": []
}
```

---

## 四、主题系统

8 套主题定义在 `themes/theme-data.js`（53KB），每套主题包含：

- 背景色 + 前景色 + 强调色
- 窗口控件颜色（最小化/关闭按钮）
- 按钮渐变（主按钮/危险按钮）
- 输入框样式
- 状态指示器颜色（已连接/未连接/错误）
- 日志区样式

主题切换由 IPC `change-theme` 事件触发，广播到所有窗口。

---

## 五、系统托盘

**Electron 版**：使用 `electron.Tray` API，程序化生成 16×16 金色电话 PNG 图标（手写 PNG 编码，无外部图片依赖）。

**Go 版**：直接调用 Win32 API（`user32.dll` + `shell32.dll` + `gdi32.dll`），生成 32×32 金色电话图标。

托盘菜单：
- 显示主窗口
- 显示/隐藏悬浮条
- 退出

双击托盘图标 → 显示主窗口。

---

## 六、日志

### 文件日志

- 路径：`{userData}/autodial-logs/autodial-pc-YYYY-MM-DD.log`
- 格式：`[HH:mm:ss.SSS] [I/W/E] [Module] [PIN] content`
- Electron 版：10MB 轮转，5 级备份，7 天清理
- Go 版：10MB 轮转，旧日志 zip 压缩

### 控制台日志

Electron 版劫持 `console.log/warn/error`，自动转发到渲染进程的日志面板（`server-log` IPC 事件）。

---

## 七、已知可优化项

| 项目 | 说明 | 优先级 |
|------|------|--------|
| PIN 设置错误提示 | 非 11 位数字时的错误提示不够友好 | P2 |
| 云端断开重连状态 | 重连过程中无进度反馈 | P2 |
| Go 版缺少短信窗口 | 当前无独立短信界面 | P1 |
| Go 版 embed 路径 | `go:embed all:frontend/dist` 需要构建前处理 | P1 |
| UDP 多网卡广播 | 当前只发 `255.255.255.255`，未遍历各网卡 | P3 |
