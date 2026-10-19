/* 规则引擎自测（Node 环境）：node test.js */
require('./js/cards.js');
require('./js/combos.js');
require('./js/engine.js');
require('./js/engine_ai.js');

var C = globalThis.Cards, K = globalThis.Combos, AI = globalThis.AI;
var ok = 0, fail = 0;
function T(name, cond) {
  if (cond) { ok++; }
  else { fail++; console.log('  ✗ ' + name); }
}
function card(rank, suit) {
  var s = C.SUITS.filter(function (x) { return x.key === suit; })[0];
  return { id: rank + suit, rank: rank, rankIdx: C.RANK_IDX[rank], suit: suit, suitIdx: s.idx, sym: s.sym, red: s.red };
}
function cs(str) { // "4C 4H"
  return str.split(' ').map(function (t) { return card(t.slice(0, -1), t.slice(-1)); });
}

console.log('— 牌型识别 —');
T('单张', K.detect(cs('4C')).type === 'single');
T('对子', K.detect(cs('4C 4H')).type === 'pair');
T('异点对子非法', K.detect(cs('4C 5H')) === null);
T('纯3张', K.detect(cs('4C 4H 4S')).type === 'triple');
T('顺子最小 34567', K.detect(cs('3C 4H 5S 6D 7C')).type === 'straight');
T('顺子最大 10JQKA', K.detect(cs('10C JH QS KD AC')).type === 'straight');
T('2 不能进顺子', K.detect(cs('JC QH KS AD 2C')) === null);
T('A2345 非法', K.detect(cs('AC 2H 3S 4D 5C')) === null);
T('三带二', K.detect(cs('4C 4H 4S 9D 9C')).type === 'fullhouse');
T('三带二需成对', K.detect(cs('4C 4H 4S 9D 8C')) === null);
T('四带一', K.detect(cs('4C 4H 4S 4D 9C')).type === 'fours');
T('5 张杂牌非法', K.detect(cs('4C 5H 6S 8D 9C')) === null);
T('同花：5 张梅花 35789', K.detect(cs('3C 5C 7C 8C 9C')).type === 'flush');
T('同花：5 张方块任意牌', K.detect(cs('4D 9D JD AD 3D')).type === 'flush');
T('同花：4 同花色 + 1 张杂牌非法', K.detect(cs('3C 5C 7C 8C 9H')) === null);
T('同花顺最小 ♣34567', K.detect(cs('3C 4C 5C 6C 7C')).type === 'sflush');
T('同花顺最大 ♦10JQKA', K.detect(cs('10D JD QD KD AD')).type === 'sflush');
T('同花色但不连续 = 同花（不是同花顺）', K.detect(cs('3C 4C 5C 6C 8C')).type === 'flush');
T('连续但不同花色 = 顺子（不是同花顺）', K.detect(cs('3C 4H 5S 6D 7C')).type === 'straight');

console.log('— 大小比较 —');
var a = K.detect(cs('4C')), b = K.detect(cs('4D'));
T('同点方块大', K.canBeat(b, a) && !K.canBeat(a, b));
T('5 大于 4', K.canBeat(K.detect(cs('5C')), K.detect(cs('4D'))));
T('3 最大', K.canBeat(K.detect(cs('3C')), K.detect(cs('2D'))));
T('对子比花色', K.canBeat(K.detect(cs('4D 4C')), K.detect(cs('4S 4H'))));
T('顺子 45678 > 34567', K.canBeat(K.detect(cs('4C 5H 6S 7D 8C')), K.detect(cs('3D 4D 5H 6S 7C'))));
T('顺子最大 10JQKA', K.canBeat(K.detect(cs('10C JH QS KD AC')), K.detect(cs('9C 10H JS QD KC'))));
T('四带一压三带二', K.canBeat(K.detect(cs('4C 4H 4S 4D 5C')), K.detect(cs('3C 3H 3S 2D 2C'))));
T('三带二压顺子', K.canBeat(K.detect(cs('4C 4H 4S 5D 5C')), K.detect(cs('10C JH QS KD AC'))));
// v1.3.6：4带1 > 3带2 > 顺子 > 纯3张，纯3张比任何五张组合牌都小
T('顺子能压纯3张', K.canBeat(K.detect(cs('3C 4H 5S 6D 7C')), K.detect(cs('3C 3H 3S'))));
T('三带二 33344 能压 999', K.canBeat(K.detect(cs('3C 3H 3S 4D 4C')), K.detect(cs('9C 9H 9S'))));
T('四带一 KQQQQ 能压 999', K.canBeat(K.detect(cs('QC QH QS QD KC')), K.detect(cs('9C 9H 9S'))));
T('纯3张只能用更大的纯3张压', K.canBeat(K.detect(cs('4C 4H 4S')), K.detect(cs('3C 3H 3S'))) === false &&
  K.canBeat(K.detect(cs('3D 3C 3H')), K.detect(cs('4C 4H 4S'))));
