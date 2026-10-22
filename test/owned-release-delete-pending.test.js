// #265 A: an owner's cleanup must finish when another process holds a file it deletes.
// Before libuv 1.49 (Node 20) a Windows unlink is delete-on-close: while any other handle
// is open the name stays, every open or lstat of it answers EPERM, and its directory cannot
// be removed (ENOTEMPTY) until that handle closes. Readers of lock and descriptor files are
// everywhere — clients, PowerShell ACL proof children — so an owner meets this in ordinary
// runs, and a cleanup that takes the transient error as final leaves its lock behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import { studyBudget } from './helpers/platform.js';
import { descriptorPath, lockPath, launch, service, until } from './helpers/study-service-fixtures.mjs';
import { acquireOwnedLock, releaseOwnedLock, readOwnedLock, removeDeletedLockDir, withNamedLock, DELETE_PENDING_WAIT_MS } from '../engine/state.js';
import { platformTimeout, platformNow, withPlatformDeadline } from '../shared/platform-files.js';
import { hasLiveLockHolder, LOCK_NAME } from '../tools/coach-control.js';

const [UV_MAJOR, UV_MINOR] = process.versions.uv.split('.').map(Number);
// libuv 1.49.0 added POSIX delete semantics on Windows (ChangeLog: "win,fs: use posix
// delete semantics, if supported"). Before it, a deleted name outlives other handles. A newer
// libuv falls back to that on a file system without POSIX delete, so only the old one is a
// certainty; tests that need the behaviour also check what the holder actually saw.
const DELETE_PENDING = process.platform === 'win32' && (UV_MAJOR < 1 || (UV_MAJOR === 1 && UV_MINOR < 49));
const WIN32 = process.platform === 'win32';
const STOP_BUDGET = studyBudget({ coldStarts: 1, warmCalls: 3, extraMs: 30_000 });
// How long a holder keeps a file open after it saw the name deleted. The owner's next step
// follows its delete within milliseconds, so this covers it with room; it is also well inside
// the owner's own bounded wait (DELETE_PENDING_WAIT_MS), which a fixed owner must outlast.
const LINGER_MS = 1000;

// A second process that opens `file` (libuv shares delete, like every reader here; a directory
// through opendir) and keeps it open until it sees the name deleted — EPERM while delete-pending,
// ENOENT where the name went at once, or another entry already in its place — and for `lingerMs`
// after that, then closes it.
const HOLDER = `
const fs = require('node:fs');
const file = process.argv[1], lingerMs = Number(process.argv[2]), maxMs = Number(process.argv[3]), kind = process.argv[4];
const pendingLingerMs = Number(process.argv[5]);
const mine = fs.lstatSync(file, { bigint: true });
const handle = kind === 'dir' ? fs.opendirSync(file) : fs.openSync(file, 'r');
const close = () => (kind === 'dir' ? handle.closeSync() : fs.closeSync(handle));
process.stdout.write('held\\n');
const started = Date.now();
const poll = setInterval(() => {
  let seen = null;
  try {
    const now = fs.lstatSync(file, { bigint: true });
    if (now.dev !== mine.dev || now.ino !== mine.ino) seen = 'replaced';
  } catch (error) { seen = error.code; }
  if (seen === null && Date.now() - started < maxMs) return;
  clearInterval(poll);
  process.stdout.write('seen ' + (seen ?? 'present') + '\\n');
  setTimeout(() => { close(); process.stdout.write('closed\\n'); process.exit(0); }, seen === 'EPERM' ? pendingLingerMs : lingerMs);
}, 5);`;

// `pendingLingerMs` replaces `lingerMs` when the holder saw the name stay behind it (EPERM).
function holdOpen(file, { lingerMs = LINGER_MS, maxMs = 120_000, kind = 'file', pendingLingerMs = lingerMs } = {}) {
  const child = registerOwnedProcess(spawn(process.execPath, ['-e', HOLDER, file, String(lingerMs), String(maxMs), kind, String(pendingLingerMs)],
    { stdio: ['ignore', 'pipe', 'pipe'] }), 'delete-pending holder');
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (out.includes('held\n')) resolve(); });
    closed.then(({ code }) => reject(new Error(`holder exited ${code} before holding: ${err}`)));
  });
  return { held, closed, child };
}

const failureCode = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };
// Absent means lstat answers ENOENT. existsSync is false for a delete-pending name too (EPERM).
const absent = (file) => failureCode(() => fs.lstatSync(file)) === 'ENOENT';

