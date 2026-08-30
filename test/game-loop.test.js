import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  processStartTime,
  withNamedLock,
} from '../engine/state.js';
import {
  createGameLoop,
  exitCodeFor,
  parseGameLoopArgs,
} from '../tools/game-loop.js';
import { RUNTIME_TABLE } from '../tools/player-runtime.js';
import { gameEpochOf } from '../publish-contract.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'engine/cli.js');
const SERVER = path.join(ROOT, 'server/server.js');
const REAL_PS = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
const REAL_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? null;

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-loop-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function snapshotTree(root) {
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

async function initGame(gameDir, extra = []) {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI, 'init', '--ai', '2', ...extra, '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 20_000 });
  return JSON.parse(stdout.trim());
}

function makeAdapter({
  kind = 'fake',
  delayMs = 0,
  onWarmup = null,
  onDecide = null,
  watchdog = { t1Ms: 25, t2Ms: 15 },
} = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  let disposed = 0;
  const calls = [];
  const decideCalls = [];
  const adapter = {
    kind,
    calls,
    decideCalls,
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

async function waitFor(predicate, message, timeoutMs = 3_000) {
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

async function waitForUserSnapshot(gameDir, timeoutMs = 3_000) {
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

function preferredUserAction(legal) {
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

async function postUserAction(lock, action) {
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

function startRun(loop) {
  const promise = loop.run();
  // Attach a handler immediately so a deliberate RED rejection is not reported as
  // unhandled while the test is still arranging the external action.
  promise.catch(() => {});
  return promise;
}

async function waitWhileRunning(runPromise, predicate, message, timeoutMs = 3_000) {
  return Promise.race([
    waitFor(predicate, message, timeoutMs),
    runPromise.then(
      () => { throw new Error(`loop stopped before condition: ${message}`); },
      (error) => { throw error; },
    ),
  ]);
}

async function stopRun(loop, runPromise) {
  await loop.requestStop();
  return runPromise;
}

async function waitForUserAction(gameDir, predicate = () => true, timeoutMs = 3_000) {
  return waitFor(() => {
    const state = readJson(path.join(gameDir, 'state.json'));
    const actions = state.hand?.actions ?? state.lastHand?.actions ?? [];
    return actions.find((action) => action.playerId === 'user' && predicate(action)) ?? null;
  }, 'user action was not applied', timeoutMs);
}

async function readLine(child, timeoutMs = 5_000) {
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

async function startOwnedLoopHolder(gameDir, { signalLog = null, ignoreTerm = false } = {}) {
  const stateUrl = pathToFileURL(path.join(ROOT, 'engine/state.js')).href;
  const script = `
    import fs from 'node:fs';
    import { acquireOwnedLock, releaseOwnedLock } from ${JSON.stringify(stateUrl)};
    const gameDir = ${JSON.stringify(gameDir)};
    const signalLog = ${JSON.stringify(signalLog)};
    const handle = acquireOwnedLock(gameDir, 'loop.lock.d');
    process.on('SIGTERM', () => {
      if (signalLog) fs.appendFileSync(signalLog, 'loop:SIGTERM\\n');
      if (${ignoreTerm ? 'true' : 'false'}) return;
      releaseOwnedLock(handle);
      process.exit(0);
    });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(await readLine(child), 'ready');
  return child;
}

async function startReplacingLoopHolder(gameDir, token, signalLog) {
  const stateUrl = pathToFileURL(path.join(ROOT, 'engine/state.js')).href;
  const serverUrl = pathToFileURL(SERVER).href;
  const replacementScript = `
    import fs from 'node:fs';
    import { startServer } from ${JSON.stringify(serverUrl)};
    const running = await startServer({
      gameDir: ${JSON.stringify(gameDir)}, port: 0, token: ${JSON.stringify(token)}
    });
    fs.appendFileSync(${JSON.stringify(signalLog)}, 'replacement:ready:' + process.pid + '\\n');
    process.once('SIGTERM', async () => {
      fs.appendFileSync(${JSON.stringify(signalLog)}, 'replacement:SIGTERM\\n');
      await running.close();
      process.exit(0);
    });
  `;
  const script = `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { acquireOwnedLock, releaseOwnedLock } from ${JSON.stringify(stateUrl)};
    const handle = acquireOwnedLock(${JSON.stringify(gameDir)}, 'loop.lock.d');
    let stopping = false;
    process.on('SIGTERM', async () => {
      if (stopping) return;
      stopping = true;
      fs.appendFileSync(${JSON.stringify(signalLog)}, 'loop:SIGTERM\\n');
      const replacement = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(replacementScript)}], {
        stdio: 'ignore'
      });
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        try {
          const lock = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(gameDir, 'lock.json'))}, 'utf8'));
          if (lock.serverPid === replacement.pid) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      releaseOwnedLock(handle);
      process.exit(0);
    });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(await readLine(child), 'ready');
  return child;
}

function spawnBootstrapWorker(gameDir) {
  const loopUrl = pathToFileURL(path.join(ROOT, 'tools/game-loop.js')).href;
  const script = `
    import { createGameLoop } from ${JSON.stringify(loopUrl)};
    const adapter = {
      kind: 'fake', watchdog: { t1Ms: 10, t2Ms: 10 },
      async warmup({playerId}) { return {sessionId: 's-' + playerId, raw: 'ready'}; },
      async decide() { return {raw: '{}'}; },
      async dispose() {}
    };
    const loop = createGameLoop({
      gameDir: ${JSON.stringify(gameDir)},
      resolver: async () => ({player: adapter, upper: adapter, notices: []}),
      opts: {port: 0, waitMs: 0}
    });
    try {
      await loop.bootstrap({ai: 1, stack: 100});
      process.stdout.write(JSON.stringify({ok: true, pid: process.pid}) + '\\n');
      process.once('SIGTERM', async () => { await loop.requestStop(); process.exit(0); });
      setInterval(() => {}, 1000);
    } catch (error) {
      process.stdout.write(JSON.stringify({ok: false, code: error.code}) + '\\n');
      await loop.requestStop().catch(() => {});
      process.exit(0);
    }
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function startLoggedServer(gameDir, token, signalLog, label) {
  const serverUrl = pathToFileURL(SERVER).href;
  const script = `
    import fs from 'node:fs';
    import { startServer } from ${JSON.stringify(serverUrl)};
    const running = await startServer({
      gameDir: ${JSON.stringify(gameDir)}, port: 0, token: ${JSON.stringify(token)}
    });
    process.once('SIGTERM', async () => {
      fs.appendFileSync(${JSON.stringify(signalLog)}, ${JSON.stringify(`${label}:SIGTERM\n`)});
      await running.close();
      process.exit(0);
    });
    process.stdout.write(String(running.port) + '\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const port = Number(await readLine(child));
  await waitFor(() => {
    const lock = readJson(path.join(gameDir, 'lock.json'));
    return lock.serverPid === child.pid && lock.port === port ? lock : null;
  }, `${label} server did not own lock`);
  return { child, port };
}

async function startExternalServer(gameDir, token, { ignoreTerm = false } = {}) {
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

async function startHealthOnlyServer({ acceptsEveryToken = false } = {}) {
  const script = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      const health = req.url === '/api/health';
      const permissive = ${acceptsEveryToken ? 'true' : 'false'} && req.url.startsWith('/api/snapshot');
      const body = health ? '{"ok":true}' : (permissive
        ? '{"revision":0,"view":null,"log":[],"coach":[]}'
        : '{"ok":false,"code":"UNAUTHORIZED"}');
      res.writeHead(health || permissive ? 200 : 401, {'Content-Type':'application/json'});
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('health-only server timeout')), 3_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n')[0];
      if (/^\d+$/.test(line)) {
        clearTimeout(timer);
        resolve(Number(line));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`health-only server exited: ${code}`));
    });
  });
  return { child, port };
}

async function terminateIfAlive(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exit;
}

