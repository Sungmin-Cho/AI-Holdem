import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, distributionFor } from '../tools/policy-player.js';
import { policyById } from '../training/policies/catalog.js';

function snapshot(over = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    street: 'preflop',
    holeCards: ['Ah', 'Ad'],
    board: [],
    blinds: [50, 100],
    toCall: 0,
    position: 'UTG',
    publicSeats: Array.from({ length: 6 }, (_, i) => ({
      playerId: i === 0 ? 'user' : `p${i}`,
      out: false,
    })),
    priorActions: [],
    effectiveStack: 10000,
    ...over,
  };
}

const openLegal = {
  canCheck: false,
  canRaise: true,
  callAmount: 50,
  minRaiseTo: 200,
  maxRaiseTo: 10000,
};

test('unsupported postflop uses rule-based fallback reasonCode', () => {
  const items = distributionFor(snapshot({ street: 'flop', board: ['2c', '3d', '4h'] }), {
    canCheck: true,
    canRaise: true,
    callAmount: 0,
    minRaiseTo: 100,
    maxRaiseTo: 10000,
  }, policyById('tag-v1'));
  assert.ok(items.every((row) => row.reasonCode.startsWith('rule-') || row.reasonCode === 'fallback-check'));
});

test('same snapshot/seed/version reproduces the same action', () => {
  const input = {
    snapshot: snapshot(),
    legal: openLegal,
    policy: policyById('baseline-v1'),
    policySeed: 'cc'.repeat(16),
    gameEpoch: 'dd'.repeat(32),
  };
  assert.deepEqual(decide(input), decide(input));
});

test('policy output never leaves the legal set', () => {
  const legal = { canCheck: true, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 };
  const out = decide({
    snapshot: snapshot({ street: 'flop', board: ['2c', '3d', '4h'] }),
    legal,
    policy: policyById('maniac-v1'),
    policySeed: 'ee'.repeat(16),
    gameEpoch: 'ff'.repeat(32),
  });
  assert.equal(out.action, 'check');
});
