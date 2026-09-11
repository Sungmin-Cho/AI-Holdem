import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownedIdentityStatus } from '../engine/state.js';
import {
  aclTransaction, withClientAclScope, markAclDirty, nextCheckpointDelay, memoizedStartTimeOf,
  isStudyTransportFailure, shouldRetryLiveWait,
} from '../tools/study-service.js';

function countingProve() {
  const calls = [];
  const prove = (entries) => {
    calls.push(entries.map(({ file }) => file));
    return true;
  };
  return { calls, prove };
}

function storeCtx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-scope-'));
  fs.chmodSync(root, 0o700);
  const training = path.join(root, '.training');
  fs.mkdirSync(training, { mode: 0o700 });
  return { root, training };
}

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
  const powershellTimeout = Object.assign(
    new Error('STUDY_DESCRIPTOR_CORRUPT before powershell:status=null error=ETIMEDOUT stderr='),
    { code: 'STUDY_DESCRIPTOR_CORRUPT' },
  );
  assert.equal(isStudyTransportFailure(transport), true);
  assert.equal(isStudyTransportFailure(wrapped), true);
  assert.equal(isStudyTransportFailure(answer), false);
  assert.equal(isStudyTransportFailure(powershellTimeout), true);
  const alive = { afterOwner: owner, owner, sameOwner: true, descriptorState: 'valid' };
  assert.equal(shouldRetryLiveWait(wrapped, alive), true);
  assert.equal(shouldRetryLiveWait(transport, alive), true);
  assert.equal(shouldRetryLiveWait(answer, alive), false);
  assert.equal(shouldRetryLiveWait(wrapped, { ...alive, descriptorState: 'missing' }), true);
  assert.equal(shouldRetryLiveWait(wrapped, { ...alive, sameOwner: false }), false);
});

test('standalone win32 transactions still pay a before/after pair each', () => {
  const ctx = storeCtx();
  const { calls, prove } = countingProve();
  try {
    aclTransaction(ctx, () => 1, { platform: 'win32', prove });
    aclTransaction(ctx, () => 2, { platform: 'win32', prove });
    assert.equal(calls.length, 4);
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('client ACL scope shares one before/after pair across sequential transactions and awaits', async () => {
  const ctx = storeCtx();
  const { calls, prove } = countingProve();
  try {
    await withClientAclScope(async () => {
      aclTransaction(ctx, () => 1, { platform: 'win32', prove });
      await Promise.resolve();
      aclTransaction(ctx, () => 2, { platform: 'win32', prove });
      aclTransaction(ctx, () => {
        aclTransaction(ctx, () => 3, { platform: 'win32', prove });
      }, { platform: 'win32', prove });
    }, { platform: 'win32', prove });
    assert.equal(calls.length, 2, `expected before+after, got ${calls.length}`);
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('client ACL scope still after-proves when the body throws', () => {
  const ctx = storeCtx();
  const { calls, prove } = countingProve();
  try {
    assert.throws(() => withClientAclScope(() => {
      aclTransaction(ctx, () => { throw Object.assign(new Error('boom'), { code: 'X' }); }, { platform: 'win32', prove });
    }, { platform: 'win32', prove }), { code: 'X' });
    assert.equal(calls.length, 2);
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('an unproven path is not private under a client scope', () => {
  const ctx = storeCtx();
  try {
    const prove = () => false;
    assert.throws(
      () => withClientAclScope(() => aclTransaction(ctx, () => {}, { platform: 'win32', prove }), { platform: 'win32', prove }),
      (error) => error.code === 'STUDY_DESCRIPTOR_CORRUPT' && String(error.message).startsWith('STUDY_DESCRIPTOR_CORRUPT before'),
    );
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('writes and listing changes invalidate the client before-proof', () => {
  const ctx = storeCtx();
  const { calls, prove } = countingProve();
  try {
    withClientAclScope(() => {
      aclTransaction(ctx, () => 1, { platform: 'win32', prove });
      markAclDirty();
      aclTransaction(ctx, () => 2, { platform: 'win32', prove });
      fs.writeFileSync(path.join(ctx.training, 'study-service.json'), '{}', { mode: 0o600 });
      aclTransaction(ctx, () => 3, { platform: 'win32', prove });
    }, { platform: 'win32', prove });
    assert.equal(calls.length, 4);
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('concurrent client scopes do not share ACL memos', async () => {
  const left = storeCtx();
  const right = storeCtx();
  const { calls, prove } = countingProve();
  try {
    await Promise.all([
      withClientAclScope(async () => {
        aclTransaction(left, () => 1, { platform: 'win32', prove });
        await Promise.resolve();
        aclTransaction(left, () => 2, { platform: 'win32', prove });
      }, { platform: 'win32', prove }),
      withClientAclScope(async () => {
        aclTransaction(right, () => 1, { platform: 'win32', prove });
        await Promise.resolve();
        aclTransaction(right, () => 2, { platform: 'win32', prove });
      }, { platform: 'win32', prove }),
    ]);
    assert.equal(calls.length, 4);
  } finally {
    fs.rmSync(left.root, { recursive: true, force: true });
    fs.rmSync(right.root, { recursive: true, force: true });
  }
});

test('a client call with no transaction does not prove', () => {
  const { calls, prove } = countingProve();
  assert.equal(withClientAclScope(() => 7, { platform: 'win32', prove }), 7);
  assert.equal(calls.length, 0);
});

test('same-path inode replacement invalidates the client before-proof', () => {
  const ctx = storeCtx();
  const { calls, prove } = countingProve();
  const file = path.join(ctx.training, 'study-service.json');
  try {
    fs.writeFileSync(file, 'a', { mode: 0o600 });
    withClientAclScope(() => {
      aclTransaction(ctx, () => 1, { platform: 'win32', prove });
      fs.unlinkSync(file);
      fs.writeFileSync(file, 'b', { mode: 0o600 });
      aclTransaction(ctx, () => 2, { platform: 'win32', prove });
    }, { platform: 'win32', prove });
    assert.equal(calls.length, 3);
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('after-proof failure on a thrown body keeps the caller error code', () => {
  const ctx = storeCtx();
  let n = 0;
  const prove = () => { n += 1; return n === 1; };
  try {
    assert.throws(
      () => withClientAclScope(() => {
        aclTransaction(ctx, () => { throw Object.assign(new Error('boom'), { code: 'X' }); }, { platform: 'win32', prove });
      }, { platform: 'win32', prove }),
      { code: 'X' },
    );
    assert.equal(n, 2);
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});
