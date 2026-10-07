import test from 'node:test';
import assert from 'node:assert/strict';
import { coachingClaimAllowed, referenceClaimAllowed, sanitizeCoachingText } from '../shared/reference.js';

// Sentences in the styles the review/coach models actually produce, plus the
// negation and authority forms the legacy predicate's tests pin.
const CORPUS = [
  'EV 손실이 큽니다. GTO 정답은 아닙니다.', '이 판단은 GTO 정답이 아닙니다.', 'GTO 기반 전략은 검증되지 않았습니다.',
  '최적성이나 확정적 누수는 판단할 수 없다.', '수치 평가(EV, 최적 여부 판정)는 하지 않습니다.', '최적의 사이즈는 아니지만 무난합니다.',
  '이것은 포커 실수입니다.', 'EV를 생각하면 폴드가 낫습니다.', '기대값 측면에서 콜이 손해입니다.', '기대 수익이 낮은 콜이었습니다.',
  'EV는 +0.5bb입니다.', '이 콜의 EV는 약 2bb 손해입니다.', 'GTO 솔버라면 레이즈합니다.', 'solver verified line', 'optimal play here',
  'not an optimal play', '필요 승률 23%인데 에퀴티 17%라 콜은 가격이 맞지 않습니다.', '정답은 폴드입니다.', '정답 여부보다 계획을 점검합니다.',
  '판정이 아니라 공개 정보에 근거한 정성적 과정 평가입니다', '솔버가 검증한 전략입니다.', '확정 누수입니다.', '확정 누수로 볼 수 없습니다.',
  'expected value was negative', 'The EV of this call is low.', '핸드 43: 22로 민레이즈했습니다.', '',
];

test('the coaching predicate accepts everything the legacy predicate accepts', () => {
  const sentences = CORPUS.filter(Boolean);
  const texts = [...sentences];
  for (const a of sentences) for (const b of sentences) texts.push(`${a} ${b}`, `${a}\n${b}`);
  for (const text of texts) {
    if (referenceClaimAllowed(text)) assert.equal(coachingClaimAllowed(text), true, text);
  }
});

test('qualitative EV language is allowed; numbers and authority stay out', () => {
  for (const ok of ['이것은 포커 실수입니다.', 'EV를 생각하면 폴드가 낫습니다.', '기대값 측면에서 콜이 손해입니다.', 'The EV of this call is low.']) {
    assert.equal(coachingClaimAllowed(ok), true, ok);
  }
  for (const bad of ['EV는 +0.5bb입니다.', '이 콜의 EV는 약 2bb 손해입니다.', '정답은 폴드입니다.', 'GTO 솔버라면 레이즈합니다.', '최적의 사이즈는 아니지만 무난합니다.']) {
    assert.equal(coachingClaimAllowed(bad), false, bad);
  }
});

test('sanitizing removes only the offending sentences and keeps structure', () => {
  const doc = [
    '## 결정적 핸드 2~3개 리플레이', '',
    '1. 43번: 22로 민레이즈했습니다. EV는 +0.5bb입니다. 이후 콜은 가격 때문입니다.',
    '- GTO 정답은 폴드입니다.',
    '- 1.5bb 오픈은 작았습니다. 기대값이 낮은 콜이었습니다.',
    '솔버가 검증한 라인입니다.',
    '## EV',
    '+2.5bb',
  ].join('\n');
  const { text, removed, total } = sanitizeCoachingText(doc);
  assert.equal(text, [
    '## 결정적 핸드 2~3개 리플레이', '',
    '1. 43번: 22로 민레이즈했습니다. 이후 콜은 가격 때문입니다.',
    '- 1.5bb 오픈은 작았습니다. 기대값이 낮은 콜이었습니다.',
    '+2.5bb',
  ].join('\n'));
  assert.equal(removed, 4);
  assert.equal(total, 10);
  assert.equal(coachingClaimAllowed(text), true);
  assert.deepEqual(sanitizeCoachingText(text), { text, removed: 0, total: 6 });
});
