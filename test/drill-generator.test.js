import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQueue } from '../training/drill-generator.js';

test('same seed and snapshot reproduce the same queue; four modes exist', () => {
  const mistakes = [{
    mistakeId: 'm1',
    spotSignature: '6max-100bb-btn-rfi-unopened:AJo',
    skillKey: 'preflop.rfi.BTN',
    nextReviewAt: '2026-08-01T00:00:00.000Z',
  }];
  const profile = { leaks: [{ id: 'preflop.rfi.BTN', recommendedDrill: 'preflop.rfi.BTN', severity: 1 }] };
  const a = generateQueue({ mode: 'leak', profile, mistakes, seed: 's1', now: '2026-09-01T00:00:00.000Z' });
  const b = generateQueue({ mode: 'leak', profile, mistakes, seed: 's1', now: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(a, b);
  assert.equal(a[0].mode, 'leak');
  assert.equal(generateQueue({ mode: 'mistake-review', mistakes, seed: 's1' })[0].mode, 'mistake-review');
  assert.equal(generateQueue({ mode: 'daily', mistakes, seed: 's1', now: '2026-09-01T00:00:00.000Z' })[0].mode, 'daily');
  assert.equal(generateQueue({ mode: 'free', seed: 's1', spotKey: '6max-100bb-co-rfi-unopened' })[0].mode, 'free');
});
