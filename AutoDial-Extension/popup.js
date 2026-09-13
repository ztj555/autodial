/**
 * AutoDial Popup v5.5
 * 整合版：设云中继地址 + 设 PIN（坐席手机号）+ 测试连接 + 切换主题
 * 服务器地址统一为纯 IP:PORT 格式（自动补全 http://）
 *
 * v5.5 修的两处：
 *  1) 状态副标题的颜色原先内联硬编码为天空蓝值（#40C057/#5880A8/#F03E3E），
 *     换任何主题都不跟随 → 现在一律走主题 CSS 变量（.hero-sub.ok / .hero-sub.err）。
 *  2) 「修改服务器」与「清除 PIN」原先由三个 handler 各改一半 DOM 的 display，
 *     两个入口看起来几乎一样、且清除后出不来 → 现在统一由 renderPanel(mode) 决定。
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

  // ─── 面板状态机（v5.5 唯一出口） ────────────────────
  // 'status' 状态页
  // 'setup'  设置页·完整（含配对码）—— 首次未设 PIN / 刚清掉 PIN
  // 'server' 设置页·仅云中继与姓名（隐藏配对码整组，带返回按钮）
  const SHOW_PIN_GROUP = { status: false, setup: true, server: false };
  function renderPanel(mode, focusEl) {
    const isStatus = mode === 'status';
    $('statusPanel').style.display = isStatus ? 'block' : 'none';
    $('setupPanel').style.display  = isStatus ? 'none'  : 'block';
    // 配对码整组（含其上分割线）一起显隐 —— 只隐藏输入框会残留一个空标题
    $('pinGroup').style.display = SHOW_PIN_GROUP[mode] ? '' : 'none';
    // 顶部提示语是讲 PIN 自动检测的，「仅服务器」模式下显示会误导 → 一并隐藏
    $('setupHintCard').style.display = (mode === 'server') ? 'none' : '';
    // 返回按钮只在「仅服务器」模式出现：此时状态页仍可用，返回才有意义
    $('backToStatusBtn').style.display = (!isStatus && mode !== 'setup') ? 'inline-block' : 'none';
    if (focusEl) setTimeout(() => { try { focusEl.focus(); focusEl.select(); } catch (_) {} }, 60);
  }

  function refreshSetupHint() {
    const hint = $('setupHint');
    if (!hint) return;
    chrome.storage.local.get(['self_phone'], (s) => {
      hint.textContent = s.self_phone
        ? '已检测到 ' + s.self_phone + '，点击保存即可'
        : '打开 CRM 页面，插件会自动检测坐席手机号作为 PIN';
    });
  }

  // ─── 状态页 ───────────────────────────────────────
  function showStatus(pin) {
    renderPanel('status');
    $('myPhone').textContent = pin || '--';

    // 接待顾问姓名（优先自动检测）
    chrome.storage.local.get(['manager_name'], (s) => {
      $('myMgrName').textContent = s.manager_name || '未检测到（可在下方设置）';
      if (s.manager_name) mgrNameInput.value = s.manager_name;
    });

    // 显示当前云端地址（手动设置优先，其次自动获取）
    chrome.storage.local.get(['cloud_api', 'cloud_apis_fetched'], (s) => {
      const auto = s.cloud_apis_fetched && s.cloud_apis_fetched[0];
      $('cloudAddr').textContent = cleanAddr(s.cloud_api) || (auto ? auto + ' [自动]' : DEFAULT_ADDR);
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

  // ─── 云端地址 / 姓名 行 → 打开「仅服务器」设置 ───────
  $('myMgrName').onclick = () => renderPanel('server', mgrNameInput);
  $('cloudAddr').onclick = () => renderPanel('server', serverInput);

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
    renderPanel('server', serverInput);
  });

  // ─── 返回状态面板（不改 PIN） ───────────────────────
  $('backToStatusBtn').addEventListener('click', () => {
    chrome.storage.local.get(['pin', 'self_phone'], (s) => {
      const p = s.pin || s.self_phone;
      if (p) showStatus(p);
      else { renderPanel('setup'); refreshSetupHint(); }
    });
  });

  // ─── 清除 PIN（二次确认，避免误点即清） ──────────────
  // 弹窗里不用原生 confirm()：部分场景会被浏览器拦截，一旦被拦按钮就成了"点了没反应"。
  // 改成按钮二次确认（3 秒内再点一次生效），并把清空后的落点明确为「完整设置页 + 聚焦配对码」。
  const clearBtn = $('clearPinBtn');
  let clearArmed = false;
  let clearTimer = null;
  clearBtn.addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = '确认清除？';
      clearTimer = setTimeout(() => { clearArmed = false; clearBtn.textContent = '清除 PIN'; }, 3000);
      return;
    }
    clearTimeout(clearTimer);
    clearArmed = false;
    clearBtn.textContent = '清除 PIN';
    chrome.storage.local.remove(['pin', 'self_phone'], () => {
      pinInput.value = '';
      pinStatus.textContent = '';
      renderPanel('setup', pinInput);
      refreshSetupHint();
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
      renderPanel('setup');
      refreshSetupHint();
    }
    testServer(fullUrl(serverInput.value));
  });
});
