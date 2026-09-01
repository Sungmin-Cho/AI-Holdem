import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { newDeck } from '../engine/cards.js';
import { fixedDeck, setup3 } from './helpers/fixtures.js';
import { redactRecord, statsReport, turnSummary, userView, viewFor } from '../engine/views.js';
import { positionsOf } from '../engine/positions.js';

function holeOf(state, playerId) {
  return state.hand?.holes[playerId] ?? state.lastHand?.holes[playerId];
}

function finishByChecks(state) {
  let current = state;
  while (!legalFor(current).handOver) {
    const legal = legalFor(current);
    current = applyAction(current, legal.toAct, legal.canCheck ? 'check' : 'call').state;
  }
  return current;
}

test('userView에 금지 정보가 없다', () => {
  const st = setup3(5000, 5000, 5000);
  const v = userView(st);
  const json = JSON.stringify(v);
  for (const banned of [st.hand.deck[0], holeOf(st, 'p1')[0], 'archetype', 'bluffFreq']) {
    assert.ok(!json.includes(banned), `유출: ${banned}`);
  }
  assert.equal(v.myCards.length, 2);
  assert.equal(v.levelEvery, st.config.levelEvery);
});

test('redactRecord: 머킹된 패 미포함, 쇼다운 공개 패 포함', () => {
  const deck = [...new Set([
    '7s', '2c', 'As', '8s', '3d', 'Ah', 'Ks', 'Kd', 'Kh', '9c', '6d',
    ...newDeck(),
  ])];
  let st = createGame({ aiCount: 2 });
  st.button = 2;
  st = startHand(st, { deck }).state;
  st = finishByChecks(st);
  const redacted = redactRecord(st.lastHand);
  const json = JSON.stringify(redacted);
  assert.deepEqual(redacted.holes.user, st.lastHand.holes.user);
  assert.ok(st.lastHand.showdown.mucks.includes('p2'));
  assert.equal(redacted.holes.p1, undefined);
  assert.equal(redacted.holes.p2, undefined);
  for (const reveal of st.lastHand.showdown?.reveals ?? []) {
    assert.deepEqual(redacted.showdown.reveals.find((r) => r.playerId === reveal.playerId).cards, reveal.cards);
  }
  for (const card of st.lastHand.holes.p2) assert.equal(json.includes(card), false);
});

test('종료된 프리플랍 폴드 핸드의 뷰 스트리트는 preflop', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'fold').state;
  st = applyAction(st, 'p1', 'fold').state;
  const view = userView(st);
  assert.equal(view.street, 'preflop');
  assert.deepEqual(view.board, []);
});

test('public 이벤트에 금지 정보 없음', () => {
  let st = setup3(5000, 5000, 5000);
  const holes = structuredClone(st.hand.holes);
  let events = [];
  while (!legalFor(st).handOver) {
    const legal = legalFor(st);
    const result = applyAction(st, legal.toAct, legal.canCheck ? 'check' : 'call');
    st = result.state;
    events = events.concat(result.events);
  }
  const json = JSON.stringify(events.filter((event) => event.visibility === 'public'));
  for (const cards of Object.values(holes)) {
    for (const card of cards) {
      const revealed = events.some((event) => event.visibility === 'public'
        && event.type === 'showdown'
        && event.reveals.some((reveal) => reveal.cards.includes(card)));
      if (!revealed) assert.equal(json.includes(card), false, `홀카드 유출: ${card}`);
    }
  }
  const unseenCard = fixedDeck().find((card) => (
    !Object.values(holes).flat().includes(card) && !st.lastHand.board.includes(card)
  ));
  assert.equal(json.includes(unseenCard), false);
});

test('진행 중 핸드는 sample에 안 들어가고 finishHand 직후 1 증가한다', () => {
  let st = setup3(5000, 5000, 5000);
  assert.equal(statsReport(st).perPlayer.user.sample, 0);
  while (!legalFor(st).handOver) {
    const legal = legalFor(st);
    st = applyAction(st, legal.toAct, 'fold').state;
  }
  assert.equal(legalFor(st).handOver, true);
  assert.equal(statsReport(st).perPlayer.user.sample, 1);
  assert.equal(st.hand, null);
  assert.ok(st.lastHand);
});

test('VPIP: BB 체크는 미집계, SB 컴플릿은 집계', () => {
  const st = finishByChecks(setup3(5000, 5000, 5000));
  assert.equal(statsReport(st).perPlayer.user.vpip, 1);
  assert.equal(statsReport(st).perPlayer.p1.vpip, 1);
  assert.equal(statsReport(st).perPlayer.p2.vpip, 0);
});

test('내 차례일 때만 legal 포함 + decisionId 일치', () => {
  const st = setup3(5000, 5000, 5000);
  assert.equal(viewFor(st, 'p1').legal, undefined);
  const current = viewFor(st, legalFor(st).toAct);
  assert.equal(current.legal.decisionId, legalFor(st).decisionId);
  assert.equal(current.legal.callAmount, legalFor(st).callAmount);
  assert.equal(current.legal.minRaiseTo, legalFor(st).minRaiseTo);
  assert.equal(current.legal.maxRaiseTo, legalFor(st).maxRaiseTo);
});

