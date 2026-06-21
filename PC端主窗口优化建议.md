# PC 端界面与功能说明

> 基于实际代码 | Electron 版 + Go/Wails 版

## 当前状态

PC 端在 v3 架构中处于**过渡期保留**状态。新用户可通过云中继 v3 直连拨号，无需 PC 端。

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
v3 架构中 PC 端的角色被云中继 v3 取代。扩展 v3 优先检测本地 PC 端，PC 在线时仍可直连，离线时自动通过云端 REST API 拨号。
