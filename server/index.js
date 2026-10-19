/* ============================================================
 * TMH-谁是队友扑克游戏 —— 联机服务器
 *   · 静态托管前端页面（手机/电脑浏览器直接打开就能玩）
 *   · WebSocket 房间同步（服务器权威，电脑玩家也在服务器跑）
 *   · 可选 MySQL 8.0 落库（战绩 / 复盘）
 * 启动：node server/index.js  [--port 8080]
 * ============================================================ */
'use strict';

var http = require('http');
var path = require('path');
var fs = require('fs');
var os = require('os');
var express = require('express');
var WebSocketServer = require('ws').Server;

/* 前端静态根目录：优先用环境变量（Electron 打包端指向 resources/web），
 * 否则依次尝试项目根目录 / ../web / ../dist —— 保证 exe 里也能找到 index.html */
function resolveWebRoot() {
  var list = [];
  if (process.env.PKGAME_WEB_ROOT) list.push(process.env.PKGAME_WEB_ROOT);
  list.push(path.join(__dirname, '..'));            // 开发：项目根目录
  list.push(path.join(__dirname, '..', 'web'));     // 打包：resources/web
  list.push(path.join(__dirname, '..', 'dist'));    // 开发：build-web 产物
  list.push(path.join(process.cwd(), 'web'));
  for (var i = 0; i < list.length; i++) {
    try { if (fs.existsSync(path.join(list[i], 'index.html'))) return list[i]; } catch (e) { }
  }
  return list[0];
}
var ROOT = resolveWebRoot();
var CFG_FILE = process.env.PKGAME_CONFIG_FILE || path.join(__dirname, 'config.json');

/* ---------------- 配置 ---------------- */
var DEFAULT_CFG = {
  port: 8080,
  host: '0.0.0.0',
  db: { enabled: false, host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'tmh_poker' }
};

var config = loadConfig();
function loadConfig() {
  try {
    var raw = fs.readFileSync(CFG_FILE, 'utf8');
    var c = JSON.parse(raw);
    return Object.assign({}, DEFAULT_CFG, c, { db: Object.assign({}, DEFAULT_CFG.db, c.db || {}) });
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CFG));
  }
}
function saveConfig(c) {
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2), 'utf8'); return true; }
  catch (e) { return false; }
}

var argv = process.argv.slice(2);
for (var i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') config.port = Number(argv[i + 1]) || config.port;
  if (argv[i] === '--host') config.host = argv[i + 1] || config.host;
}

/* ---------------- 静态站点 ---------------- */
var app = express();

/* API 允许跨域：网页版可能从别的域名/端口连过来做「测试连接」诊断。
 * 只读接口 + 本机限制的关服接口，放开 CORS 没有副作用。 */
app.use('/api', function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  next();
});

/* ============================================================
 * 文本资源 gzip 压缩 + 协商缓存
 *
 * 背景：不少部署环境的公网上行只有 1Mbps（≈128 KB/s）。
 * 前端一共 175KB 左右，不压缩首屏要 1.5 秒以上，四个人同时进还会排队；
 * gzip 后约 52KB，0.4 秒左右。二次进入直接 304，只回几百字节。
 * 压缩结果按文件 mtime 缓存在内存里，不重复压。
 * ============================================================ */
var zlib = require('zlib');
var GZ_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};
var gzCache = {};
var GZ_ALLOW = /^(index\.html|manifest\.webmanifest|css\/|js\/|icons\/)/;

function serveTextFile(req, res, file, type) {
  var st;
  try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;

  var item = gzCache[file];
  if (!item || item.mtime !== st.mtimeMs) {
    var raw = fs.readFileSync(file);
    item = gzCache[file] = {
      mtime: st.mtimeMs,
      raw: raw,
      gz: null,
      etag: '"' + raw.length.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
    };
  }

  res.setHeader('ETag', item.etag);
  res.setHeader('Cache-Control', 'no-cache');   // 每次校验，改了文件立刻生效
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === item.etag) {
    res.statusCode = 304;
    res.end();
    return true;
  }

  var body = item.raw;
  if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
    if (!item.gz) item.gz = zlib.gzipSync(item.raw, { level: 9 });
    body = item.gz;
    res.setHeader('Content-Encoding', 'gzip');
  }
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', body.length);
  if (req.method === 'HEAD') { res.end(); return true; }
  res.end(body);
  return true;
}

