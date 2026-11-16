import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';
import { createActionReceiptStore, createRelayRootOwner } from '../server/action-receipts.js';
import { gameEpochOf } from '../publish-contract.js';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';
import { skipOnWin32 } from './helpers/platform.js';

// #347: Windows refuses a rename onto a file another process holds open. The relay waits such a
// collision out a bounded number of times (as engine/state.js commitTmp does) and notes the retry;
// past the cap the publish is answered 500 PERSIST_FAILED exactly as before. Either way the relay —
// whose stdio the loop ignores — leaves the reason in its own game directory: closed fields only
// (stage, code, syscall, attempts, file name, time), never a path, a message or the token, and
// never anything in an HTTP response.

const TOKEN = 'persist-diagnostics-token';
const DIAGNOSTICS = 'relay-diagnostics.json';
const RETRIES = 20; // server/action-receipts.js RELAY_RENAME_RETRIES
const RETRY_MS = 25;
const D1 = 'd-1-preflop-0';
const D2 = 'd-1-preflop-1';
const view = (decisionId = D1) => ({ handNo: 1, toAct: 'user', legal: { decisionId } });
const request = (requestId = 'request-1') => ({ decisionId: D1, requestId, action: 'call' });
// What a real failure would carry and the record must never keep.
const PRIVATE_DIR = path.join(path.sep, 'Users', 'private-person', 'holdem-store');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function fixture(t) {
  const dir = createOwnedTempDir('holdem-persist-diagnostics');
  let relay;
  const start = async () => {
    relay = await startServer({ gameDir: dir, port: 0, token: TOKEN });
    registerOwnedServer(relay.server, 'persist-diagnostics');
  };
  await start();
  t.after(async () => { if (relay.server.listening) await relay.close(); });
  const call = async (endpoint, body, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${relay.port}${endpoint}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), ...init,
    });
    return { status: response.status, text: await response.text() };
  };
  const json = async (endpoint, body) => {
    const { status, text } = await call(endpoint, body);
    return { status, body: JSON.parse(text) };
  };
  const f = {
    dir, call,
    publish: (publishId, rest = {}) => json(`/api/publish?token=${TOKEN}`, { publishId, view: view(), ...rest }),
    action: (body = request()) => json(`/api/action?token=${TOKEN}`, body),
    wait: () => json(`/api/wait-action?token=${TOKEN}&expectDecisionId=${D1}&timeoutMs=10`),
    status: () => json(`/api/action-status?token=${TOKEN}`),
    receipt: () => JSON.parse(fs.readFileSync(path.join(dir, 'ui-action-receipt.json'), 'utf8')),
    snapshot: () => JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8')),
    diagnosticsText: () => fs.readFileSync(path.join(dir, DIAGNOSTICS), 'utf8'),
    entries: ({ absentOk = false } = {}) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, DIAGNOSTICS), 'utf8')).entries; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!absentOk) assert.fail('the relay left no record');
        return null;
      }
    },
    restart: async () => { if (relay.server.listening) await relay.close(); await start(); },
  };
  assert.equal((await f.publish(1)).status, 200);
  return f;
}

// A Node system error as fs would throw it, naming a private path in its message and fields.
const systemError = (code, syscall, target) => Object.assign(
  new Error(`${code}: operation not permitted, ${syscall} '${path.join(PRIVATE_DIR, target)}'`),
  { code, errno: -1, syscall, path: path.join(PRIVATE_DIR, `.${target}.tmp`), dest: path.join(PRIVATE_DIR, target) },
);

// Renames onto one of `targets` (by basename) fail until restore(): every one by default, or the
// first `times` of each target. `onFail(name, count, paths)` runs just before each refusal.
function failRenames(targets, { code = 'EPERM', syscall = 'rename', times = Infinity, onFail = () => {} } = {}) {
  const real = fs.renameSync;
  const failed = [];
  fs.renameSync = function renameSync(from, to, ...rest) {
    const name = path.basename(String(to));
    if (targets.includes(name) && failed.filter((entry) => entry === name).length < times) {
      failed.push(name);
      onFail(name, failed.filter((entry) => entry === name).length, { from: String(from), to: String(to) });
      throw systemError(code, syscall, name);
    }
    return real.call(this, from, to, ...rest);
  };
  return { failed, count: (name) => failed.filter((entry) => entry === name).length, restore: () => { fs.renameSync = real; } };
}

