import test from 'node:test';
import assert from 'node:assert/strict';
import { selectGoal, practiceFocusGoal, skillStanding } from '../training/goal.js';
import { LEGACY_REFERENCE_SOURCE } from '../shared/reference.js';

// v1 events need no coverage: an exact v1 comparison with no hint.
let clock = 0;
function event({ skill = 'preflop.rfi.BTN', grade = 'preferred', origin = 'game', hand = 'AJo', hint = false, forced = false } = {}) {
  clock += 1;
  const allowed = grade !== 'off-policy';
  return {
    schemaVersion: 6, skillKey: skill, grade, origin, status: 'supported', forced,
    appliedAt: new Date(Date.UTC(2026, 9, 1) + clock * 1000).toISOString(),
    providerId: LEGACY_REFERENCE_SOURCE.id, providerVersion: LEGACY_REFERENCE_SOURCE.version,
    assistance: { schemaVersion: 1, hintShown: hint, exposureId: hint ? 'ab'.repeat(32) : null },
    mixObservation: {
      spotKey: '6max-100bb-btn-rfi-unopened', handClass: hand,
      referenceActions: [{ action: 'raise', sizeBb: 2.5, frequency: 0.8 }, { action: 'fold', frequency: 0.2 }],
      chosenAction: allowed ? { action: 'raise', sizeBb: 2.5 } : { action: 'call' },
      sourceIdentity: { ...LEGACY_REFERENCE_SOURCE },
    },
  };
}

test('the goal is the skill with the largest confident off-policy share, naming the latest missed hand', () => {
  const events = [
    ...Array.from({ length: 10 }, (_, i) => event({ skill: 'preflop.rfi.BTN', grade: i % 2 ? 'off-policy' : 'preferred', hand: `A${i}o`.replace('A0o', 'A2o') })),
    ...Array.from({ length: 2 }, () => event({ skill: 'preflop.rfi.CO', grade: 'off-policy', hand: 'KTo' })),
  ];
  const goal = selectGoal(events);
  assert.equal(goal.skillKey, 'preflop.rfi.BTN', '5/10 × 10/15 beats 2/2 × 2/7');
  assert.equal(goal.origin, 'game');
  assert.equal(goal.handClass, 'A9o');
  assert.equal(goal.sample, 10);
  assert.deepEqual(practiceFocusGoal(events).id, 'preflop.rfi.BTN');
});

test('a resolved skill, assisted or forced decisions and practice records do not override a game goal', () => {
  const resolved = Array.from({ length: 6 }, (_, i) => event({ skill: 'preflop.rfi.UTG', grade: i === 0 ? 'off-policy' : 'preferred' }));
  assert.equal(skillStanding(resolved.map((e) => ({ offPolicy: e.grade === 'off-policy', allowed: e.grade !== 'off-policy' }))).resolved, true);
  assert.equal(selectGoal(resolved), null, 'five of six allowed: resolved');
  assert.equal(selectGoal([event({ grade: 'off-policy', hint: true }), event({ grade: 'off-policy', forced: true })]), null);
  const practice = event({ skill: 'preflop.rfi.SB', grade: 'off-policy', origin: 'drill' });
  const game = event({ skill: 'preflop.rfi.HJ', grade: 'off-policy', origin: 'game' });
  assert.equal(selectGoal([practice, game]).skillKey, 'preflop.rfi.HJ');
  assert.equal(selectGoal([practice]).origin, 'practice');
  assert.equal(selectGoal([]), null);
});

test('study history picks its goal only from events stamped by now', async () => {
  const { studyHistory } = await import('../training/study-history.js');
  const { evaluationIdOf } = await import('../training/contracts.js');
  const misses = Array.from({ length: 3 }, (_, i) => ({ ...event({ skill: 'preflop.rfi.CO', grade: 'off-policy', hand: 'KTo' }),
    evaluationId: evaluationIdOf({ gameEpoch: 'ab'.repeat(32), decisionId: `d-${i + 1}-preflop-0`,
      providerId: LEGACY_REFERENCE_SOURCE.id, providerVersion: LEGACY_REFERENCE_SOURCE.version }),
    payloadSha256: String(i).repeat(64) }));
  const at = misses[0].appliedAt;
  assert.equal(studyHistory(misses, misses.at(-1).appliedAt).goal.skillKey, 'preflop.rfi.CO');
  const before = new Date(Date.parse(at) - 1000).toISOString();
  assert.equal(studyHistory(misses, before).goal.origin, 'default', 'a future-stamped miss cannot choose the goal');
});

