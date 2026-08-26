import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPots, awardPots } from '../engine/sidepots.js';

test('3-way 올인 사이드팟', () => {
  // A 100 올인, B 300 올인, C 300 콜
  const pots = buildPots(new Map([['A',100],['B',300],['C',300]]), new Set());
  assert.deepEqual(pots, [
    { amount: 300, eligible: ['A','B','C'] },
    { amount: 400, eligible: ['B','C'] },
  ]);
});
test('폴드 기여는 팟에 남고 자격은 없다', () => {
  const pots = buildPots(new Map([['A',50],['B',200],['C',200]]), new Set(['A']));
  assert.deepEqual(pots, [{ amount: 450, eligible: ['B','C'] }]);
});
test('동점 스플릿 홀수 칩은 순서 앞 좌석부터', () => {
  const out = awardPots([{ amount: 101, eligible: ['A','B'] }],
    new Map([['A',[1,14]],['B',[1,14]]]), ['B','A']);
  assert.equal(out.get('B'), 51); assert.equal(out.get('A'), 50);
});
