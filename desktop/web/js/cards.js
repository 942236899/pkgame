/* ============================================================
 * cards.js —— 牌的基础定义、洗牌、发牌
 * 规则依据《找队友扑克游戏规则》
 *   点数从小到大：4,5,6,7,8,9,10,J,Q,K,A,2,3
 *   花色从大到小：方块 ♦ > 葵扇(黑桃) ♠ > 红桃 ♥ > 梅花 ♣
 *   一副牌去掉大小王，共 52 张
 * ============================================================ */
(function (global) {
  'use strict';

  // 点数顺序（索引越大越大）
  var RANKS = ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '3'];
  var RANK_IDX = {};
  RANKS.forEach(function (r, i) { RANK_IDX[r] = i; });

  // 花色（suitIdx 越大越大）
  var SUITS = [
    { key: 'C', sym: '♣', name: '梅花', idx: 0, red: false },
    { key: 'H', sym: '♥', name: '红桃', idx: 1, red: true },
    { key: 'S', sym: '♠', name: '葵扇', idx: 2, red: false },
    { key: 'D', sym: '♦', name: '方块', idx: 3, red: true }
  ];
  var SUIT_MAP = {};
  SUITS.forEach(function (s) { SUIT_MAP[s.key] = s; });

  // 顺子专用序列：3,4,5,6,7,8,9,10,J,Q,K,A（2 不参与顺子）
  var STRAIGHT_SEQ = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  var STRAIGHT_IDX = {};
  STRAIGHT_SEQ.forEach(function (r, i) { STRAIGHT_IDX[r] = i; });

  function makeDeck() {
    var deck = [];
    for (var i = 0; i < RANKS.length; i++) {
      for (var j = 0; j < SUITS.length; j++) {
        var r = RANKS[i], s = SUITS[j];
        deck.push({
          id: r + s.key,
          rank: r,
          rankIdx: i,
          suit: s.key,
          suitIdx: s.idx,
          sym: s.sym,
          suitName: s.name,
          red: s.red,
          label: s.sym + r
        });
      }
    }
    return deck;
  }

  /** 单牌绝对大小：先比点数，再比花色（方块最大） */
  function cardValue(c) {
    return c.rankIdx * 4 + c.suitIdx;
  }

  function cardText(c) {
    return SUIT_MAP[c.suit].sym + c.rank;
  }

  function cardLongText(c) {
    return SUIT_MAP[c.suit].name + c.rank;
  }

  /** 手牌排序：从大到小（左边最大，符合大多数人看牌习惯） */
  function sortDesc(hand) {
    return hand.slice().sort(function (a, b) { return cardValue(b) - cardValue(a); });
  }

  /** 手牌排序：从小到大 */
  function sortAsc(hand) {
    return hand.slice().sort(function (a, b) { return cardValue(a) - cardValue(b); });
  }

  function isDiamondA(c) { return c.rank === 'A' && c.suit === 'D'; }
  function isDiamond3(c) { return c.rank === '3' && c.suit === 'D'; }

  /* ---------- 洗牌：模拟真人手工洗牌（多次鸽尾式交叠 + 切牌） ---------- */

  /** 一次鸽尾式（riffle）洗牌：两叠交替落下，偶尔成簇落下，模拟手工不完美 */
  function riffleShuffle(deck) {
    var cut = Math.floor(deck.length / 2);
    // 手工洗牌不会刚好对半，加入 ±3 张的抖动
    cut += Math.floor(Math.random() * 7) - 3;
    if (cut < 4) cut = 4;
    if (cut > deck.length - 4) cut = deck.length - 4;

    var left = deck.slice(0, cut);
    var right = deck.slice(cut);
    var out = [];
    var i = 0, j = 0;
    while (i < left.length || j < right.length) {
      var leftRemain = left.length - i;
      var rightRemain = right.length - j;
      var goLeft;
      if (leftRemain === 0) goLeft = false;
      else if (rightRemain === 0) goLeft = true;
      else goLeft = Math.random() < leftRemain / (leftRemain + rightRemain);

      // 30% 概率一次落 2~3 张（成簇），模拟真实洗牌
      var chunk = 1;
      if (Math.random() < 0.3) chunk = Math.random() < 0.7 ? 2 : 3;

      for (var k = 0; k < chunk; k++) {
        if (goLeft) {
          if (i < left.length) out.push(left[i++]); else break;
        } else {
          if (j < right.length) out.push(right[j++]); else break;
        }
      }
    }
    return out;
  }

  /** 切牌 */
  function cutDeck(deck) {
    var n = deck.length;
    var at = Math.floor(Math.random() * (n - 6)) + 3;
    return deck.slice(at).concat(deck.slice(0, at));
  }

  /**
   * 完整洗牌流程：摊洗 + 多次鸽尾洗 + 切牌
   * @param {number} times 鸽尾洗牌次数，默认 7 次
   */
  function humanShuffle(deck, times) {
    var d = deck.slice();
    times = times || 7;
    for (var t = 0; t < times; t++) {
      d = riffleShuffle(d);
      if (t % 3 === 2) d = cutDeck(d);
    }
    d = cutDeck(d);
    return d;
  }

  /** 发牌：4 人，每人 13 张（返回 4 份已排序的手牌） */
  function deal(playerCount, shuffleTimes) {
    var deck = humanShuffle(makeDeck(), shuffleTimes);
    var hands = [];
    for (var i = 0; i < (playerCount || 4); i++) hands.push([]);
    // 逐张轮转发牌（真实发牌方式）
    var idx = 0;
    while (idx < deck.length) {
      for (var p = 0; p < hands.length && idx < deck.length; p++) {
        hands[p].push(deck[idx++]);
      }
    }
    return hands.map(sortDesc);
  }

  global.Cards = {
    RANKS: RANKS,
    RANK_IDX: RANK_IDX,
    SUITS: SUITS,
    SUIT_MAP: SUIT_MAP,
    STRAIGHT_SEQ: STRAIGHT_SEQ,
    STRAIGHT_IDX: STRAIGHT_IDX,
    makeDeck: makeDeck,
    cardValue: cardValue,
    cardText: cardText,
    cardLongText: cardLongText,
    sortDesc: sortDesc,
    sortAsc: sortAsc,
    isDiamondA: isDiamondA,
    isDiamond3: isDiamond3,
    humanShuffle: humanShuffle,
    deal: deal
  };
})(typeof window !== 'undefined' ? window : globalThis);

// 同时支持 Node（服务端）require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Cards;
}
