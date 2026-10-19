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
    lastPlays: {},      // seat -> cards[]
    bubbles: {},        // seat -> text
    hintIdx: 0
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
    var cards = C.sortDesc(me.hand);
    cards.forEach(function (c, i) {
      var d = UI.cardEl(c);
      if (App.selected[c.id]) d.classList.add('sel');
      if (App.hintSet && App.hintSet[c.id]) d.classList.add('hint');
      if (App.dealing) d.style.animationDelay = (i * 22) + 'ms';
      d.addEventListener('click', function () {
        if (!App.canOperate()) { UI.toast('还没轮到你出牌'); return; }
        if (App.selected[c.id]) delete App.selected[c.id];
        else App.selected[c.id] = c;
        App.hintSet = null;
        UI.renderHand();
        UI.layoutHand();
        UI.renderActions();
        App.sfx('tap');
      });
      hand.appendChild(d);
    });
    UI.layoutHand();
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

      var cards = UI.lastPlays[seat] || [];
      var cardHtml = '';
      cardHtml = '<div class="played-area">' + (cards.length ? cards.map(function (c) {
        return UI.cardHTML(c, 'mini');
      }).join('') : '<span style="width:30px;display:inline-block"></span>') + '</div>';

      box.innerHTML =
        '<div class="who">' +
        '<div class="av">' + p.avatar + '</div>' +
        '<div class="nm">' + escapeHtml(p.name) + '</div>' +
        '<div class="cnt">' + p.hand.length + '</div>' +
        UI.teamTag(seat) +
        '</div>' + bubble + cardHtml;
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
    $('mybar').innerHTML =
      '<div class="who-me"><span>' + p.avatar + '</span><span>' + escapeHtml(p.name) + '</span>' +
      '<span class="cnt">' + p.hand.length + '</span>' + tag + '</div>';
  };

  /* ---------------- 中央提示 ---------------- */
  UI.renderCenter = function () {
    var g = App.game;
    if (!g) return;
    var t = '';
    if (g.phase === 'declare') {
      t = '等待宣告…';
    } else if (g.phase === 'tribute') {
      t = '进贡阶段';
    } else if (g.phase === 'over') {
      t = '本局结束';
    } else if (g.turn === App.mySeat) {
      t = g.trick ? '轮到你 · 需要大过 ' + K.comboName(g.trick.combo) : '轮到你出牌（自由出）';
    } else {
      var nm = g.players[g.turn].name;
      t = '等待 ' + nm + ' …';
    }
    if (g.trick) {
      t += ' ｜ 桌面：' + K.comboName(g.trick.combo) + ' ' + K.comboText(g.trick.combo);
    }
    $('centerTip').textContent = t;
    $('metaInfo').textContent = '第 ' + g.round + ' 局 · ' + App.modeName();
  };

  /* ---------------- 操作按钮 ---------------- */
  UI.renderActions = function () {
    var g = App.game;
    var box = $('actions');
    if (!g) { box.innerHTML = ''; return; }
    box.innerHTML = '';
    if (g.phase !== 'playing') {
      var b = btn('查看记牌器', 'sm ghost', function () { UI.showCounter(); });
      box.appendChild(b);
      return;
    }
    var mine = g.turn === App.mySeat;
    if (!mine) {
      var b2 = btn('记牌器', 'sm ghost', function () { UI.showCounter(); });
      box.appendChild(b2);
      return;
    }
    box.appendChild(btn('提示', 'sm ghost', function () { App.doHint(); }));
    var canPass = !!g.trick;
    var bp = btn('过牌', 'sm', function () { App.doPass(); });
    bp.disabled = !canPass;
    box.appendChild(bp);
    box.appendChild(btn('清空', 'sm ghost', function () { App.selected = {}; App.hintSet = null; UI.renderHand(); UI.renderActions(); }));
    box.appendChild(btn('出牌', 'sm primary', function () { App.doPlay(); }));
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
    UI.renderActions();
    UI.renderCenter();
  };

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  UI.toast = function (msg, ms) {
    var root = $('toastRoot');
    root.innerHTML = '';
    var d = document.createElement('div');
    d.className = 'toast';
    d.textContent = msg;
    root.appendChild(d);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { root.innerHTML = ''; }, ms || 1600);
  };

  /* ---------------- 弹窗 ---------------- */
  UI.closeModal = function () { $('modalRoot').innerHTML = ''; };

  UI.modal = function (html, opts) {
    opts = opts || {};
    var root = $('modalRoot');
    var ov = document.createElement('div');
    ov.className = 'overlay';
    var md = document.createElement('div');
    md.className = 'modal';
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

  /* ---------------- 记牌器 ---------------- */
  UI.showCounter = function () {
    var g = App.game;
    if (!g) return;
    var rows = g.counter(App.mySeat);
    var html = '<h2>记牌器</h2><div class="sub">显示每种点数"外面还剩几张"（不含自己手牌与已出牌）</div><div class="counter-grid">';
    rows.forEach(function (r) {
      html += '<div class="cnt-cell ' + (r.remain === 0 ? 'zero' : '') + '">' +
        '<div class="r">' + r.rank + '</div><div class="n">' + r.remain + ' 张</div></div>';
    });
    html += '</div><div class="sec"><p style="font-size:12.5px;color:#7b8b82">已出 ' + g.played.length + ' 张 · 我手上 ' + g.players[App.mySeat].hand.length + ' 张</p></div>';
    var md = UI.modal(html + '<div class="sec" style="display:flex;justify-content:center"><button class="btn primary" data-close="1">关闭</button></div>');
    md.querySelector('[data-close]').addEventListener('click', UI.closeModal);
  };

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
      '<p><b>五张组合之间的大小：同花顺 &gt; 四带一 &gt; 三带二 &gt; 同花 &gt; 顺子</b>（不看点数）</p>' +
      '<p>同为「同花 / 同花顺」时，从最大的一张开始逐张比点数，同点再比花色。</p></div>' +

      '<div class="sec"><h3>怎么压牌</h3>' +
      '<p><b>同牌型才能压同牌型</b>，一直压到该牌型的最大牌出现、所有人都压不过，这一轮才结束：</p>' +
      '<p>· 单张 → 只能用<b>更大的单张</b>压</p>' +
      '<p>· 对子 → 只能用<b>更大的对子</b>压</p>' +
      '<p>· 纯 3 张 → 只能用<b>更大的纯 3 张</b>压</p>' +
      '<p>· 5 张组合（顺子 / 同花 / 三带二 / 四带一 / 同花顺）→ 只能用<b>5 张组合</b>压，' +
      '其中同花顺 &gt; 四带一 &gt; 三带二 &gt; 同花 &gt; 顺子</p>' +
      '<p>压不过或不想出就<b>过牌</b>；所有人都过牌时，由最后出牌的人重新自由出牌。</p></div>' +

      '<div class="sec"><h3>谁先出牌</h3>' +
      '<p>没有硬性规定，<b>每局开局抽签（随机）决定</b>第一个出牌的玩家。</p></div>' +

      '<div class="sec"><h3>纯 3 张的限制</h3>' +
      '<p>只能在两种情况下打出：① 本局第一个出牌的玩家，开局首出就有纯 3 张；② 其余 3 人全部过牌、牌权回到自己重新出牌时。</p>' +
      '<p>换句话说：<b>只有轮到你「自由出牌」时才能出纯 3 张</b>，跟牌压制时不能出。</p></div>' +

      '<div class="sec"><h3>找队友（暗置）</h3>' +
      '<p>拿到 <span class="sym-d">♦3</span> 与 <span class="sym-d">♦A</span> 的两人<b>自动成为队友</b>，另外两人自动成为另一队。</p>' +
      '<p>只打出其中一张时，另一名队友自己心里知道就行，<b>系统不做任何标注和提示</b>。</p>' +
      '<p><b>♦A 与 ♦3 都打出来了</b> → 系统立刻公开：</p>' +
      '<p>· 由<b>两个人</b>分别打出 ⇒ 标明这两人是队友，另外两人自动成另一队；</p>' +
      '<p>· 两张都从<b>同一个人</b>手上打出 ⇒ 他<b>没有队友（独狼）</b>，标明<b>另外 3 人</b>是一队，即 <b>1 打 3</b>。</p>' +
      '<p>若到本局结束两张牌仍没全出，结算时同样公开。</p></div>' +

      '<div class="sec"><h3>计分</h3>' +
      '<p>本游戏<b>只公布输赢，不计分</b>。每局结束只显示你这一方是赢还是输，以及累计的<b>胜 / 负场数</b>，不设积分、等级或金币。</p></div>' +

      '<div class="sec"><h3>结算与进贡（下一局发牌后执行）</h3>' +
      '<p>· 队友拿到 <b>第 1、2 名</b> → 输方各进贡 <b>2 张最大的牌</b>，赢方各回 <b>2 张</b>。</p>' +
      '<p>· 队友拿到 <b>第 1、3 名</b> → 输方各进贡 <b>1 张最大的牌</b>，赢方各回 <b>1 张</b>。</p>' +
      '<p>· <b>1、4 名</b> 或 <b>2、3 名</b> → 平局，不进贡。</p>' +
      '<p>· <b>独狼</b>拿第 1 名算赢：宣告过则另外 3 人各进贡 3 张，独狼各回 3 张；未宣告则各 2 张。独狼没拿第 1 名算输，进贡方向反过来。</p></div>' +

      '<div class="sec"><h3>操作</h3>' +
      '<p>轮到你时：选牌 → 出牌；压不过或不想出 → <b>过牌</b>（把出牌权交给下一家）。所有人都过牌，则由最后出牌的人重新自由出牌。</p>' +
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
        if (a === 'rename') { App.askName(); return; }
        if (a === 'settings') { UI.showSettings(); return; }
        App.startMode(a);
      });
    });
  };

  /* ---------------- 设置 ---------------- */
  UI.showSettings = function () {
    var st = App.settings;
    var html = '<h2>设置</h2><div class="sub">TMH-谁是队友扑克游戏</div>' +
      '<div class="sec"><h3>玩法</h3>' +
      '<div class="rows">' +
      '<div class="opt" data-sw="strict"><span class="ico">🧩</span><span class="tx"><b>压制规则：' +
      (st.strictType ? '严格同类型' : '宽松（5张可压纯3张）') + '</b><span>' +
      (st.strictType ? '单牌只能用单牌、对子只能用对子、5张组合只能用5张组合压' : '额外允许顺子/三带二/四带一压纯3张') +
      '</span></span></div>' +
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
    md.querySelector('[data-sw="strict"]').addEventListener('click', function () {
      st.strictType = !st.strictType;
      App.applySettings();
      UI.showSettings();
    });
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
    var base = st.server || (location.protocol + '//' + location.host);
    var html = '<h2>联机对战</h2><div class="sub">先填服务器地址，再建房或加入</div>' +
      '<div class="sec"><h3>服务器地址</h3>' +
      '<input id="svrFast" value="' + UI.escapeHtml(st.server || '') + '" placeholder="例如 http://192.168.1.10:8080" ' +
      'style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid #d7e3db;font-size:14px;text-align:center">' +
      '<p style="font-size:12px;color:#7b8b82;margin-top:6px">留空 = 用当前页面所在的服务器（网页版直接玩时不用填）。' +
      '手机 / 客户端要连自建服务器，就填控制台里显示的局域网地址。</p></div>' +
      '<div class="rows">' +
      '<div class="opt hl" data-act="create"><span class="ico">🏠</span><span class="tx"><b>创建房间</b><span>生成 4 位房间码，好友输入即可加入</span></span></div>' +
      '<div class="opt" data-act="join"><span class="ico">🔑</span><span class="tx"><b>加入房间</b><span>输入好友的房间码</span></span></div>' +
      '<div class="opt" data-act="quick"><span class="ico">⚡</span><span class="tx"><b>快速匹配</b><span>自动坐进有空位的房间</span></span></div>' +
      '</div>' +
      '<div class="sec" style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap">' +
      '<button class="btn ghost" data-back="1">返回</button></div>';
    var md = UI.modal(html, { dismissable: false });
    var input = md.querySelector('#svrFast');
    function saveSvr() {
      var v = (input.value || '').trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
      st.server = v;
      App.applySettings();
      return v;
    }
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
      '<button class="btn sm" data-copy="link">复制邀请链接</button></div>' +
      '<div class="sec"><h3>座位</h3><div class="result-list" id="roomSeats"></div></div>' +
      '<div class="sec"><p style="font-size:12px;color:#7b8b82">' + UI.escapeHtml(info.tip || '空位会由电脑玩家补齐。') + '</p></div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      (info.isHost ? '<button class="btn primary" data-start="1">开始游戏</button>' : '') +
      '<button class="btn ghost" data-exit="1">退出房间</button></div>';
    var md = UI.modal(html, { dismissable: false });
    var seatBox = md.querySelector('#roomSeats');
    var paint = function (seats) {
      seatBox.innerHTML = seats.map(function (s, i) {
        return '<div class="result-row"><div class="pl">' + (i + 1) + '</div><div class="nm">' +
          UI.escapeHtml(s.name) + (s.isAI ? '（电脑）' : s.isMe ? '（我）' : '') + '</div></div>';
      }).join('');
    };
    paint(info.seats);
    UI._onlinePaint = paint;
    md.querySelector('[data-copy="code"]').addEventListener('click', function () { App.copy(info.code); UI.toast('房间码已复制'); });
    md.querySelector('[data-copy="link"]').addEventListener('click', function () { App.copy(info.link || ''); UI.toast('邀请链接已复制'); });
    var st = md.querySelector('[data-start]');
    if (st) st.addEventListener('click', function () { App.onlineStart(); });
    md.querySelector('[data-exit]').addEventListener('click', function () { UI.closeModal(); App.onlineLeave(); });
  };

  UI.updateOnlineSeats = function (seats) { if (UI._onlinePaint) UI._onlinePaint(seats); };

  /* ---------------- 结算 ---------------- */
  UI.showResult = function () {
    var g = App.game;
    var order = g.finishOrder.slice();
    var html = '<h2>本局结束</h2><div class="sub">第 ' + g.round + ' 局 · ' + App.modeName() + '</div>';
    html += '<div class="result-list">';
    order.forEach(function (seat, i) {
      var p = g.players[seat];
      var tm = '';
      if (g.soloSeat === seat) tm = '<span class="tm solo">独狼</span>';
      else if (g.teams) tm = '<span class="tm t' + g.teamOf(seat) + '">' + (g.teamOf(seat) === 0 ? '红队' : '蓝队') + '</span>';
      html += '<div class="result-row"><div class="pl ' + (i === 0 ? 'gold' : '') + '">' + (i + 1) + '</div>' +
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

    if (App.isGuest && App.isGuest()) {
      html += '<div class="sec" style="text-align:center;color:#7b8b82;font-size:13px">等待房主开始下一局…</div>' +
        '<div class="sec" style="display:flex;justify-content:center"><button class="btn ghost" data-menu="1">返回菜单</button></div>';
    } else {
      html += '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
        '<button class="btn primary" data-next="1">下一局</button>' +
        '<button class="btn ghost" data-menu="1">返回菜单</button></div>';
    }
    var md = UI.modal(html, { dismissable: false });
    var nx = md.querySelector('[data-next]');
    if (nx) nx.addEventListener('click', function () { UI.closeModal(); App.nextRound(); });
    md.querySelector('[data-menu]').addEventListener('click', function () { UI.closeModal(); App.toMenu(); });
  };

  /* ---------------- 进贡 ---------------- */
  /**
   * @param {object} item {from,to,count,mode}
   * @param {function} cb(cards)
   */
  UI.showTribute = function (item, cb) {
    var g = App.game;
    var me = g.players[App.mySeat];
    var target = g.players[item.to];
    var pick = item.mode === 'pick';
    var picked = {};
    var auto = null;

    if (!pick) {
      auto = C.sortDesc(me.hand).slice(0, item.count);
    }

    var html = '<h2>进贡 · 交换 ' + item.count + ' 张</h2>' +
      '<div class="sub">' + (pick
        ? '请从手牌中挑出 ' + item.count + ' 张，还给 <b>' + UI.escapeHtml(target.name) + '</b>'
        : '你需要把手中最大的 ' + item.count + ' 张交给 <b>' + UI.escapeHtml(target.name) + '</b>') + '</div>';

    // 展示手牌
    html += '<div class="pick-hand" id="pickHand"></div>';
    html += '<div class="sec" style="display:flex;gap:10px;justify-content:center">' +
      '<button class="btn primary" data-ok="1">' + (pick ? '确认给出' : '确认交出') + '</button>' +
      (pick ? '' : '') + '</div>';

    var md = UI.modal(html, { dismissable: false });
    var box = md.querySelector('#pickHand');
    var cards = C.sortDesc(me.hand);
    cards.forEach(function (c) {
      var d = UI.cardEl(c);
      if (auto && auto.indexOf(c) >= 0) d.classList.add('sel');
      d.addEventListener('click', function () {
        if (!pick) return;
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
      // 默认预选最小的 N 张
      C.sortAsc(me.hand).slice(0, item.count).forEach(function (c) { picked[c.id] = c; });
      refreshSel();
    }

    md.querySelector('[data-ok]').addEventListener('click', function () {
      if (pick) {
        var arr = Object.keys(picked).map(function (k) { return picked[k]; });
        if (arr.length !== item.count) { UI.toast('请选择 ' + item.count + ' 张'); return; }
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
    var to = g.players[item.to];
    var isOut = item.from === App.mySeat;
    var html = '<h2>进贡交换</h2><div class="sub">' +
      (isOut
        ? '你自动交出了最大的 ' + item.count + ' 张给 <b>' + UI.escapeHtml(to.name) + '</b>'
        : '<b>' + UI.escapeHtml(g.players[item.from].name) + '</b> 向你进贡了 ' + item.count + ' 张') +
      '</div><div class="pick-hand">' +
      cards.map(function (c) { return UI.cardHTML(c); }).join('') +
      '</div>' +
      '<div class="sec" style="display:flex;justify-content:center"><button class="btn primary" data-ok="1">知道了</button></div>';
    var md = UI.modal(html, { dismissable: false });
    md.querySelector('[data-ok]').addEventListener('click', function () { UI.closeModal(); cb(); });
  };

  /* ---------------- 独狼宣告（仅本人可见，不对其他人透露） ---------------- */
  UI.showDeclare = function (seat, cb) {
    var g = App.game;
    var isMe = seat === App.mySeat;
    var html = '<h2>你拿到了 ♦A 和 ♦3</h2>' +
      '<div class="sub" style="color:#c2410c">这条提示只有你能看到，其他玩家不会知道</div>' +
      '<div class="sec"><p>你同时拿到了 <span class="sym-d">♦A</span> 与 <span class="sym-d">♦3</span>，按规则<b>你没有队友</b>，另外 3 人自动结为一队，本局变成 <b>你 1 打 3</b>。</p>' +
      '<p>其他人<b>不会看到任何提示</b>，结算时才会公布。</p>' +
      '<p>你可以在开局前<b>宣告</b>：宣告后若你独自拿到第 1 名，进贡按 <b>3 张</b>计算；不宣告则按 <b>2 张</b>计算（输了同样反向进贡）。</p></div>' +
      '<div class="sec" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn gold" data-yes="1">宣告（进贡 3 张）</button>' +
      '<button class="btn ghost" data-no="1">不宣告（进贡 2 张）</button></div>';
    var md = UI.modal(html, { dismissable: false });
    md.querySelector('[data-yes]').addEventListener('click', function () { UI.closeModal(); cb(true); });
    md.querySelector('[data-no]').addEventListener('click', function () { UI.closeModal(); cb(false); });
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
    $('btnCounter').addEventListener('click', function () { UI.showCounter(); });
    $('btnRule').addEventListener('click', function () { UI.showRules(); });
    $('btnMenu').addEventListener('click', function () { App.confirmMenu(); });
    window.addEventListener('resize', function () { UI.layoutHand(); });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { UI.layoutHand(); }, 300);
    });
  });
})(typeof window !== 'undefined' ? window : globalThis);
