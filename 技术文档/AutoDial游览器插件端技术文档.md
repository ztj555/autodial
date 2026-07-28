# AutoDial 浏览器插件端技术文档

> 最后修改：2026-07-21 23:30 | MV3 v4.2 | 全链路同步修复 + 纯增量去重 + 自动翻页 + 右键一键同步

---

## 一、项目结构

```
AutoDial-Extension/
├── manifest.json           ← MV3 清单（host_permissions + content_scripts）
├── background.js           ← Service Worker：双模路由 + PIN 管理 + 拨号
├── content-script.js       ← 内容脚本：CRM 浮动按钮 + TreeWalker 号码扫描
├── popup.html              ← 弹窗界面：云服务器 + PIN 配置
├── popup.js                ← 弹窗逻辑：/health 测试 + /api/v1/status 查询
├── wails-adapter.js        ← Wails API 适配（Go PC 端兼容）
├── icon16/48/128.png       ← 扩展图标
└── themes/                 ← CSS 主题文件
```

---

## 二、manifest.json 关键配置

```json
{
  "manifest_version": 3,
  "version": "4.0.0",
  "name": "AutoDial 一键拨号",
  "description": "一键拨号 - CRM客户手机号自动拨打（PIN整合版）",
  "host_permissions": [
    "http://127.0.0.1:35432/*"
  ],
  "permissions": ["activeTab", "storage", "clipboardWrite"],
  "content_scripts": [{
    "matches": [
      "*://*.zhudaicms.com/*",
      "*://*.rxhcrm.com/*",
      "*://*.rongxinhui.com/*"
    ],
    "js": ["content-script.js"],
    "css": ["themes/dark-gold.css"],
    "run_at": "document_idle"
  }]
}
```

**说明**：
- `host_permissions` 声明 `127.0.0.1:35432` 使扩展可绕过 CORS 访问本地 PC 端
- 内容脚本仅在三类 CRM 域名下注入，避免影响非目标页面

---

## 三、background.js — Service Worker

### 3.1 双模路由

```
拨号请求
  ├── 1. 检测 PC（localhost:35432，2s 超时）
  │     ├── PC 在线 → HTTP 35432/dial → 完成
  │     └── PC 不在线 → 步骤 2
  └── 2. 云中继（配置的云端地址，REST API）
        └── GET /api/v1/dial?number=xxx + X-AutoDial-PIN Header
```

**PC 检测缓存（30s TTL）**：检测结果缓存 30 秒，超时自动重新探测，避免 PC 离线后永久走直连超时。

**PC_CONNECTED 反向兜底**：扩展以为 PC 不在线但云中继发现 PC 实际在线 → 返回 `PC_CONNECTED` 错误码 → 扩展刷新缓存切回本地。

### 3.2 PIN 管理

```
getPin() 优先级：
  1. 用户在 popup 中手动设置的 PIN（存储于 chrome.storage）
  2. content-script.js 自动检测的 CRM 坐席手机号（selfPhoneDetected）
  3. fallback：空字符串
```

无需登录、无需密码。打开 CRM 页面后 content-script 自动检测坐席号并存入 storage。

### 3.3 拨号函数 dial(number)

```javascript
async function dial(number) {
  const pin = await getPin();
  if (!pin) return { ok: false, error: '未设置PIN' };

  // 1. 优先尝试 PC 直连
  if (await isPcAlive()) {
    const resp = await fetch(`http://127.0.0.1:35432/dial?number=${encodeURIComponent(number)}`);
    return await resp.json();
  }

  // 2. PC 不在线，走云端 REST API
  const cloudServer = await getCloudServer();
  const resp = await fetch(`${cloudServer}/api/v1/dial?number=${encodeURIComponent(number)}`, {
    headers: { 'X-AutoDial-PIN': pin }
  });
  const result = await resp.json();

  // 3. 如果云端返回 PC_CONNECTED，刷新 PC 缓存
  if (result.code === 'PC_CONNECTED') {
    await refreshPcCache();
    return dial(number); // 重试走 PC 直连
  }

  return result;
}
```

### 3.4 挂断函数 hangup()

```javascript
async function hangup() {
  // 逻辑同 dial：优先 PC 直连，降级云端
}
```

### 3.5 状态查询

- `getInfo()`：查询 PC 状态 + 手机连接状态
- `isPcAlive()`：2s 超时 `fetch('http://127.0.0.1:35432/')` → 缓存结果
- `refreshPcCache()`：重置 PC 缓存，重新检测

---

## 四、content-script.js — 内容脚本

### 4.1 核心功能

| 功能 | 说明 |
|------|------|
| **号码检测** | TreeWalker 扫描页面文本节点，正则匹配手机号 |
| **坐席号检测** | 扫描页面中的"坐席""工号""分机"等标签 → `selfPhoneDetected` |
| **浮动拨号按钮** | 可拖拽的拨号按钮（36-100px 可缩放手柄），检测 CRM 号码自动高亮 |
| **挂断按钮** | 拨号后显示的可拖拽挂断按钮（带缩放手柄） |
| **手动拨号条** | 独立悬浮条：输入框（不限长度/支持*#）+ 清空 + 拨号，右键菜单切换显隐 |
| **设置弹窗** | 毛玻璃弹窗：PIN 设置 + 云端服务器（测试连接/一键获取），与 popup.html 双向同步 |
| **右键菜单** | 主题切换、手动拨号、设置、拨号、短信、PC 状态、PIN 显示 |
| **8 套主题** | 与 PC 端一致，切换时实时刷新所有悬浮元素 |

### 4.2 号码格式

支持任意号码（手机号、固话、10086、400/800、*100# 等运营商码）：
- 最小 3 位数字，最长 20 位
- 允许 `+` `*` `#` 和格式化字符（空格、`-`、括号）
- 端到端校验点在云中继和 PC 端 HTTP handler，插件端不做拦截

