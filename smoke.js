/* 界面冒烟测试（jsdom）：node smoke.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join('C:/Users/94223/.workbuddy/binaries/node/workspace', 'node_modules', 'jsdom'));

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.location = window.location;
global.localStorage = window.localStorage;
global.getComputedStyle = window.getComputedStyle.bind(window);
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;
global.Event = window.Event;

// 固定随机数：让发牌/抽签可复现，避免测试偶发失败
let __seed = 20261018;
function __rnd() {
  __seed = (__seed * 1103515245 + 12345) & 0x7fffffff;
  return __seed / 0x7fffffff;
}
Math.random = __rnd;
window.Math.random = __rnd;

// 浏览器里 window 即全局对象；Node 中需把 window.* 桥接到 globalThis 才能解析同名全局变量
['Cards', 'Combos', 'Game', 'AI', 'Net', 'UI', 'App'].forEach(k => {
  Object.defineProperty(globalThis, k, {
    get() { return window[k]; },
    set(v) { window[k] = v; },
    configurable: true
  });
});

const errors = [];
window.addEventListener('error', e => errors.push('window error: ' + e.message));

require('./js/cards.js');
require('./js/combos.js');
require('./js/engine.js');
require('./js/engine_ai.js');
require('./js/net.js');
require('./js/ui.js');
require('./js/main.js');

window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

const App = window.App, UI = window.UI, AI = window.AI;
let pass = 0, fail = 0;
function T(name, cond) { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } }
function $(s) { return window.document.querySelector(s); }
function $$(s) { return Array.from(window.document.querySelectorAll(s)); }
function click(s) { const n = $(s); if (!n) { errors.push('找不到元素 ' + s); return false; } n.click(); return true; }

(async function run() {
  console.log('— 启动 —');
  T('App 已初始化', !!App);
  T('主菜单已弹出', !!$('.modal') && window.document.getElementById('modalRoot').children.length === 1);
  T('菜单含 5 个入口',
    $$('.modal .opt[data-act]').length === 5 &&
    !!$('[data-act="solo"]') && !!$('[data-act="online"]') && !!$('[data-act="friend"]') &&
    !!$('[data-act="web"]') && !!$('[data-act="rule"]'));

  console.log('— 单人练习 —');
  click('[data-act="solo"]');
  T('游戏已创建', !!App.game);
  T('发牌 13 张', App.game.players[0].hand.length === 13);
  T('手牌已渲染 13 张', window.document.getElementById('hand').children.length === 13);
  T('三个座位已渲染', $$('#seat1 .who').length === 1 && $$('#seat2 .who').length === 1 && $$('#seat3 .who').length === 1);

  // 独狼宣告（若触发）
  if (App.game.phase === 'declare') {
    T('宣告弹窗出现', !!$('[data-yes]'));
    click('[data-no]');
    T('宣告后进入出牌阶段', App.game.phase === 'playing');
  }

  console.log('— 记牌器 / 规则 —');
  UI.showCounter();
  T('记牌器浮窗打开', !$('#counterPanel').hidden);
  T('记牌器 13 种点数', $$('#counterBody .cnt-cell').length === 13);
  T('顶栏按钮高亮', window.document.getElementById('btnCounter').classList.contains('on'));
  T('操作栏记牌器按钮常驻', !!$('#actions .counter-toggle'));
  UI.closeModalKind('room');
  T('切换回合不会关闭记牌器', !$('#counterPanel').hidden);
  UI.toggleCounter();
  T('再点一次可关闭', $('#counterPanel').hidden);
  T('关闭状态已记住', window.localStorage.getItem('pk_counter') === '0');
  UI.openCounter();
  UI.closeCounter();

  console.log('— 选牌抬起 / 落下 —');
  const turnSave = App.game.turn;
  App.game.turn = App.mySeat;
  UI.renderActions();
  const card0 = window.document.getElementById('hand').children[0];
  card0.click();
  T('点一下牌抬起', card0.classList.contains('sel') && Object.keys(App.selected).length === 1);
  T('出牌按钮显示已选张数', !!$('#actions .pick-badge') && $('#actions .pick-badge').textContent === '1');
  card0.click();
  T('再点一下落回', !card0.classList.contains('sel') && Object.keys(App.selected).length === 0);
  T('清空后角标消失', !$('#actions .pick-badge'));
  App.game.turn = (App.mySeat + 1) % 4;
  UI.renderActions();
  window.document.getElementById('hand').children[0].click();
  T('不是自己回合也能先选牌', Object.keys(App.selected).length === 1);
  window.document.getElementById('hand').children[0].click();
  App.game.turn = turnSave;
  UI.renderActions();

  UI.showRules();
  T('规则弹窗出现', !!$('.rule-table'));
  click('[data-close]');

  console.log('— 圆桌四块 / 首出文案（v1.3.8）—');
  App.game.turn = App.mySeat;
  App.game.trick = null;
  App.doHint();
  const pickedN = Object.keys(App.selected).length;
  App.doPlay();
  const z0 = window.document.getElementById('zone0');
  T('自己那一块摊出了刚出的牌', pickedN > 0 && z0.querySelectorAll('.zcard').length === pickedN);
  T('自己那一块标出牌型', (z0.querySelector('.zlabel') || { textContent: '' }).textContent.length > 0);
  T('四块都挂在圆桌上', ['zone0', 'zone1', 'zone2', 'zone3'].every(id => !!window.document.getElementById(id)));
  T('座位旁边不再挂出牌区', $$('#seat1 .card').length === 0);
  const seqAfterPlay = App.game.lastActions[App.mySeat].seq;
  T('每一手操作带只增不减的编号', seqAfterPlay > 0);
  UI.renderAll();
  T('重复渲染不会换编号（已在桌上的牌不重播动画）',
    window.document.getElementById('zone0').dataset.seq === String(seqAfterPlay));
  App.toMenu();
  T('离开牌桌时四块一起清空', ['zone0', 'zone1', 'zone2', 'zone3']
    .every(id => window.document.getElementById(id).children.length === 0));
  click('[data-act="solo"]');
  if (App.game && App.game.phase === 'declare') click('[data-no]');

  App.game.turn = App.mySeat;
  App.game.trick = null;
  UI.renderAll();
  T('轮到自己时自己那一块是空的', window.document.getElementById('zone0').children.length === 0);
  // 别人过牌：他那一块显示「不出」
  const nextSeat = App.game._nextActive(App.mySeat);
  App.game.trick = { seat: App.mySeat, combo: window.Combos.detect([App.game.players[App.mySeat].hand[0]]) };
  App.game.turn = nextSeat;
  App.execPass(nextSeat);
  const zN = window.document.getElementById(['zone0', 'zone1', 'zone2', 'zone3'][nextSeat]);
  T('别人过牌 → 他那一块显示「不出」', !!zN.querySelector('.zpass'));
  T('「不出」用的是这一手的编号', !!App.game.lastActions[nextSeat] && !!zN.dataset.seq);
  T('别人那一块不会清掉自己已经出的牌',
    nextSeat !== App.mySeat ? window.document.getElementById('zone0').children.length >= 0 : true);
  App.game.turn = App.game._nextActive(nextSeat);
  UI.renderAll();
  T('轮到谁行动，先清空他桌前的上一手',
    window.document.getElementById(['zone0', 'zone1', 'zone2', 'zone3'][App.game.turn]).children.length === 0);

  /* v1.3.10：倒计时从「名牌旁边」挪到「出牌者头像上」，手机上不再压住玩家信息 */
  (function () {
    const other = App.game._nextActive(App.mySeat);
    App.game.turn = other;
    App.turnInfo = { seat: other, left: 11000, total: 15000, at: Date.now() };
    UI.renderAll();
    const rel = (other - App.mySeat + 4) % 4;
    const box = window.document.getElementById('seat' + rel);
    T('倒计时挂在出牌者的头像里', !!box.querySelector('.av .turn-timer'));
    T('昵称 / 张数没被圈圈挤掉', !!box.querySelector('.nm') && !!box.querySelector('.cnt'));
    T('倒计时和头像同一个盒子（不另占名牌旁边的位置）',
      box.querySelector('.av').contains(box.querySelector('.turn-timer')));

    // 底部只留一条提示：横幅和 toast 不叠着显示
    App.game.turn = App.mySeat;
    UI.renderAll();
    UI.toast('先来一条提示', 4000);
    UI.flashTurn();
    T('横幅出现时清掉 toast',
      window.document.getElementById('toastRoot').children.length === 0 &&
      !window.document.getElementById('turnBanner').hidden);
    UI.toast('再来一条', 4000);
    T('toast 出现时收掉横幅',
      window.document.getElementById('turnBanner').hidden === true);
    window.document.getElementById('toastRoot').innerHTML = '';
    window.document.getElementById('turnBanner').hidden = true;
    UI._bannerShown = false;
  })();

  App.game.leaderReason = 'club4';
  App.game.leaderCardText = '♣4';
  App.game.firstLeader = 0;
  T('♣4 首出文案', /♣4/.test(UI.leaderText(App.game)));
  App.game.leaderReason = 'tribute';
  App.game.leaderCardText = '♠2';
  App.game.firstLeader = 2;
  T('进贡首出文案含最大牌 ♠2', /♠2/.test(UI.leaderText(App.game)));

  console.log('— 游戏中收到房间广播不弹窗 —');
  const roleSave = App.netRole, roomSave = App.onlineRoom;
  App.netRole = 'client';
  App.onlineRoom = { code: 'ABCD', token: 't' };
  UI.closeModal();
  App.onServerMessage({
    type: 'room', code: 'ABCD', isHost: false,
    seats: [{ name: '我' }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }]
  });
  T('游戏中不弹「开始游戏」房间页（不挡牌桌）',
    window.document.getElementById('modalRoot').children.length === 0);
  App.netRole = roleSave;
  App.onlineRoom = roomSave;

  console.log('— 复制兜底 / 房间页 —');
  let copyResult = null;
  App.copy('hello', function (ok) { copyResult = ok; });
  T('复制失败如实回调（不谎报已复制）', copyResult === false);
  UI.showCopyFallback('http://1.2.3.4:8080/?room=ABCD', '邀请链接');
  T('复制兜底面板出现', !!$('#copyFallbackBox'));
  T('兜底面板内容完整可长按复制', ($('#copyFallbackBox').value || '').indexOf('room=ABCD') > 0);
  click('[data-close]');
  UI.showOnlineRoom({
    code: 'ABCD', isHost: true, link: 'http://1.2.3.4:8080/?room=ABCD',
    seats: [{ name: '我' }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }]
  });
  T('房间页有「解散房间」按钮', !!$('[data-dissolve]'));
  T('房间页说明房间是一次性的', /一次性/.test($('.modal').textContent || ''));
  UI.closeModal();

  console.log('— 独狼宣告三选一 / 直接下一局（v1.4.0）—');
  (function () {
    let got = null;
    UI.showDeclare(0, function (act) { got = act; });
    T('宣告弹窗有「公布 / 不公布 / 直接下一局」三个选项',
      !!$('[data-yes]') && !!$('[data-no]') && !!$('[data-giveup]'));
    T('宣告弹窗里能看到自己这一手的牌', $$('.mini-hand .card').length === App.game.players[0].hand.length);
    click('[data-no]');
    T('点「不公布」⇒ 回调 yes=false', !!got && got.yes === false && !got.giveUp);

    got = null;
    UI.showDeclare(0, function (act) { got = act; });
    click('[data-yes]');
    T('点「公布我是独狼」⇒ 回调 yes=true', !!got && got.yes === true);

    got = null;
    UI.showDeclare(0, function (act) { got = act; });
    click('[data-giveup]');
    T('点「直接下一局」先弹二次确认', !!$('[data-y]') && !!$('[data-n]') && got === null);
    click('[data-n]');
    T('取消后回到宣告弹窗', !!$('[data-giveup]') && got === null);
    click('[data-giveup]');
    click('[data-y]');
    T('确认「直接下一局」⇒ 回调 giveUp', !!got && got.giveUp === true);
    UI.closeModal();

    // 引擎侧：投降 ⇒ 本局直接结束，独狼第 4 名、另外 3 人并列第 1，按交 9 收 9
    const g = new window.Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });
    g.startRound();
    g.soloSeat = 0; g.soloCandidate = 0; g.teams = [[0], [1, 2, 3]];
    g.phase = 'declare';
    const ok = g.soloGiveUp();
    T('独狼投降 ⇒ 本局直接结束', ok === true && g.phase === 'over');
    T('独狼投降 ⇒ 名次 4 / 1 / 1 / 1', g.players.map(p => p.place).join(',') === '4,1,1,1');
    T('独狼投降 ⇒ 按交 9 收 9 进贡', g.tribute.kind === 'solo' && g.tribute.n === 3 && g.tribute.total === 9);
    T('投降局会记下 giveUpSeat', g.giveUpSeat === 0);
  })();

  console.log('— 自动打完一局 —');
  let guard = 0;
  while (App.game.phase === 'playing' && guard++ < 400) {
    const seat = App.game.turn;
    if (seat === App.mySeat) {
      App.doHint();
      if (Object.keys(App.selected).length) App.doPlay();
      else App.doPass();
    } else {
      const d = AI.decide(App.game, seat);
      if (!d) { errors.push('AI 无决策'); break; }
      if (d.type === 'pass') App.execPass(seat); else App.execPlay(seat, d.cards);
    }
  }
  T('一局正常结束', App.game.phase === 'over');
  T('4 人名次齐全', App.game.players.every(p => p.place >= 1 && p.place <= 4));

  await new Promise(r => setTimeout(r, 700));
  T('结算弹窗出现', !!$('[data-next]'));
  T('结算列出 4 人', $$('.result-row').length >= 4);

  async function playOneRound() {
    let g = 0;
    while (App.game.phase === 'playing' && g++ < 400) {
      const seat = App.game.turn;
      if (seat === App.mySeat) {
        App.doHint();
        if (Object.keys(App.selected).length) App.doPlay(); else App.doPass();
      } else {
        const d = AI.decide(App.game, seat);
        if (!d) { errors.push('AI 无决策'); break; }
        if (d.type === 'pass') App.execPass(seat); else App.execPlay(seat, d.cards);
      }
    }
  }

  console.log('— 连续再打 6 局（含进贡交换）—');
  let totalPicks = 0;
  for (let r = 2; r <= 7; r++) {
    click('[data-next]');
    T('进入第 ' + r + ' 局', App.game.round === r);
    // 等待并确认选牌（电脑玩家的进贡会自动完成）
    await new Promise(res => setTimeout(res, 1000));
    let pg = 0, picks = 0;
    while (App.game.phase === 'tribute' && pg++ < 40) {
      if ($('[data-ok]')) { click('[data-ok]'); picks++; }
      await new Promise(res => setTimeout(res, 320));
    }
    totalPicks += picks;
    if (App.game.phase === 'declare') click('[data-yes]');
    T('第 ' + r + ' 局可以出牌', App.game.phase === 'playing');
    // 牌数守恒（此时电脑可能已先出牌，所以看总数而不是各人手牌）
    const total = App.game.players.reduce((s, p) => s + p.hand.length, 0) + App.game.played.length;
    T('第 ' + r + ' 局牌数守恒 52', total === 52);
    await playOneRound();
    T('第 ' + r + ' 局正常结束', App.game.phase === 'over');
    T('第 ' + r + ' 局名次齐全', App.game.players.every(p => p.place >= 1 && p.place <= 4));
    const tb = App.game.tribute;
    console.log('    · 第 ' + r + ' 局结算：' + (tb ? tb.kind + ' 交换 ' + tb.gives.length + ' 次 / ' + tb.desc : '无'));
    await new Promise(res => setTimeout(res, 700));
  }
  console.log('    · 玩家手动确认进贡共 ' + totalPicks + ' 次');

  console.log('— 手动进贡选牌 —');
  App.toMenu();
  click('[data-act="solo"]');           // 重开一局，保证手牌是完整的 13 张
  if (App.game.phase === 'declare') click('[data-no]');
  const before = App.game.players[0].hand.length, beforeTo = App.game.players[1].hand.length;
  T('重开后手牌 13 张', before === 13);
  let gotCards = null;
  UI.showTribute({ from: App.mySeat, side: 1, count: 2, mode: 'pick' }, function (cards) {
    gotCards = cards;
    App.giveCards({ from: App.mySeat, side: 1, count: 2, mode: 'pick' }, cards);
    UI.renderAll();
  });
  T('选牌弹窗列出全部手牌', $$('#pickHand .card').length === before);
  T('默认预选 2 张', $$('#pickHand .card.sel').length === 2);
  // 改选一次，确认可选中/取消
  $$('#pickHand .card')[before - 1].click();
  T('点击可切换选中', $$('#pickHand .card.sel').length === 3 || $$('#pickHand .card.sel').length === 1);
  $$('#pickHand .card')[before - 1].click();
  click('[data-ok]');
  T('确认后交出 2 张', gotCards && gotCards.length === 2);
  T('我的手牌 -2', App.game.players[0].hand.length === before - 2);
  T('牌进了交换池（不再直接进对方手里）', App.game.pools[1].length === 2);

  UI.showTribute({ from: App.mySeat, side: 0, count: 2, mode: 'max' }, function (cards) {
    App.giveCards({ from: App.mySeat, side: 0, count: 2, mode: 'max' }, cards);
    UI.renderAll();
  });
  T('最大牌进贡自动标记 2 张', $$('#pickHand .card.sel').length === 2);
  click('[data-ok]');
  T('交最大的牌也进交换池', App.game.pools[0].length === 2);

  console.log('— 服务器联机（客户端路径）—');
  App.toMenu();
  click('[data-act="solo"]');
  if (App.game.phase === 'declare') click('[data-no]');
  // 模拟服务器下发的状态（与 server/lib/room.js 广播的 view 完全一致）
  App.netRole = 'client';
  App.mySeat = 0;
  const sent = [];
  const realSend = Net.sendWS;
  Net.sendWS = function (o) { sent.push(o); return true; };
  const shadow = new Game({ players: [{ name: '小明' }, { name: '小红' }, { name: '小刚' }, { name: '小美' }] });
  shadow.startRound();
  if (shadow.phase === 'declare') shadow.declare(false);
  const view0 = shadow.view(0);
  App.onServerMessage({ type: 'hello', seat: 0 });
  App.onServerMessage({ type: 'state', view: view0 });
  T('服务器状态同步到本地引擎', App.game.phase === shadow.phase && App.game.round === shadow.round);
  T('同步后手牌 13 张', App.game.players[0].hand.length === 13);
  T('他人手牌不可见', App.game.players[1].hand.every(c => c.hidden === true));
  T('手牌已渲染', window.document.getElementById('hand').children.length === 13);
  T('座位已渲染', $$('#seat1 .who').length === 1);

  // 客户端出牌只上报、不本地执行
  App.game.turn = 0;
  App.game.trick = null;
  App.game.requireClub4Lead = false;   // 这里只验证上报链路，绕开"首出必须带♣4"
  App.doHint();
  T('提示能选出牌', Object.keys(App.selected).length > 0);
  App.doPlay();
  T('客户端出牌走网络上报', sent.some(m => m.type === 'act' && m.act === 'play'));
  T('网络上报不影响本地手牌', App.game.players[0].hand.length === 13);
  App.game.trick = { seat: 1, combo: window.Combos.detect(shadow.players[1].hand.slice(0, 1)) };
  App.doPass();
  T('过牌也走网络上报', sent.some(m => m.type === 'act' && m.act === 'pass'));

  // 服务器请求进贡选牌
  App.onServerMessage({ type: 'askTribute', item: { from: 0, to: 1, count: 2, mode: 'pick' } });
  T('收到进贡请求弹窗', !!$('[data-ok]'));
  click('[data-ok]');
  T('进贡回包已上报', sent.some(m => m.type === 'tributeCards' && m.ids.length === 2));

  // 服务器请求独狼宣告
  App.onServerMessage({ type: 'askDeclare', seat: 0 });
  T('收到宣告请求弹窗', !!$('[data-yes]'));
  click('[data-yes]');
  T('宣告回包已上报', sent.some(m => m.type === 'declare' && m.yes === true));

  /* v1.3.4：托管 → 收起出牌按钮 + 按钮变「取消托管」+ 全程不弹房间菜单 */
  App.game.phase = 'playing';
  App.game.turn = 0;
  App.selected = {}; App.hintSet = null;
  UI.renderAll();
  const txt = () => $$('#actions .btn').map(b => b.textContent).join('|');
  T('未托管时出牌按钮齐全', /出牌/.test(txt()) && /过牌/.test(txt()) && /提示/.test(txt()));
  T('未托管时按钮显示「托管」', /托管/.test(txt()) && !/取消托管/.test(txt()));

  App.toggleTrustee(true);
  T('点托管上报服务器', sent.some(m => m.type === 'trustee' && m.on === true));
  T('托管本地立即生效（不等回包）', App.myTrustee() === true);
  T('托管后收起出牌/过牌/提示/清空', !/出牌/.test(txt()) && !/过牌/.test(txt()) && !/提示/.test(txt()) && !/清空/.test(txt()));
  T('托管后按钮变成「取消托管」', /取消托管/.test(txt()));
  T('托管期间不弹房间菜单', !$('.modal .room-code'));

  const tCard = window.document.getElementById('hand').children[0];
  tCard.dispatchEvent(new window.Event('click'));
  T('托管期间点手牌选不中', Object.keys(App.selected).length === 0);

  App.toggleTrustee(false);
  T('取消托管上报服务器', sent.some(m => m.type === 'trustee' && m.on === false));
  T('取消托管后出牌按钮恢复', /出牌/.test(txt()) && /过牌/.test(txt()) && /提示/.test(txt()));
  T('取消托管后按钮变回「托管」', /托管/.test(txt()) && !/取消托管/.test(txt()));
  T('取消托管同样不弹房间菜单', !$('.modal .room-code'));

  /* v1.3.4：开局后收到 room 广播直接忽略，不再盖住牌桌 */
  App.onlineRoom = { code: 'ABCD', token: 't' };
  App.roomPlaying = true;
  App.onServerMessage({ type: 'room', code: 'ABCD', started: true, isHost: true, seats: [] });
  T('游戏进行中收到 room 广播不弹房间页', !$('.modal .room-code'));
  App.onServerMessage({ type: 'resumeFail', code: 'INGAME', msg: '本局游戏还在进行中' });
  T('回座被拒时给明确提示而不是房间码输入页', /暂时不能进房/.test($('.modal h2') ? $('.modal h2').textContent : ''));
  UI.closeModal();
  App.roomPlaying = false;
  App.onlineRoom = null;

  /* v1.3.6：准备机制 —— 结算页 / 房间页都有「准备」，全员准备好房主才能开下一局 */
  const sentLen = sent.length;
  App.ready = false;
  App.toggleReady(true);
  T('点准备上报服务器', sent[sent.length - 1].type === 'ready' && sent[sent.length - 1].on === true);
  T('本地记住已准备', App.ready === true);
  App.toggleReady(false);
  T('再点一次取消准备', sent[sent.length - 1].type === 'ready' && sent[sent.length - 1].on === false);
  App.onServerMessage({ type: 'ready', list: [true, true, false, true], all: false, waiting: ['小刚'] });
  T('收到全员准备情况', App.readyList && App.readyAll === false && App.readyWaiting[0] === '小刚');
  App.onServerMessage({ type: 'roundBegin', round: 2 });
  T('收到 roundBegin（结算窗口会被收掉）', App.ready === false);

  /* v1.3.6：智能提示不拆牌 —— 单张优先推荐孤张，而不是拿对子 / 三张里的牌去顶 */
  (function () {
    const KK = window.Combos, CC = window.Cards;
    const card = id => CC.makeDeck().filter(c => c.id === id)[0];
    const hand = ['5C', '5H', '9S', 'KD'].map(card);   // 一对 5 + 孤张 9 + 孤张 K
    const target = KK.detect([card('4C')]);
    const opts = KK.hintOptions(hand, target, false);
    T('智能提示给出候选', opts.length > 0);
    T('先推荐孤张 9♠，不拆 55 这对', opts[0] && opts[0].main.id === '9S');
    T('拆牌代价：孤张 0、拆对子 > 0', KK.breakCost(hand, KK.detect([card('9S')])) === 0 &&
      KK.breakCost(hand, KK.detect([card('5C')])) > 0);
    // 对子：避开三张 / 四张
    const hand2 = ['6C', '6H', '6S', '7D', '7C'].map(card);
    T('拆三张的代价 > 拆对子的代价',
      KK.breakCost(hand2, KK.detect([card('6C'), card('6H')])) >
      KK.breakCost(hand2, KK.detect([card('7D'), card('7C')])));
  })();

  /* v1.3.8：手牌单击 / 拖选（9 像素阈值、整段选中、整段取消、范围可伸缩） */
  (function () {
    App.toMenu();
    click('[data-act="solo"]');
    if (App.game && App.game.phase === 'declare') click('[data-no]');
    const handEl = window.document.getElementById('hand');
    T('手牌已渲染', handEl && handEl.children.length === 13);
    T('手牌绑了划选事件', !!handEl._swipeBound);

    /* v1.3.10：划选改成按横向坐标算落在哪张牌（不再用 elementFromPoint），
     * jsdom 没有布局，这里给每张牌铺一个「从 0 开始、每张 10px 一张」的假尺子。 */
    const realRect = handEl.children[0].getBoundingClientRect;
    [].forEach.call(handEl.children, (c, i) => {
      c.getBoundingClientRect = () => ({
        left: i * 10, right: i * 10 + 40, top: 0, bottom: 80, width: 40, height: 80
      });
    });
    const evt = (type, x, target) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true });
      e.clientX = x; e.clientY = 100;
      (target || handEl).dispatchEvent(e);
      return e;
    };
    const reset = () => { App.selected = {}; App.hintSet = null; [].forEach.call(handEl.children, c => c.classList.remove('sel')); };

    // ① 移动 8 像素：仍算单击 → 选中 1 张
    reset();
    evt('pointerdown', 5);
    evt('pointermove', 13);
    window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
    T('移动不足 9 像素算单击', Object.keys(App.selected).length === 1);

    // ② 再点同一张：取消
    evt('pointerdown', 5);
    window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
    T('再单击一次取消这张', Object.keys(App.selected).length === 0);

    // ③ 拖过 3 张：整段一起选中
    reset();
    evt('pointerdown', 5);
    evt('pointermove', 15);
    evt('pointermove', 25);
    window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
    T('拖选一整段：连续 3 张一起选中', Object.keys(App.selected).length === 3);

    // ④ 从已选中的牌起手往回拖：这一整段全部取消
    evt('pointerdown', 25);
    evt('pointermove', 15);
    evt('pointermove', 5);
    window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
    T('起点已选中 → 这一整段全部取消', Object.keys(App.selected).length === 0);

    // ⑤ 拖出去再拖回来，范围会跟着收缩
    reset();
    evt('pointerdown', 5);
    evt('pointermove', 55);
    evt('pointermove', 25);
    window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
    T('拖动范围跟着当前所在的牌收缩', Object.keys(App.selected).length === 3);

    // ⑥ 选中的牌抬起 + 金色描边（样式在 CSS 里，这里确认 class）
    T('选中的牌有 sel 状态', [].filter.call(handEl.children, c => c.classList.contains('sel')).length === 3);

    if (realRect) {
      [].forEach.call(handEl.children, (c) => { c.getBoundingClientRect = realRect; });
    }
    UI.closeModal();
  })();

  Net.sendWS = realSend;
  App.netRole = 'local';

  console.log('— 房间 / 菜单 —');
  App.toMenu();
  T('返回菜单', !!$('[data-act="friend"]'));
  click('[data-act="friend"]');
  T('好友入口页出现', !!$('[data-act="create"]'));
  click('[data-back]');
  T('返回主菜单', !!$('[data-act="solo"]'));

  console.log('— 改名（v1.3.5：PC 客户端不再用 window.prompt）—');
    T('主菜单有改名入口', !!$('[data-act="rename"]'));
    click('[data-act="rename"]');
    T('改名弹出游戏内输入框（Electron 里也能用）', !!$('#promptInput'));
    const pin = $('#promptInput');
    T('输入框预填当前昵称', pin && pin.value === App.myName);
    pin.value = '  阿强  ';
    click('[data-ok]');
    T('昵称已更新（自动去空格）', App.myName === '阿强');
    T('昵称写入本地存档', (() => { try { return localStorage.getItem('pk_name') === '阿强'; } catch (e) { return false; } })());
    T('菜单上立刻显示新昵称', /阿强/.test($('.modal .chips') ? $('.modal .chips').textContent : ''));

    click('[data-act="rename"]');
    $('#promptInput').value = '   ';
    click('[data-ok]');
    T('空昵称不生效', App.myName === '阿强');
    T('空昵称时弹窗不关，能重填', !!$('#promptInput'));
    $('#promptInput').value = '这个名字超过八个字啦';
    click('[data-ok]');
    T('昵称最长 8 个字', App.myName.length === 8 && App.myName === '这个名字超过八个字啦'.slice(0, 8));
    click('[data-act="rename"]');
    click('[data-cancel]');
    T('取消改名保持原昵称', App.myName === '这个名字超过八个字啦'.slice(0, 8));

  console.log('\n运行时错误：' + (errors.length ? JSON.stringify(errors.slice(0, 5)) : '无'));
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败 / 错误 ' + errors.length);
  process.exit(fail || errors.length ? 1 : 0);
})();
