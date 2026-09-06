import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQueue as buildQueue } from '../training/drill-generator.js';

// 데이터셋 provider는 인자다(P2-2 항목 9) — 상수를 두면 데이터셋을 갈아도 질문이
// 옛 버전을 주장한다. 테스트는 고정 source로 감싸 호출한다.
const SOURCE = {
  id: 'local-preflop-baseline',
  version: '1.0.0',
  contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
};
const generateQueue = (opts = {}) => buildQueue({ source: SOURCE, ...opts });

test('same seed and snapshot reproduce the same queue; four modes exist', () => {
  const mistakes = [{
    mistakeId: 'm1',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    spotSignature: '6max-100bb-btn-rfi-unopened:AJo',
    sourceIdentity: SOURCE,
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

test('legacy mistake rows without exact source identity remain unavailable', () => {
  const legacy = {
    mistakeId: 'legacy',
    spotSignature: '6max-100bb-btn-rfi-unopened:AJo',
    skillKey: 'preflop.rfi.BTN',
    nextReviewAt: '2026-08-01T00:00:00.000Z',
  };
  assert.deepEqual(generateQueue({ mode: 'mistake-review', mistakes: [legacy] }), []);
  assert.deepEqual(generateQueue({
    mode: 'daily', mistakes: [legacy], now: '2026-09-01T00:00:00.000Z',
  }), []);
});

test('schema1 candidates use only explicit matching nested source evidence', () => {
  const id = `${'ab'.repeat(32)}:d-1-preflop-0:local-preflop-baseline@1.0.0`;
  const row = {
    schemaVersion: 1, mistakeId: id,
    spotSignature: '6max-100bb-btn-rfi-unopened:AJo', skillKey: 'preflop.rfi.BTN',
    evaluation: { evaluationId: id, payloadSha256: 'cd'.repeat(32), source: SOURCE,
      spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo', status: 'supported', forced: false, grade: 'off-policy' },
  };
  assert.equal(generateQueue({ mode: 'mistake-review', mistakes: [row] }).length, 1);
  for (const mutate of [
    (r) => { delete r.evaluation.source.contentSha256; },
    (r) => { r.evaluation.handClass = 'AA'; },
    (r) => { r.mistakeId = `${'cd'.repeat(32)}:d-2-preflop-0:local-preflop-baseline@1.0.0`; },
    (r) => { r.evaluation.grade = 'preferred'; },
  ]) {
    const bad = structuredClone(row); mutate(bad);
    assert.deepEqual(generateQueue({ mode: 'mistake-review', mistakes: [bad] }), []);
  }
});
