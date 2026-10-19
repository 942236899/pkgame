/* ============================================================
 * TMH-谁是队友扑克游戏 —— Windows 服务器控制台（Electron 主进程）
 * 一个带操作界面的 exe：启停服务、改端口、看房间、配 MySQL、看日志
 *
 * 修复要点：
 *   1. 前端页面目录显式指向 resources/web（避免 ENOENT resources/index.html）
 *   2. 端口被占用时不再抛异常闪退，而是给出友好提示 / 自动复用已有实例
 *   3. 关闭窗口即停止服务器并退出，避免进程留在后台继续占用 8080
 * ============================================================ */
'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

/* 打包后 server / web 放在 resources 下（不进 asar），开发时就在本项目根目录 */
const RES_DIR = app.isPackaged ? process.resourcesPath : __dirname;
const SERVER_DIR = path.join(RES_DIR, 'server');
const WEB_DIR = app.isPackaged ? path.join(RES_DIR, 'web') : path.join(__dirname, 'dist');

process.env.PKGAME_WEB_ROOT = WEB_DIR;

const LOG_FILE = path.join(os.tmpdir(), 'tmh-server.log');
function fileLog(s) {
  try { fs.appendFileSync(LOG_FILE, new Date().toLocaleString() + '  ' + s + '\n'); } catch (e) { }
}
try {
  fs.writeFileSync(LOG_FILE, '=== TMH-谁是队友服务器 启动 ' + new Date().toLocaleString() + ' ===\n');
} catch (e) { }
fileLog('main.js 已加载，打包=' + app.isPackaged + '，页面目录=' + WEB_DIR);

let server;
try {
  server = require(path.join(SERVER_DIR, 'index.js'));
} catch (e) {
  fileLog('服务器模块加载失败：' + e.message);
  dialog.showErrorBox('无法启动',
    '服务器模块加载失败：\n' + e.message + '\n\n请确认 exe 所在目录完整（不要只复制 exe 文件）。');
  app.quit();
}

let win = null;
let running = false;
let external = false;   // 端口上跑的是别的实例（如客户端内置服务器）
let startedAt = 0;
let quitNow = false;

function pushLog(line) {
  if (win && win.webContents && !win.webContents.isDestroyed()) win.webContents.send('log', line);
}
if (server) server.onLog = pushLog;

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: 'TMH-谁是队友扑克游戏 · 服务器',
    backgroundColor: '#f2f6f3',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.loadFile(path.join(__dirname, 'desktop', 'ui.html'));
  win.on('closed', () => { win = null; });
}

/* ---------------- 端口探测 ---------------- */
function fetchJson(port, p, cb) {
  const req = http.get({ host: '127.0.0.1', port: port, path: p, timeout: 1200 }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', d => { body += d; });
    res.on('end', () => {
      try { cb(null, JSON.parse(body)); } catch (e) { cb(e); }
    });
  });
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.on('error', e => cb(e));
}

/* ---------------- 启动 / 停止 ---------------- */
function startServer(port, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    if (!server) { resolve({ ok: false, msg: '服务器模块未加载' }); return; }
    if (running) { resolve({ ok: false, msg: '服务器已在运行' }); return; }
    if (port) server.config.port = Number(port) || server.config.port;

    server.start((err, info) => {
      if (!err) {
        running = true;
        external = false;
        startedAt = Date.now();
        fileLog('服务器已启动，端口 ' + info.port);
        resolve({ ok: true, addresses: info.addresses, port: info.port });
        return;
      }

      if (err.code === 'EADDRINUSE' || /已被占用/.test(err.message || '')) {
        // 端口被占：先看是不是本游戏自己的服务器（客户端 exe 也内置了服务器）
        server.probe(server.config.port, (isOurs, j) => {
          if (isOurs) {
            running = true;
            external = true;
            startedAt = (j && j.startedAt) || Date.now();
            fileLog('端口 ' + server.config.port + ' 上已有本游戏服务器，复用该实例');
            pushLog('检测到本机 ' + server.config.port + ' 端口已有服务器在运行，已直接复用（控制台只能查看，不能停止它）');
            resolve({
              ok: true, external: true, port: server.config.port,
              addresses: server.lanAddresses(),
              msg: '已连接本机正在运行的服务器'
            });
          } else {
            fileLog('端口 ' + server.config.port + ' 被其他程序占用');
            resolve({
              ok: false,
              code: 'EADDRINUSE',
              msg: '端口 ' + server.config.port + ' 已被其他程序占用。请把上面的端口改成 8081（或其它 1024–65535 之间的数字）后重新点「启动服务器」。'
            });
          }
        });
        return;
      }

      fileLog('启动失败：' + err.message);
      resolve({ ok: false, msg: err.message });
    });
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (!running) { resolve({ ok: true }); return; }
    if (external) {
      // 外部实例（客户端内置）不能由本控制台关闭，只做状态解绑
      running = false; external = false;
      resolve({ ok: true, msg: '已断开（该服务器由另一个程序托管，仍在运行）' });
      return;
    }
    server.stop(() => {
      running = false;
      startedAt = 0;
      resolve({ ok: true });
    });
  });
}

