// Persisted coach recovery/finalize tests split out of game-loop.test.js (#210).
// Test bodies moved verbatim; shared fixtures live in helpers/game-loop-fixtures.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  processStartTime,
  readOwnedLock,
  writeJsonAtomic,
  acquireOwnedLock,
} from '../engine/state.js';
import { skipOnWin32 } from './helpers/platform.js';
import {
  createGameLoop,
  defaultReclaimBudgets,
  platformBudgetScale,
  buildBadChildOutputDetails,
  unresolvedEvidenceGuidance,
  consultCoachCloseEvidence,
  readSidecarFileWithoutNoFollow,
  parseLsofCwdRecords,
  legacyCoachRuntimeCandidates,
  scanCoachRuntimeProcesses,
} from '../tools/game-loop.js';
import { gameEpochOf } from '../publish-contract.js';
import { createCoachControl } from '../tools/coach-control.js';
import { defaultEvaluate } from '../tools/training-pipeline.js';
import { createSessionManager } from '../tools/session-manager.js';
import {
  execFileAsync,
  CLI,
  COACH_CLI,
  REAL_LSOF,
  VALID_REVIEW,
  tmpGame,
  readJson,
  snapshotTree,
  initGame,
  runCoachCli,
  seedQueuedCoach,
  seedRunningCoach,
  TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES,
  seedReservedCoach,
  seedEmptyCoachAuthority,
  startCoachOrphan,
  makeAdapter,
  resolverFor,
  makeCoachAdapter,
  resolverForCoach,
  waitUntilDead,
  WIN32_SCALE,
  waitFor,
  waitForUserSnapshot,
  preferredUserAction,
  postUserAction,
  startRun,
  stopRun,
  startExternalServer,
  terminateIfAlive,
  injectCurrentHandCard,
  decisionIdOfMessage,
  chipTotal,
  readLoopLog,
  writeLoopStateFixture,
  setupCoachHand,
  waitForCoachNote,
  setupUserFirst,
  holdNamedLock,
  HU_BUST_DECK,
  cliJson,
  putUserOnTheButton,
  seedFinishedGame,
  expandFinishedGameToTwoHands,
  sha256Text,
  finalizingLoop,
  coachInvocations,
  publishInvocations,
  nonReviewPublishInvocations,
  flagValue,
  assert205Evidence,
  assert205UnconfirmedCommand,
} from './helpers/game-loop-fixtures.mjs';

// #213: a monotonic clock that shares process.hrtime's origin (publish.js compares
// --deadline-monotonic-ns against its own hrtime) and only ever moves forward. Jumping it
// crosses a finalization cutoff at once instead of waiting it out in real time — the win32
// default result wait alone is 190 s. Timers and child timeouts armed before a jump are not
// shortened, so a test jumps while the step it wants past the cutoff is parked in-process.
function createJumpClock() {
  let offsetNs = 0n;
  const monotonicNs = () => process.hrtime.bigint() + offsetNs;
  return {
    monotonicNs,
    jumpBy(ms) {
      assert.ok(Number.isSafeInteger(ms) && ms >= 0, `jump clock moves forward only (${ms})`);
      offsetNs += BigInt(ms) * 1_000_000n;
    },
    jumpTo(targetNs) {
      const delta = targetNs - monotonicNs();
      if (delta > 0n) offsetNs += delta;
    },
  };
}

// §9.2 (2): a finalizing replacement needs an absolute 5 s of result wait. Tests that jump
// to "less than that is left" land here, leaving room for one coach child on a slow host.
const LEFT_BELOW_REPLACEMENT_FLOOR_NS = 4_500n * 1_000_000n;

// #192 S2a E3: the CLI now exits non-zero for reserve/begin-owner/bind-handle without
// --spawn-evidence 1. execFile's promisified form rejects on a non-zero exit but still
// attaches the child's stdout/stderr to the error, so the failure envelope is read there.
async function runCoachCliFailure(gameDir, args) {
  let caught = null;
  try {
    await runCoachCli(gameDir, args);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `coach CLI was expected to fail for ${JSON.stringify(args)}`);
  assert.equal(typeof caught.stdout, 'string', 'coach CLI failure did not carry a stdout envelope');
  return JSON.parse(caught.stdout.trim());
}

// #192 S2b §6: the new-protocol variant of seedReservedCoach — stamps `spawnEvidence`
// through the in-process API (never the CLI, which now requires --spawn-evidence 1 for
// reserve; the module API keeps a plain boolean option instead).
async function seedReservedCoachStamped(gameDir, owner, handNo = 1, { spawnEvidence = true } = {}) {
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(gameDir, `.seed-reserved-coach-stamped-stats-${handNo}.json`);
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  return createCoachControl().reserve({
    gameDir, owner, handNo, attempt: 1,
    statsFile: statsPath, snapshotFile: path.join(gameDir, 'ui-snapshot.json'),
    spawnEvidence,
  });
}

// #192 S2b E2: the per-attempt spawn sidecar path a running loop would compute for
// `reserved` — same basename swap (`.result.json` → `.spawn.json`), always rooted at the
// current game dir regardless of the row's own stored exactResultPath.
function coachSpawnSidecarPath(gameDir, exactResultPath) {
  return path.join(gameDir, path.basename(exactResultPath).replace(/\.result\.json$/, '.spawn.json'));
}

function writeCoachSpawnSidecar(gameDir, sessionToken, owner, reserved, fields) {
  const sidecarPath = coachSpawnSidecarPath(gameDir, reserved.exactResultPath);
  fs.writeFileSync(sidecarPath, JSON.stringify({
    gameEpoch: gameEpochOf(sessionToken),
    owner,
    handNo: reserved.handNo,
    generation: reserved.generation,
    attempt: reserved.attempt ?? 1,
    ...fields,
  }));
  return sidecarPath;
}

async function acceptRunningCoach(gameDir, owner, reserved, handNo = reserved.handNo) {
  fs.writeFileSync(reserved.exactResultPath, JSON.stringify({
    handNo,
    text: `persisted covered coach ${handNo}`,
  }));
  const denyPath = path.join(gameDir, `.seed-running-coach-deny-${handNo}.json`);
  fs.writeFileSync(denyPath, JSON.stringify(['PERSISTED_COVERED_FORBIDDEN']));
  return runCoachCli(gameDir, [
    'accept', '--owner', owner, '--hand', String(handNo),
    '--generation', String(reserved.generation), '--forbidden-file', denyPath,
  ]);
}

// #192 O1/L1: a coach orphan whose cwd mimics player-runtime.js's own `ensureCwd()`
// convention (`ai-holdem-<kind>-XXXXXX` under the real tmpdir) so the legacy-row process
// scanner's real, default lsof-based scan recognizes it as a live candidate — used by
// fixtures whose whole point is that an alive-but-unverified identity must never be
// silently auto-recovered by judgment g.
async function startTaggedCoachOrphan(opts = {}) {
  const tagDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-holdem-testfixture-')));
  const child = await startCoachOrphan({ ...opts, cwd: tagDir });
  return { child, tagDir };
}

test('AI 3 plus user runs the finalization cutoff through the real loop with chips preserved', { timeout: 25_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const adapter = makeAdapter();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 40 },
  });
  t.after(() => loop.requestStop());
  await loop.bootstrap({ ai: 3, stack: 100, levelEvery: 1, blinds: '25/50' });
  const running = startRun(loop);
  let settled = false;
  running.finally(() => { settled = true; }).catch(() => {});
  const sent = new Set();
  const driver = (async () => {
    while (!settled) {
      try {
        const { lock, snapshot } = await waitForUserSnapshot(gameDir, 200);
        const decisionId = snapshot.view.legal.decisionId;
        if (!sent.has(decisionId)) {
          sent.add(decisionId);
          await postUserAction(lock, preferredUserAction(snapshot.view.legal));
        }
      } catch { /* AI turn, server transition, or terminal boundary */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();

  // The fake upper has no oneshotStart; the factual fallback still closes the game.
  assert.equal((await running).phase, 'done');
  await driver;
  const engine = readJson(path.join(gameDir, 'state.json'));
  assert.equal(chipTotal(engine), 400);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopState.phase, 'done');
  assert.equal(loopState.halt, undefined);
  assert.equal(loopState.finalization.cutoff.reviewGate, 'open');
  assert.equal(adapter.decideCalls.length > 0, true);
  assert.equal(sent.size > 0, true);
});

test('finalizing resume resolves upper-only with a live canary and completes review without player warmup', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'finalizing',
    sessionToken: init.sessionToken,
    gameEpoch: gameEpochOf(init.sessionToken),
    ownerSessionId: 'old-owner',
    startedAt: '2026-08-30T00:00:00.000Z',
    notices: [],
    metrics: [],
  }));
  let canaryAbsPath;
  let warmups = 0;
  const upper = makeCoachAdapter();
  upper.warmup = async (input) => {
    warmups += 1;
    return { sessionId: `session-${input.playerId}`, raw: 'ready' };
  };
  const loop = createGameLoop({
    gameDir,
    resolver: async ({ need, canaryAbsPath: canary }) => {
      assert.equal(need, 'upper-only');
      assert.equal(path.isAbsolute(canary), true);
      assert.equal(fs.existsSync(canary), true);
      canaryAbsPath = canary;
      return { player: null, upper, notices: [] };
    },
    opts: { port: 0 },
  });
  t.after(() => loop.requestStop().catch(() => {}));

  await loop.resume();
  assert.equal(fs.existsSync(canaryAbsPath), false);
  assert.equal(warmups, 0, 'finalization must not warm player sessions');
  assert.equal(fs.existsSync(path.join(gameDir, '.player-sessions.json')), false);
  assert.equal((await loop.run()).phase, 'done');
});

test('done resume adopts a live server so normal cleanup stops it without spawning or resolving runtimes', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  const enginePath = path.join(gameDir, 'state.json');
  const engine = readJson(enginePath);
  engine.gameOver = true;
  engine.result = 'lose';
  fs.writeFileSync(enginePath, JSON.stringify(engine));
  writeLoopStateFixture(gameDir, init.sessionToken, { phase: 'done' });
  const external = await startExternalServer(gameDir, init.sessionToken);
  let resolverCalls = 0;
  const loop = createGameLoop({
    gameDir,
    resolver: async () => { resolverCalls += 1; return { player: null, upper: null, notices: [] }; },
    opts: { port: 0 },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(external.child);
  });

  const resumed = await loop.resume();

  assert.equal(resumed.phase, 'done');
  assert.equal(resolverCalls, 0);
  assert.equal(loop.serverPid, external.child.pid, 'done resume did not adopt the live server');
  await loop.requestStop();
  await waitUntilDead(external.child.pid);
});

test('upper-null finalization keeps notices, clears REVIEW_FAILED, and finishes with a factual review', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  writeLoopStateFixture(gameDir, init.sessionToken, {
    phase: 'finalizing',
    halt: { code: 'REVIEW_FAILED', message: 'old review runtime failure' },
    notices: ['prior notice'],
    upperRuntime: 'old-upper',
  });
  const loop = createGameLoop({
    gameDir,
    resolver: async ({ need }) => {
      assert.equal(need, 'upper-only');
      return { player: null, upper: null, notices: ['upper unavailable'] };
    },
    opts: { port: 0 },
  });
  t.after(() => loop.requestStop().catch(() => {}));

  const resumed = await loop.resume();

  assert.equal(resumed.phase, 'finalizing');
  assert.equal(resumed.upperRuntime, null);
  assert.deepEqual(resumed.notices, [
    'prior notice',
    'upper unavailable',
    '상위 모델 런타임이 없어 핸드 1은 고정 코치 문구로 대체합니다.',
  ]);
  assert.equal(Object.hasOwn(resumed, 'halt'), false);
  assert.notEqual(resumed.ownerSessionId, 'old-owner');
  assert.equal((await loop.run()).phase, 'done');
});

test('종료: 마지막 핸드 코치를 재-reserve하지 않고 finalizing 체크포인트로 전이한다', { timeout: 40_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await cliJson(gameDir, ['init', '--ai', '1', '--stack', '100']);
  putUserOnTheButton(gameDir);
  const started = await cliJson(gameDir, ['step', '--new-hand', '--deck', HU_BUST_DECK]);
  assert.equal(started.next.toAct, 'user');
  writeLoopStateFixture(gameDir, init.sessionToken, { phase: 'playing', handNo: 1 });

  const calls = [];
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '마지막 핸드 결정을 평가했습니다.' }) }],
  });
  const player = makeAdapter({
    onDecide: (input) => ({
      raw: JSON.stringify({ decisionId: decisionIdOfMessage(input.message), action: 'call' }),
    }),
  });
  const loop = createGameLoop({
    gameDir,
    resolver: resolverForCoach(player, upper),
    opts: {
      port: 0,
      waitMs: 40,
      onCoachInvoke: (args) => calls.push({ kind: 'coach', args }),
      onPublishInvoke: (args) => calls.push({ kind: 'publish', args }),
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));

  await loop.resume();
  const running = startRun(loop);
  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  await postUserAction(lock, {
    decisionId: snapshot.view.legal.decisionId,
    action: 'raise',
    amount: snapshot.view.legal.maxRaiseTo,
  });

  assert.equal((await running).phase, 'done');

  assert.equal(readJson(path.join(gameDir, 'state.json')).gameOver, true);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopState.phase, 'done');
  assert.equal(loopState.handNo, 1);
  const reserves = coachInvocations(calls, 'reserve')
    .filter((args) => flagValue(args, '--hand') === '1');
  assert.equal(reserves.length, 1, '마지막 핸드 generation을 재-reserve했다');
  assert.equal(upper.starts.length, 1);
  assert.equal(coachInvocations(calls, 'begin-owner').length, 1, 'live finalization이 owner를 교체했다');
  const note = readJson(path.join(gameDir, 'ui-snapshot.json')).coach.find((row) => row.handNo === 1);
  assert.equal(note.unavailable, undefined, '살아 있던 generation의 결과가 유실됐다');
  const cutoff = coachInvocations(calls, 'finalize-cutoff');
  assert.equal(cutoff.length, 1);
  assert.equal(flagValue(cutoff[0], '--termination-confirmed'), 'true');
  assert.equal(flagValue(cutoff[0], '--completed'), '1');
});

test('Task 7A r1: cutoff 커밋 뒤 crash-resume은 pending Q를 owner 교대 중 게시하지 않고 새 deadline으로만 drain한다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedQueuedCoach(gameDir, 'old-owner', 1);
  const stats = await cliJson(gameDir, ['stats']);
  const statsPath = path.join(gameDir, '.post-cutoff-crash-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  const sealed = await runCoachCli(gameDir, [
    'finalize-cutoff', '--owner', 'old-owner', '--completed', '1',
    '--stats-file', statsPath, '--snapshot-file', path.join(gameDir, 'ui-snapshot.json'),
    '--termination-confirmed', 'true',
  ]);
  assert.equal(sealed.reviewGate, 'open');
  const before = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(before.finalization.status, 'SEALED');
  assert.equal(before.noNewPlayTimePublishers, true);
  assert.ok(before.publishQueue['1']);

  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  const resumed = await loop.resume();
  assert.equal(resumed.phase, 'finalizing');
  assert.equal(publishInvocations(calls).length, 0, 'resume owner 교대가 cutoff Q를 먼저 게시했다');
  assert.equal((await loop.run()).phase, 'done');

  const cutoffAt = calls.findIndex((call) => call.kind === 'coach' && call.args[0] === 'finalize-cutoff');
  const firstPublishAt = calls.findIndex((call) => call.kind === 'publish');
  assert.notEqual(cutoffAt, -1);
  assert.equal(firstPublishAt > cutoffAt, true, 'pending Q가 cutoff transaction보다 먼저 게시됐다');
  const publishes = nonReviewPublishInvocations(calls);
  assert.equal(publishes.length, 1);
  assert.match(flagValue(publishes[0], '--deadline-monotonic-ns'), /^\d+$/);
  assert.equal(upper.starts.length, 0);
  const after = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.deepEqual(after.publishQueue, {});
  assert.ok(after.publishedSeals['1']);
});

test('Task 7A r1: persisted coach workers를 shared deadline으로 동시에 닫은 뒤에만 replacement를 시작한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphans = [await startCoachOrphan(), await startCoachOrphan()];
  for (const child of orphans) t.after(() => terminateIfAlive(child));
  const seeded = [
    await seedRunningCoach(gameDir, 'old-owner', 1, orphans[0]),
    await seedRunningCoach(gameDir, 'old-owner', 2, orphans[1]),
  ];
  // #213: on win32 each identity probe is a synchronous PowerShell child (~200 ms) that
  // blocks the event loop between the two workers' SIGTERMs. Serve the start time the seed
  // itself observed for exactly these pids while they are still running; liveness still
  // comes from kill(pid, 0) and every other pid keeps the real probe, so the 80 ms
  // concurrency bound below stays as it is.
  const seededStartTime = (pid) => {
    const index = orphans.findIndex((child) => child.pid === pid);
    if (index === -1) return null;
    const child = orphans[index];
    return child.exitCode === null && child.signalCode === null ? seeded[index].startTime : null;
  };

  const signals = [];
  let liveAtReplacement = [];
  const upper = makeCoachAdapter({
    rounds: [{
      onStart: () => {
        liveAtReplacement = orphans.filter((child) => {
          try { process.kill(child.pid, 0); return true; } catch (error) {
            if (error.code === 'ESRCH') return false;
            throw error;
          }
        }).map((child) => child.pid);
      },
      raw: JSON.stringify({ handNo: 1, text: 'persisted worker closure 뒤 replacement' }),
    }],
  });
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      finalizeBudgetMs: 4_000 * WIN32_SCALE,
      finalizeCutoffLeadMs: 2_000 * WIN32_SCALE,
      orphanTerminateGraceMs: 180,
      orphanTerminateKillWaitMs: 180,
      processStartTime: (pid) => seededStartTime(pid) ?? processStartTime(pid),
      signalProcess: (pid, signal) => {
        if (orphans.some((child) => child.pid === pid)) signals.push({ pid, signal, at: Date.now() });
        process.kill(pid, signal);
      },
    },
  });

  await loop.resume();
  await waitFor(() => upper.starts.length === 1, 'replacement coach did not start');
  await Promise.all(orphans.map((child) => waitUntilDead(child.pid)));

  assert.deepEqual(liveAtReplacement, [], 'persisted worker와 replacement generation이 겹쳤다');
  const terms = signals.filter((entry) => entry.signal === 'SIGTERM');
  assert.equal(terms.length, 2);
  assert.equal(Math.abs(terms[0].at - terms[1].at) < 80, true, 'persisted workers를 순차 종료했다');
  assert.equal((await loop.run()).phase, 'done');
});

test('Task 7A full review: persisted pid startTime mismatch는 다른 pid identity에 signal하지 않고 prior cleanup을 released로 닫는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, 'old-owner', 1, orphan);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.hands['1'].agentHandle = `${orphan.pid}:identity-does-not-match`;
  fs.writeFileSync(authorityPath, JSON.stringify(authority));

  const signalled = [];
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      // This tests PID identity and durable cleanup, with the normal finalization
      // budget. Five real recovery/capture children need not finish within 500 ms.
      signalProcess: (pid, signal) => {
        signalled.push({ pid, signal });
        process.kill(pid, signal);
      },
    },
  });

  await loop.resume();
  await waitFor(() => upper.starts.length >= 1, 'identity replacement 뒤 coach generation이 시작되지 않았다');
  assert.equal((await loop.run()).phase, 'done');

  assert.deepEqual(signalled.filter((entry) => entry.pid === orphan.pid), []);
  assert.equal(upper.starts.length, 1);
  assert.doesNotThrow(() => process.kill(orphan.pid, 0), 'replacement pid identity를 잘못 종료했다');
  const after = readJson(authorityPath);
  assert.equal(after.adapterState, 'enabled');
  assert.equal(
    after.retiredAttempts.find((row) => row.generation === 1)?.cleanupState,
    'released',
  );
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).finalization.cutoff.reviewGate, 'open');
});

test('Task 7A full review: stale coach authority epoch의 live pid에는 signal 없이 durable recovery로 중단한다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, 'old-owner', 1, orphan);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.gameEpoch = 'stale-authority-epoch';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));

  const signals = [];
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      finalizeBudgetMs: 1_500,
      finalizeCutoffLeadMs: 1_000,
      orphanTerminateGraceMs: 20,
      orphanTerminateKillWaitMs: 20,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (pid !== orphan.pid) process.kill(pid, signal);
      },
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  assert.equal(signals.some((entry) => entry.pid === orphan.pid), false, 'stale authority가 가리킨 live pid에 signal을 보냈다');
  assert.doesNotThrow(() => process.kill(orphan.pid, 0));
  const halted = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(halted.phase, 'finalizing');
  assert.equal(halted.halt.code, 'FINALIZATION_ABORTED');
  assert.equal(halted.halt.recovery.code, 'COACH_HANDLE_UNRESOLVED');
  assert.equal(halted.halt.recovery.attempts[0].reason, 'STALE_GAME_EPOCH');
  assert.deepEqual(halted.halt.recovery.commands, []);
});

test('Task 7A full review: finalize 직전 authority epoch 오염도 tracked worker 종료 전에 차단한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const never = new Promise(() => {});
  const upper = makeCoachAdapter({
    rounds: [{ gate: never, raw: JSON.stringify({ handNo: 1, text: '종료되면 안 되는 worker' }) }],
  });
  const signals = [];
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: 1_200 * WIN32_SCALE,
      finalizeCutoffLeadMs: 800 * WIN32_SCALE,
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    },
  });

  await loop.resume();
  await waitFor(() => upper.starts.length === 1, 'finalize epoch guard용 worker가 시작되지 않았다');
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.gameEpoch = 'stale-before-finalize-epoch';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));

  await assert.rejects(loop.run(), (error) => error.code === 'FINALIZATION_ABORTED');

  assert.deepEqual(signals, [], 'stale authority가 가리킨 persisted pid에 signal을 보냈다');
  const halted = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(halted.halt.recovery.attempts[0].reason, 'STALE_GAME_EPOCH');
});

test('Task 7A r1: capture가 cutoff를 가로질러도 reserve 뒤 worker를 spawn/bind하지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let releaseCapture;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  t.after(() => releaseCapture());
  let captureEntered;
  const entered = new Promise((resolve) => { captureEntered = resolve; });
  const upper = makeCoachAdapter({
    rounds: [{
      gate: new Promise(() => {}),
      raw: JSON.stringify({ handNo: 1, text: 'cutoff 뒤 시작하면 안 되는 worker' }),
    }],
  });
  // #213: the POSIX default budget, crossed with a clock jump instead of a 10 s (win32
  // 190 s) wait. The lead also covers a win32 resume's tail before the jump.
  const clock = createJumpClock();
  const resultWaitMs = 10_000 * WIN32_SCALE;
  const leadMs = 10_000 * WIN32_SCALE;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: resultWaitMs + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
      coachCaptureCheckpoint: async () => {
        captureEntered();
        await captureGate;
      },
    },
  });

  await loop.resume();
  await entered;
  // The deadline starts during resume, before capture. Cross its cutoff while capture is
  // parked, before run() arms the settle wait, and observe the settle step seeing it.
  clock.jumpBy(resultWaitMs);
  const running = startRun(loop);
  const cutoff = await waitFor(
    () => readLoopLog(gameDir).find((row) => row.event === 'finalize-coach-settled'),
    'capture stayed blocked without reaching the result-wait cutoff',
    15_000 * WIN32_SCALE,
  );
  assert.equal(cutoff.settled, false, 'the blocked capture did not cross the cutoff');
  assert.equal(cutoff.pending, 1);
  releaseCapture();
  assert.equal((await running).phase, 'done');

  assert.equal(upper.starts.length, 0, 'capture 뒤 cutoff를 재확인하지 않고 worker를 시작했다');
  assert.equal(coachInvocations(calls, 'bind-handle').length, 0);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).finalization.cutoff.terminationConfirmed, true);
});

test('Task 7A full review: reserve 뒤 spawn 경계가 cutoff를 넘으면 handle 없는 worker를 시작하지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let releaseSpawn;
  const spawnGate = new Promise((resolve) => { releaseSpawn = resolve; });
  t.after(() => releaseSpawn());
  let spawnEntered;
  const entered = new Promise((resolve) => { spawnEntered = resolve; });
  const upper = makeCoachAdapter();
  // #213: as above — the POSIX default budget, crossed with a clock jump.
  const clock = createJumpClock();
  const resultWaitMs = 10_000 * WIN32_SCALE;
  const leadMs = 10_000 * WIN32_SCALE;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: resultWaitMs + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
      coachSpawnCheckpoint: async () => {
        spawnEntered();
        await spawnGate;
      },
    },
  });

  await loop.resume();
  await entered;
  clock.jumpBy(resultWaitMs);
  const running = startRun(loop);
  const cutoff = await waitFor(
    () => readLoopLog(gameDir).find((row) => row.event === 'finalize-coach-settled'),
    'spawn stayed blocked without reaching the result-wait cutoff',
    15_000 * WIN32_SCALE,
  );
  assert.equal(cutoff.settled, false, 'the blocked spawn did not cross the cutoff');
  assert.equal(cutoff.pending, 1);
  releaseSpawn();
  assert.equal((await running).phase, 'done');

  assert.equal(upper.starts.length, 0, 'cutoff 뒤 handle 없는 worker를 시작했다');
  assert.equal(coachInvocations(calls, 'bind-handle').length, 0);
});

// #213: a held-lock cutoff test passes vacuously if the result-wait window closes before
// begin-owner is even spawned (a slow host's resume setup can use the whole window).
// runJsonChild records a coach child only after its own "deadline already passed" check,
// so begin-owner must be recorded exactly once and be the last coach child: the one the
// cutoff aborted while it waited on the held lock.
function assertCutoffAbortedBeginOwner(calls) {
  const verbs = coachInvocations(calls).map((args) => args[0]);
  assert.equal(verbs.filter((verb) => verb === 'begin-owner').length, 1, `precondition: begin-owner가 cutoff 전에 시작되지 않았다 (${verbs.join(',')})`);
  assert.equal(verbs.at(-1), 'begin-owner', `precondition: cutoff가 abort한 자식이 begin-owner가 아니다 (${verbs.join(',')})`);
}

test('Task 7A r1: held coach-control lock은 result-wait cutoff에서 종료 시도를 abort하고 review gate를 잠근다', { timeout: 10_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter();
  // #213: the window is scaled so a win32 resume still reaches begin-owner before the
  // cutoff; the lock is held past any window, so only the wait gets longer.
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: 250 * WIN32_SCALE,
      finalizeCutoffLeadMs: 150 * WIN32_SCALE,
      childTimeoutMs: 5_000,
    },
  });
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  const heldOwner = readOwnedLock(gameDir, 'publish.lock.d');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.release();
  };
  t.after(async () => {
    release();
    await held.done;
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  // Keep the lock held until rejection. A stopwatch around resume also counts
  // server/identity setup before the cutoff clock and cleanup after the abort.
  assert.equal(released, false, 'deadline abort waited for the lock release');
  assert.deepEqual(readOwnedLock(gameDir, 'publish.lock.d'), heldOwner);
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.halt.code, 'FINALIZATION_ABORTED');
  assert.equal(state.finalization.cutoff.reason, 'result_wait_cutoff_exceeded');
  assert.equal(state.finalization.cutoff.reviewGate, 'closed');
  assert.equal(upper.starts.length, 0);
  assertCutoffAbortedBeginOwner(calls);
});

test('Task 7A full review: coach-control lock이 result-wait cutoff를 넘으면 late owner/replacement 없이 durable abort한다', { timeout: 10_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: 1_200 * WIN32_SCALE,
      finalizeCutoffLeadMs: 700 * WIN32_SCALE,
      childTimeoutMs: 5_000,
    },
  });
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.release();
  };
  t.after(async () => {
    release();
    await held.done;
  });

  // Resume initializes the relay before its result-wait clock starts. Keep
  // contention until the deadline abort; a wall-clock release races that setup.
  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
  assert.equal(released, false, 'deadline abort waited for the lock release');
  release();
  await held.done;
  await new Promise((resolve) => setTimeout(resolve, 100));

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.phase, 'finalizing');
  assert.equal(state.halt.code, 'FINALIZATION_ABORTED');
  assert.equal(state.finalization.cutoff.reason, 'result_wait_cutoff_exceeded');
  assert.equal(upper.starts.length, 0, 'cutoff 뒤 replacement worker가 시작됐다');
  assert.equal(coachInvocations(calls, 'finalize-cutoff').length, 0);
  assert.equal(fs.existsSync(path.join(gameDir, '.coach-authority.json')), false, 'kill된 begin-owner가 cutoff 뒤 authority를 만들었다');
  assertCutoffAbortedBeginOwner(calls);
});

test('Task 7A full review: result-wait heartbeat는 cutoff에서 끝나고 남은 예산으로 cutoff와 Q drain을 완료한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedQueuedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      finalizeBudgetMs: 3_000 * WIN32_SCALE,
      finalizeCutoffLeadMs: 1_500 * WIN32_SCALE,
      childTimeoutMs: 5_000,
    },
  });
  await loop.resume();
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.release();
  };
  // #213: release the lock when the heartbeat is observed ending at the result-wait
  // cutoff, not on a wall-clock timer tuned to POSIX: the cutoff transaction and Q drain
  // must then complete on the lead that remains.
  const isCutoffHeartbeat = (row) => (
    row.event === 'coach-heartbeat-error'
    && row.phase === 'finalizing'
    && row.code === 'FINALIZATION_RESULT_WAIT_CUTOFF'
  );
  let watching = true;
  const releaseAtCutoff = (async () => {
    while (watching && !released) {
      let seen = false;
      try { seen = readLoopLog(gameDir).some(isCutoffHeartbeat); } catch { /* log not readable yet */ }
      if (seen) {
        release();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  t.after(async () => {
    watching = false;
    await releaseAtCutoff;
    release();
    await held.done;
  });

  assert.equal((await loop.run()).phase, 'done');

  const cutoffHeartbeat = readLoopLog(gameDir).find(isCutoffHeartbeat);
  assert.notEqual(cutoffHeartbeat, undefined, 'heartbeat가 result-wait cutoff 뒤까지 살아남았다');
  assert.equal(coachInvocations(calls, 'finalize-cutoff').length, 1);
  assert.equal(nonReviewPublishInvocations(calls).length, 1);
  assert.equal(upper.starts.length, 0, 'cutoff를 넘긴 heartbeat 뒤 replacement를 시작했다');
});

test('Task 7A r2: finalizing resume은 stale COACH_RECONCILE_PENDING halt를 지우고 cutoff drain에서 Q를 다시 증명한다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedQueuedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: {
      port: external.lock.port,
      halt: { code: 'COACH_RECONCILE_PENDING', message: 'stale finalizing reconcile halt' },
    },
  });

  const resumed = await loop.resume();
  assert.equal(Object.hasOwn(resumed, 'halt'), false, 'finalizing resume이 stale reconcile halt를 보존했다');
  assert.equal(publishInvocations(calls).length, 0);
  assert.equal((await loop.run()).phase, 'done');

  const cutoffAt = calls.findIndex((call) => call.kind === 'coach' && call.args[0] === 'finalize-cutoff');
  const publishAt = calls.findIndex((call) => call.kind === 'publish');
  assert.equal(publishAt > cutoffAt, true);
  assert.deepEqual(readJson(path.join(gameDir, '.coach-authority.json')).publishQueue, {});
});