test('#265 A premise: a name deleted while another process holds it stays delete-pending only before libuv 1.49 on Windows', async (t) => {
  const root = createOwnedTempDir('holdem-delete-pending');
  const dir = path.join(root, 'held'), file = path.join(dir, 'pid');
  fs.mkdirSync(dir); fs.writeFileSync(file, 'x');
  const holder = holdOpen(file, { lingerMs: 200 });
  await holder.held;
  fs.unlinkSync(file);
  const lstatAfterUnlink = failureCode(() => fs.lstatSync(file));
  const listedAfterUnlink = fs.readdirSync(dir).join(',');
  const rmdirAfterUnlink = failureCode(() => fs.rmdirSync(dir));
  const closed = await holder.closed;
  t.diagnostic(`platform=${process.platform} node=${process.version} uv=${process.versions.uv} lstat=${lstatAfterUnlink} readdir=[${listedAfterUnlink}] rmdir=${rmdirAfterUnlink ?? 'ok'} holder=${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0);
  if (lstatAfterUnlink === 'EPERM') {
    // Delete-pending: the name stays listed and keeps its directory until the holder closes it.
    assert.equal(WIN32, true, 'only Windows keeps a deleted name behind a holder');
    assert.equal(listedAfterUnlink, 'pid');
    assert.equal(rmdirAfterUnlink, 'ENOTEMPTY');
    assert.equal(absent(file), true, 'the name goes when the last handle closes');
    fs.rmdirSync(dir);
  } else {
    assert.equal(lstatAfterUnlink, 'ENOENT');
    assert.equal(rmdirAfterUnlink, null);
  }
  // The CI premise: Node 20 on Windows (libuv 1.46) has no POSIX delete.
  if (DELETE_PENDING) assert.equal(lstatAfterUnlink, 'EPERM');
  if (!WIN32) assert.equal(lstatAfterUnlink, 'ENOENT');
});

// The decisions of removeDeletedLockDir, on any platform, against scripted file calls.
// By default the directory itself is gone once removed and every name in it is pending (EPERM).
const pendingNames = (file) => { const code = file === '/lock.d' ? 'ENOENT' : 'EPERM'; throw Object.assign(new Error(code), { code }); };
function scriptedOps({ rmdir, readdir = () => ['pid'], lstat = pendingNames, identity = () => ({ dev: 1n, ino: 2n }) }) {
  const calls = [];
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  return {
    calls,
    ops: {
      rmdir: (dir) => { calls.push('rmdir'); const code = rmdir(calls.filter((c) => c === 'rmdir').length); if (code) fail(code); },
      readdir: (dir) => { calls.push('readdir'); return readdir(); },
      lstat: (file) => { calls.push(`lstat ${path.basename(file)}`); return lstat(file); },
      identity: (dir) => { calls.push('identity'); return identity(); },
    },
  };
}
function decide(script, options = {}) {
  let clock = 0, slept = 0;
  const scripted = scriptedOps(script);
  let result, error;
  try {
    result = removeDeletedLockDir('/lock.d', { dev: 1n, ino: 2n }, {
      platform: 'win32', ops: scripted.ops, now: () => clock, sleep: (ms) => { clock += ms; slept += 1; }, ...options,
    });
  } catch (caught) { error = caught; }
  return { result, error, slept, calls: scripted.calls };
}

test('#265 A: removeDeletedLockDir waits only for deleted lock names, and only on Windows', () => {
  const aside = 'pid.reclaim.4194300.0badc0de';
  // Emptied after the first ENOTEMPTY: the holder closed in between. Retry at once.
  let r = decide({ rmdir: (n) => (n === 1 ? 'ENOTEMPTY' : null), readdir: () => [] });
  assert.equal(r.result, true); assert.equal(r.slept, 1);
  // The pid, and an aside, still pending (EPERM), then gone — whoever deleted them.
  r = decide({ rmdir: (n) => (n <= 3 ? 'ENOTEMPTY' : null), readdir: () => ['pid', aside] });
  assert.equal(r.result, true); assert.equal(r.slept, 3);
  // A pending name that vanished between readdir and lstat is gone.
  r = decide({ rmdir: (n) => (n === 1 ? 'ENOTEMPTY' : null), lstat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(r.result, true);
  // A foreign entry, a readable pid or aside (a live owner, a live reclaimer), a replaced or
  // unreadable directory: never waited on.
  for (const script of [
    { rmdir: () => 'ENOTEMPTY', readdir: () => ['pid', 'foreign'] },
    { rmdir: () => 'ENOTEMPTY', readdir: () => ['foreign'] },
    { rmdir: () => 'ENOTEMPTY', lstat: () => ({}) },
    { rmdir: () => 'ENOTEMPTY', readdir: () => [aside], lstat: () => ({}) },
    { rmdir: () => 'ENOTEMPTY', identity: () => ({ dev: 1n, ino: 3n }) },
    { rmdir: () => 'ENOTEMPTY', identity: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } },
    { rmdir: () => 'EEXIST', readdir: () => ['foreign'] },
  ]) {
    r = decide(script);
    assert.equal(r.result, false); assert.equal(r.slept, 0, JSON.stringify(r.calls));
  }
  // A name that answered EPERM and then reads again (an ACL refusal, a live reclaimer's aside):
  // the wait ends, and nothing but rmdir was ever attempted.
  let asideReads = 0;
  r = decide({ rmdir: () => 'ENOTEMPTY', readdir: () => [aside], lstat: () => { asideReads += 1; if (asideReads === 1) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return {}; } });
  assert.equal(r.result, false); assert.equal(r.slept, 1);
  assert.deepEqual(r.calls.filter((call) => !call.startsWith('lstat') && call !== 'identity' && call !== 'readdir'), ['rmdir', 'rmdir']);
  // Still pending at the bound: the directory is left, as before.
  r = decide({ rmdir: () => 'ENOTEMPTY' });
  assert.equal(r.result, false); assert.equal(r.slept, DELETE_PENDING_WAIT_MS / 20);
  // The caller's budget caps the wait; none at all when it is spent.
  r = decide({ rmdir: () => 'ENOTEMPTY' }, { waitMs: 100 });
  assert.equal(r.result, false); assert.equal(r.slept, 5);
  r = decide({ rmdir: () => 'ENOTEMPTY' }, { waitMs: -5 });
  assert.equal(r.result, false); assert.equal(r.slept, 0);
  // Other platforms delete names at once: an ENOTEMPTY there is foreign content.
  r = decide({ rmdir: () => 'ENOTEMPTY' }, { platform: 'linux' });
  assert.equal(r.result, false); assert.equal(r.slept, 0);
  assert.deepEqual(r.calls, ['rmdir']);
});

test('#265 A: removeDeletedLockDir retries a held directory only while it is the same one, and waits out its pending removal', () => {
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  // rmdir refused while another process holds the directory itself, then accepted.
  let r = decide({ rmdir: (n) => (n <= 2 ? 'EBUSY' : null), lstat: enoent });
  assert.equal(r.result, true); assert.equal(r.slept, 2);
  // Refused past the bound: thrown, as it always was.
  r = decide({ rmdir: () => 'EPERM' });
  assert.equal(r.error?.code, 'EPERM'); assert.equal(r.slept, DELETE_PENDING_WAIT_MS / 20);
  // A replaced or unreadable directory is not waited on.
  r = decide({ rmdir: () => 'EBUSY', identity: () => ({ dev: 1n, ino: 3n }) });
  assert.equal(r.error?.code, 'EBUSY'); assert.equal(r.slept, 0);
  r = decide({ rmdir: () => 'EPERM', identity: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
  assert.equal(r.error?.code, 'EPERM'); assert.equal(r.slept, 0);
  // Elsewhere, and for any other code, at once.
  r = decide({ rmdir: () => 'EPERM' }, { platform: 'darwin' });
  assert.equal(r.error?.code, 'EPERM'); assert.equal(r.slept, 0);
  r = decide({ rmdir: () => 'EACCES' });
  assert.equal(r.error?.code, 'EACCES'); assert.equal(r.slept, 0);
  // Removed, but the removal still pending behind a holder: the name answers EPERM until it goes.
  let reads = 0;
  r = decide({ rmdir: () => null, lstat: () => { reads += 1; const code = reads <= 3 ? 'EPERM' : 'ENOENT'; throw Object.assign(new Error(code), { code }); } });
  assert.equal(r.result, true); assert.equal(r.slept, 3);
  // A new owner's lock already at that path is not ours to watch.
  r = decide({ rmdir: () => null, lstat: () => ({}) });
  assert.equal(r.result, true); assert.equal(r.slept, 0);
});

test('#265: removeDeletedLockDir never retries its rmdir on a path that came to name another directory while it waited', () => {
  // The first identity read (before the wait) is the judged directory, every later one another.
  const replacedAfterWait = () => { let reads = 0; return () => { reads += 1; return { dev: 1n, ino: reads === 1 ? 2n : 3n }; }; };
  let r = decide({ rmdir: () => 'ENOTEMPTY', identity: replacedAfterWait() });
  assert.equal(r.result, false); assert.equal(r.slept, 1);
  assert.equal(r.calls.filter((call) => call === 'rmdir').length, 1, JSON.stringify(r.calls));
  r = decide({ rmdir: () => 'EBUSY', identity: replacedAfterWait() });
  assert.equal(r.error?.code, 'EBUSY'); assert.equal(r.slept, 1);
  assert.equal(r.calls.filter((call) => call === 'rmdir').length, 1, JSON.stringify(r.calls));
  // Unreadable after the wait (EPERM): not known to be the same directory, so treated as replaced.
  const unreadableAfterWait = () => { let reads = 0; return () => { reads += 1; if (reads === 1) return { dev: 1n, ino: 2n }; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }; };
  r = decide({ rmdir: () => 'ENOTEMPTY', identity: unreadableAfterWait() });
  assert.equal(r.result, false); assert.equal(r.calls.filter((call) => call === 'rmdir').length, 1);
  r = decide({ rmdir: () => 'EPERM', identity: unreadableAfterWait() });
  assert.equal(r.error?.code, 'EPERM'); assert.equal(r.calls.filter((call) => call === 'rmdir').length, 1);
  // Gone while it waited — another reclaimer finished it: removed, as the retried rmdir's ENOENT says.
  const goneAfterWait = () => { let reads = 0; return () => { reads += 1; return reads === 1 ? { dev: 1n, ino: 2n } : null; }; };
  for (const code of ['ENOTEMPTY', 'EBUSY']) {
    r = decide({ rmdir: () => code, identity: goneAfterWait() });
    assert.equal(r.result, true, code); assert.equal(r.slept, 1, code);
    assert.equal(r.calls.filter((call) => call === 'rmdir').length, 1, JSON.stringify(r.calls));
  }
});

test('#265 A: releaseOwnedLock removes its directory although another process held the pid file across the release', async () => {
  const root = createOwnedTempDir('holdem-release-held');
  const handle = acquireOwnedLock(root, 'held.lock.d');
  const holder = holdOpen(path.join(handle.dir, 'pid'));
  await holder.held;
  releaseOwnedLock(handle);
  assert.equal((await holder.closed).code, 0);
  // Judged after the holder closed: a directory still here now is the empty leftover that
  // every later reader takes as an unknown owner (LOOP_LOCK_UNKNOWN for the loop lock).
  assert.equal(absent(handle.dir), true, 'the released lock directory remains');
  assert.equal(readOwnedLock(root, 'held.lock.d'), null);
  releaseOwnedLock(acquireOwnedLock(root, 'held.lock.d'));
});

test('#265 A: a release waits a bounded time for a held pid file and then leaves the lock fail-closed', {
  skip: WIN32 ? false : 'only Windows keeps a deleted name behind its holder',
}, async (t) => {
  const root = createOwnedTempDir('holdem-release-bound');
  const handle = acquireOwnedLock(root, 'held.lock.d');
  const holder = holdOpen(path.join(handle.dir, 'pid'), { lingerMs: DELETE_PENDING_WAIT_MS + 4000 });
  await holder.held;
  const started = performance.now();
  releaseOwnedLock(handle);
  const elapsed = performance.now() - started;
  if (absent(handle.dir)) {
    await holder.closed;
    assert.equal(DELETE_PENDING, false, 'libuv 1.46 must keep the deleted name');
    t.skip('this file system deletes names at once');
    return;
  }
  assert.ok(elapsed < DELETE_PENDING_WAIT_MS + 1500, `release waited ${Math.round(elapsed)} ms for a holder that outlives its bound`);
  // While the pid is pending the lock cannot even be read: never reclaimed, never taken.
  assert.equal(readOwnedLock(root, 'held.lock.d')?.status, 'unknown');
  assert.throws(() => acquireOwnedLock(root, 'held.lock.d'), { code: 'EPERM' });
  assert.equal((await holder.closed).code, 0);
  // The empty leftover is an unknown owner, never reclaimed by age; only this test removes it.
  assert.deepEqual(fs.readdirSync(handle.dir), []);
  assert.equal(readOwnedLock(root, 'held.lock.d')?.status, 'unknown');
  assert.throws(() => acquireOwnedLock(root, 'held.lock.d'), { code: 'LOCKED' });
  fs.rmdirSync(handle.dir);
});

test('#265 A: a release returns only once its directory is gone although another process held the directory', async (t) => {
  const root = createOwnedTempDir('holdem-release-dir-held');
  const handle = acquireOwnedLock(root, 'held.lock.d');
  const holder = holdOpen(handle.dir, { kind: 'dir' });
  await holder.held;
  releaseOwnedLock(handle);
  // Judged before the holder closes: a removal still pending would refuse the next owner.
  const gone = absent(handle.dir);
  const next = gone ? acquireOwnedLock(root, 'held.lock.d') : null;
  const closed = await holder.closed;
  t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0, closed.err);
  assert.equal(gone, true, 'the released directory was still there when release returned');
  releaseOwnedLock(next);
});

test('#265 A: a release never waits on, or removes, an entry that is not its own pid file', async () => {
  const root = createOwnedTempDir('holdem-release-foreign');
  const handle = acquireOwnedLock(root, 'held.lock.d');
  fs.writeFileSync(path.join(handle.dir, 'foreign'), 'x');
  const holder = holdOpen(path.join(handle.dir, 'pid'));
  await holder.held;
  const started = performance.now();
  releaseOwnedLock(handle);
  const elapsed = performance.now() - started;
  assert.equal((await holder.closed).code, 0);
  assert.ok(elapsed < 500, `release waited ${Math.round(elapsed)} ms beside a foreign entry`);
  assert.deepEqual(fs.readdirSync(handle.dir), ['foreign']);
});

// A lock whose owner died: acquired by a child that exits without releasing it.
async function deadOwnedLock(dir, name) {
  const href = new URL('../engine/state.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireOwnedLock } from ${JSON.stringify(href)}; acquireOwnedLock(process.argv[1], process.argv[2]);`,
    dir, name], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, err);
  assert.equal(readOwnedLock(dir, name)?.status, 'dead');
}

