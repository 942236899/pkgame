/* ============================================================
 * engine.js —— 找队友扑克 游戏流程引擎（纯状态机，不含 AI 与 UI）
 * 座位约定：0=我(下)  1=右家  2=对家(上)  3=左家
 * 出牌顺序：0 → 1 → 2 → 3 → 0
 * ============================================================ */
(function (global) {
  'use strict';

  var C = global.Cards;
  var K = global.Combos;

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
    this.firstLeader = 0;          // 本局首出座位
    this.tribute = null;           // 本轮结算出的进贡任务
    this.tributeQueue = [];        // 待处理进贡项
    this.tributeStep = null;       // 当前等待处理的进贡项
    this.lastAction = null;        // { seat, type:'play'|'pass', combo }
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
    this.teamsRevealed = false;    // 只有 ♦A 与 ♦3 都打出来了才公开
    this.tribute = null;
    this.tributeQueue = [];
    this.tributeStep = null;
    this.lastAction = null;
    this._history = [];

    // 首出：抽签决定（规则：首出无硬性规定，抽签随机定）
    var leader = Math.floor(Math.random() * 4);
    this.firstLeader = leader;
    this.turn = leader;

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
  };

  /* ---------------- 出牌合法性 ---------------- */

  /**
   * 是否允许该座位此刻打出「纯3张」
   * 规则（用户确认）：只有两种情况能出——
   *   1) 游戏刚开始，第一名出牌的玩家手上有纯3张；
   *   2) 一轮中其余 3 人都过牌，轮到自己重新领出时手上有纯3张。
   * ⇒ 等价于：只要当前是「领出」（桌面没有待压的牌型）就可以出。
   */
  Game.prototype.allowTriple = function (seat) {
    return this.trick === null && this.turn === seat;
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
    if (combo.type === K.TYPE.TRIPLE && !this.allowTriple(seat)) {
      return { ok: false, msg: '纯3张只能在领出时打出（开局首出，或其余人都过牌后你重新出牌）' };
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
    return K.playableOptions(this.p(seat).hand, target, this.allowTriple(seat));
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

  /**
   * 公开时机（用户确认的规则）：
   *   · 只打出了一张（♦A 或 ♦3），另一张还没露面 ⇒ 系统不标记任何队友信息；
   *   · 两张都打出来了，且由不同人打出 ⇒ 标明这两人是队友（另两人自动另一队）；
   *   · 两张都由同一个人打出 ⇒ 标明另外 3 人是队友（他 1 打 3）。
   */
  Game.prototype._updateReveal = function () {
    if (this.teamsRevealed) return;
    if (!this.diamondAPlayed() || !this.diamond3Played()) return;
    this.teamsRevealed = true;
    this.emit('teams', { teams: this.teams, soloSeat: this.soloSeat, revealed: true });
  };

  /** 该座位此刻是否"知道"分队情况（决定 UI 是否标注、AI 是否避让队友） */
  Game.prototype.teamKnownTo = function (seat) {
    if (!this.teams) return false;
    if (this.teamsRevealed) return true;
    // 独狼自己拿着 ♦A + ♦3，当然心里有数
    if (this.soloSeat !== null && this.soloSeat === seat) return true;
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

  /* ---------------- 结束判定 ---------------- */

  Game.prototype._checkOver = function () {
    var n = this.finishOrder.length;
    var early = false;
    // 提前结束情形
    if (n >= 3) early = true;
    if (n >= 2) {
      var a = this.finishOrder[0], b = this.finishOrder[1];
      if (this.soloSeat !== null && a === this.soloSeat) early = true;
      if (this.teams && this._sameTeam(a, b)) early = true;
    }
    if (!early) return false;

    // 补齐名次
    for (var i = 0; i < 4; i++) {
      var p = this.players[i];
      if (!p.place) {
        p.finished = true;
        p.place = this.finishOrder.length + 1;
        this.finishOrder.push(i);
      }
    }
    this._ensureTeams();
    this.phase = 'over';
    this.tribute = this.computeTribute();
    this.emit('over', { finishOrder: this.finishOrder.slice(), teams: this.teams, tribute: this.tribute });
    return true;
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

  /**
   * 计算下一局的进贡任务
   * @returns {{kind:'none'|'team'|'solo', n:number, desc:string, gives:[{from,to,count,mode}]}}
   */
  Game.prototype.computeTribute = function () {
    var places = {};
    for (var i = 0; i < this.finishOrder.length; i++) places[this.finishOrder[i]] = i + 1;

    var solo = this.soloSeat;
    if (solo !== null && solo !== undefined) {
      var soloPlace = places[solo] || 4;
      var win = soloPlace === 1;
      var n = this.declared ? 3 : 2;
      var others = [0, 1, 2, 3].filter(function (s) { return s !== solo; });
      var gives = [];
      if (win) {
        others.forEach(function (s) {
          gives.push({ from: s, to: solo, count: n, mode: 'max' });
          gives.push({ from: solo, to: s, count: n, mode: 'pick' });
        });
      } else {
        others.forEach(function (s) {
          gives.push({ from: solo, to: s, count: n, mode: 'max' });
          gives.push({ from: s, to: solo, count: n, mode: 'pick' });
        });
      }
      return {
        kind: 'solo',
        n: n,
        win: win,
        soloSeat: solo,
        declared: this.declared,
        gives: gives,
        desc: (this.p(solo).name) + (win ? ' 独狼获胜' : ' 独狼失败') + '：' +
          (win ? '另外 3 人各进贡 ' + n + ' 张最大的牌' : '独狼向另外 3 人各进贡 ' + n + ' 张最大的牌')
      };
    }

    // 有队友：找含第 1 名的那一队
    var t0 = this.teams[0], t1 = this.teams[1];
    var winTeam = (places[t0[0]] === 1 || (t0[1] !== undefined && places[t0[1]] === 1)) ? t0 : t1;
    var loseTeam = winTeam === t0 ? t1 : t0;
    var ps = winTeam.map(function (s) { return places[s]; }).sort(function (a, b) { return a - b; });
    var n2 = 0;
    if (ps[0] === 1 && ps[1] === 2) n2 = 2;
    else if (ps[0] === 1 && ps[1] === 3) n2 = 1;
    else n2 = 0; // 1,4 或 2,3 平局

    if (n2 === 0) {
      return { kind: 'none', n: 0, gives: [], desc: '平局，下一局无需进贡' };
    }
    var winners = winTeam.slice().sort(function (a, b) { return places[a] - places[b]; });
    var losers = loseTeam.slice().sort(function (a, b) { return places[b] - places[a]; });
    var gives = [];
    for (var k = 0; k < losers.length; k++) {
      var from = losers[k], to = winners[k];
      if (from === undefined || to === undefined) continue;
      gives.push({ from: from, to: to, count: n2, mode: 'max' });
      gives.push({ from: to, to: from, count: n2, mode: 'pick' });
    }
    return {
      kind: 'team',
      n: n2,
      gives: gives,
      desc: '队友名次 ' + ps.join('、') + '，输方各进贡 ' + n2 + ' 张最大的牌'
    };
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
      trick: this.trick ? { seat: this.trick.seat, type: this.trick.combo.type, cards: this.trick.combo.cards } : null,
      passed: this.passed,
      finishOrder: this.finishOrder,
      // 队友身份：♦A 与 ♦3 都出现后才下发；之前任何人（含客户端）都拿不到
      teamsRevealed: this.teamsRevealed,
      teams: this.teamKnownTo(seat) ? this.teams : null,
      soloSeat: this.teamKnownTo(seat) ? this.soloSeat : null,
      declared: this.teamKnownTo(seat) ? this.declared : false,
      soloCandidate: null,
      played: this.played,
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
