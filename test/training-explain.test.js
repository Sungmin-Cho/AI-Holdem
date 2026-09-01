import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExplanation } from '../training/explain.js';

const supported = {
  status: 'supported',
  handNo: 17,
  handClass: 'AJo',
  grade: 'mixed',
  chosen: { action: 'fold', frequency: 0.04, evBb: null },
  recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96, evBb: null }],
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
