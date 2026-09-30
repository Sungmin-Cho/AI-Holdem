// Shared fixtures for test/game-loop.test.js and test/game-loop-finalize.test.js (#210 split).
// Moved verbatim from game-loop.test.js; only `export` was added and ROOT points at the repo root.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { processStartTime, withNamedLock } from '../../engine/state.js';
import { createGameLoop } from '../../tools/game-loop.js';
import { gameEpochOf } from '../../publish-contract.js';
import { newDeck } from '../../engine/cards.js';
import { createOwnedTempDir } from './owned-fixtures.mjs';
import { createCoachControl } from '../../tools/coach-control.js';

export const execFileAsync = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = path.join(ROOT, 'engine/cli.js');
export const COACH_CLI = path.join(ROOT, 'tools/coach-control.js');
export const SERVER = path.join(ROOT, 'server/server.js');
export const REAL_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? null;
export const VALID_REVIEW = [
  '## 내 성향 통계',
  'VPIP와 PFR은 참고용 표본으로 해석합니다.',
  '## 결정적 핸드 2~3개 리플레이',
  '결정 시점의 공개 정보로 과정을 복기합니다.',
  '## 각 AI의 실제 아키타입 공개 + 읽기 평가',
  '상대 성향을 맞게 읽은 부분과 놓친 부분을 구분합니다.',
  '## 다음 게임에서 연습할 것',
  '팟 오즈 확인과 포지션별 오픈 범위를 연습합니다.',
].join('\n\n');

export function tmpGame() {
  return createOwnedTempDir('holdem-loop');
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function snapshotTree(root) {
  const entries = {};
  const visit = (dir, prefix = '') => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        entries[`${rel}/`] = null;
        visit(full, rel);
      } else {
        entries[rel] = fs.readFileSync(full).toString('base64');
      }
    }
  };
  visit(root);
  return entries;
}

export async function initGame(gameDir, extra = []) {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI, 'init', '--ai', '2', ...extra, '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 20_000 });
  return JSON.parse(stdout.trim());
}

