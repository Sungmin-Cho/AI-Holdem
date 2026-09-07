import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnedLockIdentity } from '../engine/state.js';
import { createListenerOwnedBy } from '../tools/listener-ownership.js';

test('Windows owned lock preserves submillisecond start precision and rejects legacy or invalid calendar dates', () => {
  const stamp = '2026-09-07T01:02:03.1234567Z';
  assert.deepEqual(parseOwnedLockIdentity(`42\nwin32-v1\n${stamp}`), { pid: 42, startTime: `win32-v1:${stamp}` });
  for (const bytes of [`42\n${stamp}`, `42\nwin32-v1\n2026-02-30T01:02:03.1234567Z`, `42\nwin32-v1\n${stamp}\n`]) {
    assert.equal(parseOwnedLockIdentity(bytes), null);
  }
});

test('Windows listener factory tracks asynchronous probe children', async () => {
  const events = [];
  const child = { pid: 123 };
  const adapter = createListenerOwnedBy({ platform: 'win32', onChild: (event, proc) => events.push([event, proc]),
    execFileFn: (exe, args, options, callback) => {
      queueMicrotask(() => callback(null, JSON.stringify({ OwningProcess: 42, LocalAddress: '127.0.0.1', LocalPort: 12345, State: 'Listen' }), ''));
      return child;
    },
    spawn: () => ({ status: 0, stdout: JSON.stringify({ OwningProcess: 42, LocalAddress: '127.0.0.1', LocalPort: 12345, State: 'Listen' }) }),
  });
  assert.equal(await adapter(42, 12345), true);
  assert.deepEqual(events, [['open', child], ['close', child]]);
});

test('private path helper refuses permissive Windows ACL and never treats mode bits as privacy', async () => {
  const mod = await import('../shared/platform-files.js').catch(() => ({}));
  assert.equal(typeof mod.isPrivatePath, 'function');
  assert.equal(mod.isPrivatePath('/fixture', { platform: 'win32', spawn: () => ({ status: 1, stdout: '' }) }), false);
});

