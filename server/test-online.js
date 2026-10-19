/* 联机端到端测试：起服务器后 node server/test-online.js */
'use strict';
const WebSocket = require('ws');
const path = require('path');
require('../js/cards.js');
require('../js/combos.js');
require('../js/engine.js');
require('../js/engine_ai.js');
const K = globalThis.Combos, AI = globalThis.AI;

const URL = process.env.SVR || 'ws://127.0.0.1:8080/ws';
let pass = 0, fail = 0;
const T = (n, c) => c ? pass++ : (fail++, console.log('  ✗ ' + n));

function client(name) {
  return new Promise(resolve => {
    const ws = new WebSocket(URL);
    const c = { ws, name, seat: -1, room: null, view: null, msgs: [] };
    ws.on('open', () => resolve(c));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      c.msgs.push(m);
      if (m.type === 'hello') { c.seat = m.seat; c.room = m.code; }
      if (m.type === 'room') c.roomInfo = m;
      if (m.type === 'state') { c.view = m.view; c.onState && c.onState(m.view); }
      if (m.type === 'askDeclare') c.askDeclare = true;
      if (m.type === 'askTribute') { c.askTribute = m.item; c.askPool = m.pool || null; }
      if (m.type === 'ready') { c.readyList = m.list; c.readyAll = m.all; c.readyWaiting = m.waiting; }
      if (m.type === 'roundBegin') { c.roundBegin = (c.roundBegin || 0) + 1; }
      if (m.type === 'error') { c.err = m.msg; c.errCode = m.code; }
      if (m.type === 'roomClosed') c.roomClosed = m;
      if (m.type === 'dissolved') c.dissolved = m;
      if (m.type === 'leader') c.leader = m;
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
function getJson(p) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const base = URL.replace(/^ws/, 'http').replace(/\/ws\/?$/, '');
    const u = new (require('url').URL)(base + p);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: 5000 }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async function main() {
  console.log('— 连接与房间 —');
  const a = await client('小明');
  const b = await client('小红');
  T('两个客户端连上', !!a.ws && !!b.ws);

  a.send({ type: 'create', name: '小明', avatar: '🙂' });
  await until(() => a.room);
  T('创建房间拿到房间码', !!a.room && a.room.length === 4);
  const code = a.room;
  T('房主座位为 0', a.seat === 0);
  T('收到房间信息', !!a.roomInfo && a.roomInfo.isHost === true);

  b.send({ type: 'join', code, name: '小红', avatar: '😀' });
  await until(() => b.room);
  T('第二人加入同一房间', b.room === code);
  T('第二人座位为 1', b.seat === 1);
  await wait(200);
  T('房主看到座位更新', a.roomInfo.seats[1].name === '小红');

  console.log('— 准备机制（v1.3.6）—');
  a.err = null;
  a.send({ type: 'start' });
  await until(() => a.err, 3000);
  T('有人没准备 ⇒ 房主开不了局', !!a.err && /没准备/.test(a.err));
  a.err = null;
  a.send({ type: 'ready', on: true });
  b.send({ type: 'ready', on: true });
  await until(() => a.readyList && a.readyAll === true, 3000);
  T('全员准备后收到 ready 广播', !!a.readyList && a.readyAll === true);
  T('准备名单里包含自己', a.readyList[a.seat] === true && a.readyList[b.seat] === true);

  console.log('— 开局 —');
  a.send({ type: 'start' });
  await until(() => a.view && a.view.phase !== undefined);
  T('收到游戏状态', !!a.view);
  T('开局后准备状态被重置', a.readyAll === false || a.readyList[a.seat] === false);
  T('每人 13 张', a.view.players.every(p => p.count === 13));
  T('房主能看到自己的手牌', Array.isArray(a.view.players[a.seat].hand) && a.view.players[a.seat].hand.length === 13);
  T('看不到别人的手牌', a.view.players[(a.seat + 1) % 4].hand === null);

  console.log('— 改名（v1.3.5）—');
  a.send({ type: 'rename', name: ' 阿强 ' });
  await until(() => b.view && b.view.players[a.seat] && b.view.players[a.seat].name === '阿强', 5000);
  T('改名后其他玩家立刻看到新名字', b.view.players[a.seat].name === '阿强');
  T('改名后本人状态同步', a.view.players[a.seat].name === '阿强');
  const nameBefore = a.view.players[a.seat].name;
  a.send({ type: 'rename', name: '   ' });
  await wait(400);
  T('空昵称被服务器拒绝', a.view.players[a.seat].name === nameBefore);
  a.send({ type: 'rename', name: '这个名字超过八个字啦' });
  await until(() => b.view.players[a.seat].name.length === 8, 4000);
  T('昵称最长 8 个字', b.view.players[a.seat].name === '这个名字超过八个字啦'.slice(0, 8));

  console.log('— 打完一局（真人用提示策略自动出牌）—');
  function decide(c, v) {
    const me = v.players[c.seat];
    if (!me.hand) return null;
    const g = new globalThis.Game({});
    g.phase = v.phase; g.turn = v.turn; g.teams = v.teams; g.soloSeat = v.soloSeat;
    // 影子局面必须带上 played / played 判定依赖它（纯 3 张只在「本局还没人出过牌」时允许）
    g.played = v.played || [];
    g.finishOrder = v.finishOrder || [];
    g.round = v.round || 0;
    g.players.forEach((p, i) => {
      p.hand = (v.players[i].hand) || [];
      p.finished = v.players[i].finished;
      p.isAI = false;
    });
    g.trick = v.trick ? { seat: v.trick.seat, combo: K.detect(v.trick.cards) } : null;
    g.passed = v.passed || [false, false, false, false];
    const d = AI.decide(g, c.seat);
    return d;
  }

  /** 回上进贡：交牌走手牌，收牌从服务器给的牌池里挑 */
  function answerTribute(c) {
    const it = c.askTribute;
    c.askTribute = null;
    if (it.kind === 'take') {
      const pool = c.askPool || [];
      const cards = pool.slice(0, it.count);
      c.send({ type: 'tributeCards', ids: cards.map(x => x.id) });
      return;
    }
    const hand = c.view.players[c.seat].hand;
    const cards = AI.tributePick(hand, it.count, it.mode === 'max' ? 'max' : 'pick');
    c.send({ type: 'tributeCards', ids: cards.map(x => x.id) });
  }

  let guard = 0;
  while (guard++ < 400) {
    const v = a.view;
    if (!v || v.phase === 'over') break;
    if (a.askDeclare) { a.send({ type: 'declare', yes: true }); a.askDeclare = false; await wait(120); continue; }
    if (b.askDeclare) { b.send({ type: 'declare', yes: false }); b.askDeclare = false; await wait(120); continue; }
    if (a.askTribute) { answerTribute(a); await wait(150); continue; }
    if (b.askTribute) { answerTribute(b); await wait(150); continue; }
    if (v.turn === a.seat) {
      const d = decide(a, v);
      if (!d) { await wait(100); continue; }
      a.send(d.type === 'pass' ? { type: 'act', act: 'pass' } : { type: 'act', act: 'play', ids: d.cards.map(c => c.id) });
      await wait(140);
    } else if (v.turn === b.seat) {
      const d = decide(b, b.view || v);
      if (!d) { await wait(100); continue; }
      b.send(d.type === 'pass' ? { type: 'act', act: 'pass' } : { type: 'act', act: 'play', ids: d.cards.map(c => c.id) });
      await wait(140);
    } else {
      await wait(120);   // 电脑玩家的回合，等服务器推进
    }
  }
  T('一局正常结束', a.view && a.view.phase === 'over');
  T('4 人名次齐全', a.view.finishOrder.length === 4);
  T('队伍已确定', !!a.view.teams);
  console.log('    · 名次 ' + a.view.finishOrder.join(',') +
    ' / 独狼座位 ' + a.view.soloSeat + ' / 出牌轮数 ' + guard);

  console.log('— 下一局 —');
  a.err = null;
  a.send({ type: 'next' });
  await until(() => a.err, 3000);
  T('有人没准备 ⇒ 开不了下一局', !!a.err && /没准备/.test(a.err));
  a.err = null;
  const rb0 = b.roundBegin || 0;
  a.send({ type: 'ready', on: true });
  b.send({ type: 'ready', on: true });
  await until(() => a.readyAll === true, 3000);
  a.send({ type: 'next' });
  await until(() => a.view && a.view.round === 2, 8000);
  T('进入第 2 局', a.view.round === 2);
  await until(() => (b.roundBegin || 0) > rb0, 3000);
  T('开下一局时全员收到 roundBegin（收起结算窗口）', (b.roundBegin || 0) > rb0);
  // 进贡交换期间牌在池子里，等它跑完再验牌数
  let tg = 0;
  while (tg++ < 60 && a.view && a.view.phase === 'tribute') {
    if (a.askTribute) answerTribute(a);
    if (b.askTribute) answerTribute(b);
    await wait(150);
  }
  T('第 2 局进贡流程能走完', a.view.phase !== 'tribute');
  T('第 2 局牌数守恒 52', a.view.players.reduce((s, p) => s + p.count, 0) + a.view.played.length === 52);
  T('第 2 局每人仍 13 张', a.view.players.every(p => p.count === 13));

  console.log('— 快速匹配 —');
  const c3 = await client('小刚');
  c3.send({ type: 'quick', name: '小刚' });
  await until(() => c3.room);
  T('快速匹配拿到房间', !!c3.room);

  console.log('— 游戏中禁止加入（v1.3.3）—');
  const c5 = await client('迟到的人');
  c5.send({ type: 'join', code, name: '迟到的人' });
  await until(() => c5.err, 4000);
  T('正在游戏的房间拒绝加入', c5.errCode === 'INGAME' && !c5.room);
  T('拒绝时给出可读提示', /正在游戏中/.test(c5.err || ''));

  console.log('— 多房间并行 —');
  const d1 = await client('房主D');
  const d2 = await client('玩家E');
  d1.send({ type: 'create', name: '房主D' });
  await until(() => d1.room);
  const code2 = d1.room;
  T('新房间房间码与旧房间不同', !!code2 && code2 !== code);
  d2.send({ type: 'join', code: code2, name: '玩家E' });
  await until(() => d2.room === code2);
  T('第二个房间能正常加入', d2.room === code2 && d2.seat === 1);
  d1.send({ type: 'ready', on: true });
  d2.send({ type: 'ready', on: true });
  await until(() => d1.readyAll === true, 3000);
  d1.send({ type: 'start' });
  await until(() => d1.view && d1.view.players, 6000);
  await wait(300);
  T('两个房间可同时进行、状态互不影响',
    d1.view.round === 1 && a.view.round >= 2 && d1.view.players.every(p => p.count === 13));
  T('两个房间各有自己的首出座位',
    typeof d1.view.firstLeader === 'number' && typeof a.view.firstLeader === 'number');
  const list = await getJson('/api/rooms');
  T('服务器同时存在两个独立房间',
    list.rooms.filter(r => r.code === code || r.code === code2).length === 2);
  T('已开局的房间在列表里标记为 locked',
    list.rooms.filter(r => r.code === code2).every(r => r.locked === true));

  console.log('— 解散房间 / 重新建房 —');
  d1.room = '';
  d1.send({ type: 'dissolve' });
  await until(() => d1.dissolved, 4000);
  await until(() => d2.roomClosed, 4000);
  T('房主收到解散确认', !!d1.dissolved);
  T('其他玩家收到房间已解散', !!d2.roomClosed);
  const list2 = await getJson('/api/rooms');
  T('解散后房间从服务器移除', !list2.rooms.some(r => r.code === code2));
  d1.send({ type: 'create', name: '房主D' });
  await until(() => d1.room, 4000);
  T('解散后能立刻重建并拿到新房号', !!d1.room && d1.room !== code2);

  console.log('— 错误分支 —');
  const c4 = await client('陌生人');
  c4.send({ type: 'join', code: 'ZZZZ', name: '陌生人' });
  await until(() => c4.err, 3000);
  T('不存在的房间返回错误', !!c4.err);

  [a, b, c3, c4, c5, d1, d2].forEach(c => { try { c.ws.close(); } catch (e) { } });
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常：', e); process.exit(1); });
