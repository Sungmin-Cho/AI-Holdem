import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanModule } from './helpers/module-scan.mjs';
import {
  TENDENCY_MIN_N,
  emptyTendency,
} from '../training/tendency/contracts.js';
import { CALIBRATION, traitsFromTendency } from '../training/tendency/traits.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fillVpip(t, n, k) {
  t.hands = n;
  t.preflop.vpip.n = n;
  t.preflop.vpip.k = k;
  t.preflop.pfr.n = n;
  t.preflop.limp.n = n;
}

test('traits.js does not import hand-strength.js', () => {
  const source = fs.readFileSync(path.join(ROOT, 'training/tendency/traits.js'), 'utf8');
  const scan = scanModule(source);
  assert.equal(
    scan.imports.some((entry) => entry.specifier.includes('hand-strength')),
    false,
  );
});

test('CALIBRATION holds the projection constants in one object', () => {
  assert.equal(typeof CALIBRATION, 'object');
  for (const key of ['a0', 'a1', 'b1', 'b2', 'c0', 'c1', 'clampLow', 'clampHigh']) {
    assert.equal(Number.isFinite(CALIBRATION[key]), true, key);
  }
  assert.deepEqual(CALIBRATION.baseline, {
    tightness: 0.52, aggression: 0.52, calling: 0.42, bluff: 0.14,
  });
  assert.equal(CALIBRATION.clampLow, 0.05);
  assert.equal(CALIBRATION.clampHigh, 0.95);
});

test('tightness is clamp(a0 − a1·VPIP) when vpip.n ≥ MIN_N', () => {
  const t = emptyTendency('user');
  fillVpip(t, 80, Math.round(0.12 * 80));
  const traits = traitsFromTendency(t);
  const rate = t.preflop.vpip.k / t.preflop.vpip.n;
  const expected = Math.min(
    CALIBRATION.clampHigh,
    Math.max(CALIBRATION.clampLow, CALIBRATION.a0 - CALIBRATION.a1 * rate),
  );
  assert.ok(Math.abs(traits.tightness - expected) < 1e-12);
});

test('any input n < TENDENCY_MIN_N falls back to baseline-v2 traits', () => {
  const t = emptyTendency('user');
  t.hands = 4;
  t.preflop.vpip.n = 4;
  t.preflop.vpip.k = 2;
  t.preflop.pfr.n = 4;
  t.preflop.pfr.k = 1;
  const traits = traitsFromTendency(t);
  assert.deepEqual(traits, CALIBRATION.baseline);
  assert.ok(TENDENCY_MIN_N > 4);
});

test('aggression uses PFR/VPIP and capped AF, else baseline', () => {
  const t = emptyTendency('user');
  fillVpip(t, 80, 40);
  t.preflop.pfr.k = 20;
  t.postflop.af.bets = 10;
  t.postflop.af.raises = 5;
  t.postflop.af.calls = 5;
  const traits = traitsFromTendency(t);
  const pfrOverVpip = (20 / 80) / (40 / 80);
  const af = (10 + 5) / 5;
  const expected = CALIBRATION.b1 * pfrOverVpip + CALIBRATION.b2 * Math.min(1, af / 3);
  assert.ok(Math.abs(traits.aggression - expected) < 1e-12);

  const shortAf = emptyTendency('user');
  fillVpip(shortAf, 80, 40);
  shortAf.preflop.pfr.k = 20;
  shortAf.postflop.af.bets = 1;
  shortAf.postflop.af.calls = 1;
  assert.equal(traitsFromTendency(shortAf).aggression, CALIBRATION.baseline.aggression);
});

test('calling uses pooled callVsBet and bluff uses observed rate', () => {
  const t = emptyTendency('user');
  fillVpip(t, 80, 40);
  t.preflop.pfr.k = 20;
  t.postflop.af.bets = 8;
  t.postflop.af.calls = 8;
  t.postflop.byStreet.flop.facingBet = { n: 10, fold: 2, call: 7, raise: 1 };
  t.postflop.byStreet.turn.facingBet = { n: 6, fold: 2, call: 4, raise: 0 };
  t.postflop.bluff = { n: 10, k: 3 };
  const traits = traitsFromTendency(t);
  const callVsBet = (7 + 4) / (10 + 6);
  const expectedCalling = CALIBRATION.c0 + CALIBRATION.c1 * callVsBet;
  assert.ok(Math.abs(traits.calling - expectedCalling) < 1e-12);
  assert.equal(traits.bluff, 0.3);

  const shortBluff = emptyTendency('user');
  fillVpip(shortBluff, 80, 40);
  shortBluff.postflop.bluff = { n: 3, k: 3 };
  assert.equal(traitsFromTendency(shortBluff).bluff, CALIBRATION.baseline.bluff);
});

test('traits clamp to [0.05, 0.95]', () => {
  const wide = emptyTendency('user');
  fillVpip(wide, 80, 80);
  wide.preflop.pfr.k = 80;
  wide.postflop.af.bets = 80;
  wide.postflop.af.calls = 1;
  wide.postflop.byStreet.flop.facingBet = { n: 80, fold: 0, call: 80, raise: 0 };
  wide.postflop.bluff = { n: 80, k: 80 };
  const high = traitsFromTendency(wide);
  assert.ok(high.tightness >= CALIBRATION.clampLow && high.tightness <= CALIBRATION.clampHigh);
  assert.ok(high.aggression >= CALIBRATION.clampLow && high.aggression <= CALIBRATION.clampHigh);
  assert.ok(high.calling >= CALIBRATION.clampLow && high.calling <= CALIBRATION.clampHigh);
  assert.ok(high.bluff >= CALIBRATION.clampLow && high.bluff <= CALIBRATION.clampHigh);
  assert.equal(high.calling, CALIBRATION.clampHigh);
  assert.equal(high.bluff, CALIBRATION.clampHigh);
  assert.equal(high.tightness, CALIBRATION.clampLow);
});