app.use(function (req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  var rel = decodeURIComponent(req.path || '/').replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (!GZ_ALLOW.test(rel)) return next();
  var type = GZ_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return next();
  var file = path.join(ROOT, rel);
  if (file.indexOf(ROOT) !== 0) return next();
  if (serveTextFile(req, res, file, type)) return;
  next();
});

app.get('/', function (req, res) {
  var file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) {
    res.status(500).type('html').send(
      '<meta charset="utf-8"><body style="font:16px/1.8 Microsoft YaHei;padding:40px">' +
      '<h2>找不到游戏页面</h2><p>服务器已启动，但前端静态文件缺失：</p>' +
      '<pre style="background:#f3f3f3;padding:12px">' + file + '</pre>' +
      '<p>请确认 resources/web（或项目根目录）下有 index.html、css/、js/。</p></body>');
    return;
  }
  res.sendFile(file);
});
app.use('/css', express.static(path.join(ROOT, 'css')));
app.use('/js', express.static(path.join(ROOT, 'js')));
app.use('/icons', express.static(path.join(ROOT, 'icons')));

// PWA / 添加到主屏幕所需文件
app.get(['/manifest.webmanifest', '/manifest.json'], function (req, res) {
  res.type('application/manifest+json').sendFile(path.join(ROOT, 'manifest.webmanifest'), function (err) {
    if (err) res.status(404).end();
  });
});
app.get(['/favicon.ico', '/favicon.png'], function (req, res) {
  res.sendFile(path.join(ROOT, 'icons', 'favicon.ico'), function (err) {
    if (err) res.status(404).end();
  });
});

/* 服务器状态 API（给桌面控制台 / 运维用） */
var stats = { startedAt: Date.now(), connections: 0, rooms: 0, players: 0, games: 0 };
var VERSION = (function () {
  try { return require(path.join(__dirname, '..', 'package.json')).version || '1.0.0'; }
  catch (e) { try { return require('./package.json').version || '1.0.0'; } catch (e2) { return '1.0.0'; } }
})();

/* 运行日志环形缓冲：网页控制台 / 无窗口环境也能看到服务器在干什么 */
var LOGS = [];
function pushLogLine(line) {
  LOGS.push(line);
  if (LOGS.length > 300) LOGS.splice(0, LOGS.length - 300);
}

