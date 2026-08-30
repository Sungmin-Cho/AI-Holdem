import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createGameLoop,
  exitCodeFor,
  parseGameLoopArgs,
} from '../tools/game-loop.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'engine/cli.js');

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-loop-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function initGame(gameDir, extra = []) {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI, 'init', '--ai', '2', ...extra, '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 20_000 });
  return JSON.parse(stdout.trim());
}

function makeAdapter({ kind = 'fake', delayMs = 0, onWarmup = null } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  let disposed = 0;
  const calls = [];
  return {
    kind,
    watchdog: { t1Ms: 25, t2Ms: 15 },
    calls,
    get maxInFlight() { return maxInFlight; },
    get disposed() { return disposed; },
    async warmup(input) {
      calls.push(input);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      onWarmup?.(input);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return { sessionId: `session-${input.playerId}`, raw: 'ready' };
    },
    async dispose() { disposed += 1; },
  };
}

function resolverFor(adapter, inspect = null) {
  return async (input) => {
    inspect?.(input);
    return { player: adapter, upper: adapter, notices: ['fake runtime selected'] };
  };
}

async function waitUntilDead(pid, timeoutMs = 2_000) {
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

test('bootstrap owns lock before init, writes initial state before resolver, then starts a healthy child server and warms players in parallel', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const focusSource = path.join(os.tmpdir(), `holdem-focus-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(focusSource, JSON.stringify({ focus: 'river bluff-catch' }));
  const adapter = makeAdapter({ delayMs: 60 });
  let canaryAbsPath = null;
  const resolver = resolverFor(adapter, ({ need, canaryAbsPath: canary }) => {
    assert.equal(need, 'player+upper');
    assert.equal(path.isAbsolute(canary), true);
    assert.equal(path.dirname(canary), gameDir);
    assert.equal(fs.existsSync(canary), true);
    canaryAbsPath = canary;

    assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d', 'pid')), true);
    assert.equal(fs.existsSync(path.join(gameDir, 'state.json')), true, 'init must precede resolver');
    assert.equal(fs.existsSync(path.join(gameDir, 'loop.log')), true);
    assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false, 'server must follow resolver');
    assert.equal(fs.existsSync(path.join(gameDir, '.practice-focus.json')), false);
    const initial = readJson(path.join(gameDir, 'loop-state.json'));
    assert.equal(initial.phase, 'bootstrap');
    assert.match(initial.sessionToken, /^[0-9a-f]{32}$/);
    assert.equal(initial.gameEpoch, initial.sessionToken);
    assert.match(initial.ownerSessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(initial.notices, []);
    assert.deepEqual(initial.metrics, []);
  });
  const loop = createGameLoop({ gameDir, resolver, opts: { port: 0 } });
  t.after(async () => {
    await loop.requestStop();
    try { fs.unlinkSync(focusSource); } catch { /* already gone */ }
  });

  await loop.bootstrap({
    ai: 3,
    stack: 700,
    levelEvery: 2,
    blinds: '10/20',
    force: false,
    practiceFocusFile: focusSource,
  });

  assert.equal(fs.existsSync(canaryAbsPath), false, 'resolver canary must always be removed');
  const engine = readJson(path.join(gameDir, 'state.json'));
  assert.deepEqual(engine.config, {
    aiCount: 3,
    startStack: 700,
    blinds0: [10, 20],
    levelEvery: 2,
  });
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  const lock = readJson(path.join(gameDir, 'lock.json'));
  assert.equal(state.phase, 'playing');
  assert.equal(state.port > 0, true);
  assert.equal(state.port, lock.port, 'loop state must use the actual bound port');
  assert.equal(Number.isInteger(lock.serverPid), true);
  assert.notEqual(lock.serverPid, process.pid, 'server must be a child process');
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${state.port}/api/health`)).json(), { ok: true });
  assert.deepEqual(readJson(path.join(gameDir, '.practice-focus.json')), { focus: 'river bluff-catch' });
  assert.equal(adapter.calls.length, 3);
  assert.equal(adapter.maxInFlight, 3, 'warmups must overlap rather than run serially');
  const personas = new Map(readJson(path.join(gameDir, 'players.json'))
    .map((persona) => [persona.playerId, persona]));
  assert.equal(adapter.calls.every((call) => call.prompt.includes(personas.get(call.playerId).name)), true);
  assert.deepEqual(readJson(path.join(gameDir, '.player-sessions.json')), {
    p1: { runtime: 'fake', sessionId: 'session-p1', createdAt: state.startedAt },
    p2: { runtime: 'fake', sessionId: 'session-p2', createdAt: state.startedAt },
    p3: { runtime: 'fake', sessionId: 'session-p3', createdAt: state.startedAt },
  });
  await assert.rejects(loop.run(), (error) => error.code === 'HAND_LOOP_TASK_5B');

  await loop.requestStop();
  await waitUntilDead(lock.serverPid);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
  assert.equal(adapter.disposed, 1);
});