async function withFakePs(scriptBody, fn) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-loop-ps-'));
  const psPath = path.join(binDir, 'ps');
  fs.writeFileSync(psPath, `#!/bin/sh\n${scriptBody}\n`);
  fs.chmodSync(psPath, 0o755);
  const original = process.env.PATH;
  process.env.PATH = `${binDir}:${original}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

function putAiFirst(gameDir) {
  const statePath = path.join(gameDir, 'state.json');
  const state = readJson(statePath);
  state.button = 0;
  fs.writeFileSync(statePath, JSON.stringify(state));
}

function makeCurrentActorCanCheck(gameDir) {
  const statePath = path.join(gameDir, 'state.json');
  const state = readJson(statePath);
  const playerId = state.seats[state.hand.toActIdx].playerId;
  state.hand.currentBet = state.hand.bets[playerId] ?? 0;
  fs.writeFileSync(statePath, JSON.stringify(state));
}

function decisionIdOfMessage(message) {
  return /decisionId:\s*([^\s]+)/.exec(message)?.[1] ?? null;
}

function chipTotal(state) {
  const stacks = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
  const committed = Object.values(state.hand?.contribs ?? {}).reduce((sum, value) => sum + value, 0);
  return stacks + committed;
}

function readLoopLog(gameDir) {
  return fs.readFileSync(path.join(gameDir, 'loop.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function setupAiFirst(t, {
  adapter,
  ai = 1,
  stack = 100,
  loopOpts = {},
} = {}) {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0, ...loopOpts },
  });
  t.after(() => loop.requestStop());
  await loop.bootstrap({ ai, stack });
  putAiFirst(gameDir);
  return { gameDir, loop };
}

async function setupUserFirst(t, { loopOpts = {}, adapter = makeAdapter() } = {}) {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 40, ...loopOpts },
  });
  t.after(() => loop.requestStop());
  await loop.bootstrap({ ai: 1, stack: 500 });
  return { gameDir, loop, adapter };
}

async function holdNamedLock(gameDir, name) {
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

function narrationTexts(gameDir) {
  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  return (snapshot.log ?? [])
    .filter((entry) => entry.type === 'narration')
    .map((entry) => entry.text);
}

async function runUntilUserBoundary(loop, gameDir) {
  const running = startRun(loop);
  await waitForUserSnapshot(gameDir);
  await stopRun(loop, running);
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
  const loop = createGameLoop({ gameDir, resolver, opts: { port: 0, waitMs: 0 } });
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
  await runUntilUserBoundary(loop, gameDir);

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

test('warmup failure waits for every sibling to settle before adapter cleanup and bootstrap rejection', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const completed = [];
  let inFlight = 0;
  let disposedAfter = null;
  const adapter = {
    kind: 'fake',
    watchdog: { t1Ms: 25, t2Ms: 15 },
    async warmup({ playerId }) {
      inFlight += 1;
      try {
        if (playerId === 'p1') throw Object.assign(new Error('warmup failed'), { code: 'WARMUP_FAILED' });
        await new Promise((resolve) => setTimeout(resolve, 120));
        completed.push(playerId);
        return { sessionId: `session-${playerId}`, raw: 'ready' };
      } finally {
        inFlight -= 1;
      }
    },
    async dispose() { disposedAfter = [...completed]; },
  };
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0 } });
  t.after(() => loop.requestStop());

  const started = Date.now();
  await assert.rejects(loop.bootstrap({ ai: 3 }), (error) => error.code === 'WARMUP_FAILED');
  assert.equal(Date.now() - started >= 100, true, 'bootstrap rejected before delayed siblings settled');
  assert.deepEqual(completed.sort(), ['p2', 'p3']);
  assert.equal(inFlight, 0);
  assert.deepEqual(disposedAfter.sort(), ['p2', 'p3']);
  assert.equal(fs.existsSync(path.join(gameDir, '.player-sessions.json')), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
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

test('two bootstrap processes racing on one game directory produce exactly one owner', { timeout: 15_000 }, async (t) => {
  const gameDir = tmpGame();
  const workers = [spawnBootstrapWorker(gameDir), spawnBootstrapWorker(gameDir)];
  t.after(() => Promise.all(workers.map((child) => terminateIfAlive(child))));

  const results = await Promise.all(workers.map(async (child) => JSON.parse(await readLine(child, 10_000))));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.equal(
    ['ACTIVE_GAME', 'LOCKED', 'LOOP_LOCK_UNKNOWN'].includes(results.find((result) => !result.ok).code),
    true,
    JSON.stringify(results),
  );
  const winner = workers[results.findIndex((result) => result.ok)];
  assert.equal(
    Number(fs.readFileSync(path.join(gameDir, 'loop.lock.d', 'pid'), 'utf8').split('\n')[0]),
    winner.pid,
  );
  winner.kill('SIGTERM');
  await waitUntilDead(winner.pid, 4_000);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('a positively dead loop lock is reclaimed before bootstrap without force', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const deadOwner = await startOwnedLoopHolder(gameDir);
  const recorded = fs.readFileSync(path.join(gameDir, 'loop.lock.d', 'pid'), 'utf8');
  deadOwner.kill('SIGKILL');
  await waitUntilDead(deadOwner.pid);
  assert.match(recorded, new RegExp(`^${deadOwner.pid}\\n`));

  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0 },
  });
  t.after(() => loop.requestStop());
  await loop.bootstrap({ ai: 1 });
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).phase, 'playing');
  assert.notEqual(fs.readFileSync(path.join(gameDir, 'loop.lock.d', 'pid'), 'utf8'), recorded);
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

test('resume adopts a healthy external server and requestStop identity-confirms its death', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap',
    sessionToken: init.sessionToken,
    gameEpoch: init.sessionToken,
    ownerSessionId: 'old-owner',
    startedAt: '2026-08-30T00:00:00.000Z',
    notices: [],
    metrics: [],
  }));
  const external = await startExternalServer(gameDir, init.sessionToken);
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(external.child);
  });

  await loop.resume();
  assert.equal(loop.serverPid, external.child.pid);
  await loop.requestStop();
  await waitUntilDead(external.child.pid);
  assert.equal(external.child.exitCode !== null || external.child.signalCode !== null, true);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('requestStop fails closed without signalling an adopted server when identity revalidation is unavailable', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap',
    sessionToken: init.sessionToken,
    gameEpoch: init.sessionToken,
    ownerSessionId: 'old-owner',
    startedAt: '2026-08-30T00:00:00.000Z',
    notices: [],
    metrics: [],
  }));
  const external = await startExternalServer(gameDir, init.sessionToken);
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(() => terminateIfAlive(external.child));
  await loop.resume();

  await withFakePs('exit 1', async () => {
    await assert.rejects(
      loop.requestStop(),
      (error) => error.code === 'SERVER_IDENTITY_UNAVAILABLE',
    );
  });
  assert.doesNotThrow(() => process.kill(external.child.pid, 0));
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('forged lock cannot bind an unrelated live pid to another healthy authenticated server', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: init.sessionToken,
    ownerSessionId: 'old-owner', startedAt: '2026-08-30T00:00:00.000Z', notices: [], metrics: [],
  }));
  const external = await startExternalServer(gameDir, init.sessionToken);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(gameDir, 'lock.json'), JSON.stringify({
    ...external.lock,
    serverPid: unrelated.pid,
  }));
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(async () => {
    await terminateIfAlive(external.child);
    await terminateIfAlive(unrelated);
  });

  await assert.rejects(loop.resume(), (error) => error.code === 'SERVER_LISTENER_MISMATCH');
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  assert.doesNotThrow(() => process.kill(external.child.pid, 0));
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('listener ownership without token-authenticated snapshot is never adopted', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: init.sessionToken,
    ownerSessionId: 'old-owner', startedAt: '2026-08-30T00:00:00.000Z', notices: [], metrics: [],
  }));
  const fake = await startHealthOnlyServer();
  fs.writeFileSync(path.join(gameDir, 'lock.json'), JSON.stringify({
    serverPid: fake.child.pid,
    port: fake.port,
    sessionToken: init.sessionToken,
    startedAt: new Date().toISOString(),
  }));
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(() => terminateIfAlive(fake.child));

  await assert.rejects(loop.resume(), (error) => error.code === 'SERVER_AUTH_FAILED');
  assert.doesNotThrow(() => process.kill(fake.child.pid, 0));
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('snapshot endpoint that accepts a fresh wrong token is not treated as authenticated', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: init.sessionToken,
    ownerSessionId: 'old-owner', startedAt: '2026-08-30T00:00:00.000Z', notices: [], metrics: [],
  }));
  const fake = await startHealthOnlyServer({ acceptsEveryToken: true });
  fs.writeFileSync(path.join(gameDir, 'lock.json'), JSON.stringify({
    serverPid: fake.child.pid,
    port: fake.port,
    sessionToken: init.sessionToken,
    startedAt: new Date().toISOString(),
  }));
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(() => terminateIfAlive(fake.child));

  await assert.rejects(loop.resume(), (error) => error.code === 'SERVER_AUTH_FAILED');
  assert.doesNotThrow(() => process.kill(fake.child.pid, 0));
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('missing or timed-out listener verifier fails closed without adopting or signalling', { timeout: 10_000 }, async (t) => {
  for (const mode of ['missing', 'timeout']) {
    await t.test(mode, async (st) => {
      const gameDir = tmpGame();
      const init = await initGame(gameDir);
      fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
        phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: init.sessionToken,
        ownerSessionId: 'old-owner', startedAt: '2026-08-30T00:00:00.000Z', notices: [], metrics: [],
      }));
      const external = await startExternalServer(gameDir, init.sessionToken);
      st.after(() => terminateIfAlive(external.child));
      let lsofPath = path.join(gameDir, 'missing-lsof');
      if (mode === 'timeout') {
        lsofPath = path.join(gameDir, 'slow-lsof');
        fs.writeFileSync(lsofPath, '#!/bin/sh\nsleep 5\n');
        fs.chmodSync(lsofPath, 0o755);
      }
      const loop = createGameLoop({
        gameDir,
        resolver: resolverFor(makeAdapter()),
        opts: { port: 0, lsofPath, osVerifyMs: 50 },
      });

      await assert.rejects(loop.resume(), (error) => error.code === 'SERVER_LISTENER_UNAVAILABLE');
      assert.doesNotThrow(() => process.kill(external.child.pid, 0));
      assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
    });
  }
});

test('present invalid or falsy lock.json fails closed without spawn, adoption, or signal', { timeout: 20_000 }, async (t) => {
  const cases = [
    ['malformed-json', '{'],
    ['null', 'null'],
    ['false', 'false'],
    ['zero', '0'],
    ['empty-string', '""'],
    ['array', '[]'],
    ['missing-pid', (lock) => JSON.stringify({ port: lock.port, sessionToken: lock.sessionToken })],
    ['missing-port', (lock) => JSON.stringify({ serverPid: lock.serverPid, sessionToken: lock.sessionToken })],
    ['missing-token', (lock) => JSON.stringify({ serverPid: lock.serverPid, port: lock.port })],
  ];

  for (const [label, rawOrBuilder] of cases) {
    await t.test(label, async (st) => {
      const gameDir = tmpGame();
      const init = await initGame(gameDir);
      fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
        phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: init.sessionToken,
        ownerSessionId: 'old-owner', startedAt: '2026-08-30T00:00:00.000Z', notices: [], metrics: [],
      }));
      const external = await startExternalServer(gameDir, init.sessionToken);
      const raw = typeof rawOrBuilder === 'function' ? rawOrBuilder(external.lock) : rawOrBuilder;
      const lockPath = path.join(gameDir, 'lock.json');
      fs.writeFileSync(lockPath, raw);
      const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
      st.after(async () => {
        await loop.requestStop().catch(() => {});
        await terminateIfAlive(external.child);
      });

      await assert.rejects(loop.resume(), (error) => error.code === 'BAD_SERVER_LOCK');
      assert.equal(fs.readFileSync(lockPath, 'utf8'), raw, 'invalid lock was replaced by a spawned server');
      assert.doesNotThrow(() => process.kill(external.child.pid, 0));
      const snapshot = await fetch(
        `http://127.0.0.1:${external.lock.port}/api/snapshot?token=${init.sessionToken}`,
      );
      assert.equal(snapshot.ok, true, 'preserved external server stopped responding');
      assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
    });
  }
});

