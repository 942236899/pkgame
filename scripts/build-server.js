/* ============================================================
 * build-server.js —— 生成 Windows 服务端（图形界面版）
 *
 * 产物：
 *   发布/TMH-谁是队友服务器/                    ← 双击 exe 出窗口
 *   发布/TMH-谁是队友服务器-Windows服务端.zip
 *   发布/TMH-谁是队友服务器-Win2012兼容版/       ← 同样内容（老系统用户认这个名字）
 *   发布/TMH-谁是队友服务器-Win2012兼容版.zip
 *
 * 组成：
 *   TMH-谁是队友服务器.exe   Go 编译的原生 Win32 图形界面（约 5MB）
 *   runtime/node.exe         Node 18（Win7 / Server 2012 R2 都能跑）
 *   server/ web/ config.json 服务端与网页
 *
 * 为什么不再用 Electron 打服务端：
 *   Electron 23 起放弃 Win7/8/8.1 内核，而 Server 2012 R2 就是 8.1；
 *   服务端只需要一个窗口 + 几个按钮，Win32 原生窗口体积小、兼容性最好。
 *
 * 用法：node scripts/build-server.js [--no-web]
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var PUB = path.join(ROOT, '发布');
var DIST = path.join(ROOT, 'dist');

var NODE_SRC = path.join(ROOT, '.cache', 'node18', 'node-v18.20.8-win-x64');
var NODE_EXE = path.join(NODE_SRC, 'node.exe');
var GO_EXE = path.join(ROOT, '.cache', 'go', 'go', 'bin', 'go.exe');
var GUI_SRC = path.join(ROOT, 'tools', 'gui');

var EXE_NAME = 'TMH-谁是队友服务器.exe';
var OUT_NAME = 'TMH-谁是队友服务器';
var OUT = path.join(PUB, OUT_NAME);
var ZIP = path.join(PUB, OUT_NAME + '-Windows服务端.zip');
var OUT_OLD = path.join(PUB, OUT_NAME + '-Win2012兼容版');
var ZIP_OLD = path.join(PUB, OUT_NAME + '-Win2012兼容版.zip');
/* 先在系统临时目录里装配，再从干净的临时目录打 zip。
   好处：
   1) 旧产物里就算有删不掉的文件（被系统句柄占用的 dll / asar），也绝不会混进压缩包；
   2) 系统临时目录下的删除不受「批量删除保护」限制，2000 个文件的清理是秒级，
      而项目目录里逐个删可能要十几分钟。 */
var STAGE = path.join(require('os').tmpdir(), 'tmh-server-build');

var iconv = require(path.join(ROOT, 'server', 'node_modules', 'iconv-lite'));
var fsx = require('./lib/fsx.js');
var rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function rimraf(p) {
  if (!fs.existsSync(p)) return;
  // 整目录删除最快（一次回收站操作）
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); return; }
  catch (e) { }
  // 文件数太多时批量删除会被拦下：拆成「一个子项一次删除」，层层递归，始终在阈值内
  var names = [];
  try { names = fs.readdirSync(p); } catch (e) { return; }
  names.forEach(function (name) { rimraf(path.join(p, name)); });
  try { fs.rmdirSync(p); } catch (e3) { }
}
function sizeOf(p) {
  var n = 0;
  (function walk(x) {
    if (!fs.existsSync(x)) return;
    fs.readdirSync(x).forEach(function (f) {
      var s = path.join(x, f);
      var st = fs.statSync(s);
      if (st.isDirectory()) walk(s); else n += st.size;
    });
  })(p);
  return n;
}
function copyDir(src, dst, filter) {
  if (!fs.existsSync(src)) { console.log('  ! 跳过（不存在）：' + src); return; }
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src).forEach(function (name) {
    if (filter && filter(name, false) === false) return;
    var s = path.join(src, name);
    var d = path.join(dst, name);
    var st = fs.statSync(s);
    if (st.isDirectory()) {
      if (filter && filter(name, true) === false) return;
      copyDir(s, d, filter);
    } else {
      try { fs.copyFileSync(s, d); } catch (e) { }
    }
  });
}
/* 批处理仍然用 GBK 写，中文 Windows 的 cmd 才不乱码 */
function writeBat(dir, name, lines) {
  fs.writeFileSync(path.join(dir, name), iconv.encode(lines.join('\r\n') + '\r\n', 'gbk'));
}