test('bootstrap records NO_PLAYER_RUNTIME, removes the canary, and releases ownership without starting a server', async () => {
  const gameDir = tmpGame();
  let canaryAbsPath;
  const loop = createGameLoop({
    gameDir,
    resolver: async ({ need, canaryAbsPath: canary }) => {
      assert.equal(need, 'player+upper');
      assert.equal(fs.existsSync(canary), true);
      canaryAbsPath = canary;
      return { player: null, upper: null, notices: ['none eligible'] };
    },
    opts: { port: 0 },
  });

  await assert.rejects(
    loop.bootstrap({ ai: 2 }),
    (error) => error.code === 'NO_PLAYER_RUNTIME',
  );
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.phase, 'bootstrap');
  assert.deepEqual(state.halt, {
    code: 'NO_PLAYER_RUNTIME',
    message: '적격 플레이어 런타임이 없습니다.',
  });
  assert.deepEqual(state.notices, ['none eligible']);
  assert.equal(fs.existsSync(canaryAbsPath), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
  await loop.requestStop();
});

test('a live owner rejects a second bootstrap and resume without re-running init', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const adapter = makeAdapter();
  const first = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0 } });
  t.after(() => first.requestStop());
  await first.bootstrap({ ai: 1 });
  const before = fs.readFileSync(path.join(gameDir, 'state.json'));

  const second = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  await assert.rejects(second.bootstrap({ ai: 1 }), (error) => error.code === 'ACTIVE_GAME');
  await assert.rejects(second.resume(), (error) => error.code === 'LOCKED');
  assert.deepEqual(fs.readFileSync(path.join(gameDir, 'state.json')), before);
  await second.requestStop();
});

test('partial or unknown loop ownership fails closed before destructive init or resolver work', async () => {
  const gameDir = tmpGame();
  fs.mkdirSync(path.join(gameDir, 'loop.lock.d'));
  let resolverCalls = 0;
  const loop = createGameLoop({
    gameDir,
    resolver: async () => { resolverCalls += 1; return { player: null, upper: null, notices: [] }; },
  });

  await assert.rejects(loop.bootstrap({ ai: 2 }), (error) => error.code === 'LOOP_LOCK_UNKNOWN');
  await assert.rejects(loop.resume(), (error) => error.code === 'LOOP_LOCK_UNKNOWN');
  assert.equal(resolverCalls, 0);
  assert.equal(fs.existsSync(path.join(gameDir, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true, 'unknown lock must not be reclaimed');
});

test('an old-looking pid-less loop lock is still unknown and is never reclaimed by bootstrap', async () => {
  const gameDir = tmpGame();
  const lockDir = path.join(gameDir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);
  const loop = createGameLoop({
    gameDir,
    resolver: async () => assert.fail('resolver must not run'),
  });

  await assert.rejects(loop.bootstrap({ ai: 2 }), (error) => error.code === 'LOOP_LOCK_UNKNOWN');
  assert.equal(fs.existsSync(lockDir), true);
  assert.equal(fs.existsSync(path.join(gameDir, 'state.json')), false);
});

test('IDENTITY_UNAVAILABLE is surfaced distinctly and leaves no partial lock', { concurrency: false }, async () => {
  const gameDir = tmpGame();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-no-ps-'));
  const ps = path.join(fakeBin, 'ps');
  fs.writeFileSync(ps, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(ps, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = fakeBin;
  try {
    const loop = createGameLoop({
      gameDir,
      resolver: async () => assert.fail('resolver must not run'),
    });
    await assert.rejects(loop.bootstrap({ ai: 2 }), (error) => error.code === 'IDENTITY_UNAVAILABLE');
    assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
    assert.equal(fs.existsSync(path.join(gameDir, 'state.json')), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test('resume from bootstrap never calls init, preserves engine files, and completes server plus warmup', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  const originalState = fs.readFileSync(path.join(gameDir, 'state.json'));
  const sentinel = path.join(gameDir, 'must-survive-resume.txt');
  fs.writeFileSync(sentinel, 'keep');
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap',
    sessionToken: init.sessionToken,
    gameEpoch: init.sessionToken,
    ownerSessionId: '00000000-0000-4000-8000-000000000000',
    startedAt: '2026-08-30T00:00:00.000Z',
    notices: [],
    metrics: [],
  }));
  const adapter = makeAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0 } });
  t.after(() => loop.requestStop());

  await loop.resume();
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.phase, 'playing');
  assert.equal(state.sessionToken, init.sessionToken);
  assert.notEqual(state.ownerSessionId, '00000000-0000-4000-8000-000000000000');
  assert.deepEqual(fs.readFileSync(path.join(gameDir, 'state.json')), originalState);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(adapter.calls.length, 2);
  assert.equal(state.port > 0, true);
});

