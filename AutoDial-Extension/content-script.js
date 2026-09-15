/**
 * AutoDial Content Script v6.1（拆分后主文件）
 *
 * 本文件保留：
 *   1. 顶层页面（isTopFrame）的全部挂件、菜单、弹窗、业务逻辑
 *   2. 子 iframe 的号码扫描与上报
 *
 * 共享符号由前面的模块提供（见 manifest content_scripts.js 加载顺序）：
 *   cs-00-core.js  —— 守卫 / isTopFrame / isOwnUiNode / getMyPhoneAndNameFromCRM / 图标 / escHtml
 *   cs-10-theme.js —— 主题表 / 换肤 / Toast / 挂件句柄
 */
(function () {
  'use strict';
  if (window.__adv2_main) return;
  window.__adv2_main = true;

  const AD = window.__ADCS;
  if (!AD) return;

  // v6.1：以下符号已迁至 cs-00-core.js / cs-10-theme.js，这里只做本地别名，
  //       让下方数十处调用点一行都不用改。
  const isTopFrame = AD.isTopFrame;
  const isOwnUiNode = AD.isOwnUiNode;
  const getMyPhoneAndNameFromCRM = AD.getMyPhoneAndNameFromCRM;
  const adIcon = AD.adIcon;
  const escHtml = AD.escHtml;
  const T = AD.T;
  const rebuildThemes = AD.rebuildThemes;
  const applyTheme = AD.applyTheme;
  const applyMode = AD.applyMode;
  const showToast = AD.showToast;

  if (isTopFrame) {
    AD.floatEl = null;
    AD.currentPhone = null;

    // v6.1：以下挂件层函数已迁至 cs-20-widgets.js，这里只做本地别名，
    //       让下方数十处调用点一行都不用改。
    const createFloat = AD.createFloat;
    const createHangupBtn = AD.createHangupBtn;
    const createManualDial = AD.createManualDial;
    const toggleManualDial = AD.toggleManualDial;
    const updatePhone = AD.updatePhone;
    const flashFloat = AD.flashFloat;

    // v6.1.1: 反向导出 —— 本文件内定义、但 cs-20-widgets.js 的挂件事件需要调用的符号。
    // 挂件层在 manifest 里排在本文件之前，它加载时还看不到这两个函数，
    // 所以只能由这里主动挂到 AD 上（函数声明在本块内提升，写在块首即可用）。
    AD.showContextMenu = showContextMenu;         // 定义于本块内（浮窗/挂断的右键菜单）
    AD.refreshActivePhone = refreshActivePhone;   // 定义于本块内（点击浮窗取实时号码）

    // ─── 自定义右键菜单 ──────────────────────────────
    AD.contextMenu = null;
    let _ctxMousedownHandler = null;

    // v5.3: 用最新号码刷新已弹出的菜单文案（号码实时查询回来后调用）
    function refreshContextMenuLabels() {
      const menu = document.getElementById('__ad_ctxmenu');
      if (!menu) return;
      const setLabel = (key, text) => {
        const row = menu.querySelector('[data-ad-ctx="' + key + '"]');
        const span = row && row.querySelector('span');
        if (span) span.textContent = text;
      };
      const phone = AD.currentPhone;
      setLabel('dial', phone ? '拨打 ' + phone : '拨号（未检测号码）');
      setLabel('sms', phone ? '发短信 ' + phone : '发短信（未检测号码）');
      const custName = window.__adCustomerName || '';
      const custPhone = window.__adPhone || '';
      setLabel('register', (custPhone && custName) ? '一键登记 ' + custName + ' ' + custPhone : '一键登记（未检测客户）');
    }

    function showContextMenu(x, y) {
      AD.hideContextMenu();
      const t = T();

      // 全屏透明遮罩层：负责捕获菜单外的所有点击
      const overlay = document.createElement('div');
      overlay.id = '__ad_ctxmenu_overlay';
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483646', // 比菜单低 1
        cursor: 'default',
      });
      overlay.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        AD.hideContextMenu();
      });
      overlay.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        AD.hideContextMenu();
      });
      document.body.appendChild(overlay);

      AD.contextMenu = document.createElement('div');
      AD.contextMenu.id = '__ad_ctxmenu';
      Object.assign(AD.contextMenu.style, {
        position: 'fixed',
        left: x + 'px',
        top: y + 'px',
        zIndex: '2147483647',
        background: t.bg2,
        borderRadius: '14px',
        boxShadow: `0 6px 24px ${t.accent}2E, 0 0 0 1px ${t.accent}1A`,
        padding: '6px',
        minWidth: '220px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        color: t.text,
        overflow: 'hidden',
        backdropFilter: 'blur(16px)',
      });

      const items = [
        { icon: 'monitor', label: '打开电脑端主界面', action: openDesktopApp },
        { icon: 'eye', label: '显示/隐藏悬浮窗', action: toggleFloatbar },
        { type: 'separator' },
        { icon: 'phone', key: 'dial', label: AD.currentPhone ? '拨打 ' + AD.currentPhone : '拨号（未检测号码）', action: () => {
          if (!AD.currentPhone) { flashFloat('未检测到号码', false); return; }
          chrome.runtime.sendMessage({ type: 'dial', phone: AD.currentPhone });
        }},
        { icon: 'chat', key: 'sms', label: AD.currentPhone ? '发短信 ' + AD.currentPhone : '发短信（未检测号码）', action: () => {
          if (!AD.currentPhone) { flashFloat('未检测到号码', false); return; }
          sendSms(AD.currentPhone);
        }},
        { icon: 'pencil', key: 'register', label: (function() {
          var custName = window.__adCustomerName || '';
          var custPhone = window.__adPhone || '';
          return custPhone && custName ? '一键登记 ' + custName + ' ' + custPhone : '一键登记（未检测客户）';
        })(), action: () => {
          var custName = window.__adCustomerName || '';
          var custPhone = window.__adPhone || AD.currentPhone || '';
          if (!custPhone || !custName) { flashFloat('未检测到客户信息', false); return; }
          showRegisterConfirm(custName, custPhone);
        }},
        { type: 'separator' },
        { icon: 'palette', label: '切换主题', action: showThemeMenu },
        { icon: 'keypad', label: '手动拨号', action: toggleManualDial },
        { icon: 'gear', label: '设置', action: showSettingsDialog },
        { type: 'separator' },
        { type: 'account' },  // 占位，渲染时异步填充当前登录账号
        { icon: 'x', label: '关闭菜单', action: () => {} },
      ];

      items.forEach(item => {
        if (item.type === 'separator') {
          const sep = document.createElement('div');
          Object.assign(sep.style, { height: '1px', background: t.accent + '22', margin: '4px 12px' });
          AD.contextMenu.appendChild(sep);
          return;
        }
        if (item.type === 'account') {
          const row = document.createElement('div');
          Object.assign(row.style, {
            padding: '8px 10px', margin: '0 2px', borderRadius: '8px',
            display: 'flex', alignItems: 'center', gap: '8px',
            whiteSpace: 'nowrap', fontSize: '12px',
          });
          row.innerHTML = adIcon('user', 14) + '<span>加载中...</span>';
          AD.contextMenu.appendChild(row);
          // PIN 模式：显示自动检测的坐席号 + PC 状态
          chrome.storage.local.get(['self_phone', 'pin'], (s) => {
            const phone = s.pin || s.self_phone;
            if (phone) {
              row.innerHTML = adIcon('user', 14) + '<span>PIN: ' + escHtml(phone) + '</span>';
              row.style.color = t.text2;
              row.style.cursor = 'default';
              // 异步查 PC 状态（v5.6.1：在线/离线都显示 —— 原实现离线时整行不插入，
              // 用户看不到「离线」，与 popup 的三行状态语义不一致）
              chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
                const pcOn = !!(status && status.pcAlive === true);
                const pcRow = document.createElement('div');
                pcRow.style.cssText = 'padding:0 10px 6px 10px;font-size:11px;';
                pcRow.style.color = pcOn ? t.green : t.text2;
                pcRow.textContent = 'PIN 已就绪 · PC ' + (pcOn ? '在线' : '离线');
                row.parentNode.insertBefore(pcRow, row.nextSibling);
              });
            } else {
              row.innerHTML = adIcon('bolt', 14) + '<span>未检测到坐席号</span>';
              row.style.color = t.red;
              row.style.fontWeight = '600';
              row.style.cursor = 'pointer';
              row.addEventListener('mouseenter', () => { row.style.background = t.accent + '18'; });
              row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
              row.addEventListener('click', (e) => { e.stopPropagation(); AD.hideContextMenu(); detectPin(); });
            }
          });
          return;
        }
        const row = document.createElement('div');
        Object.assign(row.style, {
          padding: '8px 10px',
          margin: '0 2px',
          borderRadius: '8px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          transition: 'background .15s',
          whiteSpace: 'nowrap',
        });
        if (item.key) row.setAttribute('data-ad-ctx', item.key);
        if (item.icon) {
          row.innerHTML = adIcon(item.icon, 15) + '<span style="pointer-events:none">' + escHtml(item.label) + '</span>';
        } else {
          row.textContent = item.label;
        }
        row.addEventListener('mouseenter', () => { row.style.background = t.accent + '14'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          AD.hideContextMenu();
          item.action();
        });
        AD.contextMenu.appendChild(row);
      });

      document.body.appendChild(AD.contextMenu);

      requestAnimationFrame(() => {
        const rect = AD.contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) AD.contextMenu.style.left = (window.innerWidth - rect.width - 8) + 'px';
        if (rect.bottom > window.innerHeight) AD.contextMenu.style.top = (window.innerHeight - rect.height - 8) + 'px';
        if (rect.left < 0) AD.contextMenu.style.left = '8px';
        if (rect.top < 0) AD.contextMenu.style.top = '8px';
      });

      // v5.3: 右键即刷新——弹出菜单的同时向"当前激活客户帧"取最新号码，
      //       拿到后就地更新菜单里的拨打/发短信/一键登记文案（菜单先弹出，不阻塞手感）
      refreshActivePhone(() => refreshContextMenuLabels());

      _ctxMousedownHandler = (e) => {
        const menu = document.getElementById('__ad_ctxmenu');
        if (menu && !menu.contains(e.target)) {
          AD.hideContextMenu();
        }
      };
      // 用 setTimeout 延迟一帧注册，避免与当前右键事件冲突
      setTimeout(() => {
        document.addEventListener('mousedown', _ctxMousedownHandler, true);
      }, 0);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') AD.hideContextMenu(); }, { once: true });
    }

    // v6.1: 实体由 cs-10-theme.js 的共享命名空间持有（AD.hideContextMenu），这里只赋值
    //（原本是块内 function 声明，顶层 applyTheme 看不到，见文件顶部说明）。
    AD.hideContextMenu = function () {
      // 移除遮罩层
      const overlay = document.getElementById('__ad_ctxmenu_overlay');
      if (overlay) overlay.remove();
      // 移除菜单
      const el = document.getElementById('__ad_ctxmenu');
      if (el) el.remove();
      AD.contextMenu = null;
    };

    // ─── 主题选择子菜单 ──────────────────────────────
    function showThemeMenu() {
      const t = T();
      const menu = document.createElement('div');
      menu.id = '__ad_thememenu';
      Object.assign(menu.style, {
        position: 'fixed',
        right: '20px',
        bottom: '140px',
        zIndex: '2147483647',
        background: t.bg2,
        borderRadius: '14px',
        boxShadow: `0 6px 24px ${t.accent}2E, 0 0 0 1px ${t.accent}1A`,
        padding: '12px',
        width: '200px',
        maxHeight: 'calc(100vh - 180px)',
        overflowY: 'auto',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        color: t.text,
        backdropFilter: 'blur(20px)',
      });

      const title = document.createElement('div');
      Object.assign(title.style, {
        fontSize: '12px',
        color: t.text2,
        marginBottom: '10px',
        fontWeight: '500',
        letterSpacing: '1px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      });
      title.innerHTML = adIcon('palette', 13) + '<span>选择主题</span>';
      menu.appendChild(title);

      // v6.0：明暗档切换（色相与明暗是两个独立维度，挂件菜单里也要能切）
      const modeRow = document.createElement('div');
      Object.assign(modeRow.style, { display: 'flex', gap: '6px', marginBottom: '10px' });
      AD_THEME_MODES.forEach((mk) => {
        const on = mk === AD.currentMode;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = AD_THEME_MODE_LABEL[mk];
        Object.assign(b.style, {
          flex: '1', fontFamily: 'inherit', fontSize: '12px', lineHeight: '1',
          padding: '6px 0', borderRadius: '999px', cursor: on ? 'default' : 'pointer',
          border: '1px solid ' + (on ? t.accent : t.accent + '33'),
          background: on ? t.accent : 'transparent',
          color: on ? (t.textOnAccent || '#FFFFFF') : t.text2,
          transition: 'background .15s, color .15s',
        });
        if (!on) {
          b.addEventListener('mouseenter', () => { b.style.background = t.accent + '12'; });
          b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
          b.addEventListener('click', () => {
            applyMode(mk);
            document.getElementById('__ad_thememenu')?.remove();
            showThemeMenu();   // 就地重建：菜单保持打开并刷新选中态
          });
        }
        modeRow.appendChild(b);
      });
      menu.appendChild(modeRow);

      // 色相网格（16 套 4 列 × 4 行）。
      // v5.x 是 9 行竖排列表；升到 16 套后竖排会撑满整屏，改网格后高度只有原来的 1/4
      const grid = document.createElement('div');
      Object.assign(grid.style, {
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '8px', justifyItems: 'center',
      });
      AD_THEME_LIST.forEach((id) => {
        const theme = AD.EXT_THEMES[id];
        if (!theme) return;
        const isActive = id === AD.currentThemeId;
        const swatch = document.createElement('span');
        swatch.title = theme.name;
        Object.assign(swatch.style, {
          width: '26px', height: '26px', borderRadius: '50%',
          cursor: isActive ? 'default' : 'pointer',
          background: theme.gradAccent,
          boxShadow: isActive
            ? `0 0 0 2px ${t.bg2}, 0 0 0 4px ${theme.accent}55`
            : `0 1px 4px ${theme.accent}55`,
          transition: 'transform .12s',
        });
        if (!isActive) {
          swatch.addEventListener('mouseenter', () => { swatch.style.transform = 'scale(1.12)'; });
          swatch.addEventListener('mouseleave', () => { swatch.style.transform = 'scale(1)'; });
          swatch.addEventListener('click', () => {
            applyTheme(id);
            document.getElementById('__ad_thememenu')?.remove();
          });
        }
        grid.appendChild(swatch);
      });
      menu.appendChild(grid);

      // 当前生效的「色相 · 明暗」，避免只靠色块光环猜
      const curRow = document.createElement('div');
      Object.assign(curRow.style, {
        marginTop: '10px', textAlign: 'center', fontSize: '11px', color: t.text2,
      });
      curRow.textContent = (AD.EXT_THEMES[AD.currentThemeId] ? AD.EXT_THEMES[AD.currentThemeId].name : '') +
                           ' \u00B7 ' + AD_THEME_MODE_LABEL[AD.currentMode];
      menu.appendChild(curRow);

      // 关闭按钮
      const closeRow = document.createElement('div');
      Object.assign(closeRow.style, {
        marginTop: '8px',
        paddingTop: '8px',
        borderTop: `1px solid ${t.accent}22`,
        textAlign: 'center',
        color: t.text2,
        cursor: 'pointer',
        fontSize: '12px',
      });
      closeRow.textContent = '关闭';
      closeRow.addEventListener('click', () => menu.remove());
      menu.appendChild(closeRow);

      document.body.appendChild(menu);

      // 点击外部关闭
      const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener('mousedown', closeHandler, true);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', closeHandler, true), 100);
    }

    function showSettingsDialog() {
      const t = T();

      // 关闭已打开的
      const old = document.getElementById('__ad_settings');
      if (old) { old.remove(); document.getElementById('__ad_settings_overlay')?.remove(); }

      // 遮罩
      const overlay = document.createElement('div');
      overlay.id = '__ad_settings_overlay';
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '2147483646',
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(2px)',
      });
      overlay.addEventListener('click', closeSettings);
      document.body.appendChild(overlay);

      // 弹窗主体
      const dialog = document.createElement('div');
      dialog.id = '__ad_settings';
      Object.assign(dialog.style, {
        position: 'fixed', left: '50%', top: '50%',
        transform: 'translate(-50%, -50%) scale(0.95)',
        zIndex: '2147483647',
        width: '380px', maxWidth: 'calc(100vw - 32px)',
        background: t.bg2,
        borderRadius: '16px',
        boxShadow: `0 16px 48px rgba(0,0,0,0.45), 0 0 0 1px ${t.accent}22`,
        padding: '20px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: t.text,
        fontSize: '14px',
        backdropFilter: 'blur(24px)',
        opacity: '0',
        transition: 'opacity .2s ease, transform .2s ease',
      });

      // 入场动画
      requestAnimationFrame(() => {
        dialog.style.opacity = '1';
        dialog.style.transform = 'translate(-50%, -50%) scale(1)';
      });

      function closeSettings() {
        dialog.style.opacity = '0';
        dialog.style.transform = 'translate(-50%, -50%) scale(0.95)';
        setTimeout(() => { overlay.remove(); dialog.remove(); }, 200);
      }
      document.addEventListener('keydown', function escClose(e) {
        if (e.key === 'Escape') { closeSettings(); document.removeEventListener('keydown', escClose); }
      });

      // ── 标题（20px 图标底座 + 15px/700 标题 + 右侧 × 关闭） ──
      const title = document.createElement('div');
      Object.assign(title.style, {
        display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px',
      });
      const tile = document.createElement('span');
      Object.assign(tile.style, {
        width: '20px', height: '20px', borderRadius: '6px',
        background: t.accent + '1F', color: t.accent,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0',
      });
      tile.innerHTML = adIcon('gear', 12);
      const titleText = document.createElement('span');
      titleText.textContent = '设置';
      Object.assign(titleText.style, { fontSize: '15px', fontWeight: '700', color: t.text, letterSpacing: '0.5px' });
      const titleCloseBtn = document.createElement('button');
      titleCloseBtn.innerHTML = adIcon('x', 14);
      Object.assign(titleCloseBtn.style, {
        marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
        color: t.text2, padding: '4px', display: 'inline-flex', alignItems: 'center', borderRadius: '6px',
      });
      titleCloseBtn.addEventListener('click', closeSettings);
      title.append(tile, titleText, titleCloseBtn);
      dialog.appendChild(title);

      // ═══════════════════ PIN 区 ═══════════════════
      const pinSection = mkSection('配对码 (PIN)', '4位或11位数字，用于配对和标识');
      dialog.appendChild(pinSection);

      const pinRow = document.createElement('div');
      Object.assign(pinRow.style, { display: 'flex', gap: '8px', marginBottom: '4px' });
      const pinInput = document.createElement('input');
      pinInput.type = 'tel';
      pinInput.maxLength = 11;
      pinInput.placeholder = '4位或11位数字配对码';
      Object.assign(pinInput.style, {
        flex: '1', height: '40px', padding: '0 12px', fontSize: '15px', fontWeight: '500', letterSpacing: '1px',
        background: t.bg3, border: `1px solid ${t.accent}33`, borderRadius: '10px',
        color: t.text, outline: 'none', textAlign: 'center',
        transition: 'border-color .15s, box-shadow .15s',
      });
      pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, ''); });
      pinInput.addEventListener('focus', () => {
        const c = T();
        pinInput.style.borderColor = c.accent;
        pinInput.style.boxShadow = `0 0 0 3px ${c.accent}26`;
      });
      pinInput.addEventListener('blur', () => {
        pinInput.style.borderColor = T().accent + '33';
        pinInput.style.boxShadow = 'none';
      });

      const pinSaveBtn = mkBtn('保存', t.gradAccent, '#FFFFFF');
      pinSaveBtn.addEventListener('click', () => {
        const v = pinInput.value.trim();
        if (!/^\d{4}$|^\d{11}$/.test(v)) {
          pinStatus.textContent = '请输入4位或11位数字配对码'; pinStatus.style.color = t.red;
          return;
        }
        chrome.runtime.sendMessage({ type: 'setPin', pin: v }, (resp) => {
          if (chrome.runtime.lastError || !resp?.success) {
            pinStatus.textContent = '保存失败'; pinStatus.style.color = t.red;
          } else {
            pinStatus.textContent = '✓ 已保存'; pinStatus.style.color = t.green;
            setTimeout(() => { pinStatus.textContent = ''; }, 2000);
          }
        });
      });
      pinRow.appendChild(pinInput);
      pinRow.appendChild(pinSaveBtn);
      dialog.appendChild(pinRow);

      const pinStatus = document.createElement('div');
      Object.assign(pinStatus.style, { fontSize: '11px', minHeight: '16px', marginBottom: '16px', paddingLeft: '4px', color: t.text2 });
      dialog.appendChild(pinStatus);

      // 加载当前 PIN
      chrome.storage.local.get(['pin', 'self_phone'], (s) => {
        pinInput.value = s.pin || s.self_phone || '';
      });

      // ═══════════════════ 云中继地址区（v5.6 走 addr.js） ═══════════════════
      const srvSection = mkSection('云中继地址', '默认端口 35430 · 留空则用自动获取的地址');
      dialog.appendChild(srvSection);

      const srvRow = document.createElement('div');
      Object.assign(srvRow.style, { display: 'flex', gap: '8px', marginBottom: '4px' });
      const srvInput = document.createElement('input');
      srvInput.type = 'text';
      srvInput.placeholder = '例: 101.34.65.254:35430';
      Object.assign(srvInput.style, {
        flex: '1', height: '40px', padding: '0 12px', fontSize: '14px',
        background: t.bg3, border: `1px solid ${t.accent}33`, borderRadius: '10px',
        color: t.text, outline: 'none',
        transition: 'border-color .15s, box-shadow .15s',
      });
      srvInput.addEventListener('focus', () => {
        const c = T();
        srvInput.style.borderColor = c.accent;
        srvInput.style.boxShadow = `0 0 0 3px ${c.accent}26`;
      });
      srvInput.addEventListener('blur', () => {
        srvInput.style.borderColor = T().accent + '33';
        srvInput.style.boxShadow = 'none';
      });

      const srvSaveBtn = mkBtn('保存', t.gradAccent, '#FFFFFF');
      srvSaveBtn.addEventListener('click', async () => {
        const v = srvInput.value.trim();
        if (!v) {
          await AD_ADDR.setManual('');
          srvStatus.textContent = '✓ 已清空，将使用自动获取的地址'; srvStatus.style.color = t.green;
          const a = await AD_ADDR.readActive();
          srvInput.value = AD_ADDR.cleanAddr(a.addr);
          srcHint.textContent = '来源：' + AD_ADDR.sourceLabel(a.source);
          setTimeout(() => { srvStatus.textContent = ''; }, 2000);
          return;
        }
        const saved = await AD_ADDR.setManual(v);
        srvInput.value = AD_ADDR.cleanAddr(saved.addr);
        srcHint.textContent = '来源：手动';
        srvStatus.textContent = '✓ 已保存'; srvStatus.style.color = t.green;
        setTimeout(() => { srvStatus.textContent = ''; }, 2000);
      });
      srvRow.appendChild(srvInput);
      srvRow.appendChild(srvSaveBtn);
      dialog.appendChild(srvRow);

      const srvStatus = document.createElement('div');
      Object.assign(srvStatus.style, { fontSize: '11px', minHeight: '16px', marginBottom: '4px', paddingLeft: '4px', color: t.text2 });
      dialog.appendChild(srvStatus);

      // v5.6：来源提示行（手动 / 自动 / 默认）
      const srcHint = document.createElement('div');
      Object.assign(srcHint.style, { fontSize: '11px', marginBottom: '8px', paddingLeft: '4px', color: t.text2 });
      dialog.appendChild(srcHint);

      // v5.6：输入框显示「真实生效地址」。此前只读 cloud_api —— 从没手动设过时是空白，
      // 但后台实际在用自动获取的候选首位，看到的值和用到的值不是一回事。
      AD_ADDR.readActive().then((a) => {
        srvInput.value = AD_ADDR.cleanAddr(a.addr);
        srcHint.textContent = '来源：' + AD_ADDR.sourceLabel(a.source);
      });

      // 按钮行: 测试连接 + 获取候选
      const actionRow = document.createElement('div');
      Object.assign(actionRow.style, { display: 'flex', gap: '8px', marginBottom: '8px' });

      const testBtn = mkBtn('测试连接', t.bg3, t.text, `1px solid ${t.accent}33`);
      testBtn.addEventListener('click', async () => {
        const addr = srvInput.value.trim();
        if (!addr) { srvStatus.textContent = '请输入服务器地址'; srvStatus.style.color = t.red; return; }
        srvStatus.textContent = '测试中...'; srvStatus.style.color = t.text2;
        // v5.6：统一走 AD_ADDR.probe（与弹窗同一个实现），失败按原因区分，
        // 不再是笼统的"无法连接"（地址错/端口拒绝/超时/不是本服务）。
        const r = await AD_ADDR.probe(addr, { timeoutMs: 8000 });
        srvStatus.textContent = AD_ADDR.probeMessage(r);
        srvStatus.style.color = r.ok ? t.green : t.red;
      });
      actionRow.appendChild(testBtn);

      const fetchBtn = mkBtn('获取候选', t.bg3, t.text, `1px solid ${t.accent}33`);
      fetchBtn.addEventListener('click', async () => {
        srvStatus.textContent = '获取中...'; srvStatus.style.color = t.text2;
        // v5.6：只刷新「候选池」，**不再**把 servers[0] 写进 cloud_api。
        // 此前点一次「一键获取」就顶掉手动地址，并从此永久钉死在第一台机器上
        // （后面自动列表再更新也不会跟随）。
        const list = await AD_ADDR.fetchList(8000);
        if (!list.length) {
          srvStatus.textContent = '获取失败，请检查网络'; srvStatus.style.color = t.red;
          return;
        }
        await AD_ADDR.applyAuto(list);
        srvInput.value = list[0];  // 仅填入输入框作建议，点「保存」才真正生效
        srvStatus.textContent = `✓ 获取到 ${list.length} 个候选，点「保存」启用首个`; srvStatus.style.color = t.green;
      });
      actionRow.appendChild(fetchBtn);
      dialog.appendChild(actionRow);

      // ── 关闭按钮 ──
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '关闭';
      Object.assign(closeBtn.style, {
        display: 'block', margin: '14px auto 0', height: '38px', padding: '0 32px',
        background: 'transparent', color: t.text2, border: `1px solid ${t.accent}33`,
        borderRadius: '10px', cursor: 'pointer', fontSize: '13px',
      });
      closeBtn.addEventListener('click', closeSettings);
      dialog.appendChild(closeBtn);

      document.body.appendChild(dialog);
    }

    // ── 辅助：区块标题 ──
    const SECTION_ICON = { '配对码 (PIN)': 'lock', '云端服务器': 'cloud' };
    function mkSection(title, subtitle) {
      const t = T();
      const el = document.createElement('div');
      Object.assign(el.style, { marginBottom: '10px' });
      const head = document.createElement('div');
      Object.assign(head.style, {
        fontSize: '13px', fontWeight: '600', color: t.accent, marginBottom: '2px',
        display: 'flex', alignItems: 'center', gap: '6px',
      });
      head.innerHTML = adIcon(SECTION_ICON[title] || 'gear', 14) + '<span>' + title + '</span>';
      el.appendChild(head);
      if (subtitle) {
        const sub = document.createElement('div');
        Object.assign(sub.style, { fontSize: '11px', color: t.text2, paddingLeft: '20px' });
        sub.textContent = subtitle;
        el.appendChild(sub);
      }
      return el;
    }

    // ── 辅助：按钮 ──
    function mkBtn(text, bg, color, border) {
      const btn = document.createElement('button');
      btn.textContent = text;
      Object.assign(btn.style, {
        height: '40px', padding: '0 16px', fontSize: '13px', fontWeight: '600',
        background: bg || 'transparent', color: color || '#fff',
        border: border || 'none', borderRadius: '10px',
        cursor: 'pointer', whiteSpace: 'nowrap', transition: 'opacity .15s',
      });
      btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.8'; });
      btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
      return btn;
    }

    function openDesktopApp() {
      chrome.runtime.sendMessage({ type: 'openDesktop' }, (resp) => {
        if (chrome.runtime.lastError) { flashFloat('PC端未运行', false); return; }
        if (resp && resp.success) flashFloat('已打开主界面', true);
        else flashFloat('打开失败', false);
      });
    }

    function toggleFloatbar() {
      chrome.runtime.sendMessage({ type: 'toggleFloatbar' }, (resp) => {
        if (chrome.runtime.lastError) { flashFloat('PC端未运行', false); return; }
        if (resp && resp.success) flashFloat(resp.visible ? '悬浮窗已显示' : '悬浮窗已隐藏', true);
        else flashFloat('操作失败', false);
      });
    }

    function sendSms(phone) {
      chrome.runtime.sendMessage({ type: 'sendSms', phone }, (resp) => {
        if (chrome.runtime.lastError) { flashFloat('PC端未运行', false); return; }
        if (resp && resp.success) flashFloat('已打开短信窗口', true);
        else flashFloat('打开短信窗口失败', false);
      });
    }

    // ─── v5.3: 实时读取「当前激活客户帧」的号码 ──────
    //
    // 背景：客户详情是独立 iframe，靠 5 秒心跳上报号码 → 切客户后顶层浮窗最多滞后 5 秒。
    // 用户若在这几秒内点击，就可能拨到上一位客户。
    //
    // 改为「动作驱动的即时查询」：顶层浮窗左击/右键时广播一次询问，只有 isFrameActive()
    // 为真的那一帧（= 眼前这个客户）会应答自己号码，因此拿到的永远是最新值，既无需等心跳，
    // 也不会被隐藏的旧客户帧串号。超时（300ms 无应答）时沿用现有 AD.currentPhone，退回旧行为。
    var _adAskSeq = 0;
    function broadcastToFrames(msg) {
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        try { if (frames[i].contentWindow) frames[i].contentWindow.postMessage(msg, '*'); } catch (e) {}
      }
    }
    function refreshActivePhone(cb) {
      var reqId = 'adq' + (++_adAskSeq);
      var settled = false;
      function settle(got, phone) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onReply);
        if (got && phone !== AD.currentPhone) updatePhone(phone);
        if (typeof cb === 'function') cb(AD.currentPhone);
      }
      function onReply(e) {
        if (!e.data || e.data.type !== '__ad_phone_reply' || e.data.reqId !== reqId) return;
        settle(true, e.data.phone || null);
      }
      var timer = setTimeout(function () { settle(false, null); }, 300);
      window.addEventListener('message', onReply);
      broadcastToFrames({ type: '__ad_ask_phone', reqId: reqId });
    }

    // v6.1: updatePhone / flashFloat / restoreFloatLabel 已迁至 cs-20-widgets.js

    // ─── 一键登记确认弹窗 ────────────────────────────
    function showRegisterConfirm(name, phone) {
      // 移除已有弹窗
      var old = document.getElementById('autodial-register-overlay');
      if (old) old.remove();

      var pin = window.__adMyPhone || '';
      var mgrName = window.__adMyName || pin; // 优先用自动检测的姓名，兜底用 PIN

      var t = T();
      var overlay = document.createElement('div');
      overlay.id = 'autodial-register-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;' +
        'background:rgba(0,0,0,0.6);z-index:2147483647;display:flex;' +
        'align-items:center;justify-content:center;font-family:sans-serif;';

      overlay.innerHTML = '<div style="background:' + t.bg2 + ';border-radius:16px;padding:20px;' +
        'min-width:300px;max-width:360px;color:' + t.text + ';text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.45),0 0 0 1px ' + t.accent + '22;backdrop-filter:blur(16px);font-family:system-ui,-apple-system,sans-serif;">' +
        '<div style="font-size:16px;font-weight:bold;color:' + t.accentLight + ';margin-bottom:16px;">确认登记客户信息</div>' +
        '<div style="text-align:left;margin-bottom:16px;">' +
        '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">客户姓名：</span>' + escHtml(name) + '</div>' +
        '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">客户手机号：</span>' + escHtml(phone) + '</div>' +
        '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">接待顾问：</span>' +
        '<select id="autodial-register-manager" style="width:100%;padding:8px 10px;border:1px solid ' + t.accent + '33;border-radius:10px;background:' + t.bg3 + ';color:' + t.text + ';font-size:14px;box-sizing:border-box;margin-top:4px;outline:none;">' +
        '<option value="' + escHtml(mgrName || '') + '" selected>' + escHtml(mgrName || '加载中…') + '</option>' +
        '</select></div>' +
        '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">事由：</span>贷款咨询</div>' +
        '</div>' +
        '<div style="display:flex;gap:12px;">' +
        '<button id="autodial-register-cancel" style="flex:1;height:42px;border:1px solid ' + t.accent + '44;' +
        'border-radius:999px;background:transparent;color:' + t.text2 + ';cursor:pointer;font-size:14px;font-family:inherit;">取消</button>' +
        '<button id="autodial-register-confirm" style="flex:1;height:42px;border:none;' +
        'border-radius:999px;background:' + t.gradAccent + ';color:#FFFFFF;cursor:pointer;font-size:14px;font-weight:bold;font-family:inherit;box-shadow:0 3px 10px ' + t.accent + '44;">确认登记</button>' +
        '</div></div>';

      document.body.appendChild(overlay);

      // 异步拉取 CRM 顾问列表，填充下拉框
      chrome.runtime.sendMessage({ type: 'getConsultantList' }, function(resp) {
        var select = document.getElementById('autodial-register-manager');
        if (!select) return; // 弹窗已被关闭
        var list = (resp && resp.list) || [];
        if (!list.length) return; // 拉取失败时保留默认选项
        var html = '';
        var mgrInList = false;
        for (var i = 0; i < list.length; i++) {
          var sel = (list[i].name === mgrName) ? ' selected' : '';
          if (list[i].name === mgrName) mgrInList = true;
          html += '<option value="' + escHtml(list[i].name) + '"' + sel + '>' + escHtml(list[i].name) + '</option>';
        }
        // 若当前姓名不在 CRM 列表中，保留为第一项
        if (!mgrInList && mgrName) {
          html = '<option value="' + escHtml(mgrName) + '" selected>' + escHtml(mgrName) + '</option>' + html;
        }
        select.innerHTML = html;
      });

      document.getElementById('autodial-register-cancel').onclick = function() {
        overlay.remove();
      };
      document.getElementById('autodial-register-confirm').onclick = function() {
        var mgrSelect = document.getElementById('autodial-register-manager');
        var finalMgrName = mgrSelect ? mgrSelect.value.trim() : '';
        overlay.remove();
        chrome.runtime.sendMessage({
          type: 'registerVisit',
          name: name,
          phone: phone,
          managerName: finalMgrName || undefined
        }, function(resp) {
          if (resp && resp.success) {
            showToast('✅ 已登记 ' + name);
          } else {
            showToast('✗ 登记失败: ' + (resp ? resp.error : '网络错误'));
          }
        });
      };

      // 点击遮罩关闭
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) overlay.remove();
      });
    }

    // ========== v4: 检测坐席手机号 → 存为 PIN ==========
    // v5.1: PIN 注册时机收紧。原实现由 MutationObserver 持续触发 detectPin()，
    // 使用过程中任何一次识别变化都可能覆盖 PIN；而本机坐席号是唯一的，
    // 只有离职换人才会变，且换人必然伴随 CRM 重新登录/刷新。
    // 因此约定：**只有"本次页面加载后的首次命中"才允许写入 self_phone 并注册 PIN**，
    // 之后由 MutationObserver 触发的识别仅打印日志，不再改动 PIN。
    let _lastPhone = null;
    let _debounceTimer = null;
    let _pinRegistered = false;

    function detectPin() {
      try {
        const result = getMyPhoneAndNameFromCRM();
        if (result && result.phone && result.phone !== _lastPhone) {
          _lastPhone = result.phone;
          // 首次命中 = 本次页面加载（CRM 刷新）的这一次注册机会
          const isInitial = !_pinRegistered;
          if (!isInitial) {
            // 非首次：本次页面加载期间坐席号又变了，沿用原 PIN，什么都不改
            console.log('[AutoDial v4] 坐席手机号发生变化，沿用原 PIN 不再覆盖:', result.phone);
            return true;
          }
          _pinRegistered = true;
          window.__adMyPhone = result.phone;
          chrome.storage.local.set({ self_phone: result.phone });
          console.log('[AutoDial v4] 检测到坐席手机号 (PIN):', result.phone);
          chrome.runtime.sendMessage({ type: 'selfPhoneDetected', phone: result.phone, name: result.name || '', precise: !!result.precise, initial: true });
          // 同步检测并存储经理姓名
          if (result.name) {
            window.__adMyName = result.name;
            chrome.storage.local.set({ manager_name: result.name });
            console.log('[AutoDial v4] 检测到经理姓名:', result.name);
          }
          return true;
        }
      } catch(e) {}
      return false;
    }

    // DOM 就绪后立即检测一次（SPA可能还未渲染，加延迟重试）
    function onDomReady() {
      createFloat();
      createHangupBtn();
      createManualDial();
      // 每次页面加载时检测一次PC状态（后续拨号直接复用缓存）
      chrome.runtime.sendMessage({ type: 'checkPc' });

      if (!detectPin()) {
        // 首次未检出，SPA可能在异步渲染，500ms/1500ms后重试
        setTimeout(() => { if (!detectPin()) setTimeout(detectPin, 1000); }, 500);
      }

      // SPA 页面切换时重新检测（debounce 500ms）
      new MutationObserver(() => {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(detectPin, 500);
      }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.body) { onDomReady(); }
    else { document.addEventListener('DOMContentLoaded', onDomReady); }

    // 监听来自background的消息
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'updatePhone') updatePhone(msg.phone);
      if (msg.type === 'dialResult') {
        flashFloat(msg.ok ? '已拨出' : (msg.err || '失败'), msg.ok);
      }
      if (msg.type === 'pinNotice') {
        // v4.15: 坐席号切换/不一致提示（切换=中性醒目，不一致=红色警告）
        flashFloat(msg.text || '', msg.warn ? false : undefined);
      }
      if (msg.type === 'reDetect') {
        // 用户点拨号时background让重新扫手机号和姓名
        const result = getMyPhoneAndNameFromCRM();
        if (result && result.phone) {
          _lastPhone = result.phone;
          window.__adMyPhone = result.phone;
          chrome.storage.local.set({ self_phone: result.phone });
          if (result.name) {
            window.__adMyName = result.name;
            chrome.storage.local.set({ manager_name: result.name });
          }
        }
        sendResponse({ phone: result ? result.phone : null });
        return true;
      }
    });

    // v5.5: 跟随「扩展弹窗 / 其他端」的主题切换实时换肤。
    // 此前 AD.currentThemeId 只在脚本注入时从 localStorage 读一次 —— 在弹窗里换了主题，
    // 已打开的 CRM 页面悬浮挂件不跟随，得刷新页面才生效。
    // chrome.storage 是跨上下文共享的，弹窗只需写入 __ad_theme 即可推到所有 CRM 标签页。
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        // v6.0：明暗档是独立维度，任一端（弹窗/其他标签页）改了都要重建扁平表
        const mv = changes.__ad_theme_mode && changes.__ad_theme_mode.newValue;
        if (mv && AD_NORM_MODE(mv) !== AD.currentMode) {
          AD.currentMode = AD_NORM_MODE(mv);
          localStorage.setItem('__ad_theme_mode', AD.currentMode);
          rebuildThemes();
          applyTheme(AD.currentThemeId);
          return;
        }
        const nv = changes.__ad_theme && changes.__ad_theme.newValue;
        if (nv && nv !== AD.currentThemeId && AD.EXT_THEMES[nv]) applyTheme(nv);
      });
    } catch (_) {}

    // 监听子iframe发来的客户姓名
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'nameDetected') {
        window.__adCustomerName = e.data.name;
      }
    });

    // v4.15: 残留号码保鲜检查。详情页 iframe 心跳（见 scan 的 setInterval）停止
    // 15 秒（页面已切换/iframe被移除）→ 清空残留号码，防止误拨上一位客户
    window.__adLastPhoneAt = 0;
    setInterval(() => {
      if (AD.currentPhone && Date.now() - (window.__adLastPhoneAt || 0) > 15000) {
        console.log('[AutoDial v4] 页面已离开详情页，清除残留号码:', AD.currentPhone);
        updatePhone(null);
      }
    }, 5000);

    return; // 顶层页面只做浮动按钮，不做手机号扫描
  }

  // ═══════════════════════════════════════════════
  // 子iframe：扫描手机号并拦截"点击拨打"
  // ═══════════════════════════════════════════════

  // v5.4: 原先此处为 iframeToast() 与 iframe 侧「响应同步登记列表」监听器，
  // 随「同步登记列表」功能一并移除（插件端不再抓取 CRM 列表、也不再批量上报）。

  // 监听主题变更，刷新"点击拨打"链接颜色
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === '__ad_theme_change' && e.data.accent) {
      document.querySelectorAll('.__ad-dial-link').forEach(link => {
        link.style.setProperty('color', e.data.accent, 'important');
      });
    }
  });

  // v5.2: 判断「本 iframe 是否为当前激活的页签」。
  //
  // 融鑫汇等 CRM 打开多个客户时，会为每个客户保留一个 iframe：切走的客户 iframe 被设为
  // opacity:0 / z-index:-999 叠在下面，而 display、visibility、innerWidth 全都不变，
  // 其 DOM 依旧完全可读。若不加判断，每个已打开客户的 iframe 都会随着 5 秒心跳一起上报
  // 自己那份「手机号码：」，顶层浮窗就会在多个客户之间来回跳。
  // （老版没有心跳，靠 DOM 变化驱动，天然只有当前客户会上报，故无此问题。）
  //
  // 同源时可用 window.frameElement 拿到父文档里承载自己的 <iframe>，逐层向上检查；
  // 跨域取不到时保守放行，退回旧行为，不误伤单客户场景。
  function isFrameActive() {
    try {
      if (document.visibilityState === 'hidden') return false;
      var w = window.innerWidth || document.documentElement.clientWidth || 0;
      var h = window.innerHeight || document.documentElement.clientHeight || 0;
      if (!w || !h) return false;
      var win = window, depth = 0;
      while (win && win.frameElement && depth++ < 5) {
        var cs = win.getComputedStyle(win.frameElement);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;
        var z = parseInt(cs.zIndex, 10);
        if (!isNaN(z) && z < 0) return false;
        if (win.parent === win) break;
        win = win.parent;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  // v6.1: isFrameActive() 的「轻量版」——只判可见性，不读 innerWidth/innerHeight。
  //
  // 供 300ms 级别的「激活态轮询」使用（见文件末尾）。区别只在最后那两项视口尺寸检查：
  //   · getComputedStyle().opacity / zIndex 是纯样式读取，不触发重排；
  //   · window.innerWidth / innerHeight 会强制一次布局（layout flush），
  //     放进高频轮询里会给 CRM 页面带来无谓的重排。
  // 因此高频轮询用本函数做「是否被切到前台」的判定，真正扫描前再走完整的 isFrameActive()。
  function isFrameShown() {
    try {
      if (document.visibilityState === 'hidden') return false;
      var win = window, depth = 0;
      while (win && win.frameElement && depth++ < 5) {
        var cs = win.getComputedStyle(win.frameElement);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;
        var z = parseInt(cs.zIndex, 10);
        if (!isNaN(z) && z < 0) return false;
        if (win.parent === win) break;
        win = win.parent;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  // v5.3: 响应顶层的"实时读取激活帧号码"请求。
  // 顶层浮窗左击/右键时广播 __ad_ask_phone；只有当前激活的客户帧才应答，
  // 从而让顶层立刻拿到"眼前这个客户"的号码，不必等 5 秒心跳，也不会被旧客户串号。
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.type) return;
    if (d.type === '__ad_ask_phone') {
      // 多层 iframe：继续向下转发，让最深处的激活帧也能应答
      try {
        var subs = document.querySelectorAll('iframe');
        for (var i = 0; i < subs.length; i++) {
          if (subs[i].contentWindow) subs[i].contentWindow.postMessage(d, '*');
        }
      } catch (_) {}
      // 非激活帧一律不应答（与 scan() 同一道守卫，避免隐藏的旧客户帧回来串号）
      if (!isFrameActive()) return;
      var p = null;
      try { p = getPhoneFromDetailPage(); } catch (_) {}
      try {
        window.parent.postMessage({ type: '__ad_phone_reply', reqId: d.reqId, phone: p || null }, '*');
      } catch (_) {}
    } else if (d.type === '__ad_phone_reply') {
      // 多层 iframe：把深层应答逐级冒泡回顶层
      try { if (window.parent !== window) window.parent.postMessage(d, '*'); } catch (_) {}
    }
  });

  function getPhoneFromDetailPage() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      { acceptNode: node => node.textContent.trim() === '手机号码：' || node.textContent.trim() === '手机号码:' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
    );

    while (walker.nextNode()) {
      const labelNode = walker.currentNode;
      const valueEl = labelNode.parentElement?.nextElementSibling;
      if (!valueEl) continue;

      const raw = valueEl.firstChild?.textContent?.trim() || '';
      const phone = raw.match(/^(1[3-9]\d{9})/)?.[1];
      if (!phone) continue;

      console.log('[AutoDial v4] ✓ 检测到客户手机号:', phone);

      chrome.runtime.sendMessage({ type: 'phoneDetected', phone });

      const dialLink = valueEl.querySelector('a');
      if (dialLink && !dialLink.__adHooked) {
        dialLink.__adHooked = true;
        dialLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // v4.23: 点击那一刻重新读取号码。SPA 框架会复用 <a> 节点（只改 href/文本），
          // 闭包里的 phone 是首次拦截时的旧值——换客户后点击会拨错人（旧号码）。
          let current = phone;
          const href = dialLink.getAttribute('href') || '';
          const hrefMatch = href.match(/1[3-9]\d{9}/);
          if (hrefMatch) {
            current = hrefMatch[0];
          } else {
            const textMatch = (dialLink.textContent || '').match(/1[3-9]\d{9}/);
            if (textMatch) current = textMatch[0];
          }
          console.log('[AutoDial v4] 点击拨打:', current);
          chrome.runtime.sendMessage({ type: 'dial', phone: current });
        });
        dialLink.classList.add('__ad-dial-link');
        dialLink.style.cssText += `;color:${T().accent}!important;font-weight:bold;`;
        console.log('[AutoDial v4] ✓ 已拦截"点击拨打"链接');
      }

      // 同时检测客户姓名
      var customerName = getNameFromDetailPage();
      if (customerName) {
        window.parent.postMessage({ type: 'nameDetected', name: customerName }, '*');
      }

      return phone;
    }

    return null;
  }

  // 从CRM详情页提取客户姓名（找"姓名："标签）
  function getNameFromDetailPage() {
    var labels = ['姓名：', '姓名:', '客户姓名：', '客户姓名:', '客户名称：', '客户名称:'];
    var allElements = document.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      // 跳过不可见元素、大的容器元素
      if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
      if (el.children.length > 10) continue;
      var text = (el.textContent || '').trim();
      for (var j = 0; j < labels.length; j++) {
        if (text.indexOf(labels[j]) === 0 || text === labels[j].replace(/[：:]/g, '')) {
          // 取标签后面兄弟节点的文本
          var next = el.nextElementSibling;
          if (next) {
            var name = (next.textContent || next.value || '').trim();
            if (name && name.length >= 1 && name.length <= 30 && !/\d{11}/.test(name)) {
              return name;
            }
          }
          // 如果标签在同一个节点内，取标签后的文字
          var after = text.substring(labels[j].length).trim();
          if (after && after.length >= 1 && after.length <= 30 && !/\d{11}/.test(after)) {
            return after;
          }
        }
      }
    }
    return '';
  }

  // v4.15: 本帧最近一次检出号码时的 URL，用于 SPA 切换后清除残留号码
  var adLastDetectedUrl = '';

  function scan() {
    // v5.2: 多客户标签场景下，只有「当前激活」的 iframe 才有资格上报号码/姓名。
    // 已打开但被 CRM 隐藏（opacity:0 / z-index:-999）的上一个客户，其 iframe 仍会每 5 秒
    // 心跳一次；若一并上报，顶层浮窗就会在两个客户的号码之间来回跳。
    if (!isFrameActive()) return;
    const phone = getPhoneFromDetailPage();
    if (phone) {
      adLastDetectedUrl = window.location.href;
      return;
    }
    // v4.15: 本帧之前检出过号码、且页面已切走 → 通知顶层清除，
    // 防止残留号码导致误拨上一位客户
    if (adLastDetectedUrl && window.location.href !== adLastDetectedUrl) {
      adLastDetectedUrl = '';
      try { chrome.runtime.sendMessage({ type: 'phoneDetected', phone: null }); } catch (_) {}
    }
  }

  if (document.body) {
    scan();
  }

  setTimeout(scan, 100);
  // v4.15: 每 5 秒心跳一次——静态详情页也要持续上报号码；心跳停止（页面切换/iframe
  // 被移除）时顶层会在 15 秒后清除残留号码
  setInterval(scan, 5000);

  // v6.1: 切客户「即时刷新」——补上缺失的「激活态跃迁」事件源。
  //
  // 现象：切到另一位客户后，浮窗上的号码最多滞后 5 秒才更新（旧版体感更快）。
  //
  // 根因：多客户场景下，CRM 是靠改**父文档里 <iframe> 的 opacity/z-index** 来切换显示的
  //（见上方 isFrameActive 注释）。于是被切出来的那一帧自身文档**没有任何 DOM 变化**，
  // 它的 MutationObserver 不会触发；而它在「还处于隐藏态」时完成加载/渲染的那一次
  // scan()（L1628/L1631）又会被 isFrameActive() 正当拦下（防串号）。
  // 两条路都被堵住，就只剩 5 秒心跳这一条 —— 也就是你看到的「等 5 秒才换过来」。
  //
  // 解法：轮询「我是不是被切到前台了」。每 300ms 只调一次 isFrameShown()
  //（纯样式读取、不重排、不做 TreeWalker），只在【隐藏 → 可见】那一瞬间真正扫描一次。
  // 空闲时零上报、零网络消息，代价可忽略。
  var _adWasShown = isFrameShown();
  setInterval(function () {
    var shown = isFrameShown();
    if (shown && !_adWasShown) {
      try { scan(); } catch (e) { console.warn('[AutoDial] 切客户即时刷新失败:', e); }
    }
    _adWasShown = shown;
  }, 300);

  const obs = new MutationObserver(() => {
    clearTimeout(scan._timer);
    scan._timer = setTimeout(scan, 150);
  });
  if (document.body) {
    obs.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      obs.observe(document.body, { childList: true, subtree: true });
      scan();
    });
  }
})();