test('Task 7A r2: expired deadline의 rejected terminate도 관찰되어 unhandledRejection 없이 gate abort로 수렴한다', { timeout: 20_000, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const upper = makeCoachAdapter({
    rounds: [{
      gate,
      raw: JSON.stringify({ handNo: 1, text: 'deadline 뒤 종료 거부' }),
      terminate: async () => { throw Object.assign(new Error('terminate rejected'), { code: 'TERMINATE_REJECTED' }); },
    }],
  });
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: { finalizeBudgetMs: 1_200, finalizeCutoffLeadMs: 600 },
  });
  await loop.resume();
  await waitFor(() => upper.starts.length === 1, 'deadline rejection worker did not start');
  await new Promise((resolve) => setTimeout(resolve, 1_300));

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(loop.run(), (error) => error.code === 'FINALIZATION_ABORTED');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('finalizing 중 requestStop은 BAD_LOOP_PHASE 없이 정상 정리된다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter({
    rounds: [{ gate: new Promise(() => {}), raw: JSON.stringify({ handNo: 1, text: '정지 대기' }) }],
  });
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: { finalizeBudgetMs: 2_000, finalizeCutoffLeadMs: 1_000 },
  });
  await loop.resume();
  const running = loop.run();
  await waitFor(
    () => readLoopLog(gameDir).some((entry) => entry.event === 'finalize-start'),
    'finalize가 시작되지 않았다',
  );
  const stopping = loop.requestStop();
  const result = await running;
  await stopping;
  assert.equal(result.phase, 'finalizing');
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).halt, undefined);
});

test('Task 7A r2: persisted identity unknown은 deadline까지 재조회하고 확인된 동일 pid만 종료한다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan({ ignoreTerm: false });
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, 'old-owner', 1, orphan);
  const countPath = path.join(os.tmpdir(), `holdem-unknown-ps-${process.pid}-${Date.now()}`);
  fs.writeFileSync(countPath, '0');
  t.after(() => { try { fs.unlinkSync(countPath); } catch { /* absent */ } });
  const signals = [];
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      finalizeBudgetMs: 2_500 * WIN32_SCALE,
      finalizeCutoffLeadMs: 1_500 * WIN32_SCALE,
      orphanTerminateGraceMs: 500 * WIN32_SCALE,
      processStartTime: (pid) => {
        if (pid === orphan.pid) {
          const n = Number(fs.readFileSync(countPath, 'utf8')) + 1;
          if (n <= 2) {
            fs.writeFileSync(countPath, String(n));
            return null;
          }
        }
        return processStartTime(pid);
      },
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) signals.push(signal);
        process.kill(pid, signal);
      },
    },
  });

  await loop.resume();
  await waitFor(() => upper.starts.length >= 1, 'unknown identity가 해소된 뒤 replacement가 시작되지 않았다');
  assert.equal((await loop.run()).phase, 'done');

  assert.equal(Number(fs.readFileSync(countPath, 'utf8')) >= 2, true);
  assert.equal(signals.includes('SIGTERM'), true);
  await waitUntilDead(orphan.pid);
});

test('Task 7A r3: permanently unknown persisted identity는 result-wait cutoff에서 polling을 끝내고 durable recovery를 남긴다', { timeout: 15_000, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, 'old-owner', 1, orphan);
  const countPath = path.join(os.tmpdir(), `holdem-always-unknown-ps-${process.pid}-${Date.now()}`);
  fs.writeFileSync(countPath, '0');
  t.after(() => { try { fs.unlinkSync(countPath); } catch { /* absent */ } });
  const signals = [];
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      finalizeBudgetMs: 2_200,
      finalizeCutoffLeadMs: 1_100,
      processStartTime: (pid) => {
        if (pid === orphan.pid) {
          fs.writeFileSync(countPath, String(Number(fs.readFileSync(countPath, 'utf8')) + 1));
          return null;
        }
        return processStartTime(pid);
      },
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) signals.push(signal);
        process.kill(pid, signal);
      },
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  assert.equal(Number(fs.readFileSync(countPath, 'utf8')) > 1, true);
  assert.deepEqual(signals, []);
  assert.equal(coachInvocations(calls, 'fence').length, 1);
  assert.equal(coachInvocations(calls, 'cleanup-result').length, 1);
  assert.equal(coachInvocations(calls, 'adapter-disable').length, 1);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(authority.adapterState, 'disabled');
  assert.equal(authority.hands['1'], undefined);
  assert.equal(authority.retiredAttempts[0].cleanupState, 'termination_unconfirmed');
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.finalization.cutoff.reason, 'persisted_worker_unresolved');
  assert.equal(state.halt.recovery.code, 'COACH_HANDLE_UNRESOLVED');
  assert.equal(upper.starts.length, 0);
});

test('Task 7A full review: handle-less persisted generation은 owner 교대 전에 recovery argv와 함께 abort되고 released 뒤 재개된다', { timeout: 30_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);
  const firstUpper = makeCoachAdapter();
  const first = finalizingLoop(t, gameDir, init.sessionToken, {
    upper: firstUpper,
    stateOverrides: { port: external.lock.port },
    // #192 O1/L1: force the legacy scanner unavailable so this genuinely unresolved
    // handle-less row stays unresolved regardless of the host's stray process table.
    loopOpts: { scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'test-fixture' }) },
  });

  await assert.rejects(first.loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const halted = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(halted.halt.code, 'FINALIZATION_ABORTED');
  assert.equal(halted.halt.recovery.code, 'COACH_HANDLE_UNRESOLVED');
  assert.equal(halted.halt.recovery.prerequisites.authenticatedServerLock, true);
  assert.equal(halted.halt.recovery.prerequisites.sessionToken, init.sessionToken);
  assert.equal(halted.halt.recovery.commands.length, 1);
  assert.equal(halted.halt.recovery.commands[0].args.includes('cleanup-result'), true);
  assert.equal(halted.halt.recovery.commands[0].args.includes('released'), true);
  assert.equal(coachInvocations(first.calls, 'begin-owner').length, 0);
  assert.equal(firstUpper.starts.length, 0);
  assert.equal(readJson(path.join(gameDir, '.coach-authority.json')).activeOwnerSessionId, 'old-owner');

  const recoveryServer = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(recoveryServer.child));
  const recovery = halted.halt.recovery.commands[0];
  await assert205UnconfirmedCommand(gameDir, recovery);
  const recovered = JSON.parse((await execFileAsync(recovery.program, [...recovery.args, '--operator-confirmed', '1'], {
    encoding: 'utf8', timeout: 5_000,
  })).stdout.trim());
  assert.equal(recovered.cleanupState, 'released');
  assert.equal(reserved.generation, 1);

  const secondCalls = [];
  const secondUpper = makeCoachAdapter();
  const second = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: secondUpper, notices: [] }),
    opts: {
      port: 0,
      waitMs: 0,
      onCoachInvoke: (args) => secondCalls.push({ kind: 'coach', args }),
      onPublishInvoke: (args) => secondCalls.push({ kind: 'publish', args }),
    },
  });
  t.after(() => second.requestStop().catch(() => {}));
  await second.resume();
  assert.equal((await second.run()).phase, 'done');
  assert.equal(coachInvocations(secondCalls, 'begin-owner').length, 1);
});

test('Task 7A: non-deadline coach-control child failure는 raw 탈출 없이 durable recovery halt로 수렴한다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  t.after(async () => { held.release(); await held.done; });
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper: makeCoachAdapter(),
    stateOverrides: { port: external.lock.port },
    loopOpts: { childTimeoutMs: 100, finalizeBudgetMs: 5_000, finalizeCutoffLeadMs: 1_000 },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.finalization.cutoff.reason, 'persisted_worker_unresolved');
  assert.equal(state.halt.recovery.attempts.some((row) => row.reason === 'FENCE_CHILD_FAILED'), true);
  assert.deepEqual(state.halt.recovery.commands, []);
});

test('Task 7A r2: persisted authority fence/cleanup은 shared deadline 아래 hand별로 동시에 시작한다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphans = [await startCoachOrphan(), await startCoachOrphan()];
  await seedRunningCoach(gameDir, 'old-owner', 1, orphans[0]);
  await seedRunningCoach(gameDir, 'old-owner', 2, orphans[1]);
  await Promise.all(orphans.map((child) => terminateIfAlive(child)));
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.release();
  };
  t.after(async () => { release(); await held.done; });
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  const resuming = loop.resume();
  resuming.catch(() => {});
  // Both real children must start while the same lock is still held. Releasing
  // after an arbitrary delay can hide serialization on a slow scheduler.
  await waitFor(() => coachInvocations(calls, 'fence').length === 2, 'persisted fence children did not start concurrently');
  const concurrentFences = coachInvocations(calls, 'fence').length;
  release();
  await resuming;

  assert.equal(concurrentFences, 2, 'persisted fence children were serialized per hand');
  assert.equal((await loop.run()).phase, 'done');
});

test('Task 7A r3: Q로 이미 봉인되고 pid가 죽은 retired attempt는 cleanup released를 durable 기록한다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  await seedRunningCoach(gameDir, 'old-owner', 1, orphan);
  const authorityBefore = readJson(path.join(gameDir, '.coach-authority.json'));
  const reserved = authorityBefore.hands['1'];
  await acceptRunningCoach(gameDir, 'old-owner', reserved, 1);
  await terminateIfAlive(orphan);
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  await loop.resume();
  const cleanups = coachInvocations(calls, 'cleanup-result');
  assert.equal(cleanups.length, 1);
  assert.equal(flagValue(cleanups[0], '--cleanup-state'), 'released');
  assert.equal(
    readJson(path.join(gameDir, '.coach-authority.json')).retiredAttempts[0].cleanupState,
    'released',
  );
  assert.equal(upper.starts.length, 0);
  assert.equal((await loop.run()).phase, 'done');
});

test('Task 7A r2: finalizing resume begin-owner 전에 result-wait cutoff를 설치해 5초 미만 attempt-2를 막는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  // #213: the 5 s replacement floor is absolute, so a scaled window would change the
  // scenario. The window is large instead, and a clock jump leaves less than 5 s of it.
  // Attempt 1 answers only after its bind is durable and the jump has landed, so a slow
  // host has to fit just the complete-unavailable seal into what is left.
  const clock = createJumpClock();
  const cutoffs = [];
  let answerAttemptOne;
  const attemptOneGate = new Promise((resolve) => { answerAttemptOne = resolve; });
  t.after(() => answerAttemptOne());
  const upper = makeCoachAdapter({
    rounds: [
      { gate: attemptOneGate, raw: 'invalid first coach response' },
      { raw: JSON.stringify({ handNo: 1, text: '금지된 pre-run replacement' }) },
    ],
  });
  const leadMs = 4_000 * WIN32_SCALE;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: 10_000 * WIN32_SCALE + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
      onFinalizationDeadline: (installed) => {
        cutoffs.push({ ...installed, beginOwners: coachInvocations(calls, 'begin-owner').length });
      },
    },
  });

  await loop.resume();
  assert.equal(cutoffs.length, 1, 'finalizing resume이 result-wait cutoff를 설치하지 않았다');
  assert.equal(cutoffs[0].beginOwners, 0, 'result-wait cutoff가 begin-owner 뒤에 설치됐다');
  await waitFor(
    () => readJson(path.join(gameDir, '.coach-authority.json')).hands?.['1']?.agentHandle,
    'resume-time attempt 1 was not bound',
  );
  clock.jumpTo(cutoffs[0].resultWaitCutoffNs - LEFT_BELOW_REPLACEMENT_FLOOR_NS);
  answerAttemptOne();
  await waitFor(
    () => upper.starts.length >= 2 || coachInvocations(calls, 'complete-unavailable').length >= 1,
    'resume-time attempt 1 did not settle',
  );

  assert.equal(upper.starts.length, 1, 'result-wait 잔여 5초 미만인데 attempt 2를 시작했다');
  assert.equal(
    coachInvocations(calls, 'reserve').filter((args) => flagValue(args, '--attempt') === '2').length,
    0,
  );
  assert.equal(flagValue(coachInvocations(calls, 'complete-unavailable')[0], '--reason'), 'finalize-no-replacement-budget');
  assert.equal((await loop.run()).phase, 'done');
});

test('#213 onFinalizationDeadline은 cutoff 설치를 한 번 관찰만 하고, 던져도 finalization을 바꾸지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const observed = [];
  const leadMs = 4_000 * WIN32_SCALE;
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper: makeCoachAdapter(),
    loopOpts: {
      finalizeBudgetMs: 6_000 * WIN32_SCALE,
      finalizeCutoffLeadMs: leadMs,
      onFinalizationDeadline: (installed) => {
        observed.push(installed);
        throw new Error('an observer failure must not reach finalization');
      },
    },
  });

  await loop.resume();
  assert.equal((await loop.run()).phase, 'done');

  assert.equal(observed.length, 1);
  assert.equal(typeof observed[0].deadlineNs, 'bigint');
  assert.equal(observed[0].deadlineNs - observed[0].resultWaitCutoffNs, BigInt(leadMs) * 1_000_000n);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopState.halt, undefined);
  assert.equal(loopState.finalization.cutoff.reviewGate, 'open');
});

test('Task 7A r2: open review gate는 cutoff deadline을 해제하고 독립 300초 Task 7B handoff scope를 연다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let seamCalls = 0;
  const upper = makeCoachAdapter();
  const clock = createJumpClock();
  const finalizeBudgetMs = 3_000 * WIN32_SCALE;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs,
      finalizeCutoffLeadMs: 2_000 * WIN32_SCALE,
      monotonicNs: clock.monotonicNs,
      reviewGateCheckpoint: async () => {
        seamCalls += 1;
        // #213: move the clock past the whole finalization budget at once (was a 3.2 s
        // sleep against a 3 s budget): the handoff child after the reset must still run.
        clock.jumpBy(finalizeBudgetMs + 1_000);
      },
    },
  });

  await loop.resume();
  assert.equal((await loop.run()).phase, 'done');

  assert.equal(seamCalls, 1);
  assert.equal(coachInvocations(calls, 'completeness').length, 1, 'reset 뒤 Task 7B handoff proof child가 실행되지 않았다');
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.finalization.deadlineScope, 'review_generation');
  assert.equal(state.finalization.reviewGenerationTimeoutMs, 300_000);
});

test('Task 7A full review: terminal engine lastHand.handNo가 없으면 stats sample로 대체하지 않고 fail closed한다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const enginePath = path.join(gameDir, 'state.json');
  const engine = readJson(enginePath);
  delete engine.lastHand;
  fs.writeFileSync(enginePath, JSON.stringify(engine));
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, { upper });

  await loop.resume();
  await assert.rejects(loop.run(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.phase, 'finalizing');
  assert.equal(state.halt.code, 'FINALIZATION_ABORTED');
  assert.match(state.halt.message, /lastHand\.handNo/);
  assert.equal(state.finalization.cutoff.terminationConfirmed, true);
  assert.equal(coachInvocations(calls, 'finalize-cutoff').length, 0);
  assert.equal(upper.evaluatorStarts.length + upper.synthesizerStarts.length, 0);
});

test('Task 7A full review: engine lastHand.handNo와 stats user.sample 불일치는 fail closed한다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const enginePath = path.join(gameDir, 'state.json');
  const engine = readJson(enginePath);
  engine.stats.user.hands = 0;
  fs.writeFileSync(enginePath, JSON.stringify(engine));
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, { upper });

  await loop.resume();
  await assert.rejects(loop.run(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.phase, 'finalizing');
  assert.equal(state.halt.code, 'FINALIZATION_ABORTED');
  assert.match(state.halt.message, /stats user\.sample/);
  assert.equal(state.finalization.cutoff.terminationConfirmed, true);
  assert.equal(coachInvocations(calls, 'finalize-cutoff').length, 0);
  assert.equal(upper.evaluatorStarts.length + upper.synthesizerStarts.length, 0);
});

test('종료: finalizing resume은 새 owner로 begin-owner를 한 번만 실행하고 봉인된 핸드를 재스폰하지 않는다', { timeout: 40_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  // coach-control reads the session identity from lock.json, so the pre-crash Q is
  // seeded against a live server that the finalizing resume then adopts.
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedQueuedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  const resumed = await loop.resume();
  assert.equal(publishInvocations(calls).length, 0, 'pre-cutoff Q를 owner 교대 중 drain했다');
  assert.equal((await loop.run()).phase, 'done');

  assert.notEqual(resumed.ownerSessionId, 'old-owner');
  const beginOwners = coachInvocations(calls, 'begin-owner');
  assert.equal(beginOwners.length, 1);
  assert.equal(flagValue(beginOwners[0], '--owner'), resumed.ownerSessionId);
  assert.equal(upper.starts.length, 0, '이미 Q에 있는 핸드를 재스폰했다');
  assert.equal(readJson(path.join(gameDir, 'ui-snapshot.json')).coach.some((row) => row.handNo === 1), true);
  const cutoff = coachInvocations(calls, 'finalize-cutoff');
  assert.equal(cutoff.length, 1);
  assert.equal(flagValue(cutoff[0], '--owner'), resumed.ownerSessionId);
  assert.equal(flagValue(cutoff[0], '--completed'), '1');
  const cutoffAt = calls.findIndex((call) => call.kind === 'coach' && call.args[0] === 'finalize-cutoff');
  const publishAt = calls.findIndex((call) => call.kind === 'publish');
  assert.equal(publishAt > cutoffAt, true, 'pre-cutoff Q가 cutoff보다 먼저 게시됐다');
  assert.match(flagValue(publishInvocations(calls)[0], '--deadline-monotonic-ns'), /^\d+$/);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(authority.finalization.status, 'SEALED');
  assert.equal(authority.activeOwnerSessionId, resumed.ownerSessionId);
});

test('종료: 예산을 넘긴 tracked 코치 생성은 종료 확인 뒤 finalize-cutoff가 봉인한다', { timeout: 40_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const upper = makeCoachAdapter({
    rounds: [{ gate, raw: JSON.stringify({ handNo: 1, text: '예산을 넘긴 코치' }) }],
  });
  const clock = createJumpClock();
  const resultWaitMs = 5_000 * WIN32_SCALE;
  const leadMs = 4_300 * WIN32_SCALE;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: resultWaitMs + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
    },
  });

  await loop.resume();
  // #213: cross the cutoff with a clock jump once the tracked worker's bind is durable,
  // instead of a 700 ms window a win32 resume overruns before spawn and bind.
  await waitFor(
    () => readJson(path.join(gameDir, '.coach-authority.json')).hands?.['1']?.agentHandle,
    'tracked coach was not bound before the cutoff',
  );
  clock.jumpBy(resultWaitMs);
  assert.equal((await loop.run()).phase, 'done');

  assert.equal(upper.starts.length, 1, 'begin-owner descriptor가 스폰되지 않았다');
  assert.equal(upper.terminations.length, 1, 'cutoff가 live generation을 종료하지 않았다');
  const verbs = calls.filter((call) => call.kind === 'coach').map((call) => call.args[0]);
  const cutoffAt = verbs.indexOf('finalize-cutoff');
  assert.notEqual(cutoffAt, -1);
  assert.equal(verbs.indexOf('bind-handle') < cutoffAt, true, 'bind-handle이 cutoff 뒤로 밀렸다');
  assert.equal(
    verbs.slice(cutoffAt + 1).some((verb) => verb === 'reserve' || verb === 'begin-owner'),
    false,
    'cutoff 뒤에 새 generation을 예약했다',
  );
  const cutoff = coachInvocations(calls, 'finalize-cutoff')[0];
  assert.equal(flagValue(cutoff, '--termination-confirmed'), 'true');
  assert.equal(flagValue(cutoff, '--completed'), '1');
  assert.equal(flagValue(cutoff, '--snapshot-file'), path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(fs.existsSync(flagValue(cutoff, '--stats-file')), true);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopState.finalization.budgetMs, resultWaitMs + leadMs);
  assert.equal(loopState.finalization.resultWaitMs, resultWaitMs);
  assert.equal(loopState.finalization.cutoff.terminationConfirmed, true);
  assert.deepEqual(loopState.finalization.cutoff.sealed, [1]);
  const note = readJson(path.join(gameDir, 'ui-snapshot.json')).coach.find((row) => row.handNo === 1);
  assert.equal(note.unavailable, true);
});

test('종료: result-wait 잔여가 5초 미만이면 attempt 2 교체 없이 그 generation을 unavailable로 봉인한다', { timeout: 40_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  // Attempt 1 fails only after the finalization checkpoint exists. #213: the window is
  // large (the 5 s floor of §9.2 (2) is absolute, so it is not scaled) and a clock jump at
  // that moment leaves less than 5 s of it.
  const clock = createJumpClock();
  const cutoffs = [];
  const gate = waitFor(
    () => Boolean(readJson(path.join(gameDir, 'loop-state.json')).finalization),
    'finalization checkpoint did not appear',
    10_000 * WIN32_SCALE,
  ).then(() => {
    assert.equal(cutoffs.length, 1, 'result-wait cutoff was not installed');
    clock.jumpTo(cutoffs[0].resultWaitCutoffNs - LEFT_BELOW_REPLACEMENT_FLOOR_NS);
  });
  const upper = makeCoachAdapter({
    rounds: [
      { gate, raw: '코치 응답이 JSON이 아니다' },
      { raw: JSON.stringify({ handNo: 1, text: '교체 예산 없이 스폰된 attempt 2' }) },
    ],
  });
  const leadMs = 4_000 * WIN32_SCALE;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: 10_000 * WIN32_SCALE + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
      onFinalizationDeadline: (installed) => cutoffs.push(installed),
    },
  });

  await loop.resume();
  assert.equal((await loop.run()).phase, 'done');

  assert.equal(upper.starts.length, 1, '5초 미만 잔여 예산으로 교체 attempt 2를 스폰했다');
  assert.equal(upper.terminations.length, 1);
  assert.equal(
    coachInvocations(calls, 'reserve').filter((args) => flagValue(args, '--attempt') === '2').length,
    0,
    '교체 reserve가 실행됐다',
  );
  const unavailable = coachInvocations(calls, 'complete-unavailable');
  assert.equal(unavailable.length, 1);
  assert.equal(flagValue(unavailable[0], '--reason'), 'finalize-no-replacement-budget');
  assert.notEqual(flagValue(unavailable[0], '--generation'), null, 'attempt 1 generation 없이 봉인했다');
  const note = readJson(path.join(gameDir, 'ui-snapshot.json')).coach.find((row) => row.handNo === 1);
  assert.equal(note.unavailable, true);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopState.finalization.cutoff.terminationConfirmed, true);
  assert.deepEqual(loopState.finalization.cutoff.sealed, [], 'cutoff 전에 봉인되지 않은 핸드가 남았다');
  assert.equal(loopState.finalization.cutoff.reviewGate, 'open');
});

test('종료: cutoff 뒤 잔여 Q만 deadline 게시로 정확히 한 번 실린다', { timeout: 40_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const upper = makeCoachAdapter({
    rounds: [{ gate, raw: JSON.stringify({ handNo: 1, text: '예산을 넘긴 코치' }) }],
  });
  const clock = createJumpClock();
  const resultWaitMs = 5_000 * WIN32_SCALE;
  const leadMs = 4_300 * WIN32_SCALE;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: resultWaitMs + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
    },
  });

  await loop.resume();
  // #213: cross the cutoff with a clock jump once the tracked worker's bind is durable,
  // instead of a 700 ms window a win32 resume overruns before spawn and bind.
  await waitFor(
    () => readJson(path.join(gameDir, '.coach-authority.json')).hands?.['1']?.agentHandle,
    'tracked coach was not bound before the cutoff',
  );
  clock.jumpBy(resultWaitMs);
  assert.equal((await loop.run()).phase, 'done');

  const cutoffAt = calls.findIndex((call) => call.kind === 'coach' && call.args[0] === 'finalize-cutoff');
  assert.equal(
    calls.slice(0, cutoffAt).some((call) => call.kind === 'publish'),
    false,
    'cutoff 전에 게시할 것이 없는데 게시했다',
  );
  const residual = calls.slice(cutoffAt + 1).filter((call) => (
    call.kind === 'publish' && path.basename(flagValue(call.args, '--from') ?? '') !== '.review.json'
  ));
  assert.equal(residual.length, 1, '잔여 Q가 정확히 한 번 게시되지 않았다');
  assert.equal(residual[0].args.includes('--deadline-monotonic-ns'), true);
  assert.match(flagValue(residual[0].args, '--deadline-monotonic-ns'), /^\d+$/);
  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(snapshot.coach.filter((row) => row.handNo === 1).length, 1);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(authority.noNewPlayTimePublishers, true);
  assert.equal(authority.publishQueue['1'], undefined);
  assert.notEqual(authority.publishedSeals['1'], undefined);
  assert.equal(nonReviewPublishInvocations(calls).length, 1);
});

test('종료: 종료 미확인 코치는 fence·adapter-disable 뒤 FINALIZATION_ABORTED로 리뷰 게이트를 잠근다', { timeout: 40_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const upper = makeCoachAdapter({
    rounds: [{
      gate,
      raw: JSON.stringify({ handNo: 1, text: '종료를 확인할 수 없는 코치' }),
      terminate: { confirmed: false, reason: 'reason-must-not-open-the-gate' },
    }],
  });
  const clock = createJumpClock();
  const resultWaitMs = 5_000 * WIN32_SCALE;
  const leadMs = 4_300 * WIN32_SCALE;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: resultWaitMs + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
    },
  });

  await loop.resume();
  // #213: cross the cutoff with a clock jump once the tracked worker's bind is durable,
  // instead of a 700 ms window a win32 resume overruns before spawn and bind.
  await waitFor(
    () => readJson(path.join(gameDir, '.coach-authority.json')).hands?.['1']?.agentHandle,
    'tracked coach was not bound before the cutoff',
  );
  clock.jumpBy(resultWaitMs);
  await assert.rejects(loop.run(), (error) => error.code === 'FINALIZATION_ABORTED');

  const verbs = coachInvocations(calls).map((args) => args[0]);
  assert.equal(verbs.includes('fence'), true);
  assert.equal(verbs.includes('adapter-disable'), true);
  const cutoff = coachInvocations(calls, 'finalize-cutoff');
  assert.equal(cutoff.length, 1);
  assert.equal(flagValue(cutoff[0], '--termination-confirmed'), 'false');
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopState.halt.code, 'FINALIZATION_ABORTED');
  assert.equal(loopState.finalization.cutoff.reviewGate, 'closed');
  assert.equal(loopState.finalization.cutoff.terminationConfirmed, false);
  assert.equal(loopState.notices.some((notice) => notice.includes('리뷰')), true);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(authority.finalization, null, 'abort된 cutoff가 authority를 커밋했다');
  assert.equal(authority.adapterState, 'disabled');
  assert.equal(authority.publishedSeals['1'], undefined);
  assert.equal(fs.existsSync(path.join(gameDir, 'review.md')), false);
});

// ── #192 RED: HEAD fail-open 경로 (설계 docs/design 2026-09-13-issue-192 §1.3) ──────────

test('#192 FO-2 RED: 코치 oneshot의 startTime이 null이면 "pid:null"을 bind-handle하지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const handles = [];
  const upper = makeCoachAdapter({
    rounds: [{
      gate: new Promise(() => {}),
      startTime: null,
      terminate: { confirmed: true },
      raw: JSON.stringify({ handNo: 1, text: 'identity 없는 worker' }),
    }],
  });
  const { loop } = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke(args) {
        if (args[0] === 'bind-handle') handles.push(args[args.indexOf('--handle') + 1]);
      },
    },
  });
  const running = startRun(loop);

  await waitFor(() => upper.starts.length >= 1, 'coach worker was not started');
  await waitFor(
    () => handles.length >= 1 || upper.terminations.length >= 1,
    'neither bind-handle nor terminate followed the spawn',
  );
  await stopRun(loop, running);

  assert.deepEqual(
    handles.filter((handle) => /:null$/.test(handle)),
    [],
    'an unverified null startTime was persisted as a coach handle',
  );
});

test('#192 O6: 코치 oneshot의 startTime이 빈 문자열/공백뿐이면 identity-unavailable로 처리하고 bind-handle하지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  for (const sentinelStartTime of ['', '   ']) {
    const handles = [];
    const upper = makeCoachAdapter({
      rounds: [{
        gate: new Promise(() => {}),
        startTime: sentinelStartTime,
        terminate: { confirmed: true },
        raw: JSON.stringify({ handNo: 1, text: 'identity 없는 worker' }),
      }],
    });
    const { loop } = await setupCoachHand(t, {
      upper,
      loopOpts: {
        onCoachInvoke(args) {
          if (args[0] === 'bind-handle') handles.push(args[args.indexOf('--handle') + 1]);
        },
      },
    });
    const running = startRun(loop);

    await waitFor(() => upper.starts.length >= 1, 'coach worker was not started');
    await waitFor(
      () => handles.length >= 1 || upper.terminations.length >= 1,
      'neither bind-handle nor terminate followed the spawn',
    );
    await stopRun(loop, running);

    assert.equal(
      handles.length,
      0,
      `a "${sentinelStartTime}" startTime identity was bound as a coach handle`,
    );
    assert.equal(
      upper.terminations.length,
      1,
      `a "${sentinelStartTime}" startTime identity was not terminated as identity-unavailable`,
    );
  }
});

