# AutoDial Android 端技术文档

> 版本：v4.0 | 更新：2026-06-06

---

## 一、项目概述

**A跨屏拨号** 是一款专为电销场景设计的 Android 应用。用户在电脑端点击号码，手机自动拨号，无需手动操作手机。

核心技术栈：Kotlin + OkHttp WebSocket + UDP 广播 + SQLite

---

## 二、架构总览

```
┌──────────────────────────────────────────────────┐
│                   MainActivity                     │
│  ┌─────────────┬─────────────┬──────────────────┐ │
│  │ ConnectFrag │ CallLogFrag │   StatsFragment  │ │
│  │  (连接页)    │  (通话记录)  │    (统计页)       │ │
│  └──────┬──────┴─────────────┴──────────────────┘ │
│         │ ViewPager2 (底部3个Tab)                  │
└─────────┼────────────────────────────────────────┘
          │ startService / stopService
          ▼
┌──────────────────────────────────────────────────┐
│                 DialService                        │
│   Foreground Service (通知栏常驻)                   │
│   ┌─────────────────────────────────────────┐     │
│   │         ConnectionManager v7             │     │
│   │  ┌──────────┐  ┌───────────────────┐    │     │
│   │  │ LAN通道   │  │   Cloud通道        │    │     │
│   │  │ UDP发现   │  │   ws://relay:35430 │    │     │
│   │  │ ws://pc   │  │   多服务器遍历      │    │     │
│   │  └──────────┘  └───────────────────┘    │     │
│   │          transportMode: lan/cloud/lan+cloud│  │
│   └─────────────────────────────────────────┘     │
│   ┌─────────────┐  ┌──────────────────────┐       │
│   │ DialEngine  │  │    CallLogDb (SQLite) │       │
│   │ 拨号执行     │  │   通话记录/统计       │       │
│   └─────────────┘  └──────────────────────┘       │
└──────────────────────────────────────────────────┘
```

---

## 三、核心模块详解

### 3.1 ConnectionManager v7（连接管理器）

**职责**：管理 LAN + Cloud 双通道连接生命周期

**状态机**：
```
DISCONNECTED → DISCOVERING → CONNECTING → CONNECTED
     ↑                            │            │
     └──────── 超时/失败 ──────────┘            │
                                               │
     transportMode: "" | "lan" | "cloud" | "lan+cloud"
```

**连接策略** (`ConnectionStrategy`)：
| 策略 | 枚举值 | 行为 |
|------|--------|------|
| 自动(LAN优先) | AUTO | 同时尝试LAN+Cloud，谁先通谁亮 |
| 仅局域网 | LAN_ONLY | 仅UDP发现+LAN直连，不连Cloud |
| 仅云中转 | CLOUD_ONLY | 跳过LAN，直连云中继 |

**关键常量**：
- LAN端口: 35432 (WebSocket直连)
- 发现端口: 35433 (UDP广播)
- 心跳: 30s间隔, 15s pong超时
- 发现超时: 8s, 最多4次(间隔1m→2m)
- LAN恢复: 最多10次(每60s), WiFi不可用时跳过
- 重连阶梯: 0s→1s→3s→5s→10s→30s→60s→5m (最多30次)

**Thread Safety**：
- `manualDisconnecting`: `@Volatile` 修饰，跨线程可见
- `transportMode`: `@Volatile` 修饰
- 所有Handler回调在主线程执行, OkHttp回调在IO线程

---

### 3.2 DialService（前台服务）

**职责**：常驻后台，接收PC端拨号指令

**生命周期**：
- `onCreate`: 初始化ConnectionManager, 注册NetworkMonitor, 注册亮屏广播
- `onStartCommand`: 处理CONNECT/DISCONNECT/DIAL_WITH_SIM/DIAL_CANCELLED intent
- `onDestroy`: 清理所有连接和监听器

**Intent Actions**：
| Action | 说明 |
|--------|------|
| CONNECT | 发起连接(携带ip+pin) |
| DISCONNECT | 断开所有连接 |
| DIAL_WITH_SIM | SimSelect返回选卡结果 |
| DIAL_CANCELLED | 用户取消选卡 |

