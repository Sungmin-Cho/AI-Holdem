import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotDecision } from '../engine/decision.js';

test('REQ-004: prospective snapshots carry authoritative legal actions', async () => {
  const { setup3 } = await import('./helpers/fixtures.js');
  const { blindsForLevel, legalFor } = await import('../engine/hand.js');
  const state = setup3(5000, 5000, 5000);
  const legal = legalFor(state);
  const snapshot = snapshotDecision(state, legal.toAct, null, {
    blinds: blindsForLevel(state.level, state.config.blinds0),
    legal,
  });

  assert.strictEqual(snapshot.schemaVersion, 2, 'new decision snapshots must carry legal evidence');
});

import { applyAction, blindsForLevel, createGame, legalFor, startHand } from '../engine/hand.js';
import { turnSummary } from '../engine/views.js';
import { assertSnapshot } from '../training/contracts.js';
import { buildProcessInput, toProcessReview } from '../training/process-review.js';
import { personaGuidance } from '../tools/persona-guidance.js';
import { buildPlayerPrompt } from '../tools/player-runtime.js';
import { validateExplanation } from '../training/explain.js';
import { CANONICAL_REFERENCE_SOURCE } from '../shared/reference.js';
import { projectReferenceEvaluation } from '../export/hand-normalizer.js';
import { aggregateProcessRows } from '../tools/training-pipeline.js';
import { fixedDeck, setup3 } from './helpers/fixtures.js';
import './helpers/owned-fixtures.mjs';

function prospectiveSnapshot(state, chosenAction = null) {
  const legal = legalFor(state);
  return snapshotDecision(state, legal.toAct, chosenAction, {
    blinds: blindsForLevel(state.level, state.config.blinds0),
    legal,
  });
}

function handRecord(snapshot, extra = {}) {
  return {
    handNo: snapshot.handNo,
    decisions: [snapshot],
    board: ['2c', '3d', '4h', '5s', '6c'],
    endStacks: { user: 5100, p1: 4900 },
    pots: [{ amount: 200, winners: [{ playerId: 'user', amount: 200 }] }],
    showdown: { reveals: [{ playerId: 'p1', cards: ['As', 'Kd'] }] },
    winners: ['user'],
    net: { user: 100, p1: -100 },
    result: 'win',
    actions: [...snapshot.priorActions, { action: 'raise', playerId: 'p1', amount: 5000 }],
    stats: { user: { net: 100, showdownWin: 1, confidence: 0.99 } },
    ...extra,
  };
}

test('schema 2 legal evidence is byte-for-byte engine authority', () => {
  const state = setup3(5000, 5000, 5000);
  const legal = legalFor(state);
  const snapshot = prospectiveSnapshot(state, { action: 'call', amount: legal.callAmount });
  assert.deepEqual(snapshot.legal, {
    decisionId: legal.decisionId,
    canCheck: legal.canCheck,
    canRaise: legal.canRaise,
    callAmount: legal.callAmount,
    minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo,
  });
  assert.doesNotThrow(() => assertSnapshot(snapshot));
});

test('only-short-all-in legal evidence preserves the inverted min/max boundary', () => {
  const state = setup3(80, 5000, 5000);
  const legal = legalFor(state);
  assert.equal(legal.canRaise, true);
  assert.ok(legal.minRaiseTo > legal.maxRaiseTo);
  const snapshot = prospectiveSnapshot(state);
  assert.deepEqual(snapshot.legal, {
    decisionId: legal.decisionId,
    canCheck: false,
    canRaise: true,
    callAmount: legal.callAmount,
    minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo,
  });
});

test('short all-in does not reconstruct reopening rights from min/max', () => {
  let state = setup3(5000, 5000, 120);
  state = applyAction(state, 'user', 'raise', 100).state;
  state = applyAction(state, 'p1', 'call').state;
  state = applyAction(state, 'p2', 'raise', 120).state;
  const legal = legalFor(state);
  assert.equal(legal.toAct, 'user');
  assert.equal(legal.canRaise, false);
  const snapshot = prospectiveSnapshot(state);
  assert.equal(snapshot.legal.canRaise, false);
  assert.ok(snapshot.legal.maxRaiseTo > snapshot.legal.minRaiseTo);
});

