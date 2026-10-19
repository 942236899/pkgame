/* ============================================================
 * ai.js —— 电脑玩家（NPC）决策
 * 座位 0 为人类，1/2/3 为 NPC（联机模式下按 isAI 判断）
 * ============================================================ */
(function (global) {
  'use strict';

  var C = global.Cards;
  var K = global.Combos;
  var T = K.TYPE;

  // 大牌阈值：主牌点数 >= 该索引视为大牌（A=10, 2=11, 3=12）
  var BIG_RANK = 9; // K 及以上算大牌

  function isBigCard(c) { return c.rankIdx >= BIG_RANK; }

  /** 局面信息：还有几人未出完、对手最少手牌数 */
  function situation(game, seat) {
    var minOpp = 99, alive = 0;
    for (var i = 0; i < 4; i++) {
      if (i === seat) continue;
      if (game.players[i].finished) continue;
      alive++;
      if (game.players[i].hand.length < minOpp) minOpp = game.players[i].hand.length;
    }
    return { alive: alive, minOpp: minOpp };
  }

  /** 一手牌的"代价"：越小越优先出（尽量留大牌、尽量多出张数） */
  function cost(combo) {
    var base = C.cardValue(combo.main);
    if (combo.type === T.SFLUSH) base += 340;     // 同花顺最珍贵
    if (combo.type === T.FOURS) base += 260;      // 四带一很珍贵，尽量留
    if (combo.type === T.FULLHOUSE) base += 130;
    if (combo.type === T.FLUSH) base += 90;
    if (combo.type === T.STRAIGHT) base += 40;
    return base - combo.cards.length * 6;
  }

  /** 是否值得为了压牌而拆掉这手 */
  function worthBeat(game, seat, combo, sit) {
    var need = combo.cards.length;
    // 手牌很少时不惜代价
    if (game.players[seat].hand.length <= 4) return true;
    // 对手快出完了，必须拦
    if (sit.minOpp <= 2) return true;
    // 用同花顺/四带一去压小牌，太浪费
    if ((combo.type === T.FOURS || combo.type === T.SFLUSH) && game.trick &&
      game.trick.combo.type !== combo.type) {
      if (game.trick.combo.cards.length <= 2 && Math.random() < 0.85) return false;
    }
    if ((combo.type === T.FULLHOUSE || combo.type === T.FLUSH) && game.trick &&
      (game.trick.combo.type === T.SINGLE || game.trick.combo.type === T.PAIR)) {
      if (Math.random() < 0.8) return false;
    }
    // 用大牌（3/2/A）压小牌，看情况
    if (isBigCard(combo.main) && game.trick) {
      var t = game.trick.combo;
      if (t.cards.length <= 2 && !isBigCard(t.main)) {
        return Math.random() < 0.35;
      }
    }
    return true;
  }

  /**
   * AI 决策
   * @returns {null|{type:'play'|'pass', cards:Array}}
   */
  function decide(game, seat) {
    if (game.phase !== 'playing' || game.turn !== seat) return null;
    var hand = game.players[seat].hand;
    var sit = situation(game, seat);
    var opts = game.options(seat);
    if (!opts.length) return { type: 'pass' };

    var i, c;

    /* ---------- 跟牌 ---------- */
    if (game.trick) {
      var leader = game.trick.seat;
      var myTeam = game.teamOf(seat);
      // 队友领出则不压（独狼模式下三名非独狼玩家互为队友）
      // 但只在该座位"确实知道"队友是谁时才避让——♦A / ♦3 没都露面之前，大家都是敌友未明
      if (game.teamKnownTo(seat) && myTeam >= 0 && myTeam === game.teamOf(leader)) {
        return { type: 'pass' };
      }
      // 能一把出完就直接出
      for (i = 0; i < opts.length; i++) {
        if (opts[i].cards.length === hand.length) return { type: 'play', cards: opts[i].cards };
      }
      // 找一个值得压的最小牌
      var sorted = opts.slice().sort(function (a, b) { return cost(a) - cost(b); });
      for (i = 0; i < sorted.length; i++) {
        c = sorted[i];
        if (worthBeat(game, seat, c, sit)) return { type: 'play', cards: c.cards };
      }
      return { type: 'pass' };
    }

    /* ---------- 自由出牌 ---------- */
    // 1) 能一把出完
    for (i = 0; i < opts.length; i++) {
      if (opts[i].cards.length === hand.length) return { type: 'play', cards: opts[i].cards };
    }

    // 2) 中局以后，若手里有 ♦A 且队伍还没确定，可以打出以明确队友
    var midGame = hand.length <= 8;
    if (midGame && !game.teams) {
      for (i = 0; i < hand.length; i++) {
        if (C.isDiamondA(hand[i])) {
          var single = { type: T.SINGLE, main: hand[i], cards: [hand[i]] };
          if (K.canBeat(single, null)) {
            // 不总是打，给点随机
            if (Math.random() < 0.5) return { type: 'play', cards: [hand[i]] };
          }
        }
      }
    }

    // 3) 优先出张数多的小牌型（消耗手牌），再出小单张
    var lead = opts.slice().sort(function (a, b) {
      var ca = cost(a), cb = cost(b);
      if (Math.abs(ca - cb) < 12) {
        // 代价接近时优先张数多的
        return b.cards.length - a.cards.length;
      }
      return ca - cb;
    });

    // 出牌：不要把 ♦A 当普通小牌随手打掉（除非上面已决定）
    for (i = 0; i < lead.length; i++) {
      c = lead[i];
      var hasDA = c.cards.some(C.isDiamondA);
      if (hasDA && hand.length > 6 && Math.random() < 0.7) continue;
      // 开局首出时，如果手牌 >3 张，别把大牌（3/2）拆着出
      if (c.type === T.SINGLE && isBigCard(c.main) && hand.length > 4) continue;
      return { type: 'play', cards: c.cards };
    }
    // 兜底出最小的
    return { type: 'play', cards: lead[0].cards };
  }

  /** 进贡：交出牌（交最大时避开 4 张 3 和 ♦A，还贡时也不碰 ♦3 / ♦A） */
  function tributePick(hand, count, mode) {
    if (mode === 'max') return C.tributeMax(hand, count);
    // 还贡：给最小、最没用的牌，但 ♦3 / ♦A 一律留着
    var pool = hand.filter(function (c) { return C.canReturn(c); });
    pool.sort(function (a, b) { return C.cardValue(a) - C.cardValue(b); });
    return pool.slice(0, count);
  }

  /** 独狼宣告决策：牌够强就宣告（进贡 3 张，赢得更多） */
  function decideDeclare(hand) {
    var score = 0;
    hand.forEach(function (c) {
      score += c.rankIdx;                    // 基础牌力
      if (c.rank === '2' || c.rank === '3') score += 6;
      if (c.rank === 'A') score += 3;
    });
    var groups = K.groupByRank(hand);
    Object.keys(groups).forEach(function (r) {
      if (groups[r].length >= 4) score += 14;
      else if (groups[r].length === 3) score += 6;
      else if (groups[r].length === 2) score += 2;
    });
    // 同花 / 同花顺潜力
    var bySuit = {};
    hand.forEach(function (c) { bySuit[c.suit] = (bySuit[c.suit] || 0) + 1; });
    Object.keys(bySuit).forEach(function (s) {
      if (bySuit[s] >= 5) score += 12;
      else if (bySuit[s] === 4) score += 4;
    });
    return score >= 118;
  }

  global.AI = {
    decide: decide,
    tributePick: tributePick,
    decideDeclare: decideDeclare
  };
})(typeof window !== 'undefined' ? window : globalThis);
