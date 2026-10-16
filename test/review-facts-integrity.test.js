import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, legalFor } from '../engine/hand.js';
import { processDetectors } from '../tools/review-facts.js';
import { setup3 } from './helpers/fixtures.js';

test('machine detectors use valid prospective evidence and survive malformed neighbors', () => {
  let state = setup3(5000, 5000, 5000);
  while (!legalFor(state).handOver) {
    const legal = legalFor(state);
    state = applyAction(state, legal.toAct, legal.canCheck ? 'check' : 'call').state;
  }
  const good = structuredClone(state.lastHand.decisions.find((decision) => decision.street === 'flop'));
  assert.ok(good?.legal.canCheck);
  good.chosenAction = { action: 'fold', amount: 0 };
  const bad = { ...structuredClone(good), decisionId: 'd-1-flop-999', publicSeats: {}, toCall: 100,
    chosenAction: { action: 'call', amount: 100 } };
  const record = { ...state.lastHand, decisions: [bad, good], startStacks: { user: 5000 }, endStacks: { user: 4500 } };
  const found = processDetectors([record]);
  assert.equal(found.decisions, 1);
  assert.deepEqual(found.foldWhenCheck, [1]);
  assert.ok(found.biggestLosses[0].line.startsWith(`${good.decisionId}:`));
  record.decisions = [good, bad];
  assert.equal(processDetectors([record]).biggestLosses[0].line, null,
    'an earlier valid decision must not label the loss when the last decision is invalid');
  delete good.legal;
  const unavailable = processDetectors([record]);
  assert.equal(unavailable.decisions, 0);
  assert.deepEqual(unavailable.foldWhenCheck, []);
  assert.equal(unavailable.biggestLosses[0].line, null);
});
