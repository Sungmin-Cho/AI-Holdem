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
import { descriptorPath, lockPath, launch, service } from './helpers/study-service-fixtures.mjs';
import { acquireOwnedLock, releaseOwnedLock, readOwnedLock } from '../engine/state.js';

const [UV_MAJOR, UV_MINOR] = process.versions.uv.split('.').map(Number);
// libuv 1.49.0 added POSIX delete semantics on Windows (ChangeLog: "win,fs: use posix
// delete semantics, if supported"). Before it, a deleted name outlives other handles.
const DELETE_PENDING = process.platform === 'win32' && (UV_MAJOR < 1 || (UV_MAJOR === 1 && UV_MINOR < 49));
const STOP_BUDGET = studyBudget({ coldStarts: 1, warmCalls: 3, extraMs: 30_000 });

// A second process that opens `file` (libuv shares delete, like every reader here) and keeps it
// open until it sees the name deleted — EPERM while delete-pending, ENOENT where the name went
// at once — and for `lingerMs` after that, then closes it and exits.
const HOLDER = `
const fs = require('node:fs');
const file = process.argv[1], lingerMs = Number(process.argv[2]), maxMs = Number(process.argv[3]);
const fd = fs.openSync(file, 'r');
process.stdout.write('held\\n');
const started = Date.now();
const poll = setInterval(() => {
  let seen = null;
  try { fs.lstatSync(file); } catch (error) { seen = error.code; }
  if (seen === null && Date.now() - started < maxMs) return;
  clearInterval(poll);
  process.stdout.write('seen ' + (seen ?? 'present') + '\\n');
  setTimeout(() => { fs.closeSync(fd); process.stdout.write('closed\\n'); process.exit(0); }, lingerMs);
}, 5);`;

function holdOpen(file, { lingerMs = 300, maxMs = 120_000 } = {}) {
  const child = registerOwnedProcess(spawn(process.execPath, ['-e', HOLDER, file, String(lingerMs), String(maxMs)],
    { stdio: ['ignore', 'pipe', 'pipe'] }), 'delete-pending holder');
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (out.includes('held\n')) resolve(); });
    closed.then(({ code }) => reject(new Error(`holder exited ${code} before holding: ${err}`)));
  });
  return { held, closed };
}

const failureCode = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };

test('#265 A premise: a name deleted while another process holds it stays delete-pending only before libuv 1.49 on Windows', async (t) => {
  const root = createOwnedTempDir('holdem-delete-pending');
  const dir = path.join(root, 'held'), file = path.join(dir, 'pid');
  fs.mkdirSync(dir); fs.writeFileSync(file, 'x');
  const holder = holdOpen(file, { lingerMs: 200 });
  await holder.held;
  fs.unlinkSync(file);
  const lstatAfterUnlink = failureCode(() => fs.lstatSync(file));
  const rmdirAfterUnlink = failureCode(() => fs.rmdirSync(dir));
  const closed = await holder.closed;
  t.diagnostic(`platform=${process.platform} uv=${process.versions.uv} lstat=${lstatAfterUnlink} rmdir=${rmdirAfterUnlink ?? 'ok'} holder=${closed.out.trim().replace(/\n/g, ' | ')}`);
  assert.equal(closed.code, 0);
  if (DELETE_PENDING) {
    assert.equal(lstatAfterUnlink, 'EPERM');
    assert.equal(rmdirAfterUnlink, 'ENOTEMPTY');
    assert.equal(failureCode(() => fs.lstatSync(file)), 'ENOENT', 'the name goes when the last handle closes');
    fs.rmdirSync(dir);
  } else {
    assert.equal(lstatAfterUnlink, 'ENOENT');
    assert.equal(rmdirAfterUnlink, null);
  }
});

test('#265 A: releaseOwnedLock removes its directory although another process held the pid file across the release', async () => {
  const root = createOwnedTempDir('holdem-release-held');
  const handle = acquireOwnedLock(root, 'held.lock.d');
  const holder = holdOpen(path.join(handle.dir, 'pid'), { lingerMs: 300 });
  await holder.held;
  releaseOwnedLock(handle);
  assert.equal((await holder.closed).code, 0);
  // Judged after the holder closed: a directory still here now is the empty leftover that
  // every later reader takes as an unknown owner (LOOP_LOCK_UNKNOWN for the loop lock).
  assert.equal(fs.existsSync(handle.dir), false, 'the released lock directory remains');
  assert.equal(readOwnedLock(root, 'held.lock.d'), null);
  releaseOwnedLock(acquireOwnedLock(root, 'held.lock.d'));
});

