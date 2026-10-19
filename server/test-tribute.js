/* ============================================================
 * test-tribute.js —— 进贡 / 还贡 房间级端到端测试（v1.3.6 牌池版）
 * 直接驱动 server/lib/room.js 的真实流程（nextRound → 交牌进池 → 按交牌大小依次收牌）
 *   node server/test-tribute.js
 *
 * 覆盖：
 *   ① 队友 1、2 名：输方各交 2 张最大的，赢方各拿出 2 张不要的
 *   ② 队友 1、3 名：输方各交 1 张
 *   ③ 独狼赢 + 已宣告：另外 3 人各交 3 张（共 9），独狼拿出 9 张不要的
 *   ④ 独狼最后一名 + 已宣告：独狼交出原手牌里最大的 9 张，另外 3 人各拿出 3 张
 *   ④b 独狼第 2 名 + 已宣告（v1.4.0）：独狼交 6 张，另外 3 人各还 2 张
 *   ④c 独狼第 3 名 + 已宣告（v1.4.0）：谁都不交换，回到 ♣4 定首出
 *   每次交换：每人仍 13 张；♦3 / ♦A 从未换手；
 *            收牌顺序 = 各自交出的最大单张从大到小，最后一名自动拿剩下的
 * ============================================================ */
'use strict';

var R = require('./lib/room.js');
var C = globalThis.Cards;
var Game = globalThis.Game;