test('bootstrap validates present invalid lock.json before init, archive, spawn, or signal', { timeout: 20_000 }, async (t) => {
  const cases = [
    ['malformed-json', '{'],
    ['null', 'null'],
    ['false', 'false'],
    ['zero', '0'],
    ['empty-string', '""'],
    ['array', '[]'],
    ['missing-pid', (lock) => JSON.stringify({ port: lock.port, sessionToken: lock.sessionToken })],
    ['missing-port', (lock) => JSON.stringify({ serverPid: lock.serverPid, sessionToken: lock.sessionToken })],
    ['missing-token', (lock) => JSON.stringify({ serverPid: lock.serverPid, port: lock.port })],
  ];

  for (const [label, rawOrBuilder] of cases) {
    await t.test(label, async (st) => {
      const gameDir = tmpGame();
      const init = await initGame(gameDir);
      fs.writeFileSync(path.join(gameDir, 'must-survive-bootstrap.txt'), 'original-game');
      fs.mkdirSync(path.join(gameDir, 'archive', 'keep-existing'), { recursive: true });
      fs.writeFileSync(path.join(gameDir, 'archive', 'keep-existing', 'receipt.txt'), 'keep');
      const external = await startExternalServer(gameDir, init.sessionToken);
      const raw = typeof rawOrBuilder === 'function' ? rawOrBuilder(external.lock) : rawOrBuilder;
      fs.writeFileSync(path.join(gameDir, 'lock.json'), raw);
      const before = snapshotTree(gameDir);
      let resolverCalls = 0;
      const loop = createGameLoop({
        gameDir,
        resolver: async (...args) => {
          resolverCalls += 1;
          return resolverFor(makeAdapter())(...args);
        },
        opts: { port: 0 },
      });
      st.after(async () => {
        await loop.requestStop().catch(() => {});
        await terminateIfAlive(external.child);
      });

      await assert.rejects(loop.bootstrap({ ai: 2 }), (error) => error.code === 'BAD_SERVER_LOCK');
      assert.equal(resolverCalls, 0, 'resolver ran after a present-invalid pre-init lock');
      assert.deepEqual(snapshotTree(gameDir), before, 'init/archive/spawn changed the game tree');
      assert.doesNotThrow(() => process.kill(external.child.pid, 0));
      const snapshot = await fetch(
        `http://127.0.0.1:${external.lock.port}/api/snapshot?token=${init.sessionToken}`,
      );
      assert.equal(snapshot.ok, true, 'preserved external server stopped responding');
    });
  }
});

test('adopted server startTime mismatch after capture is never signalled', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: init.sessionToken,
    ownerSessionId: 'old-owner', startedAt: '2026-08-30T00:00:00.000Z', notices: [], metrics: [],
  }));
  const external = await startExternalServer(gameDir, init.sessionToken);
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(() => terminateIfAlive(external.child));
  await loop.resume();

  await withFakePs(
    `if [ "$2" = "${external.child.pid}" ]; then echo 'Mon Jan  1 00:00:00 2001'; exit 0; fi\nexec ${REAL_PS} "$@"`,
    async () => assert.rejects(loop.requestStop(), (error) => error.code === 'SERVER_IDENTITY_MISMATCH'),
  );
  assert.doesNotThrow(() => process.kill(external.child.pid, 0));
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('direct server child startTime mismatch is rechecked before the first stop signal', { timeout: 10_000, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0 },
  });
  await loop.bootstrap({ ai: 1, stack: 100 });
  const serverPid = loop.serverPid;
  const marker = path.join(os.tmpdir(), `holdem-direct-server-reused-${process.pid}-${Date.now()}`);
  fs.writeFileSync(marker, 'reused');
  t.after(async () => {
    try { process.kill(serverPid, 'SIGKILL'); } catch { /* already dead */ }
    await waitUntilDead(serverPid).catch(() => {});
    try { fs.unlinkSync(marker); } catch { /* absent */ }
  });

  await withFakePs(
    `if [ "$2" = "${serverPid}" ] && [ -f "${marker}" ]; then echo 'Mon Jan  1 00:00:00 2001'; exit 0; fi\nexec ${REAL_PS} "$@"`,
    async () => assert.rejects(
      loop.requestStop(),
      (error) => error.code === 'SERVER_IDENTITY_MISMATCH',
    ),
  );
  assert.doesNotThrow(() => process.kill(serverPid, 0), 'identity mismatch server child was signalled');
});

