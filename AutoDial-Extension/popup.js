/**
 * AutoDial Popup v3.2
 * 简化版：设服务器地址 + 自动登录 + 手动登录备选
 */
document.addEventListener('DOMContentLoaded', () => {
  const serverInput = document.getElementById('serverInput');
  const serverStatus = document.getElementById('serverStatus');

  // 加载保存的服务器地址（无保存时预填默认值）
  chrome.storage.local.get(['cloud_api'], (s) => {
    serverInput.value = s.cloud_api || 'http://127.0.0.1:35441';
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
    setServerStatus('测试中...', 'checking');
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${addr}/health`, { signal: ctrl.signal });
      const d = await res.json();
      if (d.ok) {
        setServerStatus('✓ 已连接 (' + (d.data?.service || 'v3') + ')', 'ok');
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

  // 检查登录状态
  chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
    // 同步读取 content-script 存入的 self_phone
    chrome.storage.local.get(['self_phone'], (s) => {
      const detectedPhone = s.self_phone || '';
      if (detectedPhone) {
        document.getElementById('manualPhoneInput').value = detectedPhone;
      }
      if (!chrome.runtime.lastError && status && status.loggedIn) {
        showStatus(status);
      } else {
        showSetup(detectedPhone);
      }
    });
  });

  // 退出
  document.getElementById('logoutBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'logout' }, () => showSetup());
  });

  // 手动登录（自动检测失败时的备选方案）
  const manualPhoneInput = document.getElementById('manualPhoneInput');
  const manualLoginStatus = document.getElementById('manualLoginStatus');

  document.getElementById('manualLoginBtn').addEventListener('click', () => {
    const phone = manualPhoneInput.value.trim();
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      manualLoginStatus.textContent = '请输入有效的11位手机号';
      manualLoginStatus.className = 'server-status err';
      return;
    }
    manualLoginStatus.textContent = '登录中...';
    manualLoginStatus.className = 'server-status';

    chrome.runtime.sendMessage({ type: 'manualLogin', phone }, (resp) => {
      if (chrome.runtime.lastError) {
        manualLoginStatus.textContent = '通信错误，请重试';
        manualLoginStatus.className = 'server-status err';
        return;
      }
      if (resp && resp.success) {
        manualLoginStatus.textContent = '✓ 登录成功';
        manualLoginStatus.className = 'server-status ok';
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
            if (!chrome.runtime.lastError && status && status.loggedIn) {
              showStatus(status);
            }
          });
        }, 500);
      } else {
        manualLoginStatus.textContent = '✗ 无法连接服务器';
        manualLoginStatus.className = 'server-status err';
      }
    });
  });

  // 回车键触发手动登录
  manualPhoneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('manualLoginBtn').click();
    }
  });

  function showSetup(detectedPhone) {
    document.getElementById('setupPanel').style.display = 'block';
    document.getElementById('statusPanel').style.display = 'none';
    const hint = document.getElementById('setupHint');
    if (hint) {
      hint.textContent = detectedPhone
        ? '检测到 ' + detectedPhone + '，请点击登录'
        : '未检测到手机号，请手动输入后登录';
    }
  }

  async function showStatus(status) {
    document.getElementById('setupPanel').style.display = 'none';
    document.getElementById('statusPanel').style.display = 'block';
    document.getElementById('myPhone').textContent = status.phone || '--';
    const el = document.getElementById('cloudStatus');
    el.textContent = status.loggedIn ? '● 已登录' : '○ 未登录';
    el.style.color = status.loggedIn ? '#2ECC71' : '#A09070';
  }
});
