# 2026-07-04 项目改动记录

## 一、底部导航栏重命名 + 顺序调整（14:15）

| 改前 | 改后 | 图标 |
|------|------|------|
| 设置 (wifi) | **通话** | list-numbers |
| 记录 | **录上门** | note-pencil |
| 统计 | **统计** | chart-bar |
| 登记 | **设置** | ⚙️ 齿轮 |

**涉及文件**：
- `activity_main.xml` — Tab 顺序重排，标签改名，设置图标换 gear
- `fragment_connect.xml` — 新增"设置"标题栏
- `fragment_register.xml` — 标题"来访登记"→"录上门"
- `MainActivity.kt` — fragments 列表顺序 (`CallLog→Register→Stats→Connect`) + switchTab 索引
- `ic_tab_settings.xml` — **新建**齿轮矢量图标
- `README.md`, `CHANGELOG.md`, 技术文档 — 全部同步

---

## 二、JWT 全量清理（14:21）

- 删除 4 个 v3 云中继文件：`cloud_relay_v3.py`, `auth.py`, `db.py`, `test_cloud_relay_v3.py`
- `requirements.txt` 移除 `aiosqlite`, `bcrypt`, `PyJWT`
- `ConnectFragment.kt`：移除 JWT 自动登录块、`doAutoLogin()`、`showLoginDialog()`、`getCloudApiUrl()`
- `PrefCtrl.kt`：移除 6 个 JWT 方法
- `CloudCtrl.kt`：更新 JWT 注释

---

## 三、通话记录颜色修复（15:40）

- 拨出/来电图标和文字：绿色 (`colors.green`) → 金色 (`colors.goldLight`)
- 通话时长文字：绿色 → 正文色 (`colors.text`)
- 未接/未接通：红色保持不变
- SIM卡标识：卡1→金色，卡2→正文色

---

## 四、设置页「卡片边框」开关（15:40）

- `ThemeManager.kt`：新增 `card_border` 偏好（默认 true），控制 `bg2`/`bg3`/`topBar`/`navBar`/`chip`/`inputField` 等所有带边框的卡片标签
- 设置页"卡片透明度"下方新增 ON/OFF 开关
- `PrefCtrl.kt` 新增 `getCardBorder()`/`setCardBorder()`

---

## 五、设置页「通知弹窗」分组 + 上次通话提示可配（15:59）

- 新增 `NotifyHelper.kt` 工具类，`connToast()`/`registerToast()` 根据 pref 开关决定是否弹出
- 新增「通知弹窗」分组（现改名为折叠区"▶ 主题/弹窗"）：
  - 连接状态通知 ON/OFF
  - 登记结果通知 ON/OFF
  - 上次通话提示停留时长：5秒/10秒/30秒/一直（0=不消失）
- `PrefCtrl.kt` 新增 `getNotifyConnState()`/`setNotifyConnState()`/`getNotifyRegister()`/`setNotifyRegister()`/`getLastCallHintDuration()`/`setLastCallHintDuration()`

---

## 六、设置页布局重构（17:49）

- 删除"当前连接状态↓"标签（后恢复分隔线）
- 分隔装饰线放在「▶ 跨屏连接设置」上方
- 状态大盘固定高度 64dp，PIN 配对区外包 `minHeight="150dp"`，防内容跳动
- 通道状态文字对齐状态大盘（"电脑在线"、"已连通，等待电脑"）
- 「主题行」从 APP拨号设置内部移到外部
- 新增独立折叠区「▶ 主题/弹窗」（默认收起），位于 APP拨号设置下方

---

## 七、CRM 双重同步修复 + 云端为准（16:22 → 18:43）

- 移除 `cloud_relay_v2.py` 中 `/api/v1/visit` 的 `_sync_to_crm()` 调用
- 新架构：插件/手机直接提交 CRM，云端仅记录
- 手机端同步改为**以云端为准（替换模式）**：
  - `syncVisitsFromCloud` 不再合并本地+云端，直接使用云端数据覆盖本地
  - 同步提示：云端有记录 → "共 N 条"，云端空 → "云端暂无上门记录"
  - 同时清理旧格式 `registration_timestamps`

---

## 八、手机端登记页顾问姓名选择器（13:25）

- 新增 `fetchAdvisorListFromCrm()` — POST `/bserve/search`（keyword 为空）拉取全量顾问列表
- `etManagerName` 从文本输入改为点击选择器（`focusable=false`, `clickable=true`）
- 点击弹出 `AlertDialog` 列出所有顾问姓名，选中后自动填入并保存
- `RegisterFragment.kt`：登记成功时同步写入 `visit_records` JSON

---

## 九、手机端统计页增强（16:29）

- 上门统计卡片标题右侧增加「🔄 同步」按钮，从 `/api/v1/visits?pin=xxx` 拉取云端数据
- 6 个统计数字点击后弹出详情窗口，显示客户姓名、手机号、登记时间
- `saveVisitRecord()` 和 `loadVisitStats()` 的静默 catch 改为带日志的错误处理

---

## 变更文件清单

### 新增文件
| 文件 | 说明 |
|------|------|
| `android-app/app/src/main/res/drawable/ic_tab_settings.xml` | 设置页齿轮图标 |
| `android-app/app/src/main/res/drawable/bg_gold_btn.xml` | 金色按钮背景 |
| `android-app/app/src/main/java/com/autodial/app/NotifyHelper.kt` | 弹窗通知辅助 |

### 删除文件
| 文件 | 说明 |
|------|------|
| `cloud-relay/python/cloud_relay_v3.py` | v3 JWT 中继 |
| `cloud-relay/python/auth.py` | v3 JWT 认证 |
| `cloud-relay/python/db.py` | v3 数据库层 |
| `cloud-relay/python/test_cloud_relay_v3.py` | v3 测试 |

### 修改文件
| 文件 | 主要改动 |
|------|---------|
| `cloud_relay_v2.py` | CORS 头、CRM 双重同步移除 |
| `web_server.py` | - |
| `requirements.txt` | 移除 v3 依赖 |
| `MainActivity.kt` | 导航栏排 + switchTab 索引 |
| `ConnectFragment.kt` | 设置页全部重构 + JWT 清理 |
| `CallLogFragment.kt` | 通话颜色 + 上次通话提示时长可配 |
| `RegisterFragment.kt` | 顾问姓名选择器 + visit_records 写入 |
| `StatsFragment.kt` | 同步按钮 + 详情弹窗 + 云端替换逻辑 |
| `PrefCtrl.kt` | 新增 8 个偏好方法 |
| `ThemeManager.kt` | 边框开关 + borderRadius 辅助 |
| `CloudCtrl.kt` | JWT 注释更新 |
| `activity_main.xml` | Tab 重排 |
| `fragment_connect.xml` | 设置页全部布局重构 |
| `fragment_register.xml` | 标题改名 + 姓名字段改为选择器 |
| `README.md`, `CHANGELOG.md` | 术语同步 |
| `技术文档/*.md` | 全部同步 |

---

> 最后更新：2026-07-04 18:57