test('#192 O7: 이미 identity sidecar가 있으면 pipeline이 재실행돼도 spawn하지 않고 sidecar를 그대로 둔다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  let gameDir;
  let sidecarPath;
  let seededPayload;
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '기본 코치 응답' }) }],
  });
  const setup = await setupCoachHand(t, {
    upper,
    loopOpts: {
      // Simulates "a pipeline ran twice for the same attempt path": by the time this
      // checkpoint fires, `reserve` has already recorded this exact attempt's tuple in
      // `.coach-authority.json`, so the sidecar this seeds here carries the identical
      // {gameEpoch, owner, handNo, generation, attempt} the real pipeline is about to
      // compute for its own `intent` write.
      coachSpawnCheckpoint: async ({ handNo, attempt }) => {
        if (seededPayload) return;
        const authority = readJson(path.join(gameDir, '.coach-authority.json'));
        const hand = authority.hands[String(handNo)];
        const state = readJson(path.join(gameDir, 'loop-state.json'));
        sidecarPath = coachSpawnSidecarPath(gameDir, hand.exactResultPath);
        seededPayload = {
          phase: 'identity',
          gameEpoch: state.gameEpoch,
          owner: state.ownerSessionId,
          handNo,
          generation: hand.generation,
          attempt,
          pid: 999_999,
          startTime: 'sentinel-o7-start',
        };
        fs.writeFileSync(sidecarPath, JSON.stringify(seededPayload));
      },
    },
  });
  gameDir = setup.gameDir;
  const { loop } = setup;

  const running = startRun(loop);
  await waitFor(() => seededPayload !== undefined, 'coachSpawnCheckpoint never fired');
  await stopRun(loop, running);

  assert.equal(upper.starts.length, 0, '이미 identity가 있는 attempt에 대해 두 번째 spawn을 시도했다');
  assert.deepEqual(readJson(sidecarPath), seededPayload, '기존 identity sidecar가 다른 phase로 덮어써졌다');
});

test('#192 S3: identity-unavailable 분기에서 fence child가 실패해도 attempt 2를 예약하지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  let gameDir;
  let originalOwner = null;
  const upper = makeCoachAdapter({
    rounds: [{
      gate: new Promise(() => {}),
      startTime: null,
      terminate: { confirmed: true },
      raw: JSON.stringify({ handNo: 1, text: '테스트용 응답' }),
      // Fires the instant oneshotStart is called, before this attempt ever reaches the
      // identity-unavailable branch's own fenceCurrentGeneration() call below. Hijacking
      // the coach authority's active owner out from under it makes that exact fence CLI
      // call fail with STALE_OWNER (never STALE_GENERATION), so it propagates out of the
      // null-identity branch and into the pipeline's outer catch — the scenario the S3
      // fix (identityUnavailableReason) must never turn into a replacement attempt 2. The
      // owner is restored (below, via onCoachInvoke) just before complete-unavailable runs
      // so that call — whichever branch issues it — can still actually seal the hand.
      onStart: () => {
        const authorityPath = path.join(gameDir, '.coach-authority.json');
        const authority = readJson(authorityPath);
        originalOwner = authority.activeOwnerSessionId;
        authority.activeOwnerSessionId = 'hijacked-owner';
        fs.writeFileSync(authorityPath, JSON.stringify(authority));
      },
    }],
  });
  const coachCalls = [];
  const setup = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke: (args) => {
        coachCalls.push(args);
        if (args[0] === 'complete-unavailable' && originalOwner !== null) {
          const authorityPath = path.join(gameDir, '.coach-authority.json');
          const authority = readJson(authorityPath);
          authority.activeOwnerSessionId = originalOwner;
          fs.writeFileSync(authorityPath, JSON.stringify(authority));
        }
      },
    },
  });
  gameDir = setup.gameDir;
  const { loop } = setup;

  const running = startRun(loop);
  await waitFor(() => upper.starts.length >= 1, 'coach worker was not started');
  await waitFor(() => upper.terminations.length >= 1, 'identity-unavailable branch did not terminate the attempt');
  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.equal(note.unavailable, true, 'identity-unavailable 실패가 unavailable로 봉인되지 않았다');
  assert.equal(upper.starts.length, 1, 'identity-unavailable 실패 뒤 attempt 2 spawn이 발생했다');
  const reserves = coachCalls.filter((args) => args[0] === 'reserve' && flagValue(args, '--hand') === '1');
  assert.equal(reserves.length, 1, 'identity-unavailable 실패 뒤 attempt 2를 위해 다시 reserve했다');
});

// #213: "not released" and "no signal" also hold when the finalization deadline simply
// expires first, so pin the abort to the identity classification itself: the persisted
// row stays unresolved on the injected scanner's own answer (not SCAN_DEADLINE,
// DEADLINE_EXCEEDED or IDENTITY_UNKNOWN), and the cutoff is not a deadline abort.
function assertUnverifiedIdentityHalt(gameDir, resumeError) {
  assert.equal(resumeError?.code, 'FINALIZATION_ABORTED', `resume ${resumeError?.code ?? 'ok'}`);
  const halted = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(halted.finalization.cutoff.reason, 'persisted_worker_unresolved');
  assert.deepEqual(
    halted.halt.recovery.attempts.map((row) => [row.reason, row.evidence?.legacyScanDetail]),
    [['LEGACY_SCAN_UNAVAILABLE', 'TEST_DEFAULT']],
  );
}

test('#192 FO-2 RED: persisted "pid:null" handle은 검증된 identity가 아니므로 released로 닫지 않는다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  // #192 O1/L1: this orphan's cwd must mimic a real coach CLI child's `ai-holdem-*`
  // convention — judgment g's process scanner only recognizes that shape, and this test's
  // whole point is that an alive-but-unverified identity is never silently auto-recovered.
  const { child: orphan, tagDir } = await startTaggedCoachOrphan();
  t.after(() => terminateIfAlive(orphan));
  t.after(() => { try { fs.rmSync(tagDir, { recursive: true, force: true }); } catch { /* gone */ } });
  const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);
  await createCoachControl().bindHandle({
    gameDir, owner: 'old-owner', handNo: 1,
    generation: reserved.generation, handle: `${orphan.pid}:null`,
  });
  const signals = [];
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper: makeCoachAdapter(),
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      finalizeBudgetMs: 2_500 * WIN32_SCALE,
      finalizeCutoffLeadMs: 1_500 * WIN32_SCALE,
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) signals.push(signal);
        process.kill(pid, signal);
      },
    },
  });

  let resumeError = null;
  try {
    await loop.resume();
  } catch (error) {
    resumeError = error;
  }

  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = (authority.retiredAttempts ?? []).find((entry) => entry.handNo === 1);
  assert.notEqual(
    row?.cleanupState,
    'released',
    `an unverified "pid:null" identity was closed as released (resume ${resumeError?.code ?? 'ok'})`,
  );
  assert.deepEqual(signals, [], 'a signal was sent to a pid whose identity was never verified');
  assertUnverifiedIdentityHalt(gameDir, resumeError);
});

test('#192 S1: persisted handle의 startTime이 공백뿐이거나 "undefined"면 검증된 identity로 취급하지 않는다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  for (const sentinelStartTime of ['   ', 'undefined']) {
    const gameDir = tmpGame();
    const init = await seedFinishedGame(gameDir);
    const external = await startExternalServer(gameDir, init.sessionToken);
    t.after(() => terminateIfAlive(external.child));
    // #192 O1/L1: tag this orphan's cwd like a real coach CLI child so judgment g's
    // process scanner recognizes it as live — this test's whole point is that an
    // alive-but-unverified identity is never silently auto-recovered.
    const { child: orphan, tagDir } = await startTaggedCoachOrphan();
    t.after(() => terminateIfAlive(orphan));
    t.after(() => { try { fs.rmSync(tagDir, { recursive: true, force: true }); } catch { /* gone */ } });
    const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);
    await createCoachControl().bindHandle({
      gameDir, owner: 'old-owner', handNo: 1,
      generation: reserved.generation, handle: `${orphan.pid}:${sentinelStartTime}`,
    });
    const signals = [];
    const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
      upper: makeCoachAdapter(),
      stateOverrides: { port: external.lock.port },
      loopOpts: {
        finalizeBudgetMs: 2_500 * WIN32_SCALE,
        finalizeCutoffLeadMs: 1_500 * WIN32_SCALE,
        signalProcess: (pid, signal) => {
          if (pid === orphan.pid) signals.push(signal);
          process.kill(pid, signal);
        },
      },
    });

    let resumeError = null;
    try {
      await loop.resume();
    } catch (error) {
      resumeError = error;
    }

    const authority = readJson(path.join(gameDir, '.coach-authority.json'));
    const row = (authority.retiredAttempts ?? []).find((entry) => entry.handNo === 1);
    assert.notEqual(
      row?.cleanupState,
      'released',
      `a "${sentinelStartTime}" startTime identity was closed as released (resume ${resumeError?.code ?? 'ok'})`,
    );
    assert.deepEqual(
      signals,
      [],
      `a signal was sent to a pid whose "${sentinelStartTime}" startTime identity was never verified`,
    );
    assertUnverifiedIdentityHalt(gameDir, resumeError);
  }
});

test('#192 FO-3 RED: policy playing resume도 살아 있는 persisted coach를 회수한 뒤에만 begin-owner를 호출한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 0, opponentRuntime: 'policy' },
  });
  await first.bootstrap({ ai: 1, stack: 100, opponentRuntime: 'policy' });
  const oldOwner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  const orphan = await startCoachOrphan({ ignoreTerm: false });
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, oldOwner, 1, orphan);
  await first.requestStop();

  const calls = [];
  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 0,
      opponentRuntime: 'policy',
      pollMs: 10,
      orphanTerminateGraceMs: 500 * WIN32_SCALE,
      orphanTerminateKillWaitMs: 200 * WIN32_SCALE,
      resumeReclaimResidualMs: 5_000 * WIN32_SCALE,
      onCoachInvoke: (args) => calls.push(args),
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));

  const state = await resumed.resume();

  assert.equal(state.phase, 'playing');
  const cleanupIndex = calls.findIndex((args) => args[0] === 'cleanup-result');
  const beginIndex = calls.findIndex((args) => args[0] === 'begin-owner');
  assert.equal(cleanupIndex >= 0, true, 'policy playing resume skipped persisted coach reclaim');
  assert.equal(beginIndex > cleanupIndex, true, 'begin-owner ran before persisted cleanup completed');
  await waitUntilDead(orphan.pid);
});

test('#192 S3 D6: policy playing resume의 persisted coach 회수는 ensureServer 뒤·beginCoachOwner 전에 실행되고 player adapter를 호출하지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 0, opponentRuntime: 'policy' },
  });
  await first.bootstrap({ ai: 1, stack: 100, opponentRuntime: 'policy' });
  const oldOwner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  const orphan = await startCoachOrphan({ ignoreTerm: false });
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, oldOwner, 1, orphan);
  await first.requestStop();

  // A spy player adapter: policy resume must never warm it up or ask it to decide, even
  // though the resolver hands one back (the resolver's own return value is not what gates
  // this — `resolveForPhase`'s policy branch never calls `restorePlayers()` at all).
  const player = makeAdapter();
  const calls = [];
  let healthProbe = null;
  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 0,
      opponentRuntime: 'policy',
      pollMs: 10,
      orphanTerminateGraceMs: 500 * WIN32_SCALE,
      orphanTerminateKillWaitMs: 200 * WIN32_SCALE,
      resumeReclaimResidualMs: 5_000 * WIN32_SCALE,
      onCoachInvoke: (args) => {
        if (calls.length === 0) {
          // D6: the reclaim's own coach CLI calls (fence/cleanup-result) must fire only
          // after ensureServer has brought the resumed server fully up — probing it here,
          // at the moment of the very first coach call, is the same /api/health check other
          // tests use to confirm a server is actually bound and listening.
          const { port } = readJson(path.join(gameDir, 'loop-state.json'));
          healthProbe = fetch(`http://127.0.0.1:${port}/api/health`)
            .then((response) => response.json())
            .catch((error) => ({ error: error.code ?? error.message }));
        }
        calls.push(args);
      },
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));

  const state = await resumed.resume();

  assert.equal(state.phase, 'playing');
  const beginIndex = calls.findIndex((args) => args[0] === 'begin-owner');
  assert.equal(beginIndex > 0, true, 'begin-owner ran without a preceding persisted-coach reclaim call');
  assert.deepEqual(
    await healthProbe,
    { ok: true },
    'persisted coach reclaim ran before ensureServer brought the resumed server up',
  );
  assert.equal(player.calls.length, 0, 'policy resume warmed up a player adapter');
  assert.equal(player.decideCalls.length, 0, 'policy resume asked a player adapter to decide');
  await waitUntilDead(orphan.pid);
});

test('#192 FO-1 RED: bind-handle 실패 뒤 종료 미확인 worker를 finalize가 NOT_SPAWNED로 닫지 않는다', { timeout: 45_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  if (skipOnWin32(t, 'finalization budgets are timed for POSIX; win32 CI overruns the cutoff')) return;
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let held = null;
  t.after(async () => {
    if (!held) return;
    held.release();
    await held.done;
  });
  let spawnEntered;
  const entered = new Promise((resolve) => { spawnEntered = resolve; });
  const upper = makeCoachAdapter({
    rounds: [{
      gate: new Promise(() => {}),
      terminate: { confirmed: false, reason: 'STILL_ALIVE' },
      raw: JSON.stringify({ handNo: 1, text: '종료되지 않는 worker' }),
    }],
  });
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      childTimeoutMs: 1_500,
      coachSpawnCheckpoint: async () => {
        // bind-handle이 coach-control 락에서 막히도록 spawn 직전에 락을 잡는다.
        held = await holdNamedLock(gameDir, 'publish.lock.d');
        spawnEntered();
      },
    },
  });

  await loop.resume();
  await entered;
  await waitFor(
    () => readLoopLog(gameDir).find((row) => row.event === 'coach-error'),
    'bind-handle failure did not end the coach attempt',
    15_000,
  );
  held.release();
  await held.done;
  held = null;

  assert.equal(coachInvocations(calls, 'bind-handle').length, 1, 'precondition: the spawned worker reached bind-handle');
  assert.equal(
    upper.terminations.some(({ result }) => result.confirmed === false),
    true,
    'precondition: the spawned worker termination was unconfirmed',
  );

  const outcome = await loop.run().catch((error) => error);
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.notEqual(
    state.finalization?.cutoff?.terminationConfirmed,
    true,
    `an unconfirmed spawned worker was closed as NOT_SPAWNED (outcome ${outcome?.phase ?? outcome?.code})`,
  );
});

// ── #192 S2a: E3 CLI 프로토콜 강제 + record 생명주기 ──────────────────────────

test('#192 S2a: reserve/begin-owner/bind-handle CLI는 --spawn-evidence 1 없이 SPAWN_PROTOCOL_REQUIRED로 거부되고 authority를 바꾸지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const { gameDir } = await setupUserFirst(t);
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(gameDir, '.spawn-protocol-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  const snapshotFile = path.join(gameDir, 'ui-snapshot.json');
  const authorityPath = path.join(gameDir, '.coach-authority.json');

  assert.equal(fs.existsSync(authorityPath), false, 'precondition: no authority file yet');
  const reserveFail = await runCoachCliFailure(gameDir, [
    'reserve', '--owner', owner, '--hand', '1', '--attempt', '1',
    '--stats-file', statsPath, '--snapshot-file', snapshotFile,
  ]);
  assert.equal(reserveFail.ok, false);
  assert.equal(reserveFail.code, 'SPAWN_PROTOCOL_REQUIRED');
  assert.equal(fs.existsSync(authorityPath), false, 'reserve without --spawn-evidence created an authority file');

  const reserveOk = await runCoachCli(gameDir, [
    'reserve', '--owner', owner, '--hand', '1', '--attempt', '1',
    '--stats-file', statsPath, '--snapshot-file', snapshotFile,
    '--spawn-evidence', '1',
  ]);
  assert.equal(reserveOk.ok, true);
  let authority = readJson(authorityPath);
  assert.equal(authority.hands['1'].spawnEvidence, 1);
  const bytesAfterReserve = fs.readFileSync(authorityPath);

  const bindFail = await runCoachCliFailure(gameDir, [
    'bind-handle', '--owner', owner, '--hand', '1',
    '--generation', String(reserveOk.generation), '--handle', '4242:coach-start',
  ]);
  assert.equal(bindFail.code, 'SPAWN_PROTOCOL_REQUIRED');
  assert.equal(
    fs.readFileSync(authorityPath).equals(bytesAfterReserve),
    true,
    'bind-handle without --spawn-evidence changed authority bytes',
  );

  const bindOk = await runCoachCli(gameDir, [
    'bind-handle', '--owner', owner, '--hand', '1',
    '--generation', String(reserveOk.generation), '--handle', '4242:coach-start',
    '--spawn-evidence', '1',
  ]);
  assert.equal(bindOk.ok, true);
  authority = readJson(authorityPath);
  assert.equal(authority.hands['1'].agentHandle, '4242:coach-start');
  const bytesBeforeBeginOwner = fs.readFileSync(authorityPath);

  const secondOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const beginFail = await runCoachCliFailure(gameDir, [
    'begin-owner', '--owner', secondOwner, '--completed', '0',
    '--stats-file', statsPath, '--snapshot-file', snapshotFile,
  ]);
  assert.equal(beginFail.code, 'SPAWN_PROTOCOL_REQUIRED');
  assert.equal(
    fs.readFileSync(authorityPath).equals(bytesBeforeBeginOwner),
    true,
    'begin-owner without --spawn-evidence changed authority bytes',
  );

  const beginOk = await runCoachCli(gameDir, [
    'begin-owner', '--owner', secondOwner, '--completed', '0',
    '--stats-file', statsPath, '--snapshot-file', snapshotFile,
    '--spawn-evidence', '1',
  ]);
  assert.equal(beginOk.ok, true);
});

test('#192 S2a: 정상 코치 attempt는 bind-handle에 --spawn-evidence 1을 보내고 authority 행에 spawnEvidence:1을 남긴다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const bindArgs = [];
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '정상 코치 응답' }) }],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke(args) {
        if (args[0] === 'bind-handle') bindArgs.push(args);
      },
    },
  });
  const running = startRun(loop);
  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.equal(bindArgs.length, 1);
  assert.equal(flagValue(bindArgs[0], '--spawn-evidence'), '1');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const retired = (authority.retiredAttempts ?? []).find((entry) => entry.handNo === 1);
  assert.equal(retired?.spawnEvidence, 1);
});

test('#192 S2a: 종료 미확인 attempt의 record는 남아 있다가 이후 terminateLiveCoachGenerations가 confirmed:true를 받으면 지워진다', { timeout: 45_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  if (skipOnWin32(t, 'finalization budgets are timed for POSIX; win32 CI overruns the cutoff')) return;
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let held = null;
  t.after(async () => {
    if (!held) return;
    held.release();
    await held.done;
  });
  let spawnEntered;
  const entered = new Promise((resolve) => { spawnEntered = resolve; });
  let terminateCalls = 0;
  const upper = makeCoachAdapter({
    rounds: [{
      gate: new Promise(() => {}),
      // §D2: the first terminate (during the resume-time bind-handle failure) is
      // unconfirmed; the second (finalize's own terminateLiveCoachGenerations, since the
      // record survived) confirms it.
      terminate: () => {
        terminateCalls += 1;
        return terminateCalls === 1
          ? { confirmed: false, reason: 'STILL_ALIVE' }
          : { confirmed: true };
      },
      raw: JSON.stringify({ handNo: 1, text: '결국 종료되는 worker' }),
    }],
  });
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      childTimeoutMs: 1_500,
      coachSpawnCheckpoint: async () => {
        held = await holdNamedLock(gameDir, 'publish.lock.d');
        spawnEntered();
      },
    },
  });

  await loop.resume();
  await entered;
  await waitFor(
    () => readLoopLog(gameDir).find((row) => row.event === 'coach-error'),
    'bind-handle failure did not end the coach attempt',
    15_000,
  );
  held.release();
  await held.done;
  held = null;

  assert.equal(coachInvocations(calls, 'bind-handle').length, 1, 'precondition: the spawned worker reached bind-handle');
  assert.equal(terminateCalls, 1, 'precondition: only the first (unconfirmed) terminate has run so far');

  await loop.run().catch(() => {});
  assert.equal(terminateCalls, 2, 'finalize did not re-attempt terminate on the still-tracked record');
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.finalization?.cutoff?.terminationConfirmed, true);
});

test('#192 S2a: startTime null 코치 attempt의 종료가 미확인이면 record가 남아 finalize terminationConfirmed를 false로 만든다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter({
    rounds: [{
      startTime: null,
      terminate: { confirmed: false, reason: 'STILL_ALIVE' },
      raw: JSON.stringify({ handNo: 1, text: 'identity 없는 worker' }),
    }],
  });
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, { upper });

  await loop.resume();
  const outcome = await loop.run().catch((error) => error);
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.notEqual(
    state.finalization?.cutoff?.terminationConfirmed,
    true,
    `identity 없는 worker의 미확인 종료가 confirmed로 처리됐다 (outcome ${outcome?.phase ?? outcome?.code})`,
  );
  assert.equal(upper.terminations.length, 2, '최초 null-identity 종료와 finalize 재확인이 각각 한 번씩 호출돼야 한다');
});

test('#192 O2: startTime null 코치 attempt의 종료가 confirmed면 handle 없이도 finalize가 released로 닫는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter({
    rounds: [{
      startTime: null,
      terminate: { confirmed: true },
      raw: JSON.stringify({ handNo: 1, text: 'identity 없는 worker' }),
    }],
  });
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, { upper });

  await loop.resume();
  const outcome = await loop.run().catch((error) => error);
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(
    state.finalization?.cutoff?.terminationConfirmed,
    true,
    // The child confirmed its own close in-process (this instance's terminate() call
    // returned confirmed:true) — that confirmation must survive into the persisted
    // classifier's later, independent scan of the retired row, not be lost the moment the
    // in-memory record is removed from `coachAttempts`.
    `identity 없는 worker의 in-process confirmed 종료가 persisted 증거 없이 unresolved로 판정됐다 (outcome ${outcome?.phase ?? outcome?.code})`,
  );
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts?.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released');
});

test('#192 I3: 같은 attempt에 대한 동시 종료 호출은 하나의 실제 terminate()만 실행하고 결과를 공유한다', { timeout: 30_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let terminateCalls = 0;
  let releaseTerminate;
  const gate = new Promise((resolve) => { releaseTerminate = resolve; });
  const upper = makeCoachAdapter({
    rounds: [{
      startTime: null,
      raw: JSON.stringify({ handNo: 1, text: 'identity 없는 worker' }),
      // Counts real invocations and stays pending until released, so a still-in-flight
      // termination is observable while a second, independent caller (finalize's
      // terminateLiveCoachGenerations) reaches the exact same record.
      terminate: async () => {
        terminateCalls += 1;
        await gate;
        return { confirmed: true };
      },
    }],
  });
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: { finalizeBudgetMs: 3_000 * WIN32_SCALE, finalizeCutoffLeadMs: 1_500 * WIN32_SCALE },
  });

  // Safety net: `requestStop()` (registered by `finalizingLoop` via `t.after`) awaits
  // `coachTasks` with no deadline of its own — if the assertions below throw before this
  // test ever releases the gate, that cleanup would hang forever. The `finally` guarantees
  // release happens before this test function returns or throws, i.e. before any `t.after`
  // hook runs at all.
  let running;
  try {
    // resume() only launches the coach pipeline as a background tracked task (it never
    // awaits its completion) — the identity-unavailable branch reaches its own
    // terminateCoachAttempt() call and calls terminate() once, then blocks on `gate`.
    await loop.resume();
    await waitFor(() => terminateCalls >= 1, 'identity-unavailable 분기가 terminate()를 호출하지 않았다');

    running = loop.run();
    running.catch(() => {});
    // finalize's own settle-wait for coachTasks gives up at the result-wait cutoff (the
    // pipeline task above is still blocked on `gate`) and proceeds to
    // terminateLiveCoachGenerations, which looks up the same record by the same
    // {handNo, generation} key and must reuse the in-flight termination instead of
    // invoking a second, independent terminate() call.
    await waitFor(
      () => readLoopLog(gameDir).some((row) => row.event === 'finalize-coach-settled'),
      'finalize가 coach settle 단계에 도달하지 않았다',
      15_000 * WIN32_SCALE,
    );
    await new Promise((resolve) => setTimeout(resolve, 300 * WIN32_SCALE));

    assert.equal(terminateCalls, 1, '두 번째 caller가 이미 진행 중인 termination을 공유하지 않고 다시 호출했다');
  } finally {
    releaseTerminate();
  }

  await running?.catch(() => {});

  assert.equal(terminateCalls, 1, 'gate 해제 후에도 실제 terminate() 호출은 정확히 한 번이어야 한다');
  assert.equal(upper.terminations.length, 1, '공유된 termination이 아니라 각 caller가 독립적으로 종료를 호출했다');
});

// ── #192 S2b: E2 spawn sidecar + evidence classifier ──────────────────────────

test('#192 S2b: identity-unavailable 처리 중 fence가 실패해도 terminate는 한 번만 호출된다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const upper = makeCoachAdapter({
    rounds: [{
      gate: new Promise(() => {}),
      startTime: null,
      terminate: { confirmed: true },
      raw: JSON.stringify({ handNo: 1, text: 'identity 없는 worker' }),
    }],
  });
  let fenceThrown = false;
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke(args) {
        if (args[0] === 'fence' && !fenceThrown) {
          fenceThrown = true;
          throw new Error('injected fence failure');
        }
      },
    },
  });
  const running = startRun(loop);
  await waitFor(() => upper.starts.length >= 1, 'coach worker was not started');
  await waitFor(() => upper.terminations.length >= 1, 'null-identity termination이 호출되지 않았다');
  // fence 실패는 outer catch로 빠져 attempt 2(기본 응답)로 재시도한다; 그 결과를 기다린다.
  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.equal(fenceThrown, true, 'precondition: fence가 실제로 injected 실패를 겪었다');
  assert.equal(upper.terminations.length, 1, 'fence 실패 처리 중 terminate가 두 번 호출됐다');
});

test('#192 S2b: 정상 attempt는 bind-handle 전에 .spawn.json phase:identity를 pid/startTime과 함께 남긴다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '정상 코치 응답' }) }],
  });
  let sidecarAtBind = null;
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke(args) {
        if (args[0] !== 'bind-handle' || sidecarAtBind) return;
        const dir = flagValue(args, '--game-dir');
        const authority = readJson(path.join(dir, '.coach-authority.json'));
        const exactResultPath = authority.hands['1']?.exactResultPath;
        const sidecarPath = coachSpawnSidecarPath(dir, exactResultPath);
        sidecarAtBind = fs.existsSync(sidecarPath) ? readJson(sidecarPath) : { missing: true };
      },
    },
  });
  const running = startRun(loop);
  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.ok(sidecarAtBind && !sidecarAtBind.missing, 'bind-handle 시점에 spawn sidecar가 존재하지 않았다');
  assert.equal(sidecarAtBind.phase, 'identity');
  assert.equal(typeof sidecarAtBind.pid, 'number');
  assert.equal(typeof sidecarAtBind.startTime, 'string');
});

test('#192 S2b: coachSpawnCheckpoint 대기 중 cutoff가 걸리면 sidecar도 spawn도 남기지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let releaseSpawn;
  const spawnGate = new Promise((resolve) => { releaseSpawn = resolve; });
  t.after(() => releaseSpawn());
  let spawnEntered;
  const entered = new Promise((resolve) => { spawnEntered = resolve; });
  const upper = makeCoachAdapter();
  // #213: the POSIX default budget, crossed with a clock jump while spawn is parked.
  const clock = createJumpClock();
  const resultWaitMs = 10_000 * WIN32_SCALE;
  const leadMs = 10_000 * WIN32_SCALE;
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: resultWaitMs + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
      coachSpawnCheckpoint: async () => {
        spawnEntered();
        await spawnGate;
      },
    },
  });

  await loop.resume();
  await entered;
  clock.jumpBy(resultWaitMs);
  const running = startRun(loop);
  await waitFor(
    () => readLoopLog(gameDir).find((row) => row.event === 'finalize-coach-settled'),
    'spawn stayed blocked without reaching the result-wait cutoff',
    15_000 * WIN32_SCALE,
  );
  releaseSpawn();
  assert.equal((await running).phase, 'done');

  assert.equal(upper.starts.length, 0, 'cutoff 뒤에도 handle 없는 worker를 시작했다');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const exactResultPath = authority.retiredAttempts?.find((row) => row.handNo === 1)?.exactResultPath
    ?? authority.hands?.['1']?.exactResultPath;
  assert.ok(exactResultPath, 'precondition: reserve가 exactResultPath를 남겼다');
  const sidecarPath = coachSpawnSidecarPath(gameDir, exactResultPath);
  assert.equal(fs.existsSync(sidecarPath), false, 'cutoff 뒤 coachSpawnCheckpoint가 sidecar를 남겼다');
});

