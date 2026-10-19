/* ============================================================
 * test-turns.js —— 出牌倒计时 / 超时代打 / 掉线托管 / 断线重连
 *
 * 前置：先起服务器（node server/index.js --port 8080）
 * 运行：node server/test-turns.js
 *
 * 说明：为了验证「15 秒不出牌自动代打」，这里真的要等 15 秒左右。
 *       想快点验证可改环境变量 TURN_WAIT（毫秒），但服务器仍是 15 秒。
 * ============================================================ */
'use strict';

const WebSocket = require('ws');
const URL = process.env.SVR || 'ws://127.0.0.1:8080/ws';
const WAIT_TURN = Number(process.env.TURN_WAIT || 23000);

let pass = 0, fail = 0;
const T = (n, c, extra) => {
  if (c) { pass++; }
  else { fail++; console.log('  ✗ ' + n + (extra ? '  → ' + extra : '')); }
};

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { ws, name, seat: -1, room: '', token: '', view: null, msgs: [] };
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      c.msgs.push(m);
      if (m.type === 'hello') {
        c.seat = m.seat; c.room = m.code; c.token = m.token || c.token;
        c.resumed = !!m.resumed;
      }
      if (m.type === 'room') c.roomInfo = m;
      if (m.type === 'state') { c.view = m.view; c.onState && c.onState(m.view); }
      if (m.type === 'askDeclare') {
        c.askDeclare = true;
        // 测试里不关心独狼宣告，一律「不宣告」，让牌局继续
        c.send({ type: 'declare', yes: false });
      }
      if (m.type === 'resumeFail') { c.resumeFail = m; c.resumeFailCode = m.code; }
      if (m.type === 'ready') { c.readyList = m.list; c.readyAll = m.all; c.readyWaiting = m.waiting; }
      if (m.type === 'roundBegin') c.roundBegin = (c.roundBegin || 0) + 1;
    });
    c.send = o => { try { ws.send(JSON.stringify(o)); } catch (e) { } };
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(80); }
  return false;
}
function hasAuto(c, seat) {
  return c.msgs.some(m => m.type === 'auto' && m.seat === seat);
}

(async function main() {
  console.log('— 连接与开局 —');
  const a = await client('小明');
  const b = await client('小红');
  a.send({ type: 'create', name: '小明', avatar: '🙂' });
  await until(() => a.room);
  const code = a.room;
  b.send({ type: 'join', code, name: '小红', avatar: '😀' });
  await until(() => b.seat >= 0);
  T('两名真人入座', a.seat === 0 && b.seat === 1);
  T('拿到重连凭据 token', !!a.token && !!b.token);

  // v1.3.6：全员准备后才能开局
  a.send({ type: 'ready', on: true });
  b.send({ type: 'ready', on: true });
  await until(() => a.readyAll === true, 3000);
  a.send({ type: 'start' });
  T('开局并下发状态', await until(() => a.view && a.view.phase === 'playing', 6000));
  T('状态里带 15 秒倒计时', await until(() => a.view && a.view.turnLeft > 0, 4000),
    a.view ? 'turnLeft=' + a.view.turnLeft : 'no view');

  console.log('— 超时自动出牌（等 15 秒）—');
  // 找一个「轮到真人」的时机，然后故意不出牌
  await until(() => {
    const v = a.view;
    return v && v.phase === 'playing' && (v.turn === a.seat || v.turn === b.seat);
  }, 15000);
  const slowSeat = a.view && a.view.turn;
  const slowClient = slowSeat === a.seat ? a : b;
  const beforeRound = a.view ? a.view.played.length : 0;
  const beforeTurn = a.view ? a.view.turn : -1;
  T('轮到真人出牌', beforeTurn === a.seat || beforeTurn === b.seat, 'turn=' + beforeTurn);

  const autoed = await until(() => hasAuto(a, slowSeat) || (a.view && a.view.turn !== beforeTurn), WAIT_TURN);
  T('15 秒不出牌 → 系统自动代打', autoed);
  T('自动代打后牌局继续', !!a.view && (a.view.played.length >= beforeRound || a.view.turn !== beforeTurn));
  const autoMsg = a.msgs.filter(m => m.type === 'auto' && m.seat === slowSeat)[0];
  T('收到「超时自动出牌」提示', !!autoMsg && autoMsg.reason === 'timeout',
    autoMsg ? 'reason=' + autoMsg.reason : 'no auto msg');

  console.log('— 掉线托管 —');
  // 让 B 掉线，A 一直在线观察
  const bSeat = b.seat;
  try { b.ws.close(); } catch (e) { }
  const offOk = await until(() => a.view && a.view.offline && a.view.offline[bSeat], 6000);
  T('掉线后其他人立刻看到「离线」', offOk);
  T('掉线玩家自动进入托管', !!a.view && a.view.trustee && a.view.trustee[bSeat] === true);

  // 掉线期间轮到 B 时，服务器会直接代打
  const autoWhileOff = await until(() => hasAuto(a, bSeat) || (a.view && a.view.turn !== bSeat), 15000);
  T('掉线期间轮到他会自动出牌', autoWhileOff);

  console.log('— 断线重连（v1.3.4：本局没打完不许回座）—');
  const b2 = await client('小红');
  b2.send({ type: 'resume', code, token: b.token });
  await until(() => b2.resumeFail, 6000);
  T('本局进行中，凭 token 回座被拒绝', b2.resumeFailCode === 'INGAME',
    b2.resumeFail ? 'code=' + b2.resumeFailCode : 'no reply');
  T('拒绝时说明什么时候能回来', /等这一局结束/.test((b2.resumeFail || {}).msg || ''));
  T('座位仍在（由系统托管打完本局）', !!a.view && a.view.offline[bSeat] === true);
  T('掉线玩家回来不会打扰牌桌', !!a.view && a.view.trustee[bSeat] === true);
  await wait(400);
  T('重连被拒的过程中牌局照常推进', !!a.view && a.view.phase === 'playing');

  console.log('— 主动托管 —');
  // A 打开托管：轮到他时应很快自动出牌
  a.send({ type: 'trustee', on: true });
  T('托管状态下发到本人', await until(() => a.view && a.view.myTrustee === true, 4000));
  const aSeat = a.seat;
  const autoTrustee = await until(() => hasAuto(a, aSeat) || (a.view && a.view.turn !== aSeat), 25000);
  T('托管后轮到他自动出牌', autoTrustee);
  a.send({ type: 'trustee', on: false });
  T('可以取消托管', await until(() => a.view && a.view.myTrustee === false, 4000));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  try { a.ws.close(); b2.ws.close(); } catch (e) { }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('测试异常：' + (e && e.stack || e));
  process.exit(1);
});
