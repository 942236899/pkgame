/* ============================================================
 * room.js —— 服务器端房间：跑引擎、驱动电脑玩家、下发视图
 * 直接复用前端 js/ 下的 cards / combos / engine / engine_ai
 *
 * 本版新增（v1.3.0）：
 *   · 出牌倒计时（v1.3.8 起 15 秒，原 20 秒）：每手牌给真人 15 秒，超时自动代打
 *   · 掉线托管：连接一断立即标托管，轮到他就自动出牌
 *   · 断线重连：座位保留 10 分钟，凭 token 回到原座位
 *   · 心跳探活：手机断网没有 close 事件时，靠 WS ping 发现
 * ============================================================ */
'use strict';

/* 复用前端的牌型/引擎代码。
 * 开发时：项目根 js/；打包后：server 被放到 resources/server，前端在 resources/web/js。
 * 逐个候选路径尝试，保证两种布局都能跑。 */
(function loadGameCore() {
  var fs = require('fs');
  var path = require('path');
  var files = ['cards.js', 'combos.js', 'engine.js', 'engine_ai.js'];
  var cands = [
    path.join(__dirname, '..', '..', 'js'),                       // 开发：项目根/js
    path.join(__dirname, '..', '..', 'web', 'js'),                // 打包：resources/web/js
    path.join(__dirname, '..', 'js'),                             // 兜底：server/js
    (process.env.PKGAME_WEB_ROOT || '') + path.sep + 'js'
  ];
  for (var i = 0; i < cands.length; i++) {
    if (!cands[i]) continue;
    var ok = files.every(function (f) { return fs.existsSync(path.join(cands[i], f)); });
    if (!ok) continue;
    files.forEach(function (f) { require(path.join(cands[i], f)); });
    return;
  }
  throw new Error('找不到游戏核心代码 js/{cards,combos,engine,engine_ai}.js');
})();

var C = globalThis.Cards;
var K = globalThis.Combos;
var AI = globalThis.AI;

var NAMES = ['阿强', '小美', '老王', '大熊', '阿珍', '闪电', '老K', '虎子', '冰糖', '阿福', '飞鱼', '小辣椒', '阿豪', '茉莉'];
var AVATARS = ['🤖', '😎', '🐯', '🦊', '🐼', '🐵', '🦁', '🐧'];
function rnd(a) { return a[Math.floor(Math.random() * a.length)]; }

/* 一手牌的时间预算 */
var TURN_MS = 15000;        // 真人在线：15 秒
var TRUSTEE_MS = 1600;      // 托管中：1.6 秒就走一步，别拖节奏
var DECLARE_MS = 15000;     // 独狼宣告
var TRIBUTE_MS = 20000;     // 手动选进贡牌
var RESUME_TTL = 10 * 60 * 1000;   // 掉线后座位保留 10 分钟

function newToken() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);
}

function Room(code) {
  this.code = code;
  this.seats = [null, null, null, null];   // {ws, name, avatar, seat, isAI, token, trustee, offline}
  this.game = null;
  this.started = false;
  this.hostSeat = 0;
  this.tributeQueue = [];
  this.pendingTribute = null;
  this.pendingDeclare = null;
  this.aiTimer = null;
  this.createdAt = Date.now();
  this.onEmpty = null;

  /* v1.3.6：准备机制。开房后每局都要全员点「准备」，房主才能开始 / 开下一局 */
  this.ready = [false, false, false, false];

  /* 回合计时 */
  this.turnTimer = null;
  this.turnSeat = -1;
  this.turnEndAt = 0;
  this.turnTotal = 0;
  this.trusteeFlags = [false, false, false, false];
  this.lastAuto = null;
  this.declareTimer = null;
  this.tributeTimer = null;
  this.cleanupTimer = null;
}

Room.prototype.humanCount = function () {
  return this.seats.filter(function (s) { return s && !s.isAI && s.ws; }).length;
};