test('#265 A: a dead lock is reclaimed although another process held its pid file across the reclaim', async () => {
  const root = createOwnedTempDir('holdem-reclaim-held');
  await deadOwnedLock(root, 'held.lock.d');
  const holder = holdOpen(path.join(root, 'held.lock.d', 'pid'));
  await holder.held;
  const handle = acquireOwnedLock(root, 'held.lock.d');
  assert.equal((await holder.closed).code, 0);
  assert.equal(readOwnedLock(root, 'held.lock.d')?.status, 'alive');
  assert.deepEqual(fs.readdirSync(handle.dir), ['pid']);
  releaseOwnedLock(handle);
  assert.equal(absent(handle.dir), true);
});

test('#265 A: a dead lock is reclaimed although another process held its directory across the reclaim', async (t) => {
  const root = createOwnedTempDir('holdem-reclaim-dir-held');
  await deadOwnedLock(root, 'held.lock.d');
  const holder = holdOpen(path.join(root, 'held.lock.d'), { kind: 'dir' });
  await holder.held;
  const handle = acquireOwnedLock(root, 'held.lock.d');
  const closed = await holder.closed;
  t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0, closed.err);
  assert.equal(readOwnedLock(root, 'held.lock.d')?.status, 'alive');
  releaseOwnedLock(handle);
  assert.equal(absent(handle.dir), true);
});

test('#265 A: a dead lock is reclaimed although another process held a dead reclaimer\'s aside the sweep removed', async (t) => {
  const root = createOwnedTempDir('holdem-reclaim-orphan-held');
  await deadOwnedLock(root, 'held.lock.d');
  // An orphan aside of a reclaimer that is not running, linked to the stale pid file as a real one is.
  assert.equal(failureCode(() => process.kill(4194300, 0)), 'ESRCH', 'the orphan reclaimer pid must not be running');
  const orphan = path.join(root, 'held.lock.d', 'pid.reclaim.4194300.0badc0de');
  fs.linkSync(path.join(root, 'held.lock.d', 'pid'), orphan);
  const holder = holdOpen(orphan);
  await holder.held;
  const handle = acquireOwnedLock(root, 'held.lock.d');
  const closed = await holder.closed;
  t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0, closed.err);
  assert.equal(readOwnedLock(root, 'held.lock.d')?.status, 'alive');
  assert.deepEqual(fs.readdirSync(handle.dir), ['pid']);
  releaseOwnedLock(handle);
  assert.equal(absent(handle.dir), true);
});

for (const [label, held] of [['descriptor', (storeDir) => descriptorPath(storeDir)], ['lock pid file', (storeDir) => path.join(lockPath(storeDir), 'pid')]]) {
  test(`#265 A: a study stop finishes and leaves no lock or descriptor when another process holds the ${label} across its removal`, { timeout: STOP_BUDGET }, async (t) => {
    const { storeDir, handle, api } = await launch(t);
    const holder = holdOpen(held(storeDir));
    await holder.held;
    const result = await api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId });
    const closed = await holder.closed;
    t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
    assert.deepEqual(result, { stopped: true, alreadyStopped: false });
    // The stop result alone would also accept a dead lock left behind; the service's own
    // cleanup is what removes both.
    assert.equal(absent(descriptorPath(storeDir)), true, 'descriptor left behind');
    assert.equal(absent(lockPath(storeDir)), true, 'study lock left behind');
  });
}

test('#265 A: a service that cannot release its lock within its deadline leaves it dead, and the stop and the next ensure still converge', { timeout: STOP_BUDGET }, async (t) => {
  // The service's stderr goes to the diagnostics log; CI already sets one, a local run gets its own.
  const before = process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS;
  const diagnostics = before ?? createOwnedTempDir('holdem-study-diagnostics');
  const childLog = path.join(diagnostics, 'study-children.log');
  // Only what this test's service appends: the CI log is shared, and pids are reused.
  const logStart = fs.existsSync(childLog) ? fs.statSync(childLog).size : 0;
  process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS = diagnostics;
  let launched;
  try { launched = await launch(t); }
  finally { if (before === undefined) delete process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS; else process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS = before; }
  const { storeDir, handle, api } = launched;
  // Where the deleted name stays behind the holder, held past the service's cleanup deadline (10 s).
  const holder = holdOpen(descriptorPath(storeDir), { lingerMs: 300, pendingLingerMs: 14_000 });
  await holder.held;
  const result = await api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId });
  const closed = await holder.closed;
  t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0, closed.err);
  assert.deepEqual(result, { stopped: true, alreadyStopped: false });
  assert.equal(absent(descriptorPath(storeDir)), true);
  const lock = readOwnedLock(path.join(storeDir, '.training'), 'study.lock.d');
  if (closed.out.includes('seen EPERM')) {
    assert.equal(lock?.status, 'dead', 'a service that gave up its release leaves a dead lock');
    // It retried the held file until its deadline: the last attempt failed on that file (EPERM)
    // or on the spent budget itself (no errno) — never on anything else, such as the RangeError
    // a broken retry clock threw at once. How many attempts fit depends on the runner.
    const appended = fs.readFileSync(childLog).subarray(logStart).toString('utf8');
    const line = appended.split('\n')
      .find((row) => row.startsWith('STUDY_CHILD_CLEANUP_FAILED step=release') && row.endsWith(` pid=${handle.pid}`));
    assert.ok(line, `the service reported no failed release:\n${appended}`);
    t.diagnostic(line);
    assert.match(line, / code=STUDY_DESCRIPTOR_CORRUPT fs=(EPERM|none) /);
  } else {
    assert.equal(lock, null);
  }
  const second = await launch(t, {}, storeDir);
  assert.notEqual(second.handle.instanceId, handle.instanceId);
});