K.setStrictType(true);
T('【严格模式】顺子不能压纯3张', !K.canBeat(K.detect(cs('3C 4H 5S 6D 7C')), K.detect(cs('3C 3H 3S'))));
K.setStrictType(false);
T('切回默认（宽松）', K.isStrictType() === false);
T('纯3张不能压顺子', !K.canBeat(K.detect(cs('3C 3H 3S')), K.detect(cs('3C 4H 5S 6D 7C'))));
T('单张不能压纯3张', !K.canBeat(K.detect(cs('3D')), K.detect(cs('3C 3H 3S'))));
T('对子不能压纯3张', !K.canBeat(K.detect(cs('3D 3C')), K.detect(cs('3C 3H 3S'))));
T('单张不能压对子', !K.canBeat(K.detect(cs('3D')), K.detect(cs('4C 4H'))));
T('三带二可压任意顺子（3+2 > 顺子）', K.canBeat(K.detect(cs('4C 4H 4S 5D 5C')), K.detect(cs('10C JH QS KD AC'))));
T('顺子不能压三带二', !K.canBeat(K.detect(cs('10C JH QS KD AC')), K.detect(cs('4C 4H 4S 5D 5C'))));

console.log('— 同花 / 同花顺 —');
T('同花顺 > 四带一', K.canBeat(K.detect(cs('3C 4C 5C 6C 7C')), K.detect(cs('9C 9H 9S 9D 2H'))));
T('四带一 > 三带二', K.canBeat(K.detect(cs('4C 4H 4S 4D 5C')), K.detect(cs('3C 3H 3S 2D 2C'))));
T('三带二 > 同花', K.canBeat(K.detect(cs('4C 4H 4S 5D 5C')), K.detect(cs('3D 5D 7D 8D 9D'))));
T('同花 > 顺子', K.canBeat(K.detect(cs('3C 5C 7C 8C 9C')), K.detect(cs('10C JH QS KD AC'))));
T('顺子不能压同花', !K.canBeat(K.detect(cs('10C JH QS KD AC')), K.detect(cs('3C 5C 7C 8C 9C'))));
T('同花不能压三带二', !K.canBeat(K.detect(cs('3D 5D 7D 8D 9D')), K.detect(cs('4C 4H 4S 5D 5C'))));
T('同花不能压四带一', !K.canBeat(K.detect(cs('3D 5D 7D 8D AD')), K.detect(cs('4C 4H 4S 4D 5C'))));
T('四带一不能压同花顺', !K.canBeat(K.detect(cs('9C 9H 9S 9D 2H')), K.detect(cs('3C 4C 5C 6C 7C'))));
T('同花顺最大 ♦10JQKA 压 ♠9-K 同花顺', K.canBeat(K.detect(cs('10D JD QD KD AD')), K.detect(cs('9S 10S JS QS KS'))));
T('同为 10JQKA 时比花色 ♦ > ♠', K.canBeat(K.detect(cs('10D JD QD KD AD')), K.detect(cs('10S JS QS KS AS'))));
T('同为 34567 时比花色 ♠ > ♣', K.canBeat(K.detect(cs('3S 4S 5S 6S 7S')), K.detect(cs('3C 4C 5C 6C 7C'))));
T('同花比最大牌（10 > 9）', K.canBeat(K.detect(cs('3C 5C 7C 8C 10C')), K.detect(cs('3D 5D 7D 8D 9D'))));
T('同花最大牌相同则比第 2 大（9 > 8）', K.canBeat(K.detect(cs('3C 5C 7C 9C 10C')), K.detect(cs('3D 5D 7D 8D 10D'))));
T('同花比到第 3 大（7 > 6）', K.canBeat(K.detect(cs('3C 5C 7C 9C 10C')), K.detect(cs('3D 5D 6D 9D 10D'))));
K.setFlushBySuit(true);
T('【先比花色】♦ 同花压 ♠ 同花', K.canBeat(K.detect(cs('3D 5D 7D 8D 9D')), K.detect(cs('3S 5S 7S 8S 10S'))));
T('【先比花色】♦ 同花顺压 ♠ 同花顺', K.canBeat(K.detect(cs('4D 5D 6D 7D 8D')), K.detect(cs('10S JS QS KS AS'))));
T('【先比花色】同花色内仍逐张比点数',
  K.canBeat(K.detect(cs('4D 6D 8D 10D QD')), K.detect(cs('5D 7D 9D JD KD'))) === false &&
  K.canBeat(K.detect(cs('5D 7D 9D JD KD')), K.detect(cs('4D 6D 8D 10D QD'))) === true);
K.setFlushBySuit(false);
T('切回先比牌面', K.isFlushBySuit() === false);

console.log('— 队友公开时机 —');
function buildHands(aSeat, t3Seat) {
  var deck = C.makeDeck();
  var hands = [[], [], [], []];
  function pick(pred) {
    for (var k = 0; k < deck.length; k++) {
      if (pred(deck[k])) return deck.splice(k, 1)[0];
    }
    return null;
  }
  hands[aSeat].push(pick(C.isDiamondA));
  hands[t3Seat].push(pick(C.isDiamond3));
  while (deck.length) {
    var min = 0;
    for (var s = 1; s < 4; s++) if (hands[s].length < hands[min].length) min = s;
    hands[min].push(deck.shift());
  }
  return hands.map(C.sortDesc);
}
function mkGame(hands) {
  var g = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });
  var orig = C.deal;
  C.deal = function () { return hands.map(function (h) { return C.sortDesc(h); }); };
  g.startRound();
  C.deal = orig;
  return g;
}
function handCard(g, seat, pred) { return g.players[seat].hand.filter(pred)[0]; }

