import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { snapshotDecision } from '../engine/decision.js';
import { clampRaiseTo, legalizeOne } from '../training/policies/contracts.js';
import { raiseToFor, roundToUnit } from '../training/policies/sizing.js';
import { mulberry32 } from './helpers/fixtures.js';
import { sizingFixture } from './helpers/sizing-fixture.js';

const TABLE = [
  { name: 'P1 unopened', actions: [], actor: 'p3', rule: 'open-2.5bb', raiseTo: 125 },
  { name: 'P2 iso vs limp', actions: ['call'], actor: 'p4', rule: 'iso', raiseTo: 175 },
  {
    name: 'P2 BB canCheck iso',
    actions: ['call', 'fold', 'fold', 'fold', 'fold'],
    actor: 'p2',
    rule: 'iso',
    raiseTo: 175,
    canCheck: true,
    potBefore: 125,
  },
  { name: 'P3 vs 2.5bb open', actions: [['raise', 125]], actor: 'p4', rule: '3bet-3.4x', raiseTo: 425 },
  { name: 'P3 vs iso 175', actions: ['call', ['raise', 175]], actor: 'p5', rule: '3bet-3.4x', raiseTo: 600 },
  { name: 'P4 squeeze', actions: [['raise', 125], 'call'], actor: 'p5', rule: 'squeeze', raiseTo: 550 },
  { name: 'P5 4bet', actions: [['raise', 125], ['raise', 425]], actor: 'p5', rule: '4bet-2.3x', raiseTo: 975 },
  {
    name: 'P6 5bet all-in',
    actions: [['raise', 125], ['raise', 425], ['raise', 975]],
    actor: 'user',
    rule: '5bet-allin',
    raiseTo: 5000,
  },
  {
    name: 'F1 flop 2/3 pot',
    actions: [['raise', 125], 'fold', 'fold', 'fold', 'fold', 'call'],
    actor: 'p2',
    rule: 'bet-2/3-pot',
    raiseTo: 175,
    potBefore: 275,
    canCheck: true,
  },
  {
    name: 'F2 flop 3/4 pot raise',
    actions: [['raise', 125], 'fold', 'fold', 'fold', 'fold', 'call', ['raise', 175]],
    actor: 'p3',
    rule: 'raise-3/4-pot',
    raiseTo: 650,
  },
  {
    name: 'F2 vs 1bb minbet',
    actions: [['raise', 125], 'fold', 'fold', 'fold', 'fold', 'call', 'check', ['raise', 50]],
    actor: 'p2',
    rule: 'raise-3/4-pot',
    raiseTo: 325,
  },
  {
    name: 'short-stack clamp all-in',
    stack: 300,
    actions: [['raise', 125]],
    actor: 'p4',
    rule: '3bet-3.4x',
    raiseTo: 300,
  },
  {
    name: '15/30 P5 rounds 586.5 to 585',
    blinds: [15, 30],
    stack: 3000,
    actions: [['raise', 75], ['raise', 255]],
    actor: 'p5',
    rule: '4bet-2.3x',
    raiseTo: 585,
  },
  {
    name: 'street filter ignores preflop raises on flop',
    actions: [['raise', 125], ['raise', 425], 'call', 'fold', 'fold', 'fold', 'call'],
    actor: 'p3',
    rule: 'bet-2/3-pot',
    raiseTo: 900,
    potBefore: 1350,
    canCheck: true,
  },
];

for (const row of TABLE) {
  test(`engine fixture ${row.name} sizes to ${row.raiseTo}`, () => {
    const { legal, snapshot } = sizingFixture({
      blinds: row.blinds,
      stack: row.stack,
      actions: row.actions,
    });
    assert.equal(legal.toAct, row.actor);
    if (row.canCheck != null) assert.equal(legal.canCheck, row.canCheck);
    if (row.potBefore != null) assert.equal(snapshot.potBefore, row.potBefore);
    const sized = raiseToFor(snapshot, legal);
    assert.equal(sized.rule, row.rule);
    assert.equal(sized.raiseTo, row.raiseTo);
    assert.ok(sized.raiseTo >= legal.minRaiseTo || legal.minRaiseTo > legal.maxRaiseTo);
    assert.ok(sized.raiseTo <= legal.maxRaiseTo);
  });
}