Room.prototype.addPlayer = function (ws, name, avatar) {
  /* v1.3.3：房间一旦开局就锁定，中途不允许新人补位。
   * 否则新人会坐进一个"电脑刚打完半局"的座位，还能看到那一手的牌。 */
  if (this.started) return -2;
  for (var i = 0; i < 4; i++) {
    if (!this.seats[i]) {
      this.seats[i] = {
        ws: ws,
        name: name || ('玩家' + (i + 1)),
        avatar: avatar || '😀',
        seat: i,
        isAI: false,
        token: newToken(),
        trustee: false,
        offline: false
      };
      return i;
    }
  }
  return -1;
};

Room.prototype.sendTo = function (seat, msg) {
  var s = this.seats[seat];
  if (s && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(msg));
};

Room.prototype.broadcast = function (msg) {
  for (var i = 0; i < 4; i++) this.sendTo(i, msg);
};

Room.prototype.broadcastState = function () {
  var g = this.game;
  if (!g) return;
  var now = Date.now();
  var left = (this.turnSeat === g.turn && this.turnEndAt) ? Math.max(0, this.turnEndAt - now) : 0;
  var trustee = this.trusteeList();
  var offline = this.offlineList();
  var lastAuto = (this.lastAuto && now - this.lastAuto.at < 5000) ? this.lastAuto : null;
  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    if (!s || s.isAI) continue;
    var view = g.view(i);
    view.turnLeft = left;
    view.turnTotal = this.turnTotal || 0;
    view.trustee = trustee;
    view.offline = offline;
    view.lastAuto = lastAuto;
    view.myTrustee = !!trustee[i];
    this.sendTo(i, { type: 'state', view: view });
  }
};

Room.prototype.trusteeList = function () {
  var out = [];
  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    out.push(!!(s && !s.isAI && (s.trustee === true || s.offline === true)));
  }
  return out;
};

Room.prototype.offlineList = function () {
  var out = [];
  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    out.push(!!(s && !s.isAI && s.offline === true));
  }
  return out;
};

Room.prototype.roomInfo = function (mySeat) {
  var self = this;
  return {
    code: this.code,
    seats: [0, 1, 2, 3].map(function (i) {
      var s = self.seats[i];
      if (s) {
        return {
          name: s.name, avatar: s.avatar, isAI: !!s.isAI, isMe: i === mySeat,
          offline: !!s.offline, trustee: !!s.trustee,
          ready: self.isSeatReady(i)
        };
      }
      return { name: '空位（电脑代替）', isAI: true, ready: true };
    })
  };
};

/* ---------------- 准备（v1.3.6） ----------------
 * · 电脑座位和已经掉线的座位自动算「已准备」，不会因为有人掉线就永远开不了局
 * · 只有真人在座、且连着线的座位，才需要本人点准备
 */
Room.prototype.isSeatReady = function (i) {
  var s = this.seats[i];
  if (!s) return true;                       // 空位 → 开局时补电脑
  if (s.isAI) return true;
  if (!s.ws || s.offline) return true;       // 掉线：视为已准备，由系统托管
  return !!this.ready[i];
};

Room.prototype.allReady = function () {
  for (var i = 0; i < 4; i++) if (!this.isSeatReady(i)) return false;
  return true;
};

Room.prototype.notReadyNames = function () {
  var out = [];
  for (var i = 0; i < 4; i++) {
    if (this.isSeatReady(i)) continue;
    var s = this.seats[i];
    out.push(s ? s.name : ('座位' + (i + 1)));
  }
  return out;
};

Room.prototype.setReady = function (seat, on) {
  this.ready[seat] = !!on;
  this.broadcastReady();
};

Room.prototype.resetReady = function () {
  this.ready = [false, false, false, false];
};

Room.prototype.broadcastReady = function () {
  var self = this;
  var list = [0, 1, 2, 3].map(function (i) { return self.isSeatReady(i); });
  this.broadcast({ type: 'ready', list: list, all: this.allReady(), waiting: this.notReadyNames() });
};

