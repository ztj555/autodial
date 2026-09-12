# AutoDial 更新日志

## 2026-09-12（第四批 · 场景化复核修复 v4.23）

> 依据《场景化复核报告-2026-09-12.md》按「内部 20 人 + 手机流量可用 + 机型不统一 + 文件夹版 PC」的真实使用场景重新定级后，修复 P0/P1 中确认的体验与安全条目。PC Go 端确认为废弃实验版（`go build` 不可用），其 9 条全部不修；Electron「便携版自启失效」经确认为误报（文件夹版 `getPath('exe')` 行为正确），不修。
> 验证情况：云端 `py_compile` + 本地隔离实例 8+4 项接口实测（含越权 401、正常同步 200、幂等不重复）；PC Electron `node --check` + settings 原子写行为测试；扩展/面板 JS `node --check`；Android 侧随本次提交推送 GitHub Actions 编译验证（`.github/workflows/android-build.yml`，push 自动触发）。

### 云中继 `cloud_relay_v2.py`（安全，按场景定为必修）

- **[P0] 越权读整组客户数据**：`GET /api/v1/visits?pin=随便填&group=1` 无需管理员令牌即可读出整个分组的客户姓名/手机号/来访事由。根因：鉴权只在 `pin` 为空时校验，而分组分支优先级更高。现按分组或无筛选访问一律要求管理员令牌；单 PIN 精确查询（手机端同步路径）保持免鉴权
- **[P0] 上报接口无鉴权**：`/api/v1/calls/batch`、`/api/v1/events/log` 任意伪造 `device_id` 即可写入/伪造数据。现要求设备已注册（phones 表存在）且 `pin` 与该设备登记的 `last_pin` 一致，否则 403
- **[P1] 上报通道支持 POST body**：`calls/batch`、`events/log` 同时接受 JSON body（`{device_id, pin, data|event_type, detail}`），GET query 通道保留向后兼容；新版 App 优先 POST，PIN 与记录不再出现在 URL
- **[P1] 关闭登录/登出的 GET query 通道**：`/api/v1/login` 仅接受 POST body（口令不进网址/访问日志）；`/api/v1/logout` 令牌从 Authorization 头读取
- **[P1] 压测脚本防误伤生产**：`test_stress_live.py` 不再硬编码生产地址；新增 `--host/--port/--dry-run/preflight`，默认拒绝公网地址（仅允许私网/localhost），preflight 缺 `--host` 直接退出

### PC Electron

- **[P0] 短信失败/超时窗口永久卡死**：手机 ACK 超时/发送失败不回 `sms-result`，短信窗口停在"等待手机确认" → 失败与超时都会给窗口回执
- **[P0] 配置静默损坏即全丢**：`settings.json` 一旦写入中断/损坏，加载失败回退默认并立即写回，用户配置无痕清空 → 读写改原子写（tmp + rename）；加载失败自动备份现场为 `settings.json.corrupt-*`，且不再用默认值覆盖原文件
- **[P0] 云端重连 30 次后彻底放弃**：夜间网络抖动，白天回来不自愈 → 30 次快速重试后转入 5 分钟一次的低频重试，连上即恢复
- **[P1] `removeDevice` 无连接归属校验**：旧连接的 close 事件能把刚重连的新设备状态清掉（"显示在线却拨不出去"）→ 只有当注册表里的连接就是触发者本人时才清理；stale 设备清理同步收紧
- **[P1] LAN 重连覆盖 `isCloud` 标志**：云端模式手机走 LAN hello 重连会被登记成局域网设备，后续按局域网发消息发不出去 → LAN 重连保留原有 `isCloud` 状态
- **[P2] "关闭即退出"残留进程**：主窗口走 exit 分支时悬浮条窗口未销毁 → 退出前统一关闭
- **[P2] 每次拨号无条件覆写剪贴板**：现在号码已在剪贴板（内容相同）时不重复写，尊重用户复制内容

### Android

- **[P0] 进程被杀后不自愈**（A-14）：`START_STICKY` 在国产 ROM 杀后台后可能迟迟不重启 → 新增 `KeepAliveReceiver`：15 分钟周期自查（`setExactAndAllowWhileIdle`），服务不在且用户未手动断开时 `startForegroundService` 复活；系统拦截后台启动时退化为原行为，无副作用
- **[P0] `simHandleCache` 永不失效**（A-5）：换卡/热插拔后一直拿旧卡 handle，拨错卡 → 缓存绑定 subscriptionId，subId 变化自动失效重建
- **[P0] 自动选卡只认小米**（A-11）：机型不统一 → 预布防扩展到全部厂商；非小米启用严格模式（仅响应"新窗口弹出"事件），避免在通话界面上误点；小米保持原行为
- **[P1] 手动断开形同虚设**（A-7）：`MainActivity.onCreate` 无条件清 `manual_disconnect`，Activity 重建即悄悄恢复自动重连 → 清零只保留在连接/重连按钮两处显式动作
- **[P1] 通话记录/拨号盘绕过主拨号链路**（A-6）：拨号盘与通话详情"立即拨号"裸走 `ACTION_CALL`——不走选卡弹层、不写本地记录、不给 PC 回执 → 新增 DialService `"DIAL"` action，统一走 `DialEngine.dialNumber`
- **[P1] `onCreate` 异常恢复路径漏 `startDataSync`**（A-4）：补上；`startDataSync` 加幂等保护防重复调度
- **[P1] READ_CALL_LOG 被拒无感知**（A-2）：统计页顶部新增"去授权"横幅（点击发起授权，成功自动消失并刷新）
- **[P1] 云端空响应清空本地上门记录**（A-8）：同步返回空数组不再覆写本地，提示"本地记录已保留"
- **[P2] 通话记录上报改 POST**：配合云端新增的 POST 通道，PIN 与记录不再进 URL；旧版云端自动回退 GET，两种部署顺序都兼容

### Chrome 扩展

- **[P0] "点击拨打"闭包固化旧号码**（E-1）：SPA 复用 `<a>` 节点时闭包里是首次拦截的旧号码，换客户后拨错人 → 点击时从 href/文本实时读取号码，闭包值仅作兜底
- **[P1] 浮窗连点双拨**（E-4）：2 秒窗口去重
- **[P1] 两处 fetch 无超时**（E-3）：「测试连接」加 8 秒超时（地址填错不再永久停在"测试中"）；`uploadAdvisorName` 改用已有 `fetchWithTimeout`

### 管理面板 `dashboard.html`

- **[P1] `recent-clients` 的 PIN/IP 未转义**（M-1）→ 补 `esc()`
- **[P2] 通话记录设备筛选只在启动时加载一次**（M-9）：新登记的手机要重启面板才出现在筛选里 → 每次切到通话记录页刷新选项，且保留用户已选中的筛选值

### 第二批 P2 顺手修（同日追加）

- **[P2] 云端 `shutdown()` 协程内 `sys.exit(0)`**（Y-10）：托盘路径下事件循环跑在子线程，`SystemExit` 只杀线程——托盘图标残留成僵尸进程、服务已死 → 清理（落盘+停服）完成后改 `os._exit(0)` 结束整个进程
- **[P2] 云端 `configure_firewall()` 无平台判断**（Y-14）：Linux/Docker 每次启动白跑两趟 `netsh` 并刷 error 日志 → 非 Windows 直接跳过
- **[P2] PC 无单实例锁**（P-3）：双开后第二个实例抢同一 LAN/发现端口，手机连到谁全凭运气 → `requestSingleInstanceLock`，二次启动拉起已有实例主窗口
- **[P2] 面板弹窗不支持 Esc 关闭**（M-6）→ Esc 按确认 > 导入 > 编辑的优先级关最上层弹窗；确认弹窗走取消回调，Promise 正常 resolve(false)
- **[P2] 扩展离线队列读改写竞态**（E-9）：flush 一次跑数秒，期间 `queueCloudVisit` 的写入会被 flush 结尾的 `set(remain)` 覆盖，补推期间新登记的记录直接丢失 → promise 链把队列读写串行化

### 第三批 P2 顺手修（同日追加）

- **[P2] 安卓同号防双拨兜底**（A-10）：messageId 去重依赖 PC 每次带 id，浮窗连点/插件重试可产生两个不同 id 的同号请求 → 真拨两次。现 4 秒窗口内同号请求直接忽略
- **[P2] 安卓拨号路径主线程查通话记录**（A-13）：`notifyLastCallHint` 的 ContentResolver 查询从 `onStartCommand("DIAL")` 进来时在主线程 → 挪到专用单线程池，结果广播延后几百毫秒无感知
- **[P2] PC `get-info` 补齐 `connected`/`firewall` 字段**（P-1）：渲染端首屏一直在读这两个字段做状态展示与防火墙提示，主进程从未返回——纯死代码。`firewall.hasFirewallWarning()` 早已实现只是没人接
- **[P2] PC 日志明文打印配对码**（P-10）：配对码即客服本人手机号，`set-pin` 与启动横幅改脱敏（`138****1234`）
- **[P2] 面板 `phoneHistoryCache` 永不过期**（M-3）：设备历史刚被顶号/换 PIN 后展开行一直显示陈旧数据 → 60 秒 TTL
- **[P2] 面板搜索防抖定时器跨页存活**（M-4）：切页后仍触发旧页搜索请求 → 切页时统一清理
- **[P2] 云端日志/stats.json 在 Docker 重建即丢**（Y-11）：路径固定 `APPDATA or ~`（容器内）→ 新增 `AUTODIAL_DATA_DIR` 环境变量，docker-compose 已指向挂载卷 `/app/data`

## 2026-09-12（第三批 · 外部复核结论修复 v4.22）

> 依据一份外部源码核查结论（逐条回源核实后确认全部属实），修复了 4 个端"文档声称已修、实际未生效"与"半落地"的问题。
> 验证情况：云端 `pytest` 109 通过（新增 `test_p0_fixes.py` 6 例专门覆盖 P0）、`py_compile` 通过、dashboard 内联脚本经 `node --check` 通过、扩展 JS 经 `node --check` 通过。**Android 侧未做编译验证**——本机 Gradle wrapper 不可用（`gradlew` 报 `Please run: gradle wrapper --gradle-version 8.2`，且无系统 gradle），改动请在有 Android SDK 的机器上跑一次 `./gradlew compileDebugKotlin` 再合并。
> **尚未部署到线上。**