const withoutTime = (entries) => entries.map(({ at, ...rest }) => rest);

function assertTimes(entries, since) {
  for (const { at } of entries) {
    assert.match(at, ISO);
    assert.ok(Date.parse(at) >= since - 1000 && Date.parse(at) <= Date.now() + 1000, at);
  }
}

function assertNothingPrivate(text) {
  for (const needle of [PRIVATE_DIR, 'private-person', 'operation not permitted', TOKEN, '.tmp']) {
    assert.equal(text.includes(needle), false, `the record carries ${JSON.stringify(needle)}: ${text}`);
  }
}

test('#347 one rename collision is waited out: the publish commits and the relay notes the retry', async (t) => {
  const f = await fixture(t);
  const since = Date.now();
  const fault = failRenames(['ui-snapshot.json'], { times: 1 });
  let response;
  try { response = await f.publish(2); } finally { fault.restore(); }
  assert.equal(fault.failed.length, 1, 'the injected collision happened');
  assert.deepEqual([response.status, response.body.ok, response.body.applied], [200, true, true]);
  assert.equal(f.snapshot().publishId, 2);
  assert.equal((await f.status()).status, 200, 'no recovery is needed');
  const entries = f.entries();
  assert.deepEqual(withoutTime(entries), [{ event: 'rename-retried', target: 'ui-snapshot.json', code: 'EPERM', attempts: 2 }]);
  assertTimes(entries, since);
  assertNothingPrivate(f.diagnosticsText());
});

test('#347 the receipt and lock writers wait collisions out the same way', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.action()).status, 200);
  await f.wait();
  const receipt = f.receipt();
  const actionAck = { gameEpoch: receipt.gameEpoch, decisionId: receipt.decisionId, requestId: receipt.requestId,
    digest: receipt.digest, phase: 'rejected', reason: 'ILLEGAL_ACTION' };
  let fault = failRenames(['ui-action-receipt.json'], { code: 'EBUSY', times: 2 });
  let response;
  try { response = await f.publish(2, { actionAck }); } finally { fault.restore(); }
  assert.equal(response.status, 200);
  assert.equal(f.receipt().phase, 'rejected');
  // A relay starting over a lock another process is reading.
  fault = failRenames(['lock.json'], { code: 'EACCES', times: 1 });
  try { await f.restart(); } finally { fault.restore(); }
  assert.equal((await f.status()).status, 200);
  assert.deepEqual(withoutTime(f.entries()), [
    { event: 'rename-retried', target: 'ui-action-receipt.json', code: 'EBUSY', attempts: 3 },
    { event: 'rename-retried', target: 'lock.json', code: 'EACCES', attempts: 2 },
  ]);
});

test('#347 a collision past the cap answers PERSIST_FAILED as before and records stage, code and attempts', async (t) => {
  const f = await fixture(t);
  const since = Date.now();
  const fault = failRenames(['ui-snapshot.json']);
  let response;
  const started = performance.now();
  try { response = await f.publish(2); } finally { fault.restore(); }
  const elapsed = performance.now() - started;
  assert.equal(fault.count('ui-snapshot.json'), RETRIES + 1, 'the first rename and every retry');
  // The bounded wait: twenty sleeps (the event loop is held that long; see the PR's budget note).
  assert.ok(elapsed >= RETRIES * RETRY_MS - 50, `waited ${elapsed}ms`);
  // The answer is byte-for-byte what it was: no diagnostic in the body.
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { ok: false, code: 'PERSIST_FAILED' });
  const entries = f.entries();
  assert.deepEqual(withoutTime(entries), [{ event: 'persist-failed', stage: 'ui-commit', code: 'EPERM', syscall: 'rename', attempts: RETRIES + 1 }]);
  assertTimes(entries, since);
  assertNothingPrivate(f.diagnosticsText());
  // The relay is in recovery exactly as before, and the next publish restores it.
  assert.deepEqual((await f.status()).body, { ok: false, code: 'ACTION_RECOVERY_REQUIRED' });
  assert.equal((await f.publish(2)).status, 200);
  assert.equal(f.entries().length, 1, 'a publish without trouble records nothing');
});