/* 只有本机（127.0.0.1 / ::1）才能停止服务，防止公网上被人一键关服 */
function isLocalReq(req) {
  var ip = (req.ip || (req.connection && req.connection.remoteAddress) || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

/* 网页版控制台（不依赖 Electron，用纯 Node 启动时访问 /admin） */
app.get(['/admin', '/admin.html'], function (req, res) {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/status', function (req, res) {
  res.json({
    ok: true,
    name: 'TMH-谁是队友扑克游戏',
    version: VERSION,
    mode: process.versions.electron ? 'electron' : 'node',
    node: process.versions.node,
    platform: process.platform + ' ' + (os.release ? os.release() : ''),
    startedAt: stats.startedAt,
    rooms: rooms ? Object.keys(rooms).length : 0,
    players: countPlayers(),
    games: stats.games,
    db: db.status()
  });
});
app.get('/api/rooms', function (req, res) {
  var list = Object.keys(rooms).map(function (c) { return roomBrief(rooms[c]); });
  res.json({ ok: true, rooms: list });
});
app.get('/api/lan', function (req, res) {
  res.json({ ok: true, addresses: lanAddresses(), port: config.port });
});
app.get('/api/config', function (req, res) {
  res.json({ ok: true, config: { port: config.port, host: config.host, db: config.db } });
});
app.post('/api/config', express.json(), function (req, res) {
  var b = req.body || {};
  if (b.db) {
    config.db = Object.assign({}, config.db, b.db);
    db.enable(config.db).then(function (r) { res.json({ ok: r.ok, msg: r.msg, saved: saveConfig(config) }); });
    return;
  }
  res.json({ ok: false, msg: '仅支持修改 db 配置（端口需重启生效）' });
});
app.post('/api/db/test', express.json(), function (req, res) {
  db.test(Object.assign({}, config.db, req.body || {})).then(function (r) { res.json(r); });
});

/* 运行日志（最近 200 行） */
app.get('/api/logs', function (req, res) {
  res.json({ ok: true, logs: LOGS.slice(-200) });
});

/* 网页控制台改端口：写入 config.json，重启后生效（不在运行中切换，避免把玩家踢掉） */
app.post('/api/port', express.json(), function (req, res) {
  var p = Number((req.body || {}).port);
  if (!(p >= 1 && p <= 65535)) { res.json({ ok: false, msg: '端口需为 1–65535 之间的整数' }); return; }
  config.port = p;
  var saved = saveConfig(config);
  log('端口已改为 ' + p + '（重启后生效）');
  res.json({ ok: true, saved: saved, port: p, msg: '已保存为 ' + p + '，重启服务器后生效' });
});

/* 停止服务器：只允许本机操作。无窗口环境（Node 直接启动）会直接退出进程 */
app.post('/api/shutdown', function (req, res) {
  if (!isLocalReq(req)) { res.status(403).json({ ok: false, msg: '只能在服务器本机操作' }); return; }
  res.json({ ok: true, msg: '服务器正在停止…' });
  setTimeout(function () {
    try {
      if (typeof module.exports.onShutdown === 'function') { module.exports.onShutdown(); return; }
      stop(function () { process.exit(0); });
      setTimeout(function () { process.exit(0); }, 1500);
    } catch (e) { process.exit(0); }
  }, 260);
});

/* ---------------- 房间 ---------------- */
var RoomMod = require('./lib/room.js');
var Room = RoomMod.Room;
var db = require('./lib/db.js');
var rooms = {};

function countPlayers() {
  var n = 0;
  Object.keys(rooms).forEach(function (c) { n += rooms[c].humanCount(); });
  return n;
}
function roomBrief(r) {
  var g = r.game;
  return {
    code: r.code,
    players: r.humanCount(),
    seats: r.seats.map(function (s) { return s ? { name: s.name, isAI: !!s.isAI, offline: !!s.offline, trustee: !!s.trustee } : null; }),
    started: r.started,
    locked: !!r.started,          // 已开局的房间不再接受新玩家
    round: g ? g.round : 0,
    phase: g ? g.phase : 'wait',
    turn: g ? g.turn : -1,
    firstLeader: g ? g.firstLeader : -1,
    leaderReason: g ? g.leaderReason : '',
    turnLeft: (r.turnSeat === (g ? g.turn : -1) && r.turnEndAt) ? Math.max(0, r.turnEndAt - Date.now()) : 0
  };
}

function newCode() {
  var s = 'ACDEFGHJKLMNPQRTUVWXY34679';
  var out = '';
  do {
    out = '';
    for (var i = 0; i < 4; i++) out += s[Math.floor(Math.random() * s.length)];
  } while (rooms[out]);
  return out;
}

function findQuickRoom() {
  var keys = Object.keys(rooms);
  for (var i = 0; i < keys.length; i++) {
    var r = rooms[keys[i]];
    if (!r.started && r.humanCount() < 4) return r;
  }
  return null;
}

/** 解散房间：通知其他人回联机页，房主收到 dissolved 后可以立刻重建 */
function dissolveRoom(room, hostSeat) {
  var code = room.code;
  for (var i = 0; i < 4; i++) {
    if (i === hostSeat) continue;
    room.sendTo(i, { type: 'roomClosed', msg: '房主解散了房间，请回联机页重新加入' });
  }
  room.sendTo(hostSeat, { type: 'dissolved', code: code });
  if (rooms[code] === room) delete rooms[code];
  log('房间 ' + code + ' 已解散（房主座位 ' + hostSeat + '）');
}

/* ---------------- WebSocket ---------------- */
var server = http.createServer(app);
var wss = null;
var hbTimer = null;

function ensureWss() {
  if (wss) return wss;
  /* perMessageDeflate：把每手牌的状态包压掉六成左右。
   * 1Mbps 外网 + 手机流量下，这个开关能明显减少卡顿。 */
  wss = new WebSocketServer({
    server: server,
    path: '/ws',
    perMessageDeflate: {
      threshold: 256,
      zlibDeflateOptions: { level: 6, memLevel: 7 }
    },
    maxPayload: 1024 * 1024
  });
  wss.on('connection', onConnection);
  wss.on('error', function (e) { log('WebSocket 异常：' + e.message); });

  /* 探活：手机锁屏 / 拔网线时浏览器往往不会发 close，
   * 只靠 TCP 可能几分钟才发现。这里每 15 秒 ping 一次，
   * 上一轮没有 pong 就直接断开 → 立刻触发托管。 */
  clearInterval(hbTimer);
  hbTimer = setInterval(function () {
    if (!wss) return;
    wss.clients.forEach(function (c) {
      if (c.isAlive === false) { try { c.terminate(); } catch (e) { } return; }
      c.isAlive = false;
      try { c.ping(); } catch (e) { }
    });
  }, 15000);
  if (hbTimer.unref) hbTimer.unref();
  return wss;
}

function onConnection(ws) {
  stats.connections++;
  var seat = -1;
  var room = null;
  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });

  ws.on('message', function (raw) {
    var msg = null;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg) return;

    /* 心跳：客户端每 25 秒发一次。慢速网络下用来区分「网络慢」和「真的断了」，
     * 也顺便让中间的 NAT / 路由器别把空闲连接回收掉。 */
    if (msg.type === 'ping') {
      ws.isAlive = true;
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong', t: msg.t || 0 }));
      return;
    }

    handle(ws, msg, function (r, s) { room = r; seat = s; });
  });

  ws.on('close', function () {
    stats.connections--;
    if (room && seat >= 0) {
      // 保留座位 10 分钟：断线重连能回到原位，期间由系统托管
      room.disconnect(seat);
      if (room.isEmpty()) {
        var code = room.code;
        var target = room;
        setTimeout(function () {
          if (rooms[code] === target && target.isEmpty()) {
            delete rooms[code];
            log('房间 ' + code + ' 已回收');
          }
        }, 120000);
      }
    }
  });

  ws.on('error', function () { });

  function reply(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  ws.__reply = reply;
}

