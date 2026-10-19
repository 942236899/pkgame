/* ============================================================
 * net.js —— 房间 / 联机（邀请好友）
 * 联机基于 WebRTC(PeerJS) 公共信令服务器，房主为权威端：
 *   房主运行完整引擎，把每个玩家的"视图"下发；其他玩家只上报操作。
 * 若联机服务不可用，自动降级为本地 AI 填充（游戏仍可正常进行）。
 * ============================================================ */
(function (global) {
  'use strict';

  var Net = {
    mode: 'local',      // local | host | guest
    code: '',
    mySeat: 0,
    peer: null,
    conns: {},          // host: seat -> conn ; guest: {host: conn}
    seatTaken: {},
    onMessage: null,    // function(msg, fromSeat)
    onJoin: null,       // host: function(seat, info)
    onStatus: null,     // function(text)
    available: false
  };

  function status(t) { if (Net.onStatus) Net.onStatus(t); }

  var PEER_CDN = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

  function loadPeer(cb) {
    if (global.Peer) { Net.available = true; return cb(null); }
    status('正在连接联机服务…');
    var s = document.createElement('script');
    s.src = PEER_CDN;
    s.crossOrigin = 'anonymous';
    var done = false;
    s.onload = function () {
      done = true;
      Net.available = !!global.Peer;
      cb(Net.available ? null : new Error('PeerJS 未加载'));
    };
    s.onerror = function () {
      if (done) return;
      done = true;
      cb(new Error('无法加载联机组件'));
    };
    document.head.appendChild(s);
    setTimeout(function () {
      if (!done) { done = true; cb(new Error('联机服务超时')); }
    }, 8000);
  }

  function roomId(code) {
    return ('pkzmtdy-' + String(code).toUpperCase()).replace(/[^A-Z0-9-]/g, '');
  }

  /* ---------------- 创建房间（房主） ---------------- */
  Net.createRoom = function (code, cb) {
    Net.code = code;
    loadPeer(function (err) {
      if (err) { Net.mode = 'local'; return cb(err); }
      try {
        Net.peer = new Peer(roomId(code), { debug: 0 });
      } catch (e) {
        Net.mode = 'local';
        return cb(e);
      }
      Net.peer.on('open', function () {
        Net.mode = 'host';
        Net.mySeat = 0;
        Net.seatTaken[0] = true;
        status('房间已创建');
        cb(null);
      });
      Net.peer.on('connection', function (conn) {
        conn.on('open', function () {
          // 分配座位 1..3
          var seat = -1;
          for (var i = 1; i <= 3; i++) {
            if (!Net.seatTaken[i]) { seat = i; break; }
          }
          if (seat < 0) {
            conn.send({ type: 'full' });
            conn.close();
            return;
          }
          Net.seatTaken[seat] = true;
          Net.conns[seat] = conn;
          conn.send({ type: 'welcome', seat: seat });
          conn.on('data', function (msg) {
            if (msg && msg.type === 'join') {
              if (Net.onJoin) Net.onJoin(seat, msg);
            } else if (Net.onMessage) {
              Net.onMessage(msg, seat);
            }
          });
          conn.on('close', function () {
            Net.seatTaken[seat] = false;
            delete Net.conns[seat];
            status('有玩家离开了房间');
          });
        });
      });
      Net.peer.on('error', function (e) {
        status('联机异常：' + (e && e.type ? e.type : '未知'));
      });
    });
  };

  /* ---------------- 加入房间 ---------------- */
  Net.joinRoom = function (code, cb) {
    Net.code = code;
    loadPeer(function (err) {
      if (err) { Net.mode = 'local'; return cb(err); }
      try {
        Net.peer = new Peer({ debug: 0 });
      } catch (e) {
        Net.mode = 'local';
        return cb(e);
      }
      Net.peer.on('open', function () {
        status('正在加入房间…');
        var conn = Net.peer.connect(roomId(code), { reliable: true });
        Net.conns.host = conn;
        var ok = false;
        conn.on('open', function () {
          conn.send({ type: 'join', name: (global.App && App.myName) || '玩家' });
        });
        conn.on('data', function (msg) {
          if (!msg) return;
          if (msg.type === 'welcome') {
            ok = true;
            Net.mode = 'guest';
            Net.mySeat = msg.seat;
            status('已加入房间');
            cb(null, msg.seat);
            return;
          }
          if (msg.type === 'full') {
            cb(new Error('房间已满'));
            conn.close();
            return;
          }
          if (Net.onMessage) Net.onMessage(msg, -1);
        });
        conn.on('error', function () {
          if (!ok) cb(new Error('连接失败'));
        });
        conn.on('close', function () {
          status('与房主断开连接');
        });
        setTimeout(function () {
          if (!ok) cb(new Error('加入房间超时'));
        }, 10000);
      });
      Net.peer.on('error', function (e) {
        if (!Net.peer || Net.mode !== 'guest') cb(new Error('联机异常：' + (e && e.type ? e.type : '')));
      });
    });
  };

  /* ---------------- 收发 ---------------- */
  Net.sendToHost = function (msg) {
    if (Net.mode === 'guest' && Net.conns.host && Net.conns.host.open) {
      Net.conns.host.send(msg);
    }
  };

  Net.sendTo = function (seat, msg) {
    var c = Net.conns[seat];
    if (c && c.open) c.send(msg);
  };

  Net.broadcast = function (msg) {
    for (var k in Net.conns) {
      var c = Net.conns[k];
      if (c && c.open) c.send(msg);
    }
  };

  Net.close = function () {
    Net._connSeq = (Net._connSeq || 0) + 1;   // 取消还没做完的连接重试
    try { Net.stopHeartbeat(); } catch (e) { }
    try {
      if (Net.ws) Net.ws.close();
    } catch (e) { }
    Net.ws = null;
    try {
      if (Net.peer) Net.peer.destroy();
    } catch (e) { }
    Net.peer = null;
    Net.conns = {};
    Net.seatTaken = {};
    Net.mode = 'local';
  };

  /* ==========================================================
   * 自建服务器联机（WebSocket）—— 局域网 / 公网部署都走这里
   * 服务器权威：引擎与电脑玩家都在服务器上跑，客户端只上报操作
   * ========================================================== */
  Net.serverBase = '';

  /* ---------------- 地址规范化 ----------------
   * 手机上手输地址很容易出现这些情况：
   *   · 中文输入法打出全角「：」「／」
   *   · 只填了 IP，没写 http://
   *   · 只填了 IP，没写端口
   *   · 结尾多一个 /
   * 这里统一修掉，避免「看起来没错但就是连不上」。 */
  Net.normalizeBase = function (v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    s = s.replace(/：/g, ':').replace(/／/g, '/').replace(/．/g, '.').replace(/[\s\u3000]+/g, '');
    s = s.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    s = s.replace(/\/+$/, '');          // 先去掉结尾多余的斜杠，避免影响端口判断
    var hadScheme = /^https?:\/\//i.test(s);
    if (!hadScheme) {
      // 只写了 IP / 域名（可能带端口）：默认端口 8080
      if (/^[^\/]+$/.test(s) && !/:\d+$/.test(s) && s.charAt(0) !== '[') s += ':8080';
      s = 'http://' + s;
    }
    return s;
  };

  /* 是否运行在打包 App（安卓 / iOS）里：此时页面来自本地 https://localhost，
   * 不能把 location 当成"服务器地址"，否则会去连一个根本不存在的本机服务器。 */
  Net.isApp = function () {
    try {
      if (global.Capacitor && typeof global.Capacitor.isNativePlatform === 'function') {
        return !!global.Capacitor.isNativePlatform();
      }
      if (global.Capacitor && global.Capacitor.platform && global.Capacitor.platform !== 'web') return true;
    } catch (e) { }
    return /^(localhost|127\.0\.0\.1)$/i.test(location.hostname || '') &&
      location.protocol === 'https:' && !!(global.Capacitor);
  };

  Net.serverUrl = function (base) {
    var b = Net.normalizeBase(base);
    if (!b) {
      if (Net.isApp()) return '';                  // App 内必须显式填服务器地址
      b = location.protocol + '//' + location.host;
    }
    return b.replace(/\/+$/, '');
  };

  function wsUrlOf(base) {
    var u = String(base).replace(/^http/i, 'ws');
    if (!/^wss?:\/\//i.test(u)) u = 'ws://' + u;
    return u.replace(/\/+$/, '') + '/ws';
  }

  /* ---------------- 心跳 ----------------
   * 1Mbps 外网 + 手机 4G 时，链路经常「没断但很久没数据」。
   * 25 秒一次 ping，90 秒收不到任何回包才认定断线，
   * 既不会误杀慢速连接，也能让 NAT 别回收空闲连接。 */
  Net.lastRecv = 0;
  Net._hb = null;

  function startHeartbeat() {
    Net.stopHeartbeat();
    Net.lastRecv = Date.now();
    Net._hb = setInterval(function () {
      if (!Net.ws || Net.ws.readyState !== 1) return;
      if (Date.now() - Net.lastRecv > 90000) {
        try { Net.ws.close(); } catch (e) { }
        return;
      }
      Net.sendWS({ type: 'ping', t: Date.now() });
    }, 25000);
  }
  Net.stopHeartbeat = function () {
    if (Net._hb) { clearInterval(Net._hb); Net._hb = null; }
  };

  /* ---------------- 连接服务器 ----------------
   * 针对慢速外网（1Mbps / 4G / 跨境线路）：
   *   · 单次超时 25 秒，失败重试 3 次（间隔 1.5s / 3s），总窗口 ~80 秒
   *   · 握手期间并行探测 HTTP /api/status，用来区分「连不上」和「WebSocket 被挡」
   *   · 成功后记录握手耗时 Net.linkMs，界面会提示"网络较慢"
   *   · App 内没填服务器地址时直接给出可操作的提示，不去连 localhost */
  var CONN_TIMEOUT = 25000;
  var CONN_TRIES = 3;

  /* 轻量 HTTP 探测：判断服务器是否"网页能打开"，用于错误定位 */
  Net.probeHttp = function (base, cb, timeout) {
    var b = Net.serverUrl(base);
    var t0 = Date.now();
    var done = false;
    var ctrl = null;
    try { if (typeof AbortController !== 'undefined') ctrl = new AbortController(); } catch (e) { }

    var timer = setTimeout(function () {
      finish({ ok: false, ms: Date.now() - t0, error: 'timeout' });
    }, timeout || 20000);

    function finish(r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (ctrl) ctrl.abort(); } catch (e) { }
      cb(r);
    }

    if (!b || !global.fetch) { finish({ ok: false, ms: 0, error: 'no-fetch' }); return; }
    try {
      global.fetch(b + '/api/status', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (res) {
          return res.text().then(function (txt) {
            var j = null;
            try { j = JSON.parse(txt); } catch (e) { }
            finish({ ok: res.status === 200 && !!j && !!j.ok, ms: Date.now() - t0, status: res.status, info: j });
          });
        })
        .catch(function (e) {
          finish({ ok: false, ms: Date.now() - t0, error: (e && e.name === 'AbortError') ? 'timeout' : 'neterr' });
        });
    } catch (e) {
      finish({ ok: false, ms: 0, error: 'neterr' });
    }
  };

  Net.connectServer = function (base, cb) {
    if (typeof base === 'function') { cb = base; base = ''; }
    Net.serverBase = Net.serverUrl(base);

    if (!Net.serverBase) {
      setTimeout(function () {
        cb(new Error('还没有填服务器地址。请填电脑上服务器的地址，例如 192.168.1.8:8080 或 1.2.3.4:8080'));
      }, 0);
      return;
    }

    Net._connSeq = (Net._connSeq || 0) + 1;
    var seq = Net._connSeq;
    var url = wsUrlOf(Net.serverBase);
    var attempt = 0;
    var lastErr = null;
    var httpHint = null;       // 握手期间顺手探测的 HTTP 结果

    function finish(err) {
      if (!cb) return;
      var f = cb;
      cb = null;
      f(err || null);
    }

    function fail(msg) {
      lastErr = msg instanceof Error ? msg : new Error(msg);
      next();
    }

    function next() {
      if (seq !== Net._connSeq) return;              // 已被新的连接请求取代
      if (attempt >= CONN_TRIES) { explain(); return; }
      var wait = attempt === 0 ? 0 : 1500 * attempt;
      if (wait > 0 && Net.onStatus) {
        Net.onStatus('连接不上，' + (wait / 1000).toFixed(1) + ' 秒后自动重试（第 ' + (attempt + 1) + '/' + CONN_TRIES + ' 次）…');
      }
      setTimeout(tryOnce, wait);
    }

    /* 三次都失败：用 HTTP 探测结果给出可执行的判断，而不是一句"连不上" */
    function explain() {
      if (seq !== Net._connSeq) return;
      if (httpHint) return finish(buildErr(httpHint));
      Net.probeHttp(Net.serverBase, function (h) {
        httpHint = h;
        finish(buildErr(h));
      }, 7000);
    }

    function buildErr(h) {
      var detail = lastErr ? lastErr.message : '无法连接服务器';
      if (h && h.ok) {
        return new Error('网页能打开，但 WebSocket 连不上。多为代理 / 防火墙没放行 WebSocket（Upgrade），或上行带宽被占满。' +
          '（' + detail + '）');
      }
      if (h && h.status) {
        return new Error('服务器有响应但异常（HTTP ' + h.status + '）。请确认地址指向本游戏服务器。（' + detail + '）');
      }
      if (h && h.error === 'timeout') {
        return new Error('服务器响应超时：1Mbps 上行时首次加载较慢，请稍后重试；同时检查路由器端口映射与 Windows 防火墙。（' + detail + '）');
      }
      return new Error('连不上服务器：请检查地址、端口、端口映射和防火墙。（' + detail + '）');
    }

    function tryOnce() {
      if (seq !== Net._connSeq) return;
      attempt++;

      // 第一次尝试时并行探测 HTTP：不额外增加等待时间
      if (attempt === 1) {
        Net.probeHttp(Net.serverBase, function (h) { httpHint = h; }, 12000);
      }

      var settled = false;
      var ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return fail(new Error('地址格式不正确：' + Net.serverBase));
      }
      Net.ws = ws;

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (e) { }
        fail(new Error('连接超时（' + (CONN_TIMEOUT / 1000) + ' 秒没有响应）'));
      }, CONN_TIMEOUT);

      ws.onopen = function () {
        if (settled) { try { ws.close(); } catch (e) { } return; }
        settled = true;
        clearTimeout(timer);
        Net.mode = 'ws';
        Net.lastRecv = Date.now();
        Net.linkMs = Date.now() - (Net._tryStart || Date.now());
        startHeartbeat();
        finish(null);
      };

      ws.onmessage = function (e) {
        Net.lastRecv = Date.now();
        var msg = null;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (!msg) return;
        if (msg.type === 'pong') {
          if (msg.t) Net.rtt = Math.max(0, Date.now() - msg.t);
          return;
        }
        try { if (Net.onWSMessage) Net.onWSMessage(msg); }
        catch (err) { if (global.console) console.error(err); }
      };

      ws.onerror = function () { /* 具体原因统一在 onclose 里判断 */ };

      ws.onclose = function (ev) {
        clearTimeout(timer);
        Net.stopHeartbeat();
        Net.mode = 'local';

        if (!settled) {
          settled = true;
          var code = ev && ev.code;
          fail(new Error(code === 1006 || !code
            ? '连不上（地址不通 / 端口没开放 / 被防火墙拦截）'
            : '连接被服务器关闭（代码 ' + code + '）'));
          return;
        }
        if (Net.onWSClose) Net.onWSClose(ev);
      };
    }

    Net._tryStart = Date.now();
    next();
  };

  /* 连接测试：用一条临时连接验证地址是否可达，不影响正在进行的对局
   * 慢速网络下 15 秒并不够：1Mbps 上行 + 高 RTT，握手经常要 3–8 秒，
   * 偶尔排队就超过 15 秒。这里放宽到 25 秒，并在失败时给出 HTTP 探测结论。 */
  Net.probe = function (base, cb) {
    var b = Net.serverUrl(base);
    if (!b) { cb(new Error('请先填服务器地址')); return; }
    var url;
    try {
      url = wsUrlOf(b);
    } catch (e) {
      return cb(new Error('地址格式不正确'));
    }
    var t0 = Date.now();
    var done = false;
    var ws;
    try { ws = new WebSocket(url); }
    catch (e) { return cb(new Error('地址格式不正确')); }

    function finish(err, r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) { }
      cb(err || null, r || null);
    }

    var timer = setTimeout(function () {
      if (done) return;
      // 超时也别只报"超时"：补一次 HTTP 探测，告诉用户是服务器没响应还是 WS 被挡
      Net.probeHttp(b, function (h) {
        if (h && h.ok) {
          finish(new Error('页面能打开，但 WebSocket 握手超时：多为上行带宽被占满或代理不支持 WebSocket，稍后重试即可'));
        } else if (h && h.error === 'timeout') {
          finish(new Error('服务器 25 秒没有响应：1Mbps 上行时首次握手较慢，请再测一次；' +
            '持续如此请检查端口映射、防火墙是否放行 8080'));
        } else {
          finish(new Error('超时（25 秒没有握手成功）：地址不通 / 端口没开放 / 被防火墙拦截'));
        }
      }, 7000);
    }, 25000);

    ws.onopen = function () {
      var ms = Date.now() - t0;
      finish(null, { ms: ms, url: url, base: b });
    };
    ws.onerror = function () { };
    ws.onclose = function () {
      if (done) return;
      // WebSocket 失败时补一次 HTTP 探测，区分「服务器没开」和「只是 WS 被挡」
      Net.probeHttp(b, function (h) {
        if (h && h.ok) {
          finish(new Error('网页能打开，但 WebSocket 被拦截：请检查代理 / 防火墙是否允许 WebSocket（Upgrade）'));
        } else if (h && h.error === 'timeout') {
          finish(new Error('服务器响应超时：请检查上行带宽是否被占满、端口映射是否正确'));
        } else {
          finish(new Error('连不上（地址不通 / 端口没开放 / 被防火墙拦截）'));
        }
      }, 8000);
    };
  };

  Net.sendWS = function (obj) {
    if (Net.ws && Net.ws.readyState === 1) Net.ws.send(JSON.stringify(obj));
    else return false;
    return true;
  };

  Net.randomCode = function () {
    var s = 'ACDEFGHJKLMNPQRTUVWXY34679';
    var out = '';
    for (var i = 0; i < 4; i++) out += s[Math.floor(Math.random() * s.length)];
    return out;
  };

  Net.inviteUrl = function (code) {
    var base = location.href.split('?')[0].split('#')[0];
    return base + '?room=' + encodeURIComponent(code || Net.code);
  };

  global.Net = Net;
})(typeof window !== 'undefined' ? window : globalThis);