Room.prototype.broadcastRoom = function () {
  /* v1.3.4：房间一旦开局，就不再下发"房间等待页"数据。
   * 以前「玩家点托管」「有人掉线」「有人重连」都会广播 room，
   * 客户端收到就把「房间码 + 开始游戏」的菜单盖到牌桌上，
   * 导致房间里正在出牌的四个人全都被挡住、点不了牌。 */
  if (this.started && this.game) return;

  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    if (!s || s.isAI) continue;
    var info = this.roomInfo(i);
    info.isHost = (i === this.hostSeat);
    this.sendTo(i, {
      type: 'room', code: this.code, seats: info.seats,
      isHost: info.isHost, started: this.started,
      phase: this.game ? this.game.phase : 'idle'
    });
  }
};

/* ---------------- 开局 ---------------- */
Room.prototype.start = function () {
  var self = this;
  var players = [];
  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    if (s) players.push({ name: s.name, avatar: s.avatar, isAI: false, id: 'p' + i });
    else players.push({ name: rnd(NAMES), avatar: rnd(AVATARS), isAI: true, id: 'ai' + i });
  }
  var g = new globalThis.Game({ players: players });
  this.game = g;
  this.started = true;
  g.on('newtrick', function (d) { self.broadcastState(); });
  g.on('teams', function (d) { self.broadcastState(); });
  g.on('finish', function () { self.broadcastState(); });
  /* v1.3.6：新一局开始，先让所有人把上一局的结算窗口收起来，
   * 否则结算页会一直盖在牌桌上，其他人根本点不到牌、最后全被托管。 */
  this.broadcast({ type: 'roundBegin', round: 1 });
  this.resetReady();
  this.beginRound();
  this.broadcastState();
  this.broadcastReady();
};

/**
 * 开新一局
 * @param {object|null} plan 上一局算出的进贡方案（null = 不进贡）
 */
Room.prototype.beginRound = function (plan) {
  var g = this.game;
  var hasTribute = !!(plan && plan.gives && plan.gives.length);
  this.lastAuto = null;
  this.pendingDeclare = null;
  this.pendingTribute = null;
  try { clearTimeout(this.declareTimer); clearTimeout(this.tributeTimer); } catch (e) { }
  g.startRound();                 // 注意：startRound 会把 g.tribute 清空，进贡方案必须提前取出来
  this.resetReady();
  if (hasTribute) {
    // 先切到进贡阶段再广播，避免客户端出现"可以出牌"的一瞬
    g.beginTribute(plan);
    this.tributeQueue = g.tributeQueue;
  } else {
    this.tributeQueue = [];
  }
  this.syncClock(true);
  this.broadcastState();
  if (hasTribute) return;
  this.announceLeader();
  this.afterMove();
};

/** 告诉所有客户端本局谁先出、凭什么先出（♣4 / 进贡最大牌） */
Room.prototype.announceLeader = function () {
  var g = this.game;
  if (!g) return;
  this.broadcast({
    type: 'leader',
    seat: g.firstLeader,
    reason: g.leaderReason,
    card: g.leaderCardText,
    name: g.players[g.firstLeader] ? g.players[g.firstLeader].name : ''
  });
};

Room.prototype.afterMove = function () {
  var g = this.game;
  if (!g) return;
  if (g.phase === 'declare') return this.handleDeclare();
  if (g.phase === 'over') return;                 // 结算由客户端点击"下一局"驱动
  if (g.phase === 'playing') return this.scheduleAI();
};

/* ---------------- 回合计时 ---------------- */
/**
 * 给"当前该出牌的人"开一个 15 秒的倒计时（v1.3.8 起）。
 *   · 电脑 / 托管 / 掉线 → 不显示 15 秒，改成 1.6 秒后自动走一步
 *   · 同一手牌只开一次，force=true 时才重开
 */
