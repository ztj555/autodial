# AutoDial 一键拨号系统 v4.5

> 仓库：github.com/ztj555/autodial | 最后更新：2026-07-18

## 项目概述

AutoDial 是一套跨屏一键拨号+来访登记系统。用户在 CRM 网页中点击手机号自动拨号；右键悬浮按钮即可完成客户登记，数据实时同步云端和手机端。

**v4.5 更新**：
- 云服务器管理：别名系统、连接状态显示、默认 `101.34.65.254:35430`
- 设置页全面重构：卡片拆分+折叠箭头+动态副标题+策略标签
- 状态大盘优化：连接状态整合、失败原因提示、连接策略一键可见
- 新签名密钥（RSA2048）防止华为误报，CI 双构建 Release+Debug

## 系统架构

```
                       ┌──────────────────────────────────┐
                       │   云中继 cloud_relay_v2.py         │
                       │   端口 35430 (WS + HTTP)           │
                       │                                  │
     REST API          │   WebSocket 中继                   │
   ┌───────────────────│   visit 登记 API                   │──────────────────┐
   │                   │   SQLite (visits/pins/stats/log)  │                  │
   │   一键登记 + 同步  │   Web 管理面板 (dashboard.html)    │                  │
   │                   └────────────┬─────────────────────┘                  │
   ▼                                │  WS visit_record                      ▼
┌──────────────────┐                │                       ┌──────────────────┐
│ Chrome 扩展       │  HTTP 35432   │                       │ Android 手机端     │
│ (MV3)            │◄──────────────┼───────────────────────│                  │
│ PIN 自动检测      │   Go / Electron│                       │ WS 连云中继       │
│ 双模路由(Ping)   │    PC 端        │                       │ 收发 dial/hangup  │
│ 浮动按钮 8 主题   │               │                       │ 4 Tab 界面        │
│ 一键登记+确认弹窗 │               │                       │ 16 主题+7 亮度    │
└──────────────────┘               │                       └──────────────────┘
                                    │
                           手机离线 → pending_visits → 重连补推
```

## 端口配置

| 端口 | 协议 | 用途 |
|------|------|------|
| **35430** | WS + HTTP | 云中继（WS 中继 + REST API + Web 面板） |
| 35432 | HTTP + WS | PC 端主服务（局域网直连 + 扩展连接） |

## 目录结构

```
├── cloud-relay/python/
│   ├── cloud_relay_v2.py            # ★ 云中继主程序
│   ├── dashboard.html               # Web 管理面板
│   └── requirements.txt             # Python 依赖
├── AutoDial-Extension/              # ★ Chrome 扩展 (MV3)
│   ├── background.js                # Service Worker：PIN/路由/登记
│   ├── content-script.js            # 全帧注入：扫号/按钮/主题/菜单
│   └── popup.html + popup.js        # 弹窗：配置 PIN + 服务器
├── pc-app-Electron/                 # Electron PC 端
│   ├── main.js / preload.js         # 主进程 + 预加载
│   ├── phone-connection-manager.js  # 手机连接管理
│   ├── modules/settings.js          # 服务器同步
│   └── renderer/                    # 前端界面
├── pc-app-go/                       # Go PC 端 (轻量版)
│   ├── app.go                       # HTTP + WS 服务 + 启动
│   ├── cloud.go                     # 云中继同步
│   └── devices.go                   # 设备/PIN 校验
├── android-app/                     # Android 手机端
│   └── app/src/main/java/com/autodial/app/
│       ├── MainActivity.kt          # 4 Tab + ViewPager + 底部导航
│       ├── ConnectFragment.kt       # 设置页（连接/策略/主题/通知）
│       ├── CallLogFragment.kt       # 通话记录
│       ├── RegisterFragment.kt      # 录上门
│       ├── StatsFragment.kt         # 财库统计
│       ├── ConnectionManager.kt     # WS 连接管理
│       ├── DialService.kt           # 拨号前台服务
│       ├── DialEngine.kt            # 拨号引擎
│       ├── CloudCtrl.kt             # 云服务器管理 CRUD + 同步
│       ├── CloudServerSheet.kt      # 云服务器管理弹窗
│       ├── ThemeManager.kt          # 16 套主题 + 7 级亮度
│       ├── ThemeDialog.kt           # 主题选择弹窗
│       ├── DialMode.kt / DialModeSheet.kt        # 拨号模式
│       ├── ConnectionStrategySheet.kt             # 连接策略
│       ├── DialAnimationOverlay.kt / AnimationSheet.kt  # 拨号动画
│       ├── CallDetailSheet.kt       # 通话详情
│       ├── DialPadSheet.kt          # 拨号盘
│       ├── DialAccessibilityService.kt  # 无障碍拨号
│       └── PrefCtrl.kt              # SharedPrefs 封装
├── 设计文档/                         # UI 设计规范
├── 技术文档/                         # 各端技术文档
├── 场景测试列表.md                   # 50 场景覆盖
├── 场景检测报告.md                   # 代码审计结果
├── 待验证问题.md                     # QA 验证清单
└── CHANGELOG.md                      # 版本更新日志
```

## 快速启动

### 1. 云中继

```bash
cd cloud-relay/python
pip install websockets pystray Pillow
python cloud_relay_v2.py
```

