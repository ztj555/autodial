/**
 * AutoDial Popup v5.6
 * 整合版：设云中继地址 + 设 PIN（坐席手机号）+ 测试连接 + 切换主题
 *
 * v5.6：云中继地址的读写/格式化/探测全部收敛到 addr.js 的 AD_ADDR（与
 *       content-script 挂件、background 共用同一份实现），修复以下自相矛盾：
 *   · 原「测试」按钮会**顺带把地址写进 storage** —— 只想测一下，地址已被改。
 *     现在「测试」只测不存，「保存」才是唯一的写入动作。
 *   · 打开弹窗会**自动发两次请求**（/health 与 /api/v1/status），两处结论可能
 *     一个"已连接"一个"不可达"。现在只跑一次探针，两个面板共用结果。
 *   · 失败一律提示"无法连接"。现在按原因区分（超时/拒绝/HTTP/非本服务）。
 *   · 新增来源徽标（手动/自动/默认）与候选池展示。
 *   自动获取只更新候选池，**不自动切换**生效地址（生效地址只由「保存」决定）。
 *
 * v5.6.0：候选服务器改为「输入框内嵌下拉浮层」——
 *   · 原来候选池是 flex-wrap 的 pill 列表，5 个地址在 340px 弹窗里会折成 3 行、
 *     单独吃掉约 100px 高度（弹窗总高上限仅 600px）。
 *   · 现在收进输入框右侧的 ▾ 浮层（绝对定位覆盖下方内容，不撑高面板）；
 *     「从网络获取」并入浮层底部脚注，脚注同时显示候选个数与更新时间。
 *   · 云中继组高度约 172px → 约 70px。
 *   语义不变：选中候选只填入输入框，仍需点「保存」才生效。
 *
 * v5.6.1：状态区改为「云端 / PC / 手机」三行独立状态：
 *   · 大圆点与大标题**只反映云端连通性**（原实现取 pcConnected||phoneConnected，
 *     云端明明连通、只是设备离线也照样显示红点，与用户直觉相反）
 *   · 大标题由写死的「PIN 已就绪」改为动态结论（云端未连接 / 云端已连接 / 服务正常）
 *   · 颜色语义：绿 = 正常 · 灰 = 中性（设备离线、云端不通时未查询）· 红 = 仅云端故障
 *   · 云端不通时 PC/手机显示「未查询」而非「离线」，不误导
 *
 * v5.5.2：「清除 PIN」改为「修改 PIN」，且不再清空配对码：
 *   · 「修改 PIN」→ 进入设置页，配对码输入框保留当前值（可改后保存），并显示「返回」
 *   · 「返回」按钮位于设置面板**顶部**，点击 = 放弃本次修改（还原为已保存值）
 *   · 状态页「坐席手机号」行也可直接点击 → 等同点「修改 PIN」
 *
 * v5.5.1：回退 v5.5 引入的「面板状态单一出口（renderPanel）」改写，恢复原三 handler 写法。
 *   · 「修改服务器」→ 显示设置页、隐藏配对码输入框（保存按钮/状态行一并隐藏）、显示返回按钮
 *   · 「修改 PIN」  → 显示设置页，配对码保留原值，改完点保存
 *   · 「返回」      → 恢复配对码输入区并回到状态页
 * 与面板无关的两项 v5.5 改进**保留**：
 *   ① 状态副标题颜色走主题变量（.hero-sub.ok / .hero-sub.err），不再内联硬编码天空蓝值
 *   ② 底部常驻「外观」主题切换卡片
 */
