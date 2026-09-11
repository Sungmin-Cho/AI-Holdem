import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatAmount, formatSignedAmount, readPreference, writePreference} from '../server/public/chip-format.js';

test('BB formatting preserves exact chips and reports precision honestly', () => {
  assert.deepEqual(formatAmount(5000, 50), {primary:'100 BB', secondary:'5,000 칩'});
  assert.equal(formatAmount(125,50).primary,'2.5 BB');
  assert.equal(formatAmount(1,200).primary,'<0.01 BB');
  assert.equal(formatAmount(-1,200).primary,'−<0.01 BB');
  assert.equal(formatAmount(0,50).primary,'0 BB');
  assert.equal(formatAmount(1,3).primary,'≈0.33 BB');
  assert.equal(formatAmount(5000,50,'chips').primary,'5,000 칩');
  assert.equal(formatSignedAmount(100,50).primary,'+2 BB');
});
test('missing amounts and invalid denominators never become zero', () => {
  for(const value of [null,undefined,NaN,Infinity,'100',Number.MAX_SAFE_INTEGER+1]) assert.equal(formatAmount(value,50).primary,'—');
  for(const bb of [0,-1,null,NaN,Infinity,'50',Number.MAX_SAFE_INTEGER+1]) assert.deepEqual(formatAmount(100,bb),{primary:'100 칩',secondary:'BB 기준 없음'});
});
test('display storage is optional and allowlisted', () => {
  const bad={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.equal(readPreference(bad),'bb');assert.equal(writePreference('chips',bad),false);
  assert.equal(readPreference({getItem:()=> 'unknown'}),'bb');
  assert.equal(readPreference({getItem:()=> 'chips'}),'chips');
});
