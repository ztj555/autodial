# AutoDial Android 端技术文档

> 最后修改：2026-06-30 21:15 | Kotlin | 包名 `com.autodial.app` | 登记kid适配 + 离线补推 + 姓名查询

---

## 一、项目结构

```
android/app/src/main/java/com/autodial/app/
├── DialService.kt              # 前台服务（主入口）
├── ConnectionManager.kt        # 连接状态机 + 双通道管理
├── DialEngine.kt               # 拨号执行引擎 + SIM 选择
├── CallLogDb.kt                # SQLite 通话记录数据库
├── CloudCtrl.kt                # 云服务器配置 CRUD + 连通测试
├── DialMode.kt                 # 拨号模式枚举
├── MainActivity.kt             # 主界面（ViewPager2 + 3 Tab）
├── ConnectFragment.kt          # 连接管理页
├── CallLogFragment.kt          # 通话记录页
├── StatsFragment.kt            # 统计页
├── DialAccessibilityService.kt # 无障碍服务（SIM 自动点击）
├── DialAnimationOverlay.kt     # 拨号动画悬浮窗
├── SimSelectOverlay.kt         # SIM 选卡悬浮窗
├── SmsConfirmActivity.kt       # 短信确认 Activity
├── FileLogger.kt               # 文件日志工具
├── BootReceiver.kt             # 开机自启广播接收器
├── ThemeManager.kt             # 主题管理（多套配色）
├── ThemeDialog.kt              # 主题选择对话框
├── ViewPagerAdapter.kt         # ViewPager2 适配器
└── ConnectionStrategy.kt       # 连接策略枚举（AUTO/LAN_ONLY/CLOUD_ONLY）
```

---

## 二、连接方式（PIN + JWT 双兼容）

> **说明**：Android v4.53 同时支持 PIN 认证（主用，连接云中继 v2:35430）和 JWT 认证（兼容旧版，连接云中继 v3:35440）。推荐使用 PIN 方式，JWT 方式为向后兼容保留。

### PrefCtrl — JWT 字段

```kotlin
fun getJwtToken()       // SharedPreferences "jwt_token"
fun setJwtToken(token)
fun getRefreshToken()   // "refresh_token"
fun setRefreshToken(token)
fun getLoginPhone()     // "login_phone"
fun setLoginPhone(phone)
```

### ConnectFragment — 登录流程

当用户在连接页输入 11 位手机号：
1. 检查 `PrefCtrl.getJwtToken()` 是否有已保存的 JWT
2. 有 JWT → `auth_method: "jwt"` 直连云中继 v3 (35440)
3. 无 JWT → 弹出登录对话框 → POST `/api/v1/auth/login` → 保存 JWT + refresh_token

### ConnectionManager — 双模握手

```kotlin
val token = prefs.getString("jwt_token", "") ?: ""
if (token.isNotEmpty()) {
    hello.put("auth_method", "jwt")
    hello.put("token", token)
} // else 传统 PIN 方式
```

### 云中继地址转换

```kotlin
// ws://server:35440 → http://server:35441
fun getCloudApiUrl(): String {
    return server.replace("ws://", "http://")
        .replace(":35440", ":35430")  // v4: 云中继统一到 35430
}
```

---

## 三、DialService — 前台服务

### 2.1 生命周期

```
BootReceiver / MainActivity.startService()
  → DialService.onCreate()
    → FileLogger.init()          # 初始化日志
    → callLogDb 初始化
    → startForeground()          # 前台通知
    → wakeLock.acquire(12h)      # CPU唤醒锁
    → syncFromSystemCallLog()    # 同步系统通话记录（异步线程）
    → registerCallStateListener() # 通话状态监听
    → connectionManager = ConnectionManager()  # 创建连接管理器
    → registerNetworkMonitor()    # 网络变化监听
    → registerScreenOnReceiver()  # 亮屏广播
    → loadSavedConfig()           # 加载配置并自动连接
  → onStartCommand()              # 处理 Intent 指令
```

### 2.2 Intent Actions

| Action | 来源 | 说明 |
|--------|------|------|
| `ACTION_EXECUTE_PENDING_DIAL` | 通知点击 | 执行后台待拨号码 |
| `CONNECT` | 连接页 | 携带 ip、pin 发起连接 |
| `DISCONNECT` | 连接页 | 主动断开所有连接 |
| `DIAL_WITH_SIM` | SIM 选卡弹窗 | 携带 number、sim_slot 执行拨号 |
| `DIAL_CANCELLED` | SIM 选卡取消 | 取消待拨号码 |

### 2.3 通知管理

