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

  Net.serverUrl = function (base) {
    var b = base || Net.serverBase || (location.protocol + '//' + location.host);
    return b.replace(/\/+$/, '');
  };

  Net.connectServer = function (base, cb) {
    Net.serverBase = Net.serverUrl(base);
    var wsBase = Net.serverBase.replace(/^http/, 'ws');
    var done = false;
    var ws;
    try {
      ws = new WebSocket(wsBase + '/ws');
    } catch (e) {
      return cb(e);
    }
    Net.ws = ws;
    ws.onopen = function () {
      done = true;
      Net.mode = 'ws';
      cb(null);
    };
    ws.onmessage = function (e) {
      var msg = null;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (Net.onWSMessage) Net.onWSMessage(msg);
    };
    ws.onerror = function () {
      if (!done) { done = true; cb(new Error('无法连接服务器')); }
    };
    ws.onclose = function () {
      Net.mode = 'local';
      if (Net.onWSClose) Net.onWSClose();
    };
    setTimeout(function () {
      if (!done) { done = true; cb(new Error('连接服务器超时')); }
    }, 8000);
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
