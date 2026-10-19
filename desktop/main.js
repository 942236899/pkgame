/* ============================================================
 * desktop/main.js —— TMH-谁是队友扑克游戏 · Windows 客户端（Electron）
 *
 * 双击即用：
 *   1. 自动启动内置联机服务器（同局域网的手机 / 网页 / 其他电脑都能加入）
 *   2. 打开游戏窗口，本身就是"房主"，可以直接建房邀请好友
 *   3. 菜单里可查看局域网地址、复制邀请链接、打开服务器控制台、看 MySQL 状态
 *
 * 打包：node scripts/build-desktop-exe.js
 * ============================================================ */
'use strict';

var path = require('path');
var fs = require('fs');
var electron = require('electron');
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var Menu = electron.Menu;
var shell = electron.shell;
var dialog = electron.dialog;
var clipboard = electron.clipboard;

/* ---------- 路径：打包后 server / web 放在 resources 下（不进 asar） ---------- */
var RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
var SERVER_DIR = path.join(RES, 'server');
var WEB_DIR = path.join(RES, 'web');

process.env.PKGAME_WEB_ROOT = WEB_DIR;
process.env.PKGAME_CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

var SERVER = require(path.join(SERVER_DIR, 'index.js'));
var DB = require(path.join(SERVER_DIR, 'lib', 'db.js'));

var win = null;
var adminWin = null;
var booted = false;
var actualPort = SERVER.config.port || 8080;
var external = false;   // 复用本机已在运行的服务器（例如先开了服务器控制台）

function gameUrl() {
  var base = 'http://127.0.0.1:' + actualPort;
  return base + '/?server=' + encodeURIComponent(base) + '&client=desktop';
}

function createWindow() {
  if (win) return;
  win = new BrowserWindow({
    width: 560,
    height: 940,
    minWidth: 360,
    minHeight: 620,
    title: 'TMH-谁是队友扑克游戏',
    backgroundColor: '#14532d',
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolated: true,
      backgroundThrottling: false
    }
  });

  win.loadURL(gameUrl());
  win.on('closed', function () { win = null; });

  // 关掉窗口就退出（客户端不像服务器需要常驻）
  win.on('close', function () {
    adminWin = null;
  });

  buildMenu();
}

function lanList() {
  var port = actualPort;
  try { return SERVER.lanAddresses().map(function (a) { return 'http://' + a + ':' + port; }); }
  catch (e) { return []; }
}

function openAdmin() {
  var port = actualPort;
  var url = 'http://127.0.0.1:' + port + '/admin';
  if (adminWin && !adminWin.isDestroyed()) { adminWin.focus(); return; }
  adminWin = new BrowserWindow({
    width: 1040, height: 820, minWidth: 900, minHeight: 620,
    title: 'TMH-谁是队友 · 服务器控制台',
    backgroundColor: '#f2f6f3',
    parent: win,
    webPreferences: { nodeIntegration: false, contextIsolated: true }
  });
  adminWin.loadURL(url);
  adminWin.on('closed', function () { adminWin = null; });
}