function handle(ws, msg, bind) {
  var reply = ws.__reply;

  /* 断线重连：浏览器刷新、手机切后台回来、Wi-Fi 抖动，都走这里回原座位 */
  if (msg.type === 'resume') {
    var rc = String(msg.code || '').toUpperCase();
    var rr = rooms[rc];
    if (!rr) { reply({ type: 'resumeFail', msg: '房间已关闭' }); return; }
    var rs = rr.resume(ws, msg.token);
    if (rs === -2) {
      /* v1.3.4：本局进行中不接受回座。掉线玩家的座位已由系统托管打完本局，
       * 中途放回来会打断出牌顺序，所以明确拒绝并说明什么时候能回来。 */
      reply({
        type: 'resumeFail', code: 'INGAME',
        msg: '本局游戏还在进行中，暂时不能回到座位（你的牌已由系统托管）。等这一局结束、房主重新建房后再加入。'
      });
      return;
    }
    if (rs < 0) { reply({ type: 'resumeFail', msg: '座位已释放，请重新加入房间' }); return; }
    bind(rr, rs);
    reply({ type: 'hello', seat: rs, code: rc, token: rr.seats[rs].token, resumed: true });
    rr.broadcastRoom();
    rr.broadcastState();
    log((rr.seats[rs].name || '玩家') + ' 断线重连成功（房间 ' + rc + '）');
    return;
  }

  if (msg.type === 'create') {
    var code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    // 房间码必须唯一：客户端自带的码撞车时改由服务器重新分配，绝不覆盖已有房间
    if (!code || rooms[code]) code = newCode();
    var r = new Room(code);
    rooms[code] = r;
    var s = r.addPlayer(ws, msg.name, msg.avatar);
    if (s < 0) { delete rooms[code]; reply({ type: 'error', code: 'ROOMFULL', msg: '房间已满' }); return; }
    r.hostSeat = s;
    bind(r, s);
    reply({ type: 'hello', seat: s, code: code, token: r.seats[s].token, isHost: true });
    reply({ type: 'room', code: code, isHost: true, seats: r.roomInfo(s).seats });
    r.broadcastRoom();
    log('创建房间 ' + code);
    return;
  }

  if (msg.type === 'join') {
    var code2 = String(msg.code || '').toUpperCase();
    var r2 = rooms[code2];
    if (!r2) { reply({ type: 'error', code: 'NOROOM', msg: '房间 ' + (code2 || '') + ' 不存在（可能已解散，请让房主重新建房）' }); return; }
    /* v1.3.3：已开局的房间不再放人进来。
     * 否则新玩家会坐进一个正在打（由电脑代打）的座位，还会弹"等待开始"的房间页挡住牌桌。 */
    if (r2.started) {
      reply({
        type: 'error', code: 'INGAME',
        msg: '房间 ' + code2 + ' 正在游戏中，暂时不能加入。等这一局结束、房主重新建房后再邀请你。'
      });
      log('拒绝加入：房间 ' + code2 + ' 正在游戏中');
      return;
    }
    var s2 = r2.addPlayer(ws, msg.name, msg.avatar);
    if (s2 === -2) { reply({ type: 'error', code: 'INGAME', msg: '房间 ' + code2 + ' 已经开始，正在游戏中' }); return; }
    if (s2 < 0) { reply({ type: 'error', code: 'ROOMFULL', msg: '房间已满（4 人）' }); return; }
    bind(r2, s2);
    reply({ type: 'hello', seat: s2, code: code2, token: r2.seats[s2].token });
    r2.broadcastRoom();
    log((msg.name || '玩家') + ' 加入房间 ' + code2);
    return;
  }

  if (msg.type === 'quick') {
    var r3 = findQuickRoom();
    if (!r3) {
      r3 = new Room(newCode());
      rooms[r3.code] = r3;
      var s3 = r3.addPlayer(ws, msg.name, msg.avatar);
      if (s3 === -2) { reply({ type: 'error', code: 'INGAME', msg: '房间刚刚开局，请再点一次快速匹配' }); return; }
      r3.hostSeat = s3;
      bind(r3, s3);
      reply({ type: 'hello', seat: s3, code: r3.code, token: r3.seats[s3].token, isHost: true });
      r3.broadcastRoom();
      log('快速匹配：新建房间 ' + r3.code);
      return;
    }
    var s4 = r3.addPlayer(ws, msg.name, msg.avatar);
    if (s4 === -2) { reply({ type: 'error', code: 'INGAME', msg: '该房间刚开始，请再点一次快速匹配' }); return; }
    if (s4 < 0) { reply({ type: 'error', code: 'ROOMFULL', msg: '房间已满，请再点一次快速匹配' }); return; }
    bind(r3, s4);
    reply({ type: 'hello', seat: s4, code: r3.code, token: r3.seats[s4].token });
    r3.broadcastRoom();
    log((msg.name || '玩家') + ' 快速匹配进入 ' + r3.code);
    return;
  }

  // 以下消息需要已绑定房间
  var myRoom = null, mySeat = -1;
  Object.keys(rooms).forEach(function (c) {
    var rr = rooms[c];
    for (var i = 0; i < 4; i++) {
      if (rr.seats[i] && rr.seats[i].ws === ws) { myRoom = rr; mySeat = i; }
    }
  });
  if (!myRoom) { reply({ type: 'error', msg: '尚未加入房间' }); return; }

  /* v1.3.3：解散房间（房主）
   * 房间是一次性的：一局开始后就不再放人进来；想换人玩就解散重建，
   * 建房后拿到新的 4 位房间码再邀请。 */
  if (msg.type === 'dissolve') {
    if (mySeat !== myRoom.hostSeat) {
      reply({ type: 'error', msg: '只有房主可以解散房间' });
      return;
    }
    dissolveRoom(myRoom, mySeat);
    bind(null, -1);
    return;
  }

  if (msg.type === 'leave') {
    myRoom.removePlayer(mySeat);
    if (myRoom.isEmpty()) delete rooms[myRoom.code];
    return;
  }

  /* v1.3.5：改名。座位名和牌桌上的名字一起改，其他人立刻看到。
   * 游戏中也能改（broadcastRoom 在开局后是静默的，不会弹房间页）。 */
  if (msg.type === 'rename') {
    var newName = String(msg.name || '').trim().slice(0, 8);
    if (!newName) { reply({ type: 'error', msg: '昵称不能为空' }); return; }
    var rst = myRoom.seats[mySeat];
    if (rst && !rst.isAI) {
      var oldName = rst.name;
      rst.name = newName;
      if (myRoom.game && myRoom.game.players[mySeat]) myRoom.game.players[mySeat].name = newName;
      myRoom.broadcastState();
      myRoom.broadcastRoom();
      log('改名（房间 ' + myRoom.code + '）：' + oldName + ' → ' + newName);
    }
    return;
  }

  myRoom.onMessage(mySeat, msg);

  // 一局结束时落库
  if (msg.type === 'act' || msg.type === 'start' || msg.type === 'next') {
    if (myRoom.game && myRoom.game.phase === 'over' && !myRoom.__savedRound) {
      myRoom.__savedRound = myRoom.game.round;
      stats.games++;
      persist(myRoom);
    }
    if (myRoom.game && myRoom.game.phase !== 'over') myRoom.__savedRound = 0;
  }
}

