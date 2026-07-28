# AutoDial CRM 导入 — 系统设计 & 任务分解

> 作者: Bob (Architect)  
> 基于: PRD v1 (CRM 粘贴导入)  
> 目标代码库: `cloud-relay/python/`  
> 日期: 2025-07-23

---

## Part A: 系统设计

### 1. 实现方案

#### 1.1 核心技术挑战

| 挑战 | 分析 |
|------|------|
| **粘贴文本解析** | CRM 导出的分隔符不确定（Tab/逗号/TSV），需前端纯 JS 实现自动检测分隔符 + 表头识别 |
| **无 POST body** | websockets 库的 `process_request` 不支持 POST body，API 参数必须走 query string。JSON 数组数据通过 `?data=` query param 传递，对大体积做前端分批 |
| **crm_id 去重** | SQLite 支持 UNIQUE 约束，使用 `INSERT OR IGNORE` 实现自然去重；冲突时捕获并计数 skipped |
| **平滑迁移** | 现有 `init_db()` 已用 `ALTER TABLE ADD COLUMN` 兼容模式；新增 `crm_id` 列走同样路径 |
| **单文件前端** | `dashboard.html` 无构建工具，所有 JS/CSS 内联或 CDN 引入；新增的导入页面也内联在同一 HTML 中 |

#### 1.2 方案选择

| 决策点 | 方案 A | 方案 B | 选择及理由 |
|--------|--------|--------|------------|
| 分隔符检测 | 后端检测 | **前端 JS 检测** | ✅ 前端先行解析可做实时预览，无需 HTTP 往返，用户体验更好 |
| 前端数据格式 | FormData | **JSON 数组** | ✅ PRD 明确要求 `?data=<JSON数组>`，与现有 `calls/batch` 模式一致 |
| 去重策略 | SELECT 先查再 INSERT | **INSERT OR IGNORE** | ✅ SQLite UNIQUE 约束 + INSERT OR IGNORE 原子操作，无竞态风险 |
| 分批策略 | 后端自动分批 | **前端按 200 条切片** | ✅ 前端感知总量更直观，后端逻辑简单；与 PRD "单批上限 200" 对齐 |
| 导入页面位置 | 新建独立 HTML | **嵌入 dashboard.html** | ✅ 保持单文件架构；作为 `dashboard.html` 的一个新 Tab 页 |
| 鉴权 | 无需鉴权 | **需要 admin 鉴权** | ✅ 导入涉及数据库写入，与现有 visit/delete、visit/update 一致，使用 `_check_admin` |

#### 1.3 架构模式

```
┌─────────────────────────────────────────────────────┐
│                  dashboard.html (单文件)               │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 现有 Tab  │  │ 现有 Tab  │  │  NEW: CRM 导入 Tab │  │
│  │ (概览等)  │  │ (访问记录)│  │                   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                    │                  │
│                          fetch() 分批调用              │
└────────────────────────────────────┼──────────────────┘
                                     │
                    GET /api/v1/import_visits?data=<json>
                                     │
┌────────────────────────────────────┼──────────────────┐
│              cloud_relay_v2.py (后端)                  │
│  ┌─────────────────────────────────┐                  │
│  │  health_check_handler()         │                  │
│  │  新增路由: /api/v1/import_visits │                  │
│  │  鉴权: _check_admin()           │                  │
│  │  解析 → 去重写入 → 返回计数      │                  │
│  └─────────────────────────────────┘                  │
│                    │                                  │
│              SQLite visits.db                         │
│         (新增 crm_id TEXT UNIQUE)                     │
└───────────────────────────────────────────────────────┘
```

---

### 2. 文件列表

| 文件 | 路径 | 状态 | 说明 |
|------|------|------|------|
| `cloud_relay_v2.py` | `cloud-relay/python/cloud_relay_v2.py` | **修改** | 新增 `crm_id` 列迁移、新增 `/api/v1/import_visits` 路由 |
| `dashboard.html` | `cloud-relay/python/dashboard.html` | **修改** | 新增 "CRM 导入" Tab 页：粘贴区 + 预览表格 + 导入按钮 + Toast |

