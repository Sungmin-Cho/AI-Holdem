import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspect } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createRelayAccess, RelayDenied, RELAY_DENY_REASONS } from '../tools/relay-access.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import {
  makeSession, makeState, accessDeps, OWNED_START, OTHER_START, SESSION_TOKEN, deferred,
} from './helpers/relay-proxy-fixture.js';

function rig(patch = {}, lockPatch = {}) {
  const root = createOwnedTempDir('relay-access');
  const session = makeSession(root, 45999, { lock: lockPatch });
  const state = makeState(session, patch);
  const calls = { listener: 0, startTime: 0 };
  const access = createRelayAccess(accessDeps(session, state, calls));
  const sent = [];
  const send = (granted) => { sent.push(granted); return 'sent'; };
  const request = (extra = {}) => ({ gameEpoch: session.gameEpoch, revalidate: () => {}, ...extra });
  return { session, state, calls, access, sent, send, request };
}
const denial = (promise) => promise.then(() => null, (error) => error);
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

function assertDenied(error, reason, r) {
  assert.ok(error instanceof RelayDenied, `expected RelayDenied, got ${error?.stack ?? error}`);
  assert.equal(error.reason, reason);
  assert.equal(error.code, reason === 'STALE' ? 'STALE_GAME' : 'RELAY_UNAVAILABLE');
  assert.ok(RELAY_DENY_REASONS.includes(error.reason));
  assert.equal(r.sent.length, 0, 'send must not run for a denied request');
}

test('a verified relay is granted exactly once per use, with fresh OS evidence each time', async () => {
  const r = rig();
  assert.equal(await r.access.capture().use(r.request(), r.send), 'sent');
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].port, 45999);
  assert.equal(r.sent[0].sessionToken, SESSION_TOKEN);
  assert.ok(Object.isFrozen(r.sent[0]));
  assert.deepEqual([r.calls.listener, r.calls.startTime], [1, 1]);
  const capability = r.access.capture();
  await capability.use(r.request(), r.send);
  await capability.use(r.request(), r.send);
  // Three uses in total (one on the first capability, two on the second): one OS proof each.
  assert.equal(r.sent.length, 3);
  assert.deepEqual([r.calls.listener, r.calls.startTime], [3, 3], 'no success is cached, even on one capability');
});

// An adopted (pre-#215) relay lock carries no serverStartTime.
const dropLockStamp = (r) => {
  const lock = r.session.readLock();
  delete lock.serverStartTime;
  fs.writeFileSync(r.session.lockPath, JSON.stringify(lock));
};

test('an adopted relay whose lock has no serverStartTime is authorized by the verified binding', async () => {
  const r = rig();
  dropLockStamp(r);
  assert.equal(await r.access.capture().use(r.request(), r.send), 'sent');
  assert.equal(r.sent.length, 1);
});

test('an adopted relay whose lock has no serverStartTime is refused when the binding stamp is not owned', async () => {
  // A fresh rig: the positive half above must not leave a prior send behind this denial.
  const r = rig();
  dropLockStamp(r);
  r.state.binding = { ...r.state.binding, startTime: 'Thu Jan  1 00:00:00 2026' };
  assertDenied(await denial(r.access.capture().use(r.request(), r.send)), 'BAD_BINDING', r);
  assert.deepEqual([r.calls.listener, r.calls.startTime], [0, 0]);
});