Room.prototype.syncClock = function (force) {
  clearTimeout(this.turnTimer);
  this.turnTimer = null;
  var g = this.game;
  if (!g || g.phase !== 'playing') {
    this.turnSeat = -1;
    this.turnEndAt = 0;
    this.turnTotal = 0;
    return;
  }
  var seat = g.turn;
  var st = this.seats[seat];
  var p = g.players[seat];
  var auto = p.isAI || !st || st.isAI || st.trustee || !st.ws || st.offline;

  if (!auto) {
    if (!force && this.turnSeat === seat && this.turnEndAt > Date.now() - 100) return;
  } else {
    // 电脑由 scheduleAI 驱动；掉线/托管由下面的短定时器驱动
    if (!p.isAI && st && !st.isAI) {
      var ms = TRUSTEE_MS;
      this.turnSeat = seat;
      this.turnTotal = ms;
      this.turnEndAt = Date.now() + ms;
      var self = this;
      this.turnTimer = setTimeout(function () {
        self.autoAct(seat, st.offline ? 'offline' : 'trustee');
      }, ms);
      return;
    }
    this.turnSeat = seat;
      this.turnEndAt = 0;
      this.turnTotal = 0;
      return;
  }

  this.turnSeat = seat;
  this.turnTotal = TURN_MS;
  this.turnEndAt = Date.now() + TURN_MS;
  var self2 = this;
  this.turnTimer = setTimeout(function () { self2.autoAct(seat, 'timeout'); }, TURN_MS);
};

/** 倒计时到点 / 掉线 / 托管：替该玩家出一步 */
Room.prototype.autoAct = function (seat, reason) {
  var g = this.game;
  if (!g || g.phase !== 'playing' || g.turn !== seat) return false;

  var st = this.seats[seat];
  // 掉线后 1 秒内又回来了：不代打，重新给满 15 秒
  if (reason !== 'timeout' && st && st.ws && !st.trustee && !st.offline) {
    this.syncClock(true);
    this.broadcastState();
    return false;
  }

  this.lastAuto = { seat: seat, reason: reason, at: Date.now(), name: g.players[seat].name };

  var ok = false;
  /* v1.3.8：超时不再按电脑策略"聪明出牌" ——
   *   跟牌超时 → 自动过牌；自由出牌超时 → 自动打出最小的一张（首手必须带 ♣4 时打 ♣4）。
   * 托管 / 掉线仍由电脑玩家接手，保证牌局能推进。 */
  if (reason === 'timeout') {
    if (g.trick) {
      ok = this.execPass(seat);
    } else {
      var hand = g.players[seat].hand || [];
      var one = null;
      if (g.mustIncludeClub4(seat)) {
        one = hand.filter(C.isClub4)[0] || null;
      }
      if (!one && hand.length) {
        one = hand.slice().sort(function (a, b) { return C.cardValue(a) - C.cardValue(b); })[0];
      }
      if (one) ok = this.execPlay(seat, [one]);
      else ok = this.execPass(seat);
    }
  } else {
    var d = null;
    try { d = AI.decide(g, seat); } catch (e) { d = null; }
    if (d && d.type === 'play' && d.cards && d.cards.length) ok = this.execPlay(seat, d.cards);
    else if (d && d.type === 'pass') ok = this.execPass(seat);
  }

  if (!ok) {
    var opts = [];
    try { opts = g.options(seat) || []; } catch (e) { }
    if (opts.length) ok = this.execPlay(seat, opts[0].cards);
    else ok = this.execPass(seat);
  }

  if (ok) {
    this.broadcast({ type: 'auto', seat: seat, reason: reason, name: g.players[seat].name });
  }
  return ok;
};

Room.prototype.handleDeclare = function () {
  var self = this, g = this.game;
  if (!g.needDeclare()) {
    g.phase = 'playing';
    this.syncClock(true);
    this.broadcastState();
    return this.afterMove();
  }
  var seat = g.soloCandidate;
  var s = this.seats[seat];
  if (s && !s.isAI && s.ws && !s.trustee && !s.offline) {
    this.pendingDeclare = seat;
    this.sendTo(seat, { type: 'askDeclare', seat: seat });
    clearTimeout(this.declareTimer);
    this.declareTimer = setTimeout(function () {
      if (self.pendingDeclare !== seat) return;
      if (!self.game || self.game.phase !== 'declare') return;
      self.pendingDeclare = null;
      self.game.declare(AI.decideDeclare(self.game.players[seat].hand));
      self.syncClock(true);
      self.broadcastState();
      self.afterMove();
      self.broadcast({ type: 'auto', seat: seat, reason: 'timeout', name: self.game.players[seat].name });
    }, DECLARE_MS);
    return;
  }
  g.declare(AI.decideDeclare(g.players[seat].hand));
  this.syncClock(true);
  this.broadcastState();
  this.afterMove();
};

