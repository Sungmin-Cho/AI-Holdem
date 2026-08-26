import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDeck, shuffle, rankValue } from '../engine/cards.js';

test('덱은 52장 전부 유일', () => {
  const d = newDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  assert.ok(d.includes('As') && d.includes('2c') && d.includes('Td'));
});
test('셔플은 순열이며 원본을 훼손하지 않는다', () => {
  const d = newDeck(); const before = [...d];
  const s = shuffle(d);
  assert.deepEqual(d, before);
  assert.deepEqual([...s].sort(), [...d].sort());
});
test('셔플은 주입된 rng로 Fisher-Yates 순서를 재현한다', () => {
  const d = ['a', 'b', 'c', 'd', 'e']; const before = [...d];
  const values = [0.5, 0.66, 0.5, 0];
  const s = shuffle(d, () => values.shift());

  assert.deepEqual(s, ['d', 'a', 'b', 'e', 'c']);
  assert.deepEqual(d, before);
});
test('rankValue', () => {
  assert.equal(rankValue('As'), 14);
  assert.equal(rankValue('Td'), 10);
  assert.equal(rankValue('2c'), 2);
});
