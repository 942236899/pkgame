/* ============================================================
 * cli.js —— TMH 服务端 Windows exe 入口（pkg 打包专用）
 *
 * 打包后的 exe 自带 Node 18 运行时（官方支持 Windows 7 SP1 及以上，
 * 因此 Windows Server 2012 R2 / Win8.1 内核可以直接双击运行，不依赖
 * 浏览器内核，也不需要安装 Node）。
 *
 * 用法：
 *   TMH-谁是队友服务器.exe                 前台启动（双击即用）
 *   TMH-谁是队友服务器.exe --port 18080    指定端口启动
 *   TMH-谁是队友服务器.exe --open          启动并打开网页控制台
 *   TMH-谁是队友服务器.exe --stop          停止正在运行的服务器
 *   TMH-谁是队友服务器.exe --check         只检查配置与端口，不起服务
 * ============================================================ */
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var http = require('http');
var cp = require('child_process');

/* exe 所在目录：配置、网页都放在它旁边，方便直接改。
 * 启动器（TMH-谁是队友服务器.exe）会用 PKGAME_HOME 告诉我们 exe 在哪；
 * 直接用 node server/cli.js 调试时退回本文件所在目录。 */
var IS_PKG = !!process.pkg;
var HOME = process.env.PKGAME_HOME || (IS_PKG ? path.dirname(process.execPath) : __dirname);

var argv = process.argv.slice(2);
function hasFlag(f) { return argv.indexOf(f) >= 0; }
function flagValue(f, def) {
  var i = argv.indexOf(f);
  return (i >= 0 && argv[i + 1] && argv[i + 1].charAt(0) !== '-') ? argv[i + 1] : def;
}

/* ---------------- 配置文件 ---------------- */
var CFG_FILE = path.join(HOME, 'config.json');
var DEFAULT_CFG = {
  port: 8080,
  host: '0.0.0.0',
  db: {
    enabled: false,
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'tmh_poker'
  }
};

function readCfg() {
  try {
    var c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    return c || {};
  } catch (e) {
    return {};
  }
}