const DENIALS = [
  ['stopping', (r) => { r.state.stopping = true; }, 'STOPPING'],
  ['no binding', (r) => { r.state.binding = null; }, 'NO_BINDING'],
  ['binding with a raw start time', (r) => { r.state.binding = { ...r.state.binding, startTime: 'Thu Jan  1 00:00:00 2026' }; }, 'BAD_BINDING'],
  ['binding with a bad port', (r) => { r.state.binding = { ...r.state.binding, port: 0 }; }, 'BAD_BINDING'],
  ['lock missing', (r) => { fs.rmSync(r.session.lockPath); }, 'LOCK_MISSING'],
  ['lock not json', (r) => { fs.writeFileSync(r.session.lockPath, '{'); }, 'LOCK_BAD'],
  ['lock is a directory', (r) => { fs.rmSync(r.session.lockPath); fs.mkdirSync(r.session.lockPath); }, 'LOCK_BAD'],
  ['lock larger than the bound', (r) => r.session.rewriteLock({ pad: 'x'.repeat(64 * 1024) }), 'LOCK_BAD'],
  // Unsafe physical identities, POSIX only (symlink/FIFO/hard-link creation is privileged or
  // absent on the Windows runner). None may park the request in open(2) or follow the link.
  ...(process.platform === 'win32' ? [] : [
    ['lock is a symlink to a valid lock', (r) => {
      fs.renameSync(r.session.lockPath, `${r.session.lockPath}.real`);
      fs.symlinkSync(`${r.session.lockPath}.real`, r.session.lockPath);
    }, 'LOCK_BAD'],
    ['lock has a second hard link', (r) => fs.linkSync(r.session.lockPath, `${r.session.lockPath}.alias`), 'LOCK_BAD'],
    ['lock is a FIFO with no writer', (r) => {
      fs.rmSync(r.session.lockPath);
      const made = spawnSync('mkfifo', [r.session.lockPath]);
      assert.equal(made.status, 0, 'mkfifo must create the FIFO');
    }, 'LOCK_BAD'],
  ]),
  ['lock pid differs', (r) => r.session.rewriteLock({ serverPid: process.pid + 1 }), 'LOCK_BINDING_MISMATCH'],
  ['lock port differs', (r) => r.session.rewriteLock({ port: 45998 }), 'LOCK_BINDING_MISMATCH'],
  ['lock token differs', (r) => r.session.rewriteLock({ sessionToken: 'c'.repeat(64) }), 'LOCK_BINDING_MISMATCH'],
  ['lock protocol differs', (r) => r.session.rewriteLock({ controlProtocolVersion: 2 }), 'LOCK_BINDING_MISMATCH'],
  ['lock protocol missing', (r) => r.session.rewriteLock({ controlProtocolVersion: undefined }), 'LOCK_BINDING_MISMATCH'],
  ['lock stamp differs', (r) => r.session.rewriteLock({ serverStartTime: OTHER_START }), 'LOCK_BINDING_MISMATCH'],
  ['lock stamp is a legacy raw stamp', (r) => r.session.rewriteLock({ serverStartTime: 'Thu Jan  1 00:00:00 2026' }), 'LOCK_BINDING_MISMATCH'],
  ['engine token differs', (r) => r.session.rewriteState({ sessionToken: 'd'.repeat(64) }), 'CHANGED'],
  ['state.json missing', (r) => fs.rmSync(r.session.statePath), 'CHANGED'],
];

for (const [name, mutate, reason] of DENIALS) {
  test(`denied before any OS probe: ${name}`, async () => {
    const r = rig();
    mutate(r);
    assertDenied(await denial(r.access.capture().use(r.request(), r.send)), reason, r);
    assert.deepEqual([r.calls.listener, r.calls.startTime], [0, 0]);
  });
}

test('a request epoch that is not the engine epoch is stale before any OS probe', async () => {
  const r = rig();
  assertDenied(await denial(r.access.capture().use(r.request({ gameEpoch: '0'.repeat(64) }), r.send)), 'STALE', r);
  assert.deepEqual([r.calls.listener, r.calls.startTime], [0, 0]);
});

test('a capture that already failed stays denied even when the world recovers', async () => {
  const r = rig();
  const binding = r.state.binding;
  r.state.binding = null;
  const capability = r.access.capture();
  r.state.binding = binding;
  assertDenied(await denial(capability.use(r.request(), r.send)), 'NO_BINDING', r);
});

