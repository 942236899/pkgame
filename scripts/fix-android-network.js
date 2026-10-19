/* ============================================================
 * fix-android-network.js —— 在 `npx cap add android` 之后执行一次
 * 作用：允许 App 通过明文 http/ws 访问局域网里的联机服务器
 *       （Android 9+ 默认禁止 cleartext 流量，不配会连不上房间）
 * 用法：node scripts/fix-android-network.js
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'xml');
var MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(MANIFEST)) {
  console.log('未找到 android 工程，请先执行：npx cap add android');
  process.exit(0);
}

if (!fs.existsSync(RES)) fs.mkdirSync(RES, { recursive: true });

fs.writeFileSync(path.join(RES, 'network_security_config.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<network-security-config>\n' +
  '    <domain-config cleartextTrafficPermitted="true">\n' +
  '        <domain includeSubdomains="true">localhost</domain>\n' +
  '        <domain includeSubdomains="true">127.0.0.1</domain>\n' +
  '        <domain includeSubdomains="true">192.168.0.0</domain>\n' +
  '        <domain includeSubdomains="true">10.0.0.0</domain>\n' +
  '    </domain-config>\n' +
  '</network-security-config>\n', 'utf8');

var m = fs.readFileSync(MANIFEST, 'utf8');
if (m.indexOf('networkSecurityConfig') < 0) {
  m = m.replace(
    /<application\s/g,
    '<application android:networkSecurityConfig="@xml/network_security_config" '
  );
  fs.writeFileSync(MANIFEST, m, 'utf8');
  console.log('已写入 network_security_config.xml 并修改 AndroidManifest.xml');
} else {
  console.log('AndroidManifest.xml 已配置过，跳过');
}