console.log('— 首出权：♣4 / 进贡最大牌（v1.3.3）—');
(function () {
  /* 造一手"♣4 在指定座位"的牌 */
  function handsWithC4(seat) {
    var deck = C.makeDeck();
    var idx = 0;
    for (var i = 0; i < deck.length; i++) if (C.isClub4(deck[i])) { idx = i; break; }
    var c4 = deck.splice(idx, 1)[0];
    var hands = [[], [], [], []];
    hands[seat].push(c4);
    var n = 0;
    while (deck.length) hands[(n++) % 4].push(deck.shift());
    return hands;
  }

  var okSeat = [0, 0, 0, 0];
  for (var s = 0; s < 4; s++) {
    var gg = mkGame(handsWithC4(s));
    if (gg.firstLeader === s && gg.turn === s && gg.leaderReason === 'club4' && gg.leaderCardId === '4C') okSeat[s] = 1;
  }
  T('无进贡：♣4 在谁手上谁先出（4 个座位都验证）', okSeat.join(',') === '1,1,1,1');

  // 随机 300 次发牌：首出座位必须就是 ♣4 持有者
  var bad = 0;
  for (var t = 0; t < 300; t++) {
    var g0 = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });
    g0.startRound();
    var holder = -1;
    for (var q = 0; q < 4; q++) if (g0.players[q].hand.some(C.isClub4)) holder = q;
    if (holder < 0 || g0.firstLeader !== holder) bad++;
  }
  T('随机 300 局：首出座位 = ♣4 持有者', bad === 0);

  /* v1.3.6：♣4 持有者先出，且开局首出必须带 ♣4 */
  var gA = mkGame(handsWithC4(1));
  gA.phase = 'playing';
  gA.turn = 1;
  var single = gA.players[1].hand.filter(function (c) { return !C.isClub4(c); })[0];
  T('开局首出不带 ♣4 ⇒ 拒绝', gA.validate(1, [single]).ok === false &&
    /♣4/.test(gA.validate(1, [single]).msg || ''));
  var c4 = gA.players[1].hand.filter(C.isClub4)[0];
  T('开局首出单张 ♣4 ⇒ 允许', gA.validate(1, [c4]).ok === true);
  T('开局首出带 ♣4 的组合（♣4+4）⇒ 允许', (function () {
    var four = gA.players[1].hand.filter(function (c) { return c.rank === '4' && !C.isClub4(c); })[0];
    return four ? gA.validate(1, [c4, four]).ok === true : true;
  })());
  T('首出后（played 非空）不再要求带 ♣4', (function () {
    gA.played = [c4];
    return gA.validate(1, [single]).ok === true;
  })());
  T('交给 options() 的候选全部含 ♣4', (function () {
    var g2 = mkGame(handsWithC4(2));
    g2.phase = 'playing'; g2.turn = 2;
    var opts = g2.options(2);
    return opts.length > 0 && opts.every(function (o) { return o.cards.some(C.isClub4); });
  })());

  // 进贡：1、3 名一队，各交 1 张 —— 交 ♠2 的人先出，而不是 ♣4 持有者
  var gB = mkGame(handsWithC4(0));
  gB.phase = 'tribute';
  gB.noteTribute({ from: 2, to: 0, mode: 'max' }, [card('2', 'S')]);
  gB.noteTribute({ from: 3, to: 1, mode: 'max' }, [card('A', 'H')]);
  gB.noteTribute({ from: 0, to: 2, mode: 'pick' }, [card('3', 'C')]);   // 还贡不参与
  var rB = gB.finishTribute();
  T('进贡 ♠2 > ♥A：交 ♠2 的玩家先出', gB.firstLeader === 2 && rB.reason === 'tribute');
  T('首出牌记录为 ♠2', gB.leaderCardId === '2S' && gB.leaderCardText === '♠2');
  T('还贡的牌不参与首出判定', gB.firstLeader !== 0);

  // 独狼输：只有独狼一个人交牌 ⇒ 独狼先出
  var gC = mkGame(handsWithC4(3));
  gC.phase = 'tribute';
  gC.noteTribute({ from: 1, to: 0, mode: 'max' }, [card('K', 'D')]);
  gC.noteTribute({ from: 1, to: 2, mode: 'max' }, [card('10', 'S')]);
  gC.noteTribute({ from: 1, to: 3, mode: 'max' }, [card('9', 'H')]);
  gC.finishTribute();
  T('独狼独自交牌：由独狼先出', gC.firstLeader === 1);
  T('独狼先出的依据是交出的大牌 ♦K', gC.leaderCardId === 'KD');

  // 全都不是 max（异常情况）：退回 ♣4 规则
  var gD = mkGame(handsWithC4(2));
  gD.phase = 'tribute';
  gD.noteTribute({ from: 0, to: 1, mode: 'pick' }, [card('5', 'C')]);
  gD.finishTribute();
  T('没有进贡牌时退回 ♣4 规则', gD.firstLeader === 2 && gD.leaderReason === 'club4');
})();