/* ---------------- 进程级兜底：任何漏网异常都不再弹 Electron 崩溃框 ---------------- */
process.on('uncaughtException', e => {
  fileLog('未捕获异常：' + (e && e.stack || e));
  try {
    if (win) pushLog('发生错误：' + (e && e.message || e));
  } catch (_) { }
});
process.on('unhandledRejection', e => {
  fileLog('未处理的 Promise 异常：' + (e && e.stack || e));
});

/* 服务器不依赖窗口：进程一启动就把服务跑起来，界面只是个操作面板 */
app.whenReady().then(() => {
  createWindow();
  if (!server) return;
  startServer(server.config.port, { silent: true }).then(r => {
    if (!r.ok) {
      pushLog('自动启动失败：' + r.msg);
      fileLog('自动启动失败：' + r.msg);
    }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', async () => {
  if (quitNow) return;
  quitNow = true;
  await stopServer();
  app.quit();
});

app.on('before-quit', () => {
  try { if (running && !external) server.stop(() => { }); } catch (e) { }
});

/* ---------------- IPC ---------------- */
ipcMain.handle('get-config', () => ({
  port: server ? server.config.port : 8080,
  host: server ? server.config.host : '0.0.0.0',
  db: server ? server.config.db : null,
  webRoot: WEB_DIR
}));

ipcMain.handle('get-addrs', () => (server ? server.lanAddresses() : []));

ipcMain.handle('start', (e, opt) => startServer(opt && opt.port));

ipcMain.handle('stop', () => stopServer());

ipcMain.handle('open-browser', () => {
  if (!running) return { ok: false, msg: '请先点「启动服务器」' };
  const url = 'http://127.0.0.1:' + server.config.port;
  shell.openExternal(url);
  return { ok: true, url };
});

ipcMain.handle('status', async () => {
  if (!running) {
    return { running: false, external: false, players: 0, rooms: 0, games: 0, roomList: [], db: { enabled: false } };
  }
  const port = server.config.port;

  // 外部实例：通过 HTTP API 取状态
  if (external) {
    const j = await new Promise(r => fetchJson(port, '/api/status', (e, d) => r(e ? null : d)));
    const rooms = await new Promise(r => fetchJson(port, '/api/rooms', (e, d) => r(e ? null : d)));
    const list = (rooms && rooms.rooms) || [];
    return {
      running: true,
      external: true,
      startedAt: (j && j.startedAt) || startedAt,
      players: (j && j.players) || 0,
      rooms: list.length,
      games: (j && j.games) || 0,
      roomList: list,
      db: (j && j.db) || { enabled: false }
    };
  }

  const rooms = server.rooms();
  const list = Object.keys(rooms).map(c => {
    const r = rooms[c];
    return {
      code: r.code,
      players: r.humanCount(),
      seats: r.seats.map(s => s ? { name: s.name, isAI: !!s.isAI } : null),
      started: r.started,
      round: r.game ? r.game.round : 0,
      phase: r.game ? r.game.phase : 'wait'
    };
  });
  return {
    running: true,
    external: false,
    startedAt,
    players: list.reduce((s, r) => s + r.players, 0),
    rooms: list.length,
    games: server.stats.games,
    roomList: list,
    db: require(path.join(SERVER_DIR, 'lib', 'db.js')).status()
  };
});

ipcMain.handle('db-test', (e, cfg) => require(path.join(SERVER_DIR, 'lib', 'db.js')).test(cfg));

ipcMain.handle('db-save', async (e, cfg) => {
  server.config.db = Object.assign({}, server.config.db, cfg);
  const ok = server.saveConfig(server.config);
  const r = await require(path.join(SERVER_DIR, 'lib', 'db.js')).enable(server.config.db);
  return { ok: r.ok, msg: r.msg + (ok ? '（已写入 config.json）' : '（配置文件写入失败）') };
});