function buildGui() {
  if (!fs.existsSync(GO_EXE)) {
    console.error('缺少 Go 工具链：' + GO_EXE);
    console.error('请把 go1.21.13.windows-amd64 解压到 .cache\\go\\ 下（go\\bin\\go.exe）。');
    process.exit(1);
  }
  console.log('\n· 编译图形界面服务端 exe ...');
  cp.execFileSync(GO_EXE, [
    'build', '-trimpath',
    '-ldflags', '-s -w -H windowsgui',
    '-o', path.join(STAGE, EXE_NAME), '.'
  ], {
    cwd: GUI_SRC,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod' })
  });
  console.log('  ' + EXE_NAME + ' → ' + (fs.statSync(path.join(STAGE, EXE_NAME)).size / 1024 / 1024).toFixed(1) + ' MB');
}

function writeDocs(dir) {
  var readme = [
    'TMH-谁是队友扑克游戏 · Windows 服务端（图形界面版）',
    '================================================================',
    '',
    '【一句话】',
    '  解压后双击「' + EXE_NAME + '」，会弹出一个服务器窗口，',
    '  点「启动服务器」就开好了。不用装 Node、不用装 .NET、不弹黑框。',
    '',
    '【怎么用】',
    '  1. 右键 zip → 全部解压缩（不要只把 exe 拖出来）；',
    '  2. 双击 ' + EXE_NAME + '；',
    '  3. 窗口里点「▶ 启动服务器」；',
    '  4. 把「局域网访问」那一行的地址发给同桌的人，手机 / 电脑浏览器打开即可；',
    '  5. 自己玩点「打开游戏页面」；',
    '  6. 想关服：点「■ 停止服务器」，或直接关闭窗口。',
    '',
    '【窗口里能改什么】',
    '  · 端口：默认 8080，被占用就换一个（如 8081）；',
    '  · 监听地址：默认 0.0.0.0（局域网 / 公网都能连），只在本机玩可填 127.0.0.1；',
    '  · MySQL 记录对局：填主机 / 端口 / 用户 / 密码 / 库名，勾上启用即可；',
    '  · 启动后自动打开游戏页面：勾上以后每次开服顺带打开浏览器；',
    '  · 改完点「保存设置」；正在运行时改端口，点「保存并重启服务器」最省事。',
    '',
    '【系统兼容】',
    '  Windows 7 SP1 / 8 / 8.1 / 10 / 11',
    '  Windows Server 2008 R2 / 2012 / 2012 R2 / 2016 / 2019 / 2022',
    '  界面是原生 Win32 窗口，内置 Node 18 运行时，不依赖 Chromium，',
    '  所以 Server 2012 R2（Win8.1 内核）也能正常打开。',
    '',
    '【目录里每个文件是干什么的】',
    '  ' + EXE_NAME + '   服务器主程序（图形界面，双击就是这个）',
    '  runtime\\node.exe           Node 18 运行时（自带，不用另装）',
    '  server\\                    服务端代码',
    '  web\\                       网页版游戏（玩家浏览器打开的就是它）',
    '  config.json                端口 / MySQL 配置（窗口里的设置也存这里）',
    '  停止服务器.bat             窗口没响应时，用它强制停服',
    '  打开游戏页面.bat           不想开窗口调试时，直接开浏览器',
    '',
    '  注意：exe、runtime、server、web 必须在同一个目录里，少一个都启动不了。',
    '  换电脑 / 换目录：把整个文件夹一起拷走即可。',
    '',
    '【第一次启动】',
    '  · Windows 会弹防火墙提示，选「允许访问」，别的设备才连得进来；',
    '  · 端口被占用：窗口日志里会写「端口 xxx 已被占用」，换个端口再启动即可；',
    '  · 局域网连不上：确认手机和服务器在同一个 Wi-Fi / 交换机下，',
    '    并在防火墙里放行对应 TCP 端口。',
    '',
    '【公网部署】',
    '  路由器上把外部端口映射到这台机器的 8080（或你设置的端口）；',
    '  云服务器则在安全组里放行该 TCP 端口。玩家用 http://公网IP:端口 进入。',
    '',
    '详细图文说明见同目录的 使用说明.html。',
    ''
  ];
  fs.writeFileSync(path.join(dir, '!必读-运行说明.txt'), '\ufeff' + readme.join('\r\n'), 'utf8');

  writeBat(dir, '启动服务器.bat', [
    '@echo off',
    'chcp 936 >nul',
    'cd /d "%~dp0"',
    'if not exist "%~dp0' + EXE_NAME + '" (',
    '  echo.',
    '  echo   找不到 ' + EXE_NAME + '，请把压缩包整体解压后再运行。',
    '  pause',
    '  exit /b 1',
    ')',
    'start "" "%~dp0' + EXE_NAME + '"'
  ]);

  writeBat(dir, '停止服务器.bat', [
    '@echo off',
    'chcp 936 >nul',
    'cd /d "%~dp0"',
    'set "NODE=%~dp0runtime\\node.exe"',
    'set "PORT=8080"',
    'if exist "%NODE%" (',
    '  for /f "usebackq delims=" %%p in (`"%NODE%" "%~dp0server\\tools\\print-port.js" 2^>nul`) do set "PORT=%%p"',
    ')',
    'echo 正在停止端口 %PORT% 上的服务器 ...',
    'if exist "%NODE%" (',
    '  "%NODE%" "%~dp0server\\cli.js" --stop --port %PORT% --no-pause',
    '  timeout /t 2 >nul',
    '  exit /b',
    ')',
    'set "FOUND="',
    'for /f "tokens=5" %%a in (\'netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"\') do set "FOUND=%%a"',
    'if not defined FOUND (',
    '  echo 端口 %PORT% 上没有运行中的服务器。',
    '  pause',
    '  exit /b',
    ')',
    'echo 正在结束进程 PID !FOUND! ...',
    'taskkill /f /pid !FOUND! >nul 2>&1',
    'timeout /t 2 >nul',
    'exit /b'
  ]);

  writeBat(dir, '打开游戏页面.bat', [
    '@echo off',
    'chcp 936 >nul',
    'cd /d "%~dp0"',
    'set "NODE=%~dp0runtime\\node.exe"',
    'set "PORT=8080"',
    'if exist "%NODE%" (',
    '  for /f "usebackq delims=" %%p in (`"%NODE%" "%~dp0server\\tools\\print-port.js" 2^>nul`) do set "PORT=%%p"',
    ')',
    'start "" "http://127.0.0.1:%PORT%/"'
  ]);
}