test('#347 a receipt that cannot be acknowledged or retired names its own stage', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.action()).status, 200);
  await f.wait();
  const receipt = f.receipt();
  const actionAck = { gameEpoch: receipt.gameEpoch, decisionId: receipt.decisionId, requestId: receipt.requestId,
    digest: receipt.digest, phase: 'rejected', reason: 'ILLEGAL_ACTION' };
  const since = Date.now();
  let fault = failRenames(['ui-action-receipt.json'], { code: 'EBUSY' });
  let response;
  try { response = await f.publish(2, { actionAck }); } finally { fault.restore(); }
  assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
  // Recover, then fail the retirement a newer decision makes of that terminal receipt.
  assert.equal((await f.publish(2, { actionAck })).status, 200);
  assert.equal(f.receipt().phase, 'rejected');
  fault = failRenames(['ui-action-receipt.json'], { code: 'ENOSPC' });
  try { response = await f.publish(3, { view: view(D2) }); } finally { fault.restore(); }
  assert.equal(fault.failed.length, 1, 'a failure that is not a collision is not retried');
  assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
  const entries = f.entries();
  assert.deepEqual(withoutTime(entries), [
    { event: 'persist-failed', stage: 'receipt-acknowledge', code: 'EBUSY', syscall: 'rename', attempts: RETRIES + 1 },
    { event: 'persist-failed', stage: 'receipt-reconcile', code: 'ENOSPC', syscall: 'rename', attempts: 1 },
  ]);
  assertTimes(entries, since);
  assertNothingPrivate(f.diagnosticsText());
});

test('#347 a receipt read that fails before the commit keeps its cause behind the corrupt code', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.action()).status, 200);
  const since = Date.now();
  const realOpen = fs.openSync;
  fs.openSync = function openSync(file, ...rest) {
    if (path.basename(String(file)) === 'ui-action-receipt.json') throw systemError('EACCES', 'open', 'ui-action-receipt.json');
    return realOpen.call(this, file, ...rest);
  };
  let response;
  try { response = await f.publish(2, { view: view(D2) }); } finally { fs.openSync = realOpen; }
  assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
  const entries = f.entries();
  assert.deepEqual(withoutTime(entries), [{ event: 'persist-failed', stage: 'receipt-check', code: 'ACTION_RECEIPT_CORRUPT', syscall: null,
    causeCode: 'EACCES', causeSyscall: 'open' }]);
  assertTimes(entries, since);
  assertNothingPrivate(f.diagnosticsText());
});

for (const swap of ['target', 'temporary']) {
  test(`#347 every retry first re-proves the ${swap}: a replacement during the wait fails closed`, async (t) => {
    const f = await fixture(t);
    const outside = createOwnedTempDir('holdem-persist-diagnostics-outside');
    const before = fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'));
    let swapped = null;
    const fault = failRenames(['ui-snapshot.json'], { times: 1, onFail: (name, count, { from, to }) => {
      if (swap === 'target') {
        // A second link to the destination: the writer refuses any target with nlink > 1.
        swapped = path.join(outside, 'second-link');
        fs.linkSync(to, swapped);
      } else {
        // The temporary's name now holds a foreign file; the writer's fd still holds its own.
        swapped = path.join(outside, 'opened-temporary');
        fs.renameSync.call(fs, from, swapped);
        fs.writeFileSync(from, '{"foreign":true}');
      }
    } });
    let response;
    try { response = await f.publish(2); } finally { fault.restore(); }
    assert.ok(swapped, 'the replacement happened during the collision');
    assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json')), before, 'nothing was renamed onto the target');
    assert.deepEqual(withoutTime(f.entries()), [{ event: 'persist-failed', stage: 'ui-commit', code: 'UNSAFE_PATH', syscall: null }]);
    if (swap === 'target') fs.unlinkSync(swapped);
  });
}

test('#347 a root replaced during the wait is refused, and nothing is written into the replacement', async (t) => {
  // Renaming a directory with an open handle inside is EPERM on win32 (the S4 root tests skip it too).
  if (skipOnWin32(t, 'renaming a directory with an open handle is EPERM on win32')) return;
  const f = await fixture(t);
  const holder = createOwnedTempDir('holdem-persist-diagnostics-root');
  const displaced = path.join(holder, 'original');
  let moved = false;
  const fault = failRenames(['ui-snapshot.json'], { times: 1, onFail: () => {
    fs.renameSync.call(fs, f.dir, displaced);
    moved = true;
    fs.mkdirSync(f.dir);
    fs.writeFileSync(path.join(f.dir, 'sentinel'), 'foreign-root');
  } });
  let response;
  let replacement = null;
  try { response = await f.publish(2); } finally {
    fault.restore();
    // The original root comes back whatever happened above; the assertions follow.
    if (moved) {
      try { replacement = fs.readdirSync(f.dir); } catch { replacement = null; } finally {
        fs.rmSync(f.dir, { recursive: true, force: true });
        fs.renameSync(displaced, f.dir);
      }
    }
  }
  assert.ok(moved, 'the root was replaced during the collision');
  assert.deepEqual(replacement, ['sentinel'], 'no snapshot, temporary or record reached the replacement root');
  assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
});