### 云中继 `cloud_relay_v2.py`

- **[P0] Docker/headless 路径下所有异步任务被静默丢弃**（`run_server()` 用局部变量接收 `get_running_loop()`，函数未 `global loop`，而全局 `loop` 恒为 `None`）。Docker entrypoint 走的是 `asyncio.run(run_server())`，从不经过 `run_server_thread()`，因此 `_schedule_async`（REST 拨号 / 挂断 / 登记推送 / 踢人 / 授权回调）全部落到 else 分支只打一条 warning。表现是"服务看着在跑、界面能点，实际什么也没执行"。
  - `run_server()` 改为 `global ... loop` 并在启动时登记事件循环（`run_server_thread` 路径行为不变）
  - 新增 `run_headless()`：headless 专用入口，登记全局 loop + 接管 SIGTERM/SIGINT
  - 新增 `shutdown_gracefully()`：退出时落盘统计 → 取消周期任务 → 关闭所有 WS 连接 → 停服
- **[P0] 分页 limit 只钳上限不钳下限**：SQLite 中 `LIMIT -1` 表示"不限量"，`/api/v1/calls?limit=-1`、`/api/v1/events?limit=-1` 可一次拖走全表（同时打满内存与事件循环）；`/api/logs?n=-1` 同类问题
  - 新增 `_safe_limit(value, default, maximum)`（夹到 `[1, maximum]`）与 `_safe_offset`（负数归零），三处调用点统一替换
- **[P0] `:memory:` 降级分支实际不可用**：每次 `_connect_db()` 都新建一个独立空内存库，`init_db` 建的表后续 44 处连接看不到 → 降级不是"重启丢数据"而是"整个后端直接不可用"
  - 改用 shared-cache 内存库（`file:autodial_memdb?mode=memory&cache=shared`）+ 常驻 anchor 连接（anchor 关闭则库被回收，故永不关闭），所有连接共享同一内存库
- **[P1] 离线登记"无痕丢失"**：组内有手机但连接已死（僵尸连接）时 `forward_to_phones` 吞异常返回，既不发送也不落 pending；补推时删 pending 与"送达"脱钩，补推失败也照样删
  - `forward_to_phones` 现在返回实际送达数；`_push_visit_to_phone` 在送达数为 0 时落 pending；`phone_hello` 补推循环仅在真正送达后删除 pending
- **[P1] `new_device_join` 通知分支不可达**：踢旧机在广播之前执行，遍历 `group.phones` 时集合已空 → 改为使用踢机前的快照
- **[P1] 导出 CSV"顾问姓名"整列为空**：`SELECT * FROM visits` 没有 `kefu_name` 列，`r.get('kefu_name','')` 恒为空字符串 → 按 `kefu_tel` 关联 `advisor_names` 补全（`kefu_tel` 本身是姓名时直接使用）
- **[P1] 登录限频信任可伪造的 `X-Forwarded-For`**：任何客户端换个假 IP 即可绕过。改为默认取 TCP 对端地址（`_peer_ip`），仅当显式设置 `AUTODIAL_TRUST_PROXY=1` 时才采信代理头
- **[P1] REST `auth/respond` 可被手机自批**：原来只校验 `caller_pin == 请求 pin`，而等待授权的手机自己就知道这个 PIN，先调一次 `auth/pending`（也会登记扩展活跃）再调 `auth/respond` 就能给自己放行。现增加：该 PIN 的插件须在线（5 分钟内轮询过）+ 响应方 IP 须与插件轮询 IP 一致
- **[P1] 无优雅退出 / 周期任务叠加 / 会话不回收**：`import signal` 从未使用（`docker stop` 只能硬杀）；服务器重启时 `periodic_*` 任务重复叠加；`_admin_sessions` 只增不减
  - 新增 `_periodic_tasks` 统一记录并在重启前取消、退出时取消；`cleanup_memory()` 增加过期会话清理
- **[P2] Dockerfile `pip install websockets>=12.0` 未加引号**：shell 把 `>` 当重定向，实际装的是无版本约束的包并在工作目录留下垃圾文件 → 已加引号并改用 `printf` 生成 entrypoint
- **[P2] `docker-compose.yml` 未注入管理员账号密码**：代码支持 `AUTODIAL_ADMIN_USER`/`AUTODIAL_ADMIN_PASS`，但 compose 没传 —— 首次启动生成随机密码只打在日志里，用户拿不到就登不进去 → 已补环境变量与 `stop_grace_period`

### 管理面板 `dashboard.html`

- **[P1] 令牌仍大量出现在 URL 里**（"凭据出网址"只做了一半）：`apiGet` 拼 `?token=`，20 余处 `fetch(withToken(url))` 直接调用原生 fetch
  - `apiGet` 改走 `Authorization: Bearer`；新增全局 `fetch` 包装，对所有 `/api/` 请求自动注入 Authorization 头（一次性消灭所有死角，含遗漏的调用点）；`withToken` 保留为恒等函数仅供兼容
- **[P1] 反射型 XSS 面**：`toast()` 与 `setApiBanner()` 直接把消息拼进 `innerHTML` → 统一用已有的 `esc()` 转义
- **[P2] 人员管理表格有「操作」列表头但单元格恒空**（删功能留下的残骸）→ 移除该列，并同步修正 4 处 `colspan="5"` → `4`
- **[P2] 手机管理设备列表无分页、全量渲染**（每台设备还带一行展开详情，设备多时明显卡顿）→ 新增 50 条/页的客户端分页（分页脚注渲染在表格内，不改动页面布局），筛选条件变化自动回到第 1 页
- **[P2] `loadVisits` 绕过统一请求层**：自己 fetch，缺少 429/断网横幅 → 补上 429、非 2xx 与网络异常的提示

### Chrome 扩展

- **[P0] 429 退避是死代码**：`setInterval(pollAuthRequests, INTERVAL * _authPollBackoff)` 的间隔在创建时就固定，429 时只改 `_authPollBackoff` 不重建定时器 → 退避永不生效，始终 30 秒硬撞限流桶。新增 `applyAuthPollBackoff()`：变更倍数即清掉旧定时器、用新间隔重建
  - 注：v4.21 的更新日志把"429 退避"记为已修复，实际只是写了一个没人再读的变量
- **[P0] popup 主题被 MV3 CSP 拦截**：主题初始化为 `popup.html` 内联脚本，MV3 默认 CSP（`script-src 'self'`）拒绝执行且不报错 → 抽成 `theme-init.js` 外部文件（与 `auth.html` 的 `auth.js` 同思路），并在 `manifest.json` 显式声明 `content_security_policy`
- **[P1] 误判号码可能成为生效 PIN**：`getPin()` 无条件兜底 `self_phone`，而 `self_phone` 会被 TreeWalker 的非精确识别覆盖 → 新增 `self_phone_precise` 标记，非精确识别不参与 PIN 兜底（手动 `setPin` 视为精确）
- **[P1] 批量同步漏传 `crm_id`**：云端按 `crm_id` 唯一去重，漏传会导致重复点"同步"把同一条来访反复写库 → 已补
- **[P1] CRM 请求缺 `credentials:'include'`**：扩展页面是 `chrome-extension://` 源，默认不附带 Cookie，CRM 会当成未登录返回登录页（表现为"CRM 登录已过期"）；顺带标注 `Origin`/`Referer` 属浏览器禁改头、设置会被忽略
- **[P1] PC 返回 `success:false` 后未复位 `pcAvailable`**：35 秒缓存窗口内每次拨号都要先白等 3 秒超时 → 失败即复位
- **[P2] 补推队列无间隔重放**：`flushCloudVisits` 逐条之间加 150ms 间隔，遇 429 立即停止并把剩余留到下次（暂存上限 500 条，无间隔重放会继续打爆限流桶）

### Android

- **[P0] 通话记录批量上传水位线逻辑错误**（`DialService.syncCallRecords`）：查询是 `_ID > 水位线` 且 `ORDER BY _ID DESC LIMIT 20`，水位线却取"本批最小 id" —— 水位线落到 81 后下一轮 `_ID > 81` 又把最近 20 条（82..100）捞回来，每轮只前移 1 条，永远在最近 20 条里打转，`id <= 80` 的老记录一条都传不上去
  - 改为**双向水位线**：`highId`（`_ID > highId`，ASC，向上补新）+ `floorId`（`_ID < floorId`，DESC，向下补旧历史），两条线各自单调向外扩张；首次启动把边界对齐到当前最大 id（`floorId = maxId + 1`）
  - 云端 `call_records_raw` 以 `(device_id, local_id)` 为主键且 `INSERT OR IGNORE`，重报幂等，故升级后少量重报不会产生脏数据
  - 抽出 `currentMaxCallLogId()` / `readCallLogBatch()` / `uploadCallBatch()` 三个方法
- **[P0] Manifest 缺 `FOREGROUND_SERVICE_SPECIAL_USE`**：服务声明了 `phoneCall|specialUse`，targetSdk 34 下 `startForeground()` 会抛 `SecurityException` → 开机自启/后台保活全部失效。已补权限声明
- **[P0] 无障碍服务整段被注释**：`DialEngine.kt:178` 在小米机型上调用 `DialAccessibilityService.expectSimPicker()`，但 manifest 里服务未注册 → 自动选卡回退完全失效。已恢复声明（服务仍需用户在系统设置里手动开启，不会强制启用）
- **[P1] 内联"连接"把云地址当 LAN IP 写入**：`putExtra("ip", server)` 传入的是 `ws://host:port`，会污染 `lastLanIp` 与 `prefs["ip"]`，之后局域网直连全部失效 → 不再传 `ip`；`DialService` 侧同时加防御（带 `://` 的值一律忽略，空值不再覆盖已保存的 LAN IP）
- **[P1] 连接中点"取消"不下发 DISCONNECT**：只改本地标志位，后台仍在继续建连，出现"按钮显示未连接、实际已连上"的状态错乱 → 已在下发取消时发送 DISCONNECT
- **[P1] "自动连接"开关与运行时状态相反且不驱动运行时**：UI 默认 `false`（`PrefCtrl`），运行时默认 `true`（`ConnectionManager.loadSavedConfig`），且运行时只在服务创建时读一次 pref → 统一为 `PrefCtrl.KEY_AUTO_CONNECT` / `DEFAULT_AUTO_CONNECT`（取 `true`，保持既有行为），并把 `autoReconnect` 改为实时读 pref 的计算属性，开关立即生效
- **[P2] `allowBackup="true"`** → 改为 `false`（应用数据含 PIN、云端地址、通话记录，不应被系统备份带走）