test('TERM-resistant adopted server is KILLed and death-confirmed', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: init.sessionToken,
    ownerSessionId: 'old-owner', startedAt: '2026-08-30T00:00:00.000Z', notices: [], metrics: [],
  }));
  const external = await startExternalServer(gameDir, init.sessionToken, { ignoreTerm: true });
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(external.child);
  });
  await loop.resume();

  await loop.requestStop();
  await waitUntilDead(external.child.pid);
  assert.equal(external.child.signalCode, 'SIGKILL');
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('resume derives a missing loop state from engine state, but an entirely absent game releases the lock and fails', { timeout: 10_000 }, async (t) => {
  const emptyDir = tmpGame();
  const absent = createGameLoop({
    gameDir: emptyDir,
    resolver: async () => assert.fail('resolver must not run for an absent game'),
  });
  await assert.rejects(absent.resume(), (error) => error.code === 'NO_GAME');
  assert.equal(fs.existsSync(path.join(emptyDir, 'loop.lock.d')), false);
  assert.equal(fs.existsSync(path.join(emptyDir, 'loop.log')), false);

  const orphanDir = tmpGame();
  fs.writeFileSync(path.join(orphanDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap',
    sessionToken: 'orphan-token',
    notices: [],
    metrics: [],
  }));
  const orphan = createGameLoop({
    gameDir: orphanDir,
    resolver: async () => assert.fail('resolver must not run without engine state'),
  });
  await assert.rejects(orphan.resume(), (error) => error.code === 'NO_GAME');
  assert.equal(fs.existsSync(path.join(orphanDir, 'loop.lock.d')), false);
  assert.equal(fs.existsSync(path.join(orphanDir, 'loop.log')), false);

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

test('playing resume seeds the checked hand so its archive is checked exactly once', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const original = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  await original.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  let envelope = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'step', '--new-hand', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  envelope = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'step', envelope.next.toAct, 'fold',
    '--expect-version', String(envelope.stateVersion), '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  assert.equal(envelope.handOver, true);
  const archive = path.join(gameDir, 'hands', 'hand-0001.json');
  fs.unlinkSync(archive);
  await original.requestStop();
  fs.rmSync(path.join(gameDir, 'lock.json'), { force: true });

  const resumed = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  t.after(() => resumed.requestStop());
  await resumed.resume();
  await runUntilUserBoundary(resumed, gameDir);

  assert.equal(fs.existsSync(archive), true);
  const checks = readLoopLog(gameDir).filter((entry) => (
    entry.event === 'resume-archive-check' || entry.event === 'archive-resume-check'
  ));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].event, 'resume-archive-check');
  assert.equal(checks[0].handNo, 1);
});

test('resumed archivePending for the pre-checked hand is suppressed without a second resume-check', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const original = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  await original.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  const active = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'step', '--new-hand', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  assert.equal(active.next.toAct, 'p1');
  await original.requestStop();
  fs.rmSync(path.join(gameDir, 'lock.json'), { force: true });

  const adapter = makeAdapter({
    onDecide: async ({ message }) => {
      fs.mkdirSync(path.join(gameDir, 'hands', 'hand-0001.json'), { recursive: true });
      return { raw: JSON.stringify({ decisionId: decisionIdOfMessage(message), action: 'fold' }) };
    },
  });
  const resumed = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0 },
  });
  t.after(() => resumed.requestStop());
  await resumed.resume();

  await runUntilUserBoundary(resumed, gameDir);

  const checks = readLoopLog(gameDir).filter((entry) => (
    entry.event === 'resume-archive-check' || entry.event === 'archive-resume-check'
  ));
  assert.deepEqual(checks.map((entry) => [entry.event, entry.handNo]), [
    ['resume-archive-check', 1],
  ]);
  assert.equal(fs.statSync(path.join(gameDir, 'hands', 'hand-0001.json')).isDirectory(), true);
});

test('playing starts a hand, accepts a tolerant AI decision, and preserves every chip before the 5C user boundary', { timeout: 10_000 }, async (t) => {
  const adapter = makeAdapter({
    onDecide: async ({ message }) => ({
      raw: `결정입니다.\n\`\`\`json\n${JSON.stringify({
        decisionId: decisionIdOfMessage(message),
        action: 'fold',
      })}\n\`\`\``,
    }),
  });
  const { gameDir, loop } = await setupAiFirst(t, { adapter });

  await runUntilUserBoundary(loop, gameDir);

  const engine = readJson(path.join(gameDir, 'state.json'));
  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(chipTotal(engine), 200);
  assert.equal(engine.lastHand.actions[0].playerId, 'p1');
  assert.equal(engine.lastHand.actions[0].action, 'fold');
  assert.equal(adapter.decideCalls.length, 1);
  assert.equal(state.metrics.length, 1);
  assert.equal(state.metrics[0].outcome, 'accepted');
  assert.equal(state.lastPublishId >= 3, true, 'first hand/action/next hand were not all published');
});

test('watchdog resends the identical AI summary once, then force-defaults and records the timeout outcome', { timeout: 10_000 }, async (t) => {
  const adapter = makeAdapter({
    onDecide: async ({ timeoutMs }) => new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error('adapter timeout');
        error.code = 'TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  });
  const { gameDir, loop } = await setupAiFirst(t, {
    adapter,
    loopOpts: { watchdog: { t1Ms: 20, t2Ms: 15 } },
  });

  await runUntilUserBoundary(loop, gameDir);

  assert.equal(adapter.decideCalls.length, 2);
  assert.equal(adapter.decideCalls[0].message, adapter.decideCalls[1].message);
  assert.equal(adapter.decideCalls[0].sessionId, adapter.decideCalls[1].sessionId);
  assert.deepEqual(adapter.decideCalls.map((call) => call.timeoutMs), [20, 15]);
  const metric = readJson(path.join(gameDir, 'loop-state.json')).metrics[0];
  assert.equal(metric.outcome, 'forced_default');
  assert.equal(readJson(path.join(gameDir, 'state.json')).lastHand.actions[0].action, 'fold');
});

test('T2 never overlaps an unresolved T1 and a late T1 rejection cannot affect the applied decision', { timeout: 10_000 }, async (t) => {
  let active = 0;
  let maxActive = 0;
  let firstSettled = false;
  let secondStartedBeforeFirstSettled = false;
  const adapter = makeAdapter({
    onDecide: async ({ message }, attempt) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        active -= 1;
        firstSettled = true;
        const error = new Error('late adapter timeout');
        error.code = 'TIMEOUT';
        throw error;
      }
      secondStartedBeforeFirstSettled = !firstSettled;
      active -= 1;
      return { raw: JSON.stringify({ decisionId: decisionIdOfMessage(message), action: 'fold' }) };
    },
  });
  const { gameDir, loop } = await setupAiFirst(t, {
    adapter,
    loopOpts: { watchdog: { t1Ms: 10, t2Ms: 20 } },
  });

  await runUntilUserBoundary(loop, gameDir);
  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.equal(maxActive, 1);
  assert.equal(secondStartedBeforeFirstSettled, false);
  assert.equal(adapter.decideCalls.length, 2);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).metrics[0].outcome, 'retried_accepted');
  assert.equal(readJson(path.join(gameDir, 'state.json')).lastHand.actions[0].action, 'fold');
});

