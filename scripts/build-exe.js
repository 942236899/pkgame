/* ============================================================
 * build-exe.js —— 组装两个 Windows 绿色版（免安装 exe），不需要 electron-builder
 *
 *  发布/TMH-谁是队友/TMH-谁是队友.exe              游戏客户端（内置服务器，打开即玩）
 *
 * 注意：服务端已改为原生 Win32 图形界面 + Node 运行时（见 build-server.js），
 *       不再用 Electron 打包，所以这里只负责客户端。
 *
 * 目录结构（Electron 官方规范）：
 *   <exe>.exe                ← electron.exe 改名
 *   resources/app.asar       ← 应用主进程代码
 *   resources/server/        ← Node 服务器（含 node_modules，不放 asar 里更稳）
 *   resources/web/           ← 前端页面
 *
 * 用法：node scripts/build-exe.js [client|server|all]
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron', 'dist');
var PUB = path.join(ROOT, '发布');
var fsx = require('./lib/fsx.js');
var fsx = require('./lib/fsx.js');

var TARGETS = {
  client: {
    dir: 'TMH-谁是队友',
    exe: 'TMH-谁是队友.exe',
    main: 'desktop/main.js',
    desc: 'TMH-谁是队友扑克游戏 · Windows 客户端'
  },
};

function rimraf(p) {
  if (!fs.existsSync(p)) return;
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 1, retryDelay: 150 }); return; }
  catch (e) { }
  // 批量删除被安全策略拦下时，拆成一个子项一次删除，层层递归
  var names = [];
  try { names = fs.readdirSync(p); } catch (e2) { return; }
  names.forEach(function (n) { rimraf(path.join(p, n)); });
  try { fs.rmdirSync(p); } catch (e3) { }
}
function copyDir(src, dst, filter) {
  if (!fs.existsSync(src)) { console.log('  ! 跳过（不存在）：' + src); return; }
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src).forEach(function (name) {
    var s = path.join(src, name), d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) {
      if (filter && !filter(name, true)) return;
      copyDir(s, d, filter);
    } else {
      if (filter && !filter(name, false)) return;
      try { fs.copyFileSync(s, d); } catch (e) { }
    }
  });
}
function sizeOf(p) {
  var n = 0;
  (function walk(x) {
    if (!fs.existsSync(x)) return;
    fs.readdirSync(x).forEach(function (f) {
      var s = path.join(x, f);
      if (fs.statSync(s).isDirectory()) walk(s); else n += fs.statSync(s).size;
    });
  })(p);
  return n;
}

var asar = null;
try { asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar', 'lib', 'asar.js')); } catch (e) { }

function build(key) {
  var t = TARGETS[key];
  var OUT = path.join(PUB, t.dir);
  console.log('\n=== ' + t.desc + ' ===');
  console.log('输出：' + OUT);

  rimraf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // 1) Electron 运行时
  copyDir(ELECTRON_DIR, OUT);
  console.log('· Electron 运行时 ✓');

  // 2) 应用主进程代码 → resources/app（随后打 asar）
  var APP = path.join(OUT, 'resources', 'app');
  rimraf(APP);
  fs.mkdirSync(APP, { recursive: true });

  var mainSrc = path.join(ROOT, t.main);
  fs.copyFileSync(mainSrc, path.join(APP, 'main.js'));

  // 服务器控制台的界面文件（桌面客户端不需要）
  if (key === 'server') {
    copyDir(path.join(ROOT, 'desktop'), path.join(APP, 'desktop'), function (n, isDir) {
      if (isDir) return n === 'ui.html';
      return n === 'ui.html';
    });
    if (fs.existsSync(path.join(ROOT, 'desktop', 'ui.html'))) {
      fs.copyFileSync(path.join(ROOT, 'desktop', 'ui.html'), path.join(APP, 'desktop', 'ui.html'));
    }
  }

  var rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
    name: key === 'client' ? 'tmh-pkgame-client' : 'tmh-pkgame-server',
    version: rootPkg.version || '1.0.0',
    description: t.desc,
    main: 'main.js',
    author: 'TMH',
    license: 'MIT'
  }, null, 2), 'utf8');

  // 3) server / web 放在 resources 下（不进 asar）
  copyDir(path.join(ROOT, 'server'), path.join(OUT, 'resources', 'server'), function (n) {
    return n !== 'test-online.js';
  });
  copyDir(path.join(ROOT, 'dist'), path.join(OUT, 'resources', 'web'));
  console.log('· server / web ✓');

  // 使用说明随包分发
  try {
    fs.copyFileSync(path.join(PUB, '使用说明.html'), path.join(OUT, '使用说明.html'));
  } catch (e) { console.log('  ! 未找到 发布/使用说明.html，跳过'); }

  // 每个 exe 都放一份「必读」：Electron 不是单文件程序，只拷 exe 会报 ICU 错误
  var readme = key === 'client' ? [
    'TMH-谁是队友扑克游戏 · Windows 客户端',
    '================================================',
    '',
    '【怎么运行】',
    '  1. 整个文件夹一起复制 / 解压，不要只把 exe 单独拿出来；',
    '  2. 双击 TMH-谁是队友.exe。',
    '',
    '【★ 重要：Windows 7 / 8 / 8.1 / Server 2012 R2 用户必看】',
    '  本程序基于 Electron 44（Chromium），已不再支持 Win7 / 8 / 8.1 内核，',
    '  而 Server 2012 R2 的内核正是 Windows 8.1。这类系统上双击会提示：',
    '    此应用无法在你的电脑上运行。',
    '    若要找到适用于你的电脑的版本，请与软件发布者联系。',
    '  补 dll、装 .NET / VC++ 运行库都没用（是内核版本不支持）。',
    '  解决办法：',
    '    · 客户端：不用装，直接用浏览器打开服务器地址即可，功能完全一样；',
    '    · 服务端：改用 发布\\TMH-谁是队友服务器-Win2012兼容版.zip（纯 Node，无 Chromium）。',
    '',
    '【为什么不能只拷 exe】',
    '  这个 exe 用的是 Chromium 内核，运行时还需要同目录下的',
    '  icudtl.dat、*.pak、locales\\、resources\\ 和一堆 dll。',
    '  只拷 exe 到另一台电脑会报：',
    '    ERROR:base\\i18n\\icu_util.cc:237]',
    '    Invalid file descriptor to ICU data received.',
    '  看到这个报错就是文件没拷全，把整个文件夹重新复制即可。',
    '',
    '【换台电脑最省事的做法】',
    '  用 发布\\TMH-谁是队友-Windows客户端.zip：',
    '  拷这一个 zip 过去 → 右键「全部解压缩」→ 双击里面的 exe。',
    '',
    '【第一次打开】',
    '  · 会弹 Windows 防火墙提示，选「允许访问」，局域网里其他设备才连得上；',
    '  · 程序自带服务器，打开就能一个人玩，也可以让同一 Wi-Fi 的人连进来。',
    '',
    '【端口被占】',
    '  默认 8080。若被别的程序占用，客户端会自动改用 8081、8082…，',
    '  菜单里会显示实际地址；也可以改 resources\\server\\config.json。',
    '',
    '详细说明见同目录的 使用说明.html（浏览器打开）。',
    ''
  ] : [
    'TMH-谁是队友扑克游戏 · 服务器控制台',
    '================================================',
    '',
    '【怎么运行】',
    '  1. 整个文件夹一起复制 / 解压，不要只把 exe 单独拿出来；',
    '  2. 双击 TMH-谁是队友服务器.exe；',
    '  3. 点「启动服务器」→「在浏览器打开」即可进入游戏（或让别人用你的局域网地址连进来）。',
    '',
    '【★ 重要：Windows 7 / 8 / 8.1 / Server 2012 R2 用户必看】',
    '  本程序基于 Electron 44（Chromium），已不再支持 Win7 / 8 / 8.1 内核，',
    '  而 Server 2012 R2 的内核正是 Windows 8.1。这类系统上双击会提示：',
    '    此应用无法在你的电脑上运行。',
    '    若要找到适用于你的电脑的版本，请与软件发布者联系。',
    '  补 dll、装 .NET / VC++ 运行库都没用（是内核版本不支持）。',
    '  解决办法：改用 发布\\TMH-谁是队友服务器-Win2012兼容版.zip',
    '    · 解压后双击「★ 启动服务器.bat」→ 按 1 启动、按 3 开控制台；',
    '    · 它是 Node 18 运行时 + 批处理控制台，完全不依赖 Chromium。',
    '',
    '【为什么不能只拷 exe】',
    '  这个 exe 用的是 Chromium 内核，运行时还需要同目录下的',
    '  icudtl.dat、*.pak、locales\\、resources\\ 和一堆 dll。',
    '  只拷 exe 到另一台电脑会报：',
    '    ERROR:base\\i18n\\icu_util.cc:237]',
    '    Invalid file descriptor to ICU data received.',
    '  看到这个报错就是文件没拷全，把整个文件夹重新复制即可。',
    '',
    '【换台电脑最省事的做法】',
    '  用 发布\\TMH-谁是队友服务器-Windows服务端.zip：',
    '  拷这一个 zip 过去 → 右键「全部解压缩」→ 双击里面的 exe。',
    '  （和客户端同理，服务端也是「一个文件夹」，不是单个 exe）',
    '',
    '【第一次启动】',
    '  · 会弹 Windows 防火墙提示，选「允许访问」，别人才能连进来；',
    '  · 默认端口 8080，被占用时会提示改端口（8081 等）；',
    '  · 页面地址形如 http://192.168.3.24:8080，手机/电脑浏览器直接打开就能玩。',
    '',
    '详细说明见同目录的 使用说明.html（浏览器打开）。',
    ''
  ];
  fs.writeFileSync(path.join(OUT, '!必读-运行说明.txt'), '\ufeff' + readme.join('\r\n'), 'utf8');
  // 加 BOM：老版本记事本也能正确识别 UTF-8 中文

  // 4) 默认配置
  var cfgPath = path.join(OUT, 'resources', 'server', 'config.json');
  if (!fs.existsSync(cfgPath)) {
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: 8080, host: '0.0.0.0',
      db: { enabled: false, host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'tmh_poker' }
    }, null, 2), 'utf8');
  }

  function finish() {
    var exeSrc = path.join(OUT, 'electron.exe');
    var exeDst = path.join(OUT, t.exe);
    try {
      if (fs.existsSync(exeDst) && fs.existsSync(exeSrc)) fs.unlinkSync(exeDst);
      if (fs.existsSync(exeSrc)) fs.renameSync(exeSrc, exeDst);
      else if (!fs.existsSync(exeDst)) fs.copyFileSync(path.join(ELECTRON_DIR, 'electron.exe'), exeDst);
    } catch (e) { console.log('  ! 主程序改名失败（被占用）：' + e.message); }

    if (fs.existsSync(path.join(OUT, 'resources', 'app.asar'))) rimraf(APP);

    console.log('· 完成：' + t.exe + '  体积 ' + (sizeOf(OUT) / 1024 / 1024).toFixed(1) + ' MB');
    next();
  }

  if (asar) {
    asar.createPackage(APP, path.join(OUT, 'resources', 'app.asar'))
      .then(function () { console.log('· app.asar ✓'); finish(); })
      .catch(function (e) { console.log('  ! asar 失败：' + e.message + '，改用明文 app 目录'); finish(); });
  } else {
    console.log('  ! 未安装 @electron/asar，使用明文 app 目录');
    finish();
  }
}

var queue = [];
function next() { if (queue.length) queue.shift()(); else console.log('\n全部完成。'); }

if (!fs.existsSync(path.join(ELECTRON_DIR, 'electron.exe'))) {
  console.error('未找到 Electron 二进制，请先执行 npm install');
  process.exit(1);
}

var arg = (process.argv[2] || 'all').toLowerCase();
if (arg === 'server') {
  console.log('服务端请用：node scripts/build-server.js（图形界面版，兼容 Win7 / Server 2012 R2）');
  process.exit(0);
}
if (arg === 'all') queue = [function () { build('client'); }];
else queue = [function () { build(arg); }];
next();
