import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the primary wager verb follows the log verb rule: bet on an empty street, raise after chips, all-in at the maximum', async () => {
  const { primaryVerb, PRIMARY_VERB_LABEL } = await import('../server/public/table-controls.js');
  const { actionVerbs } = await import('../server/public/replay-format.js');
  const legal = { minRaiseTo: 100, maxRaiseTo: 5000 };
  const seats = (bets) => bets.map((bet, index) => ({ playerId: index ? `p${index}` : 'user', bet }));
  // Preflop: blinds are in, so the first wager is a raise (the log agrees).
  assert.equal(primaryVerb({ street: 'preflop', legal, seats: seats([25, 50]) }, 150), 'raise');
  assert.equal(actionVerbs([{ type: 'hand_start' }, { type: 'action', street: 'preflop', action: 'raise' }]).values().next().value, 'raise');
  // Flop with nobody in yet: a bet, as the log labels the first raise-to of a street.
  assert.equal(primaryVerb({ street: 'flop', legal, seats: seats([0, 0]) }, 200), 'bet');
  assert.equal(actionVerbs([{ type: 'street', street: 'flop' }, { type: 'action', street: 'flop', action: 'raise' }]).values().next().value, 'bet');
  // Flop after a bet: a raise.
  assert.equal(primaryVerb({ street: 'flop', legal, seats: seats([0, 300]) }, 900), 'raise');
  // The maximum is all-in whatever the street.
  assert.equal(primaryVerb({ street: 'flop', legal, seats: seats([0, 0]) }, 5000), 'allin');
  assert.deepEqual(PRIMARY_VERB_LABEL, { bet: '벳', raise: '레이즈', allin: '올인' });
});