// #192 O4 (design memo missing-RED item 1, first half): the same E2 §3a re-validation
// guards a pause/stop arriving mid-checkpoint identically to a cutoff arriving mid-checkpoint
// (`coachWorkSuspended()` is one OR of stopRequested/finalizationCutoff/pauseRequested) — but
// only the cutoff variant above had a RED test before this round. requestStop() flips
// `stopRequested` synchronously before any of its own await, so triggering it while the
// checkpoint is deliberately held open exercises the stop-specific branch instead of relying
// on real time crossing the cutoff.
// #192 O4-rest 1: the same E2 §3a re-validation must also catch a pause that won the race
// while `coachSpawnCheckpoint` was awaited — `coachWorkSuspended()` is one OR of
// `stopRequested`/`finalizationCutoff`/`pauseRequested`, and only the cutoff/stop variants had
// a test before this round. `loop.pause()` itself requires `managed` mode and the loop's
// `playing` phase (session-control protocol, `readLoopState()?.phase === 'playing'`) — the
// `finalizingLoop` fixture used by every sibling test in this cluster runs in `finalizing`
// phase, where `pause()` throws `INVALID_TRANSITION` outright, so it cannot reach this
// checkpoint in a test. Narrow seam: `coachSpawnCheckpoint` resolving to
// `{ pauseRequested: true }` flips the exact same internal flag a real pause winning the race
// would flip, before the same re-check the stop/cutoff variants already exercise.
test('#192 O4: coachSpawnCheckpoint 대기 중 pause 요청이 오면 sidecar도 spawn도 남기지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      coachSpawnCheckpoint: async () => ({ pauseRequested: true }),
    },
  });

  await loop.resume();
  await loop.run().catch(() => {});

  assert.equal(upper.starts.length, 0, 'pause 요청 뒤에도 handle 없는 worker를 시작했다');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const exactResultPath = authority.retiredAttempts?.find((row) => row.handNo === 1)?.exactResultPath
    ?? authority.hands?.['1']?.exactResultPath;
  assert.ok(exactResultPath, 'precondition: reserve가 exactResultPath를 남겼다');
  const sidecarPath = coachSpawnSidecarPath(gameDir, exactResultPath);
  assert.equal(fs.existsSync(sidecarPath), false, 'pause 요청 뒤 coachSpawnCheckpoint가 sidecar를 남겼다');
});

test('#192 O4: coachSpawnCheckpoint 대기 중 stop 요청이 오면 sidecar도 spawn도 남기지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  let releaseSpawn;
  const spawnGate = new Promise((resolve) => { releaseSpawn = resolve; });
  t.after(() => releaseSpawn());
  let spawnEntered;
  const entered = new Promise((resolve) => { spawnEntered = resolve; });
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      coachSpawnCheckpoint: async () => {
        spawnEntered();
        await spawnGate;
      },
    },
  });

  await loop.resume();
  await entered;
  const stopPromise = loop.requestStop();
  releaseSpawn();
  await stopPromise;

  assert.equal(upper.starts.length, 0, 'stop 요청 뒤에도 handle 없는 worker를 시작했다');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const exactResultPath = authority.retiredAttempts?.find((row) => row.handNo === 1)?.exactResultPath
    ?? authority.hands?.['1']?.exactResultPath;
  assert.ok(exactResultPath, 'precondition: reserve가 exactResultPath를 남겼다');
  const sidecarPath = coachSpawnSidecarPath(gameDir, exactResultPath);
  assert.equal(fs.existsSync(sidecarPath), false, 'stop 요청 뒤 coachSpawnCheckpoint가 sidecar를 남겼다');
});

// #192 O4-rest 2: E2 §3c re-validates `assertBeforeResultWaitCutoff()`/`coachWorkSuspended()`
// a second time, right after the synchronous `intent` sidecar write and right before
// `oneshotStart` — a suspension arriving in exactly that gap must still abort without ever
// spawning, and the sidecar must move on to `aborted-before-spawn` (never staying stuck at
// `intent`, which a later reader could otherwise mistake for "we don't know whether the spawn
// happened"). `writeSpawnEvidence` is the test seam named for this boundary: since the
// production call site never awaits it, firing `requestStop()` from inside it (which flips
// `stopRequested` synchronously before its own first await) reliably wins the race every time,
// without any gate/promise choreography.
test('#192 O4: intent 기록 뒤 spawn 직전에 suspension이 오면 sidecar가 aborted-before-spawn으로 끝나고 spawn하지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter();
  let loop;
  let stopFired = false;
  const writeSpawnEvidence = (filePath, data) => {
    writeJsonAtomic(filePath, data);
    if (data.phase === 'intent' && !stopFired) {
      stopFired = true;
      loop.requestStop().catch(() => {});
    }
  };
  ({ loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: { writeSpawnEvidence },
  }));

  await loop.resume().catch(() => {});
  await loop.requestStop().catch(() => {});

  assert.equal(upper.starts.length, 0, 'intent 뒤 suspension인데도 handle 없는 worker를 시작했다');
  assert.equal(stopFired, true, 'precondition: writeSpawnEvidence의 intent 훅이 한 번도 불리지 않았다');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const exactResultPath = authority.retiredAttempts?.find((row) => row.handNo === 1)?.exactResultPath
    ?? authority.hands?.['1']?.exactResultPath;
  assert.ok(exactResultPath, 'precondition: reserve가 exactResultPath를 남겼다');
  const sidecarPath = coachSpawnSidecarPath(gameDir, exactResultPath);
  const sidecar = readJson(sidecarPath);
  assert.equal(
    sidecar.phase,
    'aborted-before-spawn',
    `intent 뒤 suspension인데 sidecar phase가 ${sidecar.phase}로 끝났다`,
  );
});

// #192 O4 (design memo missing-RED item 6): parsePersistedCoachHandle keeps everything after
// the first ":" verbatim precisely so a Windows-shaped start time (which itself contains
// colons) is preserved instead of truncated at the wrong separator. This drives the
// classifier's step 0 tuple/identity check with a handle and a tuple-matched sidecar identity
// that carry the exact same colon-bearing startTime, proving they compare equal instead of
// raising IDENTITY_CONFLICT.
test('#192 O4: 콜론을 포함한 win32 startTime은 handle과 sidecar identity가 동일하게 파싱돼 IDENTITY_CONFLICT를 내지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const win32StartTime = 'win32-v1:2026-09-14T01:02:03.1234567Z';
  const fakePid = 999_999_999;
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  await createCoachControl().bindHandle({
    gameDir, owner: 'old-owner', handNo: 1,
    generation: reserved.generation, handle: `${fakePid}:${win32StartTime}`,
  });
  writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, {
    phase: 'identity', pid: fakePid, startTime: win32StartTime,
  });
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  const resumed = await loop.resume();
  assert.equal(resumed.halt, undefined, `콜론 포함 startTime 처리에서 예상치 못한 halt: ${JSON.stringify(resumed.halt)}`);

  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts?.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released', 'step 0 tuple 비교를 통과한 identity가 released로 닫히지 않았다');
});

// #192 O4 (design memo missing-RED item 2, first half): the spawn-time owner re-check
// (`spawnLoopState?.ownerSessionId !== owner`) must catch an owner handoff that happened
// while `coachSpawnCheckpoint` was awaited, not just a suspension flag — this rewrites
// loop-state.json's ownerSessionId from inside the checkpoint itself.
// #192 O4-rest 3: the spawn-time re-check is actually two clauses
// (`spawnLoopState?.ownerSessionId !== owner || !issuedOwners.has(owner)`, §3 E1 "spawn 전
// owner 확인") — the sibling test above already isolates the first ("owner changed mid-
// checkpoint"). This one isolates the second: loop-state still names exactly the owner this
// coachPipeline call captured, but this loop instance never actually issued it (every real
// `resume()`/`bootstrap()` immediately adds its own freshly-minted owner to `issuedOwners`, so
// genuinely reproducing "still named, never issued" needs a second real instance racing this
// one). Narrow seam: `coachSpawnCheckpoint` resolving to `{ retractIssuedOwner: true }`
// removes the just-captured owner from `issuedOwners` in-process, leaving loop-state's
// ownerSessionId untouched.
test('#192 O4: 이 인스턴스가 발급하지 않은 owner는 loop-state가 여전히 가리켜도 spawn하지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      coachSpawnCheckpoint: async () => ({ retractIssuedOwner: true }),
    },
  });

  await loop.resume();
  await loop.run().catch(() => {});

  assert.equal(upper.starts.length, 0, 'issuedOwners에 없는 owner인데도 handle 없는 worker를 시작했다');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const exactResultPath = authority.retiredAttempts?.find((row) => row.handNo === 1)?.exactResultPath
    ?? authority.hands?.['1']?.exactResultPath;
  assert.ok(exactResultPath, 'precondition: reserve가 exactResultPath를 남겼다');
  const sidecarPath = coachSpawnSidecarPath(gameDir, exactResultPath);
  assert.equal(
    fs.existsSync(sidecarPath),
    false,
    'issuedOwners에 없는 owner인데 coachSpawnCheckpoint가 sidecar를 남겼다',
  );
});

test('#192 O4: spawn 직전 loop-state의 ownerSessionId가 바뀌면 sidecar도 spawn도 남기지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      coachSpawnCheckpoint: async () => {
        const statePath = path.join(gameDir, 'loop-state.json');
        const state = readJson(statePath);
        state.ownerSessionId = 'someone-else-entirely';
        fs.writeFileSync(statePath, JSON.stringify(state));
      },
    },
  });

  await loop.resume();
  await loop.run().catch(() => {});

  assert.equal(upper.starts.length, 0, 'owner가 바뀐 뒤에도 handle 없는 worker를 시작했다');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const exactResultPath = authority.retiredAttempts?.find((row) => row.handNo === 1)?.exactResultPath
    ?? authority.hands?.['1']?.exactResultPath;
  assert.ok(exactResultPath, 'precondition: reserve가 exactResultPath를 남겼다');
  const sidecarPath = coachSpawnSidecarPath(gameDir, exactResultPath);
  assert.equal(fs.existsSync(sidecarPath), false, 'owner 변경 뒤 spawn 경계가 sidecar를 남겼다');
});

test('#192 S2b: intent 기록이 result-wait cutoff를 가로지르면 sidecar는 aborted-before-spawn으로 끝나고 finalize는 NOT_SPAWNED로 닫는다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter();
  let crossedOnce = false;
  const clock = createJumpClock();
  const resultWaitMs = 5_000 * WIN32_SCALE;
  const leadMs = 2_000 * WIN32_SCALE;
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      finalizeBudgetMs: resultWaitMs + leadMs,
      finalizeCutoffLeadMs: leadMs,
      monotonicNs: clock.monotonicNs,
      writeSpawnEvidence: (filePath, data) => {
        if (data.phase === 'intent' && !crossedOnce) {
          crossedOnce = true;
          // #213: the intent write crosses the result-wait cutoff by a clock jump (was a
          // 1.7 s Atomics.wait against a 1.5 s window, which a win32 resume overruns).
          clock.jumpBy(resultWaitMs + 100);
        }
        writeJsonAtomic(filePath, data);
      },
    },
  });

  await loop.resume();
  const outcome = await loop.run().catch((error) => error);

  assert.equal(crossedOnce, true, 'precondition: intent 기록이 실제로 cutoff를 가로질렀다');
  assert.equal(upper.starts.length, 0, 'cutoff를 넘긴 뒤에도 worker를 시작했다');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const retired = authority.retiredAttempts.find((row) => row.handNo === 1);
  assert.equal(retired?.cleanupState, 'released', `outcome ${outcome?.phase ?? outcome?.code}`);
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(
    state.finalization?.cutoff?.terminationConfirmed,
    true,
    `outcome ${outcome?.phase ?? outcome?.code}`,
  );
});

test('#192 S2b: writeSpawnEvidence가 intent에서 던지면 spawn 없이 코치를 unavailable로 봉인한다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const upper = makeCoachAdapter({
    rounds: [{ gate: new Promise(() => {}), raw: JSON.stringify({ handNo: 1, text: '시작하면 안 되는 worker' }) }],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: {
      writeSpawnEvidence: (filePath, data) => {
        if (data.phase === 'intent') throw new Error('injected intent write failure');
        writeJsonAtomic(filePath, data);
      },
    },
  });
  const running = startRun(loop);
  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.equal(upper.starts.length, 0, 'intent 기록 실패 뒤에도 worker를 시작했다');
  assert.equal(note.unavailable, true);
});

test('#192 S2b: writeSpawnEvidence가 identity에서 던지면 bind-handle 없이 fail-closed 처리되고 record는 실패 전에 등록돼 있다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const upper = makeCoachAdapter({
    rounds: [{
      terminate: { confirmed: false, reason: 'STILL_ALIVE' },
      raw: JSON.stringify({ handNo: 1, text: 'identity 기록 실패' }),
    }],
  });
  const bindArgs = [];
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    loopOpts: {
      writeSpawnEvidence: (filePath, data) => {
        if (data.phase === 'identity') throw new Error('injected identity write failure');
        writeJsonAtomic(filePath, data);
      },
      onCoachInvoke(args) {
        if (args[0] === 'bind-handle') bindArgs.push(args);
      },
    },
  });

  await loop.resume();
  const outcome = await loop.run().catch((error) => error);

  assert.equal(bindArgs.length, 0, 'identity write 실패에도 bind-handle을 호출했다');
  assert.equal(
    upper.terminations.length,
    2,
    `record가 등록되지 않았으면 finalize 재확인이 다시 terminate를 부르지 않는다 (outcome ${outcome?.phase ?? outcome?.code})`,
  );
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.notEqual(
    state.finalization?.cutoff?.terminationConfirmed,
    true,
    `outcome ${outcome?.phase ?? outcome?.code}`,
  );
});

// ── #192 S2b: 판정 순서 분류자 매트릭스 (finalizing resume) ──────────────────────

test('#192 S2b 분류자 1: stamp, handle 없음, sidecar 없음 → released NOT_SPAWNED, resume이 begin-owner에 도달한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  const resumed = await loop.resume();

  assert.equal(resumed.halt, undefined, `resume이 halt됐다: ${JSON.stringify(resumed.halt)}`);
  assert.equal(coachInvocations(calls, 'begin-owner').length, 1);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released');
        assert205Evidence(coachInvocations(calls, 'cleanup-result'), 'NOT_SPAWNED');
        assert205Trace(gameDir, 'NOT_SPAWNED');
  assert.equal(row?.spawnEvidence, 1);
});

// #192 O4-rest 4: `readCoachSpawnSidecar`'s `absentOrInvalid` only classifies a missing
// sidecar as the strong "we would have seen it" `absent` when the game root directory itself
// still `stat`s — an unmounted/relocated root must never masquerade as "confirmed no spawn
// happened" (judgment d, `NOT_SPAWNED`). Narrow seam: `opts.statGameRoot` stands in for
// `fs.statSync(root)` so a test can force that specific failure without real filesystem/mount
// manipulation.
test('#192 O4: 게임 root 디렉터리 stat이 실패하면 없는 sidecar가 absent가 아니라 invalid로 판정된다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      statGameRoot: () => { throw Object.assign(new Error('root gone'), { code: 'ENOENT' }); },
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(
    row?.reason,
    'SPAWN_EVIDENCE_INVALID',
    `root stat 실패인데 NOT_SPAWNED(d)로 판정됐다 (${JSON.stringify(row)})`,
  );
  assert.equal(row?.evidence?.sidecar, 'invalid', 'root stat 실패인데 sidecar가 absent로 분류됐다');
});

// #192 O4-rest 5: tools/session-launcher.js's `launchSession` mirrors `prepareGameSession`'s
// store-launcher pattern — the loop lock is acquired *before* the loop even exists
// (`acquireOwnedLock`, passed in as `initialLockHandle`), and `resume({ skipLock: true })`
// then trusts that already-held lock instead of acquiring its own. When that resume fails
// before this instance ever issues an owner (`issuedOwners.add(...)` — the very first check
// inside `resume()`, `NO_GAME` when `engine/state.json` itself is missing, throws well before
// that point), the launcher's own catch block calls `loop.requestStop()`. `issuedOwners` is
// still empty at that point, so E1's receipt logic has nothing to write — no closure entry
// ever appears for this loop instance.
test('#192 O4: launcher 스타일 resume({skipLock:true})이 owner 발급 전에 실패하면 closure entry를 남기지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const loopStatePath = path.join(gameDir, 'loop-state.json');

  // A real prior instance's clean bootstrap+stop, purely to give loop-state.json an existing
  // `coachRuntimeClosures` entry — the point below is that this launcher-style failed resume
  // adds nothing *on top of* it, not merely that loop-state.json happens not to exist yet
  // (which would make the assertion trivially true regardless of `issuedOwners`).
  const first = createGameLoop({
    gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0, waitMs: 0 },
  });
  await first.bootstrap({ ai: 1, stack: 100 });
  await first.requestStop();
  const closuresBefore = readJson(loopStatePath).coachRuntimeClosures ?? [];
  assert.ok(closuresBefore.length > 0, 'precondition: 첫 bootstrap+stop이 closure entry를 남기지 않았다');

  // Break resume()'s pendingDecision validation so this second instance's resume() throws
  // well after loop-state.json already exists, but still before it ever issues its own owner
  // (`issuedOwners.add(...)` runs strictly later in resume()).
  const state = readJson(loopStatePath);
  fs.writeFileSync(loopStatePath, JSON.stringify({
    ...state, pendingDecision: { schemaVersion: 99 },
  }));

  const lockHandle = acquireOwnedLock(gameDir, 'loop.lock.d');
  const loop = createGameLoop({
    gameDir,
    initialLockHandle: lockHandle,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });

  await assert.rejects(loop.resume({ skipLock: true }), (error) => error.code === 'BAD_PLAYER_RECOVERY');
  await loop.requestStop();

  const closuresAfter = readJson(loopStatePath).coachRuntimeClosures ?? [];
  assert.deepEqual(
    closuresAfter,
    closuresBefore,
    'owner 발급 전에 실패한 launcher 스타일 resume 뒤 requestStop이 closure entry를 추가로 남겼다',
  );
});

test('#192 S2b 분류자 2: 표식 없음, handle 없음, sidecar 없음 → FINALIZATION_ABORTED, evidence.spawnEvidence는 false (기존 Task 7A 계약)', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    // #192 O1/L1: this test's own purpose is the pre-L1 evidence shape (judgment e's old
    // fallback) — force the legacy scanner unavailable so judgment g cannot auto-recover
    // this row out from under it.
    loopOpts: { scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'test-fixture' }) },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.ok(row, 'recovery attempts에 hand 1이 없다');
  assert.equal(row.evidence.spawnEvidence, false);
  assert.equal(row.evidence.hasHandle, false);
  assert.equal(row.evidence.sidecar, 'absent');
});

test('#192 S2b 분류자 3: stamp, sidecar intent만 → aborted', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, { phase: 'intent' });
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'SPAWN_INTENT_ONLY');
  assert.equal(row?.evidence.sidecar, 'intent');
});

test('#192 S2b 분류자 4: stamp, sidecar aborted-before-spawn(튜플 일치) → released', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, { phase: 'aborted-before-spawn' });
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  const resumed = await loop.resume();

  assert.equal(resumed.halt, undefined, `resume이 halt됐다: ${JSON.stringify(resumed.halt)}`);
  assert.equal(coachInvocations(calls, 'begin-owner').length, 1);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released');
});

test('#192 S2b 분류자 5: stamp, sidecar identity(live orphan), handle 없음 → orphan 종료 후 released', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan({ ignoreTerm: false });
  t.after(() => terminateIfAlive(orphan));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const orphanStartTime = await waitFor(
    () => processStartTime(orphan.pid),
    `coach orphan ${orphan.pid} start identity was not observable`,
  );
  writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, {
    phase: 'identity', pid: orphan.pid, startTime: orphanStartTime,
  });
  const signals = [];
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) signals.push(signal);
        process.kill(pid, signal);
      },
    },
  });

  const resumed = await loop.resume();

  assert.equal(resumed.halt, undefined, `resume이 halt됐다: ${JSON.stringify(resumed.halt)}`);
  assert.equal(signals.includes('SIGTERM'), true, 'sidecar identity의 live orphan에 SIGTERM을 보내지 않았다');
  await waitUntilDead(orphan.pid);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released');
});

test('#192 S2b 분류자 6: stamp, sidecar generation 불일치 → aborted SPAWN_EVIDENCE_MISMATCH', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, {
    phase: 'intent', generation: reserved.generation + 1,
  });
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'SPAWN_EVIDENCE_MISMATCH');
});

test('#192 S2b 분류자 7: stamp, exactResultPath가 다른 디렉터리로 재작성, sidecar 없음 → aborted (귀속 불가)', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const foreignDir = tmpGame();
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.hands['1'].exactResultPath = path.join(foreignDir, path.basename(authority.hands['1'].exactResultPath));
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'NOT_ATTRIBUTABLE');
  assert.equal(row?.evidence.attributable, false);
});

test('#192 S2b 분류자 8: stamp, .spawn.json이 symlink → aborted', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const sidecarPath = coachSpawnSidecarPath(gameDir, reserved.exactResultPath);
  const targetPath = path.join(gameDir, '.spawn-symlink-target.json');
  fs.writeFileSync(targetPath, JSON.stringify({ phase: 'intent' }));
  fs.symlinkSync(targetPath, sidecarPath);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'SPAWN_EVIDENCE_INVALID');
  assert.equal(row?.evidence.sidecar, 'invalid');
});

test('#192 I2: sidecar가 hard link면(nlink>1) invalid로 판정하고 identity에 signal을 보내지 않는다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  if (skipOnWin32(t, 'hard link 의미론이 POSIX 전용이다')) return;
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan({ ignoreTerm: false });
  t.after(() => terminateIfAlive(orphan));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const orphanStartTime = await waitFor(
    () => processStartTime(orphan.pid),
    `coach orphan ${orphan.pid} start identity was not observable`,
  );
  const sidecarPath = writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, {
    phase: 'identity', pid: orphan.pid, startTime: orphanStartTime,
  });
  fs.linkSync(sidecarPath, `${sidecarPath}.hardlink`);
  t.after(() => { try { fs.unlinkSync(`${sidecarPath}.hardlink`); } catch { /* best effort */ } });
  const signals = [];
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) signals.push(signal);
        process.kill(pid, signal);
      },
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  assert.deepEqual(signals, [], 'hard-linked sidecar identity의 live orphan에 signal을 보냈다');
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'SPAWN_EVIDENCE_INVALID');
  assert.equal(row?.evidence.sidecar, 'invalid');
});

test('#192 I2: sidecar가 64KiB를 넘으면 invalid로 판정한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, {
    phase: 'intent', padding: 'x'.repeat(64 * 1024 + 1),
  });
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'SPAWN_EVIDENCE_INVALID');
  assert.equal(row?.evidence.sidecar, 'invalid');
});

test('#192 sJ5/oK1: O_NOFOLLOW가 없는 플랫폼에서는 symlink sidecar를 따라가지 않고 invalid로 판정한다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  if (skipOnWin32(t, 'symlink 생성은 win32에서 권한이 필요하다')) return;
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan({ ignoreTerm: false });
  t.after(() => terminateIfAlive(orphan));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const orphanStartTime = await waitFor(
    () => processStartTime(orphan.pid),
    `coach orphan ${orphan.pid} start identity was not observable`,
  );
  // A valid, tuple-matched `identity` payload that would resolve through judgment b if read.
  // It is written to a separate file and the sidecar path is a symlink to it, so the
  // no-flag fallback reader (forced by the seam below) must refuse it at `lstat`.
  const realPayloadPath = writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, {
    phase: 'identity', pid: orphan.pid, startTime: orphanStartTime,
  });
  const symlinkTarget = `${realPayloadPath}.target`;
  fs.renameSync(realPayloadPath, symlinkTarget);
  fs.symlinkSync(symlinkTarget, realPayloadPath);
  const signals = [];
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      sidecarNoFollowFlag: undefined,
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) signals.push(signal);
        process.kill(pid, signal);
      },
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  assert.deepEqual(signals, [], 'O_NOFOLLOW 없는 플랫폼에서 symlink sidecar의 identity를 믿고 live orphan에 signal을 보냈다');
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'SPAWN_EVIDENCE_INVALID');
  assert.equal(row?.evidence.sidecar, 'invalid');
});

test('#192 sJ5: O_NOFOLLOW가 없는 플랫폼에서도 sidecar가 없으면 여전히 absent로 판정 d(NOT_SPAWNED)가 적용된다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  if (skipOnWin32(t, 'symlink 의미론이 POSIX 전용이다')) return;
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: { sidecarNoFollowFlag: undefined },
  });

  const resumed = await loop.resume();

  assert.equal(resumed.halt, undefined, `resume이 halt됐다: ${JSON.stringify(resumed.halt)}`);
  assert.equal(coachInvocations(calls, 'begin-owner').length, 1);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released');
  assert.equal(row?.spawnEvidence, 1);
});

test('#192 S2b 분류자 9: stamp, 잘못된 handle 문자열 "abc", sidecar 없음 → aborted (d 아님)', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.hands['1'].agentHandle = 'abc';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.notEqual(row?.reason, 'NOT_SPAWNED', 'malformed handle을 d(NOT_SPAWNED)로 잘못 판정했다');
  assert.equal(row?.evidence.hasHandle, true);
});

test('#192 S2b 분류자 10: stamp, live orphan의 authority handle이지만 processStartTime이 강제로 unknown, sidecar 없음 → aborted IDENTITY_UNKNOWN, signal 없음', { timeout: 15_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  t.after(() => terminateIfAlive(orphan));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  const realStartTime = await waitFor(
    () => processStartTime(orphan.pid),
    `coach orphan ${orphan.pid} start identity was not observable`,
  );
  await createCoachControl().bindHandle({
    gameDir, owner: 'old-owner', handNo: 1, generation: reserved.generation,
    handle: `${orphan.pid}:${realStartTime}`,
  });
  const signals = [];
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      finalizeBudgetMs: 2_200,
      finalizeCutoffLeadMs: 1_100,
      processStartTime: (pid) => (pid === orphan.pid ? null : processStartTime(pid)),
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) signals.push(signal);
        process.kill(pid, signal);
      },
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  assert.deepEqual(signals, [], '해소되지 않는 identity의 orphan에 signal을 보냈다');
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'IDENTITY_UNKNOWN');
  assert.equal(row?.evidence.spawnEvidence, true);
  assert.equal(row?.evidence.hasHandle, true);
});

// ── #192 S3: E3 close 표식(f) 판정, D3 수집/권한 분리, D6(FO-3) 회수 선행 ────────

test('#192 S3: 코치 pipeline accept는 --accept-evidence closed-child를 넘긴다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const coachCalls = [];
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '기본 코치 응답' }) }],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: { onCoachInvoke: (args) => coachCalls.push(args) },
  });
  const running = startRun(loop);
  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  const accepts = coachCalls.filter((args) => args[0] === 'accept');
  assert.equal(accepts.length, 1);
  assert.equal(flagValue(accepts[0], '--accept-evidence'), 'closed-child');
});

test('#192 S3: heartbeat result-ready accept는 --accept-evidence closed-child를 넘긴다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  let releaseGeneration;
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  t.after(() => releaseGeneration());
  const coachCalls = [];
  const upper = makeCoachAdapter({
    rounds: [{ gate: generationGate, raw: JSON.stringify({ handNo: 1, text: '늦은 원본' }) }],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: { waitMs: 40, onCoachInvoke: (args) => coachCalls.push(args) },
  });
  const running = startRun(loop);
  const handTwo = await waitForUserSnapshot(gameDir);
  assert.equal(handTwo.snapshot.view.handNo, 2);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = await waitFor(() => {
    const value = readJson(authorityPath);
    return value.hands?.['1']?.agentHandle ? value : null;
  }, 'hand 1 coach generation was not running');
  fs.writeFileSync(authority.hands['1'].exactResultPath, JSON.stringify({
    handNo: 1,
    text: 'heartbeat result ready',
  }));
  authority.hands['1'].deadlineMono = '0';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  await postUserAction(handTwo.lock, {
    decisionId: handTwo.snapshot.view.legal.decisionId,
    action: 'fold',
  });
  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  const accepts = coachCalls.filter((args) => args[0] === 'accept' && flagValue(args, '--hand') === '1');
  assert.equal(accepts.length, 1);
  assert.equal(flagValue(accepts[0], '--accept-evidence'), 'closed-child');
});

test('#192 S3: deferred flush accept는 live generation이 그대로면 --accept-evidence closed-child를 넘긴다', { timeout: 40_000 * WIN32_SCALE }, async (t) => {
  let overlapCard = null;
  let decisionId = 'd-1-preflop-0';
  const rounds = [{
    get raw() {
      return JSON.stringify({
        handNo: 1,
        text: overlapCard ? `핸드 1에서 상대 ${overlapCard} 인용` : '카드 없이 평가',
        decisions: [{
          decisionId,
          why: '왜 그 액션을 했는지 설명합니다.',
          outcome: overlapCard ? `폴드 상대의 ${overlapCard}가 드러났다.` : '보드만 근거로 평가한다.',
          alternative: '다른 라인을 검토할 수 있었습니다.',
        }],
      });
    },
  }];
  const upper = makeCoachAdapter({ rounds });
  const coachCalls = [];
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    bootstrap: { replayReveal: 'all' },
    loopOpts: {
      onCoachInvoke: (args) => coachCalls.push(args),
      async coachCaptureCheckpoint({ handNo }) {
        if (handNo !== 1) return;
        await waitFor(() => {
          const state = readJson(path.join(gameDir, 'state.json'));
          return state.hand && state.lastHand?.handNo === 1 ? state : null;
        }, 'hand 2 was not dealt before coach deny', 8_000);
        const statePath = path.join(gameDir, 'state.json');
        const state = readJson(statePath);
        const replay = readJson(path.join(gameDir, '.coach-hand-1-replay.json'));
        decisionId = replay.decisions?.[0]?.decisionId ?? decisionId;
        const last = state.lastHand;
        const foldPid = (last.folded ?? []).find((pid) => pid !== 'user') ?? 'p1';
        overlapCard = injectCurrentHandCard(state, last.holes[foldPid][0]);
        fs.writeFileSync(statePath, JSON.stringify(state));
      },
    },
  });
  const running = startRun(loop);

  await waitFor(() => {
    try {
      const auth = readJson(path.join(gameDir, '.coach-authority.json'));
      return auth.deferred?.['1'] ?? null;
    } catch {
      return null;
    }
  }, 'hand 1 coach was not deferred', 10_000);

  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  assert.equal(snapshot.view.handNo, 2);
  await postUserAction(lock, {
    decisionId: snapshot.view.legal.decisionId,
    action: 'fold',
  });
  await waitForCoachNote(gameDir, 1, 10_000);
  await stopRun(loop, running);

  const accepts = coachCalls.filter((args) => args[0] === 'accept' && flagValue(args, '--hand') === '1');
  assert.equal(accepts.length, 1);
  assert.equal(flagValue(accepts[0], '--accept-evidence'), 'closed-child');
});

