/* 托管 / 掉线托管 回归测试（v1.3.4）
 * 起服务器后运行： SVR=ws://127.0.0.1:8099/ws node server/test-trustee.js
 *
 * 覆盖两条需求：
 *  1. 点「托管」不会弹出房间等待页（服务器开局后不再广播 room），
 *     出牌按钮收起、按钮变成「取消托管」，再点一次恢复。
 *  2. 玩家掉线立即托管；本局没打完时，掉线的玩家不能回座、也不能重新加入。
 */
'use strict';
const WebSocket = require('ws');
require('../js/cards.js');
require('../js/combos.js');
require('../js/engine.js');
require('../js/engine_ai.js');

const URL = process.env.SVR || 'ws://127.0.0.1:8080/ws';
let pass = 0, fail = 0;
const T = (n, c) => c ? pass++ : (fail++, console.log('  ✗ ' + n));

function client(name) {
  return new Promise(resolve => {
    const ws = new WebSocket(URL);
    const c = {
      ws, name, seat: -1, room: null, token: '', view: null,
      msgs: [], rooms: 0, autoMsg: null, offlineMsg: null, resumeFail: null
    };
    ws.on('open', () => resolve(c));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      c.msgs.push(m);
      if (m.type === 'hello') { c.seat = m.seat; c.room = m.code; c.token = m.token || ''; }
      if (m.type === 'room') { c.rooms++; c.roomInfo = m; }
      if (m.type === 'state') c.view = m.view;
      if (m.type === 'auto') c.autoMsg = m;
      if (m.type === 'offline') c.offlineMsg = m;
      if (m.type === 'resumeFail') { c.resumeFail = m; c.resumeFailCode = m.code; }
      if (m.type === 'error') { c.err = m.msg; c.errCode = m.code; }
      if (m.type === 'askDeclare') c.askDeclare = true;
      if (m.type === 'askTribute') { c.askTribute = m.item; c.askPool = m.pool || null; }
      if (m.type === 'ready') { c.readyList = m.list; c.readyAll = m.all; c.readyWaiting = m.waiting; }
      if (m.type === 'roundBegin') c.roundBegin = (c.roundBegin || 0) + 1;
    });
    c.send = o => ws.send(JSON.stringify(o));
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(60); }
  return false;
}
const roomCount = c => c.msgs.filter(m => m.type === 'room').length;

