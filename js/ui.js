/* ============================================================
 * ui.js —— 界面渲染与通用弹窗
 * 座位：绝对 seat 0..3；相对 rel = (seat - mySeat + 4) % 4
 *       rel 0 = 我(下)  1 = 右  2 = 对家(上)  3 = 左
 * ============================================================ */
(function (global) {
  'use strict';

  var C = global.Cards;
  var K = global.Combos;

  var UI = {
    bubbles: {},        // seat -> text（只用于「第 N 名」等提示，过牌不再走这里）
    hintIdx: 0,
    /* v1.3.8：桌面四块 —— 每块记录已渲染的操作编号 seq。
     * 编号没变就不重绘，已经在桌上的牌不会跟着倒计时再飞一遍。 */
    _zoneSeq: [null, null, null, null],
    _zoneReady: false
  };

  function $(id) { return document.getElementById(id); }
  function el(id) { return $(id); }

  function relSeat(seat) { return (seat - App.mySeat + 4) % 4; }
  function absSeat(rel) { return (rel + App.mySeat) % 4; }

  /* ---------------- 扑克牌 DOM ---------------- */
  UI.cardEl = function (card, cls) {
    var d = document.createElement('div');
    d.className = 'card ' + (card.red ? 'red ' : '') + (cls || '');
    d.dataset.id = card.id;
    d.innerHTML =
      '<div class="corner"><span class="rk">' + card.rank + '</span><span class="st">' + card.sym + '</span></div>' +
      '<span class="big">' + card.sym + '</span>';
    return d;
  };

  UI.cardBack = function (cls) {
    var d = document.createElement('div');
    d.className = 'card back ' + (cls || '');
    return d;
  };

  /* ---------------- 手牌 ---------------- */
  UI.renderHand = function () {
    var hand = $('hand');
    var g = App.game;
    if (!g) return;
    var me = g.players[App.mySeat];
    hand.innerHTML = '';
    // 手牌从左到右由大到小：3 在最左，4 在最右（sortDesc 已按牌力倒序）
    var cards = C.sortDesc(me.hand);
    cards.forEach(function (c, i) {
      var d = UI.cardEl(c);
      d._card = c;                      // 划选时直接取牌对象，避免数组下标错位
      if (App.selected[c.id]) d.classList.add('sel');
      if (App.hintSet && App.hintSet[c.id]) d.classList.add('hint');
      if (App.dealing) d.style.animationDelay = (i * 22) + 'ms';
      d.addEventListener('click', function () {
        // 指针事件（按下 / 拖选）已经处理过这一次，别再切换一遍
        if (UI._swiped) { UI._swiped = false; return; }
        if (UI._pointerAt && Date.now() - UI._pointerAt < 800) return;
        if (!g || g.phase !== 'playing') return;
        if (App.myTrustee && App.myTrustee()) {
          UI.toast('托管中：先点「取消托管」才能自己出牌', 1800);
          return;
        }
        UI.toggleCard(c, d);
      });
      hand.appendChild(d);
    });
    UI.layoutHand();
    UI.bindSwipeSelect(hand);
  };

  /** 选中 / 取消一张牌（单击、提示、拖选共用） */
  UI.toggleCard = function (c, d) {
    var on = !App.selected[c.id];
    if (on) App.selected[c.id] = c;
    else delete App.selected[c.id];
    App.hintSet = null;
    if (d) {
      d.classList.toggle('sel', on);
      d.classList.remove('hint');
    }
    UI.renderActions();
    App.sfx('tap');
  };

  /** 手机轻震一下（设备不支持就算了） */
  UI.buzz = function (ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms || 8);
    } catch (e) { }
  };

  /**
   * v1.3.10：手牌「单击 / 拖选」—— 按手机手感重写
   *   · 按下后移动不足 9 像素 → 松手算单击：选中或取消这一张
   *   · 移动超过 9 像素 → 拖选：从按下的那张到当前那张，中间连续的一段一起处理
   *       - 起点当时没选中 → 这一段全部选中
   *       - 起点当时已选中 → 这一段全部取消
   *   · 拖动过程中范围跟着手指收窄或伸长，松手后不会残留半段
   *
   * 和上一版的区别（都是手机上真会踩到的坑）：
   *   1. 手牌区 touch-action:none，浏览器不再把手势当成「滚动手牌条」，
   *      也就不会中途发 pointercancel 把拖选打断；
   *   2. 落在哪张牌只看横向坐标，不看 elementFromPoint ——
   *      拇指往上一飘就落空的老问题没了，牌选中抬起 18px 也不会再串到别的牌；
   *   3. 指针捕获：手指划出手牌区（上方/下方）照样继续选；
   *   4. 只有跨过 9 像素才真正开始拖，单击/拖选不会互相误触。
   */
  var DRAG_PX = 9;

  UI.bindSwipeSelect = function (hand) {
    if (!hand || hand._swipeBound) return;
    hand._swipeBound = true;

    var drag = null;
    var rects = [];          // 按下那一刻每张牌的位置（只取 left / right）

    function measure() {
      rects = [];
      for (var i = 0; i < hand.children.length; i++) {
        var b = hand.children[i].getBoundingClientRect();
        rects.push({ l: b.left, r: b.right });
      }
    }

    /** 横向坐标落在第几张牌上。clamp=true 时拖出边界算第一张/最后一张 */
    function indexAt(x, clamp) {
      var n = rects.length;
      if (!n) return -1;
      if (clamp) {
        if (x <= rects[0].l) return 0;
        if (x >= rects[n - 1].r) return n - 1;
      } else {
        if (x < rects[0].l - 4 || x > rects[n - 1].r + 4) return -1;
      }
      for (var i = n - 1; i > 0; i--) {
        if (x >= rects[i].l) return i;
      }
      return 0;
    }

    function canPick() {
      var g = App.game;
      if (!g || g.phase !== 'playing') return false;
      if (App.myTrustee && App.myTrustee()) return false;
      return true;
    }

    function paint(el, on) {
      var c = el._card;
      if (!c) return;
      if (on) App.selected[c.id] = c;
      else delete App.selected[c.id];
      el.classList.toggle('sel', on);
      el.classList.remove('hint');
    }

    function applyRange() {
      var a = Math.min(drag.i0, drag.i1), b = Math.max(drag.i0, drag.i1);
      var inRange = {};
      for (var i = a; i <= b; i++) {
        var el = hand.children[i];
        if (!el || !el._card) continue;
        if (!(el._card.id in drag.orig)) drag.orig[el._card.id] = !!App.selected[el._card.id];
        inRange[el._card.id] = true;
        paint(el, drag.mode);
      }
      // 范围收缩：之前划过、现在不在段内的牌 → 还原成按下前的样子
      Object.keys(drag.orig).forEach(function (id) {
        if (inRange[id] || drag.orig[id] === drag.mode) return;
        var el = hand.querySelector('[data-id="' + id + '"]');
        if (el && el._card) paint(el, drag.orig[id]);
      });
    }

    function onDown(e) {
      if (!canPick()) return;
      if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
      measure();
      var idx = indexAt(e.clientX || 0, false);
      if (idx < 0) return;
      var el = hand.children[idx];
      if (!el || !el._card) return;
      UI._pointerAt = Date.now();
      UI._swiped = false;
      drag = {
        x: e.clientX || 0, y: e.clientY || 0,
        i0: idx, i1: idx,
        mode: !App.selected[el._card.id],   // 起点没选中 → 这一段全部选中
        moved: false,
        orig: {}
      };
      App.hintSet = null;
      // 抓住指针：手指划出手牌区也不会丢事件
      if (e.pointerId !== undefined && hand.setPointerCapture) {
        try { hand.setPointerCapture(e.pointerId); } catch (err) { }
      }
      if (e.cancelable) e.preventDefault();
    }

    function onMove(e) {
      if (!drag) return;
      var x = e.clientX || 0;
      if (!drag.moved) {
        var dx = x - drag.x;
        var dy = (e.clientY || 0) - drag.y;
        if (dx * dx + dy * dy < DRAG_PX * DRAG_PX) return;   // 不到 9 像素：仍算单击
        drag.moved = true;
        UI._swiped = true;
        UI.buzz(8);
      }
      var idx = indexAt(x, true);
      if (idx < 0 || idx === drag.i1) return;               // 没换牌就不重绘，拖起来更顺
      drag.i1 = idx;
      applyRange();
      UI.renderActions();
      if (e.cancelable) e.preventDefault();
    }

    function onUp() {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (!d.moved) {
        var el = hand.children[d.i0];
        if (el && el._card) {
          UI.toggleCard(el._card, el);                     // 单击
          UI.buzz(8);
        }
      } else {
        UI.renderActions();
        App.sfx('tap');
      }
      setTimeout(function () { UI._swiped = false; }, 0);
    }

    hand.addEventListener('pointerdown', onDown);
    hand.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    // 老浏览器（没有 Pointer Events）退回 touch 事件
    if (!('onpointerdown' in hand)) {
      hand.addEventListener('touchstart', function (e) { if (e.touches[0]) onDown(e.touches[0]); }, { passive: false });
      hand.addEventListener('touchmove', function (e) { if (e.touches[0]) onMove(e.touches[0]); }, { passive: false });
      window.addEventListener('touchend', onUp);
    }
  };

  UI.layoutHand = function () {
    var wrap = $('handWrap');
    var hand = $('hand');
    var n = hand.children.length;
    if (!n) return;
    var cs = getComputedStyle(document.documentElement);
    var cw = parseFloat(cs.getPropertyValue('--cw')) || 62;
    var avail = wrap.clientWidth - 6;
    var step;
    if (n === 1) step = cw + 6;
    else step = Math.min(cw + 6, (avail - cw) / (n - 1));
    if (step < cw * 0.28) step = cw * 0.28;
    for (var i = 0; i < n; i++) {
      hand.children[i].style.marginRight = (i === n - 1) ? '0px' : ((step - cw).toFixed(2) + 'px');
    }
  };

  /* ---------------- 座位 ---------------- */
  UI.teamTag = function (seat) {
    var g = App.game;
    // 暗置：♦A 与 ♦3 都出现后才标注；只出了一张时系统不标记
    if (!g || !g.teams || !g.teamKnownTo(App.mySeat)) return '';
    if (g.soloSeat === seat) return '<span class="tag solo">独狼</span>';
    var myT = g.teamOf(App.mySeat);
    var t = g.teamOf(seat);
    if (t === myT) return '<span class="tag t' + t + '">队友</span>';
    return '<span class="tag t' + t + '">对手</span>';
  };

  UI.renderSeats = function () {
    var g = App.game;
    if (!g) return;
    var map = { 1: 'seat1', 2: 'seat2', 3: 'seat3' };
    for (var rel = 1; rel <= 3; rel++) {
      var seat = absSeat(rel);
      var p = g.players[seat];
      var box = $(map[rel]);
      var active = (g.phase === 'playing' && g.turn === seat);
      var cls = 'seat ' + (rel === 1 ? 'seat-right' : rel === 2 ? 'seat-top' : 'seat-left');
      if (active) cls += ' active';
      if (g.teams && g.teamKnownTo(App.mySeat)) cls += ' team' + g.teamOf(seat);
      if (g.soloSeat === seat && g.teamKnownTo(App.mySeat)) cls += ' solo';
      box.className = cls;

      var bubble = '';
      if (p.finished) bubble = '<div class="bubble">第 ' + p.place + ' 名</div>';
      else if (UI.bubbles[seat]) bubble = '<div class="bubble ' + UI.bubbles[seat].cls + '">' + UI.bubbles[seat].text + '</div>';

      var flags = '';
      if (App.offlineFlags && App.offlineFlags[seat]) flags += '<span class="tag offline">离线</span>';
      else if (App.trusteeFlags && App.trusteeFlags[seat]) flags += '<span class="tag trustee">托管</span>';

      var timerSec = UI.turnLeftSec();
      var timerHtml = '';
      if (active) {
        // 欢乐斗地主式：谁出牌，倒计时圆盘就挂在谁的名牌朝向牌桌中央那一侧
        var tcls = 'turn-timer' + UI.timerStateClass(timerSec);
        if (p.isAI || (App.trusteeFlags && App.trusteeFlags[seat]) || (App.offlineFlags && App.offlineFlags[seat])) tcls += ' auto';
        timerHtml = '<div class="' + tcls + '" data-seat="' + seat + '" style="--p:' + UI.turnProgress() + '"' +
          (timerSec < 0 ? ' hidden' : '') + '><span class="tt-sec">' + (timerSec >= 0 ? timerSec : '') + '</span></div>';
      }

      box.innerHTML =
        '<div class="who">' +
        /* v1.3.10：倒计时直接盖在出牌者的头像上 —— 手机上牌桌窄，
         * 挂在名牌旁边会顶到中间提示、把昵称/张数挤掉。 */
        '<div class="av">' + p.avatar + timerHtml + '</div>' +
        '<div class="nm">' + escapeHtml(p.name) + '</div>' +
        '<div class="cnt">' + p.hand.length + '</div>' +
        UI.teamTag(seat) + flags +
        '</div>' + bubble;
    }
    UI.renderMyBar();
  };

  UI.cardHTML = function (card, cls) {
    return '<div class="card ' + (card.red ? 'red ' : '') + (cls || '') + '">' +
      '<div class="corner"><span class="rk">' + card.rank + '</span><span class="st">' + card.sym + '</span></div>' +
      '<span class="big">' + card.sym + '</span></div>';
  };

  UI.renderMyBar = function () {
    var g = App.game;
    var p = g.players[App.mySeat];
    var tag = '';
    if (g.teams && g.teamKnownTo(App.mySeat)) {
      if (g.soloSeat === App.mySeat) tag = '<span class="tag solo">独狼</span>';
      else tag = '<span class="tag t' + g.teamOf(App.mySeat) + '">' + (g.teamOf(App.mySeat) === 0 ? '红队' : '蓝队') + '</span>';
    }
    if (App.myTrustee && App.myTrustee()) {
      tag += '<span class="tag trustee">托管中</span>';
    }
    /* v1.3.8：轮到我时头像发光，右侧挂一个圆形倒计时 —— 全桌的注意力都在自己这里 */
    $('mybar').innerHTML =
      '<div class="who-me">' +
      '<span class="me-av">' + p.avatar + '</span>' +
      '<span class="me-nm">' + escapeHtml(p.name) + '</span>' +
      '<span class="me-cnt">' + p.hand.length + '</span>' + tag +
      '</div>' +
      '<div class="my-timer" id="myTimer" hidden><span class="mt-sec"></span></div>';
    UI.refreshMyTimer();
  };

  /** 我的倒计时圆盘（只在轮到我时出现） */
  UI.refreshMyTimer = function () {
    var el = $('myTimer');
    if (!el) return;
    var g = App.game;
    var mine = !!(g && g.phase === 'playing' && g.turn === App.mySeat);
    var sec = UI.turnLeftSec();
    if (!mine || sec < 0) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    el.hidden = false;
    var cls = 'my-timer' + UI.timerStateClass(sec) + ((App.myTrustee && App.myTrustee()) ? ' auto' : '');
    if (el.className !== cls) el.className = cls;
    el.style.setProperty('--p', UI.turnProgress());
    var s = el.querySelector('.mt-sec');
    if (s && s.textContent !== String(sec)) s.textContent = sec;
  };

  /* ---------------- 出牌倒计时 ----------------
   * 数据来源：App.turnInfo = {seat, left, total, at}
   *   服务器联机 → 服务器下发 turnLeft（权威）
   *   单机 / 好友房 → 本地 15 秒计时（v1.3.8 起，原 20 秒）
   * 显示：倒计时圆盘挂在当前出牌者的座位上（欢乐斗地主式）
   *       + 轮到我时屏幕下方弹出横幅（约 1.4 秒自动收起）+ 底部状态栏 30px 小圆盘
   * ---------------------------------------------------- */
  UI.turnLeftMs = function () {
    var t = App.turnInfo;
    if (!t) return -1;
    var left = t.left - (Date.now() - t.at);
    return Math.max(0, left);
  };
  UI.turnLeftSec = function () {
    var ms = UI.turnLeftMs();
    return ms < 0 ? -1 : Math.ceil(ms / 1000);
  };

  /* 倒计时进度（0–100，剩余比例），用于圆盘外圈的环形进度 */
  UI.turnProgress = function () {
    var t = App.turnInfo;
    if (!t || !(t.total > 0)) return 100;
    var left = UI.turnLeftMs();
    if (left < 0) return 100;
    return Math.round(Math.max(0, Math.min(100, (left / t.total) * 100)));
  };

  /* 剩余秒数 → 圆盘配色：>10 秒绿、6–10 秒黄、≤5 秒红 */
  UI.timerStateClass = function (sec) {
    if (sec < 0) return '';
    if (sec <= 5) return ' urgent';
    if (sec <= 10) return ' warn';
    return '';
  };

  /* ---------------- 中央提示（圆桌正中，只放一句短话） ---------------- */
  UI.renderCenter = function () {
    var g = App.game;
    if (!g) return;
    var t = '';
    var full = '';
    var mine = false;
    if (g.phase === 'declare') {
      t = '等待宣告…';
    } else if (g.phase === 'tribute') {
      t = '进贡中…';
    } else if (g.phase === 'over') {
      t = '本局结束';
    } else if (g.turn === App.mySeat) {
      mine = (g.phase === 'playing');
      if (mine && App.myTrustee && App.myTrustee()) {
        t = '托管中 · 系统代出';
      } else if (mine && UI._canPlay === false) {
        t = '压不过 · 点「过牌」';
        full = '你压不过 ' + (g.trick ? K.comboName(g.trick.combo) + ' ' + K.comboText(g.trick.combo) : '') + '，请点「过牌」';
      } else if (mine) {
        t = g.trick ? '轮到你 · 需大过 ' + K.comboName(g.trick.combo) : '轮到你 · 自由出';
        full = g.trick
          ? '轮到你出牌 · 需大过 ' + K.comboName(g.trick.combo) + ' ' + K.comboText(g.trick.combo)
          : '轮到你出牌 · 自由出';
        if (g.mustIncludeClub4 && g.mustIncludeClub4(App.mySeat)) {
          t += '（带 ♣4）';
          full += '（第一手必须带 ♣4）';
        }
      } else {
        t = '轮到你出牌';
      }
    } else {
      var p = g.players[g.turn];
      var nm = p ? p.name : '';
      var tail = '';
      if (App.trusteeFlags && App.trusteeFlags[g.turn]) tail = '（托管）';
      else if (p && p.isAI) tail = '（电脑）';
      t = '等待 ' + nm + tail;
      full = t + '出牌';
      // 本局第一手：标出"为什么是他先出"，玩家不用猜
      if (g.played && g.played.length === 0 && g.firstLeader === g.turn) {
        t = (g.leaderReason === 'tribute' ? '进贡最大 ' + (g.leaderCardText || '') : '♣4 先行') + ' · ' + t;
        full = '（' + (g.leaderReason === 'tribute' ? '进贡最大的牌是 ' + (g.leaderCardText || '') : '♣4 在他手上') + '）' + full;
      }
      if (g.trick) {
        full += ' ｜ 桌面：' + K.comboName(g.trick.combo) + ' ' + K.comboText(g.trick.combo);
      }
    }
    var tip = $('centerTip');
    if (!tip) return;
    tip.textContent = t;
    tip.title = full || t;
    tip.className = 'tip' + (mine ? ' mine' : '');
    $('metaInfo').textContent = '第 ' + g.round + ' 局 · ' + App.modeName();
  };

  /* ---------------- 圆桌四块：每人只占自己那一块（v1.3.8） ----------------
   * · 出了牌 → 摊在自己那一块；过牌 → 显示「不出」；没轮到过 → 空着
   * · 轮到谁行动，先清空他那一块，等他这一手打出来再落下
   * · 每一手操作带一个只增不减的编号 seq，编号没变就不重绘，
   *   所以倒计时刷新、别人出牌都不会让已经在桌上的牌再飞一遍
   * ---------------------------------------------------- */
  var ZONE_IDS = ['zone0', 'zone1', 'zone2', 'zone3'];

  function zoneHtml(a) {
    if (a.type === 'pass') return '<span class="zpass">不出</span>';
    var cards = a.cards || [];
    var label = '';
    try {
      var cb = K.detect(cards);
      if (cb) label = K.comboName(cb);
    } catch (e) { }
    var html = '<div class="zcards">';
    cards.forEach(function (c, i) {
      html += '<span class="zcard-wrap" style="animation-delay:' + (i * 40) + 'ms">' +
        UI.cardHTML(c, 'zcard') + '</span>';
    });
    html += '</div>';
    if (label) html += '<span class="zlabel">' + label + '</span>';
    return html;
  }

  UI.renderZones = function () {
    var g = App.game;
    if (!g) return;
    var playing = g.phase === 'playing';
    for (var seat = 0; seat < 4; seat++) {
      var box = $(ZONE_IDS[seat]);
      if (!box) continue;
      var a = g.lastActions ? g.lastActions[seat] : null;
      // 轮到他行动：先把他桌前的上一手收走（但他刚打出的这一手是当前桌面牌，不收）
      var clearing = playing && g.turn === seat && !(g.trick && g.trick.seat === seat);
      if (!playing || clearing || !a) {
        if (UI._zoneSeq[seat] !== null) {
          box.innerHTML = '';
          box.classList.remove('has');
          UI._zoneSeq[seat] = null;
        }
        continue;
      }
      if (UI._zoneSeq[seat] === a.seq) continue;     // 同一手：不重绘，不再播动画
      UI._zoneSeq[seat] = a.seq;
      box.innerHTML = zoneHtml(a);
      box.classList.add('has');
      box.dataset.seq = a.seq;
      // 任意一家打出新操作：一声更短的落牌音
      if (UI._zoneReady && App.sfx) App.sfx('drop');
    }
    UI._zoneReady = true;
  };

  /** 新一局 / 离开牌桌：清空四块，下一手重新播动画 */
  UI.resetZones = function () {
    UI._zoneSeq = [null, null, null, null];
    UI._zoneReady = false;
    for (var i = 0; i < 4; i++) {
      var box = $(ZONE_IDS[i]);
      if (!box) continue;
      box.innerHTML = '';
      box.classList.remove('has');
    }
  };

  /* 首出权播报文案：♣4 持有者 / 进贡最大牌 */
  UI.leaderText = function (g) {
    if (!g || g.firstLeader === undefined || g.firstLeader === null) return '';
    var nm = g.players[g.firstLeader] ? g.players[g.firstLeader].name : '';
    if (g.leaderReason === 'tribute') {
      return '🃏 进贡最大的牌是 ' + (g.leaderCardText || '') + '，由 ' + nm + ' 先出牌';
    }
    return '♣4 在 ' + nm + ' 手上，本局由 ' + nm + ' 先出牌，第一手必须带 ♣4';
  };

  /* 服务器下发的 leader 消息 */
  UI.sayLeader = function (msg) {
    if (!msg) return;
    var nm = msg.name || '';
    if (msg.reason === 'tribute') {
      UI.toast('🃏 进贡最大的牌是 ' + (msg.card || '') + '，由 ' + nm + ' 先出牌', 3000);
    } else {
      UI.toast('♣4 在 ' + nm + ' 手上，本局由 ' + nm + ' 先出牌，第一手必须带 ♣4', 3000);
    }
  };

  /* ---------------- 「轮到你出牌」强提示 ----------------
   * 触发时机：回合切换到我的那一瞬间（边沿检测，不会每帧重复弹）
   * 表现：全屏横幅 + 提示音 + 震动 + 手牌区呼吸描边 + 后台标签闪动
   * ---------------------------------------------------- */
  var bannerTimer = null;
  var titleTimer = null;
  var lastMine = false;
  var lastFlashAt = 0;
  var baseTitle = '';

  function hideBanner() {
    var el = $('turnBanner');
    clearTimeout(bannerTimer);
    UI._bannerShown = false;
    if (!el) return;
    el.hidden = true;
    el.classList.remove('show');
    el.classList.remove('urgent');
  }
  UI.hideBanner = hideBanner;

  function startTitleFlash() {
    if (titleTimer) return;
    baseTitle = baseTitle || document.title;
    var on = false;
    titleTimer = setInterval(function () {
      on = !on;
      document.title = on ? '⏰ 轮到你出牌！' : '（等你出牌）';
    }, 700);
  }

  function stopTitleFlash() {
    if (!titleTimer) return;
    clearInterval(titleTimer);
    titleTimer = null;
    if (baseTitle) document.title = baseTitle;
  }
  UI.stopTitleFlash = stopTitleFlash;

  UI.flashTurn = function () {
    var g = App.game;
    var el = $('turnBanner');
    if (!el) return;

    var tt = $('turnTitle');
    var trustee = !!(App.myTrustee && App.myTrustee());
    if (tt) tt.textContent = trustee ? '托管中 · 系统代出' : '轮到你出牌';

    var sub = $('turnBannerSub');
    if (sub) {
      if (trustee) {
        sub.textContent = '想自己打请点「取消托管」';
      } else if (g && g.trick && UI._canPlay === false) {
        sub.textContent = '没有能压过的牌，点「过牌」';
      } else if (g && g.trick) {
        sub.textContent = '需要大过 ' + K.comboName(g.trick.combo) + ' ' + K.comboText(g.trick.combo);
      } else if (g && g.mustIncludeClub4 && g.mustIncludeClub4(App.mySeat)) {
        sub.textContent = '自由出牌 · 第一手必须带 ♣4';
      } else {
        sub.textContent = '自由出牌 · 15 秒内要打出一手牌';
      }
    }

    var now = Date.now();
    // 快节奏的连续回合（电脑秒出牌）里不要反复弹，避免闪屏；文案已在上面更新
    if (now - lastFlashAt < 700 && !el.hidden) return;
    lastFlashAt = now;

    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth; // 强制回流，让动画每次都能重播
    el.classList.add('show');
    UI._bannerShown = true;
    // 横幅和 toast 都在底部这一带，同时出现会互相压住 —— 后来的赢
    $('toastRoot').innerHTML = '';
    clearTimeout(bannerTimer);
    // v1.3.8：屏幕下方弹出，约 1.4 秒后自己消失（倒计时留在自己头像旁边）
    bannerTimer = setTimeout(hideBanner, 1400);

    if (!trustee && App.sound !== false) {
      App.sfx('turn');
      try { if (navigator.vibrate) navigator.vibrate([0, 120, 60, 120]); } catch (e) { }
    }
    if (document.hidden) startTitleFlash();
  };

  UI.checkTurn = function () {
    var g = App.game;
    var me = g && g.players ? g.players[App.mySeat] : null;
    var mine = !!(g && g.phase === 'playing' && g.turn === App.mySeat && me && !me.finished);
    document.body.classList.toggle('my-turn', mine);
    if (mine && !lastMine) {
      // 只在回合刚轮到我时算一次「有没有能压过的牌」，避免每帧枚举组合
      UI._canPlay = null;
      try { UI._canPlay = g.options(App.mySeat).length > 0; } catch (e) { UI._canPlay = null; }
      UI.flashTurn();
    }
    if (!mine) {
      // 已经出完牌 / 轮到别人：横幅和标签闪动立刻收掉
      UI._canPlay = null;
      hideBanner();
      stopTitleFlash();
    } else if (!document.hidden) {
      stopTitleFlash();
    }
    lastMine = mine;
  };

  /* ---------------- 倒计时刷新 ----------------
   * 200ms 一跳：只改数字和样式，不重绘 DOM，旧手机也不卡。
   * ---------------------------------------------------- */
  var tickHandle = null;
  var lastSec = -1;
  var lastBeepSec = -1;

  UI.tickTurn = function () {
    var g = App.game;
    var sec = UI.turnLeftSec();
    var playing = !!(g && g.phase === 'playing');

    if (!playing) {
      if (UI._bannerShown) hideBanner();
      lastSec = -1;
      lastBeepSec = -1;
      return;
    }

    var turn = g.turn;
    var mine = turn === App.mySeat;
    var p = g.players[turn];
    var state = UI.timerStateClass(sec);
    var pct = UI.turnProgress();

    // 出牌者座位上的倒计时圆盘：数字 + 环形进度，谁出牌就出现在谁那里
    var badge = document.querySelector('.seat .turn-timer[data-seat="' + turn + '"]');
    if (badge) {
      var numEl = badge.querySelector('.tt-sec');
      var txt = sec >= 0 ? String(sec) : '';
      if (numEl && numEl.textContent !== txt) numEl.textContent = txt;
      badge.hidden = sec < 0;
      badge.style.setProperty('--p', pct);
      var bcls = 'turn-timer' + state;
      if (p && (p.isAI || (App.trusteeFlags && App.trusteeFlags[turn]) || (App.offlineFlags && App.offlineFlags[turn]))) bcls += ' auto';
      if (badge.className !== bcls) badge.className = bcls;
    }

    if (mine) {
      // 轮到我：自己头像旁的圆盘跳数字，最后 5 秒变红并加快闪动
      UI.refreshMyTimer();
      var banner = $('turnBanner');
      if (banner) banner.classList.toggle('urgent', sec >= 0 && sec <= 5);
      if (sec > 0 && sec <= 5 && sec !== lastBeepSec) {
        lastBeepSec = sec;
        App.sfx('tick');
        try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { }
      }
    } else if (UI._bannerShown) {
      hideBanner();
    }

    if (sec !== lastSec) {
      lastSec = sec;
      UI.renderCenter();
    }
  };

  UI.startTicker = function () {
    if (tickHandle) return;
    tickHandle = setInterval(UI.tickTurn, 200);
  };

  /* ---------------- 操作按钮 ---------------- */
  UI.renderActions = function () {
    var g = App.game;
    var box = $('actions');
    if (!g) { box.innerHTML = ''; return; }
    box.innerHTML = '';
    // 记牌器按钮常驻（任何阶段、任何回合都点得到）
    var bc = btn('', 'sm ghost counter-toggle' + (UI.counterOpen ? ' on' : ''), function () { UI.toggleCounter(); });
    bc.innerHTML = '<span class="ct-ico">🔢</span><span class="ct-label">记牌器</span>';
    box.appendChild(bc);

    // 托管：随时可开关，掉线/离开一会儿也不会拖累队友
    var tOn = !!(App.myTrustee && App.myTrustee());
    if (App.netRole === 'client') {
      var bt = btn(tOn ? '取消托管' : '托管', 'sm ghost trustee-btn' + (tOn ? ' on' : ''), function () {
        App.toggleTrustee(!tOn);
      });
      box.appendChild(bt);
    }

    /* v1.3.4：托管中 —— 收起「提示 / 过牌 / 清空 / 出牌」，
     * 只留「取消托管」和记牌器；再点取消托管，这些按钮立刻回来。 */
    if (tOn) {
      var picked0 = Object.keys(App.selected || {}).length;
      if (picked0) {
        App.selected = {}; App.hintSet = null;
        UI.renderHand();
      }
      return;
    }

    if (g.phase !== 'playing') return;
    var mine = g.turn === App.mySeat;
    if (!mine) return;
    box.appendChild(btn('提示', 'sm ghost', function () { App.doHint(); }));

    /* 自由出牌时「过牌」不可用；跟牌时选中的牌不合法就「出牌」不可用。
     * 按钮做成灰掉的样子，但仍可点 —— 点一下用短提示说清楚为什么不能出。 */
    var canPass = !!g.trick;
    var bp = btn('过牌', 'sm' + (canPass ? '' : ' off'), function () {
      if (!canPass) { UI.toast('自由出牌：必须出牌，「过牌」不可用', 1800); App.sfx('tap'); return; }
      App.doPass();
    });
    // 压不过时把「过牌」高亮出来，省得玩家翻牌找半天
    if (canPass && UI._canPlay === false) bp.classList.add('ready');
    box.appendChild(bp);

    box.appendChild(btn('清空', 'sm ghost', function () {
      App.selected = {}; App.hintSet = null;
      UI.renderHand(); UI.renderActions();
    }));

    var picked = Object.keys(App.selected || {}).length;
    var info = App.selInfo ? App.selInfo() : { n: picked, ok: picked > 0, reason: '请先选牌' };
    var bplay = btn('出牌', 'sm primary', function () {
      if (!info.ok) { UI.toast(info.reason, 2200); App.sfx('tap'); return; }
      App.doPlay();
    });
    if (info.ok) {
      // 已选好合法牌型：按钮脉动，明确告诉玩家「点这里」
      bplay.classList.add('ready');
    } else {
      bplay.classList.add('off');
    }
    if (picked) {
      // 用角标显示已选张数，避免按钮变宽把整手牌顶上去
      var badge = document.createElement('i');
      badge.className = 'pick-badge';
      badge.textContent = picked;
      bplay.appendChild(badge);
    }
    box.appendChild(bplay);
  };

  function btn(text, cls, fn) {
    var b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }
  UI.btn = btn;

  UI.renderAll = function () {
    UI.renderSeats();
    UI.renderHand();
    // 先判定回合归属（顺带算出「能不能压过」），再据此渲染按钮和提示
    UI.checkTurn();
    UI.renderActions();
    UI.renderCenter();
    UI.renderZones();
    UI.renderCounter();
    // 牌桌出现后，竖屏手机再提示横屏（菜单页保持竖屏可正常浏览）
    if (typeof App !== 'undefined' && App.refreshRotateHint) App.refreshRotateHint();
  };

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  UI.toast = function (msg, ms) {
    var root = $('toastRoot');
    root.innerHTML = '';
    // 底部只留一条提示：toast 出现时把「轮到你出牌」横幅收掉，别叠在一起
    if (UI._bannerShown) {
      var tb = $('turnBanner');
      if (tb) tb.hidden = true;
      UI._bannerShown = false;
      clearTimeout(bannerTimer);
    }
    var d = document.createElement('div');
    d.className = 'toast';
    d.textContent = msg;
    root.appendChild(d);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { root.innerHTML = ''; }, ms || 1600);
  };

  /* ---------------- 弹窗 ---------------- */
  UI.closeModal = function () { $('modalRoot').innerHTML = ''; };

  // 只关某类弹窗（如 room：等待房间），避免误关记牌器等其它界面
  UI.closeModalKind = function (kind) {
    var md = $('modalRoot').querySelector('.modal');
    if (md && md.dataset.kind === kind) UI.closeModal();
  };

  UI.modal = function (html, opts) {
    opts = opts || {};
    var root = $('modalRoot');
    var ov = document.createElement('div');
    ov.className = 'overlay';
    var md = document.createElement('div');
    md.className = 'modal';
    if (opts.kind) md.dataset.kind = opts.kind;
    md.innerHTML = html;
    ov.appendChild(md);
    if (opts.dismissable !== false) {
      ov.addEventListener('click', function (e) {
        if (e.target === ov) UI.closeModal();
      });
    }
    root.innerHTML = '';
    root.appendChild(ov);
    return md;
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  UI.escapeHtml = escapeHtml;

  /* ---------------- 复制失败时的兜底面板 ----------------
   * 手机上偶尔会出现「系统不允许网页写剪贴板」（尤其微信内置浏览器、
   * 老 WebView）。这时不再谎报"已复制"，而是把内容摊开让用户长按复制。 */
  UI.showCopyFallback = function (text, label) {
    text = String(text == null ? '' : text);
    var md = UI.modal(
      '<h2>手动复制' + (label ? ' · ' + escapeHtml(label) : '') + '</h2>' +
      '<div class="sub">当前浏览器不允许自动写入剪贴板。<br>请<b>长按下面的文字 → 全选 → 复制</b>。</div>' +
      '<textarea id="copyFallbackBox" readonly style="width:100%;height:96px;padding:10px 12px;border-radius:12px;' +
      'border:1px solid #d7e3db;font-size:13px;line-height:1.6;resize:none;background:#f7fbf8;color:#16241c;' +
      '-webkit-user-select:text;user-select:text">' + escapeHtml(text) + '</textarea>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center">' +
      '<button class="btn primary" data-sel="1">全选</button>' +
      '<button class="btn ghost" data-close="1">关闭</button></div>',
      { dismissable: true }
    );
    var box = md.querySelector('#copyFallbackBox');
    function selectAll() {
      try {
        box.focus();
        box.select();
        box.setSelectionRange(0, box.value.length);
      } catch (e) { }
    }
    selectAll();
    md.querySelector('[data-sel]').addEventListener('click', selectAll);
    md.querySelector('[data-close]').addEventListener('click', UI.closeModal);
  };

  /* ---------------- 记牌器（常驻浮窗，自主开关） ---------------- */
  UI.counterOpen = false;

  UI.openCounter = function () {
    UI.counterOpen = true;
    try { localStorage.setItem('pk_counter', '1'); } catch (e) { }
    var panel = $('counterPanel');
    if (panel) panel.hidden = false;
    var b = $('btnCounter');
    if (b) b.classList.add('on');
    UI.renderCounter();
  };

  UI.closeCounter = function () {
    UI.counterOpen = false;
    try { localStorage.setItem('pk_counter', '0'); } catch (e) { }
    var panel = $('counterPanel');
    if (panel) panel.hidden = true;
    var b = $('btnCounter');
    if (b) b.classList.remove('on');
    var acts = $('actions');
    if (acts) {
      var t = acts.querySelector('.counter-toggle');
      if (t) t.classList.remove('on');
    }
  };

  UI.toggleCounter = function () {
    if (UI.counterOpen) UI.closeCounter();
    else UI.openCounter();
  };

  // 离开牌桌时收起面板，但不改用户的「常开」偏好（下一局自动回来）
  UI.hideCounter = function () {
    var panel = $('counterPanel');
    if (panel) panel.hidden = true;
    var b = $('btnCounter');
    if (b) b.classList.remove('on');
  };

  // 打开状态下随牌局实时刷新；关闭时什么也不做
  UI.renderCounter = function () {
    if (!UI.counterOpen) return;
    var g = App.game;
    if (!g || !g.counter) return;
    var panel = $('counterPanel');
    var body = $('counterBody');
    if (!panel || !body) return;
    panel.hidden = false;
    var b = $('btnCounter');
    if (b) b.classList.add('on');

    var rows = g.counter(App.mySeat);
    var html = '<div class="counter-grid">';
    rows.forEach(function (r) {
      html += '<div class="cnt-cell ' + (r.remain === 0 ? 'zero' : '') + '">' +
        '<div class="r">' + r.rank + '</div><div class="n">' + r.remain + ' 张</div></div>';
    });
    html += '</div><div class="cp-foot">外面还剩 = 不含我的 ' + (g.players[App.mySeat] ? g.players[App.mySeat].hand.length : 0) +
      ' 张手牌与已出的 ' + g.played.length + ' 张 · 第 ' + g.round + ' 局</div>';
    body.innerHTML = html;
  };

  // 兼容旧调用
  UI.showCounter = function () { UI.openCounter(); };

  /* ---------------- 规则 ---------------- */
  UI.showRules = function () {
    var html =
      '<h2>游戏规则</h2>' +
      '<div class="sub">找队友 · 4 人扑克（52 张，无大小王）</div>' +

      '<div class="sec"><h3>牌的大小</h3>' +
      '<p>点数：<b>4 &lt; 5 &lt; 6 &lt; 7 &lt; 8 &lt; 9 &lt; 10 &lt; J &lt; Q &lt; K &lt; A &lt; 2 &lt; 3</b></p>' +
      '<p>花色：<span class="sym-d">♦ 方块</span> &gt; <span class="sym-b">♠ 葵扇</span> &gt; <span class="sym-d">♥ 红桃</span> &gt; <span class="sym-b">♣ 梅花</span>；同点数时含方块者更大。</p></div>' +

      '<div class="sec"><h3>牌型</h3>' +
      '<table class="rule-table"><tr><th>牌型</th><th>说明</th><th>举例</th></tr>' +
      '<tr><td>单张</td><td>1 张</td><td>♦3</td></tr>' +
      '<tr><td>对子</td><td>2 张同点</td><td>44 最小 · 33 最大</td></tr>' +
      '<tr><td>纯 3 张</td><td>3 张同点</td><td>444</td></tr>' +
      '<tr><td>顺子</td><td>5 张连续，2 不参与</td><td>34567 最小 · 10JQKA 最大</td></tr>' +
      '<tr><td>同花</td><td>5 张同一花色，点数任意</td><td>♣3 ♣5 ♣7 ♣8 ♣9</td></tr>' +
      '<tr><td>三带二</td><td>3 张 + 对子</td><td>444XX 最小 · 333XX 最大</td></tr>' +
      '<tr><td>四带一</td><td>4 张 + 任意单张</td><td>4444X 最小 · 3333X 最大</td></tr>' +
      '<tr><td>同花顺</td><td>5 张同花色且连续</td><td>♣34567 最小 · ♦10JQKA 最大</td></tr>' +
      '</table>' +
      '<p><b>五张组合 + 纯3张的大小：同花顺 &gt; 四带一 &gt; 三带二 &gt; 同花 &gt; 顺子 &gt; 纯3张</b>（不看点数）</p>' +
      '<p>同为「同花 / 同花顺」时，从最大的一张开始逐张比点数，同点再比花色。</p></div>' +

      '<div class="sec"><h3>怎么压牌</h3>' +
      '<p><b>同牌型才能压同牌型</b>，一直压到该牌型的最大牌出现、所有人都压不过，这一轮才结束：</p>' +
      '<p>· 单张 → 只能用<b>更大的单张</b>压</p>' +
      '<p>· 对子 → 只能用<b>更大的对子</b>压</p>' +
      '<p>· 纯 3 张 → 可以用<b>更大的纯 3 张</b>压，也可以被<b>任意 5 张组合牌</b>压' +
      '（顺子 / 同花 / 三带二 / 四带一 / 同花顺 都比纯 3 张大）</p>' +
      '<p>· 5 张组合（顺子 / 同花 / 三带二 / 四带一 / 同花顺）→ 只能用<b>5 张组合</b>压，' +
      '其中同花顺 &gt; 四带一 &gt; 三带二 &gt; 同花 &gt; 顺子</p>' +
      '<p>例：桌上 <b>999</b>（纯 3 张），你可以用 <b>33344</b>（三带二）或 <b>KQQQQ</b>（四带一）压过去。</p>' +
      '<p>压不过或不想出就<b>过牌</b>；所有人都过牌时，由最后出牌的人重新自由出牌。</p></div>' +

      '<div class="sec"><h3>谁先出牌</h3>' +
      '<p>· <b>第 1 局</b>，或上一局是 <b>1、4 名 对 2、3 名</b>（不进贡）→ <b>♣4 在谁手上谁先出</b>，' +
      '并且<b>第一手必须带 ♣4</b>（单张 ♣4、♣4+4 的对子、带对 4 的三带二、带 ♣4 的四带一都可以）。</p>' +
      '<p>· 上一局有进贡（1、2 / 1、3 / 独狼）→ <b>谁交出的单张牌最大，谁先出</b>，' +
      '这时第一手出任何合规牌型都行，不要求带 ♣4。</p></div>' +

      '<div class="sec"><h3>纯 3 张的限制</h3>' +
      '<p>纯 3 张（如 444）只有两种情况能打：</p>' +
      '<p>① <b>本局第一次出牌</b>——拿到首出权的那位玩家，第一手就能甩纯 3 张（本局要求带 ♣4 时，这手要含 ♣4）；</p>' +
      '<p>② <b>其余 3 人全部过牌、牌权回到自己，且这时手上正好只剩这 3 张</b>（例如只剩 444，出完即走完）。</p>' +
      '<p><b>不能这样出：</b>自己先打了一张大牌、其余 3 人都过牌、手上还剩一堆牌，又回头甩 444。这种属于违规，系统会拦下并提示。</p>' +
      '<p>另外：<b>跟牌压制时永远不能出纯 3 张</b>，只能用更大的纯 3 张压。</p></div>' +

      '<div class="sec"><h3>找队友（暗置）</h3>' +
      '<p>拿到 <span class="sym-d">♦3</span> 与 <span class="sym-d">♦A</span> 的两人<b>自动成为队友</b>，另外两人自动成为另一队。</p>' +
      '<p><b>谁先打出 ♦A 或 ♦3，除了他自己，其余 3 人立刻看到</b>谁是队友、谁是敌人；' +
      '他自己要等<b>另一张身份牌也打出来</b>才看得到。</p>' +
      '<p>例：B 打出 ♦3 → A、C、D 三人的界面马上标出敌友，B 自己的界面暂时还不标；' +
      '等 ♦A 也露面，B 才看得到。</p>' +
      '<p><b>♦A 与 ♦3 都打出来了</b> → 系统立刻公开：</p>' +
      '<p>· 由<b>两个人</b>分别打出 ⇒ 标明这两人是队友，另外两人自动成另一队；</p>' +
      '<p>· 两张都从<b>同一个人</b>手上打出 ⇒ 他<b>没有队友（独狼）</b>，标明<b>另外 3 人</b>是一队，即 <b>1 打 3</b>。</p>' +
      '<p><b>独狼开局三选一</b>（v1.4.0，只有独狼本人看到这个选择）：</p>' +
      '<p>　① <b>公布我是独狼</b> → 开局即公开，全场都知道他是独狼；</p>' +
      '<p>　② <b>不公布</b> → 只有他自己心里有数，另外 3 人一律不标记，直到他把 ♦A 和 ♦3 都打出来；</p>' +
      '<p>　③ <b>不想玩 · 直接下一局</b> → 本局不开打，按「公布 + 最后一名」收尾（交 9 收 9）。</p>' +
      '<p>若到本局结束两张牌仍没全出，结算时同样公开。</p></div>' +

      '<div class="sec"><h3>计分</h3>' +
      '<p>本游戏<b>只公布输赢，不计分</b>。每局结束只显示你这一方是赢还是输，以及累计的<b>胜 / 负场数</b>，不设积分、等级或金币。</p></div>' +

      '<div class="sec"><h3>结算与进贡（下一局发牌后执行）</h3>' +
      '<p>· 队友拿到 <b>第 1、2 名</b> → 输方各交出 <b>2 张最大的牌</b>，赢方各拿出 <b>2 张不要的牌</b>。</p>' +
      '<p>· 队友拿到 <b>第 1、3 名</b> → 输方各交出 <b>1 张最大的牌</b>，赢方各拿出 <b>1 张</b>。</p>' +
      '<p>· <b>1、4 名</b> 或 <b>2、3 名</b> → 平局，不进贡（下一局看 ♣4）。</p>' +
      '<p>· <b>独狼局的名次</b>（v1.4.0，独狼定名次、其余并列）：</p>' +
      '<p>　· 独狼<b>第 1 个出完</b> → 本局立刻结束：<b>独狼第 1 名</b>，另外 3 人<b>统统并列第 2 名</b>；</p>' +
      '<p>　· 独狼<b>第 2 个出完</b> → 本局立刻结束：先走的那位第 1 名、<b>独狼第 2 名</b>，剩下 2 人<b>并列第 3 名</b>；</p>' +
      '<p>　· 独狼第 3 / 第 4 个出完 → 名次照排：第 1、第 2、独狼，最后没出完的自动第 4。</p>' +
      '<p>· <b>独狼局的进贡张数</b>（"每人几张"：另外 3 人各交这么多，独狼一人交 3 倍、收 3 倍）：</p>' +
      '<p>　· 独狼<b>第 1 名</b>：公布 → 每人 <b>3 张</b>（独狼交 9 收 9）；未公布 → 每人 <b>2 张</b>（交 6 收 6）</p>' +
      '<p>　· 独狼<b>第 2 名</b>：公布 → 每人 <b>2 张</b>（交 6 收 6）；未公布 → 每人 <b>1 张</b>（交 3 收 3）</p>' +
      '<p>　· 独狼<b>第 3 名</b>：公布 → <b>谁都不用交换牌</b>（下一局看 ♣4）；未公布 → 每人 <b>1 张</b></p>' +
      '<p>　· 独狼<b>最后一名</b>：公布 → 每人 <b>3 张</b>（交 9 收 9）；未公布 → 每人 <b>2 张</b>（交 6 收 6）</p>' +
      '<p>· <b>独狼「直接下一局」</b>（v1.4.0）：开局时独狼可以先看完自己这一手牌，觉得没戏就点' +
      '<b>「不想玩 · 直接下一局」</b>，本局不再开打，按<b>「公布身份 + 最后一名」</b>收尾 —— ' +
      '独狼交 9 张、收 9 张，另外 3 人各交 3 张、各收 3 张。</p>' +
      '<p><b>交哪些牌：</b>只交「除 <b>♦3、♠3、♥3、♣3、♦A</b> 以外最大的牌」。若这些牌全部交完仍不够张数（独狼局交 6 / 9 张时才会遇到），才从 <b>♠3 → ♥3 → ♣3</b> 里补足。<b>♦3 与 ♦A 任何情况下都不交。</b></p>' +
      '<p><b>谁先挑牌：</b>双方各自把「交出的最大单张」从大到小排序，依次从对方交出的牌里挑自己要的张数，' +
      '排在最后的自动拿走剩下的牌。例：C 交了 ♦2、D 交了 ♠A ⇒ C 先挑。</p></div>' +

      '<div class="sec"><h3>操作</h3>' +
      '<p>轮到你时：选牌 → 出牌；压不过或不想出 → <b>过牌</b>（把出牌权交给下一家）。所有人都过牌，则由最后出牌的人重新自由出牌。</p>' +
      '<p>选多张牌（对子 / 三带二 / 四带一 / 顺子）时，可以<b>按住屏幕横向划过</b>一排牌，划到的牌会一起选中。</p>' +
      '<p>点<b>提示</b>会优先推荐<b>不拆牌</b>的一手：单张避开手里的对子 / 三张 / 四张，对子避开三张 / 四张。</p>' +
      '<p>顶栏 🔢 可随时打开<b>记牌器</b>。</p></div>' +

      '<div class="sec" style="display:flex;justify-content:center"><button class="btn primary" data-close="1">知道了</button></div>';
    var md = UI.modal(html);
    md.querySelector('[data-close]').addEventListener('click', UI.closeModal);
  };

  /* ---------------- 主菜单 ---------------- */
  UI.showMenu = function () {
    var html =
      '<div class="logo"><div class="em">♦️♠️♥️♣️</div><h1>TMH · 谁是队友</h1><p>4 人扑克 · 方块A 找方块3</p></div>' +
      '<div class="rows">' +
      '<div class="opt hl" data-act="solo"><span class="ico">🎮</span><span class="tx"><b>单人练习</b><span>你 + 3 个电脑玩家，无需服务器</span></span></div>' +
      '<div class="opt" data-act="online"><span class="ico">🌐</span><span class="tx"><b>联机对战</b><span>连服务器开房，和真人一起玩</span></span></div>' +
      '<div class="opt" data-act="friend"><span class="ico">👥</span><span class="tx"><b>邀请好友（直连）</b><span>房间码点对点，不用服务器</span></span></div>' +
      '<div class="opt" data-act="web"><span class="ico">🌐</span><span class="tx"><b>网页进入 · 手机扫码</b><span>扫码进网页版，不用装 App</span></span></div>' +
      '<div class="opt" data-act="rule"><span class="ico">📖</span><span class="tx"><b>游戏规则</b><span>牌型、找队友、进贡结算</span></span></div>' +
      '</div>' +
      '<div class="sec" style="margin-top:14px"><div class="chips">' +
      '<span class="chip">我的昵称：' + UI.escapeHtml(App.myName) + '</span>' +
      '<span class="chip">战绩：' + App.record.win + ' 胜 ' + App.record.lose + ' 负</span>' +
      '<span class="chip" data-act="rename">✏️ 改名</span>' +
      '<span class="chip" data-act="settings">⚙️ 设置</span>' +
      '</div></div>';
    var md = UI.modal(html, { dismissable: false });
    md.querySelectorAll('[data-act]').forEach(function (n) {
      n.addEventListener('click', function () {
        var a = n.getAttribute('data-act');
        App.sfx('tap');
        if (a === 'rule') { UI.showRules(); return; }
        if (a === 'web') { UI.showWebEntry(); return; }
        if (a === 'rename') { App.askName(); return; }
        if (a === 'settings') { UI.showSettings(); return; }
        App.startMode(a);
      });
    });
  };

  /* ---------------- 网页进入（扫码 / 复制网址） ---------------- */
  UI.showWebEntry = function (opt) {
    opt = opt || {};
    var html = '<h2>网页进入</h2>' +
      '<div class="sub">手机 / 平板 / 电脑浏览器直接开玩，不用装 App</div>' +
      '<div class="sec" style="text-align:center"><div class="qr-holder" id="qrHolder">' +
      '<span class="hint">正在生成二维码…</span></div></div>' +
      '<div class="sec"><input id="shareUrl" readonly value="" placeholder="正在获取地址…" ' +
      'style="width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--line);font-size:12.5px;user-select:text"></div>' +
      (opt.room ? '<div class="sec" style="text-align:center;margin-top:-2px"><p style="font-size:12.5px">扫码打开的页面会直接加入房间 <b>' +
        UI.escapeHtml(opt.room) + '</b></p></div>' : '') +
      '<div class="sec" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn primary" data-copy="1">复制网址</button>' +
      (opt.back ? '<button class="btn ghost" data-back="1">返回房间</button>' : '<button class="btn ghost" data-close="1">关闭</button>') +
      '</div>' +
      '<div class="sec"><h3>怎么用</h3>' +
      '<p style="font-size:12.5px">· 手机相机或微信「扫一扫」扫描二维码，浏览器打开即玩。</p>' +
      '<p style="font-size:12.5px">· iPhone：Safari 打开后点「分享 → 添加到主屏幕」，就有和 App 一样的图标与全屏体验。</p>' +
      '<p style="font-size:12.5px">· 安卓：Chrome 菜单 →「添加到主屏幕」。</p>' +
      '<p style="font-size:12.5px">· 手机需与服务器在同一个 Wi-Fi；外网玩请填公网地址（见使用说明书第 5 节）。</p></div>';

    var md = UI.modal(html, { dismissable: !opt.back });
    var input = md.querySelector('#shareUrl');
    var holder = md.querySelector('#qrHolder');

    function backToRoom() {
      UI.closeModal();
      if (opt.back) opt.back();
    }

    md.querySelector('[data-copy]').addEventListener('click', function () {
      if (!input.value) { UI.toast('地址还没准备好'); return; }
      App.copy(input.value);
      UI.toast('网址已复制');
    });
    var bk = md.querySelector('[data-back]');
    if (bk) bk.addEventListener('click', backToRoom);
    var cl = md.querySelector('[data-close]');
    if (cl) cl.addEventListener('click', UI.closeModal);

    App.shareInfo({ room: opt.room }, function (info) {
      if (!md.parentNode) return;   // 弹窗已被关闭
      if (info.error) {
        holder.innerHTML = '<span class="hint" style="color:#c0392b">' + UI.escapeHtml(info.error) + '</span>';
        return;
      }
      input.value = info.url;
      holder.innerHTML = '';
      var cv = document.createElement('canvas');
      holder.appendChild(cv);
      var box = Math.min(220, Math.max(150, md.clientWidth - 90));
      if (global.QR && global.QR.draw(cv, info.url, { size: box, margin: 4 })) {
        if (info.lan) {
          var tip = document.createElement('div');
          tip.className = 'hint';
          tip.style.padding = '6px 0 2px';
          tip.textContent = '已自动换成局域网地址，手机连同一个 Wi-Fi 即可扫码进入';
          holder.appendChild(tip);
        }
      } else {
        holder.innerHTML = '<span class="hint">地址太长，二维码生成失败，请直接复制下面的网址。</span>';
      }
    });
  };

  /* ---------------- 设置 ---------------- */
  UI.showSettings = function () {
    var st = App.settings;
    var html = '<h2>设置</h2><div class="sub">TMH-谁是队友扑克游戏</div>' +
      '<div class="sec"><h3>玩法</h3>' +
      '<div class="rows">' +
      '<div class="opt"><span class="ico">🧩</span><span class="tx"><b>牌型大小：四带一 &gt; 三带二 &gt; 纯3张</b>' +
      '<span>单牌只能用单牌、对子只能用对子；5 张组合牌（顺子 / 三带二 / 四带一 / 同花 / 同花顺）都能压纯3张</span></span></div>' +
      '<div class="opt" data-sw="flush"><span class="ico">🌸</span><span class="tx"><b>同花比大小：' +
      (st.flushBySuit ? '先比花色' : '先比牌面') + '</b><span>' +
      (st.flushBySuit ? '♦ &gt; ♠ &gt; ♥ &gt; ♣，同花色再逐张比点数' : '从最大的一张开始逐张比点数，同点再比花色') +
      '</span></span></div>' +
      '<div class="opt" data-sw="sound"><span class="ico">🔊</span><span class="tx"><b>音效：' +
      (st.sound ? '开' : '关') + '</b><span>出牌与点击提示音</span></span></div>' +
      '</div></div>' +
      '<div class="sec"><h3>联机服务器</h3>' +
      '<p style="font-size:12.5px">留空则使用当前页面所在的服务器；局域网自建服务器填 <b>http://192.168.x.x:8080</b>。</p>' +
      '<input id="svrInput" value="' + UI.escapeHtml(st.server || '') + '" placeholder="例如 http://192.168.1.10:8080" ' +
      'style="width:100%;padding:9px 12px;border-radius:10px;border:1px solid #d7e3db;font-size:14px">' +
      '</div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn primary" data-save="1">保存</button>' +
      '<button class="btn ghost" data-close="1">返回</button></div>';
    var md = UI.modal(html);
    // v1.3.6：纯3张比所有五张组合牌都小，这条规则固定生效，不再提供开关
    md.querySelector('[data-sw="flush"]').addEventListener('click', function () {
      st.flushBySuit = !st.flushBySuit;
      App.applySettings();
      UI.showSettings();
    });
    md.querySelector('[data-sw="sound"]').addEventListener('click', function () {
      st.sound = !st.sound;
      App.applySettings();
      UI.showSettings();
    });
    md.querySelector('[data-save]').addEventListener('click', function () {
      st.server = (md.querySelector('#svrInput').value || '').trim().replace(/\/+$/, '');
      App.applySettings();
      UI.closeModal();
      UI.toast('已保存');
      if (!App.game) UI.showMenu();
    });
    md.querySelector('[data-close]').addEventListener('click', function () {
      UI.closeModal();
      if (!App.game) UI.showMenu();
    });
  };

  /* ---------------- 联机（服务器） ---------------- */
  UI.showOnline = function () {
    var st = App.settings;
    var html = '<h2>联机对战</h2><div class="sub">先填服务器地址，再建房或加入</div>' +
      '<div class="sec"><h3>服务器地址</h3>' +
      '<input id="svrFast" value="' + UI.escapeHtml(st.server || '') + '" placeholder="服务器 IP 或域名，例如 1.2.3.4:8080" ' +
      'style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid #d7e3db;font-size:14px;text-align:center">' +
      '<div style="margin-top:8px;display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap">' +
      '<button class="btn ghost sm" data-test="1">测试连接</button>' +
      '<span id="svrTest" style="font-size:12px;color:#7b8b82"></span></div>' +
      '<p style="font-size:12px;color:#7b8b82;margin-top:6px;line-height:1.7">' +
      '留空 = 用当前页面所在的服务器。只填 IP 会自动补成 <code>http://IP:8080</code>，填错全角冒号也能自动纠正。<br>' +
      '外网连不上先点「测试连接」：<b>一直转圈后超时</b>多半是端口没映射或上行带宽被占满，<b>立刻失败</b>多半是地址写错或被防火墙拦掉。</p></div>' +
      '<div class="rows">' +
      '<div class="opt hl" data-act="create"><span class="ico">🏠</span><span class="tx"><b>创建房间</b><span>生成 4 位房间码，好友输入即可加入</span></span></div>' +
      '<div class="opt" data-act="join"><span class="ico">🔑</span><span class="tx"><b>加入房间</b><span>输入好友的房间码</span></span></div>' +
      '<div class="opt" data-act="quick"><span class="ico">⚡</span><span class="tx"><b>快速匹配</b><span>自动坐进有空位的房间</span></span></div>' +
      '</div>' +
      '<div class="sec" style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap">' +
      '<button class="btn ghost" data-back="1">返回</button></div>';
    var md = UI.modal(html, { dismissable: false });
    var input = md.querySelector('#svrFast');
    var testBox = md.querySelector('#svrTest');

    function saveSvr() {
      var v = Net.normalizeBase(input.value);
      input.value = v;
      st.server = v;
      App.applySettings();
      return v;
    }

    md.querySelector('[data-test]').addEventListener('click', function () {
      var v = saveSvr();
      if (!v) { testBox.textContent = '请先填服务器地址'; testBox.style.color = '#a3231b'; return; }
      testBox.textContent = '正在测试…';
      testBox.style.color = '#7b8b82';
      Net.probe(v, function (err, r) {
        if (err) { testBox.textContent = '✗ ' + err.message; testBox.style.color = '#a3231b'; return; }
        var s = r.ms / 1000;
        testBox.textContent = '✓ 连接正常，耗时 ' + s.toFixed(1) + ' 秒' + (s > 2 ? '（网速较慢，但能玩）' : '');
        testBox.style.color = '#1f7a4d';
      });
    });

    input.addEventListener('change', saveSvr);
    md.querySelectorAll('[data-act]').forEach(function (n) {
      n.addEventListener('click', function () {
        saveSvr();
        var a = n.getAttribute('data-act');
        App.sfx('tap');
        if (a === 'create') App.onlineCreate();
        else if (a === 'join') App.onlineJoin();
        else App.onlineQuick();
      });
    });
    md.querySelector('[data-back]').addEventListener('click', UI.showMenu);
  };

  /* ---------------- 服务器房间等待页 ---------------- */
  UI.showOnlineRoom = function (info) {
    var html = '<h2>房间 ' + info.code + '</h2>' +
      '<div class="sub">' + (info.isHost ? '把房间码告诉好友' : '等待房主开始') + '</div>' +
      '<div class="room-code"><span class="code">' + info.code + '</span></div>' +
      '<div class="sec" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn sm" data-copy="code">复制房间码</button>' +
      '<button class="btn sm" data-copy="link">复制邀请链接</button>' +
      '<button class="btn sm" data-qr="1">扫码进房</button></div>' +
      '<div class="sec"><h3>座位</h3><div class="result-list" id="roomSeats"></div></div>' +
      '<div class="sec" id="readyBox"><h3>准备情况</h3><div class="rdy-list" id="roomReady"></div>' +
      '<p style="font-size:12px;color:#7b8b82;text-align:center;margin-top:6px">所有人点「准备」后，房主才能开始游戏</p></div>' +
      '<div class="sec"><p style="font-size:12px;color:#7b8b82">' + UI.escapeHtml(info.tip || '空位会由电脑玩家补齐。') + '</p>' +
      '<p style="font-size:12px;color:#a3231b;line-height:1.7">房间是「一次性」的：点开始游戏后就不再接受新玩家。' +
      '换人请先解散房间，重新建房后会生成新的房间码。</p></div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn primary" data-ready="1">准备</button>' +
      (info.isHost ? '<button class="btn primary" data-start="1">开始游戏</button>' : '') +
      (info.isHost ? '<button class="btn ghost" data-dissolve="1">解散房间</button>' : '') +
      '<button class="btn ghost" data-exit="1">退出房间</button></div>';
    var md = UI.modal(html, { dismissable: false, kind: 'room' });
    var seatBox = md.querySelector('#roomSeats');
    var paint = function (seats) {
      seatBox.innerHTML = seats.map(function (s, i) {
        return '<div class="result-row"><div class="pl">' + (i + 1) + '</div><div class="nm">' +
          UI.escapeHtml(s.name) + (s.isAI ? '（电脑）' : s.isMe ? '（我）' : '') +
          (s.ready ? ' ✅' : (s.isAI ? '' : ' ⏳')) + '</div></div>';
      }).join('');
      var rb = md.querySelector('#roomReady');
      if (rb) {
        rb.innerHTML = seats.map(function (s, i) {
          return '<span class="rdy ' + (s.ready ? 'on' : '') + '">' + UI.escapeHtml(s.name) +
            (s.ready ? ' ✅' : (s.isAI ? ' ✅' : ' ⏳')) + '</span>';
        }).join('');
      }
      var btn = md.querySelector('[data-ready]');
      if (btn) {
        btn.textContent = App.ready ? '✅ 已准备（点击取消）' : '准备';
        btn.className = 'btn ' + (App.ready ? 'ghost' : 'primary');
      }
    };
    paint(info.seats);
    UI._onlinePaint = paint;
    md.querySelector('[data-ready]').addEventListener('click', function () {
      App.toggleReady(!App.ready);
      UI.toast(App.ready ? '已准备，等待房主开始' : '已取消准备');
      if (UI._onlinePaint && info.seats) {
        var myIdx = -1;
        info.seats.forEach(function (s, i) { if (s.isMe) myIdx = i; });
        if (myIdx >= 0) info.seats[myIdx].ready = App.ready;
        UI._onlinePaint(info.seats);
      }
    });
    md.querySelector('[data-copy="code"]').addEventListener('click', function () {
      App.copy(info.code, function (ok) {
        if (ok) UI.toast('房间码已复制：' + info.code);
        else UI.showCopyFallback(info.code, '房间码');
      });
    });
    md.querySelector('[data-copy="link"]').addEventListener('click', function () {
      var link = info.link || '';
      if (!link) { UI.toast('还没有可分享的服务器地址，请先填服务器地址', 3000); return; }
      App.copy(link, function (ok) {
        if (ok) UI.toast('邀请链接已复制，粘贴到微信里发给好友即可');
        else UI.showCopyFallback(link, '邀请链接');
      });
    });
    md.querySelector('[data-qr]').addEventListener('click', function () {
      UI.showWebEntry({
        room: info.code,
        back: function () { UI.showOnlineRoom(info); }
      });
    });
    var st = md.querySelector('[data-start]');
    if (st) st.addEventListener('click', function () { App.onlineStart(); });
    var ds = md.querySelector('[data-dissolve]');
    if (ds) ds.addEventListener('click', function () {
      var c = UI.modal('<h2>解散房间？</h2><div class="sub">解散后当前房间码作废，系统会立刻新建一个房间并生成新的房间码。</div>' +
        '<div class="sec" style="display:flex;gap:10px;justify-content:center">' +
        '<button class="btn danger" data-yes="1">解散并重建</button>' +
        '<button class="btn ghost" data-no="1">取消</button></div>', { dismissable: true });
      c.querySelector('[data-yes]').addEventListener('click', function () { UI.closeModal(); App.dissolveRoom(); });
      c.querySelector('[data-no]').addEventListener('click', function () { UI.closeModal(); UI.showOnlineRoom(info); });
    });
    md.querySelector('[data-exit]').addEventListener('click', function () { UI.closeModal(); App.onlineLeave(); });
  };

  UI.updateOnlineSeats = function (seats) { if (UI._onlinePaint) UI._onlinePaint(seats); };

  /* ---------------- 本局进行中，暂时不让回来 ----------------
   * 掉线的玩家重连时，服务器会拒绝回座（座位已交给系统托管）。
   * 这里给一个明确说明，不再弹「输入房间码」的菜单来回折腾。 */
  /* ---------------- 通用输入弹窗 ----------------
   * Electron 里 window.prompt 不可用，所有「让用户输入一句话」的地方都走这里，
   * 网页 / PC 客户端 / 手机 App 表现一致。 */
  UI.showPrompt = function (opt) {
    opt = opt || {};
    var max = opt.max || 8;
    var md = UI.modal(
      '<h2>' + UI.escapeHtml(opt.title || '请输入') + '</h2>' +
      (opt.sub ? '<div class="sub">' + UI.escapeHtml(opt.sub) + '</div>' : '') +
      '<div class="sec" style="text-align:center">' +
      '<input id="promptInput" maxlength="' + max + '" ' +
      'value="' + UI.escapeHtml(opt.value || '') + '" ' +
      'placeholder="' + UI.escapeHtml(opt.placeholder || '') + '" ' +
      'style="font-size:20px;text-align:center;width:82%;padding:10px 12px;border-radius:12px;border:1px solid var(--line);outline:none">' +
      '</div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center">' +
      '<button class="btn primary" data-ok="1">确定</button>' +
      '<button class="btn ghost" data-cancel="1">取消</button></div>',
      { dismissable: true }
    );
    var inp = md.querySelector('#promptInput');
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) { } }, 60);

    function ok() {
      var v = (inp.value || '').trim();
      if (!v) { UI.toast(opt.emptyText || '内容不能为空'); return; }
      UI.closeModal();
      if (opt.onOk) opt.onOk(v.slice(0, max));
    }
    md.querySelector('[data-ok]').addEventListener('click', ok);
    md.querySelector('[data-cancel]').addEventListener('click', function () {
      UI.closeModal();
      if (opt.onCancel) opt.onCancel();
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); ok(); }
    });
    return md;
  };

  UI.showLockedOut = function (msg) {
    var md = UI.modal('<h2>暂时不能进房</h2>' +
      '<div class="sub" style="line-height:1.8">' + UI.escapeHtml(msg ||
        '本局游戏还在进行中，暂时不能回到座位（你的牌已由系统托管）。等这一局结束、房主重新建房后再加入。') + '</div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn ghost" data-menu="1">返回菜单</button></div>',
      { dismissable: false, kind: 'locked' });
    md.querySelector('[data-menu]').addEventListener('click', function () { UI.closeModal(); App.toMenu(); });
  };

  /* ---------------- 结算 ---------------- */
  UI.showResult = function () {
    var g = App.game;
    var order = g.finishOrder.slice();
    var html = '<h2>本局结束</h2><div class="sub">第 ' + g.round + ' 局 · ' + App.modeName() + '</div>';
    /* v1.4.0：独狼投降跳过的局，明说一句，免得其他三人以为出了 bug */
    if (g.giveUpSeat !== null && g.giveUpSeat !== undefined) {
      html += '<div class="sec" style="text-align:center;color:#c2410c;font-size:13px;font-weight:700">' +
        UI.escapeHtml(g.players[g.giveUpSeat].name) + ' 觉得这手牌没戏，选择了「直接下一局」，本局未开打</div>';
    }
    html += '<div class="result-list">';
    order.forEach(function (seat, i) {
      var p = g.players[seat];
      var pl = p.place || (i + 1);
      var tm = '';
      if (g.soloSeat === seat) tm = '<span class="tm solo">独狼</span>';
      else if (g.teams) tm = '<span class="tm t' + g.teamOf(seat) + '">' + (g.teamOf(seat) === 0 ? '红队' : '蓝队') + '</span>';
      /* v1.4.0：独狼局会出现并列名次（3 人并列第 2 / 2 人并列第 3），
       * 所以名次一律显示 p.place，不再按列表下标 1/2/3/4 排。 */
      html += '<div class="result-row"><div class="pl ' + (pl === 1 ? 'gold' : '') + '">' + pl + '</div>' +
        '<div class="nm">' + p.avatar + ' ' + UI.escapeHtml(p.name) + (seat === App.mySeat ? '（我）' : '') + '</div>' + tm + '</div>';
    });
    html += '</div>';
    var tb = g.tribute || { desc: '', n: 0, kind: 'none' };
    html += '<div class="sec"><h3>下一局进贡</h3><p>' + UI.escapeHtml(tb.desc) + '</p></div>';

    App.tallyResult();
    var myWin = false;
    if (g.soloSeat === App.mySeat) myWin = (g.players[App.mySeat].place === 1);
    else if (g.teams) myWin = (g.teamOf(App.mySeat) === g.teamOf(g.finishOrder[0]));
    var winTxt = g.soloSeat === App.mySeat ? (myWin ? '独狼获胜！' : '独狼失败') : (myWin ? '你的队伍获胜！' : '你的队伍落败');
    html += '<div class="sec" style="text-align:center;font-size:16px;font-weight:800;color:' + (myWin ? '#1f7a4d' : '#d64545') + '">' + winTxt + '</div>';
    // 只公布输赢，不做积分
    html += '<div class="sec" style="text-align:center;color:#7b8b82;font-size:13px">本场战绩：' +
      App.record.win + ' 胜 ' + App.record.lose + ' 负（无积分）</div>';

    var isClient = App.netRole === 'client';
    var meHost = isClient ? !!App.roomIsHost : !(App.isGuest && App.isGuest());

    /* v1.3.6 准备机制：
     * 联机模式下所有人都要先点「准备」，房主的「开始下一局」才有效，
     * 免得房主一点开始、别人的结算窗口还盖在牌桌上被人一直托管。 */
    html += '<div class="sec" id="readyBox"></div>';
    if (!meHost) {
      html += '<div class="sec" style="text-align:center;color:#7b8b82;font-size:13px">全员准备好后，由房主开始下一局</div>';
    }
    html += '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      (meHost ? '<button class="btn primary" data-next="1">开始下一局</button>' : '') +
      (isClient ? '<button class="btn ghost" data-dissolve="1">解散并重建房间</button>' : '') +
      // 联机模式下这里是"退出房间"（会让系统接管你的座位），说清楚免得误点
      '<button class="btn ghost" data-menu="1">' + (isClient ? '退出房间' : '返回菜单') + '</button></div>';

    var md = UI.modal(html, { dismissable: false, kind: 'result' });
    UI._readyPaint = function (list, all, waiting) {
      var box = md.querySelector('#readyBox');
      if (!box) return;
      var names = (App.game ? App.game.players : []).map(function (p) { return p.name; });
      var rows = (list || []).map(function (ok, i) {
        return '<span class="rdy ' + (ok ? 'on' : '') + '">' + UI.escapeHtml(names[i] || ('座位' + (i + 1))) +
          (ok ? ' ✅' : ' ⏳') + '</span>';
      }).join('');
      box.innerHTML = '<h3>准备情况</h3><div class="rdy-list">' + rows + '</div>' +
        '<div style="text-align:center;font-size:12px;color:#7b8b82;margin-top:6px">' +
        (all ? '全员已准备' : '等待：' + UI.escapeHtml((waiting || []).join('、'))) + '</div>';
      var btn = md.querySelector('[data-ready]');
      if (btn) {
        btn.textContent = App.ready ? '✅ 已准备（点击取消）' : '准备';
        btn.className = 'btn ' + (App.ready ? 'ghost' : 'primary');
      }
    };

    if (isClient) {
      var readyBtn = document.createElement('button');
      readyBtn.className = 'btn ' + (App.ready ? 'ghost' : 'primary');
      readyBtn.setAttribute('data-ready', '1');
      readyBtn.textContent = App.ready ? '✅ 已准备（点击取消）' : '准备';
      readyBtn.addEventListener('click', function () {
        App.toggleReady(!App.ready);
        readyBtn.textContent = App.ready ? '✅ 已准备（点击取消）' : '准备';
        readyBtn.className = 'btn ' + (App.ready ? 'ghost' : 'primary');
      });
      var hostSec = md.querySelectorAll('.sec');
      hostSec[hostSec.length - 1].insertBefore(readyBtn, hostSec[hostSec.length - 1].firstChild);
    }

    var nx = md.querySelector('[data-next]');
    if (nx) nx.addEventListener('click', function () {
      if (isClient && !App.ready) { App.toggleReady(true); UI.toast('你已准备'); }
      // 结算窗口保持打开，等服务器下发 roundBegin 再统一收掉，
      // 这样"还有人没准备"时能立刻回到结算页继续点准备
      App.nextRound();
    });
    var ds = md.querySelector('[data-dissolve]');
    if (ds) ds.addEventListener('click', function () { UI.closeModal(); App.dissolveRoom(); });
    md.querySelector('[data-menu]').addEventListener('click', function () { UI.closeModal(); App.toMenu(); });

    if (App.readyList) UI._readyPaint(App.readyList, App.readyAll, App.readyWaiting);
  };

  /* ---------------- 进贡 / 收牌 ---------------- */
  /**
   * @param {object} item 交牌 {from,side,count,mode} 或 收牌 {kind:'take',side,taker,count,auto,order,of}
   * @param {function} cb(cards)
   * @param {Array} pool 收牌时可选的牌池（对方交出来的牌）
   */
  UI.showTribute = function (item, cb, pool) {
    var g = App.game;
    var me = g.players[App.mySeat];
    var picked = {};

    /* ---- 阶段二：从对方交出来的牌池里挑牌 ---- */
    if (item.kind === 'take') {
      var poolCards = (pool && pool.length ? pool : g.poolOf(item.side)).slice();
      C.sortDesc(poolCards);
      var orderTip = (item.of > 1 && !item.auto)
        ? '<br><span style="font-size:12px;color:#7b8b82">你排在第 ' + item.order + ' 位挑牌（按各自交出的最大单张排序）</span>'
        : '';
      var htmlT = '<h2>收牌 · 挑 ' + item.count + ' 张</h2>' +
        '<div class="sub">从对方交出来的 ' + poolCards.length + ' 张牌里挑 <b>' + item.count + '</b> 张进自己手牌' +
        orderTip + '</div>' +
        '<div class="pick-hand" id="pickHand"></div>' +
        '<div class="sec" style="display:flex;gap:10px;justify-content:center">' +
        '<button class="btn primary" data-ok="1">确认拿走</button></div>';
      var mdT = UI.modal(htmlT, { dismissable: false });
      var boxT = mdT.querySelector('#pickHand');
      poolCards.forEach(function (c) {
        var d = UI.cardEl(c);
        d.addEventListener('click', function () {
          if (picked[c.id]) { delete picked[c.id]; }
          else {
            if (Object.keys(picked).length >= item.count) { UI.toast('只能挑 ' + item.count + ' 张'); return; }
            picked[c.id] = c;
          }
          Array.prototype.forEach.call(boxT.children, function (dd, i) {
            dd.classList.toggle('sel', !!picked[poolCards[i].id]);
          });
        });
        boxT.appendChild(d);
      });
      // 默认预选最大的几张
      poolCards.slice(0, item.count).forEach(function (c) { picked[c.id] = c; });
      Array.prototype.forEach.call(boxT.children, function (dd, i) {
        dd.classList.toggle('sel', !!picked[poolCards[i].id]);
      });
      mdT.querySelector('[data-ok]').addEventListener('click', function () {
        var arr = Object.keys(picked).map(function (k) { return picked[k]; });
        if (arr.length !== item.count) { UI.toast('请挑 ' + item.count + ' 张'); return; }
        UI.closeModal();
        cb(arr);
      });
      return;
    }

    /* ---- 阶段一：交牌 ---- */
    var pick = item.mode === 'pick';
    var auto = null;
    if (!pick) {
      // 交最大的牌：四张 3 与 ♦A 不交，♦3 / ♦A 永不交出；不够张数才用 ♠3 ♥3 ♣3 补
      auto = C.tributeMax(me.hand, item.count);
    }
    var useThree = !pick && C.tributeNeedsThree(me.hand, item.count);

    var html = '<h2>' + (pick ? '拿出不要的牌' : '进贡') + ' · 交 ' + item.count + ' 张</h2>' +
      '<div class="sub">' + (pick
        ? '请从手牌中挑出 ' + item.count + ' 张不要的牌放进交换牌池' +
          '<br><span style="font-size:12px;color:#7b8b82">♦3 与 ♦A 是判定队友的两张牌，<b>不能</b>交出去</span>'
        : '你需要把手中最大的 ' + item.count + ' 张交进交换牌池' +
          '<br><span style="font-size:12px;color:#7b8b82">♦3、♠3、♥3、♣3 和 ♦A 不参与进贡；' +
          (useThree
            ? '你除这些牌以外的牌不足 ' + item.count + ' 张，本次用 ♠3 / ♥3 / ♣3 补足（♦3、♦A 仍然不交）</span>'
            : '本次只交这些牌以外最大的 ' + item.count + ' 张</span>')) + '</div>';

    // 展示手牌
    html += '<div class="pick-hand" id="pickHand"></div>';
    html += '<div class="sec" style="display:flex;gap:10px;justify-content:center">' +
      '<button class="btn primary" data-ok="1">' + (pick ? '确认给出' : '确认交出') + '</button></div>';

    var md = UI.modal(html, { dismissable: false });
    var box = md.querySelector('#pickHand');
    var cards = C.sortDesc(me.hand);
    cards.forEach(function (c) {
      var d = UI.cardEl(c);
      if (auto && auto.indexOf(c) >= 0) d.classList.add('sel');
      if (pick && !C.canReturn(c)) d.classList.add('locked');
      d.addEventListener('click', function () {
        if (!pick) return;
        if (!C.canReturn(c)) { UI.toast('♦3 和 ♦A 不能交出去，必须留在手里'); return; }
        if (picked[c.id]) delete picked[c.id];
        else {
          var cnt = Object.keys(picked).length;
          if (cnt >= item.count) { UI.toast('只能选 ' + item.count + ' 张'); return; }
          picked[c.id] = c;
        }
        refreshSel();
      });
      box.appendChild(d);
    });

    function refreshSel() {
      Array.prototype.forEach.call(box.children, function (d, i) {
        d.classList.toggle('sel', !!picked[cards[i].id]);
      });
    }

    if (pick) {
      // 默认预选最小、最没用的 N 张（跳过 ♦3 / ♦A）
      C.sortAsc(me.hand).filter(C.canReturn).slice(0, item.count).forEach(function (c) { picked[c.id] = c; });
      refreshSel();
    }

    md.querySelector('[data-ok]').addEventListener('click', function () {
      if (pick) {
        var arr = Object.keys(picked).map(function (k) { return picked[k]; });
        if (arr.length !== item.count) { UI.toast('请选择 ' + item.count + ' 张'); return; }
        if (arr.some(function (c) { return !C.canReturn(c); })) { UI.toast('♦3 和 ♦A 不能交出去'); return; }
        UI.closeModal();
        cb(arr);
      } else {
        UI.closeModal();
        cb(auto);
      }
    });
  };

  /** 自动进贡（交出最大的牌）后给玩家一个交代 */
  UI.showTributeNotice = function (item, cards, cb) {
    var g = App.game;
    var isOut = (item.from === App.mySeat) || (item.taker === App.mySeat);
    var hasThree = (cards || []).some(function (c) { return c && c.rank === '3'; });
    var html = '<h2>进贡交换</h2><div class="sub">' +
      (isOut
        ? (item.kind === 'take'
          ? '你自动拿到了剩下的 ' + (cards || []).length + ' 张'
          : '你自动交出了最大的 ' + item.count + ' 张放进交换牌池' +
            (hasThree
              ? '<br><span style="font-size:12px;color:#c2410c">你除四张 3 和 ♦A 以外的牌不足 ' + item.count + ' 张，本次用 ♠3 / ♥3 / ♣3 补足了</span>'
              : '<br><span style="font-size:12px;color:#7b8b82">♦3 / ♦A 以及其它 3 都留着，没有交出去</span>'))
        : '<b>' + UI.escapeHtml(g.players[item.from === undefined ? item.taker : item.from].name) + '</b> 交出了 ' + item.count + ' 张') +
      '</div><div class="pick-hand">' +
      (cards || []).map(function (c) { return UI.cardHTML(c); }).join('') +
      '</div>' +
      '<div class="sec" style="display:flex;justify-content:center"><button class="btn primary" data-ok="1">知道了</button></div>';
    var md = UI.modal(html, { dismissable: false });
    md.querySelector('[data-ok]').addEventListener('click', function () { UI.closeModal(); cb(); });
  };

  /* ---------------- 独狼宣告（仅本人可见，不对其他人透露） ---------------- */
  /**
   * 独狼开局宣告（v1.4.0）
   * 三选一：
   *   ① 公布我是独狼   —— 全场立刻知道你是独狼，进贡按「已公布」那一档算
   *   ② 不公布         —— 只有你自己知道
   *   ③ 不想玩，直接下一局 —— 本局不再开打，视同「已公布 + 最后一名走」，交 9 张 / 收 9 张
   * 回调：cb({yes:true}) / cb({yes:false}) / cb({giveUp:true})
   */
  UI.showDeclare = function (seat, cb) {
    var g = App.game;
    var hand = C.sortDesc((g.players[seat] && g.players[seat].hand) ? g.players[seat].hand : []);
    var handHtml = '<div class="mini-hand">';
    hand.forEach(function (c) { handHtml += UI.cardHTML(c, 'zcard'); });
    handHtml += '</div>';

    var html = '<h2>你拿到了 ♦A 和 ♦3</h2>' +
      '<div class="sub" style="color:#c2410c">这条提示只有你能看到，其他玩家不会知道</div>' +
      '<div class="sec"><p>你同时拿到了 <span class="sym-d">♦A</span> 与 <span class="sym-d">♦3</span>，按规则<b>你没有队友</b>，另外 3 人自动结为一队，本局变成 <b>你 1 打 3</b>。</p>' +
      '<p>先看看你这一手的牌，再决定怎么打：</p>' + handHtml + '</div>' +
      '<div class="sec">' +
      '<p><b>① 公布我是独狼</b>：全场立刻知道你的身份。</p>' +
      '<p><b>② 不公布</b>：只有你自己知道，其他人要等你把 ♦A / ♦3 打出来才明白。</p>' +
      '<p><b>③ 不想玩，直接下一局</b>：牌太烂就直接跳过本局，按<b>「公布 + 最后一名走」</b>收尾 —— 你交 9 张、收 9 张，另外 3 人各交 3 张、各收 3 张。</p>' +
      '</div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn gold" data-yes="1">公布我是独狼</button>' +
      '<button class="btn ghost" data-no="1">不公布</button>' +
      '<button class="btn danger" data-giveup="1">不想玩 · 直接下一局</button></div>';
    var md = UI.modal(html, { dismissable: false });
    md.querySelector('[data-yes]').addEventListener('click', function () { UI.closeModal(); cb({ yes: true }); });
    md.querySelector('[data-no]').addEventListener('click', function () { UI.closeModal(); cb({ yes: false }); });
    md.querySelector('[data-giveup]').addEventListener('click', function () {
      UI.closeModal();
      UI.confirm2('确定跳过本局吗？',
        '本局将不再开打，按「公布独狼 + 最后一名」收尾：你交 9 张、收 9 张，另外 3 人各交 3 张、各收 3 张。',
        '确定跳过', '再看看', function () { cb({ giveUp: true }); }, function () { UI.showDeclare(seat, cb); });
    });
  };

  /** 通用二次确认：onYes / onNo 都是回调，标题 + 说明 + 两个按钮 */
  UI.confirm2 = function (title, msg, yesText, noText, onYes, onNo) {
    var html = '<h2>' + UI.escapeHtml(title) + '</h2>' +
      '<div class="sec"><p>' + UI.escapeHtml(msg) + '</p></div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn danger" data-y="1">' + UI.escapeHtml(yesText || '确定') + '</button>' +
      '<button class="btn ghost" data-n="1">' + UI.escapeHtml(noText || '取消') + '</button></div>';
    var md = UI.modal(html, { dismissable: true });
    md.querySelector('[data-y]').addEventListener('click', function () { UI.closeModal(); if (onYes) onYes(); });
    md.querySelector('[data-n]').addEventListener('click', function () { UI.closeModal(); if (onNo) onNo(); });
  };

  /* ---------------- 房间 ---------------- */
  UI.showRoom = function (info) {
    var html = '<h2>' + (info.isHost ? '我的房间' : '已加入房间') + '</h2>' +
      '<div class="sub">把房间码或链接发给好友，4 人齐了就能开局</div>' +
      '<div class="room-code"><span class="code">' + info.code + '</span></div>' +
      '<div class="sec" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn sm" data-copy="code">复制房间码</button>' +
      '<button class="btn sm" data-copy="link">复制邀请链接</button></div>' +
      '<div class="sec"><h3>座位</h3><div class="result-list" id="roomSeats"></div></div>' +
      '<div class="sec"><p style="font-size:12px;color:#7b8b82">' + UI.escapeHtml(info.tip || '') + '</p></div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      (info.isHost ? '<button class="btn primary" data-start="1">开始游戏</button>' : '') +
      '<button class="btn ghost" data-exit="1">退出房间</button></div>';
    var md = UI.modal(html, { dismissable: false });
    var seatBox = md.querySelector('#roomSeats');
    function paint(seats) {
      seatBox.innerHTML = seats.map(function (s, i) {
        return '<div class="result-row"><div class="pl">' + (i + 1) + '</div><div class="nm">' +
          UI.escapeHtml(s.name) + (s.isAI ? '（电脑）' : s.isMe ? '（我）' : '') + '</div></div>';
      }).join('');
    }
    paint(info.seats);
    md.querySelector('[data-copy="code"]').addEventListener('click', function () {
      App.copy(info.code); UI.toast('房间码已复制');
    });
    md.querySelector('[data-copy="link"]').addEventListener('click', function () {
      App.copy(Net.inviteUrl(info.code)); UI.toast('邀请链接已复制');
    });
    var st = md.querySelector('[data-start]');
    if (st) st.addEventListener('click', function () { UI.closeModal(); App.hostStart(); });
    md.querySelector('[data-exit]').addEventListener('click', function () { UI.closeModal(); App.toMenu(); });
    UI._roomPaint = paint;
  };

  UI.updateRoomSeats = function (seats) {
    if (UI._roomPaint) UI._roomPaint(seats);
  };

  /* ---------------- 匹配动画 ---------------- */
  UI.showMatching = function (cb) {
    var html = '<h2>正在匹配…</h2><div class="sub" id="matchTip">正在寻找牌桌</div>' +
      '<div class="sec" style="text-align:center"><div class="logo"><div class="em">🎴</div></div></div>' +
      '<div class="sec" style="display:flex;justify-content:center"><button class="btn ghost" data-cancel="1">取消</button></div>';
    var md = UI.modal(html, { dismissable: false });
    var tip = md.querySelector('#matchTip');
    var steps = ['正在寻找牌桌…', '已找到 1 位玩家…', '已找到 2 位玩家…', '已找到 3 位玩家，马上开局'];
    var i = 0;
    var timer = setInterval(function () {
      i++;
      if (i < steps.length) tip.textContent = steps[i];
      else { clearInterval(timer); UI.closeModal(); cb(); }
    }, 620);
    md.querySelector('[data-cancel]').addEventListener('click', function () {
      clearInterval(timer); UI.closeModal(); App.toMenu();
    });
  };

  UI.relSeat = relSeat;
  UI.absSeat = absSeat;
  global.UI = UI;

  /* 绑定顶栏按钮 */
  document.addEventListener('DOMContentLoaded', function () {
    $('btnCounter').addEventListener('click', function () { UI.toggleCounter(); });
    var cc = $('counterClose');
    if (cc) cc.addEventListener('click', function () { UI.closeCounter(); });
    $('btnRule').addEventListener('click', function () { UI.showRules(); });
    $('btnMenu').addEventListener('click', function () { App.confirmMenu(); });
    UI.startTicker();          // 出牌倒计时：200ms 刷新一次
    window.addEventListener('resize', function () { UI.layoutHand(); });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { UI.layoutHand(); }, 300);
    });
  });
})(typeof window !== 'undefined' ? window : globalThis);