test('engine first ILLEGAL_ACTION retries the same AI summary once and applies the accepted retry', { timeout: 10_000 }, async (t) => {
  let gameDir = null;
  const adapter = makeAdapter({
    onDecide: async ({ message }, attempt) => {
      if (attempt === 1) makeCurrentActorCanCheck(gameDir);
      return { raw: JSON.stringify({
        decisionId: decisionIdOfMessage(message),
        action: attempt === 1 ? 'call' : 'fold',
      }) };
    },
  });
  const setup = await setupAiFirst(t, { adapter });
  gameDir = setup.gameDir;

  await runUntilUserBoundary(setup.loop, gameDir);

  assert.equal(adapter.decideCalls.length, 2);
  assert.equal(adapter.decideCalls[0].message, adapter.decideCalls[1].message);
  const engine = readJson(path.join(gameDir, 'state.json'));
  assert.equal(engine.lastHand.actions.length, 1);
  assert.equal(engine.lastHand.actions[0].action, 'fold');
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).metrics[0].outcome, 'retried_accepted');
});

test('two engine ILLEGAL_ACTION rejections force-default without a third model request', { timeout: 10_000 }, async (t) => {
  let gameDir = null;
  const adapter = makeAdapter({
    onDecide: async ({ message }, attempt) => {
      if (attempt === 1) makeCurrentActorCanCheck(gameDir);
      return { raw: JSON.stringify({ decisionId: decisionIdOfMessage(message), action: 'call' }) };
    },
  });
  const setup = await setupAiFirst(t, { adapter });
  gameDir = setup.gameDir;

  await runUntilUserBoundary(setup.loop, gameDir);

  assert.equal(adapter.decideCalls.length, 2);
  const engine = readJson(path.join(gameDir, 'state.json'));
  assert.equal(engine.hand.actions.length, 1);
  assert.equal(engine.hand.actions[0].action, 'check');
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).metrics[0].outcome, 'forced_default');
});

test('malformed, mismatched, and illegal AI decisions each get one retry before force-default', { timeout: 20_000 }, async (t) => {
  const cases = [
    ['malformed', () => 'not-json'],
    ['decision-mismatch', () => JSON.stringify({ decisionId: 'stale-decision', action: 'fold' })],
    ['illegal-action', ({ message }) => JSON.stringify({
      decisionId: decisionIdOfMessage(message),
      action: 'check',
    })],
  ];

  for (const [label, response] of cases) {
    await t.test(label, async (st) => {
      const adapter = makeAdapter({
        onDecide: async (input) => ({ raw: response(input) }),
      });
      const { gameDir, loop } = await setupAiFirst(st, { adapter });
      await runUntilUserBoundary(loop, gameDir);
      assert.equal(adapter.decideCalls.length, 2);
      assert.equal(adapter.decideCalls[0].message, adapter.decideCalls[1].message);
      assert.equal(readJson(path.join(gameDir, 'loop-state.json')).metrics[0].outcome, 'forced_default');
    });
  }
});

test('a valid second response after parse failure is recorded as retried_accepted', { timeout: 10_000 }, async (t) => {
  const adapter = makeAdapter({
    onDecide: async ({ message }, attempt) => ({
      raw: attempt === 1
        ? 'garbage'
        : JSON.stringify({ decisionId: decisionIdOfMessage(message), action: 'fold' }),
    }),
  });
  const { gameDir, loop } = await setupAiFirst(t, { adapter });

  await runUntilUserBoundary(loop, gameDir);

  assert.equal(adapter.decideCalls.length, 2);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).metrics[0].outcome, 'retried_accepted');
});

test('adapter runtime watchdog is used when opts.watchdog is absent', { timeout: 10_000 }, async (t) => {
  const adapter = makeAdapter({
    kind: 'codex',
    watchdog: null,
    onDecide: async () => ({ raw: 'invalid' }),
  });
  const { gameDir, loop } = await setupAiFirst(t, { adapter });

  await runUntilUserBoundary(loop, gameDir);

  assert.deepEqual(
    adapter.decideCalls.map((call) => call.timeoutMs),
    [RUNTIME_TABLE.codex.watchdog.t1Ms, RUNTIME_TABLE.codex.watchdog.t2Ms],
  );
});

test('zero-delay AI metrics include every timing field and keep non-model overhead under one second', { timeout: 10_000 }, async (t) => {
  const adapter = makeAdapter();
  const { gameDir, loop } = await setupAiFirst(t, { adapter });

  await runUntilUserBoundary(loop, gameDir);

  const [metric] = readJson(path.join(gameDir, 'loop-state.json')).metrics;
  assert.deepEqual(Object.keys(metric).sort(), [
    'decisionId', 'elapsedMs', 'modelMs', 'outcome', 'parseMs',
    'playerId', 'publishMs', 'runtime', 'stepMs',
  ]);
  for (const field of ['elapsedMs', 'modelMs', 'parseMs', 'stepMs', 'publishMs']) {
    assert.equal(Number.isFinite(metric[field]) && metric[field] >= 0, true, `${field} is invalid`);
  }
  assert.equal(metric.parseMs + metric.stepMs + metric.publishMs <= 1_000, true);
});

test('archivePending runs resume-check once and repair_failed halts before a new hand', { timeout: 10_000 }, async (t) => {
  const adapter = makeAdapter();
  const { gameDir, loop } = await setupAiFirst(t, { adapter });
  fs.mkdirSync(path.join(gameDir, 'hands', 'hand-0001.json'), { recursive: true });

  await assert.rejects(loop.run(), (error) => error.code === 'repair_failed');

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(state.halt.code, 'repair_failed');
  assert.equal(state.handNo, 1);
  assert.equal(
    readLoopLog(gameDir).filter((entry) => entry.event === 'archive-resume-check').length,
    1,
  );
});

test('VERSION_MISMATCH discards the stale model decision, resynchronizes with an argumentless step, and continues', { timeout: 10_000 }, async (t) => {
  let gameDir = null;
  const adapter = makeAdapter({
    onDecide: async ({ playerId, message }, attempt) => {
      if (attempt === 1) {
        const version = readJson(path.join(gameDir, 'state.json')).stateVersion;
        await execFileAsync(process.execPath, [
          CLI, 'step', playerId, 'fold', '--expect-version', String(version), '--game-dir', gameDir,
        ], { encoding: 'utf8', timeout: 5_000 });
      }
      return { raw: JSON.stringify({ decisionId: decisionIdOfMessage(message), action: 'fold' }) };
    },
  });
  const setup = await setupAiFirst(t, { adapter });
  gameDir = setup.gameDir;

  await runUntilUserBoundary(setup.loop, gameDir);

  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).metrics.length, 0);
  assert.equal(
    readLoopLog(gameDir).filter((entry) => entry.event === 'version-resync').length,
    1,
  );
  assert.equal(readJson(path.join(gameDir, 'state.json')).lastHand.actions[0].playerId, 'p1');
});

test('ATTEMPT_PENDING is retried before the current AI transition publish', { timeout: 10_000 }, async (t) => {
  const adapter = makeAdapter();
  const { gameDir, loop } = await setupAiFirst(t, { adapter });
  const engine = readJson(path.join(gameDir, 'state.json'));
  fs.writeFileSync(path.join(gameDir, '.publish-attempt.json'), JSON.stringify({
    body: { publishId: 1, messages: [{ type: 'narration', text: 'pending-before-loop' }] },
    expectedGameEpoch: gameEpochOf(engine.sessionToken),
  }));

  await runUntilUserBoundary(loop, gameDir);

  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).lastPublishId >= 4, true);
});

test('PUBLISH_FAILED after the owned server dies restarts it and retries the recorded attempt', { timeout: 20_000 }, async (t) => {
  const adapter = makeAdapter();
  const { gameDir, loop } = await setupAiFirst(t, { adapter });
  const oldPid = loop.serverPid;
  process.kill(oldPid, 'SIGKILL');
  await waitUntilDead(oldPid);

  await runUntilUserBoundary(loop, gameDir);

  assert.notEqual(loop.serverPid, oldPid);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
  assert.equal(readLoopLog(gameDir).some((entry) => entry.event === 'server-recovered'), true);
});