test('no-respondent actor cannot raise even with chips behind', () => {
  const game = createGame({ aiCount: 1, startStack: 5000 });
  game.button = 1;
  game.seats[1].stack = 50;
  const state = startHand(game, { deck: fixedDeck() }).state;
  const legal = legalFor(state);
  assert.equal(legal.toAct, 'user');
  assert.equal(legal.canRaise, false);
  assert.equal(prospectiveSnapshot(state).legal.canRaise, false);
});

test('schema 1 remains quantitative-compatible but process review is unavailable', () => {
  const state = setup3(5000, 5000, 5000);
  const current = prospectiveSnapshot(state, { action: 'fold', amount: 0 });
  const { legal, ...legacy } = current;
  legacy.schemaVersion = 1;
  assert.doesNotThrow(() => assertSnapshot(legacy));
  const review = toProcessReview(handRecord(legacy));
  assert.equal(review.decisions[0].processStatus, 'unavailable');
  assert.deepEqual(review.unavailableReasons, [{
    decisionId: legacy.decisionId,
    code: 'LEGAL_EVIDENCE_MISSING',
  }]);
});

test('process input is invariant to final board, outcome stacks, winners and future actions', () => {
  const state = setup3(5000, 5000, 5000);
  const snapshot = prospectiveSnapshot(state, { action: 'fold', amount: 0 });
  const first = handRecord(snapshot);
  const changed = handRecord(snapshot, {
    board: ['Ah', 'Ad', 'Ac', 'As', 'Kh'],
    endStacks: { user: 0, p1: 10000 },
    pots: [{ amount: 10000, winners: [{ playerId: 'p1', amount: 10000 }] }],
    showdown: { reveals: [{ playerId: 'p1', cards: ['Qh', 'Qd'] }] },
    winners: ['p1'],
    net: { user: -5000, p1: 5000 },
    result: 'lose',
    actions: [{ action: 'raise', playerId: 'p1', amount: 9999, street: 'river' }],
    stats: { user: { net: -5000, showdownWin: 0, confidence: 0.01 } },
  });
  assert.equal(JSON.stringify(buildProcessInput([first])), JSON.stringify(buildProcessInput([changed])));
});

test('process projection contains only own decision-time fields', () => {
  const state = setup3(5000, 5000, 5000);
  const snapshot = prospectiveSnapshot(state, { action: 'fold', amount: 0 });
  const projected = JSON.stringify(buildProcessInput([handRecord(snapshot)]));
  for (const forbidden of ['endStacks', 'winners', 'showdown', 'net', 'result', 'confidence', 'sampledProbability']) {
    assert.equal(projected.includes(forbidden), false, forbidden);
  }
  assert.equal(projected.includes('As'), false, 'opponent showdown hole leaked');
  assert.equal(projected.includes(snapshot.holeCards[0]), true, 'viewer hole was removed');
});

test('process projection drops non-viewer decision snapshots', () => {
  const state = setup3(5000, 5000, 5000);
  const own = prospectiveSnapshot(state, { action: 'fold', amount: 0 });
  const opponent = { ...structuredClone(own), actorId: 'p1', holeCards: ['As', 'Ad'] };
  const review = toProcessReview({ handNo: 1, decisions: [own, opponent] });
  assert.deepEqual(review.decisions.map((row) => row.actorId), ['user']);
  assert.equal(JSON.stringify(review).includes('As'), false);
});

test('schema 2 mismatched legal evidence is unavailable and rejected quantitatively', () => {
  const state = setup3(5000, 5000, 5000);
  const snapshot = prospectiveSnapshot(state, { action: 'fold', amount: 0 });
  snapshot.legal.callAmount += 1;
  assert.throws(() => assertSnapshot(snapshot), { code: 'SNAPSHOT_INVALID' });
  const review = toProcessReview({ handNo: 1, decisions: [snapshot] });
  assert.equal(review.decisions[0].unavailableReason, 'LEGAL_EVIDENCE_INVALID');
});

