import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTrainingCard } from '../server/public/training-format.js';

const CONTENT_SHA256 = '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf';

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
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
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
      opponents: [{
        opponentId: 'villain-1',
        policyId: 'policy-1',
        adjustment: { bluff: 'decrease', thinValue: 'increase', defense: 'hold' },
        comparison: { summaryCode: 'GTO_CLOSE' },
      }],
      primary: 'villain-1',
    },
  });
  assert.match(exploit.exploit, /bluff decrease/);
  assert.match(exploit.exploit, /thin value increase/);
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

test('canonical cards use qualified reference wording without solver authority', () => {
  const card = formatTrainingCard({
    handNo: 17,
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    chosen: { action: 'fold', frequency: 0.2 },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.8 }],
    grade: 'mixed',
    status: 'supported',
    source: {
      id: 'local-preflop-baseline',
      version: '1.0.0',
      contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
    },
  });
  const raw = JSON.stringify(card);
  assert.match(card.recommendation, /기준표|참고/);
  assert.doesNotMatch(raw, /solver.?verified|검증된 GTO|포커 실수|EV 손실/i);
});

test('fake and spoofed sources expose no recommendation or process grade', () => {
  const rows = [
    { id: 'fake-solver', version: '1.0.0', contentSha256: 'aa'.repeat(32) },
    { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: 'ff'.repeat(32) },
  ];
  for (const source of rows) {
    const card = formatTrainingCard({
      handNo: 1,
      status: 'supported',
      grade: 'preferred',
      chosen: { action: 'raise' },
      recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1 }],
      source,
    });
    assert.equal(card.recommendation, '');
    assert.equal(card.grade, null);
    assert.match(card.note, /미검증|테스트|출처/);
  }
});

test('unsupported solver-authority explanations are not displayed as feedback', () => {
  const card = formatTrainingCard({
    handNo: 1,
    status: 'supported',
    grade: 'preferred',
    chosen: { action: 'raise' },
    recommended: [{ action: 'raise', frequency: 1 }],
    explanation: '이 선택은 검증된 GTO 정답이며 1.2bb EV 손실을 막습니다.',
    source: {
      id: 'local-preflop-baseline',
      version: '1.0.0',
      contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
    },
  });
  assert.equal(card.explanation, '');
  assert.match(card.note, /근거|표현|제한/);
});

test('missing source digest and mixed negative-positive claims remain unavailable', () => {
  const legacy = formatTrainingCard({
    status: 'supported', grade: 'preferred', chosen: { action: 'raise' },
    recommended: [{ action: 'raise', frequency: 1 }],
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  });
  assert.equal(legacy.grade, null);
  assert.equal(legacy.recommendation, '');
  const mixed = formatTrainingCard({
    status: 'supported', grade: 'preferred', chosen: { action: 'raise' },
    recommended: [{ action: 'raise', frequency: 1 }],
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
    explanation: '이 기준은 GTO 정답이 아닙니다. 하지만 다음 선택은 검증된 GTO 정답입니다.',
  });
  assert.equal(mixed.explanation, '');
});

test('authority claims require negation bound to the claim itself', async () => {
  const { referenceClaimAllowed } = await import('../shared/reference.js');
  const forbidden = [
    '검증된 GTO 정답이며 실수가 없습니다.',
    '잘못된 선택은 아니며 검증된 GTO 정답입니다.',
    '이것은 참고 기준이며 검증된 GTO 정답입니다.',
  ];
  for (const explanation of forbidden) {
    assert.equal(referenceClaimAllowed(explanation), false);
    const card = formatTrainingCard({
      status: 'supported', grade: 'preferred', chosen: { action: 'raise' },
      recommended: [{ action: 'raise', frequency: 1 }],
      source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
      explanation,
    });
    assert.equal(card.explanation, '');
  }
  for (const caveat of [
    '이 참고 기준은 검증된 GTO 정답이 아닙니다.',
    'EV 손실을 검증한 것이 아닙니다.',
    'solver-verified 결과가 아닙니다.',
  ]) assert.equal(referenceClaimAllowed(caveat), true);
});