function persist(room) {
  var g = room.game;
  if (!g) return;
  var seats = g.players.map(function (p, i) {
    var s = room.seats[i];
    return {
      name: p.name,
      isAI: !s || s.isAI,
      place: p.place,
      team: g.teamOf(i),
      hand: []
    };
  });
  var actions = (g._history || []).map(function (h) {
    return { seat: h.seat, action: 'play', cards: h.cards };
  });
  db.saveGame({
    roomCode: room.code,
    winnerSeat: g.finishOrder[0],
    soloSeat: g.soloSeat,
    startedAt: new Date(Date.now() - 60000),
    seats: seats,
    actions: actions
  }).then(function (id) { if (id) log('已写入 MySQL，对局 #' + id); });
}

/* ---------------- 局域网地址 ---------------- */
function lanAddresses() {
  var out = [];
  var ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (k) {
    (ifs[k] || []).forEach(function (f) {
      if (f.family === 'IPv4' && !f.internal) out.push(f.address);
    });
  });
  return out;
}

/* ---------------- 启动 ---------------- */
var listening = false;   // 是否已成功监听
var starting = false;    // 是否正在启动（防止重复 listen）

function log(s) {
  var t = new Date().toTimeString().slice(0, 8);
  var line = '[' + t + '] ' + s;
  console.log(line);
  pushLogLine(line);
  if (typeof module.exports.onLog === 'function') module.exports.onLog(line);
}