- **前台通知**（NOTIFICATION_ID=1001）："跨屏拨号 运行中"，静默无振动
- **后台拨号通知**（NOTIFICATION_ID=1002）：全屏 Intent 拉起 Activity，3 秒自动取消
- **后台短信通知**（NOTIFICATION_ID=2001）：PendingIntent 指向 SmsConfirmActivity
- **通知渠道**：`IMPORTANCE_DEFAULT`，名为"跨屏拨号 服务"

### 2.4 广播通信

DialService 通过本地广播与 UI 层通信：

| Action | 携带数据 | 用途 |
|--------|----------|------|
| `CONNECTION_CHANGE` | connected, mode, reason | 通知 UI 连接状态变化 |
| `NEW_DIAL` | number | 通知 UI 新增拨号记录 |
| `CALL_ENDED` | - | 通话结束，通知刷新记录 |
| `LAST_CALL_HINT` | number, hint | 号码上次拨号信息 |
| `SHOW_SIM_SELECT` | number, last_sim_slot, last_dial_time | 触发 SIM 选卡弹窗 |
| `SHOW_SMS_CONFIRM` | number, content | 触发短信确认界面 |
| `CLOUD_STATUS` | connected, mode | 云端连接状态变化 |

---

## 三、ConnectionManager — 连接状态机

### 3.1 状态定义

```
DISCONNECTED ──→ DISCOVERING ──→ CONNECTING ──→ CONNECTED
     ↑                                              │
     └──────────── 断线/超时 ──────────────────────┘
```

### 3.2 连接策略

```kotlin
enum class ConnectionStrategy {
    AUTO,       // 同时发起 LAN 发现 + 云端连接，先到先用
    LAN_ONLY,   // 仅 LAN 发现和连接
    CLOUD_ONLY  // 仅云端连接
}
```

### 3.3 LAN 发现

- UDP 广播到 `255.255.255.255:35433`
- 发送 3 次 discover 请求，间隔 200ms
- 等待 8 秒收集响应
- 发现序列：首次 60s 后，后续每 120s，最多 4 次

### 3.4 LAN 连接

- OkHttp WebSocket 客户端
- 连接超时 5s，读超时 45s，ping 间隔 30s
- TCP KeepAlive：15s idle, 5s interval, 3 probes
- 发送 `phone_hello{pin, deviceName}` 握手

### 3.5 云端连接

- OkHttp WebSocket 客户端（独立 client 实例）
- 连接超时 6s
- 从 `cloud_servers` 列表遍历尝试，成功一个即停止
- 发送 `phone_hello{pin, deviceName, messageId}` 握手
- `auth_ok` 响应中检查 `pc_present` 字段：
  - `true` → PC 在线
  - `false` → 发起 PC 探活（8s 超时等 ACK）

### 3.6 PC 真探活（v4.57）

1. `phone_hello` 携带 `messageId = "probe_<timestamp>"`
2. PC 收到后回复 `ack{messageId}`
3. 云中继转发 ACK 回手机 → 标记 `pcConfirmedOnline = true`
4. 8 秒超时无 ACK → `pcConfirmedOnline` 保持 `false`

### 3.7 公开属性

```kotlin
val isConnected: Boolean       // 状态 CONNECTED 且对应通道存活
val isPcReachable: Boolean     // LAN已连 或 (Cloud已连 且 pcConfirmedOnline)
val isLanConnected: Boolean    // LAN WebSocket 存在
val isCloudConnected: Boolean  // Cloud WebSocket 存在
val transportMode: String      // "lan" / "cloud" / "lan+cloud"
```

### 3.8 重连退避

```
尝试次数:  1    2    3    4-6   7-10  11-15  16-20   21+
延迟:     0s   1s   3s   5s    10s   30s    60s    300s
```

- LAN 最大 30 次，Cloud 最大 8 次
- 网络变化时重置计数器（2s 防抖）

### 3.9 网络监控

`registerNetworkMonitor()` 注册 `ConnectivityManager.NetworkCallback`：
- `onAvailable` → 触发重连（2s 防抖）
- `onLost` → 标记断线，停止 LAN 发现
- WiFi 打开 → 启动 LAN 发现序列；WiFi 关闭 → 停止 LAN 发现

---

## 四、DialEngine — 拨号执行引擎

### 4.1 拨号模式

| 模式 | key | resolveSimSlot() 逻辑 |
|------|-----|----------------------|
| POPUP | `popup` | 始终返回 -1（弹窗） |
| ROUND_SELECT | `round_select` | 10 天内打过→-1（弹窗）；否则→轮流 |
| OPPOSITE | `opposite` | 2 天内打过→反向卡；否则→轮流 |
| SIM1 | `sim1` | 始终返回 0 |
| SIM2 | `sim2` | 始终返回 1 |
| ALTERNATE | `alternate` | 全局交替（与上次相反） |
| SYSTEM | `system` | 返回 -2（系统拨号器） |