Room.prototype.scheduleAI = function () {
  var self = this;
  clearTimeout(this.aiTimer);
  var g = this.game;
  if (!g || g.phase !== 'playing') return;
  var p = g.players[g.turn];
  var st = this.seats[g.turn];
  var isAI = p.isAI || !st || st.isAI;
  if (!isAI) return;
  this.aiTimer = setTimeout(function () {
    var g2 = self.game;
    if (!g2 || g2.phase !== 'playing') return;
    var seat = g2.turn;
    var s2 = self.seats[seat];
    if (!g2.players[seat].isAI && s2 && !s2.isAI) return;
    var d = AI.decide(g2, seat);
    if (!d) return;
    if (d.type === 'pass') self.execPass(seat);
    else self.execPlay(seat, d.cards);
  }, 500 + Math.random() * 600);
};

Room.prototype.execPlay = function (seat, cards) {
  var g = this.game;
  var r = g.play(seat, cards);
  if (!r.ok) return false;
  this.syncClock(true);
  this.broadcastState();
  this.afterMove();
  return true;
};

Room.prototype.execPass = function (seat) {
  var g = this.game;
  var r = g.pass(seat);
  if (!r.ok) return false;
  this.syncClock(true);
  this.broadcastState();
  this.afterMove();
  return true;
};

/* ---------------- 下一局 + 进贡 ---------------- */
Room.prototype.nextRound = function (seat) {
  var g = this.game;
  if (!g) return;
  if (seat !== this.hostSeat) return;            // 只有房主能开下一局
  /* v1.3.6：全员点了「准备」才允许开下一局 */
  if (!this.allReady()) {
    this.sendTo(seat, { type: 'error', msg: '还有玩家没准备：' + this.notReadyNames().join('、') });
    return;
  }
  var plan = g.tribute;                          // 先取出上一局的进贡方案（发牌会被重置）
  var hasTribute = !!(plan && plan.gives && plan.gives.length);
  // 新一局开始：先让所有人把上一局的结算窗口收起来，别再盖住牌桌
  this.broadcast({ type: 'roundBegin', round: g.round + 1 });
  this.beginRound(hasTribute ? plan : null);
  this.broadcastReady();
  if (hasTribute) {
    this.broadcast({ type: 'tributeStart', desc: plan.desc, count: plan.n });
    var self = this;
    setTimeout(function () { self.execTributeStep(); }, 800);
  }
};

/** 进贡流程：先把所有「交牌」跑完进牌池，再按交牌大小依次「收牌」 */
Room.prototype.execTributeStep = function () {
  var self = this, g = this.game;
  if (!g) return;
  if (!g.tributeQueue) g.tributeQueue = [];

  if (!g.tributeQueue.length) {
    if (!g._takeSteps) {
      g._takeSteps = g.buildTakeSteps();         // 交牌结束 → 生成收牌步骤
      g.tributeQueue = g._takeSteps.slice();
      if (g.tributeQueue.length) this.broadcastState();
    }
    if (!g.tributeQueue.length) return this.finishTributePhase();
  }

  var item = g.tributeQueue.shift();
  if (item.kind === 'take') return this.doTakeStep(item);
  return this.doGiveStep(item);
};

Room.prototype.finishTributePhase = function () {
  var g = this.game;
  g._takeSteps = null;
  // 进贡全部结束：按"交出的单张牌最大"决定本局首出
  g.finishTribute();
  g.phase = (g.soloCandidate !== null && g.soloCandidate !== undefined) ? 'declare' : 'playing';
  this.syncClock(true);
  this.broadcastState();
  this.announceLeader();
  return this.afterMove();
};