---

### 3. 数据结构和接口

#### 3.1 数据库表结构变更

**visits 表（变更后）**：

```sql
-- 迁移 SQL（向后兼容，init_db 中执行）
ALTER TABLE visits ADD COLUMN crm_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_crm_id ON visits(crm_id);
```

完整 visits 表结构：

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK AUTOINCREMENT | 自增主键 |
| pin | TEXT | NOT NULL | 顾问 PIN |
| name | TEXT | NOT NULL | 客户姓名 |
| mobile | TEXT | NOT NULL | 客户手机号 |
| kefu_tel | TEXT | NOT NULL | 顾问电话 |
| visit_type | TEXT | DEFAULT '贷款咨询' | 来访事由 |
| source | TEXT | DEFAULT 'plugin' | 来源标识 |
| crm_synced | INTEGER | DEFAULT 0 | CRM 同步标记 |
| visit_time | TEXT | DEFAULT '' | 上门时间 |
| **crm_id** | **TEXT** | **UNIQUE (新增)** | **CRM 系统 ID，去重键** |
| created_at | TEXT | NOT NULL | 创建时间 |
| updated_at | TEXT | NOT NULL | 更新时间 |

#### 3.2 API 接口设计

**新增 API: `GET /api/v1/import_visits`**

```
URL:     /api/v1/import_visits?data=<URL-encoded JSON array>&token=<admin_token>
Method:  GET (query string, 遵循 process_request 限制)
Auth:    管理员鉴权 (_check_admin)
```

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| data | string (JSON) | 是 | URL-encoded JSON 数组，每元素一个对象 |
| token | string | 是(*) | 管理员会话令牌（鉴权启用时必填） |

**data JSON 元素字段**：

```json
{
  "ID": "CRM001",        // → crm_id
  "姓名": "张三",         // → name
  "客户手机号": "13800138000",  // → mobile
  "顾问电话": "8888",     // → kefu_tel
  "上门时间": "2025-07-20 14:30",  // → visit_time
  "来访事由": "贷款咨询",  // → visit_type
  "城市": "上海"          // → source (映射为 "crm_import")
}
```

**响应格式**：

```json
{
  "ok": true,
  "inserted": 15,
  "skipped": 2,
  "total": 17,
  "errors": [
    {"index": 3, "crm_id": "CRM005", "reason": "Missing required field: mobile"}
  ]
}
```

**错误码**：

| code | 含义 |
|------|------|
| UNAUTHORIZED | 未通过鉴权 |
| INVALID_JSON | data 参数不是有效 JSON |
| MISSING_FIELDS | 必填字段缺失 |
| SERVER_ERROR | 服务器内部错误 |

**约束**：
- 单批上限 200 条（约 20KB），超量由前端分批
- `source` 字段统一固定为 `"crm_import"`
- `pin` 固定为空字符串 `""`
- `crm_synced` 固定为 `1`

#### 3.3 Mermaid 类图

见独立文件 `docs/class-diagram.mermaid`。

```
classDiagram
    class VisitRecord {
        +int id
        +str pin
        +str name
        +str mobile
        +str kefu_tel
        +str visit_type
        +str source
        +int crm_synced
        +str visit_time
        +str crm_id
        +str created_at
        +str updated_at
    }

    class CrmImportRequest {
        +str crm_id
        +str name
        +str mobile
        +str kefu_tel
        +str visit_time
        +str visit_type
        +str city
    }

    class CrmImportResponse {
        +bool ok
        +int inserted
        +int skipped
        +int total
        +List~CrmImportError~ errors
    }

    class CrmImportError {
        +int index
        +str crm_id
        +str reason
    }

    class ImportHandler {
        +handle_import(data_json, hdrs, parsed_query) Tuple
        -_check_admin(hdrs, parsed_query) bool
        -_insert_batch(records) CrmImportResponse
        -_validate_record(row) Optional~str~
    }

    CrmImportRequest --> VisitRecord : maps to
    ImportHandler --> CrmImportResponse : returns
    CrmImportResponse --> CrmImportError : contains
```