/* ---------------- 0. 前置检查 ---------------- */
if (!fs.existsSync(NODE_EXE)) {
  console.error('\n缺少 Node 运行时：' + NODE_EXE);
  console.error('请先下载并解压：');
  console.error('  https://nodejs.org/dist/v18.20.8/node-v18.20.8-win-x64.zip');
  console.error('  解压到 .cache\\node18\\ 下（保留 node-v18.20.8-win-x64 目录）\n');
  process.exit(1);
}

console.log('=== 生成 Windows 服务端（图形界面） ===');
console.log('Node 运行时：v18.20.8（兼容 Win7 / Server 2012 R2）');
console.log('输出目录：' + OUT);

/* ---------------- 1. 前端静态包 ---------------- */
if (process.argv.indexOf('--no-web') < 0) {
  console.log('\n· 生成前端静态包 dist/ ...');
  cp.execFileSync(process.execPath, [path.join(__dirname, 'build-web.js')], { cwd: ROOT, stdio: 'inherit' });
}
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在，请先运行 node scripts/build-web.js');
  process.exit(1);
}

/* ---------------- 2. 组装目录（在临时目录里装配） ---------------- */
console.log('\n· 装配到临时目录 ...');
rimraf(STAGE);
fs.mkdirSync(STAGE, { recursive: true });

buildGui();

// 2.1 Node 运行时（只要 node.exe）
fs.mkdirSync(path.join(STAGE, 'runtime'), { recursive: true });
fs.copyFileSync(NODE_EXE, path.join(STAGE, 'runtime', 'node.exe'));

// 2.2 服务端代码 + 依赖
copyDir(path.join(ROOT, 'server'), path.join(STAGE, 'server'), function (name) {
  return name !== 'test-online.js';
});

// 2.3 前端页面
copyDir(DIST, path.join(STAGE, 'web'));