test('#265 A: only a Windows EPERM or EBUSY from a file call earns a cleanup step another attempt', async () => {
  const { transientCleanupError } = await service();
  const coded = (fsCode) => Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT'), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode });
  for (const code of ['EPERM', 'EBUSY']) {
    assert.equal(transientCleanupError(coded(code), 'win32'), true, code);
    assert.equal(transientCleanupError(Object.assign(new Error(code), { code }), 'win32'), true, `raw ${code}`);
    assert.equal(transientCleanupError(coded(code), 'linux'), false, `${code} is permanent on POSIX`);
    assert.equal(transientCleanupError(coded(code), 'darwin'), false, `${code} is permanent on macOS`);
  }
  for (const error of [coded('EACCES'), coded('ENOTDIR'), coded(undefined), new Error('STUDY_IDENTITY_MISMATCH'),
    Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT'), { code: 'STUDY_DESCRIPTOR_CORRUPT' }), null, undefined]) {
    assert.equal(transientCleanupError(error, 'win32'), false, String(error?.fsCode ?? error?.message));
  }
});

test('#265 A: a cleanup step retries only a transient failure, inside one deadline, and reports how it ended', async () => {
  const { runCleanupStep } = await service();
  const transient = () => Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT fs=EPERM'), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EPERM' });
  const run = async (fn, { deadline = 1000, platform = 'win32' } = {}) => {
    let clock = 0;
    const lines = [];
    const ok = await runCleanupStep('release', fn, { deadline, platform, now: () => clock,
      wait: async (ms) => { clock += ms; }, report: (line) => lines.push(line) });
    return { ok, lines, clock };
  };
  let tries = 0;
  let r = await run(() => { tries += 1; if (tries < 3) throw transient(); });
  assert.equal(r.ok, true); assert.equal(tries, 3); assert.deepEqual(r.lines, []);
  // Every retry runs under the deadline, on the same clock: its proofs and stat calls see what is
  // left of it, and fail once it is spent.
  const budgets = [];
  tries = 0;
  r = await run(() => {
    tries += 1;
    try { budgets.push(platformTimeout(15_000)); } catch (error) { budgets.push(error.code); }
    if (tries < 2) throw transient();
  }, { deadline: 5_000 });
  assert.deepEqual(budgets, [15_000, 4_950], 'the first attempt keeps the bounds it always had');
  // A failure that is not a held file ends the step at once, reported.
  tries = 0;
  r = await run(() => { tries += 1; throw Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT own lock absent'), { code: 'STUDY_DESCRIPTOR_CORRUPT' }); });
  assert.equal(r.ok, false); assert.equal(tries, 1);
  assert.deepEqual(r.lines, [`STUDY_CHILD_CLEANUP_FAILED step=release code=STUDY_DESCRIPTOR_CORRUPT fs=none tries=1 pid=${process.pid}\n`]);
  // A held file that outlasts the deadline: retried until it is spent, then reported.
  tries = 0;
  r = await run(() => { tries += 1; throw transient(); }, { deadline: 200 });
  assert.equal(r.ok, false); assert.equal(tries, 5); assert.equal(r.clock, 200);
  assert.deepEqual(r.lines, [`STUDY_CHILD_CLEANUP_FAILED step=release code=STUDY_DESCRIPTOR_CORRUPT fs=EPERM tries=5 pid=${process.pid}\n`]);
  // POSIX: EPERM is a refusal, never retried.
  tries = 0;
  r = await run(() => { tries += 1; throw transient(); }, { platform: 'linux' });
  assert.equal(r.ok, false); assert.equal(tries, 1);
  // The two steps of a stop share one deadline: what the first spends, the second cannot retry with.
  let clock = 0;
  const lines = [];
  const shared = { deadline: 120, platform: 'win32', now: () => clock, wait: async (ms) => { clock += ms; }, report: (line) => lines.push(line) };
  let first = 0, second = 0;
  assert.equal(await runCleanupStep('descriptor', () => { first += 1; if (first < 3) throw transient(); }, shared), true);
  assert.equal(await runCleanupStep('release', () => { second += 1; throw transient(); }, shared), false);
  assert.deepEqual([first, second, clock], [3, 2, 120]);
  assert.deepEqual(lines, [`STUDY_CHILD_CLEANUP_FAILED step=release code=STUDY_DESCRIPTOR_CORRUPT fs=EPERM tries=2 pid=${process.pid}\n`]);
});

test('#265 A: a cleanup retry on the default clock reads its deadline without recursing', async () => {
  const { runCleanupStep } = await service();
  const transient = () => Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT fs=EPERM'), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EPERM' });
  const budgets = [];
  const lines = [];
  let tries = 0;
  const ok = await runCleanupStep('release', () => {
    tries += 1;
    budgets.push(platformTimeout(15_000));
    if (tries < 2) throw transient();
  }, { deadline: platformNow() + 5_000, platform: 'win32', report: (line) => lines.push(line) });
  assert.deepEqual(lines, []);
  assert.equal(ok, true);
  assert.equal(budgets[0], 15_000);
  assert.ok(budgets[1] > 0 && budgets[1] <= 5_000, `the retry ran with ${budgets[1]} ms`);
  // Without a clock of its own a cleanup step keeps the clock already in force, an outer test
  // clock included, and a retry that reaches the deadline fails on the spent budget (no errno).
  let clock = 0;
  const seen = [];
  tries = 0;
  const outer = await withPlatformDeadline(10_000, () => runCleanupStep('release', () => {
    tries += 1;
    seen.push(platformTimeout(15_000));
    throw transient();
  }, { deadline: 100, platform: 'win32', wait: async (ms) => { clock += ms; }, report: (line) => lines.push(line) }), { now: () => clock });
  assert.equal(outer, false);
  assert.deepEqual(seen, [10_000, 50], 'the first attempt sees the outer budget, the retry what is left of its deadline');
  assert.deepEqual(lines, [`STUDY_CHILD_CLEANUP_FAILED step=release code=STUDY_DESCRIPTOR_CORRUPT fs=none tries=3 pid=${process.pid}\n`]);
  assert.equal(clock, 100);
});

test('#265 A: a transaction keeps its body\'s errno when its after-proof fails too, and a proof keeps the errno of a path it could not stat', async () => {
  const { aclTransaction } = await service();
  const root = createOwnedTempDir('holdem-acl-errno');
  const ctx = { root, training: path.join(root, '.training') };
  const held = Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT fs=EPERM'), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EPERM' });
  let proofs = 0;
  const beforeOnly = (entries, { onUnproven }) => { proofs += 1; if (proofs === 1) return true; onUnproven('acl:after'); return false; };
  assert.throws(() => aclTransaction(ctx, () => { throw held; }, { platform: 'win32', prove: beforeOnly }), (error) => error === held);
  assert.equal(proofs > 1, true, 'the after-proof still ran');
  proofs = 0;
  // A body that succeeded still fails on its after-proof, as before.
  assert.throws(() => aclTransaction(ctx, () => 'done', { platform: 'win32', prove: beforeOnly }),
    (error) => error.code === 'STUDY_DESCRIPTOR_CORRUPT' && error.fsCode === undefined);
  const unstatable = (entries, { onUnproven }) => { onUnproven('error:EPERM'); return false; };
  assert.throws(() => aclTransaction(ctx, () => 'never', { platform: 'win32', prove: unstatable }),
    (error) => error.code === 'STUDY_DESCRIPTOR_CORRUPT' && error.fsCode === 'EPERM');
  const refused = (entries, { onUnproven }) => { onUnproven('acl:refused'); return false; };
  assert.throws(() => aclTransaction(ctx, () => 'never', { platform: 'win32', prove: refused }),
    (error) => error.code === 'STUDY_DESCRIPTOR_CORRUPT' && error.fsCode === undefined);
});

test('#265 A: a dead owner that left only its lock is stopped for inspect and stop, and a later ensure replaces it', { timeout: STOP_BUDGET }, async (t) => {
  const first = await launch(t);
  const api = await service();
  await api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId });
  assert.equal(absent(lockPath(first.storeDir)), true);
  await deadOwnedLock(path.join(first.storeDir, '.training'), 'study.lock.d');
  assert.equal(absent(descriptorPath(first.storeDir)), true);
  assert.deepEqual(await api.inspectStudyService(first.storeDir), { status: 'stopped' });
  assert.deepEqual(await api.stopStudyService(first.storeDir, { expectedInstanceId: randomUUID() }), { stopped: true, alreadyStopped: true });
  const second = await launch(t, {}, first.storeDir);
  assert.notEqual(second.handle.instanceId, first.handle.instanceId);
  assert.equal((await api.inspectStudyService(first.storeDir)).instanceId, second.handle.instanceId);
});

// #319 F4: a refused file names the check that refused it — never its path. A dead owner's pid
// file with a second name is refused by its link count, before any ACL proof.
test('#319 F4: a refused lock pid file names the failed check in the error detail, never the path', { timeout: STOP_BUDGET }, async (t) => {
  const first = await launch(t);
  const api = await service();
  await api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId });
  await deadOwnedLock(path.join(first.storeDir, '.training'), 'study.lock.d');
  const second = path.join(first.storeDir, 'pid-second-name');
  fs.linkSync(path.join(lockPath(first.storeDir), 'pid'), second);
  t.after(() => fs.rmSync(second, { force: true }));
  for (const call of [() => api.inspectStudyService(first.storeDir),
    () => api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId })]) {
    const error = await call().then(() => null, (failure) => failure);
    assert.equal(error?.code, 'STUDY_DESCRIPTOR_CORRUPT', String(error?.stack ?? error));
    assert.match(error.message, /^STUDY_DESCRIPTOR_CORRUPT read:before:nlink$/);
  }
});

test('#319 F4: a proof refusal keeps its kind, status and errno but no path or SID', async () => {
  const { proofRefusalToken } = await service();
  const file = 'C:\\Users\\runner admin\\AppData\\Local\\Temp\\store\\.training\\study.lock.d\\pid';
  const cases = [
    [`powershell:status=null error=ETIMEDOUT stderr=${file}`, 'proof-powershell-null-ETIMEDOUT'],
    ['powershell:status=1 error=none stderr=Access denied', 'proof-powershell-1-none'],
    [`acl:${file} {"user":"S-1-5-21-1","owner":"S-1-5-21-2","rules":[]}`, 'proof-acl'],
    [`shape:${file}`, 'proof-shape'],
    ['proofs:0/3', 'proof-proofs'],
    ['error:SyntaxError', 'proof-error-SyntaxError'],
    ['error:C:\\secret path', 'proof-error-unknown'],
    [`stat:${file} ENOENT`, 'proof-stat-ENOENT'],
    [`mode:/tmp/x 644`, 'proof-mode'],
    ['something else', 'proof-unknown'],
    [null, 'proof-unknown'],
  ];
  for (const [reason, token] of cases) {
    assert.equal(proofRefusalToken(reason), token, String(reason));
    assert.match(token, /^[A-Za-z0-9_-]+$/);
  }
});