**关键设计**：
- START_STICKY: 被系统杀死后自动重启
- WakeLock: 12小时PARTIAL_WAKE_LOCK防止CPU休眠
- 亮屏广播: 屏幕亮起时检查WebSocket是否僵尸
- 通话状态监听: 通话结束时通知UI刷新

---

### 3.3 DialEngine（拨号引擎）

**职责**：封装拨号逻辑，支持7种SIM卡选择模式

**SIM卡选择模式** (`DialMode`)：
| 模式 | 行为 |
|------|------|
| 弹窗选卡 | 每次弹出卡片让用户选择 |
| 智能轮选 | 打过→弹窗; 没打过→循环 |
| 相反 | 2天内→反向; 超过2天→弹窗 |
| 卡1/卡2 | 固定使用指定卡 |
| 循环 | 全局交替卡1→卡2→卡1 |
| 系统默认 | 由系统选择器决定 |

**拨号执行**：
1. `placeCall()` (TelecomManager) - 优先
2. `ACTION_CALL` intent - 回退
3. 小米设备特殊处理: `DialAccessibilityService.expectSimPicker()`

---

### 3.4 CloudCtrl（云服务器配置管理）

**职责**：纯后端CRUD + 连通测试

**方法**：
- `getServerList() / saveServerList()`: 持久化到SharedPreferences
- `testServer(server)`: HTTP GET 健康检查 (4s超时)
- `testAllServers(servers)`: 并发测试所有服务器
- `normalizeServer(input)`: 自动补ws://前缀
- `fetchServerListFromGist()`: 从Gist同步服务器列表

---

### 3.5 UI 模块

| 页面 | 功能 |
|------|------|
| ConnectFragment | 配对码输入、连接/断开、高级设置(策略/动画/服务器)、主题 |
| CallLogFragment | 通话记录列表、拨号模式快捷切换栏 |
| StatsFragment | 今日/一周/本月财运统计、7天趋势图 |

**ThemeManager**：16套主题 × 7级亮度 = 112种组合，通过tag属性批量应用

---

### 3.6 辅助模块

| 模块 | 说明 |
|------|------|
| FileLogger | 文件日志(24h保留, 10MB上限) |
| CallLogDb | SQLite通话记录+SIM缓存 |
| BootReceiver | 开机自启 |
| DialAccessibilityService | 无障碍服务，辅助小米SIM卡选择 |
| SimSelectOverlay | 悬浮窗选卡弹窗 |
| DialAnimationOverlay | 10种拨号成功动画 |
| SmsConfirmActivity | 短信确认弹窗 |

---

## 四、通信协议

### 4.1 LAN 发现
```
手机 → UDP广播(255.255.255.255:35433)
  {"type":"discover","pin":"1234"}
PC → UDP单播回复
  {"type":"found","ip":"192.168.1.5","pin":"1234"}
```

### 4.2 WebSocket 消息

**握手**：
```
手机→PC/Relay: {"type":"phone_hello","pin":"1234","deviceName":"Xiaomi 14"}
PC/Relay→手机: {"type":"auth_ok","pin":"1234"}
```

**拨号**：
```
PC→手机: {"type":"dial","number":"13800138000","messageId":"ack_123"}
手机→PC: {"type":"ack","messageId":"ack_123","originalType":"dial"}
手机→PC: {"type":"dial_result","number":"13800138000","status":"ok"}
```

**心跳**：30s间隔发送 `{"type":"ping"}`，回复 `{"type":"pong"}`

**云端唤醒**：`{"type":"reconnect_request"}` 指示手机立即重连

---

## 五、安全与隐私

- 配对码: 4位数字PIN (已知安全风险，后续需加强)
- 通信: WebSocket 明文传输 (无TLS)
- 签名证书: PKCS12 (RSA 2048 + SHA256)

---

## 六、构建与发布

- **编译**: Gradle 8.2, JDK 17
- **最低SDK**: API 24 (Android 7.0)
- **目标SDK**: API 34 (Android 14)
- **混淆**: ProGuard (release)
- **CI/CD**: GitHub Actions (`android-build.yml`)
