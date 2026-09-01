import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveUnit, sampleWeighted } from '../training/policies/rng.js';

const SEED = 'aa'.repeat(16);
const EPOCH = 'bb'.repeat(32);

test('same seed/epoch/decision/policy yields the same unit; order does not matter', () => {
  const a = deriveUnit(SEED, EPOCH, 'd-1-preflop-0', 'tag-v1');
  const b = deriveUnit(SEED, EPOCH, 'd-1-preflop-0', 'tag-v1');
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1);
  const c = deriveUnit(SEED, EPOCH, 'd-1-preflop-1', 'tag-v1');
  assert.notEqual(a, c);
});

test('sampleWeighted is deterministic for a unit and always picks a mass-1 action', () => {
  const items = [{ action: 'fold', frequency: 1 }];
  assert.equal(sampleWeighted(items, 0).action, 'fold');
  assert.equal(sampleWeighted(items, 0.999).action, 'fold');
});
