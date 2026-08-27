import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { newDeck } from '../engine/cards.js';
import { fixedDeck, setup3 } from './helpers/fixtures.js';
import { redactRecord, statsReport, userView, viewFor } from '../engine/views.js';

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