test('#265 A: a live owner without a descriptor is never reported stopped', { timeout: STOP_BUDGET }, async (t) => {
  const { storeDir, handle, api } = await launch(t);
  await api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId });
  // This process holds the lock and publishes nothing: a live owner before its first publish.
  const own = acquireOwnedLock(path.join(storeDir, '.training'), 'study.lock.d');
  try {
    assert.equal(readOwnedLock(path.join(storeDir, '.training'), 'study.lock.d')?.status, 'alive');
    // Under a short outer budget both calls wait for a publish that never comes and fail.
    const budget = WIN32 ? 20_000 : 2_000;
    await assert.rejects(withPlatformDeadline(platformNow() + budget, () => api.inspectStudyService(storeDir)), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
    await assert.rejects(withPlatformDeadline(platformNow() + budget,
      () => api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId })), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  } finally { releaseOwnedLock(own); }
});

test('#265 A: a lock directory without a readable owner still fails closed for inspect and stop', { timeout: STOP_BUDGET }, async (t) => {
  const { storeDir, handle, api } = await launch(t);
  await api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId });
  fs.mkdirSync(lockPath(storeDir));
  t.after(() => fs.rmSync(lockPath(storeDir), { recursive: true, force: true }));
  await assert.rejects(api.inspectStudyService(storeDir), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  await assert.rejects(api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  assert.deepEqual(fs.readdirSync(lockPath(storeDir)), [], 'an unknown owner is preserved');
});

// #265: the short mutex (withNamedLock, withMutation, runExclusive) — publish.lock.d, which every
// coach-control and publish child takes, .mutex, the training and drill locks. Its waiters poll the
// owner's pid file every retry, so on a contended lock a waiter often has it open when the owner
// releases. Before libuv 1.49 on Windows that leaves the name pending behind the waiter: a release
// that took the directory's ENOTEMPTY as final left an empty directory, which every waiter then takes
// for a lock inside its mkdir→pid window until it is 6 s old (MUTEX_STALE_MS) — past the 3 s default
// wait, and a 6 s stall for a coach child under a finalization deadline. A third process opening the
// pending name meanwhile got EPERM, and its acquire threw it.
const STATE_HREF = new URL('../engine/state.js', import.meta.url).href;

// Takes the mutex `name` under `root` once, polling every `retryMs`, and reports how it went. It
// starts once `go` exists: registering the child can take a while on Windows (a synchronous identity
// probe), and its deadline must not run before the test is ready to act on it.
const WAITER = `
import fs from 'node:fs';
import { withNamedLock } from ${JSON.stringify(STATE_HREF)};
import { performance } from 'node:perf_hooks';
const [root, name, retryMs, timeoutMs, go] = process.argv.slice(1);
while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 2));
process.stdout.write('waiting\\n');
const started = performance.now();
try {
  await withNamedLock(root, name, () => {}, { retryMs: Number(retryMs), timeoutMs: Number(timeoutMs) });
  process.stdout.write('acquired ' + Math.round(performance.now() - started) + '\\n');
} catch (error) {
  process.stdout.write('failed ' + (error.code ?? error.message) + ' ' + Math.round(performance.now() - started) + '\\n');
}`;

function waitForMutex(root, name, { retryMs = 5, timeoutMs = 15_000 } = {}) {
  const go = path.join(root, `waiter-go-${randomUUID()}`);
  const child = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e', WAITER, root, name, String(retryMs), String(timeoutMs), go],
    { stdio: ['ignore', 'pipe', 'pipe'] }), 'short mutex waiter');
  fs.writeFileSync(go, '');
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  const waiting = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (out.includes('waiting\n')) resolve(); });
    closed.then(({ code }) => reject(new Error(`waiter exited ${code} before waiting: ${err}`)));
  });
  return { waiting, closed };
}

test('#265 short mutex: a release leaves no lock directory although another process held its pid file across it', async (t) => {
  const root = createOwnedTempDir('holdem-mutex-release-held');
  const dir = path.join(root, 'held.lock.d');
  let holder;
  await withNamedLock(root, 'held.lock.d', async () => {
    holder = holdOpen(path.join(dir, 'pid'), { lingerMs: 300 });
    await holder.held;
  });
  const closed = await holder.closed;
  t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0, closed.err);
  // Judged after the holder closed: what is still here is the empty leftover.
  assert.equal(absent(dir), true, `the released lock directory remains: [${fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : ''}]`);
  // The next owner, on the default 3 s wait, takes it at once.
  const started = performance.now();
  await withNamedLock(root, 'held.lock.d', () => {});
  assert.ok(performance.now() - started < 1000, `the next acquire waited ${Math.round(performance.now() - started)} ms`);
});