---

### 4. 程序调用流程

#### 4.1 时序图

见独立文件 `docs/sequence-diagram.mermaid`。

**主流程：用户粘贴 → 解析 → 预览 → 编辑 → 导入**

```
sequenceDiagram
    actor User as 👤 管理员
    participant FE as dashboard.html<br/>CRM导入Tab
    participant BE as cloud_relay_v2.py<br/>health_check_handler
    participant DB as SQLite<br/>visits.db

    rect rgb(240, 248, 255)
        Note over User,FE: Phase 1: 粘贴 & 解析
        User->>FE: 粘贴 CRM 导出文本 (Ctrl+V)
        FE->>FE: 自动检测分隔符 (Tab/逗号/TSV)
        FE->>FE: 解析表头行, 映射到字段
        FE->>FE: 填充预览表格
    end

    rect rgb(255, 248, 240)
        Note over User,FE: Phase 2: 预览 & 编辑
        User->>FE: 点击单元格编辑内容
        User->>FE: 勾选/反选行
        User->>FE: 点击删除选中行
        FE->>FE: 更新本地 rows[] 数组
    end

    rect rgb(240, 255, 240)
        Note over User,BE: Phase 3: 确认导入 (分批)
        User->>FE: 点击「确认导入」
        FE->>FE: 按 200 条/批切片
        loop 每一批 (最多 200 条)
            FE->>BE: GET /api/v1/import_visits?data=<JSON>&token=xxx
            BE->>BE: _check_admin(hdrs, parsed_query)
            alt 鉴权失败
                BE-->>FE: 401 UNAUTHORIZED
            end
            BE->>BE: JSON.parse(data)
            BE->>BE: 遍历验证每条记录
            loop 每条记录
                alt 缺少必填字段 (name/mobile/kefu_tel)
                    BE->>BE: 记入 errors[]
                else 字段齐全
                    BE->>DB: INSERT OR IGNORE INTO visits<br/>(pin,name,mobile,kefu_tel,visit_type,<br/>source,visit_time,crm_id,crm_synced,<br/>created_at,updated_at)
                    alt crm_id 冲突 (UNIQUE)
                        DB-->>BE: skipped++
                    else 插入成功
                        DB-->>BE: inserted++
                    end
                end
            end
            BE-->>FE: {ok, inserted, skipped, total, errors}
            FE->>FE: 累加 inserted/skipped 计数
        end
    end

    rect rgb(255, 240, 255)
        Note over User,FE: Phase 4: 结果反馈
        FE->>FE: 显示 Toast: "成功导入 85 条，跳过 12 条重复"
        FE->>FE: 清空粘贴区, 恢复初始状态
    end
```

---

### 5. 待明确事项 (UNCLEAR)

| # | 问题 | 我的假设 | 影响范围 |
|---|------|----------|----------|
| 1 | `顾问电话` 列映射到 `kefu_tel` 还是 `pin`？PRD 字段映射说 → kefu_tel，但 kefu_tel 存储的是顾问电话号码，而 visits 的 pin 字段也是顾问标识。 | **按 PRD 字段映射执行**：顾问电话 → kefu_tel，pin 固定为 `""` | 如果实际 CRM 导出中的"顾问电话"是 PIN 码而非电话号码，则需要调整映射 |
| 2 | `source` 字段是固定 `"crm_import"` 还是拼接城市信息？PRD 说"城市/所在城市 → source"，又说"source 字段统一为 crm_import" | **统一为 `"crm_import"`**，城市信息不单独存储（当前 visits 表无城市字段，PRD 未要求新增） | 如需保留城市信息，需新增 `city` 列 |
| 3 | 需不需要为新导入的记录触发 CRM 同步（`_sync_to_crm`）？ | **不需要**。`crm_synced` 固定为 1，表示这些记录本身就来自 CRM，无需反向同步 | 逻辑上不会造成死循环 |
| 4 | 导入是否需要 `_push_visit_to_phone` 推送？ | **不需要**。批量导入没有实时通知手机的语义，且 pin 为空字符串 | 不影响手机端体验 |
| 5 | 前端编辑预览时，`crm_id` 列是否允许编辑？ | **允许编辑**，但它也是去重键，用户修改后可能导致之前跳过的记录被插入 | 需在 UI 提示用户 crm_id 是去重依据 |