/** 这个座位现在由系统接手吗（电脑 / 掉线 / 托管） */
Room.prototype.isAutoSeat = function (seat) {
  var g = this.game;
  var st = this.seats[seat];
  return !!(g.players[seat].isAI || !st || st.isAI || !st.ws || st.offline || st.trustee);
};

/** 阶段一：交牌进牌池 */
Room.prototype.doGiveStep = function (item) {
  var self = this, g = this.game;
  if (this.isAutoSeat(item.from)) {
    this.autoGive(item);
    this.broadcastState();
    setTimeout(function () { self.execTributeStep(); }, 600);
    return;
  }
  // 真人：mode='max' 只是让他确认；mode='pick' 让他自己挑不要的牌
  this.pendingTribute = item;
  this.sendTo(item.from, { type: 'askTribute', item: item });
  clearTimeout(this.tributeTimer);
  this.tributeTimer = setTimeout(function () {
    if (self.pendingTribute !== item) return;
    self.pendingTribute = null;
    self.autoGive(item);
    self.broadcastState();
    self.broadcast({ type: 'auto', seat: item.from, reason: 'timeout', name: g.players[item.from].name });
    setTimeout(function () { self.execTributeStep(); }, 500);
  }, TRIBUTE_MS);
};

/** 阶段二：从对方交出来的牌池里挑牌 */
Room.prototype.doTakeStep = function (item) {
  var self = this, g = this.game;
  var rest = g.poolOf(item.side).slice();
  if (item.auto || this.isAutoSeat(item.taker)) {
    var cards = item.auto ? rest : g.autoTake(item, item.count);
    g.takeFromPool(item, cards.length ? cards : rest);
    this.broadcastState();
    setTimeout(function () { self.execTributeStep(); }, 600);
    return;
  }
  this.pendingTribute = item;
  this.sendTo(item.taker, {
    type: 'askTribute', item: item,
    pool: rest.map(function (c) {
      return { id: c.id, rank: c.rank, suit: c.suit, sym: c.sym, label: c.label, red: !!c.red };
    })
  });
  clearTimeout(this.tributeTimer);
  this.tributeTimer = setTimeout(function () {
    if (self.pendingTribute !== item) return;
    self.pendingTribute = null;
    var cs = g.autoTake(item, item.count);
    g.takeFromPool(item, cs.length ? cs : rest);
    self.broadcastState();
    self.broadcast({ type: 'auto', seat: item.taker, reason: 'timeout', name: g.players[item.taker].name });
    setTimeout(function () { self.execTributeStep(); }, 500);
  }, TRIBUTE_MS);
};

Room.prototype.autoGive = function (item) {
  var g = this.game;
  var hand = g.players[item.from].hand;
  var cards = (item.mode === 'max')
    ? C.tributeMax(hand, item.count)
    : AI.tributePick(hand, item.count, 'pick');
  g.giveToPool(item, cards);
};

/** 兼容旧调用：直接把牌交出去（现在统一走 giveToPool，这里保留给历史代码） */
Room.prototype.giveCards = function (item, cards) {
  var g = this.game;
  g.giveToPool(item, cards);
};

/* ---------------- 座位 / 断线 ---------------- */
Room.prototype.seatOfWs = function (ws) {
  for (var i = 0; i < 4; i++) {
    if (this.seats[i] && this.seats[i].ws === ws) return i;
  }
  return -1;
};

/** 断线重连：凭 token 回到原座位
 *  v1.3.4：本局还没打完时不接受回座 —— 掉线的座位已经交给系统托管，
 *  中途放人回来会打乱出牌顺序（也可能把已经开始的一局搅乱）。
 *  只有等本局结束（phase === 'over'）或房间还没开局，才可以回来。
 *  返回值：>=0 座位号；-1 座位已被释放；-2 本局进行中，暂不接受 */