console.log('— 纯 3 张的出牌时机 —');
/* 造一个可控局面：0 号手牌 = handStr，played 决定是本局首出还是领出 */
function t3game(handStr, playedStr, withTrick) {
  var g = mkGame(buildHands(0, 1));
  g.phase = 'playing';
  g.played = playedStr ? cs(playedStr) : [];
  g.trick = withTrick ? { seat: 1, combo: K.detect(cs('2C 2D')) } : null;
  g.turn = 0;
  g.passed = [false, false, false, false];
  g.players.forEach(function (p) { p.hand = []; p.finished = false; });
  g.players[0].hand = cs(handStr);
  g.players[1].hand = cs('AC AH');
  return g;
}
var big3 = '4C 4H 4S 9D 9H JC QD 2S';
var v1 = t3game(big3, '', false).validate(0, cs('4C 4H 4S'));
T('开局首出：手上有 13 张也能打 444', v1.ok);
var v2 = t3game(big3, '5C 6D', false).validate(0, cs('4C 4H 4S'));
T('重新领出但手上还有很多牌 ⇒ 444 违规', !v2.ok && /只剩/.test(v2.msg || ''));
var v3 = t3game('4C 4H 4S', '5C 6D', false).validate(0, cs('4C 4H 4S'));
T('重新领出且手上只剩 444 ⇒ 允许', v3.ok);
var v4 = t3game(big3, '5C 6D', true).validate(0, cs('4C 4H 4S'));
T('跟牌时不能出纯3张', !v4.ok);
var g3 = t3game(big3, '5C 6D', false);
T('options 不再给出纯3张', !g3.options(0).some(function (o) { return o.type === 'triple'; }));
var g3b = t3game('4C 4H 4S', '5C 6D', false);
T('只剩 3 张时 options 含纯3张', g3b.options(0).some(function (o) { return o.type === 'triple'; }));

/* v1.3.6 公开规则：
 *  · 非独狼：谁先打出 ♦A / ♦3，除他本人外其余 3 人立刻看到敌友；本人要等另一张也出了才看得到
 *  · 独狼：宣告 ⇒ 开局全场皆知；未宣告 ⇒ 只有他自己心里有数，等两张身份牌都出完才公开 */
var rg = mkGame(buildHands(0, 1));
rg.requireClub4Lead = false;          // 这些用例只验公开时机，绕开"首出必须带♣4"
T('开局两张牌都没出 ⇒ 不公开', rg.teamsRevealed === false && rg.view(0).teams === null);
rg.turn = 0; rg.trick = null;
rg.play(0, [handCard(rg, 0, C.isDiamondA)]);
T('只打出 ♦A ⇒ 除出牌者本人外都能看到', rg.teamsRevealed === false &&
  rg.view(0).teams === null && rg.view(1).teams !== null &&
  rg.view(2).teams !== null && rg.view(3).teams !== null);
rg.turn = 1; rg.trick = null;
rg.play(1, [handCard(rg, 1, C.isDiamond3)]);
T('♦A 与 ♦3 都出现 ⇒ 公开', rg.teamsRevealed === true);
T('不同人打出 ⇒ 这两人一队', rg.soloSeat === null && JSON.stringify(rg.teams) === JSON.stringify([[0, 1], [2, 3]]));
T('公开后所有人都能看到', rg.view(0).teams !== null && rg.view(3).teams !== null);

var sg = mkGame(buildHands(2, 2));
sg.requireClub4Lead = false;
sg.declare(false);
T('♦A+♦3 撞车 ⇒ 独狼', sg.soloSeat === 2 && sg.soloCandidate === 2);
T('未宣告：独狼自己心里有数，另外 3 人不知道', sg.teamKnownTo(2) === true && sg.teamKnownTo(0) === false);
sg.turn = 2; sg.trick = null;
sg.play(2, [handCard(sg, 2, C.isDiamondA)]);
T('未宣告的独狼只出 ♦A ⇒ 另外 3 人仍不标记',
  sg.teamsRevealed === false && sg.view(0).teams === null && sg.view(1).teams === null);
sg.turn = 2; sg.trick = null;
sg.play(2, [handCard(sg, 2, C.isDiamond3)]);
T('两张都从同一人打出 ⇒ 另外 3 人一队', sg.teamsRevealed === true &&
  sg.soloSeat === 2 && JSON.stringify(sg.teams) === JSON.stringify([[2], [0, 1, 3]]));
T('公开后所有人都能看到（独狼局）', sg.view(0).teams !== null && sg.view(2).teams !== null);

// 宣告 ⇒ 开局就全场皆知
var sd = mkGame(buildHands(3, 3));
sd.requireClub4Lead = false;
T('宣告前：只有独狼自己知道', sd.teamKnownTo(3) === true && sd.teamKnownTo(0) === false);
sd.declare(true);
T('宣告后：全场立刻都知道', sd.teamKnownTo(0) && sd.teamKnownTo(1) && sd.teamKnownTo(2) && sd.teamKnownTo(3));
T('宣告后所有人都能看到队友标记', sd.view(0).teams !== null && sd.view(0).soloSeat === 3);