### 文档同步

- `README.md`：`/api/v1/dial` 的 `PC_CONNECTED` 已于 v4.15 移除（文档与状态码表仍写着）；`/api/v1/visits` 已支持 `days`/`source`/`d_from`/`d_to` 与 `page`/`page_size` 服务端分页（旧文档称"API 仅支持 pin/group、日期筛选是前端过滤"）
- `AutoDial-Extension/AutoDial-API.md`：补充 `auth/respond` 三重归属校验；管理员初始密码说明改为环境变量机制（旧文档称"无 `AUTODIAL_ADMIN_PASS` 环境变量机制、初始密码 123456"，与代码不符）；补充 `AUTODIAL_TRUST_PROXY`
- `技术文档/AutoDial技术文档.md`：授权归属校验条目同步
- 新增 `cloud-relay/python/test_p0_fixes.py`：6 个回归用例覆盖 limit 钳制、内存降级共享、`run_server` 登记全局 loop

## 2026-09-11（第二批 · 综合复核 P0 修复 v4.21）

> 依据《综合复核报告-2026-09-11.md》《综合复核报告-实际使用场景-2026-09-11.md》，逐项对照实际代码核实后修复。全部改动已通过本地验证（pytest 103 通过、E2E 批量导入实测、Kotlin Gradle 编译通过），**尚未部署到线上**（部署需按既有流程 MD5 校验 + py_compile 预检 + supervisorctl restart）。

### 云中继 `cloud_relay_v2.py`

- **[C-01] REST 限流按端点分级**（此前所有 `/api/v1/` 共享 60/min/IP，被扩展授权轮询打爆，线上已实际拦截 `/api/v1/visit` 上门登记）：
  - 认证/管理类（login/admin×/auth/respond）：60/min/IP（维持严格防爆破）
  - 高频轮询类（auth/pending）：240/min/IP 独立配额
  - 业务类（dial/visit/calls/events/stats/devices…）：600/min/IP
- **[C-02] 批量导入改 POST body**：`/api/v1/visits/batch` 新增 POST 方式（请求体 `{"data":[...]}`），绕开 websockets 对 HTTP 请求行 8192 字节硬上限（GET URL 约 20 行中文即超限，整批静默失败）；GET 兼容保留
  - `_PeerProtocol.read_http_request()` 放行 POST 方法（websockets 原版硬编码只接受 GET，POST 在解析请求行即被拒 400）；请求体经 `_request_body` ContextVar 传给 handler
- **[潜伏雷] init_db 全新库初始化必炸修复**：v4.17 引入的 `idx_call_records_dial` 索引建在 `create_call_records` 之前——全新 DB 首次初始化必抛 `no such table`，落入 `:memory:` 降级分支（分支同样先建索引再失败），所有数据落内存库、进程重启即丢。线上因旧库带表未触发。已修正两处分支建表顺序，并用内存 DB 实测验证

### 管理面板 `dashboard.html`

- **[D-2] 未登录/登录过期时停止自动刷新**：锁定态下定时器此前仍每 15 秒触发一轮全 401 的请求，白白消耗限流配额（全员同一出口 IP 时与业务请求互相挤兑）
- **[C-02] 批量导入改 POST + 每批 20 条**（原 BATCH_SIZE=200 拼 GET URL 必超 8KB 上限）

### Chrome 扩展 `background.js`

- **[X-01] 授权轮询降频**：5 秒 → 30 秒（授权请求云端保留 120 秒，30 秒轮询最坏 30 秒内弹窗，体验可接受）；20 台电脑的轮询量从 ≈240 次/分降至 ≈40 次/分
- **[X-01] 429 退避**：被限流后轮询间隔逐次加倍（封顶 8 倍），恢复后回落
- **[G-3] 拨号/挂断/短信不再被"假成功"误导**：PC 端在手机未连接时返回 `200 {success:false, error:'手机未连接'}`，扩展此前只看 HTTP 状态码即报"已拨出/已挂断"——现在读取响应体，`success:false` 时如实报错（dial 失败还会落入云端兜底重试）

### Android `DialService.kt`

- **[P0-B] `logEvent()` 接线**（原函数全仓库零调用，云端 `phone_events` 表永远为空）：拨号结果（ok/error/cancelled）、短信结果全部上报 `/api/v1/events/log`
- **[P0-B] 通话记录上报可观测性**：READ_CALL_LOG 权限缺失不再裸 return（打 FileLogger 日志）；上报失败记录 HTTP 状态码；异常不再无痕吞掉
- **[P0-B] 首传水位线改 DESC**：从最新通话记录开始上报（原 ASC 从最老开始爬，存量大的手机要数小时~数天才能报到"今天"，且先入库陈年数据污染时间线）；DESC 下水位线取本批最小 local_id，逐步向老记录补爬
- 同步策略本身未改：仍要求 WS 已认证在线（isConnected 门控）——离线手机用登记补推通道，通话记录等待重连后自动同步

### 复核实况（未改代码，结论）

- **[A-4] Android 14 前台服务**：核实**已修**——`startForegroundCompat` 按 SDK 选 `specialUse` 类型（34+），manifest 已声明 `FOREGROUND_SERVICE_PHONE_CALL` + `phoneCall|specialUse` 双类型 + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`，无需再改
- **[B] 配对码 deviceId**：核实**已实施**（v4.16）——LAN/Cloud 两处 `phone_hello` 均已携带 `deviceId`（复用 device_uuid），云端以 deviceId 作绑定/去重唯一键
- **[P0-C] 生产库压测数据**：本机 `visits.db` 中 50 台 `StressTest-Phone-*` 均为压测残留；线上 101 台设备中 100 台 `ZZLOADTEST-*` 待管理员确认后清理（清理脚本需登录服务器操作，涉及删数据未擅动）
- **[主线1 局域网直连]**：核实为死链路（PC 只监听 127.0.0.1），维持报告建议"砍掉入口"待拍板，未动代码

### 验证记录

- pytest：103 通过（2 失败为历史遗留 async 测试需要 pytest-asyncio，与本批改动无关，改动前同样失败）
- E2E：真启动服务器（隔离内存 DB）POST 30 行批量导入全量入库 + GET 小批量兼容通过
- 限流分级单元验证：三档配额精确生效、桶互相独立、拒绝不占槽
- Kotlin：`gradle compileDebugKotlin` 通过（本机验证用，kotlin_version 1.9.20 为缓存版本、已还原）
- 扩展 JS：`node --check` 通过；面板两段内联脚本提取后 `node --check` 通过

### 管理员拍板后追加修复（v4.21.1，2026-09-11 晚）

**局域网直连修通（功能保留）**
- `pc-app-Electron/main.js`：HTTP/WS 端口改监听 `0.0.0.0`（原 127.0.0.1 导致手机 UDP 发现后 `ws://<PC局域网IP>:35432` 永远被拒——LAN 直连自始至终不可用）
- `pc-app-Electron/modules/server.js` WS `verifyClient` 重构：
  - 带 Origin 的连接（浏览器发起，无法省略）必须可信 → "任意网页静默连 WS 拨号"的防线不变（S1 目标保持）
  - 无 Origin 放行（Android OkHttp 不发 Origin），身份由 `phone_hello` 的 PIN 校验兜底（配对码错 → auth_fail 断开）
  - 移除 WS 回环 Host 校验（LAN 手机 Host 是 PC 局域网 IP）
- HTTP 层保留回环 Host + 可信 Origin 校验（扩展只从本机访问，不受影响；防 DNS rebinding 依旧）
- Android `ConnectFragment.kt`："检查防火墙"误导文案改为准确指引（同一 WiFi + PC 运行中 + 首次启动允许防火墙）
- PC Windows 防火墙：首次监听外网卡系统会弹授权框，允许即可；被拒时手机 LAN 仍连不上（属正常安全机制）

**PC 端未捕获异常不再退出（P-1）**
- `pc-app-Electron/main.js` `uncaughtException` 由"记日志→退出应用"改为"记录日志 + 弹一次提示，程序继续运行"；同类异常去重防弹窗轰炸

**双击防双拨（PC 直连路径补齐）**
- 复核确认：云端 `/api/v1/dial` 已有 5 秒同号去重（DUPLICATE_DIAL），但 PC 直连 `/dial` 没有——双击浮窗会真拨两次
- `pc-app-Electron/modules/server.js`：HTTP 拨号入口加 5 秒同号去重（在线直发与离线排队两条路径共用一道闸），行为与云端对齐

**数据清理（管理员拍板：直接删不备份）**
- 本地 `visits.db`：50 台 `StressTest-Phone-*` 压测设备及其通话/事件/统计残留已清空（phones 余 0）
- 线上 `101.34.65.254` 100 台 `ZZLOADTEST-*`：本机无 SSH 凭据未执行，留给管理员跑一条命令（见《验证报告-v4.21综合复核修复》第四节）

### 第二梯队修复（v4.21.2，2026-09-11 深夜）

> 依据管理员逐项拍板：8 修、10 配对成功再踢、11 修、12 修、13 修；9 正常不动、14 Go 版不动、15 安全收尾不动。

**C-4 授权握手不再误踢真机（管理员："配对成功再踢下线"）**
- `cloud_relay_v2.py` 手机握手路径：踢旧机从"授权判定之前"推迟到"授权判定成功之后"（`_kick_old_phones` 在 `auth_ok` 前调用）。待授权设备（默认 PIN 不匹配、等待/被拒）不再顶掉该 PIN 正在线的手机；授权通过的两条路径（WS auth_response / REST auth/respond）本就在通过后才踢，行为统一
- 实测：B 设备用他人 PIN 连接被拒后，A 仍在组内并可正常收拨号指令