/* 首次运行时把配置写到 exe 旁边，用户可以直接用记事本改端口 */
function ensureCfg() {
  if (fs.existsSync(CFG_FILE)) return true;
  try {
    fs.writeFileSync(CFG_FILE, JSON.stringify(DEFAULT_CFG, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

ensureCfg();
var cfg = readCfg();
var port = Number(flagValue('--port', cfg.port || 8080)) || 8080;

/* ---------------- 网页目录 ----------------
 * 优先级：外部指定的 PKGAME_WEB_ROOT（图形界面会传）→ exe 旁边的 web → 开发用的 dist */
var webDir = process.env.PKGAME_WEB_ROOT || path.join(HOME, 'web');
try {
  if (!fs.existsSync(path.join(webDir, 'index.html'))) {
    var cands = [
      path.join(HOME, 'web'),
      path.join(HOME, 'dist'),
      path.join(HOME, '..', 'dist')
    ];
    for (var wi = 0; wi < cands.length; wi++) {
      if (fs.existsSync(path.join(cands[wi], 'index.html'))) { webDir = cands[wi]; break; }
    }
  }
} catch (e) { }
var hasWeb = false;
try { hasWeb = fs.existsSync(path.join(webDir, 'index.html')); } catch (e) { }
if (hasWeb) process.env.PKGAME_WEB_ROOT = webDir;

/* 让 server/index.js 读到 exe 旁边的配置 */
process.env.PKGAME_CONFIG_FILE = CFG_FILE;

/* ---------------- 输出 ---------------- */
var LINE = '------------------------------------------------------------';
function say(s) { console.log(s || ''); }
function line() { say(LINE); }

function banner(srv) {
  say('');
  say('============================================================');
  say('   TMH · 谁是队友扑克游戏   联机服务器');
  say('   版本 ' + (srv.version || '') + '   运行环境 Node ' + process.versions.node +
    ' (' + (process.arch === 'x64' ? '64 位' : process.arch) + ')');
  say('   兼容 Windows 7 SP1 / 8.1 / Server 2012 R2 及更高版本');
  say('============================================================');
}

function addressLines(info) {
  var addrs = (info && info.addresses) || [];
  line();
  say('  本机访问     http://127.0.0.1:' + info.port);
  if (addrs.length) {
    addrs.forEach(function (a) {
      say('  局域网访问   http://' + a + ':' + info.port + '   ← 发给同桌的人');
    });
  } else {
    say('  局域网访问   未检测到网卡地址（只在本机可访问）');
  }
  say('  网页控制台   http://127.0.0.1:' + info.port + '/admin');
  say('  配置文件     ' + CFG_FILE);
  say('  网页目录     ' + (process.env.PKGAME_WEB_ROOT || '（默认）'));
  line();
  if (hasFlag('--gui')) {
    // 图形界面版：日志显示在窗口里，不再讲命令行用法
    say('  这里是服务器窗口的运行日志；改端口 / MySQL 请在上方设置区操作。');
    say('  停止服务：点窗口里的「■ 停止服务器」，或直接关闭窗口。');
  } else {
    say('  手机 / 平板 / 电脑浏览器打开上面的地址即可开局，无需安装。');
    say('  想改端口：关掉本窗口，用记事本改 config.json 里的 port。');
    say('  停止服务：按 Ctrl + C，或直接关闭本窗口。');
  }
  line();
  say('');
}

function fail(msg, hint) {
  say('');
  say('[启动失败] ' + msg);
  if (hint) say('           ' + hint);
  say('');
  pauseExit(1);
}

/* 双击运行出错时不要一闪而过，等用户看完再关 */
function pauseExit(code) {
  if (hasFlag('--no-pause') || !process.stdin.isTTY) {
    setTimeout(function () { process.exit(code); }, 200);
    return;
  }
  say('按回车键退出…');
  try {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', function () { process.exit(code); });
  } catch (e) {
    setTimeout(function () { process.exit(code); }, 6000);
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      cp.exec('cmd /c start "" "' + url + '"');
    } else if (process.platform === 'darwin') {
      cp.exec('open "' + url + '"');
    } else {
      cp.exec('xdg-open "' + url + '"');
    }
  } catch (e) { }
}

/* ---------------- 停止 / 检测 ---------------- */
function postShutdown(p, cb) {
  var body = '{}';
  var req = http.request({
    host: '127.0.0.1',
    port: p,
    path: '/api/shutdown',
    method: 'POST',
    timeout: 4000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, function (res) {
    var t = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { t += d; });
    res.on('end', function () { cb(null, res.statusCode, t); });
  });
  req.on('timeout', function () { req.destroy(); cb(new Error('请求超时')); });
  req.on('error', function (e) { cb(e); });
  req.write(body);
  req.end();
}

/* ---------------- 启动 ---------------- */
ensureCfg();

var srv;
try {
  srv = require('./index.js');
} catch (e) {
  say('[致命错误] 服务端模块加载失败：' + e.message);
  pauseExit(1);
  throw e;
}

if (hasFlag('--help') || hasFlag('-h') || hasFlag('/?')) {
  banner(srv);
  say('');
  say('  双击 exe                 直接启动服务器（默认端口 8080）');
  say('  --port 18080             指定端口启动');
  say('  --open                   启动后自动打开网页控制台');
  say('  --stop                   停止正在运行的服务器');
  say('  --check                  只检查配置和端口，不启动');
  say('  --no-pause               出错时不停留（脚本调用用）');
  say('');
  process.exit(0);
}

if (hasFlag('--version') || hasFlag('-v')) {
  console.log(srv.version || '');
  process.exit(0);
}

if (hasFlag('--stop')) {
  banner(srv);
  say('  正在通知 127.0.0.1:' + port + ' 上的服务器停止…');
  postShutdown(port, function (err, code) {
    if (err) {
      say('  没有响应：' + err.message);
      say('  （服务器可能本来就没在运行，或者用的是别的端口）');
      pauseExit(1);
      return;
    }
    say('  已发送停止指令（HTTP ' + code + '），服务器正在退出。');
    setTimeout(function () { process.exit(0); }, 600);
  });
  return;
}

if (hasFlag('--check')) {
  banner(srv);
  line();
  say('  端口         ' + port);
  say('  配置文件     ' + CFG_FILE + (fs.existsSync(CFG_FILE) ? '（存在）' : '（缺失，将自动创建）'));
  say('  网页目录     ' + (hasWeb ? webDir + '（存在）' : webDir + '（缺失！请把 web 文件夹放在 exe 旁边）'));
  say('  服务端代码   ' + path.join(__dirname, 'index.js'));
  say('  运行时       ' + path.join(HOME, 'runtime', 'node.exe') +
    (fs.existsSync(path.join(HOME, 'runtime', 'node.exe')) ? '（存在）' : '（缺失！）'));
  line();
  say(hasWeb ? '  检查通过，可以启动。' : '  检查未通过：缺少 web 目录，网页会打不开。');
  say('');
  pauseExit(hasWeb ? 0 : 1);
  return;
}

/* 正常启动 */
banner(srv);
say('');
say('  正在启动…');

if (!hasWeb) {
  fail('找不到网页目录：' + webDir,
    '请把下载的 web 文件夹整个放在 exe 所在的同一个目录下（不要改名）。');
  return;
}

var started = false;
srv.start(function (err, info) {
  if (started) return;
  started = true;
  if (err) {
    var msg = err.message || String(err);
    if (/EADDRINUSE|已被占用/.test(msg)) {
      if (hasFlag('--gui')) {
        fail('端口 ' + port + ' 已被占用。',
          '多半是已经开着一个服务器窗口了。关掉那个，或在上方把端口改成 8081 再启动。');
      } else {
        fail('端口 ' + port + ' 已被占用。',
          '八成是已经开着一个服务器窗口了。关掉那个窗口，或用 --port 换一个端口。');
      }
    } else {
      fail(msg, '可以截图这个窗口发给开发者。');
    }
    return;
  }
  addressLines(info);
  if (hasFlag('--open')) openBrowser('http://127.0.0.1:' + info.port + '/admin');
});

/* Ctrl + C / 关闭窗口：优雅退出，先把玩家连接断开 */
process.on('SIGINT', function () {
  say('');
  say('  正在停止服务器…');
  try { srv.stop(); } catch (e) { }
  setTimeout(function () { process.exit(0); }, 300);
});

process.on('SIGTERM', function () {
  try { srv.stop(); } catch (e) { }
  setTimeout(function () { process.exit(0); }, 300);
});

process.on('uncaughtException', function (e) {
  say('');
  say('[未捕获异常] ' + (e && e.stack ? e.stack : e));
  say('  服务器可能已停止，请把这段信息发给开发者。');
  pauseExit(1);
});
