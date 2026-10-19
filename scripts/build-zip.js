/* ============================================================
 * build-zip.js —— 把 Windows 客户端 / 服务端整个文件夹打成 zip
 *
 *  发布/TMH-谁是队友-Windows客户端.zip
 *  发布/TMH-谁是队友服务器-Windows服务端.zip
 *
 * 为什么需要：Electron 程序不是单文件程序，exe 旁边必须有
 * icudtl.dat / *.pak / locales / 一堆 dll / resources 才能启动。
 * 只把 exe 拷到别的电脑会报：
 *   ERROR:base\i18n\icu_util.cc:237] Invalid file descriptor to ICU data received.
 * 打成一个 zip，就是为了让「换台电脑」只需要复制一个文件。
 * zip 内统一带一层同名文件夹，Windows「全部解压缩」后不会散落一千个文件。
 *
 * 用法：
 *   node scripts/build-zip.js all       （默认，客户端 + 服务端）
 *   node scripts/build-zip.js client
 *   node scripts/build-zip.js server
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..');
var PUB = path.join(ROOT, '发布');

var TARGETS = {
  client: {
    src: path.join(PUB, 'TMH-谁是队友'),
    zip: path.join(PUB, 'TMH-谁是队友-Windows客户端.zip'),
    inner: 'TMH-谁是队友',
    hint: '把这个 zip 拷到别的电脑，右键「全部解压缩」，再双击里面的 TMH-谁是队友.exe 即可。'
  },
  server: {
    src: path.join(PUB, 'TMH-谁是队友服务器'),
    zip: path.join(PUB, 'TMH-谁是队友服务器-Windows服务端.zip'),
    inner: 'TMH-谁是队友服务器',
    hint: '把这个 zip 拷到服务器电脑，右键「全部解压缩」，再双击里面的 TMH-谁是队友服务器.exe 即可。'
  }
};

/* ---------- CRC32 ---------- */
var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- 收集文件 ---------- */
function walk(dir, base, list) {
  fs.readdirSync(dir).forEach(function (name) {
    var full = path.join(dir, name);
    var rel = base ? base + '/' + name : name;
    var st = fs.statSync(full);
    if (st.isDirectory()) walk(full, rel, list);
    else if (st.isFile()) list.push({ full: full, rel: rel, size: st.size, mtime: st.mtime });
  });
}
function dosTime(d) {
  var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  var date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time, date: date };
}

function build(t) {
  if (!fs.existsSync(t.src)) {
    console.error('找不到目录：' + t.src + '\n请先运行 node scripts/build-exe.js all');
    return false;
  }
  var files = [];
  walk(t.src, '', files);
  files.sort(function (a, b) { return a.rel < b.rel ? -1 : 1; });

  console.log('\n打包 ' + files.length + ' 个文件 → ' + t.zip);
  var fd = fs.openSync(t.zip, 'w');
  var offset = 0;
  var central = [];

  function writeBuf(buf) {
    fs.writeSync(fd, buf, 0, buf.length);
    offset += buf.length;
  }

  files.forEach(function (f, idx) {
    var nameBuf = Buffer.from(t.inner + '/' + f.rel, 'utf8');
    var data = fs.readFileSync(f.full);
    // 大文件用 level 1 快速压（247MB 的 exe 约 3 秒），小文件用 level 6 压得更小
    var big = data.length > 4 * 1024 * 1024;
    var comp = zlib.deflateRawSync(data, { level: big ? 1 : 6 });
    var crc = crc32(data);
    var dt = dosTime(f.mtime);

    var local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    var localOffset = offset;
    writeBuf(local);
    writeBuf(nameBuf);
    writeBuf(comp);

    var cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dt.time, 12);
    cen.writeUInt16LE(dt.date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    if ((idx + 1) % 20 === 0) process.stdout.write('  ' + (idx + 1) + '/' + files.length + '\r');
  });

  var cenStart = offset;
  central.forEach(writeBuf);
  var cenSize = offset - cenStart;

  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(cenStart, 16);
  end.writeUInt16LE(0, 20);
  writeBuf(end);
  fs.closeSync(fd);

  console.log('\n完成：' + t.zip + '  (' + (offset / 1024 / 1024).toFixed(1) + ' MB)');
  console.log(t.hint);
  return true;
}

var which = process.argv[2] || 'all';
var keys = which === 'all' ? ['client', 'server'] : [which];
keys.forEach(function (k) {
  if (!TARGETS[k]) {
    console.error('未知目标：' + k + '（可用 client / server / all）');
    process.exit(1);
  }
});
var allOk = true;
keys.forEach(function (k) { if (!build(TARGETS[k])) allOk = false; });
process.exit(allOk ? 0 : 1);