test('#265 short mutex: a waiter that meets the pid file pending deletion behind another reader waits for the release instead of failing', async (t) => {
  const root = createOwnedTempDir('holdem-mutex-waiter-pending');
  const dir = path.join(root, 'held.lock.d');
  let holder, waiter;
  await withNamedLock(root, 'held.lock.d', async () => {
    // The reader keeps the deleted name for a second; the waiter polls through all of it.
    holder = holdOpen(path.join(dir, 'pid'), { lingerMs: 1000 });
    await holder.held;
    waiter = waitForMutex(root, 'held.lock.d');
    await waiter.waiting;
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  const [held, waited] = await Promise.all([holder.closed, waiter.closed]);
  t.diagnostic(`holder ${held.out.trim().replace(/\n/g, ' | ')}; waiter ${waited.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(held.code, 0, held.err);
  assert.equal(waited.code, 0, waited.err);
  const result = /^(acquired|failed) (\S+)(?: (\d+))?$/m.exec(waited.out);
  assert.equal(result?.[1], 'acquired', `the waiter failed: ${waited.out.trim()}`);
  // Not the 6 s staleness of an empty leftover: the release itself made way.
  assert.ok(Number(result[2]) < 5000, `the waiter waited ${result[2]} ms`);
  assert.equal(absent(dir), true);
});

test('#265 short mutex: a pid file pending past the waiter\'s deadline still fails it with that EPERM', {
  skip: WIN32 ? false : 'only Windows keeps a deleted name behind its holder',
}, async (t) => {
  const root = createOwnedTempDir('holdem-mutex-pending-bound');
  const dir = path.join(root, 'held.lock.d');
  let holder;
  await withNamedLock(root, 'held.lock.d', async () => {
    holder = holdOpen(path.join(dir, 'pid'), { lingerMs: 300, pendingLingerMs: DELETE_PENDING_WAIT_MS + 6000 });
    await holder.held;
  });
  try {
    if (absent(path.join(dir, 'pid'))) {
      assert.equal(DELETE_PENDING, false, 'libuv 1.46 must keep the deleted name');
      t.skip('this file system deletes names at once');
      return;
    }
    // The name is still pending: a waiter retries it to its deadline, and then fails as it always did.
    const started = performance.now();
    await assert.rejects(withNamedLock(root, 'held.lock.d', () => {}, { timeoutMs: 1000, retryMs: 20 }), { code: 'EPERM' });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 3000, `the waiter gave up after ${Math.round(elapsed)} ms, against a 1000 ms deadline`);
  } finally {
    assert.equal((await holder.closed).code, 0);
    try { fs.rmdirSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
});

test('#265 short mutex: a waiter whose last round finds a lock it may not take fails LOCKED, though earlier rounds met a pending pid', {
  skip: WIN32 ? false : 'only Windows keeps a deleted name behind its holder',
}, async (t) => {
  const root = createOwnedTempDir('holdem-mutex-pending-then-held');
  const dir = path.join(root, 'held.lock.d');
  let holder;
  // The holder keeps the deleted pid past the release's bound until this test ends it.
  await withNamedLock(root, 'held.lock.d', async () => {
    holder = holdOpen(path.join(dir, 'pid'), { lingerMs: 300, pendingLingerMs: 60_000 });
    await holder.held;
  });
  try {
    if (absent(path.join(dir, 'pid'))) {
      assert.equal(DELETE_PENDING, false, 'libuv 1.46 must keep the deleted name');
      t.skip('this file system deletes names at once');
      return;
    }
    // A waiter in another process polls the pending pid; then the holder ends, which leaves the
    // empty directory no waiter may take before it is 6 s old, well past the waiter's 3 s.
    const waiter = waitForMutex(root, 'held.lock.d', { retryMs: 20, timeoutMs: 3000 });
    await waiter.waiting;
    await new Promise((resolve) => setTimeout(resolve, 300));
    holder.child.kill();
    await holder.closed;
    const waited = await waiter.closed;
    t.diagnostic(`waiter ${waited.out.trim().replace(/\n/g, ' | ')}`);
    assert.equal(waited.code, 0, waited.err);
    assert.match(waited.out, /^failed LOCKED \d+$/m);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    holder.child.kill();
    await holder.closed;
    try { fs.rmdirSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
});

// A dead owner's short lock: its one-line pid names a process that is not running.
function deadShortLock(root, name) {
  assert.equal(failureCode(() => process.kill(4194300, 0)), 'ESRCH', 'the dead owner pid must not be running');
  fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, name, 'pid'), '4194300');
}

test('#265 short mutex: a reclaim step that fails is thrown at once, never retried as a pending read', async () => {
  const root = createOwnedTempDir('holdem-mutex-reclaim-step');
  deadShortLock(root, 'held.lock.d');
  let entered = false, linked = 0;
  // Past the judgement, with the stale pid pinned by this reclaimer's aside: a step that fails here
  // is a failed reclaim, not a name in the middle of its deletion.
  await assert.rejects(withNamedLock(root, 'held.lock.d', () => { entered = true; }, {
    timeoutMs: 3000,
    hooks: {
      afterLink: (lockDir, aside) => { linked += fs.existsSync(aside) ? 1 : 0; },
      beforeUnlinkPid: () => { throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM', syscall: 'unlink' }); },
    },
  }), { code: 'EPERM', syscall: 'unlink' });
  assert.equal(entered, false);
  // Once, after the aside was linked: a retry would have judged and linked again.
  assert.equal(linked, 1, 'the failure was retried, or came before the aside was linked');
  // Nothing was half-removed: the stale pid is where it was, and the aside is gone.
  assert.deepEqual(fs.readdirSync(path.join(root, 'held.lock.d')), ['pid']);
  // Without the failure the same stale lock is reclaimed.
  await withNamedLock(root, 'held.lock.d', () => { entered = true; });
  assert.equal(entered, true);
  assert.equal(absent(path.join(root, 'held.lock.d')), true);
});

test('#265 short mutex: a release never waits on, or removes, an entry that is not its own pid file', async () => {
  const root = createOwnedTempDir('holdem-mutex-release-foreign');
  const dir = path.join(root, 'held.lock.d');
  let holder, started;
  await withNamedLock(root, 'held.lock.d', async () => {
    fs.writeFileSync(path.join(dir, 'foreign'), 'x');
    holder = holdOpen(path.join(dir, 'pid'));
    await holder.held;
    started = performance.now();
  });
  const elapsed = performance.now() - started;
  assert.equal((await holder.closed).code, 0);
  assert.ok(elapsed < 500, `release waited ${Math.round(elapsed)} ms beside a foreign entry`);
  assert.deepEqual(fs.readdirSync(dir), ['foreign']);
});

// Ordinary contention, no holder: the waiters themselves are the readers. Every contender starts
// once all of them are ready, then runs `cycles` cycles; `maxMs` is only a watchdog on starting
// another (the last acquire may still take its timeout). An error is counted under where it was
// thrown (acquire or release — the body only spins) and its code and syscall.
const CONTENDER = `
import fs from 'node:fs';
import { withNamedLock } from ${JSON.stringify(STATE_HREF)};
import { performance } from 'node:perf_hooks';
const [root, name, cycles, maxMs, go] = process.argv.slice(1);
process.stdout.write('ready\\n');
while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 2));
const errors = {};
let done = 0, maxWait = 0;
const end = performance.now() + Number(maxMs);
while (done < Number(cycles) && performance.now() < end) {
  const started = performance.now();
  let entered = false;
  try {
    await withNamedLock(root, name, () => {
      entered = true;
      maxWait = Math.max(maxWait, performance.now() - started);
      const until = performance.now() + 1;
      while (performance.now() < until);
    }, { retryMs: 5, timeoutMs: 20000 });
    done += 1;
  } catch (error) {
    const key = (entered ? 'release' : 'acquire') + ':' + (error.code ?? 'ERROR') + ':' + (error.syscall ?? '-');
    errors[key] = (errors[key] ?? 0) + 1;
  }
  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 10)));
}
process.stdout.write(JSON.stringify({ done, errors, maxWait: Math.round(maxWait) }) + '\\n');`;

const CONTENDER_CYCLES = 60;

test('#265 short mutex: contending processes do not fail on each other\'s reads of the pid file', { timeout: 150_000 }, async (t) => {
  const root = createOwnedTempDir('holdem-mutex-contention');
  const go = path.join(root, 'go');
  const runs = Array.from({ length: 4 }, () => {
    const child = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e', CONTENDER, root, 'busy.lock.d', String(CONTENDER_CYCLES), '60000', go],
      { stdio: ['ignore', 'pipe', 'pipe'] }), 'short mutex contender');
    let out = '', err = '';
    const closed = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('ready\n')) resolve(); });
      closed.then(({ code }) => reject(new Error(`contender exited ${code} before it was ready: ${err}`)));
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    return { ready, closed };
  });
  await Promise.all(runs.map((run) => run.ready));
  fs.writeFileSync(go, '');
  const results = await Promise.all(runs.map((run) => run.closed));
  const reports = results.map(({ code, out, err }) => { assert.equal(code, 0, err); return JSON.parse(out.slice(out.indexOf('ready\n') + 6)); });
  t.diagnostic(`contenders ${JSON.stringify(reports)}`);
  // The waits are a diagnostic: the lock is not fair, so no bound on them is a correctness check
  // (the empty leftover's 6 s stall — 5990–6030 ms in the Windows Node 20 RED — is pinned by the
  // deterministic tests above).
  for (const report of reports) {
    assert.deepEqual(report.errors, {}, `a contender failed: ${JSON.stringify(reports)}`);
    assert.equal(report.done, CONTENDER_CYCLES, `a contender did not finish: ${JSON.stringify(reports)}`);
  }
  assert.equal(absent(path.join(root, 'busy.lock.d')), true);
});

// #306: two readers of a lock's pid file that took a name pending deletion for a verdict. The
// pending name is a release (or a reclaim) in progress, not an owner: its owner is gone or going.
// finalize-cutoff's check for a live publish.lock.d holder read it as one (lock_held), and a study
// client failed an ensure whose own service child was reclaiming a dead owner's lock.
test('#306: hasLiveLockHolder takes a pid file pending deletion behind another reader for the release it is', async (t) => {
  const gameDir = createOwnedTempDir('holdem-306-holder-pending');
  const pidFile = path.join(gameDir, LOCK_NAME, 'pid');
  fs.mkdirSync(path.dirname(pidFile));
  // A live pid: this owner is releasing, exactly as a publisher does when it leaves.
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  const holder = holdOpen(pidFile, { lingerMs: 300, pendingLingerMs: 1000 });
  await holder.held;
  fs.unlinkSync(pidFile);
  const pending = failureCode(() => fs.lstatSync(pidFile)) === 'EPERM';
  const started = performance.now();
  const held = hasLiveLockHolder(gameDir);
  const elapsed = performance.now() - started;
  const closed = await holder.closed;
  t.diagnostic(`pending=${pending} elapsed=${Math.round(elapsed)} holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0, closed.err);
  if (!pending) assert.equal(DELETE_PENDING, false, 'libuv 1.46 must keep the deleted name');
  assert.equal(held, false, 'a pid file pending deletion was taken for a live lock holder');
  // A lock the release left behind is still a holder's while its pid answers.
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  assert.equal(hasLiveLockHolder(gameDir), true);
});

test('#306: hasLiveLockHolder retries only a Windows EPERM read of the pid file, within its bound', () => {
  const gameDir = createOwnedTempDir('holdem-306-holder-decision');
  const coded = (code) => () => Object.assign(new Error(code), { code });
  let clock = 0;
  const sleep = (ms) => { clock += ms; };
  const now = () => clock;
  const reads = (...steps) => {
    const calls = { n: 0 };
    const readFile = () => {
      const step = steps[Math.min(calls.n, steps.length - 1)];
      calls.n += 1;
      if (typeof step === 'function') throw step();
      return step;
    };
    return Object.assign(readFile, { calls });
  };
  // A release that finished, and a reclaim whose next owner is alive.
  assert.equal(hasLiveLockHolder(gameDir, { platform: 'win32', readFile: reads(coded('EPERM'), coded('EPERM'), coded('ENOENT')), sleep, now }), false);
  assert.equal(hasLiveLockHolder(gameDir, { platform: 'win32', readFile: reads(coded('EPERM'), `${process.pid}\n`), sleep, now }), true);
  // Unreadable to the end of the bound: held, after waiting no longer than the bound.
  clock = 0;
  const stuck = reads(coded('EPERM'));
  assert.equal(hasLiveLockHolder(gameDir, { platform: 'win32', readFile: stuck, sleep, now }), true);
  assert.ok(clock >= DELETE_PENDING_WAIT_MS && clock < DELETE_PENDING_WAIT_MS + 100, `waited ${clock} ms`);
  assert.ok(stuck.calls.n > 1);
  // A shorter caller bound is kept; a longer one is capped.
  clock = 0;
  assert.equal(hasLiveLockHolder(gameDir, { platform: 'win32', readFile: reads(coded('EPERM')), sleep, now, waitMs: 100 }), true);
  assert.ok(clock >= 100 && clock < 200, `waited ${clock} ms`);
  clock = 0;
  assert.equal(hasLiveLockHolder(gameDir, { platform: 'win32', readFile: reads(coded('EPERM')), sleep, now, waitMs: 60_000 }), true);
  assert.ok(clock < DELETE_PENDING_WAIT_MS + 100, `waited ${clock} ms`);
  // Elsewhere an EPERM read is no pending name: held at once, read once.
  const posix = reads(coded('EPERM'));
  assert.equal(hasLiveLockHolder(gameDir, { platform: 'linux', readFile: posix, sleep, now }), true);
  assert.equal(posix.calls.n, 1);
  // Any other failure is thrown, never retried.
  const busy = reads(coded('EBUSY'));
  assert.throws(() => hasLiveLockHolder(gameDir, { platform: 'win32', readFile: busy, sleep, now }), { code: 'EBUSY' });
  assert.equal(busy.calls.n, 1);
  // A live process this user may not signal (kill(0) EPERM) is held at once: read once, no wait.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    clock = 0;
    const init = reads('1\n');
    assert.equal(hasLiveLockHolder(gameDir, { platform: 'win32', readFile: init, sleep, now }), true);
    assert.equal(init.calls.n, 1);
    assert.equal(clock, 0);
  }
  // Unchanged: no pid file and an unparsable one are no holder.
  assert.equal(hasLiveLockHolder(gameDir), false);
  assert.equal(hasLiveLockHolder(gameDir, { readFile: reads('not-a-pid\n') }), false);
});