const OS_DENIALS = [
  ['listener is not the pid', { listener: async () => false }, 'LISTENER_MISMATCH', 1],
  ['listener check throws', { listener: async () => { throw new Error('lsof failed'); } }, 'LISTENER_UNKNOWN', 1],
  ['listener check resolves nothing usable', { listener: async () => undefined }, 'LISTENER_MISMATCH', 1],
  ['start time unreadable', { startTimeOf: () => null }, 'IDENTITY_UNKNOWN', 1],
  ['start time is another process', { startTimeOf: () => OTHER_START }, 'IDENTITY_UNKNOWN', 1],
  ['start time reader throws', { startTimeOf: () => { throw new Error('ps failed'); } }, 'IDENTITY_UNKNOWN', 1],
];
for (const [name, patch, reason, listenerCalls] of OS_DENIALS) {
  test(`denied by OS evidence: ${name}`, async () => {
    const r = rig(patch);
    assertDenied(await denial(r.access.capture().use(r.request(), r.send)), reason, r);
    assert.equal(r.calls.listener, listenerCalls);
  });
}

test('a dead pid is never authorized, even when the listener seam answers yes', async () => {
  const pid = deadPid();
  const r = rig();
  r.state.binding = { ...r.state.binding, pid };
  r.session.rewriteLock({ serverPid: pid });
  assertDenied(await denial(r.access.capture().use(r.request(), r.send)), 'IDENTITY_UNKNOWN', r);
});

test('a rejected identity is not remembered: the next request is judged on its own evidence', async () => {
  const r = rig();
  const lockBefore = fs.readFileSync(r.session.lockPath, 'utf8');
  const binding = r.state.binding;
  r.state.startTimeOf = () => OTHER_START;
  assertDenied(await denial(r.access.capture().use(r.request(), r.send)), 'IDENTITY_UNKNOWN', r);
  assert.equal(r.state.binding, binding, 'a denial must not clear or replace the loop binding');
  assert.equal(fs.readFileSync(r.session.lockPath, 'utf8'), lockBefore, 'a denial must not touch the lock');
  r.state.startTimeOf = () => OWNED_START;
  assert.equal(await r.access.capture().use(r.request(), r.send), 'sent');
});

test('replacement between capture and use is refused (the body-wait window)', async () => {
  const cases = [
    ['same-valued binding object (ABA)', (r) => { r.state.binding = { ...r.state.binding }; }],
    ['lock replaced by an identical-looking file', (r) => r.session.rewriteLock({})],
    ['lock rewritten', (r) => r.session.rewriteLock({ startedAt: 'later' })],
    ['stopping', (r) => { r.state.stopping = true; }],
  ];
  for (const [name, change] of cases) {
    const r = rig();
    const capability = r.access.capture();
    change(r);
    const error = await denial(capability.use(r.request(), r.send));
    assert.ok(error instanceof RelayDenied, name);
    assert.equal(r.sent.length, 0, name);
    assert.deepEqual([r.calls.listener, r.calls.startTime], [0, 0], `${name}: no OS probe for a changed world`);
  }
  const r = rig();
  const capability = r.access.capture();
  r.session.rewriteState({ sessionToken: 'e'.repeat(64) });
  assertDenied(await denial(capability.use(r.request(), r.send)), 'CHANGED', r);
});

test('replacement during the asynchronous OS check is refused', async () => {
  const cases = [
    ['same-valued binding object (ABA)', (r) => { r.state.binding = { ...r.state.binding }; }, null],
    ['lock replaced', (r) => r.session.rewriteLock({}), null],
    ['engine token replaced', (r) => r.session.rewriteState({ sessionToken: 'f'.repeat(64) }), null],
    ['stopping', (r) => { r.state.stopping = true; }, null],
    ['binding cleared', (r) => { r.state.binding = null; }, null],
    ['app revalidation fails', () => {}, true],
  ];
  for (const [name, change, flip] of cases) {
    const entered = deferred();
    const gate = deferred();
    let revoked = false;
    const r = rig({ listener: async () => { entered.resolve(); await gate.promise; return true; } });
    const pending = denial(r.access.capture().use(r.request({
      revalidate: () => { if (revoked) throw new RelayDenied('STALE_GAME', 'STALE'); },
    }), r.send));
    await entered.promise;
    if (flip) revoked = true; else change(r);
    gate.resolve();
    const error = await pending;
    assert.ok(error instanceof RelayDenied, name);
    assert.equal(r.sent.length, 0, name);
  }
});