test('atomic state write never copy-overwrites after Windows sharing violation', async () => {
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { writeJsonAtomic } = await import('../engine/state.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-atomic-'));
  const file = path.join(root, 'state.json'); fs.writeFileSync(file, 'original');
  const originalRename = fs.renameSync; const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    fs.renameSync = () => { throw Object.assign(new Error('sharing'), { code: 'EPERM' }); };
    assert.throws(() => writeJsonAtomic(file, { changed: true }), { code: 'EPERM' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  } finally { fs.renameSync = originalRename; Object.defineProperty(process, 'platform', platform); fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual platform fresh private store owns, reuses and stops study service', { timeout: process.platform === 'win32' ? 600000 : 30000 }, async () => {
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { randomUUID } = await import('node:crypto');
  const { createPrivateDirectory, isPrivatePath } = await import('../shared/platform-files.js');
  const { acquireOwnedLock, releaseOwnedLock, ownedIdentityStatus } = await import('../engine/state.js');
  const { ensureStudyService, inspectStudyService, stopStudyService } = await import('../tools/study-service.js');
  const cp = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = path.join(os.tmpdir(), `platform-study-${randomUUID()}`);
  createPrivateDirectory(root);
  // The detached service child runs on 'ignore' stdio, so a cold start that dies
  // is indistinguishable from one that is merely slow: the client only ever
  // reports its own expired budget. Pipe that one child so its own account of
  // the failure reaches this assertion instead of a bare timeout code.
  let childOutput = '';
  const originalSpawn = cp.spawn;
  cp.spawn = (command, args, options) => {
    if (!Array.isArray(args) || args[1] !== '--serve') return originalSpawn(command, args, options);
    const child = originalSpawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { childOutput += chunk; });
      stream.on('error', () => {});
      stream.unref();
    }
    child.on('exit', (code, signal) => { childOutput += `[study child exit code=${code} signal=${signal}]\n`; });
    return child;
  };
  syncBuiltinESMExports();
  let owner, service;
  try {
    assert.equal(isPrivatePath(root), true);
    owner = acquireOwnedLock(root, 'loop.lock.d');
    const options = { parentIdentity: { pid: owner.pid, startTime: owner.startTime } };
    service = await ensureStudyService(root, options);
    assert.equal(isPrivatePath(path.join(root, '.training')), true);
    assert.equal(isPrivatePath(path.join(root, '.training', 'study-service.json')), true);
    assert.equal(ownedIdentityStatus(service.pid, service.startTime), 'alive');
    const again = await ensureStudyService(root, options);
    assert.equal(again.instanceId, service.instanceId);
    assert.equal(again.studyUrl, service.studyUrl);
    assert.equal((await inspectStudyService(root)).instanceId, service.instanceId);
    assert.equal((await stopStudyService(root, { expectedInstanceId: service.instanceId })).stopped, true);
    assert.equal(ownedIdentityStatus(service.pid, service.startTime), 'dead');
    service = null;
  } catch (error) {
    // A child that died moments before this throw has not had its exit or its
    // last stderr delivered yet. Give the loop a turn so the account is complete.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    // An AssertionError computes its message through a getter, so assigning to
    // it throws and hides the very failure this is here to explain. Carry the
    // account on a new error and keep the original as its cause.
    const account = childOutput || '(the child produced no output)';
    throw Object.assign(new Error(`${error?.message ?? error}\nstudy child output: ${account}`, { cause: error }),
      error?.code === undefined ? {} : { code: error.code });
  } finally {
    cp.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (service) await stopStudyService(root, { expectedInstanceId: service.instanceId });
    if (owner) releaseOwnedLock(owner);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows solver cannot confirm termination when last identity probe becomes unknown', async () => {
  const { killGroup } = await import('../tools/solver-runtime.js');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let probes = 0;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const result = await killGroup(process.pid, 'expected-start', () => ++probes === 1 ? 'expected-start' : null);
    assert.equal(result.confirmed, false);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('owned lock adapter preserves legacy probe injection without storing an unversioned identity', async () => {
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { acquireOwnedLock, releaseOwnedLock, processStartTime, ownedProcessStartTime } = await import('../engine/state.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-probe-'));
  let lock;
  try {
    lock = acquireOwnedLock(root, 'loop.lock.d', { processStartTime: (pid) => processStartTime(pid) });
    assert.equal(lock.startTime, ownedProcessStartTime(process.pid));
  } finally { if (lock) releaseOwnedLock(lock); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows ACL proof rejects generic writes and permits only explicit read rights for strangers', async () => {
  const mod = await import('../shared/platform-files.js');
  assert.equal(typeof mod.privateAclAllowed, 'function');
  const snapshot = { owner: 'S-1-5-21-42', user: 'S-1-5-21-42', reparse: false, rules: [
    { sid: 'S-1-5-21-42', type: 'Allow', rights: 2032127 },
    { sid: 'S-1-1-0', type: 'Allow', rights: 1179817 },
  ] };
  assert.equal(mod.privateAclAllowed(snapshot, false), true);
  assert.equal(mod.privateAclAllowed(snapshot, true), false);
  for (const rights of [0x40000000, 0x10000000, 2, 0x80000, 0x40000, 64, -1]) {
    assert.equal(mod.privateAclAllowed({ ...snapshot, rules: [snapshot.rules[0], { ...snapshot.rules[1], rights }] }, false), false);
  }
  assert.equal(mod.privateAclAllowed({ ...snapshot, reparse: true }, false), false);
});

test('elevated token ownership is proof only for its own trusted creation owner', async () => {
  const mod = await import('../shared/platform-files.js');
  const user = 'S-1-5-21-42';
  const admins = 'S-1-5-32-544';
  const elevated = { owner: admins, tokenOwner: admins, user, reparse: false,
    rules: [{ sid: user, type: 'Allow', rights: 2032127 }] };
  assert.equal(mod.privateAclAllowed(elevated, true), true, 'a lock this token created is still ours');
  assert.equal(mod.privateAclAllowed(elevated, false), true);
  assert.equal(mod.privateAclAllowed({ ...elevated, tokenOwner: undefined }, true), false,
    'ownership by a group this token does not create objects as proves nothing');
  assert.equal(mod.privateAclAllowed({ ...elevated, tokenOwner: user }, true), false);
  assert.equal(mod.privateAclAllowed({ ...elevated, owner: 'S-1-5-21-99', tokenOwner: 'S-1-5-21-99' }, true), false,
    'only SYSTEM and Administrators are platform authorities');
  assert.equal(mod.privateAclAllowed({ ...elevated, owner: null, tokenOwner: null, user: null }, true), false);
  assert.equal(mod.privateAclAllowed({ ...elevated, rules: [{ sid: admins, type: 'Allow', rights: 2032127 }] }, true), false,
    'the DACL must still grant this user explicitly');
});

test('Windows listener fallback consumes the original deadline and closes its tracked child', async () => {
  const events = []; let calls = 0;
  const adapter = createListenerOwnedBy({ platform: 'win32', timeoutMs: 20,
    onChild: (event) => events.push(event),
    execFileFn: (exe, args, options, callback) => {
      calls += 1; setTimeout(() => callback(null, '', ''), 35); return { pid: 123 };
    },
  });
  await assert.rejects(adapter(42, 12345), { code: 'SERVER_LISTENER_UNAVAILABLE' });
  assert.equal(calls, 1, 'fallback cannot receive a second full probe budget');
  assert.deepEqual(events, ['open', 'close']);
});

test('Windows owned identity rejects noncanonical fractions before classifying a live PID', async () => {
  const { ownedIdentityStatus } = await import('../engine/state.js');
  const prefix = '2026-09-07T01:02:03';
  const canonical = `win32-v1:${prefix}.1230000Z`;
  for (const stamp of [`${prefix}Z`, `${prefix}.123Z`, `${prefix}.123000Z`]) {
    assert.equal(ownedIdentityStatus(process.pid, `win32-v1:${stamp}`, () => canonical), 'unknown');
    assert.equal(parseOwnedLockIdentity(`${process.pid}\nwin32-v1\n${stamp}`), null);
  }
  assert.equal(ownedIdentityStatus(process.pid, canonical, () => canonical), 'alive');
  assert.equal(ownedIdentityStatus(process.pid, `win32-v1:${prefix}.1230001Z`, () => canonical), 'dead');
  assert.deepEqual(parseOwnedLockIdentity(`${process.pid}\nwin32-v1\n${prefix}.1230001Z`), {
    pid: process.pid, startTime: `win32-v1:${prefix}.1230001Z`,
  });
});

test('Windows listener accepts the PowerShell numeric Listen enum in both query paths', async () => {
  const { win32ListenerOwnedBy } = await import('../tools/listener-ownership.js');
  const row = { OwningProcess: 42, LocalAddress: '127.0.0.1', LocalPort: 12345, State: 2 };
  const events = []; let syncCalls = 0; let asyncCalls = 0;
  assert.equal(win32ListenerOwnedBy(42, 12345, { spawn: () => {
    syncCalls += 1; return { status: 0, stdout: JSON.stringify(row), stderr: '' };
  } }), true);
  const adapter = createListenerOwnedBy({ platform: 'win32', onChild: (event) => events.push(event),
    execFileFn: (exe, args, options, callback) => {
      asyncCalls += 1; queueMicrotask(() => callback(null, JSON.stringify(row), '')); return { pid: 123 };
    },
  });
  assert.equal(await adapter(42, 12345), true);
  assert.equal(syncCalls, 1); assert.equal(asyncCalls, 1);
  assert.deepEqual(events, ['open', 'close']);
});

test('Windows numeric listener proof rejects non-listen, unknown and mismatched owners in both query paths', async () => {
  const { win32ListenerOwnedBy } = await import('../tools/listener-ownership.js');
  const base = { OwningProcess: 42, LocalAddress: '127.0.0.1', LocalPort: 12345, State: 2 };
  for (const patch of [{ State: 1 }, { State: 5 }, { State: 999 }, { State: null }, { State: '2' },
    { State: true }, { State: 'Established' }, { State: {} }, { OwningProcess: 43 },
    { LocalPort: 12346 }, { LocalAddress: '0.0.0.0' }]) {
    const stdout = JSON.stringify({ ...base, ...patch });
    assert.equal(win32ListenerOwnedBy(42, 12345, { spawn: () => ({ status: 0, stdout, stderr: '' }) }), false);
    const adapter = createListenerOwnedBy({ platform: 'win32', execFileFn: (exe, args, options, callback) => {
      queueMicrotask(() => callback(null, stdout, '')); return { pid: 123 };
    } });
    assert.equal(await adapter(42, 12345), false);
  }
});

test('actual platform listener query proves an owned loopback socket and rejects a different PID', { timeout: 60000 }, async () => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    const owned = createListenerOwnedBy({ timeoutMs: process.platform === 'win32' ? 15000 : 1000 });
    assert.equal(await owned(process.pid, port), true);
    assert.equal(await owned(process.pid + 100000, port), false);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