document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const serverInput = $('serverInput');
  const serverStatus = $('serverStatus');
  const pinInput = $('pinInput');
  const pinStatus = $('pinStatus');
  const mgrNameInput = $('mgrNameInput');
  const mgrNameStatus = $('mgrNameStatus');

  // ─── 连接探针（v5.6：全弹窗只跑一次，两个面板共用结果） ──
  const PROBE_TTL = 30000;
  let probeCache = { key: '', result: null, at: 0 };

  async function runProbe(addr, force) {
    const key = AD_ADDR.fullUrl(addr);
    if (!force && probeCache.key === key && Date.now() - probeCache.at < PROBE_TTL) {
      return probeCache.result;
    }
    const r = await AD_ADDR.probe(addr);
    probeCache = { key: key, result: r, at: Date.now() };
    return r;
  }

  // ─── 三行独立连接状态渲染（v5.6.1） ────────────────
  //   rows: { cloud:{state,text}, pc:{...}, phone:{...} }
  //   state ∈ 'ok'（绿） | 'off'（中性灰） | 'err'（红，仅云端故障用）
  const CONN_ROWS = { cloud: 'connCloud', pc: 'connPc', phone: 'connPhone' };
  function renderConn(rows) {
    Object.keys(CONN_ROWS).forEach((k) => {
      const el = $(CONN_ROWS[k]);
      if (!el) return;
      const r = rows[k] || { state: 'off', text: '—' };
      el.className = 'conn-row ' + r.state;
      const v = el.querySelector('.conn-val');
      if (v) v.textContent = r.text;
    });
  }

  // 统一刷新：设置页状态行 + 状态页 Hero 大盘
  //   opts.hero   === false 时只更新设置页那一行（例如正在输入一个还没保存的地址）
  //   opts.prefix 非空时前缀到状态行（用于「已保存」这类一次性确认，避免被探针结果吞掉）
  //
  // v5.6.1 重写：大圆点与大标题**只反映云端连通性**。
  // 原实现里圆点取 `pcConnected || phoneConnected`，导致「云端已连通、但设备都离线」
  // 时显示红色，与用户直觉相反，也无法第一眼判断云端是否连上。
  async function refreshConnectivity(addr, pin, force, opts) {
    const heroToo = !opts || opts.hero !== false;
    const prefix = (opts && opts.prefix) || '';
    const r = await runProbe(addr, force);

    setServerStatus(prefix + AD_ADDR.probeMessage(r), r.ok ? 'ok' : 'err');

    if (!heroToo) return r;

    const tEl = $('statusText');
    const sEl = $('cloudStatus');
    const dot = $('statusDot');

    // ① 云端不通 —— 红色只在此处出现；PC/手机标「未查询」而不是「离线」，避免误判
    if (!r.ok) {
      tEl.textContent = '云端未连接';
      tEl.className = 'hero-title err';
      sEl.textContent = r.detail || '云中继不可达';
      sEl.className = 'hero-sub err';
      dot.className = 'status-dot offline';
      renderConn({
        cloud: { state: 'err', text: '连接失败' },
        pc:    { state: 'off', text: '未查询' },
        phone: { state: 'off', text: '未查询' }
      });
      return r;
    }

    // ② 云端已通 —— 先把云端行落定，再查业务态
    renderConn({ cloud: { state: 'ok', text: '已连接' } });

    const queryFailed = () => {
      tEl.textContent = '云端已连接';
      tEl.className = 'hero-title ok';
      sEl.textContent = '设备状态查询失败';
      sEl.className = 'hero-sub';
      dot.className = 'status-dot online';
      renderConn({
        cloud: { state: 'ok', text: '已连接' },
        pc:    { state: 'off', text: '未知' },
        phone: { state: 'off', text: '未知' }
      });
    };

    try {
      const d = await AD_ADDR.statusOf(addr, pin);
      if (d && d.ok) {
        const pcOn = !!d.pcConnected;
        const phOn = !!d.phoneConnected;
        renderConn({
          cloud: { state: 'ok', text: '已连接' },
          pc:    { state: pcOn ? 'ok' : 'off', text: pcOn ? '在线' : '离线' },
          phone: { state: phOn ? 'ok' : 'off', text: phOn ? '在线 ' + (d.phoneCount || 1) + ' 台' : '离线' }
        });
        const anyOnline = pcOn || phOn;
        tEl.textContent = anyOnline ? '服务正常' : '云端已连接';
        tEl.className = 'hero-title ok';
        sEl.textContent = '';   // 三行清单已说明一切，副标题留空（CSS :empty 不占行）
        sEl.className = 'hero-sub';
        dot.className = 'status-dot online';
      } else {
        queryFailed();
      }
    } catch (e) {
      queryFailed();
    }
    return r;
  }

  function setServerStatus(text, cls) {
    serverStatus.textContent = text;
    serverStatus.className = 'field-status ' + cls;
  }

  // ─── 来源徽标 / 候选下拉浮层（v5.6.0） ─────────────
  function renderSource(src) {
    $('serverSource').textContent = AD_ADDR.sourceLabel(src);
  }

  function relTime(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚更新';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前更新';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前更新';
    return Math.floor(d / 86400000) + ' 天前更新';
  }

  // 候选缓存（供浮层渲染与脚注计数复用）
  let poolItems = [];
  let poolAt = 0;

  function updateFetchLabel() {
    const btn = $('fetchPoolBtn');
    if (btn.disabled) return;            // 拉取中，别覆盖「获取中…」
    const n = poolItems.length;
    btn.textContent = n
      ? '从网络获取 · ' + n + ' 个' + (poolAt ? ' · ' + relTime(poolAt) : '')
      : '从网络获取';
  }

  function openAddrMenu() {
    $('addrMenu').hidden = false;
    $('addrCaretBtn').classList.add('open');
    $('addrCaretBtn').setAttribute('aria-expanded', 'true');
  }

  function closeAddrMenu() {
    $('addrMenu').hidden = true;
    $('addrCaretBtn').classList.remove('open');
    $('addrCaretBtn').setAttribute('aria-expanded', 'false');
  }

  function toggleAddrMenu() {
    if ($('addrMenu').hidden) openAddrMenu(); else closeAddrMenu();
  }

  // 渲染候选浮层。只填充 #addrMenuList，显隐交给 openAddrMenu/closeAddrMenu
  function renderPool(list, activeAddr, listAt) {
    poolItems = list || [];
    poolAt = listAt || 0;
    const box = $('addrMenuList');
    box.innerHTML = '';
    if (!poolItems.length) {
      const d = document.createElement('div');
      d.className = 'addr-empty';
      d.textContent = '暂无候选，点下方「从网络获取」';
      box.appendChild(d);
    } else {
      poolItems.forEach((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'addr-item' + (item === activeAddr ? ' active' : '');
        b.textContent = item;
        b.title = '点击填入上方输入框（需点「保存」才生效）';
        b.addEventListener('click', () => {
          serverInput.value = item;
          closeAddrMenu();
          setServerStatus('已填入，点击「保存」生效', '');
        });
        box.appendChild(b);
      });
    }
    $('addrCaretBtn').disabled = false;
    updateFetchLabel();
  }

  // 浮层开合：点 ▾ 切换；点别处或按 Esc 收起（点浮层内部不收起）
  $('addrCaretBtn').addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    toggleAddrMenu();
  });
  $('addrMenu').addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
  });
  document.addEventListener('click', () => { if (!$('addrMenu').hidden) closeAddrMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAddrMenu(); });

  // ─── 面板切换（v5.4 及以前的原实现） ────────────────
  function showSetup() {
    $('setupPanel').style.display = 'block';
    $('statusPanel').style.display = 'none';
    const hint = $('setupHint');
    if (hint) {
      chrome.storage.local.get(['self_phone'], (s) => {
        hint.textContent = s.self_phone
          ? '已检测到 ' + s.self_phone + '，点击保存即可'
          : '打开 CRM 页面，插件会自动检测坐席手机号作为 PIN';
      });
    }
  }

  async function showStatus(pin) {
    $('setupPanel').style.display = 'none';
    $('statusPanel').style.display = 'block';
    $('backToStatusBtn').style.display = 'none';
    $('myPhone').textContent = pin || '--';

    // v5.5.2：点「坐席手机号」行 = 修改 PIN（与「接待顾问」「云端地址」两行的交互对齐，
    // 三个入口都改成 click() 复用已有 handler，避免再出现"某条路径少改一段 DOM"）
    $('myPhone').onclick = () => { $('editPinBtn').click(); };

    // 接待顾问姓名（优先自动检测）
    chrome.storage.local.get(['manager_name'], (s) => {
      $('myMgrName').textContent = s.manager_name || '未检测到（可在下方设置）';
      $('myMgrName').onclick = () => {
        $('editServerBtn').click();
        setTimeout(() => mgrNameInput.focus(), 100);
      };
      if (s.manager_name) mgrNameInput.value = s.manager_name;
    });

    // v5.6：生效地址 + 来源，均来自 addr.js 的统一读取
    const a = await AD_ADDR.readActive();
    $('cloudAddr').textContent = AD_ADDR.cleanAddr(a.addr) + ' · ' + AD_ADDR.sourceLabel(a.source);
    $('cloudAddr').onclick = () => { $('editServerBtn').click(); };
    renderSource(a.source);

    refreshConnectivity(a.addr, pin, false, { hero: true });
  }

  // ─── 运行时授权（v6.4）────────────────────────────
  // 内置地址池已在 manifest 静态声明；用户自填的其它主机必须在「用户手势内」调用
  // chrome.permissions.request 取得授权。因此这些 handler 在调用 request 之前
  // 不能出现 await —— 一旦跨过 await，手势失效，浏览器会直接拒绝弹授权框。
  function ensureOrigin(addr, onGranted, onDenied) {
    const need = AD_ADDR.grantNeeded(addr);
    if (!need) { onGranted(); return; }
    try {
      chrome.permissions.request({ origins: [need] }, (granted) => {
        if (granted) onGranted();
        else onDenied(need);
      });
    } catch (e) {
      onDenied(need);
    }
  }

  // ─── 测试服务器连接（v5.6：只测试，绝不写 storage） ──
  $('testServerBtn').addEventListener('click', () => {
    const v = serverInput.value.trim();
    if (!v) { setServerStatus('请输入地址', 'err'); return; }
    ensureOrigin(v,
      () => {
        setServerStatus('测试中…', '');
        refreshConnectivity(v, pinInput.value.trim(), true, { hero: true });
      },
      (origin) => setServerStatus('✗ 未授权访问 ' + origin + '，无法测试', 'err'));
  });

  // ─── 保存云中继地址（v5.6：唯一的写入动作） ──────────
  async function doSaveServer(v) {
    const saved = await AD_ADDR.setManual(v);
    serverInput.value = AD_ADDR.cleanAddr(saved.addr);
    renderSource('manual');
    const a = await AD_ADDR.readActive();
    renderPool(a.list, a.addr, a.listAt);
    // 「已保存」作为前缀保留下来，随探针结果一起显示 —— 否则会被连接结果直接覆盖，
    // 用户看不到"到底存没存上"
    refreshConnectivity(saved.addr, pinInput.value.trim(), true, { hero: true, prefix: '✓ 已保存（手动） · ' });
  }

  $('saveServerBtn').addEventListener('click', () => {
    const v = serverInput.value.trim();
    if (!v) { setServerStatus('请输入地址', 'err'); return; }
    ensureOrigin(v,
      () => { doSaveServer(v).catch((e) => setServerStatus('保存失败：' + (e && e.message ? e.message : e), 'err')); },
      (origin) => setServerStatus('✗ 未授权访问 ' + origin + '，地址未保存', 'err'));
  });

  // ─── 从网络获取候选池（v5.6：不改动生效地址） ────────
  $('fetchPoolBtn').addEventListener('click', async () => {
    const btn = $('fetchPoolBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '获取中…';
    let ok = false;
    try {
      const list = await AD_ADDR.fetchList(8000);
      if (list.length) { await AD_ADDR.applyAuto(list); ok = true; }
    } catch (e) { ok = false; }
    const a = await AD_ADDR.readActive();
    if (ok) renderSource(a.source);
    renderPool(a.list, a.addr, a.listAt);
    btn.disabled = false;
    updateFetchLabel();                        // 复位后再写正式文案（个数 + 更新时间）
    if (ok) openAddrMenu(); else btn.textContent = '获取失败，点击重试';
  });

  // ─── 保存 PIN ─────────────────────────────────────
  $('savePinBtn').addEventListener('click', () => {
    const pin = pinInput.value.trim();
    if (!pin || !/^\d{4}$|^\d{11}$/.test(pin)) {
      pinStatus.textContent = '请输入4位或11位数字配对码';
      pinStatus.className = 'field-status err';
      return;
    }
    chrome.storage.local.set({ pin: pin, self_phone: pin }, () => {
      pinStatus.textContent = '✓ PIN 已保存';
      pinStatus.className = 'field-status ok';
      showStatus(pin);
      setTimeout(() => { pinStatus.textContent = ''; }, 1500);
    });
  });

  // 回车键保存 PIN
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('savePinBtn').click();
  });

  // ─── 保存接待顾问姓名 ──────────────────────────────
  $('saveMgrNameBtn').addEventListener('click', () => {
    const mgrName = mgrNameInput.value.trim();
    if (!mgrName) {
      mgrNameStatus.textContent = '请输入接待顾问姓名';
      mgrNameStatus.className = 'field-status err';
      return;
    }
    chrome.storage.local.set({ manager_name: mgrName }, () => {
      mgrNameStatus.textContent = '✓ 姓名已保存';
      mgrNameStatus.className = 'field-status ok';
      setTimeout(() => { mgrNameStatus.textContent = ''; }, 1500);
    });
  });

  // ─── 修改服务器（PIN 与姓名保持不动） ────────────────
  $('editServerBtn').addEventListener('click', () => {
    showSetup();
    pinInput.style.display = 'none';
    $('savePinBtn').style.display = 'none';
    pinStatus.style.display = 'none';
    $('backToStatusBtn').style.display = 'inline-block';
    // 保留姓名输入可见
    mgrNameInput.style.display = '';
    $('saveMgrNameBtn').style.display = '';
    mgrNameStatus.style.display = '';
  });

  // ─── 修改 PIN（保留当前配对码，不清空；改完点保存） ──
  $('editPinBtn').addEventListener('click', () => {
    showSetup();
    pinInput.style.display = '';
    $('savePinBtn').style.display = '';
    pinStatus.style.display = '';
    pinStatus.textContent = '';
    $('backToStatusBtn').style.display = 'inline-block';
    mgrNameInput.style.display = '';
    $('saveMgrNameBtn').style.display = '';
    mgrNameStatus.style.display = '';
    // 原值已填好，直接聚焦并全选，便于覆盖输入
    setTimeout(() => { pinInput.focus(); pinInput.select(); }, 60);
  });

  // ─── 返回状态面板（放弃本次修改） ───────────────────
  $('backToStatusBtn').addEventListener('click', () => {
    pinInput.style.display = '';
    $('savePinBtn').style.display = '';
    pinStatus.style.display = '';
    pinStatus.textContent = '';
    $('backToStatusBtn').style.display = 'none';
    mgrNameInput.style.display = '';
    $('saveMgrNameBtn').style.display = '';
    mgrNameStatus.style.display = '';
    chrome.storage.local.get(['pin', 'self_phone'], (s) => {
      const p = s.pin || s.self_phone || '';
      pinInput.value = p;   // 还原为已保存的值，丢弃未保存的输入
      showStatus(p);
    });
  });

  // ─── 外观（色相 × 明暗） ───────────────────────────
  // 与手机端 / PC 端 / dashboard 共用主题数据（themes.js 的 AD_THEMES = 唯一权威源）。
  // v6.0：色相与明暗拆成两个独立维度，分开存储 ——
  //   __ad_theme      → 色相 id（16 套，顺序见 AD_THEME_LIST）
  //   __ad_theme_mode → light 亮白 / dark 暗夜
  let currentTheme = AD_THEME_DEFAULT;
  let currentMode = AD_THEME_DEFAULT_MODE;

  function buildSwatches() {
    const box = $('swatches');
    if (!box || typeof AD_THEMES === 'undefined') return;
    box.innerHTML = AD_THEME_LIST.filter(id => AD_THEMES[id]).map(id => {
      const t = AD_THEMES[id];
      // 色块预览固定用亮档配色：色块表达的是"色相"，明暗由右侧开关单独表达
      const m = t.modes.light;
      return '<button type="button" class="swatch-btn" data-theme="' + id +
             '" title="' + t.name + '" aria-label="' + t.name +
             '" style="background:linear-gradient(135deg,' + m.accentLight + ',' + m.accentDark + ')"></button>';
    }).join('');
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.swatch-btn');
      if (btn) pickTheme(btn.dataset.theme);
    });
  }

  function buildModeToggle() {
    const box = $('modeToggle');
    if (!box) return;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.mode-btn');
      if (btn) pickMode(btn.dataset.mode);
    });
  }

  function markSwatch(id) {
    currentTheme = AD_HAS_THEME(id) ? id : AD_THEME_DEFAULT;
    const box = $('swatches');
    if (box) {
      box.querySelectorAll('.swatch-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.theme === currentTheme);
      });
    }
    renderThemeName();
  }

  function markMode(mode) {
    currentMode = AD_NORM_MODE(mode);
    const box = $('modeToggle');
    if (box) {
      box.querySelectorAll('.mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === currentMode);
      });
    }
    renderThemeName();
  }

  function renderThemeName() {
    const nameEl = $('themeName');
    if (nameEl && typeof AD_THEMES !== 'undefined' && AD_THEMES[currentTheme]) {
      nameEl.textContent = AD_THEMES[currentTheme].name + ' · ' + AD_THEME_MODE_LABEL[currentMode];
    }
  }

  function pickTheme(id) {
    if (typeof AD_APPLY_THEME !== 'function' || !AD_HAS_THEME(id)) return;
    AD_APPLY_THEME(id, currentMode);   // 弹窗自身立即换肤
    markSwatch(id);
    // 写入权威存储：下次打开弹窗由 theme-init.js 读取；
    // 已打开的 CRM 页面由 content-script 的 chrome.storage.onChanged 监听到，悬浮挂件实时跟随
    chrome.storage.local.set({ __ad_theme: id });
  }

  function pickMode(mode) {
    const mk = AD_NORM_MODE(mode);
    if (mk === currentMode) return;
    AD_APPLY_THEME(currentTheme, mk);
    markMode(mk);
    chrome.storage.local.set({ __ad_theme_mode: mk });
  }

  // ─── 顶栏刷新：重读存储 + 强制重查（v6.0） ───────────
  //   ① 只用现成函数：AD_APPLY_THEME 幂等、refreshConnectivity 支持 force 绕缓存，
  //      不新增任何网络调用（候选池的「从网络获取」仍是独立按钮，刷新不碰它）；
  //   ② 主题 / PIN / 地址一律**重新从 storage 读**——若沿用内存里的 currentTheme，
  //      在别的入口（右键菜单、另一弹窗、dashboard）改过主题后点刷新会刷不出来；
  //   ③ 刷新期间禁用按钮 + 转圈，避免连点让多个探针并发在飞。
  let refreshing = false;
  async function doRefresh(btn) {
    if (refreshing) return;
    refreshing = true;
    if (btn) { btn.disabled = true; btn.classList.add('spin'); }
    try {
      const s = await new Promise((res) => chrome.storage.local.get(
        ['pin', 'self_phone', 'manager_name', '__ad_theme', '__ad_theme_mode'], res));

      // ① 主题：重落 CSS 变量 + 重标记色块/明暗开关/名称
      const th = AD_HAS_THEME(s.__ad_theme) ? s.__ad_theme : AD_THEME_DEFAULT;
      const mk = AD_NORM_MODE(s.__ad_theme_mode);
      AD_APPLY_THEME(th, mk);
      markSwatch(th);
      markMode(mk);

      // ② 地址 / 来源 / 候选池（读权威源，顺手同步状态页那一行）
      const a = await AD_ADDR.readActive();
      serverInput.value = AD_ADDR.cleanAddr(a.addr);
      renderSource(a.source);
      renderPool(a.list, a.addr, a.listAt);
      const addrEl = $('cloudAddr');
      if (addrEl) addrEl.textContent = AD_ADDR.cleanAddr(a.addr) + ' · ' + AD_ADDR.sourceLabel(a.source);
      if (s.manager_name) {
        mgrNameInput.value = s.manager_name;
        const m = $('myMgrName');
        if (m) m.textContent = s.manager_name;
      }

      // ③ 连接状态：force=true 绕过探针缓存；没 PIN 时状态页不显示，只刷设置页那一行
      const pin = s.pin || s.self_phone || '';
      await refreshConnectivity(a.addr, pin, true, { hero: !!pin });
    } catch (e) {
      setServerStatus('刷新失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      refreshing = false;
      if (btn) { btn.disabled = false; btn.classList.remove('spin'); }
    }
  }
  $('refreshBtn').addEventListener('click', () => doRefresh($('refreshBtn')));

  // ─── 初始化 ───────────────────────────────────────
  buildSwatches();
  buildModeToggle();

  chrome.storage.local.get(['self_phone', 'pin', 'manager_name', '__ad_theme', '__ad_theme_mode'], async (s) => {
    if (s.manager_name) mgrNameInput.value = s.manager_name;
    markMode(AD_NORM_MODE(s.__ad_theme_mode));
    markSwatch(s.__ad_theme);

    // v5.6：生效地址 / 来源 / 候选池 统一由 addr.js 提供
    const a = await AD_ADDR.readActive();
    serverInput.value = AD_ADDR.cleanAddr(a.addr);
    renderSource(a.source);
    renderPool(a.list, a.addr, a.listAt);

    const p = s.pin || s.self_phone;
    if (p) {
      pinInput.value = p;
      showStatus(p);
    } else {
      showSetup();
      // 未设 PIN 时状态页不显示，只更新设置页那一行，避免多打一次请求
      refreshConnectivity(a.addr, '', false, { hero: false });
    }
  });
});
