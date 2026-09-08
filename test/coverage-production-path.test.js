import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProfileStore } from '../tools/training-stores.js';
import { eventFromEvaluation } from '../training/profile-store.js';
import { rebuildFromEvents } from '../training/profile-aggregator.js';
import { formatSummary } from '../server/drill-public/study-format.js';
import { LEGACY_REFERENCE_SOURCE as source } from '../shared/reference.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

const now = () => '2026-09-06T00:00:00.000Z';
function evaluation(index, { status = 'supported', origin = 'game', identity = source } = {}) {
  return {
    evaluationId: `${'ab'.repeat(32)}:d-${index}-preflop-0:${identity.id}@${identity.version}`,
    payloadSha256: index.toString(16).padStart(64, '0'), street: 'preflop',
    status, origin, source: identity, forced: false, evLossBb: null,
    spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA',
    grade: status === 'supported' ? 'preferred' : null,
    recommended: status === 'supported' ? [{ action: 'raise', sizeBb: 2.5, frequency: 1 }] : [],
    chosen: { action: 'raise', sizeBb: 2.5 },
  };
}
function score(projection) {
  return Object.fromEntries(['overall', 'skills', 'calibration', 'candidates', 'studyRuns'].map((key) => [key, projection[key]]));
}

test('production coverage includes unsupported and unverified without granting score authority', async () => {
  const dir = createOwnedTempDir('holdem-coverage-production');
  const store = createProfileStore(dir, { now });
  const supported = evaluation(1);
  const unsupported = evaluation(2, { status: 'unsupported' });
  const baseline = (await store.apply(supported)).profile;
  const pair = (await store.apply(unsupported)).profile;
  assert.deepEqual(pair.game.coverage, {
    evaluatedDecisions: 2, supportedDecisions: 1, unsupportedDecisions: 1,
    supportedRate: 0.5, unverifiedDecisions: 1,
    referenceAvailableDecisions: 1, exactComparableDecisions: 1, projectedReferenceDecisions: 0, comparisonUnavailableDecisions: 0, forcedDecisions: 0,
  });
  assert.deepEqual(score(pair.game), score(baseline.game));
  assert.equal(eventFromEvaluation(unsupported, now()).mixObservation, undefined);
  const pairUi = formatSummary({ source, game: pair.game });
  assert.match(pairUi.game.coverage, /2개 결정.*참고 가능 1개.*직접 비교 1개/);
  assert.match(pairUi.game.coverage, /지원 제외 1/);
  assert.match(pairUi.game.coverage, /출처 미검증 1/);

  const unknown = evaluation(3, { identity: { ...source, id: 'unknown-reference' } });
  const withUnknown = (await store.apply(unknown)).profile;
  assert.equal(withUnknown.game.coverage.evaluatedDecisions, 3);
  assert.equal(withUnknown.game.coverage.supportedRate, 1 / 3);
  assert.equal(withUnknown.game.coverage.unverifiedDecisions, 2);
  assert.deepEqual(score(withUnknown.game), score(baseline.game));
  const gameBefore = structuredClone(withUnknown.game);
  await store.apply(evaluation(4, { origin: 'practice' }));
  const result = (await store.apply(evaluation(5, { origin: 'practice', status: 'unsupported' }))).profile;
  assert.deepEqual(result.game, gameBefore);
  assert.equal(result.practice.coverage.evaluatedDecisions, 2);
  assert.equal(result.practice.coverage.unsupportedDecisions, 1);
  const journal = path.join(dir, '.training/profile-events.jsonl');
  const raw = fs.readFileSync(journal);
  const events = raw.toString().trim().split('\n').map(JSON.parse);
  assert.deepEqual(events, [supported, unsupported, unknown, evaluation(4, { origin: 'practice' }), evaluation(5, { origin: 'practice', status: 'unsupported' })].map((row) => eventFromEvaluation(row, now())));
  const rebuilt = await store.rebuild();
  assert.deepEqual(rebuilt, result);
  assert.deepEqual(rebuilt, rebuildFromEvents(events));
  assert.deepEqual(await store.show(), rebuilt);
  assert.equal((await store.apply(unsupported)).applied, false);
  assert.deepEqual(fs.readFileSync(journal), raw);
  assert.deepEqual(rebuilt.processed, Object.fromEntries(events.map((row) => [row.evaluationId, row.payloadSha256])));
});

test('legacy unsupported journals remain byte-identical and score-unverified on replay', async () => {
  const dir = createOwnedTempDir('holdem-coverage-legacy');
  const root = path.join(dir, '.training');
  fs.mkdirSync(root);
  const old = { ...eventFromEvaluation(evaluation(6, { status: 'unsupported' }), now()), schemaVersion: 3 };
  const raw = ` ${JSON.stringify(old)} \n`;
  fs.writeFileSync(path.join(root, 'profile-events.jsonl'), raw);
  const store = createProfileStore(dir, { now });
  const profile = await store.rebuild();
  assert.equal(profile.game.coverage.evaluatedDecisions, 1);
  assert.equal(profile.game.coverage.unsupportedDecisions, 1);
  assert.equal(profile.game.coverage.unverifiedDecisions, 1);
  assert.equal(profile.game.overall.supportedDecisions, 0);
  assert.deepEqual(profile.game.skills, {});
  assert.deepEqual(profile.game.candidates, []);
  assert.equal(profile.game.calibration.totalObservations, 0);
  assert.deepEqual(await store.show(), profile);
  assert.equal(fs.readFileSync(path.join(root, 'profile-events.jsonl'), 'utf8'), raw);
});

