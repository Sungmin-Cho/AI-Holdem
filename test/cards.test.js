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
test('rankValue', () => {
  assert.equal(rankValue('As'), 14);
  assert.equal(rankValue('Td'), 10);
  assert.equal(rankValue('2c'), 2);
});