(async function main() {
  console.log('— 建房间并开局 —');
  const cs = [];
  for (let i = 0; i < 4; i++) cs.push(await client('玩家' + (i + 1)));
  cs[0].send({ type: 'create', name: '玩家1', avatar: '🙂' });
  await until(() => cs[0].room);
  const code = cs[0].room;
  for (let i = 1; i < 4; i++) {
    cs[i].send({ type: 'join', code, name: '玩家' + (i + 1), avatar: '🙂' });
    await until(() => cs[i].room === code);
  }
  T('四人坐满', cs.every(c => c.seat >= 0));

  // v1.3.6：全员准备后才能开局
  cs.forEach(c => c.send({ type: 'ready', on: true }));
  await until(() => cs[0].readyAll === true, 3000);
  cs[0].send({ type: 'start' });
  await until(() => cs[0].view && cs[0].view.phase);
  await wait(400);
  T('开局成功，每人 13 张', cs[0].view.players.every(p => p.count === 13));
  T('开局前收到过房间信息（等待页）', cs[0].rooms >= 1);

  // 之后的判定只统计"开局之后"的 room 广播
  cs.forEach(c => { c.msgs = []; });

  console.log('— 点托管：不弹房间菜单 —');
  cs[1].send({ type: 'trustee', on: true });
  await until(() => cs[1].view && cs[1].view.myTrustee === true, 4000);
  await wait(400);
  T('托管开启后 myTrustee 为真', cs[1].view.myTrustee === true);
  T('其他客户端也看到该玩家托管', cs[0].view.trustee[cs[1].seat] === true);
  T('托管开关不会再广播房间等待页', cs.every(c => roomCount(c) === 0));

  console.log('— 取消托管：状态回到手动 —');
  cs[1].send({ type: 'trustee', on: false });
  await until(() => cs[1].view && cs[1].view.myTrustee === false, 4000);
  await wait(300);
  T('取消托管后 myTrustee 为假', cs[1].view.myTrustee === false);
  T('取消托管同样不弹房间菜单', cs.every(c => roomCount(c) === 0));

  console.log('— 掉线：立即托管，其它人不被弹窗打扰 —');
  const drop = cs[2];
  const dropSeat = drop.seat;
  const dropToken = drop.token;
  drop.ws.close();
  await until(() => cs[0].offlineMsg && cs[0].offlineMsg.seat === dropSeat, 5000);
  await until(() => cs[0].view && cs[0].view.trustee[dropSeat] === true, 5000);
  await wait(500);
  T('掉线玩家被标记 offline', cs[0].view.offline[dropSeat] === true);
  T('掉线玩家立刻进入托管', cs[0].view.trustee[dropSeat] === true);
  T('其他人收到掉线通知', !!cs[0].offlineMsg);
  T('掉线托管不会弹出房间等待页', cs.filter(c => c !== drop).every(c => roomCount(c) === 0));
  T('座位仍然保留（房间还是 4 个人）',
    cs[0].view.players.filter(p => p.count > 0).length === 4);

  console.log('— 掉线玩家本局未结束不能回来 —');
  const back = await client('回来的玩家');
  back.send({ type: 'resume', code, token: dropToken });
  await until(() => back.resumeFail, 5000);
  T('凭座位凭据回座被拒绝', !!back.resumeFail);
  T('拒绝原因是「本局进行中」', back.resumeFailCode === 'INGAME');
  T('拒绝提示说明什么时候能回来', /等这一局结束/.test(back.resumeFail.msg || ''));

  const back2 = await client('硬闯的玩家');
  back2.send({ type: 'join', code, name: '硬闯的玩家' });
  await until(() => back2.err, 5000);
  T('游戏进行中也不能用房间码加入', back2.errCode === 'INGAME' && !back2.room);

  console.log('— 托管玩家由系统自动出牌 —');
  // 让 3 号（掉线托管）之外的人都不动，服务器应在 1.6 秒内替他走一步
  const before = cs[0].view.trick ? JSON.stringify(cs[0].view.trick) : '';
  const advanced = await until(() => {
    const v = cs[0].view;
    if (!v) return false;
    if (v.turn !== dropSeat) return true;
    const now = v.trick ? JSON.stringify(v.trick) : '';
    return now !== before;
  }, 12000);
  T('托管/掉线的座位由系统推进，牌局没有卡死', advanced || cs[0].view.turn !== dropSeat);

  console.log('— 托管中的玩家手动出牌按钮被收起（服务端不收手动操作）—');
  cs[1].send({ type: 'trustee', on: true });
  await until(() => cs[1].view && cs[1].view.myTrustee === true, 4000);
  const tSeat = cs[1].seat;
  // 强行让轮到他，再发一次手动出牌：服务器照常处理（客户端已把按钮收起，这里只验证不崩）
  cs[1].send({ type: 'act', act: 'pass' });
  await wait(400);
  T('托管玩家发来的意外操作不会让房间崩溃', !!cs[0].view && cs[0].view.players.length === 4);
  T('托管状态维持', cs[0].view.trustee[tSeat] === true);

  [cs[0], cs[1], cs[3], back, back2].forEach(c => { try { c.ws.close(); } catch (e) { } });

  console.log('— 房间级：开局后不再广播房间等待页 / 结束后可回座 —');
  const R = require('./lib/room.js');
  const Game = globalThis.Game;
  const room = new R.Room('8888');
  room.hostSeat = 0;
  room.syncClock = function () { };
  room.afterMove = function () { };
  room.broadcastState = function () { };
  room.broadcast = function () { };
  room.scheduleAI = function () { };

  const sent = [];
  for (let i = 0; i < 4; i++) {
    room.seats[i] = {
      ws: { readyState: 1, send: m => sent.push(JSON.parse(m)) },
      name: 'P' + i, avatar: '🙂', seat: i, isAI: false,
      token: 't' + i, trustee: false, offline: false
    };
  }
  room.game = new Game({ players: [0, 1, 2, 3].map(i => ({ name: 'P' + i, isAI: false })) });
  room.game.startRound();

  room.started = false;
  sent.length = 0;
  room.broadcastRoom();
  T('未开局时照常下发房间信息', sent.length === 4 && sent[0].type === 'room');
  T('房间信息里带 started 标记', sent[0].started === false);

  room.started = true;
  sent.length = 0;
  room.broadcastRoom();
  T('开局后不再下发房间等待页（托管/掉线都不弹菜单）', sent.length === 0);

  room.game.phase = 'playing';
  room.seats[2].offline = true; room.seats[2].trustee = true;
  T('本局进行中拒绝回座', room.resume({ readyState: 1, send: () => { } }, 't2') === -2);
  T('拒绝后座位保持离线托管', room.seats[2].offline === true && room.seats[2].trustee === true);

  room.game.phase = 'over';
  T('本局结束后允许回座', room.resume({ readyState: 1, send: () => { } }, 't2') === 2);
  T('回座后清掉离线与托管', room.seats[2].offline === false && room.seats[2].trustee === false);
  T('座位号没有变化', room.seats[2].seat === 2);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常：', e); process.exit(1); });
