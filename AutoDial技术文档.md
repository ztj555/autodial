# AutoDial 技术文档 v4.0.0

> 基于实际代码 | 整合版：11pin 云端 + 11phone 扩展 | 全链路 11 位 PIN 强校验

---

## 一、版本演进

| 版本 | 云中继 | 认证方式 | 状态 |
|------|--------|----------|------|
| **v4** | `cloud_relay_v2.py`（整合升级版） | 11 位 PIN（坐席手机号） | ✅ 当前 |
| v3 | `cloud_relay_v3.py` | JWT（手机号+密码+bcrypt+SQLite） | 已废弃 |
| v2 | `cloud_relay_v2.py`（原始版） | 4 位 PIN 配对码 | 保留兼容 |

v4 的核心变化：**合并 JWT 和 PIN 两套体系的优点**——取 11pin 的 11 位 PIN 强校验 + 取 11phone 的扩展双模路由和自动检测，**去掉 JWT/SQLite/密码登录等重量依赖**。

---

## 二、云中继 v4（端口 35430）

### 2.1 架构

单文件部署，零数据库依赖，仅需 `websockets` 包。

```
cloud_relay_v2.py
├── WebSocket 中继（PIN 认证，11 位强校验）
│   ├── phone_hello → PinGroup 管理
│   ├── pc_hello → PinGroup 管理
│   ├── dial/hangup/sms → 转发到手机
│   └── dial_result/sms_result → 转发到 PC/扩展
├── REST API（GET + X-AutoDial-PIN Header）
│   ├── /api/v1/dial?number=xxx
│   ├── /api/v1/hangup
│   └── /api/v1/status
├── 管理 API
│   ├── /health（含 CORS）
│   ├── /api/status /api/clients /api/stats /api/logs
│   └── / （Web 管理面板 HTML）
└── 系统托盘（pystray，启停/日志/Web 面板）
```

### 2.2 PinGroup 分组管理

```python
class PinGroup:
    def __init__(self):
        self.pcs = set()       # PC WebSocket 连接
        self.phones = set()    # 手机 WebSocket 连接
        self.last_dial = {}    # {number: timestamp} REST 并发保护
```

- 同一 PIN 的设备自动归入同一组
- 双向转发：`forward_to_phones()` / `forward_to_pcs()`
- 所有设备断开时自动清理组
- 已有 14 项 bug 修复（Bug6/Bug9/v8 等）

### 2.3 REST 端点设计要点

**为何用 GET + Header 而非 POST body？**

`websockets` 的 `process_request(path, request_headers)` 回调只接收 path 和 headers 两个参数，**不接收 request body**。POST 的 JSON body 无法读取。解决方案：PIN 通过自定义 Header `X-AutoDial-PIN` 传递，号码通过 URL query `?number=`。

**为何 REST 端点不加 CORS？**

MV3 Chrome 扩展在 `manifest.json` 的 `host_permissions` 中声明目标域名后，`background.js` 的 `fetch()` 不受 CORS 限制。仅 `/health` 端点保留 CORS（供 popup 页面测试连接用）。

**为何用 `asyncio.ensure_future()`？**

`process_request` 是同步回调，不能直接 `await` 异步的 `forward_to_phones()`。用 `asyncio.ensure_future()` 将异步转发调度出去，同步返回 `202 ACCEPTED`。

### 2.4 并发保护

| 机制 | 实现 |
|------|------|
| PC_CONNECTED 去重 | REST 端点检查 `group.pcs` 非空 → 返回 `PC_CONNECTED`，让扩展走本地 |
| DUPLICATE_DIAL 去重 | `PinGroup.last_dial[number]`，5 秒内同号码拒绝 |
| 频率限制 | `check_rate_limit()`，每 IP 每分钟 5 次尝试 |
| 心跳超时 | WebSocket 内置 ping/pong（30s 间隔，90s 超时） |

---

## 三、REST API（端口 35430）

### 3.1 响应格式

```json
{"ok": true,  "code": "ACCEPTED"}
{"ok": false, "code": "INVALID_PIN", "message": "PIN 格式错误"}
```

### 3.2 拨号端点

**GET `/api/v1/dial?number=13900139000`**
```
Header: X-AutoDial-PIN: 13800138000
→ {"ok": true, "code": "ACCEPTED"}
```

处理流程：
1. PIN 11 位数字强校验
2. 检查 PinGroup.pcs → 有 PC 在线返回 `PC_CONNECTED`
3. 检查 PinGroup.phones → 无手机返回 `PHONE_OFFLINE`
4. 5 秒去重检查 → 同号码返回 `DUPLICATE_DIAL`
5. `asyncio.ensure_future(forward_to_phones(...))` → 返回 `ACCEPTED`

### 3.3 挂断端点

**GET `/api/v1/hangup`**
```
Header: X-AutoDial-PIN: 13800138000
→ {"ok": true, "code": "ACCEPTED"}
```

### 3.4 状态端点

**GET `/api/v1/status`**
```
Header: X-AutoDial-PIN: 13800138000
→ {"ok": true, "pin": "13800138000", "pcConnected": true, "phoneConnected": true, "phoneCount": 1}
```

### 3.5 错误码

| code | 含义 | 扩展处理 |
|------|------|---------|
| `ACCEPTED` | 指令已接受 | — |
| `INVALID_PIN` | PIN 非 11 位数字 | 提示检查 PIN |
| `PHONE_OFFLINE` | 手机未连接 | 提示手机未连接 |
| `PC_CONNECTED` | PC 在线，应走本地 | 切回 localhost |
| `DUPLICATE_DIAL` | 5 秒内同号码重复 | 忽略 |
| `RATE_LIMITED` | 频率限制 | 1 分钟后重试 |
| `INVALID_NUMBER` | 号码不合法 | 提示用户 |

