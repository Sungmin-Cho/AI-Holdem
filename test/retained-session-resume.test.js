// #273: a game whose cleanup could not be confirmed stays owned by the app (it may still have
// children), the lobby offers 불러오기 for it, and that command has to do what it says: re-check
// the cleanup, relaunch only after it is confirmed, and report a concrete failure otherwise —
// never record a no-op as success. The real session manager, loop, relay and engine run; the
// LLM player and the child whose close is unconfirmed are the only stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createGameLoop } from '../tools/game-loop.js';
import { createSessionManager } from '../tools/session-manager.js';
import { createTrainingControl } from '../tools/training-control.js';
import * as pipeline from '../tools/training-pipeline.js';
import { gameEpochOf } from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import { decisionAssistance } from '../shared/assistance.js';
import { dealSelectionFields } from '../shared/deal-selection.js';
import { q3Evaluation } from './helpers/q3-fixtures.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import {
  TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES,
  makeAdapter,
  postUserAction,
  preferredUserAction,
  putAiFirst,
  resolverFor,
  startRun,
  tmpGame,
} from './helpers/game-loop-fixtures.mjs';
import { projectPublicCode } from '../tools/diagnostic-codes.js';

const TIMEOUT = process.platform === 'win32' ? 300000 : 40000;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The fixture child's pid 4242 can only reach a snapshot with its label: its `details` serialize as
// `"pid":4242` and a formatted message reads `pid: 4242`. A bare `4242` also turns up inside the
// snapshot's random hex identifiers (gameEpoch, UUIDs), which made the whole-snapshot check flaky (#319).
const PID_LEAK = /"pid":4242|pid: 4242/;

const cas = (manager, kind) => {
  const s = manager.snapshot();
  return {
    requestId: randomUUID(), kind, expectedInstanceId: s.instanceId, expectedAppRevision: s.appRevision,
    expectedGameId: s.gameId, expectedSelectionVersion: s.selectionVersion,
  };
};
const settle = async (manager, id) => {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const row = manager.receipt(id);
    if (row.status !== 'accepted') return row;
    await sleep(20);
  }
  throw new Error('receipt timeout');
};
const until = async (probe, label) => {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timeout: ${label}`);
};

// The player fails fatally on its first decision (the run ends), and the adapter's disposal —
// the stand-in for a child whose close cannot be confirmed — fails until `closeNow` is called.
function fixture(t, { failFirstDecision = true, runCode = 'CHILD_SIGNAL_FAILED', closeCode = 'CHILD_CLOSE_UNCONFIRMED' } = {}) {
  const events = [];
  const state = { closes: false, decisions: 0 };
  const adapter = {
    kind: 'claude',
    runtimeHomeId: null,
    disposeConfirmsChildren: true,
    async warmup({ playerId }) { return { sessionId: `s-${playerId}`, raw: 'ready' }; },
    async decide(input) {
      state.decisions += 1;
      events.push(`decide#${state.decisions}`);
      if (failFirstDecision && state.decisions === 1) {
        throw Object.assign(new Error('signal'), { code: runCode });
      }
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
    async dispose() {
      const ok = state.closes;
      events.push(ok ? 'dispose:confirmed' : 'dispose:unconfirmed');
      if (!ok) throw Object.assign(new Error('close'), { code: closeCode, details: { pid: 4242, closeConfirmed: false } });
    },
  };
  let resolves = 0;
  const resolver = async () => { resolves += 1; events.push(`resolver#${resolves}`); return { player: adapter, upper: adapter, notices: [] }; };
  const storeDir = createOwnedTempDir('retained-resume');
  const manager = createSessionManager({ storeDir, resolver });
  t.after(async () => { state.closes = true; await manager.close().catch(() => {}); });
  return { manager, events, state, adapter, storeDir, resolves: () => resolves };
}

// Starts an LLM game and drives it until the player's decision fails fatally and the app is
// left in `error` holding the retained session.
async function reachRetainedError(f) {
  await f.manager.initialize();
  const start = { ...cas(f.manager, 'start'), setup: { mode: 'cash-training', aiCount: 1, opponentRuntime: 'llm', hints: 'off', dealBias: 'off' } };
  f.manager.command(start);
  assert.equal((await settle(f.manager, start.requestId)).status, 'succeeded');
  let posted = false;
  await until(async () => {
    if (f.manager.snapshot().state === 'error') return true;
    if (posted || f.state.decisions > 0) return false;
    // The user may be first to act; the AI decides only after that.
    try {
      const dir = f.manager.current.sessionDir;
      const lock = readJson(path.join(dir, 'lock.json'));
      const snap = await (await fetch(`http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`)).json();
      if (snap.view?.legal?.toAct === 'user') {
        posted = true;
        await postUserAction(lock, preferredUserAction(snap.view.legal));
      }
    } catch { /* not up yet */ }
    return false;
  }, 'the failed decision ends the run');
  const snapshot = f.manager.snapshot();
  assert.equal(snapshot.state, 'error');
  return snapshot;
}

test('a retained failed session keeps both failures, offers 불러오기, and resume fails closed while the close stays unconfirmed', { timeout: TIMEOUT }, async (t) => {
  const f = fixture(t);
  const snapshot = await reachRetainedError(f);

  assert.equal(snapshot.error, 'CHILD_CLOSE_UNCONFIRMED', 'the cleanup failure is the state\'s error');
  assert.deepEqual(snapshot.errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'CHILD_CLOSE_UNCONFIRMED', rejection: null });
  assert.deepEqual(snapshot.allowedCommands, ['resume']);
  assert.ok(f.manager.session, 'ownership stays with the retained session');
  const dir = f.manager.current.sessionDir;
  const persisted = readJson(path.join(dir, 'loop-state.json')).cleanupError;
  assert.equal(persisted.code, 'CHILD_CLOSE_UNCONFIRMED');
  assert.deepEqual(persisted.runError, { code: 'CHILD_SIGNAL_FAILED' }, 'the persisted diagnostics keep the original run failure');
  assert.equal(PID_LEAK.test(JSON.stringify(snapshot)), false, 'no pid or message reaches the host snapshot');
  const resolvesBefore = f.resolves();

  const resume = cas(f.manager, 'resume');
  f.manager.command(resume);
  const row = await settle(f.manager, resume.requestId);

  assert.equal(row.status, 'failed', 'a resume that changed nothing is not a success');
  assert.equal(row.error, 'CHILD_CLOSE_UNCONFIRMED');
  const after = f.manager.snapshot();
  assert.equal(after.state, 'error');
  assert.equal(after.error, 'CHILD_CLOSE_UNCONFIRMED');
  assert.deepEqual(after.errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'CHILD_CLOSE_UNCONFIRMED', rejection: null });
  assert.deepEqual(after.allowedCommands, ['resume'], 'the recovery path stays offered');
  assert.ok(f.manager.session, 'still retained');
  assert.equal(f.resolves(), resolvesBefore, 'no replacement work starts while the close is unconfirmed');
  assert.equal(fs.existsSync(path.join(f.storeDir, 'loop.lock.d')), true, 'the loop lock is still held');
  assert.equal(f.events.filter((e) => e === 'dispose:unconfirmed').length >= 2, true, 'the cleanup was re-attempted, not replayed');
  const refreshed = readJson(path.join(dir, 'loop-state.json'));
  assert.deepEqual(refreshed.cleanupError.runError, { code: 'CHILD_SIGNAL_FAILED' }, 'a failed retry keeps the original run failure too');
  assert.equal(refreshed.cleanupError.code, 'CHILD_CLOSE_UNCONFIRMED');
});

