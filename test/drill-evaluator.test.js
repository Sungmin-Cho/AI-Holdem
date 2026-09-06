import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';

const CONTENT_SHA256 = '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf';

test('mixed strategy is graded by frequency, not binary; provider version is pinned', () => {
  const question = {
    questionId: 'drill:1.0.0:6max-100bb-btn-rfi-unopened:AJo:1',
    answerPolicy: { providerId: 'local-preflop-baseline', providerVersion: '1.0.0' },
    prompt: { handClass: 'AJo', spotKey: '6max-100bb-btn-rfi-unopened' },
  };
  const strategy = {
    status: 'supported',
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
    actions: [
      { action: 'raise', sizeBb: 2.5, frequency: 0.6 },
      { action: 'fold', frequency: 0.4 },
    ],
  };
  const mixed = evaluateDrillAnswer(question, { action: 'fold' }, strategy);
  assert.equal(mixed.grade, 'mixed');
  assert.equal(mixed.binaryCorrect, undefined);
  assert.equal(mixed.feedback.includes('빈도'), true);
  assert.throws(
    () => evaluateDrillAnswer(question, { action: 'fold' }, {
      ...strategy,
      source: { id: 'local-preflop-baseline', version: '2.0.0' },
    }),
    { code: 'PROVIDER_VERSION_MISMATCH' },
  );
});

test('missing source digest is unverified and cannot produce a grade or recommendation', () => {
  const result = evaluateDrillAnswer({ questionId: 'legacy', answerPolicy: {} }, { action: 'fold' }, {
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
    actions: [{ action: 'fold', frequency: 1 }],
  });
  assert.equal(result.status, 'unverified');
  assert.equal(result.grade, null);
  assert.deepEqual(result.recommended, []);
});
