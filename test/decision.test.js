import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, blindsForLevel, createGame, forceDefault, legalFor, startHand } from '../engine/hand.js';
import { snapshotDecision, PRIOR_ACTION_KEYS } from '../engine/decision.js';
import { positionsOf } from '../engine/positions.js';
import { redactRecord, SAFE_ACTION_KEYS } from '../engine/views.js';
import { newDeck } from '../engine/cards.js';
import { setup3 } from './helpers/fixtures.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/cli.js');

function blindsOf(state) {
  return blindsForLevel(state.level, state.config.blinds0);
}

function publicProjection(snapshot) {
  const { chosenAction, ...rest } = snapshot;
  return rest;
}

function userSnapshot(state, action, amount, options = {}) {
  assert.equal(legalFor(state).toAct, 'user');
  return applyAction(state, 'user', action, amount, options).state;
}

test('fold/check/call/raise/숏 올인 스냅샷이 액션 적용 전 상태를 담는다', () => {
  let st = setup3(5000, 5000, 5000);
  const before = legalFor(st);
  const holes = [...st.hand.holes.user];
  const potBefore = Object.values(st.hand.contribs).reduce((a, b) => a + b, 0);
  st = userSnapshot(st, 'fold');
  assert.equal(st.hand.decisions.length, 1);
  const snap = st.hand.decisions[0];
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.decisionId, before.decisionId);
  assert.equal(snap.gameMode, 'tournament');
  assert.equal(snap.actorId, 'user');
  assert.equal(snap.street, 'preflop');
  assert.equal(snap.position, 'BTN');
  assert.deepEqual(snap.holeCards, holes);
  assert.deepEqual(snap.blinds, [25, 50]);
  assert.equal(snap.potBefore, potBefore);
  assert.equal(snap.currentBet, 50);
  assert.equal(snap.actorBet, 0);
  assert.equal(snap.toCall, 50);
  assert.equal(snap.forced, false);
  assert.deepEqual(snap.chosenAction, { action: 'fold', amount: 0 });
  assert.equal(snap.publicSeats.length, 3);
  assert.deepEqual(snap.publicSeats.map((s) => s.playerId), ['user', 'p1', 'p2']);
});

test('check/call/raise chosenAction과 수치', () => {
  let callSt = setup3(5000, 5000, 5000);
  const callLegal = legalFor(callSt);
  callSt = userSnapshot(callSt, 'call');
  const callSnap = callSt.hand
    ? callSt.hand.decisions[0]
    : callSt.lastHand.decisions[0];
  assert.deepEqual(callSnap.chosenAction, { action: 'call', amount: callLegal.callAmount });
  assert.equal(callSnap.toCall, callLegal.callAmount);

  let raiseSt = setup3(5000, 5000, 5000);
  const raiseLegal = legalFor(raiseSt);
  raiseSt = userSnapshot(raiseSt, 'raise', 150);
  const raiseSnap = raiseSt.hand.decisions[0];
  assert.deepEqual(raiseSnap.chosenAction, { action: 'raise', amount: 150 });
  assert.equal(raiseSnap.minRaiseTo, raiseLegal.minRaiseTo);
  assert.equal(raiseSnap.maxRaiseTo, raiseLegal.maxRaiseTo);

  let checkSt = setup3(5000, 5000, 5000);
  checkSt = applyAction(checkSt, 'user', 'call').state;
  checkSt = applyAction(checkSt, 'p1', 'call').state;
  assert.equal(legalFor(checkSt).toAct, 'p2');
  assert.equal(legalFor(checkSt).canCheck, true);
  // p2 is BB; user already acted. Check path: force a later street user check via p2 check then flop.
  checkSt = applyAction(checkSt, 'p2', 'check').state;
  assert.equal(checkSt.hand.street, 'flop');
  assert.equal(legalFor(checkSt).toAct, 'p1');
  checkSt = applyAction(checkSt, 'p1', 'check').state;
  checkSt = applyAction(checkSt, 'p2', 'check').state;
  assert.equal(legalFor(checkSt).toAct, 'user');
  assert.equal(legalFor(checkSt).canCheck, true);
  const beforeCheck = legalFor(checkSt).decisionId;
  checkSt = applyAction(checkSt, 'user', 'check').state;
  const checkSnap = checkSt.hand.decisions.at(-1);
  assert.equal(checkSnap.decisionId, beforeCheck);
  assert.deepEqual(checkSnap.chosenAction, { action: 'check', amount: 0 });
  assert.equal(checkSnap.street, 'flop');

  let short = setup3(80, 5000, 5000);
  const shortLegal = legalFor(short);
  assert.ok(shortLegal.minRaiseTo > shortLegal.maxRaiseTo);
  short = userSnapshot(short, 'raise', shortLegal.maxRaiseTo);
  const shortSnap = short.hand.decisions[0];
  assert.deepEqual(shortSnap.chosenAction, { action: 'raise', amount: shortLegal.maxRaiseTo });
});