console.log('— 进贡：四张 3 与 ♦A 都不交 —');
// 规则（v1.3.2）：交最大的牌时，♦3 ♠3 ♥3 ♣3 与 ♦A 这 5 张都不交；
// 这些牌都交完还不够张数，才从除 ♦3 / ♦A 以外的牌里继续取最大的（♠3 → ♥3 → ♣3）。
var th1 = cs('3C 3H 3S 3D 2D 2S 2H 2C AC AD');
var g1 = C.tributeMax(th1, 1);
T('交 1 张时交 ♦2，不是 3、也不是 ♦A', g1.length === 1 && g1[0].id === '2D');
var g2 = C.tributeMax(th1, 2);
T('交 2 张时为 ♦2 + ♠2，不含 3 与 ♦A', g2.length === 2 && !g2.some(function (c) { return c.rank === '3'; }) &&
  !g2.some(function (c) { return c.id === 'AD'; }) &&
  g2[0].id === '2D' && g2[1].id === '2S');
var g3 = C.tributeMax(th1, 3);
T('交 3 张时仍不含 3', g3.length === 3 && !g3.some(function (c) { return c.rank === '3'; }));
T('♦A 绝不进贡（牌力最高也跳过）', C.tributeMax(cs('AD AH AS AC KD'), 2).every(function (c) { return c.id !== 'AD'; }));

// 手里只有 2 张可交的牌，要交 3 张 → 才动 ♠3 / ♥3 / ♣3，♦3 仍不交
var th2 = cs('3D 3C 9H 5S');
var g4 = C.tributeMax(th2, 3);
T('可交的牌不够时才动用 3', g4.length === 3 && g4.filter(function (c) { return c.rank === '3'; }).length === 1);
T('补 3 时先交 ♣3，♦3 永不交出', g4.some(function (c) { return c.id === '3C'; }) &&
  !g4.some(function (c) { return c.id === '3D'; }));
T('tributeNeedsThree 判定正确', C.tributeNeedsThree(th2, 3) === true && C.tributeNeedsThree(th2, 2) === false);

// 累计 6 张：先交完 4 张可交的大牌，再补 ♠3 / ♥3（♦3、♦A 不动）
var th3 = cs('3C 3H 3S 2D AD AH AS AC');
var six = [];
for (var t = 0; t < 3; t++) {
  var part = C.tributeMax(th3, 2);
  six = six.concat(part);
  var drop = {};
  part.forEach(function (c) { drop[c.id] = true; });
  th3 = th3.filter(function (c) { return !drop[c.id]; });
}
T('累计交 6 张：先交 4 张可交的大牌，再按 ♠3 → ♥3 补 2 张',
  six.slice(0, 4).every(function (c) { return c.rank !== '3'; }) &&
  six.filter(function (c) { return c.rank === '3'; }).length === 2 &&
  six.some(function (c) { return c.id === '3S'; }) && six.some(function (c) { return c.id === '3H'; }) &&
  !six.some(function (c) { return c.id === '3D'; }) && !six.some(function (c) { return c.id === 'AD'; }));

var th4 = cs('3C 3H 3S 3D 2D 2C AD AH AS AC KD KH');
var nine = [];
for (var t2 = 0; t2 < 3; t2++) {
  var part2 = C.tributeMax(th4, 3);
  nine = nine.concat(part2);
  var drop2 = {};
  part2.forEach(function (c) { drop2[c.id] = true; });
  th4 = th4.filter(function (c) { return !drop2[c.id]; });
}
T('累计交 9 张：7 张可交的大牌 + ♠3 ♥3，♦3 与 ♦A 保留',
  nine.filter(function (c) { return c.rank !== '3'; }).length === 7 &&
  nine.some(function (c) { return c.id === '3S'; }) && nine.some(function (c) { return c.id === '3H'; }) &&
  !nine.some(function (c) { return c.id === '3C' || c.id === '3D' || c.id === 'AD'; }));
T('AI 交最大的牌同样避开 3 与 ♦A',
  AI.tributePick(cs('3C 2D AC'), 1, 'max')[0].id === '2D');
T('还贡不许还 ♦3 / ♦A',
  !C.canReturn(cs('3D')[0]) && !C.canReturn(cs('AD')[0]) &&
  C.canReturn(cs('3C')[0]) && C.canReturn(cs('AH')[0]));
var back = AI.tributePick(cs('3D AD 3C 4H 5S'), 2, 'pick');
T('AI 还贡只还最没用的牌，且不碰 ♦3 / ♦A',
  back.length === 2 && !back.some(function (c) { return c.id === '3D' || c.id === 'AD'; }));

console.log('— 进贡：名次与张数 —');
/** 造一个结算场景：teams / finishOrder / soloSeat / declared */
function tbCase(teams, order, soloSeat, declared) {
  var g = new Game({
    players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]
  });
  g.teams = teams;
  g.finishOrder = order.slice();
  g.soloSeat = (soloSeat === undefined ? null : soloSeat);
  g.declared = !!declared;
  return g.computeTribute();
}
// ① 队友 1、2 名：输方各交 2 张，赢方各还 2 张
var team12 = tbCase([[0, 1], [2, 3]], [0, 1, 2, 3], null, false);
T('队友 1、2 名 ⇒ 每对交换 2 张', team12.kind === 'team' && team12.n === 2 &&
  team12.gives.length === 4 && team12.gives.every(function (it) { return it.count === 2; }) &&
  team12.gives.filter(function (it) { return it.mode === 'max'; }).length === 2);
