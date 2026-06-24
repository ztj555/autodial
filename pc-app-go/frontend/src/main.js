// AutoDial PC Frontend - 最小可运行版本
// 依赖 Go 端暴露的 Wails bindings

import {
  GetSettings, UpdateSettings, GetCloudStatus,
  ConnectCloudServer, UpdateCloudConfig, TestCloudServers,
  SendDial, SendHangup, SendSMS,
  GetPhoneList, GetActivePhoneID, SelectPhone,
  FetchCloudServers, RestartCloud, ForceReconnect,
  SetAutoStart, MinimizeToFloatbar, ToggleFloatbar,
  MinimizeWindow, CloseWindow, QuitApp, RestartApp, RestoreMainWindow,
  ChangeTheme, ReadClipboard, GetInfo, RenamePhone, SetTopmost
} from '../wailsjs/go/main/App';

document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  if (!app) return;

  // 基础样式
  const s = document.createElement('style');
  s.textContent = `
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:system-ui,sans-serif; background:#111318; color:#E8DCC8; overflow:hidden; }
    #app { display:flex; flex-direction:column; height:100vh; }
    .header { padding:14px 16px; background:#1A1D24; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #2A2E38; -webkit-app-region:drag; }
    .header h1 { font-size:15px; color:#C9A84C; }
    .header-btns { display:flex; gap:6px; -webkit-app-region:no-drag; }
    .header-btns button { padding:4px 10px; border:none; border-radius:4px; cursor:pointer; font-size:12px; background:#2A2E38; color:#A09070; }
    .header-btns button:hover { background:#3A3E48; color:#E8DCC8; }
    .main { flex:1; padding:12px; overflow-y:auto; }
    .section { background:#1A1D24; border-radius:8px; padding:14px; margin-bottom:10px; border:1px solid #2A2E38; }
    .section-title { font-size:12px; color:#707070; margin-bottom:8px; }
    .row { display:flex; gap:8px; align-items:center; margin-bottom:6px; }
    input { flex:1; padding:8px 10px; background:#111318; border:1px solid #2A2E38; border-radius:6px; color:#E8DCC8; font-size:13px; outline:none; }
    input:focus { border-color:#C9A84C; }
    button { padding:7px 14px; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; }
    .btn-accent { background:#C9A84C; color:#111318; }
    .btn-accent:hover { background:#D4B35A; }
    .btn-dark { background:#2A2E38; color:#A09070; }
    .btn-dark:hover { background:#3A3E48; color:#E8DCC8; }
    .btn-danger { background:transparent; color:#E74C3C; border:1px solid #E74C3C44; }
    .btn-danger:hover { background:#E74C3C22; }
    .status { font-size:12px; padding:2px 0; }
    .status-ok { color:#2ECC71; }
    .status-err { color:#E74C3C; }
    .status-warn { color:#F39C12; }
    .phone-list { max-height:200px; overflow-y:auto; }
    .phone-item { padding:8px 10px; border-bottom:1px solid #2A2E38; cursor:pointer; font-size:13px; display:flex; justify-content:space-between; }
    .phone-item:hover { background:#2A2E38; }
    .phone-item.active { background:#C9A84C22; border-left:3px solid #C9A84C; }
    .phone-item .online { color:#2ECC71; font-size:11px; }
    .phone-item .offline { color:#E74C3C; font-size:11px; }
    .log-area { max-height:150px; overflow-y:auto; font-size:11px; color:#707070; font-family:monospace; }
    .log-area div { padding:1px 0; }
    .dial-bar { display:flex; gap:8px; }
    .dial-bar input { flex:1; }
  `;
  document.head.appendChild(s);

  // === UI 结构 ===
  app.innerHTML = `
    <div class="header">
      <h1>⚡ AutoDial PC</h1>
      <div class="header-btns">
        <button onclick="window._toggleFloatbar()" title="悬浮窗">📌</button>
        <button onclick="window._minimize()" title="最小化">─</button>
        <button onclick="window._close()" title="关闭">✕</button>
      </div>
    </div>
    <div class="main">
      <div class="section">
        <div class="section-title">📞 拨号</div>
        <div class="dial-bar">
          <input id="dialInput" placeholder="输入手机号..." />
          <button class="btn-accent" id="dialBtn">拨打</button>
          <button class="btn-danger" id="hangupBtn">挂断</button>
        </div>
      </div>

      <div class="section">
        <div class="section-title">☁ 云中继</div>
        <div id="cloudStatus" class="status status-warn">加载中...</div>
        <div class="row" style="margin-top:8px">
          <input id="serverInput" placeholder="服务器地址:端口" />
          <button class="btn-accent" id="connectBtn">连接</button>
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn-dark" id="fetchBtn">📡 一键获取服务器</button>
          <button class="btn-dark" id="testBtn">🔍 测试连接</button>
          <button class="btn-dark" id="restartCloudBtn">🔄 重连</button>
        </div>
      </div>

      <div class="section">
        <div class="section-title">📱 已连接手机</div>
        <div id="phoneList" class="phone-list">无设备</div>
      </div>

      <div class="section" style="display:none" id="logSection">
        <div class="section-title">📋 日志</div>
        <div id="logArea" class="log-area"></div>
      </div>
    </div>
  `;

  // === 状态 ===
  let settings = {};
  let activePhoneId = '';

  function log(msg) {
    const area = document.getElementById('logArea');
    if (!area) return;
    const div = document.createElement('div');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    area.prepend(div);
    if (area.children.length > 50) area.lastChild.remove();
  }

  // === 初始化 ===
  async function init() {
    try {
      const info = await GetInfo();
      settings = await GetSettings();
      activePhoneId = await GetActivePhoneID() || '';

      document.getElementById('serverInput').value =
        (settings.cloudServers && settings.cloudServers[0]) || '';

      refreshCloudStatus();
      refreshPhones();
      setInterval(refreshPhones, 5000);
    } catch (e) {
      log('初始化失败: ' + e.message);
    }
  }

  // === 云状态 ===
  async function refreshCloudStatus() {
    try {
      const status = await GetCloudStatus();
      const el = document.getElementById('cloudStatus');
      if (status.connected) {
        el.textContent = '● 已连接云端';
        el.className = 'status status-ok';
      } else if (status.connecting) {
        el.textContent = '◌ 连接中...';
        el.className = 'status status-warn';
      } else {
        el.textContent = '○ 未连接';
        el.className = 'status status-err';
      }
    } catch (e) {}
  }

  // === 手机列表 ===
  async function refreshPhones() {
    try {
      const phones = await GetPhoneList();
      const el = document.getElementById('phoneList');
      if (!phones || phones.length === 0) {
        el.innerHTML = '<div style="padding:8px;color:#707070;font-size:12px">无设备连接</div>';
        return;
      }
      el.innerHTML = phones.map(p => {
        const active = p.id === activePhoneId ? ' active' : '';
        const status = p.online ? '<span class="online">在线</span>' : '<span class="offline">离线</span>';
        return `<div class="phone-item${active}" data-id="${p.id}">
          <span>${p.name || p.id} (${p.ip || '-'})</span>${status}
        </div>`;
      }).join('');
      el.querySelectorAll('.phone-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.dataset.id;
          SelectPhone(id).then(() => { activePhoneId = id; refreshPhones(); });
        });
      });
    } catch (e) {}
  }

  // === 事件绑定 ===
  document.getElementById('dialBtn').addEventListener('click', async () => {
    const num = document.getElementById('dialInput').value.trim();
    if (!num) return;
    try {
      const res = await SendDial(num);
      log('拨号: ' + num + ' -> ' + res);
    } catch (e) { log('拨号失败: ' + e.message); }
  });

  document.getElementById('hangupBtn').addEventListener('click', async () => {
    try { await SendHangup(); log('已挂断'); } catch (e) {}
  });

  document.getElementById('connectBtn').addEventListener('click', async () => {
    const addr = document.getElementById('serverInput').value.trim();
    if (!addr) return;
    try {
      await UpdateCloudConfig(true, [addr]);
      log('连接: ' + addr);
      setTimeout(refreshCloudStatus, 1000);
    } catch (e) { log('连接失败: ' + e.message); }
  });

  document.getElementById('fetchBtn').addEventListener('click', async () => {
    try {
      const servers = await FetchCloudServers();
      if (servers && servers.length > 0) {
        document.getElementById('serverInput').value = servers[0];
        log('获取到 ' + servers.length + ' 个服务器');
      } else {
        log('未获取到服务器列表');
      }
    } catch (e) { log('获取失败: ' + e.message); }
  });

  document.getElementById('testBtn').addEventListener('click', async () => {
    const addr = document.getElementById('serverInput').value.trim();
    if (!addr) return;
    try {
      const results = await TestCloudServers([addr]);
      const r = results[0];
      log(r.ok ? `✓ 连接成功 (${r.ms}ms)` : `✗ 失败: ${r.error || '超时'}`);
    } catch (e) { log('测试失败: ' + e.message); }
  });

  document.getElementById('restartCloudBtn').addEventListener('click', async () => {
    try { await RestartCloud(); log('重连中...'); setTimeout(refreshCloudStatus, 2000); } catch (e) {}
  });

  // 全局函数
  window._minimize = () => MinimizeWindow();
  window._close = () => CloseWindow();
  window._toggleFloatbar = () => ToggleFloatbar();

  document.getElementById('dialInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('dialBtn').click();
  });

  init();
});
