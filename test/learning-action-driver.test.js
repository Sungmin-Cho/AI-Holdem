import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, legalFor } from '../engine/hand.js';
import { setup3 } from './helpers/fixtures.js';
import { submitLearningAction } from './helpers/learning-action-driver.js';

test('learning driver advances a real short-all-in decision instead of submitting an impossible full raise', async () => {
  const state = setup3(80, 5000, 5000);
  const legal = legalFor(state);
  assert(legal.canRaise && legal.minRaiseTo > legal.maxRaiseTo);
  assert.throws(() => applyAction(state, 'user', 'raise', legal.minRaiseTo));
  const sent = new Set();
  await submitLearningAction(legal, sent, async (action) => {
    const next = applyAction(state, 'user', action.action, action.amount).state;
    assert.notEqual(legalFor(next).decisionId, legal.decisionId);
    assert.equal(next.hand.decisions[0].chosenAction.amount, legal.maxRaiseTo);
    return { ok: true };
  });
  assert(sent.has(legal.decisionId));
});

test('learning driver retries after a rejected POST and records only accepted actions', async () => {
  const legal = legalFor(setup3(5000, 5000, 5000));
  const sent = new Set();
  await submitLearningAction(legal, sent, async () => ({ ok: false, code: 'ACTION_RECOVERY_REQUIRED' }));
  assert(!sent.has(legal.decisionId));
  await submitLearningAction(legal, sent, async () => ({ ok: true }));
  assert(sent.has(legal.decisionId));
  await submitLearningAction(legal, sent, async () => assert.fail('accepted decision was sent twice'));
});
