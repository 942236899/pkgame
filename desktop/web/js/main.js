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
    settings: { sound: true, strictType: true, flushBySuit: false, server: '' }
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
          strictType: s.strictType !== false,   // 默认严格同类型压制
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
      var o = ctx.createOscillator(), g = ctx.createGain();
      var f = kind === 'play' ? 660 : kind === 'tap' ? 880 : 520;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.value = 0.06;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.frequency.exponentialRampToValueAtTime(f * 0.7, ctx.currentTime + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      o.stop(ctx.currentTime + 0.13);
    } catch (e) { }
  };

  App.copy = function (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return;
      }
    } catch (e) { }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { }
    document.body.removeChild(ta);
  };

  App.askName = function () {
    var v = prompt('请输入你的昵称', App.myName);
    if (v && v.trim()) {
      App.myName = v.trim().slice(0, 8);
      try { localStorage.setItem('pk_name', App.myName); } catch (e) { }
      UI.showMenu();
    }
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
    if (App.netRole === 'client' && Net.ws) {
      try { Net.sendWS({ type: 'leave' }); Net.ws.close(); } catch (e) { }
    }
    App.game = null;
    App.netRole = 'local';
    App.roomPlayers = {};
    try { Net.close(); } catch (e) { }
    App.mySeat = 0;
    UI.lastPlays = {}; UI.bubbles = {};
    document.getElementById('hand').innerHTML = '';
    document.getElementById('actions').innerHTML = '';
    document.getElementById('mybar').innerHTML = '';
    ['seat1', 'seat2', 'seat3'].forEach(function (id) { document.getElementById(id).innerHTML = ''; });
    document.getElementById('centerTip').textContent = '';
    document.getElementById('metaInfo').textContent = '';
    UI.showMenu();
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
      else start();
    } else if (mode === 'online') {
      App.connectServer(function (err) {
        if (err) { UI.toast('连不上服务器：' + err.message + '（可先用单人练习）', 3000); return; }
        UI.showOnline();
      });
    } else {
      App.friendFlow();
    }
  };

  /* ---------------- 服务器联机 ---------------- */
  App.connectServer = function (cb) {
    Net.onWSMessage = App.onServerMessage;
    Net.onWSClose = function () {
      if (App.netRole === 'client') UI.toast('与服务器断开连接');
    };
    Net.connectServer(App.settings.server || '', function (err) {
      if (err) { cb(err); return; }
      App.netRole = 'client';
      App.mode = 'online';
      cb(null);
    });
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
      App.ensureShadowGame();
      App.game.players[msg.seat].name = App.myName;
      return;
    }
    if (msg.type === 'room') {
      App.ensureShadowGame();
      UI.showOnlineRoom({
        code: msg.code,
        isHost: !!msg.isHost,
        seats: msg.seats,
        link: App.inviteLink(msg.code)
      });
      return;
    }
    if (msg.type === 'state') {
      App.ensureShadowGame();
      App.applyView(msg.view);
      if (msg.view && msg.view.phase === 'playing') UI.closeModal();
      return;
    }
    if (msg.type === 'askDeclare') {
      UI.showDeclare(App.mySeat, function (yes) {
        Net.sendWS({ type: 'declare', yes: !!yes });
      });
      return;
    }
    if (msg.type === 'askTribute') {
      UI.showTribute(msg.item, function (cards) {
        Net.sendWS({ type: 'tributeCards', ids: cards.map(function (c) { return c.id; }) });
      });
      return;
    }
    if (msg.type === 'error') { UI.toast(msg.msg || '服务器返回错误'); return; }
  };

  App.inviteLink = function (code) {
    var base = (location.href.split('?')[0]);
    var svr = Net.serverUrl(App.settings.server || '');
    return base + '?server=' + encodeURIComponent(svr) + '&room=' + encodeURIComponent(code);
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
      Net.sendWS({ type: 'join', code: code, name: App.myName, avatar: '🙂' });
    });
  };
  App.onlineStart = function () { Net.sendWS({ type: 'start' }); };
  App.onlineLeave = function () { Net.sendWS({ type: 'leave' }); App.toMenu(); };

  App.createGame = function (players) {
    var g = new Game({ players: players });
    App.game = g;
    bindEvents(g);
    App.selected = {};
    App.hintSet = null;
    UI.lastPlays = {};
    UI.bubbles = {};
    App.beginRound(true);
  };

  App.beginRound = function (animate) {
    var g = App.game;
    if (App.isGuest()) { UI.renderAll(); return; }
    g.startRound();
    App.selected = {};
    App.hintSet = null;
    UI.lastPlays = {};
    UI.bubbles = {};
    if (animate) {
      App.dealing = true;
      UI.renderAll();
      setTimeout(function () { App.dealing = false; }, 500);
    } else {
      UI.renderAll();
    }
    // 首出权：规则没规定，每局抽签随机决定，并明确告知是谁
    setTimeout(function () {
      if (!App.game || App.game.round !== g.round) return;
      UI.toast('🎲 抽签结果：' + g.players[g.firstLeader].name + ' 先出牌', 2200);
    }, animate ? 560 : 60);
    App.broadcast();
    App.afterMove();
  };

  function bindEvents(g) {
    g.on('newtrick', function () {
      UI.lastPlays = {};
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
      App.handleDeclare();
      return;
    }
    if (g.phase === 'over') {
      setTimeout(function () { UI.showResult(); }, 500);
      return;
    }
    if (g.phase === 'playing') {
      App.scheduleAI();
    }
  };

  App.handleDeclare = function () {
    var g = App.game;
    if (!g.needDeclare()) { g.phase = 'playing'; App.broadcast(); App.afterMove(); return; }
    var seat = g.soloCandidate;
    if (seat === App.mySeat) {
      UI.showDeclare(seat, function (yes) {
        g.declare(yes);
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
    UI.lastPlays = {};
    UI.lastPlays[seat] = r.combo.cards.slice();
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
    UI.bubbles[seat] = { text: '不要', cls: 'pass' };
    UI.renderAll();
    App.broadcast();
    App.afterMove();
    return true;
  };

  App.doPlay = function () {
    var g = App.game;
    var cards = Object.keys(App.selected).map(function (k) { return App.selected[k]; });
    if (!cards.length) { UI.toast('请先选牌'); return; }
    var v = g.validate(App.mySeat, cards);
    if (!v.ok) { UI.toast(v.msg); App.sfx('tap'); return; }
    if (App.netRole === 'client') {
      Net.sendWS({ type: 'act', act: 'play', ids: cards.map(function (c) { return c.id; }) });
      App.selected = {};
      UI.renderHand();
      return;
    }
    if (App.isGuest()) {
      Net.sendToHost({ type: 'act', act: 'play', ids: cards.map(function (c) { return c.id; }) });
      App.selected = {};
      UI.renderHand();
      return;
    }
    App.execPlay(App.mySeat, cards);
  };

  App.doPass = function () {
    var g = App.game;
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
    var opts = g.options(App.mySeat);
    if (!opts.length) {
      UI.toast('没有能压过的牌，试试过牌');
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
    if (App.netRole === 'client') { Net.sendWS({ type: 'next' }); UI.toast('已请求开下一局'); return; }
    if (App.isGuest()) { UI.toast('等待房主开始下一局'); return; }
    var tb = g.tribute;              // 先取出上一局的进贡任务（发牌会被重置）
    App.beginRound(true);
    // 发牌后若有进贡任务则执行
    if (tb && tb.gives && tb.gives.length) {
      g.phase = 'tribute';
      g.tributeQueue = tb.gives.slice();
      App.broadcast();
      setTimeout(function () { UI.toast('本局需要进贡，请按提示交换手牌', 2000); }, 300);
      setTimeout(App.execTributeStep, 900);
    }
  };

  App.execTributeStep = function () {
    var g = App.game;
    if (!g) return;
    var q = g.tributeQueue;
    if (!q || !q.length) {
      // 进贡完成后，若本局仍有独狼候选，先走宣告流程
      g.phase = (g.soloCandidate !== null && g.soloCandidate !== undefined) ? 'declare' : 'playing';
      UI.lastPlays = {}; UI.bubbles = {};
      UI.renderAll();
      App.broadcast();
      UI.toast('进贡完成，开始出牌');
      App.afterMove();
      return;
    }
    var item = q.shift();
    var from = g.players[item.from];

    if (item.mode === 'max') {
      var cards = C.sortDesc(from.hand).slice(0, item.count);
      App.giveCards(item, cards);
      App.broadcast();
      UI.renderAll();
      if (item.from === App.mySeat || item.to === App.mySeat) {
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

  App.giveCards = function (item, cards) {
    var g = App.game;
    var ids = {};
    cards.forEach(function (c) { ids[c.id] = true; });
    var from = g.players[item.from], to = g.players[item.to];
    from.hand = from.hand.filter(function (c) { return !ids[c.id]; });
    to.hand = to.hand.concat(cards);
    to.hand = C.sortDesc(to.hand);
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
    for (var k in Net.conns) {
      var seat = parseInt(k, 10);
      if (isNaN(seat)) continue;
      Net.sendTo(seat, { type: 'state', view: g.view(seat) });
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
        g.declare(!!msg.yes);
        App.broadcast();
        App.afterMove();
      }
      return;
    }
    if (msg.type === 'tributeCards') {
      if (App.pendingTribute && App.pendingTribute.from === fromSeat) {
        var item = App.pendingTribute;
        App.pendingTribute = null;
        var pool2 = {};
        g.players[fromSeat].hand.forEach(function (c) { pool2[c.id] = c; });
        var cs = (msg.ids || []).map(function (id) { return pool2[id]; }).filter(Boolean);
        if (cs.length !== item.count) return;
        App.giveCards(item, cs);
        App.broadcast();
        UI.renderAll();
        setTimeout(App.execTributeStep, 400);
      }
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
      UI.showDeclare(App.mySeat, function (yes) {
        Net.sendToHost({ type: 'declare', yes: !!yes });
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

    // 出牌区展示
    if (g.trick) {
      UI.lastPlays = {};
      UI.lastPlays[g.trick.seat] = g.trick.combo.cards;
    }

    UI.renderAll();

    if (g.phase === 'over' && !App._resultShown) {
      App._resultShown = true;
      setTimeout(function () { UI.showResult(); }, 500);
    }
    if (g.phase !== 'over') App._resultShown = false;
  };

  /* ---------------- 启动 ---------------- */
  App.init = function () {
    try { App.myName = localStorage.getItem('pk_name') || '我'; } catch (e) { }
    App.loadSettings();
    App.loadRecord();

    var q = location.search;
    var room = (q.match(/[?&]room=([^&]+)/) || [])[1];
    var svr = (q.match(/[?&]server=([^&]+)/) || [])[1];
    if (svr) { App.settings.server = decodeURIComponent(svr); App.applySettings(); }
    // 打包端（exe / 安卓 / iOS）预置的服务器地址：window.PKGAME_SERVER
    if (!App.settings.server && global.PKGAME_SERVER) {
      App.settings.server = String(global.PKGAME_SERVER).replace(/\/+$/, '');
      App.applySettings();
    }

    if (room) {
      room = decodeURIComponent(room).toUpperCase();
      UI.closeModal();
      if (App.settings.server) {
        // 服务器房：连服务器后自动加入
        App.connectServer(function (err) {
          if (err) { UI.toast('连不上服务器：' + err.message, 3000); UI.showMenu(); return; }
          Net.sendWS({ type: 'join', code: room, name: App.myName, avatar: '🙂' });
        });
      } else {
        App.mode = 'friend';
        App.doJoin(room);
      }
      return;
    }
    UI.showMenu();
  };

  global.App = App;
  App.init();
})(typeof window !== 'undefined' ? window : globalThis);