test('#265 A: a release waits a bounded time for a held pid file and then leaves the lock fail-closed', {
  skip: DELETE_PENDING ? false : 'only a delete-pending platform keeps a deleted name behind its holder',
}, async () => {
  const root = createOwnedTempDir('holdem-release-bound');
  const handle = acquireOwnedLock(root, 'held.lock.d');
  const holder = holdOpen(path.join(handle.dir, 'pid'), { lingerMs: 6000 });
  await holder.held;
  const started = performance.now();
  releaseOwnedLock(handle);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 4000, `release waited ${Math.round(elapsed)} ms for a holder that outlives its bound`);
  assert.equal(fs.existsSync(handle.dir), true);
  assert.equal(readOwnedLock(root, 'held.lock.d')?.status, 'unknown');
  assert.equal((await holder.closed).code, 0);
  // The empty leftover is an unknown owner, never reclaimed by age; only this test removes it.
  assert.deepEqual(fs.readdirSync(handle.dir), []);
  assert.equal(readOwnedLock(root, 'held.lock.d')?.status, 'unknown');
  assert.throws(() => acquireOwnedLock(root, 'held.lock.d'), { code: 'LOCKED' });
  fs.rmdirSync(handle.dir);
});

test('#265 A: a release never waits on, or removes, an entry that is not its own pid file', async () => {
  const root = createOwnedTempDir('holdem-release-foreign');
  const handle = acquireOwnedLock(root, 'held.lock.d');
  fs.writeFileSync(path.join(handle.dir, 'foreign'), 'x');
  const holder = holdOpen(path.join(handle.dir, 'pid'), { lingerMs: 1500 });
  await holder.held;
  const started = performance.now();
  releaseOwnedLock(handle);
  const elapsed = performance.now() - started;
  assert.equal((await holder.closed).code, 0);
  assert.ok(elapsed < 1000, `release waited ${Math.round(elapsed)} ms beside a foreign entry`);
  assert.deepEqual(fs.readdirSync(handle.dir), ['foreign']);
});

for (const [label, held] of [['descriptor', (storeDir) => descriptorPath(storeDir)], ['lock pid file', (storeDir) => path.join(lockPath(storeDir), 'pid')]]) {
  test(`#265 A: a study stop finishes and leaves no lock or descriptor when another process holds the ${label} across its removal`, { timeout: STOP_BUDGET }, async (t) => {
    const { storeDir, handle, api } = await launch(t);
    const holder = holdOpen(held(storeDir), { lingerMs: 300 });
    await holder.held;
    const result = await api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId });
    const closed = await holder.closed;
    t.diagnostic(`holder ${closed.out.trim().replace(/\n/g, ' | ')}`);
    assert.deepEqual(result, { stopped: true, alreadyStopped: false });
    // The stop result alone would also accept a dead lock left behind; the service's own
    // cleanup is what removes both.
    assert.equal(fs.existsSync(descriptorPath(storeDir)), false, 'descriptor left behind');
    assert.equal(fs.existsSync(lockPath(storeDir)), false, 'study lock left behind');
  });
}

// A lock whose owner died: acquired by a child that exits without releasing it.
async function deadStudyLock(storeDir) {
  const href = new URL('../engine/state.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireOwnedLock } from ${JSON.stringify(href)}; acquireOwnedLock(process.argv[1], 'study.lock.d');`,
    path.join(storeDir, '.training')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, err);
  assert.equal(readOwnedLock(path.join(storeDir, '.training'), 'study.lock.d')?.status, 'dead');
}

test('#265 A: a dead owner that left only its lock is stopped for inspect and stop, and a later ensure replaces it', { timeout: STOP_BUDGET }, async (t) => {
  const first = await launch(t);
  const api = await service();
  await api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId });
  assert.equal(fs.existsSync(lockPath(first.storeDir)), false);
  await deadStudyLock(first.storeDir);
  assert.equal(fs.existsSync(descriptorPath(first.storeDir)), false);
  assert.deepEqual(await api.inspectStudyService(first.storeDir), { status: 'stopped' });
  assert.deepEqual(await api.stopStudyService(first.storeDir, { expectedInstanceId: randomUUID() }), { stopped: true, alreadyStopped: true });
  const second = await launch(t, {}, first.storeDir);
  assert.notEqual(second.handle.instanceId, first.handle.instanceId);
  assert.equal((await api.inspectStudyService(first.storeDir)).instanceId, second.handle.instanceId);
});

test('#265 A: a lock directory without a readable owner still fails closed for inspect and stop', { timeout: STOP_BUDGET }, async (t) => {
  const { storeDir, handle, api } = await launch(t);
  await api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId });
  fs.mkdirSync(lockPath(storeDir));
  t.after(() => fs.rmSync(lockPath(storeDir), { recursive: true, force: true }));
  await assert.rejects(api.inspectStudyService(storeDir), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  await assert.rejects(api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
});
