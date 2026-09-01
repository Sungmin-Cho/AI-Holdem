import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDecision } from '../training/decision-evaluator.js';

function sixSeats() {
  return ['user', 'p1', 'p2', 'p3', 'p4', 'p5'].map((playerId) => ({
    playerId, out: false, folded: false, allIn: false, stack: 10000, bet: 0, contribution: 0,
  }));
}

function snap(overrides = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    street: 'preflop',
    position: 'BTN',
    holeCards: ['Ah', 'Ad'],
    blinds: [50, 100],
    effectiveStack: 10000,
    publicSeats: sixSeats(),
    priorActions: [],
    chosenAction: { action: 'raise', amount: 250 },
    forced: false,
    ...overrides,
  };
}

const source = { id: 'local-preflop-baseline', version: '1.0.0', license: 'Apache-2.0', contentSha256: 'abc' };

test('frequency grades: off-policy / preferred / mixed / low-frequency; EV always null', () => {
  const actions = [
    { action: 'raise', sizeBb: 2.5, frequency: 0.6, evBb: null },
    { action: 'fold', frequency: 0.4, evBb: null },
  ];
  const preferred = evaluateDecision(snap(), { status: 'supported', actions, source }, { gameEpoch: 'epoch' });
  assert.equal(preferred.grade, 'preferred');
  assert.equal(preferred.chosen.evBb, null);
  assert.equal(preferred.bestEvBb, null);
  assert.equal(preferred.evLossBb, null);
  assert.ok(preferred.evaluationId.includes('local-preflop-baseline@1.0.0'));

  const fold = evaluateDecision(
    snap({ chosenAction: { action: 'fold', amount: 0 } }),
    { status: 'supported', actions, source },
    { gameEpoch: 'epoch' },
  );
  assert.equal(fold.grade, 'mixed');

  const low = evaluateDecision(
    snap({ chosenAction: { action: 'call', amount: 100 } }),
    {
      status: 'supported',
      actions: [
        { action: 'raise', sizeBb: 2.5, frequency: 0.92 },
        { action: 'call', frequency: 0.05 },
        { action: 'fold', frequency: 0.03 },
      ],
      source,
    },
    { gameEpoch: 'epoch' },
  );
  assert.equal(low.grade, 'low-frequency');

  const off = evaluateDecision(
    snap({ chosenAction: { action: 'call', amount: 100 } }),
    { status: 'supported', actions, source },
    { gameEpoch: 'epoch' },
  );
  assert.equal(off.grade, 'off-policy');
  assert.equal(off.chosen.frequency, 0);

  const a = JSON.stringify(preferred);
  const b = JSON.stringify(evaluateDecision(snap(), { status: 'supported', actions, source }, { gameEpoch: 'epoch' }));
  assert.equal(a, b);
});