test('once the close is confirmed, resume confirms cleanup first, then relaunches and plays', { timeout: TIMEOUT }, async (t) => {
  const f = fixture(t);
  await reachRetainedError(f);
  const retained = f.manager.session;
  const resolvesBefore = f.resolves();
  f.state.closes = true; // the child closed late

  const resume = cas(f.manager, 'resume');
  f.manager.command(resume);
  const row = await settle(f.manager, resume.requestId);

  assert.equal(row.status, 'succeeded', row.error);
  const after = f.manager.snapshot();
  assert.notEqual(after.state, 'error');
  assert.equal(after.error, null);
  assert.equal(after.errorDetail, null);
  assert.notEqual(f.manager.session, retained, 'a new loop owns the game');
  assert.equal(f.resolves(), resolvesBefore + 1);
  // Order: confirmed disposal strictly before the replacement's runtime resolution.
  const confirmed = f.events.indexOf('dispose:confirmed');
  assert.ok(confirmed >= 0 && f.events.indexOf(`resolver#${resolvesBefore + 1}`) > confirmed, f.events.join(','));
  assert.ok(['playing', 'paused', 'finalizing'].includes(row.result.state), `receipt result ${row.result.state}`);
  // The recorded outcome and the app agree: no error left behind a succeeded receipt.
  assert.equal(row.result.error, null);
});

test('a second resume while the first is settling is refused, not run twice', { timeout: TIMEOUT }, async (t) => {
  const f = fixture(t);
  await reachRetainedError(f);
  f.state.closes = true;
  const first = cas(f.manager, 'resume');
  f.manager.command(first);
  const second = cas(f.manager, 'resume');
  assert.throws(() => f.manager.command(second), (error) => error.code === 'COMMAND_PENDING' || error.code === 'STALE_APP');
  assert.equal((await settle(f.manager, first.requestId)).status, 'succeeded');
  assert.equal(f.events.filter((e) => e === 'dispose:confirmed').length >= 1, true);
});

test('shutdown while the cleanup is still unconfirmed reports it and keeps ownership', { timeout: TIMEOUT }, async (t) => {
  const f = fixture(t);
  await reachRetainedError(f);
  const lock = path.join(f.storeDir, 'loop.lock.d');
  await assert.rejects(f.manager.close(), (error) => error.code === 'CHILD_CLOSE_UNCONFIRMED');
  assert.equal(fs.existsSync(lock), true, 'ownership is kept for the next attempt');
  f.state.closes = true;
  await f.manager.close();
  assert.equal(fs.existsSync(lock), false, 'a later confirmed close releases it');
});

// The same contract one level down, on the loop alone.
function unconfirmedDisposal(adapter, state) {
  adapter.dispose = async () => {
    state.disposals += 1;
    if (!state.closes) throw Object.assign(new Error('close'), { code: 'CHILD_CLOSE_UNCONFIRMED', details: { pid: 4242 } });
  };
}

test('a loop whose adapter disposal failed asks the adapter again on the next requestStop, and keeps both failures meanwhile', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  const state = { disposals: 0, closes: false };
  const adapter = makeAdapter({
    onDecide: async () => { throw Object.assign(new Error('signal'), { code: 'CHILD_SIGNAL_FAILED' }); },
  });
  unconfirmedDisposal(adapter, state);
  const loop = createGameLoop({
    gameDir, resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0, scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES },
  });
  t.after(() => { state.closes = true; return loop.requestStop().catch(() => {}); });
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);

  const runFailure = await startRun(loop).then(() => null, (error) => error);
  assert.equal(runFailure?.code, 'CHILD_SIGNAL_FAILED');
  assert.deepEqual(loop.runFailure, { code: 'CHILD_SIGNAL_FAILED' });

  const lock = path.join(gameDir, 'loop.lock.d');
  await assert.rejects(loop.requestStop(), { code: 'CHILD_CLOSE_UNCONFIRMED' });
  assert.equal(state.disposals, 1);
  let persisted = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(persisted.cleanupError.code, 'CHILD_CLOSE_UNCONFIRMED');
  assert.deepEqual(persisted.cleanupError.runError, { code: 'CHILD_SIGNAL_FAILED' });
  assert.equal(fs.existsSync(lock), true);

  // The retry asks the adapter again — it does not replay the first rejection.
  await assert.rejects(loop.requestStop(), { code: 'CHILD_CLOSE_UNCONFIRMED' });
  assert.equal(state.disposals, 2, 'the second stop attempt reached the adapter');
  assert.equal(fs.existsSync(lock), true, 'still unconfirmed: ownership is kept');

  state.closes = true;
  await loop.requestStop();
  assert.equal(state.disposals, 3);
  persisted = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(persisted.cleanupError, undefined);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(loop.runFailure, null, 'the failure is history once the cleanup it left behind is done');
});

test('concurrent stop requests share one disposal attempt', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  const state = { disposals: 0, closes: false };
  const adapter = makeAdapter();
  unconfirmedDisposal(adapter, state);
  const loop = createGameLoop({
    gameDir, resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0, scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES },
  });
  t.after(() => { state.closes = true; return loop.requestStop().catch(() => {}); });
  await loop.bootstrap({ ai: 1, stack: 100 });
  const results = await Promise.allSettled([loop.requestStop(), loop.requestStop(), loop.requestStop()]);
  assert.deepEqual(results.map((r) => r.reason?.code), Array(3).fill('CHILD_CLOSE_UNCONFIRMED'));
  assert.equal(state.disposals, 1, 'one observation served all concurrent callers');
});

// Codes reach these fields from adapters and child stdout, so a code shaped like an identifier
// is still untrusted text: only the closed vocabulary (tools/diagnostic-codes.js) passes. Both
// sentinels below are classified fatal by the loop (…SIGNAL_…, …_CLOSE_UNCONFIRMED) so they
// end the run and fail the cleanup exactly like the real codes do.
const RUN_SENTINEL = 'PRIVATE_As_Kh_tok_SIGNAL_FAILED';
const CLEANUP_SENTINEL = 'PRIVATE_Qd_7c_CLOSE_UNCONFIRMED';
function assertNoSentinel(objects) {
  for (const object of objects) {
    const text = JSON.stringify(object);
    for (const sentinel of [RUN_SENTINEL, CLEANUP_SENTINEL, 'PRIVATE_', 'As_Kh', 'Qd_7c', 'tok_']) {
      assert.equal(text.includes(sentinel), false, `${sentinel} reached a host-facing object: ${text.slice(0, 200)}`);
    }
  }
}