function info() {
  return { port: config.port, host: config.host, addresses: lanAddresses(), webRoot: ROOT };
}

function start(cb) {
  var done = false;
  function finish(err, data) {
    if (done) return;
    done = true;
    if (cb) cb(err || null, data || null);
  }

  if (listening) { setTimeout(function () { finish(null, info()); }, 0); return; }
  if (starting) { setTimeout(function () { finish(new Error('服务器正在启动中，请稍候…')); }, 0); return; }

  starting = true;
  var port = config.port;
  var host = config.host;

  // 关键：错误监听必须在 listen 之前挂上，并且 listen 本身也要 try/catch。
  // 否则端口被占用时 Node 会直接抛 EADDRINUSE，Electron 主进程就弹出
  // "A JavaScript error occurred in the main process" 并闪退。
  function onListenError(e) {
    server.removeListener('error', onListenError);
    server.removeListener('listening', onListening);
    starting = false;
    listening = false;
    var msg = (e && e.code === 'EADDRINUSE')
      ? ('端口 ' + port + ' 已被占用')
      : ('启动失败：' + (e && e.message ? e.message : e));
    log(msg);
    finish(e || new Error(msg));
  }

  function onListening() {
    server.removeListener('error', onListenError);
    server.on('error', function (e) { log('服务器异常：' + e.message); });
    starting = false;
    listening = true;
    stats.startedAt = Date.now();
    ensureWss();
    var addrs = lanAddresses();
    log('TMH-谁是队友扑克游戏 · 服务器已启动（端口 ' + port + '）');
    log('本机访问：  http://127.0.0.1:' + port);
    addrs.forEach(function (a) { log('局域网访问：http://' + a + ':' + port); });
    log('页面目录：' + ROOT);
    db.enable(config.db).then(function (r) {
      log('MySQL：' + (r.ok ? r.msg : (r.msg === '未启用' ? '未启用（仅内存，不落库）' : ('未启用（' + r.msg + '）'))));
      finish(null, { port: port, addresses: addrs, webRoot: ROOT });
    }).catch(function () {
      finish(null, { port: port, addresses: addrs, webRoot: ROOT });
    });
  }

  server.once('error', onListenError);
  server.once('listening', onListening);

  try {
    server.listen(port, host);
  } catch (e) {
    server.removeListener('error', onListenError);
    server.removeListener('listening', onListening);
    starting = false;
    listening = false;
    log('启动失败：' + e.message);
    finish(e);
  }
}

