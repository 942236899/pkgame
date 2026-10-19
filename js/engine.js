/* ============================================================
 * engine.js —— 找队友扑克 游戏流程引擎（纯状态机，不含 AI 与 UI）
 * 座位约定：0=我(下)  1=右家  2=对家(上)  3=左家
 * 出牌顺序：0 → 1 → 2 → 3 → 0
 * ============================================================ */
(function (global) {
  'use strict';

  var C = global.Cards;
  var K = global.Combos;

  /* ♣4 的固定牌对象：只用于"首出权"展示，不参与手牌 */
  var CLUB4 = { id: '4C', rank: '4', rankIdx: 0, suit: 'C', suitIdx: 0, sym: '♣', suitName: '梅花', red: false, label: '♣4' };

  function Game(cfg) {
    cfg = cfg || {};
    this.players = [];
    var defaults = [
      { name: '我', avatar: '🙂' },
      { name: '右家', avatar: '🤖' },
      { name: '对家', avatar: '🤖' },
      { name: '左家', avatar: '🤖' }
    ];
    for (var i = 0; i < 4; i++) {
      var p = (cfg.players && cfg.players[i]) || {};
      this.players.push({
        seat: i,
        id: p.id || ('p' + i),
        name: p.name || defaults[i].name,
        avatar: p.avatar || defaults[i].avatar,
        isAI: !!p.isAI,
        hand: [],
        finished: false,
        place: 0
      });
    }

    this.round = 0;
    this.phase = 'idle';           // idle | declare | playing | tribute | over
    this.turn = 0;                 // 当前该谁行动
    this.trick = null;             // { seat, combo } 桌面当前牌型
    this.passed = [false, false, false, false];
    this.trickCount = 0;           // 本局已进行的回合数
    this.played = [];              // 本局已出的所有牌
    this.finishOrder = [];         // 出完牌的座位顺序
    this.teams = null;             // [[a,b],[c,d]]
    this.soloSeat = null;          // 独狼座位
    this.teamsRevealed = false;    // ♦A 与 ♦3 是否都已出现（都出现 ⇒ 公开标明队友）
    this.declared = false;         // 独狼是否在开局前宣告
    this.giveUpSeat = null;        // v1.4.0：本局是否由独狼「直接下一局」跳过（存独狼座位）
    this.firstLeader = 0;          // 本局首出座位
    this.leaderReason = 'club4';   // 首出依据：club4（♣4 持有者）| tribute（进贡最大牌）
    this.leaderCardId = '4C';      // 决定首出的那张牌的 id
    this.leaderCardText = '♣4';
    /* v1.3.6：本局开局首出是否「必须带 ♣4」。
     * true  = 第 1 局 / 上一局 1、4 对 2、3 不进贡的局面 ⇒ ♣4 持有者先出，且首出必须含 ♣4
     * false = 上一局有进贡 ⇒ 交出最大单张的人先出，只需出合规牌型 */
    this.requireClub4Lead = true;
    this.tributePaid = [];         // 本局实际进贡（mode:'max'）的牌：{from,to,cards}
    this.tribute = null;           // 本轮结算出的进贡任务
    this.tributeQueue = [];        // 待处理进贡项
    this.tributeStep = null;       // 当前等待处理的进贡项
    this.lastAction = null;        // { seat, type:'play'|'pass', combo }
    /* v1.3.8：桌面显示用 —— 每人「最近一次操作」，只保留一份，换手就替换自己那一块。
     * seq 是只增不减的操作编号：前端拿它当作这一手牌的节点标识，
     * 编号没变就不重绘、不重播飞入动画。 */
    this.lastActions = [null, null, null, null];
    this.actSeq = 0;
    this.log = [];
    this.listeners = {};
  }

  Game.prototype.on = function (evt, fn) {
    (this.listeners[evt] = this.listeners[evt] || []).push(fn);
    return this;
  };
  Game.prototype.emit = function (evt, data) {
    var l = this.listeners[evt] || [];
    for (var i = 0; i < l.length; i++) l[i](data);
  };
  Game.prototype.p = function (seat) { return this.players[seat]; };

  /* ---------------- 发牌 / 开局 ---------------- */

  Game.prototype.startRound = function () {
    this.round++;
    var hands = C.deal(4, 7);
    for (var i = 0; i < 4; i++) {
      var p = this.players[i];
      p.hand = hands[i];
      p.finished = false;
      p.place = 0;
    }
    this.phase = 'declare';
    this.turn = 0;
    this.trick = null;
    this.passed = [false, false, false, false];
    this.trickCount = 0;
    this.played = [];
    this.finishOrder = [];
    this.teams = null;
    this.soloSeat = null;
    this.declared = false;
    this.giveUpSeat = null;
    this.teamsRevealed = false;
    this._revealSig = null;        // 公开状态签名（见 revealSignature）
    this.tribute = null;
    this.tributeQueue = [];
    this.tributeStep = null;
    this.tributePaid = [];
    this.pools = [[], []];
    this.contrib = {};
    this._takeSteps = null;
    this.lastAction = null;
    this.lastActions = [null, null, null, null];
    this.actSeq = 0;
    this._history = [];

    /* 首出：♣4 的持有者先出（可出任意合法牌型，不强制先出 ♣4）。
     * 若本局有进贡，进贡交换完成后由 finishTribute() 改判为
     * 「交出最大那张牌的玩家」先出 —— 见 finishTribute()。 */
    var leader = 0;
    for (var s = 0; s < 4; s++) {
      if (this.players[s].hand.some(C.isClub4)) { leader = s; break; }
    }
    this.firstLeader = leader;
    this.leaderReason = 'club4';
    this.leaderCardId = '4C';
    this.leaderCardText = '♣4';
    this.turn = leader;
    // 开局首出必须带 ♣4（进贡局面会在 finishTribute() 里改成 false）
    this.requireClub4Lead = true;

    // 分队：发牌后立刻在内部确定，但游戏中一律不公布，结算才公开
    //   · ♦3 与 ♦A 的持有者同队
    //   · 两张牌在同一人手里 ⇒ 该玩家 1 打 3（独狼）
    this.soloCandidate = null;
    for (var k = 0; k < 4; k++) {
      var h = this.players[k].hand;
      if (h.some(C.isDiamondA) && h.some(C.isDiamond3)) { this.soloCandidate = k; break; }
    }
    this._resolveTeamsByHolder();
    // 撞车（♦A + ♦3 同人）⇒ 独狼 1 打 3。
    // 是否"宣告"由他本人私下决定（只影响进贡 3 张 / 2 张），过程中不对任何人公开。
    this.phase = (this.soloCandidate !== null) ? 'declare' : 'playing';
    this.emit('roundstart', { round: this.round, leader: leader, soloCandidate: this.soloCandidate });
    return this;
  };

  /** 是否有玩家需要在开局前宣告独狼 */
  Game.prototype.needDeclare = function () {
    return this.phase === 'declare' && this.soloCandidate !== null;
  };

  Game.prototype.declare = function (yes) {
    if (this.phase !== 'declare') return;
    this.declared = !!yes;
    this.phase = 'playing';
    this.emit('declare', { seat: this.soloCandidate, declared: this.declared });
    // 宣告 = 公开自己独狼身份：全场立刻都能看到标记
    this._updateReveal();
  };

  /**
   * 独狼开局投降（v1.4.0）：
   * 宣告阶段独狼先看完自己这一手的牌，觉得没戏就可以「直接下一局」，本局不再开打。
   * 处理办法：视同「已公布自己是独狼 + 最后一个走」——
   *   · 名次：独狼第 4 名，另外 3 人并列第 1 名；
   *   · 进贡：按独狼交 9 张、收 9 张（另外 3 人各交 3 张、各收 3 张）执行，
   *           谁先拿牌仍按「交出的单张最大者先选」的老规则。
   */
  Game.prototype.soloGiveUp = function () {
    if (this.phase !== 'declare') return false;
    var solo = (this.soloSeat === null || this.soloSeat === undefined) ? this.soloCandidate : this.soloSeat;
    if (solo === null || solo === undefined) return false;

    this.declared = true;
    this.giveUpSeat = solo;
    this.finishOrder = [];
    for (var i = 0; i < 4; i++) {
      var p = this.players[i];
      p.finished = true;
      p.place = (i === solo) ? 4 : 1;
      if (i !== solo) this.finishOrder.push(i);
    }
    this.finishOrder.push(solo);
    this._ensureTeams();
    this._updateReveal();
    this.phase = 'over';
    this.tribute = this.computeTribute();
    this.emit('over', {
      finishOrder: this.finishOrder.slice(), teams: this.teams,
      tribute: this.tribute, mode: 'giveup', giveUpSeat: solo
    });
    return true;
  };

  /* ---------------- 首出权（v1.3.3） ----------------
   * 规则：
   *   · 第 1 局、或上一局是「1、4 名 对 2、3 名」这类不进贡的局面
   *     ⇒ 谁手里有 ♣4 谁先出（先出的人可以出任意合法牌型，不必先出 ♣4）；
   *   · 上一局有名次差、需要进贡的（1、2 / 1、3 / 独狼等）
   *     ⇒ 谁交出的单张牌最大，谁先出。
   *     例：1、3 名一队、各交 1 张，一人交 ♠2、另一人交 ♥A ⇒ 交 ♠2 的先出。
   *   · 独狼局里只有独狼一方交牌（独狼输），则独狼先出；
   *     独狼赢时另外 3 人各交若干张，则这 3 人里交得最大的先出。
   * 实现：进贡每交出一批「最大的牌」就 noteTribute 记一笔，
   *      全部交换结束后调 finishTribute() 统一判定。
   */
  Game.prototype.setLeader = function (seat, reason, card) {
    this.firstLeader = seat;
    this.leaderReason = reason;
    this.leaderCardId = card ? card.id : '';
    this.leaderCardText = card ? C.cardText(card) : '';
    this.turn = seat;
    /* 只有「看 ♣4」定首出时才要求首出带 ♣4；
     * 有进贡的局面看谁交的单张最大，那手牌随便出合规牌型就行 */
    this.requireClub4Lead = (reason === 'club4');
  };

  /**
   * 本局首出是否必须包含 ♣4
   * · 第 1 局，或上一局是 1、4 名 对 2、3 名（不进贡）⇒ 是
   * · 上一局有进贡（1、2 / 1、3 / 独狼）⇒ 否
   */
  Game.prototype.mustIncludeClub4 = function (seat) {
    if (!this.requireClub4Lead) return false;
    if (this.played && this.played.length) return false;   // 只在开局第一手生效
    return this.turn === seat;
  };

  /** 记录一次实际进贡（只记 mode:'max' 的"交最大的牌"，还贡不参与首出判定） */
  Game.prototype.noteTribute = function (item, cards) {
    if (!item || item.mode !== 'max' || !cards || !cards.length) return;
    this.tributePaid = this.tributePaid || [];
    this.tributePaid.push({ from: item.from, to: item.to, cards: cards.slice() });
  };

  /** 进贡全部完成后调用：交出的单张牌最大者先出；没有进贡则回到 ♣4 规则 */
  Game.prototype.finishTribute = function () {
    var best = null, bestSeat = -1;
    (this.tributePaid || []).forEach(function (p) {
      p.cards.forEach(function (c) {
        if (best === null || C.cardValue(c) > C.cardValue(best)) { best = c; bestSeat = p.from; }
      });
    });
    if (bestSeat >= 0) {
      this.setLeader(bestSeat, 'tribute', best);
      return { seat: bestSeat, reason: 'tribute', card: best };
    }
    var leader = 0;
    for (var s = 0; s < 4; s++) {
      if (this.players[s].hand.some(C.isClub4)) { leader = s; break; }
    }
    var c4 = CLUB4;
    this.setLeader(leader, 'club4', c4);
    return { seat: leader, reason: 'club4', card: c4 };
  };

  /* ---------------- 出牌合法性 ---------------- */

  /**
   * 是否允许该座位此刻打出「纯3张」
   * 规则（用户确认，v1.2.1 收紧）：
   *   必须是「领出」（桌面没有待压的牌型），并且满足其中一条——
   *   1) 本局第一次出牌（开局首出，牌权本来就在他手上）；
   *   2) 其余 3 人都过牌、牌权回到自己时，手上正好只剩纯 3 张（出完即走完），例如只剩 444。
   * ⇒ 「先打了一张大牌、其余人全过、手上还有一堆牌」这种重新领出，是<b>不能</b>再甩 444 的。
   */
  Game.prototype.allowTriple = function (seat) {
    if (this.trick !== null) return false;          // 跟牌压制一律不能出纯3张
    if (this.turn !== seat) return false;
    if (this.played.length === 0) return true;      // ① 本局开局首出
    return this.p(seat).hand.length === 3;          // ② 领出时手上只剩这 3 张
  };

  /** 校验一组牌能否打出 */
  Game.prototype.validate = function (seat, cards) {
    if (this.phase !== 'playing') return { ok: false, msg: '当前不能出牌' };
    if (this.turn !== seat) return { ok: false, msg: '还没到你出牌' };
    if (!cards || !cards.length) return { ok: false, msg: '请先选牌' };
    var hand = this.p(seat).hand;
    var ids = {};
    hand.forEach(function (c) { ids[c.id] = true; });
    for (var i = 0; i < cards.length; i++) {
      if (!ids[cards[i].id]) return { ok: false, msg: '手牌中没有这张牌' };
    }
    var combo = K.detect(cards);
    if (!combo) return { ok: false, msg: '不是合法牌型' };
    /* v1.3.6：开局首出必须带 ♣4。
     * 可以是单张 ♣4、含 ♣4 的对子（♣4+4）、带"对4（含♣4）"的三带二、带 ♣4 的四带一。 */
    if (this.mustIncludeClub4(seat) && !cards.some(C.isClub4)) {
      return {
        ok: false,
        msg: '开局首出必须带 ♣4（可单出 ♣4，或 ♣4+4 的对子、带对4的三带二、带 ♣4 的四带一）'
      };
    }
    if (combo.type === K.TYPE.TRIPLE && !this.allowTriple(seat)) {
      if (this.trick) return { ok: false, msg: '纯3张不能跟牌，只能在领出时打出' };
      return {
        ok: false,
        msg: '纯3张只能开局首出，或手上只剩这 3 张时领出（现在还有 ' + this.p(seat).hand.length + ' 张牌）'
      };
    }
    if (this.trick && !K.canBeat(combo, this.trick.combo)) {
      return { ok: false, msg: '压不过桌上的牌' };
    }
    return { ok: true, combo: combo };
  };

  /** 当前行动方可出的所有合法选项（用于提示 / AI） */
  Game.prototype.options = function (seat) {
    if (this.phase !== 'playing') return [];
    var target = this.trick ? this.trick.combo : null;
    var opts = K.playableOptions(this.p(seat).hand, target, this.allowTriple(seat));
    if (this.mustIncludeClub4(seat)) {
      opts = opts.filter(function (o) { return o.cards.some(C.isClub4); });
      if (!opts.length) {
        // 理论上不会发生（首出者手里一定有 ♣4，单张永远合法），兜底放行 ♣4 本身
        var c4 = this.p(seat).hand.filter(C.isClub4);
        if (c4.length) opts = [{ type: K.TYPE.SINGLE, main: c4[0], cards: c4 }];
      }
    }
    return opts;
  };

  /** 智能提示候选（不拆对子 / 三张 / 四张优先） */
  Game.prototype.hintOptions = function (seat) {
    if (this.phase !== 'playing') return [];
    var target = this.trick ? this.trick.combo : null;
    var list = K.hintOptions(this.p(seat).hand, target, this.allowTriple(seat));
    if (this.mustIncludeClub4(seat)) {
      list = list.filter(function (o) { return o.cards.some(C.isClub4); });
    }
    return list;
  };

  /* ---------------- 出牌 / 过牌 ---------------- */

  Game.prototype.play = function (seat, cards) {
    var v = this.validate(seat, cards);
    if (!v.ok) return v;
    var p = this.p(seat);
    var removeIds = {};
    cards.forEach(function (c) { removeIds[c.id] = true; });
    p.hand = p.hand.filter(function (c) { return !removeIds[c.id]; });

    this.trick = { seat: seat, combo: v.combo };
    this.passed = [false, false, false, false];
    this.trickCount++;
    this._history = this._history || [];
    this._history.push({ seat: seat, cards: v.combo.cards.map(function (c) { return c.id; }) });
    this.played = this.played.concat(v.combo.cards.slice());
    this.lastAction = { seat: seat, type: 'play', combo: v.combo };
    this.lastActions[seat] = {
      seat: seat, type: 'play', cards: v.combo.cards.slice(),
      comboType: v.combo.type, seq: ++this.actSeq
    };

    // 分队开局时已内部确定；只打出一张 ♦A/♦3 时系统不做任何标记，
    // 等两张都出现了才公开（见 _updateReveal）
    this.emit('play', { seat: seat, combo: v.combo });
    this._updateReveal();

    if (p.hand.length === 0) {
      p.finished = true;
      p.place = this.finishOrder.length + 1;
      this.finishOrder.push(seat);
      this._lastWinnerPlace1 = this.finishOrder[0];
      this.emit('finish', { seat: seat, place: p.place });
    }

    if (this._checkOver()) return { ok: true, combo: v.combo };

    this.turn = this._nextActive(seat);
    return { ok: true, combo: v.combo };
  };

  Game.prototype.pass = function (seat) {
    if (this.phase !== 'playing') return { ok: false, msg: '当前不能操作' };
    if (this.turn !== seat) return { ok: false, msg: '还没到你' };
    if (!this.trick) return { ok: false, msg: '你是本轮首发，必须出牌' };
    this.passed[seat] = true;
    this.lastAction = { seat: seat, type: 'pass' };
    this.lastActions[seat] = { seat: seat, type: 'pass', cards: [], seq: ++this.actSeq };
    this.emit('pass', { seat: seat });

    // 是否除牌权拥有者外，其余未出完玩家全部过牌
    var all = true;
    for (var i = 0; i < 4; i++) {
      if (i === this.trick.seat) continue;
      if (this.players[i].finished) continue;
      if (!this.passed[i]) { all = false; break; }
    }
    if (all) {
      var leader = this.trick.seat;   // 牌权拥有者重新自由出牌
      this.trick = null;
      this.passed = [false, false, false, false];
      this.turn = leader;
      if (this.p(leader).finished) this.turn = this._nextActive(leader);
      this.emit('newtrick', { seat: this.turn });
    } else {
      this.turn = this._nextActive(seat);
    }
    return { ok: true };
  };

  Game.prototype.lastPlaySeat = function () {
    if (this.trick) return this.trick.seat;
    return this.firstLeader;
  };

  Game.prototype._nextActive = function (from) {
    for (var i = 1; i <= 4; i++) {
      var s = (from + i) % 4;
      if (!this.players[s].finished) return s;
    }
    return from;
  };

  /* ---------------- 找队友 ---------------- */

  /** ♦3 的归属：已打出 → 打出者；否则 → 当前持有者 */
  Game.prototype.diamond3Owner = function () {
    for (var i = this.played.length - 1; i >= 0; i--) {
      if (C.isDiamond3(this.played[i])) {
        // 找到打出 ♦3 的人
        return this._playOwner(this.played[i]);
      }
    }
    for (var s = 0; s < 4; s++) {
      if (this.players[s].hand.some(C.isDiamond3)) return s;
    }
    return null;
  };

  Game.prototype._playOwner = function (card) {
    // 从历史出牌记录里找是谁打的
    var hist = this._history || [];
    for (var i = hist.length - 1; i >= 0; i--) {
      if (hist[i].cards.indexOf(card.id) >= 0) return hist[i].seat;
    }
    // 兜底：还在谁手里
    for (var s = 0; s < 4; s++) {
      if (this.players[s].hand.some(function (c) { return c.id === card.id; })) return s;
    }
    return null;
  };

  /** 按发牌后的持有情况分队（内部信息，结算前不对外公布） */
  Game.prototype._resolveTeamsByHolder = function () {
    var aSeat = null, t3 = null;
    for (var s = 0; s < 4; s++) {
      var h = this.players[s].hand;
      if (h.some(C.isDiamondA)) aSeat = s;
      if (h.some(C.isDiamond3)) t3 = s;
    }
    // ♦A / ♦3 的原始持有者（自己手里有，自己心里有数）
    this._origA = aSeat;
    this._orig3 = t3;
    if (aSeat !== null && t3 !== null && aSeat !== t3) {
      this.teams = [[aSeat, t3], [0, 1, 2, 3].filter(function (s) { return s !== aSeat && s !== t3; })];
      this.soloSeat = null;
    } else {
      var solo = (aSeat !== null ? aSeat : (t3 !== null ? t3 : 0));
      this.soloSeat = solo;
      this.teams = [[solo], [0, 1, 2, 3].filter(function (s) { return s !== solo; })];
    }
  };

  /** ♦A 是否已经打出来 */
  Game.prototype.diamondAPlayed = function () {
    for (var i = 0; i < this.played.length; i++) if (C.isDiamondA(this.played[i])) return true;
    return false;
  };
  /** ♦3 是否已经打出来 */
  Game.prototype.diamond3Played = function () {
    for (var i = 0; i < this.played.length; i++) if (C.isDiamond3(this.played[i])) return true;
    return false;
  };

  /** 只打出了一张身份牌时，是哪位玩家打出的（没打出则为 null） */
  Game.prototype.identityPlayerSeat = function () {
    var a = this.diamondAPlayed(), t3 = this.diamond3Played();
    if (a && !t3) return this._playOwnerOfId('AD');
    if (t3 && !a) return this._playOwnerOfId('3D');
    return null;
  };

  Game.prototype._playOwnerOfId = function (id) {
    var hist = this._history || [];
    for (var i = hist.length - 1; i >= 0; i--) {
      if (hist[i].cards.indexOf(id) >= 0) return hist[i].seat;
    }
    for (var s = 0; s < 4; s++) {
      if (this.players[s].hand.some(function (c) { return c.id === id; })) return s;
    }
    return null;
  };

  /**
   * 公开时机（v1.3.6 用户确认）：
   *
   * 非独狼（♦A 与 ♦3 分属两人）：
   *   · 谁先打出 ♦A 或 ♦3，除了他自己，其余 3 人立刻看到谁是队友、谁是敌人；
   *   · 他自己要等另一张身份牌也打出来，才看得到。
   *
   * 独狼（♦A + ♦3 在同一人手里）：
   *   · 宣告了 ⇒ 开局即公开：他自己看到「我独狼、另外 3 人是敌人」，
   *                        另外 3 人看到「他是独狼、我们仨一队」；
   *   · 没宣告   ⇒ 他自己心里有数（别人看不到），另外 3 人一律不标记；
   *                只有等他把手里的 ♦A 和 ♦3 都打出来，另外 3 人才开始标记。
   */
  Game.prototype._updateReveal = function () {
    var sig = this.revealSignature();
    if (sig === this._revealSig) return;
    this._revealSig = sig;
    this.teamsRevealed = !!sig.all;
    this.emit('teams', { teams: this.teams, soloSeat: this.soloSeat, revealed: this.teamsRevealed, sig: sig });
  };

  /** 当前公开状态：{all:boolean, except:seat|null} */
  Game.prototype.revealSignature = function () {
    var solo = (this.soloSeat === null || this.soloSeat === undefined) ? null : this.soloSeat;
    var both = this.diamondAPlayed() && this.diamond3Played();

    if (solo !== null) {
      if (this.declared) return { all: true, except: null };
      if (both) return { all: true, except: null };
      return { all: false, except: null, only: solo };      // 未宣告：只有独狼自己知道
    }
    if (both) return { all: true, except: null };
    var one = this.identityPlayerSeat();
    if (one === null || one === undefined) return { all: false, except: null };
    return { all: false, except: one };                     // 出牌者本人还蒙在鼓里
  };

  /** 该座位此刻是否"知道"分队情况（决定 UI 是否标注、AI 是否避让队友） */
  Game.prototype.teamKnownTo = function (seat) {
    if (!this.teams) return false;
    var sig = this.revealSignature();
    if (sig.all) return true;
    if (sig.only !== undefined && sig.only !== null) return sig.only === seat;
    if (sig.except !== undefined && sig.except !== null) return seat !== sig.except;
    return false;
  };

  Game.prototype._resolveTeams = function (aSeat) {
    if (this.teams) return;
    var t3 = this.diamond3Owner();
    if (t3 === null || t3 === aSeat) {
      // ♦A 与 ♦3 同在一人 → 独狼
      this.soloSeat = aSeat;
      this.teams = [[aSeat], [0, 1, 2, 3].filter(function (s) { return s !== aSeat; })];
    } else {
      var others = [0, 1, 2, 3].filter(function (s) { return s !== aSeat && s !== t3; });
      this.teams = [[aSeat, t3], others];
      this.soloSeat = null;
    }
    this.emit('teams', { teams: this.teams, soloSeat: this.soloSeat });
  };

  /** 一局结束时若仍未分队（♦A 一直没出），按最终持有者补判 */
  Game.prototype._ensureTeams = function () {
    // 一局结束：无论 ♦A/♦3 有没有出完，结算时一律公开
    this.teamsRevealed = true;
    if (this.teams) return;
    var aSeat = null, t3 = null;
    for (var s = 0; s < 4; s++) {
      if (this.players[s].hand.some(C.isDiamondA)) aSeat = s;
      if (this.players[s].hand.some(C.isDiamond3)) t3 = s;
    }
    if (aSeat === null) {
      // ♦A 已出但没触发（理论上不会），退化为按名次分队
      var o = this.finishOrder.slice();
      while (o.length < 4) {
        for (var q = 0; q < 4; q++) if (o.indexOf(q) < 0) { o.push(q); break; }
      }
      this.teams = [[o[0], o[1]], [o[2], o[3]]];
      return;
    }
    this._resolveTeams(aSeat);
  };

  /* ---------------- 结束判定 ----------------
   * v1.4.0：独狼局不再把 4 个人排出 1/2/3/4，改成「独狼定名次，其余并列」：
   *   · 独狼第 1 个出完 ⇒ 立刻结束，独狼第 1 名，另外 3 人统统并列第 2 名；
   *   · 独狼第 2 个出完 ⇒ 立刻结束，先走的那位第 1 名、独狼第 2 名，剩下 2 人并列第 3 名；
   *   · 独狼第 3 个出完 ⇒ 名次照排：1、2、独狼（第 3）、最后一人第 4；
   *   · 独狼最后走   ⇒ 名次照排，独狼第 4。
   * 非独狼局维持原样：凑够 3 人出完，或同队两人包揽前两名，就结束。
   */

  Game.prototype._checkOver = function () {
    var solo = (this.soloSeat === null || this.soloSeat === undefined) ? null : this.soloSeat;
    var n = this.finishOrder.length;
    var mode = 'normal';

    if (solo !== null) {
      if (n >= 1 && this.finishOrder[0] === solo) mode = 'solo1';
      else if (n >= 2 && this.finishOrder[1] === solo) mode = 'solo2';
    }
    if (mode === 'normal') {
      var over = (n >= 3);
      if (!over && n >= 2 && this.teams && this._sameTeam(this.finishOrder[0], this.finishOrder[1])) over = true;
      if (!over) return false;
    }

    this._assignPlaces(mode, solo);
    this._ensureTeams();
    this.phase = 'over';
    this.tribute = this.computeTribute();
    this.emit('over', {
      finishOrder: this.finishOrder.slice(), teams: this.teams,
      tribute: this.tribute, mode: mode
    });
    return true;
  };

  /** 给 4 个人定名次（v1.4.0：支持并列名次） */
  Game.prototype._assignPlaces = function (mode, solo) {
    var places = {}, i, k;
    if (mode === 'solo1') {
      // 独狼第 1，其余 3 人并列第 2
      places[solo] = 1;
      for (i = 0; i < 4; i++) if (i !== solo) places[i] = 2;
    } else if (mode === 'solo2') {
      // 先出完的玩家第 1，独狼第 2，剩下 2 人并列第 3
      places[this.finishOrder[0]] = 1;
      places[solo] = 2;
      for (i = 0; i < 4; i++) if (places[i] === undefined) places[i] = 3;
    } else {
      for (i = 0; i < this.finishOrder.length; i++) places[this.finishOrder[i]] = i + 1;
      k = this.finishOrder.length + 1;
      for (i = 0; i < 4; i++) if (places[i] === undefined) places[i] = k++;
    }
    for (i = 0; i < 4; i++) {
      this.players[i].finished = true;
      this.players[i].place = places[i];
      if (this.finishOrder.indexOf(i) < 0) this.finishOrder.push(i);
    }
  };

  Game.prototype._sameTeam = function (a, b) {
    if (!this.teams) return false;
    for (var i = 0; i < this.teams.length; i++) {
      if (this.teams[i].indexOf(a) >= 0 && this.teams[i].indexOf(b) >= 0) return true;
    }
    return false;
  };

  Game.prototype.teamOf = function (seat) {
    if (!this.teams) return -1;
    for (var i = 0; i < this.teams.length; i++) {
      if (this.teams[i].indexOf(seat) >= 0) return i;
    }
    return -1;
  };

  /* ---------------- 结算与进贡 ---------------- */

  /* ------------------------------------------------------------------
   * 进贡 / 还贡（v1.3.6 重写：交牌进公共牌池，按「交出的单张最大」排序依次挑选）
   *
   * 规则要点：
   *  1. 先算交换总张数 T = max(输方人数, 赢方人数) × n
   *     · 队友局 2v2：T = 2n，每人交 n 张、收 n 张
   *     · 独狼局 1v3：T = 3n，独狼一人交 3n 张、收 3n 张，另外 3 人各交 n 张、收 n 张
   *  2. 交牌：输方交「最大的牌」（强制，♦3 / ♦A / 四张 3 不交，不够才用 ♠3 ♥3 ♣3 补）
   *          赢方交「自己不要的牌」（玩家自己选）
   *  3. 收牌：同一方内部按「各自交出的最大单张」从大到小排序，依次从对方牌池里挑牌；
   *          排在最后的人自动拿走剩下的牌。
   * ------------------------------------------------------------------ */
  /**
   * 独狼局的进贡基数 n（每人交 n 张；独狼一人交 3n 张、收 3n 张）—— v1.4.0
   *
   *         独狼名次 →  1    2    3    4
   *   已宣告（公布）    3    2    0    3
   *   未宣告            2    1    1    2
   *
   * n = 0 ⇒ 这一轮谁都不用交换牌，下一局按初始规则（♣4 在谁手里谁先出）。
   */
  Game.prototype.soloTributeCount = function (soloPlace) {
    var table = { '1': [3, 2], '2': [2, 1], '3': [0, 1], '4': [3, 2] };
    var row = table[String(soloPlace)] || table['4'];
    return this.declared ? row[0] : row[1];
  };

  Game.prototype.computeTribute = function () {
    /* v1.4.0：名次可能有并列（独狼局），所以一律以 p.place 为准，
     * 不能再从 finishOrder 的下标推。 */
    var places = {};
    for (var i = 0; i < 4; i++) {
      var pl = this.players[i].place;
      if (!pl) {
        var at = this.finishOrder.indexOf(i);
        pl = at >= 0 ? at + 1 : 4;
      }
      places[i] = pl;
    }

    var solo = (this.soloSeat === null || this.soloSeat === undefined) ? null : this.soloSeat;

    var n = 0, winSide = null, loseSide = null, kind = 'team', win = false;

    if (solo !== null) {
      kind = 'solo';
      win = (places[solo] === 1);
      n = this.soloTributeCount(places[solo]);
      var others = [0, 1, 2, 3].filter(function (s) { return s !== solo; });
      if (win) { winSide = [solo]; loseSide = others; }
      else { winSide = others; loseSide = [solo]; }
      if (n === 0) {
        // 独狼拿了第 3 名且已宣告：本轮不交换牌，下一局回到 ♣4 定首出
        return {
          kind: 'none', n: 0, total: 0, win: win, soloSeat: solo, declared: this.declared,
          gives: [], takes: [], sides: [],
          desc: this.p(solo).name + ' 是独狼，本局拿到第 ' + places[solo] + ' 名且已公布身份 ⇒ ' +
            '本轮所有玩家都不交换牌，下一局按初始规则：♣4 在谁手里谁先出'
        };
      }
    } else {
      var t0 = this.teams[0], t1 = this.teams[1];
      var winTeam = (places[t0[0]] === 1 || (t0[1] !== undefined && places[t0[1]] === 1)) ? t0 : t1;
      var loseTeam = (winTeam === t0) ? t1 : t0;
      var ps = winTeam.map(function (s) { return places[s]; }).sort(function (a, b) { return a - b; });
      if (ps[0] === 1 && ps[1] === 2) n = 2;
      else if (ps[0] === 1 && ps[1] === 3) n = 1;
      else n = 0;                       // 1、4 或 2、3 ⇒ 平局不进贡
      if (n === 0) {
        return {
          kind: 'none', n: 0, gives: [], takes: [], sides: [],
          desc: '队友名次 ' + ps.join('、') + '（1、4 或 2、3）视为平局，下一局不进贡，' +
            '开局看 ♣4 在谁手里谁先出'
        };
      }
      winSide = winTeam.slice().sort(function (a, b) { return places[a] - places[b]; });
      loseSide = loseTeam.slice().sort(function (a, b) { return places[a] - places[b]; });
    }

    var mL = loseSide.length, mW = winSide.length;
    var total = Math.max(mL, mW) * n;               // 交换总张数
    var giveLose = Math.round(total / mL);          // 输方每人交几张
    var giveWin = Math.round(total / mW);           // 赢方每人交几张

    var sides = [
      { idx: 0, role: 'lose', members: loseSide, mode: 'max', give: giveLose, take: giveLose },
      { idx: 1, role: 'win', members: winSide, mode: 'pick', give: giveWin, take: giveWin }
    ];

    var gives = [];
    [0, 1].forEach(function (si) {
      var s = sides[si];
      s.members.forEach(function (seat) {
        gives.push({ from: seat, side: si, count: s.give, mode: s.mode });
      });
    });

    var desc;
    if (kind === 'solo') {
      desc = this.p(solo).name + ' 独狼第 ' + places[solo] + ' 名' +
        (win ? '（独狼获胜）' : '（独狼落败）') +
        '，' + (this.declared ? '已公布身份' : '未公布身份') + '，每人 ' + n + ' 张：' +
        (win
          ? '另外 3 人各交出 ' + n + ' 张最大的牌（共 ' + total + ' 张）给 ' + this.p(solo).name + '；' +
            this.p(solo).name + ' 拿出 ' + total + ' 张不要的牌，另外 3 人按「交牌最大者先选」依次各挑 ' + n + ' 张'
          : this.p(solo).name + ' 交出 ' + total + ' 张最大的牌；另外 3 人按「交牌最大者先选」依次各挑 ' + n + ' 张，' +
            '并各还 ' + n + ' 张不要的牌') +
        '（♦3 / ♦A 永不交出；独狼局四张 3 也不交，不够才用 ♠3 ♥3 ♣3 补）';
    } else {
      desc = '输方各交出 ' + giveLose + ' 张最大的牌，赢方各拿出 ' + giveWin + ' 张不要的牌；' +
        '双方各自按「交出的最大单张」从大到小排序，依次从对方牌池里挑 ' + Math.max(giveLose, giveWin) + ' 张，' +
        '排在最后的自动拿剩下的牌（♦3 / ♦A 永不交出）';
    }

    return {
      kind: kind, n: n, total: total, win: win, soloSeat: solo, declared: this.declared,
      sides: sides, gives: gives, takes: [], desc: desc
    };
  };

  /* ---------------- 进贡执行（牌池） ---------------- */

  /** 进入进贡阶段：清空牌池，把「交牌」步骤排进队列 */
  Game.prototype.beginTribute = function (plan) {
    this.tribute = plan;
    this.phase = 'tribute';
    this.pools = [[], []];
    this.contrib = {};
    this._takeSteps = null;
    this.tributeQueue = (plan.gives || []).slice();
    this.tributeStep = null;
    return this;
  };

  /** 该座位要收的牌池（对方交出来的牌） */
  Game.prototype.poolOf = function (side) {
    return (this.pools && this.pools[1 - side]) ? this.pools[1 - side] : [];
  };

  /** 交牌：从手里拿走，放进本方的牌池 */
  Game.prototype.giveToPool = function (item, cards) {
    if (!cards || !cards.length) return;
    var ids = {};
    cards.forEach(function (c) { ids[c.id] = true; });
    var from = this.p(item.from);
    from.hand = from.hand.filter(function (c) { return !ids[c.id]; });
    this.pools = this.pools || [[], []];
    var si = (item.side === 1) ? 1 : 0;      // 老格式只有 from/to，默认放 0 号池
    this.pools[si] = this.pools[si].concat(cards.slice());
    var mx = cards[0];
    cards.forEach(function (c) { if (C.cardValue(c) > C.cardValue(mx)) mx = c; });
    this.contrib[item.from] = { cards: cards.slice(), max: mx };
    // 只有「交最大的牌」参与首出权判定
    if (item.mode === 'max') this.noteTribute(item, cards);
  };

  /** 收牌：从对方牌池里拿走，进自己手牌 */
  Game.prototype.takeFromPool = function (step, cards) {
    if (!cards || !cards.length) return;
    var ids = {};
    cards.forEach(function (c) { ids[c.id] = true; });
    var pool = this.pools[1 - step.side] || [];
    this.pools[1 - step.side] = pool.filter(function (c) { return !ids[c.id]; });
    var t = this.p(step.taker);
    t.hand = C.sortDesc(t.hand.concat(cards.slice()));
  };

  /** 某座位交出的最大单张的牌力值（用于排序选牌顺序） */
  Game.prototype.contribMax = function (seat) {
    var c = this.contrib && this.contrib[seat];
    return (c && c.max) ? C.cardValue(c.max) : -1;
  };

  /**
   * 交牌全部结束后，生成「收牌」步骤：
   * 每一方内部按「交出的最大单张」从大到小排，前几名自己挑，最后一名自动拿剩下的。
   */
  Game.prototype.buildTakeSteps = function () {
    var self = this;
    var plan = this.tribute;
    if (!plan) return [];
    var out = [];
    for (var si = 0; si < 2; si++) {
      var s = plan.sides[si];
      if (!s) continue;
      var members = s.members.slice().sort(function (a, b) {
        return self.contribMax(b) - self.contribMax(a);
      });
      for (var i = 0; i < members.length; i++) {
        out.push({
          kind: 'take',
          side: si,
          taker: members[i],
          count: s.take,
          auto: (i === members.length - 1) || members.length === 1,
          order: i + 1,
          of: members.length
        });
      }
    }
    return out;
  };

  /** 电脑/托管收牌：挑牌池里最大的几张 */
  Game.prototype.autoTake = function (step, count) {
    var pool = this.poolOf(step.side).slice().sort(function (a, b) { return C.cardValue(b) - C.cardValue(a); });
    return pool.slice(0, count);
  };

  /* ---------------- 记牌器 ---------------- */

  /** 每个点数在外面（不含自己手牌、不含已出牌）还剩几张 */
  Game.prototype.counter = function (seat) {
    var total = {}, mine = {}, out = {};
    C.RANKS.forEach(function (r) { total[r] = 4; mine[r] = 0; out[r] = 0; });
    this.players[seat].hand.forEach(function (c) { mine[c.rank]++; });
    this.played.forEach(function (c) { out[c.rank]++; });
    var res = [];
    C.RANKS.forEach(function (r, i) {
      res.push({
        rank: r,
        total: 4,
        mine: mine[r],
        played: out[r],
        remain: 4 - mine[r] - out[r]
      });
    });
    return res;
  };

  /** 生成给某个座位的视图（隐藏他人手牌），用于联机同步 */
  Game.prototype.view = function (seat) {
    var self = this;
    return {
      round: this.round,
      phase: this.phase,
      turn: this.turn,
      firstLeader: this.firstLeader,
      leaderReason: this.leaderReason,
      leaderCardText: this.leaderCardText,
      requireClub4Lead: !!this.requireClub4Lead,
      trick: this.trick ? { seat: this.trick.seat, type: this.trick.combo.type, cards: this.trick.combo.cards } : null,
      passed: this.passed,
      finishOrder: this.finishOrder,
      // 队友身份：♦A 与 ♦3 都出现后才下发；之前任何人（含客户端）都拿不到
      teamsRevealed: this.teamsRevealed,
      teams: this.teamKnownTo(seat) ? this.teams : null,
      soloSeat: this.teamKnownTo(seat) ? this.soloSeat : null,
      declared: this.teamKnownTo(seat) ? this.declared : false,
      soloCandidate: null,
      // v1.4.0：本局是不是独狼「直接下一局」跳过的（客户端据此提示"本局未开打"）
      giveUpSeat: (this.giveUpSeat === null || this.giveUpSeat === undefined) ? null : this.giveUpSeat,
      played: this.played,
      /* v1.3.8：四家「最近一次操作」，只带牌 id，客户端从 played 里还原牌面 */
      actions: (this.lastActions || []).map(function (a) {
        return a ? {
          seat: a.seat, type: a.type, seq: a.seq,
          ids: (a.cards || []).map(function (c) { return c.id; })
        } : null;
      }),
      tributeDesc: this.tribute ? this.tribute.desc : '',
      players: this.players.map(function (p) {
        return {
          seat: p.seat, name: p.name, avatar: p.avatar, isAI: p.isAI,
          count: p.hand.length, finished: p.finished, place: p.place,
          hand: p.seat === seat ? p.hand : null
        };
      })
    };
  };

  global.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
