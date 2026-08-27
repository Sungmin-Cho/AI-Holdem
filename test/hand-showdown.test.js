import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDeck } from '../engine/cards.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { readHand, writeHandArchive } from '../engine/state.js';
import { fixedDeck, setup3 } from './helpers/fixtures.js';

function chipTotal(st) {
  return st.seats.reduce((a, s) => a + s.stack, 0)
    + Object.values(st.hand?.contribs ?? {}).reduce((a, c) => a + c, 0);
}

function deckWith(ordered) {
  const used = new Set(ordered);
  return [...ordered, ...newDeck().filter((card) => !used.has(card))];
}

// setup3 deal order is SB p1, BB p2, BTN user.
function deck3(holes, board) {
  return deckWith([
    holes.p1[0], holes.p2[0], holes.user[0],
    holes.p1[1], holes.p2[1], holes.user[1],
    ...board,
  ]);
}

function start3(userStack, p1Stack, p2Stack, deck = fixedDeck()) {
  const st = createGame({ aiCount: 2 });
  st.button = 2;
  st.seats[0].stack = userStack;
  st.seats[1].stack = p1Stack;
  st.seats[2].stack = p2Stack;
  return startHand(st, { deck }).state;
}

function checkDownToEnd(st) {
  let last = { state: st, events: [] };
  while (!legalFor(last.state).handOver) {
    const legal = legalFor(last.state);
    const action = legal.canCheck ? 'check' : 'call';
    last = applyAction(last.state, legal.toAct, action);
  }
  return last;
}

test('헤즈업 포스트플랍 선행동은 BB', () => {
  const st = createGame({ aiCount: 1 });
  const r = startHand(st, { deck: fixedDeck() });
  const btnSeat = r.state.seats[r.state.button].playerId;
  const bbSeat = r.state.seats.find((s) => s.playerId !== btnSeat).playerId;
  let next = applyAction(r.state, btnSeat, 'call').state;
  next = applyAction(next, bbSeat, 'check').state;
  assert.equal(legalFor(next).toAct, bbSeat);
  assert.equal(legalFor(next).street, 'flop');
});

test('포스트플랍 벳과 체크-레이즈', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call', undefined).state; // 콜 50
  st = applyAction(st, 'p1', 'call').state;              // SB 컴플릿
  st = applyAction(st, 'p2', 'check').state;             // 플랍으로
  assert.equal(legalFor(st).street, 'flop');
  assert.equal(legalFor(st).toAct, 'p1');                // 포스트플랍은 SB부터
  st = applyAction(st, 'p1', 'check').state;
  st = applyAction(st, 'p2', 'raise', 100).state;        // 벳 100 (첫 벳도 raise-to로 표현)
  assert.equal(legalFor(st).minRaiseTo, 200);            // user 차례
  st = applyAction(st, 'user', 'fold').state;
  st = applyAction(st, 'p1', 'raise', 300).state;        // 체크-레이즈 합법
  assert.equal(legalFor(st).toAct, 'p2');
  assert.equal(st.hand.currentBet, 300);
});

test('칩 보존: 핸드 전후 총합 불변', () => {
  const st0 = setup3(5000, 5000, 5000);
  const before = chipTotal(st0);
  assert.equal(before, 15000);
  const r = checkDownToEnd(st0);
  const st = r.state;
  assert.equal(chipTotal(st), before);
  assert.equal(st.hand, null);
  assert.equal(st.phase, 'idle');
  assert.equal(legalFor(st).handOver, true);
  assert.equal(st.seats.reduce((a, s) => a + s.stack, 0), before);
  for (const seat of st.seats) assert.ok(seat.stack >= 0);
});

test('한 명 남으면 쇼다운 없이 지급·홀카드 비공개', () => {
  let st = setup3(5000, 5000, 5000);
  const holes = structuredClone(st.hand.holes);
  st = applyAction(st, 'user', 'fold').state;
  const r = applyAction(st, 'p1', 'fold');
  st = r.state;
  assert.equal(r.events.some((e) => e.type === 'showdown'), false);
  const awards = r.events.filter((e) => e.type === 'pot_award');
  assert.equal(awards.length, 1);
  assert.equal(awards[0].visibility, 'public');
  assert.equal(awards[0].potIndex, 0);
  assert.equal(awards[0].amount, 75);
  assert.deepEqual(awards[0].winners, [{ playerId: 'p2', share: 75 }]);
  const publicJson = JSON.stringify(r.events.filter((e) => e.visibility === 'public'));
  for (const pid of Object.keys(holes)) {
    for (const card of holes[pid]) {
      assert.equal(publicJson.includes(card), false, `홀카드 유출: ${card}`);
    }
  }
  assert.equal(st.lastHand.showdown, null);
  assert.equal(st.hand, null);
  const p2 = st.seats.find((s) => s.playerId === 'p2');
  assert.equal(p2.stack, 5025);
  assert.equal(legalFor(st).handOver, true);
});