function stop(cb) {
  var done = false;
  function finish() { if (done) return; done = true; if (cb) cb(); }

  try { clearInterval(hbTimer); hbTimer = null; } catch (e) { }
  try { if (wss) { wss.close(); wss = null; } } catch (e) { }
  if (!listening) { listening = false; setTimeout(finish, 0); return; }

  listening = false;
  try {
    server.close(function () { log('服务器已停止'); finish(); });
    setTimeout(finish, 2500); // 兜底：还有长连接时不让界面卡住
  } catch (e) { finish(); }
}

/* 探测某个端口上是不是「本游戏」的服务器（用于两个 exe 同时打开时复用实例） */
function probe(port, cb) {
  var http = require('http');
  var req = http.get({ host: '127.0.0.1', port: port, path: '/api/status', timeout: 900 }, function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { body += d; });
    res.on('end', function () {
      try {
        var j = JSON.parse(body);
        cb(!!(j && j.ok && /TMH|谁是队友/.test(j.name || '')), j);
      } catch (e) { cb(false, null); }
    });
  });
  req.on('timeout', function () { req.destroy(); cb(false, null); });
  req.on('error', function () { cb(false, null); });
}

module.exports = {
  start: start,
  stop: stop,
  probe: probe,
  log: log,
  config: config,
  version: VERSION,
  logs: function () { return LOGS.slice(-200); },
  webRoot: ROOT,
  isRunning: function () { return listening; },
  saveConfig: saveConfig,
  loadConfig: loadConfig,
  setConfig: function (c) { config = Object.assign({}, config, c); },
  lanAddresses: lanAddresses,
  rooms: function () { return rooms; },
  stats: stats
};

if (require.main === module) start();