test('#347 the cancellation ledger waits a collision out the same way', () => {
  const dir = createOwnedTempDir('holdem-persist-diagnostics-ledger');
  const store = createActionReceiptStore(dir, gameEpochOf(TOKEN), { owner: createRelayRootOwner(dir) });
  const fault = failRenames(['ui-action-cancellations.json'], { code: 'EBUSY', times: 2 });
  let proof;
  try { proof = store.cancel(request(), D1, 1); } finally { fault.restore(); }
  assert.equal(fault.failed.length, 2);
  assert.deepEqual(proof, { decisionId: D1, requestId: 'request-1' }, 'the durable proof is given after the collision');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ui-action-cancellations.json'), 'utf8')).entries[0].requestId, 'request-1');
});

test('#347 a write that fails after its retried rename reports no retry, only the failure', async (t) => {
  const f = await fixture(t);
  const fault = failRenames(['ui-snapshot.json'], { times: 1 });
  const refusing = fs.renameSync;
  const realClose = fs.closeSync;
  let renamed = false;
  let closeFailed = false;
  fs.renameSync = function renameSync(from, to, ...rest) {
    const out = refusing.call(this, from, to, ...rest);
    if (path.basename(String(to)) === 'ui-snapshot.json') renamed = true;
    return out;
  };
  // The writer closes the renamed temporary's fd next; that close fails once.
  fs.closeSync = function closeSync(fd) {
    if (renamed && !closeFailed) {
      closeFailed = true;
      throw systemError('EIO', 'close', 'ui-snapshot.json');
    }
    return realClose.call(this, fd);
  };
  let response;
  try { response = await f.publish(2); } finally { fs.closeSync = realClose; fault.restore(); }
  assert.ok(closeFailed, 'the close after the retried rename failed');
  assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
  assert.deepEqual(withoutTime(f.entries()), [{ event: 'persist-failed', stage: 'ui-commit', code: 'EIO', syscall: 'close' }]);
});

test('#347 odd thrown values change nothing in the answer or the recovery and record only closed values', async (t) => {
  const f = await fixture(t);
  const selfCause = Object.assign(new Error(PRIVATE_DIR), { code: 'EIO', syscall: 'rename' });
  selfCause.cause = selfCause;
  const loopCause = { code: 'EIO', syscall: PRIVATE_DIR };
  const mutualCause = Object.assign(new Error(PRIVATE_DIR), { code: 'EIO', syscall: 'rename', cause: loopCause });
  loopCause.cause = mutualCause;
  const throwingCode = Object.defineProperty(new Error(PRIVATE_DIR), 'code', { get() { throw new Error(PRIVATE_DIR); } });
  const frozen = Object.freeze(Object.assign(new Error(PRIVATE_DIR), { code: 'EPERM', syscall: 'rename' }));
  const cases = [
    { thrown: null, entry: { code: null, syscall: null } },
    { thrown: PRIVATE_DIR, entry: { code: null, syscall: null } },
    { thrown: 42, entry: { code: null, syscall: null } },
    // The getter's own throw replaces the rename error, still as a plain 500.
    { thrown: throwingCode, entry: { code: null, syscall: null } },
    // A collision is still waited out; a frozen error just cannot carry its attempt count.
    { thrown: frozen, entry: { code: 'EPERM', syscall: 'rename' }, renames: RETRIES + 1 },
    { thrown: selfCause, entry: { code: 'EIO', syscall: 'rename', attempts: 1 } },
    { thrown: mutualCause, entry: { code: 'EIO', syscall: 'rename', attempts: 1, causeCode: 'EIO', causeSyscall: 'OTHER' } },
  ];
  let publishId = 2;
  for (const { thrown, entry, renames = 1 } of cases) {
    const real = fs.renameSync;
    let calls = 0;
    fs.renameSync = function renameSync(from, to, ...rest) {
      if (path.basename(String(to)) === 'ui-snapshot.json') { calls += 1; throw thrown; }
      return real.call(this, from, to, ...rest);
    };
    let response;
    try { response = await f.publish(publishId); } finally { fs.renameSync = real; }
    assert.equal(calls, renames);
    assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
    assert.deepEqual((await f.status()).body, { ok: false, code: 'ACTION_RECOVERY_REQUIRED' });
    assert.equal((await f.publish(publishId)).status, 200);
    assert.deepEqual(withoutTime(f.entries()).at(-1), { event: 'persist-failed', stage: 'ui-commit', ...entry });
    publishId += 1;
  }
  assert.equal(f.entries().length, cases.length);
  assertNothingPrivate(f.diagnosticsText());
});