var ok = 0, fail = 0;
function T(name, cond) {
  if (cond) { ok++; }
  else { fail++; console.log('  ✗ ' + name); }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function byId(id) {
  return C.makeDeck().filter(function (x) { return x.id === id; })[0];
}
function sortedIds(cards) {
  return cards.map(function (c) { return c.id; }).sort().join(',');
}
function sortIds(ids) {
  return ids.slice().sort().join(',');
}
function maxVal(ids) {
  var m = -1;
  ids.forEach(function (id) { var v = C.cardValue(byId(id)); if (v > m) m = v; });
  return m;
}

/** 造一个已结算的房间，并让 nextRound 走真实流程 */
function setup(teams, order, soloSeat, declared) {
  var room = new R.Room('9999');
  room.started = true;
  room.hostSeat = 0;
  room.log = [];
  // 关掉与进贡无关的副作用
  room.syncClock = function () { };
  room.afterMove = function () { };
  room.broadcastState = function () { };
  room.broadcastRoom = function () { };
  room.broadcast = function () { };
  room.broadcastReady = function () { };

  var players = [0, 1, 2, 3].map(function (i) { return { name: 'P' + i, isAI: true }; });
  var g = new Game({ players: players });
  room.game = g;
  for (var i = 0; i < 4; i++) {
    room.seats[i] = {
      ws: null, name: 'P' + i, avatar: '🙂', seat: i, isAI: true,
      token: 't' + i, trustee: false, offline: false
    };
  }
  // 记录每一次实际的「交牌 / 收牌」
  var realGive = Game.prototype.giveToPool;
  g.giveToPool = function (item, cards) {
    room.log.push({
      kind: 'give', from: item.from, side: item.side, mode: item.mode,
      count: item.count, ids: cards.map(function (c) { return c.id; })
    });
    return realGive.call(this, item, cards);
  };
  var realTake = Game.prototype.takeFromPool;
  g.takeFromPool = function (step, cards) {
    room.log.push({
      kind: 'take', taker: step.taker, side: step.side, count: cards.length,
      auto: !!step.auto, order: step.order || 1, of: step.of || 1,
      ids: cards.map(function (c) { return c.id; })
    });
    return realTake.call(this, step, cards);
  };

  g.startRound();
  g.phase = 'over';
  g.finishOrder = order.slice();
  g.teams = teams;
  g.soloSeat = soloSeat;
  g.declared = !!declared;
  g.tribute = g.computeTribute();
  return { room: room, g: g };
}

function snap(g) {
  return g.players.map(function (p) { return p.hand.map(function (c) { return c.id; }); });
}

function ownerOf(g, id) {
  for (var i = 0; i < 4; i++) {
    if (g.players[i].hand.some(function (c) { return c.id === id; })) return i;
  }
  return -1;
}

function gives(room, mode) {
  return room.log.filter(function (x) { return x.kind === 'give' && x.mode === mode; });
}
function takes(room, side) {
  return room.log.filter(function (x) { return x.kind === 'take' && x.side === side; });
}

/** 按"交出的单张牌最大"推算首出座位 */
function expectedLeader(entries) {
  var best = -1, seat = -1;
  entries.forEach(function (e) {
    var v = maxVal(e.ids);
    if (v > best) { best = v; seat = e.from; }
  });
  return seat;
}

/** 收牌顺序必须 = 该方各人「交出的最大单张」从大到小 */
function checkTakeOrder(room, side, giveMode) {
  var gv = gives(room, giveMode).filter(function (x) { return x.side === side; });
  var tk = takes(room, side);
  if (!gv.length || !tk.length) return false;
  var want = gv.slice().sort(function (a, b) { return maxVal(b.ids) - maxVal(a.ids); })
    .map(function (x) { return x.from; });
  var got = tk.map(function (x) { return x.taker; });
  if (want.join(',') !== got.join(',')) return false;
  // 最后一名是 auto，前面的都不是（单人方除外）
  if (tk.length > 1) {
    if (tk[tk.length - 1].auto !== true) return false;
    for (var i = 0; i < tk.length - 1; i++) if (tk[i].auto) return false;
  }
  return true;
}

async function run() {
  /* ---------- ① 队友 1、2 名 ---------- */
  console.log('— ① 队友 1、2 名 —');
  var a = setup([[0, 1], [2, 3]], [0, 1, 2, 3], null, false);
  a.room.nextRound(0);
  var before1 = snap(a.g);
  var d3Seat = ownerOf(a.g, '3D'), adSeat = ownerOf(a.g, 'AD');
  await wait(800 + 8 * 700 + 1500);
  T('进贡阶段已结束', a.g.phase !== 'tribute');
  T('每人仍是 13 张', a.g.players.every(function (p) { return p.hand.length === 13; }));
  T('♦3 没有换手', ownerOf(a.g, '3D') === d3Seat);
  T('♦A 没有换手', ownerOf(a.g, 'AD') === adSeat);
  T('牌池已清空', (a.g.pools[0].length + a.g.pools[1].length) === 0);

  var pay1 = gives(a.room, 'max'), back1 = gives(a.room, 'pick');
  T('输方两人各交 2 张、赢方两人各拿 2 张',
    pay1.length === 2 && pay1.every(function (x) { return x.count === 2 && x.ids.length === 2; }) &&
    back1.length === 2 && back1.every(function (x) { return x.count === 2 && x.ids.length === 2; }));
  T('交牌方是输的那一队（2、3 号）', pay1.every(function (x) { return x.from === 2 || x.from === 3; }));
  T('出牌方是赢的那一队（0、1 号）', back1.every(function (x) { return x.from === 0 || x.from === 1; }));
  T('输方交出的是「除 3 和 ♦A 以外最大的 2 张」',
    pay1.every(function (x) { return sortIds(x.ids) === sortedIds(C.tributeMax(before1[x.from].map(byId), 2)); }));
  T('交出的牌里没有 ♦3 / ♦A / 其它 3',
    pay1.every(function (x) {
      return x.ids.every(function (id) { return id.slice(0, -1) !== '3' && id !== 'AD'; });
    }));
  T('赢方交出的牌里没有 ♦3 / ♦A',
    back1.every(function (x) { return x.ids.every(function (id) { return id !== '3D' && id !== 'AD'; }); }));
  T('交换总张数 = 4（双方各 4 张）', a.g.tribute.total === 4);
  T('输方收牌顺序 = 交牌最大者先选', checkTakeOrder(a.room, 0, 'max'));
  T('赢方收牌顺序 = 交牌最大者先选', checkTakeOrder(a.room, 1, 'pick'));
  T('首出：交出最大单张的玩家先出', a.g.firstLeader === expectedLeader(pay1) && a.g.leaderReason === 'tribute');
  T('首出座位在两名输方之中', pay1.some(function (x) { return x.from === a.g.firstLeader; }));

  /* ---------- ② 队友 1、3 名 ---------- */
  console.log('— ② 队友 1、3 名 —');
  var b = setup([[0, 2], [1, 3]], [0, 1, 2, 3], null, false);
  b.room.nextRound(0);
  var before2 = snap(b.g);
  await wait(800 + 8 * 700 + 1500);
  T('每人仍是 13 张（1、3 名）', b.g.players.every(function (p) { return p.hand.length === 13; }));
  var pay2 = gives(b.room, 'max'), back2 = gives(b.room, 'pick');
  T('输方各交 1 张、赢方各拿 1 张',
    pay2.length === 2 && pay2.every(function (x) { return x.count === 1 && x.ids.length === 1; }) &&
    back2.length === 2 && back2.every(function (x) { return x.count === 1 && x.ids.length === 1; }));
  T('1、3 名时交的也是规则要求的最大牌',
    pay2.every(function (x) { return sortIds(x.ids) === sortedIds(C.tributeMax(before2[x.from].map(byId), 1)); }));
  T('1、3 名：单张最大者先出（例：♠2 > ♥A）', b.g.firstLeader === expectedLeader(pay2));
  T('1、3 名：收牌顺序同样按交牌大小', checkTakeOrder(b.room, 0, 'max') && checkTakeOrder(b.room, 1, 'pick'));

  /* ---------- ③ 独狼赢 + 已宣告 ---------- */
  console.log('— ③ 独狼赢 + 已宣告 —');
  var c = setup([[0], [1, 2, 3]], [0, 1, 2, 3], 0, true);
  c.room.nextRound(0);
  var before3 = snap(c.g);
  var soloD3 = ownerOf(c.g, '3D'), soloAD = ownerOf(c.g, 'AD');
  await wait(800 + 8 * 700 + 2000);
  T('独狼进贡阶段已结束', c.g.phase !== 'tribute');
  T('每人仍是 13 张（独狼 9 张交换）', c.g.players.every(function (p) { return p.hand.length === 13; }));
  T('♦3 没有换手（独狼）', ownerOf(c.g, '3D') === soloD3);
  T('♦A 没有换手（独狼）', ownerOf(c.g, 'AD') === soloAD);
  var pay3 = gives(c.room, 'max'), back3 = gives(c.room, 'pick');
  T('另外 3 人各交 3 张（共 9 张）',
    pay3.length === 3 && pay3.every(function (x) { return x.ids.length === 3; }) &&
    pay3.reduce(function (s, x) { return s + x.ids.length; }, 0) === 9);
  T('独狼一次拿出 9 张不要的牌',
    back3.length === 1 && back3[0].from === 0 && back3[0].count === 9 && back3[0].ids.length === 9);
  T('另外 3 人交出的是「除 3 和 ♦A 以外最大的 3 张」',
    pay3.every(function (x) { return sortIds(x.ids) === sortedIds(C.tributeMax(before3[x.from].map(byId), 3)); }));
  T('独狼拿出的牌不含 ♦3 / ♦A',
    back3.every(function (x) { return x.ids.every(function (id) { return id !== '3D' && id !== 'AD'; }); }));
  T('独狼赢：交换总张数 = 9', c.g.tribute.total === 9);
  T('另外 3 人的收牌顺序按交牌大小（最后一名自动拿剩下的）', checkTakeOrder(c.room, 0, 'max'));
  T('独狼那一方只有 1 人 ⇒ 直接收下 9 张',
    takes(c.room, 1).length === 1 && takes(c.room, 1)[0].ids.length === 9 && takes(c.room, 1)[0].auto === true);
  T('独狼赢：另外 3 人中交出最大牌的玩家先出', c.g.firstLeader === expectedLeader(pay3));

  /* ---------- ④ 独狼最后一名 + 已宣告：自己交出最大的 9 张 ---------- */
  console.log('— ④ 独狼最后一名 + 已宣告 —');
  var d = setup([[0], [1, 2, 3]], [1, 2, 3, 0], 0, true);
  d.room.nextRound(0);
  var before4 = snap(d.g);
  var d3Seat4 = ownerOf(d.g, '3D'), adSeat4 = ownerOf(d.g, 'AD');
  await wait(800 + 8 * 700 + 2000);
  T('独狼输：每人仍是 13 张', d.g.players.every(function (p) { return p.hand.length === 13; }));
  T('独狼输：♦3 / ♦A 都没有换手',
    ownerOf(d.g, '3D') === d3Seat4 && ownerOf(d.g, 'AD') === adSeat4);
  var pay4 = gives(d.room, 'max'), back4 = gives(d.room, 'pick');
  T('独狼交出 9 张（一次 9 张）',
    pay4.length === 1 && pay4[0].from === 0 && pay4[0].ids.length === 9);
  T('另外 3 人各拿出 3 张不要的牌',
    back4.length === 3 && back4.every(function (x) { return x.ids.length === 3; }) &&
    back4.reduce(function (s, x) { return s + x.ids.length; }, 0) === 9);
  T('独狼交出的是原手牌里「除 3 和 ♦A 以外最大的 9 张」',
    sortIds(pay4[0].ids) === sortedIds(C.tributeMax(before4[0].map(byId), 9)));
  T('独狼输：另外 3 人的收牌顺序按交牌大小', checkTakeOrder(d.room, 1, 'pick'));
  T('独狼输：只有他交最大的牌 ⇒ 独狼自己先出', d.g.firstLeader === 0 && d.g.leaderReason === 'tribute');

  /* ---------- ④b 独狼第 2 名 + 已宣告（v1.4.0）⇒ 交 6 收 6 ---------- */
  console.log('— ④b 独狼第 2 名 + 已宣告 —');
  var d2 = setup([[0], [1, 2, 3]], [1, 0, 2, 3], 0, true);
  d2.room.nextRound(0);
  await wait(800 + 8 * 700 + 2000);
  var pay4b = gives(d2.room, 'max'), back4b = gives(d2.room, 'pick');
  T('独狼第 2 名 + 已公布 ⇒ 独狼交 6 张',
    pay4b.length === 1 && pay4b[0].from === 0 && pay4b[0].ids.length === 6);
  T('独狼第 2 名 + 已公布 ⇒ 另外 3 人各还 2 张',
    back4b.length === 3 && back4b.every(function (x) { return x.ids.length === 2; }));
  T('独狼第 2 名：交换总张数 = 6', d2.g.tribute.total === 6);
  T('独狼第 2 名：每人仍 13 张', d2.g.players.every(function (p) { return p.hand.length === 13; }));

  /* ---------- ④c 独狼第 3 名 + 已宣告（v1.4.0）⇒ 谁都不交换 ---------- */
  console.log('— ④c 独狼第 3 名 + 已宣告 —');
  var d3 = setup([[0], [1, 2, 3]], [1, 2, 0, 3], 0, true);
  T('独狼第 3 名 + 已公布 ⇒ 不进贡', d3.g.tribute.kind === 'none' && d3.g.tribute.gives.length === 0);
  d3.room.nextRound(0);
  await wait(600);
  T('独狼第 3 名：不进贡 ⇒ 首出回到 ♣4 规则',
    d3.g.phase !== 'tribute' && d3.g.leaderReason === 'club4' && d3.g.requireClub4Lead === true);

  /* ---------- ⑤ 不进贡的局面（1、4 / 2、3）---------- */
  console.log('— ⑤ 平局不进贡 —');
  var e = setup([[0, 3], [1, 2]], [0, 1, 2, 3], null, false);
  T('1、4 名 ⇒ 不进贡', e.g.tribute.kind === 'none' && e.g.tribute.gives.length === 0);
  e.room.nextRound(0);
  await wait(600);
  T('不进贡时直接开局（无牌池）', e.g.phase !== 'tribute' && e.g.pools[0].length === 0);
  T('不进贡 ⇒ 首出回到 ♣4 规则且必须带 ♣4',
    e.g.leaderReason === 'club4' && e.g.requireClub4Lead === true);

  /* ---------- ⑥ 独狼「直接下一局」投降（v1.4.0）---------- */
  console.log('— ⑥ 独狼投降（直接下一局）—');
  var f = setup([[0], [1, 2, 3]], [], 0, false);
  f.g.phase = 'declare';
  f.g.soloCandidate = 0;
  f.g.soloSeat = 0;
  f.g.tribute = null;
  f.room.pendingDeclare = 0;
  f.room.onMessage(0, { type: 'declare', giveUp: 1 });
  T('投降后房间直接结算', f.g.phase === 'over' && f.g.declared === true);
  T('投降名次 = 独狼第 4、另外 3 人并列第 1',
    f.g.players.map(function (p) { return p.place; }).join(',') === '4,1,1,1');
  T('投降按交 9 收 9 进贡', f.g.tribute.kind === 'solo' && f.g.tribute.n === 3 && f.g.tribute.total === 9);
  f.room.nextRound(0);
  await wait(800 + 8 * 700 + 2000);
  var pay6 = gives(f.room, 'max'), back6 = gives(f.room, 'pick');
  T('投降 ⇒ 独狼实际交出 9 张',
    pay6.length === 1 && pay6[0].from === 0 && pay6[0].ids.length === 9);
  T('投降 ⇒ 另外 3 人各还 3 张',
    back6.length === 3 && back6.every(function (x) { return x.ids.length === 3; }));
  T('投降局：每人仍 13 张', f.g.players.every(function (p) { return p.hand.length === 13; }));

  console.log('\n结果：' + ok + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
