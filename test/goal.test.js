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
