import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQueue as buildQueue } from '../training/drill-generator.js';

// 데이터셋 provider는 인자다(P2-2 항목 9) — 상수를 두면 데이터셋을 갈아도 질문이
// 옛 버전을 주장한다. 테스트는 고정 source로 감싸 호출한다.
const SOURCE = { id: 'local-preflop-baseline', version: '1.0.0' };
const generateQueue = (opts = {}) => buildQueue({ source: SOURCE, ...opts });

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