test('user timeouts repeat wait-only indefinitely and never force-default before the submitted raise', { timeout: 10_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, { loopOpts: { waitMs: 30 } });
  const running = startRun(loop);

  await waitWhileRunning(running, () => (
    readLoopLog(gameDir).filter((entry) => entry.event === 'user-wait-timeout').length >= 3
  ), 'three user wait-only timeouts were not observed');
  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  const action = preferredUserAction(snapshot.view.legal);
  assert.equal(action.action, 'raise', 'fixture must distinguish a real user action from force-default');
  assert.deepEqual(await postUserAction(lock, action), { status: 200, body: { ok: true } });
  const applied = await waitWhileRunning(
    running,
    () => waitForUserAction(gameDir, (entry) => entry.action === 'raise'),
    'submitted user raise was not applied',
  );
  assert.equal(applied.decisionId, action.decisionId);

  await stopRun(loop, running);
  const userActions = [
    ...(readJson(path.join(gameDir, 'state.json')).hand?.actions ?? []),
    ...(readJson(path.join(gameDir, 'state.json')).lastHand?.actions ?? []),
  ].filter((entry) => entry.playerId === 'user');
  assert.equal(userActions[0].action, 'raise');
  assert.equal(readLoopLog(gameDir).some((entry) => entry.event === 'user-force-default'), false);
});

test('user action·amount의 의미 플래그는 engine argv로 넘어가지 않고 같은 결정을 다시 기다린다', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, { loopOpts: { waitMs: 35 } });
  const running = startRun(loop);
  let current = await waitForUserSnapshot(gameDir);
  const decisionId = current.snapshot.view.legal.decisionId;
  const invalids = [
    { decisionId, action: '--force-default' },
    { decisionId, action: 'raise', amount: '--force-default' },
    { decisionId, action: 'raise', amount: 1.5 },
    { decisionId, action: 'raise', amount: 0 },
    { decisionId, action: 'fold', amount: 1 },
  ];

  for (const payload of invalids) {
    const rejectedBefore = readLoopLog(gameDir)
      .filter((entry) => entry.event === 'user-action-rejected').length;
    assert.deepEqual(await postUserAction(current.lock, payload), { status: 200, body: { ok: true } });
    await waitWhileRunning(running, () => (
      readLoopLog(gameDir).filter((entry) => entry.event === 'user-action-rejected').length > rejectedBefore
    ), `invalid user payload was not rejected: ${JSON.stringify(payload)}`);
    assert.equal((readJson(path.join(gameDir, 'state.json')).hand?.actions ?? []).length, 0,
      `invalid payload reached engine mutation: ${JSON.stringify(payload)}`);
    current = await waitForUserSnapshot(gameDir);
    assert.equal(current.snapshot.view.legal.decisionId, decisionId);
  }

  const valid = preferredUserAction(current.snapshot.view.legal);
  await postUserAction(current.lock, valid);
  const applied = await waitWhileRunning(
    running,
    () => waitForUserAction(gameDir, (entry) => entry.decisionId === decisionId),
    'valid user action was not accepted after invalid payloads',
  );
  assert.equal(applied.action, valid.action);
  await stopRun(loop, running);
});

test('stale user decision is discarded and the same current decision is re-waited', { timeout: 10_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, { loopOpts: { waitMs: 35 } });
  const running = startRun(loop);
  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  const current = snapshot.view.legal.decisionId;

  assert.deepEqual(await postUserAction(lock, {
    decisionId: `${current}-stale`, action: 'fold',
  }), { status: 409, body: { ok: false, code: 'STALE_DECISION' } });
  await waitWhileRunning(running, () => (
    readLoopLog(gameDir).filter((entry) => entry.event === 'user-wait-timeout').length >= 2
  ), 'sidecar did not continue waiting after a stale action');
  assert.equal((readJson(path.join(gameDir, 'state.json')).hand?.actions ?? []).length, 0);

  const refreshed = await waitForUserSnapshot(gameDir);
  assert.equal(refreshed.snapshot.view.legal.decisionId, current);
  const action = preferredUserAction(refreshed.snapshot.view.legal);
  await postUserAction(refreshed.lock, action);
  await waitWhileRunning(
    running,
    () => waitForUserAction(gameDir, (entry) => entry.decisionId === current),
    'current user action was not accepted after stale discard',
  );
  await stopRun(loop, running);
});

test('illegal user action resynchronizes, narrates, and waits again without folding the user', { timeout: 10_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, { loopOpts: { waitMs: 40 } });
  const running = startRun(loop);
  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  const legal = snapshot.view.legal;
  const illegal = {
    decisionId: legal.decisionId,
    action: 'raise',
    amount: legal.maxRaiseTo + 1,
  };
  assert.deepEqual(await postUserAction(lock, illegal), { status: 200, body: { ok: true } });

  await waitWhileRunning(running, () => (
    narrationTexts(gameDir).some((text) => text.includes('허용되지 않아'))
  ), 'illegal-action narration was not published');
  assert.equal((readJson(path.join(gameDir, 'state.json')).hand?.actions ?? []).length, 0);
  const refreshed = await waitForUserSnapshot(gameDir);
  assert.equal(refreshed.snapshot.view.legal.decisionId, legal.decisionId);
  const action = preferredUserAction(refreshed.snapshot.view.legal);
  await postUserAction(refreshed.lock, action);
  await waitWhileRunning(
    running,
    () => waitForUserAction(gameDir, (entry) => entry.decisionId === legal.decisionId),
    'user action was not accepted after illegal-action resync',
  );
  await stopRun(loop, running);
});

test('user VERSION_MISMATCH republishes the authoritative decision with narration and re-waits', { timeout: 10_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, { loopOpts: { waitMs: 40 } });
  const running = startRun(loop);
  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  const staleVersion = readJson(path.join(gameDir, 'state.json')).stateVersion;
  const externallyChanged = readJson(path.join(gameDir, 'state.json'));
  externallyChanged.stateVersion += 1;
  fs.writeFileSync(path.join(gameDir, 'state.json'), JSON.stringify(externallyChanged));
  await postUserAction(lock, preferredUserAction(snapshot.view.legal));

  await waitWhileRunning(running, () => (
    narrationTexts(gameDir).some((text) => text.includes('상태가 변경되어'))
  ), 'VERSION_MISMATCH narration was not published');
  assert.equal(readJson(path.join(gameDir, 'state.json')).stateVersion, staleVersion + 1);
  assert.equal((readJson(path.join(gameDir, 'state.json')).hand?.actions ?? []).length, 0);
  const refreshed = await waitForUserSnapshot(gameDir);
  await postUserAction(refreshed.lock, preferredUserAction(refreshed.snapshot.view.legal));
  await waitWhileRunning(
    running,
    () => waitForUserAction(gameDir),
    'user action was not accepted after VERSION_MISMATCH resync',
  );
  await stopRun(loop, running);
});

test('user waitError restarts a dead server, republishes view-only, and re-waits for the action', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, { loopOpts: { waitMs: 1_000 } });
  const oldPid = loop.serverPid;
  const running = startRun(loop);
  await waitForUserSnapshot(gameDir);
  process.kill(oldPid, 'SIGKILL');
  await waitUntilDead(oldPid);

  await waitWhileRunning(running, () => (
    loop.serverPid !== null && loop.serverPid !== oldPid
      && readLoopLog(gameDir).some((entry) => entry.event === 'user-view-republished')
  ), 'waitError recovery did not restart and republish', 6_000);
  const { lock, snapshot } = await waitForUserSnapshot(gameDir, 6_000);
  await postUserAction(lock, preferredUserAction(snapshot.view.legal));
  await waitWhileRunning(
    running,
    () => waitForUserAction(gameDir),
    'user action was not accepted after waitError recovery',
    6_000,
  );
  await stopRun(loop, running);
  const events = readLoopLog(gameDir).map((entry) => entry.event);
  assert.equal(events.includes('user-wait-error'), true);
  assert.equal(events.includes('server-recovered'), true);
  assert.equal(events.includes('user-view-republished'), true);
});

test('AI 3 plus user reaches the Task 7 boundary through the real loop with chips preserved', { timeout: 25_000 }, async (t) => {
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

  await assert.rejects(running, (error) => error.code === 'FINALIZATION_TASK_7');
  await driver;
  const engine = readJson(path.join(gameDir, 'state.json'));
  assert.equal(chipTotal(engine), 400);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).phase, 'finalizing');
  assert.equal(adapter.decideCalls.length > 0, true);
  assert.equal(sent.size > 0, true);
});

