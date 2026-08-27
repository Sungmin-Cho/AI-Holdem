import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, legalFor, forceDefault } from '../engine/hand.js';
import { setup3 } from './helpers/fixtures.js';

test('언더 레이즈 올인은 베팅을 다시 열지 않는다', () => {
  // 스택: user 5000, p1 5000, p2 130
  let st = setup3(5000, 5000, 130);
  st = applyAction(st, 'user', 'raise', 100).state;   // lastRaise 50 → 다음 min 150
  st = applyAction(st, 'p1', 'fold').state;
  st = applyAction(st, 'p2', 'raise', 130).state;      // 언더 레이즈 올인 (150 미만)
  const la = legalFor(st);
  assert.equal(la.toAct, 'user');
  assert.equal(la.canRaise, false);                    // user에게 다시 열리지 않음
  assert.equal(la.callAmount, 30);
  assert.equal(st.hand.lastAggressor, 'p2');
  assert.equal(st.hand.reopenEligible, false);
});

test('minRaiseTo: 프리플랍 연쇄', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'raise', 100).state;    // BB 50 기준 lastRaise 50
  assert.equal(legalFor(st).minRaiseTo, 150);          // p1 차례
  st = applyAction(st, 'p1', 'raise', 300).state;      // lastRaise 200
  assert.equal(legalFor(st).minRaiseTo, 500);          // p2 차례
});

test('forceDefault: 체크 가능하면 체크, 아니면 폴드', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call').state;
  st = applyAction(st, 'p1', 'call').state;
  const r1 = forceDefault(st, 'p2');                     // 미벳 → check
  assert.equal(r1.events.find((e) => e.type === 'action').action, 'check');
  let st2 = setup3(5000, 5000, 5000);
  st2 = applyAction(st2, 'user', 'raise', 150).state;
  const r2 = forceDefault(st2, 'p1');                    // 벳 직면 → fold
  assert.equal(r2.events.find((e) => e.type === 'action').action, 'fold');
});

test('숏스택 올인 레이즈: minRaiseTo > maxRaiseTo, canRaise true', () => {
  // 3인 [user,p1,p2], button=0(user) → SB=p1, BB=p2. 블라인드 25/50, 스택 user 5000 / p1 5000 / p2 200
  let st = setup3(5000, 5000, 200);
  st = applyAction(st, 'user', 'raise', 150).state;  // BTN 오픈 레이즈 → 다음 min 250
  st = applyAction(st, 'p1', 'fold').state;
  const la = legalFor(st);
  assert.equal(la.toAct, 'p2');
  assert.equal(la.canRaise, true);
  assert.ok(la.minRaiseTo > la.maxRaiseTo);
  assert.equal(la.maxRaiseTo, 200);
  applyAction(st, 'p2', 'raise', 200);               // 올인 레이즈 성공해야 함
});

test('legal 재호출은 같은 decisionId (안정성)', () => {
  let st = setup3(5000, 5000, 5000);
  const a = legalFor(st); const b = legalFor(st);
  assert.equal(a.decisionId, b.decisionId);
  assert.equal(a.decisionId, 'd-1-preflop-0');
});

test('apply 실패 시 상태 무변경·actionIndex 불변', () => {
  let st = setup3(5000, 5000, 5000);
  const before = JSON.stringify(st);
  assert.throws(() => applyAction(st, 'user', 'raise', 999999), { code: 'ILLEGAL_ACTION' });
  assert.equal(JSON.stringify(st), before);
});

test('체크-레이즈 합법', () => {
  // BB 체크 → 상대 벳 → BB 레이즈 성공. p1 폴드로 헤즈업 플랍, 포스트플랍 선행동=BB.
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call').state;
  st = applyAction(st, 'p1', 'fold').state;
  const toFlop = applyAction(st, 'p2', 'check');
  st = toFlop.state;
  const streetEv = toFlop.events.find((e) => e.type === 'street');
  assert.equal(streetEv.street, 'flop');
  assert.equal(streetEv.board.length, 3);
  assert.equal(toFlop.events[0].seq, 0);
  assert.equal(toFlop.events[1].seq, 1);
  assert.equal(st.hand.currentBet, 0);
  assert.equal(st.hand.bets.user, 0);
  assert.equal(legalFor(st).street, 'flop');
  assert.equal(legalFor(st).toAct, 'p2');
  st = applyAction(st, 'p2', 'check').state;
  st = applyAction(st, 'user', 'raise', 100).state;
  const r = applyAction(st, 'p2', 'raise', 300);
  assert.equal(r.state.hand.currentBet, 300);
  const act = r.events.find((e) => e.type === 'action');
  assert.equal(act.action, 'raise');
  assert.equal(act.amount, 300);
  assert.equal(legalFor(r.state).toAct, 'user');
});

test('대응 가능한 상대가 없으면 레이즈할 수 없다', () => {
  // SB 25·BB 50이 블라인드 포스팅으로 이미 올인 — 레이즈할 상대가 없다
  const st = setup3(5000, 25, 50);
  const la = legalFor(st);
  assert.equal(la.toAct, 'user');
  assert.equal(la.canRaise, false);
  assert.equal(la.callAmount, 50);
  const before = JSON.stringify(st);
  assert.throws(() => applyAction(st, 'user', 'raise', 100), { code: 'ILLEGAL_ACTION' });
  assert.equal(JSON.stringify(st), before);
});

test('minRaiseTo 계산', () => {
  // 벳 100 → 레이즈는 200 이상; 300 레이즈 후 재레이즈는 500 이상
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call').state;
  st = applyAction(st, 'p1', 'call').state;
  st = applyAction(st, 'p2', 'check').state;
  assert.equal(legalFor(st).street, 'flop');
  assert.equal(legalFor(st).toAct, 'p1');
  assert.equal(legalFor(st).minRaiseTo, 50);
  st = applyAction(st, 'p1', 'raise', 100).state;
  assert.equal(legalFor(st).minRaiseTo, 200);
  st = applyAction(st, 'p2', 'raise', 300).state;
  assert.equal(legalFor(st).minRaiseTo, 500);
});
