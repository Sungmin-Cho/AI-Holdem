import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { PREFLOP_EQUITY_V1 } from '../training/data/preflop-equity-v1.js';
import { classEquity, equityVsRange, decodeEquityTable } from '../training/ranges/equity-table.js';
import { computePairEquityUnits } from '../training/ranges/equity-build.js';
import { HAND_CLASSES, xorshift32, seedFrom } from '../shared/poker-eval.js';

// Pinned bytes of the generated table; rebuild with `node tools/build-preflop-equity.js`.
const TABLE_SHA256 = fs.readFileSync(new URL('../training/data/preflop-equity-v1.sha256', import.meta.url), 'utf8').trim();

test('the committed equity table is the pinned build', () => {
  const bytes = fs.readFileSync(new URL('../training/data/preflop-equity-v1.js', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), TABLE_SHA256);
  assert.equal(PREFLOP_EQUITY_V1.samplesPerPair, 6000);
  assert.throws(() => decodeEquityTable(PREFLOP_EQUITY_V1.encoded.slice(3)), /wrong size/);
});

test('known preflop matchups fall within Monte Carlo error', () => {
  const near = (value, expected, tolerance = 0.015) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} vs ${expected}`);
  near(classEquity('AA', 'KK'), 0.819);
  near(classEquity('KK', 'AKo'), 0.70, 0.02);
  near(classEquity('AKo', '22'), 0.47, 0.02);
  near(classEquity('72o', 'AA'), 0.124);
  near(classEquity('AKs', 'QQ'), 0.46, 0.02);
  near(classEquity('JTs', '22'), 0.53, 0.025);
  assert.equal(classEquity('QQ', 'QQ'), 0.5);
});

test('the table is antisymmetric', () => {
  for (const a of HAND_CLASSES) for (const b of HAND_CLASSES) {
    assert.ok(Math.abs(classEquity(a, b) + classEquity(b, a) - 1) < 1e-9);
  }
});

test('a sample of entries recomputes exactly from the build procedure', () => {
  const next = xorshift32(seedFrom('equity-spot-check'));
  for (let n = 0; n < 8; n += 1) {
    let i = next() % 169;
    let j = next() % 169;
    if (i === j) continue;
    if (i > j) [i, j] = [j, i];
    const units = Math.round(classEquity(HAND_CLASSES[i], HAND_CLASSES[j]) * 10000);
    assert.equal(computePairEquityUnits(i, j), units, `${HAND_CLASSES[i]} vs ${HAND_CLASSES[j]}`);
  }
});

test('equityVsRange weighs each class by the combos left after card removal', () => {
  // AQs blocks one ace: three AA combos remain against six KK combos.
  const vsPremium = equityVsRange('AQs', { AA: 1, KK: 1 });
  const expected = (3 * classEquity('AQs', 'AA') + 6 * classEquity('AQs', 'KK')) / 9;
  assert.ok(Math.abs(vsPremium - expected) < 1e-12);
  assert.equal(equityVsRange('AKs', {}), 0.5);
});
