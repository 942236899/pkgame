/* ============================================================
 * bootstrap-android.js —— 自动准备安卓构建环境
 *   1) 下载并解压 JDK 21（清华镜像）
 *   2) 下载并解压 Android cmdline-tools
 *   3) sdkmanager 安装 platform-tools / platforms;android-36 / build-tools;36.0.0
 * 产物都在 .tools/ 下，不污染系统环境。
 * 用法：node scripts/bootstrap-android.js
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var url = require('url');
var { execFileSync, spawnSync } = require('child_process');

var ROOT = path.join(__dirname, '..');
var TOOLS = path.join(ROOT, '.tools');
var JDK = path.join(TOOLS, 'jdk21');
var SDK = path.join(TOOLS, 'android-sdk');
var TAR = 'C:\\Windows\\System32\\tar.exe';

function say(m) { console.log('[bootstrap] ' + m); }
function mkdirp(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function download(fileUrl, out) {
  return new Promise(function (resolve, reject) {
    if (fs.existsSync(out)) { say('已存在，跳过下载：' + path.basename(out)); return resolve(out); }
    say('下载 ' + fileUrl);
    var get = function (u, depth) {
      if (depth > 8) return reject(new Error('重定向过多'));
      var opt = url.parse(u);
      opt.headers = { 'User-Agent': 'Mozilla/5.0' };
      https.get(opt, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(url.resolve(u, res.headers.location), depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        var ws = fs.createWriteStream(out);
        var got = 0, tick = 0;
        res.on('data', function (c) {
          got += c.length;
          if (++tick % 200 === 0) process.stdout.write('\r  已下载 ' + (got / 1048576).toFixed(1) + ' MB   ');
        });
        res.pipe(ws);
        ws.on('finish', function () { ws.close(function () { console.log(''); resolve(out); }); });
        ws.on('error', reject);
      }).on('error', reject);
    };
    get(fileUrl, 0);
  });
}

function unzip(zipFile, dest) {
  mkdirp(dest);
  say('解压 ' + path.basename(zipFile));
  if (fs.existsSync(TAR)) {
    spawnSync(TAR, ['-xf', zipFile, '-C', dest], { stdio: 'inherit' });
  } else {
    spawnSync('powershell', ['-NoProfile', '-Command',
      'Expand-Archive -Path "' + zipFile + '" -DestinationPath "' + dest + '" -Force'], { stdio: 'inherit' });
  }
}

/** 把 dest 下唯一的子目录内容提到 dest 根 */
function flatten(dest) {
  var names = fs.readdirSync(dest);
  if (names.indexOf('bin') >= 0) return;
  var dirs = names.filter(function (n) { return fs.statSync(path.join(dest, n)).isDirectory(); });
  if (!dirs.length) return;
  var inner = path.join(dest, dirs[0]);
  say('展平目录 ' + dirs[0]);
  fs.readdirSync(inner).forEach(function (n) {
    var s = path.join(inner, n), d = path.join(dest, n);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    fs.renameSync(s, d);
  });
  fs.rmSync(inner, { recursive: true, force: true });
}

function run(cmd, args, env) {
  say('执行 ' + path.basename(cmd) + ' ' + args.join(' '));
  var r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: Object.assign({}, process.env, env || {}),
    shell: false
  });
  if (r.status !== 0) throw new Error(path.basename(cmd) + ' 退出码 ' + r.status);
}

(async function main() {
  mkdirp(TOOLS);

  /* ---------- JDK 21 ---------- */
  var javaExe = path.join(JDK, 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) {
    await download('https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
      path.join(TOOLS, 'jdk21.zip'));
    unzip(path.join(TOOLS, 'jdk21.zip'), JDK);
    flatten(JDK);
  }
  if (!fs.existsSync(javaExe)) throw new Error('JDK 解压失败：' + javaExe);
  say('JDK 就绪');

  var JAVA_HOME = JDK;
  var env = { JAVA_HOME: JAVA_HOME, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK };
  env.PATH = path.join(JDK, 'bin') + ';' + process.env.PATH;

  /* ---------- cmdline-tools ---------- */
  var sm = path.join(SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
  if (!fs.existsSync(sm)) {
    await download('https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
      path.join(TOOLS, 'cmdline-tools.zip'));
    var tmp = path.join(TOOLS, 'cmt');
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    unzip(path.join(TOOLS, 'cmdline-tools.zip'), tmp);
    var dest = path.join(SDK, 'cmdline-tools', 'latest');
    mkdirp(dest);
    fs.readdirSync(path.join(tmp, 'cmdline-tools')).forEach(function (n) {
      var s = path.join(tmp, 'cmdline-tools', n), d = path.join(dest, n);
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      fs.renameSync(s, d);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!fs.existsSync(sm)) throw new Error('cmdline-tools 解压失败');
  say('cmdline-tools 就绪');

  /* ---------- 许可 ---------- */
  var licDir = path.join(SDK, 'licenses');
  mkdirp(licDir);
  fs.writeFileSync(path.join(licDir, 'android-sdk-license'), '\n24333f8a63b6825ea9c5514f83c2829b004d1fee', 'ascii');
  fs.writeFileSync(path.join(licDir, 'android-sdk-preview-license'), '\n84831b9409646a918e30573bab4c9c91346d8abd', 'ascii');

  /* ---------- SDK 组件 ---------- */
  say('安装 SDK 组件（约几分钟）…');
  // compileSdk 36 → 需要 platforms;android-36 与 build-tools;36.0.0
  var y = spawnSync('cmd.exe', ['/c', sm, '--sdk_root=' + SDK,
    'platform-tools', 'platforms;android-36', 'build-tools;36.0.0'],
    { stdio: ['ignore', 'inherit', 'inherit'], env: Object.assign({}, process.env, env) });
  if (y.status !== 0) say('sdkmanager 退出码 ' + y.status + '（若已装好可忽略）');

  say('环境就绪');
  console.log('JAVA_HOME=' + JAVA_HOME);
  console.log('ANDROID_HOME=' + SDK);
})().catch(function (e) {
  console.error('[bootstrap] 失败：' + e.message);
  process.exit(1);
});