---

## 四、WebSocket 协议（端口 35430）

### 4.1 握手协议

**手机端握手**：
```json
→ {"type": "phone_hello", "pin": "13800138000", "deviceName": "Redmi K40"}
← {"type": "auth_ok", "pin": "13800138000", "pcCount": 1, "pc_present": true}
← {"type": "auth_fail", "reason": "配对码必须为11位数字"}
```

**PC 端握手**：
```json
→ {"type": "pc_hello", "pin": "13800138000", "hostname": "DESKTOP-ABC"}
← {"type": "pc_auth_ok", "pin": "13800138000", "phoneCount": 1}
```

### 4.2 消息路由

| type | 方向 | 说明 |
|------|------|------|
| `phone_hello` | 手机→云→PC | 手机上线（含 deviceId） |
| `pc_hello` | PC→云→手机 | PC 上线 |
| `auth_ok` / `auth_fail` | 云→客户端 | 认证结果 |
| `dial` | PC/云→手机 | 拨号指令 |
| `dial_result` | 手机→云→PC | 拨号结果 |
| `hangup` | PC/云→手机 | 挂断 |
| `sms` / `sms_result` | PC⇌云⇌手机 | 短信指令/结果 |
| `ping` / `pong` | 双向 | 心跳 |
| `ack` | 手机→PC | ACK 确认 |
| `pc_online` / `pc_offline` | 云→手机 | PC 上下线通知 |

### 4.3 PIN 强校验

WebSocket 握手时对手机和 PC 均执行 11 位数字强校验：

```python
if not pin or len(pin) != 11 or not pin.isdigit():
    await ws.send(json.dumps({'type': 'auth_fail', 'reason': '配对码必须为11位数字'}))
    continue
```

---

## 五、Chrome 扩展 v4 实现

### 5.1 background.js（Service Worker）

**双模路由**：
- PC 直连优先（2s 超时），不可达时自动切云端
- 云端通过 `X-AutoDial-PIN` Header 认证
- PC 缓存失效时自动重置检测

**PIN 管理**：
- `getPin()`：优先手动设置的 `pin` → fallback CRM 自动检测的 `self_phone`
- 无需登录，无需密码，打开 CRM 页面即自动检测坐席号

**PC_CONNECTED 反向兜底**：
- 扩展以为 PC 不在线但云端发现 PC 实际在线 → 返回 `PC_CONNECTED` → 扩展刷新缓存切回本地

### 5.2 content-script.js（内容脚本）

**零改动整合**，保留 11phone 版全部能力：

- **8 套主题**：dark-gold / cyber-frost / deep-space / cyberpunk / minimalist / forest-green / energetic-orange / ocean-blue
- **浮动按钮**：拨号按钮（可拖动）+ 挂断按钮（可拖动 + 缩放手柄 36-100px）
- **CRM 检测**：TreeWalker 扫描坐席手机号 → `selfPhoneDetected` → 存为 PIN
- **右键菜单**：主题切换、拨号、短信、PC 状态、PIN 显示

### 5.3 popup.js / popup.html

- 云中继地址配置 + `/health` 连通性测试
- PIN（坐席手机号）设置，默认自动检测值
- `/api/v1/status` 实时查询 PC/手机在线状态

---

## 六、Go PC 端

`server.go`（525 行，零改动整合）—— 已是两版中最优版本：

| 功能 | 说明 |
|------|------|
| HTTP `/dial` `/hangup` `/sms` | 局域网直连 API |
| `/api/set-pin` | 动态换 PIN（POST） |
| 11 位 PIN 强校验 | `len(pin) != 11` + `isNumeric` |
| 空 PIN 守卫 | 未设置 PIN 时拒绝一切连接 |
| 类型安全 | `getStringField`（非直接断言） |
| LAN 优先 + Cloud 降级 | 自动切换 |

---

## 七、全链路 PIN 校验

| 环节 | 校验 | 文件:行 |
|------|------|---------|
| 扩展设置 | 11 位手机号正则 | popup.js |
| 扩展请求 | X-AutoDial-PIN Header | background.js |
| 云中继 REST | `len(pin) != 11 or not pin.isdigit()` | cloud_relay_v2.py |
| 云中继 WS 手机 | 同上 | cloud_relay_v2.py:259 |
| 云中继 WS PC | 同上 | cloud_relay_v2.py:294 |
| Go PC 端 | `len(pin) != 11` + `isNumeric` | server.go:313 |

---

## 八、安全设计

| 机制 | 说明 |
|------|------|
| **PIN 强校验** | 全链路 11 位数字，4 位旧 PIN 直接拒绝 |
| **并发保护** | PC_CONNECTED 去重 + DUPLICATE_DIAL 5s 去重 |
| **频率限制** | 每 IP 每分钟 5 次握手尝试 |
| **心跳超时** | WebSocket 内置 ping/pong（30s/90s） |
| **空 PIN 守卫** | PC 端未设置 PIN 时拒绝一切连接 |
| **单文件部署** | 无数据库、无外部依赖，攻击面最小 |

---

## 九、部署

| 组件 | 依赖 | 文件数 | 启动命令 |
|------|------|:---:|------|
| 云中继 | `websockets pystray Pillow` | 1 | `python cloud_relay_v2.py` |
| Go PC 端 | Go 1.21+ | 1 | `go build server.go` |
| 扩展 | 无 | 6 | Chrome 加载已解压 |
| Android | Kotlin | 标准项目 | Android Studio 构建 |