test('올인 런아웃: 프리플랍 올인 콜 → 보드 5장 자동', () => {
  let st = setup3(100, 100, 100);
  st = applyAction(st, 'user', 'raise', 100).state;
  st = applyAction(st, 'p1', 'call').state;
  const r = applyAction(st, 'p2', 'call');
  const streets = r.events.filter((e) => e.type === 'street');
  assert.equal(streets.length, 3);
  assert.deepEqual(streets.map((e) => e.street), ['flop', 'turn', 'river']);
  assert.equal(streets[0].board.length, 3);
  assert.equal(streets[1].board.length, 4);
  assert.equal(streets[2].board.length, 5);
  const types = r.events.map((e) => e.type);
  const firstStreet = types.indexOf('street');
  assert.deepEqual(types.slice(firstStreet, firstStreet + 3), ['street', 'street', 'street']);
  assert.ok(r.events.some((e) => e.type === 'showdown'));
  assert.ok(r.events.some((e) => e.type === 'pot_award'));
  assert.equal(r.state.lastHand.board.length, 5);
  assert.equal(r.state.hand, null);
  assert.equal(chipTotal(r.state), 300);
});

test('쇼다운 공개 순서와 머킹', () => {
  // button=user 확정(start3). 리버 체크 종료 → 버튼 왼쪽(p1)부터.
  // p1 풀하우스, 나머지는 트리플 K — 승자만 공개, 지는 패 머킹.
  const deck = deck3(
    { p1: ['As', 'Ah'], p2: ['2c', '3d'], user: ['7s', '8s'] },
    ['Ks', 'Kd', 'Kh', '9c', '6d'],
  );
  const st0 = start3(5000, 5000, 5000, deck);
  assert.equal(st0.seats[st0.button].playerId, 'user');
  const r = checkDownToEnd(st0);
  const show = r.events.find((e) => e.type === 'showdown');
  assert.equal(show.visibility, 'public');
  assert.deepEqual(show.reveals.map((x) => x.playerId), ['p1']);
  assert.deepEqual(show.mucks, ['p2', 'user']);
  assert.deepEqual(show.reveals[0].cards, ['As', 'Ah']);
  assert.equal(show.reveals[0].handName, '풀하우스');
  assert.equal(r.state.lastHand.showdown.reveals[0].playerId, 'p1');
  assert.deepEqual(r.state.lastHand.showdown.mucks, ['p2', 'user']);
  const p1 = r.state.seats.find((s) => s.playerId === 'p1');
  assert.equal(p1.stack, 5100);
});

test('사용자 버스트 → gameOver lose', () => {
  const deck = deck3(
    { p1: ['As', 'Ah'], p2: ['Ks', 'Kh'], user: ['2c', '3d'] },
    ['Qs', 'Jd', '9h', '8c', '6s'],
  );
  const r = checkDownToEnd(start3(50, 5000, 5000, deck));
  const st = r.state;
  assert.equal(st.gameOver, true);
  assert.equal(st.result, 'lose');
  assert.equal(legalFor(st).gameOver, true);
  assert.equal(legalFor(st).result, 'lose');
  const over = r.events.find((e) => e.type === 'game_over');
  assert.equal(over.visibility, 'public');
  assert.equal(over.result, 'lose');
  assert.ok(over.bustedPlayerIds.includes('user'));
  assert.ok(r.events.some((e) => e.type === 'bust' && e.playerId === 'user'));
  const user = st.seats.find((s) => s.playerId === 'user');
  assert.equal(user.stack, 0);
  assert.equal(user.out, true);
});