test('identifier-shaped secret codes never reach errorDetail or the persisted runError', { timeout: TIMEOUT }, async (t) => {
  const f = fixture(t, { runCode: RUN_SENTINEL, closeCode: CLEANUP_SENTINEL });
  const snapshot = await reachRetainedError(f);
  assert.deepEqual(snapshot.errorDetail, { run: 'UNLISTED', cleanup: 'UNLISTED', rejection: null });
  const persisted = readJson(path.join(f.manager.current.sessionDir, 'loop-state.json')).cleanupError;
  assert.deepEqual(persisted.runError, { code: 'UNLISTED' });
  for (const sentinel of [RUN_SENTINEL, CLEANUP_SENTINEL, 'As_Kh', 'Qd_7c']) {
    assert.equal(JSON.stringify(snapshot.errorDetail).includes(sentinel), false, `errorDetail carried ${sentinel}`);
    assert.equal(JSON.stringify(persisted.runError).includes(sentinel), false, `runError carried ${sentinel}`);
  }
  // A failed resume reports the same closed projection.
  const resume = cas(f.manager, 'resume');
  f.manager.command(resume);
  const row = await settle(f.manager, resume.requestId);
  assert.equal(row.status, 'failed');
  assert.deepEqual(f.manager.snapshot().errorDetail, { run: 'UNLISTED', cleanup: 'UNLISTED', rejection: null });
  // The complete host-facing objects, not only the detail: state error and receipt error are
  // projected too, and nothing anywhere in them carries the adapter's text.
  assert.equal(snapshot.error, 'UNLISTED');
  assert.equal(row.error, 'UNLISTED');
  assert.equal(f.manager.snapshot().error, 'UNLISTED');
  assertNoSentinel([snapshot, f.manager.snapshot(), row, f.manager.receipt(resume.requestId)]);
});

test('on the loop alone, an identifier-shaped run code is projected before it is kept beside a cleanup failure', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  const state = { disposals: 0, closes: false };
  const adapter = makeAdapter({
    onDecide: async () => { throw Object.assign(new Error('signal'), { code: RUN_SENTINEL }); },
  });
  unconfirmedDisposal(adapter, state);
  const loop = createGameLoop({
    gameDir, resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0, scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES },
  });
  t.after(() => { state.closes = true; return loop.requestStop().catch(() => {}); });
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  const runFailure = await startRun(loop).then(() => null, (error) => error);
  assert.equal(runFailure?.code, RUN_SENTINEL, 'the run itself still fails with what the adapter said');
  assert.deepEqual(loop.runFailure, { code: 'UNLISTED' });
  await assert.rejects(loop.requestStop(), { code: 'CHILD_CLOSE_UNCONFIRMED' });
  const persisted = readJson(path.join(gameDir, 'loop-state.json')).cleanupError;
  assert.deepEqual(persisted.runError, { code: 'UNLISTED' });
  assert.equal(JSON.stringify(persisted.runError).includes('As_Kh'), false);
});

// #273 launching loop: a start (or a recovery) whose bootstrap fails and whose cleanup is then
// unconfirmed keeps its loop as `startingLoop` — no session, but the loop lock and maybe a child
// are still owned. Warmup fails while `failWarmup` is set (and leaves the close unconfirmed);
// disposal confirms only once `closes` is set, and may be held at `disposeGate`.
const LLM_SETUP = { mode: 'cash-training', aiCount: 1, opponentRuntime: 'llm', hints: 'off', dealBias: 'off' };

function launchFixture(t, { runCode = 'CHILD_SIGNAL_FAILED', closeCode = 'CHILD_CLOSE_UNCONFIRMED', beforeWarmupFailure = null, runErrorExtra = null } = {}) {
  const events = [];
  const state = { closes: false, failWarmup: true, disposeGate: null, warmups: 0 };
  const adapter = {
    kind: 'claude',
    runtimeHomeId: null,
    disposeConfirmsChildren: true,
    async warmup({ playerId }) {
      state.warmups += 1;
      events.push(`warmup#${state.warmups}`);
      if (state.failWarmup) {
        await beforeWarmupFailure?.(state);
        if (!state.keepCloses) state.closes = false; // the child this warmup started has not been seen to close
        throw Object.assign(new Error('signal'), { code: runCode, ...(runErrorExtra ?? {}) });
      }
      return { sessionId: `s-${playerId}`, raw: 'ready' };
    },
    async decide(input) {
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
    async dispose() {
      if (state.disposeGate) {
        events.push('dispose:waiting');
        await state.disposeGate;
        state.disposeGate = null;
      }
      const ok = state.closes;
      events.push(ok ? 'dispose:confirmed' : 'dispose:unconfirmed');
      if (!ok) throw Object.assign(new Error('close'), { code: closeCode, details: { pid: 4242, closeConfirmed: false } });
    },
  };
  let resolves = 0;
  const resolver = async () => { resolves += 1; events.push(`resolver#${resolves}`); return { player: adapter, upper: adapter, notices: [] }; };
  const storeDir = createOwnedTempDir('retained-launch');
  const manager = createSessionManager({ storeDir, resolver });
  t.after(async () => { state.failWarmup = false; state.closes = true; await manager.close().catch(() => {}); });
  return { manager, events, state, storeDir, resolves: () => resolves, lock: path.join(storeDir, 'loop.lock.d') };
}

async function failedStart(f) {
  await f.manager.initialize();
  const start = { ...cas(f.manager, 'start'), setup: LLM_SETUP };
  f.manager.command(start);
  const row = await settle(f.manager, start.requestId);
  return { row, snapshot: f.manager.snapshot(), start };
}

async function command(f, kind) {
  const body = cas(f.manager, kind);
  f.manager.command(body);
  return settle(f.manager, body.requestId);
}

const count = (events, name) => events.filter((event) => event === name).length;

test('a failed bootstrap keeps its launching loop; resume retries that cleanup, keeps it while unconfirmed, and recovers only after a confirmed close', { timeout: TIMEOUT * 2 }, async (t) => {
  const f = launchFixture(t);
  const { row: started, snapshot } = await failedStart(f);

  assert.equal(started.status, 'failed');
  assert.equal(started.error, 'CHILD_CLOSE_UNCONFIRMED');
  assert.equal(snapshot.state, 'error');
  assert.equal(f.manager.session, null, 'no session: what is retained is the launching loop');
  assert.deepEqual(snapshot.errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'CHILD_CLOSE_UNCONFIRMED', rejection: null });
  assert.deepEqual(snapshot.allowedCommands, ['resume']);
  assert.equal(fs.existsSync(f.lock), true, 'the launching loop still owns the loop lock');
  const gameId = snapshot.gameId;
  assert.ok(gameId, 'the reserved game is the current one');
  const persisted = readJson(path.join(f.manager.current.sessionDir, 'loop-state.json')).cleanupError;
  assert.deepEqual(persisted.runError, { code: 'CHILD_SIGNAL_FAILED' });
  assert.equal(f.resolves(), 1);

  // Still unconfirmed: the cleanup is observed again (not replayed, not skipped), nothing is
  // launched, the loop stays retained, and both failures stay reported.
  const unconfirmedBefore = count(f.events, 'dispose:unconfirmed');
  const stillOpen = await command(f, 'resume');
  assert.equal(stillOpen.status, 'failed');
  assert.equal(stillOpen.error, 'CHILD_CLOSE_UNCONFIRMED', 'not ACTIVE_GAME or LOCKED: the retained cleanup answered');
  assert.equal(count(f.events, 'dispose:unconfirmed') > unconfirmedBefore, true, 'the retry re-observed the close');
  assert.equal(f.resolves(), 1, 'no replacement work while the close is unconfirmed');
  assert.equal(fs.existsSync(f.lock), true);
  assert.equal(f.manager.session, null);
  let after = f.manager.snapshot();
  assert.deepEqual([after.state, after.error, after.gameId], ['error', 'CHILD_CLOSE_UNCONFIRMED', gameId]);
  assert.deepEqual(after.errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'CHILD_CLOSE_UNCONFIRMED', rejection: null });
  assert.deepEqual(after.allowedCommands, ['resume']);

  // The child closes late, but the recovery launch fails the same way: the confirmed cleanup
  // came first, and the replacement's own unconfirmed loop is retained in turn.
  f.state.closes = true;
  const recoveryFailed = await command(f, 'resume');
  assert.equal(recoveryFailed.status, 'failed');
  assert.equal(recoveryFailed.error, 'CHILD_CLOSE_UNCONFIRMED');
  assert.equal(f.resolves(), 2, 'one recovery launch, only after the confirmed close');
  const confirmedAt = f.events.indexOf('dispose:confirmed');
  assert.ok(confirmedAt >= 0 && f.events.indexOf('resolver#2') > confirmedAt, f.events.join(','));
  assert.equal(f.manager.session, null);
  assert.equal(fs.existsSync(f.lock), true, 'the failed recovery keeps its own ownership');
  after = f.manager.snapshot();
  assert.deepEqual([after.state, after.gameId], ['error', gameId]);
  assert.deepEqual(after.errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'CHILD_CLOSE_UNCONFIRMED', rejection: null },
    'the failed recovery reports its own run and cleanup failure');

  // Closed and healthy: cleanup is confirmed, the same game recovers and plays.
  f.state.failWarmup = false;
  f.state.closes = true;
  const recovered = await command(f, 'resume');
  assert.equal(recovered.status, 'succeeded', recovered.error);
  assert.equal(f.resolves(), 3);
  assert.ok(f.manager.session, 'a new loop owns the game');
  assert.ok(['playing', 'paused'].includes(recovered.result.state), recovered.result.state);
  assert.deepEqual([recovered.result.error, recovered.result.errorDetail, recovered.result.gameId], [null, null, gameId]);
  after = f.manager.snapshot();
  assert.deepEqual([after.error, after.errorDetail, after.gameId], [null, null, gameId]);
  const lastConfirmed = f.events.lastIndexOf('dispose:confirmed');
  assert.ok(f.events.indexOf('resolver#3') > lastConfirmed, f.events.join(','));
});