test('#306: hasLiveLockHolder still answers held for a pid file that stays unreadable past its bound', {
  skip: WIN32 ? false : 'only Windows keeps a deleted name behind its holder',
}, async (t) => {
  const gameDir = createOwnedTempDir('holdem-306-holder-bound');
  const pidFile = path.join(gameDir, LOCK_NAME, 'pid');
  fs.mkdirSync(path.dirname(pidFile));
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  const holder = holdOpen(pidFile, { pendingLingerMs: DELETE_PENDING_WAIT_MS + 4000 });
  await holder.held;
  fs.unlinkSync(pidFile);
  if (failureCode(() => fs.lstatSync(pidFile)) !== 'EPERM') {
    await holder.closed;
    assert.equal(DELETE_PENDING, false, 'libuv 1.46 must keep the deleted name');
    t.skip('this file system deletes names at once');
    return;
  }
  const started = performance.now();
  const held = hasLiveLockHolder(gameDir);
  const elapsed = performance.now() - started;
  assert.equal((await holder.closed).code, 0);
  // Unproven to the end: the lock is never taken for released.
  assert.equal(held, true);
  assert.ok(elapsed < DELETE_PENDING_WAIT_MS + 1500, `hasLiveLockHolder waited ${Math.round(elapsed)} ms`);
});

test('#306: an ensure whose service child reclaims a dead owner\'s lock past a reader of its pid file still gets that service', { timeout: STOP_BUDGET }, async (t) => {
  const first = await launch(t);
  const api = await service();
  await api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId });
  await deadOwnedLock(path.join(first.storeDir, '.training'), 'study.lock.d');
  // The reader keeps the reclaimed pid name pending for 1.5 s (inside the child's own 2 s bound on
  // removing the lock directory); the client polls the lock through all of it.
  const holder = holdOpen(path.join(lockPath(first.storeDir), 'pid'), { pendingLingerMs: 1500 });
  await holder.held;
  // One call, made directly (r1): the launch helper would retry a failed ensure that spawned nothing.
  const children = [];
  const handle = await api.ensureStudyService(first.storeDir, {
    onChild(child) { child.ref(); children.push(registerOwnedProcess(child, 'study service')); },
  });
  t.after(() => api.stopStudyService(first.storeDir, { expectedInstanceId: handle.instanceId }).catch(() => {}));
  const closed = await holder.closed;
  t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0, closed.err);
  assert.equal(children.length, 1, 'one service child');
  assert.notEqual(handle.instanceId, first.handle.instanceId);
  assert.equal((await api.inspectStudyService(first.storeDir)).instanceId, handle.instanceId);
});

test('#306: an inspect that meets a lock whose pid file is pending deletion still fails closed', {
  skip: WIN32 ? false : 'only Windows keeps a deleted name behind its holder', timeout: STOP_BUDGET,
}, async (t) => {
  const first = await launch(t);
  const api = await service();
  await api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId });
  await deadOwnedLock(path.join(first.storeDir, '.training'), 'study.lock.d');
  const pidFile = path.join(lockPath(first.storeDir), 'pid');
  // Past the client's own bound on reading a pending lock again (twice DELETE_PENDING_WAIT_MS).
  const holder = holdOpen(pidFile, { pendingLingerMs: 2 * DELETE_PENDING_WAIT_MS + 3000 });
  await holder.held;
  fs.unlinkSync(pidFile);
  if (failureCode(() => fs.lstatSync(pidFile)) !== 'EPERM') {
    await holder.closed;
    assert.equal(DELETE_PENDING, false, 'libuv 1.46 must keep the deleted name');
    t.skip('this file system deletes names at once');
    return;
  }
  // Neither stopped nor running: an owner that cannot be read is never reported either way.
  await assert.rejects(api.inspectStudyService(first.storeDir), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  assert.equal((await holder.closed).code, 0);
  fs.rmdirSync(lockPath(first.storeDir));
});

test('#306: only a Windows EPERM read failure of a study lock is read again', async () => {
  const { isPendingReadFailure } = await service();
  const failure = (fields) => Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT'), { code: 'STUDY_DESCRIPTOR_CORRUPT', ...fields });
  assert.equal(isPendingReadFailure(failure({ fsCode: 'EPERM' }), 'win32'), true);
  assert.equal(isPendingReadFailure(failure({ fsCode: 'EPERM' }), 'linux'), false);
  assert.equal(isPendingReadFailure(failure({ fsCode: 'EBUSY' }), 'win32'), false);
  assert.equal(isPendingReadFailure(failure({}), 'win32'), false);
  assert.equal(isPendingReadFailure(Object.assign(new Error('x'), { code: 'STUDY_IDENTITY_MISMATCH', fsCode: 'EPERM' }), 'win32'), false);
});

test('#306: a batch proof that fails leaves no proved set for the next transaction of its scope', async () => {
  const { withClientAclScope, aclTransaction } = await service();
  const root = createOwnedTempDir('holdem-306-batch-proof');
  const training = path.join(root, '.training');
  fs.mkdirSync(training);
  const ctx = { root, training };
  let proofs = 0;
  let refuse = false;
  const prove = (entries, { onUnproven }) => {
    proofs += 1;
    if (!refuse) return true;
    onUnproven('error:EPERM');
    return false;
  };
  withClientAclScope(() => {
    assert.equal(aclTransaction(ctx, () => 'first', { platform: 'win32' }), 'first');
    // The listing changes, and the proof of the new one fails (a path pending deletion, say).
    fs.writeFileSync(path.join(training, 'study-service.json'), '{}');
    refuse = true;
    assert.throws(() => aclTransaction(ctx, () => 'second', { platform: 'win32' }), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EPERM' });
    refuse = false;
    const before = proofs;
    // Same listing as the failed proof saw: only a new proof may vouch for it.
    assert.equal(aclTransaction(ctx, () => 'third', { platform: 'win32' }), 'third');
    assert.ok(proofs > before, 'the transaction ran on the set proved for an older listing');
  }, { platform: 'win32', prove });
});

// #306 r1: every read-only step of a client call is read again the same way, within one bound. Here
// the descriptor name, not the lock, is pending — a stopped service's descriptor behind a reader —
// when the ensure takes its first look at the store (its context, before any lock read). The ensure
// is called directly: the launch helper would retry a failed one and hide that.
test('#306: an ensure whose first look at the store meets a descriptor name pending deletion waits it out', {
  skip: WIN32 ? false : 'only Windows keeps a deleted name behind its holder', timeout: STOP_BUDGET,
}, async (t) => {
  const first = await launch(t);
  const api = await service();
  await api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId });
  const descriptor = descriptorPath(first.storeDir);
  fs.writeFileSync(descriptor, '{}', { mode: 0o600 });
  const holder = holdOpen(descriptor, { pendingLingerMs: 1500 });
  await holder.held;
  fs.unlinkSync(descriptor);
  if (failureCode(() => fs.lstatSync(descriptor)) !== 'EPERM') {
    await holder.closed;
    assert.equal(DELETE_PENDING, false, 'libuv 1.46 must keep the deleted name');
    t.skip('this file system deletes names at once');
    return;
  }
  const handle = await api.ensureStudyService(first.storeDir, {
    onChild(child) { child.ref(); registerOwnedProcess(child, 'study service'); },
  });
  t.after(() => api.stopStudyService(first.storeDir, { expectedInstanceId: handle.instanceId }).catch(() => {}));
  const closed = await holder.closed;
  t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0, closed.err);
  assert.notEqual(handle.instanceId, first.handle.instanceId);
});