test('requestStop lets the in-flight step+publish unit commit before child and server cleanup', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, { loopOpts: { waitMs: 0 } });
  const serverPid = loop.serverPid;
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  const running = startRun(loop);
  await waitFor(() => readJson(path.join(gameDir, 'state.json')).hand !== null, 'step did not start a hand');

  const stopping = loop.requestStop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true, 'lock released before atomic publish');
  held.release();
  await held.done;
  await stopping;
  await running;

  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(snapshot.view.handNo, 1);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).stoppedAt != null, true);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
  await waitUntilDead(serverPid);
});

test('D9 never restarts the server while stopping and preserves the failed publish attempt for resume', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, { loopOpts: { waitMs: 0 } });
  const oldPid = loop.serverPid;
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  const running = startRun(loop);
  await waitFor(() => readJson(path.join(gameDir, 'state.json')).hand !== null, 'step did not start a hand');
  process.kill(oldPid, 'SIGKILL');
  await waitUntilDead(oldPid);

  const stopping = loop.requestStop();
  held.release();
  await held.done;
  await assert.rejects(running, (error) => error.code === 'STOPPING');
  await stopping;

  assert.equal(loop.serverPid, null);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), true);
  assert.equal(readLoopLog(gameDir).some((entry) => entry.event === 'server-recovered'), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);

  const resumed = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  t.after(() => resumed.requestStop());
  await resumed.resume();
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).stopping, false);
  const resumedRun = startRun(resumed);
  await waitWhileRunning(
    resumedRun,
    () => waitForUserSnapshot(gameDir),
    'resume did not recover the pending publish and user decision',
  );
  await waitWhileRunning(
    resumedRun,
    () => readLoopLog(gameDir).some((entry) => entry.event === 'user-wait-timeout'),
    'resume entry publish had not settled into the user wait loop',
  );
  await stopRun(resumed, resumedRun);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
});

test('SIGTERM waits for the real in-flight publish, records stop state, and removes its server child', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  const loopUrl = pathToFileURL(path.join(ROOT, 'tools/game-loop.js')).href;
  const script = `
    import { createGameLoop } from ${JSON.stringify(loopUrl)};
    const adapter = {
      kind: 'fake', watchdog: {t1Ms: 10, t2Ms: 10},
      async warmup({playerId}) { return {sessionId: 's-' + playerId, raw: 'ready'}; },
      async decide() { return {raw: '{}'}; },
      async dispose() {}
    };
    const loop = createGameLoop({
      gameDir: ${JSON.stringify(gameDir)},
      resolver: async () => ({player: adapter, upper: adapter, notices: []}),
      opts: {port: 0, waitMs: 0}
    });
    let stopping = false;
    process.once('SIGTERM', async () => {
      if (stopping) return;
      stopping = true;
      try { await loop.requestStop(); process.exit(0); }
      catch { process.exit(5); }
    });
    await loop.bootstrap({ai: 1, stack: 500});
    process.stdout.write(JSON.stringify({ready: true, serverPid: loop.serverPid}) + '\\n');
    await loop.run();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    held.release();
    await held.done.catch(() => {});
    await terminateIfAlive(child);
  });
  const ready = JSON.parse(await readLine(child, 10_000));
  await waitFor(() => readJson(path.join(gameDir, 'state.json')).hand !== null, 'signal child step did not start');

  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.doesNotThrow(() => process.kill(child.pid, 0), 'sidecar exited before publish lock released');
  held.release();
  await held.done;
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(readJson(path.join(gameDir, 'ui-snapshot.json')).view.handNo, 1);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).stoppedAt != null, true);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
  await waitUntilDead(ready.serverPid);
});

test('--force stops loop, rereads replacement server identity, then stops that server before archive', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const signalLog = path.join(os.tmpdir(), `holdem-force-signals-${process.pid}-${Date.now()}.log`);
  const initialized = await initGame(gameDir);
  await execFileAsync(process.execPath, [CLI, 'step', '--new-hand', '--game-dir', gameDir], {
    encoding: 'utf8', timeout: 5_000,
  });
  fs.writeFileSync(path.join(gameDir, 'must-archive.txt'), 'old-game');
  const original = await startLoggedServer(gameDir, initialized.sessionToken, signalLog, 'original');
  const holder = await startReplacingLoopHolder(gameDir, initialized.sessionToken, signalLog);
  let replacementPid = null;
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, forceStopMs: 4_000 },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(holder);
    await terminateIfAlive(original.child);
    if (replacementPid) {
      try { process.kill(replacementPid, 'SIGKILL'); } catch { /* already dead */ }
    }
    try { fs.unlinkSync(signalLog); } catch { /* already gone */ }
  });

  const bootstrapped = await loop.bootstrap({ ai: 1, force: true });
  const lines = fs.readFileSync(signalLog, 'utf8').trim().split('\n');
  const readyLine = lines.find((line) => line.startsWith('replacement:ready:'));
  replacementPid = Number(readyLine?.split(':').at(-1));
  assert.deepEqual(lines.slice(0, 3).map((line) => line.replace(/:\d+$/, ':PID')), [
    'loop:SIGTERM',
    'replacement:ready:PID',
    'replacement:SIGTERM',
  ]);
  assert.equal(lines.includes('original:SIGTERM'), false, 'pre-loop server lock was not reread');
  assert.doesNotThrow(() => process.kill(original.child.pid, 0), 'stale pre-loop server was signalled');
  await waitUntilDead(replacementPid);
  assert.equal(bootstrapped.phase, 'playing');
  assert.equal(typeof bootstrapped.archivedTo, 'string');
  assert.equal(fs.existsSync(path.join(gameDir, bootstrapped.archivedTo, 'must-archive.txt')), true);
});

test('--force with no live loop rejects a forged unrelated server pid before any signal or archive', { timeout: 15_000 }, async (t) => {
  const gameDir = tmpGame();
  const initialized = await initGame(gameDir);
  await execFileAsync(process.execPath, [CLI, 'step', '--new-hand', '--game-dir', gameDir], {
    encoding: 'utf8', timeout: 5_000,
  });
  fs.writeFileSync(path.join(gameDir, 'must-survive-forged-force.txt'), 'old-game');
  const external = await startExternalServer(gameDir, initialized.sessionToken);
  const signalLog = path.join(os.tmpdir(), `holdem-forged-force-${process.pid}-${Date.now()}.log`);
  const unrelated = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    process.once('SIGTERM', () => {
      fs.appendFileSync(${JSON.stringify(signalLog)}, 'SIGTERM\\n');
      process.exit(0);
    });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(await readLine(unrelated), 'ready');

  const lockPath = path.join(gameDir, 'lock.json');
  fs.writeFileSync(lockPath, JSON.stringify({
    ...external.lock,
    serverPid: unrelated.pid,
  }));
  const before = snapshotTree(gameDir);
  let resolverCalls = 0;
  const loop = createGameLoop({
    gameDir,
    resolver: async (...args) => {
      resolverCalls += 1;
      return resolverFor(makeAdapter())(...args);
    },
    opts: { port: 0 },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(unrelated);
    await terminateIfAlive(external.child);
    try { fs.unlinkSync(signalLog); } catch { /* no signal */ }
  });

  await assert.rejects(
    loop.bootstrap({ ai: 1, force: true }),
    (error) => error.code === 'SERVER_LISTENER_MISMATCH',
  );
  assert.equal(resolverCalls, 0);
  assert.equal(fs.existsSync(signalLog), false, 'forged unrelated pid received a server signal');
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  assert.doesNotThrow(() => process.kill(external.child.pid, 0));
  assert.deepEqual(snapshotTree(gameDir), before);
});

test('--force leaves the game byte-for-byte unchanged when loop termination is unconfirmed', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'must-survive-force.txt'), 'old-game');
  const holder = await startOwnedLoopHolder(gameDir, { ignoreTerm: true });
  const before = snapshotTree(gameDir);
  const signals = [];
  let resolverCalls = 0;
  const loop = createGameLoop({
    gameDir,
    resolver: async () => { resolverCalls += 1; return resolverFor(makeAdapter())(); },
    opts: {
      port: 0,
      forceStopMs: 60,
      signalProcess: (pid, signal) => { signals.push([pid, signal]); },
    },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(holder);
  });

  await assert.rejects(loop.bootstrap({ ai: 1, force: true }), (error) => error.code === 'LOOP_ALIVE');
  assert.deepEqual(signals, [[holder.pid, 'SIGTERM'], [holder.pid, 'SIGKILL']]);
  assert.equal(resolverCalls, 0);
  assert.deepEqual(snapshotTree(gameDir), before);
  assert.doesNotThrow(() => process.kill(holder.pid, 0));
});

test('--force treats a reused-pid startTime mismatch as dead and never signals that process', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const signalLog = path.join(gameDir, 'pid-reuse-signals.log');
  const holder = await startOwnedLoopHolder(gameDir, { signalLog });
  fs.writeFileSync(
    path.join(gameDir, 'loop.lock.d', 'pid'),
    `${holder.pid}\nMon Jan  1 00:00:00 2001`,
  );
  const signals = [];
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: {
      port: 0,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        process.kill(pid, signal);
      },
    },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(holder);
  });

  await loop.bootstrap({ ai: 1, force: true });
  assert.deepEqual(signals, []);
  assert.equal(fs.existsSync(signalLog), false);
  assert.doesNotThrow(() => process.kill(holder.pid, 0));
  assert.notEqual(processStartTime(holder.pid), 'Mon Jan  1 00:00:00 2001');
});

test('--force treats loop pid reuse after TERM as an identity error, not death, and blocks archive plus KILL', { timeout: 10_000, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  await initGame(gameDir);
  await execFileAsync(process.execPath, [CLI, 'step', '--new-hand', '--game-dir', gameDir], {
    encoding: 'utf8', timeout: 5_000,
  });
  fs.writeFileSync(path.join(gameDir, 'must-survive-loop-reuse.txt'), 'old-game');
  const holder = await startOwnedLoopHolder(gameDir, { ignoreTerm: true });
  const marker = path.join(os.tmpdir(), `holdem-loop-reused-${process.pid}-${Date.now()}`);
  const before = snapshotTree(gameDir);
  const signals = [];
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: {
      port: 0,
      forceStopMs: 100,
      pollMs: 10,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === holder.pid && signal === 'SIGTERM') {
          fs.writeFileSync(marker, 'term-sent');
          return;
        }
        process.kill(pid, signal);
      },
    },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(holder);
    try { fs.unlinkSync(marker); } catch { /* absent */ }
  });

  await withFakePs(
    `if [ "$2" = "${holder.pid}" ] && [ -f "${marker}" ]; then echo 'Mon Jan  1 00:00:00 2001'; exit 0; fi\nexec ${REAL_PS} "$@"`,
    async () => assert.rejects(
      loop.bootstrap({ ai: 1, force: true }),
      (error) => error.code === 'LOOP_IDENTITY_MISMATCH',
    ),
  );
  assert.deepEqual(signals, [[holder.pid, 'SIGTERM']], 'pid reuse 후 추가 시그널을 보냈다');
  assert.doesNotThrow(() => process.kill(holder.pid, 0));
  assert.deepEqual(snapshotTree(gameDir), before);
});

test('--force rechecks server startTime immediately after async binding and before the first signal', { timeout: 15_000, concurrency: false }, async (t) => {
  if (!REAL_LSOF) {
    t.skip('lsof is required for authoritative listener binding');
    return;
  }
  const gameDir = tmpGame();
  const initialized = await initGame(gameDir);
  await execFileAsync(process.execPath, [CLI, 'step', '--new-hand', '--game-dir', gameDir], {
    encoding: 'utf8', timeout: 5_000,
  });
  fs.writeFileSync(path.join(gameDir, 'must-survive-adjacency.txt'), 'old-game');
  const external = await startExternalServer(gameDir, initialized.sessionToken);
  const holder = await startOwnedLoopHolder(gameDir);
  const marker = path.join(os.tmpdir(), `holdem-server-adjacency-${process.pid}-${Date.now()}`);
  const lsofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-loop-lsof-'));
  const lsofPath = path.join(lsofDir, 'lsof');
  fs.writeFileSync(lsofPath, `#!/bin/sh\ntouch "${marker}"\nexec ${REAL_LSOF} "$@"\n`);
  fs.chmodSync(lsofPath, 0o755);
  const beforeState = fs.readFileSync(path.join(gameDir, 'state.json'));
  const beforeArchives = fs.existsSync(path.join(gameDir, 'archive'))
    ? fs.readdirSync(path.join(gameDir, 'archive')).sort()
    : [];
  const signals = [];
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: {
      port: 0,
      lsofPath,
      forceStopMs: 100,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === external.child.pid) return;
        process.kill(pid, signal);
      },
    },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(holder);
    await terminateIfAlive(external.child);
    try { fs.unlinkSync(marker); } catch { /* absent */ }
  });

  await withFakePs(
    `if [ "$2" = "${external.child.pid}" ] && [ -f "${marker}" ]; then echo 'Mon Jan  1 00:00:00 2001'; exit 0; fi\nexec ${REAL_PS} "$@"`,
    async () => assert.rejects(
      loop.bootstrap({ ai: 1, force: true }),
      (error) => error.code === 'SERVER_IDENTITY_MISMATCH',
    ),
  );
  assert.deepEqual(signals, [[holder.pid, 'SIGTERM']], 'binding 후 재사용된 server pid에 시그널을 보냈다');
  assert.doesNotThrow(() => process.kill(external.child.pid, 0));
  assert.deepEqual(fs.readFileSync(path.join(gameDir, 'state.json')), beforeState);
  assert.equal(fs.readFileSync(path.join(gameDir, 'must-survive-adjacency.txt'), 'utf8'), 'old-game');
  assert.deepEqual(
    fs.existsSync(path.join(gameDir, 'archive')) ? fs.readdirSync(path.join(gameDir, 'archive')).sort() : [],
    beforeArchives,
  );
});

