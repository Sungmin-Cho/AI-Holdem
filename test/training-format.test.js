import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTrainingCard } from '../server/public/training-format.js';

test('formatter: collapsed card, unsupported reason, forced is not a mistake', () => {
  const supported = formatTrainingCard({
    handNo: 17,
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    chosen: { action: 'fold', frequency: 0.04 },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96 }],
    grade: 'mixed',
    evLossBb: null,
    status: 'supported',
    forced: false,
    explanation: 'BTN에서 AJo는 오픈이 주력입니다.',
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  });
  assert.match(supported.title, /핸드 17/);
  assert.match(supported.title, /AJo/);
  assert.match(supported.choice, /폴드/);
  assert.match(supported.recommendation, /레이즈/);
  assert.equal(supported.grade, 'mixed');
  assert.equal(supported.forced, false);

  const forced = formatTrainingCard({
    handNo: 2,
    handClass: '72o',
    chosen: { action: 'fold' },
    grade: 'off-policy',
    status: 'supported',
    forced: true,
  });
  assert.equal(forced.forced, true);
  assert.match(forced.note, /몰수/);

  const unsupported = formatTrainingCard({
    handNo: 3,
    status: 'unsupported',
    code: 'UNSUPPORTED_SPOT',
    reason: '6-max only',
    chosen: { action: 'raise' },
  });
  assert.equal(unsupported.grade, null);
  assert.match(unsupported.note, /지원되지/);

  const exploit = formatTrainingCard({
    handNo: 44,
    status: 'supported',
    grade: 'preferred',
    chosen: { action: 'raise' },
    exploit: {
      accuracy: 'heuristic',
      adjustment: { bluff: 'decrease', thinValue: 'increase' },
    },
  });
  assert.match(exploit.exploit, /heuristic/);
  assert.equal(exploit.exploit.includes('0.80'), false);
});

test('formatter merge by evaluationId+field displays unavailable and does not use payloadSha256 no-op for annotations', async () => {
  const { applyTrainingAnnotation, formatTrainingCard: format } = await import('../server/public/training-format.js');
  const item = {
    handNo: 17,
    evaluationId: 'eval-merge',
    payloadSha256: 'aa'.repeat(32),
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    chosen: { action: 'fold' },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96 }],
    grade: 'mixed',
    status: 'supported',
  };
  const merged = applyTrainingAnnotation(item, {
    evaluationId: 'eval-merge',
    field: 'explanation',
    status: 'unavailable',
    value: null,
    payloadSha256: 'ff'.repeat(32),
  });
  const card = format(merged);
  assert.match(String(card.explanation), /unavailable/i);
});

test('SSE-style merge keeps the machine card and fills explanation later', async () => {
  const { applyTrainingAnnotation, formatTrainingCard: format } = await import('../server/public/training-format.js');
  const machine = {
    handNo: 17,
    evaluationId: 'eval-sse',
    payloadSha256: 'aa'.repeat(32),
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    chosen: { action: 'fold', frequency: 0.04 },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96 }],
    grade: 'mixed',
    status: 'supported',
  };
  const ui = { training: [machine], trainingAnnotations: [] };
  const firstCard = format(ui.training[0]);
  assert.equal(firstCard.explanation, '');
  const ann = {
    evaluationId: 'eval-sse',
    field: 'explanation',
    status: 'ready',
    value: 'BTN에서 AJo는 0.96 빈도로 2.5bb 오픈이 주력입니다.',
    payloadSha256: 'ff'.repeat(32),
  };
  ui.trainingAnnotations.push(ann);
  ui.training[0] = applyTrainingAnnotation(ui.training[0], ann);
  assert.equal(ui.training[0].payloadSha256, 'aa'.repeat(32));
  assert.equal(ui.training[0].handClass, 'AJo');
  const filled = format(ui.training[0]);
  assert.match(filled.explanation, /0\.96/);
});
