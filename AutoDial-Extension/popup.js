/**
 * AutoDial Popup v4.0
 * 整合版：设云中继地址 + 设 PIN（坐席手机号）+ 测试连接
 */
document.addEventListener('DOMContentLoaded', () => {
  const serverInput = document.getElementById('serverInput');
  const serverStatus = document.getElementById('serverStatus');
  const pinInput = document.getElementById('pinInput');
  const pinStatus = document.getElementById('pinStatus');

  // 加载保存的服务器地址和 PIN
  chrome.storage.local.get(['cloud_api', 'self_phone', 'pin'], (s) => {
    serverInput.value = s.cloud_api || 'http://127.0.0.1:35430';
    if (s.pin || s.self_phone) {
      pinInput.value = s.pin || s.self_phone || '';
      showStatus(s.pin || s.self_phone);
    } else {
      showSetup();
    }
    testServer(serverInput.value);
  });

  // 测试服务器连接
  document.getElementById('testServerBtn').addEventListener('click', () => {
    const addr = serverInput.value.trim();
    if (!addr) { setServerStatus('请输入地址', 'err'); return; }
    chrome.storage.local.set({ cloud_api: addr });
    testServer(addr);
  });

  async function testServer(addr) {
    setServerStatus('测试中...', '');
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${addr}/health`, { signal: ctrl.signal });
      const d = await res.json();
      // /health 返回的字段（兼容 v2.0 格式）
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
    serverStatus.className = 'server-status ' + cls;
  }

  // 保存 PIN
  document.getElementById('savePinBtn').addEventListener('click', () => {
    const pin = pinInput.value.trim();
    if (!pin || !/^1[3-9]\d{9}$/.test(pin)) {
      pinStatus.textContent = '请输入有效的11位手机号';
      pinStatus.className = 'server-status err';
      return;
    }
    chrome.storage.local.set({ pin: pin, self_phone: pin }, () => {
      pinStatus.textContent = '✓ PIN 已保存';
      pinStatus.className = 'server-status ok';
      showStatus(pin);
      setTimeout(() => { pinStatus.textContent = ''; }, 1500);
    });
  });

  // 回车键保存 PIN
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('savePinBtn').click();
    }
  });

  // 清除 PIN
  document.getElementById('clearPinBtn').addEventListener('click', () => {
    chrome.storage.local.remove(['pin', 'self_phone'], () => {
      showSetup();
    });
  });

  function showSetup() {
    document.getElementById('setupPanel').style.display = 'block';
    document.getElementById('statusPanel').style.display = 'none';
    const hint = document.getElementById('setupHint');
    if (hint) {
      chrome.storage.local.get(['self_phone'], (s) => {
        hint.textContent = s.self_phone
          ? '已检测到 ' + s.self_phone + '，点击保存即可'
          : '打开 CRM 页面，插件会自动检测坐席手机号作为 PIN';
      });
    }
  }

  function showStatus(pin) {
    document.getElementById('setupPanel').style.display = 'none';
    document.getElementById('statusPanel').style.display = 'block';
    document.getElementById('myPhone').textContent = pin || '--';

    // 异步检查云端 API 状态
    chrome.storage.local.get(['cloud_api'], (s) => {
      const addr = s.cloud_api || 'http://127.0.0.1:35430';
      // B35修复: 加超时和 HTTP 错误码检查
      fetch(`${addr}/api/v1/status`, {
        headers: { 'X-AutoDial-PIN': pin || '' },
        signal: AbortSignal.timeout(8000)
      }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }).then(d => {
        const el = document.getElementById('cloudStatus');
        if (d.ok) {
          const pcStr = d.pcConnected ? 'PC在线' : 'PC离线';
          const phStr = d.phoneConnected ? '手机在线(' + (d.phoneCount || 0) + ')' : '手机离线';
          el.textContent = '● ' + pcStr + ' | ' + phStr;
          el.style.color = (d.pcConnected || d.phoneConnected) ? '#2ECC71' : '#A09070';
          document.getElementById('statusDot').className = 'status-dot ' + ((d.pcConnected || d.phoneConnected) ? 'online' : 'offline');
        } else {
          el.textContent = '○ 无法获取状态';
          el.style.color = '#E74C3C';
        }
      }).catch(() => {
        const el = document.getElementById('cloudStatus');
        el.textContent = '○ 云中继不可达';
        el.style.color = '#E74C3C';
      });
    });
  }
});