export async function runCoachCli(gameDir, args) {
  const { stdout } = await execFileAsync(process.execPath, [
    COACH_CLI, ...args, '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 20_000 });
  return JSON.parse(stdout.trim());
}

// #192 S2a §6: the CLI now refuses reserve/begin-owner/bind-handle without
// --spawn-evidence. These fixtures seed legacy (pre-protocol) rows on purpose, so they
// go through the in-process API — with `spawnEvidence` left at its default `false` — to
// keep the resulting authority rows exactly as before.
// #192 S3 §6/H4: this is the loop's "queued note with no child" fixture kind — the row is
// accepted without ever spawning a coach process, so by default the accept carries
// `no-spawn` evidence (judgment f), matching what a real loop's deferred-flush new-generation
// branch would stamp. Pass `{ acceptEvidence: null }` for the handful of tests that need the
// pre-S3 legacy shape (an accepted row with no evidence at all).
export async function seedQueuedCoach(gameDir, owner, handNo = 1, { acceptEvidence = 'no-spawn' } = {}) {
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(gameDir, `.seed-coach-stats-${handNo}.json`);
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  const reserved = await createCoachControl().reserve({
    gameDir, owner, handNo, attempt: 1, considerOverfold: true,
    statsFile: statsPath, snapshotFile: path.join(gameDir, 'ui-snapshot.json'),
  });
  fs.writeFileSync(reserved.exactResultPath, JSON.stringify({
    handNo,
    text: `resume queued coach ${handNo}`,
  }));
  const denyPath = path.join(gameDir, `.seed-coach-deny-${handNo}.json`);
  fs.writeFileSync(denyPath, JSON.stringify(['SEED_FORBIDDEN_SENTINEL']));
  await runCoachCli(gameDir, [
    'accept', '--owner', owner, '--hand', String(handNo),
    '--generation', String(reserved.generation), '--forbidden-file', denyPath,
    ...(acceptEvidence ? ['--accept-evidence', acceptEvidence] : []),
  ]);
  return reserved;
}

// `startTimeOf` picks the recorded form: legacy by default, `ownedProcessStartTime` for the
// handles a current runtime writes (#247).
export async function seedRunningCoach(gameDir, owner, handNo, child, { startTimeOf = processStartTime } = {}) {
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(gameDir, `.seed-running-coach-stats-${handNo}.json`);
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  const cc = createCoachControl();
  const reserved = await cc.reserve({
    gameDir, owner, handNo, attempt: 1,
    statsFile: statsPath, snapshotFile: path.join(gameDir, 'ui-snapshot.json'),
  });
  const startTime = await waitFor(
    () => startTimeOf(child.pid),
    `coach orphan ${child.pid} start identity was not observable`,
  );
  await cc.bindHandle({
    gameDir, owner, handNo, generation: reserved.generation, handle: `${child.pid}:${startTime}`,
  });
  return { ...reserved, startTime };
}

// #192 J3: judgment g's default scanner is the real POSIX lsof scan. Any test that seeds an
// evidence-free legacy row and reaches the classifier without controlling the scanner would
// get a result that depends on whatever processes happen to be running on the machine at that
// moment (this file's own real-lsof test's tagged child, other test files running in parallel,
// or a real game elsewhere) — not on this test's own fixture. Shared loop constructors inject
// this deterministic default; the dedicated `#192 L1:` scanner tests remain the only ones
// exercising the real lsof path, and any test that needs a specific scan result still passes
// its own `scanCoachRuntimeProcesses` through `loopOpts` (spread after this default, so it
// wins).
export const TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES = () => (
  Promise.resolve({ status: 'unavailable', reason: 'TEST_DEFAULT' })
);

export async function seedReservedCoach(gameDir, owner, handNo = 1) {
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(gameDir, `.seed-reserved-coach-stats-${handNo}.json`);
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  return createCoachControl().reserve({
    gameDir, owner, handNo, attempt: 1,
    statsFile: statsPath, snapshotFile: path.join(gameDir, 'ui-snapshot.json'),
  });
}

export async function seedEmptyCoachAuthority(gameDir, owner) {
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(gameDir, '.seed-empty-coach-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  return runCoachCli(gameDir, [
    'begin-owner', '--owner', owner, '--completed', '0',
    '--stats-file', statsPath,
    '--snapshot-file', path.join(gameDir, 'ui-snapshot.json'),
    '--spawn-evidence', '1',
  ]);
}

export async function startCoachOrphan({ ignoreTerm = true, cwd = undefined } = {}) {
  const script = `
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    ...(cwd ? { cwd } : {}),
  });
  assert.equal(await readLine(child), 'ready');
  return child;
}

export function makeAdapter({
  kind = 'fake',
  delayMs = 0,
  onWarmup = null,
  onDecide = null,
  sessionIdFor = (input) => `session-${input.playerId}`,
  watchdog = { t1Ms: 25, t2Ms: 15 },
} = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  let disposed = 0;
  const calls = [];
  const decideCalls = [];
  const adapter = {
    kind,
    runtimeHomeId: null,
    calls,
    decideCalls,
    get maxInFlight() { return maxInFlight; },
    get disposed() { return disposed; },
    async warmup(input) {
      calls.push(input);
      const callNo = calls.length;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await onWarmup?.(input);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return { sessionId: sessionIdFor(input, callNo), raw: 'ready', runtimeHomeId: adapter.runtimeHomeId ?? null };
    },
    async decide(input) {
      decideCalls.push(input);
      if (onDecide) return onDecide(input, decideCalls.length);
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
    async dispose() { disposed += 1; },
  };
  if (watchdog) adapter.watchdog = { ...watchdog };
  return adapter;
}

export function resolverFor(adapter, inspect = null) {
  return async (input) => {
    inspect?.(input);
    return { player: adapter, upper: adapter, notices: ['fake runtime selected'] };
  };
}

export function makeCoachAdapter({ rounds = [], evaluatorRounds = [], synthesizerRounds = [] } = {}) {
  const prompts = [];
  const starts = [];
  const terminations = [];
  const evaluatorStarts = [];
  const synthesizerStarts = [];
  const reviewPrompts = [];
  const reviewTerminations = [];
  const pending = new Set();
  let disposed = 0;
  let serial = 0;
  return {
    kind: 'coach-fake',
    prompts,
    starts,
    terminations,
    evaluatorStarts,
    synthesizerStarts,
    reviewPrompts,
    reviewTerminations,
    get disposed() { return disposed; },
    // #192 sJ4: this fake's `dispose` genuinely settles every pending `oneshotStart` handle
    // (cancels each entry still in `pending` below) before resolving — declare the
    // confirming-dispose contract so the S4/finalize receipt tests keep exercising the real
    // "confirmed disposal" path rather than the now-stricter undeclared-confirmation skip.
    disposeConfirmsChildren: true,
    oneshotStart(input) {
      const stage = input.prompt.includes('역할: 격리 evaluator')
        ? 'evaluator'
        : input.prompt.includes('역할: 종합자')
          ? 'synthesizer'
          : 'coach';
      const stageStarts = stage === 'evaluator'
        ? evaluatorStarts
        : stage === 'synthesizer'
          ? synthesizerStarts
          : starts;
      const stageRounds = stage === 'evaluator'
        ? evaluatorRounds
        : stage === 'synthesizer'
          ? synthesizerRounds
          : rounds;
      const index = stageStarts.length;
      const coachHandNo = Number(/hand (\d+) \(redacted\):/.exec(input.prompt)?.[1] ?? 1);
      const round = stageRounds[index] ?? {
        raw: stage === 'evaluator'
          ? '표본 30핸드 미만이므로 참고용입니다. 공개 정보 기준 과정 평가는 안정적이었습니다.'
          : stage === 'synthesizer'
            ? VALID_REVIEW
            : JSON.stringify({ handNo: coachHandNo, text: '기본 코치 응답' }),
      };
      if (stage === 'coach') prompts.push(input.prompt);
      else reviewPrompts.push(input.prompt);
      stageStarts.push(input);
      const handleIndex = serial;
      serial += 1;
      round.onStart?.(input, index);
      let cancel;
      const cancelled = new Promise((_, reject) => { cancel = reject; });
      const produced = (async () => {
        if (round.gate) await round.gate;
        if (round.error) throw round.error;
        return { raw: round.raw };
      })();
      const done = Promise.race([produced, cancelled]);
      const entry = { cancel };
      pending.add(entry);
      done.finally(() => pending.delete(entry)).catch(() => {});
      done.catch(() => {});
      return {
        pid: round.pid !== undefined ? round.pid : 910_000 + handleIndex,
        startTime: round.startTime !== undefined ? round.startTime : `coach-start-${handleIndex}`,
        done,
        async terminate() {
          const result = typeof round.terminate === 'function'
            ? await round.terminate()
            : await (round.terminate ?? { confirmed: true });
          if (stage === 'coach') terminations.push({ index, result });
          else reviewTerminations.push({ stage, index, result });
          round.onTerminate?.(result, index);
          return result;
        },
      };
    },
    async dispose() {
      disposed += 1;
      for (const entry of pending) {
        entry.cancel(Object.assign(new Error('fake coach disposed'), { code: 'RUNTIME_CLOSED' }));
      }
    },
  };
}

export function resolverForCoach(player, upper, notices = []) {
  return async () => ({ player, upper, notices });
}

export async function waitUntilDead(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`pid ${pid} did not exit`);
}

// A wait bounded for in-process proofs; on win32 each proof behind the loop is
// a PowerShell child, so the same wait needs an order of magnitude more.
export const WIN32_SCALE = process.platform === 'win32' ? 10 : 1;

export async function waitFor(predicate, message, timeoutMs = 3_000 * WIN32_SCALE) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (lastError) throw new Error(`${message}: ${lastError.message}`);
  assert.fail(message);
}

// Real CLI publish/new-hand hops can exceed three seconds on a busy host.
// This is an arrival bound, not a product latency assertion.
export async function waitForUserSnapshot(gameDir, timeoutMs = 5_000 * WIN32_SCALE) {
  return waitFor(async () => {
    const lock = readJson(path.join(gameDir, 'lock.json'));
    const response = await fetch(
      `http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`,
    );
    if (!response.ok) return null;
    const snapshot = await response.json();
    return snapshot.view?.legal?.toAct === 'user' ? { lock, snapshot } : null;
  }, 'user snapshot did not become available', timeoutMs);
}

export function preferredUserAction(legal) {
  if (legal.canRaise) {
    return {
      decisionId: legal.decisionId,
      action: 'raise',
      amount: legal.minRaiseTo > legal.maxRaiseTo ? legal.maxRaiseTo : legal.minRaiseTo,
    };
  }
  if (legal.canCheck) return { decisionId: legal.decisionId, action: 'check' };
  return { decisionId: legal.decisionId, action: 'call' };
}

export async function postUserAction(lock, action) {
  const response = await fetch(
    `http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    },
  );
  const body = await response.json();
  return { status: response.status, body };
}