// #306 r1: the bound itself, on every platform through `platform`. Another failure, or one off
// Windows, is thrown at once. A pending read that clears is returned. One that never clears is thrown
// by the earliest of the call's deadline, the platform budget in force and PENDING_READ_WAIT_MS from
// its first failure; no read starts past that, and each read again runs inside it.
test('#306: a pending read is read again only within its bound, and never started past it', { timeout: 30_000 }, async () => {
  const { readSettled } = await service();
  const pending = () => Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT'), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EPERM' });
  const win32 = { platform: 'win32' };
  let reads = 0;
  await assert.rejects(readSettled(() => {
    reads += 1;
    throw Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT'), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EACCES' });
  }, platformNow() + 10_000, win32), { fsCode: 'EACCES' });
  assert.equal(reads, 1);
  reads = 0;
  await assert.rejects(readSettled(() => { reads += 1; throw pending(); }, platformNow() + 10_000, { platform: 'linux' }), { fsCode: 'EPERM' });
  assert.equal(reads, 1);
  reads = 0;
  assert.equal(await readSettled(() => { reads += 1; if (reads < 3) throw pending(); return 'read'; }, platformNow() + 10_000, win32), 'read');
  assert.equal(reads, 3);

  // The call's deadline.
  const starts = [];
  const budgets = [];
  const deadline = platformNow() + 300;
  await assert.rejects(readSettled(() => {
    starts.push(platformNow());
    if (starts.length > 1) budgets.push(platformTimeout(15_000));
    throw pending();
  }, deadline, win32), { fsCode: 'EPERM' });
  assert.ok(starts.length > 2, `read ${starts.length} times`);
  assert.ok(starts.every((at) => at < deadline), 'a read started past the deadline');
  assert.ok(budgets.every((ms) => ms <= 300), `a read again ran with ${Math.max(...budgets)} ms`);

  // A read again that runs out of the bound keeps the pending EPERM; any other failure is its own.
  reads = 0;
  await assert.rejects(readSettled(() => {
    reads += 1;
    if (reads === 1) throw pending();
    platformTimeout(1);
    throw Object.assign(new Error('STUDY_IDENTITY_MISMATCH'), { code: 'STUDY_IDENTITY_MISMATCH' });
  }, platformNow() + 10_000, win32), { code: 'STUDY_IDENTITY_MISMATCH' });
  let spent = 0;
  await assert.rejects(readSettled(() => {
    spent += 1;
    if (spent === 1) throw pending();
    const until = platformNow() + 400;
    while (platformNow() < until) { /* the bound runs out during this read */ }
    platformTimeout(1);
    return 'late';
  }, platformNow() + 200, win32), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EPERM' });
  // The budget's whole milliseconds run out a fraction of one before the bound (r1): the read again
  // fails as a spent budget while the clock is still short of the bound, and keeps the EPERM too.
  let at = 0.25;
  let fractional = 0;
  await assert.rejects(withPlatformDeadline(10_000, () => readSettled(() => {
    fractional += 1;
    if (fractional === 1) throw pending();
    at = 100;
    platformTimeout(1);
    return 'late';
  }, 100.5, win32), { now: () => at }), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EPERM' });
  assert.equal(fractional, 2);
  // The bound is where reads stop being started (r3): a read again started inside it that returns
  // after it is what it observed, and stands.
  at = 0.25;
  let late = 0;
  assert.equal(await withPlatformDeadline(10_000, () => readSettled(() => {
    late += 1;
    if (late === 1) throw pending();
    at = 500;
    return 'late';
  }, 100.5, win32), { now: () => at }), 'late');
  assert.equal(late, 2);

  // The platform budget in force.
  let started = platformNow();
  await assert.rejects(withPlatformDeadline(platformNow() + 300, () => readSettled(() => { throw pending(); }, platformNow() + 60_000, win32)),
    { fsCode: 'EPERM' });
  assert.ok(platformNow() - started < 1500, `waited ${Math.round(platformNow() - started)} ms past a 300 ms budget`);

  // PENDING_READ_WAIT_MS from the first failure.
  let first = null;
  started = platformNow();
  await assert.rejects(readSettled(() => {
    if (first === null) { first = platformNow(); while (platformNow() - first < 200) { /* a slow first read */ } }
    throw pending();
  }, platformNow() + 60_000, win32), { fsCode: 'EPERM' });
  const waited = platformNow() - first;
  assert.ok(waited >= 2 * DELETE_PENDING_WAIT_MS && waited < 2 * DELETE_PENDING_WAIT_MS + 1500, `waited ${Math.round(waited)} ms`);
});

// #306 r1: the trailing ACL proof of a client call lists its names once more. For a call that
// succeeded a pending name there is read again in the same bound; a call that failed keeps its own
// error and is proved once.
test('#306: the trailing proof of a call that succeeded is read again past a pending name', { timeout: 30_000 }, async () => {
  const { withClientAclScope, aclTransaction } = await service();
  const root = createOwnedTempDir('holdem-306-trailing-proof');
  const training = path.join(root, '.training');
  fs.mkdirSync(training);
  const ctx = { root, training };
  const scope = (body, failures) => {
    let trailing = false;
    let after = 0;
    const prove = (entries, { onUnproven }) => {
      if (!trailing) return true;
      after += 1;
      if (after > failures) return true;
      onUnproven('error:EPERM');
      return false;
    };
    const run = () => withClientAclScope(async () => {
      assert.equal(aclTransaction(ctx, () => 'body', { platform: 'win32' }), 'body');
      trailing = true;
      return body();
    }, { platform: 'win32', prove });
    return { run, proofs: () => after };
  };
  const cleared = scope(() => 'done', 2);
  assert.equal(await cleared.run(), 'done');
  assert.equal(cleared.proofs(), 3);

  // Within the platform budget the call runs in.
  const held = scope(() => 'done', Infinity);
  const started = platformNow();
  await assert.rejects(withPlatformDeadline(platformNow() + 300, held.run), { code: 'STUDY_DESCRIPTOR_CORRUPT', fsCode: 'EPERM' });
  assert.ok(platformNow() - started < 1500, `waited ${Math.round(platformNow() - started)} ms past a 300 ms budget`);
  assert.ok(held.proofs() > 1);

  const failed = scope(() => { throw Object.assign(new Error('mine'), { code: 'STUDY_IDENTITY_MISMATCH' }); }, Infinity);
  await assert.rejects(failed.run(), { code: 'STUDY_IDENTITY_MISMATCH' });
  assert.equal(failed.proofs(), 1);
});

// #306 r2: the EPERM a pending name answers, for the first lstat whose call stack holds every frame
// in `within` and none in `outside` — one named read-only step of a client call, in this process
// only (the service child is untouched). It stands in, deterministically, for a release that begins
// between two reads of the same call. `onFail` sees the moment it fires.
function failOnePendingRead({ within, outside = [], onFail = () => {} }) {
  const original = fs.lstatSync;
  const has = (stack, frame) => stack.includes(`at ${frame} (`) || stack.includes(`at async ${frame} (`);
  let failed = 0;
  fs.lstatSync = function lstatSync(file, ...rest) {
    if (failed === 0) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 200;
      const { stack } = new Error();
      Error.stackTraceLimit = limit;
      if (within.every((frame) => has(stack, frame)) && !outside.some((frame) => has(stack, frame))) {
        failed += 1;
        onFail(String(file));
        throw Object.assign(new Error(`EPERM: operation not permitted, lstat '${file}'`), { code: 'EPERM', syscall: 'lstat', path: String(file) });
      }
    }
    return original.call(this, file, ...rest);
  };
  return { restore() { fs.lstatSync = original; }, failed: () => failed };
}
// The reads that hold `assertContext` themselves, so a step's own check is told from them.
const READ_FRAMES = ['context', 'readContextOwnership', 'readLock', 'readDescriptor', 'readPrivate', 'validateParent'];

// #306 r2: the check right before an ensure spawns its service child (after its first read
// succeeded), and the check before a cold ensure creates the store's training directory. Each is
// failed once as pending; the one ensure call still succeeds with one child. Windows only: elsewhere
// an EPERM is never a pending name. (Without that step's readSettled, the ensure fails.)
for (const step of ['pre-spawn', 'cold-create']) {
  test(`#306: an ensure whose ${step === 'pre-spawn' ? 'check right before it spawns' : 'check before it creates a cold store'} meets a pending name reads it again`, {
    skip: WIN32 ? false : 'an EPERM is a pending name only on Windows', timeout: STOP_BUDGET,
  }, async (t) => {
    const api = await service();
    let storeDir;
    if (step === 'pre-spawn') {
      const first = await launch(t);
      await api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId });
      storeDir = first.storeDir;
    } else {
      storeDir = createOwnedTempDir('holdem-306-cold-create');
    }
    const children = [];
    let childrenAtFailure = null;
    const injected = failOnePendingRead(step === 'pre-spawn'
      ? { within: ['assertContext', 'ensureOwned'], outside: READ_FRAMES, onFail: () => { childrenAtFailure = children.length; } }
      : { within: ['assertContext', 'ensureStudyServiceWithinBudget'], outside: [...READ_FRAMES, 'ensureOwned'], onFail: () => { childrenAtFailure = children.length; } });
    let handle;
    try {
      handle = await api.ensureStudyService(storeDir, {
        onChild(child) { child.ref(); children.push(registerOwnedProcess(child, 'study service')); },
      });
    } finally { injected.restore(); }
    t.after(() => api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId }).catch(() => {}));
    assert.equal(injected.failed(), 1, 'the step met the pending name');
    assert.equal(childrenAtFailure, 0, 'it did before the spawn');
    assert.equal(children.length, 1, 'one service child');
    assert.equal((await api.inspectStudyService(storeDir)).instanceId, handle.instanceId);
  });
}