test('shutdown racing a resume of a retained launching loop: the confirmed cleanup releases it and no replacement starts', { timeout: TIMEOUT }, async (t) => {
  const f = launchFixture(t);
  const { row: started } = await failedStart(f);
  assert.equal(started.status, 'failed');
  let release;
  f.state.disposeGate = new Promise((resolve) => { release = resolve; });
  f.state.closes = true;
  f.state.failWarmup = false;
  const body = cas(f.manager, 'resume');
  f.manager.command(body);
  await until(() => f.events.includes('dispose:waiting'), 'the retried cleanup is in flight');

  const closing = f.manager.close();
  release();
  await closing;
  const row = await settle(f.manager, body.requestId);

  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'APP_STOPPING', 'shutdown forbids the replacement launch');
  assert.equal(f.resolves(), 1, 'no replacement loop was resolved or launched');
  assert.equal(f.manager.session, null);
  assert.equal(fs.existsSync(f.lock), false, 'the confirmed cleanup released the lock');
  assert.deepEqual(f.manager.snapshot().allowedCommands, [], 'a closed app accepts nothing');
  assert.throws(() => f.manager.command(cas(f.manager, 'resume')), (error) => ['APP_STOPPING', 'INVALID_TRANSITION', 'STALE_APP'].includes(error.code));
});

test('a launching loop retained with identifier-shaped secret codes: complete snapshots and receipts carry only UNLISTED, before and after a failed resume', { timeout: TIMEOUT }, async (t) => {
  const f = launchFixture(t, { runCode: RUN_SENTINEL, closeCode: CLEANUP_SENTINEL });
  const { row: started, snapshot, start } = await failedStart(f);
  assert.equal(started.status, 'failed');
  assert.equal(started.error, 'UNLISTED');
  assert.equal(snapshot.error, 'UNLISTED');
  assert.deepEqual(snapshot.errorDetail, { run: 'UNLISTED', cleanup: 'UNLISTED', rejection: null });
  assert.equal(f.manager.session, null);
  const resume = await command(f, 'resume');
  assert.equal(resume.status, 'failed');
  assert.equal(resume.error, 'UNLISTED');
  const after = f.manager.snapshot();
  assert.deepEqual([after.state, after.error], ['error', 'UNLISTED']);
  assert.deepEqual(after.errorDetail, { run: 'UNLISTED', cleanup: 'UNLISTED', rejection: null }, 'the original detail survives the failed resume');
  assertNoSentinel([snapshot, started, f.manager.receipt(start.requestId), resume, after]);
  // The raw codes stay inside: the private loop-state keeps the cleanup as it happened.
  assert.equal(readJson(path.join(f.manager.current.sessionDir, 'loop-state.json')).cleanupError.code, CLEANUP_SENTINEL);
});

// #273: the failure that ended a run is history only once a stop actually succeeds. A stop
// refused as LOOP_LOCK_LOST (the lock's identity can no longer be verified while the resource
// cleanup itself succeeds) keeps the loop retained — and every later failed resume, on a
// retained session and on a retained launching loop alike, must still report that first cause.
// The lock is lost the way the #192/#197 fixtures lose it: the directory this instance's handle
// points at is replaced by a new one (a new inode) that still names the same live owner (the
// recorded pid file, byte for byte), so the app still reads its own live owner while the
// instance's own handle verification fails.
const loseLoopLock = (dir) => {
  const lockDir = path.join(dir, 'loop.lock.d');
  const pidFile = path.join(lockDir, 'pid');
  const owner = fs.existsSync(pidFile) ? fs.readFileSync(pidFile) : null;
  // The original directory is renamed aside, not removed: removing it first lets Linux hand the
  // same inode back to mkdir, which would leave the replacement indistinguishable from the original.
  const retired = path.join(dir, `loop.lock.d.lost-${randomUUID()}`);
  const before = fs.existsSync(lockDir) ? fs.statSync(lockDir) : null;
  if (before) fs.renameSync(lockDir, retired);
  fs.mkdirSync(lockDir);
  if (owner) fs.writeFileSync(pidFile, owner, { mode: 0o600 });
  if (!before) return;
  const after = fs.statSync(lockDir);
  assert.notDeepEqual([after.dev, after.ino], [before.dev, before.ino], 'the lock directory is a new physical directory');
  if (owner) assert.deepEqual(fs.readFileSync(path.join(retired, 'pid')), owner, 'the retired owner record is unchanged');
};