**A-2 切换云服务器立即生效**
- `ConnectionManager.kt`：`refreshCloudServerList()` 把用户指定的"当前服务器"稳定排序到尝试队首；新增 `switchCloudServer()`——已连接云端时断开并以新服务器立即重连（原先"设为当前"只写偏好、界面切了实际还连旧的）
- `CloudServerSheet.kt`："设为当前"回调触发 `switchCloudServer()`

**C-1 REST 重端点移入线程池（导出/列表不再卡全员）**
- `cloud_relay_v2.py` 新增 `_run_db(fn)` 通用助手；6 个重端点 DB/CSV 段迁入共享线程池：`/api/v1/visit`（登记写）、`/api/v1/visits`（列表）、`/api/v1/visits/export`、`/api/v1/devices`、`/api/v1/calls`、`/api/v1/calls/export`。导出 ≤20 万行 + 内存拼 CSV 期间，事件循环继续跑 WS 拨号/心跳（此前全体卡顿的根因）
- 顺带修复 REST `/api/v1/auth/respond` 中 `conn3` 未定义时 `finally` 抛 NameError 的隐患（该查询同时移入线程池）

**D-8 面板凭据不再进网址（12a）**
- 服务端 `login` / `admin/add` / `admin/chpwd` 兼容 POST body（`_request_body` 机制），前端登录/加账号/改密码改 POST JSON body——明文凭据不再出现在 URL / 访问日志 / 浏览器历史
- 两处导出由 `window.open(带token URL)` 改 `fetch` + `Authorization: Bearer` 头 + blob 下载，token 不进地址栏与历史

**面板 13 项打磨**
- hash 路由（`#/visits` 等）：F5/收藏/分享保留当前页（原先必回首页）
- 危险操作自定义确认弹窗（替换 3 处原生 `confirm`，回显账号 ID / 记录 ID / 分组 ID）
- 改密码"手输账号 ID"改下拉选择（loadAdminAccounts 填充）
- 删除手机页名不副实的"详情"按钮及其空列（列 10→9，真正的历史靠点行展开）
- 表格最小列宽 92px→72px（1280 屏不再无谓横向滚动）
- 表头字号 11px→12px；浅色主题次要色 `#5880A8`→`#456B8F`（对比度 ~3.8:1 → ~5.0:1，达 WCAG AA）
- 定时刷新不再重置用户上下文：`_timerRefresh` 软刷新标记——通话页翻页保留、上门页筛选下拉不重建、手机页已展开行自动恢复（`phoneExpanded`/`phoneRowMap`）
- 列表请求加序号（`_loadSeq`），慢响应后到不再覆盖新数据（手机/通话/上门）
- 顶部横幅"成功即灭"改为错误计数（并发下一次成功不再吹灭别的失败提示）；未登录时 401 文案改中性"请先登录"
- 切页清除"上次刷新 · 已跳过"残留提示

## 2026-09-11

### 云端管理面板状态可信度整改（v4.19 + v4.20，合入 9-11autodial-master.zip 分支）

**云中继 `cloud_relay_v2.py`**
- 新增 `/api/v1/calls/export`（管理员鉴权）：按 `device_id/pin/date_from/date_to/number` 同套筛选条件服务端导出**全部匹配记录**（LIMIT 200000），CSV 带 BOM + 防公式注入 + 附件头（与 `visits/export` 同风格）
- 修复线上存活 BUG：新设备加入已有组的广播分支 `list(group.pcs) | list(group.phones)` 必抛 TypeError（sets 先 list 再 | ）→ 改为 `list(group.pcs | group.phones)`；该分支位于"PC 已在线时手机接入"的常见路径，此前加入通知整体发不出

**dashboard.html**
- 统一请求层：新增顶部全局横幅 `#api-banner`——401（清 token+重新登录）/429（限流）/非 2xx（显示状态码）/断网 分类提示，成功自动收起；请求失败不再被渲染成"暂无数据"；登记页/人员页原生 fetch 补 401 处理
- 移除假"保存设置"（原 `saveSettings()` 不发请求只弹提示）；端口/日志级别改只读，`refreshSettingsInfo()` 走 `/api/status` 显示真实运行端口 + 服务器端修改指引
- 通话记录导出改服务端全量（前端拼 CSV 只导当前页 50 行，年底对账静默缺数据）
- 补 4 处静默 `catch{}`：内联编辑保存失败 toast 明确报错，分组/姓名失败自动重拉保证"界面显示=服务端真实值"，成功给反馈
- 8 张 data-table 自动包裹 `.table-wrap` 横向滚动容器（列数×92px 最小宽），窄屏/多列表格不再挤压变形
- 手机搜索、系统日志关键词搜索统一 400ms 防抖（原先每按一键全量请求一次）
- 管理员密码/新密码输入框改 `type="password"` + `autocomplete="new-password"`（防旁视泄露）
- 自动刷新防误伤（v4.20）：正在表格内联编辑/弹窗填写时自动跳过本轮刷新；顶部"自动刷新"徽标可点击暂停/恢复，长时间录入不被打断

**文档**
- 新增 6 份 2026-09-11 报告：面板 UX 排查、代码审查（实际使用问题）、修复清单（第一批）、验证报告×3（第一批整改/P0 修复实测/面板真实数据实测）

## 2026-09-10（第三批）

### 管理面板性能/导出 + REST 限频 + 姓名翻转修复（v4.18）

**云中继 `cloud_relay_v2.py`**
- [D1] `/api/v1/visits` 支持分页：`page`/`page_size`（1-200）返回 `{ok,total,page,page_size,rows}`；不带 `page` 保持返回数组（手机端同步完全兼容）；新增 `days`/`d_from`/`d_to`/`source` 服务端过滤（来源=unsynced 映射 crm_synced=0）
- [D1] 新增 `/api/v1/visits/export`（管理员鉴权）：按当前筛选条件服务端导出**全部匹配记录**（不再只导屏幕已渲染行），CSV 带 BOM（Excel 中文不乱码）+ 防 CSV 公式注入（=+-@ 前置单引号）+ 附件头
- [E] REST 全局限频：`MAX_REST_PER_MINUTE=60/IP`（localhost 豁免），通过 `create_protocol` 协议子类在握手时捕获对端 IP（legacy process_request 拿不到地址），堵住公网 PIN 枚举/管理口令爆破/接口滥用；`_rest_attempts` 纳入周期清理
- [D4] `/api/v1/visit` 顾问姓名映射改为 `ON CONFLICT DO NOTHING`——登记的"接待顾问"不再覆写扩展上传的"业务员本人"姓名，人员管理姓名不再来回翻转

**dashboard.html**
- [D1] 登记列表分页（每页 50，上一页/下一页/页码/总数显示），15 秒自动刷新只拉当前页——一年 10 万行后面板不再卡死；兼容旧版服务端（数组退回全量渲染）
- [D1] 上门趋势图只拉最近 14 天（此前每 15 秒全量拉整表两次）
- [D1] 导出 CSV 改为服务端按筛选条件导出全量

**已知取舍**
- `/api/v1/calls` 按设备换人后历史归属问题（D5）未动——需数据模型决策，暂缓

## 2026-09-10（第二批）

### 登记数据正确性修复（v4.17）— C 类数据错账 + D2/D3 零成本安全项

**云中继 `cloud_relay_v2.py`**
- [C3] `/api/v1/visit` 新增 `crm_id` 参数：客户端唯一 id，重发/补推按唯一索引精确去重（同一物理来访只入库一次）；visit_record 推送携带 crm_id
- [C2] 无 visit_time 的回退去重从"当日同号"改为"**同号 2 小时内**"——原逻辑会静默吞掉同客户当天第二次真实上门（CRM 有两条、云端只有一条）
- [D2] `/api/v1/advisor/register` 免鉴权端点加校验：PIN 格式 + 姓名长度≤32 + 拒收 HTML 特殊字符
- [D3] 新增 `idx_visits_mobile`、`idx_call_records_dial` 索引，去重/翻页查询不再全表扫描；visit 字段加长度上限
- [D2] `dashboard.html` 两处存储型 XSS 修复：登记列表 `visit_time`、人员管理 `pin` 渲染前 esc() 转义（此前可经 /api/v1/visit 与 advisor/register 注入管理员浏览器）

**Chrome 扩展**
- [C1] CRM 提交严格校验：HTTP 非 2xx（登录过期 401/302、5xx）直接判失败；返回非 JSON（登录页 HTML）不再视为成功；`code` 缺失不再算成功——此前"假成功"导致 CRM 实际未写入
- [C3] CRM 成功但云端不可达时，登记入 chrome.storage 暂存队列（上限 500 条）；SW 启动与下次登记成功时自动补推（crm_id 保证云端去重）
- [C7] 顾问匹配移除"兜底取第一个"——无精确匹配直接报"未找到顾问"，不再把客户挂到同名/相似顾问名下；CRM search 请求加 8s 超时

**Android**
- [C4] 统计翻倍修复（三管齐下）：①提交不再双写 registration_timestamps，统计只读 visit_records；②云端回推按 crm_id 抑制（本机已登记的 echo 直接跳过）；③统计合并加 2 秒簇去重（兼容历史双写数据）
- [C5] 离线补推重写：补推并发保护（AtomicBoolean）+ 每条重读队列 + 成功按 crm_id 原子删除一条——补推期间新保存的记录不再被整体覆写丢失；旧快照写回竞态消除
- [C4] 周起始修正：所有 `set(DAY_OF_WEEK, MONDAY)` 前先 `firstDayOfWeek = MONDAY`，修复周日"本周"统计归零
- [C3] 手机自登记生成 `ph-<pin>-<ts>` crm_id：云端去重 + 本机 seen_crm_ids 抑制回推双计；补推复用同一 id
- [C7] 顾问列表加载失败不再无限"正在加载"——15 秒内明确提示"加载失败，请检查网络或 CRM 登录状态"

