import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHand } from '../export/hand-normalizer.js';

test('unrevealed opponent holes are stripped; raise amount is raise-to', () => {
  const hand = normalizeHand({
    handNo: 1,
    button: 'user',
    blinds: [50, 100],
    holes: { user: ['Ah', 'Kd'], p1: ['2c', '2d'] },
    board: [],
    posts: [{ playerId: 'p1', amount: 50, allIn: false }],
    uncalledReturns: { user: 150 },
    actions: [{ playerId: 'user', action: 'raise', amount: 250, street: 'preflop', currentBet: 100 }],
    pots: [{ amount: 250, winners: ['user'] }],
    showdown: { reveals: [] },
    startStacks: { user: 10000, p1: 10000 },
    endStacks: { user: 10250, p1: 9750 },
    decisions: [],
  });
  assert.deepEqual(hand.heroCards, ['Ah', 'Kd']);
  assert.equal(hand.holes.p1, undefined);
  assert.equal(hand.actions[0].amount, 250);
  assert.equal(hand.actions[0].currentBet, 100);
  assert.deepEqual(hand.posts, [{ playerId: 'p1', amount: 50, allIn: false }]);
  assert.equal(hand.uncalledReturns.user, 150);
});