test('roundToUnit uses SB, 25/50 P5 977.5→975, 15/30 586.5→585, and 1/2 integers', () => {
  assert.equal(roundToUnit(977.5, 25), 975);
  assert.equal(roundToUnit(586.5, 15), 585);
  assert.equal(roundToUnit(5, 1), 5);
  assert.equal(roundToUnit(5.4, 1), 5);
  assert.equal(roundToUnit(5.5, 1), 6);
  assert.equal(roundToUnit(183.333, 25), 175);
  const halfPot = raiseToFor({
    street: 'preflop',
    blinds: [1, 2],
    priorActions: [],
  }, { canRaise: true, minRaiseTo: 4, maxRaiseTo: 200 });
  assert.equal(halfPot.rule, 'open-2.5bb');
  assert.equal(halfPot.raiseTo, 5);
});

test('rounding happens before clamp when the rounded target falls below minRaiseTo', () => {
  const snapshot = {
    street: 'flop',
    blinds: [25, 50],
    currentBet: 0,
    potBefore: 275,
    priorActions: [],
  };
  const legal = { canRaise: true, minRaiseTo: 200, maxRaiseTo: 5000 };
  const sized = raiseToFor(snapshot, legal);
  assert.equal(sized.rule, 'bet-2/3-pot');
  assert.equal(roundToUnit(sized.target, 25), 175);
  assert.ok(175 < legal.minRaiseTo);
  assert.equal(sized.raiseTo, 200);
});

test('clampRaiseTo all-in, min>max, and canRaise false', () => {
  assert.equal(clampRaiseTo(425, { canRaise: true, minRaiseTo: 200, maxRaiseTo: 300 }), 300);
  assert.equal(clampRaiseTo(400, { canRaise: true, minRaiseTo: 800, maxRaiseTo: 300 }), 300);
  assert.equal(clampRaiseTo(400, { canRaise: false, minRaiseTo: 200, maxRaiseTo: 5000 }), null);
  const noRaise = raiseToFor({
    street: 'preflop',
    blinds: [25, 50],
    priorActions: [],
  }, { canRaise: false, minRaiseTo: 100, maxRaiseTo: 5000 });
  assert.equal(noRaise.rule, 'open-2.5bb');
  assert.equal(noRaise.target, 125);
  assert.equal(noRaise.raiseTo, null);
});

const facing = {
  canCheck: false,
  canRaise: true,
  callAmount: 50,
  minRaiseTo: 100,
  maxRaiseTo: 5000,
};

test('legalizeOne uses integer raiseTo and clamps it', () => {
  assert.equal(legalizeOne({ action: 'raise', raiseTo: 400 }, facing).amount, 400);
  assert.equal(legalizeOne({ action: 'raise', raiseTo: 99999 }, facing).amount, 5000);
  assert.equal(legalizeOne({ action: 'raise', raiseTo: 50 }, facing).amount, 100);
  assert.equal(legalizeOne({
    action: 'raise',
    raiseTo: 400,
  }, { ...facing, minRaiseTo: 800, maxRaiseTo: 300 }).amount, 300);
});

test('legalizeOne falls back to sizeBb when raiseTo is not a safe integer', () => {
  const opts = { bb: 50 };
  assert.equal(legalizeOne({ action: 'raise', raiseTo: 1.5, sizeBb: 2.5 }, facing, opts).amount, 125);
  assert.equal(legalizeOne({ action: 'raise', raiseTo: Number.NaN, sizeBb: 2.5 }, facing, opts).amount, 125);
  assert.equal(legalizeOne({ action: 'raise', raiseTo: '400', sizeBb: 2.5 }, facing, opts).amount, 125);
});

test('legalizeOne keeps the v1 sizeBb out-of-range fallback to minRaiseTo', () => {
  assert.equal(legalizeOne({ action: 'raise', sizeBb: 999 }, facing, { bb: 50 }).amount, 100);
  assert.equal(legalizeOne({ action: 'raise' }, facing, { bb: 50 }).amount, 100);
});

test('F1 handmade snapshot without priorActions does not throw', () => {
  const sized = raiseToFor({
    street: 'flop',
    blinds: [25, 50],
    currentBet: 0,
    potBefore: 275,
  }, { canRaise: true, minRaiseTo: 50, maxRaiseTo: 5000 });
  assert.equal(sized.rule, 'bet-2/3-pot');
  assert.equal(sized.raiseTo, 175);
});

test('P1 handmade snapshot without potBefore does not throw and opens 2.5bb', () => {
  const sized = raiseToFor({
    street: 'preflop',
    blinds: [50, 100],
    priorActions: [],
  }, { canRaise: true, minRaiseTo: 200, maxRaiseTo: 10000 });
  assert.equal(sized.rule, 'open-2.5bb');
  assert.equal(sized.raiseTo, 250);
});

