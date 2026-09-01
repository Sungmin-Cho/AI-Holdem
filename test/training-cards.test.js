import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allHandClasses, handClassOf } from '../training/cards.js';

test('169 hand class, suit/order independent', () => {
  const classes = allHandClasses();
  assert.equal(classes.length, 169);
  assert.equal(new Set(classes).size, 169);
  assert.equal(handClassOf(['Ah', 'Ad']), 'AA');
  assert.equal(handClassOf(['Ah', 'Kd']), 'AKo');
  assert.equal(handClassOf(['Kd', 'Ah']), 'AKo');
  assert.equal(handClassOf(['Ah', 'Kh']), 'AKs');
  assert.equal(handClassOf(['2c', '2s']), '22');
  assert.equal(handClassOf(['Ts', '9s']), 'T9s');
  assert.equal(handClassOf(['9s', 'Ts']), 'T9s');
});