test('#192 S3: deferred flush accept는 live generation이 없으면 새로 reserve하고 --accept-evidence no-spawn을 넘긴다', { timeout: 40_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const state = readJson(path.join(gameDir, 'state.json'));
  state.config = { ...(state.config ?? {}), replayReveal: 'all' };
  fs.writeFileSync(path.join(gameDir, 'state.json'), JSON.stringify(state));
  const epoch = gameEpochOf(init.sessionToken);
  const owner = '11111111-1111-4111-8111-111111111111';
  const deferredNote = {
    handNo: 1,
    text: '지연됐던 노트를 종료 국면에서 게시합니다.',
    decisions: [{
      decisionId: (state.lastHand.decisions ?? []).find((row) => row.actorId === 'user')?.decisionId ?? 'd-1-preflop-0',
      why: '왜 그 액션을 했는지 설명합니다.',
      outcome: '결과적으로 이 핸드가 이렇게 끝났습니다.',
      alternative: '다른 라인을 검토할 수 있었습니다.',
    }],
  };
  writeJsonAtomic(path.join(gameDir, '.coach-authority.json'), {
    schemaVersion: 2,
    gameEpoch: epoch,
    activeOwnerSessionId: owner,
    adapterState: 'enabled',
    legacyMigrationCompleted: true,
    overfoldLease: null,
    hands: {},
    retiredAttempts: [],
    publishQueue: {},
    publishedSeals: {},
    deferred: { 1: { note: deferredNote } },
    noNewPlayTimePublishers: false,
    finalization: null,
  });
  const coachCalls = [];
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper: makeCoachAdapter(),
    stateOverrides: { ownerSessionId: owner, handNo: 1 },
    loopOpts: { onCoachInvoke: (args) => coachCalls.push(args) },
  });
  await loop.resume();
  await loop.run();
  const snap = readJson(path.join(gameDir, 'ui-snapshot.json'));
  const note = (snap.coach ?? []).find((row) => row.handNo === 1);
  assert.ok(note);
  const accepts = coachCalls.filter((args) => args[0] === 'accept' && flagValue(args, '--hand') === '1');
  assert.equal(accepts.length, 1);
  assert.equal(flagValue(accepts[0], '--accept-evidence'), 'no-spawn');
  const reserves = coachCalls.filter((args) => args[0] === 'reserve' && flagValue(args, '--hand') === '1');
  assert.equal(reserves.length, 1, 'deferred flush without a live generation did not reserve a fresh one');
});

test('#192 S3 분류자 f: consumed 행이 acceptEvidence를 가지면 handle 없이도 released ACCEPT_EVIDENCE, 없으면 unresolved로 halt한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  for (const acceptEvidence of ['no-spawn', null]) {
    await t.test(acceptEvidence ?? 'no evidence', async (st) => {
      const gameDir = tmpGame();
      const init = await seedFinishedGame(gameDir);
      const external = await startExternalServer(gameDir, init.sessionToken);
      st.after(() => terminateIfAlive(external.child));
      await seedQueuedCoach(gameDir, 'old-owner', 1, { acceptEvidence });
      const upper = makeCoachAdapter();
      const { loop, calls } = finalizingLoop(st, gameDir, init.sessionToken, {
        upper,
        stateOverrides: { port: external.lock.port },
        // #192 O1/L1: the `null` branch is exactly the pre-S3 legacy shape (no
        // spawnEvidence, no acceptEvidence, no sidecar) — force the scanner unavailable so
        // this test's own "unresolved, not f" assertion is unaffected by judgment g.
        loopOpts: acceptEvidence
          ? {}
          : { scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'test-fixture' }) },
      });

      if (acceptEvidence) {
        const resumed = await loop.resume();
        assert.equal(resumed.halt, undefined, `resume이 halt됐다: ${JSON.stringify(resumed.halt)}`);
        const authority = readJson(path.join(gameDir, '.coach-authority.json'));
        const row = authority.retiredAttempts.find((entry) => entry.handNo === 1);
        assert.equal(row?.cleanupState, 'released');
        assert205Evidence(coachInvocations(calls, 'cleanup-result'), 'ACCEPT_EVIDENCE');
        assert205Trace(gameDir, 'ACCEPT_EVIDENCE');
      } else {
        await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
        const state = readJson(path.join(gameDir, 'loop-state.json'));
        const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
        assert.ok(row, 'recovery attempts에 hand 1이 없다');
        assert.notEqual(row.reason, 'ACCEPT_EVIDENCE', 'evidence 없는 행을 f로 잘못 판정했다');
      }
    });
  }
});

test('#192 S3 분류자 f (H2): evidence가 있으면 processStartTime unknown identity를 result-wait cutoff까지 기다리지 않고 즉시 released로 닫는다', { timeout: 15_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  t.after(() => terminateIfAlive(orphan));
  const reserved = await seedRunningCoach(gameDir, 'old-owner', 1, orphan);
  fs.writeFileSync(reserved.exactResultPath, JSON.stringify({
    handNo: 1,
    text: 'evidence-backed row with unknown identity',
  }));
  const denyPath = path.join(gameDir, '.classifier-f-fast-deny.json');
  fs.writeFileSync(denyPath, JSON.stringify(['SEED_FORBIDDEN_SENTINEL']));
  await runCoachCli(gameDir, [
    'accept', '--owner', 'old-owner', '--hand', '1',
    '--generation', String(reserved.generation), '--forbidden-file', denyPath,
    '--accept-evidence', 'closed-child',
  ]);

  const signals = [];
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      finalizeBudgetMs: 4_000 * WIN32_SCALE,
      finalizeCutoffLeadMs: 1_000 * WIN32_SCALE,
      processStartTime: (pid) => (pid === orphan.pid ? null : processStartTime(pid)),
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) signals.push(signal);
        process.kill(pid, signal);
      },
    },
  });

  const startedAt = Date.now();
  const resumed = await loop.resume();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(resumed.halt, undefined, `resume이 halt됐다: ${JSON.stringify(resumed.halt)}`);
  assert.deepEqual(signals, [], 'evidence로 released되기 전에 identity에 signal을 보냈다');
  assert.equal(elapsedMs < 1_500 * WIN32_SCALE, true, `evidence 있는 행이 result-wait cutoff 근처까지 대기했다 (${elapsedMs}ms)`);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released');
});

test('#192 S3 분류자 f: evidence가 있어도 identity가 alive로 확인된 뒤 signal이 실패하면 unconfirmed로 남는다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan({ ignoreTerm: false });
  t.after(() => terminateIfAlive(orphan));
  const reserved = await seedRunningCoach(gameDir, 'old-owner', 1, orphan);
  fs.writeFileSync(reserved.exactResultPath, JSON.stringify({
    handNo: 1,
    text: 'evidence-backed row with a still-alive identity',
  }));
  const denyPath = path.join(gameDir, '.classifier-f-signal-deny.json');
  fs.writeFileSync(denyPath, JSON.stringify(['SEED_FORBIDDEN_SENTINEL']));
  await runCoachCli(gameDir, [
    'accept', '--owner', 'old-owner', '--hand', '1',
    '--generation', String(reserved.generation), '--forbidden-file', denyPath,
    '--accept-evidence', 'closed-child',
  ]);

  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      signalProcess: (pid, signal) => {
        if (pid === orphan.pid) {
          throw Object.assign(new Error('signal blocked for test'), { code: 'EPERM' });
        }
        process.kill(pid, signal);
      },
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.ok(row, 'recovery attempts에 hand 1이 없다');
  assert.equal(row.reason, 'SIGNAL_FAILED');
});

test('#192 S3 D3: heartbeat timeout-fence로 만들어진 handle 없는 foreign pending 행은 evidence 없이는 unresolved로 halt하고 cleanup-result를 쓰지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.hands[String(reserved.handNo)].deadlineMono = '0';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  const heartbeat = await runCoachCli(gameDir, ['heartbeat', '--owner', 'old-owner']);
  assert.equal(
    heartbeat.actions.some((action) => action.action === 'timeout-fence' && action.handNo === 1),
    true,
    'heartbeat이 hand 1을 timeout-fence하지 않았다',
  );
  const foreignRow = readJson(authorityPath).retiredAttempts.find((row) => row.handNo === 1);
  assert.equal(foreignRow.agentHandle, null);
  assert.equal(foreignRow.cleanupEligible, false);
  assert.equal(foreignRow.cleanupState, 'pending');

  // A different owner takes over via begin-owner (--completed 0 touches no hand
  // reservation) — this switches activeOwnerSessionId away from 'old-owner' without ever
  // touching the retired row above, leaving it foreign: nobody's begin-owner has reclaimed
  // it, and it is neither this new owner's own row nor cleanup-eligible.
  await seedEmptyCoachAuthority(gameDir, 'intermediate-owner');
  assert.equal(readJson(authorityPath).activeOwnerSessionId, 'intermediate-owner');

  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    // #192 O1/L1: this test's own purpose is "evidence-free foreign row stays unresolved
    // and unwritten" — force the legacy scanner unavailable so judgment g does not
    // auto-recover it before that assertion is reached.
    loopOpts: { scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'test-fixture' }) },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.ok(row, 'recovery attempts에 hand 1이 없다');
  assert.equal(row.cleanupAuthorized, false, '소유하지 않은 pending 행을 write-authorized로 잘못 판정했다');
  const cleanupCalls = coachInvocations(calls, 'cleanup-result').filter((args) => flagValue(args, '--hand') === '1');
  assert.equal(cleanupCalls.length, 0, '권한 없는 행에 cleanup-result를 호출했다');
});

// ── #192 S4 E1: owner runtime closure receipt ──────────────────────────────

test('#192 S4: 락 획득에 실패한 두번째 loop가 requestStop을 불러도 첫 loop owner의 closure entry를 쓰지 않는다', { timeout: 10_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const adapter = makeAdapter();
  const first = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0 } });
  t.after(() => first.requestStop());
  await first.bootstrap({ ai: 1 });
  const firstOwner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;

  const second = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  await assert.rejects(second.bootstrap({ ai: 1 }), (error) => error.code === 'ACTIVE_GAME');
  await assert.rejects(second.resume(), (error) => error.code === 'LOCKED');
  await second.requestStop();

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.ownerSessionId, firstOwner, 'first loop이 여전히 자신의 owner를 소유해야 한다');
  assert.equal(
    (state.coachRuntimeClosures ?? []).some((entry) => entry.ownerSessionId === firstOwner),
    false,
    '락을 획득하지 못한 두번째 인스턴스가 첫 owner의 closure entry를 기록했다',
  );
});

test('#192 S4: owner 발급 전에 실패하는 resume은 requestStop에서 이전 owner의 closure entry를 기록하지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const initialized = await initGame(gameDir, ['--stack', '100']);
  const staleOwner = 'stale-owner-before-issue';
  // schemaVersion !== 1은 resume()이 lifecycleStarted = true를 지난 직후,
  // ownerSessionId = randomUUID()에 도달하기 한참 전에 BAD_PLAYER_RECOVERY로 던지게 한다.
  writeLoopStateFixture(gameDir, initialized.sessionToken, {
    ownerSessionId: staleOwner,
    pendingDecision: { schemaVersion: 999 },
  });

  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  t.after(() => loop.requestStop().catch(() => {}));

  await assert.rejects(loop.resume(), (error) => error.code === 'BAD_PLAYER_RECOVERY');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.ownerSessionId, staleOwner, '이 인스턴스는 새 owner를 발급하지 못했어야 한다');
  assert.equal(
    (state.coachRuntimeClosures ?? []).some((entry) => entry.ownerSessionId === staleOwner),
    false,
    'owner 발급 전 실패한 resume의 requestStop이 이전 owner를 closure entry로 기록했다',
  );
});

test('#192 S4: adapter dispose 실패는 owner closure entry를 기록하지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const adapter = makeAdapter();
  adapter.dispose = async () => {
    throw Object.assign(new Error('dispose failed for test'), { code: 'ADAPTER_DISPOSE_TEST_FAILURE' });
  };
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0 } });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1 });
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;

  await assert.rejects(loop.requestStop(), (error) => error.code === 'ADAPTER_DISPOSE_TEST_FAILURE');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(Object.hasOwn(state, 'stoppedAt'), false, 'disposal 실패인데도 stoppedAt이 기록됐다');
  assert.equal(state.cleanupError.code, 'ADAPTER_DISPOSE_TEST_FAILURE');
  assert.equal(
    (state.coachRuntimeClosures ?? []).some((entry) => entry.ownerSessionId === owner),
    false,
    'adapter dispose 실패에도 closure entry가 기록됐다',
  );
});

test('#192 S4: 성공적인 stop은 발급한 owner마다 정확히 한 번, 중복 없이 closure entry를 남기고 이전 인스턴스의 항목도 보존한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(() => first.requestStop().catch(() => {}));
  await first.bootstrap({ ai: 1 });
  const owner1 = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;

  await first.requestStop();
  let state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.coachRuntimeClosures.length, 1);
  assert.equal(state.coachRuntimeClosures[0].ownerSessionId, owner1);
  assert.equal(typeof state.coachRuntimeClosures[0].confirmedAt, 'string');

  // 같은 인스턴스에 대한 두번째 requestStop 호출은 캐시된 stopPromise를 재사용할 뿐,
  // 중복 기록을 만들지 않는다.
  await first.requestStop();
  state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.coachRuntimeClosures.length, 1);

  const second = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0, waitMs: 0 } });
  t.after(() => second.requestStop().catch(() => {}));
  const resumedState = await second.resume();
  const owner2 = resumedState.ownerSessionId;
  assert.notEqual(owner2, owner1);

  await second.requestStop();
  state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.coachRuntimeClosures.length, 2, '이전 인스턴스의 항목이 보존되지 않았거나 중복됐다');
  const owners = state.coachRuntimeClosures.map((entry) => entry.ownerSessionId).sort();
  assert.deepEqual(owners, [owner1, owner2].sort());
});

test('#192 I1: oneshotStart는 있지만 dispose가 없는 adapter가 있으면 성공적인 stop도 closure entry를 남기지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const logs = [];
  // A coach-capable adapter (exposes `oneshotStart`) that never confirms its own children
  // closed (no `dispose` at all) — `startAdapterDisposal` currently treats "no dispose" the
  // same as "successfully disposed", which is exactly the gap #192 I1 closes.
  const undisposableUpper = {
    kind: 'coach-undisposable',
    oneshotStart() {
      return {
        pid: 1,
        startTime: 'sentinel-i1-start',
        done: new Promise(() => {}),
        async terminate() { return { confirmed: true }; },
      };
    },
  };
  const loop = createGameLoop({
    gameDir,
    resolver: resolverForCoach(makeAdapter(), undisposableUpper),
    opts: { port: 0, waitMs: 0, log: (record) => logs.push(record) },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1 });
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;

  await loop.requestStop();

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(typeof state.stoppedAt, 'string', 'precondition: stop 자체는 정상적으로 성공해야 한다');
  assert.equal(
    (state.coachRuntimeClosures ?? []).some((entry) => entry.ownerSessionId === owner),
    false,
    'dispose를 확인하지 못한 coach adapter가 있는데도 closure entry가 기록됐다',
  );
  assert.ok(
    logs.some((row) => row.event === 'coach-runtime-closure-skipped'),
    'coach-runtime-closure-skipped 로그가 기록되지 않았다',
  );
});

test('#192 sJ4: dispose가 resolve해도 disposeConfirmsChildren을 선언하지 않은 coach adapter는 closure entry를 남기지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const logs = [];
  // dispose는 정상적으로 resolve하지만(예외 없음), 자신이 registry의 모든 child를
  // 실제로 확인·종료했다고 선언(`disposeConfirmsChildren`)하지 않는 adapter — "dispose가
  // 존재한다"만으로는 receipt를 신뢰할 수 없다는 #192 sJ4의 전제를 재현한다.
  const unconfirmingUpper = {
    kind: 'coach-unconfirming',
    oneshotStart() {
      return {
        pid: 1,
        startTime: 'sentinel-sj4-start',
        done: new Promise(() => {}),
        async terminate() { return { confirmed: true }; },
      };
    },
    async dispose() { /* resolve하지만 disposeConfirmsChildren을 선언하지 않는다 */ },
  };
  const loop = createGameLoop({
    gameDir,
    resolver: resolverForCoach(makeAdapter(), unconfirmingUpper),
    opts: { port: 0, waitMs: 0, log: (record) => logs.push(record) },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1 });
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;

  await loop.requestStop();

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(typeof state.stoppedAt, 'string', 'precondition: stop 자체는 정상적으로 성공해야 한다');
  assert.equal(
    (state.coachRuntimeClosures ?? []).some((entry) => entry.ownerSessionId === owner),
    false,
    'disposeConfirmsChildren을 선언하지 않은 coach adapter가 있는데도 closure entry가 기록됐다',
  );
  const skipped = logs.find((row) => row.event === 'coach-runtime-closure-skipped');
  assert.ok(skipped, 'coach-runtime-closure-skipped 로그가 기록되지 않았다');
  assert.equal(skipped.reason, 'DISPOSE_CONFIRMATION_UNDECLARED');
});

test('#192 I5/L2: requestStop 직전 loop lock 디렉터리가 다른 inode/identity로 바뀌면 LOOP_LOCK_LOST로 거부되고 loop-state를 쓰지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0, log: (record) => logs.push(record) },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1 });
  const loopStatePath = path.join(gameDir, 'loop-state.json');
  const before = readJson(loopStatePath);
  const beforeRaw = fs.readFileSync(loopStatePath, 'utf8');

  // Replace the loop lock directory this instance's in-memory `lockHandle` still points at
  // with a brand-new, empty directory: a new inode, no pid file at all — the same identity
  // loss `releaseOwnedLock` itself already tolerates (it silently no-ops). Before #192 L2
  // this only suppressed the closure receipt; the success-path write itself still went
  // through and reported a false success. L2 makes the whole stop attempt fail closed.
  const lockDir = path.join(gameDir, 'loop.lock.d');
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir);

  let caught = null;
  try {
    await loop.requestStop();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'lock을 잃은 stop이 거부되지 않았다');
  assert.equal(caught.code, 'LOOP_LOCK_LOST');

  // The stopping marker written at stop entry is guarded too, so a lock-lost instance
  // leaves loop-state byte-for-byte untouched.
  assert.equal(fs.readFileSync(loopStatePath, 'utf8'), beforeRaw, 'loop-state가 바뀌었다');
  assert.equal(before.stoppedAt, undefined);
  assert.ok(
    logs.some((row) => row.event === 'loop-lock-lost-on-stop'),
    'loop-lock-lost-on-stop 로그가 기록되지 않았다',
  );
  assert.ok(
    logs.some((row) => row.event === 'coach-runtime-closure-lock-lost'),
    'coach-runtime-closure-lock-lost 로그가 기록되지 않았다',
  );
});

test('#192 L2/#197: adapter disposal 실패와 락 상실이 겹치면 loop-state를 쓰지 않고 원래 정리 오류를 그대로 올린다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const logs = [];
  const disposeError = Object.assign(new Error('dispose boom'), { code: 'DISPOSE_BOOM' });
  const adapter = makeAdapter();
  adapter.dispose = async () => { throw disposeError; };
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0, log: (record) => logs.push(record) },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1 });
  const loopStatePath = path.join(gameDir, 'loop-state.json');
  const before = readJson(loopStatePath);

  const lockDir = path.join(gameDir, 'loop.lock.d');
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir);

  let caught = null;
  try {
    await loop.requestStop();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'disposal 실패 + lock 상실 stop이 거부되지 않았다');
  // #197: 락을 잃었다는 이유로 원래 정리 오류를 가리지 않는다. 자식이 살아 있을 수
  // 있다는 신호가 그대로 호출자에게 전달돼야 한다.
  assert.equal(caught.code, 'DISPOSE_BOOM', `원래 정리 오류가 가려졌다: ${caught.code}`);

  // requestStop 시작 시점의 `stopping`/`stopRequestedAt` 마커 외에는 아무것도 바뀌지
  // 않아야 한다 — 특히 cleanupError가 전혀 기록되지 않아야 한다(lock을 잃었으므로
  // persistCleanupFailure도 자신의 writeLoopState를 건너뛴다).
  const { stopping: _stopping, stopRequestedAt: _stopRequestedAt, ...restAfter } = readJson(loopStatePath);
  assert.deepEqual(restAfter, before, 'stopping 마커 외 다른 loop-state 필드가 바뀌었다');
  assert.equal(readJson(loopStatePath).cleanupError, undefined, 'cleanupError가 기록됐다');
  assert.ok(
    logs.some((row) => row.event === 'loop-lock-lost-on-stop'),
    'loop-lock-lost-on-stop 로그가 기록되지 않았다',
  );
  assert.ok(
    logs.some((row) => row.event === 'cleanup-failed' && row.code === 'DISPOSE_BOOM'),
    'cleanup-failed 로그가 원래 정리 오류 코드로 남지 않았다',
  );
});

test('#192 L2: observeRun은 LOOP_LOCK_LOST stop 실패에도 session을 비우지 않고 오류를 남긴다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const root = tmpGame();
  const manager = createSessionManager({
    storeDir: root,
    resolver: resolverFor(makeAdapter()),
  });
  t.after(() => manager.close().catch(() => {}));
  await manager.initialize();

  const payload = (kind) => {
    const s = manager.snapshot();
    return {
      requestId: randomUUID(),
      expectedInstanceId: s.instanceId,
      expectedAppRevision: s.appRevision,
      expectedGameId: s.gameId,
      expectedSelectionVersion: s.selectionVersion,
      kind,
    };
  };
  const settle = async (id) => {
    const deadline = Date.now() + 15_000 * WIN32_SCALE;
    while (Date.now() < deadline) {
      const row = manager.receipt(id);
      if (row.status !== 'accepted') return row;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('receipt timeout');
  };

  const start = { ...payload('start'), setup: { aiCount: 1, mode: 'cash-training' } };
  manager.command(start);
  assert.equal((await settle(start.requestId)).status, 'succeeded');
  assert.ok(manager.session, 'precondition: session이 등록돼야 한다');

  // `end`는 `paused` 상태에서만 허용된다(ALLOWED_COMMANDS) — `playing`에서 바로 보내면
  // INVALID_TRANSITION으로 거부된다.
  const pause = payload('pause');
  manager.command(pause);
  assert.equal((await settle(pause.requestId)).status, 'succeeded');

  // session-manager의 loop lock은 세션 하위 디렉터리가 아니라 store root 바로 아래
  // 있다(readOwnedLock(root, "loop.lock.d") — root는 storeDir다).
  const lockDir = path.join(root, 'loop.lock.d');
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir);

  const end = payload('end');
  manager.command(end);
  const row = await settle(end.requestId);

  assert.equal(row.status, 'failed', 'lock을 잃은 stop이 성공으로 기록됐다');
  assert.ok(manager.session, 'stop 실패인데도 session이 비워졌다');
  assert.equal(manager.snapshot().error, row.error);
});

test('#192 S4: 다른 owner의 closure entry는 이 행을 release하지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: {
      port: external.lock.port,
      coachRuntimeClosures: [{ ownerSessionId: 'unrelated-owner', confirmedAt: '2026-09-14T00:00:00.000Z' }],
    },
    // #192 O1/L1: this test's own purpose is "a non-matching closure entry never resolves
    // the row via c" — force the legacy scanner unavailable so judgment g does not
    // auto-recover it via a different path before that assertion is reached.
    loopOpts: { scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'test-fixture' }) },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.ok(row, 'recovery attempts에 hand 1이 없다');
  assert.notEqual(row.reason, 'OWNER_RUNTIME_CLOSED', '다른 owner의 closure entry로 released 판정했다');
});

test('#192 S4 분류자 c: 표식 없는 legacy 행도 owner closure entry가 있으면 OWNER_RUNTIME_CLOSED로 released되고 d·f를 거치지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  // spawnEvidence도 acceptEvidence도 sidecar도 없는 legacy fixture — 이 owner에
  // closure entry가 없으면 (형제 테스트 "#192 S2b 분류자 2") FINALIZATION_ABORTED로
  // halt한다. 유일한 차이는 아래 coachRuntimeClosures뿐이므로, released로 바뀐다면
  // 그것은 오직 c 때문이지 d(NOT_SPAWNED)나 f(ACCEPT_EVIDENCE)일 수 없다.
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: {
      port: external.lock.port,
      coachRuntimeClosures: [{ ownerSessionId: 'old-owner', confirmedAt: '2026-09-14T00:00:00.000Z' }],
    },
  });

  const resumed = await loop.resume();

  assert.equal(resumed.halt, undefined, `resume이 halt됐다: ${JSON.stringify(resumed.halt)}`);
  assert.equal(coachInvocations(calls, 'begin-owner').length, 1);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released');
        assert205Evidence(coachInvocations(calls, 'cleanup-result'), 'OWNER_RUNTIME_CLOSED');
        assert205Trace(gameDir, 'OWNER_RUNTIME_CLOSED');
  assert.notEqual(row?.spawnEvidence, 1, 'legacy 행에는 spawnEvidence stamp가 없어야 한다(d 배제 확인)');
});

test('#192 S4: resume은 이전 인스턴스가 남긴 coachRuntimeClosures 항목을 유지한다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  const priorOwner = 'owner-closed-before-crash';
  const priorClosure = { ownerSessionId: priorOwner, confirmedAt: '2026-09-01T00:00:00.000Z' };
  writeLoopStateFixture(gameDir, init.sessionToken, {
    phase: 'playing',
    coachRuntimeClosures: [priorClosure],
  });
  const adapter = makeAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0, waitMs: 0 } });
  t.after(() => loop.requestStop().catch(() => {}));

  const resumed = await loop.resume();

  assert.equal(resumed.phase, 'playing');
  assert.deepEqual(resumed.coachRuntimeClosures, [priorClosure]);
  const onDisk = readJson(path.join(gameDir, 'loop-state.json'));
  assert.deepEqual(onDisk.coachRuntimeClosures, [priorClosure]);
});

// ── #192 S5: 이슈 재현 통합 (design memo §7 S5) ──────────────────────────────
//
// finalizeBudgetMs/finalizeCutoffLeadMs are deliberately tight: with S1–S4 applied, both
// coach rows are resolvable purely from spawn evidence, so a generous budget lets the very
// same first run reach `done` on its own. Keeping the budget this small forces the run to
// hit the common finalization deadline before it can finish draining (finalize-cutoff,
// residual publish, review generation) — matching the issue's own budgetMs/resultWaitMs
// exhaustion — while still leaving enough room for hand 2's real, lock-contended
// bind-handle/publish attempts (each bounded by childTimeoutMs) to fail on their own.
const ISSUE_192_FINALIZE_BUDGET_MS = 4_200;
const ISSUE_192_FINALIZE_CUTOFF_LEAD_MS = 1_200;
const ISSUE_192_RESULT_WAIT_MS = ISSUE_192_FINALIZE_BUDGET_MS - ISSUE_192_FINALIZE_CUTOFF_LEAD_MS;
const ISSUE_192_CHILD_TIMEOUT_MS = 900;