test('F2 missing actorBet throws POLICY_SNAPSHOT_INVALID', () => {
  assert.throws(() => raiseToFor({
    street: 'flop',
    blinds: [25, 50],
    currentBet: 175,
    toCall: 175,
    potBefore: 450,
    priorActions: [],
  }, { canRaise: true, minRaiseTo: 350, maxRaiseTo: 5000 }), { code: 'POLICY_SNAPSHOT_INVALID' });
});

test('handmade preflop raise without street still counts as a 3bet spot', () => {
  const sized = raiseToFor({
    street: 'preflop',
    blinds: [50, 100],
    priorActions: [
      { playerId: 'user', action: 'raise', amount: 250 },
    ],
  }, { canRaise: true, minRaiseTo: 400, maxRaiseTo: 10000 });
  assert.equal(sized.rule, '3bet-3.4x');
  assert.equal(sized.raiseTo, 850);
});

function randomLegal(legal, rng) {
  const options = [
    { weight: 0.2, pick: () => ['fold'] },
    { weight: 0.5, pick: () => [legal.canCheck ? 'check' : 'call'] },
  ];
  if (legal.canRaise) {
    options.push({
      weight: 0.3,
      pick: () => {
        const amount = legal.minRaiseTo > legal.maxRaiseTo
          ? legal.maxRaiseTo
          : legal.minRaiseTo + Math.floor(rng() * (legal.maxRaiseTo - legal.minRaiseTo + 1));
        return ['raise', amount];
      },
    });
  }
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = rng() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return option.pick();
  }
  return options.at(-1).pick();
}

test('raiseToFor stays legal on 300 seeded engine snapshots and min-raises only after rounding down', () => {
  const started = Date.now();
  const rng = mulberry32(143);
  const samples = [];
  let games = 0;
  while (samples.length < 300) {
    games += 1;
    let state = createGame({
      aiCount: 5,
      startStack: 5000,
      blinds0: [25, 50],
      mode: 'cash-training',
      levelEvery: null,
      startStackBb: 100,
      handLimit: 40,
    });
    state.button = 5;
    let hands = 0;
    while (samples.length < 300 && hands < 40 && !state.gameOver) {
      state = startHand(state, { rng }).state;
      hands += 1;
      let acts = 0;
      while (!legalFor(state).handOver) {
        acts += 1;
        assert.ok(acts <= 10_000, 'hand did not close');
        const legal = legalFor(state);
        if (rng() < 0.35 || !legal.canRaise) {
          const snapshot = snapshotDecision(state, legal.toAct, null, {
            blinds: state.config.blinds0,
            legal,
          });
          samples.push({ snapshot, legal });
          if (samples.length >= 300) break;
        }
        state = applyAction(state, legal.toAct, ...randomLegal(legal, rng)).state;
      }
    }
    assert.ok(games < 80, 'could not collect 300 snapshots');
  }

  for (const { snapshot, legal } of samples) {
    const sized = raiseToFor(snapshot, legal);
    if (!legal.canRaise) {
      assert.equal(sized.raiseTo, null);
      continue;
    }
    assert.equal(typeof sized.rule, 'string');
    assert.equal(Number.isInteger(sized.raiseTo), true);
    if (legal.minRaiseTo > legal.maxRaiseTo) {
      assert.equal(sized.raiseTo, legal.maxRaiseTo);
    } else {
      assert.ok(sized.raiseTo >= legal.minRaiseTo, `${sized.rule} ${sized.raiseTo} < ${legal.minRaiseTo}`);
      assert.ok(sized.raiseTo <= legal.maxRaiseTo, `${sized.rule} ${sized.raiseTo} > ${legal.maxRaiseTo}`);
    }
    if (sized.raiseTo === legal.minRaiseTo) {
      const unit = Number.isInteger(snapshot.blinds[0]) && snapshot.blinds[0] > 0 ? snapshot.blinds[0] : 1;
      assert.ok(
        roundToUnit(sized.target, unit) <= legal.minRaiseTo,
        `${sized.rule} target ${sized.target} rounded above min ${legal.minRaiseTo}`,
      );
    }
  }
  assert.equal(samples.length, 300);
  assert.ok(Date.now() - started < 3000, `property test took ${Date.now() - started}ms`);
});
