# AutoDial 一键拨号系统 v4.1.0

> 最后修改：2026-06-30 21:15 | 登记页重构(CRM kid适配) | 云端管理面板升级 | 姓名自动检测 | PIN分组管理

## 项目概述

AutoDial 是一套跨屏一键拨号+来访登记系统。用户在 CRM 网页中点击手机号自动拨号；右键悬浮按钮即可完成客户登记，数据实时同步云端和手机端。

**v4.1.1 更新**：
- 登记 CRM kid 适配：插件和手机端改为两步提交（姓名→kid→CRM），解决登记假成功问题
- CRM 姓名自动检测：插件端 CSS 选择器自动抓取业务员姓名，无需手动输入
- 云端管理面板重构：PIN/分组/管理员/未同步筛选/CSV导出/趋势图
- 手机端离线补推：云端断连期间登记记录自动缓存，重连后补推
- Android 端「录上门」模块（第 2 个 Tab），顾问姓名从 CRM 列表选择
- 云中继 SQLite 存储 + Web 管理面板「上门记录」Tab
- 全链路同步：插件/手机端登记 → 云中继 → WS 推手机 → 统计实时更新
- 上门统计卡片：今日/本周/近7天/当月/上月/近30天

## 系统架构

```
                       ┌──────────────────────────────────┐
                       │   云中继 (端口 35430)               │
                       │   cloud_relay_v2.py               │
                       │                                  │
     GET + Header PIN  │   WebSocket 中继                   │
   ┌───────────────────│   REST API (dial/hangup/visit)    │──────────────────┐
   │                   │   SQLite visits 表                │                  │
   │   📝 一键登记     │   Web 管理面板（含上门记录）         │                  │
   │                   └────────────┬─────────────────────┘                  │
   ▼                                │  WS visit_record                      ▼
┌──────────────────┐                │                       ┌──────────────────┐
│ Chrome 扩展 v4.1  │  HTTP 35432   │                       │ Android 手机端     │
│                  │◄──────────────┼───────────────────────│                  │
│ PIN 自动检测      │   Go PC 端     │                       │ WS 连接云中继     │
│ 双模路由         │               │                       │ 接收 dial/hangup  │
│ 一键登记+确认弹窗 │               │                       │ 录上门模块         │
│ 主题/浮动按钮     │               │                       │ 📊 上门统计卡片   │
└──────────────────┘               │                       └──────────────────┘
                                    │
                           手机离线 → pending_visits → 重连补推
```

## 端口配置

| 端口 | 协议 | 用途 |
|------|------|------|
| **35430** | WebSocket + HTTP | 云中继（WS 中继 + REST API + Web 管理面板 + 访问登记 API） |
| 35432 | HTTP + WebSocket | PC 端主服务（局域网直连） |

> 旧版 v3 JWT 端口 35440/35441 已废弃，统一到 35430。

## 目录结构

```
├── cloud-relay/python/
│   ├── cloud_relay_v2.py            # ★ 云中继（WS + REST + 访问登记 + Web面板）
│   ├── dashboard.html               # Web 管理界面（含上门记录管理Tab）
│   └── visits.db                    # SQLite 访问登记数据库（自动创建）
├── AutoDial-Extension/              # ★ Chrome 扩展 v4.1
│   ├── background.js                # PIN 管理 + 双模路由 + 一键登记
│   ├── content-script.js            # 8 套主题 + 浮动按钮 + CRM 检测 + 姓名识别
│   ├── popup.js / popup.html        # PIN 设置 + 服务器配置
│   └── manifest.json                # MV3 清单
├── pc-app-go/                       # Go PC 端（局域网直连）
│   └── server.go                    # HTTP API + WebSocket + 4/11 位 PIN 校验
├── android-app/                     # Android 手机端
│   └── app/src/main/java/com/autodial/app/
│       ├── MainActivity.kt          # 4 Tab（设置/记录/统计/登记）
│       ├── RegisterFragment.kt      # 录上门（顾问姓名从CRM选择）
│       ├── StatsFragment.kt         # 统计页（含上门统计卡片）
│       └── ConnectionManager.kt     # WS 连接管理（含 visit_record 处理）
└── 技术文档/                         # 详细技术文档
```

## 快速启动

### 1. 云中继

```bash
cd cloud-relay\python
pip install websockets pystray Pillow
python cloud_relay_v2.py
```

启动后：
- WebSocket 中继：`ws://localhost:35430`
- REST API：`http://localhost:35430`
- Web 管理面板：`http://localhost:35430`（浏览器打开）

### 2. Chrome 扩展

1. Chrome 打开 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"，选择 `AutoDial-Extension/` 目录
4. 点击扩展图标 → 设置服务器地址（默认 `http://IP:35430`）→ 确认 PIN
5. 打开 CRM 页面，自动检测坐席手机号为 PIN