test('resume derives a missing loop state from engine state, but an entirely absent game releases the lock and fails', { timeout: 10_000 }, async (t) => {
  const emptyDir = tmpGame();
  const absent = createGameLoop({
    gameDir: emptyDir,
    resolver: async () => assert.fail('resolver must not run for an absent game'),
  });
  await assert.rejects(absent.resume(), (error) => error.code === 'NO_GAME');
  assert.equal(fs.existsSync(path.join(emptyDir, 'loop.lock.d')), false);

  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  const adapter = makeAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0 } });
  t.after(() => loop.requestStop());
  await loop.resume();
  const derived = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(derived.phase, 'playing');
  assert.equal(derived.sessionToken, init.sessionToken);
  assert.equal(derived.gameEpoch, init.sessionToken);
  assert.equal(adapter.calls.length, 2);
});

test('finalizing resume resolves upper-only with a live canary and exposes an explicit Task 7 stub', async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'finalizing',
    sessionToken: init.sessionToken,
    gameEpoch: init.sessionToken,
    ownerSessionId: 'old-owner',
    startedAt: '2026-08-30T00:00:00.000Z',
    notices: [],
    metrics: [],
  }));
  let canaryAbsPath;
  let warmups = 0;
  const upper = makeAdapter({ onWarmup: () => { warmups += 1; } });
  const loop = createGameLoop({
    gameDir,
    resolver: async ({ need, canaryAbsPath: canary }) => {
      assert.equal(need, 'upper-only');
      assert.equal(path.isAbsolute(canary), true);
      assert.equal(fs.existsSync(canary), true);
      canaryAbsPath = canary;
      return { player: null, upper, notices: [] };
    },
  });
  t.after(() => loop.requestStop());

  await loop.resume();
  assert.equal(fs.existsSync(canaryAbsPath), false);
  assert.equal(warmups, 0, 'finalization must not warm player sessions');
  assert.equal(fs.existsSync(path.join(gameDir, '.player-sessions.json')), false);
  await assert.rejects(loop.run(), (error) => error.code === 'FINALIZATION_TASK_7');
});

test('CLI parser covers the full surface and halt errors map to stable process exits', () => {
  assert.deepEqual(parseGameLoopArgs([
    '--game-dir', '/tmp/g', '--ai', '3', '--stack', '900', '--level-every', '4',
    '--blinds', '15/30', '--force', '--player-runtime', 'codex',
    '--practice-focus-file', '/tmp/focus.json',
  ]), {
    gameDir: '/tmp/g',
    ai: 3,
    stack: 900,
    levelEvery: 4,
    blinds: '15/30',
    force: true,
    resume: false,
    playerRuntime: 'codex',
    practiceFocusFile: '/tmp/focus.json',
  });
  assert.equal(parseGameLoopArgs(['--resume', '--game-dir', '/tmp/g']).resume, true);
  assert.throws(() => parseGameLoopArgs(['--unknown']), (error) => error.code === 'USAGE');
  assert.throws(() => parseGameLoopArgs(['--ai']), (error) => error.code === 'USAGE');
  assert.equal(exitCodeFor(null), 0);
  assert.equal(exitCodeFor({ code: 'repair_failed' }), 2);
  assert.equal(exitCodeFor({ code: 'REVIEW_FAILED' }), 3);
  assert.equal(exitCodeFor({ code: 'NO_PLAYER_RUNTIME' }), 4);
  assert.equal(exitCodeFor({ code: 'HAND_LOOP_TASK_5B' }), 5);
});