---

## Part B: 任务分解

### 6. 依赖包列表

本功能完全基于现有依赖，**无需新增第三方包**：

```
- Python 3.8+ (标准库: json, sqlite3, urllib.parse, datetime)
- websockets (现有依赖, 用于 process_request)
- 前端: 无新增 CDN 依赖, 纯 Vanilla JS + 现有 Chart.js
```

### 7. 任务列表（有序，含依赖）

---

### T01: 数据库迁移 — visits 表新增 crm_id 列 + UNIQUE 索引

- **Task ID**: T01
- **优先级**: P0
- **依赖**: 无
- **修改文件**:
  - `cloud_relay_v2.py` → 修改 `init_db()` 函数，添加 `crm_id` 迁移逻辑

**具体变更点**：

1. 在 `init_db()` 的 `create_visits` SQL 中，将 `crm_id TEXT` 加入 CREATE TABLE 语句（新安装直接包含该列）
2. 在兼容迁移段（`try: ALTER TABLE ... except: pass`）新增：
   - `ALTER TABLE visits ADD COLUMN crm_id TEXT`
   - `CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_crm_id ON visits(crm_id)`
3. 内存降级路径（`:memory:` 分支）也同步添加

**验证标准**：
- 对已有 `visits.db` 执行迁移不报错
- 尝试插入重复 `crm_id` 触发 `UNIQUE constraint failed`
- 全新部署直接创建带 `crm_id` 列的表

---

### T02: 后端 API — `/api/v1/import_visits` 路由实现

- **Task ID**: T02
- **优先级**: P0
- **依赖**: T01
- **修改文件**:
  - `cloud_relay_v2.py` → 在 `health_check_handler()` 中新增路由分支

**具体变更点**：

1. 新增路由分支 `if path == '/api/v1/import_visits':`
2. 鉴权：调用 `_check_admin(hdrs, parsed.query)`，失败返回 `_AUTH_ERR`
3. 解析 query string 中的 `data` 参数，URL-decode → JSON.parse
4. JSON 解析失败返回 `INVALID_JSON` 错误
5. 遍历每条记录：
   - 验证必填字段（name, mobile, kefu_tel），缺失记入 `errors[]`
   - 字段映射：`ID→crm_id, 姓名→name, 客户手机号→mobile, 顾问电话→kefu_tel, 上门时间→visit_time, 来访事由→visit_type`
   - `pin=""`, `source="crm_import"`, `crm_synced=1`
   - `INSERT OR IGNORE INTO visits(...)` — 通过 `crm_id UNIQUE` 自动去重
   - 根据 `rowcount` 判断 inserted vs skipped
6. 返回 `{ok, inserted, skipped, total, errors}`
7. 添加 `IMPORT_VISITS` 日志记录

**验证标准**：
- `curl "http://127.0.0.1:35430/api/v1/import_visits?data=...&token=xxx"` 正确返回
- crm_id 重复时 skipped 计数正确
- 缺少必填字段时 errors 数组包含对应条目

---

### T03: 前端 — CRM 导入 Tab 页面（粘贴解析 + 预览表格）