// Builds the issue's first-run failure store through the real loop (no hand-written
// authority rows): a finished two-hand game with training enabled, hand 1's coach
// reservation that never spawns (evidence judgment d), hand 2's coach reservation that
// spawns and then fails bind-handle with a confirmed terminate (evidence judgment b), one
// training evaluation pending past the shared result-wait cutoff, and a real
// training-publish-error contending on the same lock hand 2's bind-handle is stuck on.
// `crashHandOneIntent` swaps hand 1's mechanism for the crash-variant test: hand 1's
// checkpoint still blocks, but it is released only after hand 2's own bind-handle cascade
// has already failed on its own (observed via the `coach-error` log), so jumping a fake
// monotonic clock forward at that point to cross hand 1's cutoff can never race hand 2's
// still-in-flight early cutoff checks. Once released, the intent sidecar write succeeds
// normally, the jump lands, and the immediately following aborted-before-spawn write is
// made to fail — the same #192 S2b commitTmp-retry technique in spirit (real time passing
// between the two writes), except the "time" is a clock jump instead of a blocking sleep
// so hand 2's own concurrent processing is never stalled by it, and the follow-up write is
// made to fail like an actual crash would leave it, so the sidecar is left at exactly
// `phase: 'intent'`.
async function buildIssue192FirstRunFailure(t, { crashHandOneIntent = false } = {}) {
  const finalizeBudgetMs = ISSUE_192_FINALIZE_BUDGET_MS;
  const finalizeCutoffLeadMs = ISSUE_192_FINALIZE_CUTOFF_LEAD_MS;
  const resultWaitMs = ISSUE_192_RESULT_WAIT_MS;
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  expandFinishedGameToTwoHands(gameDir);

  let held = null;
  const releaseHeldLock = async () => {
    if (!held) return;
    const current = held;
    held = null;
    current.release();
    await current.done;
  };
  t.after(releaseHeldLock);

  let releaseHandOneCheckpoint = () => {};
  const handOneCheckpointGate = new Promise((resolve) => { releaseHandOneCheckpoint = resolve; });

  const hand2Terminations = [];
  const upper = makeCoachAdapter({
    rounds: [
      { raw: JSON.stringify({ handNo: 1, text: '핸드 1 코치 (도달하지 않음)' }) },
      {
        pid: 4_242_424,
        startTime: 'issue-192-hand2-identity',
        raw: JSON.stringify({ handNo: 2, text: '핸드 2 코치 (도달하지 않음)' }),
        terminate: () => {
          hand2Terminations.push(Date.now());
          return { confirmed: true };
        },
      },
    ],
  });

  // A monotonic clock this test can jump forward instantly instead of blocking the whole
  // JS thread with a synchronous sleep (which would also stall hand 2's own timeline,
  // since Atomics.wait halts every other pending callback along with it).
  let monotonicOffsetNs = 0n;
  const monotonicNs = () => process.hrtime.bigint() + monotonicOffsetNs;

  let hand1IntentWritten = false;
  const writeSpawnEvidence = (filePath, data) => {
    if (!crashHandOneIntent || data.handNo !== 1) {
      writeJsonAtomic(filePath, data);
      return;
    }
    if (data.phase === 'intent' && !hand1IntentWritten) {
      hand1IntentWritten = true;
      writeJsonAtomic(filePath, data);
      // Jump the clock past the shared result-wait cutoff so the very next
      // assertBeforeResultWaitCutoff() call genuinely fails, without blocking the thread
      // hand 2's own concurrent bind-handle attempt depends on.
      monotonicOffsetNs += BigInt(resultWaitMs + 700) * 1_000_000n;
      return;
    }
    if (data.phase === 'aborted-before-spawn') {
      // Simulate a crash between "the cutoff was exceeded" and "that fact was durably
      // recorded": the sidecar must never move past `intent`.
      throw new Error('issue-192 simulated crash before aborted-before-spawn landed');
    }
    writeJsonAtomic(filePath, data);
  };

  const loop = createGameLoop({
    gameDir,
    resolver: async ({ need }) => {
      assert.equal(need, 'upper-only');
      return { player: null, upper, notices: [] };
    },
    opts: {
      port: 0,
      waitMs: 0,
      // #192 J3: this fixture reserves hands through the loop's own current-protocol
      // `reserve` (always `spawnEvidence: 1`), so it can never actually produce a
      // legacy-eligible row — the default is added anyway for defense-in-depth, matching
      // every other shared loop constructor in this file.
      scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES,
      trainingEnabled: true,
      training: {
        // Hand 1's evaluation hangs past the cutoff (`training-settle-return
        // timeout=true pending=1`); hand 2's real evaluation is left to run so its
        // machine publish attempt genuinely contends on the held publish.lock.d. Like a
        // real evaluate handle, terminate() actually settles the promise (a cancelled
        // evaluation) instead of leaving it dangling — finalize's own
        // terminateTrainingChildren() calls terminate() once the cutoff is confirmed, and
        // an unresolvable promise here would make requestStop()'s unbounded
        // `Promise.allSettled([...trainingTasks])` hang forever.
        evaluate: (sessionDir, handNo, options) => {
          if (handNo === 1) {
            let settle;
            const promise = new Promise((resolve) => { settle = resolve; });
            return {
              promise,
              terminate: async () => {
                settle({ ok: false, code: 'ISSUE_192_HAND1_EVALUATE_TERMINATED' });
                return { confirmed: true };
              },
            };
          }
          return defaultEvaluate(sessionDir, handNo, options);
        },
      },
      childTimeoutMs: ISSUE_192_CHILD_TIMEOUT_MS,
      finalizeBudgetMs,
      finalizeCutoffLeadMs,
      monotonicNs,
      writeSpawnEvidence,
      coachSpawnCheckpoint: async ({ handNo }) => {
        if (handNo === 1) {
          await handOneCheckpointGate;
          return;
        }
        // Hand 2: hold the coach-control lock so bind-handle (and every later
        // coach-control/publish attempt while it is held) times out via childTimeoutMs.
        held = await holdNamedLock(gameDir, 'publish.lock.d');
      },
    },
  });
  // The crash variant must never reach a successful requestStop (that is what would mint
  // the owner-runtime-closure receipt this variant exists to go without), so its cleanup
  // only clears the OS-level loop lock directory instead of running the loop's own
  // graceful shutdown.
  if (!crashHandOneIntent) {
    t.after(() => loop.requestStop().catch(() => {}));
  } else {
    t.after(() => { try { fs.rmSync(path.join(gameDir, 'loop.lock.d'), { recursive: true, force: true }); } catch { /* already gone */ } });
  }

  const state = await loop.resume();
  assert.equal(state.phase, 'finalizing');

  const running = startRun(loop);
  if (!crashHandOneIntent) {
    // Release hand 1's spawn checkpoint only once the shared result-wait cutoff has
    // certainly elapsed, matching #192 S2b's `coachSpawnCheckpoint 대기 중 cutoff가
    // 걸리면...` test.
    await new Promise((resolve) => setTimeout(resolve, resultWaitMs + 500));
    releaseHandOneCheckpoint();
  } else {
    // Let hand 2's own bind-handle cascade fail on its own first (real time, real lock
    // contention, unaffected by any clock trick) before crossing hand 1's cutoff — jumping
    // the clock any earlier could also cross hand 2's own still-in-flight early cutoff
    // check and short-circuit it before it ever reaches bind-handle.
    await waitFor(
      () => readLoopLog(gameDir).find((row) => row.event === 'coach-error'),
      'hand 2 bind-handle failure did not surface as a coach-error before crossing hand 1\'s cutoff',
      20_000,
    );
    releaseHandOneCheckpoint();
  }

  // Keep publish.lock.d held for the whole run, not just through hand 2's bind-handle
  // failure: closePersistedCoachWorkers() runs inside this same finalize() call, and if
  // the lock were freed early it could successfully write cleanup-result for both rows
  // before the run ever aborts, leaving nothing unresolved for the resumes below to prove
  // anything about. Releasing only after the run settles keeps both rows genuinely
  // unresolved through the abort, matching the issue's own observation.
  const outcome = await running.catch((error) => error);
  await releaseHeldLock();
  assert.equal(
    outcome?.code,
    'FINALIZATION_ABORTED',
    `first run was expected to abort (got ${outcome?.phase ?? outcome?.code})`,
  );
  assert.ok(
    readLoopLog(gameDir).some((row) => row.event === 'training-publish-error'),
    'training publish did not fail while publish.lock.d was held',
  );
  assert.ok(
    readLoopLog(gameDir).some((row) => row.event === 'coach-error'),
    'hand 2 bind-handle failure did not surface as a coach-error',
  );

  if (!crashHandOneIntent) {
    // This is what the app does after a failed run: wait for requestStop to resolve.
    await loop.requestStop();
  } else {
    // Simulate a crash: no requestStop, no owner-runtime-closure receipt, no graceful
    // adapter/coach/training teardown. Only the OS-level lock is cleared — mirroring an
    // operator confirming the crashed process is gone and clearing its stale lock
    // directory — so a fresh resume can proceed in this same test process.
    fs.rmSync(path.join(gameDir, 'loop.lock.d'), { recursive: true, force: true });
  }

  return { gameDir, init, loop, upper, hand2Terminations };
}

// An unresolved coach reservation lives in `auth.hands[handNo]` (status reserved/running)
// until cleanup-result actually writes; only then does it move into `retiredAttempts`
// with a `cleanupState`. Tests need to read whichever shape currently holds a hand.
function coachAuthorityRow(authority, handNo) {
  const retired = (authority.retiredAttempts ?? []).find((row) => row.handNo === handNo);
  if (retired) return { ...retired, handNo, released: retired.cleanupState === 'released' };
  const active = authority.hands?.[String(handNo)];
  if (!active) return null;
  return { ...active, handNo, released: false };
}

test('#192 S5: 이슈 재현 — 1차 finalize 실패 store를 수정 없이 두 번 재개하면 done과 리뷰 게시에 도달한다', { timeout: 60_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  if (skipOnWin32(t, 'finalization budgets are timed for POSIX; win32 CI overruns the cutoff')) return;
  const { gameDir, init } = await buildIssue192FirstRunFailure(t);

  const loopLog = readLoopLog(gameDir);
  assert.ok(
    loopLog.some((row) => row.event === 'finalize-halt' && row.code === 'FINALIZATION_ABORTED'),
    'first run did not log finalize-halt FINALIZATION_ABORTED',
  );
  const publishError = loopLog.find((row) => row.event === 'training-publish-error');
  assert.ok(publishError, 'first run did not log a training-publish-error row');

  const authorityBefore = readJson(path.join(gameDir, '.coach-authority.json'));
  const rowsBefore = [1, 2].map((handNo) => coachAuthorityRow(authorityBefore, handNo));
  assert.ok(rowsBefore[0] && rowsBefore[1], 'precondition: both coach hands left an unresolved row');
  for (const row of rowsBefore) {
    assert.equal(row.agentHandle, null, `hand ${row.handNo} unexpectedly has an agentHandle`);
    assert.equal(row.released, false, `hand ${row.handNo} was already released before resume`);
  }

  const stateBefore = readJson(path.join(gameDir, 'state.json'));
  const handsDirBefore = fs.readdirSync(path.join(gameDir, 'hands')).sort();
  // #192 I4: byte-for-byte, not just filenames — a fresh resume replaying/rewriting a hand
  // file would pass a filename-only comparison but must fail this one.
  const handsTreeBefore = snapshotTree(path.join(gameDir, 'hands'));
  const sealsBefore = { ...authorityBefore.publishedSeals };
  assert.deepEqual(sealsBefore, {}, 'precondition: no hand was sealed yet');

  // ── first fresh resume: must reach done and publish the review ──────────────────
  const firstResumeCalls = [];
  const firstResumed = createGameLoop({
    gameDir,
    resolver: async ({ need }) => {
      assert.equal(need, 'upper-only');
      return {
        player: null,
        upper: makeCoachAdapter({ synthesizerRounds: [{ raw: VALID_REVIEW }] }),
        notices: [],
      };
    },
    opts: {
      port: 0,
      waitMs: 0,
      onCoachInvoke: (args) => firstResumeCalls.push(args),
    },
  });
  t.after(() => firstResumed.requestStop().catch(() => {}));

  const firstState = await firstResumed.resume();
  assert.equal(firstState.phase, 'finalizing');
  const firstCompleted = await firstResumed.run();
  assert.equal(firstCompleted.phase, 'done', `first fresh resume did not reach done (halt ${JSON.stringify(firstCompleted.halt)})`);
  assert.equal(fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8'), VALID_REVIEW);
  assert.deepEqual(readJson(path.join(gameDir, '.review.json')), { review: VALID_REVIEW });

  const stateAfterFirstResume = readJson(path.join(gameDir, 'state.json'));
  assert.deepEqual(stateAfterFirstResume.lastHand?.handNo, stateBefore.lastHand?.handNo);
  assert.deepEqual(stateAfterFirstResume.result, stateBefore.result);
  assert.deepEqual(fs.readdirSync(path.join(gameDir, 'hands')).sort(), handsDirBefore);
  // #192 I4: byte-for-byte comparison of every file under hands/, not just the filename
  // listing above.
  assert.deepEqual(
    snapshotTree(path.join(gameDir, 'hands')),
    handsTreeBefore,
    'a fresh resume changed the bytes of a file under hands/',
  );

  const authorityAfterFirstResume = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.ok(authorityAfterFirstResume.publishedSeals['1'], 'hand 1 was not sealed after done');
  assert.ok(authorityAfterFirstResume.publishedSeals['2'], 'hand 2 was not sealed after done');

  // #192 I4: the final ui-snapshot.json `review` field's own digest must equal the
  // durably recorded published-review digest (`loop-state.json`'s `reviewSha256`, the same
  // field `snapshotReviewStatus` in tools/game-loop.js compares against) — proving the
  // snapshot actually carries the review that was published, not some other text.
  const finalSnapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  const finalLoopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(
    sha256Text(finalSnapshot.review),
    finalLoopState.reviewSha256,
    'ui-snapshot.json review 필드의 digest가 게시된 review digest(loop-state.reviewSha256)와 다르다',
  );

  await firstResumed.requestStop();

  // ── second fresh resume on the done game: must be a pure no-op ──────────────────
  const secondResumeCalls = [];
  const authorityBytesBeforeSecond = fs.readFileSync(path.join(gameDir, '.coach-authority.json'));
  const secondResumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 0,
      onCoachInvoke: (args) => secondResumeCalls.push(args),
    },
  });
  t.after(() => secondResumed.requestStop().catch(() => {}));

  const secondState = await secondResumed.resume();
  assert.equal(secondState.phase, 'done');
  assert.equal((await secondResumed.run()).phase, 'done');

  assert.equal(
    secondResumeCalls.some((args) => args[0] === 'cleanup-result' || args[0] === 'adapter-disable'),
    false,
    'second resume on a done game issued cleanup-result/adapter-disable calls',
  );
  assert.equal(
    fs.readFileSync(path.join(gameDir, '.coach-authority.json')).equals(authorityBytesBeforeSecond),
    true,
    'second resume on a done game changed .coach-authority.json bytes',
  );
});

test('#192 I4: publishCliPath 테스트 seam — 비envelope stdout은 training-publish-error에 BAD_CHILD_OUTPUT로 진단되고 sentinel 텍스트는 로그에 남지 않는다', { timeout: 30_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  await seedFinishedGame(gameDir);
  const sentinel = 'PRIVATE_SENTINEL_192';
  // A publish CLI stand-in that exits 0 but never prints a JSON success envelope — the
  // loop's own runJsonChild must classify this as BAD_CHILD_OUTPUT, not crash or hang.
  const brokenPublishPath = path.join(gameDir, '.broken-publish.cjs');
  fs.writeFileSync(
    brokenPublishPath,
    `process.stdout.write('not a json envelope ${sentinel}\\n');\nprocess.exitCode = 0;\n`,
  );

  const upper = makeCoachAdapter({ synthesizerRounds: [{ raw: VALID_REVIEW }] });
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper, notices: [] }),
    opts: {
      port: 0,
      waitMs: 0,
      trainingEnabled: true,
      publishCliPath: brokenPublishPath,
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));

  await loop.resume();
  await loop.run().catch(() => {});

  const loopLog = readLoopLog(gameDir);
  const publishError = loopLog.find((row) => row.event === 'training-publish-error');
  assert.ok(publishError, 'training-publish-error가 로그에 없다');
  assert.equal(publishError.code, 'BAD_CHILD_OUTPUT');
  assert.equal(publishError.details?.script, path.basename(brokenPublishPath));
  assert.equal(publishError.details?.exitCode, 0);
  assert.ok(
    Number.isInteger(publishError.details?.stdoutBytes) && publishError.details.stdoutBytes > 0,
    'BAD_CHILD_OUTPUT details에 stdout byte count가 없다',
  );

  const logText = fs.readFileSync(path.join(gameDir, 'loop.log'), 'utf8');
  assert.doesNotMatch(logText, new RegExp(sentinel), 'loop.log에 sentinel 텍스트가 노출됐다');
  const statePath = path.join(gameDir, 'loop-state.json');
  if (fs.existsSync(statePath)) {
    assert.doesNotMatch(fs.readFileSync(statePath, 'utf8'), new RegExp(sentinel), 'loop-state.json에 sentinel 텍스트가 노출됐다');
  }
});

// #192 S5 (team-lead addendum): after the app-style requestStop() succeeds, judgment c
// (OWNER_RUNTIME_CLOSED) releases every row of that owner first, which can hide whether
// the spawn sidecar evidence (b/d) alone would have been enough. Remove the owner closure
// receipt between runs — the only allowed edit — so the fresh resume must close both rows
// on spawn evidence alone.
test('#192 S5: 종료 영수증 없이도 spawn 증거만으로 1차 finalize 실패 store가 done에 도달한다', { timeout: 60_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  if (skipOnWin32(t, 'finalization budgets are timed for POSIX; win32 CI overruns the cutoff')) return;
  const { gameDir } = await buildIssue192FirstRunFailure(t);

  const loopStateBefore = readJson(path.join(gameDir, 'loop-state.json'));
  assert.ok(
    Array.isArray(loopStateBefore.coachRuntimeClosures) && loopStateBefore.coachRuntimeClosures.length > 0,
    'precondition: the clean requestStop did not leave a coachRuntimeClosures receipt',
  );

  const authorityBefore = readJson(path.join(gameDir, '.coach-authority.json'));
  const rowsBefore = [1, 2].map((handNo) => coachAuthorityRow(authorityBefore, handNo));
  assert.ok(rowsBefore[0] && rowsBefore[1], 'precondition: both coach hands left an unresolved row');
  for (const row of rowsBefore) {
    assert.equal(row.released, false, `hand ${row.handNo} was already released before removing the receipt`);
    assert.equal(row.acceptEvidence ?? null, null, `hand ${row.handNo} unexpectedly carries acceptEvidence`);
  }

  delete loopStateBefore.coachRuntimeClosures;
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify(loopStateBefore));

  const resumed = createGameLoop({
    gameDir,
    resolver: async ({ need }) => {
      assert.equal(need, 'upper-only');
      return {
        player: null,
        upper: makeCoachAdapter({ synthesizerRounds: [{ raw: VALID_REVIEW }] }),
        notices: [],
      };
    },
    opts: { port: 0, waitMs: 0 },
  });
  t.after(() => resumed.requestStop().catch(() => {}));

  const state = await resumed.resume();
  assert.equal(state.phase, 'finalizing');
  const completed = await resumed.run();
  assert.equal(
    completed.phase,
    'done',
    `resume without a closure receipt did not reach done (halt ${JSON.stringify(completed.halt)})`,
  );
  assert.equal(fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8'), VALID_REVIEW);

  const authorityAfter = readJson(path.join(gameDir, '.coach-authority.json'));
  const rowsAfter = [1, 2].map((handNo) => coachAuthorityRow(authorityAfter, handNo));
  assert.ok(rowsAfter[0] && rowsAfter[1]);
  for (const row of rowsAfter) {
    assert.equal(row.released, true, `hand ${row.handNo} was not released`);
  }

  const hand1Row = rowsAfter.find((row) => row.handNo === 1);
  const hand2Row = rowsAfter.find((row) => row.handNo === 2);
  const hand1SidecarPath = coachSpawnSidecarPath(gameDir, hand1Row.exactResultPath);
  const hand2SidecarPath = coachSpawnSidecarPath(gameDir, hand2Row.exactResultPath);
  // hand 1's checkpoint blocked before any write; a sidecar surviving as
  // aborted-before-spawn is also acceptable, matching the plan's own allowance.
  if (fs.existsSync(hand1SidecarPath)) {
    assert.equal(readJson(hand1SidecarPath).phase, 'aborted-before-spawn');
  }
  // #192 O2: hand 2's bind-handle never completes (it times out on the held
  // publish.lock.d), so the pipeline's own outer catch confirms termination in-process via
  // the fixture's custom terminate() during the FIRST run itself — well before this second,
  // receipt-less resume ever runs. Because that attempt never reached `bound: true`,
  // terminateCoachAttempt() persists that confirmation as `closed-confirmed` right then, so
  // this resume's classifier releases the row on that (still spawn-sidecar) evidence alone,
  // never needing to poll the old identity's liveness at all.
  assert.equal(readJson(hand2SidecarPath).phase, 'closed-confirmed');
});

// #192 S5 variant: no requestStop, no owner-runtime-closure receipt, and hand 1's sidecar
// left at exactly `phase: 'intent'` (evidence judgment e) — a fresh resume must halt
// explicitly rather than silently release it, and must not duplicate coach-control
// transitions on a second resume attempt.
test('#192 S5: 영수증 없는 crash store는 명시적으로 멈추고 증거 요약을 남긴다', { timeout: 60_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  if (skipOnWin32(t, 'finalization budgets are timed for POSIX; win32 CI overruns the cutoff')) return;
  const { gameDir } = await buildIssue192FirstRunFailure(t, { crashHandOneIntent: true });

  const loopStateBefore = readJson(path.join(gameDir, 'loop-state.json'));
  if (Array.isArray(loopStateBefore.coachRuntimeClosures) && loopStateBefore.coachRuntimeClosures.length > 0) {
    delete loopStateBefore.coachRuntimeClosures;
    fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify(loopStateBefore));
  }
  assert.equal(
    (readJson(path.join(gameDir, 'loop-state.json')).coachRuntimeClosures ?? []).length,
    0,
    'precondition: no owner-runtime-closure receipt exists for this crash store',
  );

  const authorityBefore = readJson(path.join(gameDir, '.coach-authority.json'));
  const hand1RowBefore = coachAuthorityRow(authorityBefore, 1);
  assert.ok(hand1RowBefore && hand1RowBefore.released === false, 'precondition: hand 1 left an unresolved row');
  const hand1SidecarPath = coachSpawnSidecarPath(gameDir, hand1RowBefore.exactResultPath);
  assert.equal(
    readJson(hand1SidecarPath).phase,
    'intent',
    'precondition: hand 1 sidecar did not stay at intent',
  );

  const firstResumeCalls = [];
  const firstResumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 0,
      onCoachInvoke: (args) => firstResumeCalls.push(args),
    },
  });
  t.after(() => firstResumed.requestStop().catch(() => {}));

  // closePersistedCoachWorkers() runs inside resume()'s own finalizing branch, before
  // beginCoachOwner, so an unconfirmable row is expected to reject resume() itself; only
  // fall through to run() if resume() unexpectedly succeeded.
  const firstOutcome = await firstResumed.resume().catch((error) => error);
  const firstHalted = firstOutcome instanceof Error
    ? firstOutcome
    : await firstResumed.run().catch((error) => error);
  assert.equal(
    firstHalted?.code,
    'FINALIZATION_ABORTED',
    `resume of an unconfirmable crash store was expected to halt explicitly (got ${JSON.stringify(firstHalted)})`,
  );

  const loopStateAfterFirst = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopStateAfterFirst.halt?.code, 'FINALIZATION_ABORTED');
  const attempts = loopStateAfterFirst.halt?.recovery?.attempts ?? [];
  const hand1Attempt = attempts.find((attempt) => attempt.handNo === 1);
  assert.ok(hand1Attempt, 'halt.recovery.attempts did not include hand 1');
  assert.ok(hand1Attempt.evidence, 'hand 1 unresolved attempt did not carry an evidence summary');

  // #192 O3: include 'fence' alongside cleanup-result/adapter-disable — hand 1 is still
  // `source: 'active'` at this point (never retired), so the first closure's own fence
  // call belongs in the mutating-call count too, not just the two writes that follow it.
  const firstMutatingCalls = firstResumeCalls.filter((args) => (
    args[0] === 'cleanup-result' || args[0] === 'adapter-disable' || args[0] === 'fence'
  ));

  await firstResumed.requestStop().catch(() => {});

  // #192 O3: capture the authority bytes right after the first resume's own halt, before
  // the second (repeated) resume runs at all.
  const authorityAfterFirst = fs.readFileSync(path.join(gameDir, '.coach-authority.json'));

  // Repeated resume must not duplicate cleanup-result/adapter-disable/fence transitions.
  const secondResumeCalls = [];
  const secondResumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 0,
      onCoachInvoke: (args) => secondResumeCalls.push(args),
    },
  });
  t.after(() => secondResumed.requestStop().catch(() => {}));

  const secondOutcome = await secondResumed.resume().catch((error) => error);
  const secondHalted = secondOutcome instanceof Error
    ? secondOutcome
    : await secondResumed.run().catch((error) => error);
  assert.equal(secondHalted?.code, 'FINALIZATION_ABORTED');
  const secondMutatingCalls = secondResumeCalls.filter((args) => (
    args[0] === 'cleanup-result' || args[0] === 'adapter-disable' || args[0] === 'fence'
  ));
  // hand 2's row was already released on the first resume (evidence alone, independent of
  // hand 1's unresolved status) and its retiredAttempts entry is skipped on every later
  // scan. Hand 1's own first closure already retired it (fence) and wrote its
  // termination_unconfirmed cleanup-result/adapter-disable once — its unchanged
  // classification on the second resume (`cleanupStateUnchanged`, D4's already-disabled
  // adapterState) must skip every one of those three calls entirely, not merely not
  // exceed the first resume's count.
  assert.equal(
    secondMutatingCalls.length,
    0,
    `repeated resume issued mutating coach calls: ${JSON.stringify(secondMutatingCalls)}`,
  );
  assert.equal(
    fs.readFileSync(path.join(gameDir, '.coach-authority.json')).equals(authorityAfterFirst),
    true,
    'second resume changed .coach-authority.json bytes',
  );
  await secondResumed.requestStop().catch(() => {});
});

// ── #192 S6: 반복 재개 멱등성과 진단 (design memo §4 D4·D5, §7 S6) ──────────────

test('#192 S6: BAD_CHILD_OUTPUT details는 allowlist에 있는 code만 통과시키고 그 외는 UNLISTED로 가린다', () => {
  const base = { script: COACH_CLI, exitCode: 0, signal: null };
  const sentinel = 'PRIVATE_SENTINEL_XYZ';

  const known = buildBadChildOutputDetails({
    ...base, stdout: JSON.stringify({ code: 'DEADLINE_EXPIRED' }), stderr: '',
  });
  assert.equal(known.code, 'DEADLINE_EXPIRED', '알려진 code는 그대로 통과해야 한다');
  assert.equal(known.script, path.basename(COACH_CLI));
  assert.equal(known.exitCode, 0);
  assert.equal(known.signal, null);
  assert.equal(known.stdoutBytes, Buffer.byteLength(JSON.stringify({ code: 'DEADLINE_EXPIRED' }), 'utf8'));
  assert.equal(known.stderrBytes, 0);

  const sentinelString = buildBadChildOutputDetails({
    ...base, stdout: JSON.stringify({ code: sentinel }), stderr: '',
  });
  assert.equal(sentinelString.code, 'UNLISTED', 'allowlist에 없는 문자열 code는 UNLISTED여야 한다');
  assert.ok(!JSON.stringify(sentinelString).includes(sentinel));

  const nestedObject = buildBadChildOutputDetails({
    ...base, stdout: JSON.stringify({ code: { nested: sentinel } }), stderr: '',
  });
  assert.equal(nestedObject.code, 'UNLISTED', '객체 code는 UNLISTED여야 한다');
  assert.ok(!JSON.stringify(nestedObject).includes(sentinel));

  const oversizedCode = 'X'.repeat(10 * 1024);
  const oversized = buildBadChildOutputDetails({
    ...base, stdout: JSON.stringify({ code: oversizedCode }), stderr: '',
  });
  assert.equal(oversized.code, 'UNLISTED', '10KB 문자열 code는 UNLISTED여야 한다');
  assert.ok(!JSON.stringify(oversized).includes(oversizedCode));

  const nonJsonStdout = `이건 JSON이 아닙니다 ${sentinel}`;
  const nonJson = buildBadChildOutputDetails({ ...base, stdout: nonJsonStdout, stderr: '' });
  assert.equal('code' in nonJson, false, 'stdout이 JSON이 아니면 code 필드를 아예 싣지 않아야 한다');
  assert.ok(!JSON.stringify(nonJson).includes(sentinel));
  assert.equal(nonJson.stdoutBytes, Buffer.byteLength(nonJsonStdout, 'utf8'));

  const missingCode = buildBadChildOutputDetails({ ...base, stdout: JSON.stringify({ ok: false }), stderr: '' });
  assert.equal(missingCode.code, 'UNLISTED', 'JSON이지만 code 필드가 없으면 UNLISTED여야 한다');
});

test('#192 I6: allowlist는 publish.js·engine/cli.js가 실제로 방출하는 모든 code를 포함한다', () => {
  const base = { script: COACH_CLI, exitCode: 0, signal: null };
  // tools/publish.js: STALE_COACH_AUTHORITY (assertCoachQueue/staleAttemptReason 둘 다),
  // BAD_ATTEMPT_VERSION·STALE_GAME_ATTEMPT(staleAttemptReason이 반환해 bail되는 코드),
  // BAD_SNAPSHOT(readJson(ui-snapshot.json, 'BAD_SNAPSHOT', …)).
  // engine/cli.js: HINT_SNAPSHOT_INVALID(throwCoded, catch-all이 top-level code로 방출).
  for (const code of [
    'STALE_COACH_AUTHORITY', 'BAD_ATTEMPT_VERSION', 'STALE_GAME_ATTEMPT',
    'BAD_SNAPSHOT', 'HINT_SNAPSHOT_INVALID',
  ]) {
    const details = buildBadChildOutputDetails({ ...base, stdout: JSON.stringify({ code }), stderr: '' });
    assert.equal(details.code, code, `${code}가 allowlist에 없어 UNLISTED로 가려졌다`);
  }
});

test('#192 S6: 영구히 unknown인 persisted identity를 반복 재개해도 cleanup-result·adapter-disable은 첫 closure에서만 호출된다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, 'old-owner', 1, orphan);

  const loopOpts = {
    finalizeBudgetMs: 2_200 * WIN32_SCALE,
    finalizeCutoffLeadMs: 1_100 * WIN32_SCALE,
    processStartTime: (pid) => (pid === orphan.pid ? null : processStartTime(pid)),
    signalProcess: (pid, signal) => { if (pid !== orphan.pid) process.kill(pid, signal); },
  };

  const { loop: loop1, calls: calls1 } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper: makeCoachAdapter(),
    stateOverrides: { port: external.lock.port },
    loopOpts,
  });
  await assert.rejects(loop1.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
  assert.equal(coachInvocations(calls1, 'cleanup-result').length, 1, '첫 closure는 cleanup-result를 정확히 한 번 호출해야 한다');
  assert.equal(coachInvocations(calls1, 'adapter-disable').length, 1, '첫 closure는 adapter-disable을 정확히 한 번 호출해야 한다');
  await loop1.requestStop().catch(() => {});

  const authorityAfterFirst = fs.readFileSync(path.join(gameDir, '.coach-authority.json'));

  const calls2 = [];
  const loop2 = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: { port: 0, waitMs: 0, ...loopOpts, onCoachInvoke: (args) => calls2.push({ kind: 'coach', args }) },
  });
  t.after(() => loop2.requestStop().catch(() => {}));
  await assert.rejects(loop2.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
  assert.equal(coachInvocations(calls2, 'cleanup-result').length, 0, '두 번째 재개는 cleanup-result를 다시 호출하면 안 된다');
  assert.equal(coachInvocations(calls2, 'adapter-disable').length, 0, '두 번째 재개는 adapter-disable을 다시 호출하면 안 된다');
  await loop2.requestStop().catch(() => {});

  assert.equal(
    fs.readFileSync(path.join(gameDir, '.coach-authority.json')).equals(authorityAfterFirst),
    true,
    '두 번째 재개 뒤 .coach-authority.json 바이트가 바뀌었다',
  );

  const calls3 = [];
  const loop3 = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: { port: 0, waitMs: 0, ...loopOpts, onCoachInvoke: (args) => calls3.push({ kind: 'coach', args }) },
  });
  t.after(() => loop3.requestStop().catch(() => {}));
  await assert.rejects(loop3.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
  assert.equal(coachInvocations(calls3, 'cleanup-result').length, 0, '세 번째 재개는 cleanup-result를 다시 호출하면 안 된다');
  assert.equal(coachInvocations(calls3, 'adapter-disable').length, 0, '세 번째 재개는 adapter-disable을 다시 호출하면 안 된다');
});