### 4.2 SIM 信息解析

`getPhoneAccountHandle(simSlot)` 通过多层方案匹配 PhoneAccountHandle：
1. 通过 `SubscriptionManager.activeSubscriptionInfoList` 获取 SIM 列表
2. 遍历 `telecomManager.callCapablePhoneAccounts`
3. 匹配 subscriptionId / iccId / simSlotIndex
4. 回退尝试已知组件名（AOSP/Xiaomi/MTK/华为）

### 4.3 拨号执行流程

```
dialNumber(number)
  ├── 检查 CALL_PHONE 权限
  ├── resolveSimSlot(number)
  │     ├── -2 (SYSTEM) → ACTION_CALL intent
  │     ├── >=0 (指定卡) → performDial(number, simSlot)
  │     └── -1 (弹窗) → 发送 SHOW_SIM_SELECT 广播 / 显示悬浮窗
  │
  └── performDial(number, simSlot)
        ├── getPhoneAccountHandle(simSlot)
        ├── [Xiaomi] DialAccessibilityService.expectSimPicker(simSlot)
        ├── telecomManager.placeCall(uri, extras)  ← 主路径
        │     └── 成功 → onDialSuccess()
        └── 失败 → fallback: ACTION_CALL intent
              └── 成功 → onDialSuccess()
              └── 失败 → onDialResult(number, "error")

onDialSuccess(number, simSlot)
  ├── service.onDialResult(number, "ok")  → 发回 PC
  ├── callLogDb.insertDial(number, "ok", simSlot)
  ├── notifyNewDial(number)              → 广播通知 UI
  ├── copyNumberToClipboard(number)      → 写入剪贴板
  └── showDialAnimation()                → 拨号动画
```

### 4.4 挂断

```kotlin
fun endCall() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        telecomManager.endCall()
    }
}
```

---

## 五、CallLogDb — 通话记录数据库

### 5.1 数据库结构

**SQLite 数据库**：`autodial.db`，DCL 单例，版本 2

**dial_log 表**：APP 自身拨号记录
| 列 | 类型 | 说明 |
|----|------|------|
| `_id` | INTEGER PK | 自增 |
| `number` | TEXT | 电话号码 |
| `dial_time` | INTEGER | 拨号时间戳 |
| `sim_slot` | INTEGER | SIM 卡槽（0/1） |
| `status` | TEXT | "ok" / "error" |

**sim_cache 表**：SIM 卡缓存（从系统通话记录同步）
| 列 | 类型 | 说明 |
|----|------|------|
| `number` | TEXT PK | 电话号码 |
| `sim_slot` | INTEGER | SIM 卡槽 |
| `call_time` | INTEGER | 最近通话时间 |

### 5.2 查询层级

```
getLastDialInfo(number, context)
  ├── 1. dial_log 表（APP 自身记录）
  ├── 2. sim_cache 表（系统同步缓存）
  └── 3. 系统 CallLog（实时查询，需传 Context）
```

### 5.3 初始化同步

服务启动时异步线程调用 `syncFromSystemCallLog()`，从系统 CallLog 查询呼出记录，匹配 SIM 信息后写入 `sim_cache`，上限 500 条。

---

## 六、辅助功能

### 6.1 DialAccessibilityService（无障碍服务）

**用途**：Xiaomi/HyperOS 设备上自动点击系统 SIM 选择器

**工作流程**：
1. `DialEngine.performDial()` 检测到 Xiaomi 设备 → 调用 `expectSimPicker(simSlot)`
2. 当系统弹出 SIM 选择弹窗（包名 `com.android.phone`）
3. 无障碍服务遍历节点树，查找"卡1"/"卡2"或运营商名称
4. 自动点击对应按钮，8 秒超时自动清除

**需要用户手动在系统设置中开启**。

### 6.2 SimSelectOverlay（SIM 选卡悬浮窗）

自定义 SIM 选卡界面，需要 `SYSTEM_ALERT_WINDOW` 权限。显示号码历史拨号信息（SIM 卡 + 时间）。

### 6.3 DialAnimationOverlay（拨号动画）

三种模式：`MODE_BOUNCE`（弹跳）、`MODE_PULSE`（脉冲）、`MODE_OFF`（关闭）。

### 6.4 SmsConfirmActivity（短信确认）

当手机在后台时收到短信请求，通过通知栏提示用户点击进入确认界面。前台时直接通过广播触发。

### 6.5 BootReceiver（开机自启）

监听 `ACTION_BOOT_COMPLETED`，自动启动 DialService。

---

## 七、CloudCtrl — 云服务器配置

### 7.1 服务器列表管理