// ② 队友 1、3 名：输方各交 1 张
var team13 = tbCase([[0, 2], [1, 3]], [0, 1, 2, 3], null, false);
T('队友 1、3 名 ⇒ 每对交换 1 张', team13.kind === 'team' && team13.n === 1 &&
  team13.gives.every(function (it) { return it.count === 1; }));
// ③ 队友 1、4 名 / 2、3 名：平局不进贡
var team14 = tbCase([[0, 3], [1, 2]], [0, 1, 2, 3], null, false);
T('队友 1、4 名 ⇒ 平局不进贡', team14.kind === 'none' && team14.gives.length === 0);
var team23 = tbCase([[1, 2], [0, 3]], [0, 1, 2, 3], null, false);
T('队友 2、3 名 ⇒ 平局不进贡', team23.kind === 'none' && team23.gives.length === 0);
// ④ 独狼获胜：宣告 3 张 / 未宣告 2 张
var soloWinD = tbCase([[0], [1, 2, 3]], [0, 1, 2, 3], 0, true);
T('独狼获胜 + 已宣告 ⇒ 另外 3 人各交 3 张（共 9 张）',
  soloWinD.kind === 'solo' && soloWinD.n === 3 &&
  soloWinD.gives.filter(function (it) { return it.mode === 'max'; }).length === 3 &&
  soloWinD.gives.filter(function (it) { return it.mode === 'max'; }).every(function (it) { return it.count === 3; }));
T('独狼获胜：独狼一方拿出 9 张不要的牌',
  soloWinD.gives.filter(function (it) { return it.mode === 'pick'; }).length === 1 &&
  soloWinD.gives.filter(function (it) { return it.mode === 'pick'; })[0].count === 9);
var soloWinN = tbCase([[0], [1, 2, 3]], [0, 1, 2, 3], 0, false);
T('独狼获胜 + 未宣告 ⇒ 另外 3 人各交 2 张（共 6 张）',
  soloWinN.n === 2 && soloWinN.gives.filter(function (it) { return it.mode === 'max'; })
    .reduce(function (s, it) { return s + it.count; }, 0) === 6);
/* ⑤ 独狼落败：张数改按「独狼名次 × 是否公布」查表（v1.4.0）
 *
 *         独狼名次 →  1    2    3    4
 *   已宣告（公布）    3    2    0    3
 *   未宣告            2    1    1    2
 *
 * n = 0 ⇒ 谁都不用交换牌，下一局回到 ♣4 定首出。
 */
function soloGive(plan) {          // 输方（独狼落败时就是独狼本人）交出的总张数
  return plan.gives.filter(function (it) { return it.mode === 'max'; })
    .reduce(function (s, it) { return s + it.count; }, 0);
}
var soloP2D = tbCase([[0], [1, 2, 3]], [1, 0, 2, 3], 0, true);
T('独狼第 2 名 + 已公布 ⇒ 独狼交 6 张，另外 3 人各还 2 张',
  soloP2D.kind === 'solo' && soloP2D.win === false && soloP2D.n === 2 && soloGive(soloP2D) === 6);
var soloP2N = tbCase([[0], [1, 2, 3]], [1, 0, 2, 3], 0, false);
T('独狼第 2 名 + 未公布 ⇒ 独狼交 3 张，另外 3 人各还 1 张',
  soloP2N.kind === 'solo' && soloP2N.n === 1 && soloGive(soloP2N) === 3);
var soloP3D = tbCase([[0], [1, 2, 3]], [1, 2, 0, 3], 0, true);
T('独狼第 3 名 + 已公布 ⇒ 谁都不用交换牌', soloP3D.kind === 'none' && soloP3D.gives.length === 0);
var soloP3N = tbCase([[0], [1, 2, 3]], [1, 2, 0, 3], 0, false);
T('独狼第 3 名 + 未公布 ⇒ 独狼交 3 张，另外 3 人各还 1 张',
  soloP3N.kind === 'solo' && soloP3N.n === 1 && soloGive(soloP3N) === 3);
var soloP4D = tbCase([[0], [1, 2, 3]], [1, 2, 3, 0], 0, true);
T('独狼最后一名 + 已公布 ⇒ 交 9 收 9（旧规则不变）',
  soloP4D.kind === 'solo' && soloP4D.n === 3 && soloGive(soloP4D) === 9);
var soloP4N = tbCase([[0], [1, 2, 3]], [1, 2, 3, 0], 0, false);
T('独狼最后一名 + 未公布 ⇒ 交 6 收 6（旧规则不变）',
  soloP4N.kind === 'solo' && soloP4N.n === 2 && soloGive(soloP4N) === 6);
T('独狼进贡：交换总张数 = 9（双方各 9 张）', soloWinD.total === 9 &&
  soloWinD.gives.reduce(function (s, it) { return s + it.count; }, 0) === 18);