- **Task ID**: T03
- **优先级**: P0
- **依赖**: T01（需表结构确定，以便前端字段映射正确）
- **修改文件**:
  - `dashboard.html` → 新增 Tab 按钮 + 页面容器 + JS 逻辑

**具体变更点**：

1. **Tab 导航**：在现有导航栏（`.nav`）中新增 `<button class="nav-btn">📥 CRM 导入</button>`
2. **页面容器**：新增 `<div class="page" id="page-crm-import">` 包含：
   - **粘贴区**：`<textarea>` 大文本输入框，placeholder 提示"在此粘贴 CRM 导出的文本..."
   - **解析按钮**：`<button>解析预览</button>`
   - **统计条**：显示"已识别 X 条记录，Y 列"
   - **预览表格**：`<table>` 动态生成，表头从 CRM 列名映射为 visits 字段名
   - **行复选框**：每行首列 `<input type="checkbox">`，表头全选/反选
   - **工具栏**：删除选中行、清空表格
3. **JS 解析器**（内联）：
   - `detectSeparator(text)`: 统计每行 Tab/逗号/竖线出现次数，返回最可能的分隔符
   - `parseCrmText(text)`: 解析表头行 → 映射字段 → 解析数据行 → 返回 `rows[]`
   - `mapFieldName(crmHeader)`: CRM 列名 → visits 字段名映射表
   - `renderTable(rows)`: 动态生成可编辑 `<table>`，单元格 contenteditable
4. **行选择管理**：`selectedRows` Set，支持 Shift 多选、全选/反选

**验证标准**：
- 粘贴 Tab 分隔的文本，自动识别为 6 列
- 粘贴逗号分隔的文本，自动识别为 7 列
- 预览表格中双击单元格可编辑
- 勾选/反选/全选 正常工作

---

### T04: 前端 — 导入执行 + 结果反馈

- **Task ID**: T04
- **优先级**: P0
- **依赖**: T02, T03
- **修改文件**:
  - `dashboard.html` → 在 CRM 导入 Tab 的 JS 中新增导入逻辑 + Toast 组件

**具体变更点**：

1. **「确认导入」按钮**：置灰逻辑（无选中行时禁用、无数据时禁用）
2. **前端分批**：`async function doImport()`:
   - 将选中行（或全部行）按 200 条切片
   - 每批 `encodeURIComponent(JSON.stringify(batch))` 构造 URL
   - `fetch()` 调用 `/api/v1/import_visits?data=...&token=...`
   - 累加 `totalInserted` / `totalSkipped`
   - 显示进度条（已处理 X/Y 批）
3. **Token 管理**：复用现有 `token` 变量（仪表盘登录后获得）
4. **Toast 通知组件**（新增通用组件）：
   - 成功态：`✅ 成功导入 85 条，跳过 12 条重复`
   - 错误态：`❌ 导入失败：鉴权未通过`
   - 带关闭按钮，3 秒自动消失
   - `showToast(message, type)` 函数
5. **导入完成后**：清空粘贴区、清空表格、重置统计
6. **错误处理**：单批失败时显示具体错误信息，不影响已成功的批次

**验证标准**：
- 选中 100 条 → 确认导入 → 1 批完成 → Toast 显示计数
- 选中 350 条 → 确认导入 → 2 批完成 → Toast 显示累计
- 重复导入相同 crm_id → skipped 计数正确
- 未登录时导入 → Toast 显示鉴权失败

---

### T05: 集成验证 & 边界情况处理

- **Task ID**: T05
- **优先级**: P1
- **依赖**: T01, T02, T03, T04
- **修改文件**:
  - `cloud_relay_v2.py` → 边界情况加固
  - `dashboard.html` → 边界情况加固

**具体变更点**：

1. **后端边界**：
   - `data` 参数超长返回友好错误（建议分批）
   - 空数组 `[]` 返回 `{ok:true, inserted:0, skipped:0, total:0}`
   - URL 解码失败返回 `INVALID_JSON`
   - 单批超过 200 条时，仍然处理但记录 WARN 日志
