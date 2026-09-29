// #214 (writer verifies release declarations) and #216 (the authority file is canonical;
// the trace is a mirror reconciled through an outbox).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../engine/state.js';
import { gameEpochOf } from '../publish-contract.js';
import { createCoachControl } from '../tools/coach-control.js';
import { deriveServerLockObservation } from '../tools/game-loop.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'tok-coach-release';
const DEAD_PID = 4_194_303;
const LIVE_PID = process.pid;
const START = 'Mon Sep 28 12:00:00 2026';
const TRACE = '.coach-adapter-trace.jsonl';

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-coach-release-'));
}

function authorityOf(dir) { return JSON.parse(fs.readFileSync(path.join(dir, '.coach-authority.json'), 'utf8')); }
function traceRows(dir) {
  const file = path.join(dir, TRACE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function bytes(dir) {
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name)) : null);
  return { authority: read('.coach-authority.json'), trace: read(TRACE) };
}

// A retired row for hand 1, shaped by `row` overrides, with a controllable writer.
async function fixture({ handle = null, spawnEvidence = false, deps = {}, sidecar = null, closures = null } = {}) {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ serverPid: process.pid, port: 8877, sessionToken: TOKEN, startedAt: new Date().toISOString() }));
  const snapshotFile = path.join(dir, 'ui-snapshot.json');
  writeJsonAtomic(snapshotFile, { revision: 1, view: null, log: [], coach: [] });
  const statsFile = path.join(dir, 'stats.json');
  writeJsonAtomic(statsFile, { perPlayer: { user: { sample: 0, vpip: 0 } } });
  if (closures) writeJsonAtomic(path.join(dir, 'loop-state.json'), { coachRuntimeClosures: closures });
  const setupCc = createCoachControl();
  const reserved = await setupCc.reserve({ gameDir: dir, owner: OWNER, handNo: 1, statsFile, snapshotFile, spawnEvidence });
  if (handle) await setupCc.bindHandle({ gameDir: dir, owner: OWNER, handNo: 1, generation: reserved.generation, handle });
  await setupCc.fence({ gameDir: dir, owner: OWNER, handNo: 1, generation: reserved.generation, reason: 'test' });
  const row = authorityOf(dir).retiredAttempts.at(-1);
  if (sidecar) {
    const sidecarPath = path.join(dir, path.basename(row.exactResultPath).replace(/\.result\.json$/, '.spawn.json'));
    fs.writeFileSync(sidecarPath, JSON.stringify({
      gameEpoch: gameEpochOf(TOKEN), owner: OWNER, handNo: 1, generation: reserved.generation, attempt: row.attempt, ...sidecar,
    }));
  }
  const cc = createCoachControl(deps);
  const cleanup = (fields) => cc.recordCleanup({ gameDir: dir, owner: OWNER, handNo: 1, generation: reserved.generation, cleanupState: 'released', ...fields });
  return { dir, cc, generation: reserved.generation, cleanup };
}

const observed = (states) => ({
  processAlive: (pid) => states[pid] !== 'dead',
  processStartTime: (pid) => states[pid] === 'unknown' ? null : (states[pid] ?? START),
});

test('#214 identity declarations are verified by the writer, not taken from the caller', async () => {
  const dead = await fixture({ handle: `${DEAD_PID}:${START}`, deps: observed({ [DEAD_PID]: 'dead' }) });
  const released = await dead.cleanup({ evidence: 'IDENTITY_DEAD' });
  assert.deepEqual(released.verification, { status: 'verified', method: 'identity', observed: { identity: 'dead', sidecar: 'absent' } });
  const row = authorityOf(dead.dir).retiredAttempts.at(-1);
  assert.equal(row.cleanupState, 'released');
  assert.deepEqual(row.release.declared, { evidence: 'IDENTITY_DEAD' });
  assert.equal(traceRows(dead.dir).at(-1).auditId, row.release.auditId, 'the trace mirrors the canonical record');

  // DEAD and REPLACED are one class: a reused pid proves the recorded process gone.
  const replaced = await fixture({ handle: `${LIVE_PID}:${START}`, deps: observed({ [LIVE_PID]: 'Mon Sep 28 12:00:07 2026' }) });
  assert.equal((await replaced.cleanup({ evidence: 'IDENTITY_DEAD' })).verification.status, 'verified');

  for (const [state, code] of [[START, 'RELEASE_TARGET_ALIVE'], ['unknown', 'RELEASE_EVIDENCE_UNVERIFIABLE'], ['Mon Sep 28 21:00:00 2026', 'RELEASE_EVIDENCE_UNVERIFIABLE']]) {
    const f = await fixture({ handle: `${LIVE_PID}:${START}`, deps: observed({ [LIVE_PID]: state }) });
    const before = bytes(f.dir);
    await assert.rejects(f.cleanup({ evidence: 'IDENTITY_REPLACED' }), { code }, state);
    assert.deepEqual(bytes(f.dir), before, `${code} writes nothing`);
  }
  const none = await fixture({ deps: observed({}) });
  await assert.rejects(none.cleanup({ evidence: 'IDENTITY_DEAD' }), { code: 'RELEASE_EVIDENCE_REFUTED' }, 'no identity to be dead');
});