Room.prototype.resume = function (ws, token) {
  if (!token) return -1;
  if (this.started && this.game && this.game.phase !== 'over') return -2;
  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    if (s && !s.isAI && s.token === token) {
      s.ws = ws;
      s.offline = false;
      s.offlineAt = 0;
      s.trustee = false;                 // 人回来了就恢复手动出牌
      if (this.game && this.game.players[i]) this.game.players[i].isAI = false;
      this.syncClock(true);
      this.broadcastRoom();
      this.broadcastState();
      return i;
    }
  }
  return -1;
};

/** 连接断开：保留座位 + 立刻托管 */
Room.prototype.disconnect = function (seat) {
  var s = this.seats[seat];
  if (!s) return;

  if (!this.started || !this.game) {
    // 还没开局：直接释放座位，让新人能补位
    this.seats[seat] = null;
    this.transferHost();
    this.broadcastRoom();
    return;
  }

  s.ws = null;
  s.offline = true;
  s.offlineAt = Date.now();
  s.trustee = true;
  this.trusteeFlags[seat] = true;
  this.transferHost();
  this.broadcastRoom();
  this.broadcastState();
  this.broadcast({ type: 'offline', seat: seat, name: s.name });

  // 正好轮到他：立刻代打，别让另外三个人干等
  if (this.game.phase === 'playing' && this.game.turn === seat) this.autoAct(seat, 'offline');
  // 等他宣告 / 进贡：也直接替他处理
  if (this.pendingDeclare === seat) {
    var self = this;
    setTimeout(function () {
      if (self.pendingDeclare !== seat || !self.game || self.game.phase !== 'declare') return;
      self.pendingDeclare = null;
      self.game.declare(AI.decideDeclare(self.game.players[seat].hand));
      self.syncClock(true);
      self.broadcastState();
      self.afterMove();
    }, 400);
  }
  if (this.pendingTribute && (this.pendingTribute.from === seat || this.pendingTribute.taker === seat)) {
    var it = this.pendingTribute;
    this.pendingTribute = null;
    clearTimeout(this.tributeTimer);
    if (it.kind === 'take') {
      var rest = this.game.poolOf(it.side).slice();
      this.game.takeFromPool(it, it.auto ? rest : this.game.autoTake(it, it.count));
    } else {
      this.autoGive(it);
    }
    this.broadcastState();
    var self2 = this;
    setTimeout(function () { self2.execTributeStep(); }, 500);
  }
  // 掉线的人不再阻塞"全体准备"
  this.broadcastReady();

  // 10 分钟没回来：座位转给电脑，避免占着位置
  var self3 = this;
  clearTimeout(this.cleanupTimer);
  this.cleanupTimer = setTimeout(function () {
    var s2 = self3.seats[seat];
    if (!s2 || s2.ws || !s2.offline) return;
    s2.token = '';
    if (self3.game && self3.game.players[seat]) self3.game.players[seat].isAI = true;
    self3.broadcastRoom();
    self3.broadcastState();
    self3.scheduleAI();
  }, RESUME_TTL);
};

Room.prototype.transferHost = function () {
  var cur = this.seats[this.hostSeat];
  if (cur && cur.ws) return;
  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    if (s && !s.isAI && s.ws) { this.hostSeat = i; return; }
  }
};

Room.prototype.removePlayer = function (seat) {
  if (seat < 0) return;
  var s = this.seats[seat];
  if (!s) return;
  if (this.started && this.game) {
    // 主动离开：座位交给电脑托管，本局照常打完
    this.disconnect(seat);
    s.token = '';
    return;
  }
  this.seats[seat] = null;
  this.transferHost();
  this.broadcastRoom();
};

Room.prototype.isEmpty = function () {
  return this.seats.every(function (s) { return !s || s.isAI || !s.ws; });
};

