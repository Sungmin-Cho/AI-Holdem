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
import { projectReferenceEvaluation } from '../export/hand-normalizer.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionReference } from '../tools/reference-source.js';
import { createTrainingControl, materializeLearningEvaluation } from '../tools/training-control.js';
import { measureTrainingCoverage } from '../tools/measure-training-coverage.js';

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
function atUserTurn(cards, startStackBb = 100) {
  const game = createGame({ aiCount: 5, mode: 'cash-training', startStack: startStackBb * 50, startStackBb, handLimit: 10, levelEvery: null });
  game.button = 5; // the user is on the button
  let state = startHand(game, { deck: deckFor(game, cards) }).state;
  while (legalFor(state).toAct !== 'user') state = applyAction(state, legalFor(state).toAct, 'fold').state;
  return state;
}
function userDecision(cards, action, amount, startStackBb) {
  const state = atUserTurn(cards, startStackBb);
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

test('a default v3 hand with preflop, postflop and unscored decisions stays verified end to end', () => {
  // Open 2.5BB on the button (SB p1, BB p2), the big blind calls and checks the flop.
  let state = atUserTurn(['As', 'Kd']);
  state = applyAction(state, 'user', 'raise', 125).state;
  while (legalFor(state).toAct !== 'user') {
    const legal = legalFor(state);
    assert.equal(legal.handOver, false);
    state = applyAction(state, legal.toAct, legal.canCheck ? 'check' : legal.toAct === 'p2' ? 'call' : 'fold').state;
  }
  state = applyAction(state, 'user', 'check').state;
  const decisions = (state.hand ?? state.lastHand).decisions.filter((d) => d.actorId === 'user');
  assert.deepEqual(decisions.map((d) => d.street), ['preflop', 'flop']);
  const [open, flop] = decisions.map((d) => evaluatePreflopReferenceV3(d, dataset, { gameEpoch: EPOCH }));
  // A 5BB open is outside the tree: compared, not scored.
  const wide = evaluatePreflopReferenceV3(userDecision(['2s', '2d'], 'raise', 250), dataset, { gameEpoch: 'ef'.repeat(32) });
  assert.equal(flop.status, 'unsupported');
  assert.equal(flop.coverage, null);
  assert.equal(wide.coverage.metricEligible, false);
  const expected = [[open, true, true], [flop, false, false], [wide, true, false]];
  for (const [e, available, eligible] of expected) {
    assert.deepEqual(referenceAssessmentEligibility(e), { verified: true, referenceAvailable: available, metricEligible: eligible, reason: null });
    assert.deepEqual(projectTrainingSummary({ ...e, handNo: 1 }).coverage, e.coverage);
    // Export projects it without throwing (coverage needs a journal receipt there).
    assert.equal(projectReferenceEvaluation({ ...e, handNo: 1 }).status, e.status);
  }
  const events = expected.map(([e], i) => eventFromEvaluation({ ...e, payloadSha256: `${i + 3}`.repeat(64), origin: 'game' }, `2026-10-07T00:01:0${i}.000Z`));
  // The profile event keeps the choice only for the scored result; the others stay verified.
  events.forEach((event, i) => assert.deepEqual(referenceAssessmentEligibility(event),
    { verified: true, referenceAvailable: expected[i][1], metricEligible: expected[i][2], reason: null }));
  const profile = rebuildFromEvents(events);
  assert.equal(profile.game.coverage.unverifiedDecisions, 0);
  assert.equal(profile.coverage.exactComparableDecisions, 1);
  // A forged postflop result cannot claim a grade or an observation without coverage.
  assert.equal(referenceAssessmentEligibility({ ...flop, grade: 'preferred' }).verified, false);
  assert.equal(referenceAssessmentEligibility({ ...flop, status: 'supported' }).verified, false);
});

test('the accept loop takes a v3 hand with a postflop decision', async (t) => {
  let state = atUserTurn(['As', 'Kd']);
  state = applyAction(state, 'user', 'raise', 125).state;
  while (legalFor(state).toAct !== 'user') {
    const legal = legalFor(state);
    state = applyAction(state, legal.toAct, legal.canCheck ? 'check' : legal.toAct === 'p2' ? 'call' : 'fold').state;
  }
  state = applyAction(state, 'user', 'check').state;
  const decisions = (state.hand ?? state.lastHand).decisions.filter((d) => d.actorId === 'user');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-v3-accept-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  resolveSessionReference(d, { createNew: true, source: V3_REFERENCE_SOURCE });
  fs.mkdirSync(path.join(d, 'hands'));
  fs.writeFileSync(path.join(d, 'hands', 'hand-0001.json'), JSON.stringify({ handNo: 1, decisions }));
  const evaluations = decisions.map((decision) => evaluatePreflopReferenceV3(decision, dataset, { gameEpoch: EPOCH }));
  const { accepted } = await createTrainingControl().acceptEvaluations(d, { gameEpoch: EPOCH, owner: 'test', handNo: 1, evaluations });
  assert.equal(accepted.length, 2);
  for (const [i, item] of accepted.entries()) assert.deepEqual(materializeLearningEvaluation(d, item).coverage, evaluations[i].coverage);
  const journal = path.join(d, 'training', 'evaluations.jsonl');
  fs.writeFileSync(journal, accepted.map((item, i) => `${JSON.stringify({ ...evaluations[i], payloadSha256: item.payloadSha256 })}\n`).join(''));
  const report = measureTrainingCoverage(d);
  assert.equal(report.complete, true);
  assert.equal(report.decisions, 2);
  assert.equal(report.exactComparable, 1);
});

test('the table card links a v3 practice spot and states a v3 projection', async () => {
  const { createHash } = await import('node:crypto');
  const { formatTrainingCard, verifyTrainingDetail } = await import('../server/public/training-format.js');
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const card = async (evaluation) => {
    const detail = { ...evaluation, handNo: 1 };
    const item = { ...projectTrainingSummary(detail), detailRef: sha(detail.evaluationId), detailSha256: sha(JSON.stringify(detail)) };
    const verifiedDetail = await verifyTrainingDetail(item, detail);
    assert.ok(verifiedDetail);
    return formatTrainingCard(item, { verifiedDetail });
  };
  const exact = await card(evaluatePreflopReferenceV3(userDecision(['As', 'Kd'], 'raise', 125), dataset, { gameEpoch: EPOCH }));
  assert.deepEqual({ ...exact.practiceTarget }, { spotKey: '6max-100bb-btn-rfi-v3', handClass: 'AKo' });
  assert.match(exact.title, /6인 BTN/);
  assert.equal(exact.note, '직접 기준표 비교');
  const deep = await card(evaluatePreflopReferenceV3(userDecision(['As', 'Kd'], 'raise', 125, 200), dataset, { gameEpoch: 'fe'.repeat(32) }));
  assert.equal(deep.practiceTarget, null);
  assert.match(deep.note, /^투영 참고: 스택 200\.0bb → 100bb · 점수 제외/);
  assert.equal(deep.grade, null);
  const wide = await card(evaluatePreflopReferenceV3(userDecision(['2s', '2d'], 'raise', 250), dataset, { gameEpoch: 'ed'.repeat(32) }));
  assert.match(wide.note, /직접 비교 범위 밖/);
  assert.equal(wide.grade, null);
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
