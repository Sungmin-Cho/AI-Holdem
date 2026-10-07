import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newDeck } from '../engine/cards.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { parsePreflopJson } from '../training/providers/preflop-json.js';
import { evaluatePreflopReferenceV3 } from '../training/preflop-reference-v3.js';
import { projectReferenceCoverageV3 } from '../shared/reference-coverage-v3.js';

const raw = fs.readFileSync(new URL('../training/data/preflop-baseline-v3.json', import.meta.url), 'utf8');
const V3 = parsePreflopJson(raw, { expectedSha256: fs.readFileSync(new URL('../training/data/preflop-baseline-v3.sha256', import.meta.url), 'utf8').trim() });
const EPOCH = 'a'.repeat(64);

// Six seats [user, p1..p5]. `userSeat` picks the user's position:
// button index b moves to b+1 at startHand, then SB, BB, UTG... follow.
const BUTTON_FOR = { BTN: 5, SB: 4, BB: 3, UTG: 2, HJ: 1, CO: 0 };
function deckFor(state, userCards) {
  // Deal order starts at the small blind (left of the button), two rounds.
  const n = state.seats.length;
  const button = (state.button + 1) % n;
  const sb = (button + 1) % n;
  const order = Array.from({ length: n }, (_, i) => state.seats[(sb + i) % n].playerId);
  const u = order.indexOf('user');
  const rest = newDeck().filter((card) => !userCards.includes(card));
  const deck = [];
  for (let i = 0; i < 2 * n; i += 1) deck.push(i === u ? userCards[0] : i === n + u ? userCards[1] : rest.shift());
  return [...deck, ...rest];
}
function table({ position, cards, stacks = null, mode = 'cash-training' }) {
  const g = createGame(mode === 'cash-training' ? { aiCount: 5, mode, startStackBb: 100, handLimit: 10, levelEvery: null } : { aiCount: 5, levelEvery: 50 });
  g.button = BUTTON_FOR[position];
  if (stacks) g.seats.forEach((seat, i) => { seat.stack = stacks[i]; });
  return startHand(g, { deck: deckFor(g, cards) }).state;
}
// Plays scripted actions for other seats until the user acts, then the user's action.
function decide(state, script, userAction) {
  let st = state;
  const queue = [...script];
  while (legalFor(st).toAct !== 'user') {
    const legal = legalFor(st);
    const [action, amount] = queue.shift() ?? ['fold'];
    st = applyAction(st, legal.toAct, action, amount).state;
  }
  const [action, amount] = userAction(legalFor(st));
  const next = applyAction(st, 'user', action, amount).state;
  const hand = next.hand ?? next.lastHand;
  return hand.decisions.filter((d) => d.actorId === 'user').at(-1);
}
const evaluate = (snap) => evaluatePreflopReferenceV3(snap, V3, { gameEpoch: EPOCH });

test('RFI: a 2.5bb or 3bb open is graded; a 4bb open and a limp are not compared', () => {
  const open = (amount) => evaluate(decide(table({ position: 'BTN', cards: ['As', 'Kd'] }), [], () => ['raise', amount]));
  const e25 = open(125);
  assert.equal(e25.status, 'supported');
  assert.equal(e25.spotKey, '6max-100bb-btn-rfi-v3');
  assert.equal(e25.coverage.metricEligible, true);
  assert.equal(e25.grade, 'preferred');
  assert.equal(open(150).coverage.metricEligible, true);
  const e4 = open(200);
  assert.equal(e4.coverage.choiceMatch, 'unavailable');
  assert.deepEqual(e4.coverage.reasonCodes, ['CHOICE_SIZE_OUT_OF_RANGE']);
  assert.equal(e4.grade, null);
  const limp = evaluate(decide(table({ position: 'BTN', cards: ['As', 'Kd'] }), [], () => ['call']));
  assert.deepEqual(limp.coverage.reasonCodes, ['CHOICE_OUT_OF_TREE']);
  const trash = evaluate(decide(table({ position: 'BTN', cards: ['7s', '2d'] }), [], () => ['raise', 125]));
  assert.equal(trash.grade, 'off-policy');
  for (const e of [e25, e4, limp, trash]) assert.deepEqual(projectReferenceCoverageV3(e.coverage), e.coverage);
});

test('facing an open: big blind defence is graded; a 5bb open is out of range', () => {
  const vs = (openTo, action) => evaluate(decide(table({ position: 'BB', cards: ['Qd', '8c'] }),
    [['raise', openTo]], () => action));
  const call = vs(125, ['call']);
  assert.equal(call.spotKey, '6max-100bb-bb-vs-utg-open-v3');
  assert.equal(call.coverage.referenceMatch, 'exact');
  assert.equal(call.coverage.metricEligible, true);
  const big = vs(250, ['fold']);
  assert.equal(big.status, 'unsupported');
  assert.equal(big.code, 'FACING_SIZE_OUT_OF_RANGE');
});