**已知取舍**
- CRM 批量同步导入（/api/v1/visits/batch）与插件手工登记之间仍无跨源去重（插件无 visit_time 无法精确匹配）——重发类重复已由 crm_id 消灭，跨源重复需业务层关联，暂缓
- REST 全局限频暂未加（websockets legacy handler 无法直接取对端 IP，需协议层改造），advisor/register 已加校验降低注入面

## 2026-09-10

### 配对码遗留问题修复（v4.16）+ 设备自动注册（v4.16.1）+ 后台登录门禁 + 35440 数据落卷 — 完成于 2026-09-10

设计原则：20 人内部使用、便捷优先于安全、单管理员、双实例容灾（35430 主 / 35440 备，两套数据为预期）。

**云中继 `cloud_relay_v2.py`**
- [B1] `phone_hello` 改用 `deviceId` 作为设备唯一键（`meta['device_id'] = msg.get('deviceId') or deviceName`，旧 APK 缺字段自动回退 deviceName，零破坏）；设备-PIN 绑定查询、踢旧连接、AUTH/PHONE_HELLO 日志全部改用 device_id
- [B2] 同步修正三处遗漏的 deviceId 传递：转发 PC 的 hello（原 831 行）、RESEND 给新连 PC（原 884 行）、WS 授权通过后的转发；`/api/v1/devices` 的 `online_map` 在线判断改按 device_id 匹配；`/api/v1/auth/pending` 返回体补 device_id
- [A1] **设备自动注册（v4.16.1）**：`AUTO_REGISTER_DEVICE` 默认开启，未注册设备首次连接自动绑定当前 PIN 并放行，取消"联系管理员预设"硬门槛；换 PIN 仍走插件授权（防误输顶号）；env `AUTODIAL_AUTO_REGISTER=0` 可恢复严格模式。服务器实测：模拟未注册手机 → AUTO_REGISTER 日志 → DB 生成绑定 → auth_ok
- [A2] 跨 PIN 授权文案改为可操作提示：插件/CRM 未打开 → "需对方授权：请对方（PIN xxx）在电脑上打开 CRM 界面后，重新点击「连接」"；120s 超时 → "授权超时：对方未在 CRM 界面确认。请对方打开 CRM 页面后，重新点击「连接」"