- 存储：SharedPreferences `cloud_servers`（JSON Array）
- 默认服务器：`ws://262ao85kz470.vicp.fun:55535`
- 支持 CRUD 操作
- 向后兼容旧的 `cloud_server`（单字符串）配置

### 7.2 连通性测试

- `testServer(server)`：HTTP GET 测试，4 秒超时
- `testAllServers(servers)`：协程并发测试所有服务器
- 自动将 `ws://` 转为 `http://` 进行 HTTP 连通性探测

### 7.3 Gist 同步

- `fetchServerListFromGist()`：从 GitHub Gist 或 Gitee 拉取服务器列表
- 多个源并发获取，合并去重

---

## 八、FileLogger — 文件日志

### 8.1 日志路径

三级回退策略：
1. `/sdcard/Download/AutoDial/logs/`（用户最易找到）
2. `/sdcard/Android/data/com.autodial.app/files/autodial-logs/`
3. 内部存储 `filesDir/autodial-logs/`

### 8.2 日志特性

- 文件名：`autodial-YYYY-MM-DD.log`
- 格式：`[HH:mm:ss.SSS] [I/W/E/D] [Module] content`
- 自动清理 7 天前的日志
- 10MB 单文件上限，超限滚动为 `.1.log`
- 后台 HandlerThread 异步写入，3 秒刷新缓冲
- 连续写入失败 3 次后降级为内存环形缓冲（1000 条上限）
- 同时输出到 Android Logcat

---

## 九、权限需求

| 权限 | 用途 | Android 版本要求 |
|------|------|-----------------|
| CALL_PHONE | 执行拨号 | 所有版本 |
| READ_PHONE_STATE | 监听通话状态 | 所有版本 |
| READ_CALL_LOG | 同步系统通话记录 | 所有版本 |
| SEND_SMS | 发送短信 | 所有版本 |
| ANSWER_PHONE_CALLS | 接听电话 | API 28+ |
| POST_NOTIFICATIONS | 前台通知 | API 33+ |
| READ_PHONE_NUMBERS | 读取本机号码 | API 23+ |
| SYSTEM_ALERT_WINDOW | SIM 选卡悬浮窗 | API 23+ |
| RECEIVE_BOOT_COMPLETED | 开机自启 | - |
| FOREGROUND_SERVICE | 前台服务 | API 28+ |
| BIND_ACCESSIBILITY_SERVICE | SIM 自动点击 | - |

---

## 十、构建配置

### 10.1 gradle 配置

- `android/build.gradle`：项目级构建
- `android/app/build.gradle`：应用级构建
- 签名：`autodial-release.p12`（密码：autodial2024，别名：autodial）
- ProGuard：`proguard-rules.pro`

### 10.2 GitHub Actions

`.github/workflows/android-build.yml` 定义了自动构建流水线：
- 触发：push 到 main/master 分支
- 输出：Debug APK + Release APK
- Secrets 需求：KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD

---

## v4.1.0 更新（2026-06-28）

### 新增组件

| 组件 | 文件 | 说明 |
|------|------|------|
| RegisterFragment | `RegisterFragment.kt` | 来访登记表单（第4个Tab「📝 登记」） |
| 上门统计 | `StatsFragment.kt` | 6维度统计卡片（今日/本周/近7天/当月/上月/近30天） |
| visit_record 处理 | `ConnectionManager.kt` | WS 消息 → 存时间戳 + 通知 + 统计刷新 |

### MainActivity 改动
- `activity_main.xml`：底部导航新增第4个Tab「📝 登记」
- `fragments` 列表新增 `RegisterFragment()`
- `switchTab()` 新增 index=3 分支

### 登记流程（v4.1.1 更新）
1. 「接待顾问姓名」可编辑输入，也可按 PIN 从云中继自动查询（`/api/v1/advisor/name`），持久化到 SharedPreferences
2. 来访事由固定「贷款咨询」
3. 提交 → `lookupKid()` 调 `/bserve/search` 姓名→ID → POST CRM API（`kid` 替代 `kefu_tel`）
4. 成功后按钮「✅ 登记成功」+ 2秒恢复
5. 后台 `syncToCloudRelay()` 同步云端，失败则 `savePendingVisit()` 入本地队列
6. 云端 WebSocket 重连后 `flushPendingSyncs()` 补推离线记录

### 上门统计
- 登记时间戳存储：`SharedPreferences("autodial")."registration_timestamps"`（逗号分隔 epoch millis，保留66天）
- visit_record WS 推送到达时自动存入 + 系统通知
- 监听 `com.autodial.VISIT_RECORDED` 广播自动刷新

### 性能优化
- `DialEngine.kt`：`simHandleCache` 缓存 PhoneAccountHandle（每次省50-100ms）
- 动画提前到 `placeCall()` 之前播放（用户即时感知）
