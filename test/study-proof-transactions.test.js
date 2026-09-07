import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownedIdentityStatus } from '../engine/state.js';
import {
  aclTransaction, nextCheckpointDelay, memoizedStartTimeOf,
  isStudyTransportFailure, shouldRetryLiveWait,
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

test('live wait retries transport resets while the same owner is alive', () => {
  const owner = { status: 'alive', pid: 1, startTime: 't' };
  const transport = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const wrapped = Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT health transport TypeError fetch failed cause=ECONNRESET'), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  const answer = Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT health answer denied=401'), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  assert.equal(isStudyTransportFailure(transport), true);
  assert.equal(isStudyTransportFailure(wrapped), true);
  assert.equal(isStudyTransportFailure(answer), false);
  const alive = { afterOwner: owner, owner, sameOwner: true, descriptorState: 'valid' };
  assert.equal(shouldRetryLiveWait(wrapped, alive), true);
  assert.equal(shouldRetryLiveWait(transport, alive), true);
  assert.equal(shouldRetryLiveWait(answer, alive), false);
  assert.equal(shouldRetryLiveWait(wrapped, { ...alive, descriptorState: 'missing' }), true);
  assert.equal(shouldRetryLiveWait(wrapped, { ...alive, sameOwner: false }), false);
});