test('#347 an unlisted code or syscall is recorded as OTHER, an absent one as null', async (t) => {
  const f = await fixture(t);
  let fault = failRenames(['ui-snapshot.json'], { code: 'E_PRIVATE_PERSON_HOME', syscall: 'copy /Users/private-person' });
  try { assert.equal((await f.publish(2)).status, 500); } finally { fault.restore(); }
  assert.equal(fault.failed.length, 1);
  assert.equal((await f.publish(2)).status, 200);
  const real = fs.renameSync;
  fs.renameSync = function renameSync(from, to, ...rest) {
    if (path.basename(String(to)) === 'ui-snapshot.json') throw new Error(`plain failure in ${PRIVATE_DIR}`);
    return real.call(this, from, to, ...rest);
  };
  try { assert.equal((await f.publish(3)).status, 500); } finally { fs.renameSync = real; }
  assert.deepEqual(withoutTime(f.entries()), [
    { event: 'persist-failed', stage: 'ui-commit', code: 'OTHER', syscall: 'OTHER', attempts: 1 },
    { event: 'persist-failed', stage: 'ui-commit', code: null, syscall: null, attempts: 1 },
  ]);
  assertNothingPrivate(f.diagnosticsText());
});

test('#347 a record that cannot be written changes nothing in the answer or the recovery, and is never retried', async (t) => {
  const f = await fixture(t);
  // The record's own write fails too: same answer, same recovery, and no record.
  let fault = failRenames(['ui-snapshot.json', DIAGNOSTICS]);
  let response;
  try { response = await f.publish(2); } finally { fault.restore(); }
  assert.equal(fault.count(DIAGNOSTICS), 1, 'the record was attempted once and not retried');
  assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
  assert.equal(f.entries({ absentOk: true }), null);
  assert.equal(fs.readdirSync(f.dir).some((name) => name.includes(DIAGNOSTICS)), false, 'no temporary of the record is left behind');
  assert.deepEqual((await f.status()).body, { ok: false, code: 'ACTION_RECOVERY_REQUIRED' });
  assert.equal((await f.publish(2)).status, 200);
  // A collision on the record itself, while it notes another file's retry, is neither retried
  // nor noted: it cannot recurse.
  fault = failRenames(['ui-snapshot.json', DIAGNOSTICS], { times: 1 });
  try { response = await f.publish(3); } finally { fault.restore(); }
  assert.deepEqual(fault.failed, ['ui-snapshot.json', DIAGNOSTICS]);
  assert.equal(response.status, 200);
  assert.equal(f.entries({ absentOk: true }), null);
  // A record the relay cannot even read is replaced, never a reason to fail.
  fs.writeFileSync(path.join(f.dir, DIAGNOSTICS), '{not json');
  fault = failRenames(['ui-snapshot.json'], { code: 'EIO' });
  try { response = await f.publish(4); } finally { fault.restore(); }
  assert.deepEqual([response.status, response.body], [500, { ok: false, code: 'PERSIST_FAILED' }]);
  assert.equal(f.entries().length, 1);
});

