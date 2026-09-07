import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownedIdentityStatus } from '../engine/state.js';
import {
  aclTransaction, nextCheckpointDelay, memoizedStartTimeOf,
} from '../tools/study-service.js';

test('aclTransaction refuses a thenable transaction body', () => {
  assert.throws(
    () => aclTransaction({}, async () => {}, { platform: 'linux' }),
    (error) => error.code === 'STUDY_DESCRIPTOR_CORRUPT' && String(error.message).includes('async transaction'),
  );
  assert.equal(aclTransaction({}, () => 7, { platform: 'linux' }), 7);
});

test('identity memo reuses startTimeOf only inside one transaction', () => {
  const memo = new Map();
  let n = 0;
  const stamp = 'utc-v1:Mon Sep  7 00:00:00 2026';
  const startTimeOf = () => { n += 1; return stamp; };
  const lookup = memoizedStartTimeOf(memo, startTimeOf);
  ownedIdentityStatus(process.pid, stamp, lookup);
  ownedIdentityStatus(process.pid, stamp, lookup);
  assert.equal(n, 1);
  memo.clear();
  ownedIdentityStatus(process.pid, stamp, lookup);
  assert.equal(n, 2);
});

test('nextCheckpointDelay stretches only on win32 after a slow checkpoint', () => {
  assert.equal(nextCheckpointDelay(1000, 6000, 'win32'), 12000);
  assert.equal(nextCheckpointDelay(1000, 100, 'win32'), 1000);
  assert.equal(nextCheckpointDelay(1000, 6000, 'linux'), 1000);
});