**Android**
- [B1'] `ConnectionManager.kt` LAN / Cloud 两处 `phone_hello` 增加 `deviceId`（复用 `PrefCtrl.getDeviceId()` 的 device_uuid；deviceName 保持型号仅作展示）
- [A1'] `ConnectionManager.kt` Cloud 消息 when 显式新增 `auth_pending` 分支并透传上层（修复：此前落入 `DialService.onMessageReceived` 被静默丢弃，只能干等 120 秒）
- [A2'] `DialService.kt` 新增 `ACTION_AUTH_PENDING` 广播（带 message/default_name，不走 notifyConnectionChange 避免误触发重连）
- [A3'] `ConnectFragment.kt` 注册 `authPendingReceiver`，等待授权显示橙点脉冲 + "等待授权中…（原因）"；等待期间"取消"真正断开连接（云端 finally 自动清理挂起请求）；doConnect 3 秒提示不再覆盖等待文案

**后台前端 `dashboard.html`**
- [G1] 登录门禁：未登录（无会话 token）时 body.locked 隐藏登录框以外全部内容 + 禁滚动 + 强制弹出登录框（不可点空白关闭）；登录成功/登出/401 均自动回登录页。数据 API 服务端 `_check_admin` 原本就有，此改动补齐"界面本身不外泄"一层

**部署（101.34.65.254）**
- v4.16 / v4.16.1 / 文案修订 / 登录门禁分四批上线，双实例（35430 supervisor + 35440 Docker 镜像 v2）均验证 /health 正常；逐行 diff 确认服务器无本地缺失的独有配置，纯升级无回退；各步均有备份（`cloud_relay_v2.py.bak.pre-v4.16_20260910`、`.bak.v4.16_20260910`、`dashboard.html.bak.pre-login-gate_20260910`、Docker 镜像 v1）
- [D1] **35440 数据落卷修复**：Dockerfile 漏设 `AUTODIAL_DB_PATH`，数据库原落在容器内 `/app/visits.db`，重建即清零（当天已发生数轮）。容器重建加 `-e AUTODIAL_DB_PATH=/app/data/visits.db` + Dockerfile 补 ENV 行；验证 DB 已落挂载卷 `/opt/autodial/data/visits.db`，双实例独立容灾设计不变
- 注：/health 返回的 `version: "4.10"` 为代码内版本常量未更新，实际已是 v4.16.1，不影响功能

**备注**
- Kotlin 改动本机无 Java/Android SDK 未编译验证，需 GitHub Actions 构建确认；旧 APK 缺 deviceId 自动回退，无需强制升级
- 旧 APK 以型号名作设备键期间，同型号多台共享一条绑定（首连者定 PIN）；新 APK（device_uuid）发放后按设备唯一。老 APK 将弃用
- 待办（B3）：后台给各设备预设 default_pin 的一次性动作，随新 APK 发放视需要执行

## 2026-08-22

### 第四批 P2/P3 清理修复（QA 独立回归 13/13 PASS）— 完成于 2026-08-22 11:00

死代码清理 / QA 遗留观察项 / 轻量优化，每处删除均先 grep 全量确认无调用者。

**云中继**
- [Q1] `dashboard.html` `delAdminAccount` 迁移为 data-action 事件委托（与第二批 S3 统一，消除最后一处拼接式 onclick）
- [Q2] `cloud_relay_v2.py` 登录成功清空该 (user,ip) 失败计数（限频不再跨成功保留）
- [Q3] `get_logs` 改为文件尾部倒读（PY-P1-2 轻量缓解，不再全量读入 10MB 日志；8 例边界实测通过）
- [Q4] 死代码删除：`check_heartbeats` / `_sync_to_crm` / `_lookup_kid` / http.server import；注释对齐（热更新、5 分钟→1 分钟）

**Chrome 扩展**
- [Q5] 死代码删除：`tabPhones` / `reDetectPhone` / `_lastAuthPollTime` / `checkIsAdmin` 分支 / `getMyPhoneFromCRM` / `adStyles` / `showPosition`

**Go PC 端**
- [Q6] 死代码删除：`generatePinCode` / `onUpdate` 回调；go.mod 清理 EDY 残留注释

**Electron PC 端**
- [Q7] 删除无调用方的 `fetchCloudServers` 函数与 `fetch-cloud-servers` IPC 注册
- [Q8] 删除无发送方的监听：floatbar `menu-dial`/`menu-hangup`、index.html `error`/`open-settings-tab`/`open-sms-tab`
- [Q9] 删除 `index.html` 死代码 fetch `/api/set-pin`（实际走 IPC）；`discovery.js` 未使用变量
- [Q10] `pack.js` 硬编码 EDY 缓存路径 → `os.homedir()` 动态路径

**Android**
- [Q11] `DialService.kt` 删除未使用 pin 变量
- [Q12] `CallLogDb.kt` 异常文案指向真实存在的 `getInstance(context)`
- [Q13] 删除死代码 `rebuildV3ConnectionHeader` / `showDialModeDialog`；`autoTestServersOnStart` 经 grep 确认有调用者、正确保留

**QA 独立回归**：13/13 PASS / 0 FAIL；前序修复（dashboard 委托 9 action、authorized 授权标记、登录限频、Electron IPC 通道）兼容性抽查通过。
**遗留观察项**（非阻塞，后续顺手可清）：floatbar.html:412 `error` 监听无发送方；main.js 7 个无调用方 ipcMain 处理器；get_logs 全空行文件边界（实际无影响）；discovery.js 未使用解构。

**四批累计修复 49 点**（18 + 12 + 6 + 13）。剩余建议单独立项：PY-P1-2（REST 线程池化）、AN-P1-3（HTTPS 迁移）；EX-P1-2（PIN 误检测，设计取舍）。

### 第三批修复：资源泄漏 / data race / 体验（QA 独立回归 R1-R6 全 PASS）— 完成于 2026-08-22 10:30

**Go PC 端**
- [R1] `server.go` ACK 定时器超时路径补 `delete(pendAcks, msgID)`（GO-P1-1，消除每次拨号超时的 AckEntry 泄漏；与 handleAck 幂等共存）
- [R2] `devices.go` removeDevice 补关连接（GO-P1-6），并经 QA 发现后**收敛**：仅关闭 LAN Ws（独立读 goroutine 防泄漏）；共享 CloudWs 生死归 cloud.go pong 看门狗，单台云手机超时不再引发全体云设备闪断重连
- [R3] `settings.go` 全局 appSettings 加读写锁 + tmp/rename 原子写（GO-P1-8；23 处引用全量覆盖，锁序无嵌套、无重入）

**Electron PC 端**
- [R4] `cloud.js` 替换旧连接时清理旧 `_pingTimer`（EL-P1-3，消除重连定时器泄漏）

**Android**
- [R5] `CloudCtrl.kt` testServer 用 try/finally 统一释放 OkHttpClient（AN-P1-8，覆盖成功/失败/取消全出口）

**Chrome 扩展**
- [R6] `content-script.js` showToast 上提到 IIFE 顶层（EX-P1-3，顶层同步进度不再回退阻塞式 alert）

**QA 独立回归**：R1-R6 全部 PASS / 0 FAIL；前两批兼容性抽查 3 项 PASS。gofmt/vet/build 与 node --check 通过（frontend/dist embed 缺失为既有环境问题）。

**至此三批累计修复 36 点**（第一批 18 + 第二批 12 + 第三批 6）。剩余未修：PY-P1-2（REST 线程池化，大改建议单独立项）、AN-P1-3（HTTPS 迁移，单独立项）、EX-P1-2（PIN 误检测，依赖 CRM 页面，需用户决策）及 P2/P3 低危项。

### 审计报告 P0/P1 最小改动修复（软件开发团队协作，QA 回归通过）— 完成于 2026-08-22 08:35

依据《Bug检查报告-2026-08-21.md》修复 18 点（工程师寇豆码执行、QA 严过关独立回归：17 PASS / 1 风险 / 0 FAIL）。所有改动遵循最小 diff，未引入新依赖。

**云中继**
- [A1] `cloud_relay_v2.py` init_db `:memory:` 降级分支补建 phones/call_records_raw/phone_events/phone_daily_stats 4 张表（修复 PY-P0-1 漏建表）
- [A2] `_seed_default_admin()` try 前预置 `conn = None`，杜绝 finally NameError（PY-P1-5）
- [A3] `dashboard.html` loadPins 两个 fetch 补管理 token（PY-P1-3，"人员管理"页恢复可用）
- [A4] `escA()` 补反斜杠转义（PY-P1-4；残余风险见下）
- [A5] REST `/api/v1/auth/respond` 踢旧手机补 `close`（PY-P1-6，消除幽灵连接）

**Chrome 扩展**
- [B1] `auth.html` 内联脚本与 onclick 抽到外部 `auth.js`（EX-P0-1，规避 MV3 CSP，设备授权弹窗恢复可用）

**Go PC 端**
- [C1] `security.go` Origin 校验：空/`null` 拒绝 + 精确 host 校验（GO-P0-1，堵前缀绕过与空 Origin 放行）
- [C2] WebSocket 并发写锁：设备级 `wsMu` + 全局 `cloudWsMu` 统一串行化所有写路径（GO-P0-2；QA 死锁专项审查通过）
- [C3] `cloud.go` 读循环补 `case "ack"`，与本地共用 handleAck（GO-P0-3，云通道拨号不再误超时/重复拨号）
- [C4] `RestartCloud` 异步化（GO-P1-4）
- [C5] 悬浮条状态接通 `updateFloatbarStatus`（GO-P1-5，拨号/挂断按钮恢复可用）

**Electron PC 端**
- [D1] `cloud.js` failover generation 单次递增（EL-P0-1，多服务器遍历恢复）
- [D2] `main.js` 托盘创建移到窗口创建之后（EL-P1-1，托盘菜单恢复可用）

**Android**
- [E1] `build.gradle` 移除硬编码签名密码，改 env/keystore.properties 必填（AN-P0-1）
- [E2] `DialService` 亮屏 receiver 补 RECEIVER_NOT_EXPORTED（AN-P0-2，Android 14+ 不再崩溃）
- [E3] 通知栏移除 PIN 明文（AN-P1-2）
- [E4] `MainActivity` 三个广播改 RECEIVER_NOT_EXPORTED（AN-P1-4）
- [E5] `RegisterFragment` flushPendingSyncs 线程池 finally shutdown（AN-P1-5）

**已知残余**：
- A4 未完全覆盖 onclick 单引号属性注入（`&#39;` 被属性解析器解码还原），建议后续将 dashboard 内联 onclick 迁移到 addEventListener + data-* 属性；本次已按报告要求堵住反斜杠向量
- EL-P0-2（Electron 仅监听回环导致 LAN 直连失效）属 v4.14 有意安全收窄，未改
- 其余报告 P1/P2/P3 项未在本次范围，见报告

### 第二批修复：安全 5 + 功能 4 + 崩溃 2 + 构建 1（QA 独立回归 12/12 PASS）— 完成于 2026-08-22 09:40

**安全**
- [S1] `server.js` Electron 端来源校验与 Go 对齐：空/`null` 来源拒绝 + URL 精确 host（EL-P1-4，堵 `<img>` 静默拨号）；HTTP 与 WS verifyClient 同步收紧；renderer 依赖核查无本地端口真实依赖
- [S2] `cloud_relay_v2.py` 授权绕过封堵（PY-P1-1）：新增 `meta['authorized']` 标记，未授权手机的消息不再转发给 PC（心跳 ping/pong 不受影响；等待授权链路保持可收 auth_ok）
- [S3] `dashboard.html` 8 处含用户数据的动态 onclick 全部委托化为 data-action + 事件委托（A4 残余加固，彻底消除 onclick 单引号注入）
- [S4] `cloud.go` 云端 phone_hello 增加 PIN 校验（GO-P1-7）：readPin() 空/格式/与配对码不符均拒绝注册；QA 评估不会误伤合法多手机
- [S5] `cloud_relay_v2.py` 登录限频改按 (username, client_ip) 维度（PY-P1-7，消除全局 DoS）

**功能**
- [F1] `cloud.js` 自动重连恢复（EL-P1-2）：error 分支与"从未认证成功"路径均调度重连，与 D1 generation 兼容
- [F2] `content-script.js` syncVisitList 顶层监听器不抢答（EX-P1-4，iframe 布局下同步恢复）
- [F3] `content-script.js` 分页识别限定容器 + 纯数字≤4 位 + http(s) 协议（EX-P1-5，不再把手机号链接当页码）
- [F4] `app.go` + `server.go` dialQueue 覆盖时 Stop 旧 Timer（GO-P1-3，消除连续拨号号码被误删）

**崩溃 / 构建**
- [C1] `RegisterFragment.kt` / `StatsFragment.kt` 后台线程 requireContext 改主线程预取 appCtx（AN-P1-1）
- [C2] `MainActivity.kt` postDelayed 弹窗加 isFinishing/isDestroyed 守卫（AN-P1-7）
- [B1] `package.json` build.files 补 `themes/**/*`（EL-P1-5，修复 electron-builder 打包缺主题）

**QA 独立回归**：12/12 PASS / 0 FAIL；与第一批兼容性抽查 3 项（D1+F1、A1/A2/A5+S2/S5、S1+扩展 fetch）全部 PASS。非阻塞观察：dashboard L1166 `delAdminAccount(a.id)` 拼接式 onclick 仅含 DB 自增整数、风险低，可后续统一。

## 2026-08-21（深夜）

### 报告全量复核修订（只改文档，未动代码）

对《Bug检查报告-2026-08-21.md》全部约 183 条论断逐条复查（5 复核代理 + 关键点人工实测 + 官方 changelog 核证，另经第三方 AI 独立验证 8 项核心修正全部确认）：

- **PY-P0-2 降级 P0→P2**：websockets.legacy 实测（12.0/16.0/16.1.1）与官方 changelog 确认**从未移除**（14.0 弃用、15/16/17 均保留），"新环境部署必崩 ImportError"不成立；Dockerfile `>` 重定向机制属实但后果为"依赖未锁定 + 弃用 API"
- **PY-P2-b 误报移除**：REST header 大小写敏感不成立（websockets Headers 内部键全小写，实测命中）；README 对应警示已撤销
- **数字修正**：PY-P0-1 漏建 4 张表（非 5 张）；MISSING 计数 6 处（非 7）；`/api/history` 返回约 2.4 小时（非 4 小时）
- **措辞修正**：AN-P1-1（L626/660 有 try-catch，真无保护在 L690）、AN-P0-2 子项、AN-P2-e 30 次上限、EX-P1-3/4、EL-P2-a
- **严重性补充**：GO-P0-1 空 Origin 直接放行（`<img>` no-cors 即可触发，比原判定更严重）
- P0 有效清单 10→**9** 项；P2 合计 60→61；复核统计 ✅161 / ❌3 / ⚠️19
- 同步修订：`README.md`（撤销 header 大小写警示、history 2.4h）、`部署指南.md`（websockets 坑措辞："未锁定"非"必崩"）

## 2026-08-21

### 全量代码复审（只读）+ 文档规整

**审计**（未修改任何代码）
- 五端（云中继 Python / Chrome 扩展 / Go PC 端 / Electron PC 端 / Android 端）全量静态审查
- 新增《Bug检查报告-2026-08-21.md》：P0×10（均已二次核验）、P1×33、P2×60、P3×82
- 重点结论：扩展 auth.html 被 MV3 CSP 阻断（授权流程死亡）；Go 端 Origin 前缀匹配可绕过；Electron 云 failover 永不切换；Android 签名密码硬编码 + Android 14 必崩；websockets 依赖未锁定
- 核验 v4.14 声称修复项：Android 三项属实；授权链路/来源校验/ACK 竞态修复均不完整或被绕过

**文档规整**（依据实际代码修订）
- `README.md`：修正错误码表（补 `MISSING`）、响应格式说明、`/api/v1/visits` 筛选参数、`/api/history` 保留时长、双模路由超时描述（仅探测 500ms）、扩展版本号（5.0.0）、目录结构（补 themes.js、auth.html 定位）、PIN header 传递方式；新增版本号现状说明与依赖坑警示
- `部署指南.md`：新增"已知部署坑"（websockets<14 上界 + Dockerfile shell 重定向缺陷）
- `待验证问题.md`：新增 2026-08-21 复审待验证项（B1-B5）

## 2026-08-19

### v4.14 全链路修复 + 安全加固

**云中继 cloud_relay_v2.py**
- 修复 `GET /api/v1/auth/respond` 引用未定义 `default_pin` 的 NameError（扩展端授权流程恢复可用）
- 授权防越权：REST `auth/respond` 必须携带与请求一致的 `pin`（错误返回 `UNAUTHORIZED` 且不消耗请求）；WebSocket `auth_response` 仅允许 PC 端响应——封死等待授权的手机自批
- `reconnect_request` 纳入 `PC_TO_PHONE_TYPES` 转发白名单（此前被静默丢弃，PC 云端唤醒离线手机完全失效）；`forward_to_phones` 的 `targetDevice` 兼容设备名与设备当前 PIN
- `events/log`、`stats/report` 的 `INSERT OR REPLACE INTO phones` 改为 `ON CONFLICT DO UPDATE`，不再抹掉管理员预设的 `default_pin`/别名（设备绑定被手机上报静默破坏的问题）
- 新增 `_connect_db()` 统一连接入口（39 处替换），每个连接显式 `timeout=5` + `PRAGMA busy_timeout=5000`，消除低版本 Python 下并发写 `database is locked`
- 管理员安全：密码 SHA-256 加盐哈希存储（`_hash_pwd`，登录兼容旧明文并自动迁移）；登录限频（60s/5 次失败返回 `429 RATE_LIMITED`）
- 鉴权收紧：`/api/status`、`/api/clients`、`/api/stats`、`/api/logs`、`/api/history`、`/api/v1/pins`、`/api/v1/groups`、`/api/v1/devices`、`/api/v1/device-history`、`/api/v1/calls`、`/api/v1/phone-stats`、`/api/v1/events` 及 `/api/v1/visits`（无 pin 时）要求管理员令牌
- `AUTODIAL_DB_PATH` 环境变量支持（Docker 数据库落持久卷）

**dashboard.html**
- 敏感查询统一携带会话令牌（`withToken`）；PIN 下拉框 `p.pin` 转义防 Stored XSS

**PC 端（Go + Electron）**
- 本地端口 35432 增加回环 Host + 可信来源校验（扩展/Electron 页面/本机工具放行；外部网页与 DNS rebinding 拒绝），HTTP 与 WebSocket 均覆盖
- Go：`sendToPhone` ACK 定时器写入改为非阻塞 select（消除竞态 goroutine 泄漏）；`/sms` 补号码格式校验；`server.go`/`devices.go` 格式化
- Electron：`set-pin` 错误通过 `pin-error` 通道回显（前端监听 + 校验对齐），消除"假保存成功"；`addLog`/短信模板 innerHTML 转义防 XSS

**Chrome 扩展**
- 授权弹窗 `respondAuth` 携带 PIN（配合云中继归属校验）

**Android**
- `MainActivity` 权限回调下标修复（通话列表刷新）；`CallLogDb` 日期格式改 ThreadLocal（消除跨线程竞争）；`ConnectionManager` 日志 PIN/手机号脱敏

**测试**
- `test_auth.py` 场景4 的 respond 请求补 `pin` 参数，与新版协议一致

**文档**
- 更新 `README.md`、`AutoDial-API.md`、`部署指南.md`、`待验证问题.md`（本文档）

## 2026-08-01

### 云中继并发 / DB 性能 P0 修复 + 测试脚本

**cloud_relay_v2.py**
- 新增专用 DB 线程池 `_db_executor`（8 线程），将同步 SQLite 查询卸载到线程池，避免阻塞事件循环
- SQLite 启用 WAL 模式（`journal_mode=WAL`）、`synchronous=NORMAL`、`busy_timeout=5000`，缓解写锁阻塞读
- localhost 请求不限频（健康检查、管理面板自身调用）
- `forward_to_phones` 遍历前创建快照，避免迭代过程中集合被并发修改
- `_schedule_async` 优化：事件循环内用 `create_task`，跨线程用 `run_coroutine_threadsafe`
- REST 拨号转发、`visit_record` 推送统一改用 `_schedule_async`

**测试脚本**
- 新增 `test_cloud_relay_v2.py`、`test_stress_50_users.py`

**文档**
- 更新 `README.md`、`部署指南.md`、`待验证问题.md`

## 2026-07-31

### 扩展端 UI 对齐手机端「天空蓝 · 亮白」(v4.13)

**Chrome 扩展**
- `popup.html` 弹窗整体改版：暗金主题 → 天空蓝亮色主题，与手机端默认主题（ThemeManager sky-blue/light）一致
  - 页面底色 #EBF4FF、白色卡片 + #DCEAF7 描边、输入框 #F4F8FC、主按钮 #4A90E0→#1A56A8 蓝渐变
  - 状态大盘改为浅蓝渐变卡片，在线状态点增加脉冲动画
  - 设置项改为白卡分区 + 图标小块（#EDF5FD），与手机端设置页一致
- `auth.html` 设备授权页同步改版为天空蓝亮色
- `content-script.js` 新增「天空蓝」主题并设为默认（localStorage 已选主题的用户不受影响）
  - 修复亮色主题下拨号按钮文字对比度（新增 textOnAccent 字段）
  - 清理 5 处硬编码旧主题色（#2ECC71/#E74C3C），改用主题变量
- `popup.js` 修复状态文字 class 名不匹配（server-status → field-status），成功/失败着色此前未生效
- 扩展版本号 4.1.0 → 4.2.0

## 2026-07-23

### 安全加固 + Bug 修复 (v4.12)

**云中继**
- 管理后台增加管理员鉴权（账号密码登录 + 会话令牌，24h 过期）
- 管理员账号存于 `admin_accounts` 表，鉴权始终启用（`_check_admin`）；`GET /api/v1/login` 发放 24h 会话令牌
- 保护端点：添加/删除管理账号、分组增删、登记增删改、踢出设备
- 修复会话令牌永不过期 bug、登录状态验证用错接口 bug

**PC 端 (Go)**
- 监听地址从 `0.0.0.0` 改为 `127.0.0.1`（防止局域网直接访问拨号接口）
- 修复 `activePin` 闭包问题（切换手机后定时器可能删除错误队列）
- `msgCounter` 改用 `atomic.Uint64`（消除并发数据竞争）

**Electron**
- 修复剪贴板检测不工作（main.js 返回字符串，渲染层错误读取 `d.text`）
- `pack.js` TLS 证书校验恢复（仅在构建期间临时放行，构建后恢复）

**Chrome 扩展**
- 修复挂断/短信/拨号 `sendResponse` 不调用（导致按钮无反馈）

**Android**
- 批量同步通话记录从 50 条限制为 20 条（避免 URL 超长）

**工程整理**
- 删除废弃文件：`cloud_relay.py`（旧版）、`web_server.py`；`package.json` 未删除（仍存在于 `pc-app-Electron/`）
- 更新 `build.bat`、`start.bat`、`Dockerfile` 引用到 `cloud_relay_v2.py`
- 清理过时/冗余文档 3 份，更新技术文档 3 份

## 2026-07-21

### 同步登记列表全链路修复 + 纯增量去重 (v4.11)

**核心问题**：扩展端"同步登记列表"功能完全失效（3个bug），且云中继去重逻辑导致跨天重复入库。

**content-script.js** — 修复 3 个 Bug + 自动翻页
- **Bug #1**（严重）选择器错误：`form[name="fdsf"] table tr` 匹配了搜索表单（1行）而非数据表格（22行），导致循环从未执行
  - 修复：`form[name="fdsf"] ~ table tr`
- **Bug #2** 列数过滤错误：`cells.length < 12`，实际表格只有 11 列，所有行被过滤
  - 修复：`cells.length < 11`
- **Bug #3** 时间列索引错误：`cells[11]` 超出范围，应为 `cells[10]`
  - 修复：`cells[10]`
- **新增** 自动翻页抓取：从分页链接扫描所有页码，用 `fetch + DOMParser` 逐页解析，合并全量记录
- **新增** 增量反馈 toast：`✅ 同步完成：共 120 条，新增 80 条，跳过 35 条（当日已存在），失败 5 条`

**background.js** — 右键菜单增强 + visit_time 传参 + 分状态计数
- **新增** 3个右键菜单入口：
  - 🔁 一键同步上门数据（任意CRM页面右键 → 自动跳转+同步）
  - 同步登记列表当前页（仅列表页右键）
  - 🔁 一键同步上门数据（扩展图标右键）
- **新增** `visit_time` 参数传递到云中继
- **改进** `batchSyncVisits` 区分 `synced / skipped / failed` 三种状态
- **去除** 重复的 `VISIT_LIST_URL` 局部声明，提升为模块常量
- **修复** 使用 `chrome.contextMenus.removeAll()` 防止 MV3 service worker 重启时菜单重复

**cloud_relay_v2.py** — 纯增量去重 + visit_time 支持
- **新增** `visit_time` 字段：DB迁移 + CREATE TABLE + INSERT + visit_record推送
- **改进** 去重逻辑：有 `visit_time` → `WHERE mobile=? AND visit_time=?`（真·纯增量）；无 `visit_time` → 回退旧逻辑（兼容一键登记/手机端）
- **关键变化**：同一客户同一天的 CRM 来访记录，无论同步多少次，只存一条

**dashboard.html** — Web 管理面板增强
- **新增** 表格"来访时间"列（第9列）
- **改进** 日期筛选优先按 CRM 来访时间（`visit_time || created_at`）
- **新增** 来源筛选增加"CRM同步"选项 + 独立 badge 样式（`.badge-crm` 蓝紫色）
- **改进** CSV 导出增加"来访时间"列
- **更新** 所有 colspan 9→10

### 全链路数据流

```
CRM list_user_visit.html
  → extractVisits() + 自动翻页
  → batchSyncVisits (name/mobile/kefu_tel/visit_type/visit_time)
  → Cloud Relay (/api/v1/visit) → mobile+visit_time 精确去重
  → SQLite INSERT (含 visit_time)
  → WebSocket push {type:'visit_record', data:{...}} → Android
  → Dashboard 查看/编辑/删除/导出
```

### 触发方式

| 入口 | 路径 |
|------|------|
| CRM 页面右键 | 🔁 一键同步上门数据 |
| 扩展图标右键 | 🔁 一键同步上门数据 |
| Popup 按钮 | 同步登记列表 |

---

## 2026-07-20

### 管理面板重大升级 (v4.10) + P0/P1 缺陷修复

**cloud_relay_v2.py** (1736→1989行)
- 新增 6 个管理 API 端点：
  - `GET /api/v1/devices` — 已注册设备清单（含在线状态标注）
  - `GET /api/v1/calls?device_id=&pin=&date_from=&date_to=&number=&limit=&offset=` — 通话记录查询+分页
  - `GET /api/v1/kick?pin=&role=` — 踢出在线客户端
  - `GET /api/v1/phone-stats?device_id=` — 每日对账数据（服务端 vs 手机端，OK/MISMATCH）
  - `GET /api/v1/events?device_id=&event_type=&limit=` — 手机行为事件日志
  - `GET /api/history` — 连接数历史（供仪表盘趋势图）
- `/api/stats` 扩展：新增 `by_type`（消息类型分布）和 `by_pin`（按PIN统计）字段
- `/api/logs` 扩展：支持 `?n=N` 行数和 `?q=关键词` 搜索
- 新增连接数历史追踪系统：每30秒快照，环形数组保留24小时(2880点)
- 新增 `cleanup_memory()` 定期清理机制（每10分钟）：message_count_by_pin(Top200)、last_ext_activity(1h过期)、pending_visits(上限100)、last_dial(10min过期)、daily_stats(90天)、_pin_attempts过期条目
- **P0修复**：`/api/v1/calls/batch`、`/api/v1/events/log`、`/api/v1/stats/report` 三个端点补全 `try/finally` 确保数据库连接释放
- **P1修复**：`save_stats()`/`load_stats()` 失败增加日志输出；CRM同步更新失败记日志

**dashboard.html** (817→864行，完全重写)
- 新增 3 个 Tab 页：📞 通话记录、📱 设备管理、📊 对账面板
- 仪表盘增强：6个统计卡片（含在线PC/手机计数）+ 连接趋势折线图 + 消息类型饼图
- 客户端管理：踢出功能真正实现（不再弹"暂未实现"）+ 角色筛选 + 设备名搜索
- 通话记录：日期/设备/号码筛选 + 分页 + CSV导出
- 设备管理：在线状态(绿/灰点) + 手机型号/版本 + 首次/最后在线
- 对账面板：OK/MISMATCH 高亮标记
- 日志增强：关键词搜索 + 行数选择(100/200/500/1000)
- 流量统计：新增消息类型饼图 + 按PIN柱状图(Top10)
- UI 现代化：卡片阴影/渐变动画/响应式布局/自动刷新15秒

**pc-app-Electron/modules/cloud.js** (481→484行)
- **P0修复**：error 事件不再提前设置 `_cleanedUp = true`，改用 `_errorHandled` 标记
- close 事件中检查 `_errorHandled`，跳过重复UI清理但仍触发自动重连
- 修复了"error先于close触发时自动重连永不执行"的bug

## 2026-07-19

### 手机端云中转数据同步系统（新功能）
**cloud_relay_v2.py**
- 新建 4 张数据库表：
  - `phones` — 设备注册（device_id, label, last_pin, model, version, first_seen, last_seen）
  - `call_records_raw` — 原始通话记录（device_id+local_id 联合主键，幂等去重）
  - `phone_events` — 行为事件日志
  - `phone_daily_stats` — 每日统计 + 服务器重算对账（match_status: OK/MISMATCH）
- 新增 3 个 REST API 端点：
  - `GET /api/v1/calls/batch?device_id=&pin=&data=` — 增量通话记录批量上传
  - `GET /api/v1/events/log?device_id=&event_type=&pin=&detail=` — 行为事件记录
  - `GET /api/v1/stats/report?device_id=&pin=&count=&duration=&connected=` — 每日统计快照（服务器从 raw 重算并对比）
- 新增 `today_start_ms()` / `today_end_ms()` 时间工具函数

**PrefCtrl.kt**
- `getDeviceId()` — 首次调用自动生成 UUID 并持久化到 SharedPreferences

**DialService.kt**
- `startDataSync()` — 启动定时同步，首次立即触发，之后每 5 分钟
- `syncCallRecords()` — 从系统 CallLog 增量查询（`_id > last_synced_id`），批量 50 条，通过 GET 上传
- `syncDailyStats()` — 上传今日财运/通时/接通数快照
- `logEvent(eventType, detail)` — 异步记录行为事件到服务器
- `normalizeHttpUrl()` — ws:// 转 http:// 工具方法
- `onDestroy()` 新增清理定时任务和线程池

### 云服务器管理优化
**CloudCtrl.kt**
- `testServer()` 重写：从 HTTP GET 改为 WebSocket 全链路认证测试（发 auth → 收 auth_fail 即成功）
- `resetToDefault()` — 清除已保存服务器列表，回退到代码内置默认
- `getTodayConnectedCount()` — 查询今日接通次数（呼出且 duration > 0）
- `getConnectedCountSince()` — 按时间段查询接通次数
- `DayStats` 新增 `connectedCount` 字段，`getDailyDurationStats()` 中统计
- 默认服务器别名设为 `融鑫汇腾讯云专线`
- 修复：`resume()` 需要 `onCancellation` 空 lambda，补 `java.net.URL` import

**CloudServerSheet.kt**
- 删除按钮增加二次确认弹窗
- `PC 同步` 改为 `恢复默认`（清除列表，回退到代码内置默认）
- `测速` 改为 `测试`，全部测速改为 `全部测试`
- 添加对话框：新增格式说明（`IP或域名:端口，无需加 ws://`）+ 示例 + 别名字段
- 按钮 `别名` → `点击修改别名`
- 未连接状态：🟡 → 🔴，颜色 `primaryLight` → `red`
- 测试点击反馈：Toast + 测后显示 ✅ 可达 / ❌ 不可达（Line 4）
- 网络获取：先 GitHub Gist 后 Gitee 备选，`distinctBy { url }` 去重

### 设置页优化
**ConnectFragment.kt**
- 设置页顶栏显示当前云服务器别名（连上断开都显示）
- 服务器别名 `<TextView>` 插入 `disconnectBtn` 前，`updateConnectionUI` 中更新
- `rebuildV3ConnectionHeader` 未调用问题修复
- `上次通话提示` 时长选项：5s/10s/30s/一直 → 2s/3s/5s/8s
- 修复：`colors` 和 `Gravity` 作用域问题

**DialService.kt — 同 PIN 挤下线修复**
- `ConnectionManager.onClosed(code=4001)` 新增 `notifyError(Disconnected("kicked"))`
- `lastDisconnectReason` 变量防止 `onStateChanged(DISCONNECTED)` 用 "disconnected" 覆盖 "kicked"
- `notifyConnectionChange()` 自动记录最后断连原因

**DialService.kt — 通知栏**
- 标题：`跨屏拨号` → `Auto融鑫汇`
- 内容简化为 `已连接`，追加今日数据：`今日财运：+12 接通6 · 67%`
- 连接状态文字：`已连接到电脑(cloud)` → `已连接`
- 初始状态文字：`跨屏拨号 运行中` → `运行中`

### 统计页优化
**StatsFragment.kt**
- 计数卡片（今日/一周/本月财运）：数字+单位合并一行，底部新增接通率副行
- 通时卡片保留独立单位行（左右卡片等高）
- 一周/本月标题可点击弹出每日明细弹窗（整张卡片可点）
- 明细弹窗：`BottomSheetDialog` 全宽，`NestedScrollView` 400dp，列名小标题，日期近→远
- `showVisitDetail` 弹窗同样改造：`NestedScrollView` + `isDraggable = false`
- 弹窗 `window.setLayout(MATCH_PARENT, WRAP_CONTENT)`，从底部自然滑出

**fragment_stats.xml**
- `statsTodayCount` → `0次`，`statsTotalCount` → `0次`，`statsTodayLuck` → `0次`
- `statsTodayDuration`/`statsTotalDuration` 恢复独立 `分钟` 行
- 新增 `statsTodayConnect`/`statsWeekConnect`/`statsMonthConnect`
- 月度分隔线高度 60dp → 72dp
- 4 个标题加 ID：`statsWeekCallLabel`/`statsWeekDurationLabel`/`statsMonthCallLabel`/`statsMonthDurationLabel`
- 4 个卡片容器加 ID 和 `clickable="true"`
- 修复 Kotlin 三元运算符（`?:` → `if-else`）

### 通话记录页优化
**CallLogFragment.kt**
- 卡1 SIM 标签颜色：`colors.text2` → `colors.text`（与号码颜色一致）
- 已接通话右侧：呼出/呼入 + 时长（如 `呼出3m15s`）
- 今日财运数字前加 `+` 号
- 连接状态文字：`未连接电脑` → `未连接`
- 重连 Pin 检查：`== 4` → `>= 4`（兼容 6 位 Pin）
- `connectionStatusBar` 发送广播方式改为 `LocalBroadcastManager`

**item_call_log.xml**
- 主题色占位改动（来自 07-18 的全局清理）

**DialPadSheet.kt**
- 删除按钮移至输入框右侧
- 禁止系统输入法弹出：`showSoftInputOnFocus = false`

**dialFab** → 52dp → 42dp

### 扩展端改动
**AutoDial-Extension/content-script.js**
- 去掉主管限制：移除 `checkIsAdmin` 检查，任何人可同步
- `handleSyncVisitList` 结构扁平化

### 云中转改动
**cloud_relay_v2.py**
- `POST /api/v1/visit` 新增去重：同一手机号当天已有记录返回 `{skipped: true}`
- 所有 API 改为 GET + query params（websockets process_request 仅支持 path+headers）

### 应用信息
- 应用名称：`A跨屏拨号` → `Auto融鑫汇`
- 通知 channel：`Auto融鑫汇通知`
- 无障碍服务描述：`Auto融鑫汇辅助服务`
- 无障碍服务声明已注释（华为禁用/小米需开启）

## 2026-07-18

### 主题色清理（91 处）
**所有 layout XML**
- 主题 tag 驱动的硬编码颜色统一替换为中性 `#888888`
- 改动文件：`activity_main.xml` / `fragment_call_log.xml` / `fragment_connect.xml` / `fragment_register.xml` / `fragment_stats.xml` / `item_call_log.xml`

### 华为设备兼容
**MainActivity.kt**
- 权限请求延迟 800ms（避免华为吞掉系统对话框）
- 悬浮窗权限双层保障：直接跳转 + 1500ms 后弹 AlertDialog 引导

**AndroidManifest.xml**
- 无障碍服务声明已注释（华为暂时关闭，小米需要时手动取消注释即可）

### 弹窗滚动修复
**StatsFragment.kt**
- `ScrollView` → `NestedScrollView`（配合 BottomSheet 避免下滑直接关闭弹窗）
- `dialog.behavior.isDraggable = false` 禁止下滑关闭

### 筛选芯片行优化
**fragment_call_log.xml + CallLogFragment.kt**
- 筛选芯片行右侧增加今日接通数和接通率显示
- 数据随通话列表刷新自动更新（ContentObserver 监听）

### 拨号盘图标
**ic_dialpad.xml + fragment_call_log.xml**
- FAB 按钮 52dp → 42dp
- 九宫格圆点间距调整（列距 7dp→5dp，行距 6dp→5dp），后恢复