test('#347 the record is bounded, survives a relay restart and drops entries it did not write', async (t) => {
  const f = await fixture(t);
  // Planted entries with free text or values outside the closed lists are not carried forward.
  fs.writeFileSync(path.join(f.dir, DIAGNOSTICS), JSON.stringify({ schemaVersion: 1, entries: [
    { event: 'persist-failed', stage: 'ui-commit', code: 'EPERM', syscall: 'rename', at: '2026-11-16T00:00:00.000Z', path: PRIVATE_DIR },
    { event: 'persist-failed', stage: PRIVATE_DIR, code: 'EPERM', syscall: 'rename', at: '2026-11-16T00:00:00.000Z' },
    { event: 'rename-retried', target: PRIVATE_DIR, code: 'EPERM', attempts: 2, at: '2026-11-16T00:00:00.000Z' },
    { event: 'rename-retried', target: 'ui-snapshot.json', code: 'EPERM', attempts: 99, at: '2026-11-16T00:00:00.000Z' },
    { event: ['persist-failed'], stage: 'ui-commit', code: 'EPERM', syscall: 'rename', at: '2026-11-16T00:00:00.000Z' },
    { event: 'persist-failed', stage: 'ui-commit', code: 'EPERM', syscall: 'rename', at: '2026-11-16T00:00:00.000Z' },
  ] }));
  let publishId = 2;
  const fail = async () => {
    // A failure that is not a collision, so it is not retried and the test stays quick.
    const fault = failRenames(['ui-snapshot.json'], { code: 'EIO' });
    try { assert.equal((await f.publish(publishId)).status, 500); } finally { fault.restore(); }
    assert.equal((await f.publish(publishId)).status, 200);
    publishId += 1;
  };
  await fail();
  assert.equal(f.entries().length, 2, 'the one valid planted entry and the new one');
  assertNothingPrivate(f.diagnosticsText());
  await f.restart();
  await fail();
  assert.equal(f.entries().length, 3, 'a restarted relay keeps what the one before it recorded');
  for (let i = 0; i < 40; i += 1) await fail();
  assert.equal(f.entries().length, 32, 'only the newest entries are kept');
  assert.ok(Buffer.byteLength(f.diagnosticsText()) <= 16 * 1024);
  assert.equal(f.entries().some((entry) => entry.at === '2026-11-16T00:00:00.000Z'), false, 'the oldest left first');
});

test('#347 no relay response carries the record, and nothing but the relay names its file', async (t) => {
  const f = await fixture(t);
  let fault = failRenames(['ui-snapshot.json'], { times: 1 });
  try { assert.equal((await f.publish(2)).status, 200); } finally { fault.restore(); }
  fault = failRenames(['ui-snapshot.json'], { code: 'EIO' });
  try { assert.equal((await f.publish(3)).status, 500); } finally { fault.restore(); }
  assert.deepEqual(f.entries().map((entry) => entry.event), ['rename-retried', 'persist-failed']);
  const marks = ['persist-failed', 'rename-retried', 'ui-commit', DIAGNOSTICS, 'syscall', 'attempts'];
  const probes = [
    await f.call('/api/health'),
    await f.call(`/api/health?token=${TOKEN}`),
    await f.call(`/api/snapshot?token=${TOKEN}`),
    await f.call(`/api/snapshot?token=${TOKEN}`, undefined, { headers: { 'x-loop-probe': '1' } }),
    await f.call(`/api/action-status?token=${TOKEN}`),
    await f.call(`/${DIAGNOSTICS}`),
    await f.call(`/../${DIAGNOSTICS}`),
  ];
  assert.equal((await f.publish(3)).status, 200);
  probes.push(await f.call(`/api/snapshot?token=${TOKEN}`), await f.call(`/api/action-status?token=${TOKEN}`));
  for (const probe of probes) {
    for (const mark of marks) assert.equal(probe.text.includes(mark), false, `a response carries ${mark}: ${probe.text.slice(0, 200)}`);
  }
  // No route of the relay, the app server (host, remote host, participants, spectators) or the
  // study service can serve a file whose name it never mentions: only its recorder and the relay
  // writer's closed list of destinations name it.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:m?js|cjs|html)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes(DIAGNOSTICS)) {
        offenders.push(path.relative(repo, full).split(path.sep).join('/'));
      }
    }
  };
  for (const top of ['server', 'tools', 'shared', 'engine', 'training']) walk(path.join(repo, top));
  for (const file of fs.readdirSync(repo)) if (/\.m?js$/.test(file) && fs.readFileSync(path.join(repo, file), 'utf8').includes(DIAGNOSTICS)) offenders.push(file);
  assert.deepEqual(offenders.sort(), ['server/action-receipts.js', 'server/relay-diagnostics.js']);
});
