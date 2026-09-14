/**
 * AutoDial Popup v5.5.2
 * 整合版：设云中继地址 + 设 PIN（坐席手机号）+ 测试连接 + 切换主题
 * 服务器地址统一为纯 IP:PORT 格式（自动补全 http://）
 *
 * v5.5.2：「清除 PIN」改为「修改 PIN」，且**不再清空配对码**：
 *   · 「修改 PIN」→ 进入设置页，配对码输入框保留当前值（可改后保存），并显示「返回」
 *   · 补上「返回」按钮：此前只有「修改服务器」会显示返回按钮，
 *     从「清除 PIN」进来后没有任何回路，回不到状态页
 *   · 点「返回」= 放弃本次修改：配对码输入框还原为已保存的值
 *   · 「返回」按钮位于设置面板**顶部**（`#setupPanel` 开标签之后），原先在面板最底部
 *   · 状态页「坐席手机号」行也可直接点击 → 等同点「修改 PIN」（与「接待顾问」「云端地址」两行一致）
 *
 * v5.5.1：回退 v5.5 引入的「面板状态单一出口（renderPanel）」改写，恢复原三 handler 写法：
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

  const DEFAULT_ADDR = '101.34.65.254:35430';

  // ─── 地址工具 ──────────────────────────────────────
  // 提取纯地址用于显示（去掉 http:// ws:// 等协议前缀，https:// 保留）
  function cleanAddr(addr) {
    addr = (addr || '').trim();
    if (/^https:\/\//i.test(addr)) return addr;
    return addr.replace(/^(https?|wss?):\/\//i, '');
  }
  // 补全协议前缀，返回完整 URL
  function fullUrl(addr) {
    if (!addr) return '';
    addr = addr.trim();
    if (/^https?:\/\//i.test(addr)) return addr;
    return 'http://' + addr;
  }
  // 当前生效的云中继地址（手动设置优先，其次自动获取）
  function storedAddr(s) {
    return cleanAddr(s.cloud_api) ||
           (s.cloud_apis_fetched && s.cloud_apis_fetched[0] ? s.cloud_apis_fetched[0] : DEFAULT_ADDR);
  }

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

  function showStatus(pin) {
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

    // 显示当前云端地址（手动设置优先，其次自动获取）
    chrome.storage.local.get(['cloud_api', 'cloud_apis_fetched'], (s) => {
      const auto = s.cloud_apis_fetched && s.cloud_apis_fetched[0];
      $('cloudAddr').textContent = cleanAddr(s.cloud_api) || (auto ? auto + ' [自动]' : DEFAULT_ADDR);
      $('cloudAddr').onclick = () => { $('editServerBtn').click(); };
    });

    // 异步检查云端 API 状态
    chrome.storage.local.get(['cloud_api', 'cloud_apis_fetched'], (s) => {
      const el = $('cloudStatus');
      fetch(`${fullUrl(storedAddr(s))}/api/v1/status`, {
        headers: { 'X-AutoDial-PIN': pin || '' },
        signal: AbortSignal.timeout(8000)
      }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }).then(d => {
        if (d.ok) {
          const pcStr = d.pcConnected ? 'PC在线' : 'PC离线';
          const phStr = d.phoneConnected ? '手机在线(' + (d.phoneCount || 0) + ')' : '手机离线';
          const online = !!(d.pcConnected || d.phoneConnected);
          el.textContent = '● ' + pcStr + ' | ' + phStr;
          // v5.5：颜色改由主题 CSS 变量驱动（原为内联硬编码 #40C057/#5880A8/#F03E3E）
          el.className = 'hero-sub' + (online ? ' ok' : '');
          $('statusDot').className = 'status-dot ' + (online ? 'online' : 'offline');
        } else {
          el.textContent = '○ 无法获取状态';
          el.className = 'hero-sub err';
        }
      }).catch(() => {
        el.textContent = '○ 云中继不可达';
        el.className = 'hero-sub err';
      });
    });
  }

  // ─── 测试服务器连接 ────────────────────────────────
  async function testServer(addr) {
    if (!addr) { setServerStatus('请输入地址', 'err'); return; }
    setServerStatus('测试中...', '');
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${addr}/health`, { signal: ctrl.signal });
      const d = await res.json();
      if (d.service) {
        setServerStatus('✓ 已连接 (' + d.service + ' v' + (d.version || '') + ')', 'ok');
      } else {
        setServerStatus('✗ 服务器异常', 'err');
      }
    } catch (e) {
      setServerStatus('✗ 无法连接', 'err');
    }
  }
  function setServerStatus(text, cls) {
    serverStatus.textContent = text;
    serverStatus.className = 'field-status ' + cls;
  }

  $('testServerBtn').addEventListener('click', () => {
    const cleaned = cleanAddr(serverInput.value);
    if (!cleaned) { setServerStatus('请输入地址', 'err'); return; }
    // 保存纯 IP:PORT 格式
    chrome.storage.local.set({ cloud_api: cleaned });
    serverInput.value = cleaned;
    testServer(fullUrl(cleaned));
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

  chrome.storage.local.get(['cloud_api', 'cloud_apis_fetched', 'self_phone', 'pin', 'manager_name', '__ad_theme'], (s) => {
    serverInput.value = storedAddr(s);
    if (s.manager_name) mgrNameInput.value = s.manager_name;
    markSwatch(s.__ad_theme && AD_THEMES[s.__ad_theme] ? s.__ad_theme : 'sky-blue');

    const p = s.pin || s.self_phone;
    if (p) {
      pinInput.value = p;
      showStatus(p);
    } else {
      showSetup();
    }
    testServer(fullUrl(serverInput.value));
  });
});
