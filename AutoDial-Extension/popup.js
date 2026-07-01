/**
 * AutoDial Popup v4.0
 * 整合版：设云中继地址 + 设 PIN（坐席手机号）+ 测试连接
 * 服务器地址统一为纯 IP:PORT 格式（自动补全 http://）
 */
document.addEventListener('DOMContentLoaded', () => {
  const serverInput = document.getElementById('serverInput');
  const serverStatus = document.getElementById('serverStatus');
  const pinInput = document.getElementById('pinInput');
  const pinStatus = document.getElementById('pinStatus');

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
    // 已有完整协议的直接用
    if (/^https?:\/\//i.test(addr)) return addr;
    return 'http://' + addr;
  }

  // 加载保存的服务器地址和 PIN（手动设置优先，其次自动获取）
  chrome.storage.local.get(['cloud_api', 'cloud_apis_fetched', 'self_phone', 'pin', 'manager_name'], (s) => {
    serverInput.value = cleanAddr(s.cloud_api) ||
                        (s.cloud_apis_fetched && s.cloud_apis_fetched[0] ? s.cloud_apis_fetched[0] : '262ao85kz470.vicp.fun:55535');
    if (s.pin || s.self_phone) {
      pinInput.value = s.pin || s.self_phone || '';
      showStatus(s.pin || s.self_phone);
    } else {
      showSetup();
    }
    // 加载经理姓名
    if (s.manager_name) {
      document.getElementById('mgrNameInput').value = s.manager_name;
    }
    testServer(fullUrl(serverInput.value));
  });

  // 测试服务器连接
  document.getElementById('testServerBtn').addEventListener('click', () => {
    const cleaned = cleanAddr(serverInput.value);
    if (!cleaned) { setServerStatus('请输入地址', 'err'); return; }
    // 保存纯 IP:PORT 格式
    chrome.storage.local.set({ cloud_api: cleaned });
    serverInput.value = cleaned;
    testServer(fullUrl(cleaned));
  });

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
    serverStatus.className = 'server-status ' + cls;
  }

  // 保存 PIN
  document.getElementById('savePinBtn').addEventListener('click', () => {
    const pin = pinInput.value.trim();
    if (!pin || !/^\d{4}$|^\d{11}$/.test(pin)) {
      pinStatus.textContent = '请输入4位或11位数字配对码';
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

  // 保存经理姓名
  document.getElementById('saveMgrNameBtn').addEventListener('click', () => {
    const mgrName = document.getElementById('mgrNameInput').value.trim();
    if (!mgrName) {
      document.getElementById('mgrNameStatus').textContent = '请输入接待顾问姓名';
      document.getElementById('mgrNameStatus').className = 'server-status err';
      return;
    }
    chrome.storage.local.set({ manager_name: mgrName }, () => {
      document.getElementById('mgrNameStatus').textContent = '✓ 姓名已保存';
      document.getElementById('mgrNameStatus').className = 'server-status ok';
      setTimeout(() => { document.getElementById('mgrNameStatus').textContent = ''; }, 1500);
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

  // 修改服务器（PIN 和经理姓名保持不动）
  document.getElementById('editServerBtn').addEventListener('click', () => {
    document.getElementById('setupPanel').style.display = 'block';
    document.getElementById('statusPanel').style.display = 'none';
    document.getElementById('pinInput').style.display = 'none';
    document.getElementById('savePinBtn').style.display = 'none';
    document.getElementById('pinStatus').style.display = 'none';
    document.getElementById('backToStatusBtn').style.display = 'inline-block';
    // 保留经理姓名输入可见
    document.getElementById('mgrNameInput').style.display = '';
    document.getElementById('saveMgrNameBtn').style.display = '';
    document.getElementById('mgrNameStatus').style.display = '';
  });

  // 返回状态面板（不改 PIN）
  document.getElementById('backToStatusBtn').addEventListener('click', () => {
    document.getElementById('pinInput').style.display = '';
    document.getElementById('savePinBtn').style.display = '';
    document.getElementById('pinStatus').style.display = '';
    document.getElementById('backToStatusBtn').style.display = 'none';
    document.getElementById('mgrNameInput').style.display = '';
    document.getElementById('saveMgrNameBtn').style.display = '';
    document.getElementById('mgrNameStatus').style.display = '';
    chrome.storage.local.get(['pin', 'self_phone'], (s) => {
      showStatus(s.pin || s.self_phone);
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

    // 显示经理姓名（优先自动检测）
    chrome.storage.local.get(['manager_name'], (s) => {
      var mgr = s.manager_name || '未检测到（可在下方设置）';
      document.getElementById('myMgrName').textContent = mgr;
      document.getElementById('myMgrName').onclick = () => {
        document.getElementById('editServerBtn').click();
        setTimeout(() => { document.getElementById('mgrNameInput').focus(); }, 100);
      };
      if (s.manager_name) {
        document.getElementById('mgrNameInput').value = s.manager_name;
      }
    });

    // 显示当前云端地址（手动设置优先，其次自动获取）
    chrome.storage.local.get(['cloud_api', 'cloud_apis_fetched'], (s) => {
      const addr = cleanAddr(s.cloud_api) ||
                   (s.cloud_apis_fetched && s.cloud_apis_fetched[0] ? s.cloud_apis_fetched[0] + ' [自动]' : '262ao85kz470.vicp.fun:55535');
      document.getElementById('cloudAddr').textContent = addr;
      document.getElementById('cloudAddr').onclick = () => {
        document.getElementById('editServerBtn').click();
      };
    });

    // 异步检查云端 API 状态
    chrome.storage.local.get(['cloud_api', 'cloud_apis_fetched'], (s) => {
      const apiUrl = fullUrl(cleanAddr(s.cloud_api) || 
                             (s.cloud_apis_fetched && s.cloud_apis_fetched[0] ? s.cloud_apis_fetched[0] : '262ao85kz470.vicp.fun:55535'));
      fetch(`${apiUrl}/api/v1/status`, {
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

  // 同步登记列表按钮
  document.getElementById('syncBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'triggerSync' }, (resp) => {
      const st = document.getElementById('cloudStatus');
      if (resp && resp.result) {
        st.textContent = resp.result; st.style.color = resp.ok ? '#2ECC71' : '#E74C3C';
        setTimeout(() => { st.textContent = '--'; st.style.color = '#A09070'; }, 3000);
      } else {
        st.textContent = '✗ 请先打开 CRM 页面'; st.style.color = '#E74C3C';
      }
    });
  });
});
