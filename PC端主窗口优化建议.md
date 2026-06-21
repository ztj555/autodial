# PC 端界面与功能说明

> 基于实际代码 | Electron 版 + Go/Wails 版

## 当前状态

PC 端在 v4 架构中作为局域网直连组件保留。扩展优先检测本地 PC（2s 超时），PC 在线时直连拨号，离线时自动走云端 PIN 验证。

## 界面概览（Electron 版）

### 主窗口（420×780）
- 无边框设计，可拖拽
- 自定义标题栏
- 状态栏：IP、配对码、连接状态
- 拨号盘 + 拨号/挂断按钮
- 短信按钮 + 快捷模板
- 可折叠日志区

### 悬浮条（440×48，可缩放 0.7-1.5x）
- 始终置顶，可拖拽
- 最近拨号记录 + 右键菜单

### 设置窗口（380×420）
- 云端配置、主题选择、自启动

## Go/Wails 版
- 更轻量的实现（~10MB vs Electron 的 ~150MB）
- 功能与 Electron 版基本一致
- 悬浮条通过主窗口缩放实现（400×52）

## 设置持久化
文件路径：`{userData}/settings.json`

```json
{
  "closeAction": "minimize",
  "trayExit": true,
  "theme": "dark-gold",
  "cloudEnabled": false,
  "cloudServers": []
}
```

## 过渡说明
v4 架构中 PC 端保留为局域网高速直连通道。扩展 v4 优先检测本地 PC 端（缓存复用），PC 在线时走 localhost:35432 直连，离线时自动通过云中继 REST API（X-AutoDial-PIN Header）拨号。