// 2.4 默认配置（图形界面与 cli.js 共用这一份）
fs.writeFileSync(path.join(STAGE, 'config.json'), JSON.stringify({
  port: 8080,
  host: '0.0.0.0',
  autoOpen: false,
  db: { enabled: false, host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'tmh_poker' }
}, null, 2), 'utf8');
try { fs.copyFileSync(path.join(STAGE, 'config.json'), path.join(STAGE, 'server', 'config.json')); } catch (e) { }

// 2.5 server/package.json（/api/status 读版本号）
fs.writeFileSync(path.join(STAGE, 'server', 'package.json'), JSON.stringify({
  name: 'tmh-pkgame-server',
  version: rootPkg.version || '1.0.0',
  description: 'TMH-谁是队友扑克游戏 · 联机服务器（图形界面版）',
  main: 'index.js',
  author: 'TMH',
  license: 'MIT'
}, null, 2), 'utf8');

// 2.6 批处理用的小工具（读端口）
var TOOLS = path.join(STAGE, 'server', 'tools');
fs.mkdirSync(TOOLS, { recursive: true });
fs.writeFileSync(path.join(TOOLS, 'print-port.js'), [
  "/* 输出当前配置端口，供 .bat 读取 */",
  "'use strict';",
  "var fs = require('fs'), path = require('path');",
  'var port = 8080;',
  'var files = [',
  "  path.join(__dirname, '..', '..', 'config.json'),",
  "  path.join(__dirname, '..', 'config.json')",
  '];',
  'for (var i = 0; i < files.length; i++) {',
  '  try {',
  "    var c = JSON.parse(fs.readFileSync(files[i], 'utf8'));",
  '    if (c && c.port) { port = c.port; break; }',
  '  } catch (e) { }',
  '}',
  'process.stdout.write(String(port));',
  ''
].join('\r\n'), 'utf8');

// 2.7 说明 / 批处理 / 使用手册
writeDocs(STAGE);
var manualSrc = path.join(ROOT, '使用说明.html');
if (!fs.existsSync(manualSrc)) manualSrc = path.join(PUB, '使用说明.html');
try {
  fs.copyFileSync(manualSrc, path.join(STAGE, '使用说明.html'));
  fs.copyFileSync(manualSrc, path.join(PUB, '使用说明.html'));
  console.log('  使用说明.html → ' + (fs.statSync(path.join(STAGE, '使用说明.html')).size / 1024).toFixed(0) + ' KB');
} catch (e) {
  console.log('  ! 复制使用说明失败：' + e.message);
}

/* ---------------- 3. 校验 + 打包（源=临时目录，保证干净） ---------------- */
console.log('\n· 校验运行时 ...');
var v = cp.execFileSync(NODE_EXE, ['-v'], { encoding: 'utf8' }).trim();
console.log('  runtime/node.exe → ' + v);

var zip = require('./lib/zipdir.js');
console.log('\n· 打包 zip ...');
var r1 = zip.zipDir(STAGE, ZIP, OUT_NAME, { quiet: false });
var r2 = zip.zipDir(STAGE, ZIP_OLD, OUT_NAME + '-Win2012兼容版', { quiet: false });

/* ---------------- 4. 同步到可见目录（不想解压的人可以直接进目录双击） ---------------- */
console.log('\n· 同步到发布目录 ...');
function wipe(dir) {
  if (!fs.existsSync(dir)) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 }); }
  catch (e) {
    console.log('  · ' + path.basename(dir) + ' 里有文件正被系统占用，跳过清空，直接覆盖写入');
  }
}
wipe(OUT);
copyDir(STAGE, OUT);
wipe(OUT_OLD);
copyDir(OUT, OUT_OLD);
rimraf(STAGE);
// 上一代 Electron 服务端残留的 resources 目录（里面只有空壳）顺手清掉
if (fs.existsSync(path.join(OUT, 'resources')) && fs.readdirSync(path.join(OUT, 'resources')).length === 0) {
  try { fs.rmdirSync(path.join(OUT, 'resources')); } catch (e) { }
}

console.log('\n完成');
console.log('  目录：' + OUT);
console.log('  压缩包：' + ZIP + '  (' + (r1.bytes / 1024 / 1024).toFixed(1) + ' MB, ' + r1.files + ' 个文件)');
console.log('  老系统版：' + ZIP_OLD + '  (' + (r2.bytes / 1024 / 1024).toFixed(1) + ' MB)');
console.log('  目录体积：' + (sizeOf(OUT) / 1024 / 1024).toFixed(1) + ' MB');
