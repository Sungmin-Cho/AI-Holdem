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

test('the default raise is a 2.5bb open, three times a bet faced, or half pot on a fresh street', async () => {
  const { defaultRaiseTo } = await import('../server/public/table-controls.js');
  const seat = (playerId, bet) => ({ playerId, bet });
  const legal = (over = {}) => ({ canRaise: true, minRaiseTo: 100, maxRaiseTo: 10_000, callAmount: 0, potTotal: 150, ...over });
  // Unopened preflop at 50/100: 250, not the 200 minimum.
  const unopened = { street: 'preflop', blinds: [50, 100], viewer: 'user', seats: [seat('user', 0), seat('p1', 50), seat('p2', 100)] };
  assert.equal(defaultRaiseTo(unopened, legal({ callAmount: 100, minRaiseTo: 200 })), 250);
  // An odd big blind rounds to whole chips: 2.5 × 25 = 62.5 → 63.
  const odd = { ...unopened, blinds: [10, 25], seats: [seat('user', 0), seat('p1', 10), seat('p2', 25)] };
  assert.equal(defaultRaiseTo(odd, legal({ callAmount: 25, minRaiseTo: 50 })), 63);
  // Facing a 250 open: three times the bet.
  const facing = { ...unopened, seats: [seat('user', 0), seat('p1', 250), seat('p2', 100)] };
  assert.equal(defaultRaiseTo(facing, legal({ callAmount: 250, minRaiseTo: 400 })), 750);
  // A fresh flop with 600 in the pot: half pot.
  const flop = { street: 'flop', blinds: [50, 100], viewer: 'user', seats: [seat('user', 0), seat('p1', 0)] };
  assert.equal(defaultRaiseTo(flop, legal({ potTotal: 600, minRaiseTo: 100 })), 300);
  // Facing a 200 flop bet: three times it.
  const flopBet = { ...flop, seats: [seat('user', 0), seat('p1', 200)] };
  assert.equal(defaultRaiseTo(flopBet, legal({ potTotal: 800, callAmount: 200, minRaiseTo: 400 })), 600);
  // Clamped into the legal range; no raise means the minimum stays.
  assert.equal(defaultRaiseTo(facing, legal({ callAmount: 250, minRaiseTo: 400, maxRaiseTo: 500 })), 500);
  assert.equal(defaultRaiseTo(unopened, { canRaise: false, minRaiseTo: 0 }), 0);
});
