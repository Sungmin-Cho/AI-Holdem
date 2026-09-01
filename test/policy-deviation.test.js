import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeviations } from '../training/policies/deviation.js';
import { deriveUnit, sampleWeighted } from '../training/policies/rng.js';

const legal = {
  canCheck: false,
  canRaise: false,
  callAmount: 100,
  minRaiseTo: 0,
  maxRaiseTo: 0,
};

const riverBet = { street: 'river', toCall: 100 };
const deviation = {
  selector: { street: 'river', facingBet: true },
  operation: 'shift',
  from: 'fold',
  to: 'call',
  probability: 0.20,
};

test('river facing-bet shift moves 0.20 from fold to call', () => {
  const next = applyDeviations([
    { action: 'fold', amount: 0, frequency: 0.50 },
    { action: 'call', amount: 100, frequency: 0.50 },
  ], [deviation], riverBet, legal);
  const fold = next.find((row) => row.action === 'fold').frequency;
  const call = next.find((row) => row.action === 'call').frequency;
  assert.ok(Math.abs(fold - 0.30) < 1e-9);
  assert.ok(Math.abs(call - 0.70) < 1e-9);
});

test('selector miss leaves the distribution unchanged', () => {
  const next = applyDeviations([
    { action: 'fold', amount: 0, frequency: 1 },
  ], [deviation], { street: 'flop', toCall: 100 }, legal);
  assert.equal(next[0].action, 'fold');
  assert.equal(next[0].frequency, 1);
});

test('target deviation is observed within tolerance over a fixed seed set', () => {
  const items = applyDeviations([
    { action: 'fold', amount: 0, frequency: 0.50 },
    { action: 'call', amount: 100, frequency: 0.50 },
  ], [deviation], riverBet, legal);
  let calls = 0;
  const n = 4000;
  for (let i = 0; i < n; i += 1) {
    const unit = deriveUnit('seed', 'epoch', `d-${i}`, 'calling-station-v1');
    if (sampleWeighted(items, unit).action === 'call') calls += 1;
  }
  const freq = calls / n;
  assert.ok(Math.abs(freq - 0.70) < 0.03, `observed ${freq}`);
});
