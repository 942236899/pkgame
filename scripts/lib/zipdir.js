/* ============================================================
 * lib/zipdir.js —— 把一个目录打成 zip（纯 Node，无第三方依赖）
 *
 * 为什么自己写：项目里没有也不打算加 archiver 之类的大依赖，
 * 而 zlib 自带的 deflateRaw 足够；1000 多个文件打 170MB 约 3 秒。
 *
 * 特点：
 *   · zip 内统一带一层同名根目录（Windows「全部解压缩」后不会散落文件）
 *   · 文件名标记 UTF-8（bit 11），中文路径不乱码
 *   · 大文件用 level 1 快速压，小文件用 level 6 压得更小
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

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

/**
 * @param {string} srcDir   要打包的目录
 * @param {string} outZip   输出 zip 路径
 * @param {string} innerName zip 内的根目录名
 * @param {object} [opt]    { quiet:false, onProgress:fn }
 * @returns {{ok:boolean, files:number, bytes:number}}
 */
function zipDir(srcDir, outZip, innerName, opt) {
  opt = opt || {};
  if (!fs.existsSync(srcDir)) throw new Error('找不到目录：' + srcDir);

  var files = [];
  walk(srcDir, '', files);
  files.sort(function (a, b) { return a.rel < b.rel ? -1 : 1; });

  if (!opt.quiet) console.log('打包 ' + files.length + ' 个文件 → ' + path.basename(outZip));

  var fd = fs.openSync(outZip, 'w');
  var offset = 0;
  var central = [];

  function writeBuf(buf) {
    fs.writeSync(fd, buf, 0, buf.length);
    offset += buf.length;
  }

  files.forEach(function (f, idx) {
    var nameBuf = Buffer.from(innerName + '/' + f.rel, 'utf8');
    var data = fs.readFileSync(f.full);
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

    if (!opt.quiet && (idx + 1) % 50 === 0) process.stdout.write('  ' + (idx + 1) + '/' + files.length + '\r');
    if (typeof opt.onProgress === 'function') opt.onProgress(idx + 1, files.length);
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

  if (!opt.quiet) console.log('完成：' + outZip + '  (' + (offset / 1024 / 1024).toFixed(1) + ' MB)');
  return { ok: true, files: files.length, bytes: offset };
}

module.exports = { zipDir: zipDir, crc32: crc32 };