test('#192 S6: 이후 재개에서 identity가 죽어 해소되면 adapter가 이미 disabled여도 cleanup-result released를 기록한다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  let orphanAlive = true;
  t.after(() => { if (orphanAlive) terminateIfAlive(orphan); });
  await seedRunningCoach(gameDir, 'old-owner', 1, orphan);

  const loopOpts = {
    finalizeBudgetMs: 2_200,
    finalizeCutoffLeadMs: 1_100,
    processStartTime: (pid) => (pid === orphan.pid ? null : processStartTime(pid)),
    signalProcess: (pid, signal) => { if (pid !== orphan.pid) process.kill(pid, signal); },
  };

  const { loop: loop1, calls: calls1 } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper: makeCoachAdapter(),
    stateOverrides: { port: external.lock.port },
    loopOpts,
  });
  await assert.rejects(loop1.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
  assert.equal(coachInvocations(calls1, 'cleanup-result').length, 1);
  assert.equal(coachInvocations(calls1, 'adapter-disable').length, 1);
  await loop1.requestStop().catch(() => {});

  const authorityAfterFirst = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(authorityAfterFirst.adapterState, 'disabled', 'precondition: 첫 closure 뒤 adapter가 disabled여야 한다');
  assert.equal(
    authorityAfterFirst.retiredAttempts.find((row) => row.handNo === 1)?.cleanupState,
    'termination_unconfirmed',
    'precondition: hand 1이 termination_unconfirmed로 남아 있어야 한다',
  );

  // Kill the orphan for real: processAlive()가 이제 실제로 죽었다고 보게 되어, 여전히
  // 고장난 processStartTime override가 참조되기도 전에 persistedCoachIdentityState()가
  // 'dead'로 단락시킨다 — 이 다음 재개에서 행이 해소 가능해진다.
  await terminateIfAlive(orphan);
  orphanAlive = false;

  const calls2 = [];
  const loop2 = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: { port: 0, waitMs: 0, ...loopOpts, onCoachInvoke: (args) => calls2.push({ kind: 'coach', args }) },
  });
  t.after(() => loop2.requestStop().catch(() => {}));

  await loop2.resume().catch(() => {});

  const cleanupCalls = coachInvocations(calls2, 'cleanup-result');
  assert.equal(cleanupCalls.length, 1, '해소된 행은 cleanup-result를 한 번 기록해야 한다');
  assert.equal(flagValue(cleanupCalls[0], '--cleanup-state'), 'released');
  assert.equal(flagValue(cleanupCalls[0], '--evidence'), 'IDENTITY_DEAD');
  assert.equal(
    coachInvocations(calls2, 'adapter-disable').length,
    0,
    '더 이상 unresolved 행이 없으므로 adapter-disable을 다시 호출하면 안 된다',
  );

  const authorityAfterSecond = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(
    authorityAfterSecond.retiredAttempts.find((row) => row.handNo === 1)?.cleanupState,
    'released',
  );
});

test('#192 S6: 판정 대상 행이 늘어도 owner-runtime-closure 영수증은 closure당 한 번만 읽는다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const countLoopStateReadsDuringResume = async (handCount) => {
    const gameDir = tmpGame();
    const init = await seedFinishedGame(gameDir);
    if (handCount > 1) expandFinishedGameToTwoHands(gameDir);
    const external = await startExternalServer(gameDir, init.sessionToken);
    t.after(() => terminateIfAlive(external.child));
    for (let handNo = 1; handNo <= handCount; handNo += 1) {
      // Legacy no-stamp reservations: no handle, no sidecar, no identity to resolve — each
      // falls straight through to the single "neither a nor b" consultCoachCloseEvidence
      // call inside terminatePersistedCoachAttempt, with no polling delay.
      await seedReservedCoach(gameDir, 'old-owner', handNo);
    }
    const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
      upper: makeCoachAdapter(),
      stateOverrides: { port: external.lock.port },
      // #192 O1/L1: this test's own purpose is the receipt read-count invariant, not the
      // scanner — force it unavailable (deterministic, no live lsof call) so every row
      // stays unresolved exactly as before L1.
      loopOpts: { scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'test-fixture' }) },
    });
    const loopStatePath = path.join(gameDir, 'loop-state.json');
    let reads = 0;
    const originalReadFile = fs.readFileSync;
    fs.readFileSync = function countingReadFileSync(filePath, ...args) {
      if (path.resolve(String(filePath)) === loopStatePath) reads += 1;
      return originalReadFile.call(this, filePath, ...args);
    };
    try {
      await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
    } finally {
      fs.readFileSync = originalReadFile;
    }
    return reads;
  };

  const oneRowReads = await countLoopStateReadsDuringResume(1);
  const twoRowReads = await countLoopStateReadsDuringResume(2);
  assert.equal(
    twoRowReads,
    oneRowReads,
    `loop-state.json 읽기 횟수가 행 수에 비례해 늘었다 (1행 ${oneRowReads}회, 2행 ${twoRowReads}회) — `
      + '영수증을 closure당 한 번이 아니라 행마다 다시 읽고 있다',
  );
});

test('#192 S6: recovery 메시지가 sidecar intent 행과 증거 없는 legacy 행을 구분한다', { timeout: 20_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDirLegacy = tmpGame();
  const initLegacy = await seedFinishedGame(gameDirLegacy);
  const externalLegacy = await startExternalServer(gameDirLegacy, initLegacy.sessionToken);
  t.after(() => terminateIfAlive(externalLegacy.child));
  await seedReservedCoach(gameDirLegacy, 'old-owner', 1);
  const { loop: legacyLoop } = finalizingLoop(t, gameDirLegacy, initLegacy.sessionToken, {
    upper: makeCoachAdapter(),
    stateOverrides: { port: externalLegacy.lock.port },
    // #192 O1/L1: this test's own purpose is message differentiation between the
    // sidecar-intent case and the genuinely evidence-free legacy case, not the scanner —
    // force it unavailable so the legacy row stays unresolved as before L1 (its own
    // LEGACY_SCAN_UNAVAILABLE guidance also mentions "legacy", matching the assertion below).
    loopOpts: { scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'test-fixture' }) },
  });
  await assert.rejects(legacyLoop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
  const legacyMessage = readJson(path.join(gameDirLegacy, 'loop-state.json')).halt?.message;
  assert.ok(legacyMessage, 'legacy 시나리오에 halt.message가 없다');

  const gameDirIntent = tmpGame();
  const initIntent = await seedFinishedGame(gameDirIntent);
  const externalIntent = await startExternalServer(gameDirIntent, initIntent.sessionToken);
  t.after(() => terminateIfAlive(externalIntent.child));
  const reserved = await seedReservedCoachStamped(gameDirIntent, 'old-owner', 1);
  writeCoachSpawnSidecar(gameDirIntent, initIntent.sessionToken, 'old-owner', reserved, { phase: 'intent' });
  const { loop: intentLoop } = finalizingLoop(t, gameDirIntent, initIntent.sessionToken, {
    upper: makeCoachAdapter(),
    stateOverrides: { port: externalIntent.lock.port },
  });
  await assert.rejects(intentLoop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');
  const intentMessage = readJson(path.join(gameDirIntent, 'loop-state.json')).halt?.message;
  assert.ok(intentMessage, 'intent 시나리오에 halt.message가 없다');

  assert.notEqual(legacyMessage, intentMessage, '두 시나리오의 recovery 메시지가 동일하다');
  assert.match(intentMessage, /coach CLI 자식/, 'intent-only 메시지에 자식 프로세스 확인 안내가 없다');
  assert.match(legacyMessage, /legacy/, 'no-evidence 메시지에 legacy 안내가 없다');
});

test('#192 O5: 카테고리별 unresolvedEvidenceGuidance — legacy는 hasHandle/spawnEvidence/sidecar가 모두 증거 없음일 때만', () => {
  // 진짜 legacy 무증거 행: handle 없음, spawnEvidence 없음, sidecar 자체가 absent.
  assert.match(
    unresolvedEvidenceGuidance([{
      handNo: 1, generation: 1, reason: 'IDENTITY_UNAVAILABLE',
      evidence: { hasHandle: false, spawnEvidence: false, sidecar: 'absent', attributable: true },
    }]),
    /legacy/,
    'legacy 무증거 행에 legacy 안내가 없다',
  );
});

test('#192 O5: NOT_ATTRIBUTABLE 행은 legacy가 아니라 경로 확인 불가 문구를 받는다', () => {
  const guidance = unresolvedEvidenceGuidance([{
    handNo: 1, generation: 1, reason: 'NOT_ATTRIBUTABLE',
    evidence: { hasHandle: false, spawnEvidence: true, sidecar: 'absent', attributable: false },
  }]);
  assert.ok(guidance, 'NOT_ATTRIBUTABLE 행에 안내 문구가 없다');
  assert.doesNotMatch(guidance, /legacy/, 'NOT_ATTRIBUTABLE 행이 legacy로 잘못 표시됐다');
  assert.match(guidance, /디렉터리|경로/, 'NOT_ATTRIBUTABLE 행에 경로 확인 불가 안내가 없다');
});

test('#192 O5: authority/epoch/owner/deadline/adapter-disable 실패는 evidence guidance를 받지 않는다', () => {
  for (const reason of [
    'STALE_GAME_EPOCH', 'COACH_EPOCH_UNVERIFIABLE', 'NO_COACH_OWNER',
    'RESUME_RECLAIM_DEADLINE_EXCEEDED', 'ADAPTER_DISABLE_CHILD_FAILED', 'AUTHORITY_MISSING',
  ]) {
    // These rows never carry an `evidence` field at all (they are synthetic
    // authority-level failures, not coach-row evidence classifications) — the previous
    // code treated "no evidence field" the same as "legacy row", which is exactly the
    // mislabel #192 O5 fixes.
    const guidance = unresolvedEvidenceGuidance([{ handNo: null, generation: null, reason }]);
    assert.equal(guidance, null, `${reason}가 legacy/다른 evidence guidance로 잘못 표시됐다 (${guidance})`);
  }
});

test('#192 O5: NOT_ATTRIBUTABLE 행이 legacy 조건도 함께 만족해도 경로 확인 불가 문구가 우선한다', () => {
  const guidance = unresolvedEvidenceGuidance([{
    handNo: 1, generation: 1, reason: 'NOT_ATTRIBUTABLE',
    evidence: { hasHandle: false, spawnEvidence: false, sidecar: 'absent', attributable: false },
  }]);
  assert.doesNotMatch(guidance, /legacy/, '경로 확인 불가 행이 legacy로 잘못 표시됐다');
  assert.match(guidance, /디렉터리|경로/);
});

// ── #192 L1: legacy 행 자동 복구 (design memo §10, appendix v3.2) ──────────────

test('#192 L1: parseLsofCwdRecords — clean 출력, candidate, p 단독, 빈 출력', () => {
  // 실측(2026-09-14, macOS lsof): `-Fpn`으로 요청해도 lsof는 각 p마다 식별 field인
  // `f<fd>`를 항상 끼워 넣는다 — 실제 출력은 (p, f, n) 삼중항이 반복되는 구조다.
  const clean = 'p111\nfcwd\nn/Users/tester/project\np222\nfcwd\nn/tmp/other-dir\n';
  assert.deepEqual(parseLsofCwdRecords(clean), [
    { pid: 111, cwd: '/Users/tester/project' },
    { pid: 222, cwd: '/tmp/other-dir' },
  ]);

  const withCandidate = 'p333\nfcwd\nn/private/var/folders/xy/abc/T/ai-holdem-codex-AbC123\n';
  assert.deepEqual(parseLsofCwdRecords(withCandidate), [
    { pid: 333, cwd: '/private/var/folders/xy/abc/T/ai-holdem-codex-AbC123' },
  ]);
  assert.deepEqual(legacyCoachRuntimeCandidates(parseLsofCwdRecords(withCandidate)), [
    { pid: 333, cwd: '/private/var/folders/xy/abc/T/ai-holdem-codex-AbC123' },
  ]);

  assert.equal(parseLsofCwdRecords('p444\n'), null, 'p 레코드만 있고 f/n이 없으면 null(조회 불가)이어야 한다');
  assert.equal(
    parseLsofCwdRecords('p444\nfcwd\n'),
    null,
    'p·f만 있고 n이 없으면 null(조회 불가)이어야 한다',
  );

  assert.deepEqual(parseLsofCwdRecords(''), [], '빈 출력은 빈 배열이어야 한다');
});

test('#192 L1: legacyCoachRuntimeCandidates — ai-holdem- 경로 구성요소만, 자기 pid는 제외', () => {
  const records = [
    { pid: 10, cwd: '/tmp/ai-holdem-claude-XYZ' },
    { pid: 11, cwd: '/tmp/notai-holdem-fake' },
    { pid: 12, cwd: '/tmp/ai-holdem-codex-ABC/nested' },
    { pid: 13, cwd: '/tmp/ai-holdem-grok-QRS' },
  ];
  assert.deepEqual(
    legacyCoachRuntimeCandidates(records, { excludePid: 13 }).map((c) => c.pid).sort(),
    [10, 12],
  );
});

// #192 CI: these two pure fake-exec tests pin `platform` to a POSIX value so they also run
// on the Windows CI shard, where `process.platform` short-circuits before the fake is used.
test('#192 L1: 스캐너는 자기 pid가 없는 결과나 exit 1 빈 출력을 clean이 아니라 unavailable로 본다', async () => {
  const fakeExec = (outcome) => (file, args, options, callback) => {
    setImmediate(() => callback(outcome.error ?? null, outcome.stdout ?? '', outcome.stderr ?? ''));
    return { pid: 1 };
  };
  const exit1 = Object.assign(new Error('lsof exit 1'), { code: 1 });
  const base = { lsofPath: '/usr/sbin/lsof', excludePid: 500, selfPid: 500, platform: 'darwin', uid: 501 };

  const emptyExit1 = await scanCoachRuntimeProcesses({ ...base, execFileFn: fakeExec({ error: exit1, stdout: '' }) });
  assert.deepEqual(emptyExit1, { status: 'unavailable', reason: 'LSOF_NO_OUTPUT' });

  const emptyExit0 = await scanCoachRuntimeProcesses({ ...base, execFileFn: fakeExec({ stdout: '' }) });
  assert.deepEqual(emptyExit0, { status: 'unavailable', reason: 'LSOF_NO_OUTPUT' });

  const withoutSelf = await scanCoachRuntimeProcesses({
    ...base,
    execFileFn: fakeExec({ stdout: 'p600\nfcwd\nn/Users/someone\n' }),
  });
  assert.deepEqual(withoutSelf, { status: 'unavailable', reason: 'SELF_NOT_OBSERVED' });

  const selfOnly = await scanCoachRuntimeProcesses({
    ...base,
    execFileFn: fakeExec({ stdout: 'p500\nfcwd\nn/Users/someone/repo\n' }),
  });
  assert.deepEqual(selfOnly, { status: 'clean' });

  // #192 J2: exit 1 must never be trusted even when its output parses cleanly and even when
  // it contains what looks like a candidate — only a clean exit (status 0) listing is ever
  // trusted for "no coach runtime process here".
  const exit1WithCandidate = await scanCoachRuntimeProcesses({
    ...base,
    execFileFn: fakeExec({
      error: exit1,
      stdout: 'p500\nfcwd\nn/Users/someone/repo\np700\nfcwd\nn/private/var/folders/x/T/ai-holdem-codex-AbC123\n',
    }),
  });
  assert.deepEqual(exit1WithCandidate, { status: 'unavailable', reason: 'LSOF_FAILED' });

  const killed = await scanCoachRuntimeProcesses({
    ...base,
    execFileFn: fakeExec({ error: Object.assign(new Error('timeout'), { killed: true, signal: 'SIGKILL' }), stdout: 'p500\nfcwd\nn/x\n' }),
  });
  assert.deepEqual(killed, { status: 'unavailable', reason: 'LSOF_TIMEOUT' });
});

test('#192 CI: uid를 구할 수 없으면 조회하지 않고 UID_UNAVAILABLE로 답한다', async () => {
  let called = 0;
  const scan = await scanCoachRuntimeProcesses({
    lsofPath: '/usr/sbin/lsof',
    platform: 'darwin',
    uid: null,
    execFileFn: () => { called += 1; return { pid: 1 }; },
  });
  assert.deepEqual(scan, { status: 'unavailable', reason: 'UID_UNAVAILABLE' });
  assert.equal(called, 0, 'uid 없이 lsof를 실행했다');
});

test('#192 CI: 스캐너는 win32에서 조회를 시도하지 않고 WIN32_UNSUPPORTED로 답한다', async () => {
  let called = 0;
  const scan = await scanCoachRuntimeProcesses({
    lsofPath: '/usr/sbin/lsof',
    platform: 'win32',
    execFileFn: () => { called += 1; return { pid: 1 }; },
  });
  assert.deepEqual(scan, { status: 'unavailable', reason: 'WIN32_UNSUPPORTED' });
  assert.equal(called, 0, 'win32에서 lsof를 실행했다');
});

test('#192 J2: 스캐너는 완전한 절대 경로 cwd만 신뢰한다 — readlink 주석, 빈 이름, 상대 경로, deleted 접미사', async () => {
  const fakeExec = (outcome) => (file, args, options, callback) => {
    setImmediate(() => callback(outcome.error ?? null, outcome.stdout ?? '', outcome.stderr ?? ''));
    return { pid: 1 };
  };
  const base = { lsofPath: '/usr/sbin/lsof', excludePid: 500, selfPid: 500, platform: 'darwin', uid: 501 };
  const selfRecord = 'p500\nfcwd\nn/Users/someone/repo\n';

  // Linux에서 같은 uid의 cwd를 읽을 수 없으면 `n/proc/<pid>/cwd (readlink: Permission denied)`
  // 형태가 나온다 — 이 record에는 `ai-holdem-`가 없어 전에는 그냥 무시됐지만, cwd를 검증할 수
  // 없다는 뜻이므로 전체 스캔이 unavailable이어야 한다(절대 "매칭 없음"으로 읽으면 안 된다).
  const readlinkAnnotation = await scanCoachRuntimeProcesses({
    ...base,
    execFileFn: fakeExec({ stdout: `${selfRecord}p800\nfcwd\nn/proc/800/cwd (readlink: Permission denied)\n` }),
  });
  assert.deepEqual(readlinkAnnotation, { status: 'unavailable', reason: 'CWD_UNVERIFIABLE' });

  // pCHILD/fcwd/n에 빈 이름 — 매칭되는 ai-holdem- 컴포넌트가 없다고 clean으로 읽으면 안 된다.
  const emptyName = await scanCoachRuntimeProcesses({
    ...base,
    execFileFn: fakeExec({ stdout: `${selfRecord}p900\nfcwd\nn\n` }),
  });
  assert.deepEqual(emptyName, { status: 'unavailable', reason: 'CWD_UNVERIFIABLE' });

  const relativeName = await scanCoachRuntimeProcesses({
    ...base,
    execFileFn: fakeExec({ stdout: `${selfRecord}p901\nfcwd\nnrelative/path\n` }),
  });
  assert.deepEqual(relativeName, { status: 'unavailable', reason: 'CWD_UNVERIFIABLE' });

  // 삭제된 ai-holdem- cwd는 " (deleted)" 접미사가 매칭 전에 벗겨져야 candidate로 남는다.
  const deletedAiHoldemCwd = await scanCoachRuntimeProcesses({
    ...base,
    execFileFn: fakeExec({
      stdout: `${selfRecord}p1000\nfcwd\nn/private/var/folders/x/T/ai-holdem-codex-AbC123 (deleted)\n`,
    }),
  });
  assert.equal(deletedAiHoldemCwd.status, 'candidates');
  assert.deepEqual(deletedAiHoldemCwd.candidates, [
    { pid: 1000, cwd: '/private/var/folders/x/T/ai-holdem-codex-AbC123' },
  ]);
});

test('#192 L1: 기본 스캐너가 ai-holdem- cwd의 실제 프로세스를 candidate로, 종료 후에는 clean으로 본다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  if (skipOnWin32(t, 'lsof 기반 스캐너는 POSIX 전용이다')) return;
  if (!REAL_LSOF) { t.skip('이 머신에 lsof가 없다'); return; }
  // #192 CI: some Linux images ship an lsof that exits non-zero (warnings about unreadable
  // mounts), and the scanner deliberately trusts a clean exit only. There the scan can never
  // report candidates, so this test has nothing to assert — skip it with the observed reason
  // instead of failing, and keep the scanner's fail-closed rule unchanged.
  const probe = await scanCoachRuntimeProcesses({ lsofPath: REAL_LSOF, timeoutMs: 5_000 });
  if (probe.status === 'unavailable') { t.skip(`이 머신의 lsof는 신뢰할 수 없다: ${probe.reason}`); return; }
  const tagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-holdem-codex-'));
  t.after(() => { try { fs.rmSync(tagDir, { recursive: true, force: true }); } catch { /* gone */ } });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    cwd: tagDir,
    stdio: 'ignore',
  });
  // If an assertion below fails before the explicit terminate, the tagged child must not
  // outlive the test: a leftover ai-holdem-* cwd process would make later real scans report
  // candidates on this machine.
  t.after(() => terminateIfAlive(child));
  let lastScan = null;
  try {
    await waitFor(
      async () => {
        lastScan = await scanCoachRuntimeProcesses({ lsofPath: REAL_LSOF, timeoutMs: 5_000 });
        return lastScan.status === 'candidates' && lastScan.candidates.some((c) => c.pid === child.pid);
      },
      `실제 lsof 스캔이 pid ${child.pid}를 candidate로 보지 않았다`,
      8_000,
    );
  } catch (error) {
    error.message = `${error.message} (마지막 스캔: ${JSON.stringify(lastScan)})`;
    throw error;
  }
  await terminateIfAlive(child);
  await waitFor(
    async () => {
      const scan = await scanCoachRuntimeProcesses({ lsofPath: REAL_LSOF, timeoutMs: 5_000 });
      return scan.status === 'clean'
        || (scan.status === 'candidates' && !scan.candidates.some((c) => c.pid === child.pid));
    },
    `프로세스 종료 뒤에도 pid ${child.pid}가 candidate로 남아 있다`,
    8_000,
  );
});

test('#192 L1: 스캐너가 clean이면 evidence 없는 legacy 행이 자동 복구되고 resume이 done까지 진행한다', { timeout: 30_000 * WIN32_SCALE, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);

  const upper = makeCoachAdapter();
  let scanCalls = 0;
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      scanCoachRuntimeProcesses: () => { scanCalls += 1; return Promise.resolve({ status: 'clean' }); },
    },
  });

  const resumed = await loop.resume();
  const completed = await loop.run();
  assert.equal(completed.phase, 'done', `clean 스캔인데 done에 도달하지 못했다 (halt ${JSON.stringify(resumed.halt ?? completed.halt)})`);
  // resume()의 finalize 진입과 run()의 postCutoff 재확인은 서로 다른
  // closePersistedCoachWorkersCore 호출(closure)일 수 있지만, 두 번째 closure가 실제로
  // 도는지는 남은 finalize 예산(실시간)에 달려 있어 정확한 총 호출 횟수는 결정적이지
  // 않다 — 최소 한 번은 불렸는지만 확인한다. "행마다 여러 번"이라는 회귀는 이 hand
  // 1개짜리 fixture로는 구분되지 않으므로 별도로 다루지 않는다.
  assert.ok(scanCalls >= 1, '스캐너가 한 번도 호출되지 않았다');

  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts.find((entry) => (
    entry.handNo === 1 && entry.generation === reserved.generation
  ));
  assert.equal(row?.cleanupState, 'released');
  // Finalize's own post-game coach review legitimately reserves a *new* generation for
  // hand 1 and cleans that up too — filter down to this legacy row's own generation.
  const cleanupCalls = coachInvocations(calls, 'cleanup-result').filter((args) => (
    flagValue(args, '--hand') === '1' && flagValue(args, '--generation') === String(reserved.generation)
  ));
  assert.equal(cleanupCalls.length, 1);
  assert.equal(flagValue(cleanupCalls[0], '--cleanup-state'), 'released');
  assert.equal(flagValue(cleanupCalls[0], '--evidence'), 'LEGACY_NO_RUNTIME_PROCESS');
});

test('#192 L1: 스캐너가 clean이어도 foreign legacy 행은 released 판정만 되고 온디스크에는 쓰이지 않은 채 resume이 진행된다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.hands[String(reserved.handNo)].deadlineMono = '0';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  await runCoachCli(gameDir, ['heartbeat', '--owner', 'old-owner']);
  await seedEmptyCoachAuthority(gameDir, 'intermediate-owner');

  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: { scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'clean' }) },
  });

  const resumed = await loop.resume();
  const completed = await loop.run();
  assert.equal(completed.phase, 'done', `foreign 행이 clean 스캔에도 resume을 막았다 (halt ${JSON.stringify(resumed.halt ?? completed.halt)})`);
  // Finalize's own post-game coach review legitimately reserves a *new* generation for
  // hand 1 and cleans that up at the end — filter down to the original foreign row's own
  // generation so that unrelated, correctly-authorized cleanup is not mistaken for it.
  const cleanupCalls = coachInvocations(calls, 'cleanup-result').filter((args) => (
    flagValue(args, '--hand') === '1' && flagValue(args, '--generation') === String(reserved.generation)
  ));
  assert.equal(cleanupCalls.length, 0, '권한 없는 foreign 행에 cleanup-result를 써서는 안 된다');
  const row = readJson(authorityPath).retiredAttempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'pending', 'foreign 행의 온디스크 cleanupState가 released로 잘못 쓰였다');
});

test('#192 L1: 스캐너가 candidates면 pid를 담아 unresolved로 halt하고 안내 문구에 pid가 나타난다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      scanCoachRuntimeProcesses: () => Promise.resolve({
        status: 'candidates', candidates: [{ pid: 999_999, cwd: '/tmp/ai-holdem-codex-ZZZ' }],
      }),
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.halt.recovery.code, 'COACH_HANDLE_UNRESOLVED');
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.ok(row, 'recovery attempts에 hand 1이 없다');
  assert.equal(row.reason, 'LEGACY_RUNTIME_PROCESS_PRESENT');
  assert.deepEqual(row.evidence.legacyScanPids, [999_999]);
  assert.match(state.halt.message, /999999/, 'halt 메시지에 candidate pid가 나타나지 않는다');
});

test('#192 J3: finalizingLoop 같은 공용 헬퍼는 loopOpts가 없어도 실제 lsof 대신 결정적 TEST_DEFAULT 스캐너를 쓴다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  // loopOpts에 scanCoachRuntimeProcesses를 전혀 지정하지 않는다 — 헬퍼 자신의 기본값만
  // 써야 한다. 헬퍼가 실제 lsof로 fall back하면 이 결과는 이 머신에서 지금 돌고 있는
  // 프로세스에 좌우된다(이 파일의 실제 lsof 테스트 자체의 태그된 자식, 다른 테스트
  // 파일, 실제 게임 등).
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'LEGACY_SCAN_UNAVAILABLE', `헬퍼 기본값이 결정적이지 않다 (${JSON.stringify(row)})`);
  assert.equal(
    row?.evidence?.legacyScanDetail,
    'TEST_DEFAULT',
    '헬퍼가 실제 lsof 스캐너를 호출했다 — 머신의 프로세스 테이블에 의존한다',
  );
});

test('#192 L1: 스캐너가 unavailable이면 LEGACY_SCAN_UNAVAILABLE로 halt하고 조회 불가 안내를 남긴다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'LSOF_MISSING' }),
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row.reason, 'LEGACY_SCAN_UNAVAILABLE');
  assert.match(state.halt.message, /확인할 수 없습니다/, 'unavailable halt 메시지가 조회 불가 안내를 담지 않았다');
});

test('#192 L1: 살아있는 orphan handle이 있는 legacy 행은 스캐너를 부르지 않고 judgment a로 해소된다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const orphan = await startCoachOrphan();
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, 'old-owner', 1, orphan);
  let scanCalls = 0;
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper: makeCoachAdapter(),
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      scanCoachRuntimeProcesses: () => { scanCalls += 1; return Promise.resolve({ status: 'clean' }); },
    },
  });

  const resumed = await loop.resume();
  const completed = await loop.run();
  assert.equal(completed.phase, 'done', `orphan handle이 있는 행이 released되지 못했다 (halt ${JSON.stringify(resumed.halt ?? completed.halt)})`);
  assert.equal(scanCalls, 0, '살아있는 identity가 있는 행(judgment a)은 스캐너를 호출하면 안 된다');
});

test('#192 sJ3: 스캔이 clean으로 해소되기 전에 loop lock identity가 바뀌면 legacy 행을 release하지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      // #192 sJ3: replace the loop lock directory this instance's in-memory `lockHandle`
      // still points at with a brand-new, empty directory (the same identity loss #192 I5
      // already covers for `requestStop`) while the scan is still "in flight" from the
      // classifier's point of view, then resolve clean — exactly the race a scan that takes
      // real wall-clock time (a real lsof exec) could lose to a lock reclaimed by another
      // instance mid-scan.
      scanCoachRuntimeProcesses: () => new Promise((resolve) => {
        setImmediate(() => {
          const lockDir = path.join(gameDir, 'loop.lock.d');
          fs.rmSync(lockDir, { recursive: true, force: true });
          fs.mkdirSync(lockDir);
          resolve({ status: 'clean' });
        });
      }),
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'LEGACY_SCAN_UNAVAILABLE', 'lock을 잃은 clean 스캔으로 legacy 행이 released됐다');
  assert.equal(row?.evidence?.legacyScanDetail, 'LOCK_LOST_DURING_SCAN');
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const authRow = authority.retiredAttempts.find((entry) => (
    entry.handNo === 1 && entry.generation === reserved.generation
  ));
  assert.notEqual(authRow?.cleanupState, 'released', '락을 잃은 스캔 결과로 온디스크 행이 released로 쓰였다');
});