test('동시 버스트: 사용자 생존+AI 전멸 → win', () => {
  const deck = deck3(
    { p1: ['2c', '3c'], p2: ['4d', '5d'], user: ['As', 'Ah'] },
    ['Ks', 'Kd', 'Kh', '9s', '8s'],
  );
  let st = start3(5000, 50, 50, deck);
  st = applyAction(st, 'user', 'call').state;
  const r = applyAction(st, 'p1', 'call');
  st = r.state;
  assert.equal(st.gameOver, true);
  assert.equal(st.result, 'win');
  assert.equal(legalFor(st).result, 'win');
  const over = r.events.find((e) => e.type === 'game_over');
  assert.equal(over.result, 'win');
  assert.ok(over.bustedPlayerIds.includes('p1'));
  assert.ok(over.bustedPlayerIds.includes('p2'));
  assert.equal(over.bustedPlayerIds.includes('user'), false);
  const user = st.seats.find((s) => s.playerId === 'user');
  assert.ok(user.stack > 0);
  assert.equal(user.out, false);
  assert.equal(st.seats.find((s) => s.playerId === 'p1').stack, 0);
  assert.equal(st.seats.find((s) => s.playerId === 'p2').stack, 0);
});

test('bust 좌석은 out=true', () => {
  const deck = deck3(
    { p1: ['2c', '3d'], p2: ['9s', '8s'], user: ['As', 'Ah'] },
    ['Ks', 'Kd', 'Kh', '7c', '6d'],
  );
  const r = checkDownToEnd(start3(5000, 50, 5000, deck));
  const st = r.state;
  const p1 = st.seats.find((s) => s.playerId === 'p1');
  const p2 = st.seats.find((s) => s.playerId === 'p2');
  const user = st.seats.find((s) => s.playerId === 'user');
  assert.equal(p1.stack, 0);
  assert.equal(p1.out, true);
  assert.ok(r.events.some((e) => e.type === 'bust' && e.playerId === 'p1'));
  assert.equal(p2.out, false);
  assert.ok(p2.stack > 0);
  assert.equal(user.out, false);
  assert.equal(st.gameOver, false);
  assert.equal(st.result, null);
});

test('lastHand 완전성: 정산 후 lastHand로 hand-NNNN.json 내용을 재구성할 수 있다(모듈 수준 비교)', () => {
  const r = checkDownToEnd(setup3(5000, 5000, 5000));
  const rec = r.state.lastHand;
  assert.ok(rec);
  assert.equal(r.state.hand, null);
  const required = [
    'handNo', 'level', 'blinds', 'button', 'holes', 'board',
    'folded', 'allIn', 'actions', 'pots', 'showdown', 'startStacks', 'endStacks',
  ];
  for (const key of required) assert.ok(key in rec, `missing ${key}`);
  assert.equal(rec.handNo, 1);
  assert.deepEqual(rec.blinds, [25, 50]);
  assert.equal(rec.button, 'user');
  assert.equal(Object.keys(rec.holes).length, 3);
  assert.equal(rec.board.length, 5);
  assert.ok(Array.isArray(rec.actions));
  assert.ok(rec.actions.length > 0);
  const snapKeys = [
    'decisionId', 'playerId', 'action', 'amount', 'street',
    'potTotal', 'callAmount', 'minRaiseTo', 'maxRaiseTo', 'board', 'stacks',
  ];
  for (const action of rec.actions) {
    for (const key of snapKeys) assert.ok(key in action, `action missing ${key}`);
    assert.equal(typeof action.decisionId, 'string');
    assert.ok(Array.isArray(action.board));
    assert.equal(typeof action.stacks, 'object');
  }
  assert.equal(rec.actions[0].decisionId, 'd-1-preflop-0');
  assert.ok(Array.isArray(rec.pots));
  assert.ok(rec.pots.length >= 1);
  assert.equal(typeof rec.pots[0].potIndex, 'number');
  assert.ok(rec.showdown === null || (Array.isArray(rec.showdown.reveals) && Array.isArray(rec.showdown.mucks)));
  assert.equal(typeof rec.startStacks.user, 'number');
  assert.equal(typeof rec.endStacks.user, 'number');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-archive-'));
  writeHandArchive(dir, rec);
  const loaded = readHand(dir, rec.handNo);
  assert.deepEqual(loaded, rec);
  const reconstructed = structuredClone(rec);
  assert.deepEqual(reconstructed, rec);
});