test('effectiveStack: 블라인드 게시 후 100BB, 헤즈업 vs 올인, 멀티웨이', () => {
  const hundred = setup3(5000, 5000, 5000);
  const hundredSnap = snapshotDecision(hundred, 'user', { action: 'fold', amount: 0 }, {
    blinds: blindsOf(hundred),
  });
  assert.equal(hundredSnap.effectiveStack, 5000);

  const hu = createGame({ aiCount: 1, startStack: 5000 });
  hu.button = 1;
  hu.seats[1].stack = 50;
  const dealtHu = startHand(hu, { deck: newDeck() }).state;
  assert.equal(legalFor(dealtHu).toAct, 'user');
  assert.ok(dealtHu.hand.allIn.includes('p1'));
  const huSnap = snapshotDecision(dealtHu, 'user', { action: 'call', amount: legalFor(dealtHu).callAmount }, {
    blinds: blindsOf(dealtHu),
  });
  assert.equal(huSnap.effectiveStack, Math.min(
    dealtHu.seats[0].stack + (dealtHu.hand.contribs.user ?? 0),
    dealtHu.seats[1].stack + (dealtHu.hand.contribs.p1 ?? 0),
  ));
  assert.ok(huSnap.effectiveStack > 0);

  let multi = setup3(5000, 5000, 80);
  multi = applyAction(multi, 'user', 'raise', 200).state;
  multi = applyAction(multi, 'p1', 'fold').state;
  const multiSnap = snapshotDecision(multi, 'p2', { action: 'call', amount: legalFor(multi).callAmount }, {
    blinds: blindsOf(multi),
  });
  const totals = {};
  for (const seat of multi.seats) {
    totals[seat.playerId] = seat.stack + (multi.hand.contribs[seat.playerId] ?? 0);
  }
  assert.equal(
    multiSnap.effectiveStack,
    Math.min(totals.p2, totals.user),
  );
});

test('JSON round-trip 동일, chosenAction 생략 시 공개 투영 동일', () => {
  const st = setup3(5000, 5000, 5000);
  const blinds = blindsOf(st);
  const withAction = snapshotDecision(st, 'user', { action: 'raise', amount: 150 }, { blinds });
  const without = snapshotDecision(st, 'user', undefined, { blinds });
  assert.deepEqual(JSON.parse(JSON.stringify(withAction)), withAction);
  assert.equal('chosenAction' in without, false);
  assert.deepEqual(publicProjection(withAction), without);
});

test('forceDefault만 forced:true, 정상 applyAction은 false', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call').state;
  st = applyAction(st, 'p1', 'call').state;
  const checked = forceDefault(st, 'p2');
  assert.equal(checked.state.hand.decisions.length, 1);
  assert.equal(checked.state.hand.decisions[0].forced, false);
  assert.equal(checked.state.hand.decisions[0].actorId, 'user');

  let foldSt = setup3(5000, 5000, 5000);
  foldSt = applyAction(foldSt, 'user', 'raise', 150).state;
  const forcedAi = forceDefault(foldSt, 'p1');
  assert.equal(forcedAi.state.hand.decisions.length, 1);
  assert.equal(forcedAi.state.hand.decisions[0].forced, false);

  let userForce = setup3(5000, 5000, 5000);
  const r = forceDefault(userForce, 'user');
  const snap = (r.state.hand?.decisions ?? r.state.lastHand.decisions)[0];
  assert.equal(snap.forced, true);
  assert.equal(snap.actorId, 'user');
  assert.equal(snap.chosenAction.action, 'fold');

  let normal = setup3(5000, 5000, 5000);
  normal = applyAction(normal, 'user', 'fold').state;
  assert.equal(normal.hand.decisions[0].forced, false);
});

test('AI 액션은 영속화하지 않고 user 액션만 1개', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call').state;
  assert.equal(st.hand.decisions.length, 1);
  st = applyAction(st, 'p1', 'fold').state;
  assert.equal(st.hand.decisions.length, 1);
  st = applyAction(st, 'p2', 'check').state;
  assert.equal(st.hand.decisions.length, 1);
  assert.equal(st.hand.decisions[0].actorId, 'user');
});

test('구 archive dual-read: decisions 없어도 redactRecord 성공', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'fold').state;
  st = applyAction(st, 'p1', 'fold').state;
  assert.ok(st.lastHand);
  const { decisions, ...legacy } = st.lastHand;
  assert.ok(decisions);
  const redacted = redactRecord(legacy);
  assert.ok(redacted);
  assert.equal(redacted.decisions, undefined);
});

