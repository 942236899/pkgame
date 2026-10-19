/* ============================================================
 * build-android.js —— 一键构建安卓 APK
 *
 * 全程不污染系统环境：JDK / Android SDK / Gradle 都放在 .tools/ 下
 *   · 首次运行会自动下载 JDK 21、Android SDK、Gradle（脚本里走国内镜像）
 *   · 产物：发布/TMH-谁是队友-Android.apk
 *
 * 用法：node scripts/build-android.js            构建 debug APK
 *       node scripts/build-android.js --release  构建 release（需签名配置）
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var url = require('url');
var { spawnSync } = require('child_process');

var ROOT = path.join(__dirname, '..');
var TOOLS = path.join(ROOT, '.tools');
var JDK = path.join(TOOLS, 'jdk21');
var SDK = path.join(TOOLS, 'android-sdk');
var GRADLE = path.join(TOOLS, 'gradle-8.14.3');
var ANDROID = path.join(ROOT, 'android');
var PUB = path.join(ROOT, '发布');

function say(m) { console.log('[android] ' + m); }
function mkdirp(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function download(fileUrl, out) {
  return new Promise(function (resolve, reject) {
    if (fs.existsSync(out)) { say('已存在：' + path.basename(out)); return resolve(out); }
    say('下载 ' + fileUrl);
    var get = function (u, depth) {
      if (depth > 8) return reject(new Error('重定向过多'));
      https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return get(url.resolve(u, res.headers.location), depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        var ws = fs.createWriteStream(out), got = 0, tick = 0;
        res.on('data', function (c) { got += c.length; if (++tick % 300 === 0) process.stdout.write('\r  ' + (got / 1048576).toFixed(1) + ' MB   '); });
        res.pipe(ws);
        ws.on('finish', function () { ws.close(function () { console.log(''); resolve(out); }); });
        ws.on('error', reject);
      }).on('error', reject);
    };
    get(fileUrl, 0);
  });
}

function unzip(z, dest) {
  mkdirp(dest);
  say('解压 ' + path.basename(z));
  var tar = 'C:\\Windows\\System32\\tar.exe';
  var r = fs.existsSync(tar)
    ? spawnSync(tar, ['-xf', z, '-C', dest], { stdio: 'inherit' })
    : spawnSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive -Path "' + z + '" -DestinationPath "' + dest + '" -Force'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压失败 ' + z);
}

function flatten(dest) {
  var names = fs.readdirSync(dest);
  var dirs = names.filter(function (n) { return fs.statSync(path.join(dest, n)).isDirectory(); });
  if (names.indexOf('bin') >= 0 || !dirs.length) return;
  var inner = path.join(dest, dirs[0]);
  fs.readdirSync(inner).forEach(function (n) {
    var s = path.join(inner, n), d = path.join(dest, n);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    fs.renameSync(s, d);
  });
  fs.rmSync(inner, { recursive: true, force: true });
}

function prepare() {
  if (!fs.existsSync(path.join(JDK, 'bin', 'java.exe')) || !fs.existsSync(path.join(SDK, 'platforms'))) {
    say('先准备 JDK / Android SDK…');
    var r = spawnSync(process.execPath, [path.join(__dirname, 'bootstrap-android.js')], { stdio: 'inherit', cwd: ROOT });
    if (r.status !== 0) throw new Error('JDK / Android SDK 准备失败');
  }
  if (!fs.existsSync(path.join(GRADLE, 'bin', 'gradle.bat'))) {
    download('https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip', path.join(TOOLS, 'gradle.zip'))
      .then(function (z) {
        unzip(z, TOOLS);
        // tar 解压后目录名就是 gradle-8.14.3
        say('Gradle 就绪');
        return go();
      }).catch(function (e) { console.error('[android] ' + e.message); process.exit(1); });
    return;
  }
  go();
}

function go() {
  var release = process.argv.indexOf('--release') >= 0;
  var task = release ? 'assembleRelease' : 'assembleDebug';

  // Gradle 用独立 GRADLE_USER_HOME，并挂上国内 Maven 镜像
  var gHome = path.join(TOOLS, 'gradle-home');
  mkdirp(path.join(gHome, 'init.d'));
  fs.writeFileSync(path.join(gHome, 'init.d', 'mirrors.gradle'), [
    "allprojects {",
    "  repositories {",
    "    maven { url 'https://maven.aliyun.com/repository/google' }",
    "    maven { url 'https://maven.aliyun.com/repository/public' }",
    "    maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }",
    "    google()",
    "    mavenCentral()",
    "  }",
    "}",
    "settingsEvaluated { settings ->",
    "  settings.pluginManagement {",
    "    repositories {",
    "      maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }",
    "      gradlePluginPortal()",
    "      google()",
    "      mavenCentral()",
    "    }",
    "  }",
    "}"
  ].join('\n'), 'utf8');

  // 版本号跟随 package.json（否则 APK 里永远显示 1.0）
  try {
    var pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    var vp = pkgVer.split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var vcode = vp[0] * 10000 + vp[1] * 100 + vp[2];
    var bgPath = path.join(ANDROID, 'app', 'build.gradle');
    var bgSrc = fs.readFileSync(bgPath, 'utf8');
    bgSrc = bgSrc.replace(/versionCode\s+\d+/, 'versionCode ' + vcode)
      .replace(/versionName\s+"[^"]*"/, 'versionName "' + pkgVer + '"');
    fs.writeFileSync(bgPath, bgSrc, 'utf8');
    say('版本号：' + pkgVer + '（versionCode ' + vcode + '）');
  } catch (e) { console.error('  ! 写入安卓版本号失败：' + e.message); }

  say('同步前端资源到安卓工程…');
  var cap = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
  var s1 = spawnSync(process.execPath, [cap, 'sync', 'android'], { stdio: 'inherit', cwd: ROOT });
  if (s1.status !== 0) console.error('  ! cap sync 返回 ' + s1.status);

  var env = Object.assign({}, process.env, {
    JAVA_HOME: JDK,
    ANDROID_HOME: SDK,
    ANDROID_SDK_ROOT: SDK,
    GRADLE_USER_HOME: gHome
  });
  env.PATH = path.join(JDK, 'bin') + ';' + path.join(GRADLE, 'bin') + ';' + env.PATH;

  say('开始 Gradle 构建（首次会下载依赖，约 5~15 分钟）…');
  var r = spawnSync(path.join(GRADLE, 'bin', 'gradle.bat'),
    [task, '-p', ANDROID, '--console', 'plain', '--no-daemon'],
    { stdio: 'inherit', env: env, cwd: ANDROID, shell: true });

  if (r.status !== 0) {
    console.error('[android] Gradle 构建失败，退出码 ' + r.status);
    process.exit(1);
  }

  var apkDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', release ? 'release' : 'debug');
  var files = fs.existsSync(apkDir) ? fs.readdirSync(apkDir).filter(function (f) { return /\.apk$/.test(f); }) : [];
  if (!files.length) { console.error('[android] 未找到 APK 产物'); process.exit(1); }

  mkdirp(PUB);
  var dst = path.join(PUB, 'TMH-谁是队友-Android' + (release ? '-release' : '') + '.apk');
  fs.copyFileSync(path.join(apkDir, files[0]), dst);
  say('完成：' + dst + '  （' + (fs.statSync(dst).size / 1048576).toFixed(1) + ' MB）');
}

prepare();