test('a stop refused as LOOP_LOCK_LOST keeps the run failure on the loop, and repeated failed resumes of a retained session and of a retained launching loop keep reporting the first cause', { timeout: TIMEOUT * 2 }, async (t) => {
  // The loop alone: the run failed, the cleanup itself would succeed, the lock is lost.
  const gameDir = tmpGame();
  const state = { disposals: 0, closes: true };
  const adapter = makeAdapter({
    onDecide: async () => { throw Object.assign(new Error('signal'), { code: 'CHILD_SIGNAL_FAILED' }); },
  });
  unconfirmedDisposal(adapter, state);
  const loop = createGameLoop({
    gameDir, resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0, scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  const runFailure = await startRun(loop).then(() => null, (error) => error);
  assert.equal(runFailure?.code, 'CHILD_SIGNAL_FAILED');
  assert.deepEqual(loop.runFailure, { code: 'CHILD_SIGNAL_FAILED' });
  const loopStateBytes = fs.readFileSync(path.join(gameDir, 'loop-state.json'), 'utf8');
  loseLoopLock(gameDir);
  await assert.rejects(loop.requestStop(), { code: 'LOOP_LOCK_LOST' });
  assert.deepEqual(loop.runFailure, { code: 'CHILD_SIGNAL_FAILED' }, 'a refused stop is not a successful one: the cause stays');
  await assert.rejects(loop.requestStop(), { code: 'LOOP_LOCK_LOST' });
  assert.deepEqual(loop.runFailure, { code: 'CHILD_SIGNAL_FAILED' }, 'and stays across repeated refusals');
  assert.equal(fs.readFileSync(path.join(gameDir, 'loop-state.json'), 'utf8'), loopStateBytes, 'nothing is written with a lost lock');
  assert.ok(state.disposals >= 1, 'the resource cleanup itself ran');

  // The retained session: the first failed resume and the second one both name the first cause.
  const f = fixture(t);
  await reachRetainedError(f);
  f.state.closes = true;
  loseLoopLock(f.storeDir);
  const first = cas(f.manager, 'resume');
  f.manager.command(first);
  const firstRow = await settle(f.manager, first.requestId);
  assert.deepEqual([firstRow.status, firstRow.error], ['failed', 'LOOP_LOCK_LOST']);
  assert.deepEqual(f.manager.snapshot().errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'LOOP_LOCK_LOST', rejection: null });
  assert.ok(f.manager.session, 'still retained');
  const second = cas(f.manager, 'resume');
  f.manager.command(second);
  const secondRow = await settle(f.manager, second.requestId);
  assert.deepEqual([secondRow.status, secondRow.error], ['failed', 'LOOP_LOCK_LOST']);
  assert.deepEqual(f.manager.snapshot().errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'LOOP_LOCK_LOST', rejection: null }, 'the second failed resume still names the first cause');
  assert.deepEqual(f.manager.receipt(second.requestId).result?.errorDetail ?? f.manager.snapshot().errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'LOOP_LOCK_LOST', rejection: null });

  // The retained launching loop: the same, under the same lost ownership.
  const g = launchFixture(t);
  const { row: started } = await failedStart(g);
  assert.equal(started.status, 'failed');
  assert.equal(g.manager.session, null);
  g.state.closes = true;
  loseLoopLock(g.storeDir);
  const blocked = await command(g, 'resume');
  assert.deepEqual([blocked.status, blocked.error], ['failed', 'LOOP_LOCK_LOST']);
  assert.deepEqual(g.manager.snapshot().errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'LOOP_LOCK_LOST', rejection: null });
  const again = await command(g, 'resume');
  assert.deepEqual([again.status, again.error], ['failed', 'LOOP_LOCK_LOST']);
  assert.deepEqual(g.manager.snapshot().errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'LOOP_LOCK_LOST', rejection: null }, 'the retained launching loop keeps its first cause too');
});

// #273 + #274 together, as in the incident: a refused explanation is the recorded attempt when
// the AI acts, so the applied AI action's publication must settle it first; its retirement
// cannot complete (the audit target is obstructed), the run fails, and the cleanup that follows
// is unconfirmed. Removing only the obstruction and confirming the close, an explicit resume
// recovers the same game: the explanation is retired from its exact body, the action is
// published after it in order, and the engine never applies the action again.
const PUBLISH_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/publish.js');
const EXPLANATION = '이 스팟에서는 레이즈가 주력입니다.';

function runPublisher(dir, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PUBLISH_CLI, ...args, '--game-dir', dir], { encoding: 'utf8', timeout: 20_000 }, (error, stdout) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok !== true) {
        reject(Object.assign(new Error(envelope?.message ?? 'publisher failed'), { code: envelope?.code ?? error?.code ?? 'CHILD_FAILED', envelope }));
        return;
      }
      resolve(envelope);
    });
  });
}

// The engine's completed hands (archive and lastHand, one record per hand), oldest first.
function completedHands(dir) {
  const byHand = new Map();
  const handsDir = path.join(dir, 'hands');
  if (fs.existsSync(handsDir)) {
    for (const name of fs.readdirSync(handsDir)) {
      if (!/^hand-\d+\.json$/.test(name)) continue;
      const record = readJson(path.join(handsDir, name));
      if (Number.isInteger(record?.handNo)) byHand.set(record.handNo, record);
    }
  }
  const state = readJson(path.join(dir, 'state.json'));
  if (Number.isInteger(state.lastHand?.handNo)) byHand.set(state.lastHand.handNo, state.lastHand);
  return [...byHand.values()].sort((a, b) => a.handNo - b.handNo);
}

// The first user decision the engine recorded in a completed hand: the practice provenance an
// evaluation must carry is checked against exactly this record and snapshot.
function completedUserDecision(dir) {
  for (const record of completedHands(dir)) {
    const snapshot = (record.decisions ?? []).find((row) => row.actorId === 'user');
    if (snapshot) return { record, snapshot };
  }
  return null;
}

// An evaluation of an independent provider for that recorded user decision, carrying the
// decision's real practice provenance exactly as the hand record and the snapshot state it
// (deal selection contract and hint assistance). The session's bound reference is not
// involved, and no gate is bypassed: acceptEvaluations verifies this provenance, the epoch
// and the owner the same way it does for the loop's own evaluations.
function independentEvaluation(epoch, { record, snapshot }) {
  const source = { id: 'fixture-274', version: '1.0.0' };
  const assistance = decisionAssistance(record, snapshot.decisionId);
  return {
    ...q3Evaluation(epoch, snapshot.decisionId),
    ...dealSelectionFields(record),
    ...(assistance === undefined ? {} : { assistance }),
    street: snapshot.street,
    source,
    evaluationId: evaluationIdOf({ gameEpoch: epoch, decisionId: snapshot.decisionId, providerId: source.id, providerVersion: source.version }),
  };
}

