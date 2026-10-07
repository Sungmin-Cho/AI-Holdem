import test from 'node:test';
import assert from 'node:assert/strict';
import { newDeck } from '../engine/cards.js';
import { snapshotDecision } from '../engine/decision.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { evaluatePreflopReferenceV3 } from '../training/preflop-reference-v3.js';
import { projectTrainingSummary } from '../publish-contract.js';
import { eventFromEvaluation } from '../training/profile-store.js';
import { rebuildFromEvents } from '../training/profile-aggregator.js';
import { referenceAssessmentEligibility } from '../shared/reference-coverage.js';
import { generateQueue } from '../training/drill-generator.js';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';
import { nativePreflopSnapshotV3 } from '../training/native-preflop-snapshot-v3.js';
import { buildPreActionHint } from '../training/pre-action-hint.js';
import { loadReferenceDataset } from '../tools/preflop-dataset.js';
import { V3_REFERENCE_SOURCE, formatReferenceReason } from '../shared/reference.js';
import { lookup } from '../training/providers/preflop-json.js';
import { feedbackBars, formatQuestion, spotDiagram } from '../server/drill-public/study-format.js';

const dataset = loadReferenceDataset(V3_REFERENCE_SOURCE);
const source = { id: dataset.data.id, version: dataset.data.version, contentSha256: dataset.contentSha256 };
const EPOCH = 'ab'.repeat(32);

// Six seats [user, p1..p5]; the button index decides the user's seat.
function deckFor(state, userCards) {
  const n = state.seats.length;
  const sb = ((state.button + 1) % n + 1) % n;
  const order = Array.from({ length: n }, (_, i) => state.seats[(sb + i) % n].playerId);
  const u = order.indexOf('user');
  const rest = newDeck().filter((card) => !userCards.includes(card));
  const deck = [];
  for (let i = 0; i < 2 * n; i += 1) deck.push(i === u ? userCards[0] : i === n + u ? userCards[1] : rest.shift());
  return [...deck, ...rest];
}
function atUserTurn(cards) {
  const game = createGame({ aiCount: 5, mode: 'cash-training', startStackBb: 100, handLimit: 10, levelEvery: null });
  game.button = 5; // the user is on the button
  let state = startHand(game, { deck: deckFor(game, cards) }).state;
  while (legalFor(state).toAct !== 'user') state = applyAction(state, legalFor(state).toAct, 'fold').state;
  return state;
}
function userDecision(cards, action, amount) {
  const state = atUserTurn(cards);
  const next = applyAction(state, 'user', action, amount).state;
  return (next.hand ?? next.lastHand).decisions.filter((d) => d.actorId === 'user').at(-1);
}

test('a v3 game decision travels through publication and the profile as an exact comparison', () => {
  const allowed = evaluatePreflopReferenceV3(userDecision(['As', 'Kd'], 'raise', 150), dataset, { gameEpoch: EPOCH });
  const offPolicy = evaluatePreflopReferenceV3(userDecision(['7s', '2d'], 'raise', 125), dataset, { gameEpoch: 'cd'.repeat(32) });
  for (const e of [allowed, offPolicy]) {
    assert.equal(referenceAssessmentEligibility(e).metricEligible, true);
    const summary = projectTrainingSummary({ ...e, handNo: 1 });
    assert.deepEqual(summary.coverage, e.coverage);
    assert.match(summary.payloadSha256, /^[0-9a-f]{64}$/);
  }
  const events = [allowed, offPolicy].map((e, i) => eventFromEvaluation({ ...e, payloadSha256: `${i}`.repeat(64), origin: 'game' }, `2026-10-07T00:00:0${i}.000Z`));
  assert.equal(events[0].skillKey, 'preflop.v3.6max-100bb-btn-rfi-v3');
  assert.ok(events.every((event) => event.mixObservation && event.coverage));
  const profile = rebuildFromEvents(events);
  const skill = profile.skills['preflop.v3.6max-100bb-btn-rfi-v3'];
  assert.equal(skill.opportunities, 2);
  assert.equal(skill.allowed, 1, 'a 3bb open with AKo is the open class: allowed');
  assert.equal(skill.offPolicy, 1);
  assert.equal(profile.coverage.exactComparableDecisions, 2);
});

test('a v3 drill asks reachable hands with the tree sizes and grades like the game', () => {
  const admits = (spotKey, handClass) => lookup(dataset, { spotKey, handClass }).status === 'supported';
  const spotKey = '6max-100bb-co-vs-btn-3bet-v3';
  assert.throws(() => generateQueue({ mode: 'free', source, spotKey, handClass: '72o', limit: 1, admits }), { code: 'UNSUPPORTED_HAND' });
  const [question] = generateQueue({ mode: 'free', source, spotKey, handClass: 'AA', limit: 1, admits });
  const shown = formatQuestion(question);
  assert.deepEqual(shown.actions.map((row) => `${row.action}${row.sizeBb ? `:${row.sizeBb}` : ''}`), ['fold', 'call', 'raise:20']);
  assert.match(shown.context, /내 오픈에 BTN 3벳/);
  assert.equal(spotDiagram(question.prompt).seats.find((seat) => seat.position === 'BTN').role, 'opener');
  const answer = { action: 'raise', sizeBb: 20 };
  const strategy = { status: 'supported', source: lookup(dataset, { spotKey: '', handClass: '' }).source,
    actions: evaluatePreflopReferenceV3(nativePreflopSnapshotV3(spotKey, 'AA', null), dataset, { gameEpoch: EPOCH }).recommended };
  const result = evaluateDrillAnswer(question, answer, strategy);
  const asGame = evaluatePreflopReferenceV3(nativePreflopSnapshotV3(spotKey, 'AA', answer), dataset, { gameEpoch: EPOCH });
  assert.equal(result.grade, asGame.grade);
  const event = { status: 'supported', forced: false, spotKey, handClass: 'AA', grade: result.grade, source,
    coverage: asGame.coverage, recommended: result.recommended, chosen: answer };
  assert.equal(referenceAssessmentEligibility(event).metricEligible, true, 'the drill event is an exact v3 comparison');
  assert.ok(feedbackBars({ ...result, questionId: question.questionId }, source, { ...answer, questionId: question.questionId }).mineLabel);
  // Every free question of the v3 source is reachable.
  for (const q of generateQueue({ mode: 'free', source, seed: 'x', limit: 30, admits })) assert.equal(admits(q.prompt.spotKey, q.prompt.handClass), true);
});

test('a v3 pre-action hint is built from the same rows, before any choice', () => {
  const state = atUserTurn(['As', 'Kd']);
  const legal = legalFor(state);
  const snapshot = snapshotDecision(state, 'user', null, { legal, blinds: state.config.blinds0 });
  const hint = buildPreActionHint(snapshot, dataset, { gameEpoch: EPOCH, stateVersion: 0 });
  assert.equal(hint.status, 'supported');
  assert.equal(hint.coverage.schemaVersion, 2);
  assert.equal(hint.coverage.choiceMatch, 'not-observed');
  assert.equal(hint.actions.find((row) => row.action === 'raise').raiseToChips, 125);
  assert.match(formatReferenceReason('OPENER_RANGE_UNREACHABLE'), /오픈 범위 밖/);
});
