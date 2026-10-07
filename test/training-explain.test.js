import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExplanation } from '../training/explain.js';
import * as pipeline from '../tools/training-pipeline.js';
import { LEGACY_REFERENCE_SOURCE as CANONICAL_REFERENCE_SOURCE } from '../shared/reference.js';

const supported = {
  source: CANONICAL_REFERENCE_SOURCE,
  status: 'supported',
  handNo: 17,
  handClass: 'AJo',
  grade: 'mixed',
  chosen: { action: 'fold', frequency: 0.04, evBb: null },
  recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96, evBb: null }],
};

const foldHeavy = {
  ...supported,
  chosen: { action: 'raise', frequency: 0.04, evBb: null },
  recommended: [{ action: 'fold', sizeBb: null, frequency: 0.96, evBb: null }],
};

test('explanation rejects invented numbers and unsupported-as-answer', () => {
  assert.equal(validateExplanation(supported, 'BTN에서 AJo는 0.96 빈도로 2.5bb 오픈이 주력입니다.').ok, true);
  assert.equal(validateExplanation(supported, 'EV loss는 0.28bb입니다.').ok, false);
  assert.equal(
    validateExplanation({ status: 'unsupported', code: 'UNSUPPORTED_SPOT', reason: '4bet' }, 'GTO 정답은 올인입니다.').ok,
    false,
  );
  assert.equal(
    validateExplanation({ status: 'unsupported', code: 'UNSUPPORTED_SPOT', reason: '4bet' }, '이 스팟은 지원되지 않습니다.').ok,
    true,
  );
});

test('R11 binds action aliases to frequency and sizeBb, and rejects EV numbers when evBb is null', () => {
  assert.equal(validateExplanation(supported, 'Raise 96%').ok, true);
  assert.equal(validateExplanation(supported, '레이즈 96%').ok, true);
  assert.equal(validateExplanation(supported, '2.5bb 오픈').ok, true);
  assert.equal(validateExplanation(foldHeavy, 'Raise 96%').ok, false);
  assert.equal(validateExplanation(supported, 'EV loss 0.96BB').ok, false);
  assert.equal(validateExplanation(supported, 'EV 2.5bb').ok, false);
  assert.equal(
    validateExplanation({ status: 'unsupported', handNo: 3, code: 'UNSUPPORTED_SPOT' }, '핸드 3에서 2.5bb 오픈').ok,
    false,
  );
});

test('R11 binds 3-bet/3벳 aliases before leftover numbers and nearest action per frequency', () => {
  assert.equal(validateExplanation(foldHeavy, '3-bet 4%').ok, true);
  assert.equal(validateExplanation(foldHeavy, '3벳 4%').ok, true);
  assert.equal(validateExplanation(supported, '3-bet 4%').ok, false);
  assert.equal(validateExplanation(supported, 'fold 4% raise 96%').ok, true);
  assert.equal(validateExplanation(supported, 'fold 96% raise 4%').ok, false);
  assert.equal(validateExplanation(supported, '레이즈 96% 폴드 4%').ok, true);
});

test('R11 binds frequency to the action alias in the same clause only', () => {
  assert.equal(validateExplanation(supported, 'fold 4%. unrelated 96%. raise').ok, false);
  assert.equal(validateExplanation(supported, 'raise 96%. stack 0.96.').ok, false);
  assert.equal(validateExplanation(supported, 'stack 0.96. raise').ok, false);
  assert.equal(validateExplanation(supported, 'x!! 96% raise').ok, true);
  assert.equal(validateExplanation(supported, 'Raise 96%').ok, true);
  assert.equal(validateExplanation(supported, '레이즈 96%').ok, true);
  assert.equal(validateExplanation(supported, 'BTN에서 AJo는 0.96 빈도로 2.5bb 오픈이 주력입니다.').ok, true);
  assert.equal(validateExplanation(foldHeavy, '3-bet 4%').ok, true);
});

test('buildExplanationPrompt states allowed number forms, aliases, and no new numbers', () => {
  assert.equal(typeof pipeline.buildExplanationPrompt, 'function');
  const prompt = pipeline.buildExplanationPrompt(supported);
  assert.match(prompt, /새 숫자/);
  assert.match(prompt, /레이즈/);
  assert.match(prompt, /0\.nn|n%/);
  assert.match(prompt, /evaluationId/);
  assert.match(prompt, /JSON/);
});

test('S2 supported explanation fails closed when source is absent', () => {
  const { source, ...unverified } = supported;
  assert.equal(validateExplanation(unverified, '레이즈가 주력입니다.').ok, false);
});

test('an explanation may name its own hand class, spot and stack depth; other numbers are still checked', async () => {
  const { validateExplanation } = await import('../training/explain.js');
  const { LEGACY_REFERENCE_SOURCE } = await import('../shared/reference.js');
  const evaluation = { status: 'supported', handNo: 12, handClass: '92s', spotKey: '6max-100bb-btn-rfi-unopened', street: 'preflop',
    source: { ...LEGACY_REFERENCE_SOURCE }, recommended: [{ action: 'fold', frequency: 1, evBb: null }], chosen: { action: 'fold', frequency: 1, evBb: null }, grade: 'preferred' };
  assert.equal(validateExplanation(evaluation, '92s는 이 위치에서 상대의 범위를 고려해야 합니다.').ok, true);
  assert.equal(validateExplanation(evaluation, '6max 100BB에서 92s는 폴드가 주력입니다.').ok, true);
  assert.equal(validateExplanation({ ...evaluation, handClass: '22' }, '22는 작은 페어입니다.').ok, true);
  assert.equal(validateExplanation(evaluation, '92s는 3번 레이즈할 손패가 아닙니다.').code, 'NUMBER_CONTRADICTION');
  assert.equal(validateExplanation(evaluation, '93s는 버리는 손패입니다.').code, 'NUMBER_CONTRADICTION', 'another hand class is not exempt');
  assert.equal(validateExplanation(evaluation, '이 손패는 37% 확률로 이깁니다.').code, 'NUMBER_CONTRADICTION');
});

test('an identifier never excuses a frequency or a size claim', async () => {
  const { validateExplanation } = await import('../training/explain.js');
  const { LEGACY_REFERENCE_SOURCE } = await import('../shared/reference.js');
  // BTN 22: the reference is a 2.5BB raise at 100%.
  const evaluation = { status: 'supported', handNo: 4, handClass: '22', spotKey: '6max-100bb-btn-rfi-unopened', street: 'preflop',
    source: { ...LEGACY_REFERENCE_SOURCE }, recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }, grade: 'preferred' };
  assert.equal(validateExplanation(evaluation, '폴드 22%가 기준 빈도입니다.').code, 'NUMBER_CONTRADICTION');
  assert.equal(validateExplanation(evaluation, '레이즈 100BB가 기준 사이즈입니다.').code, 'NUMBER_CONTRADICTION');
  assert.equal(validateExplanation(evaluation, '100BB로 레이즈하세요.').code, 'NUMBER_CONTRADICTION');
  assert.equal(validateExplanation(evaluation, '22BB 레이즈가 기준입니다.').code, 'NUMBER_CONTRADICTION');
  // The same identifiers used as identifiers stay allowed.
  assert.equal(validateExplanation(evaluation, '100BB 깊이에서 22는 레이즈 2.5BB가 주력입니다.').ok, true);
  assert.equal(validateExplanation(evaluation, '6인 100BB에서 22는 레이즈 100%입니다.').ok, true);
});