// Armed from inside the AI's decision, before its action is applied: the relay holds the
// machine row of an evaluation of a real recorded user decision; the local item then names
// another payload digest for one publication, so the relay refuses the explanation as a proof
// mismatch (400, retirable) and it stays the recorded attempt. The audit target is obstructed
// (a directory) before anything is sealed, so neither this helper nor the loop's own
// background flush can retire it; the canonical digest is restored once the attempt is
// recorded, so later machine rows of the item are not corrupted — the attempt and its
// retirement are bound to the exact body that was sent.
async function armRefusedExplanation(dir, decision) {
  const epoch = gameEpochOf(readJson(path.join(dir, 'state.json')).sessionToken);
  const owner = readJson(path.join(dir, 'loop-state.json')).ownerSessionId;
  const tc = createTrainingControl();
  const execute = (args) => runPublisher(dir, args);
  // The loop's own pipeline for that hand (evaluate → machine publish → explain, with no
  // explainer in this adapter) must be at rest first, or an explanation sealed here could be
  // bundled into a body the loop builds: its evaluation of the decision is on the relay and no
  // annotation is queued.
  await until(() => {
    const auth = tc.loadAuthority(dir);
    const own = Object.values(auth?.items ?? {}).find((item) => item.decisionId === decision.snapshot.decisionId);
    if (!own) return false;
    const relayed = readJson(path.join(dir, 'ui-snapshot.json')).training ?? [];
    return relayed.some((row) => row.evaluationId === own.evaluationId)
      && Object.keys(auth.annotationQueue ?? {}).length === 0;
  }, 'the loop registered and published its own evaluation of the recorded user decision');
  fs.mkdirSync(path.join(dir, '.publish-rejections.jsonl'));
  const evaluation = independentEvaluation(epoch, decision);
  await tc.acceptEvaluations(dir, { gameEpoch: epoch, owner, handNo: decision.record.handNo, evaluations: [evaluation] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: epoch, executePublish: execute, trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', EXPLANATION)).ok, true);
  const authFile = path.join(dir, 'training', '.training-authority.json');
  const drifted = readJson(authFile);
  const canonicalPayload = drifted.items[evaluation.evaluationId].payloadSha256;
  drifted.items[evaluation.evaluationId].payloadSha256 = 'ab'.repeat(32);
  fs.writeFileSync(authFile, JSON.stringify(drifted));
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: epoch, executePublish: execute, trainingControl: tc })
    .then(() => assert.fail('the explanation must be refused'), (error) => assert.equal(error.code, 'PUBLISH_REJECTED'));
  const attempt = readJson(path.join(dir, '.publish-attempt.json'));
  assert.deepEqual(attempt.body.trainingAnnotations.map((row) => row.evaluationId), [evaluation.evaluationId], 'the refused body is this explanation alone');
  const restored = readJson(authFile);
  restored.items[evaluation.evaluationId].payloadSha256 = canonicalPayload;
  fs.writeFileSync(authFile, JSON.stringify(restored));
  return {
    tc, evaluation, epoch, attempt,
    decisionId: decision.snapshot.decisionId, handNo: decision.record.handNo,
    publishedBefore: readJson(path.join(dir, 'ui-snapshot.json')).publishId,
  };
}