test('a resolved record keeps no goal in every consumer, and future records count nowhere', async () => {
  const { studyHistory } = await import('../training/study-history.js');
  const { evaluationIdOf } = await import('../training/contracts.js');
  const { goalSelection, practiceFocusGoal } = await import('../training/goal.js');
  const { writePracticeFocus } = await import('../tools/profile-cli.js');
  const { createOwnedTempDir } = await import('./helpers/owned-fixtures.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const valid = (rows) => rows.map((row, i) => ({ ...row,
    evaluationId: evaluationIdOf({ gameEpoch: 'cd'.repeat(32), decisionId: `d-${i + 1}-preflop-0`,
      providerId: LEGACY_REFERENCE_SOURCE.id, providerVersion: LEGACY_REFERENCE_SOURCE.version }),
    payloadSha256: String(i % 10).repeat(64) }));
  // One miss, then five allowed decisions: resolved.
  const resolved = valid([event({ skill: 'preflop.rfi.HJ', grade: 'off-policy' }),
    ...Array.from({ length: 5 }, () => event({ skill: 'preflop.rfi.HJ', grade: 'preferred' }))]);
  const now = resolved.at(-1).appliedAt;
  assert.deepEqual(goalSelection(resolved, { now }), { state: 'clear', goal: null });
  assert.equal(studyHistory(resolved, now).goal.origin, 'default', 'the old miss is not revived');
  const storeDir = createOwnedTempDir('goal-focus');
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true });
  const leaky = { game: { candidates: [{ id: 'preflop.rfi.HJ', recommendedDrill: 'preflop.rfi.HJ', severity: 1, confidence: 1 }] } };
  const file = writePracticeFocus(storeDir, leaky, { events: resolved, now });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 2, origin: 'default', goal: null, focus: null });
  // A miss stamped after now is left out by the selector, the focus and the study room alike.
  const future = valid([event({ skill: 'preflop.rfi.CO', grade: 'off-policy' })]);
  const before = new Date(Date.parse(future[0].appliedAt) - 1000).toISOString();
  assert.deepEqual(goalSelection(future, { now: before }), { state: 'none', goal: null });
  assert.equal(practiceFocusGoal(future, { now: before }), null);
  assert.equal(practiceFocusGoal(future, { now: future[0].appliedAt }).id, 'preflop.rfi.CO');
  // A study run that starts after now is future too.
  const run = { ...future[0], appliedAt: before, studyRun: { startedAt: future[0].appliedAt } };
  assert.equal(goalSelection([run], { now: before }).state, 'none');
});

test('the practice-focus fallback cannot revive evidence stamped after now', async () => {
  const { writePracticeFocus } = await import('../tools/profile-cli.js');
  const { rebuildFromEvents } = await import('../training/profile-aggregator.js');
  const { eventFromEvaluation } = await import('../training/profile-store.js');
  const { evaluatePreflopReferenceV3 } = await import('../training/preflop-reference-v3.js');
  const { nativePreflopSnapshotV3 } = await import('../training/native-preflop-snapshot-v3.js');
  const { loadReferenceDataset } = await import('../tools/preflop-dataset.js');
  const { V3_REFERENCE_SOURCE } = await import('../shared/reference.js');
  const { createOwnedTempDir } = await import('./helpers/owned-fixtures.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dataset = loadReferenceDataset(V3_REFERENCE_SOURCE);
  const events = Array.from({ length: 10 }, (_, i) => {
    const epoch = i.toString(16).padStart(2, '0').repeat(32);
    const evaluation = evaluatePreflopReferenceV3(nativePreflopSnapshotV3('6max-100bb-btn-rfi-v3', '72o', { action: 'raise', sizeBb: 2.5 }), dataset, { gameEpoch: epoch });
    return eventFromEvaluation({ ...evaluation, payloadSha256: epoch, origin: 'game' }, `2099-01-01T00:00:${String(i).padStart(2, '0')}.000Z`);
  });
  const now = '2026-10-07T00:00:00.000Z';
  const unfiltered = rebuildFromEvents(events);
  assert.ok((unfiltered.game?.candidates ?? []).length > 0, 'the future record alone would name a leak');
  const storeDir = createOwnedTempDir('goal-future-focus');
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true });
  const file = writePracticeFocus(storeDir, unfiltered, { events, now });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 2, origin: 'default', goal: null, focus: null });
  // At the time the record exists, the same events name the goal.
  const later = writePracticeFocus(storeDir, unfiltered, { events, now: '2099-02-01T00:00:00.000Z' });
  assert.equal(JSON.parse(fs.readFileSync(later, 'utf8')).goal.id, events[0].skillKey);
});
