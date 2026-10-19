/* ============================================================
 * main.js —— 游戏控制器（流程、AI 调度、联机收发）
 * ============================================================ */
(function (global) {
  'use strict';

  var C = global.Cards;
  var K = global.Combos;
  var AI = global.AI;
  var Net = global.Net;
  var UI = global.UI;

  var NAMES = ['阿强', '小美', '老王', '大熊', '阿珍', '闪电', '老K', '虎子', '冰糖', '阿福', '飞鱼', '小辣椒', '阿豪', '茉莉'];
  var AVATARS = ['🙂', '😎', '🐯', '🦊', '🐼', '🐵', '🦁', '🐧', '🤖', '👽', '🎩', '🧑‍🚀'];

  function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  var App = {
    game: null,
    mySeat: 0,
    myName: '我',
    mode: 'solo',          // solo | match | friend
    netRole: 'local',      // local | host | guest
    selected: {},
    hintSet: null,
    hintIdx: 0,
    dealing: false,
    aiTimer: null,
    roomPlayers: {},       // P2P host: seat -> {name, avatar}
    pendingTribute: null,
    pendingDeclare: null,
    sound: true,
    record: { win: 0, lose: 0 },   // 只记输赢，不计分
    // v1.3.6：strictType 固定为 false —— 4带1 > 3带2 > 顺子 > 纯3张，五张组合牌一律能压纯3张
    settings: { sound: true, strictType: false, flushBySuit: false, server: '' },

    /* 回合计时 / 托管 / 断线重连 */
    turnInfo: null,        // {seat, left, total, at}
    trusteeFlags: null,    // [bool x4] 服务器下发的托管状态
    offlineFlags: null,    // [bool x4] 掉线状态
    onlineRoom: null,      // {code, token} 断线重连凭据
    roomIsHost: false,     // 服务器联机：我是不是房主
    roomPlaying: false,    // 这个房间已经开局：之后不再弹"房间等待页"
    ready: false,          // v1.3.6：本局我是否已点「准备」
    readyList: null,       // 全员准备情况 [bool×4]
    readyAll: false,
    readyWaiting: [],      // 还没准备的人名
    leaving: false,
    humanTimer: null,
    reconnectTry: 0
  };

  /* ---------------- 战绩（只统计输赢，不做积分） ---------------- */
  App.loadRecord = function () {
    try {
      var raw = localStorage.getItem('pk_record');
      if (raw) {
        var r = JSON.parse(raw);
        App.record = { win: r.win || 0, lose: r.lose || 0 };
      }
    } catch (e) { }
  };
  App.saveRecord = function () {
    try { localStorage.setItem('pk_record', JSON.stringify(App.record)); } catch (e) { }
  };
  App.tallyResult = function () {
    var g = App.game;
    if (!g || !g.teams) return;
    if (g._tallied === g.round) return;
    g._tallied = g.round;
    var myWin;
    if (g.soloSeat === App.mySeat) myWin = (g.players[App.mySeat].place === 1);
    else myWin = (g.teamOf(App.mySeat) === g.teamOf(g.finishOrder[0]));
    if (myWin) App.record.win++; else App.record.lose++;
    App.saveRecord();
  };

  /* ---------------- 设置 ---------------- */
  App.applySettings = function () {
    K.setStrictType(App.settings.strictType);
    K.setFlushBySuit(!!App.settings.flushBySuit);
    App.sound = App.settings.sound;
    try { localStorage.setItem('pk_settings', JSON.stringify(App.settings)); } catch (e) { }
  };
  App.loadSettings = function () {
    try {
      var raw = localStorage.getItem('pk_settings');
      if (raw) {
        var s = JSON.parse(raw);
        App.settings = {
          sound: s.sound !== false,
          strictType: false,                    // v1.3.6：固定宽松（纯3张可被五张组合牌压）
          flushBySuit: !!s.flushBySuit,         // 同花默认先比牌面
          server: s.server || ''
        };
      }
    } catch (e) { }
    App.applySettings();
  };

  /* ---------------- 基础工具 ---------------- */
  App.isHost = function () { return App.netRole !== 'guest'; };
  // 非权威端：P2P 客人 或 服务器联机客户端（引擎与电脑玩家都在服务端跑）
  App.isGuest = function () { return App.netRole === 'guest' || App.netRole === 'client'; };
  // P2P 联机（直连，不需要服务器）
  App.online = function () { return App.netRole === 'host' || App.netRole === 'guest'; };
  App.canOperate = function () {
    var g = App.game;
    return !!g && g.phase === 'playing' && g.turn === App.mySeat;
  };

  /** 当前选中的牌能不能出（失败时给出具体原因，按钮与提示共用） */
  App.selInfo = function () {
    var g = App.game;
    var cards = Object.keys(App.selected || {}).map(function (k) { return App.selected[k]; });
    if (!g) return { n: 0, ok: false, reason: '还不能出牌' };
    if (!cards.length) return { n: 0, ok: false, reason: '请先点牌选中，再点「出牌」' };
    if (g.phase !== 'playing') return { n: cards.length, ok: false, reason: '现在不是出牌阶段' };
    var v = { ok: false, msg: '' };
    try { v = g.validate(App.mySeat, cards) || v; } catch (e) { }
    return {
      n: cards.length,
      ok: !!v.ok,
      reason: v.ok ? '' : (v.msg || '这手牌现在不能出')
    };
  };

  /* ---------------- 回合计时 ----------------
   * v1.3.8：每人 15 秒。跟牌超时自动过牌；自由出牌超时自动打出最小的一张。
   * 服务器联机：倒计时由服务器权威下发（view.turnLeft），客户端只做本地递减。
   * ---------------------------------------------------- */
  var TURN_MS = 15000;

  /** 自由出牌超时 / 托管兜底：打出最小的一张（首手必须带 ♣4 时打 ♣4） */
  App.smallestLead = function (seat) {
    var g = App.game;
    if (!g) return null;
    var hand = g.p(seat) ? g.p(seat).hand : (g.players[seat] ? g.players[seat].hand : []);
    if (!hand || !hand.length) return null;
    if (g.mustIncludeClub4 && g.mustIncludeClub4(seat)) {
      var c4 = hand.filter(C.isClub4)[0];
      if (c4) return c4;
    }
    return C.sortAsc(hand)[0];
  };

  App.setTurnClock = function (seat, left, total) {
    if (seat === null || seat === undefined || !(left > 0)) { App.turnInfo = null; return; }
    App.turnInfo = {
      seat: seat,
      left: Math.max(0, left),
      total: total || TURN_MS,
      at: Date.now()
    };
  };

  App.turnRemain = function () {
    var t = App.turnInfo;
    if (!t) return null;
    return Math.max(0, t.left - (Date.now() - t.at));
  };

  App.clearHumanClock = function () {
    clearTimeout(App.humanTimer);
    App.humanTimer = null;
    App.turnInfo = null;
  };

  /** 单机 / 好友房：给当前该出牌的真人开 15 秒计时，超时代打 */
  App.startHumanClock = function () {
    clearTimeout(App.humanTimer);
    App.humanTimer = null;
    var g = App.game;
    if (!g || g.phase !== 'playing') { App.turnInfo = null; return; }
    var seat = g.turn;
    if (App.isGuest()) return;                 // 客人端由伺服端/房主驱动
    App.setTurnClock(seat, TURN_MS, TURN_MS);

    App.humanTimer = setTimeout(function () {
      var gg = App.game;
      if (!gg || gg.phase !== 'playing' || gg.turn !== seat) return;
      App.autoActLocal(seat, 'timeout');
    }, TURN_MS);
  };

  /** 超时 / 托管：替这个座位走一步（本地引擎模式）
   *  v1.3.8：超时不再"聪明出牌" —— 跟牌就过牌，自由出牌就打最小的一张，
   *  和规则说明完全一致，玩家不用猜系统会不会突然甩一把大牌。 */
  App.autoActLocal = function (seat, reason) {
    var g = App.game;
    if (!g || g.phase !== 'playing' || g.turn !== seat) return false;
    var ok = false;
    if (reason === 'timeout') {
      if (g.trick) ok = App.execPass(seat);
      else {
        var one = App.smallestLead(seat);
        if (one) ok = App.execPlay(seat, [one]);
        else ok = App.execPass(seat);
      }
    } else {
      var d = null;
      try { d = AI.decide(g, seat); } catch (e) { d = null; }
      if (d && d.type === 'pass') ok = App.execPass(seat);
      else if (d && d.type === 'play' && d.cards && d.cards.length) ok = App.execPlay(seat, d.cards);
    }
    if (!ok) {
      var opts = [];
      try { opts = g.options(seat) || []; } catch (e) { }
      if (opts.length) ok = App.execPlay(seat, opts[0].cards);
      else ok = App.execPass(seat);
    }
    if (ok && seat === App.mySeat) {
      UI.toast(reason === 'trustee'
        ? '🤖 你正在托管，系统已自动出牌'
        : (g.trick ? '⏰ 超过 15 秒没出牌，系统已自动过牌' : '⏰ 超过 15 秒没出牌，系统已自动打出最小的一张'), 2200);
      App.sfx('tap');
    }
    return ok;
  };

  /** 托管开关（服务器联机才有；点一下交给系统，再点收回手动）
   *  v1.3.4：
   *   · 本地立刻生效 —— 按钮马上在「托管 / 取消托管」之间切换，
   *     出牌相关的按钮同时收起或恢复，不等服务器回包，手感才跟手；
   *   · 全程不弹房间菜单（服务器已改成开局后不再广播房间等待页）。 */
  App.toggleTrustee = function (on) {
    if (App.netRole !== 'client') return;
    on = !!on;
    Net.sendWS({ type: 'trustee', on: on });
    if (!App.trusteeFlags) App.trusteeFlags = [false, false, false, false];
    App.trusteeFlags[App.mySeat] = on;
    if (!on) { App.selected = {}; App.hintSet = null; }
    UI.closeModalKind('room');
    UI.renderAll();
    UI.toast(on
      ? '🤖 已开启托管：出牌按钮已收起，系统替你出牌'
      : '✋ 已取消托管：出牌按钮已恢复，可以自己打了', 2400);
  };

  App.myTrustee = function () {
    var f = App.trusteeFlags;
    return !!(f && f[App.mySeat]);
  };
  /** 托管中 / 掉线被托管时，禁止自己动手出牌（兜底，按钮本来也收起了） */
  App.blockedByTrustee = function () {
    if (App.netRole !== 'client') return false;
    if (!App.myTrustee()) return false;
    UI.toast('托管中：先点「取消托管」才能自己出牌', 2000);
    return true;
  };
  App.modeName = function () {
    if (App.mode === 'online') return '联机对战';
    if (App.mode === 'match') return '随机匹配';
    if (App.mode === 'friend') return '好友房';
    return '单人练习';
  };

  App.sfx = function (kind) {
    if (!App.sound) return;
    try {
      var ctx = App._ac || (App._ac = new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      if (kind === 'turn') {
        // 轮到你出牌：两声上行短音，比普通点击声更抓耳朵
        [[784, 0], [1175, 0.13]].forEach(function (n) {
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'triangle';
          o.frequency.value = n[0];
          g.gain.setValueAtTime(0.0001, ctx.currentTime + n[1]);
          g.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + n[1] + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + n[1] + 0.22);
          o.connect(g); g.connect(ctx.destination);
          o.start(ctx.currentTime + n[1]);
          o.stop(ctx.currentTime + n[1] + 0.24);
        });
        return;
      }
      var o = ctx.createOscillator(), g = ctx.createGain();
      if (kind === 'drop') {
        // 任意一家打出新操作：一声更短、更轻的落牌音
        o.type = 'sine';
        o.frequency.setValueAtTime(520, ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(330, ctx.currentTime + 0.05);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07);
        o.connect(g); g.connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.08);
        return;
      }
      var f = kind === 'play' ? 660 : kind === 'tick' ? 1046 : kind === 'tap' ? 880 : 520;
      o.type = kind === 'tick' ? 'square' : 'sine';
      o.frequency.value = f;
      g.gain.value = kind === 'tick' ? 0.05 : 0.06;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.frequency.exponentialRampToValueAtTime(f * 0.7, ctx.currentTime + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      o.stop(ctx.currentTime + 0.13);
    } catch (e) { }
  };

  /* 生成「网页进入」地址：手机扫码 / 复制到浏览器即可玩
   *  - 复制出的链接带 ?server=，打开后自动连到这台服务器
   *  - 如果当前是 127.0.0.1（桌面客户端），自动换成局域网 IP，手机才连得上 */
  App.shareInfo = function (opt, cb) {
    opt = opt || {};
    var base = (App.settings && App.settings.server ? String(App.settings.server) : '').replace(/\/+$/, '');

    if (!base) {
      if (location.protocol === 'file:' || Net.isApp()) {
        cb({ error: '当前是本地 App / 本地文件打开，没有可分享的网址。请先连上服务器（或在设置里填写服务器地址）后再分享。' });
        return;
      }
      base = location.origin;
    }

    var hostPart = base.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    var host = hostPart.split(':')[0];
    var port = hostPart.split(':')[1] || '';
    var isLocal = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])$/i.test(host);

    function build(b) {
      b = b.replace(/\/+$/, '');
      var u = b + '/?server=' + encodeURIComponent(b);
      if (opt.room) u += '&room=' + encodeURIComponent(opt.room);
      cb({ url: u, base: b, lan: b !== base });
    }

    if (!isLocal) { build(base); return; }

    // 桌面客户端 / 本机浏览器：向服务器要局域网地址
    try {
      fetch(base + '/api/lan', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var ip = (j && j.addresses && j.addresses[0]) || '';
          if (!ip) { build(base); return; }
          build('http://' + ip + (port ? ':' + port : ''));
        })
        .catch(function () { build(base); });
    } catch (e) {
      build(base);
    }
  };

  /* ---------------- 复制到剪贴板 ----------------
   * 三層兜底（v1.3.3）：
   *   ① 安卓 / iOS App：走原生 TmhClipboard 插件（WebView 里 execCommand 常被拦）
   *   ② 浏览器安全上下文：navigator.clipboard.writeText（失败会 catch 后继续往下走）
   *   ③ 老浏览器 / WebView：隐藏 textarea + execCommand('copy')
   * 复制失败不再谎报成功，而是弹出可长按选中的文本框，让用户手动复制。
   * 回调：cb(ok)  */
  App.copy = function (text, cb) {
    text = String(text == null ? '' : text);
    var settled = false;

    function done(ok, why) {
      if (settled) return;
      settled = true;
      if (cb) cb(!!ok, why || '');
      else if (typeof UI !== 'undefined') {
        if (!ok) UI.showCopyFallback(text);
      }
    }

    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      // 不能用 opacity:0 / display:none，老 WebView 会拒绝复制不可见元素
      ta.style.position = 'fixed';
      ta.style.left = '0';
      ta.style.top = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.padding = '0';
      ta.style.border = '0';
      ta.style.zIndex = '-1';
      ta.style.background = 'transparent';
      document.body.appendChild(ta);
      var ok = false;
      try {
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
      } catch (e) { ok = false; }
      try { document.body.removeChild(ta); } catch (e) { }
      done(ok, ok ? '' : '浏览器不允许自动复制');
    }

    // ① 原生插件
    try {
      var cap = global.Capacitor;
      var plug = cap && cap.Plugins && cap.Plugins.TmhClipboard;
      if (plug && typeof plug.copy === 'function') {
        plug.copy({ text: text }).then(function () { done(true); }, function () { fallback(); });
        // 原生调用迟迟不回调时也不要卡住
        setTimeout(function () { if (!settled) fallback(); }, 2500);
        return;
      }
    } catch (e) { }

    // ② 标准 API
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
        return;
      }
    } catch (e) { }
    fallback();
  };

  /* ---------------- 改名 ----------------
   * v1.3.5：原来用的是浏览器原生 window.prompt()，
   * PC 客户端（Electron）根本不实现 prompt —— 点了「改名」没任何反应。
   * 改成游戏内输入弹窗（UI.showPrompt），网页 / PC / 手机三端统一。 */
  App.askName = function () {
    UI.showPrompt({
      title: '改个昵称',
      sub: '最多 8 个字，房间里的其他玩家会马上看到',
      value: App.myName,
      max: 8,
      placeholder: '你的昵称',
      emptyText: '昵称不能为空',
      onOk: function (v) { App.applyName(v); },
      onCancel: function () { UI.showMenu(); }
    });
  };

  /** 落地新昵称：本地存档 + 同步给服务器 / 本地牌桌 */
  App.applyName = function (name) {
    var v = String(name || '').trim().slice(0, 8);
    if (!v) { UI.toast('昵称不能为空'); return; }
    var old = App.myName;
    App.myName = v;
    try { localStorage.setItem('pk_name', v); } catch (e) { }

    // 联机：告诉服务器，座位名和牌桌上的名字一起更新
    if (App.netRole === 'client') {
      try { Net.sendWS({ type: 'rename', name: v }); } catch (e) { }
    }
    // 好友直连（P2P 房主）
    if (App.roomPlayers && App.roomPlayers[0]) App.roomPlayers[0].name = v;
    // 本地牌桌 / 影子局面
    if (App.game && App.game.players[App.mySeat]) App.game.players[App.mySeat].name = v;

    if (App.game) UI.renderAll();
    else UI.showMenu();
    UI.toast(old === v ? '昵称：' + v : '昵称已改为「' + v + '」', 2000);
  };

  App.confirmMenu = function () {
    var md = UI.modal('<h2>暂停</h2><div class="sub">要离开当前牌桌吗？</div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn primary" data-back="1">继续游戏</button>' +
      '<button class="btn ghost" data-rule="1">看规则</button>' +
      '<button class="btn danger" data-menu="1">返回菜单</button></div>');
    md.querySelector('[data-back]').addEventListener('click', UI.closeModal);
    md.querySelector('[data-rule]').addEventListener('click', UI.showRules);
    md.querySelector('[data-menu]').addEventListener('click', function () { UI.closeModal(); App.toMenu(); });
  };

  App.toMenu = function () {
    clearTimeout(App.aiTimer);
    App.clearHumanClock();
    App.leaving = true;
    if (App.netRole === 'client' && Net.ws) {
      try { Net.sendWS({ type: 'leave' }); Net.ws.close(); } catch (e) { }
    }
    App.onlineRoom = null;
    App.roomIsHost = false;
    App.roomPlaying = false;
    App.trusteeFlags = null;
    App.offlineFlags = null;
    App.game = null;
    App.netRole = 'local';
    App.roomPlayers = {};
    try { Net.close(); } catch (e) { }
    App.mySeat = 0;
    setTimeout(function () { App.leaving = false; }, 300);
    UI.hideCounter();
    UI.bubbles = {};
    UI.resetZones();
    document.getElementById('hand').innerHTML = '';
    document.getElementById('actions').innerHTML = '';
    document.getElementById('mybar').innerHTML = '';
    ['seat1', 'seat2', 'seat3'].forEach(function (id) { document.getElementById(id).innerHTML = ''; });
    document.getElementById('centerTip').textContent = '';
    document.getElementById('metaInfo').textContent = '';
    UI.showMenu();
    if (App.refreshRotateHint) App.refreshRotateHint();
  };

  /* ---------------- 开局 ---------------- */
  App.startMode = function (mode) {
    App.mode = mode;
    if (mode === 'solo' || mode === 'match') {
      var start = function () {
        var players = [{ name: App.myName, avatar: '🙂', isAI: false }];
        for (var i = 1; i < 4; i++) {
          players.push({ name: rnd(NAMES), avatar: rnd(AVATARS), isAI: true });
        }
        App.mySeat = 0;
        App.netRole = 'local';
        App.createGame(players);
      };
      if (mode === 'match') UI.showMatching(start);
      else { UI.closeModal(); start(); }   // 关掉主菜单，避免盖在牌桌上
    } else if (mode === 'online') {
      App.connectServer(function (err) {
        if (err) {
          UI.toast('连不上服务器：' + err.message, 4200);
          // 停在地址填写页，方便改地址 / 换端口立刻重试
          UI.showOnline();
          return;
        }
        UI.showOnline();
      });
    } else {
      App.friendFlow();
    }
  };

  /* ---------------- 服务器联机 ---------------- */
  App.connectServer = function (cb) {
    Net.onWSMessage = App.onServerMessage;
    Net.onStatus = function (t) { UI.toast(t, 2200); };
    Net.onWSClose = function (ev) {
      if (App.netRole !== 'client') return;
      if (App.leaving) return;
      var why = '';
      if (ev && ev.code && ev.code !== 1000) {
        why = ev.code === 1006 ? '（网络中断）' : '（代码 ' + ev.code + '）';
      }
      UI.toast('⚠ 与服务器断开' + why + '，正在自动重连…服务器会先帮你托管', 3200);
      App.reconnectTry = 0;
      App.tryReconnect();
    };
    var t0 = Date.now();
    Net.connectServer(App.settings.server || '', function (err) {
      if (err) { cb(err); return; }
      var sec = (Date.now() - t0) / 1000;
      App.netRole = 'client';
      App.mode = 'online';
      // 慢速外网握手时间长是正常的，给个明确反馈，避免用户以为卡死
      if (sec > 2.5) UI.toast('已连接（耗时 ' + sec.toFixed(1) + ' 秒，网络较慢）', 2200);
      cb(null);
    });
  };

  /* 掉线自动重连：指数退避，连上就凭 token 回到原座位 */
  App.tryReconnect = function () {
    if (App.netRole !== 'client' || App.leaving) return;
    if (App.reconnectTry >= 5) {
      UI.toast('重连失败，请点「返回菜单」重新进入房间', 4000);
      return;
    }
    var n = App.reconnectTry++;
    setTimeout(function () {
      if (App.netRole !== 'client' || App.leaving) return;
      App.connectServer(function (err) {
        if (err) { App.tryReconnect(); return; }
        if (App.onlineRoom && App.onlineRoom.token) {
          Net.sendWS({ type: 'resume', code: App.onlineRoom.code, token: App.onlineRoom.token });
        } else {
          UI.toast('已重新连接，请重新进入房间', 2600);
          UI.showOnline();
        }
      });
    }, Math.min(1200 + n * 1400, 6000));
  };

  /** 进入房间时若本机存着座位凭据，优先恢复原座位 */
  App.resumeOrJoin = function (code) {
    var token = '';
    try { token = sessionStorage.getItem('pk_seat_' + code) || ''; } catch (e) { }
    App._resumeCode = code;
    if (token) {
      App.onlineRoom = { code: code, token: token };
      Net.sendWS({ type: 'resume', code: code, token: token });
      return true;
    }
    Net.sendWS({ type: 'join', code: code, name: App.myName, avatar: '🙂' });
    return false;
  };


  App.ensureShadowGame = function () {
    if (App.game && App.netRole === 'client') return App.game;
    App.game = new Game({
      players: [
        { name: '玩家1', avatar: '🙂', isAI: false },
        { name: '玩家2', avatar: '😀', isAI: false },
        { name: '玩家3', avatar: '😀', isAI: false },
        { name: '玩家4', avatar: '😀', isAI: false }
      ]
    });
    return App.game;
  };

  App.onServerMessage = function (msg) {
    if (!msg) return;
    if (msg.type === 'hello') {
      App.mySeat = msg.seat;
      if (msg.isHost !== undefined) App.roomIsHost = !!msg.isHost;
      App.ensureShadowGame();
      App.game.players[msg.seat].name = App.myName;
      if (msg.code && msg.token) {
        App.onlineRoom = { code: msg.code, token: msg.token };
        try { sessionStorage.setItem('pk_seat_' + msg.code, msg.token); } catch (e) { }
      }
      if (msg.resumed) UI.toast('已回到原座位，继续游戏', 2000);
      return;
    }
    if (msg.type === 'room') {
      App.ensureShadowGame();
      App.roomIsHost = !!msg.isHost;
      /* v1.3.4：房间只要已经开局，就绝不弹"房间等待页"。
       * 以前「玩家点托管」「有人掉线」「有人重连」服务器都会广播 room，
       * 客户端就把"房间码 + 开始游戏"菜单盖到牌桌上，四个人都没法出牌。 */
      var phase0 = App.game && App.game.phase;
      var busy = msg.started === true || App.roomPlaying === true || (phase0 && phase0 !== 'idle');
      var sameRoom = !App.onlineRoom || App.onlineRoom.code === msg.code;
      if (busy && sameRoom) {
        if (UI._onlinePaint && msg.seats) UI.updateOnlineSeats(msg.seats);
        UI.closeModalKind('room');
        return;
      }
      UI.showOnlineRoom({
        code: msg.code,
        isHost: !!msg.isHost,
        seats: msg.seats,
        link: App.inviteLink(msg.code)
      });
      return;
    }
    if (msg.type === 'leader') {
      // 本局谁先出、凭什么先出（♣4 持有者 / 进贡最大牌）
      setTimeout(function () { UI.sayLeader(msg); }, 260);
      return;
    }
    if (msg.type === 'tributeStart') {
      UI.toast('本局需要进贡：' + (msg.desc || ''), 3000);
      return;
    }
    if (msg.type === 'dissolved') {
      UI.closeModal();
      App.onlineRoom = null;
      App.roomPlaying = false;
      UI.toast('房间已解散，正在新建房间…', 2200);
      App.onlineCreate();
      return;
    }
    if (msg.type === 'roomClosed') {
      UI.closeModal();
      App.onlineRoom = null;
      App.roomPlaying = false;
      App.game = null;
      UI.toast(msg.msg || '房间已解散', 3200);
      UI.showOnline();
      return;
    }
    if (msg.type === 'state') {
      App.ensureShadowGame();
      App.applyView(msg.view);
      // 开局后记住"这个房间已经在打牌了"，之后任何 room 广播都不再弹等待页
      if (msg.view && msg.view.phase && msg.view.phase !== 'idle') App.roomPlaying = true;
      /* v1.3.6：只要牌局已经开起来（宣告 / 进贡 / 出牌），
       * 房间等待页和上一局的结算窗口都必须收掉，
       * 否则它们会一直盖在牌桌上，让人点不到牌最后被托管。 */
      if (msg.view && msg.view.phase && msg.view.phase !== 'idle') UI.closeModalKind('room');
      if (msg.view && (msg.view.phase === 'playing' || msg.view.phase === 'tribute' || msg.view.phase === 'declare')) {
        UI.closeModalKind('result');
      }
      return;
    }
    if (msg.type === 'roundBegin') {
      // 房主开了新一局：收掉结算窗口，准备下一局
      UI.closeModalKind('result');
      App.ready = false;
      if (App.onlineRoom) UI.toast('第 ' + (msg.round || '') + ' 局开始', 1800);
      return;
    }
    if (msg.type === 'ready') {
      App.readyList = msg.list || null;
      App.readyAll = !!msg.all;
      App.readyWaiting = msg.waiting || [];
      if (UI._readyPaint) UI._readyPaint(msg.list || [], !!msg.all, msg.waiting || []);
      return;
    }
    if (msg.type === 'auto') {
      var nm = msg.name || (App.game && App.game.players[msg.seat] ? App.game.players[msg.seat].name : '玩家');
      var txt;
      if (msg.seat === App.mySeat) {
        txt = msg.reason === 'timeout' ? '⏰ 超过 15 秒没出牌，系统已自动过牌' : '🤖 你已掉线/托管，系统自动出牌';
      } else if (msg.reason === 'offline') {
        txt = '📴 ' + nm + ' 掉线，系统已自动托管出牌';
      } else {
        txt = '⏰ ' + nm + ' 超时，系统自动出牌';
      }
      UI.toast(txt, 2400);
      return;
    }
    if (msg.type === 'offline') {
      UI.toast('📴 ' + (msg.name || '玩家') + ' 掉线了，已由系统托管', 2600);
      return;
    }
    if (msg.type === 'resumeFail') {
      /* v1.3.4：本局没打完就不许回来。座位已经交给系统托管，
       * 这里不再自动改去 join（那只会换来一次 INGAME 报错 + 弹房间码输入页），
       * 而是停掉自动重连、明确告诉玩家什么时候能回来。 */
      if (msg.code === 'INGAME') {
        App.reconnectTry = 99;
        var tip = msg.msg || '本局游戏还在进行中，暂时不能回到座位（你的牌已由系统托管）。等这一局结束、房主重新建房后再加入。';
        UI.toast(tip, 4600);
        UI.showLockedOut(tip);
        return;
      }
      App.onlineRoom = null;
      var rc = App._resumeCode;
      App._resumeCode = null;
      if (rc) {
        try { sessionStorage.removeItem('pk_seat_' + rc); } catch (e) { }
        // 座位凭据过期（比如服务器重启过）：按新玩家重新加入
        Net.sendWS({ type: 'join', code: rc, name: App.myName, avatar: '🙂' });
        return;
      }
      UI.toast(msg.msg || '座位已释放，请重新进入房间', 3200);
      UI.showOnline();
      return;
    }
    if (msg.type === 'askDeclare') {
      UI.showDeclare(App.mySeat, function (act) {
        if (act.giveUp) Net.sendWS({ type: 'declare', giveUp: 1 });
        else Net.sendWS({ type: 'declare', yes: !!act.yes });
      });
      return;
    }
    if (msg.type === 'askTribute') {
      UI.showTribute(msg.item, function (cards) {
        Net.sendWS({ type: 'tributeCards', ids: cards.map(function (c) { return c.id; }) });
      }, msg.pool);
      return;
    }
    if (msg.type === 'error') {
      // 房间在游戏中 / 已满：留在联机页，别再弹房间等待页
      if (msg.code === 'INGAME' || msg.code === 'ROOMFULL') {
        UI.closeModal();
        UI.toast(msg.msg || '房间暂时不能加入', 4200);
        UI.showOnline();
        return;
      }
      // 有人还没准备 → 把结算窗口重新画出来，让玩家能继续点准备
      if (msg.msg && msg.msg.indexOf('没准备') >= 0 && App.game && App.game.phase === 'over') {
        UI.closeModalKind('result');
        UI.showResult();
      }
      UI.toast(msg.msg || '服务器返回错误', 3200);
      return;
    }
  };

  /* 邀请链接：任何一端打开都能直接进房
   *  - 浏览器版：用当前页面地址（局域网其它设备换成服务器 IP）
   *  - 安卓 / iOS App：页面地址是 https://localhost，不能分享，
   *    必须改用「服务器地址 + ?server=&room=」，否则复制出去的链接是死的。 */
  App.inviteLink = function (code) {
    var svr = Net.serverUrl(App.settings.server || '');
    var localHost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(location.hostname || '');
    var base = '';

    if (Net.isApp() || location.protocol === 'file:' || localHost) {
      // App / 本地浏览器：页面地址不是可分享地址，改用服务器地址
      base = svr;
    } else {
      base = location.origin + location.pathname.replace(/[^/]*$/, '');   // 保留子路径
    }
    if (!base) return '';

    var server = svr || base.replace(/\/+$/, '');
    var u = base.replace(/\/+$/, '') + '/?server=' + encodeURIComponent(server);
    if (code) u += '&room=' + encodeURIComponent(code);
    return u;
  };

  App.onlineCreate = function () {
    Net.sendWS({ type: 'create', name: App.myName, avatar: '🙂' });
  };
  App.onlineQuick = function () {
    Net.sendWS({ type: 'quick', name: App.myName, avatar: '🙂' });
    UI.toast('正在匹配…');
  };
  App.onlineJoin = function () {
    var md = UI.modal('<h2>加入房间</h2><div class="sub">输入 4 位房间码</div>' +
      '<div style="text-align:center"><input id="codeInput" maxlength="4" style="font-size:26px;letter-spacing:8px;text-align:center;width:70%;padding:10px;border-radius:12px;border:1px solid #d7e3db;text-transform:uppercase"></div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center"><button class="btn primary" data-ok="1">加入</button>' +
      '<button class="btn ghost" data-back="1">返回</button></div>', { dismissable: false });
    md.querySelector('[data-back]').addEventListener('click', UI.showOnline);
    md.querySelector('[data-ok]').addEventListener('click', function () {
      var code = (md.querySelector('#codeInput').value || '').trim().toUpperCase();
      if (code.length < 4) { UI.toast('请输入 4 位房间码'); return; }
      App.resumeOrJoin(code);
    });
  };
  App.onlineStart = function () {
    // v1.3.6：房主也要先自己点准备，才能开始
    if (!App.ready) { App.toggleReady(true); UI.toast('你已准备'); }
    Net.sendWS({ type: 'start' });
  };
  App.onlineLeave = function () { Net.sendWS({ type: 'leave' }); App.toMenu(); };

  /** 准备 / 取消准备（联机开房模式：全员准备好房主才能开局） */
  App.toggleReady = function (on) {
    if (App.netRole !== 'client') { App.ready = !!on; return; }
    App.ready = !!on;
    Net.sendWS({ type: 'ready', on: !!on });
  };

  /* 解散房间（房主）：房间一次性，解散后立刻重建，拿到新的房间码再邀请 */
  App.dissolveRoom = function () {
    if (App.netRole !== 'client') { App.toMenu(); return; }
    Net.sendWS({ type: 'dissolve' });
    UI.toast('正在解散房间…', 1500);
  };

  App.createGame = function (players) {
    var g = new Game({ players: players });
    App.game = g;
    bindEvents(g);
    App.selected = {};
    App.hintSet = null;
    UI.bubbles = {};
    App.beginRound(true);
  };

  App.beginRound = function (animate, plan) {
    var g = App.game;
    var hasTribute = !!(plan && plan.gives && plan.gives.length);
    if (App.isGuest()) { UI.renderAll(); return; }
    g.startRound();                 // 会把 g.tribute 清空，所以进贡方案要提前传进来
    App.selected = {};
    App.hintSet = null;
    App.ready = false;
    UI.bubbles = {};
    UI.resetZones();          // 新一局：桌面四块清空，下一手重新播飞入动画
    UI.closeModalKind('result');
    if (hasTribute) g.beginTribute(plan);
    if (animate) {
      App.dealing = true;
      UI.renderAll();
      setTimeout(function () { App.dealing = false; }, 500);
    } else {
      UI.renderAll();
    }
    App.broadcast();
    if (hasTribute) {
      setTimeout(function () {
        if (App.game && App.game.phase === 'tribute') UI.toast('本局需要进贡，请按提示交换手牌', 2200);
      }, animate ? 600 : 120);
      return;
    }
    // 首出权：♣4 持有者先出（有名次差的局会在进贡结束后改判）
    setTimeout(function () { App.sayLeader(); }, animate ? 560 : 80);
    App.afterMove();
  };

  /** 播报本局谁先出牌（♣4 / 进贡最大牌） */
  App.sayLeader = function () {
    var g = App.game;
    if (!g || g.firstLeader === undefined || g.firstLeader === null) return;
    UI.toast(UI.leaderText(g), 2600);
  };

  function bindEvents(g) {
    g.on('newtrick', function () {
      UI.bubbles = {};
      UI.renderAll();
    });
    // ♦A 与 ♦3 都出现 ⇒ 公开队友（只出一张时系统不标记）
    g.on('teams', function (d) {
      if (!d || !d.revealed) return;
      var gg = App.game;
      if (!gg) return;
      if (gg.soloSeat !== null && gg.soloSeat !== undefined) {
        var others = [0, 1, 2, 3].filter(function (s) { return s !== gg.soloSeat; })
          .map(function (s) { return gg.players[s].name; }).join('、');
        UI.toast('♦A 与 ♦3 都出现了：' + gg.players[gg.soloSeat].name + ' 独狼 1 打 3（' + others + ' 一队）', 3200);
      } else {
        var t = gg.teams || [[], []];
        var a = t[0].map(function (s) { return gg.players[s].name; }).join(' + ');
        var b = t[1].map(function (s) { return gg.players[s].name; }).join(' + ');
        UI.toast('♦A 与 ♦3 都出现了：' + a + ' 一队，' + b + ' 一队', 3200);
      }
      UI.renderAll();
    });
    g.on('finish', function (d) {
      UI.toast(App.game.players[d.seat].name + ' 出完了，第 ' + d.place + ' 名', 1500);
    });
  }

  /* ---------------- 宣告 / 出牌 / 过牌 ---------------- */
  App.afterMove = function () {
    var g = App.game;
    if (!g) return;
    if (App.isGuest()) return;   // 客人端一切由房主驱动

    if (g.phase === 'declare') {
      App.clearHumanClock();
      App.handleDeclare();
      return;
    }
    if (g.phase === 'over') {
      App.clearHumanClock();
      setTimeout(function () { UI.showResult(); }, 500);
      return;
    }
    if (g.phase === 'playing') {
      App.startHumanClock();      // 真人 15 秒倒计时，超时自动代打
      App.scheduleAI();
    } else {
      App.clearHumanClock();
    }
  };

  App.handleDeclare = function () {
    var g = App.game;
    if (!g.needDeclare()) { g.phase = 'playing'; App.broadcast(); App.afterMove(); return; }
    var seat = g.soloCandidate;
    if (seat === App.mySeat) {
      UI.showDeclare(seat, function (act) {
        if (act.giveUp) {
          // v1.4.0：独狼看完牌觉得没戏，直接结束本局（按"已公布 + 最后一名"交 9 收 9）
          g.soloGiveUp();
        } else {
          g.declare(!!act.yes);
        }
        App.broadcast();
        App.afterMove();
      });
      return;
    }
    if (App.online() && Net.conns[seat]) {
      // 联网真人玩家：请他自己决定（不对其他人透露任何信息）
      App.pendingDeclare = seat;
      Net.sendTo(seat, { type: 'askDeclare' });
      UI.toast('等待其他玩家准备…');
      return;
    }
    // 电脑玩家自动决定
    g.declare(AI.decideDeclare(g.players[seat].hand));
    App.broadcast();
    App.afterMove();
  };

  App.scheduleAI = function () {
    clearTimeout(App.aiTimer);
    var g = App.game;
    if (g.phase !== 'playing') return;
    var p = g.players[g.turn];
    if (!p.isAI) return;
    App.aiTimer = setTimeout(function () {
      var g2 = App.game;
      if (!g2 || g2.phase !== 'playing') return;
      var seat = g2.turn;
      if (!g2.players[seat].isAI) return;
      var d = AI.decide(g2, seat);
      if (!d) return;
      if (d.type === 'pass') App.execPass(seat);
      else App.execPlay(seat, d.cards);
    }, 480 + Math.random() * 700);
  };

  App.execPlay = function (seat, cards) {
    var g = App.game;
    var r = g.play(seat, cards);
    if (!r.ok) { UI.toast(r.msg); return false; }
    App.selected = {};
    App.hintSet = null;
    UI.bubbles = {};
    UI.renderAll();
    App.sfx('play');
    App.broadcast();
    App.afterMove();
    return true;
  };

  App.execPass = function (seat) {
    var g = App.game;
    var r = g.pass(seat);
    if (!r.ok) { UI.toast(r.msg); return false; }
    // 过牌统一显示在自己那一块的「不出」上，座位旁不再挂气泡
    UI.renderAll();
    App.broadcast();
    App.afterMove();
    return true;
  };

  // 出牌后清空手牌里的抬起状态（按钮文字、手牌、操作栏一起复位）
  App.clearSelection = function () {
    App.selected = {};
    App.hintSet = null;
    UI.renderHand();
    UI.renderActions();
  };

  App.doPlay = function () {
    var g = App.game;
    if (App.blockedByTrustee()) return;
    var cards = Object.keys(App.selected).map(function (k) { return App.selected[k]; });
    if (!cards.length) { UI.toast('请先选牌'); return; }
    var v = g.validate(App.mySeat, cards);
    if (!v.ok) { UI.toast(v.msg); App.sfx('tap'); return; }
    if (App.netRole === 'client') {
      Net.sendWS({ type: 'act', act: 'play', ids: cards.map(function (c) { return c.id; }) });
      App.clearSelection();
      return;
    }
    if (App.isGuest()) {
      Net.sendToHost({ type: 'act', act: 'play', ids: cards.map(function (c) { return c.id; }) });
      App.clearSelection();
      return;
    }
    App.execPlay(App.mySeat, cards);
  };

  App.doPass = function () {
    var g = App.game;
    if (App.blockedByTrustee()) return;
    if (!g.trick) { UI.toast('你是本轮首发，必须出牌'); return; }
    if (App.netRole === 'client') {
      Net.sendWS({ type: 'act', act: 'pass' });
      return;
    }
    if (App.isGuest()) {
      Net.sendToHost({ type: 'act', act: 'pass' });
      return;
    }
    App.execPass(App.mySeat);
  };

  App.doHint = function () {
    var g = App.game;
    /* v1.3.6：智能提示 —— 优先推荐「不拆牌」的一手：
     * 单张避开手上的对子 / 三张 / 四张，对子避开三张 / 四张，以此类推。 */
    var opts = g.hintOptions(App.mySeat);
    if (!opts.length) {
      UI.toast(g.mustIncludeClub4 && g.mustIncludeClub4(App.mySeat)
        ? '开局首出必须带 ♣4，但你手上没有 ♣4'
        : '没有能压过的牌，试试过牌');
      return;
    }
    App.hintIdx = (App.hintIdx + 1) % opts.length;
    var c = opts[App.hintIdx];
    App.selected = {};
    App.hintSet = {};
    c.cards.forEach(function (card) {
      App.selected[card.id] = card;
      App.hintSet[card.id] = true;
    });
    UI.renderHand();
    UI.renderActions();
  };

  /* ---------------- 下一局 & 进贡 ---------------- */
  App.nextRound = function () {
    var g = App.game;
    if (!g) return;
    if (App.netRole === 'client') {
      if (!App.readyAll && App.readyWaiting && App.readyWaiting.length) {
        UI.toast('还有玩家没准备：' + App.readyWaiting.join('、'), 2600);
      }
      Net.sendWS({ type: 'next' });
      UI.toast('已请求开下一局');
      return;
    }
    if (App.isGuest()) { UI.toast('等待房主开始下一局'); return; }
    var plan = g.tribute;            // 先取出上一局的进贡方案（发牌会被重置）
    var hasTribute = !!(plan && plan.gives && plan.gives.length);
    App.beginRound(true, hasTribute ? plan : null);
    if (hasTribute) setTimeout(App.execTributeStep, 900);
  };

  /** 进贡流程（本地 / 主机模式）：先交牌进池，再按交牌大小依次收牌 */
  App.execTributeStep = function () {
    var g = App.game;
    if (!g) return;
    if (!g.tributeQueue) g.tributeQueue = [];

    if (!g.tributeQueue.length) {
      if (!g._takeSteps) {
        g._takeSteps = g.buildTakeSteps();
        g.tributeQueue = g._takeSteps.slice();
        if (g.tributeQueue.length) { UI.renderAll(); App.broadcast(); }
      }
      if (!g.tributeQueue.length) {
        g._takeSteps = null;
        // 进贡结束：交出的单张牌最大者先出（没有进贡则回到 ♣4 规则）
        g.finishTribute();
        g.phase = (g.soloCandidate !== null && g.soloCandidate !== undefined) ? 'declare' : 'playing';
        UI.bubbles = {};
        UI.renderAll();
        App.broadcast();
        App.sayLeader();
        App.afterMove();
        return;
      }
    }

    var item = g.tributeQueue.shift();
    if (item.kind === 'take') return App.doTakeStep(item);

    var from = g.players[item.from];
    if (item.mode === 'max') {
      var cards = C.tributeMax(from.hand, item.count);
      App.giveCards(item, cards);
      App.broadcast();
      UI.renderAll();
      if (item.from === App.mySeat) {
        // 让当事人看到被换走了什么牌
        setTimeout(function () {
          UI.showTributeNotice(item, cards, function () { setTimeout(App.execTributeStep, 300); });
        }, 450);
      } else {
        setTimeout(App.execTributeStep, 700);
      }
      return;
    }

    // mode === 'pick'
    if (from.isAI) {
      var cs = AI.tributePick(from.hand, item.count, 'pick');
      App.giveCards(item, cs);
      App.broadcast();
      UI.renderAll();
      setTimeout(App.execTributeStep, 700);
      return;
    }
    if (item.from === App.mySeat) {
      UI.showTribute(item, function (cs) {
        App.giveCards(item, cs);
        App.broadcast();
        UI.renderAll();
        setTimeout(App.execTributeStep, 500);
      });
      return;
    }
    if (App.online() && Net.conns[item.from]) {
      App.pendingTribute = item;
      Net.sendTo(item.from, { type: 'askTribute', item: item });
      UI.toast('等待 ' + from.name + ' 交换手牌…');
      return;
    }
    // 兜底
    var fb = AI.tributePick(from.hand, item.count, 'pick');
    App.giveCards(item, fb);
    App.execTributeStep();
  };

  /** 收牌：自己挑，或最后一名自动拿剩下的 */
  App.doTakeStep = function (item) {
    var g = App.game;
    var rest = g.poolOf(item.side).slice();
    var taker = g.players[item.taker];
    if (item.auto || taker.isAI) {
      var cs = item.auto ? rest : g.autoTake(item, item.count);
      App.takeCards(item, cs.length ? cs : rest);
      setTimeout(App.execTributeStep, 600);
      return;
    }
    if (item.taker === App.mySeat) {
      UI.showTribute(item, function (cs) {
        App.takeCards(item, cs);
        setTimeout(App.execTributeStep, 500);
      }, rest);
      return;
    }
    if (App.online() && Net.conns[item.taker]) {
      App.pendingTribute = item;
      Net.sendTo(item.taker, { type: 'askTribute', item: item, pool: rest });
      UI.toast('等待 ' + taker.name + ' 挑牌…');
      return;
    }
    App.takeCards(item, g.autoTake(item, item.count));
    setTimeout(App.execTributeStep, 400);
  };

  App.takeCards = function (item, cards) {
    var g = App.game;
    g.takeFromPool(item, cards);
    App.broadcast();
    UI.renderAll();
  };

  App.giveCards = function (item, cards) {
    var g = App.game;
    g.giveToPool(item, cards);
    App.selected = {};
  };

  /* ---------------- 联机：房主 ---------------- */
  App.friendFlow = function () {
    var md = UI.modal('<h2>邀请好友</h2><div class="sub">同一房间码即可同桌，支持手机与电脑互通</div>' +
      '<div class="rows">' +
      '<div class="opt hl" data-act="create"><span class="ico">🏠</span><span class="tx"><b>创建房间</b><span>生成房间码，发给好友加入</span></span></div>' +
      '<div class="opt" data-act="join"><span class="ico">🔑</span><span class="tx"><b>加入房间</b><span>输入好友给你的 4 位房间码</span></span></div>' +
      '</div><div class="sec" style="display:flex;justify-content:center"><button class="btn ghost" data-back="1">返回</button></div>',
      { dismissable: false });
    md.querySelectorAll('[data-act]').forEach(function (n) {
      n.addEventListener('click', function () {
        var a = n.getAttribute('data-act');
        if (a === 'create') App.createRoom();
        else App.joinRoom();
      });
    });
    md.querySelector('[data-back]').addEventListener('click', UI.showMenu);
  };

  App.createRoom = function () {
    var code = Net.randomCode();
    App.netRole = 'host';
    App.mode = 'friend';
    App.mySeat = 0;
    App.roomPlayers = { 0: { name: App.myName, avatar: '🙂', isMe: true } };
    UI.toast('正在创建房间…');
    Net.onJoin = function (seat, msg) {
      App.roomPlayers[seat] = { name: (msg && msg.name) || ('玩家' + (seat + 1)), avatar: rnd(AVATARS) };
      App.paintRoom();
      UI.toast(App.roomPlayers[seat].name + ' 加入了房间');
    };
    Net.onMessage = App.onHostMessage;
    Net.createRoom(code, function (err) {
      if (err) {
        UI.toast('联机服务不可用，已切换为本地练习模式', 2600);
        App.netRole = 'local';
      }
      App.showRoomUI(code, !err);
    });
  };

  App.joinRoom = function () {
    var md = UI.modal('<h2>加入房间</h2><div class="sub">输入 4 位房间码</div>' +
      '<div style="text-align:center"><input id="codeInput" maxlength="4" style="font-size:26px;letter-spacing:8px;text-align:center;width:70%;padding:10px;border-radius:12px;border:1px solid #d7e3db;text-transform:uppercase"></div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center"><button class="btn primary" data-ok="1">加入</button>' +
      '<button class="btn ghost" data-back="1">返回</button></div>', { dismissable: false });
    md.querySelector('[data-back]').addEventListener('click', App.friendFlow);
    md.querySelector('[data-ok]').addEventListener('click', function () {
      var code = (md.querySelector('#codeInput').value || '').trim().toUpperCase();
      if (code.length < 4) { UI.toast('请输入 4 位房间码'); return; }
      App.doJoin(code);
    });
  };

  App.doJoin = function (code) {
    App.mode = 'friend';
    UI.toast('正在加入房间 ' + code + ' …');
    Net.onMessage = App.onGuestMessage;
    Net.joinRoom(code, function (err, seat) {
      if (err) {
        UI.toast('加入失败：' + err.message + '（可先玩单人练习）', 2600);
        App.netRole = 'local';
        setTimeout(UI.showMenu, 800);
        return;
      }
      App.netRole = 'guest';
      App.mySeat = seat;
      // 建立本地影子引擎，等待房主下发状态
      App.game = new Game({
        players: [
          { name: '房主', avatar: '🙂', isAI: false },
          { name: '玩家2', avatar: '😀', isAI: false },
          { name: '玩家3', avatar: '😀', isAI: false },
          { name: '玩家4', avatar: '😀', isAI: false }
        ]
      });
      App.game.players[seat].name = App.myName;
      UI.closeModal();
      UI.toast('已加入房间，等待房主开始');
      UI.renderAll();
    });
  };

  App.showRoomUI = function (code, online) {
    UI.showRoom({
      isHost: true,
      code: code,
      seats: [0, 1, 2, 3].map(function (i) {
        var rp = App.roomPlayers[i];
        return rp ? { name: rp.name, isMe: i === 0, isAI: false } : { name: '空位（将由电脑代替）', isAI: true };
      }),
      tip: online ? '好友复制邀请链接打开即可自动进入本房间。空位会由电脑玩家补齐。' : '当前无法连接联机服务，已切换为本地模式。'
    });
  };

  App.paintRoom = function () {
    UI.updateRoomSeats([0, 1, 2, 3].map(function (i) {
      var rp = App.roomPlayers[i];
      return rp ? { name: rp.name, isMe: i === 0, isAI: false } : { name: '空位（将由电脑代替）', isAI: true };
    }));
  };

  App.hostStart = function () {
    var players = [];
    for (var i = 0; i < 4; i++) {
      var rp = App.roomPlayers[i];
      if (rp) players.push({ name: rp.name, avatar: rp.avatar || '😀', isAI: false });
      else players.push({ name: rnd(NAMES), avatar: rnd(AVATARS), isAI: true });
    }
    App.mySeat = 0;
    App.createGame(players);
  };

  App.broadcast = function () {
    if (Net.mode !== 'host' || !App.game) return;
    var g = App.game;
    var ti = App.turnInfo;
    var left = App.turnRemain();
    if (!ti || ti.seat !== g.turn) left = null;
    for (var k in Net.conns) {
      var seat = parseInt(k, 10);
      if (isNaN(seat)) continue;
      var v = g.view(seat);
      if (left !== null) { v.turnLeft = left; v.turnTotal = ti.total; }
      Net.sendTo(seat, { type: 'state', view: v });
    }
  };

  /* ---------------- 联机：消息处理 ---------------- */
  App.onHostMessage = function (msg, fromSeat) {
    var g = App.game;
    if (!msg) return;
    if (msg.type === 'act') {
      if (!g || g.turn !== fromSeat) return;
      if (msg.act === 'pass') {
        App.execPass(fromSeat);
      } else {
        var pool = {};
        g.players[fromSeat].hand.forEach(function (c) { pool[c.id] = c; });
        var cards = (msg.ids || []).map(function (id) { return pool[id]; }).filter(Boolean);
        if (cards.length !== (msg.ids || []).length) return;
        App.execPlay(fromSeat, cards);
      }
      return;
    }
    if (msg.type === 'declare') {
      if (App.pendingDeclare === fromSeat && g && g.phase === 'declare') {
        App.pendingDeclare = null;
        if (msg.giveUp) g.soloGiveUp();          // v1.4.0：独狼选择直接下一局
        else g.declare(!!msg.yes);
        App.broadcast();
        App.afterMove();
      }
      return;
    }
    if (msg.type === 'tributeCards') {
      var item = App.pendingTribute;
      if (!item) return;
      // 阶段二：从牌池里挑牌
      if (item.kind === 'take') {
        if (item.taker !== fromSeat) return;
        var pk = {};
        g.poolOf(item.side).forEach(function (c) { pk[c.id] = c; });
        var tk = (msg.ids || []).map(function (id) { return pk[id]; }).filter(Boolean);
        if (tk.length !== item.count) return;
        App.pendingTribute = null;
        App.takeCards(item, tk);
        setTimeout(App.execTributeStep, 400);
        return;
      }
      if (item.from !== fromSeat) return;
      var hand2 = g.players[fromSeat].hand;
      var cs;
      if (item.mode === 'max') {
        // 进贡必交最大的牌，按规则现算，忽略客户端传的牌
        cs = C.tributeMax(hand2, item.count);
      } else {
        var pool2 = {};
        hand2.forEach(function (c) { pool2[c.id] = c; });
        cs = (msg.ids || []).map(function (id) { return pool2[id]; }).filter(Boolean);
        // 还贡不许还 ♦3 / ♦A
        if (cs.some(function (c) { return !C.canReturn(c); })) return;
      }
      if (cs.length !== item.count) return;
      App.pendingTribute = null;
      App.giveCards(item, cs);
      App.broadcast();
      UI.renderAll();
      setTimeout(App.execTributeStep, 400);
      return;
    }
    if (msg.type === 'nextRound') {
      if (fromSeat === 0 || true) { UI.closeModal(); App.nextRound(); }
    }
  };

  App.onGuestMessage = function (msg) {
    if (!msg) return;
    if (msg.type === 'state') {
      App.applyView(msg.view);
      return;
    }
    if (msg.type === 'askDeclare') {
      UI.showDeclare(App.mySeat, function (act) {
        if (act.giveUp) Net.sendToHost({ type: 'declare', giveUp: 1 });
        else Net.sendToHost({ type: 'declare', yes: !!act.yes });
      });
      return;
    }
    if (msg.type === 'askTribute') {
      UI.showTribute(msg.item, function (cards) {
        Net.sendToHost({ type: 'tributeCards', ids: cards.map(function (c) { return c.id; }) });
      });
      return;
    }
    if (msg.type === 'closed') {
      UI.toast('房主已关闭房间');
      App.toMenu();
    }
  };

  /** 客人端：用房主下发的状态同步本地影子引擎 */
  App.applyView = function (v) {
    var g = App.game;
    if (!g) return;
    g.round = v.round;
    g.phase = v.phase;
    g.turn = v.turn;
    g.passed = v.passed || [false, false, false, false];
    g.finishOrder = v.finishOrder || [];
    g.teams = v.teams;
    g.teamsRevealed = !!v.teamsRevealed;
    g.soloSeat = v.soloSeat;
    g.declared = v.declared;
    g.soloCandidate = v.soloCandidate;
    g.giveUpSeat = (v.giveUpSeat === undefined || v.giveUpSeat === null) ? null : v.giveUpSeat;
    g.firstLeader = (v.firstLeader === undefined ? g.firstLeader : v.firstLeader);
    g.leaderReason = v.leaderReason || g.leaderReason || 'club4';
    g.leaderCardText = v.leaderCardText || g.leaderCardText || '';
    g.requireClub4Lead = (v.requireClub4Lead === undefined ? !!g.requireClub4Lead : !!v.requireClub4Lead);
    g.played = v.played || [];
    g.trick = null;
    if (v.trick && v.trick.cards && v.trick.cards.length) {
      var cb = K.detect(v.trick.cards);
      if (cb) g.trick = { seat: v.trick.seat, combo: cb };
    }
    v.players.forEach(function (pv) {
      var p = g.players[pv.seat];
      p.name = pv.name; p.avatar = pv.avatar; p.isAI = pv.isAI;
      p.finished = pv.finished; p.place = pv.place;
      if (pv.hand) {
        p.hand = pv.hand;
      } else {
        // 看不到别人的牌：只保留张数，且必须重建，避免残留上一局/上一状态的数据
        p.hand = [];
        for (var i = 0; i < pv.count; i++) {
          p.hand.push({ id: 'hidden' + i, rank: '4', rankIdx: 0, suit: 'C', suitIdx: 0, sym: '♣', red: false, hidden: true });
        }
      }
    });
    if (v.tributeDesc !== undefined) g.tributeDesc = v.tributeDesc;
    g.tribute = (v.phase === 'over') ? g.computeTribute() : g.tribute;

    /* 回合计时 / 托管状态：服务器权威，客户端只负责显示 */
    App.trusteeFlags = v.trustee || null;
    App.offlineFlags = v.offline || null;
    if (v.phase === 'playing' && v.turnLeft > 0) {
      App.setTurnClock(v.turn, v.turnLeft, v.turnTotal || TURN_MS);
    } else {
      App.turnInfo = null;
      clearTimeout(App.humanTimer);
      App.humanTimer = null;
    }

    /* v1.3.8：四家「最近一次操作」——只带牌 id，牌面从 played 里还原，
     * 桌面四块据此渲染；编号 seq 没变就不会重播飞入动画。 */
    var byId = {};
    (v.played || []).forEach(function (c) { byId[c.id] = c; });
    var maxSeq = 0;
    g.lastActions = (v.actions || []).map(function (a) {
      if (!a) return null;
      maxSeq = Math.max(maxSeq, a.seq || 0);
      return {
        seat: a.seat, type: a.type, seq: a.seq,
        cards: (a.ids || []).map(function (id) { return byId[id]; }).filter(Boolean)
      };
    });
    while (g.lastActions.length < 4) g.lastActions.push(null);
    g.actSeq = maxSeq;

    UI.renderAll();

    if (g.phase === 'over' && !App._resultShown) {
      App._resultShown = true;
      setTimeout(function () { UI.showResult(); }, 500);
    }
    if (g.phase !== 'over') App._resultShown = false;
  };

  /* ---------------- 启动 ---------------- */
  /* ---------------- 横屏模式 ----------------
   * 牌桌按横屏设计。手机竖着拿时给一层提示，转过去就自动消失；
   * 想竖着玩点「仍然竖屏游玩」即可（本次会话有效，刷新后重新提示）。
   * 电脑浏览器、平板本来就不是竖屏手机，不会被打扰。 */
  App.setupOrientation = function () {
    var hint = document.getElementById('rotateHint');
    var skip = document.getElementById('rotateSkip');
    if (!hint) return;

    function isPhonePortrait() {
      if (!global.matchMedia) return false;
      try {
        return global.matchMedia('(orientation: portrait)').matches &&
          global.matchMedia('(pointer: coarse)').matches &&
          global.innerWidth <= 900;
      } catch (e) { return false; }
    }

    function allowedPortrait() {
      try { return sessionStorage.getItem('pk_portrait_ok') === '1'; } catch (e) { return false; }
    }

    function apply() {
      // 只有真正进到牌桌才要求横屏；菜单、设置、房间等待页竖着看更顺手
      var inTable = !!(App.game && App.game.phase && App.game.phase !== 'idle');
      var shownOnce = false;
      try { shownOnce = sessionStorage.getItem('pk_rotate_shown') === '1'; } catch (e) { }
      var show = isPhonePortrait() && !allowedPortrait() && inTable && !shownOnce;
      if (show) {
        try { sessionStorage.setItem('pk_rotate_shown', '1'); } catch (e) { }
      }
      hint.hidden = !show;
      if (show) document.body.classList.add('need-landscape');
      else document.body.classList.remove('need-landscape');
    }
    App.refreshRotateHint = apply;

    if (skip) {
      skip.addEventListener('click', function () {
        try { sessionStorage.setItem('pk_portrait_ok', '1'); } catch (e) { }
        hint.hidden = true;
        document.body.classList.remove('need-landscape');
      });
    }

    global.addEventListener('orientationchange', function () { setTimeout(apply, 150); });
    global.addEventListener('resize', apply);
    apply();
  };

  App.init = function () {
    App.setupOrientation();
    try { App.myName = localStorage.getItem('pk_name') || '我'; } catch (e) { }
    App.loadSettings();
    App.loadRecord();
    // 记牌器偏好：用户上次开着，这次进牌桌就自动开着
    try { UI.counterOpen = localStorage.getItem('pk_counter') === '1'; } catch (e) { }

    var q = location.search;
    var room = (q.match(/[?&]room=([^&]+)/) || [])[1];
    var svr = (q.match(/[?&]server=([^&]+)/) || [])[1];
    if (svr) { App.settings.server = Net.normalizeBase(decodeURIComponent(svr)); App.applySettings(); }
    // 打包端（exe / 安卓 / iOS）预置的服务器地址：window.PKGAME_SERVER
    if (!App.settings.server && global.PKGAME_SERVER) {
      App.settings.server = Net.normalizeBase(global.PKGAME_SERVER);
      App.applySettings();
    }

    // 桌面客户端菜单「网页进入」→ ?web=1，直接弹出二维码面板
    var wantWeb = /[?&]web=1/.test(q);
    if (wantWeb && !room) {
      UI.showMenu();
      setTimeout(function () { UI.showWebEntry(); }, 220);
      return;
    }

    if (room) {
      room = decodeURIComponent(room).toUpperCase();
      UI.closeModal();
      if (App.settings.server) {
        // 服务器房：连服务器后自动加入（有旧座位凭据则直接回座）
        App.connectServer(function (err) {
          if (err) { UI.toast('连不上服务器：' + err.message, 3000); UI.showMenu(); return; }
          App.resumeOrJoin(room);
        });
      } else {
        App.mode = 'friend';
        App.doJoin(room);
      }
      return;
    }
    UI.showMenu();
  };

  /* 手机切到后台（回微信、锁屏）再回来时，连接通常已经被系统掐掉了。
   * 回到前台：先看连接是否还活着，断了就自动重连并回到原座位。 */
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && UI.stopTitleFlash) UI.stopTitleFlash();
      if (document.visibilityState !== 'visible') return;
      if (!App.settings.server || App.netRole !== 'client') return;
      if (Net.mode === 'ws' && Net.ws && Net.ws.readyState === 1) return;
      var now = Date.now();
      if (App._lastReconnect && now - App._lastReconnect < 5000) return;
      App._lastReconnect = now;
      App.reconnectTry = 0;
      App.tryReconnect();
    });
  }

  global.App = App;
  App.init();
})(typeof window !== 'undefined' ? window : globalThis);
