import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processStartTime } from '../engine/state.js';
import { newDeck } from '../engine/cards.js';
import { gameEpochOf } from '../publish-contract.js';
import { createGameLoop } from '../tools/game-loop.js';
import { stampPlayerPolicies } from '../tools/policy-player.js';
import {
  annotationExactSegments,
  createTrainingControl,
} from '../tools/training-control.js';
import {
  readPersistedSolver,
  runSolver,
} from '../tools/solver-runtime.js';
import { defaultSolve } from '../tools/training-pipeline.js';
import {
  killProcessGroup,
  processIsAlive,
  q3Evaluation,
  readJson,
  spawnTokenChild,
  tmpQ3,
  waitFor,
  writeJson,
} from './helpers/q3-fixtures.js';

const WIN32_SKIP = process.platform === 'win32'
  ? 'solver process-group identity is POSIX ps; win32 discover is fail-closed'
  : undefined;

function test(name, opts, fn) {
  if (typeof opts === 'function') {
    return nodeTest(name, WIN32_SKIP ? { skip: WIN32_SKIP } : {}, opts);
  }
  return nodeTest(name, WIN32_SKIP ? { ...opts, skip: WIN32_SKIP } : opts, fn);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine', 'cli.js');
const SOLVER_RECORD = '.solver-child.json';
const DEAD_WRAPPER_PID = 99_999_991;
const DEAD_WRAPPER_START = 'Thu Jan  1 00:00:00 1970';

function recordPath(dir) {
  return path.join(dir, SOLVER_RECORD);
}

function spawningRecord(spawnToken, overrides = {}) {
  return {
    state: 'spawning',
    wrapperPid: DEAD_WRAPPER_PID,
    wrapperStartTime: DEAD_WRAPPER_START,
    spawnToken,
    at: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

async function withFakePs(rows, work, { fallbackStart = null, onCalls = null } = {}) {
  const binDir = tmpQ3('holdem-q3-fake-ps-');
  const ps = path.join(binDir, 'ps');
  fs.writeFileSync(ps, `#!/usr/bin/env node
const fs = require('node:fs');
const rows = JSON.parse(process.env.Q3_PS_ROWS || '[]');
const fallback = process.env.Q3_PS_FALLBACK || '';
const args = process.argv.slice(2);
if (process.env.Q3_PS_LOG) fs.appendFileSync(process.env.Q3_PS_LOG, JSON.stringify(args) + '\\n');
const at = args.indexOf('-p');
if (at !== -1) {
  const pid = Number(args[at + 1]);
  const row = rows.find((entry) => entry.pid === pid);
  const start = row?.startTime || fallback;
  if (!start) process.exit(1);
  process.stdout.write(start + '\\n');
  process.exit(0);
}
for (const row of rows) {
  process.stdout.write(String(row.pid) + ' ' + row.startTime + ' node q3-solver-child AI_HOLDEM_SOLVER_TOKEN=' + row.token + '\\n');
}
`);
  fs.chmodSync(ps, 0o755);
  const log = path.join(binDir, 'calls.jsonl');
  const oldPath = process.env.PATH;
  const oldRows = process.env.Q3_PS_ROWS;
  const oldFallback = process.env.Q3_PS_FALLBACK;
  const oldLog = process.env.Q3_PS_LOG;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
  process.env.Q3_PS_ROWS = JSON.stringify(rows);
  process.env.Q3_PS_LOG = log;
  if (fallbackStart === null) delete process.env.Q3_PS_FALLBACK;
  else process.env.Q3_PS_FALLBACK = fallbackStart;
  try {
    return await work();
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldRows === undefined) delete process.env.Q3_PS_ROWS;
    else process.env.Q3_PS_ROWS = oldRows;
    if (oldFallback === undefined) delete process.env.Q3_PS_FALLBACK;
    else process.env.Q3_PS_FALLBACK = oldFallback;
    if (oldLog === undefined) delete process.env.Q3_PS_LOG;
    else process.env.Q3_PS_LOG = oldLog;
    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    onCalls?.(calls);
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

function flopSnapshot() {
  return {
    schemaVersion: 1,
    decisionId: 'd-1-flop-2',
    actorId: 'user',
    street: 'flop',
    position: 'BTN',
    holeCards: ['Ah', 'Ad'],
    board: ['Kh', '7d', '2c'],
    blinds: [50, 100],
    potBefore: 300,
    currentBet: 0,
    actorBet: 0,
    toCall: 0,
    minRaiseTo: 100,
    maxRaiseTo: 10_000,
    effectiveStack: 10_000,
    publicSeats: ['user', 'p1'].map((playerId) => ({
      playerId, out: false, folded: false, allIn: false, stack: 10_000, bet: 0, contribution: 0,
    })),
    priorActions: [],
    chosenAction: { action: 'check', amount: 0 },
    forced: false,
  };
}

function seedSolveState(dir) {
  writeJson(path.join(dir, 'state.json'), {
    sessionToken: 'tok',
    lastHand: { handNo: 1, decisions: [flopSnapshot()] },
  });
}

async function leaveSettledWrapperWithSolverChild(t, dir) {
  const statePath = path.join(dir, 'state.json');
  const previousState = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;
  const state = previousState ? JSON.parse(previousState.toString('utf8')) : { sessionToken: 'tok' };
  state.lastHand = { ...(state.lastHand ?? {}), handNo: 1, decisions: [flopSnapshot()] };
  writeJson(statePath, state);

  const oldFault = process.env.SOLVER_FAULT;
  process.env.SOLVER_FAULT = 'ignore-term';
  let handle;
  let settled;
  let pid;
  try {
    const persisted = await withFakePs([], async () => {
      handle = defaultSolve({
        sessionDir: dir,
        decisionId: 'd-1-flop-2',
        handNo: 1,
        adapterId: 'fake-solver',
      });
      settled = Promise.resolve(handle.promise).catch((error) => error);
      return waitFor(() => {
        try {
          const record = readJson(recordPath(dir));
          return Number.isInteger(record.pid) ? record : null;
        } catch {
          return null;
        }
      }, 'solver child record did not appear');
    }, { fallbackStart: 'Q3_FAKE_PROCESS_START' });
    pid = persisted.pid;
    // Make the persisted child deliberately unkillable by identity. The child must
    // survive wrapper exit so the finalizer has evidence it cannot call confirmed.
    writeJson(recordPath(dir), { ...persisted, startTime: null });
  } finally {
    if (oldFault === undefined) delete process.env.SOLVER_FAULT;
    else process.env.SOLVER_FAULT = oldFault;
  }

  t.after(() => killProcessGroup(pid));
  const termination = await handle.terminate();
  await settled;
  if (previousState === null) fs.unlinkSync(statePath);
  else fs.writeFileSync(statePath, previousState);
  return { pid, termination };
}

function engineJson(gameDir, args) {
  return JSON.parse(execFileSync(process.execPath, [
    ENGINE, ...args, '--game-dir', gameDir,
  ], { encoding: 'utf8' }).trim());
}

function stackedDeck(front) {
  const used = new Set(front);
  return [...front, ...newDeck().filter((card) => !used.has(card))].join(',');
}

function seedFinishedPolicyGame(dir) {
  const initialized = engineJson(dir, [
    'init', '--ai', '1', '--stack', '25', '--opponent-runtime', 'policy',
  ]);
  const statePath = path.join(dir, 'state.json');
  const state = readJson(statePath);
  const userIndex = state.seats.findIndex((seat) => seat.playerId === 'user');
  state.button = (userIndex + state.seats.length - 1) % state.seats.length;
  writeJson(statePath, state);
  const deck = stackedDeck(['7h', 'As', '2c', 'Ah', 'Ks', 'Qd', '9c', '8s', '3d']);
  const over = engineJson(dir, ['step', '--new-hand', '--deck', deck]);
  assert.equal(over.gameOver, true);
  stampPlayerPolicies(dir);
  writeJson(path.join(dir, 'loop-state.json'), {
    phase: 'finalizing',
    handNo: 1,
    port: null,
    sessionToken: initialized.sessionToken,
    gameEpoch: gameEpochOf(initialized.sessionToken),
    ownerSessionId: 'owner-before-q3-finalization',
    stopping: false,
    lastPublishId: null,
    playerRuntime: null,
    upperRuntime: null,
    opponentRuntime: 'policy',
    startedAt: '2026-09-04T00:00:00.000Z',
    notices: [],
    metrics: [],
  });
  return initialized;
}

function testLoopLock(gameDir) {
  const dir = path.join(gameDir, 'loop.lock.d');
  const startTime = 'q3-test-owned-lock';
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'pid'), `${process.pid}\n${startTime}`);
  const stat = fs.statSync(dir, { bigint: true });
  return { dir, pid: process.pid, startTime, dev: stat.dev, ino: stat.ino };
}

function finalizingLoop(gameDir, calls) {
  return createGameLoop({
    gameDir,
    initialLockHandle: testLoopLock(gameDir),
    resolver: async ({ need }) => {
      assert.equal(need, 'upper-only');
      return { player: null, upper: null, notices: [] };
    },
    opts: {
      port: 0,
      waitMs: 0,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 6_000,
      finalizeCutoffLeadMs: 2_000,
      onCoachInvoke: (args) => calls.push(args),
    },
  });
}

test('Q3 M13: a detached solver child surviving wrapper exit prevents confirmed termination', async (t) => {
  const dir = tmpQ3('holdem-q3-wrapper-solver-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seedSolveState(dir);

  const { pid, termination } = await leaveSettledWrapperWithSolverChild(t, dir);

  assert.deepEqual(termination, { confirmed: false, reason: 'solver_child_live' });
  assert.equal(processIsAlive(pid), true, 'wrapper termination killed an identity-unreadable solver child');
  assert.equal(readPersistedSolver(dir).state, 'unreadable');
});

test('Q3 M13: independent final cleanup detects a solver after its wrapper handle settled', { timeout: 30_000 }, async (t) => {
  const dir = tmpQ3('holdem-q3-final-solver-');
  seedFinishedPolicyGame(dir);
  const { pid } = await leaveSettledWrapperWithSolverChild(t, dir);
  const calls = [];
  const loop = finalizingLoop(dir, calls);
  t.after(async () => {
    await killProcessGroup(pid);
    try { fs.unlinkSync(recordPath(dir)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      const { serverPid } = readJson(path.join(dir, 'lock.json'));
      process.kill(serverPid, 'SIGKILL');
      await waitFor(() => !processIsAlive(serverPid), 'server child did not stop during cleanup');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
    await loop.requestStop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await withFakePs([], async () => {
    await loop.resume({ skipLock: true });
    await assert.rejects(loop.run(), { code: 'FINALIZATION_ABORTED' });
  }, { fallbackStart: 'Q3_FINALIZATION_PROCESS_START' });

  const cutoff = calls.find((args) => args[0] === 'finalize-cutoff');
  assert.ok(cutoff, 'finalize-cutoff was not invoked');
  const flag = cutoff.indexOf('--termination-confirmed');
  assert.equal(cutoff[flag + 1], 'false');
  const loopState = readJson(path.join(dir, 'loop-state.json'));
  assert.equal(loopState.finalization.cutoff.terminationConfirmed, false);
  assert.equal(processIsAlive(pid), true, 'independent cleanup signalled a child without stable identity');
});

test('Q3 M14: finalizing resume writes cutoff marker before sealing unavailable exact file', { timeout: 30_000 }, async (t) => {
  const dir = tmpQ3('holdem-q3-final-cutoff-');
  const initialized = seedFinishedPolicyGame(dir);
  const gameEpoch = gameEpochOf(initialized.sessionToken);
  const evaluation = q3Evaluation(gameEpoch);
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch,
    owner: 'owner-before-q3-finalization',
    handNo: 1,
    evaluations: [evaluation],
  });
  let authority = tc.loadAuthority(dir);
  const item = authority.items[evaluation.evaluationId];
  const cutoffPath = path.join(dir, 'training', '.cutoff');
  const exactPath = path.join(
    dir,
    'training',
    ...annotationExactSegments(item.detailRef, 'explanation'),
  );
  assert.equal(fs.existsSync(cutoffPath), false);
  assert.equal(item.annotations.explanation, undefined);

  const calls = [];
  const loop = finalizingLoop(dir, calls);
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await withFakePs([], async () => {
    await loop.resume({ skipLock: true });
    await loop.run();
  }, { fallbackStart: 'Q3_FINALIZATION_PROCESS_START' });

  assert.equal(fs.lstatSync(cutoffPath).isFile(), true);
  assert.equal(fs.lstatSync(exactPath).isFile(), true);
  const cutoffStat = fs.statSync(cutoffPath, { bigint: true });
  const exactStat = fs.statSync(exactPath, { bigint: true });
  assert.equal(cutoffStat.mtimeNs < exactStat.mtimeNs, true, 'unavailable exact file preceded its durable cutoff marker');
  authority = tc.loadAuthority(dir);
  assert.equal(authority.items[evaluation.evaluationId].annotations.explanation.status, 'unavailable');
  assert.equal(authority.items[evaluation.evaluationId].annotations.explanation.sealReason, 'cutoff');
});

test('Q3 M13 spawning: dead wrapper before spawn converges to absent after bounded token probes', async () => {
  const dir = tmpQ3('holdem-q3-spawning-absent-');
  try {
    writeJson(recordPath(dir), spawningRecord('q3-no-child-token'));
    const result = await withFakePs([], () => readPersistedSolver(dir));
    assert.equal(result.state, 'absent');
    assert.equal(fs.existsSync(recordPath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Q3 M13 spawning: one token match is promoted with child pid and startTime', async (t) => {
  const dir = tmpQ3('holdem-q3-spawning-promote-');
  const token = `q3-single-${process.pid}-${Date.now()}`;
  const child = await spawnTokenChild(token);
  t.after(async () => {
    await killProcessGroup(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeJson(recordPath(dir), spawningRecord(token));

  const result = await withFakePs([
    { pid: child.pid, startTime: child.startTime, token },
  ], () => readPersistedSolver(dir));

  assert.equal(result.state, 'live');
  assert.equal(result.record.pid, child.pid);
  assert.equal(result.record.startTime, child.startTime);
  assert.equal(readJson(recordPath(dir)).pid, child.pid);
  assert.equal(processIsAlive(child.pid), true);
});

test('Q3 M13 spawning: synchronous spawn throw removes the reservation', async () => {
  const dir = tmpQ3('holdem-q3-spawn-throw-');
  try {
    // A prior dead record proves this assertion is about the new reservation's cleanup:
    // the old implementation throws before writing and otherwise leaves these bytes behind.
    writeJson(recordPath(dir), { pid: DEAD_WRAPPER_PID, startTime: DEAD_WRAPPER_START });
    await withFakePs([], () => (
      assert.rejects(runSolver({ argv: [null], gameDir: dir, timeoutMs: 100 }))
    ), { fallbackStart: 'Q3_SPAWN_THROW_START' });
    assert.equal(fs.existsSync(recordPath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Q3 M13 spawning: asynchronous ENOENT clears the reservation and rejects as SOLVER_SPAWN', () => {
  const dir = tmpQ3('holdem-q3-async-spawn-');
  const solverModule = pathToFileURL(path.join(ROOT, 'tools', 'solver-runtime.js')).href;
  const script = `
import fs from 'node:fs';
import path from 'node:path';
import { runSolver } from ${JSON.stringify(solverModule)};
const dir = process.argv[1];
let code = null;
try {
  await runSolver({ argv: ['/definitely/missing-q3-solver'], gameDir: dir });
} catch (error) {
  code = error.code;
}
await new Promise((resolve) => setTimeout(resolve, 20));
process.stdout.write(JSON.stringify({
  code,
  recordExists: fs.existsSync(path.join(dir, '.solver-child.json')),
}));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], {
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    code: 'SOLVER_SPAWN',
    recordExists: false,
  });
});

test('Q3 M13 spawning: a torn tmp leaves the prior spawning reservation authoritative', async () => {
  const dir = tmpQ3('holdem-q3-spawning-torn-');
  try {
    const token = `q3-torn-${process.pid}-${Date.now()}`;
    const wrapperStartTime = 'Q3_LIVE_WRAPPER_START';
    const canonical = spawningRecord(token, {
      wrapperPid: process.pid,
      wrapperStartTime,
    });
    writeJson(recordPath(dir), canonical);
    fs.writeFileSync(`${recordPath(dir)}.promotion.tmp`, '{"state":"live","pid":');
    const before = fs.readFileSync(recordPath(dir));

    const result = await withFakePs([
      { pid: process.pid, startTime: wrapperStartTime, token },
    ], () => readPersistedSolver(dir));

    assert.equal(result.state, 'live');
    assert.deepEqual(fs.readFileSync(recordPath(dir)), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Q3 M13 spawning: multiple token matches stay unreadable and signal no process', async (t) => {
  const dir = tmpQ3('holdem-q3-spawning-multiple-');
  const token = `q3-multiple-${process.pid}-${Date.now()}`;
  const first = await spawnTokenChild(token);
  const second = await spawnTokenChild(token);
  t.after(async () => {
    await Promise.all([killProcessGroup(first.pid), killProcessGroup(second.pid)]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeJson(recordPath(dir), spawningRecord(token));

  let psCalls = [];
  const result = await withFakePs([
    { pid: first.pid, startTime: first.startTime, token },
    { pid: second.pid, startTime: second.startTime, token },
  ], () => readPersistedSolver(dir), { onCalls: (calls) => { psCalls = calls; } });

  assert.equal(result.state, 'unreadable');
  assert.equal(
    psCalls.some((args) => args.some((arg) => /^-ax[eE]$/.test(arg))),
    true,
    'spawning reader did not perform the token-identity process scan',
  );
  assert.equal(processIsAlive(first.pid), true);
  assert.equal(processIsAlive(second.pid), true);
});

test('Q3 M13 spawning: discovered pid/startTime mismatch stays unreadable and signal-free', async (t) => {
  const dir = tmpQ3('holdem-q3-spawning-mismatch-');
  const token = `q3-mismatch-${process.pid}-${Date.now()}`;
  const child = await spawnTokenChild(token);
  t.after(async () => {
    await killProcessGroup(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeJson(recordPath(dir), spawningRecord(token));

  let psCalls = [];
  const result = await withFakePs([
    { pid: child.pid, startTime: child.startTime, token },
  ], () => readPersistedSolver(dir, {
    processStartTime(pid) {
      if (pid === DEAD_WRAPPER_PID) return null;
      if (pid === child.pid) return 'identity-mismatch-sentinel';
      return processStartTime(pid);
    },
  }), { onCalls: (calls) => { psCalls = calls; } });

  assert.equal(result.state, 'unreadable');
  assert.equal(
    psCalls.some((args) => args.some((arg) => /^-ax[eE]$/.test(arg))),
    true,
    'spawning reader did not scan the token before rejecting the startTime mismatch',
  );
  assert.equal(processIsAlive(child.pid), true);
});

test('Q3 M13 identity uses AI_HOLDEM_SOLVER_TOKEN env without changing adapter argv', async () => {
  const dir = tmpQ3('holdem-q3-solver-env-');
  const observation = path.join(dir, 'observation.json');
  const script = `
const fs = require('node:fs');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.Q3_OBSERVATION, JSON.stringify({
    token: process.env.AI_HOLDEM_SOLVER_TOKEN,
    argv: process.argv.slice(1),
  }));
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    accuracy: 'heuristic',
    providerId: 'q3-observer',
    providerVersion: '1.0.0',
    evBb: null,
    actions: [{ action: 'check', frequency: 1, evBb: null }],
    rangeMatrix: { schemaVersion: 1, accuracy: 'heuristic', cells: [], evBb: null },
  }) + '\\n');
});
`;
  try {
    await withFakePs([], () => runSolver({
      argv: [process.execPath, '-e', script, 'argv-sentinel'],
      env: { Q3_OBSERVATION: observation },
      gameDir: dir,
      timeoutMs: 2_000,
    }), { fallbackStart: 'Q3_OBSERVER_PROCESS_START' });
    const seen = readJson(observation);
    assert.match(seen.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual(seen.argv, ['argv-sentinel']);
    assert.equal(fs.existsSync(recordPath(dir)), false);
  } finally {
    let pid = null;
    try { pid = readJson(recordPath(dir)).pid; } catch { /* absent */ }
    await killProcessGroup(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
