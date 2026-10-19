/* ============================================================
 * build-ios.js —— iOS 端准备 / 构建
 *
 * iOS 只能 macOS + Xcode 编译，所以在 Windows 上本脚本只做「准备」：
 *   · 重新生成前端 dist
 *   · cap sync ios（把网页资源打进 ios/App/App/public）
 *   · 提示到 Mac 上如何编译 / 上架
 *
 * 在 macOS 上运行时会自动 pod install 并用 xcodebuild 打出（未签名的）.app
 *
 * 用法：node scripts/build-ios.js
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var { spawnSync } = require('child_process');

var ROOT = path.join(__dirname, '..');
var IOS = path.join(ROOT, 'ios');

function say(m) { console.log('[ios] ' + m); }
function cap(args) {
  // 注意：必须把 args 展开成多个参数，否则会变成 "sync,ios" 一个参数
  return spawnSync(process.execPath,
    [path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor')].concat(args),
    { stdio: 'inherit', cwd: ROOT });
}

say('生成前端资源…');
spawnSync(process.execPath, [path.join(__dirname, 'build-web.js')], { stdio: 'inherit', cwd: ROOT });

// 版本号跟随 package.json
try {
  var pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  var vp = pkgVer.split('.').map(function (x) { return parseInt(x, 10) || 0; });
  var vcode = vp[0] * 10000 + vp[1] * 100 + vp[2];
  var pbx = path.join(IOS, 'App', 'App.xcodeproj', 'project.pbxproj');
  if (fs.existsSync(pbx)) {
    var src = fs.readFileSync(pbx, 'utf8');
    src = src.replace(/MARKETING_VERSION = [^;]+;/g, 'MARKETING_VERSION = ' + pkgVer + ';')
      .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, 'CURRENT_PROJECT_VERSION = ' + vcode + ';');
    fs.writeFileSync(pbx, src, 'utf8');
    say('版本号：' + pkgVer + '（build ' + vcode + '）');
  }
} catch (e) { console.error('  ! 写入 iOS 版本号失败：' + e.message); }

if (!fs.existsSync(IOS)) {
  say('首次生成 iOS 原生工程…');
  cap(['add', 'ios']);
} else {
  say('同步网页资源到 iOS 工程…');
  cap(['sync', 'ios']);
}

var isMac = process.platform === 'darwin';
if (!isMac) {
  console.log('\n================ iOS 构建说明 ================');
  console.log('iOS 必须用 macOS 上的 Xcode 编译，Windows 无法直接出包。');
  console.log('ios/ 目录已经生成好了，把它拷到 Mac 上即可：\n');
  console.log('  1) 把整个项目目录拷到 Mac（或用 Git 同步）');
  console.log('  2) Mac 上执行一次：');
  console.log('       cd ios/App && pod install');
  console.log('       npm run ios            # 或 open ios/App/App.xcworkspace');
  console.log('  3) Xcode 里：选自己的开发者账号 → Product → Archive → Distribute App');
  console.log('     · 只给朋友的iPhone装：选 Ad Hoc / Development，导出 ipa');
  console.log('     · 上架 App Store：选 App Store Connect');
  console.log('\n没有 Mac 也能让朋友用 iPhone 玩：');
  console.log('  · 用 Safari 打开服务器地址（http://192.168.x.x:8080），添加到主屏幕即可，');
  console.log('    体验和原生 App 几乎一样（游戏本身就是响应式网页）。');
  console.log('  · 或用云端 Mac 服务（MacinCloud / GitHub Actions macOS runner）编译。');
  console.log('=============================================\n');
  return;
}

/* ---------- macOS ---------- */
if (spawnSync('which', ['pod']).status === 0) {
  say('pod install…');
  var p = spawnSync('pod', ['install'], { stdio: 'inherit', cwd: path.join(IOS, 'App') });
  if (p.status !== 0) { console.error('[ios] pod install 失败'); process.exit(1); }
} else {
  say('未找到 CocoaPods（sudo gem install cocoapods），跳过 pod install');
}

say('xcodebuild…');
var r = spawnSync('xcodebuild', [
  '-workspace', path.join(IOS, 'App', 'App.xcworkspace'),
  '-scheme', 'App',
  '-configuration', 'Debug',
  '-sdk', 'iphonesimulator',
  '-derivedDataPath', path.join(IOS, 'build'),
  'build'
], { stdio: 'inherit', cwd: path.join(IOS, 'App') });

if (r.status !== 0) { console.error('[ios] xcodebuild 失败，退出码 ' + r.status); process.exit(1); }
say('完成，可在 Xcode 里 Archive 打包 ipa');