test('#214 hook and absence declarations need their durable evidence, and an alive identity overrides them', async () => {
  const receipt = await fixture({ closures: [{ ownerSessionId: OWNER }], deps: observed({}) });
  assert.equal((await receipt.cleanup({ evidence: 'OWNER_RUNTIME_CLOSED' })).verification.method, 'closure-receipt');
  const noReceipt = await fixture({ deps: observed({}) });
  await assert.rejects(noReceipt.cleanup({ evidence: 'OWNER_RUNTIME_CLOSED' }), { code: 'RELEASE_EVIDENCE_REFUTED' });
  const confirmed = await fixture({ sidecar: { phase: 'closed-confirmed' }, deps: observed({}) });
  assert.equal((await confirmed.cleanup({ evidence: 'CLOSED_CONFIRMED' })).verification.method, 'sidecar');
  const notSpawned = await fixture({ spawnEvidence: true, deps: observed({}) });
  assert.equal((await notSpawned.cleanup({ evidence: 'NOT_SPAWNED' })).verification.method, 'sidecar-absence');
  const aliveHook = await fixture({ handle: `${LIVE_PID}:${START}`, closures: [{ ownerSessionId: OWNER }], deps: observed({ [LIVE_PID]: START }) });
  await assert.rejects(aliveHook.cleanup({ evidence: 'OWNER_RUNTIME_CLOSED' }), { code: 'RELEASE_TARGET_ALIVE' });
  // A true declaration is accepted even if another reason now has priority (an unknown
  // start time at the loop, a readable replacement at the writer).
  const both = await fixture({ handle: `${LIVE_PID}:${START}`, closures: [{ ownerSessionId: OWNER }], deps: observed({ [LIVE_PID]: 'Mon Sep 28 12:00:07 2026' }) });
  assert.equal((await both.cleanup({ evidence: 'OWNER_RUNTIME_CLOSED' })).verification.status, 'verified');
  const foreign = await fixture({ sidecar: { phase: 'closed-confirmed', generation: 99 }, deps: observed({}) });
  await assert.rejects(foreign.cleanup({ evidence: 'CLOSED_CONFIRMED' }), { code: 'RELEASE_EVIDENCE_REFUTED' }, 'a foreign tuple is never evidence');
});

test('#214 a legacy release needs the writer’s own clean runtime scan', async () => {
  for (const [scan, expected] of [[{ status: 'clean' }, 'verified'], [{ status: 'candidates', candidates: [{ pid: 7, cwd: '/tmp/ai-holdem-coach-x' }] }, 'RELEASE_EVIDENCE_REFUTED'], [{ status: 'unavailable', reason: 'LSOF_MISSING' }, 'RELEASE_EVIDENCE_UNVERIFIABLE']]) {
    let scans = 0;
    const f = await fixture({ deps: { ...observed({}), scanRuntimeProcesses: async () => { scans += 1; return scan; } } });
    if (expected === 'verified') assert.equal((await f.cleanup({ evidence: 'LEGACY_NO_RUNTIME_PROCESS' })).verification.method, 'process-scan');
    else await assert.rejects(f.cleanup({ evidence: 'LEGACY_NO_RUNTIME_PROCESS' }), { code: expected });
    assert.equal(scans, 1);
  }
});

