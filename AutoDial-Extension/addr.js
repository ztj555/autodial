/* ============================================================
 * AutoDial 云中继地址 v5.6（唯一权威源）
 * popup.html / 内容脚本(cs-*.js) / background.js 共用：
 *   JS 侧   — AD_ADDR 下的纯函数与异步读写
 *   DOM 侧  — 无（仅 storage / fetch）
 *
 * 设计要点（v5.6 重构，解决「同一地址三套实现、结论不一致」）：
 *   1. 唯一权威地址 = cloud_api；来源 = cloud_api_source('manual'|'auto'|'')
 *   2. cloud_apis_fetched 只是「候选池」，永不自动覆盖手动地址
 *   3. 端口默认值只有 AD_DEFAULT_PORT 一处
 *   4. 连通性探针只走 /health，失败按原因分类（超时/拒绝/HTTP/非本服务）
 *
 * 加载方式：
 *   popup.html            <script src="addr.js">
 *   manifest content_scripts.js  ["themes.js","addr.js","cs-00-core.js", …, "cs-70-boot.js"]
 *   background.js         importScripts('addr.js')
 * ============================================================ */

var AD_DEFAULT_PORT = 35430;
var AD_DEFAULT_HOST = '101.34.65.254';
var AD_DEFAULT_ADDR = AD_DEFAULT_HOST + ':' + AD_DEFAULT_PORT;