test('the app revalidation runs before the OS probe and again before the send', async () => {
  const r = rig();
  const order = [];
  r.state.listener = async () => { order.push('listener'); return true; };
  r.state.startTimeOf = () => { order.push('identity'); return OWNED_START; };
  await r.access.capture().use(r.request({ revalidate: () => order.push('revalidate') }), (granted) => { order.push('send'); return granted; });
  assert.deepEqual(order, ['revalidate', 'listener', 'identity', 'revalidate', 'send']);
});

test('send runs in the same synchronous step as the last identity read', async () => {
  const marks = [];
  const r = rig({ startTimeOf: () => { queueMicrotask(() => marks.push('microtask')); return OWNED_START; } });
  await r.access.capture().use(r.request(), (granted) => { marks.push('send'); return granted; });
  assert.deepEqual(marks.slice(0, 2), ['send', 'microtask'], 'an await between the last check and send would reorder these');
});

test('concurrent verifications are bounded and the slot is always returned', async () => {
  const entered = deferred();
  const gate = deferred();
  const r = rig({ maxConcurrent: 1, listener: async () => { entered.resolve(); await gate.promise; return true; } });
  const first = r.access.capture().use(r.request(), r.send);
  await entered.promise;
  assertDenied(await denial(r.access.capture().use(r.request(), r.send)), 'BUSY', r);
  assert.equal(r.calls.listener, 1, 'a refused request spawns no OS probe');
  gate.resolve();
  assert.equal(await first, 'sent');
  r.state.listener = async () => { throw new Error('boom'); };
  assertDenied(await denial(r.access.capture().use(r.request(), (g) => g)), 'LISTENER_UNKNOWN', { sent: [] });
  r.state.listener = async () => true;
  assert.equal(await r.access.capture().use(r.request(), r.send), 'sent', 'a throwing probe returned its slot');
});

test('stillBound follows the verified binding and the stopping flag with memory reads only', async () => {
  const r = rig();
  const granted = await r.access.capture().use(r.request(), (g) => g);
  assert.equal(granted.stillBound(), true);
  const before = [r.calls.listener, r.calls.startTime];
  r.state.binding = { ...r.state.binding };
  assert.equal(granted.stillBound(), false);
  assert.deepEqual([r.calls.listener, r.calls.startTime], before);
  const again = await r.access.capture().use(r.request(), (g) => g);
  r.state.stopping = true;
  assert.equal(again.stillBound(), false);
});

test('no denial, capability or error carries the session token, pid, port or start time', async () => {
  const r = rig();
  const capability = r.access.capture();
  const errors = [];
  for (const [, mutate] of DENIALS) {
    const fresh = rig();
    mutate(fresh);
    errors.push(await denial(fresh.access.capture().use(fresh.request(), fresh.send)));
  }
  const probes = [
    inspect(capability, { depth: 5 }), JSON.stringify(capability),
    ...errors.flatMap((error) => [error.message, error.stack, JSON.stringify(error), inspect(error, { depth: 5 })]),
  ];
  for (const text of probes) {
    for (const secret of [SESSION_TOKEN, OWNED_START, '45999']) {
      assert.equal(String(text).includes(secret), false, `leaked ${secret.slice(0, 6)}`);
    }
  }
  assert.deepEqual(Object.keys(capability), ['use']);
});