T('独狼局：另外 3 人排在收牌顺序里依次挑 3 张', (function () {
  var g = mkGame(buildHands(0, 1));
  var plan = soloWinD;
  g.beginTribute(plan);
  plan.gives.forEach(function (it) {
    var h = g.players[it.from].hand;
    g.giveToPool(it, it.mode === 'max' ? C.tributeMax(h, it.count) : AI.tributePick(h, it.count, 'pick'));
  });
  var steps = g.buildTakeSteps();
  var others = steps.filter(function (s2) { return s2.side === 0; });
  var soloSteps = steps.filter(function (s2) { return s2.side === 1; });
  return others.length === 3 && others.every(function (s2) { return s2.count === 3; }) &&
    others[others.length - 1].auto === true && others[0].auto === false &&
    soloSteps.length === 1 && soloSteps[0].auto === true;
})());

console.log('— 独狼名次与「直接下一局」（v1.4.0）—');
/** 造一个「独狼是 0 号座」的残局：order 是已出完牌的座位顺序 */
function soloRankCase(order, declared) {
  var g = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });
  g.startRound();
  g.soloSeat = 0;
  g.teams = [[0], [1, 2, 3]];
  g.phase = 'playing';
  g.declared = !!declared;
  g.finishOrder = order.slice();
  order.forEach(function (s, i) { g.players[s].place = i + 1; g.players[s].finished = true; });
  g._checkOver();
  return g;
}
function placeStr(g) { return g.players.map(function (p) { return p.place; }).join(','); }

T('独狼第 1 个出完 ⇒ 独狼第 1，另外 3 人统统并列第 2',
  (function () {
    var g = soloRankCase([0], true);
    return g.phase === 'over' && placeStr(g) === '1,2,2,2' && g.tribute.n === 3;
  })());
T('独狼第 1 个出完（未公布）⇒ 同样 1 / 2 / 2 / 2，进贡按 2 张',
  (function () {
    var g = soloRankCase([0], false);
    return placeStr(g) === '1,2,2,2' && g.tribute.n === 2;
  })());
T('独狼第 2 个出完 ⇒ 先走的第 1、独狼第 2、剩下 2 人并列第 3',
  (function () {
    var g = soloRankCase([1, 0], true);
    return g.phase === 'over' && placeStr(g) === '2,1,3,3' && g.tribute.n === 2;
  })());
T('独狼第 2 个出完（未公布）⇒ 名次相同，进贡按 1 张',
  (function () {
    var g = soloRankCase([1, 0], false);
    return placeStr(g) === '2,1,3,3' && g.tribute.n === 1;
  })());
T('独狼第 3 个出完 ⇒ 名次 1 / 2 / 独狼第 3 / 最后一人第 4',
  (function () {
    var g = soloRankCase([1, 2, 0], true);
    return placeStr(g) === '3,1,2,4' && g.tribute.kind === 'none';
  })());
T('独狼第 3 个出完（未公布）⇒ 名次相同，进贡按 1 张',
  (function () {
    var g = soloRankCase([1, 2, 0], false);
    return placeStr(g) === '3,1,2,4' && g.tribute.kind === 'solo' && g.tribute.n === 1;
  })());
T('独狼投降「直接下一局」⇒ 独狼第 4，另外 3 人并列第 1，按交 9 收 9 进贡',
  (function () {
    var g = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });
    g.startRound();
    g.soloSeat = 0; g.soloCandidate = 0; g.teams = [[0], [1, 2, 3]];
    g.phase = 'declare';
    var ok = g.soloGiveUp();
    return ok === true && g.phase === 'over' && g.declared === true &&
      placeStr(g) === '4,1,1,1' && g.giveUpSeat === 0 &&
      g.tribute.kind === 'solo' && g.tribute.n === 3 && g.tribute.total === 9;
  })());
T('非独狼局不触发「直接下一局」', (function () {
  var g = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });
  g.startRound();
  g.soloSeat = null; g.soloCandidate = null;
  g.phase = 'declare';
  return g.soloGiveUp() === false;
})());

console.log('— 进贡：实盘交换后手牌守恒、标记牌不动 —');
(function () {
  var bad = 0, moved = 0;
  for (var n = 0; n < 200; n++) {
    var hands = C.deal(4, 7);
    var cases = [[2, 'team'], [1, 'team'], [3, 'solo'], [2, 'solo']];
    // team: 1、2 名 / 1、3 名轮流；solo: 宣告 3 张 / 未宣告 2 张轮流
    var nCount = cases[n % 4][0];
    var mode = cases[n % 4][1];
    var gives = [];
    for (var s = 0; s < 4; s++) {
      if (mode === 'solo' && s === 0) {
        for (var o = 1; o < 4; o++) {
          gives.push({ from: s, to: o, count: nCount, mode: 'pick' });
          gives.push({ from: o, to: s, count: nCount, mode: 'max' });
        }
      } else if (mode === 'team' && (s === 0 || s === 2)) {
        var mate = s === 0 ? 2 : 0;
        gives.push({ from: s, to: mate, count: nCount, mode: 'max' });
        gives.push({ from: mate, to: s, count: nCount, mode: 'pick' });
      }
    }
    var cur = hands.map(function (h) { return h.slice(); });
    gives.forEach(function (it) {
      var pool = cur[it.from];
      var cs2 = it.mode === 'max' ? C.tributeMax(pool, it.count) : AI.tributePick(pool, it.count, 'pick');
      if (cs2.length !== it.count) bad++;
      cs2.forEach(function (c) { if (C.isProtectedCard(c)) moved++; });
      var ids = {};
      cs2.forEach(function (c) { ids[c.id] = true; });
      cur[it.from] = pool.filter(function (c) { return !ids[c.id]; });
      cur[it.to] = cur[it.to].concat(cs2);
    });
    cur.forEach(function (h) { if (h.length !== 13) bad++; });
    if (new Set(cur.map(function (h) { return h.length; })).size !== 1) bad++;
  }
  T('200 组随机进贡：张数足够、每人仍 13 张', bad === 0);
  T('♦3 / ♦A 从未被交换', moved === 0);
})();