function buildMenu() {
  var tpl = [
    {
      label: '游戏',
      submenu: [
        { label: '回到大厅', click: function () { if (win) win.loadURL(gameUrl()); } },
        { label: '重新加载', role: 'reload' },
        { label: '全屏', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '联机',
      submenu: [
        {
          label: '显示局域网地址',
          click: function () {
            var list = lanList();
            var msg = '本机已开启服务器，同一 Wi-Fi 下的手机 / 平板 / 其他电脑用下面任一地址进入：\n\n' +
              (list.length ? list.join('\n') : '（未检测到局域网地址）') +
              '\n\n本机自己玩：http://127.0.0.1:' + actualPort;
            dialog.showMessageBox(win, { type: 'info', title: '局域网地址', message: msg });
          }
        },
        {
          label: '复制局域网邀请地址',
          click: function () {
            var list = lanList();
            if (!list.length) { dialog.showMessageBox(win, { type: 'warning', message: '未检测到局域网地址' }); return; }
            clipboard.writeText(list[0]);
            dialog.showMessageBox(win, { type: 'info', message: '已复制：\n' + list[0] });
          }
        },
        {
          label: '网页进入（手机扫码）',
          click: function () {
            if (!win) return;
            win.webContents.executeJavaScript(
              'window.UI && UI.showWebEntry ? UI.showWebEntry() : null'
            ).catch(function () { win.loadURL(gameUrl() + '&web=1'); });
          }
        },
        { label: '打开服务器控制台', click: openAdmin },
        { type: 'separator' },
        {
          label: '在浏览器中打开',
          click: function () { shell.openExternal(gameUrl()); }
        }
      ]
    },
    {
      label: '数据库',
      submenu: [
        {
          label: 'MySQL 状态',
          click: function () {
            var st = DB.status();
            dialog.showMessageBox(win, {
              type: 'info', title: 'MySQL 状态',
              message: st.enabled ? '已连接：' + (st.database || '') + '\n对局记录正在写入 MySQL。'
                : '未启用：' + (st.error || '未配置') + '\n\n可在「服务器控制台 → MySQL」里配置。'
            });
          }
        },
        {
          label: '打开控制台配置 MySQL',
          click: openAdmin
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '游戏规则',
          click: function () {
            dialog.showMessageBox(win, {
              type: 'info', title: '玩法速览',
              message: '4 人各 13 张，♦A 与 ♦3 是"队友标记"：两张都打出后系统自动公开队友关系。\n' +
                '若两张都在同一人手里，则他一人成队（独狼）1 打 3，其余 3 人自动结成一队。\n' +
                '只打出其中一张时不公开；一局打完仍未凑齐两张，结算时公开。\n\n' +
                '牌型：单张 / 对子 / 纯3张 / 五张组合。\n' +
                '五张组合从大到小：同花顺 > 四带一 > 三带二 > 同花 > 顺子。\n' +
                '只能同牌型压同牌型（单张压单张、对子压对子、五张压五张），一直压到最大牌无人能压为止。\n' +
                '纯3张只能"领出"时打，且必须满足其一：本局第一次出牌；或其余人都过牌、牌权回到自己时手上只剩这3张。\n' +
                '（打了一张大牌、其余人全过、手上还有很多牌时再甩 444 是违规的，游戏不会允许）\n\n' +
                '首出权：每局抽签随机决定。\n' +
                '结算只公布输赢，不计分；按名次进贡。\n' +
                '游戏内「设置」可切换严格/宽松压制、同花先比牌面或先比花色。'
            });
          }
        },
        { label: '关于', click: function () { dialog.showMessageBox(win, { type: 'info', title: '关于', message: 'TMH-谁是队友扑克游戏\nWindows 客户端（内置联机服务器）' }); } }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* ---------------- 启动：服务器在进程启动时就跑起来，窗口等 app ready 再开 ----------------
 * 这样即使图形环境还没就绪，局域网里的其他人也已经可以连进来。
 * 端口被占用时不再闪退：先判断是不是本游戏自己的服务器（复用），否则自动换下一个端口。 */
var startErr = null;
var MAX_TRY = 10;

function logBoot(s) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'log.txt'),
      new Date().toLocaleString() + '  ' + s + '\n');
  } catch (e) { }
}

function failBoot(msg) {
  startErr = new Error(msg);
  logBoot('启动失败：' + msg);
  dialog.showErrorBox('无法启动游戏', msg);
  app.quit();
}

function boot(port, attempt) {
  actualPort = port;
  SERVER.config.port = port;
  SERVER.start(function (err, info) {
    if (!err) {
      booted = true;
      external = false;
      actualPort = info.port;
      logBoot('服务器启动成功，端口 ' + info.port);
      if (app.isReady()) createWindow();
      return;
    }

    var busy = err.code === 'EADDRINUSE' || /已被占用/.test(err.message || '');
    if (busy) {
      SERVER.probe(port, function (isOurs) {
        if (isOurs) {
          // 8080 上已经有一个本游戏的服务器（多半是先开了「服务器控制台」），直接连它
          booted = true;
          external = true;
          logBoot('端口 ' + port + ' 已有本游戏服务器，客户端复用该实例');
          if (app.isReady()) createWindow();
          return;
        }
        if (attempt < MAX_TRY) {
          logBoot('端口 ' + port + ' 被其他程序占用，尝试 ' + (port + 1));
          boot(port + 1, attempt + 1);
          return;
        }
        failBoot('端口 ' + port + ' 已被其他程序占用，且 8080–' + (port - 1) + ' 都不可用。\n\n' +
          '请关闭占用端口的程序后重试，或先运行「TMH-谁是队友服务器」exe 换一个端口启动。');
      });
      return;
    }

    failBoot(err.message + '\n\n请确认游戏目录完整（不要只复制 exe 单个文件）。');
  });
}

boot(SERVER.config.port || 8080, 0);

app.whenReady().then(function () {
  if (startErr) return;
  if (booted && !win) createWindow();   // 服务器还没就绪时先不建窗口，等 boot 成功再建
});

app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0 && booted && !startErr) createWindow();
});

app.on('window-all-closed', function () {
  if (!external) { try { SERVER.stop(function () { }); } catch (e) { } }
  app.quit();
});

app.on('before-quit', function () {
  if (!external) { try { SERVER.stop(function () { }); } catch (e) { } }
});

/* 兜底：任何漏网异常写日志并提示，而不是弹出 Electron 崩溃框 */
process.on('uncaughtException', function (e) {
  logBoot('未捕获异常：' + (e && e.stack || e));
});
process.on('unhandledRejection', function (e) {
  logBoot('未处理 Promise 异常：' + (e && e.stack || e));
});
