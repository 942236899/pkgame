/* ============================================================
 * combos.js —— 牌型识别与大小比较
 *
 * 牌型：
 *   单张 single      1 张
 *   对子 pair        2 张同点   最小 44，最大 33（同点比花色，含方块者大）
 *   纯3张 triple     3 张同点   例 444
 *   顺子 straight    5 张连续   最小 34567，最大 10JQKA（2 不参与）
 *   3+2  fullhouse   三张 + 对子 最小 444XX，最大 333XX
 *   4+1  fours       四张 + 单张 最小 4444X，最大 3333X
 *   同花 flush       5 张同花色任意牌   例 ♣35789
 *   同花顺 sflush    5 张同花色且连续   最小 ♣34567，最大 ♦10JQKA
 *
 * 五张组合牌大小：同花顺 > 四带一 > 三带二 > 同花 > 顺子
 *
 * v1.3.6 修正：纯3张比所有五张组合牌都小，
 *   即 4带1 > 3带2 > 顺子 > 纯3张 ⇒ 999 可以被 33344（三带二）、KQQQQ（四带一）打到。
 * ============================================================ */
(function (global) {
  'use strict';

  var C = global.Cards ||
    (typeof module !== 'undefined' && module.exports ? require('./cards.js') : null);

  var TYPE = {
    SINGLE: 'single',
    PAIR: 'pair',
    TRIPLE: 'triple',
    STRAIGHT: 'straight',
    FULLHOUSE: 'fullhouse',
    FOURS: 'fours',
    FLUSH: 'flush',
    SFLUSH: 'sflush'
  };

  var TYPE_LABEL = {
    single: '单张',
    pair: '对子',
    triple: '纯3张',
    straight: '顺子',
    fullhouse: '三带二',
    fours: '四带一',
    flush: '同花',
    sflush: '同花顺'
  };

  /* 五张组合牌的类别权重（越大越强）：同花顺 > 四带一 > 三带二 > 同花 > 顺子
   * 纯3张也纳入这条链，权重 0 —— 比任何五张组合牌都小（v1.3.6 用户确认）。 */
  var FIVE_ORDER = { sflush: 5, fours: 4, fullhouse: 3, flush: 2, straight: 1, triple: 0 };

  /**
   * 严格同类型压制：
   *   单牌只能用单牌打、对子只能用对子打、5 张组合只能用 5 张组合打，
   *   直到该牌型的最大牌出现、无人能压为止。
   * STRICT_TYPE = true 时，5 张组合牌**不能**压纯3张（旧行为，已被确认是错的）；
   * 默认 false ⇒ 4带1 / 3带2 / 顺子 / 同花 / 同花顺 都能压纯3张。
   */
  var STRICT_TYPE = false;

  /**
   * 同花 / 同花顺 比大小的方式
   *   false（默认）：先比牌面——从最大的一张开始逐张比（同点再比花色）
   *   true        ：先比花色（♦ > ♠ > ♥ > ♣），花色相同再比牌面
   */
  var FLUSH_BY_SUIT = false;

  function isFiveCard(type) {
    return type === TYPE.STRAIGHT || type === TYPE.FULLHOUSE || type === TYPE.FOURS ||
      type === TYPE.FLUSH || type === TYPE.SFLUSH;
  }

  /** 5 张是否同一花色 */
  function isSameSuit(cards) {
    for (var i = 1; i < cards.length; i++) {
      if (cards[i].suit !== cards[0].suit) return false;
    }
    return true;
  }

  /** 返回一组牌的点数值数组（从大到小） */
  function valuesDesc(cards) {
    return cards.map(function (c) { return C.cardValue(c); })
      .sort(function (a, b) { return b - a; });
  }

  function groupByRank(cards) {
    var map = {};
    cards.forEach(function (c) {
      (map[c.rank] = map[c.rank] || []).push(c);
    });
    return map;
  }

  function maxCard(cards) {
    var m = cards[0];
    for (var i = 1; i < cards.length; i++) {
      if (C.cardValue(cards[i]) > C.cardValue(m)) m = cards[i];
    }
    return m;
  }

  /** 顺子判定（只接受 5 张） */
  function detectStraight(cards) {
    if (cards.length !== 5) return null;
    var idxs = [];
    for (var i = 0; i < cards.length; i++) {
      var v = C.STRAIGHT_IDX[cards[i].rank];
      if (v === undefined) return null; // 2 不能进顺子
      idxs.push(v);
    }
    idxs.sort(function (a, b) { return a - b; });
    for (var j = 1; j < idxs.length; j++) {
      if (idxs[j] !== idxs[j - 1] + 1) return null; // 不连续 或 有重复
    }
    // 主牌 = 顺子中最大的那张（按 straight 序列）
    var topIdx = idxs[idxs.length - 1];
    var topRank = C.STRAIGHT_SEQ[topIdx];
    var tops = cards.filter(function (c) { return c.rank === topRank; });
    return { type: TYPE.STRAIGHT, main: maxCard(tops), cards: cards.slice() };
  }

  /**
   * 识别一组牌的牌型，非法返回 null
   * @param {Array} cards
   * @returns {{type,main,cards}|null}
   */
  function detect(cards) {
    if (!cards || !cards.length) return null;
    var n = cards.length;

    if (n === 1) {
      return { type: TYPE.SINGLE, main: cards[0], cards: cards.slice() };
    }

    if (n === 2) {
      if (cards[0].rank !== cards[1].rank) return null;
      return { type: TYPE.PAIR, main: maxCard(cards), cards: cards.slice() };
    }

    if (n === 3) {
      if (!(cards[0].rank === cards[1].rank && cards[1].rank === cards[2].rank)) return null;
      return { type: TYPE.TRIPLE, main: maxCard(cards), cards: cards.slice() };
    }

    if (n === 5) {
      var groups = groupByRank(cards);
      var keys = Object.keys(groups);
      var sizes = keys.map(function (k) { return groups[k].length; }).sort(function (a, b) { return b - a; });
      var flush = isSameSuit(cards);
      var st = flush || sizes.length === 5 ? detectStraight(cards) : null;

      // 同花顺：同花色 + 连续（优先级最高）
      if (flush && st) {
        return { type: TYPE.SFLUSH, main: st.main, cards: cards.slice() };
      }
      if (sizes[0] === 4 && sizes.length === 2) {
        // 四张 + 任意单张
        var fourRank = keys.filter(function (k) { return groups[k].length === 4; })[0];
        return { type: TYPE.FOURS, main: maxCard(groups[fourRank]), cards: cards.slice() };
      }
      if (sizes[0] === 3 && sizes[1] === 2) {
        // 三张 + 对子
        var threeRank = keys.filter(function (k) { return groups[k].length === 3; })[0];
        return { type: TYPE.FULLHOUSE, main: maxCard(groups[threeRank]), cards: cards.slice() };
      }
      // 同花：5 张同花色，点数任意
      if (flush) {
        return { type: TYPE.FLUSH, main: maxCard(cards), cards: cards.slice() };
      }
      // 顺子：连续但不同花色
      if (st) return st;
      return null;
    }
    return null;
  }

  /**
   * 同花（含同花顺）内部的比较：a 是否大于 b
   * 默认：先逐张比点数（从大到小），点数完全一样才比花色
   * FLUSH_BY_SUIT：先比花色，再逐张比点数
   */
  function cmpFlush(a, b) {
    if (FLUSH_BY_SUIT && a.cards[0].suitIdx !== b.cards[0].suitIdx) {
      return a.cards[0].suitIdx > b.cards[0].suitIdx;
    }
    var ra = a.cards.map(function (c) { return c.rankIdx; }).sort(function (x, y) { return y - x; });
    var rb = b.cards.map(function (c) { return c.rankIdx; }).sort(function (x, y) { return y - x; });
    for (var i = 0; i < ra.length && i < rb.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] > rb[i];
    }
    // 点数序列完全相同（实战中不会出现，同一种花色的 5 张牌唯一）→ 以花色兜底
    return a.cards[0].suitIdx > b.cards[0].suitIdx;
  }

  /** 同牌型之间的大小比较 */
  function sameTypeBeat(play, target) {
    if (play.type === TYPE.FLUSH || play.type === TYPE.SFLUSH) return cmpFlush(play, target);
    return C.cardValue(play.main) > C.cardValue(target.main);
  }

  /**
   * play 能否压过 target
   * @param {object} play   待出的牌型
   * @param {object|null} target 桌面上当前的牌型（null 表示自由出牌）
   */
  function canBeat(play, target) {
    if (!play) return false;
    if (!target) return true;
    if (play.type === target.type) return sameTypeBeat(play, target);
    var p5 = isFiveCard(play.type);
    var t5 = isFiveCard(target.type);
    // 五张组合牌之间：同花顺 > 四带一 > 三带二 > 同花 > 顺子（不看点数）
    if (p5 && t5) return FIVE_ORDER[play.type] > FIVE_ORDER[target.type];
    // 纯3张比任何五张组合牌都小：4带1 / 3带2 / 顺子 / 同花 / 同花顺 都能压它
    // （STRICT_TYPE = true 是旧行为，保留为可选项）
    if (p5 && target.type === TYPE.TRIPLE) return !STRICT_TYPE;
    // 纯3张反过来压不了五张组合牌
    if (play.type === TYPE.TRIPLE && t5) return false;
    return false;
  }

  function setStrictType(v) { STRICT_TYPE = !!v; }
  function isStrictType() { return STRICT_TYPE; }
  function setFlushBySuit(v) { FLUSH_BY_SUIT = !!v; }
  function isFlushBySuit() { return FLUSH_BY_SUIT; }

  /** 枚举手牌中所有合法牌型 */
  function allCombos(hand) {
    var list = [];
    var n = hand.length;

    // 单张
    for (var i = 0; i < n; i++) list.push({ type: TYPE.SINGLE, main: hand[i], cards: [hand[i]] });

    // 对子 / 三张
    var byRank = groupByRank(hand);
    Object.keys(byRank).forEach(function (r) {
      var g = byRank[r];
      if (g.length >= 2) {
        for (var a = 0; a < g.length; a++) {
          for (var b = a + 1; b < g.length; b++) {
            list.push({ type: TYPE.PAIR, main: maxCard([g[a], g[b]]), cards: [g[a], g[b]] });
          }
        }
      }
      if (g.length >= 3) {
        for (var x = 0; x < g.length; x++) {
          for (var y = x + 1; y < g.length; y++) {
            for (var z = y + 1; z < g.length; z++) {
              list.push({ type: TYPE.TRIPLE, main: maxCard([g[x], g[y], g[z]]), cards: [g[x], g[y], g[z]] });
            }
          }
        }
      }
    });

    // 五张：C(n,5) 最多 1287 种，完全可接受
    var idx = [];
    for (var k = 0; k < n; k++) idx.push(k);
    combos5(idx, function (combo) {
      var cards = combo.map(function (i) { return hand[i]; });
      var c = detect(cards);
      if (c && isFiveCard(c.type)) list.push(c);
    });

    return list;
  }

  function combos5(arr, cb) {
    var n = arr.length;
    for (var a = 0; a < n - 4; a++)
      for (var b = a + 1; b < n - 3; b++)
        for (var c = b + 1; c < n - 2; c++)
          for (var d = c + 1; d < n - 1; d++)
            for (var e = d + 1; e < n; e++)
              cb([arr[a], arr[b], arr[c], arr[d], arr[e]]);
  }

  /**
   * 列出当前可出的所有合法选项
   * @param {Array} hand
   * @param {object|null} target 桌面牌型
   * @param {boolean} allowTriple 是否允许出纯3张（受特殊规则限制）
   */
  function playableOptions(hand, target, allowTriple) {
    var all = allCombos(hand);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (c.type === TYPE.TRIPLE && !allowTriple) continue;
      if (!target) { out.push(c); continue; }
      if (canBeat(c, target)) out.push(c);
    }
    // 排序：优先张数少的，其次小的（同为 5 张组合时先按牌型强弱，再按牌面）
    out.sort(function (a, b) {
      if (a.cards.length !== b.cards.length) return a.cards.length - b.cards.length;
      if (a.cards.length === 5) {
        var oa = FIVE_ORDER[a.type] || 0, ob = FIVE_ORDER[b.type] || 0;
        if (oa !== ob) return oa - ob;
        if (a.type === TYPE.FLUSH || a.type === TYPE.SFLUSH) {
          var va = valuesDesc(a.cards), vb = valuesDesc(b.cards);
          for (var i = 0; i < va.length; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
          return 0;
        }
      }
      return C.cardValue(a.main) - C.cardValue(b.main);
    });
    return out;
  }

  /** 玩家手牌中"最小的能压过 target 的一手"，没有则返回 null */
  function smallestBeat(hand, target, allowTriple) {
    var opts = playableOptions(hand, target, allowTriple);
    return opts.length ? opts[0] : null;
  }

  /* ---------------- 智能提示（v1.3.6） ----------------
   * 旧逻辑只会挑"最小的能压过的牌"，结果经常把好好的对子 / 三张 / 四张拆掉。
   * 现在先算「拆牌代价」，优先推荐不破坏手上成型牌型的一手：
   *   · 出单张 → 避开手上成对 / 成三 / 成四的点数
   *   · 出对子 → 避开成三 / 成四的点数
   *   · 出三带二 → 三张尽量取整三张，对子尽量取整对子
   *   · 出四带一 → 四张取整四张，单张尽量取孤张
   * 代价相同时，再按"牌面越小越好"排序。
   */

  /** 打出手牌里的点数分布 */
  function rankCounts(hand) {
    var m = {};
    hand.forEach(function (c) { m[c.rank] = (m[c.rank] || 0) + 1; });
    return m;
  }

  /** 打出 combo 会拆散手上多少成型牌型（0 = 完全不拆） */
  function breakCost(hand, combo) {
    var have = rankCounts(hand);
    var use = {};
    combo.cards.forEach(function (c) { use[c.rank] = (use[c.rank] || 0) + 1; });
    var cost = 0;
    Object.keys(use).forEach(function (r) {
      var h = have[r] || 0, t = use[r];
      if (h <= t) return;                       // 整组打出去，不算拆
      var w = h >= 4 ? 400 : (h === 3 ? 200 : 90);
      cost += w + (h - t) * 8;
    });
    return cost;
  }

  /**
   * 智能提示：返回按「拆牌代价 → 牌面大小」排序的候选列表
   * @returns {Array} 空数组表示没有能压过的牌
   */
  function hintOptions(hand, target, allowTriple) {
    var opts = playableOptions(hand, target, allowTriple);
    if (!opts.length) return [];
    var scored = opts.map(function (o, i) {
      return { o: o, i: i, b: breakCost(hand, o) };
    });
    scored.sort(function (a, b) {
      if (a.b !== b.b) return a.b - b.b;        // 先不拆牌
      return a.i - b.i;                         // 再沿用"张数少、牌面小"的原有顺序
    });
    return scored.map(function (s) { return s.o; });
  }

  /** 智能提示里最值得出的那一手 */
  function smartHint(hand, target, allowTriple) {
    var list = hintOptions(hand, target, allowTriple);
    return list.length ? list[0] : null;
  }

  function comboText(combo) {
    if (!combo) return '';
    return combo.cards.map(C.cardText).join(' ');
  }

  function comboName(combo) {
    if (!combo) return '';
    return TYPE_LABEL[combo.type] || combo.type;
  }

  global.Combos = {
    TYPE: TYPE,
    TYPE_LABEL: TYPE_LABEL,
    isFiveCard: isFiveCard,
    detect: detect,
    canBeat: canBeat,
    allCombos: allCombos,
    playableOptions: playableOptions,
    smallestBeat: smallestBeat,
    rankCounts: rankCounts,
    breakCost: breakCost,
    hintOptions: hintOptions,
    smartHint: smartHint,
    maxCard: maxCard,
    groupByRank: groupByRank,
    setStrictType: setStrictType,
    isStrictType: isStrictType,
    setFlushBySuit: setFlushBySuit,
    isFlushBySuit: isFlushBySuit,
    isSameSuit: isSameSuit,
    comboText: comboText,
    comboName: comboName
  };
})(typeof window !== 'undefined' ? window : globalThis);

// 同时支持 Node（服务端）require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Combos;
}
