#!/usr/bin/env node
import { isPrivatePath, arePrivatePaths, createPrivateDirectory, withPlatformDeadline, platformNow, platformTimeout, extendPlatformDeadline, setProofPhase } from '../shared/platform-files.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireOwnedLock, releaseOwnedLock, ownedIdentityStatus, ownedProcessStartTime, parseOwnedLockIdentity } from '../engine/state.js';
import { startDrillServer } from './drill-server.js';

const SELF = fileURLToPath(import.meta.url);
const LOCK = 'study.lock.d';
const DESCRIPTOR = 'study-service.json';
const MAX_DESCRIPTOR = 4096;
// Every Windows privacy or identity proof is a PowerShell child, and a single
// client call makes several of them. A POSIX-sized budget cannot bound that
// work: a cold ensure on a CI runner spent over 13s before its budget expired
// mid-proof. This is a ceiling on waiting, never a delay that is spent.
const WAIT_MS = process.platform === 'win32' ? 60_000 : 5000;
// The budget a client spends before it gives up on an unrepaired owner. Tests
// assert repair and refusal against this, not against a POSIX literal.
export const CLIENT_WAIT_MS = WAIT_MS;
// Only positively absent/dead ownership may enter the cold-start allowance.
const COLD_START_MS = process.platform === 'win32' ? 120_000 : WAIT_MS;
// A request is not answered until the service has re-proved its own boundaries,
// and on Windows each of those proofs is a PowerShell child. Serving
// /internal/parent-attach costs an ownership check, a descriptor read and a
// parent lock read — six or so proofs at about a second each — which overran the
// previous 8s ceiling on a CI runner. This is a ceiling on waiting, not a spend.
const HTTP_WAIT_MS = process.platform === 'win32' ? 30_000 : 500;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const inFlight = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameInode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const trainingIdentity = (ctx) => createHash('sha256').update(JSON.stringify([
  ctx.training, ctx.trainingStat?.dev, ctx.trainingStat?.ino,
])).digest('hex');
function fail(code = 'STUDY_DESCRIPTOR_CORRUPT', detail) {
  // The code is the contract; the detail only ever reaches logs and stderr.
  // formatStudyError renders from the code alone, so no path reaches a viewer.
  const error = new Error(detail ? `${code} ${detail}` : code); error.code = code; throw error;
}
export function nextCheckpointDelay(minMs, lastDurationMs, platform = process.platform) {
  if (platform !== 'win32') return minMs;
  return Math.max(minMs, 2 * lastDurationMs);
}
export function memoizedStartTimeOf(memo, startTimeOf) {
  return (pid) => {
    if (!memo.has(pid)) memo.set(pid, startTimeOf(pid));
    return memo.get(pid);
  };
}
function statOrNull(file) {
  platformTimeout(WAIT_MS);
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; fail(); }
}
// A synchronous read transaction batches mutable ACL proof before and after
// all inode/bytes checks. No proof is cached across awaits or transactions.
let aclScope = null;
let identityMemo = null;
function privatePath(file, privateMode) {
  return aclScope?.has(file) || isPrivatePath(file, { privateMode });
}
// A path can be removed between the moment it is listed and the moment the proof
// reads it, and on Windows that proof is a PowerShell child, so the window is
// about a second wide. A service shutting down does exactly this, twice in a
// row: it unlinks its descriptor, then releases its lock, each behind its own
// second of proofs — so one retry can lose the lock while re-proving the
// descriptor's absence. A path that is gone is absent, not unproven. Re-prove for
// as long as the listing keeps changing under the proof; only a listing that held
// still across a proof makes an unproven path final. The bound is the number of
// candidates: a listing can only change that many times before it is empty.
function proveEntries(candidates, phase) {
  const listing = (entries) => entries.map(({ file }) => file).join('\u0000');
  // A symlink is never a private path, and every read of one is refused on
  // its own. Listing it here would veto the whole transaction instead — an
  // owner could not release its own lock beside a symlinked descriptor.
  const present = (file) => { const stat = statOrNull(file); return stat && !stat.isSymbolicLink(); };
  let entries = candidates.filter(({ file }) => present(file));
  let reasons = [];
  for (let attempt = 0; attempt <= candidates.length; attempt += 1) {
    reasons = [];
    if (arePrivatePaths(entries, { onUnproven: (reason) => { if (reasons.length < 4) reasons.push(reason); } })) return entries;
    const relisted = candidates.filter(({ file }) => present(file));
    if (listing(relisted) === listing(entries)) break;
    entries = relisted;
  }
  fail('STUDY_DESCRIPTOR_CORRUPT', `${phase} ${reasons.join(' | ')}`);
}
function settleTransaction(fn) {
  const result = fn();
  if (result && typeof result.then === 'function') fail('STUDY_DESCRIPTOR_CORRUPT', 'async transaction');
  return result;
}
export function aclTransaction(ctx, fn, { platform = process.platform } = {}) {
  if (platform !== 'win32' || aclScope) return settleTransaction(fn);
  const candidates = [
    { file: ctx.root, privateMode: false }, { file: ctx.training, privateMode: true },
    { file: path.join(ctx.training, DESCRIPTOR), privateMode: true },
    { file: path.join(ctx.training, LOCK), privateMode: false },
    { file: path.join(ctx.training, LOCK, 'pid'), privateMode: false },
    { file: path.join(ctx.root, 'loop.lock.d'), privateMode: false },
    { file: path.join(ctx.root, 'loop.lock.d', 'pid'), privateMode: false },
  ];
  identityMemo = new Map();
  aclScope = new Set(proveEntries(candidates, 'before').map(({ file }) => file));
  try { return settleTransaction(fn); }
  finally { identityMemo = null; aclScope = null; proveEntries(candidates, 'after'); }
}
function ownUid(stat) { return typeof process.getuid !== 'function' || stat.uid === process.getuid(); }
function directory(file, { privateMode = false } = {}) {
  const stat = statOrNull(file);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !ownUid(stat)
    || (process.platform === 'win32' ? !privatePath(file, privateMode) : ((stat.mode & 0o022) !== 0 || (privateMode && (stat.mode & 0o777) !== 0o700)))) fail();
  return stat;
}
function assertContext(ctx) {
  if (process.platform === 'win32' && !aclScope) return aclTransaction(ctx, () => assertContext(ctx));
  if (!sameInode(directory(ctx.root), ctx.rootStat) || fs.realpathSync(ctx.root) !== ctx.root) fail();
  if (ctx.trainingStat && !sameInode(directory(ctx.training, { privateMode: true }), ctx.trainingStat)) fail();
}
function context(storeDir, { create = false } = {}) {
  if (typeof storeDir !== 'string' || !storeDir || storeDir.includes('\0')) fail();
  const requested = path.resolve(storeDir);
  if (process.platform === 'win32' && !aclScope) {
    return aclTransaction({ root: requested, training: path.join(requested, '.training') }, () => context(storeDir, { create }));
  }
  const original = directory(requested); // Reject a symlink store itself before canonicalizing ancestors.
  const root = fs.realpathSync(requested);
  if (!sameInode(directory(root), original)) fail();
  const training = path.join(root, '.training');
  const ctx = { root, rootStat: original, training, trainingStat: null };
  assertContext(ctx);
  let stat = statOrNull(training);
  if (!stat && create) {
    assertContext(ctx);
    try { createPrivateDirectory(training); } catch (error) { if (error.code !== 'EEXIST') fail(); }
    stat = statOrNull(training);
  }
  if (stat) ctx.trainingStat = directory(training, { privateMode: true });
  ctx.storeIdentity = createHash('sha256').update(JSON.stringify([root, original.dev, original.ino])).digest('hex');
  assertContext(ctx);
  return ctx;
}
function safeFile(stat, privateMode, file) {
  return stat?.isFile() && !stat.isSymbolicLink() && ownUid(stat) && stat.nlink === 1
    && (process.platform === 'win32' ? privatePath(file, privateMode) : (privateMode ? (stat.mode & 0o777) === 0o600 : (stat.mode & 0o022) === 0));
}
function readPrivate(ctx, file, maxBytes, { privateMode = true, allowOversized = false } = {}) {
  if (process.platform === 'win32' && !aclScope) return aclTransaction(ctx, () => readPrivate(ctx, file, maxBytes, { privateMode, allowOversized }));
  assertContext(ctx);
  const before = statOrNull(file);
  if (!before) return null;
  if (!safeFile(before, privateMode, file) || (!allowOversized && before.size > maxBytes)) fail();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!sameInode(before, opened) || !safeFile(opened, privateMode, file) || (!allowOversized && opened.size > maxBytes)) fail();
    assertContext(ctx);
    if (allowOversized && opened.size > maxBytes) return { text: null, stat: opened };
    const bytes = Buffer.alloc(opened.size);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (!sameInode(opened, statOrNull(file)) || after.size > maxBytes || !safeFile(after, privateMode, file)) fail();
    assertContext(ctx);
    return { text: bytes.subarray(0, length).toString('utf8'), stat: opened };
  } catch (error) {
    if (error.code === 'STUDY_DESCRIPTOR_CORRUPT') throw error;
    fail();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Windows inode numbers run past 2^53, where a Number-valued stat rounds them.
// Converting that rounded value with BigInt() cannot recover what it lost, so an
// identity recorded exactly at creation never matches one re-read as a Number.
// Read the identity the same exact way it was recorded.
function exactInode(file) {
  platformTimeout(WAIT_MS);
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) { if (error.code === 'ENOENT') return null; fail(); }
}
function identityStatus(pid, startTime) {
  platformTimeout(WAIT_MS);
  const startTimeOf = identityMemo ? memoizedStartTimeOf(identityMemo, ownedProcessStartTime) : undefined;
  const status = startTimeOf
    ? ownedIdentityStatus(pid, startTime, startTimeOf)
    : ownedIdentityStatus(pid, startTime);
  platformTimeout(WAIT_MS);
  return status;
}
function readLock(ctx, parent = false) {
  if (process.platform === 'win32' && !aclScope) return aclTransaction(ctx, () => readLock(ctx, parent));
  assertContext(ctx);
  if (!parent && !ctx.trainingStat) return null;
  const file = path.join(parent ? ctx.root : ctx.training, parent ? 'loop.lock.d' : LOCK);
  const stat = statOrNull(file);
  if (!stat) return null;
  const checked = directory(file);
  const exact = exactInode(file);
  const pidFile = readPrivate(ctx, path.join(file, 'pid'), 256, { privateMode: false });
  if (!sameInode(checked, directory(file))) fail();
  if (!pidFile) return { status: 'unknown', stat: checked, exact };
  const parsed = parseOwnedLockIdentity(pidFile.text);
  if (!parsed) return { status: 'unknown', stat: checked, exact };
  const { pid, startTime } = parsed;
  return { pid, startTime, stat: checked, exact, pidStat: pidFile.stat, status: identityStatus(pid, startTime) };
}
function descriptorFields(value) {
  const keys = ['schemaVersion','pid','startTime','instanceId','storeIdentity','port','drillToken','controlToken'];
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    && value.schemaVersion === 1 && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.startTime === 'string' && value.startTime.length > 0 && value.startTime.length <= 128
    && UUID.test(value.instanceId) && HEX.test(value.storeIdentity)
    && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535
    && HEX.test(value.drillToken) && HEX.test(value.controlToken) && value.drillToken !== value.controlToken;
}
function readDescriptor(ctx) {
  if (!ctx.trainingStat) return { state: 'missing' };
  const file = readPrivate(ctx, path.join(ctx.training, DESCRIPTOR), MAX_DESCRIPTOR, { allowOversized: true });
  if (!file) return { state: 'missing' };
  if (file.text === null) return { state: 'corrupt', stat: file.stat };
  let value;
  try { value = JSON.parse(file.text); } catch { return { state: 'corrupt', stat: file.stat }; }
  if (!descriptorFields(value)) return { state: 'corrupt', stat: file.stat };
  return { state: 'valid', value, stat: file.stat };
}
function descriptorMatches(value, ctx, owner) {
  return owner?.status === 'alive' && value.storeIdentity === ctx.storeIdentity
    && value.pid === owner.pid && value.startTime === owner.startTime;
}
function sameLock(a, b) {
  return sameInode(a?.stat, b?.stat) && sameInode(a?.pidStat, b?.pidStat)
    && a.pid === b.pid && a.startTime === b.startTime;
}
function publicHandle(value) {
  return { pid: value.pid, startTime: value.startTime, instanceId: value.instanceId,
    storeIdentity: value.storeIdentity, port: value.port,
    studyUrl: `http://127.0.0.1:${value.port}/#token=${value.drillToken}` };
}
// AbortSignal.timeout accepts integers only. Both the request-local deadline
// and the caller's shared monotonic budget must still permit a whole millisecond.
export function studyHttpTimeout(deadline, maximum = HTTP_WAIT_MS) {
  const localRemaining = deadline === undefined ? maximum : Math.floor(deadline - platformNow());
  const timeout = Math.min(localRemaining, platformTimeout(maximum));
  if (!Number.isSafeInteger(timeout) || timeout <= 0) fail();
  return timeout;
}
async function httpJson(value, route, { control = false, body, badToken = false, deadline } = {}) {
  const timeout = studyHttpTimeout(deadline);
  const response = await fetch(`http://127.0.0.1:${value.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { [control ? 'x-study-control' : 'x-drill-token']:
      badToken ? 'invalid-study-health-probe' : (control ? value.controlToken : value.drillToken) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout), redirect: 'error',
  });
  // Health/control responses are small; never trust an arbitrary listener's stream.
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value: bytes } = await reader.read(); if (done) break;
      size += bytes.length;
      if (size > MAX_DESCRIPTOR) { await reader.cancel(); fail(); }
      chunks.push(bytes);
    }
  } finally { reader.releaseLock(); }
  return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
async function verified(ctx, descriptor, owner, deadline) {
  if (descriptor.state !== 'valid' || !descriptorMatches(descriptor.value, ctx, owner)) fail();
  const value = descriptor.value;
  let denied, health;
  try {
    denied = await httpJson(value, '/api/health', { badToken: true, deadline });
    health = await httpJson(value, '/api/health', { deadline });
  } catch (error) {
    // A transport failure and a wrong answer are different losses; name which.
    fail('STUDY_DESCRIPTOR_CORRUPT', transportDetail(error));
  }
  if (denied.status !== 401 || health.status !== 200 || health.body?.ok !== true
    || health.body?.protocolVersion !== 1 || health.body?.capabilities?.study !== true
    || !['pid','startTime','instanceId','storeIdentity','port'].every((key) => health.body?.[key] === value[key])) {
    fail('STUDY_DESCRIPTOR_CORRUPT', `health answer denied=${denied.status} status=${health.status} ok=${health.body?.ok}`
      + ` identity=${['pid','startTime','instanceId','storeIdentity','port'].filter((key) => health.body?.[key] !== value[key]).join(',') || 'match'}`);
  }
  const { after, lock } = aclTransaction(ctx, () => ({ after: readDescriptor(ctx), lock: readLock(ctx) }));
  if (after.state !== 'valid' || JSON.stringify(after.value) !== JSON.stringify(value)
    || !sameLock(owner, lock) || !descriptorMatches(value, ctx, lock)) fail();
  return value;
}
async function waitForLiveService(ctx, owner, deadline, { expectedInstanceId, staleDescriptor } = {}) {
  if (owner?.status !== 'alive') fail();
  // Only the already observed live owner may repair this descriptor. None of
  // these reads grants permission to start a process or reclaim its metadata.
  while (platformNow() < deadline) {
    const { currentOwner, descriptor, awaitingFirstCheckpoint } = aclTransaction(ctx, () => {
      const currentOwner = readLock(ctx);
      if (currentOwner?.status !== 'alive' || !sameLock(owner, currentOwner)) {
        const observed = currentOwner
          ? `${currentOwner.status} pid=${currentOwner.pid} recorded=${currentOwner.startTime}`
          : 'absent';
        fail('STUDY_DESCRIPTOR_CORRUPT', `owner ${observed}, expected alive pid=${owner.pid} recorded=${owner.startTime}`);
      }
      const descriptor = readDescriptor(ctx);
      const awaitingFirstCheckpoint = staleDescriptor && descriptor.state === 'valid'
        && JSON.stringify(descriptor.value) === JSON.stringify(staleDescriptor)
        && identityStatus(staleDescriptor.pid, staleDescriptor.startTime) === 'dead';
      return { currentOwner, descriptor, awaitingFirstCheckpoint };
    });
    if (descriptor.state === 'valid' && !awaitingFirstCheckpoint) {
      if (expectedInstanceId !== undefined && descriptor.value.instanceId !== expectedInstanceId) {
        fail('STUDY_IDENTITY_MISMATCH');
      }
      if (!descriptorMatches(descriptor.value, ctx, currentOwner)) fail();
      try { return await verified(ctx, descriptor, currentOwner, deadline); }
      catch (error) {
        // An owner checkpoint can overlap verification. Retry only safe missing
        // or corrupt JSON; a valid conflicting record or failed health stays closed.
        const afterOwner = readLock(ctx);
        if (error.code !== 'STUDY_DESCRIPTOR_CORRUPT' || afterOwner?.status !== 'alive'
          || !sameLock(owner, afterOwner) || readDescriptor(ctx).state === 'valid') throw error;
      }
    }
    await sleep(Math.max(1, Math.min(50, deadline - platformNow())));
  }
  fail();
}
function validateParent(ctx, identity) {
  if (!identity || Object.keys(identity).some((key) => !['pid','startTime'].includes(key))
    || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || typeof identity.startTime !== 'string') fail('PARENT_IDENTITY_MISMATCH');
  const actual = readLock(ctx, true);
  if (actual?.status !== 'alive' || actual.pid !== identity.pid || actual.startTime !== identity.startTime) fail('PARENT_IDENTITY_MISMATCH');
  return actual;
}
async function attachParent(ctx, value, identity, deadline) {
  validateParent(ctx, identity);
  const response = await httpJson(value, '/internal/parent-attach', { control: true, body: identity, deadline });
  if (response.status !== 200 || response.body.ok !== true) fail('PARENT_IDENTITY_MISMATCH');
  validateParent(ctx, identity);
}
function optionsForChild(options) {
  if (options.port !== undefined && options.port !== 0) throw new TypeError('study port must be 0');
  const testOptions = options.testOptions ?? {};
  if (!testOptions || typeof testOptions !== 'object' || Array.isArray(testOptions)
    || Object.keys(testOptions).some((key) => !['idleTimeoutMs','checkpointMs'].includes(key))) throw new TypeError('invalid study test options');
  const idleTimeoutMs = testOptions.idleTimeoutMs ?? 10 * 60 * 1000;
  const checkpointMs = testOptions.checkpointMs ?? 1000;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 600000
    || !Number.isSafeInteger(checkpointMs) || checkpointMs < 25 || checkpointMs > 1000) throw new TypeError('invalid study lifetime');
  return { idleTimeoutMs, checkpointMs };
}

async function ensureOwned(ctx, options, deadline, coldDeadline) {
  const config = optionsForChild(options);
  let owner = readLock(ctx);
  let descriptor = readDescriptor(ctx);
  const staleDescriptor = descriptor.state === 'valid' && descriptor.value.storeIdentity === ctx.storeIdentity
    && identityStatus(descriptor.value.pid, descriptor.value.startTime) === 'dead' ? descriptor.value : undefined;
  if (owner?.status === 'alive') {
    extendPlatformDeadline(deadline);
    return waitForLiveService(ctx, owner, deadline);
  }
  if (!owner || owner.status === 'dead') {
    if (descriptor.state === 'corrupt') fail();
    if (descriptor.state === 'valid') {
      if (descriptor.value.storeIdentity !== ctx.storeIdentity
        || identityStatus(descriptor.value.pid, descriptor.value.startTime) !== 'dead') fail();
      if (owner && (owner.pid !== descriptor.value.pid || owner.startTime !== descriptor.value.startTime)) fail();
    }
    assertContext(ctx);
    // Only the detached service child acquires/reclaims its lifetime lock. Clients
    // never remove a lock or send process signals, including failed startup paths.
    deadline = coldDeadline ?? platformNow() + COLD_START_MS;
    extendPlatformDeadline(deadline);
    const childLog = openChildLog();
    const child = spawn(process.execPath, [SELF, '--serve', ctx.root, JSON.stringify(config),
      ctx.storeIdentity, trainingIdentity(ctx)], {
      cwd: path.dirname(SELF), detached: true,
      stdio: childLog === undefined ? 'ignore' : ['ignore', 'ignore', childLog],
      // Existing owned locks use ps lstart in the caller's locale/timezone.
      // Preserve that identity format without inheriting game/provider secrets.
      env: childEnvironment(),
    });
    if (childLog !== undefined) fs.closeSync(childLog);
    let spawnError = null;
    child.on('error', (error) => { spawnError = error; });
    child.unref();
    options.onChild?.(child);
    await sleep(25);
    if (spawnError) fail();
  }
  while (platformNow() < deadline) {
    assertContext(ctx);
    owner = readLock(ctx);
    if (owner?.status === 'alive') {
      deadline = Math.min(deadline, platformNow() + platformTimeout(WAIT_MS));
      extendPlatformDeadline(deadline);
      return waitForLiveService(ctx, owner, deadline, { staleDescriptor });
    }
    await sleep(Math.max(1, Math.min(50, deadline - platformNow())));
  }
  fail();
}

async function ensureStudyServiceWithinBudget(storeDir, options = {}) {
  // Every WAIT_MS deadline is capped by the budget in force, so a caller's
  // monotonic budget is consumed, never extended past by a fresh window.
  let deadline = platformNow() + platformTimeout(WAIT_MS);
  let ctx = context(storeDir);
  let coldDeadline;
  optionsForChild(options);
  if (!ctx.trainingStat) {
    // Safe root identity plus positively absent training metadata authorizes
    // cold directory creation. This does not authorize a raced-in live owner.
    coldDeadline = platformNow() + COLD_START_MS;
    extendPlatformDeadline(coldDeadline);
    assertContext(ctx);
    const created = context(storeDir, { create: true });
    if (created.root !== ctx.root || !sameInode(created.rootStat, ctx.rootStat)) fail();
    ctx = created;
    deadline = Math.min(coldDeadline, platformNow() + platformTimeout(WAIT_MS));
    extendPlatformDeadline(deadline);
  }
  if (options.parentIdentity !== undefined) validateParent(ctx, options.parentIdentity);
  let pending = inFlight.get(ctx.storeIdentity);
  if (!pending) {
    pending = ensureOwned(ctx, options, deadline, coldDeadline);
    inFlight.set(ctx.storeIdentity, pending);
    pending.finally(() => { if (inFlight.get(ctx.storeIdentity) === pending) inFlight.delete(ctx.storeIdentity); }).catch(() => {});
  }
  let timer;
  const value = await Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT'), { code: 'STUDY_DESCRIPTOR_CORRUPT' })), platformTimeout(COLD_START_MS));
  })]).finally(() => clearTimeout(timer));
  deadline = platformNow() + platformTimeout(WAIT_MS);
  // Revalidate the caller's own context after awaiting another concurrent ensure.
  const { current, owner } = aclTransaction(ctx, () => ({ current: readDescriptor(ctx), owner: readLock(ctx) }));
  const restored = current.state === 'valid' ? current.value
    : await waitForLiveService(ctx, owner, deadline, { expectedInstanceId: value.instanceId });
  if (JSON.stringify(restored) !== JSON.stringify(value) || !descriptorMatches(value, ctx, owner)) fail();
  if (options.parentIdentity !== undefined) await attachParent(ctx, value, options.parentIdentity, deadline);
  return publicHandle(value);
}
async function inspectStudyServiceWithinBudget(storeDir) {
  const deadline = platformNow() + platformTimeout(WAIT_MS);
  const ctx = context(storeDir);
  const { descriptor, owner } = aclTransaction(ctx, () => ({ descriptor: readDescriptor(ctx), owner: readLock(ctx) }));
  if (!owner && descriptor.state === 'missing') return { status: 'stopped' };
  if (owner?.status === 'dead' && descriptor.state === 'valid'
    && owner.pid === descriptor.value.pid && owner.startTime === descriptor.value.startTime
    && descriptor.value.storeIdentity === ctx.storeIdentity) return { status: 'stopped' };
  const value = await waitForLiveService(ctx, owner, deadline);
  return { status: 'running', ...publicHandle(value) };
}
async function stopStudyServiceWithinBudget(storeDir, { expectedInstanceId } = {}) {
  const deadline = platformNow() + platformTimeout(WAIT_MS);
  if (!UUID.test(expectedInstanceId)) fail('STUDY_IDENTITY_MISMATCH');
  const ctx = context(storeDir);
  const { descriptor, owner } = aclTransaction(ctx, () => ({ descriptor: readDescriptor(ctx), owner: readLock(ctx) }));
  if (!owner && descriptor.state === 'missing') return { stopped: true, alreadyStopped: true };
  if (descriptor.state === 'valid' && descriptor.value.instanceId === expectedInstanceId
    && descriptor.value.storeIdentity === ctx.storeIdentity && owner?.status === 'dead'
    && owner.pid === descriptor.value.pid && owner.startTime === descriptor.value.startTime) {
    return { stopped: true, alreadyStopped: true };
  }
  const value = await waitForLiveService(ctx, owner, deadline, { expectedInstanceId });
  let response;
  try { response = await httpJson(value, '/internal/shutdown', { control: true, body: { expectedInstanceId }, deadline }); }
  catch { fail(); }
  if (response.status !== 200 || response.body.ok !== true) fail();
  while (platformNow() < deadline) {
    assertContext(ctx);
    const { current, lock } = aclTransaction(ctx, () => ({ current: readDescriptor(ctx), lock: readLock(ctx) }));
    if (current.state === 'missing' && !lock && identityStatus(value.pid, value.startTime) === 'dead') {
      return { stopped: true, alreadyStopped: false };
    }
    // A replacement belongs to the next caller; it is never ours to stop.
    if (current.state === 'valid' && current.value.instanceId !== expectedInstanceId) fail('STUDY_IDENTITY_MISMATCH');
    await sleep(Math.max(1, Math.min(25, deadline - platformNow())));
  }
  fail();
}

const CHILD_ENV_KEYS = ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL','LC_TIME','TZ'];
export function childEnvironment(env = process.env) {
  const keys = env.AI_HOLDEM_PLATFORM_DIAGNOSTICS !== undefined
    ? [...CHILD_ENV_KEYS, 'AI_HOLDEM_PLATFORM_DIAGNOSTICS']
    : CHILD_ENV_KEYS;
  return Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}
function openChildLog() {
  const dir = process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS;
  if (!dir) return undefined;
  try { return fs.openSync(path.join(dir, 'study-children.log'), 'a'); }
  catch { return undefined; }
}
export function transportDetail(error) {
  const cause = error?.cause?.code ?? error?.cause?.name ?? 'none';
  return `health transport ${error?.name ?? ''} ${error?.code ?? ''} ${String(error?.message ?? '').slice(0, 120)} cause=${cause}`;
}
function withClientPhase(label, fn) {
  setProofPhase(label);
  try { return fn(); }
  finally { setProofPhase(null); }
}

export function ensureStudyService(storeDir, options = {}) {
  // platformTimeout caps the client's own budget by whatever a caller's budget
  // has left, so an outer monotonic deadline is honoured rather than replaced.
  // POSIX hid this: its WAIT_MS happened to equal the budget the contract test
  // hands in, and the 60s Windows budget overran that test by 55s.
  return withClientPhase('ensure', () => withPlatformDeadline(platformNow() + platformTimeout(WAIT_MS), () => ensureStudyServiceWithinBudget(storeDir, options)));
}
export function inspectStudyService(storeDir) {
  return withClientPhase('inspect', () => withPlatformDeadline(platformNow() + platformTimeout(WAIT_MS), () => inspectStudyServiceWithinBudget(storeDir)));
}
export function stopStudyService(storeDir, options = {}) {
  return withClientPhase('stop', () => withPlatformDeadline(platformNow() + platformTimeout(WAIT_MS), () => stopStudyServiceWithinBudget(storeDir, options)));
}

function assertOwnLock(ctx, own) {
  const current = readLock(ctx);
  if (current?.status !== 'alive' || current.pid !== own.pid || current.startTime !== own.startTime
    || current.exact?.dev !== own.dev || current.exact?.ino !== own.ino) {
    // Four different losses reach this guard and the caller cannot tell them
    // apart. Name the one that happened; the status word carries the rest,
    // since 'unknown' is a probe that could not run and 'dead' is one that ran
    // and disagreed.
    fail('STUDY_DESCRIPTOR_CORRUPT', current
      ? `own lock status=${current.status} pid=${current.pid}/${own.pid}`
        + ` start=${current.startTime}/${own.startTime}`
        + ` dev=${current.exact?.dev}/${own.dev} ino=${current.exact?.ino}/${own.ino}`
      : 'own lock absent');
  }
  return current;
}
function publish(ctx, own, value) {
  if (process.platform === 'win32' && !aclScope) return aclTransaction(ctx, () => publish(ctx, own, value));
  assertOwnLock(ctx, own);
  const file = path.join(ctx.training, DESCRIPTOR);
  const before = readPrivate(ctx, file, MAX_DESCRIPTOR, { allowOversized: true });
  let fd;
  try {
    assertOwnLock(ctx, own);
    fd = fs.openSync(file, fs.constants.O_WRONLY | NOFOLLOW | NONBLOCK
      | (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o600);
    const opened = fs.fstatSync(fd);
    if (!safeFile(opened, true, file) || (before && !sameInode(before.stat, opened))) fail();
    assertContext(ctx);
    if (!sameInode(opened, statOrNull(file))) fail();
    const bytes = Buffer.from(JSON.stringify(value));
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    assertContext(ctx);
    if (!sameInode(opened, statOrNull(file)) || !safeFile(fs.fstatSync(fd), true, file)) fail();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function runService(storeDir, config, expectedStore, expectedTraining) {
  setProofPhase('runService');
  let ctx;
  try {
    ctx = context(storeDir);
    if (!ctx.trainingStat || ctx.storeIdentity !== expectedStore || trainingIdentity(ctx) !== expectedTraining) fail();
    readDescriptor(ctx); readLock(ctx); // Validate private boundaries before owned-lock primitives.
  } finally { setProofPhase(null); }
  // runService is child-only; do not change the caller umask or existing modes.
  process.umask(0o077);
  const own = acquireOwnedLock(ctx.training, LOCK);
  let server, timer, value, stopping = false, instanceId;
  const parents = new Map();
  let lastActivity = Date.now();
  let hadLiveParent = false;
  // A service that ends on its own is invisible to its client, which can only
  // report that the lock stopped being alive. Say why, on the same stderr the
  // startup failure uses: discarded in production, read by a piped caller.
  const stop = async (reason = 'requested') => {
    if (stopping) return; stopping = true; clearTimeout(timer);
    try { process.stderr.write(`STUDY_CHILD_STOPPED ${reason} pid=${own.pid} instance=${instanceId ?? 'none'}\n`); } catch { /* closed stdio */ }
    await server?.close();
    setProofPhase('stop');
    try {
      assertOwnLock(ctx, own);
      const descriptor = readDescriptor(ctx);
      if (value && descriptor.state === 'valid' && JSON.stringify(descriptor.value) === JSON.stringify(value)) {
        assertOwnLock(ctx, own);
        const file = path.join(ctx.training, DESCRIPTOR);
        if (!sameInode(statOrNull(file), descriptor.stat)) fail();
        fs.unlinkSync(file);
      }
    } catch { /* Unsafe/foreign descriptor stays untouched; HTTP still closes. */ }
    finally { setProofPhase(null); }
    setProofPhase('stop');
    try { assertOwnLock(ctx, own); releaseOwnedLock(own); } catch { /* Never traverse a replaced owner boundary. */ }
    finally { setProofPhase(null); }
  };
  const checkpoint = () => {
    if (stopping) return;
    setProofPhase('checkpoint');
    try {
      aclTransaction(ctx, () => {
        assertOwnLock(ctx, own);
        const descriptor = readDescriptor(ctx);
        if (descriptor.state !== 'valid' || JSON.stringify(descriptor.value) !== JSON.stringify(value)) publish(ctx, own, value);
        let liveParent = false;
        for (const [key, parent] of parents) {
          let current;
          try { current = readLock(ctx, true); } catch { current = null; }
          if (current?.status === 'alive' && sameLock(parent, current)) liveParent = true;
          else parents.delete(key);
        }
        if (liveParent || hadLiveParent) lastActivity = Date.now();
        hadLiveParent = liveParent;
      });
      if (Date.now() - lastActivity >= config.idleTimeoutMs) void stop('idle');
    } catch (error) { void stop(`checkpoint ${error?.code ?? error?.name ?? 'unknown'} ${String(error?.stack ?? '').split('\n').slice(0, 3).join(' / ')}`); }
    finally { setProofPhase(null); }
  };
  try {
    const drillToken = randomBytes(32).toString('hex'), controlToken = randomBytes(32).toString('hex');
    instanceId = randomUUID();
    const health = { pid: own.pid, startTime: own.startTime, instanceId, storeIdentity: ctx.storeIdentity };
    server = await startDrillServer({ storeDir: ctx.root, token: drillToken, health,
      beforeRequest() {
        setProofPhase('beforeRequest');
        try { aclTransaction(ctx, () => { assertOwnLock(ctx, own); readDescriptor(ctx); }); }
        catch (error) { void stop(`request ${error?.code ?? error?.name ?? 'unknown'} ${String(error?.stack ?? '').split('\n').slice(0, 3).join(' / ')}`); throw error; }
        finally { setProofPhase(null); }
        if (stopping) fail();
      },
      onActivity() { lastActivity = Date.now(); },
      parentRegistry: { controlToken,
        attach(identity) {
          const parent = validateParent(ctx, identity);
          parents.set(`${parent.pid}:${parent.startTime}`, parent); lastActivity = Date.now(); hadLiveParent = true;
        },
        shutdown({ expectedInstanceId }) {
          if (expectedInstanceId !== instanceId) fail('STUDY_IDENTITY_MISMATCH');
          return () => { void stop('shutdown requested'); };
        },
      },
    });
    health.port = server.port;
    value = { schemaVersion: 1, ...health, drillToken, controlToken };
    publish(ctx, own, value);
    let lastCheckpointMs = 0;
    const scheduleCheckpoint = () => {
      timer = setTimeout(() => {
        const started = Date.now();
        checkpoint();
        lastCheckpointMs = Date.now() - started;
        if (!stopping) scheduleCheckpoint();
      }, nextCheckpointDelay(config.checkpointMs, lastCheckpointMs));
    };
    scheduleCheckpoint();
    process.once('SIGTERM', () => { void stop('SIGTERM'); });
    process.once('SIGINT', () => { void stop('SIGINT'); });
  } catch (error) { await stop(`startup ${error?.code ?? error?.name ?? 'unknown'}`); throw error; }
}
const direct = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (direct) {
  try {
    if (process.argv[2] !== '--serve' || process.argv.length !== 7) fail();
    const config = JSON.parse(process.argv[4]);
    optionsForChild({ testOptions: config });
    await runService(process.argv[3], config, process.argv[5], process.argv[6]);
  } catch (error) {
    // Production stdio is 'ignore', so this write lands on the null device and
    // costs nothing. A caller that pipes this child is otherwise unable to tell
    // a failed cold start from a slow one: it only ever sees its own timeout.
    try { process.stderr.write(`STUDY_CHILD_FAILED ${error?.code ?? error?.name ?? 'unknown'} pid=${process.pid} instance=none\n${error?.stack ?? ''}\n`); }
    catch { /* A closed or full stdio never changes the exit status. */ }
    process.exitCode = 1;
  }
}