test('#214 the operator path records what it could observe and never releases a live identity', async () => {
  const unknown = await fixture({ handle: `${LIVE_PID}:${START}`, deps: observed({ [LIVE_PID]: 'unknown' }) });
  assert.deepEqual((await unknown.cleanup({ operatorConfirmed: true })).verification.status, 'unverified');
  const dead = await fixture({ handle: `${DEAD_PID}:${START}`, deps: observed({ [DEAD_PID]: 'dead' }) });
  assert.equal((await dead.cleanup({ operatorConfirmed: true })).verification.method, 'identity');
  const alive = await fixture({ handle: `${LIVE_PID}:${START}`, deps: observed({ [LIVE_PID]: START }) });
  await assert.rejects(alive.cleanup({ operatorConfirmed: true }), { code: 'RELEASE_TARGET_ALIVE' });
  // Conflicting identities: the authority one is dead but the tuple-matched sidecar one lives.
  const conflict = await fixture({
    handle: `${DEAD_PID}:${START}`, sidecar: { phase: 'identity', pid: LIVE_PID, startTime: START },
    deps: observed({ [DEAD_PID]: 'dead', [LIVE_PID]: START }),
  });
  await assert.rejects(conflict.cleanup({ operatorConfirmed: true }), { code: 'RELEASE_TARGET_ALIVE' });
  const bothDead = await fixture({
    handle: `${DEAD_PID}:${START}`, sidecar: { phase: 'identity', pid: DEAD_PID - 1, startTime: START },
    deps: observed({ [DEAD_PID]: 'dead', [DEAD_PID - 1]: 'dead' }),
  });
  const verification = (await bothDead.cleanup({ operatorConfirmed: true })).verification;
  assert.equal(verification.status, 'unverified', 'an unresolved conflict is never recorded as verified');
  assert.equal(verification.observed.conflict, true);
});

test('#214 identity probes run outside the publish lock and a row changed meanwhile is refused', async () => {
  let dir;
  const f = await fixture({
    handle: `${DEAD_PID}:${START}`,
    deps: {
      processAlive: () => {
        assert.equal(fs.existsSync(path.join(dir, 'publish.lock.d')), false, 'no probe under the publish lock');
        const authority = authorityOf(dir);
        authority.retiredAttempts.at(-1).acceptEvidence = 'closed-child';
        fs.writeFileSync(path.join(dir, '.coach-authority.json'), JSON.stringify(authority));
        return false;
      },
      processStartTime: () => START,
    },
  });
  dir = f.dir;
  await assert.rejects(f.cleanup({ evidence: 'IDENTITY_DEAD' }), { code: 'ROW_CHANGED' });
});

test('#214 D6 released is terminal: a repeat is idempotent and other states are refused', async () => {
  const f = await fixture({ handle: `${DEAD_PID}:${START}`, deps: observed({ [DEAD_PID]: 'dead' }) });
  await f.cleanup({ evidence: 'IDENTITY_DEAD' });
  const before = bytes(f.dir);
  const again = await f.cleanup({ evidence: 'IDENTITY_DEAD' });
  assert.equal(again.idempotent, true);
  assert.deepEqual(bytes(f.dir), before);
  await assert.rejects(f.cc.recordCleanup({ gameDir: f.dir, owner: OWNER, handNo: 1, generation: f.generation, cleanupState: 'pending' }), { code: 'ALREADY_RELEASED' });
});

test('#216 a failed trace append never fails the committed release; the next operation mirrors it once', async () => {
  let failAppend = true;
  const real = createCoachControl();
  const f = await fixture({
    handle: `${DEAD_PID}:${START}`,
    deps: { ...observed({ [DEAD_PID]: 'dead' }), appendTrace: (dir, row) => {
      if (failAppend) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      fs.appendFileSync(path.join(dir, TRACE), `${JSON.stringify(row)}\n`);
    } },
  });
  const tracedBefore = traceRows(f.dir).length;
  const result = await f.cleanup({ evidence: 'IDENTITY_DEAD' });
  assert.equal(result.ok, true);
  assert.equal(result.audit, 'pending');
  const authority = authorityOf(f.dir);
  const auditId = authority.retiredAttempts.at(-1).release.auditId;
  assert.deepEqual(authority.traceOutbox.map((entry) => entry.auditId), [auditId]);
  assert.equal(traceRows(f.dir).length, tracedBefore);
  // The next persisting operation (from any writer) mirrors the pending row exactly once.
  failAppend = false;
  await real.adapterDisable({ gameDir: f.dir, owner: OWNER, reason: 'test' });
  await real.adapterDisable({ gameDir: f.dir, owner: OWNER, reason: 'test-again' });
  const mirrored = traceRows(f.dir).filter((row) => row.auditId === auditId);
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].verification.status, 'verified');
  assert.equal(authorityOf(f.dir).traceOutbox?.some((entry) => entry.auditId === auditId) ?? false, false);
});