console.log('— 洗牌/发牌 —');
var hands = C.deal(4, 7);

T('4 人各 13 张', hands.length === 4 && hands.every(function (h) { return h.length === 13; }));
var allC = [].concat.apply([], hands);
T('52 张不重复', new Set(allC.map(function (c) { return c.id; })).size === 52);
T('无大小王', !allC.some(function (c) { return c.rank === 'BJ' || c.rank === 'RJ'; }));
// 洗牌随机性：两次发牌顺序不同
var same = 0;
for (var i = 0; i < 20; i++) {
  var h1 = C.deal(4, 7), h2 = C.deal(4, 7);
  if (JSON.stringify(h1[0].map(function (c) { return c.id; })) === JSON.stringify(h2[0].map(function (c) { return c.id; }))) same++;
}
T('洗牌随机（20 次无重复）', same === 0);

console.log('— 完整对局模拟（4 个电脑玩家 × 400 局）—');
var rounds = 0, errors = [], teamStats = {};
for (var n = 0; n < 400; n++) {
  var g = new Game({
    players: [{ name: 'A', isAI: true }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }]
  });
  g.startRound();
  if (g.needDeclare()) g.declare(AI.decideDeclare(g.players[g.soloCandidate].hand));
  var guard = 0;
  while (g.phase !== 'over' && guard++ < 400) {
    var seat = g.turn;
    var d = AI.decide(g, seat);
    if (!d) { errors.push('AI 无决策'); break; }
    var r;
    if (d.type === 'pass') {
      r = g.pass(seat);
      if (!r.ok) { errors.push('PASS 失败: ' + r.msg); break; }
    } else {
      var firstPlay = g.played.length === 0;
      var handLen = g.players[seat].hand.length;
      r = g.play(seat, d.cards);
      if (!r.ok) { errors.push('PLAY 失败: ' + r.msg + ' / ' + d.cards.map(function (c) { return c.id; }).join(',')); break; }
      // 纯3张只允许：本局首出，或出牌前手上正好只剩这 3 张
      if (r.combo && r.combo.type === 'triple' && !firstPlay && handLen !== 3) {
        errors.push('纯3张违规（首出=' + firstPlay + ' 手牌=' + handLen + '）'); break;
      }
    }
    // 手牌守恒
    var total = g.players.reduce(function (s, p) { return s + p.hand.length; }, 0) + g.played.length;
    if (total !== 52) { errors.push('牌数不守恒 ' + total); break; }
    // 队友公开时机：跟 revealSignature() 保持一致（只出一张时出牌者本人还看不到）
    if (g.phase !== 'over' && g.teamsRevealed !== !!g.revealSignature().all) {
      errors.push('公开时机不符'); break;
    }
  }
  if (g.phase !== 'over') { errors.push('未能正常结束, guard=' + guard); break; }
  rounds++;
  /* 名次完整性（v1.4.0：独狼局允许并列）
   *   独狼第 1 个走 ⇒ 1,2,2,2 ；独狼第 2 个走 ⇒ 1,2,3,3 ；其余 ⇒ 1,2,3,4 */
  var places = g.players.map(function (p) { return p.place; }).sort();
  var pkey = places.join(',');
  if (g.soloSeat !== null) {
    if (['1,2,2,2', '1,2,3,3', '1,2,3,4'].indexOf(pkey) < 0) errors.push('独狼名次异常 ' + pkey);
  } else if (pkey !== '1,2,3,4') {
    errors.push('名次异常 ' + pkey);
  }
  if (!g.teams) errors.push('队伍未确定');
  else {
    var key = g.soloSeat !== null ? 'solo' : 'team';
    teamStats[key] = (teamStats[key] || 0) + 1;
  }
  // 进贡任务校验
  var tb = g.tribute;
  if (!tb) errors.push('无结算数据');
  else if (tb.kind !== 'none') {
    var sum = 0;
    tb.gives.forEach(function (it) { sum += it.count; });
    var cnt = tb.gives.length / 2;
    if (tb.kind === 'solo') {
      // 期望张数 = 6 × n（双方各交 3n 张），n 由「独狼名次 × 是否公布」查表
      var sp = g.players[g.soloSeat].place;
      var expN = g.soloTributeCount(sp);
      if (sum !== expN * 6) errors.push('独狼进贡张数异常 ' + sum + '（名次 ' + sp + '，期望 ' + expN * 6 + '）');
    } else {
      if (cnt !== 2) errors.push('队伍进贡配对异常');
    }
  }
}
T('400 局全部正常结束（已完成 ' + rounds + ' 局）', rounds === 400 && errors.length === 0);
if (errors.length) console.log('  错误样本：', errors.slice(0, 6));
console.log('  分队分布：', JSON.stringify(teamStats));

console.log('\n结果：' + ok + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