/* ---------------- 客户端消息 ---------------- */
Room.prototype.onMessage = function (seat, msg) {
  var self = this, g = this.game;
  if (!msg) return;
  var st = this.seats[seat];

  if (msg.type === 'start') {
    if (seat !== this.hostSeat) return;
    if (this.started) return;
    /* v1.3.6：所有人（在座的真人）都点了准备，房主才能开局 */
    if (!this.allReady()) {
      this.sendTo(seat, { type: 'error', msg: '还有玩家没准备：' + this.notReadyNames().join('、') });
      return;
    }
    this.start();
    return;
  }

  if (msg.type === 'ready') {
    if (!st) return;
    this.setReady(seat, !!msg.on);
    return;
  }

  if (msg.type === 'next') { this.nextRound(seat); return; }

  if (msg.type === 'trustee') {
    if (!st) return;
    st.trustee = !!msg.on;
    this.syncClock(true);
    this.broadcastState();
    this.broadcastRoom();
    return;
  }

  if (msg.type === 'declare') {
    if (this.pendingDeclare === seat && g && g.phase === 'declare') {
      this.pendingDeclare = null;
      clearTimeout(this.declareTimer);
      /* v1.4.0：独狼看完牌觉得没戏可以「直接下一局」，
       * 服务端按"已公布身份 + 最后一名走"收尾（交 9 张 / 收 9 张）。 */
      if (msg.giveUp) {
        g.soloGiveUp();
        this.broadcast({ type: 'auto', seat: seat, reason: 'giveup', name: g.players[seat].name });
      } else {
        g.declare(!!msg.yes);
      }
      this.syncClock(true);
      this.broadcastState();
      this.afterMove();
    }
    return;
  }

  if (msg.type === 'tributeCards') {
    var it = this.pendingTribute;
    if (!it) return;

    /* 阶段二：从对方牌池里挑牌 */
    if (it.kind === 'take') {
      if (it.taker !== seat) return;
      var pool = {};
      g.poolOf(it.side).forEach(function (c) { pool[c.id] = c; });
      var take = (msg.ids || []).map(function (id) { return pool[id]; }).filter(Boolean);
      if (take.length !== it.count) return;
      this.pendingTribute = null;
      clearTimeout(this.tributeTimer);
      g.takeFromPool(it, take);
      this.broadcastState();
      setTimeout(function () { self.execTributeStep(); }, 500);
      return;
    }

    /* 阶段一：交牌 */
    if (it.from !== seat) return;
    var hand = g.players[seat].hand;
    var cs;
    if (it.mode === 'max') {
      // 进贡是强制的：直接按规则取，不听客户端传的牌，避免作弊
      cs = C.tributeMax(hand, it.count);
    } else {
      var pool2 = {};
      hand.forEach(function (c) { pool2[c.id] = c; });
      cs = (msg.ids || []).map(function (id) { return pool2[id]; }).filter(Boolean);
      // ♦3 / ♦A 不允许交出（客户端已锁，这里再兜一层）
      if (cs.some(function (c) { return !C.canReturn(c); })) {
        this.sendTo(seat, { type: 'error', msg: '♦3 和 ♦A 不能交出去' });
        return;
      }
    }
    if (cs.length !== it.count) return;
    this.pendingTribute = null;
    clearTimeout(this.tributeTimer);
    g.giveToPool(it, cs);
    this.broadcastState();
    setTimeout(function () { self.execTributeStep(); }, 500);
    return;
  }

  if (msg.type === 'act') {
    if (!g || !this.started || g.turn !== seat) return;
    // 手动操作即视为"我人在"，自动取消托管
    if (st && st.trustee) {
      st.trustee = false;
      this.broadcastRoom();
    }
    clearTimeout(this.turnTimer);
    if (msg.act === 'pass') {
      this.execPass(seat);
    } else {
      var pool2 = {};
      g.players[seat].hand.forEach(function (c) { pool2[c.id] = c; });
      var cards = (msg.ids || []).map(function (id) { return pool2[id]; }).filter(Boolean);
      if (cards.length !== (msg.ids || []).length) return;
      this.execPlay(seat, cards);
    }
    return;
  }
};

module.exports = { Room: Room, NAMES: NAMES, AVATARS: AVATARS, TURN_MS: TURN_MS };