test('--force aborts before archive when the stopped server pid is observed as reused', { timeout: 10_000, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const marker = path.join(os.tmpdir(), `holdem-server-reused-${process.pid}-${Date.now()}`);
  const initialized = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'must-survive-server-reuse.txt'), 'old-game');
  const server = await startExternalServer(gameDir, initialized.sessionToken);
  const holder = await startOwnedLoopHolder(gameDir);
  const beforeState = fs.readFileSync(path.join(gameDir, 'state.json'));
  const beforeArchives = fs.existsSync(path.join(gameDir, 'archive'))
    ? fs.readdirSync(path.join(gameDir, 'archive')).sort()
    : [];
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: {
      port: 0,
      forceStopMs: 100,
      signalProcess: (pid, signal) => {
        if (pid === server.child.pid) {
          fs.writeFileSync(marker, signal);
          return;
        }
        process.kill(pid, signal);
      },
    },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(holder);
    await terminateIfAlive(server.child);
    try { fs.unlinkSync(marker); } catch { /* already gone */ }
  });

  await withFakePs(
    `if [ "$2" = "${server.child.pid}" ] && [ -f "${marker}" ]; then echo 'Mon Jan  1 00:00:00 2001'; exit 0; fi\nexec ${REAL_PS} "$@"`,
    async () => assert.rejects(
      loop.bootstrap({ ai: 1, force: true }),
      (error) => error.code === 'SERVER_IDENTITY_MISMATCH',
    ),
  );
  assert.equal(fs.readFileSync(marker, 'utf8'), 'SIGTERM');
  assert.doesNotThrow(() => process.kill(server.child.pid, 0));
  assert.deepEqual(fs.readFileSync(path.join(gameDir, 'state.json')), beforeState);
  assert.equal(fs.readFileSync(path.join(gameDir, 'must-survive-server-reuse.txt'), 'utf8'), 'old-game');
  assert.deepEqual(
    fs.existsSync(path.join(gameDir, 'archive'))
      ? fs.readdirSync(path.join(gameDir, 'archive')).sort()
      : [],
    beforeArchives,
  );
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
  assert.equal(exitCodeFor({ code: 'STOPPING' }), 5);
});