test('nested extra outcome fields cannot ride on allowed process objects', () => {
  let state = setup3(5000, 5000, 5000);
  state = applyAction(state, 'user', 'call').state;
  state = applyAction(state, 'p1', 'raise', 100).state;
  state = applyAction(state, 'p2', 'call').state;
  const snapshot = prospectiveSnapshot(state, { action: 'call', amount: 50 });
  const clean = toProcessReview(handRecord(snapshot));
  snapshot.chosenAction.outcome = 'PRIVATE_OUTCOME_SENTINEL';
  snapshot.publicSeats[0].holeCards = ['PRIVATE_SEAT_SENTINEL'];
  snapshot.priorActions[0].stacks.private = 'PRIVATE_STACK_SENTINEL';
  snapshot.legal.outcome = 'PRIVATE_LEGAL_SENTINEL';
  const projected = toProcessReview(handRecord(snapshot));
  assert.deepEqual(projected, clean, 'nested unknown fields must be removed at every boundary');
});

test('malformed required process leaves become empty unavailable markers', () => {
  const baseline = prospectiveSnapshot(setup3(5000, 5000, 5000), { action: 'fold', amount: 0 });
  const mutations = [
    (row) => { row.publicSeats[0].stack = { outcome: 'PRIVATE_SENTINEL' }; },
    (row) => { row.chosenAction.amount = { net: 'PRIVATE_SENTINEL' }; },
    (row) => { row.holeCards = [{ hidden: 'PRIVATE_SENTINEL' }, 'Ac']; },
    (row) => { row.board = ['PRIVATE_SENTINEL']; },
    (row) => { row.legal = null; },
    (row) => { row.publicSeats = []; },
    (row) => { row.priorActions = [{ playerId: 'user', action: 'call', stacks: { user: { outcome: 'PRIVATE_SENTINEL' } } }]; },
  ];
  for (const mutate of mutations) {
    const snapshot = structuredClone(baseline);
    mutate(snapshot);
    const decision = toProcessReview(handRecord(snapshot)).decisions[0];
    assert.equal(decision.processStatus, 'unavailable');
    assert.deepEqual(Object.keys(decision).sort(), ['decisionId', 'handNo', 'processStatus', 'unavailableReason']);
    assert.equal(JSON.stringify(decision).includes('PRIVATE_SENTINEL'), false);
  }
});

test('six archetypes have distinct directives and share the legal contract', () => {
  const archetypes = ['TAG', 'LAG', 'Nit', 'CallingStation', 'Maniac', 'Trickster'];
  const directives = archetypes.map((archetype) => personaGuidance(archetype));
  assert.equal(new Set(directives).size, archetypes.length);
  for (const archetype of archetypes) {
    const prompt = buildPlayerPrompt({
      persona: { name: archetype, speech: '말투', personality: '성격', archetype },
    });
    assert.ok(prompt.includes(personaGuidance(archetype)));
    assert.match(prompt, /canRaise=false.*raise/s);
    assert.match(prompt, /minRaiseTo.*maxRaiseTo/s);
    assert.match(prompt, /다른 참가자.*비공개 카드/);
  }
});

test('turn summary adds one bounded public observation and ignores hidden prior state', () => {
  let state = setup3(5000, 5000, 5000);
  state = applyAction(state, 'user', 'fold').state;
  state = applyAction(state, 'p1', 'fold').state;
  const resumed = startHand(state, { deck: fixedDeck() }).state;
  const actor = legalFor(resumed).toAct;
  const before = turnSummary(resumed, actor);
  const changed = structuredClone(resumed);
  changed.lastHand.holes.p1 = ['As', 'Ad'];
  changed.lastHand.deck = ['PRIVATE_DECK_SENTINEL'];
  changed.lastHand.policy = { private: 'PRIVATE_POLICY_SENTINEL' };
  const after = turnSummary(changed, actor);
  assert.equal(after, before);
  assert.equal((before.match(/최근 완료 핸드 공개 관측:/g) ?? []).length, 1);
  assert.ok(before.length < 6000, `turn summary is unbounded: ${before.length}`);
  assert.equal(before.includes('PRIVATE_'), false);
});

