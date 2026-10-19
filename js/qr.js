/* ============================================================
 * qr.js —— 极简二维码生成器（字节模式，纠错等级 M，版本 1–10）
 *
 * 用途：把「网页地址 / 邀请链接」画成二维码，手机相机一扫就能进网页版，
 *       不依赖任何外部 CDN，断网局域网也能用。
 *
 * 用法：
 *   var m = QR.matrix('http://192.168.1.10:8080');   // 二维布尔数组
 *   QR.draw(canvas, 'http://...', { size: 200, margin: 4 });
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- GF(256) ---------- */
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* ---------- 版本 / 纠错参数（M 级） ---------- */
  // blocks: [块数, 每块数据码字数]；ec: 每块纠错码字数
  var VERSIONS = {
    1: { ec: 10, blocks: [[1, 16]] },
    2: { ec: 16, blocks: [[1, 28]] },
    3: { ec: 26, blocks: [[1, 44]] },
    4: { ec: 18, blocks: [[2, 32]] },
    5: { ec: 24, blocks: [[2, 43]] },
    6: { ec: 16, blocks: [[4, 27]] },
    7: { ec: 18, blocks: [[4, 31]] },
    8: { ec: 22, blocks: [[2, 38], [2, 39]] },
    9: { ec: 22, blocks: [[3, 36], [2, 37]] },
    10: { ec: 26, blocks: [[4, 43], [1, 44]] }
  };

  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function dataCodewords(v) {
    var d = 0;
    VERSIONS[v].blocks.forEach(function (b) { d += b[0] * b[1]; });
    return d;
  }

  /* ---------- Reed-Solomon ---------- */
  function rsGenerator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1);
      for (var j = 0; j < next.length; j++) next[j] = 0;
      for (j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsRemainder(data, degree) {
    var gen = rsGenerator(degree);
    var res = new Array(degree);
    for (var i = 0; i < degree; i++) res[i] = 0;
    for (i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      for (var j = 0; j < degree; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  /* ---------- 数据编码 ---------- */
  function utf8Bytes(str) {
    if (global.TextEncoder) return Array.prototype.slice.call(new TextEncoder().encode(str));
    var s = unescape(encodeURIComponent(str)), out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var capacity = dataCodewords(v) - (v < 10 ? 2 : 3); // 模式 4bit + 长度 8/16bit
      if (byteLen <= capacity) return v;
    }
    return -1;
  }

  function encodeData(bytes, version) {
    var bits = [];
    function push(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    push(0x4, 4);                       // 字节模式
    push(bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var totalData = dataCodewords(version);
    var maxBits = totalData * 8;
    var term = Math.min(4, maxBits - bits.length);
    for (i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    var cw = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      cw.push(b);
    }
    var pad = [0xEC, 0x11], k = 0;
    while (cw.length < totalData) cw.push(pad[k++ % 2]);
    return cw;
  }

  function interleave(codewords, version) {
    var info = VERSIONS[version];
    var blocks = [], offset = 0;
    info.blocks.forEach(function (b) {
      for (var n = 0; n < b[0]; n++) {
        blocks.push(codewords.slice(offset, offset + b[1]));
        offset += b[1];
      }
    });

    var ecBlocks = blocks.map(function (blk) { return rsRemainder(blk, info.ec); });
    var out = [], maxLen = 0;
    blocks.forEach(function (b) { maxLen = Math.max(maxLen, b.length); });
    for (var i = 0; i < maxLen; i++) {
      blocks.forEach(function (b) { if (i < b.length) out.push(b[i]); });
    }
    for (i = 0; i < info.ec; i++) {
      ecBlocks.forEach(function (b) { out.push(b[i]); });
    }
    return out;
  }

  /* ---------- 矩阵 ---------- */
  function makeMatrix(version) {
    var size = version * 4 + 17;
    var modules = [], fn = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }

    function set(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = !!dark;
      fn[y][x] = true;
    }

    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var d = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, d !== 2 && d !== 4);
        }
      }
    }

    // 定位图案 + 分隔带
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);

    // 定时图案
    for (var i = 8; i < size - 8; i++) {
      set(i, 6, i % 2 === 0);
      set(6, i, i % 2 === 0);
    }

    // 校正图案
    var al = ALIGN[version] || [];
    for (var a = 0; a < al.length; a++) {
      for (var b = 0; b < al.length; b++) {
        var ax = al[a], ay = al[b];
        var corner = (ax === 6 && ay === 6) ||
          (ax === 6 && ay === size - 7) ||
          (ax === size - 7 && ay === 6);
        if (corner) continue;
        for (var dy2 = -2; dy2 <= 2; dy2++) {
          for (var dx2 = -2; dx2 <= 2; dx2++) {
            var dist = Math.max(Math.abs(dx2), Math.abs(dy2));
            set(ax + dx2, ay + dy2, dist !== 1);
          }
        }
      }
    }

    // 固定黑点
    set(8, size - 8, true);

    // 预留格式信息区（跳过第 6 行/列，那是定时图案）
    for (i = 0; i <= 8; i++) {
      if (i === 6) continue;
      set(8, i, false);
      set(i, 8, false);
    }
    for (i = 0; i < 8; i++) {
      set(size - 1 - i, 8, false);
      set(8, size - 1 - i, false);
    }

    // 预留版本信息区（v7+）
    if (version >= 7) {
      for (i = 0; i < 18; i++) {
        set(size - 11 + (i % 3), Math.floor(i / 3), false);
        set(Math.floor(i / 3), size - 11 + (i % 3), false);
      }
    }

    return { size: size, modules: modules, fn: fn, set: set };
  }

  function placeData(m, codewords) {
    var size = m.size, data = [], i;
    for (i = 0; i < codewords.length; i++) {
      for (var b = 7; b >= 0; b--) data.push((codewords[i] >>> b) & 1);
    }

    var bit = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!m.fn[y][x] && bit < data.length) {
            m.modules[y][x] = data[bit] === 1;
            bit++;
          }
        }
      }
    }
  }

  function maskFn(id, x, y) {
    switch (id) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  function applyMask(m, id) {
    for (var y = 0; y < m.size; y++) {
      for (var x = 0; x < m.size; x++) {
        if (!m.fn[y][x] && maskFn(id, x, y)) m.modules[y][x] = !m.modules[y][x];
      }
    }
  }

  function bchFormat(data) {
    var d = data << 10;
    for (var i = 14; i >= 10; i--) {
      if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  function bchVersion(v) {
    var d = v << 12;
    for (var i = 17; i >= 12; i--) {
      if ((d >>> i) & 1) d ^= 0x1f25 << (i - 12);
    }
    return (v << 12) | d;
  }

  function drawFormat(m, mask) {
    var bits = bchFormat((0 << 3) | mask); // M 级 = 00
    var size = m.size, i;
    for (i = 0; i <= 5; i++) m.set(8, i, ((bits >>> i) & 1) !== 0);
    m.set(8, 7, ((bits >>> 6) & 1) !== 0);
    m.set(8, 8, ((bits >>> 7) & 1) !== 0);
    m.set(7, 8, ((bits >>> 8) & 1) !== 0);
    for (i = 9; i < 15; i++) m.set(14 - i, 8, ((bits >>> i) & 1) !== 0);

    for (i = 0; i < 8; i++) m.set(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
    for (i = 8; i < 15; i++) m.set(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
    m.set(8, size - 8, true);
  }

  function drawVersion(m, version) {
    if (version < 7) return;
    var bits = bchVersion(version), size = m.size;
    for (var i = 0; i < 18; i++) {
      var bit = ((bits >>> i) & 1) !== 0;
      var a = size - 11 + (i % 3), b = Math.floor(i / 3);
      m.set(a, b, bit);
      m.set(b, a, bit);
    }
  }

  /* ---------- 掩码评分 ---------- */
  function penalty(mods, size) {
    var score = 0, x, y, i;

    // 规则 1：连续同色 ≥5
    for (y = 0; y < size; y++) {
      var run = 1;
      for (x = 1; x < size; x++) {
        if (mods[y][x] === mods[y][x - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (x = 0; x < size; x++) {
      var run2 = 1;
      for (y = 1; y < size; y++) {
        if (mods[y][x] === mods[y - 1][x]) run2++;
        else { if (run2 >= 5) score += 3 + (run2 - 5); run2 = 1; }
      }
      if (run2 >= 5) score += 3 + (run2 - 5);
    }

    // 规则 2：2×2 同色
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = mods[y][x];
        if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) score += 3;
      }
    }

    // 规则 3：类似定位图案
    var p1 = [true, false, true, true, true, false, true, false, false, false, false];
    var p2 = [false, false, false, false, true, false, true, true, true, false, true];
    function matchRow(y, offset) {
      for (var j = 0; j < 11; j++) if (mods[y][offset + j] !== p1[j]) return false;
      return true;
    }
    function matchRow2(y, offset) {
      for (var j = 0; j < 11; j++) if (mods[y][offset + j] !== p2[j]) return false;
      return true;
    }
    for (y = 0; y < size; y++) {
      for (x = 0; x <= size - 11; x++) {
        if (matchRow(y, x) || matchRow2(y, x)) score += 40;
      }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y <= size - 11; y++) {
        var ok1 = true, ok2 = true;
        for (i = 0; i < 11; i++) {
          if (mods[y + i][x] !== p1[i]) ok1 = false;
          if (mods[y + i][x] !== p2[i]) ok2 = false;
        }
        if (ok1 || ok2) score += 40;
      }
    }

    // 规则 4：黑白比例
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mods[y][x]) dark++;
    var percent = dark * 100 / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  /* ---------- 对外 ---------- */
  var QR = {};

  QR.matrix = function (text, forceMask) {
    var bytes = utf8Bytes(String(text));
    var version = pickVersion(bytes.length);
    if (version < 0) return null; // 太长，画不了（>213 字节）

    var codewords = interleave(encodeData(bytes, version), version);
    var best = null, bestScore = Infinity;
    var only = (forceMask == null || forceMask < 0) ? -1 : (forceMask & 7);

    for (var mask = 0; mask < 8; mask++) {
      if (only >= 0 && mask !== only) continue;
      var m = makeMatrix(version);
      placeData(m, codewords);
      drawFormat(m, mask);
      drawVersion(m, version);
      applyMask(m, mask);
      var sc = penalty(m.modules, m.size);
      if (sc < bestScore) {
        bestScore = sc;
        best = m.modules.map(function (row) { return row.slice(); });
      }
    }
    return best;
  };

  QR.draw = function (canvas, text, opt) {
    opt = opt || {};
    var size = opt.size || 180;
    var margin = opt.margin == null ? 4 : opt.margin;
    var dark = opt.dark || '#14532d';
    var light = opt.light || '#ffffff';
    var m = QR.matrix(text);
    if (!m || !canvas) return false;

    var n = m.length + margin * 2;
    var scale = Math.max(1, Math.floor(size / n));
    var px = n * scale;
    var dpr = global.devicePixelRatio || 1;
    canvas.width = px * dpr;
    canvas.height = px * dpr;
    canvas.style.width = px + 'px';
    canvas.style.height = px + 'px';

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = dark;
    for (var y = 0; y < m.length; y++) {
      for (var x = 0; x < m.length; x++) {
        if (m[y][x]) {
          ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
        }
      }
    }
    return true;
  };

  QR.capacity = function () { return pickVersion; };

  global.QR = QR;
  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
})(typeof window !== 'undefined' ? window : globalThis);
