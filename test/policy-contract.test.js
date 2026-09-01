import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  legalizeEntries, validatePolicyOutput, fallbackLegal, configDigestOf,
} from '../training/policies/contracts.js';

const facingBet = {
  canCheck: false,
  canRaise: true,
  callAmount: 100,
  minRaiseTo: 250,
  maxRaiseTo: 10000,
};

test('fold mass becomes check when check is legal', () => {
  const legal = { canCheck: true, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 };
  const next = legalizeEntries([{ action: 'fold', frequency: 1 }], legal);
  assert.equal(next.length, 1);
  assert.equal(next[0].action, 'check');
});

test('illegal raise is dropped and remaining mass renormalizes', () => {
  const legal = { ...facingBet, canRaise: false };
  const next = legalizeEntries([
    { action: 'fold', frequency: 0.5 },
    { action: 'raise', sizeBb: 2.5, frequency: 0.5 },
  ], legal);
  assert.equal(next.length, 1);
  assert.equal(next[0].action, 'fold');
  assert.equal(next[0].frequency, 1);
});

test('validatePolicyOutput rejects a check when facing a bet', () => {
  assert.throws(() => validatePolicyOutput({ action: 'check' }, facingBet), { code: 'POLICY_ILLEGAL' });
  validatePolicyOutput({ action: 'fold' }, facingBet);
});

test('configDigest is stable and ignores an existing digest field', () => {
  const a = configDigestOf({ policyId: 'tag-v1', x: 1 });
  const b = configDigestOf({ policyId: 'tag-v1', x: 1, configDigest: 'nope' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('fallbackLegal prefers check', () => {
  assert.equal(fallbackLegal({ canCheck: true })[0].action, 'check');
  assert.equal(fallbackLegal({ canCheck: false })[0].action, 'fold');
});