test('facing a 3-bet: a deep all-in 4-bet is not compared; an off-chart opener is not graded', () => {
  const vs3 = (cards, userFinal) => {
    let st = table({ position: 'UTG', cards });
    const btn = st.seats[st.button].playerId;
    st = applyAction(st, 'user', 'raise', 125).state;               // UTG opens
    while (legalFor(st).toAct !== btn) st = applyAction(st, legalFor(st).toAct, 'fold').state;
    st = applyAction(st, btn, 'raise', 425).state;                  // BTN 3-bets to 8.5bb
    while (legalFor(st).toAct !== 'user') st = applyAction(st, legalFor(st).toAct, 'fold').state;
    const [action, amount] = userFinal(legalFor(st));
    const next = applyAction(st, 'user', action, amount).state;
    return evaluate((next.hand ?? next.lastHand).decisions.filter((d) => d.actorId === 'user').at(-1));
  };
  const jam = vs3(['Ah', 'Ad'], (legal) => ['raise', legal.maxRaiseTo]);
  assert.equal(jam.spotKey, '6max-100bb-utg-vs-btn-3bet-v3');
  assert.deepEqual(jam.coverage.reasonCodes, ['DEEP_ALLIN_UNMODELED']);
  const fourBet = vs3(['Ah', 'Ad'], () => ['raise', 1000]);
  assert.equal(fourBet.coverage.metricEligible, true);
  assert.equal(fourBet.grade, 'preferred');
  const offChart = vs3(['7h', '2d'], () => ['fold']);
  assert.equal(offChart.status, 'unsupported');
  assert.equal(offChart.code, 'OPENER_RANGE_UNREACHABLE');
  assert.deepEqual(projectReferenceCoverageV3(offChart.coverage), offChart.coverage);
});

test('tournament short stacks: push and call-a-shove are graded; uneven stacks are projected', () => {
  // 10bb everywhere at 25/50 (500 chips).
  const even = Array(6).fill(500);
  const push = evaluate(decide(table({ position: 'BTN', cards: ['Kh', 'Td'], stacks: even, mode: 'tournament' }), [], (l) => ['raise', l.maxRaiseTo]));
  assert.equal(push.spotKey, '6max-10bb-btn-push-v3');
  assert.equal(push.coverage.metricEligible, true);
  assert.ok(['preferred', 'mixed'].includes(push.grade));
  // The big blind holds 2bb: the model's caller range does not apply.
  const uneven = [500, 500, 100, 500, 500, 500];
  const projected = evaluate(decide(table({ position: 'BTN', cards: ['Kh', 'Td'], stacks: uneven, mode: 'tournament' }), [], (l) => ['raise', l.maxRaiseTo]));
  assert.equal(projected.coverage.referenceMatch, 'projected');
  assert.deepEqual(projected.coverage.reasonCodes, ['PUSHFOLD_PROJECTED']);
  const minRaise = evaluate(decide(table({ position: 'BTN', cards: ['Kh', 'Td'], stacks: even, mode: 'tournament' }), [], (l) => ['raise', l.minRaiseTo]));
  assert.deepEqual(minRaise.coverage.reasonCodes, ['CHOICE_OUT_OF_TREE']);
  // CO shoves 8bb, folds to the user in the big blind.
  const shoveStacks = [500, 500, 500, 400, 500, 500]; // CO (seat 3) holds 8bb
  const call = evaluate(decide(table({ position: 'BB', cards: ['Ah', '9c'], stacks: shoveStacks, mode: 'tournament' }),
    [['fold'], ['fold'], ['raise', 400]], () => ['call']));
  assert.equal(call.coverage.derived.context, 'vs-shove');
  assert.match(call.spotKey, /^6max-\d+bb-bb-vs-co-shove-v3$/);
  assert.deepEqual(projectReferenceCoverageV3(call.coverage), call.coverage);
});

test('a 20bb unopened decision is a mid stack; a forged coverage is rejected', () => {
  const mid = evaluate(decide(table({ position: 'BTN', cards: ['As', 'Kd'], stacks: Array(6).fill(1000), mode: 'tournament' }), [], () => ['raise', 125]));
  assert.equal(mid.code, 'MID_STACK_UNSUPPORTED');
  const good = evaluate(decide(table({ position: 'BTN', cards: ['As', 'Kd'] }), [], () => ['raise', 125]));
  const forged = structuredClone(good.coverage);
  forged.derived.spotKey = '6max-100bb-co-rfi-v3';
  assert.throws(() => projectReferenceCoverageV3(forged), /REFERENCE_COVERAGE_INVALID|derivation/);
  const notEligible = structuredClone(good.coverage);
  notEligible.input.chosen.toChips = 400;
  assert.throws(() => projectReferenceCoverageV3(notEligible), /derivation/);
});
