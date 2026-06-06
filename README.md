# AutoDial 一键拨号系统

## 项目概述
AutoDial 是一套专为电销场景设计的跨屏一键拨号系统。用户在电脑端或浏览器中点击/粘贴一个手机号，即可自动触发手机完成拨号，无需手动操作手机。

## 系统架构
系统由4个端组成：

| 端 | 技术栈 | 角色 |
|---|---|---|
| Android端 (手机端) | Kotlin 原生APP | 接收指令 → 执行拨号/发短信 → 回报结果 |
| PC端 (电脑端) | Electron + Node.js | 桌面exe，WebSocket服务端 + 拨号UI |
| 浏览器扩展端 (插件端) | Chrome Extension (MV3) | CRM网页上检测手机号 → 一键拨打 |
| 云中继服务器 (云端) | Python (websockets) / Node.js | 跨网络WebSocket中转服务器 |

## 构建说明

### Android端（手机端）
使用GitHub Actions自动构建，无需本地构建：

1. 在GitHub仓库设置中配置以下Secrets：
   - `KEYSTORE_BASE64`: 签名文件的Base64编码（执行 `base64 autodial-release.p12`）
   - `KEYSTORE_PASSWORD`: 签名文件密码（默认: autodial2024）
   - `KEY_ALIAS`: 密钥别名（默认: autodial）
   - `KEY_PASSWORD`: 密钥密码（默认: autodial2024）

2. 推送代码到GitHub后，GitHub Actions会自动构建Debug和Release APK
3. 在Actions页面下载构建的APK文件

### 云端中继服务
本地构建为exe：
```bash
cd cloud-relay/python
# 安装依赖
pip install websockets pystray Pillow pyinstaller
# 构建exe
pyinstaller --onefile cloud_relay_v2.py
```

### PC端（电脑端）
一键启动脚本：
```bash
# 在项目根目录运行一键启动脚本
start_pc_app.bat
```

## 使用说明

### 首次使用
1. 手机端安装APK并授予必要权限
2. PC端运行一键启动脚本启动程序
3. 手机端输入PC端显示的4位配对码进行连接
4. 浏览器扩展自动检测到PC端后即可在CRM网页使用

### 连接方式
系统支持双通道连接：
1. **局域网直连**（优先）：UDP广播发现，WebSocket直连
2. **云端中继**（备选）：通过云服务器中转，支持跨网络连接

## 端口配置

| 端口 | 协议 | 用途 |
|---|---|---|
| 35430 | WebSocket | 云中继服务器 |
| 35431 | HTTP | 云中继Web管理界面 |
| 35432 | WebSocket + HTTP | PC端主服务 |
| 35433 | UDP | 局域网设备发现广播 |

## 开发说明

### Android端
- 项目路径: `android/`
- 主要文件: `app/src/main/java/com/autodial/app/DialService.kt`
- 构建配置: `android/app/build.gradle`

### PC端
- 项目路径: `pc-app/`
- 主要文件: `main.js` (Electron主进程)
- 打包脚本: `pack.js`

### 浏览器扩展
- 项目路径: `AutoDial-Extension/`
- 主要文件: `content-script.js`, `manifest.json`

### 云端中继
- 项目路径: `cloud-relay/`
- Node.js版: `server.js`
- Python完整版: `python/cloud_relay_v2.py`

## GitHub Actions配置
自动构建配置位于 `.github/workflows/android-build.yml`，每次推送到main/master分支会自动触发构建。

## 注意事项
1. MIUI系统需要设置电池白名单避免后台被杀
2. Android 13+需要动态申请通知权限
3. PC端防火墙需要放行35432和35433端口
4. 首次连接需要在同一局域网内完成配对