### 3. Go PC 端

```bash
cd pc-app-go
go build -o autodial-pc.exe server.go
autodial-pc.exe
```

### 4. Android 手机端

使用 Android Studio 打开 `android/` 目录构建。

## REST API（端口 35430）

所有响应：`{"ok": bool, "code": "xxx", "message": "xxx"}`

PIN 通过 `X-AutoDial-PIN` Header 传递，号码通过 URL query。

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/dial?number=13900139000` | 拨号 → `ACCEPTED` |
| GET | `/api/v1/hangup` | 挂断 → `ACCEPTED` |
| GET | `/api/v1/status` | 查询 PC/手机在线状态 |
| GET | `/api/v1/visit?name=...&mobile=...` | **新增** 一键登记 |
| GET | `/api/v1/visits?pin=...` | **新增** 查询登记列表 |
| GET | `/api/v1/visit/update?id=N&...` | **新增** 更新登记记录 |
| GET | `/api/v1/visit/delete?id=N` | **新增** 删除登记记录 |
| GET | `/health` | 健康检查（含 CORS，供 popup 测试连接） |
| GET | `/api/status` | 仪表盘状态（内部管理用） |
| GET | `/api/clients` | 客户端列表 |
| GET | `/api/stats` | 流量统计 |
| GET | `/api/logs` | 系统日志 |

### 错误码

| code | 含义 |
|------|------|
| `ACCEPTED` | 指令已接受 |
| `INVALID_PIN` | PIN 非 4 位或 11 位数字 |
| `PHONE_OFFLINE` | 手机未连接云中继 |
| `PC_CONNECTED` | PC 在线，应走本地直连 |
| `DUPLICATE_DIAL` | 5 秒内同号码重复 |
| `MISSING_FIELDS` | 缺少必填字段（name/mobile/kefu_tel） |
| `MISSING_PIN` | 缺少 PIN 参数 |
| `DB_ERROR` | 数据库操作失败 |

## 双模路由

```
扩展拨号:
1. 尝试 http://127.0.0.1:35432/dial  → PC 在线 → 走本地
2. PC 不可达 → GET 云中继 /api/v1/dial (Header PIN) 
   ├─ PC_CONNECTED → 切回本地
   ├─ PHONE_OFFLINE → 提示手机未连
   └─ ACCEPTED → 完成
```

## 全链路 PIN 校验

| 环节 | 校验 | 位置 |
|------|------|------|
| 扩展设置 PIN | `/^\d{4}$\|^\d{11}$/` 正则 | popup.js |
| 扩展请求云端 | X-AutoDial-PIN Header | background.js |
| 云中继 REST | `validate_pin()` → 4位或11位纯数字 | cloud_relay_v2.py |
| 云中继 WS | 同上 | cloud_relay_v2.py |
| Go PC 端 | `isValidPhonePIN()` → 4位或11位纯数字 | devices.go |

## 部署依赖

| 组件 | 依赖 | 说明 |
|------|------|------|
| 云中继 | `websockets pystray Pillow` | Python 标准库 sqlite3（内置） |
| Go PC 端 | Go 1.21+ | 单文件 |
| Chrome 扩展 | 无 | 6 文件 |

## 新功能：一键登记

顾问在 CRM 客户详情页右键悬浮按钮 → 「📝 一键登记」→ 确认弹窗 → 云端存储+CRM同步+手机通知。

```
流程：CRM详情页 → 自动识别姓名+手机号 → 右键确认 → 云中继存储+CRM同步 → WS推手机 → 统计+1
```

## 新功能：录上门（Android）

App 底部导航第 2 个 Tab「录上门」，顾问姓名从 CRM 列表点击选择，事由固定「贷款咨询」，
成功提交后自动同步云端+CRM。

## 新功能：上门统计

统计页新增「📊 上门统计」卡片，展示 6 个维度：今日/本周/近7天/当月/上月/近30天。
插件登记和手机端登记数据实时互通。

## 数据同步机制

- 插件/手机端登记 → 云中继 SQLite 存储 → WS `visit_record` 推手机
- 手机在线 → 实时收到 + 系统通知 + 统计刷新
- 手机离线 → pending_visits 堆积 → phone_hello 重连时补推（失败保留队列，下次重试）
- 云中继重启 → pending_visits 丢失（内存队列，可接受）

## 注意事项

1. 云中继端口 35430 需防火墙放行（程序启动时自动配置）
2. Android 端需授予拨号、通话记录、通知等权限
3. MIUI/HyperOS 需将应用加入电池白名单
4. Xiaomi 设备在"设置→无障碍"中开启 AutoDial 服务
5. PC 端和云中继可同时运行，扩展自动优先走 PC 直连