test('viewFor(p1)은 p1 카드만, user 카드 비노출', () => {
  const st = setup3(5000, 5000, 5000);
  const json = JSON.stringify(viewFor(st, 'p1'));
  for (const card of holeOf(st, 'p1')) assert.ok(json.includes(card));
  for (const card of holeOf(st, 'user')) assert.equal(json.includes(card), false);
});

test('코치 입력 합성(redactRecord + statsReport JSON)에 상대 홀카드·덱·아키타입 문자열 부재', () => {
  const st = finishByChecks(setup3(5000, 5000, 5000));
  const input = JSON.stringify({ record: redactRecord(st.lastHand), stats: statsReport(st) });
  for (const pid of ['p1', 'p2']) {
    for (const card of st.lastHand.holes[pid]) {
      if (!st.lastHand.showdown?.reveals.some((r) => r.playerId === pid)) assert.equal(input.includes(card), false);
    }
  }
  assert.equal(input.includes('archetype'), false);
  assert.equal(input.includes('bluffFreq'), false);
});

test('positionsOf: 헤즈업은 BTN/SB와 BB', () => {
  const st = createGame({ aiCount: 1 });
  st.button = 1; // startHand가 딜 전에 버튼을 한 칸 옮긴다 → user가 버튼
  const dealt = startHand(st, { deck: fixedDeck() }).state;
  assert.deepEqual(positionsOf(dealt), { user: 'BTN/SB', p1: 'BB' });
});

test('positionsOf: 6인은 BTN·SB·BB·UTG·UTG+1·CO, 탈락 좌석은 건너뛴다', () => {
  const st = createGame({ aiCount: 6 });
  st.button = 0;
  const full = positionsOf(st);
  assert.deepEqual(
    [full.user, full.p1, full.p2, full.p3, full.p4, full.p5, full.p6],
    ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'CO'],
  );
  st.seats[1].out = true;
  const afterBust = positionsOf(st);
  assert.equal(afterBust.p1, undefined);
  assert.equal(afterBust.p2, 'SB');
});

test('turnSummary: 자기 홀카드만 담고 legal 수치를 전부 문면에 쓴다', () => {
  const st = setup3(5000, 5000, 5000);
  const legal = legalFor(st);
  const text = turnSummary(st, legal.toAct);
  assert.equal(text.includes('talk'), false);
  assert.ok(text.includes(legal.decisionId));
  assert.ok(text.includes(`callAmount=${legal.callAmount}`));
  assert.ok(text.includes(`minRaiseTo=${legal.minRaiseTo}`));
  assert.ok(text.includes(`maxRaiseTo=${legal.maxRaiseTo}`));
  for (const card of holeOf(st, legal.toAct)) assert.ok(text.includes(card));
  for (const other of ['user', 'p1', 'p2'].filter((pid) => pid !== legal.toAct)) {
    for (const card of holeOf(st, other)) {
      assert.equal(text.includes(card), false, `${other} 홀카드 ${card} 유출`);
    }
  }
});

test('turnSummary: 올인이 나오면 팟 줄에 사이드팟이 분해된다', () => {
  const shortStack = setup3(5000, 5000, 120);
  const legal = legalFor(shortStack);
  const allIn = applyAction(shortStack, legal.toAct, 'raise', legalFor(shortStack).maxRaiseTo).state;
  const next = legalFor(allIn);
  const text = turnSummary(allIn, next.toAct);
  const potLine = text.split('\n').find((line) => line.startsWith('팟: '));
  assert.ok(allIn.hand.allIn.length > 0, '올인이 만들어지지 않았다');
  assert.ok(potLine.includes('('), potLine);
});

test('turnSummary: 행동자가 아니면 null', () => {
  const st = setup3(5000, 5000, 5000);
  const notActing = ['user', 'p1', 'p2'].find((pid) => pid !== legalFor(st).toAct);
  assert.equal(turnSummary(st, notActing), null);
});

test('turnSummary: 숏스택 올인만 가능하면 역방향 범위 대신 단일 금액을 제시한다', () => {
  const st = setup3(5000, 5000, 5000);
  // 100으로 레이즈 → currentBet 100, minRaiseTo 150. 다음 행동자의 올인을 120으로 맞추면
  // 레이즈는 가능한데(120 > 100) 최소 레이즈에는 못 미쳐(120 < 150) 올인 하나만 남는다.
  const raised = applyAction(st, legalFor(st).toAct, 'raise', 100).state;
  const actor = legalFor(raised).toAct;
  const shortSeat = raised.seats.find((seat) => seat.playerId === actor);
  shortSeat.stack = 120 - (raised.hand.bets[actor] ?? 0);
  const legal = legalFor(raised);
  assert.equal(legal.canRaise, true, '레이즈가 가능한 상황이어야 한다');
  assert.ok(legal.minRaiseTo > legal.maxRaiseTo, `min(${legal.minRaiseTo}) > max(${legal.maxRaiseTo}) 상황이어야 한다`);
  const text = turnSummary(raised, legal.toAct);
  const line = text.split('\n').find((l) => l.startsWith('가능한 액션:'));
  assert.equal(line.includes(`${legal.minRaiseTo}~${legal.maxRaiseTo}`), false, `역방향 범위 노출: ${line}`);
  assert.ok(line.includes(`raise ${legal.maxRaiseTo}`), line);
  assert.ok(line.includes('올인'), line);
});