2. **前端边界**：
   - 粘贴空文本时提示"未检测到有效数据"
   - 粘贴纯文本（无分隔符）时提示"无法识别分隔符"
   - 只有表头无数据行时提示"未检测到数据行"
   - 网络错误时 Toast 显示错误 + 保留当前预览数据以便重试
   - 导入进行中时禁用按钮防重复提交
3. **端到端验证**：
   - 完整流程：粘贴 → 解析 → 编辑 → 删除行 → 导入 → 去重 → 计数
   - 在现有 visits 管理页面确认导入数据可见

---

### 8. 共享知识（跨文件约定）

```
1. 所有 API 响应遵循 {ok: bool, code?: string, message?: string, ...} 格式
2. 错误响应使用 _err_json(code, message) 构造，HTTP 状态码 200/400/401/500
3. 鉴权：管理员操作统一使用 _check_admin(hdrs, parsed_query_string)
4. Token 传递：URL query string ?token=xxx（兼容 websockets process_request 限制）
5. 日期时间：统一使用 ISO 8601 格式 'YYYY-MM-DDTHH:MM:SS'，Python: datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
6. 数据库连接模式：每个请求独立 connect/close，不跨请求复用连接
7. 前端 DOM 操作：直接操作 document，不引入虚拟 DOM 框架
8. CRM 字段映射表（前端与后端共用映射逻辑，各自独立实现）：
   "ID"/"id"/"编号" → crm_id
   "姓名"/"客户姓名"/"name" → name
   "客户手机号"/"手机号"/"电话"/"mobile" → mobile
   "顾问电话"/"顾问"/"kefu_tel"/"客服电话" → kefu_tel
   "上门时间"/"来访时间"/"visit_time" → visit_time
   "来访事由"/"事由"/"类型"/"visit_type" → visit_type
   "城市"/"所在城市"/"source" → (不持久化，仅用于记录; source 固定 "crm_import")
9. 导入记录固定值：pin=""、source="crm_import"、crm_synced=1
10. 单批上限 200 条，前端负责分批，后端不自动分段
```

### 9. 任务依赖图

```
graph TD
    T01["T01: 数据库迁移<br/>crm_id 列 + UNIQUE 索引"]
    T02["T02: 后端 API<br/>/api/v1/import_visits"]
    T03["T03: 前端 Tab 页<br/>粘贴解析 + 预览表格"]
    T04["T04: 前端导入执行<br/>分批调用 + Toast 反馈"]
    T05["T05: 集成验证<br/>边界情况 + 端到端"]

    T01 --> T02
    T01 --> T03
    T02 --> T04
    T03 --> T04
    T02 --> T05
    T03 --> T05
    T04 --> T05
```

**执行顺序建议**：T01 → (T02 ∥ T03) → T04 → T05

---

## 附录：关键代码位置索引

| 内容 | 文件 | 行号 |
|------|------|------|
| `init_db()` | `cloud_relay_v2.py` | L82-200 |
| `_check_admin()` | `cloud_relay_v2.py` | L864-886 |
| `_err_json()` | `cloud_relay_v2.py` | L855-857 |
| `_AUTH_ERR` | `cloud_relay_v2.py` | L859 |
| `JSON_HDR` | `cloud_relay_v2.py` | L852 |
| `health_check_handler()` | `cloud_relay_v2.py` | L986-1841 |
| `/api/v1/visit` (创建单条) | `cloud_relay_v2.py` | L1525-1591 |
| `_push_visit_to_phone()` | `cloud_relay_v2.py` | L963-984 |
| `load_dashboard_html()` | `cloud_relay_v2.py` | L793-802 |
| Dashboard 导航栏 | `dashboard.html` | L31-34 |
| 页面容器结构 | `dashboard.html` | L40-42 |