test('combined acceptance: explanation refusal -> applied AI action publication fails -> cleanup unconfirmed -> resume after close recovers in order without re-applying the action', { timeout: TIMEOUT * 3 }, async (t) => {
  const events = [];
  const state = { closes: false, decisions: 0, armed: null, armedDecisionId: null, decisionsAtArm: 0 };
  let releaseLater;
  const later = new Promise((resolve) => { releaseLater = resolve; });
  let manager;
  const adapter = {
    kind: 'claude',
    runtimeHomeId: null,
    disposeConfirmsChildren: true,
    async warmup({ playerId }) { return { sessionId: `s-${playerId}`, raw: 'ready' }; },
    // The AI folds every decision. The first decision taken after a completed hand holds a
    // recorded user decision is the one that arms the refused explanation (heads-up, the
    // button alternates: the user opens one hand, the AI acts first in the next). Decisions
    // after the armed one — the recovered run's — wait for the end of the test.
    async decide(input) {
      state.decisions += 1;
      events.push(`decide#${state.decisions}`);
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      if (state.armed) {
        await later;
      } else {
        const decision = completedUserDecision(manager.current.sessionDir);
        if (decision) {
          state.armed = await armRefusedExplanation(manager.current.sessionDir, decision);
          state.armedDecisionId = decisionId;
          state.decisionsAtArm = state.decisions;
        }
      }
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
    async dispose() {
      events.push(state.closes ? 'dispose:confirmed' : 'dispose:unconfirmed');
      if (!state.closes) throw Object.assign(new Error('close'), { code: 'CHILD_CLOSE_UNCONFIRMED', details: { pid: 4242 } });
    },
  };
  let resolves = 0;
  const resolver = async () => { resolves += 1; events.push(`resolver#${resolves}`); return { player: adapter, upper: adapter, notices: [] }; };
  const storeDir = createOwnedTempDir('combined-273-274');
  manager = createSessionManager({ storeDir, resolver });
  t.after(async () => { releaseLater(); state.closes = true; await manager.close().catch(() => {}); });

  // A real game: the user opens whenever it is their turn (each decision once), the AI folds,
  // and the run fails at the publication of the armed AI action; the retained session is left
  // in error.
  await manager.initialize();
  const start = { ...cas(manager, 'start'), setup: { mode: 'cash-training', aiCount: 1, opponentRuntime: 'llm', hints: 'off', dealBias: 'off' } };
  manager.command(start);
  assert.equal((await settle(manager, start.requestId)).status, 'succeeded');
  const postedIds = new Set();
  await until(async () => {
    if (manager.snapshot().state === 'error') return true;
    if (state.armed) return false; // the armed action's own publication ends the run
    try {
      const lock = readJson(path.join(manager.current.sessionDir, 'lock.json'));
      const live = await (await fetch(`http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`)).json();
      const legal = live.view?.legal;
      if (legal?.toAct === 'user' && !postedIds.has(legal.decisionId)) {
        postedIds.add(legal.decisionId);
        await postUserAction(lock, preferredUserAction(legal));
      }
    } catch { /* relay not up yet, or a hand boundary */ }
    return false;
  }, 'the armed AI action fails its publication and ends the run');
  const snapshot = manager.snapshot();
  const dir = manager.current.sessionDir;
  const gameId = snapshot.gameId;
  assert.ok(state.armed, 'the AI decided with the refused explanation recorded');
  assert.ok(postedIds.size >= 1, 'the user decided in a hand of this game');
  assert.equal(completedHands(dir).some((record) => record.handNo === state.armed.handNo
    && (record.decisions ?? []).some((row) => row.actorId === 'user' && row.decisionId === state.armed.decisionId)), true,
  'the evaluation names a user decision the engine recorded in a completed hand');
  assert.equal(snapshot.error, 'CHILD_CLOSE_UNCONFIRMED');
  assert.deepEqual(snapshot.errorDetail, {
    run: 'REJECTION_AUDIT_FAILED', cleanup: 'CHILD_CLOSE_UNCONFIRMED',
    rejection: { httpStatus: 400, serverCode: 'ANNOTATION_PROOF_MISMATCH' },
  });
  assert.deepEqual(snapshot.allowedCommands, ['resume']);
  const attemptFile = path.join(dir, '.publish-attempt.json');
  assert.equal(fs.existsSync(attemptFile), true, 'the refused attempt is kept while it cannot be retired');
  assert.equal(readJson(attemptFile).body.publishId, state.armed.attempt.body.publishId, 'exactly the armed attempt');
  const metric = readJson(path.join(dir, 'loop-state.json')).metrics.at(-1);
  assert.equal(metric.publishError, 'REJECTION_AUDIT_FAILED', 'the applied AI action could not be published');
  // The armed AI action in the engine's records (archive, lastHand and the hand in progress,
  // one record per hand): applied exactly once, before and after recovery.
  const armedActions = () => {
    const engine = readJson(path.join(dir, 'state.json'));
    const records = completedHands(dir);
    if (engine.hand && !records.some((record) => record.handNo === engine.handNo)) records.push({ ...engine.hand, handNo: engine.handNo });
    return records.flatMap((record) => record.actions ?? [])
      .filter((action) => action.playerId !== 'user' && action.decisionId === state.armedDecisionId && action.action === 'fold');
  };
  assert.equal(armedActions().length, 1, 'the AI action was applied once');
  const resolvesBefore = resolves;

  // Still unconfirmed: resume reports the cleanup, keeps both causes and changes nothing.
  const blocked = cas(manager, 'resume');
  manager.command(blocked);
  const blockedRow = await settle(manager, blocked.requestId);
  assert.deepEqual([blockedRow.status, blockedRow.error], ['failed', 'CHILD_CLOSE_UNCONFIRMED']);
  assert.deepEqual(manager.snapshot().errorDetail, snapshot.errorDetail, 'the original run and cleanup detail survive the failed resume');
  assert.equal(resolves, resolvesBefore);
  assert.equal(fs.existsSync(attemptFile), true);

  // Only the fixture obstruction is removed and the close is confirmed.
  fs.rmdirSync(path.join(dir, '.publish-rejections.jsonl'));
  state.closes = true;
  const resume = cas(manager, 'resume');
  manager.command(resume);
  const row = await settle(manager, resume.requestId);
  assert.equal(row.status, 'succeeded', JSON.stringify({ error: row.error, diagnostic: row.diagnostic }));
  assert.deepEqual([row.result.gameId, row.result.error, row.result.errorDetail], [gameId, null, null]);
  assert.ok(['playing', 'paused'].includes(row.result.state), row.result.state);
  assert.equal(resolves, resolvesBefore + 1, 'one replacement loop, after the confirmed close');
  const confirmedAt = events.indexOf('dispose:confirmed');
  assert.ok(confirmedAt >= 0 && events.indexOf(`resolver#${resolvesBefore + 1}`) > confirmedAt, events.join(','));

  // The recovered run settles the refused explanation first, then publishes the action.
  const audit = await until(() => {
    if (fs.existsSync(attemptFile)) return null;
    try {
      const lines = fs.readFileSync(path.join(dir, '.publish-rejections.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const snap = readJson(path.join(dir, 'ui-snapshot.json'));
      return lines.length === 1 && snap.publishId >= lines[0].publishId ? lines : null;
    } catch { return null; }
  }, 'the refused explanation is retired and the action published');
  assert.equal(audit[0].publishId, state.armed.attempt.body.publishId);
  assert.equal(audit[0].httpStatus, 400);
  assert.equal(audit[0].serverCode, 'ANNOTATION_PROOF_MISMATCH');
  assert.equal(JSON.stringify(audit).includes(EXPLANATION), false, 'the public audit carries no value');
  assert.equal(fs.existsSync(path.join(dir, '.publish-retirement.json')), false, 'the private evidence was consumed');
  // Settled: the next decision is the user's or a later AI decision, and loop and relay agree.
  const ui = await until(async () => {
    let userToAct = false;
    try {
      const lock = readJson(path.join(dir, 'lock.json'));
      const live = await (await fetch(`http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`)).json();
      userToAct = live.view?.legal?.toAct === 'user';
    } catch { /* relay not up yet */ }
    const snap = readJson(path.join(dir, 'ui-snapshot.json'));
    const steady = state.decisions > state.decisionsAtArm || userToAct;
    return steady && readJson(path.join(dir, 'loop-state.json')).lastPublishId === snap.publishId ? snap : null;
  }, 'the recovered run reaches its next decision');
  assert.equal(ui.publishId > state.armed.publishedBefore, true, 'publication moved forward');
  assert.equal(Object.hasOwn(ui.trainingAnnotations ?? {}, state.armed.evaluation.evaluationId), false, 'the refused explanation never reached the relay');
  assert.equal((ui.training ?? []).some((row) => row.evaluationId === state.armed.evaluation.evaluationId), true, 'the machine row of the recorded user decision stays published');
  const auth = state.armed.tc.loadAuthority(dir);
  assert.equal(auth.annotationQueue?.[state.armed.evaluation.evaluationId], undefined);
  assert.equal(auth.items[state.armed.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.deepEqual([auth.items[state.armed.evaluation.evaluationId].decisionId, auth.items[state.armed.evaluation.evaluationId].handNo], [state.armed.decisionId, state.armed.handNo]);
  assert.equal(armedActions().length, 1, 'the applied action is not applied again');
  const final = manager.snapshot();
  assert.equal(final.gameId, gameId);
  assert.equal(final.error, null);
  assert.equal(final.errorDetail, null);
  assert.ok(['playing', 'paused', 'finalizing'].includes(final.state), final.state);
  assert.equal(manager.receipt(resume.requestId).status, 'succeeded');
});

// R13 review (Astra F3): the initial launch fails (warmup) and, in the same instant, the loop
// lock's identity is lost while a live owner still holds the replacement (the #192/#197 way).
// The bootstrap keeps its own failure as the headline — the refused cleanup is LOOP_LOCK_LOST,
// not a success and not that failure twice — so the FIRST snapshot and receipt name
// run:<the warmup failure> and cleanup:LOOP_LOCK_LOST, the launching loop stays retained with
// its lock (no deletion, no replacement launch), the child close was confirmed exactly once,
// and nothing is signalled or run again. A later resume of that retained loop is a cleanup
// retry, refused as LOOP_LOCK_LOST before any replacement, and keeps reporting the same pair.
test('#273 an initial launch whose cleanup loses the loop lock to a live owner: the first snapshot names the run cause and LOOP_LOCK_LOST as the cleanup, the launching loop stays retained, nothing runs twice', { timeout: TIMEOUT * 2 }, async (t) => {
  const holder = {};
  const f = launchFixture(t, {
    beforeWarmupFailure: (state) => {
      state.keepCloses = true; // the child closes fine: the only cleanup failure is the lost lock
      state.closes = true;
      loseLoopLock(holder.storeDir);
    },
  });
  holder.storeDir = f.storeDir;
  const { row: started, snapshot } = await failedStart(f);

  assert.deepEqual([started.status, started.error], ['failed', 'CHILD_SIGNAL_FAILED'], 'the headline is the failure that ended the launch');
  assert.deepEqual(snapshot.errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'LOOP_LOCK_LOST', rejection: null }, 'the first snapshot keeps both: the run cause and the actual cleanup outcome');
  assert.deepEqual(f.manager.receipt(started.requestId)?.result?.errorDetail ?? snapshot.errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'LOOP_LOCK_LOST', rejection: null });
  assert.equal(snapshot.state, 'error');
  assert.equal(f.manager.session, null, 'no session: the launching loop is retained');
  assert.equal(fs.existsSync(f.lock), true, 'the loop lock still names its live owner: not deleted');
  assert.equal(count(f.events, 'dispose:confirmed'), 1, 'the child close was confirmed once');
  assert.equal(count(f.events, 'dispose:unconfirmed'), 0);
  assert.equal(f.state.warmups, 1, 'nothing was run again');
  assert.equal(f.resolves(), 1, 'no replacement was launched');
  // Closed codes only: the fixture's raw error messages ("signal", "close"), its child pid
  // (4242) and the store path never reach the snapshot or the receipt. The sentinels are the
  // quoted raw values, so a permitted code such as CHILD_SIGNAL_FAILED cannot match them.
  for (const text of [JSON.stringify(snapshot.errorDetail), JSON.stringify(f.manager.receipt(started.requestId)?.result?.errorDetail ?? null), JSON.stringify(snapshot.error ?? null)]) {
    assert.equal(/"signal"|"close"|"pid":4242|4242,|\/tmp\//.test(text), false, 'no raw message, pid or path');
  }

  // A resume of the retained launching loop is the cleanup RETRY: it is refused as
  // LOOP_LOCK_LOST before any replacement could start — no new warmup, no new resolve — and
  // the pair stays the same. (A fresh recovery launch that fails the same way goes through the
  // same bootstrap/resume catch; it is not what this resume exercises.)
  const again = await command(f, 'resume');
  assert.deepEqual([again.status, again.error], ['failed', 'LOOP_LOCK_LOST'], 'the cleanup retry is refused as the lost lock');
  assert.deepEqual(f.manager.snapshot().errorDetail, { run: 'CHILD_SIGNAL_FAILED', cleanup: 'LOOP_LOCK_LOST', rejection: null }, 'the retained launch keeps the same pair');
  assert.equal(f.manager.session, null);
  assert.equal(fs.existsSync(f.lock), true);
  assert.equal(f.state.warmups, 1, 'no replacement launch: nothing warmed up again');
  assert.equal(f.resolves(), 1, 'no replacement launch: nothing resolved again');
  assert.equal(count(f.events, 'dispose:unconfirmed'), 0, 'no unverified owner was signalled');
});

// R14 review (Sol F1): a resolver/adapter error that carries its own `errorDetail` reaches the
// manager's catch, which prefers it over the retained-launch detail. Whatever it holds — an
// unlisted run code, a secret-shaped cleanup, a refusal tuple with an unlisted server code,
// extra message/nested fields — the public state boundary projects it: closed codes (UNLISTED
// for anything unknown), the two re-sanitized tuples, nothing else, in the first snapshot, the
// receipt and the command replay. Known codes stay as useful as before.
test('#273/#274 a launch error carrying hostile errorDetail: the whole public snapshot, receipt and replay carry only the projected closed fields', { timeout: TIMEOUT * 2 }, async (t) => {
  const hostile = {
    run: 'SECRET_RUN_tok_9f1',
    cleanup: 'child closed /tmp/secret/path As Kh',
    rejection: { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL_As_Kh_token' },
    recheckRejection: { httpStatus: 500, serverCode: 'X'.repeat(70) },
    message: 'raw message with cards As Kh and token tok_9f1',
    nested: { token: 'tok_9f1', path: '/tmp/secret/path' },
  };
  const holder = {};
  const f = launchFixture(t, {
    runErrorExtra: { errorDetail: hostile },
    beforeWarmupFailure: (state) => {
      state.keepCloses = true;
      state.closes = true;
      loseLoopLock(holder.storeDir); // the launch stays retained: its error, detail included, is what the manager catches
    },
  });
  holder.storeDir = f.storeDir;
  const { row: started, snapshot, start } = await failedStart(f);
  const projected = {
    run: 'UNLISTED',
    cleanup: 'UNLISTED',
    rejection: { httpStatus: 400, serverCode: 'UNLISTED' },
    recheckRejection: { httpStatus: 500, serverCode: 'UNLISTED' },
  };
  assert.equal(started.status, 'failed');
  assert.equal(started.error, 'CHILD_SIGNAL_FAILED', 'the known headline stays useful');
  assert.equal(snapshot.state, 'error');
  assert.deepEqual(snapshot.errorDetail, projected, 'the first snapshot carries only the projected closed fields');
  assert.deepEqual(Object.keys(snapshot.errorDetail).sort(), ['cleanup', 'recheckRejection', 'rejection', 'run']);
  // A failed command records its closed headline only — no result snapshot (unchanged
  // contract); the receipt and its replay therefore carry the projected code and nothing raw.
  const receipt = f.manager.receipt(start.requestId);
  assert.equal(receipt?.status, 'failed');
  assert.equal(receipt?.error, 'CHILD_SIGNAL_FAILED');
  assert.equal(receipt?.result, undefined, 'a failed command records no result snapshot');
  const replayed = await Promise.resolve(f.manager.command(start)).catch((error) => error);
  const replayedCode = replayed?.error ?? replayed?.code ?? null;
  if (replayedCode !== null) assert.equal(projectPublicCode(replayedCode), replayedCode, `a closed replay headline: ${replayedCode}`);
  assert.deepEqual(f.manager.snapshot().errorDetail, projected, 'the live state after the replay still carries only the projection');
  for (const [label, text] of [['snapshot', JSON.stringify(snapshot)], ['receipt', JSON.stringify(receipt)], ['replay', JSON.stringify(replayed)], ['snapshot again', JSON.stringify(f.manager.snapshot())]]) {
    for (const secret of ['SECRET_RUN', 'tok_9f1', '/tmp/secret', 'As Kh', 'raw message', 'nested', 'XXXXXXXX', 'FORBIDDEN_LITERAL_As']) {
      assert.equal(text.includes(secret), false, `${label}: ${secret} must not reach a host`);
    }
  }
  assert.equal(f.manager.session, null, 'retained launch');
  assert.equal(fs.existsSync(f.lock), true);
});

test('the pid leak matcher finds the fixture pid with its label but never inside a random identifier (#319)', () => {
  // Seeded, so the corpus (and the control count below) is the same on every run (as #304).
  let seed = 319;
  const next = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const hex = (chars) => Array.from({ length: chars / 8 }, () => next().toString(16).padStart(8, '0')).join('');
  const uuid = () => {
    const h = hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[next() % 4]}${h.slice(17, 20)}-${h.slice(20)}`;
  };
  const rows = Array.from({ length: 20_000 }, () => JSON.stringify({
    instanceId: uuid(), gameId: uuid(), gameEpoch: hex(64), appRevision: next() % 100_000,
    stateSince: new Date(Date.UTC(2020, 0, 1) + next() * 100).toISOString(),
    error: 'CHILD_CLOSE_UNCONFIRMED', errorDetail: { run: 'CHILD_SIGNAL_FAILED', cleanup: 'CHILD_CLOSE_UNCONFIRMED', rejection: null },
  }));
  assert.equal(rows.filter((row) => PID_LEAK.test(row)).length, 0);
  // The fixture's two ways out: its error `details`, and a message that formats them.
  assert.match(JSON.stringify({ errorDetail: { details: { pid: 4242, closeConfirmed: false } } }), PID_LEAK);
  assert.match(JSON.stringify({ error: 'close failed (pid: 4242)' }), PID_LEAK);
  // Control: the bare number the snapshot check used before does hit the same corpus.
  assert.ok(rows.filter((row) => row.includes('4242')).length > 0, 'the corpus can produce the old false positive');
});