test('#192 J4: playing resume의 legacy 스캔이 identity deadline 안에 해소되지 않으면 RESUME_RECLAIM_DEADLINE_EXCEEDED 대신 LEGACY_SCAN_UNAVAILABLE로 halt한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  await first.bootstrap({ ai: 1, stack: 100 });
  // #192 S4 fixture 관례와 동일하게, 이 인스턴스가 발급·stop한 적 없는 owner 아래 예약을
  // 심어 coachRuntimeClosures 영수증(c)이 전혀 없는 순수 legacy 행으로 만든다.
  const neverIssuedOwner = 'owner-never-issued-or-stopped';
  await seedReservedCoach(gameDir, neverIssuedOwner, 1);
  await first.requestStop();

  const player = makeAdapter();
  const upper = makeCoachAdapter();
  // playing resume의 reclaim 예산(orphanTerminateGraceMs + orphanTerminateKillWaitMs +
  // resumeReclaimResidualMs)을 아주 작게 줘서 identity deadline과 closure deadline이
  // 거의 동시에, 아주 빨리 지나가게 만든다. 스캐너는 절대 해소되지 않는 promise를
  // 반환한다 — 고정된 실측 lsof 지연 대신, "스캔이 identity deadline을 넘겨서까지
  // 끝나지 않는" 최악의 경우를 결정적으로 재현한다.
  const resumed = createGameLoop({
    gameDir,
    resolver: resolverForCoach(player, upper),
    opts: {
      port: 0,
      waitMs: 0,
      // grace+killWait sets how soon identityDeadlineNs falls (~10ms) so the never-resolving
      // scan reliably crosses it; the large residual leaves the *closure*'s own deadline far
      // enough out that the real child-process calls after the scan (adapter-disable, fence)
      // have room to finish, so it is specifically the scan bound (J4) being exercised here —
      // not the pre-existing closure deadline racing a subprocess spawn.
      orphanTerminateGraceMs: 5 * WIN32_SCALE,
      orphanTerminateKillWaitMs: 5 * WIN32_SCALE,
      resumeReclaimResidualMs: 8_000 * WIN32_SCALE,
      scanCoachRuntimeProcesses: () => new Promise(() => {}),
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));

  await assert.rejects(resumed.resume(), (error) => error.code === 'COACH_HANDLE_UNRESOLVED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(
    row?.reason,
    'LEGACY_SCAN_UNAVAILABLE',
    `deadline 소진이 scan evidence 대신 다른 halt 사유를 냈다 (${JSON.stringify(row)})`,
  );
  assert.equal(row?.evidence?.legacyScanDetail, 'SCAN_DEADLINE');
});

test('#192 L1: persistedCoachRecovery는 foreign 미해소 행에 --row-owner/--operator-confirmed 명령을 만든다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.hands[String(reserved.handNo)].deadlineMono = '0';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  await runCoachCli(gameDir, ['heartbeat', '--owner', 'old-owner']);
  await seedEmptyCoachAuthority(gameDir, 'intermediate-owner');

  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'LSOF_MISSING' }),
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const command = state.halt.recovery.commands.find((cmd) => cmd.args.includes('--row-owner'));
  assert.ok(command, 'foreign 미해소 행에 --row-owner 명령이 없다');
  assert.equal(flagValue(command.args, '--row-owner'), 'old-owner');
  // #192 J5: 발급되는 명령은 --operator-confirmed 1을 미리 채우면 안 된다 — 운영자가
  // 이 게임의 coach CLI 자식 부재를 직접 확인한 뒤 그 값을 덧붙여야 한다.
  assert.equal(flagValue(command.args, '--operator-confirmed'), null, '명령이 --operator-confirmed 1을 미리 채웠다');
  assert.equal(command.requiresOperatorConfirmation, true);
  assert.equal(flagValue(command.args, '--owner'), 'intermediate-owner');
  assert.match(state.halt.message, /coach CLI/, '운영자 확인 안내가 halt 메시지에 없다');
});

test('#192 J5: LEGACY_RUNTIME_PROCESS_PRESENT foreign 행에는 --row-owner 복구 명령을 만들지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoach(gameDir, 'old-owner', 1);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.hands[String(reserved.handNo)].deadlineMono = '0';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  await runCoachCli(gameDir, ['heartbeat', '--owner', 'old-owner']);
  await seedEmptyCoachAuthority(gameDir, 'intermediate-owner');

  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      scanCoachRuntimeProcesses: () => Promise.resolve({
        status: 'candidates', candidates: [{ pid: 999_997, cwd: '/tmp/ai-holdem-claude-YYY' }],
      }),
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'LEGACY_RUNTIME_PROCESS_PRESENT', `precondition 불일치: ${JSON.stringify(row)}`);
  const command = state.halt.recovery.commands.find((cmd) => cmd.args.includes('--row-owner'));
  assert.equal(command, undefined, 'LEGACY_RUNTIME_PROCESS_PRESENT foreign 행에 --row-owner 명령이 생겼다');
});

test('#192 L2: bootstrap 실패 뒤 정리 stop이 LOOP_LOCK_LOST여도 원래 bootstrap 오류로 거부된다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async () => {
      const lockDir = path.join(gameDir, 'loop.lock.d');
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
      throw Object.assign(new Error('resolver failed after the lock was replaced'), { code: 'RESOLVER_BOOM_192' });
    },
    opts: { port: 0, waitMs: 0, log: (record) => logs.push(record) },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await assert.rejects(loop.bootstrap({ ai: 1 }), (error) => error.code === 'RESOLVER_BOOM_192');
  assert.ok(logs.some((row) => row.event === 'bootstrap-cleanup-lock-lost'), 'bootstrap-cleanup-lock-lost 로그가 없다');
  assert.equal('cause' in logs.find((row) => row.event === 'bootstrap-cleanup-lock-lost'), false);
});

test('#192 K1: 권한 있는 active 행이라도 LEGACY_RUNTIME_PROCESS_PRESENT면 복구 명령을 하나도 만들지 않는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      scanCoachRuntimeProcesses: () => Promise.resolve({
        status: 'candidates', candidates: [{ pid: 999_996, cwd: '/tmp/ai-holdem-codex-K1' }],
      }),
    },
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'FINALIZATION_ABORTED');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'LEGACY_RUNTIME_PROCESS_PRESENT', `precondition 불일치: ${JSON.stringify(row)}`);
  assert.equal(row?.cleanupAuthorized, true, `precondition 불일치(권한 있는 행이어야 한다): ${JSON.stringify(row)}`);
  assert.deepEqual(state.halt.recovery.commands, [], '코치 런타임 프로세스가 남은 행에 released 복구 명령이 생겼다');
  assert.equal(state.halt.recovery.requiresOperatorConfirmation, undefined);
});

test('#192 K2: 락을 잃은 뒤 loop-state 파일이 사라져도 requestStop은 LOOP_LOCK_LOST로 거부되고 파일을 다시 만들지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0, log: (record) => logs.push(record) },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1 });
  const loopStatePath = path.join(gameDir, 'loop-state.json');
  assert.ok(fs.existsSync(loopStatePath), 'precondition: bootstrap이 loop-state를 만들지 않았다');

  const lockDir = path.join(gameDir, 'loop.lock.d');
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir);
  fs.rmSync(loopStatePath, { force: true });

  let caught = null;
  try {
    await loop.requestStop();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'loop-state가 없다는 이유로 lock을 잃은 stop이 성공했다');
  assert.equal(caught.code, 'LOOP_LOCK_LOST');
  assert.equal(fs.existsSync(loopStatePath), false, 'lock을 잃은 stop이 loop-state를 다시 만들었다');
  assert.ok(logs.some((row) => row.event === 'loop-lock-lost-on-stop'), 'loop-lock-lost-on-stop 로그가 없다');

  // 재시도도 sticky하게 거부된다.
  await assert.rejects(loop.requestStop(), (error) => error.code === 'LOOP_LOCK_LOST');
});

test('#192 K3: consultCoachCloseEvidence는 설계 순서 c → closed-confirmed → f로 reason을 고른다', () => {
  const attempt = { ownerSessionId: 'owner-k3', acceptEvidence: 'closed-child' };
  const closedSidecar = { phase: 'closed-confirmed' };
  const receipts = [{ ownerSessionId: 'owner-k3', confirmedAt: '2026-09-14T00:00:00.000Z' }];

  assert.deepEqual(consultCoachCloseEvidence(attempt, receipts, closedSidecar), { reason: 'OWNER_RUNTIME_CLOSED' });
  assert.deepEqual(consultCoachCloseEvidence(attempt, [], closedSidecar), { reason: 'CLOSED_CONFIRMED' });
  assert.deepEqual(consultCoachCloseEvidence(attempt, [], { phase: 'identity' }), { reason: 'ACCEPT_EVIDENCE' });
  assert.deepEqual(consultCoachCloseEvidence(attempt, []), { reason: 'ACCEPT_EVIDENCE' });
  assert.equal(consultCoachCloseEvidence({ ownerSessionId: 'owner-k3' }, [{ ownerSessionId: 'other' }], { phase: 'intent' }), null);
});

test('#192 oK1: O_NOFOLLOW가 없는 플랫폼에서도 identity sidecar가 있으면 pipeline이 재실행돼도 spawn하지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  let gameDir;
  let sidecarPath;
  let seededPayload;
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '기본 코치 응답' }) }],
  });
  const setup = await setupCoachHand(t, {
    upper,
    loopOpts: {
      sidecarNoFollowFlag: undefined,
      coachSpawnCheckpoint: async ({ handNo, attempt }) => {
        if (seededPayload) return;
        const authority = readJson(path.join(gameDir, '.coach-authority.json'));
        const hand = authority.hands[String(handNo)];
        const state = readJson(path.join(gameDir, 'loop-state.json'));
        sidecarPath = coachSpawnSidecarPath(gameDir, hand.exactResultPath);
        seededPayload = {
          phase: 'identity',
          gameEpoch: state.gameEpoch,
          owner: state.ownerSessionId,
          handNo,
          generation: hand.generation,
          attempt,
          pid: 999_998,
          startTime: 'sentinel-ok1-start',
        };
        fs.writeFileSync(sidecarPath, JSON.stringify(seededPayload));
      },
    },
  });
  gameDir = setup.gameDir;
  const { loop } = setup;

  const running = startRun(loop);
  await waitFor(() => seededPayload !== undefined, 'coachSpawnCheckpoint never fired');
  await stopRun(loop, running);

  assert.equal(upper.starts.length, 0, 'O_NOFOLLOW 없는 플랫폼에서 이미 identity가 있는 attempt에 두 번째 spawn을 시도했다');
  assert.deepEqual(readJson(sidecarPath), seededPayload, 'O_NOFOLLOW 없는 플랫폼에서 기존 identity sidecar가 덮어써졌다');
});

test('#192 oK1: O_NOFOLLOW가 없는 플랫폼에서도 튜플이 맞는 closed-confirmed sidecar로 행을 닫는다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const reserved = await seedReservedCoachStamped(gameDir, 'old-owner', 1);
  writeCoachSpawnSidecar(gameDir, init.sessionToken, 'old-owner', reserved, { phase: 'closed-confirmed' });
  const upper = makeCoachAdapter();
  const { loop, calls } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: { sidecarNoFollowFlag: undefined },
  });

  const resumed = await loop.resume();

  assert.equal(resumed.halt, undefined, `resume이 halt됐다: ${JSON.stringify(resumed.halt)}`);
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  const row = authority.retiredAttempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.cleanupState, 'released');
  assert205Evidence(coachInvocations(calls, 'cleanup-result'), 'CLOSED_CONFIRMED');
  assert205Trace(gameDir, 'CLOSED_CONFIRMED');
});

test('#192 oK2: stop 중 loop lock 검증이 EACCES로 던져도 정리를 계속하고 loop-state를 쓰지 않는다', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  if (skipOnWin32(t, 'directory permission bits do not deny reads on win32')) return;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores directory permission bits');
    return;
  }
  const gameDir = tmpGame();
  const adapter = makeAdapter();
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0, log: (record) => logs.push(record) },
  });
  const lockDir = path.join(gameDir, 'loop.lock.d');
  t.after(() => {
    try { fs.chmodSync(lockDir, 0o755); } catch { /* already gone */ }
    return loop.requestStop().catch(() => {});
  });
  await loop.bootstrap({ ai: 1 });
  const loopStatePath = path.join(gameDir, 'loop-state.json');
  const beforeRaw = fs.readFileSync(loopStatePath, 'utf8');

  fs.chmodSync(lockDir, 0o000);
  let caught = null;
  try {
    await loop.requestStop();
  } catch (error) {
    caught = error;
  } finally {
    fs.chmodSync(lockDir, 0o755);
  }

  assert.ok(caught, 'lock 검증이 불가능한 stop이 성공으로 끝났다');
  // 검증 예외는 락 상실로 취급하되(기록 금지), 실패 자체는 그 원인 그대로 보고한다.
  assert.equal(caught.code, 'EACCES', `예상 밖 오류: ${caught.code}`);
  assert.ok(adapter.disposed >= 1, 'lock 검증 예외 때문에 adapter disposal을 건너뛰었다');
  assert.ok(logs.some((row) => row.event === 'loop-lock-verify-failed'), 'loop-lock-verify-failed 로그가 없다');
  assert.equal(fs.readFileSync(loopStatePath, 'utf8'), beforeRaw, '검증할 수 없는 lock으로 loop-state를 썼다');
});

test('#192 oK5: legacy 스캔 체인이 reject되면 일반 오류가 아니라 LEGACY_SCAN_UNAVAILABLE(SCAN_THREW)로 halt한다', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  await seedReservedCoach(gameDir, 'old-owner', 1);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, {
    upper,
    stateOverrides: { port: external.lock.port },
    loopOpts: {
      scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'clean' }),
      // The scan chain logs once the scanner settles; throwing there rejects the chain
      // after the scanner's own catch, the path judgment g must still classify.
      log: (record) => {
        if (record.event === 'coach-legacy-scan') throw new Error('log sink failed in scan chain');
      },
    },
  });

  let caught = null;
  try {
    await loop.resume();
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'FINALIZATION_ABORTED', `예상 밖 오류: ${caught?.code} ${caught?.message}`);
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const row = state.halt.recovery.attempts.find((entry) => entry.handNo === 1);
  assert.equal(row?.reason, 'LEGACY_SCAN_UNAVAILABLE');
  assert.equal(row?.evidence.legacyScanDetail, 'SCAN_THREW');
});

test('#192 oK1: readSidecarFileWithoutNoFollow는 lstat와 fstat의 inode가 같은 일반 파일만 읽는다', () => {
  const stat = ({ file = true, link = false, dev = 1n, ino = 7n, nlink = 1n, size = 10n } = {}) => ({
    isFile: () => file, isSymbolicLink: () => link, dev, ino, nlink, size,
  });
  const fakeFs = ({ lstat, fstat, openError = null, text = '{"phase":"intent"}' }) => {
    const closed = [];
    return {
      closed,
      lstatSync: () => { if (lstat instanceof Error) throw lstat; return lstat; },
      openSync: () => { if (openError) throw openError; return 42; },
      fstatSync: () => fstat,
      readFileSync: () => text,
      closeSync: (fd) => closed.push(fd),
    };
  };
  const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const read = (impl) => readSidecarFileWithoutNoFollow('/x/.spawn.json', { maxBytes: 64, fsImpl: impl });

  const same = fakeFs({ lstat: stat(), fstat: stat() });
  assert.deepEqual(read(same), { status: 'ok', text: '{"phase":"intent"}' });
  assert.deepEqual(same.closed, [42]);
  assert.deepEqual(read(fakeFs({ lstat: enoent })), { status: 'absent' });
  assert.deepEqual(read(fakeFs({ lstat: Object.assign(new Error('denied'), { code: 'EACCES' }) })), { status: 'invalid' });
  assert.deepEqual(read(fakeFs({ lstat: stat({ link: true, file: false }), fstat: stat() })), { status: 'invalid' });
  assert.deepEqual(read(fakeFs({ lstat: stat(), fstat: stat({ ino: 8n }) })), { status: 'invalid' }, 'lstat 뒤 다른 파일로 바뀐 경로를 읽었다');
  assert.deepEqual(read(fakeFs({ lstat: stat(), fstat: stat({ dev: 2n }) })), { status: 'invalid' });
  assert.deepEqual(read(fakeFs({ lstat: stat(), fstat: stat({ nlink: 2n }) })), { status: 'invalid' }, '하드링크 sidecar를 읽었다');
  assert.deepEqual(read(fakeFs({ lstat: stat(), fstat: stat({ size: 65n }) })), { status: 'invalid' });
  assert.deepEqual(read(fakeFs({ lstat: stat(), openError: enoent })), { status: 'invalid' }, 'lstat 뒤 사라진 파일을 absent로 판정했다');
});


test('#207 resume cleanup lock loss preserves the resolver error without a cause field', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0, waitMs: 0 } });
  await first.bootstrap({ ai: 1 });
  await first.requestStop();
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async () => {
      const lockDir = path.join(gameDir, 'loop.lock.d');
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
      throw Object.assign(new Error('resolver failed after lock replacement'), { code: 'RESOLVER_BOOM_207' });
    },
    opts: { port: 0, waitMs: 0, log: (record) => logs.push(record) },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await assert.rejects(loop.resume(), (error) => error.code === 'RESOLVER_BOOM_207');
  const row = logs.find((entry) => entry.event === 'resume-cleanup-lock-lost');
  assert.ok(row);
  assert.equal('cause' in row, false);
});


test('#204 default reclaim budgets scale all four defaults only on win32', () => {
  const expected = { finalizeBudgetMs: 20_000, orphanTerminateGraceMs: 5_000, orphanTerminateKillWaitMs: 2_000, resumeReclaimResidualMs: 5_000 };
  for (const platform of ['darwin', 'linux', 'win32']) {
    const scale = platform === 'win32' ? 10 : 1;
    assert.equal(platformBudgetScale(platform), scale);
    assert.deepEqual(defaultReclaimBudgets(platform), Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value * scale])));
  }
});

for (const budgetPlatform of ['win32', undefined]) {
  test(`#204 playing resume wires default budgets (${budgetPlatform ?? 'native'})`, { timeout: 30_000 * WIN32_SCALE }, async (t) => {
    const gameDir = tmpGame();
    const first = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0, waitMs: 0 } });
    await first.bootstrap({ ai: 1 });
    const oldOwner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
    const orphan = await startCoachOrphan({ ignoreTerm: false });
    t.after(() => terminateIfAlive(orphan));
    await seedRunningCoach(gameDir, oldOwner, 1, orphan);
    await first.requestStop();
    const logs = [];
    const loop = createGameLoop({ gameDir, resolver: resolverForCoach(makeAdapter(), makeCoachAdapter()), opts: { port: 0, waitMs: 0, budgetPlatform, log: (row) => logs.push(row) } });
    t.after(() => loop.requestStop().catch(() => {}));
    assert.equal((await loop.resume()).phase, 'playing');
    await waitUntilDead(orphan.pid);
    const row = logs.find((entry) => entry.event === 'resume-reclaim-budget');
    assert.ok(row);
    const defaults = defaultReclaimBudgets(budgetPlatform);
    assert.deepEqual([row.graceMs, row.killWaitMs, row.residualMs, row.scale], [defaults.orphanTerminateGraceMs, defaults.orphanTerminateKillWaitMs, defaults.resumeReclaimResidualMs, platformBudgetScale(budgetPlatform)]);
  });
}

test('#204 explicit reclaim budgets are not scaled again', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0, waitMs: 0 } });
  await first.bootstrap({ ai: 1 });
  await first.requestStop();
  const logs = [];
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: {
    port: 0, waitMs: 0, budgetPlatform: 'win32', orphanTerminateGraceMs: 5,
    orphanTerminateKillWaitMs: 5, resumeReclaimResidualMs: 8_000, log: (row) => logs.push(row),
  } });
  t.after(() => loop.requestStop().catch(() => {}));
  assert.equal((await loop.resume()).phase, 'playing');
  const row = logs.find((entry) => entry.event === 'resume-reclaim-budget');
  assert.ok(row);
  assert.deepEqual([row.graceMs, row.killWaitMs, row.residualMs, row.scale], [5, 5, 8_000, 10]);
});

// #205: real persisted rows and real coach CLI children; only the orphan identity and
// signals are controlled, so server cleanup always retains its normal behavior.
async function recovery205Fixture(t, { foreign = false, mixed = false, identity = 'alive', jump = false, coachCliPath } = {}) {
  const gameDir = tmpGame();
  const first = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0, waitMs: 0 } });
  await first.bootstrap({ ai: 1 });
  await first.requestStop();
  const owner = 'old-owner-205'; // No runtime-closed receipt for this owner.
  const orphan = await startCoachOrphan({ ignoreTerm: false });
  t.after(() => terminateIfAlive(orphan));
  await seedRunningCoach(gameDir, owner, 1, orphan);
  const startTime = processStartTime(orphan.pid);
  if (foreign) {
    const authorityPath = path.join(gameDir, '.coach-authority.json');
    const authority = readJson(authorityPath);
    authority.hands['1'].deadlineMono = '0';
    writeJsonAtomic(authorityPath, authority);
    await runCoachCli(gameDir, ['heartbeat', '--owner', owner]);
    await seedEmptyCoachAuthority(gameDir, 'intermediate-owner-205');
    const row = readJson(authorityPath).retiredAttempts[0];
    assert.equal(row.ownerSessionId, owner);
    assert.equal(row.cleanupEligible, false);
    assert.ok(row.agentHandle);
  }
  if (mixed) await seedReservedCoach(gameDir, owner, 2);
  const calls = [];
  const signals = [];
  let armed = false;
  const base = process.hrtime.bigint();
  const loop = createGameLoop({ gameDir, resolver: resolverForCoach(makeAdapter(), makeCoachAdapter()), opts: {
    port: 0, waitMs: 0, pollMs: 10, coachCliPath,
    ...(jump ? {} : { orphanTerminateGraceMs: 100 * WIN32_SCALE, orphanTerminateKillWaitMs: 100 * WIN32_SCALE, resumeReclaimResidualMs: 5_000 * WIN32_SCALE }),
    monotonicNs: () => armed ? base + 1_000_000_000_000n : process.hrtime.bigint(),
    processStartTime: (pid) => {
      if (pid !== orphan.pid) return processStartTime(pid);
      if (jump) armed = true;
      return identity === 'unknown' ? null : identity === 'replaced' ? `${startTime}0` : startTime;
    },
    signalProcess: (pid, signal) => {
      if (pid === orphan.pid) signals.push(signal);
      if (jump || pid !== orphan.pid) process.kill(pid, signal);
    },
    scanCoachRuntimeProcesses: () => Promise.resolve({ status: 'unavailable', reason: 'LSOF_MISSING' }),
    onCoachInvoke: (args) => calls.push(args),
  } });
  t.after(() => loop.requestStop().catch(() => {}));
  return { gameDir, loop, orphan, calls, signals, disarm: () => { armed = false; } };
}

function assert205Trace(gameDir, reason) {
  const rows = fs.readFileSync(path.join(gameDir, '.coach-adapter-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((row) => row.operation === 'cleanup-result').at(-1).evidence, reason);
}

test('#205 UNVERIFIED command needs an explicit operator declaration', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const f = await recovery205Fixture(t, { identity: 'unknown' });
  await assert.rejects(f.loop.resume(), { code: 'COACH_HANDLE_UNRESOLVED' });
  const { halt } = readJson(path.join(f.gameDir, 'loop-state.json'));
  assert.equal(halt.recovery.attempts[0].reason, 'IDENTITY_UNKNOWN');
  assert.equal(halt.recovery.commands[0].requiresOperatorConfirmation, true);
  assert.equal(halt.recovery.requiresOperatorConfirmation, true);
  assert.equal(halt.recovery.commands[0].args.includes('--operator-confirmed'), false);
  assert.match(halt.message, /직접 확인/);
  assert.match(halt.message, /reasons: IDENTITY_UNKNOWN/);
});

for (const foreign of [false, true]) {
  test(`#205 LIVE ${foreign ? 'foreign retired' : 'authorized'} row has no command and resumes after confirmed release`, { timeout: 30_000 * WIN32_SCALE }, async (t) => {
    const f = await recovery205Fixture(t, { foreign });
    await assert.rejects(f.loop.resume(), { code: 'COACH_HANDLE_UNRESOLVED' });
    const { halt } = readJson(path.join(f.gameDir, 'loop-state.json'));
    const row = halt.recovery.attempts[0];
    assert.equal(row.reason, 'STILL_ALIVE');
    assert.equal(row.cleanupAuthorized, !foreign);
    assert.equal(row.evidence.identity.pid, f.orphan.pid);
    assert.deepEqual(halt.recovery.commands, []);
    assert.match(halt.message, new RegExp(`pid: ${f.orphan.pid}`));
    assert.match(halt.message, /종료되지 않아/);
    assert.doesNotMatch(halt.message, /authority 수동 복구|확인할 수 없어/);
    await terminateIfAlive(f.orphan);
    await waitUntilDead(f.orphan.pid);
    if (foreign) {
      assert.match(halt.message, /--row-owner.*--operator-confirmed 1/);
      const args = ['cleanup-result', '--owner', 'intermediate-owner-205', '--hand', '1', '--generation', String(row.generation), '--cleanup-state', 'released', '--row-owner', 'old-owner-205'];
      assert.equal((await runCoachCliFailure(f.gameDir, args)).code, 'USAGE');
      assert.equal((await runCoachCli(f.gameDir, [...args, '--operator-confirmed', '1'])).cleanupState, 'released');
      const trace = fs.readFileSync(path.join(f.gameDir, '.coach-adapter-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
      assert.equal(trace.operatorConfirmed, true);
    }
    const calls = [];
    const next = createGameLoop({ gameDir: f.gameDir, resolver: resolverForCoach(makeAdapter(), makeCoachAdapter()), opts: { port: 0, waitMs: 0, onCoachInvoke: (args) => calls.push(args) } });
    t.after(() => next.requestStop().catch(() => {}));
    assert.equal((await next.resume()).phase, 'playing');
    if (!foreign) {
      assert205Evidence(calls, 'IDENTITY_DEAD');
      assert205Trace(f.gameDir, 'IDENTITY_DEAD');
    }
  });
}

test('#205 mixed LIVE and UNVERIFIED rows retain pid and confirmation guidance', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const f = await recovery205Fixture(t, { mixed: true });
  await assert.rejects(f.loop.resume(), { code: 'COACH_HANDLE_UNRESOLVED' });
  const { halt } = readJson(path.join(f.gameDir, 'loop-state.json'));
  assert.equal(halt.recovery.attempts.find((row) => row.handNo === 2).reason, 'LEGACY_SCAN_UNAVAILABLE');
  assert.equal(halt.recovery.commands.length, 1);
  assert.match(halt.message, new RegExp(`pid: ${f.orphan.pid}`));
  assert.match(halt.message, /--operator-confirmed 1/);
  assert.match(halt.message, /reasons:.*STILL_ALIVE.*LEGACY_SCAN_UNAVAILABLE/);
});

test('#205 replaced identity releases with evidence without signaling the replacement', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const f = await recovery205Fixture(t, { identity: 'replaced' });
  assert.equal((await f.loop.resume()).phase, 'playing');
  assert.deepEqual(f.signals, []);
  assert205Evidence(f.calls, 'IDENTITY_REPLACED');
  assert205Trace(f.gameDir, 'IDENTITY_REPLACED');
});

test('#205 closure deadline before fence has a rowless retry diagnostic', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const f = await recovery205Fixture(t, { jump: true });
  try { await assert.rejects(f.loop.resume(), { code: 'COACH_HANDLE_UNRESOLVED' }); } finally { f.disarm(); }
  const { halt } = readJson(path.join(f.gameDir, 'loop-state.json'));
  assert.equal(halt.recovery.attempts[0].handNo, null);
  assert.equal(halt.recovery.attempts[0].reason, 'RESUME_RECLAIM_DEADLINE_EXCEEDED');
  assert.equal(f.calls.some((args) => ['fence', 'cleanup-result'].includes(args[0])), false);
  assert.match(halt.message, /다시 resume/);
  assert.match(halt.message, /reasons: RESUME_RECLAIM_DEADLINE_EXCEEDED/);
  assert.doesNotMatch(halt.message, /authority 수동 복구|확인할 수 없어/);
});

test('#205 FENCE_CHILD_FAILED is distinct from closure deadline', { timeout: 20_000 * WIN32_SCALE }, async (t) => {
  const f = await recovery205Fixture(t, { identity: 'replaced', coachCliPath: path.resolve('test/helpers/fence-failure-cli-shim.mjs') });
  await assert.rejects(f.loop.resume(), { code: 'COACH_HANDLE_UNRESOLVED' });
  const { halt } = readJson(path.join(f.gameDir, 'loop-state.json'));
  assert.equal(halt.recovery.attempts[0].handNo, 1);
  assert.equal(halt.recovery.attempts[0].reason, 'FENCE_CHILD_FAILED');
  assert.equal(halt.recovery.attempts[0].cleanupAuthorized, false);
  assert.deepEqual(halt.recovery.commands, []);
  assert.match(halt.message, /reasons: FENCE_CHILD_FAILED/);
  assert.doesNotMatch(halt.message, /다시 resume/);
});

test('#205 recovery classification defaults to unverified and LIVE guidance wins over intent', async () => {
  const { persistedRecoveryClass } = await import('../tools/game-loop.js');
  for (const reason of ['STILL_ALIVE', 'DEADLINE_EXCEEDED', 'LEGACY_RUNTIME_PROCESS_PRESENT']) assert.equal(persistedRecoveryClass(reason), 'live');
  for (const reason of ['IDENTITY_UNKNOWN', 'SIGNAL_FAILED', 'LEGACY_SCAN_UNAVAILABLE', 'IDENTITY_UNAVAILABLE', 'SPAWN_INTENT_ONLY', 'SPAWN_EVIDENCE_INVALID', 'SPAWN_EVIDENCE_MISMATCH', 'IDENTITY_CONFLICT', 'NOT_ATTRIBUTABLE', 'CLEANUP_CHILD_FAILED', 'SOMETHING_NEW', undefined]) assert.equal(persistedRecoveryClass(reason), 'unverified');
  const guidance = unresolvedEvidenceGuidance([
    { reason: 'SPAWN_INTENT_ONLY', evidence: { sidecar: 'intent' } },
    { reason: 'STILL_ALIVE', evidence: { identity: { pid: 123 } } },
    { reason: 'LEGACY_RUNTIME_PROCESS_PRESENT', evidence: { legacyScanPids: [456] } },
  ]);
  assert.match(guidance, /pid: 123, 456/);
  assert.doesNotMatch(guidance, /spawn이 실제로/);
  assert.match(unresolvedEvidenceGuidance([{ reason: 'SPAWN_INTENT_ONLY', evidence: { sidecar: 'intent' } }]), /--operator-confirmed 1/);
});