test('real dataset rounding tolerance agrees through evaluator, persisted score, calibration and history', async () => {
  const { parsePreflopJson, lookup } = await import('../training/providers/preflop-json.js');
  const { evaluateDecision } = await import('../training/decision-evaluator.js');
  const { studyHistory } = await import('../training/study-history.js');
  const dataset = parsePreflopJson(fs.readFileSync(new URL('../training/data/preflop-baseline-v1.json', import.meta.url), 'utf8'), { expectedSha256: source.contentSha256 });
  const strategy = lookup(dataset, { spotKey: '6max-100bb-utg-rfi-unopened', handClass: 'AA' });
  const snap = {
    schemaVersion: 1, decisionId: 'd-20-preflop-0', street: 'preflop', position: 'UTG',
    holeCards: ['Ah', 'Ad'], blinds: [25, 50], effectiveStack: 5000,
    publicSeats: ['user', 'p1', 'p2', 'p3', 'p4', 'p5'].map((playerId) => ({ playerId, out: false, folded: false, allIn: false, stack: 5000, bet: 0, contribution: 0 })),
    priorActions: [], chosenAction: { action: 'raise', amount: 124 }, forced: false,
  };
  const dir = createOwnedTempDir('holdem-rounding-production');
  const store = createProfileStore(dir, { now });
  const events = [];
  for (let index = 20; index < 40; index += 1) {
    const evaluated = evaluateDecision({ ...snap, decisionId: `d-${index}-preflop-0` }, strategy, { gameEpoch: 'ab'.repeat(32) });
    assert.equal(evaluated.grade, 'preferred');
    assert.equal(evaluated.chosen.sizeBb, 2.48);
    evaluated.payloadSha256 = index.toString(16).padStart(64, '0');
    const { profile } = await store.apply(evaluated);
    assert.equal(profile.game.overall.allowedActionRate, 1);
    events.push(eventFromEvaluation(evaluated, now()));
  }
  const journal = path.join(dir, '.training/profile-events.jsonl');
  const raw = fs.readFileSync(journal);
  const rebuilt = await store.rebuild();
  assert.deepEqual(fs.readFileSync(journal), raw);
  assert.deepEqual(raw.toString().trim().split('\n').map(JSON.parse), events);
  assert.equal(rebuilt.game.calibration.distributionAgreement, 1);
  assert.equal(rebuilt.game.overall.offPolicy, 0);
  assert.deepEqual(rebuilt, rebuildFromEvents(events));
  assert.ok(events.every((event) => event.mixObservation.chosenAction.sizeBb === 2.48));
  const historyEvent = { ...events[0], origin: 'practice', studyRun: { id: '11111111-1111-4111-8111-111111111111', mode: 'assessment', total: 1, index: 0, startedAt: now() } };
  const history = studyHistory([historyEvent], now());
  assert.equal(history.assessments[0].complete, true);
  assert.equal(history.assessments[0].result.allowedActionRate, 1);
  for (const amount of [122.5, 127.5]) {
    const boundary = evaluateDecision({ ...snap, chosenAction: { action: 'raise', amount } }, strategy, { gameEpoch: 'ab'.repeat(32) });
    assert.equal(boundary.status, 'supported');
    assert.equal(boundary.grade, 'preferred');
  }
  const outside = evaluateDecision({ ...snap, chosenAction: { action: 'raise', amount: 128 } }, strategy, { gameEpoch: 'ab'.repeat(32) });
  assert.equal(outside.status, 'unsupported');
  const ambiguous = { ...strategy, actions: [{ action: 'raise', sizeBb: 2.46, frequency: 0.5 }, { action: 'raise', sizeBb: 2.5, frequency: 0.5 }] };
  assert.equal(evaluateDecision(snap, ambiguous, { gameEpoch: 'ab'.repeat(32) }).grade, 'off-policy');
});

test('one finite unique reference match governs boundary, ambiguous and off-size projections', async () => {
  const { matchReferenceAction, referenceSizeMatches } = await import('../shared/reference.js');
  const { evaluateDrillAnswer } = await import('../training/drill-evaluator.js');
  const actions = [{ action: 'raise', sizeBb: 2.5, frequency: 1 }];
  for (const size of [2.45, 2.48, 2.5, 2.55]) {
    assert.equal(referenceSizeMatches(size, 2.5), true);
    assert.equal(matchReferenceAction(actions, { action: 'raise', sizeBb: size }), actions[0]);
    assert.equal(evaluateDrillAnswer({}, { action: 'raise', sizeBb: size }, { source, actions }).frequency, 1);
  }
  for (const size of [2.449, 2.551, '2.5', null, undefined, NaN, Infinity, -2.5]) {
    assert.equal(referenceSizeMatches(size, 2.5), false);
    assert.equal(matchReferenceAction(actions, { action: 'raise', sizeBb: size }), null);
    assert.equal(evaluateDrillAnswer({}, { action: 'raise', sizeBb: size }, { source, actions }).frequency, 0);
  }
  const ambiguous = [{ action: 'raise', sizeBb: 2.46, frequency: 0.5 }, { action: 'raise', sizeBb: 2.5, frequency: 0.5 }];
  assert.equal(matchReferenceAction(ambiguous, { action: 'raise', sizeBb: 2.5 }), null);
  assert.equal(evaluateDrillAnswer({}, { action: 'raise', sizeBb: 2.5 }, { source, actions: ambiguous }).frequency, 0);
  for (const [recommended, size] of [[ambiguous, 2.5], [actions, 2.56]]) {
    const events = Array.from({ length: 20 }, (_, index) => eventFromEvaluation({ ...evaluation(100 + index), recommended, chosen: { action: 'raise', sizeBb: size }, grade: 'off-policy' }, now()));
    const profile = rebuildFromEvents(events);
    assert.equal(profile.game.overall.allowedActionRate, 0);
    assert.equal(profile.game.calibration.distributionAgreement, 0);
  }
});