test('redactRecord: viewer 스냅샷만, priorActions 재필터, 상대 홀카드 없음', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'raise', 150).state;
  st = applyAction(st, 'p1', 'fold').state;
  st = applyAction(st, 'p2', 'fold').state;
  const leaked = structuredClone(st.lastHand);
  leaked.decisions[0].priorActions.push({
    decisionId: 'd-x',
    playerId: 'p1',
    action: 'fold',
    amount: 0,
    street: 'preflop',
    potTotal: 75,
    callAmount: 0,
    minRaiseTo: 0,
    maxRaiseTo: 0,
    board: [],
    stacks: {},
    policyId: 'secret-policy',
    sampledProbability: 0.42,
  });
  const redacted = redactRecord(leaked, 'user');
  assert.equal(redacted.decisions.length, 1);
  assert.equal(redacted.decisions[0].actorId, 'user');
  const json = JSON.stringify(redacted);
  assert.equal(json.includes('secret-policy'), false);
  assert.equal(json.includes('sampledProbability'), false);
  for (const card of st.lastHand.holes.p1) assert.equal(json.includes(card), false);
  for (const card of st.lastHand.holes.p2) assert.equal(json.includes(card), false);
  const other = redactRecord(leaked, 'p1');
  assert.equal((other.decisions ?? []).length, 0);
});

test('positionsOf 엔진 라벨 2인·6인 (positions.js)', () => {
  const hu = createGame({ aiCount: 1 });
  hu.button = 1;
  const dealt = startHand(hu, { deck: newDeck() }).state;
  assert.deepEqual(positionsOf(dealt), { user: 'BTN/SB', p1: 'BB' });

  const six = createGame({ aiCount: 6 });
  six.button = 0;
  const full = positionsOf(six);
  assert.deepEqual(
    [full.user, full.p1, full.p2, full.p3, full.p4, full.p5, full.p6],
    ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'CO'],
  );
});

test('snapshotDecision: 핸드 없으면 SNAPSHOT_INVALID', () => {
  const st = createGame({ aiCount: 2 });
  assert.throws(
    () => snapshotDecision(st, 'user', { action: 'fold', amount: 0 }, { blinds: [25, 50] }),
    { code: 'SNAPSHOT_INVALID' },
  );
});

test('priorActions의 currentBet이 hand.actions[i].currentBet과 정확히 일치한다', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call').state;
  st = applyAction(st, 'p1', 'call').state;
  st = applyAction(st, 'p2', 'check').state;
  st = applyAction(st, 'p1', 'check').state;
  st = applyAction(st, 'p2', 'check').state;
  st = applyAction(st, 'user', 'check').state;
  const snap = st.hand.decisions.at(-1);
  assert.ok(snap.priorActions.length > 0);
  for (let i = 0; i < snap.priorActions.length; i += 1) {
    assert.equal(snap.priorActions[i].currentBet, st.hand.actions[i].currentBet);
  }
});

test('PRIOR_ACTION_KEYS는 engine/views.js safeAction의 키 목록과 정확히 일치한다', () => {
  assert.deepEqual([...PRIOR_ACTION_KEYS].sort(), [...SAFE_ACTION_KEYS].sort());
});

test('cli hand --redacted 에 user decisions만 있고 상대 홀카드가 없다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-decision-'));
  const run = (args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--game-dir', dir], {
    encoding: 'utf8',
    timeout: 20000,
  }).trim());
  run(['init', '--ai', '2']);
  // Distinct opponent holes so a board/user card cannot substring-match as a leak.
  const started = run(['new-hand', '--deck', 'Ah,Kd,7h,2c,Qs,Jd,9c,8s,3d,4h,5s,6c,Th']);
  const oppHoles = {};
  for (const event of started.events ?? []) {
    if (event.type === 'deal_hole' && event.playerId !== 'user') {
      oppHoles[event.playerId] = event.cards;
    }
  }
  for (let i = 0; i < 40; i += 1) {
    const legal = run(['legal']);
    if (legal.handOver) break;
    const action = legal.toAct === 'user' ? (legal.canCheck ? 'check' : 'fold') : (legal.canCheck ? 'check' : 'call');
    run(['apply', legal.toAct, action]);
  }
  const redacted = run(['hand', '1', '--redacted']);
  const json = JSON.stringify(redacted);
  assert.ok(Array.isArray(redacted.decisions));
  for (const snap of redacted.decisions) assert.equal(snap.actorId, 'user');
  for (const cards of Object.values(oppHoles)) {
    for (const card of cards) {
      const revealed = (redacted.showdown?.reveals ?? []).some((r) => r.cards?.includes(card));
      if (!revealed) assert.equal(json.includes(card), false, `홀카드 유출: ${card}`);
    }
  }
});