var AD_ADDR = (function () {
  'use strict';

  var K_ADDR = 'cloud_api';            // 唯一权威地址
  var K_SRC = 'cloud_api_source';      // 来源：'manual' | 'auto' | ''
  var K_LIST = 'cloud_apis_fetched';   // 候选池
  var K_LIST_AT = 'cloud_apis_fetched_at'; // 候选池更新时间

  // ─── 纯函数：格式化 ──────────────────────────────────

  // 归一化用户输入 / 配置值 -> 可存储的干净地址
  //   'ws://a.com'      -> 'http://a.com'
  //   'https://a.com/x' -> 'https://a.com'   （带协议时不补端口）
  //   'a.com'           -> 'a.com:35430'     （无协议无端口时补默认端口）
  function cleanAddr(addr) {
    var s = String(addr == null ? '' : addr).trim();
    if (!s) return '';
    s = s.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    var m = s.match(/^(https?):\/\//i);
    var scheme = m ? m[1].toLowerCase() + '://' : '';
    var rest = scheme ? s.slice(m[0].length) : s;
    rest = rest.split('/')[0].split('?')[0].split('#')[0].trim();
    if (!rest) return '';
    if (!scheme && !/:\d+$/.test(rest)) rest += ':' + AD_DEFAULT_PORT;
    return scheme + rest;
  }

  // 补全协议，用于 fetch
  function fullUrl(addr) {
    var c = cleanAddr(addr);
    if (!c) return '';
    if (/^https?:\/\//i.test(c)) return c;
    return 'http://' + c;
  }

  // 解析服务列表文本里的单行（Gist/Gitee 格式）
  // 支持：注释行、[标签] 行、行末别名、"新云端/老云端" 后缀、无端口
  function parseLine(line) {
    var s = String(line == null ? '' : line).trim();
    if (!s || s.charAt(0) === '#') return '';
    if (/^\[.+\]$/.test(s)) return '';
    s = s.replace(/新云端|老云端/g, '').trim();
    if (!s) return '';
    s = s.split(/\s+/)[0];
    s = s.replace(/^(https?|wss?):\/\//i, '');
    s = s.replace(/\/+$/, '');
    if (!s) return '';
    if (!/:\d+$/.test(s)) s += ':' + AD_DEFAULT_PORT;
    return s;
  }

  // 整段文本 -> 地址数组
  function parseList(text) {
    var out = [];
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var v = parseLine(lines[i]);
      if (v && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  function sourceLabel(src) {
    if (src === 'manual') return '手动';
    if (src === 'auto') return '自动';
    return '默认';
  }

  // ─── storage 读写（唯一入口）────────────────────────

  // 读取当前生效地址 + 来源 + 候选池
  // 兼容老数据：有 cloud_api 但没有 source 时，视为手动（最保守）
  function readActive() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([K_ADDR, K_SRC, K_LIST, K_LIST_AT], function (s) {
        var manual = cleanAddr(s[K_ADDR] || '');
        var list = Array.isArray(s[K_LIST]) ? s[K_LIST].slice() : [];
        var src = s[K_SRC] || '';
        if (manual && !src) src = 'manual';

        var addr, source;
        if (manual) {
          addr = manual; source = src || 'manual';
        } else if (list.length) {
          addr = list[0]; source = 'auto';
        } else {
          addr = AD_DEFAULT_ADDR; source = '';
        }
        resolve({
          addr: addr, source: source, manual: manual,
          list: list, listAt: Number(s[K_LIST_AT]) || 0,
          defaultAddr: AD_DEFAULT_ADDR
        });
      });
    });
  }

  // 保存为手动地址（传空 = 清空，回落到候选池/默认值）
  function setManual(addr) {
    var cleaned = cleanAddr(addr);
    return new Promise(function (resolve) {
      if (!cleaned) {
        chrome.storage.local.remove([K_ADDR, K_SRC], function () {
          resolve({ addr: '', source: '' });
        });
        return;
      }
      var o = {};
      o[K_ADDR] = cleaned;
      o[K_SRC] = 'manual';
      chrome.storage.local.set(o, function () {
        resolve({ addr: cleaned, source: 'manual' });
      });
    });
  }

  // 写入候选池。**不碰生效地址**（v5.6 语义：自动获取只当候选，不自动切换）
  function applyAuto(list) {
    var norm = (Array.isArray(list) ? list : []).map(parseLine).filter(Boolean);
    var uniq = [];
    for (var i = 0; i < norm.length; i++) {
      if (uniq.indexOf(norm[i]) === -1) uniq.push(norm[i]);
    }
    return new Promise(function (resolve) {
      var o = {};
      o[K_LIST] = uniq;
      o[K_LIST_AT] = Date.now();
      chrome.storage.local.set(o, function () { resolve(uniq); });
    });
  }

  // ─── 网络：拉取候选 + 探针 ──────────────────────────

  var LIST_SOURCES = [
    'https://gist.githubusercontent.com/ztj555/cb6a6bb0ddbe3d4e651d5bb3411777d5/raw/AutoDialservers.txt',
    'https://gitee.com/zuo-tingjun/AutoDialserverslist/raw/master/servers.txt'
  ];

  // 从网络拉候选列表（只返回数组，不落盘；落盘请再调 applyAuto）
  function fetchList(timeoutMs) {
    var t = timeoutMs || 8000;
    var sources = LIST_SOURCES.slice();
    return new Promise(function (resolve) {
      (function next(i) {
        if (i >= sources.length) { resolve([]); return; }
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, t);
        fetch(sources[i], { signal: ctrl.signal })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
          })
          .then(function (text) {
            clearTimeout(timer);
            var list = parseList(text);
            if (list.length) resolve(list); else next(i + 1);
          })
          .catch(function () {
            clearTimeout(timer);
            next(i + 1);
          });
      })(0);
    });
  }

  // 连通性探针：GET /health
  // 返回 { ok, kind, detail, ms, service?, version? }
  //   kind: 'ok' | 'invalid' | 'timeout' | 'refused' | 'http' | 'not-autodial'
  function probe(addr, opts) {
    var t = (opts && opts.timeoutMs) || 6000;
    var base = fullUrl(addr);
    var started = Date.now();
    if (!base) {
      return Promise.resolve({ ok: false, kind: 'invalid', detail: '地址为空或格式不正确', ms: 0 });
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, t);
    return fetch(base + '/health', { signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(timer);
        var ms = Date.now() - started;
        if (!res.ok) return { ok: false, kind: 'http', detail: 'HTTP ' + res.status, ms: ms };
        return res.text().then(function (txt) {
          var d = null;
          try { d = JSON.parse(txt); } catch (e) { d = null; }
          if (!d || !d.service) {
            return { ok: false, kind: 'not-autodial', detail: '该地址可访问但不是 AutoDial 云中继', ms: ms };
          }
          return {
            ok: true, kind: 'ok', ms: ms,
            service: d.service, version: d.version || '', port: d.port || 0
          };
        });
      })
      .catch(function (e) {
        clearTimeout(timer);
        var ms = Date.now() - started;
        var isAbort = e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message)));
        return {
          ok: false,
          kind: isAbort ? 'timeout' : 'refused',
          detail: isAbort ? '连接超时' : '无法连接（域名解析失败或端口被拒绝）',
          ms: ms
        };
      });
  }

  // 把探针结果转成人话
  function probeMessage(r) {
    if (!r) return '';
    if (r.kind === 'ok') {
      return '✓ 已连接 (' + r.service + (r.version ? ' v' + r.version : '') + ') · ' + r.ms + 'ms';
    }
    var tail = r.ms ? ' · ' + r.ms + 'ms' : '';
    return '✗ ' + (r.detail || '连接失败') + tail;
  }

  // 业务态查询：GET /api/v1/status（PC/手机在线情况）
  function statusOf(addr, pin, timeoutMs) {
    var base = fullUrl(addr);
    if (!base) return Promise.reject(new Error('no addr'));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000);
    return fetch(base + '/api/v1/status', {
      headers: { 'X-AutoDial-PIN': pin || '' },
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  return {
    DEFAULT_PORT: AD_DEFAULT_PORT,
    DEFAULT_HOST: AD_DEFAULT_HOST,
    DEFAULT_ADDR: AD_DEFAULT_ADDR,
    KEYS: { ADDR: K_ADDR, SRC: K_SRC, LIST: K_LIST, LIST_AT: K_LIST_AT },
    cleanAddr: cleanAddr,
    fullUrl: fullUrl,
    parseLine: parseLine,
    parseList: parseList,
    sourceLabel: sourceLabel,
    readActive: readActive,
    setManual: setManual,
    applyAuto: applyAuto,
    fetchList: fetchList,
    probe: probe,
    probeMessage: probeMessage,
    statusOf: statusOf
  };
})();