### 4.3 8 套主题

与 PC 端一致的 8 套主题，通过 CSS 文件提供：
`dark-gold`, `cyber-frost`, `deep-space`, `cyberpunk`, `minimalist`, `forest-green`, `energetic-orange`, `ocean-blue`

### 4.4 CRM 适配

支持的 CRM 系统域名：
- `zhudaicms.com` — 筑代 CRM
- `rxhcrm.com` — 融信汇 CRM
- `rongxinhui.com` — 融信汇（备用域名）

当检测到 CRM 页面时自动注入浮动按钮，非 CRM 页面不注入。

### 4.4 同步登记列表（v4.2 全链路修复）

**功能说明**：从 CRM 来访列表页全量抓取客户来访记录，批量同步到云中继，推送手机端。纯增量去重。

**数据提取** (`extractVisits`):
```
form[name="fdsf"] ~ table tr  ← 数据表格（兄弟元素，非子元素）
cells[0] = crm_id       cells[1] = name (去括号)
cells[2] = mobile       cells[4] = visit_type
cells[5] = advisor_phone  cells[6] = advisor_name
cells[10] = visit_time  ← CRM 真实来访时间（v4.2 新增）
```

**自动翻页流程**:
```
第1页 → extractVisits(document)
扫描分页链接 (page 2,3,4...) → 去重排序
逐页 fetch(url, {credentials:'include'})
  → DOMParser → extractVisits → 合并
单页失败跳过继续（不中断整体）
```

**提交到云中继** (`batchSyncVisits`):
```
GET /api/v1/visit?name=&mobile=&kefu_tel=&visit_type=&visit_time=&source=crm_sync
Header: X-AutoDial-PIN
```

**触发方式（v4.2 新增3个入口）**:
| 入口 | 触发位置 | 行为 |
|------|----------|------|
| 🔁 右键菜单 | 任意 CRM 页面 | 自动跳转列表页 + 同步 |
| 同步当前页 | 列表页右键 | 仅同步当前页 |
| 🔁 扩展图标右键 | 工具栏 | 同上 |
| Popup 按钮 | 扩展弹窗 | 同上 |

**增量反馈**:
```
✅ 同步完成：共 120 条，新增 80 条，跳过 35 条（已存在），失败 5 条
```

---

## 五、popup.html / popup.js — 弹窗界面

### 5.1 功能

- **PIN 设置**：显示当前 PIN，支持手动修改（11 位手机号）
- **云服务器配置**：输入云中继地址（如 `ws://xxx:35430`）
- **连通性测试**：`GET /health` 测试云中继是否可达
- **状态查询**：`GET /api/v1/status` 查询 PC/手机在线状态
- **一键获取**：从 GitHub Gist / Gitee 拉取服务器列表

### 5.2 配置存储

所有配置通过 `chrome.storage.local` 持久化：
```javascript
{
  pin: "13800138000",          // 手动设置的 PIN
  selfPhone: "13800138000",    // CRM 自动检测的坐席号
  cloudServer: "ws://xxx:35430",
  cloudServers: ["ws://xxx:35430", "ws://yyy:35430"]
}
```

---

## 六、协议与端口

| 端口 | 协议 | 用途 | Headers |
|------|------|------|---------|
| 35432 | HTTP | PC 直连拨号 | 无（localhost 无需认证） |
| 35430 | HTTP REST | 云中继拨号 | `X-AutoDial-PIN: 13800138000` |
| 35430 | WebSocket | 云中继实时通信 | 通过 `phone_hello`/`pc_hello` |

---

## 七、错误处理

| 错误码 | 含义 | 用户提示 |
|--------|------|---------|
| `INVALID_PIN` | PIN 格式错误（需4位或11位手机号） | "请检查配对码格式" |
| `PHONE_OFFLINE` | 手机未连接 | "手机未连接，请检查手机端" |
| `PC_CONNECTED` | PC 在线 | 自动切回 localhost 直连（对用户透明） |
| `DUPLICATE_DIAL` | 重复拨号 | 静默忽略 |
| `RATE_LIMITED` | 频率限制 | "请求过于频繁，请稍后重试" |
| `INVALID_NUMBER` | 号码不合法（需 3-20 位数字，允许 *#+） | "无效的电话号码" |
| 网络超时 | PC/云不可达 | 自动降级：PC 不可达 → 走云端 |

---

## 八、构建与安装

### 开发模式

```bash
# Chrome → chrome://extensions/ → 开启"开发者模式" → "加载已解压的扩展程序"
# 选择 AutoDial-Extension/ 目录
```

### 发布

```bash
# Chrome → chrome://extensions/ → "打包扩展程序"
# 输出：.crx 文件 + .pem 私钥
```

---

## 九、注意事项

1. **MV3 Service Worker** 会在闲置 30s 后被浏览器终止，`background.js` 的状态需通过 `chrome.storage` 持久化
2. **fetch 超时**：本地 `localhost` 端口关闭时 TCP 瞬间拒绝（无延迟），云端超时需要 AbortController（当前本地部署不受影响，部署公网前需处理）
3. **CORS**：云中继的 REST API 不设 CORS（扩展通过 `host_permissions` 绕过），仅 `/health` 有 CORS
4. **content-script 注入时机**：`run_at: "document_idle"` 确保 DOM 加载完成后再注入，避免 TreeWalker 扫描不完整
