import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExplanation } from '../training/explain.js';
import * as pipeline from '../tools/training-pipeline.js';

const supported = {
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

test('buildExplanationPrompt states allowed number forms, aliases, and no new numbers', () => {
  assert.equal(typeof pipeline.buildExplanationPrompt, 'function');
  const prompt = pipeline.buildExplanationPrompt(supported);
  assert.match(prompt, /새 숫자/);
  assert.match(prompt, /레이즈/);
  assert.match(prompt, /0\.nn|n%/);
  assert.match(prompt, /evaluationId/);
  assert.match(prompt, /JSON/);
});