export function startRun(loop) {
  const promise = loop.run();
  // Attach a handler immediately so a deliberate RED rejection is not reported as
  // unhandled while the test is still arranging the external action.
  promise.catch(() => {});
  return promise;
}

export async function stopRun(loop, runPromise) {
  await loop.requestStop();
  return runPromise;
}

export async function readLine(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('child stdout line timeout')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      resolve(stdout.slice(0, newline));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child exited before stdout line: ${code ?? signal}`));
    });
  });
}

export async function startExternalServer(gameDir, token, { ignoreTerm = false } = {}) {
  const argv = ignoreTerm
    ? ['--input-type=module', '-e', `
      import { startServer } from ${JSON.stringify(pathToFileURL(SERVER).href)};
      process.on('SIGTERM', () => {});
      await startServer({ gameDir: ${JSON.stringify(gameDir)}, port: 0, token: ${JSON.stringify(token)} });
    `]
    : [SERVER, '--game-dir', gameDir, '--port', '0', '--token', token];
  const child = spawn(process.execPath, argv, { stdio: 'ignore' });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`external server exited early: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const lock = readJson(path.join(gameDir, 'lock.json'));
      if (lock.serverPid === child.pid) {
        const health = await fetch(`http://127.0.0.1:${lock.port}/api/health`);
        if (health.ok && (await health.json()).ok === true) return { child, lock };
      }
    } catch { /* server not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill('SIGKILL');
  throw new Error('external server did not become healthy');
}

export async function terminateIfAlive(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  // A cleanup hook has no test timeout of its own; a child whose exit never
  // arrives would hold the file until the per-file cap. Bound it and say so.
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`external child ${child.pid} did not exit after SIGKILL`)), 15_000 * WIN32_SCALE);
  });
  try { await Promise.race([exit, bound]); } finally { clearTimeout(timer); }
}

export function putAiFirst(gameDir) {
  const statePath = path.join(gameDir, 'state.json');
  const state = readJson(statePath);
  state.button = 0;
  fs.writeFileSync(statePath, JSON.stringify(state));
}

export function injectCurrentHandCard(state, card) {
  const hand = state.hand;
  const villain = Object.keys(hand.holes).find((pid) => pid !== 'user');
  delete hand.deck;
  const displaced = hand.holes[villain][0];
  const replace = (value, fallback) => (value === card ? (fallback === card ? '2c' : fallback) : value);
  for (const pid of Object.keys(hand.holes)) {
    if (pid === villain) continue;
    hand.holes[pid] = hand.holes[pid].map((value) => replace(value, displaced));
  }
  hand.holes[villain][1] = replace(hand.holes[villain][1], displaced === card ? '3c' : displaced);
  if (Array.isArray(hand.board)) {
    hand.board = hand.board.map((value) => replace(value, displaced === card ? '4c' : displaced));
  }
  hand.holes[villain][0] = card;
  return card;
}

export function decisionIdOfMessage(message) {
  return /decisionId:\s*([^\s]+)/.exec(message)?.[1] ?? null;
}

export function chipTotal(state) {
  const stacks = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
  const committed = Object.values(state.hand?.contribs ?? {}).reduce((sum, value) => sum + value, 0);
  return stacks + committed;
}

export function readLoopLog(gameDir) {
  return fs.readFileSync(path.join(gameDir, 'loop.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function writeLoopStateFixture(gameDir, sessionToken, overrides = {}) {
  const state = {
    phase: 'playing',
    handNo: 0,
    port: null,
    sessionToken,
    gameEpoch: gameEpochOf(sessionToken),
    ownerSessionId: 'old-owner',
    stopping: false,
    lastPublishId: null,
    playerRuntime: 'fake',
    upperRuntime: 'fake',
    startedAt: '2026-08-30T00:00:00.000Z',
    notices: [],
    metrics: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify(state));
  return state;
}

export async function setupCoachHand(t, {
  upper = makeCoachAdapter(),
  player = makeAdapter(),
  notices = ['fake coach runtime selected'],
  loopOpts = {},
  practiceFocusFile,
  bootstrap = {},
  deck = null,
} = {}) {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverForCoach(player, upper, notices),
    opts: {
      port: 0, waitMs: 0, scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES, ...loopOpts,
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1, stack: 100, practiceFocusFile, ...bootstrap });
  putAiFirst(gameDir);
  const newHand = ['step', '--new-hand'];
  if (deck) newHand.push('--deck', Array.isArray(deck) ? stackedDeck(deck) : deck);
  await cliJson(gameDir, newHand);
  await cliJson(gameDir, ['apply', 'p1', 'call']);
  await cliJson(gameDir, ['apply', 'user', 'check']);
  await cliJson(gameDir, ['apply', 'user', 'raise', '50']);
  return { gameDir, loop, player, upper };
}

export async function waitForCoachNote(gameDir, handNo, timeoutMs = 5_000 * WIN32_SCALE) {
  return waitFor(() => {
    try {
      const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
      return snapshot.coach?.find((note) => note.handNo === handNo) ?? null;
    } catch {
      return null;
    }
  }, `coach note for hand ${handNo} was not published`, timeoutMs);
}

export async function setupUserFirst(t, { loopOpts = {}, adapter = makeAdapter() } = {}) {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: {
      port: 0, waitMs: 40, scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES, ...loopOpts,
    },
  });
  t.after(() => loop.requestStop());
  await loop.bootstrap({ ai: 1, stack: 500 });
  return { gameDir, loop, adapter };
}

export async function holdNamedLock(gameDir, name) {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const locked = new Promise((resolve) => { entered = resolve; });
  const done = withNamedLock(gameDir, name, async () => {
    entered();
    await gate;
  });
  await locked;
  return { release, done };
}

export function stackedDeck(front) {
  const used = new Set(front);
  return [...front, ...newDeck().filter((card) => !used.has(card))].join(',');
}

// HU: SB 7h2c never splits against BB AsAh on this board, so the SB always busts.
export const HU_BUST_DECK = stackedDeck(['7h', 'As', '2c', 'Ah', 'Ks', 'Qd', '9c', '8s', '3d']);

export async function cliJson(gameDir, args) {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI, ...args, '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 20_000 });
  return JSON.parse(stdout.trim());
}

// startHand advances the button first, so seat the user one short of it.
export function putUserOnTheButton(gameDir) {
  const statePath = path.join(gameDir, 'state.json');
  const state = readJson(statePath);
  const userIdx = state.seats.findIndex((seat) => seat.playerId === 'user');
  state.button = (userIdx + state.seats.length - 1) % state.seats.length;
  fs.writeFileSync(statePath, JSON.stringify(state));
}

// A real user call against the all-in big blind supplies decision evidence before the deterministic bust.
export async function seedFinishedGame(gameDir) {
  const init = await cliJson(gameDir, ['init', '--ai', '1', '--stack', '50']);
  putUserOnTheButton(gameDir);
  await cliJson(gameDir, ['step', '--new-hand', '--deck', HU_BUST_DECK]);
  const over = await cliJson(gameDir, ['apply', 'user', 'call']);
  assert.equal(over.handOver, true);
  assert.equal(over.gameOver, true);
  return init;
}

export function expandFinishedGameToTwoHands(gameDir) {
  const statePath = path.join(gameDir, 'state.json');
  const state = readJson(statePath);
  const second = structuredClone(state.lastHand);
  second.handNo = 2;
  second.decisions = structuredClone(state.lastHand.decisions);
  for (const decision of second.decisions) {
    decision.handNo = 2;
    decision.decisionId = decision.decisionId.replace('d-1-', 'd-2-');
    decision.legal.decisionId = decision.decisionId;
  }
  second.actions = [...(second.actions ?? []), {
    decisionId: 'FUTURE_ACTION_SENTINEL',
    playerId: 'user',
    action: 'fold',
    street: 'river',
    potTotal: 50,
    board: [...(second.board ?? [])],
    stacks: { ...(second.endStacks ?? {}) },
  }];
  fs.mkdirSync(path.join(gameDir, 'hands'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'hands', 'hand-0002.json'), JSON.stringify(second));
  state.handNo = 2;
  state.lastHand = second;
  for (const stats of Object.values(state.stats ?? {})) stats.hands = 2;
  fs.writeFileSync(statePath, JSON.stringify(state));
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function seedGameOverSnapshot(gameDir) {
  const snapshotPath = path.join(gameDir, 'ui-snapshot.json');
  if (fs.existsSync(snapshotPath)) {
    const snap = readJson(snapshotPath);
    snap.view = { ...(snap.view ?? {}), gameOver: true, handNo: snap.view?.handNo ?? 1 };
    fs.writeFileSync(snapshotPath, JSON.stringify(snap));
    return;
  }
  fs.writeFileSync(snapshotPath, JSON.stringify({
    revision: 0,
    publishId: 0,
    view: { gameOver: true, handNo: 1 },
    log: [],
    coach: [],
    history: [],
  }));
}

export function finalizingLoop(t, gameDir, sessionToken, { upper, loopOpts = {}, stateOverrides = {} } = {}) {
  seedGameOverSnapshot(gameDir);
  writeLoopStateFixture(gameDir, sessionToken, {
    phase: 'finalizing',
    handNo: 1,
    playerRuntime: null,
    upperRuntime: 'coach-fake',
    ...stateOverrides,
  });
  const calls = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async ({ need }) => {
      assert.equal(need, 'upper-only');
      return { player: null, upper, notices: [] };
    },
    opts: {
      port: 0,
      waitMs: 0,
      onCoachInvoke: (args) => calls.push({ kind: 'coach', args }),
      onPublishInvoke: (args) => calls.push({ kind: 'publish', args }),
      scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES,
      ...loopOpts,
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  return { loop, calls };
}

export function coachInvocations(calls, verb = null) {
  return calls
    .filter((call) => call.kind === 'coach' && (verb === null || call.args[0] === verb))
    .map((call) => call.args);
}

export function publishInvocations(calls) {
  return calls.filter((call) => call.kind === 'publish').map((call) => call.args);
}

export function nonReviewPublishInvocations(calls) {
  return publishInvocations(calls).filter((args) => (
    !args.includes('--view-only')
    && path.basename(flagValue(args, '--from') ?? '') !== '.review.json'
  ));
}

export function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

export function assert205Evidence(calls, reason) {
  const call = calls.find((args) => args[0] === 'cleanup-result' && args[args.indexOf('--cleanup-state') + 1] === 'released');
  assert.ok(call, `no released cleanup for ${reason}`);
  assert.equal(call[call.indexOf('--evidence') + 1], reason);
}


export async function assert205UnconfirmedCommand(gameDir, command) {
  assert.equal(command.args.includes('--operator-confirmed'), false);
  const before = fs.readFileSync(path.join(gameDir, '.coach-authority.json'));
  await assert.rejects(execFileAsync(command.program, command.args, { encoding: 'utf8', timeout: 5_000 }), (error) => JSON.parse(error.stdout.trim()).code === 'USAGE');
  assert.deepEqual(fs.readFileSync(path.join(gameDir, '.coach-authority.json')), before);
}

// #214: the cleanup writer (a real coach-control CLI child) observes the OS itself. A test
// that fakes the loop's observations through seams must give the writer the same view, or
// the writer correctly refuses a release the loop only believed in. Pass the returned path
// as the loop's `coachCliPath`. The shim lives outside the repository test tree.
export function writerObservationShim({ startTimes = {}, scan = null } = {}) {
  const dir = createOwnedTempDir('holdem-writer-shim');
  const file = path.join(dir, 'coach-writer-shim.mjs');
  fs.writeFileSync(file, [
    `import { runCoachControlCliMain } from ${JSON.stringify(pathToFileURL(COACH_CLI).href)};`,
    `import { processStartTime } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'engine/process-identity.js')).href)};`,
    `const startTimes = ${JSON.stringify(Object.fromEntries(Object.entries(startTimes).map(([pid, value]) => [String(pid), value])))};`,
    `const scan = ${JSON.stringify(scan)};`,
    'await runCoachControlCliMain(process.argv.slice(2), {',
    '  processStartTime: (pid) => (Object.hasOwn(startTimes, String(pid)) ? startTimes[String(pid)] : processStartTime(pid)),',
    '  ...(scan ? { scanRuntimeProcesses: async () => scan } : {}),',
    '});',
    '',
  ].join('\n'));
  return file;
}
