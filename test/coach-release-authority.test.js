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
import { compareStartTimes, observeRecordedIdentity, rowIdentities } from '../tools/coach-evidence.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'tok-coach-release';
const DEAD_PID = 4_194_303;
const LIVE_PID = process.pid;
const START = 'Mon Sep 28 12:00:00 2026';
const TRACE = '.coach-adapter-trace.jsonl';
// `ps -o lstart=` text for an instant in this process's zone (C locale).
function lstart(ms) {
  const d = new Date(ms), two = (n) => String(n).padStart(2, '0');
  return `${'SunMonTueWedThuFriSat'.slice(d.getDay() * 3, d.getDay() * 3 + 3)} ${'JanFebMarAprMayJunJulAugSepOctNovDec'.slice(d.getMonth() * 3, d.getMonth() * 3 + 3)} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

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

// The writer's observations, pinned to POSIX so these POSIX-format handles mean the same on
// every CI platform (r5: on win32 only the canonical UTC reading is evidence).
const observed = (states, { platform = 'darwin' } = {}) => ({
  processAlive: (pid) => states[pid] !== 'dead',
  processStartTime: (pid) => states[pid] === 'unknown' ? null : (states[pid] ?? START),
  platform,
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

  // A 9 h zone-less difference is ambiguous on POSIX (pinned so every CI platform runs it).
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

// r4: when a foreign sidecar tuple or an identity conflict coincides with a live identity, the
// declared-evidence path refutes first (the loop's Step 0 order) and the operator path refuses
// the live identity first. Neither writes anything.
test('#214 refusal precedence: tuple mismatch or conflict with a live identity', async () => {
  const cases = [
    ['tuple mismatch', { handle: `${LIVE_PID}:${START}`, sidecar: { phase: 'closed-confirmed', generation: 99 }, deps: observed({ [LIVE_PID]: START }) }],
    ['conflict', { handle: `${LIVE_PID}:${START}`, sidecar: { phase: 'identity', pid: DEAD_PID, startTime: START }, deps: observed({ [LIVE_PID]: START, [DEAD_PID]: 'dead' }) }],
  ];
  for (const [label, shape] of cases) {
    for (const [fields, code] of [[{ evidence: 'IDENTITY_DEAD' }, 'RELEASE_EVIDENCE_REFUTED'], [{ evidence: 'CLOSED_CONFIRMED' }, 'RELEASE_EVIDENCE_REFUTED'], [{ operatorConfirmed: true }, 'RELEASE_TARGET_ALIVE']]) {
      const f = await fixture(shape);
      const before = bytes(f.dir);
      await assert.rejects(f.cleanup(fields), { code }, `${label} ${JSON.stringify(fields)}`);
      assert.deepEqual(bytes(f.dir), before, `${label}: a refusal writes nothing`);
    }
  }
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

test('#214 D4a start-time comparison: unparseable is unknown, win32 ticks are exact, POSIX zone steps are ambiguous', () => {
  const tick = '2026-09-28T03:00:00.1234567Z';
  assert.equal(compareStartTimes(tick, tick, { platform: 'win32' }), 'same');
  assert.equal(compareStartTimes('2026-09-28T03:00:00.123Z', '2026-09-28T03:00:00.1230000Z', { platform: 'win32' }), 'same', 'the same tick with fewer digits');
  // r4: 100 ns apart inside one millisecond is another process.
  assert.equal(compareStartTimes('2026-09-28T03:00:00.0000001Z', '2026-09-28T03:00:00.0000002Z', { platform: 'win32' }), 'different');
  assert.equal(compareStartTimes(tick, '2026-09-28T03:00:00.1239999Z', { platform: 'win32' }), 'different');
  assert.equal(compareStartTimes('2026-09-28T03:00:07.000Z', tick, { platform: 'win32' }), 'different');
  // Only the canonical UTC reading the engine records is evidence; anything else proves nothing.
  for (const other of ['garbage', '2026-09-28T12:00:00.1234567+09:00', `${tick}0`, 'Mon Sep 28 12:00:00 2026']) {
    assert.equal(compareStartTimes(other, tick, { platform: 'win32' }), 'unknown', other);
    assert.equal(compareStartTimes(other, other, { platform: 'win32' }), 'unknown', `${other} twice`);
  }
  assert.equal(compareStartTimes(START, START, { platform: 'darwin' }), 'same');
  assert.equal(compareStartTimes(START, 'Mon Sep 28 12:00:07 2026', { platform: 'darwin' }), 'different');
  for (const hours of [1, 9, 19, 26]) {
    assert.equal(compareStartTimes(START, lstart(Date.parse(START) + hours * 3_600_000), { platform: 'linux' }), 'unknown', `${hours} h`);
  }
  assert.equal(compareStartTimes(START, lstart(Date.parse(START) + 27 * 3_600_000), { platform: 'linux' }), 'different', 'beyond any zone pair');
  // r4: equal unparseable text is still unknown, and different text at the same parsed instant
  // (a DST fold such as 02:30 and 03:30 on a spring-forward night) is never 'same'.
  assert.equal(compareStartTimes(START, 'not a time', { platform: 'linux' }), 'unknown');
  assert.equal(compareStartTimes('not a time', 'not a time', { platform: 'linux' }), 'unknown');
  const sameInstant = new Date(Date.parse(START)).toISOString();
  assert.notEqual(sameInstant, START);
  assert.equal(compareStartTimes(START, sameInstant, { platform: 'darwin' }), 'unknown');
  // r5: `ps lstart` follows the locale. Identical localized readings are the same process;
  // text that is not a timestamp never is.
  for (const local of ['Mo 28 Sep 12:00:00 2026', '월  9 28 12:00:00 2026', 'lun. 28 sept. 12:00:00 2026']) {
    assert.equal(compareStartTimes(local, local, { platform: 'linux' }), 'same', local);
  }
  for (const junk of ['', '-', 'null', '12:00:00', 'garbage 2026']) {
    assert.equal(compareStartTimes(junk, junk, { platform: 'linux' }), 'unknown', JSON.stringify(junk));
  }
});

// r5: the writer's verdicts with canonical Win32 readings, as a Windows store records them.
test('#214 win32 writer: alive, replaced and refusal precedence with UTC tick handles', async () => {
  const TICK = '2026-09-28T03:00:00.1234567Z';
  const win = (states) => observed(Object.fromEntries(Object.entries(states).map(([pid, v]) => [pid, v === 'live' ? TICK : v])), { platform: 'win32' });
  const replaced = await fixture({ handle: `${LIVE_PID}:${TICK}`, deps: win({ [LIVE_PID]: '2026-09-28T03:00:00.1234568Z' }) });
  assert.equal((await replaced.cleanup({ evidence: 'IDENTITY_REPLACED' })).verification.status, 'verified', '100 ns later is another process');
  const alive = await fixture({ handle: `${LIVE_PID}:${TICK}`, deps: win({ [LIVE_PID]: 'live' }) });
  await assert.rejects(alive.cleanup({ evidence: 'IDENTITY_DEAD' }), { code: 'RELEASE_TARGET_ALIVE' });
  await assert.rejects(alive.cleanup({ operatorConfirmed: true }), { code: 'RELEASE_TARGET_ALIVE' });
  const posixText = await fixture({ handle: `${LIVE_PID}:${START}`, deps: win({ [LIVE_PID]: START }) });
  await assert.rejects(posixText.cleanup({ evidence: 'IDENTITY_DEAD' }), { code: 'RELEASE_EVIDENCE_UNVERIFIABLE' }, 'non-canonical text proves nothing on win32');
  const mismatch = await fixture({ handle: `${LIVE_PID}:${TICK}`, sidecar: { phase: 'closed-confirmed', generation: 99 }, deps: win({ [LIVE_PID]: 'live' }) });
  await assert.rejects(mismatch.cleanup({ evidence: 'CLOSED_CONFIRMED' }), { code: 'RELEASE_EVIDENCE_REFUTED' });
  const mismatch2 = await fixture({ handle: `${LIVE_PID}:${TICK}`, sidecar: { phase: 'closed-confirmed', generation: 99 }, deps: win({ [LIVE_PID]: 'live' }) });
  await assert.rejects(mismatch2.cleanup({ operatorConfirmed: true }), { code: 'RELEASE_TARGET_ALIVE' });
});

// #247: coach handles record the owned start time: no time zone, compared exactly.
const OWNED = {
  utc: 'utc-v1:Mon Sep 28 12:00:00 2026',
  win32: 'win32-v1:2026-09-28T03:00:00.1234567Z',
};
test('#247 owned start times: equal is the same process, unequal is a replacement only where the start time is fixed', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const value of Object.values(OWNED)) {
      assert.equal(compareStartTimes(value, value, { platform }), 'same', `${value} on ${platform}`);
    }
    // A Windows creation FILETIME never moves: 100 ns later is another process.
    assert.equal(compareStartTimes(OWNED.win32, 'win32-v1:2026-09-28T03:00:00.1234568Z', { platform }), 'different');
    for (const [a, b] of [
      [OWNED.utc, OWNED.win32], [OWNED.win32, OWNED.utc], [OWNED.utc, START], [START, OWNED.utc],
      [OWNED.win32, '2026-09-28T03:00:00.1234567Z'], ['utc-v1:garbage', 'utc-v1:garbage'],
      ['win32-v1:2026-09-28T03:00:00.123Z', 'win32-v1:2026-09-28T03:00:00.123Z'],
    ]) {
      assert.equal(compareStartTimes(a, b, { platform }), 'unknown', `${a} vs ${b} on ${platform}`);
    }
  }
  // macOS keeps the start time taken at fork: another reading is another process, whole hours
  // apart included (the reading has no zone to explain them).
  assert.equal(compareStartTimes(OWNED.utc, 'utc-v1:Mon Sep 28 12:00:07 2026', { platform: 'darwin' }), 'different');
  assert.equal(compareStartTimes(OWNED.utc, 'utc-v1:Mon Sep 28 13:00:00 2026', { platform: 'darwin' }), 'different');
  // Linux derives it from the boot time, which follows clock steps: a mismatch proves nothing.
  assert.equal(compareStartTimes(OWNED.utc, 'utc-v1:Mon Sep 28 12:00:07 2026', { platform: 'linux' }), 'unknown');
  assert.equal(compareStartTimes(OWNED.utc, 'utc-v1:Mon Sep 28 13:00:00 2026', { platform: 'linux' }), 'unknown');
});

test('#247 a changed zone and a reused pid never make an owned handle alive', () => {
  const calls = { legacy: 0, owned: 0 };
  // Recorded at 12:00 UTC. The pid now belongs to a process that started at 13:00 UTC; the
  // legacy reader, an hour behind, prints the text a legacy record would have, but an owned
  // record never asks it.
  const legacyReader = () => { calls.legacy += 1; return START; };
  const ownedReader = () => { calls.owned += 1; return 'utc-v1:Mon Sep 28 13:00:00 2026'; };
  const observe = (startTime, readers, platform = 'darwin') => observeRecordedIdentity({ pid: LIVE_PID, startTime }, {
    processAlive: () => true, platform, ...readers,
  });
  assert.equal(observe(OWNED.utc, { startTimeOf: legacyReader, ownedStartTimeOf: ownedReader }), 'replaced');
  assert.equal(observe(OWNED.utc, { startTimeOf: legacyReader, ownedStartTimeOf: ownedReader }, 'linux'), 'unknown',
    'on Linux it is not alive either, and nothing is released on its strength');
  assert.deepEqual(calls, { legacy: 0, owned: 2 });
  assert.equal(observe(OWNED.utc, { startTimeOf: legacyReader }), 'unknown', 'without the owned reader it is never alive');
  assert.equal(observe(OWNED.utc, { startTimeOf: legacyReader, ownedStartTimeOf: () => null }), 'unknown');
  for (const platform of ['linux', 'darwin']) {
    assert.equal(observe(OWNED.utc, { startTimeOf: legacyReader, ownedStartTimeOf: () => OWNED.utc }, platform), 'alive');
  }
  assert.equal(observe(OWNED.win32, { startTimeOf: legacyReader, ownedStartTimeOf: () => OWNED.utc }), 'unknown', 'another kind proves nothing');
  // A legacy record keeps its reader and its rules (#214 D4a).
  calls.legacy = 0; calls.owned = 0;
  assert.equal(observe(START, { startTimeOf: legacyReader, ownedStartTimeOf: ownedReader }), 'alive');
  assert.deepEqual(calls, { legacy: 1, owned: 0 });
  assert.equal(observeRecordedIdentity({ pid: DEAD_PID, startTime: OWNED.utc }, {
    processAlive: () => false, startTimeOf: legacyReader, ownedStartTimeOf: ownedReader,
  }), 'dead');
});

test('#247 an authority handle and a sidecar identity in different forms are a conflict', () => {
  for (const [authority, sidecar] of [[OWNED.utc, START], [START, OWNED.utc], [OWNED.win32, OWNED.utc]]) {
    const ids = rowIdentities({ agentHandle: `${LIVE_PID}:${authority}` }, { phase: 'identity', data: { pid: LIVE_PID, startTime: sidecar } });
    assert.equal(ids.conflict, true, `${authority} vs ${sidecar}`);
  }
  const same = rowIdentities({ agentHandle: `${LIVE_PID}:${OWNED.utc}` }, { phase: 'identity', data: { pid: LIVE_PID, startTime: OWNED.utc } });
  assert.equal(same.conflict, false);
  assert.deepEqual(same.selected, { pid: LIVE_PID, startTime: OWNED.utc }, 'the whole owned value survives the handle parser');
});

test('#247 writer: owned handles are alive, replaced or unverifiable by the owned reader alone', async () => {
  const deps = (current, platform = 'darwin') => ({
    processAlive: () => true,
    processStartTime: () => { throw new Error('an owned handle must not read the legacy start time'); },
    ownedProcessStartTime: () => current,
    platform,
  });
  const alive = await fixture({ handle: `${LIVE_PID}:${OWNED.utc}`, deps: deps(OWNED.utc) });
  await assert.rejects(alive.cleanup({ evidence: 'IDENTITY_DEAD' }), { code: 'RELEASE_TARGET_ALIVE' });
  await assert.rejects(alive.cleanup({ operatorConfirmed: true }), { code: 'RELEASE_TARGET_ALIVE' });
  const replaced = await fixture({ handle: `${LIVE_PID}:${OWNED.win32}`, deps: deps('win32-v1:2026-09-28T03:00:07.1234567Z', 'win32') });
  assert.equal((await replaced.cleanup({ evidence: 'IDENTITY_REPLACED' })).verification.status, 'verified');
  const linux = await fixture({ handle: `${LIVE_PID}:${OWNED.utc}`, deps: deps('utc-v1:Mon Sep 28 12:00:07 2026', 'linux') });
  await assert.rejects(linux.cleanup({ evidence: 'IDENTITY_REPLACED' }), { code: 'RELEASE_EVIDENCE_UNVERIFIABLE' },
    'a Linux mismatch is no proof of replacement');
  const unreadable = await fixture({ handle: `${LIVE_PID}:${OWNED.win32}`, deps: deps(null, 'win32') });
  await assert.rejects(unreadable.cleanup({ evidence: 'IDENTITY_REPLACED' }), { code: 'RELEASE_EVIDENCE_UNVERIFIABLE' });
});

test('#216 trace rows stay FIFO: while an earlier row waits, a new one waits behind it', async () => {
  let failing = true;
  const appended = [];
  const appendTrace = (dir, row) => {
    if (failing && row.operation === 'cleanup-result') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    appended.push(row.operation);
    fs.appendFileSync(path.join(dir, TRACE), `${JSON.stringify(row)}\n`);
  };
  const f = await fixture({ handle: `${DEAD_PID}:${START}`, deps: { ...observed({ [DEAD_PID]: 'dead' }), appendTrace } });
  appended.length = 0;
  assert.equal((await f.cleanup({ evidence: 'IDENTITY_DEAD' })).audit, 'pending');
  // The next operation's flush fails again for the release row; its own row must not overtake.
  const disabled = await f.cc.adapterDisable({ gameDir: f.dir, owner: OWNER, reason: 'later' });
  assert.equal(disabled.audit, 'pending');
  assert.deepEqual(appended, []);
  failing = false;
  await f.cc.adapterDisable({ gameDir: f.dir, owner: OWNER, reason: 'flush' });
  const order = traceRows(f.dir).map((row) => row.operation).slice(-3);
  assert.deepEqual(order, ['cleanup-result', 'adapter-disable', 'adapter-disable']);
  assert.equal(authorityOf(f.dir).traceOutbox?.length ?? 0, 1, 'the last row waits only for the next flush to confirm it');
});

test('#216 a bind-handle append failure never fails the committed bind', async () => {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ serverPid: process.pid, port: 8877, sessionToken: TOKEN, startedAt: new Date().toISOString() }));
  writeJsonAtomic(path.join(dir, 'ui-snapshot.json'), { revision: 1, view: null, log: [], coach: [] });
  writeJsonAtomic(path.join(dir, 'stats.json'), { perPlayer: { user: { sample: 0, vpip: 0 } } });
  const cc = createCoachControl({ appendTrace: () => { throw new Error('EIO'); } });
  const reserved = await cc.reserve({ gameDir: dir, owner: OWNER, handNo: 1, statsFile: path.join(dir, 'stats.json'), snapshotFile: path.join(dir, 'ui-snapshot.json') });
  const bound = await cc.bindHandle({ gameDir: dir, owner: OWNER, handNo: 1, generation: reserved.generation, handle: `${DEAD_PID}:${START}` });
  assert.deepEqual(bound, { ok: true, audit: 'pending' });
  assert.equal(authorityOf(dir).hands['1'].agentHandle, `${DEAD_PID}:${START}`);
  assert.equal(authorityOf(dir).traceOutbox[0].operation, 'bind-handle');
});