test('explanation authority requires an exact supported source and rejects authority claims', () => {
  const base = {
    status: 'supported', handNo: 1,
    chosen: { action: 'fold', frequency: 0.2 },
    recommended: [{ action: 'raise', frequency: 0.8, sizeBb: 2.5 }],
  };
  assert.equal(validateExplanation({ ...base, source: CANONICAL_REFERENCE_SOURCE }, 'raise 80%').ok, true);
  assert.equal(validateExplanation({ ...base, source: { ...CANONICAL_REFERENCE_SOURCE, version: 'spoof' } }, 'raise 80%').ok, false);
  assert.equal(validateExplanation({ ...base, source: { id: 'fake-solver', version: '1.0.0', contentSha256: 'a'.repeat(64) } }, 'raise 80%').ok, false);
  assert.equal(validateExplanation({ status: 'unsupported', handNo: 1 }, '검증된 GTO 정답입니다.').ok, false);
  assert.equal(validateExplanation({ status: 'unsupported', handNo: 1 }, 'GTO 정답이 아닙니다.').ok, true);
});

test('process aggregate excludes synthetic grades while preserving pending lifecycle count', () => {
  const aggregate = aggregateProcessRows([
    { status: 'supported', grade: 'preferred', source: CANONICAL_REFERENCE_SOURCE },
    { status: 'supported', grade: 'off-policy', source: { id: 'fake-solver', version: '1.0.0', contentSha256: 'a'.repeat(64) } },
  ], { pending: 7 });
  assert.deepEqual(aggregate, {
    total: 1, supported: 1, unsupported: 0, offPolicy: 0, pending: 7, supportedRate: 1,
  });
  assert.equal('confidence' in aggregate, false);
});

test('an unbound canonical-looking export preserves input without inventing transport authority', () => {
  const original = { schemaVersion: 1, payloadSha256: 'b'.repeat(64), status: 'supported',
    source: CANONICAL_REFERENCE_SOURCE, grade: 'preferred', chosen: { action: 'call' },
    recommended: [{ action: 'raise', frequency: 0.8 }], explanation: 'raise 80%' };
  const bytes = JSON.stringify(original);
  const projected = projectReferenceEvaluation(original);
  assert.equal(JSON.stringify(original), bytes);
  assert.equal(projected.schemaVersion, 2);
  assert.equal(projected.sourcePayloadSha256, undefined);
  assert.equal(projected.referenceQuality, 'unverified');
  assert.equal(projected.recommended, undefined);
});

test('unverified and synthetic exports remove reference recommendations without inventing hashes', () => {
  for (const source of [
    { ...CANONICAL_REFERENCE_SOURCE, contentSha256: 'c'.repeat(64) },
    { id: 'fake-solver', version: '1.0.0', contentSha256: 'd'.repeat(64) },
  ]) {
    const projected = projectReferenceEvaluation({
      status: 'supported', grade: 'preferred', source,
      chosen: { action: 'call' }, recommended: [{ action: 'raise' }],
      explanation: '검증된 GTO 정답',
    });
    assert.equal(projected.recommended, undefined);
    assert.equal(projected.grade, undefined);
    assert.equal(projected.explanation, undefined);
    assert.equal(projected.sourcePayloadSha256, undefined);
    assert.deepEqual(projected.chosen, { action: 'call' });
  }
});

test('process projection rejects future actions hidden inside priorActions', () => {
  const snapshot = prospectiveSnapshot(setup3(5000, 5000, 5000), { action: 'fold', amount: 0 });
  snapshot.priorActions.push({
    decisionId: 'd-1-river-999', playerId: 'p1', action: 'raise', amount: 500,
    street: 'river', potTotal: 1000, callAmount: 50, minRaiseTo: 100, maxRaiseTo: 5000,
    board: ['Ac', 'Ad', 'Ah', 'As', 'Kd'], stacks: { user: 4500, p1: 4500, p2: 4500 }, currentBet: 50,
  });
  const decision = toProcessReview(handRecord(snapshot)).decisions[0];
  assert.equal(decision.processStatus, 'unavailable');
  assert.equal(decision.priorActions, undefined);
  assert.equal(JSON.stringify(decision).includes('Ac'), false);
});
