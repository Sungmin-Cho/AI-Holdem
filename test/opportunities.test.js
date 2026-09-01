import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOpportunity, skillKeyOf } from '../training/opportunities.js';

test('spotKey maps to documented preflop skill keys', () => {
  assert.equal(skillKeyOf({ spotKey: '6max-100bb-btn-rfi-unopened' }), 'preflop.rfi.BTN');
  assert.equal(skillKeyOf({ spotKey: '6max-100bb-bb-vs-single-raise' }), 'preflop.bbDefense.vsRaise');
  assert.equal(skillKeyOf({ spotKey: '6max-100bb-co-vs-single-raise' }), 'preflop.vsRaise.CO');
  const opp = classifyOpportunity({
    status: 'supported',
    spotKey: '6max-100bb-btn-rfi-unopened',
    grade: 'preferred',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  });
  assert.equal(opp.skillKey, 'preflop.rfi.BTN');
  assert.equal(opp.supported, true);
});
