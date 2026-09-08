import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_POSITION_LABELS,
  HAND_CLASSES,
  POSITIONAL_SEATS,
  POSITIONS,
  STREETS,
  TENDENCY_MIN_HANDS,
  TENDENCY_MIN_N,
  TENDENCY_SCHEMA_VERSION,
  assertTendency,
  emptyTendency,
  medianOf,
  mergeTendency,
  normalizePosition,
  rateOf,
} from '../training/tendency/contracts.js';

test('tendency constants and vocabularies', () => {
  assert.equal(TENDENCY_SCHEMA_VERSION, 1);
  assert.equal(TENDENCY_MIN_HANDS, 60);
  assert.equal(TENDENCY_MIN_N, 8);
  assert.deepEqual(POSITIONS, ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
  assert.deepEqual(STREETS, ['flop', 'turn', 'river']);
  assert.deepEqual(POSITIONAL_SEATS, [5, 6, 7]);
  assert.deepEqual(
    [...ENGINE_POSITION_LABELS].sort(),
    ['BB', 'BTN', 'BTN/SB', 'CO', 'SB', 'UTG', 'UTG+1', 'UTG+2', 'UTG+3', 'UTG+4'].sort(),
  );
  assert.equal(ENGINE_POSITION_LABELS.includes('HJ'), false);
  assert.equal(HAND_CLASSES.length, 169);
  assert.equal(new Set(HAND_CLASSES).size, 169);
});

test('normalizePosition folds UTG+k by table size and rejects the rest', () => {
  assert.equal(normalizePosition('BTN/SB', 5), 'BTN');
  assert.equal(normalizePosition('BTN', 6), 'BTN');
  assert.equal(normalizePosition('SB', 6), 'SB');
  assert.equal(normalizePosition('BB', 6), 'BB');
  assert.equal(normalizePosition('CO', 6), 'CO');
  assert.equal(normalizePosition('UTG', 5), 'UTG');
  assert.equal(normalizePosition('UTG', 6), 'UTG');
  assert.equal(normalizePosition('UTG', 7), 'UTG');
  assert.equal(normalizePosition('UTG+1', 6), 'HJ');
  assert.equal(normalizePosition('UTG+1', 7), 'UTG');
  assert.equal(normalizePosition('UTG+2', 7), 'HJ');
  assert.equal(normalizePosition('UTG+1', 5), null);
  assert.equal(normalizePosition('BTN/SB', 2), null);
  assert.equal(normalizePosition('BTN', 8), null);
  assert.equal(normalizePosition('BTN', 4), null);
  assert.equal(normalizePosition('HJ', 6), null);
  assert.equal(normalizePosition('UTG+9', 7), null);
  assert.equal(normalizePosition('xyz', 6), null);
});

test('emptyTendency is a valid zero profile', () => {
  const empty = emptyTendency('user');
  assert.equal(empty.schemaVersion, 1);
  assert.equal(empty.subject, 'user');
  assert.equal(empty.hands, 0);
  assert.equal(empty.decisions, 0);
  assertTendency(empty);
  for (const pos of POSITIONS) {
    assert.equal(Object.keys(empty.preflop.entered[pos]).length, 169);
    for (const handClass of HAND_CLASSES) {
      assert.deepEqual(empty.preflop.entered[pos][handClass], { n: 0, k: 0 });
    }
  }
});

test('mergeTendency is associative and has empty as identity', () => {
  const empty = emptyTendency('user');
  const a = emptyTendency('user');
  a.hands = 2;
  a.decisions = 3;
  a.seatMix[6] = 2;
  a.preflop.vpip = { n: 2, k: 1 };
  a.preflop.openSizeBb.n = 2;
  a.preflop.openSizeBb.buckets['2.5'] = 2;
  a.preflop.entered.BTN.AKs = { n: 1, k: 1 };
  a.sources.push({ gameId: 'a', hands: 2, mode: 'cash-training', opponentRuntime: 'policy', seats: 6 });
  const b = emptyTendency('user');
  b.hands = 1;
  b.seatMix[5] = 1;
  b.preflop.vpip = { n: 1, k: 0 };
  b.preflop.openSizeBb.n = 1;
  b.preflop.openSizeBb.buckets['3.0'] = 1;
  b.preflop.entered.CO['77'] = { n: 1, k: 0 };
  const c = emptyTendency('user');
  c.hands = 4;
  c.preflop.vsRaise = { n: 2, fold: 1, call: 0, raise: 1 };
  c.postflop.af = { bets: 1, raises: 2, calls: 3 };
  assert.deepEqual(mergeTendency(a, empty), a);
  assert.deepEqual(mergeTendency(empty, a), a);
  assert.deepEqual(
    mergeTendency(mergeTendency(a, b), c),
    mergeTendency(a, mergeTendency(b, c)),
  );
});

test('assertTendency rejects k > n, unknown position, and unknown class', () => {
  const tooMany = emptyTendency('user');
  tooMany.preflop.vpip = { n: 2, k: 3 };
  assert.throws(() => assertTendency(tooMany), { code: 'TENDENCY_INVALID' });

  const badPos = emptyTendency('user');
  badPos.preflop.byPosition.UTG2 = {
    dealt: 1, vpip: { n: 1, k: 0 }, rfi: { n: 0, k: 0 }, limp: { n: 0, k: 0 },
    vsRaise: { n: 0, fold: 0, call: 0, raise: 0 },
  };
  assert.throws(() => assertTendency(badPos), { code: 'TENDENCY_INVALID' });

  const badClass = emptyTendency('user');
  badClass.preflop.entered.BTN.ZZ = { n: 1, k: 0 };
  assert.throws(() => assertTendency(badClass), { code: 'TENDENCY_INVALID' });

  const badSum = emptyTendency('user');
  badSum.preflop.vsRaise = { n: 2, fold: 2, call: 1, raise: 0 };
  assert.throws(() => assertTendency(badSum), { code: 'TENDENCY_INVALID' });
});

test('entered keys stay inside 6 positions × 169 classes', () => {
  const t = emptyTendency('p1');
  assertTendency(t);
  assert.deepEqual(Object.keys(t.preflop.entered).sort(), [...POSITIONS].sort());
  for (const pos of POSITIONS) {
    const keys = Object.keys(t.preflop.entered[pos]);
    assert.equal(keys.length, 169);
    for (const key of keys) assert.equal(HAND_CLASSES.includes(key), true);
  }
});

test('rateOf is null at n=0 and medianOf stays within bucket width on 100 samples', () => {
  assert.equal(rateOf({ n: 0, k: 0 }), null);
  assert.equal(rateOf({ n: 4, k: 1 }), 0.25);
  const samples = [];
  let seed = 7;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < 100; i += 1) samples.push(1 + next() * 4);
  const sorted = [...samples].sort((x, y) => x - y);
  const trueMedian = (sorted[49] + sorted[50]) / 2;
  const buckets = {};
  for (const value of samples) {
    const key = (Math.round(value / 0.5) * 0.5).toFixed(1);
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  const approx = medianOf(buckets);
  assert.equal(typeof approx, 'number');
  assert.ok(Math.abs(approx - trueMedian) <= 0.5, `${approx} vs ${trueMedian}`);
});
