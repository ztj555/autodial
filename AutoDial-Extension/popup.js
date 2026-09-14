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
 * v5.6.1：候选服务器改为「输入框内嵌下拉浮层」——
 *   · 原来候选池是 flex-wrap 的 pill 列表，5 个地址在 340px 弹窗里会折成 3 行、
 *     单独吃掉约 100px 高度（弹窗总高上限仅 600px）。
 *   · 现在收进输入框右侧的 ▾ 浮层（绝对定位覆盖下方内容，不撑高面板）；
 *     「从网络获取」并入浮层底部脚注，脚注同时显示候选个数与更新时间。
 *   · 云中继组高度约 172px → 约 70px。
 *   语义不变：选中候选只填入输入框，仍需点「保存」才生效。
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

  // 统一刷新：设置页状态行 + 状态页 Hero 大盘
  //   opts.hero   === false 时只更新设置页那一行（例如正在输入一个还没保存的地址）
  //   opts.prefix 非空时前缀到状态行（用于「已保存」这类一次性确认，避免被探针结果吞掉）
  async function refreshConnectivity(addr, pin, force, opts) {
    const heroToo = !opts || opts.hero !== false;
    const prefix = (opts && opts.prefix) || '';
    const r = await runProbe(addr, force);

    setServerStatus(prefix + AD_ADDR.probeMessage(r), r.ok ? 'ok' : 'err');

    if (!heroToo) return r;

    const el = $('cloudStatus');
    if (!r.ok) {
      el.textContent = '○ ' + (r.detail || '云中继不可达');
      el.className = 'hero-sub err';
      $('statusDot').className = 'status-dot offline';
      return r;
    }
    // 探通了才查业务态（PC/手机在线），避免两处结论打架
    el.textContent = '● 云中继已连接，查询设备…';
    el.className = 'hero-sub';
    try {
      const d = await AD_ADDR.statusOf(addr, pin);
      if (d && d.ok) {
        const pcStr = d.pcConnected ? 'PC在线' : 'PC离线';
        const phStr = d.phoneConnected ? '手机在线(' + (d.phoneCount || 0) + ')' : '手机离线';
        const online = !!(d.pcConnected || d.phoneConnected);
        el.textContent = '● ' + pcStr + ' | ' + phStr;
        // v5.5：颜色改由主题 CSS 变量驱动（原为内联硬编码 #40C057/#5880A8/#F03E3E）
        el.className = 'hero-sub' + (online ? ' ok' : '');
        $('statusDot').className = 'status-dot ' + (online ? 'online' : 'offline');
      } else {
        el.textContent = '○ 无法获取设备状态';
        el.className = 'hero-sub err';
      }
    } catch (e) {
      el.textContent = '○ 云中继已连接，但状态查询失败';
      el.className = 'hero-sub err';
    }
    return r;
  }

  function setServerStatus(text, cls) {
    serverStatus.textContent = text;
    serverStatus.className = 'field-status ' + cls;
  }

  // ─── 来源徽标 / 候选下拉浮层（v5.6.1） ─────────────
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

  // ─── 测试服务器连接（v5.6：只测试，绝不写 storage） ──
  $('testServerBtn').addEventListener('click', () => {
    const v = serverInput.value.trim();
    if (!v) { setServerStatus('请输入地址', 'err'); return; }
    setServerStatus('测试中…', '');
    refreshConnectivity(v, pinInput.value.trim(), true, { hero: true });
  });

  // ─── 保存云中继地址（v5.6：唯一的写入动作） ──────────
  $('saveServerBtn').addEventListener('click', async () => {
    const v = serverInput.value.trim();
    if (!v) { setServerStatus('请输入地址', 'err'); return; }
    const saved = await AD_ADDR.setManual(v);
    serverInput.value = AD_ADDR.cleanAddr(saved.addr);
    renderSource('manual');
    const a = await AD_ADDR.readActive();
    renderPool(a.list, a.addr, a.listAt);
    // 「已保存」作为前缀保留下来，随探针结果一起显示 —— 否则会被连接结果直接覆盖，
    // 用户看不到"到底存没存上"
    refreshConnectivity(saved.addr, pinInput.value.trim(), true, { hero: true, prefix: '✓ 已保存（手动） · ' });
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

  // ─── 外观（主题切换） ──────────────────────────────
  // 与手机端/PC 端/dashboard 共用主题数据（themes.js 的 AD_THEMES = 唯一权威源）
  const THEME_ORDER = ['sky-blue', 'dark-gold', 'cyber-frost', 'deep-space', 'cyberpunk',
                       'minimalist', 'forest-green', 'energetic-orange', 'ocean-blue'];
  let currentTheme = 'sky-blue';

  function buildSwatches() {
    const box = $('swatches');
    if (!box || typeof AD_THEMES === 'undefined') return;
    box.innerHTML = THEME_ORDER.filter(id => AD_THEMES[id]).map(id => {
      const t = AD_THEMES[id];
      return '<button type="button" class="swatch-btn" data-theme="' + id +
             '" title="' + t.name + '" aria-label="' + t.name +
             '" style="background:linear-gradient(135deg,' + t.accentLight + ',' + t.accentDark + ')"></button>';
    }).join('');
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.swatch-btn');
      if (btn) pickTheme(btn.dataset.theme);
    });
  }

  function markSwatch(id) {
    currentTheme = id;
    const box = $('swatches');
    if (box) {
      box.querySelectorAll('.swatch-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.theme === id);
      });
    }
    const nameEl = $('themeName');
    if (nameEl && typeof AD_THEMES !== 'undefined' && AD_THEMES[id]) nameEl.textContent = AD_THEMES[id].name;
  }

  function pickTheme(id) {
    if (typeof AD_APPLY_THEME !== 'function' || typeof AD_THEMES === 'undefined' || !AD_THEMES[id]) return;
    AD_APPLY_THEME(id);   // 弹窗自身立即换肤
    markSwatch(id);
    // 写入权威存储：下次打开弹窗由 theme-init.js 读取；
    // 已打开的 CRM 页面由 content-script 的 chrome.storage.onChanged 监听到，悬浮挂件实时跟随
    chrome.storage.local.set({ __ad_theme: id });
  }

  // ─── 初始化 ───────────────────────────────────────
  buildSwatches();

  chrome.storage.local.get(['self_phone', 'pin', 'manager_name', '__ad_theme'], async (s) => {
    if (s.manager_name) mgrNameInput.value = s.manager_name;
    markSwatch(s.__ad_theme && AD_THEMES[s.__ad_theme] ? s.__ad_theme : 'sky-blue');

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
