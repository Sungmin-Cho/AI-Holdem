import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertEvaluationId, evaluationIdOf } from '../training/contracts.js';
import { toPublicSummary } from '../training/public-view.js';
import {
  canonicalTrainingJson,
  detailRefOf,
  trainingPayloadSha256,
} from '../publish-contract.js';

test('evaluationId grammar fail-closed; detailRef is sha256 of the id', () => {
  const id = evaluationIdOf({
    gameEpoch: 'ab'.repeat(32),
    decisionId: 'd-1-preflop-0',
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
  });
  assert.equal(assertEvaluationId(id), id);
  assert.equal(detailRefOf(id), createHash('sha256').update(id).digest('hex'));
  assert.throws(() => assertEvaluationId('bad'), { code: 'EVALUATION_ID_INVALID' });
  assert.throws(
    () => assertEvaluationId(`x:${'d-1-preflop-0'}:id@1.0.0`),
    { code: 'EVALUATION_ID_INVALID' },
  );
});

test('public summary strips paths, hole cards, license; keeps forced and compact actions', () => {
  const evaluation = {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: 'aa'.repeat(32),
      decisionId: 'd-17-preflop-3',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId: 'd-17-preflop-3',
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    recommended: [
      { action: 'raise', sizeBb: 2.5, frequency: 0.96, evBb: null },
      { action: 'fold', frequency: 0.04, evBb: null },
    ],
    chosen: { action: 'fold', frequency: 0.04, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'mixed',
    forced: true,
    source: {
      id: 'local-preflop-baseline',
      version: '1.0.0',
      license: 'Apache-2.0',
      contentSha256: 'abc',
      path: '/secret/preflop-baseline-v1.json',
    },
    holeCards: ['Ah', 'Jd'],
  };
  const summary = toPublicSummary(evaluation, {
    handNo: 17,
    explanation: 'BTN unopened에서 AJo는 오픈이 주력이다.',
    detailSha256: 'dd'.repeat(32),
  });
  const raw = JSON.stringify(summary);
  assert.equal(summary.forced, true);
  assert.equal(summary.handNo, 17);
  assert.equal(summary.explanation, undefined);
  assert.equal(summary.source.id, 'local-preflop-baseline');
  assert.equal(summary.source.version, '1.0.0');
  assert.equal(summary.source.license, undefined);
  assert.equal(summary.source.path, undefined);
  assert.equal(summary.holeCards, undefined);
  assert.equal(raw.includes('/secret/'), false);
  assert.equal(raw.includes('Ah'), false);
  assert.equal(raw.includes('오픈이 주력'), false);
  assert.equal(summary.detailRef, detailRefOf(evaluation.evaluationId));
  assert.equal(summary.payloadSha256, trainingPayloadSha256(summary));
  const again = toPublicSummary(evaluation, {
    handNo: 17,
    explanation: 'BTN unopened에서 AJo는 오픈이 주력이다.',
    detailSha256: 'dd'.repeat(32),
  });
  assert.equal(canonicalTrainingJson(summary), canonicalTrainingJson(again));
});

test('compact historical summary bytes and digest do not depend on private source content identity', () => {
  const base = {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: 'aa'.repeat(32),
      decisionId: 'd-18-preflop-3',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId: 'd-18-preflop-3',
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    recommended: [
      { action: 'raise', sizeBb: 2.5, frequency: 0.8, evBb: null },
      { action: 'fold', frequency: 0.2, evBb: null },
    ],
    chosen: { action: 'fold', frequency: 0.2, evBb: null },
    evLossBb: null,
    grade: 'mixed',
    forced: false,
  };
  const canonical = toPublicSummary({
    ...base,
    source: {
      id: 'local-preflop-baseline',
      version: '1.0.0',
      contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
    },
  }, { handNo: 18, detailSha256: 'dd'.repeat(32) });
  const spoofed = toPublicSummary({
    ...base,
    source: {
      id: 'local-preflop-baseline',
      version: '1.0.0',
      contentSha256: 'ff'.repeat(32),
    },
  }, { handNo: 18, detailSha256: 'dd'.repeat(32) });

  assert.equal(canonicalTrainingJson(canonical), canonicalTrainingJson(spoofed));
  assert.equal(canonical.payloadSha256, spoofed.payloadSha256);
  assert.equal(canonical.source.contentSha256, undefined);
});