启动后 WebSocket + REST API + Web 面板均监听 35430 端口。

### 2. Chrome 扩展

1. Chrome 打开 `chrome://extensions/` → 开启"开发者模式"
2. 点击"加载已解压的扩展程序"，选择 `AutoDial-Extension/` 目录
3. 打开 CRM 页面（guwen.zhudaicms.com），自动检测坐席手机号为 PIN
4. 点击扩展图标可配置服务器地址

### 3. Go / Electron PC 端

```bash
# Go 版
cd pc-app-go && go build -o autodial-pc.exe . && autodial-pc.exe

# Electron 版
cd pc-app-Electron && npm install && npm start
```

### 4. Android 手机端

使用 Android Studio 打开 `android-app/` 构建，或下载 GitHub Actions 自动构建的 APK。

## REST API（云中继 35430）

所有响应格式：`{"ok": bool, "code": "xxx", "message": "xxx"}`

### 核心拨号

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/dial?number=xxx` | 拨号 → `ACCEPTED` / `PHONE_OFFLINE` / `PC_CONNECTED` |
| GET | `/api/v1/hangup` | 挂断 → `ACCEPTED` |
| GET | `/api/v1/status` | 查询 PC/手机/扩展在线状态 |

### 登记管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/visit?name=...&mobile=...&kefu_tel=...&visit_type=...` | 一键登记 |
| GET | `/api/v1/visits?pin=...` | 查询登记列表（支持 unsynced 筛选） |
| GET | `/api/v1/visit/update?id=N&...` | 更新登记记录 |
| GET | `/api/v1/visit/delete?id=N` | 删除登记记录 |

### 顾问管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/advisor/register?pin=...&name=...` | 注册顾问 |
| GET | `/api/v1/advisor/name?pin=...` | 查询顾问姓名 |
| GET | `/api/v1/advisor/is_admin?pin=...` | 是否管理员 |
| GET | `/api/v1/advisor/set_admin?pin=...` | 设为管理员 |
| GET | `/api/v1/advisor/del_admin?pin=...` | 取消管理员 |

### PIN 分组管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/pins` | 所有 PIN 列表 |
| GET | `/api/v1/pin/set_group?pin=...&group=...` | 设置 PIN 分组 |
| GET | `/api/v1/groups` | 分组列表 |
| GET | `/api/v1/group/add?name=...` | 添加分组 |
| GET | `/api/v1/group/del?name=...` | 删除分组 |

### 运维

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（含 CORS） |
| GET | `/api/status` | 仪表盘状态 |
| GET | `/api/clients` | 在线客户端列表 |
| GET | `/api/stats` | 流量统计 |
| GET | `/api/logs` | 最近 100 条日志 |
| GET | `/` | Web 管理面板 (dashboard.html) |

### 错误码

| code | 含义 |
|------|------|
| `ACCEPTED` | 指令已接受 |
| `INVALID_PIN` | PIN 格式无效（非 4 位或 11 位数字） |
| `PHONE_OFFLINE` | 手机未连接云中继 |
| `PC_CONNECTED` | PC 在线，应走本地直连 |
| `DUPLICATE_DIAL` | 5 秒内同号码重复拨号 |
| `MISSING_FIELDS` | 缺少必填字段 |
| `MISSING_PIN` | 缺少 PIN 参数 |
| `DB_ERROR` | 数据库操作失败 |

## 双模路由

```
扩展拨号:
1. 尝试 HTTP 127.0.0.1:35432 (PC 直连, 2s 超时)
2. PC 不可达 → 云中继 /api/v1/dial (Header PIN)
   ├─ PC_CONNECTED → 提示切回本地
   ├─ PHONE_OFFLINE → 提示手机离线
   └─ ACCEPTED → 拨号成功
```

## 连接策略（Android）

| 策略 | 说明 |
|------|------|
| 自动 (LAN优先) | 先尝试局域网直连 PC，不可用则走云中继 |
| 仅局域网 | 只连同一局域网内的 PC，不启用云中转 |
| 仅云中转 | 仅通过云服务器连接，适合不同网络环境 |

## 全链路 PIN 校验

| 环节 | 校验 | 位置 |
|------|------|------|
| 扩展设置 PIN | `/^\d{4}$|^\d{11}$/` | popup.js |
| 扩展请求云端 | `X-AutoDial-PIN` Header | background.js |
| 云中继 REST | `validate_pin()` → 4/11 位纯数字 | cloud_relay_v2.py |
| Go PC 端 | `isValidPhonePIN()` → 4/11 位纯数字 | devices.go |

## 数据同步

- 插件/手机端登记 → 云中继 SQLite → WS `visit_record` 推手机
- 手机在线 → 实时收到 + 通知 + 统计刷新
- 手机离线 → pending_visits 堆积 → 重连时补推
- `cloud_server` 空时自动选列表第一台为当前服务器

## 注意事项

1. 云中继端口 35430 需防火墙放行
2. Android 端需授予拨号、通话记录、通知权限
3. MIUI/HyperOS 需加入电池白名单
4. Xiaomi 设备在"设置→无障碍"中开启 AutoDial 服务
5. PC 端和云中继可同时运行，扩展自动优先 PC 直连