test('#216 a row already appended before a crash is not mirrored twice, and a torn line is isolated', async () => {
  const f = await fixture({ handle: `${DEAD_PID}:${START}`, deps: observed({ [DEAD_PID]: 'dead' }) });
  await f.cleanup({ evidence: 'IDENTITY_DEAD' });
  const auditId = authorityOf(f.dir).retiredAttempts.at(-1).release.auditId;
  // Crash after the append but before any outbox cleanup: the outbox still names the row.
  assert.equal(authorityOf(f.dir).traceOutbox.length, 1);
  fs.appendFileSync(path.join(f.dir, TRACE), '{"torn":');
  const cc = createCoachControl();
  await cc.adapterDisable({ gameDir: f.dir, owner: OWNER, reason: 'after-crash' });
  const rows = traceRows(f.dir);
  assert.equal(rows.filter((row) => row.auditId === auditId).length, 1);
  assert.equal(rows.at(-1).operation, 'adapter-disable', 'the next row starts on its own line');
  assert.equal(fs.readFileSync(path.join(f.dir, TRACE), 'utf8').includes('{"torn":\n'), true);
});

test('#216 legacy releases stay unrecorded and a missing lock.json is NO_LOCK', async () => {
  const f = await fixture({ deps: observed({}) });
  const authority = authorityOf(f.dir);
  authority.retiredAttempts.at(-1).cleanupState = 'released';
  fs.writeFileSync(path.join(f.dir, '.coach-authority.json'), JSON.stringify(authority));
  const before = traceRows(f.dir).length;
  await createCoachControl().adapterDisable({ gameDir: f.dir, owner: OWNER, reason: 'x' });
  assert.equal(traceRows(f.dir).filter((row) => row.operation === 'cleanup-result').length, 0, 'no synthetic audit row for an old release');
  assert.equal(traceRows(f.dir).length, before + 1);
  assert.equal('release' in authorityOf(f.dir).retiredAttempts.at(-1), false);
  fs.rmSync(path.join(f.dir, 'lock.json'));
  await assert.rejects(f.cleanup({ operatorConfirmed: true }), { code: 'NO_LOCK' });
});

test('#215 the server-lock observation distinguishes absent, invalid, foreign, unverified and authenticated', () => {
  const now = () => new Date('2026-09-29T00:00:00.000Z');
  const verified = { pid: 4242, startTime: START, port: 8877, sessionToken: TOKEN };
  const lock = { serverPid: 4242, port: 8877, sessionToken: TOKEN };
  const base = { expectedToken: TOKEN, bindingVerified: verified, processAlive: () => true, startTimeOf: () => START, now };
  const state = (overrides) => deriveServerLockObservation({ ...base, readLock: () => lock, ...overrides }).state;
  assert.equal(state({ readLock: () => null }), 'absent');
  assert.equal(state({ readLock: () => { throw Object.assign(new Error('bad'), { code: 'BAD_SERVER_LOCK' }); } }), 'invalid');
  assert.equal(state({ readLock: () => ({ ...lock, sessionToken: 'other' }) }), 'foreign');
  assert.equal(state({}), 'authenticated');
  assert.equal(state({ bindingVerified: null }), 'unverified', 'this instance never verified a binding');
  assert.equal(state({ readLock: () => ({ ...lock, port: 9999 }) }), 'unverified', 'a different port was never verified');
  assert.equal(state({ readLock: () => ({ ...lock, serverPid: 4243 }) }), 'unverified');
  assert.equal(state({ processAlive: () => false }), 'unverified', 'the verified relay has since exited');
  assert.equal(state({ startTimeOf: () => 'Mon Sep 28 13:00:07 2026' }), 'unverified', 'the pid now belongs to another process');
  assert.deepEqual(deriveServerLockObservation({ ...base, readLock: () => lock }), { state: 'authenticated', serverPid: 4242, observedAt: '2026-09-29T00:00:00.000Z' });
});
