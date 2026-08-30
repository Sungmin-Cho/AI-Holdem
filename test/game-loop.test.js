import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  processStartTime,
  readOwnedLock,
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
const COACH_CLI = path.join(ROOT, 'tools/coach-control.js');
const SERVER = path.join(ROOT, 'server/server.js');
const GAME_LOOP = path.join(ROOT, 'tools/game-loop.js');
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

async function runCoachCli(gameDir, args) {
  const { stdout } = await execFileAsync(process.execPath, [
    COACH_CLI, ...args, '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 20_000 });
  return JSON.parse(stdout.trim());
}

async function seedQueuedCoach(gameDir, owner, handNo = 1) {
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(gameDir, `.seed-coach-stats-${handNo}.json`);
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  const reserved = await runCoachCli(gameDir, [
    'reserve', '--owner', owner, '--hand', String(handNo), '--attempt', '1',
    '--consider-overfold', '--stats-file', statsPath,
    '--snapshot-file', path.join(gameDir, 'ui-snapshot.json'),
  ]);
  fs.writeFileSync(reserved.exactResultPath, JSON.stringify({
    handNo,
    text: `resume queued coach ${handNo}`,
  }));
  const denyPath = path.join(gameDir, `.seed-coach-deny-${handNo}.json`);
  fs.writeFileSync(denyPath, JSON.stringify(['SEED_FORBIDDEN_SENTINEL']));
  await runCoachCli(gameDir, [
    'accept', '--owner', owner, '--hand', String(handNo),
    '--generation', String(reserved.generation), '--forbidden-file', denyPath,
  ]);
  return reserved;
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

function makeCoachAdapter({ rounds = [] } = {}) {
  const prompts = [];
  const starts = [];
  const terminations = [];
  const pending = new Set();
  let disposed = 0;
  return {
    kind: 'coach-fake',
    prompts,
    starts,
    terminations,
    get disposed() { return disposed; },
    oneshotStart(input) {
      const index = starts.length;
      const round = rounds[index] ?? {
        raw: JSON.stringify({ handNo: 1, text: '기본 코치 응답' }),
      };
      prompts.push(input.prompt);
      starts.push(input);
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
        pid: 910_000 + index,
        startTime: `coach-start-${index}`,
        done,
        async terminate() {
          const result = typeof round.terminate === 'function'
            ? await round.terminate()
            : await (round.terminate ?? { confirmed: true });
          terminations.push({ index, result });
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

function resolverForCoach(player, upper, notices = []) {
  return async () => ({ player, upper, notices });
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

async function startHealthOnlyServer({ acceptsEveryToken = false, requestLog = null } = {}) {
  const script = `
    const fs = require('node:fs');
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      if (${JSON.stringify(requestLog)}) fs.appendFileSync(${JSON.stringify(requestLog)}, req.method + ' ' + req.url + '\\n');
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

async function startToggleAuthRelay(token, controlPath, requestLog) {
  fs.writeFileSync(controlPath, 'normal');
  const script = `
    const fs = require('node:fs');
    const http = require('node:http');
    const token = ${JSON.stringify(token)};
    const controlPath = ${JSON.stringify(controlPath)};
    const requestLog = ${JSON.stringify(requestLog)};
    let revision = 0;
    const mode = () => { try { return fs.readFileSync(controlPath, 'utf8').trim(); } catch { return 'normal'; } };
    const send = (res, status, body) => {
      res.writeHead(status, {'Content-Type':'application/json'});
      res.end(JSON.stringify(body));
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      fs.appendFileSync(requestLog, req.method + ' ' + url.pathname + '\\n');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, {ok:true});
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        if (mode() !== 'foreign' && url.searchParams.get('token') !== token) {
          return send(res, 401, {ok:false,code:'UNAUTHORIZED'});
        }
        return send(res, 200, {revision,view:null,log:[],coach:[]});
      }
      if (req.method === 'POST' && url.pathname === '/api/publish') {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => { revision += 1; send(res, 200, {ok:true,revision}); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/wait-action') {
        const timer = setInterval(() => {
          if (mode() !== 'foreign') return;
          clearInterval(timer);
          req.socket.destroy();
        }, 10);
        req.once('close', () => clearInterval(timer));
        return;
      }
      send(res, 404, {ok:false});
    });
    process.once('SIGTERM', () => server.close(() => process.exit(0)));
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = Number(await readLine(child));
  return { child, port };
}

async function startRejectOnceRelay(token, logPath) {
  const script = `
    const fs = require('node:fs');
    const http = require('node:http');
    const token = ${JSON.stringify(token)};
    let publishes = 0;
    const send = (res, status, body) => {
      res.writeHead(status, {'Content-Type':'application/json'});
      res.end(JSON.stringify(body));
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, {ok:true});
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        if (url.searchParams.get('token') !== token) return send(res, 401, {ok:false,code:'UNAUTHORIZED'});
        return send(res, 200, {revision:publishes,view:null,log:[],coach:[]});
      }
      if (req.method === 'GET' && url.pathname === '/api/wait-action') {
        if (url.searchParams.get('token') !== token) return send(res, 401, {ok:false,code:'UNAUTHORIZED'});
        return send(res, 200, {timeout:true});
      }
      if (req.method === 'POST' && url.pathname === '/api/publish') {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({type:'publish',raw}) + '\\n');
          publishes += 1;
          if (publishes === 1) return send(res, 503, {ok:false,code:'REJECT_ONCE'});
          return send(res, 200, {ok:true,revision:publishes});
        });
        return;
      }
      send(res, 404, {ok:false});
    });
    process.once('SIGTERM', () => server.close(() => process.exit(0)));
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = Number(await readLine(child));
  return { child, port };
}

async function startPublishFailHealthHangServer(port, logPath) {
  const script = `
    const fs = require('node:fs');
    const http = require('node:http');
    const server = http.createServer((req) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      fs.appendFileSync(${JSON.stringify(logPath)}, url.pathname + '\\n');
      if (url.pathname === '/api/health') return;
      req.socket.destroy();
    });
    server.listen(${Number(port)}, '127.0.0.1', () => process.stdout.write('ready\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(await readLine(child), 'ready');
  return child;
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

async function withServerLockSwapAtRetirement(lockPath, replacementPath, fn) {
  const originalUnlink = fs.unlinkSync;
  const originalRename = fs.renameSync;
  let swapped = false;
  const swap = (candidate) => {
    if (swapped || path.resolve(String(candidate)) !== path.resolve(lockPath)) return;
    swapped = true;
    originalRename(replacementPath, lockPath);
  };
  fs.unlinkSync = function unlinkWithSwap(candidate, ...args) {
    swap(candidate);
    return originalUnlink.call(fs, candidate, ...args);
  };
  fs.renameSync = function renameWithSwap(from, to, ...args) {
    swap(from);
    return originalRename.call(fs, from, to, ...args);
  };
  try {
    return await fn(() => swapped);
  } finally {
    fs.unlinkSync = originalUnlink;
    fs.renameSync = originalRename;
  }
}

async function withSecondServerLockBeforeRestore({
  lockPath,
  firstReplacementPath,
  secondRaw,
}, fn) {
  const originalUnlink = fs.unlinkSync;
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  let firstSwapped = false;
  let secondInserted = false;
  let secondStat = null;
  let quarantinePath = null;
  const swapFirst = (candidate) => {
    if (firstSwapped || path.resolve(String(candidate)) !== path.resolve(lockPath)) return;
    firstSwapped = true;
    originalRename(firstReplacementPath, lockPath);
  };
  const insertSecondBeforeRestore = (from, to) => {
    if (
      secondInserted
      || path.resolve(String(to)) !== path.resolve(lockPath)
      || !path.basename(String(from)).startsWith('.lock.json.retired-')
    ) return;
    secondInserted = true;
    quarantinePath = String(from);
    fs.writeFileSync(lockPath, secondRaw, { flag: 'wx' });
    secondStat = fs.lstatSync(lockPath);
  };
  fs.unlinkSync = function unlinkWithFirstSwap(candidate, ...args) {
    swapFirst(candidate);
    return originalUnlink.call(fs, candidate, ...args);
  };
  fs.renameSync = function renameWithDoubleSwap(from, to, ...args) {
    swapFirst(from);
    insertSecondBeforeRestore(from, to);
    return originalRename.call(fs, from, to, ...args);
  };
  fs.linkSync = function linkWithSecondInsert(from, to, ...args) {
    insertSecondBeforeRestore(from, to);
    return originalLink.call(fs, from, to, ...args);
  };
  try {
    return await fn(() => ({
      firstSwapped,
      secondInserted,
      secondStat,
      quarantinePath,
    }));
  } finally {
    fs.unlinkSync = originalUnlink;
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
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

function writeLoopStateFixture(gameDir, sessionToken, overrides = {}) {
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

async function setupCoachHand(t, {
  upper = makeCoachAdapter(),
  player = makeAdapter(),
  notices = ['fake coach runtime selected'],
  loopOpts = {},
  practiceFocusFile,
} = {}) {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverForCoach(player, upper, notices),
    opts: { port: 0, waitMs: 0, ...loopOpts },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1, stack: 100, practiceFocusFile });
  putAiFirst(gameDir);
  return { gameDir, loop, player, upper };
}

async function waitForCoachNote(gameDir, handNo, timeoutMs = 5_000) {
  return waitFor(() => {
    try {
      const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
      return snapshot.coach?.find((note) => note.handNo === handNo) ?? null;
    } catch {
      return null;
    }
  }, `coach note for hand ${handNo} was not published`, timeoutMs);
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
    assert.equal(initial.gameEpoch, gameEpochOf(initial.sessionToken));
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

test('requestStop holds the loop lock until an in-flight resolver settles and disposes every registered adapter', { timeout: 10_000 }, async () => {
  const gameDir = tmpGame();
  let resolverEntered;
  const entered = new Promise((resolve) => { resolverEntered = resolve; });
  let settleResolver;
  let disposed = 0;
  const adapter = {
    kind: 'fake',
    watchdog: { t1Ms: 10, t2Ms: 10 },
    async warmup({ playerId }) { return { sessionId: `s-${playerId}`, raw: 'ready' }; },
    async decide() { return { raw: '{}' }; },
    async dispose() { disposed += 1; },
  };
  const loop = createGameLoop({
    gameDir,
    resolver: ({ registerAdapter }) => {
      registerAdapter?.(adapter);
      resolverEntered();
      return new Promise((resolve) => {
        settleResolver = () => resolve({ player: adapter, upper: adapter, notices: [] });
      });
    },
    opts: { port: 0, waitMs: 0 },
  });
  const bootstrapping = loop.bootstrap({ ai: 1, stack: 100 });
  bootstrapping.catch(() => {});
  await entered;

  const stopping = loop.requestStop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const lockHeldWhileResolverPending = fs.existsSync(path.join(gameDir, 'loop.lock.d'));
  settleResolver();
  await assert.rejects(bootstrapping, (error) => error.code === 'STOPPING');
  await stopping;

  assert.equal(lockHeldWhileResolverPending, true, 'requestStop released ownership before resolver settlement');
  assert.equal(disposed, 1, 'resolver-created adapter was not disposed exactly once');
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false, 'server spawned after stopRequested');
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

test('resume rejects missing or mismatched loop-state identity before resolver, server, or log work', { timeout: 20_000 }, async (t) => {
  const cases = [
    ['missing-sessionToken', (state) => { delete state.sessionToken; }],
    ['mismatched-sessionToken', (state) => { state.sessionToken = 'different-session-token'; }],
    ['missing-gameEpoch', (state) => { delete state.gameEpoch; }],
    ['noncanonical-gameEpoch', (state, token) => { state.gameEpoch = token; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (st) => {
      const gameDir = tmpGame();
      const init = await initGame(gameDir);
      const state = writeLoopStateFixture(gameDir, init.sessionToken);
      mutate(state, init.sessionToken);
      fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify(state));
      const engineBefore = fs.readFileSync(path.join(gameDir, 'state.json'));
      let resolverCalls = 0;
      const loop = createGameLoop({
        gameDir,
        resolver: async () => {
          resolverCalls += 1;
          return resolverFor(makeAdapter())();
        },
        opts: { port: 0 },
      });
      st.after(() => loop.requestStop().catch(() => {}));

      await assert.rejects(
        loop.resume(),
        (error) => error.code === 'LOOP_STATE_IDENTITY_MISMATCH',
      );

      assert.equal(resolverCalls, 0);
      assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false);
      assert.equal(fs.existsSync(path.join(gameDir, 'loop.log')), false);
      assert.deepEqual(fs.readFileSync(path.join(gameDir, 'state.json')), engineBefore);
      assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
    });
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
    gameEpoch: gameEpochOf(init.sessionToken),
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

test('playing resume reuses every valid matching player session without warmup', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  putAiFirst(gameDir);
  const state = writeLoopStateFixture(gameDir, init.sessionToken);
  const sessions = {
    p1: { runtime: 'fake', sessionId: 'persisted-p1', createdAt: '2026-08-29T01:00:00.000Z' },
    p2: { runtime: 'fake', sessionId: 'persisted-p2', createdAt: '2026-08-29T01:00:00.000Z' },
  };
  fs.writeFileSync(path.join(gameDir, '.player-sessions.json'), JSON.stringify(sessions));
  const adapter = makeAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0, waitMs: 0 } });
  t.after(() => loop.requestStop());

  const resumed = await loop.resume();

  assert.equal(resumed.phase, 'playing');
  assert.equal(adapter.calls.length, 0, 'valid sessions were unnecessarily recreated');
  assert.deepEqual(readJson(path.join(gameDir, '.player-sessions.json')), sessions);
  await runUntilUserBoundary(loop, gameDir);
  assert.equal(adapter.decideCalls[0].sessionId, 'persisted-p1');
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).startedAt, state.startedAt);
});

test('playing resume recreates only missing, corrupt, or runtime-mismatched session entries', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  const state = writeLoopStateFixture(gameDir, init.sessionToken);
  fs.writeFileSync(path.join(gameDir, '.player-sessions.json'), JSON.stringify({
    p1: { runtime: 'fake', sessionId: 'persisted-p1', createdAt: '2026-08-29T01:00:00.000Z' },
    p2: { runtime: 'other-runtime', sessionId: '', createdAt: null },
    ghost: { runtime: 'fake', sessionId: 'ghost', createdAt: state.startedAt },
  }));
  const adapter = makeAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0 } });
  t.after(() => loop.requestStop());

  await loop.resume();

  assert.deepEqual(adapter.calls.map((call) => call.playerId), ['p2']);
  assert.deepEqual(readJson(path.join(gameDir, '.player-sessions.json')), {
    p1: { runtime: 'fake', sessionId: 'persisted-p1', createdAt: '2026-08-29T01:00:00.000Z' },
    p2: { runtime: 'fake', sessionId: 'session-p2', createdAt: state.startedAt },
  });
});

test('a remotely rejected restored session recreates only that player once, persists it, and retries without overlap', { timeout: 15_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  putAiFirst(gameDir);
  writeLoopStateFixture(gameDir, init.sessionToken);
  const oldCreatedAt = '2026-08-29T01:00:00.000Z';
  fs.writeFileSync(path.join(gameDir, '.player-sessions.json'), JSON.stringify({
    p1: { runtime: 'fake', sessionId: 'expired-p1', createdAt: oldCreatedAt },
    p2: { runtime: 'fake', sessionId: 'persisted-p2', createdAt: oldCreatedAt },
  }));
  let active = 0;
  let maxActive = 0;
  const adapter = makeAdapter({
    onDecide: async ({ sessionId, message }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (sessionId === 'expired-p1') {
          const error = new Error('remote session expired');
          error.code = 'CLI_FAILED';
          throw error;
        }
        return { raw: JSON.stringify({ decisionId: decisionIdOfMessage(message), action: 'fold' }) };
      } finally {
        active -= 1;
      }
    },
  });
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0, waitMs: 0 } });
  t.after(() => loop.requestStop());
  await loop.resume();

  await runUntilUserBoundary(loop, gameDir);

  assert.deepEqual(adapter.calls.map((call) => call.playerId), ['p1'], 'valid p2 was unnecessarily recreated');
  assert.deepEqual(
    adapter.decideCalls.filter((call) => call.playerId === 'p1').map((call) => call.sessionId),
    ['expired-p1', 'session-p1'],
  );
  assert.equal(maxActive, 1, 'old and repaired session calls overlapped');
  const sessions = readJson(path.join(gameDir, '.player-sessions.json'));
  assert.equal(sessions.p1.runtime, 'fake');
  assert.equal(sessions.p1.sessionId, 'session-p1');
  assert.notEqual(sessions.p1.createdAt, oldCreatedAt);
  assert.deepEqual(sessions.p2, { runtime: 'fake', sessionId: 'persisted-p2', createdAt: oldCreatedAt });
  const metric = readJson(path.join(gameDir, 'loop-state.json')).metrics
    .find((entry) => entry.playerId === 'p1');
  assert.equal(metric.outcome, 'retried_accepted');
  assert.equal(metric.sessionRepaired, true);
});

test('a repaired fresh session is never recreated again and its bounded failures reach force-default', { timeout: 15_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'init', '--ai', '1', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  putAiFirst(gameDir);
  writeLoopStateFixture(gameDir, init.sessionToken);
  fs.writeFileSync(path.join(gameDir, '.player-sessions.json'), JSON.stringify({
    p1: { runtime: 'fake', sessionId: 'expired-p1', createdAt: '2026-08-29T01:00:00.000Z' },
  }));
  let active = 0;
  let maxActive = 0;
  const adapter = makeAdapter({
    onDecide: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const error = new Error('session call rejected');
        error.code = 'CLI_FAILED';
        throw error;
      } finally {
        active -= 1;
      }
    },
  });
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: { port: 0, waitMs: 0, watchdog: { t1Ms: 50, t2Ms: 50 } },
  });
  t.after(() => loop.requestStop());
  await loop.resume();

  await runUntilUserBoundary(loop, gameDir);

  assert.deepEqual(adapter.calls.map((call) => call.playerId), ['p1']);
  assert.deepEqual(adapter.decideCalls.slice(0, 3).map((call) => call.sessionId), [
    'expired-p1', 'session-p1', 'session-p1',
  ]);
  assert.equal(adapter.decideCalls.length, 3, 'fresh session failure entered an unbounded recreate loop');
  assert.equal(maxActive, 1);
  const metric = readJson(path.join(gameDir, 'loop-state.json')).metrics[0];
  assert.equal(metric.outcome, 'forced_default');
  assert.equal(metric.sessionRepaired, true);
});

test('playing resume without a server lock restarts on the persisted actual port', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const original = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  await original.bootstrap({ ai: 1, stack: 100 });
  const persistedPort = readJson(path.join(gameDir, 'loop-state.json')).port;
  await original.requestStop();
  fs.rmSync(path.join(gameDir, 'lock.json'), { force: true });
  assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false);

  const resumed = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  t.after(() => resumed.requestStop());
  await resumed.resume();

  assert.equal(readJson(path.join(gameDir, 'lock.json')).port, persistedPort);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).port, persistedPort);
});

test('successful player probes clear a stale NO_PLAYER_RUNTIME halt at resume boundary', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  writeLoopStateFixture(gameDir, init.sessionToken, {
    phase: 'bootstrap',
    halt: { code: 'NO_PLAYER_RUNTIME', message: 'old runtime failure' },
  });
  const adapter = makeAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0, waitMs: 0 } });
  t.after(() => loop.requestStop());

  const resumed = await loop.resume();

  assert.equal(resumed.phase, 'playing');
  assert.equal(Object.hasOwn(resumed, 'halt'), false);
  await runUntilUserBoundary(loop, gameDir);
});

test('repair_failed halt clears only after resume-check reports a successful repair boundary', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  writeLoopStateFixture(gameDir, init.sessionToken, {
    halt: { code: 'repair_failed', message: 'old archive failure' },
  });
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0, waitMs: 0 } });
  t.after(() => loop.requestStop());
  await loop.resume();
  const running = startRun(loop);

  await waitWhileRunning(running, () => waitForUserSnapshot(gameDir), 'repair_failed resume did not continue');
  await stopRun(loop, running);

  const state = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(Object.hasOwn(state, 'halt'), false);
  assert.equal(readLoopLog(gameDir).some((entry) => (
    entry.event === 'resume-archive-check' && entry.archiveStatus !== 'repair_failed'
  )), true);
});

test('resume adopts a healthy external server and requestStop identity-confirms its death', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap',
    sessionToken: init.sessionToken,
    gameEpoch: gameEpochOf(init.sessionToken),
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
    gameEpoch: gameEpochOf(init.sessionToken),
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
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).cleanupError.code, 'SERVER_IDENTITY_UNAVAILABLE');
  await loop.requestStop();
  await waitUntilDead(external.child.pid);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('forged lock cannot bind an unrelated live pid to another healthy authenticated server', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
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
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
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
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
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
        phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
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
        phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
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
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
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
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true);
  await loop.requestStop();
  await waitUntilDead(external.child.pid);
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
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true);
  await loop.requestStop();
  await waitUntilDead(serverPid);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('TERM-resistant adopted server is KILLed and death-confirmed', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
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
  assert.equal(derived.gameEpoch, gameEpochOf(init.sessionToken));
  assert.equal(adapter.calls.length, 2);
});

test('idle playing resume starts the next hand without an unnecessary view-only publish', { timeout: 10_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'init', '--ai', '1', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const engine = readJson(path.join(gameDir, 'state.json'));
  engine.button = 1; // startHand advances to user(0): isolate view-only vs new-hand publication.
  fs.writeFileSync(path.join(gameDir, 'state.json'), JSON.stringify(engine));
  writeLoopStateFixture(gameDir, init.sessionToken);
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  t.after(() => loop.requestStop());
  await loop.resume();
  const running = startRun(loop);

  await waitWhileRunning(running, () => waitForUserSnapshot(gameDir), 'idle resume did not start a hand');
  await stopRun(loop, running);

  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(snapshot.publishId, 1, 'idle resume emitted a view-only publish before new-hand');
  assert.equal(snapshot.view.handNo, 1);
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

test('runtime close/signal/identity lifecycle failures are fatal and never enter T2 or force-default', { timeout: 20_000 }, async (t) => {
  for (const code of ['CHILD_CLOSE_UNCONFIRMED', 'CHILD_SIGNAL_FAILED', 'IDENTITY_UNAVAILABLE']) {
    await t.test(code, async (st) => {
      const adapter = makeAdapter({
        onDecide: async () => {
          const error = new Error(code);
          error.code = code;
          throw error;
        },
      });
      const { gameDir, loop } = await setupAiFirst(st, { adapter });
      const running = startRun(loop);
      const outcome = await Promise.race([
        running.then(
          () => ({ type: 'resolved' }),
          (error) => ({ type: 'rejected', error }),
        ),
        waitFor(
          () => {
            const state = readJson(path.join(gameDir, 'state.json'));
            return [
              ...(state.hand?.actions ?? []),
              ...(state.lastHand?.actions ?? []),
            ].length > 0;
          },
          `${code} neither rejected nor reached force-default`,
          4_000,
        ).then(() => ({ type: 'forced-default' })),
      ]);
      if (outcome.type === 'forced-default') await stopRun(loop, running);

      assert.equal(outcome.type, 'rejected', `${code} was treated as a retryable model failure`);
      assert.equal(outcome.error.code, code);
      assert.equal(adapter.decideCalls.length, 1, `${code} started T2`);
      const state = readJson(path.join(gameDir, 'state.json'));
      assert.deepEqual([...(state.hand?.actions ?? []), ...(state.lastHand?.actions ?? [])], []);
    });
  }
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

test('an applied AI step records publishMs and publishError even when terminal publication fails', { timeout: 15_000 }, async (t) => {
  let gameDir = null;
  let loop = null;
  let foreign = null;
  const adapter = makeAdapter({
    onDecide: async ({ message }) => {
      const owned = readJson(path.join(gameDir, 'lock.json'));
      process.kill(owned.serverPid, 'SIGKILL');
      await waitUntilDead(owned.serverPid);
      foreign = await startHealthOnlyServer();
      fs.writeFileSync(path.join(gameDir, 'lock.json'), JSON.stringify({
        serverPid: foreign.child.pid,
        port: foreign.port,
        sessionToken: owned.sessionToken,
      }));
      return { raw: JSON.stringify({ decisionId: decisionIdOfMessage(message), action: 'fold' }) };
    },
  });
  const setup = await setupAiFirst(t, { adapter });
  ({ gameDir, loop } = setup);
  t.after(async () => {
    if (foreign) await terminateIfAlive(foreign.child);
  });

  await assert.rejects(loop.run(), (error) => error.code === 'SERVER_AUTH_FAILED');

  const engine = readJson(path.join(gameDir, 'state.json'));
  const actions = engine.hand?.actions ?? engine.lastHand?.actions ?? [];
  assert.equal(actions.some((action) => action.playerId === 'p1' && action.action === 'fold'), true);
  const metric = readJson(path.join(gameDir, 'loop-state.json')).metrics.at(-1);
  assert.equal(metric.outcome, 'accepted');
  assert.equal(metric.publishError, 'SERVER_AUTH_FAILED');
  assert.equal(Number.isFinite(metric.publishMs) && metric.publishMs >= 0, true);
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

test('nested ATTEMPT_PENDING retry errors re-enter the bounded publish matrix with exact argv and artifact order', { timeout: 120_000 }, async (t) => {
  const cases = [
    {
      code: 'BAD_ATTEMPT',
      mutate: async ({ attemptPath }) => fs.writeFileSync(attemptPath, '{broken-attempt'),
      expectedSuffixes: [
        ['--wait', '--wait-ms', '0'],
        ['--retry'],
        ['--view-only', '--wait', '--wait-ms', '0'],
      ],
      assertNested(observation) {
        assert.equal(observation.attemptRaw, '{broken-attempt');
      },
    },
    {
      code: 'BAD_SNAPSHOT',
      mutate: async ({ attemptPath, snapshotPath }) => {
        fs.unlinkSync(attemptPath);
        fs.writeFileSync(snapshotPath, '{broken-snapshot');
      },
      expectedSuffixes: [
        ['--wait', '--wait-ms', '0'],
        ['--retry'],
        ['--retry'],
      ],
      assertNested(observation) {
        assert.equal(observation.attemptRaw, null);
        assert.equal(observation.snapshotRaw, '{broken-snapshot');
      },
    },
    {
      code: 'LOCK_TIMEOUT',
      mutate: async (fixture) => {
        fixture.held = await holdNamedLock(fixture.gameDir, 'publish.lock.d');
        fixture.releaseTimer = setTimeout(() => fixture.held.release(), 20_500);
      },
      expectedSuffixes: [
        ['--wait', '--wait-ms', '0'],
        ['--retry'],
        ['--retry'],
        ['--wait', '--wait-ms', '0'],
      ],
      assertNested(observation, seedRaw) {
        assert.equal(observation.attemptRaw, seedRaw);
      },
    },
    {
      code: 'NO_LOCK',
      mutate: async ({ attemptPath, lockPath, loop }) => {
        const oldPid = loop.serverPid;
        process.kill(oldPid, 'SIGKILL');
        await waitUntilDead(oldPid);
        fs.unlinkSync(lockPath);
        assert.equal(fs.existsSync(attemptPath), true);
      },
      expectedSuffixes: [
        ['--wait', '--wait-ms', '0'],
        ['--retry'],
        ['--retry'],
        ['--wait', '--wait-ms', '0'],
      ],
      assertNested(observation, seedRaw) {
        assert.equal(observation.attemptRaw, seedRaw);
        assert.equal(observation.lockPresent, false);
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.code, { timeout: 35_000 }, async (st) => {
      let loopRef = null;
      let checkpointCalls = 0;
      const invocations = [];
      const fixture = {
        gameDir: null,
        loop: null,
        attemptPath: null,
        snapshotPath: null,
        lockPath: null,
        held: null,
        releaseTimer: null,
      };
      const setup = await setupAiFirst(st, {
        adapter: makeAdapter(),
        loopOpts: {
          waitMs: 0,
          onPublishInvoke(args) {
            invocations.push({
              args: [...args],
              attemptRaw: fs.existsSync(fixture.attemptPath)
                ? fs.readFileSync(fixture.attemptPath, 'utf8')
                : null,
              snapshotRaw: fs.existsSync(fixture.snapshotPath)
                ? fs.readFileSync(fixture.snapshotPath, 'utf8')
                : null,
              lockPresent: fs.existsSync(fixture.lockPath),
            });
          },
          async attemptPendingCheckpoint() {
            checkpointCalls += 1;
            await scenario.mutate(fixture);
          },
        },
      });
      loopRef = setup.loop;
      Object.assign(fixture, {
        gameDir: setup.gameDir,
        loop: loopRef,
        attemptPath: path.join(setup.gameDir, '.publish-attempt.json'),
        snapshotPath: path.join(setup.gameDir, 'ui-snapshot.json'),
        lockPath: path.join(setup.gameDir, 'lock.json'),
      });
      st.after(async () => {
        if (fixture.releaseTimer) clearTimeout(fixture.releaseTimer);
        if (fixture.held) {
          fixture.held.release();
          await fixture.held.done.catch(() => {});
        }
      });
      const engine = readJson(path.join(setup.gameDir, 'state.json'));
      const seed = {
        body: { publishId: 1, messages: [{ type: 'narration', text: `pending-${scenario.code}` }] },
        expectedGameEpoch: gameEpochOf(engine.sessionToken),
      };
      const seedRaw = JSON.stringify(seed);
      fs.writeFileSync(fixture.attemptPath, seedRaw);
      const turnPath = path.join(setup.gameDir, '.turn.json');
      const running = startRun(loopRef);
      const outcome = await Promise.race([
        running.then(
          () => ({ type: 'resolved' }),
          (error) => ({ type: 'rejected', error }),
        ),
        waitForUserSnapshot(setup.gameDir, 27_000).then(() => ({ type: 'continued' })),
      ]);
      if (outcome.type === 'continued') await stopRun(loopRef, running);

      assert.equal(checkpointCalls, 1, `${scenario.code} did not cross the nested retry checkpoint exactly once`);
      assert.equal(outcome.type, 'continued', `${scenario.code} escaped instead of re-entering the matrix`);
      const expectedArgs = scenario.expectedSuffixes.map((suffix) => ['--from', turnPath, ...suffix]);
      assert.deepEqual(invocations.slice(0, expectedArgs.length).map((entry) => entry.args), expectedArgs);
      scenario.assertNested(invocations[1], seedRaw);
      assert.equal(fs.existsSync(fixture.attemptPath), false, `${scenario.code} left an unresolved attempt`);
      const history = readJson(fixture.snapshotPath).history ?? [];
      const recordedPendingBodies = history.filter((entry) => (
        entry.payload?.messages?.some((message) => message.text === `pending-${scenario.code}`)
      ));
      const pendingBodyShouldPublish = scenario.code === 'LOCK_TIMEOUT' || scenario.code === 'NO_LOCK';
      assert.equal(
        recordedPendingBodies.length,
        pendingBodyShouldPublish ? 1 : 0,
        `${scenario.code} published the pending body an incorrect number of times`,
      );
      if (pendingBodyShouldPublish) {
        assert.deepEqual(recordedPendingBodies[0].payload, {
          messages: [{ type: 'narration', text: `pending-${scenario.code}` }],
        });
      }
      const metric = readJson(path.join(setup.gameDir, 'loop-state.json')).metrics
        .find((entry) => entry.playerId === 'p1');
      assert.equal(metric.outcome, 'accepted');
      assert.equal(Object.hasOwn(metric, 'publishError'), false, `${scenario.code} polluted the recovered metric`);
    });
  }
});

test('BAD_ATTEMPT deletes only the corrupt record, resyncs state, and republishes view-only', { timeout: 10_000 }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter() });
  fs.writeFileSync(path.join(gameDir, '.publish-attempt.json'), '{broken-json');
  const running = startRun(loop);

  await waitWhileRunning(running, () => waitForUserSnapshot(gameDir), 'BAD_ATTEMPT recovery did not resume play');
  await stopRun(loop, running);

  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(Number.isInteger(snapshot.view.handNo), true);
});

test('BAD_SNAPSHOT verifies the server, removes the corrupt snapshot, and republishes once', { timeout: 10_000 }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter() });
  fs.writeFileSync(path.join(gameDir, 'ui-snapshot.json'), '{broken-snapshot');
  const running = startRun(loop);

  await waitWhileRunning(running, () => waitForUserSnapshot(gameDir), 'BAD_SNAPSHOT recovery did not resume play');
  await stopRun(loop, running);

  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(Number.isInteger(snapshot.view.handNo), true);
  assert.equal(Number.isInteger(snapshot.publishId), true);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
});

test('LOCK_TIMEOUT retries the same publish once after the competing publisher releases', { timeout: 35_000 }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter(), loopOpts: { waitMs: 0 } });
  const held = await holdNamedLock(gameDir, 'publish.lock.d');
  const releaseTimer = setTimeout(() => held.release(), 20_500);
  t.after(async () => {
    clearTimeout(releaseTimer);
    held.release();
    await held.done.catch(() => {});
  });
  const running = startRun(loop);

  await waitWhileRunning(running, () => waitForUserSnapshot(gameDir), 'LOCK_TIMEOUT retry did not resume play', 25_000);
  await stopRun(loop, running);

  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
  assert.equal(Number.isInteger(readJson(path.join(gameDir, 'ui-snapshot.json')).view.handNo), true);
  assert.equal(readLoopLog(gameDir).some((entry) => (
    entry.event === 'publish-recovery' && entry.code === 'LOCK_TIMEOUT'
  )), true);
});

test('NO_LOCK restarts on the persisted actual port and retries without rerunning the step', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter(), loopOpts: { waitMs: 0 } });
  const lockPath = path.join(gameDir, 'lock.json');
  const oldLock = readJson(lockPath);
  process.kill(oldLock.serverPid, 'SIGKILL');
  await waitUntilDead(oldLock.serverPid);
  fs.unlinkSync(lockPath);
  const running = startRun(loop);

  await waitWhileRunning(running, () => waitForUserSnapshot(gameDir), 'NO_LOCK recovery did not resume play', 6_000);
  await stopRun(loop, running);

  const recovered = readJson(lockPath);
  assert.equal(recovered.port, oldLock.port);
  assert.notEqual(recovered.serverPid, oldLock.serverPid);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
});

test('PUBLISH_FAILED after the owned server dies restarts it and retries the recorded attempt', { timeout: 20_000 }, async (t) => {
  const adapter = makeAdapter();
  const { gameDir, loop } = await setupAiFirst(t, { adapter });
  const oldPid = loop.serverPid;
  const oldPort = readJson(path.join(gameDir, 'lock.json')).port;
  process.kill(oldPid, 'SIGKILL');
  await waitUntilDead(oldPid);

  await runUntilUserBoundary(loop, gameDir);

  assert.notEqual(loop.serverPid, oldPid);
  assert.equal(readJson(path.join(gameDir, 'lock.json')).port, oldPort, 'D9 restarted on a new random port');
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
  assert.equal(readLoopLog(gameDir).some((entry) => entry.event === 'server-recovered'), true);
});

test('D9 rejects a healthy listener unless pid, port, token auth, startTime, and lock identity all bind', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter() });
  const oldLock = readJson(path.join(gameDir, 'lock.json'));
  process.kill(oldLock.serverPid, 'SIGKILL');
  await waitUntilDead(oldLock.serverPid);
  const foreign = await startHealthOnlyServer();
  t.after(() => terminateIfAlive(foreign.child));
  fs.writeFileSync(path.join(gameDir, 'lock.json'), JSON.stringify({
    serverPid: foreign.child.pid,
    port: foreign.port,
    sessionToken: oldLock.sessionToken,
  }));

  await assert.rejects(
    loop.run(),
    (error) => error.code === 'SERVER_AUTH_FAILED',
  );

  assert.doesNotThrow(() => process.kill(foreign.child.pid, 0));
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), true);
  assert.equal(readLoopLog(gameDir).some((entry) => entry.event === 'server-recovered'), false);
});

test('PUBLISH_REJECTED verifies the live relay then retries the exact recorded body once', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter() });
  const oldLock = readJson(path.join(gameDir, 'lock.json'));
  process.kill(oldLock.serverPid, 'SIGKILL');
  await waitUntilDead(oldLock.serverPid);
  const relayLog = path.join(os.tmpdir(), `holdem-reject-once-${process.pid}-${Date.now()}.jsonl`);
  const relay = await startRejectOnceRelay(oldLock.sessionToken, relayLog);
  t.after(async () => {
    await terminateIfAlive(relay.child);
    try { fs.unlinkSync(relayLog); } catch { /* absent */ }
  });
  fs.writeFileSync(path.join(gameDir, 'lock.json'), JSON.stringify({
    serverPid: relay.child.pid,
    port: relay.port,
    sessionToken: oldLock.sessionToken,
  }));
  const running = startRun(loop);

  const requests = await waitWhileRunning(running, () => {
    if (!fs.existsSync(relayLog)) return null;
    const rows = fs.readFileSync(relayLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const publishes = rows.filter((row) => row.type === 'publish');
    return publishes.length >= 2 ? publishes : null;
  }, 'PUBLISH_REJECTED was not retried against the verified relay', 5_000);

  assert.equal(requests[1].raw, requests[0].raw, 'retry changed publishId or recorded body');
  await waitWhileRunning(
    running,
    () => !fs.existsSync(path.join(gameDir, '.publish-attempt.json')),
    'verified retry did not clear the recorded attempt after ack',
  );
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
  await stopRun(loop, running);
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

test('wait-only child supervision exceeds waitMs plus network margin (the default 60s wait is not capped at 30s)', { timeout: 10_000 }, async (t) => {
  const { gameDir, loop } = await setupUserFirst(t, {
    loopOpts: { waitMs: 2_000, childTimeoutMs: 1_000, waitNetworkMarginMs: 500 },
  });
  const started = Date.now();
  const running = startRun(loop);
  const outcome = await Promise.race([
    running.then(
      () => ({ type: 'resolved' }),
      (error) => ({ type: 'rejected', error }),
    ),
    waitFor(
      () => readLoopLog(gameDir).some((entry) => entry.event === 'user-wait-timeout'),
      'declared user wait did not reach its own timeout',
      5_000,
    ).then(() => ({ type: 'wait-timeout' })),
  ]);
  if (outcome.type === 'wait-timeout') await stopRun(loop, running);

  assert.equal(outcome.type, 'wait-timeout');
  assert.equal(Date.now() - started >= 1_800, true, 'child supervisor killed wait before waitMs');
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

test('user waitError rejects a foreign healthy listener before any step republish reaches it', { timeout: 15_000 }, async (t) => {
  const gameDir = tmpGame();
  const initialized = await initGame(gameDir);
  writeLoopStateFixture(gameDir, initialized.sessionToken);
  const controlPath = path.join(os.tmpdir(), `holdem-wait-control-${process.pid}-${Date.now()}`);
  const requestLog = path.join(os.tmpdir(), `holdem-wait-foreign-${process.pid}-${Date.now()}.log`);
  const foreign = await startToggleAuthRelay(initialized.sessionToken, controlPath, requestLog);
  fs.writeFileSync(path.join(gameDir, 'lock.json'), JSON.stringify({
    serverPid: foreign.child.pid,
    port: foreign.port,
    sessionToken: initialized.sessionToken,
  }));
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 1_000 },
  });
  t.after(async () => {
    await loop.requestStop().catch(() => {});
    await terminateIfAlive(foreign.child);
    try { fs.unlinkSync(requestLog); } catch { /* absent */ }
    try { fs.unlinkSync(controlPath); } catch { /* absent */ }
  });
  await loop.resume();
  const running = startRun(loop);
  await waitWhileRunning(
    running,
    () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('GET /api/wait-action'),
    'toggle relay did not enter the user wait',
  );
  const publishesBeforeForeignMode = fs.readFileSync(requestLog, 'utf8')
    .split('\n').filter((line) => line === 'POST /api/publish').length;

  fs.writeFileSync(controlPath, 'foreign');

  const outcome = await Promise.race([
    running.then(
      () => ({ type: 'resolved' }),
      (error) => ({ type: 'rejected', error }),
    ),
    waitFor(
      () => fs.existsSync(requestLog)
        && fs.readFileSync(requestLog, 'utf8').split('\n')
          .filter((line) => line === 'POST /api/publish').length > publishesBeforeForeignMode,
      'foreign listener neither received a republish nor was rejected',
      5_000,
    ).then(() => ({ type: 'foreign-publish' })),
  ]);
  if (outcome.type === 'foreign-publish') {
    await loop.requestStop();
    await running.catch(() => {});
  }

  assert.equal(outcome.type, 'rejected');
  assert.equal(outcome.error.code, 'SERVER_AUTH_FAILED');
  const requests = fs.existsSync(requestLog) ? fs.readFileSync(requestLog, 'utf8') : '';
  assert.equal(
    requests.split('\n').filter((line) => line === 'POST /api/publish').length,
    publishesBeforeForeignMode,
    'foreign listener received a view-only republish after losing full identity proof',
  );
  assert.equal(readLoopLog(gameDir).some((entry) => entry.event === 'user-view-republished'), false);
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

test('코치는 redacted hand·stats를 reserve 전에 캡처하고 동일 stats·owner·snapshot을 120초 파이프라인에 쓴다', { timeout: 15_000 }, async (t) => {
  const events = [];
  const coachCalls = [];
  const engineCalls = [];
  const upper = makeCoachAdapter({
    rounds: [{
      raw: JSON.stringify({ handNo: 1, text: '프리플랍 폴드는 무난합니다.' }),
      onStart: () => events.push('oneshotStart'),
    }],
  });
  const setup = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onEngineInvoke(args) {
        engineCalls.push(args);
        if (args[0] === 'hand' || args[0] === 'stats') events.push(`engine:${args[0]}`);
      },
      onCoachInvoke(args) {
        coachCalls.push(args);
        if (['reserve', 'bind-handle', 'accept'].includes(args[0])) events.push(`coach:${args[0]}`);
        if (args[0] === 'accept') {
          const authority = readJson(path.join(setup.gameDir, '.coach-authority.json'));
          assert.equal(fs.existsSync(authority.hands['1'].exactResultPath), true, 'accept ran before exactResultPath was written');
        }
      },
      onPublishInvoke(args) {
        if (String(args[1] ?? '').includes('.coach-')) events.push('publish:coach');
      },
    },
  });
  const { gameDir, loop } = setup;
  events.length = 0;
  coachCalls.length = 0;
  engineCalls.length = 0;
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  const running = startRun(loop);

  await waitForCoachNote(gameDir, 1);
  await waitForUserSnapshot(gameDir);
  await stopRun(loop, running);

  assert.deepEqual(events.slice(0, 7), [
    'engine:hand',
    'engine:stats',
    'coach:reserve',
    'oneshotStart',
    'coach:bind-handle',
    'coach:accept',
    'publish:coach',
  ]);
  const reserve = coachCalls.find((args) => args[0] === 'reserve');
  assert.ok(reserve, 'reserve was not invoked');
  const statsPath = reserve[reserve.indexOf('--stats-file') + 1];
  const snapshotPath = reserve[reserve.indexOf('--snapshot-file') + 1];
  assert.equal(path.resolve(snapshotPath), path.join(gameDir, 'ui-snapshot.json'));
  const capturedStats = fs.readFileSync(statsPath, 'utf8');
  assert.equal(upper.prompts[0].includes(capturedStats), true, 'prompt did not reuse the exact stats capture');
  assert.equal(upper.starts[0].timeoutMs, 120_000);
  for (const args of coachCalls.filter((args) => ['heartbeat', 'reserve', 'bind-handle', 'accept'].includes(args[0]))) {
    assert.equal(args[args.indexOf('--owner') + 1], owner, `${args[0]} minted a per-hand owner`);
    assert.equal(args[args.indexOf('--game-dir') + 1], gameDir, `${args[0]} omitted --game-dir`);
  }
  for (const args of engineCalls.filter((args) => args[0] === 'hand' || args[0] === 'stats')) {
    assert.equal(args[args.indexOf('--game-dir') + 1], gameDir, `${args[0]} omitted --game-dir`);
  }
  const authority = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(authority.activeOwnerSessionId, owner);
  assert.ok(authority.publishedSeals['1']);
  assert.equal(authority.retiredAttempts.every((row) => row.ownerSessionId === owner), true);
});

test('코치 프롬프트는 상대 비공개 홀카드와 아키타입 literal을 감추고 deny 파일로만 검증한다', { timeout: 15_000 }, async (t) => {
  let forbiddenFile = null;
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '공개 액션만 보면 무난한 폴드입니다.' }) }],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke(args) {
        if (args[0] === 'accept') forbiddenFile = args[args.indexOf('--forbidden-file') + 1];
      },
    },
  });
  const players = readJson(path.join(gameDir, 'players.json'));
  const villain = players.find((player) => player.playerId === 'p1');
  Object.assign(villain, {
    archetype: 'PRIVATE_ARCHETYPE_SENTINEL',
    personality: 'PRIVATE_PERSONALITY_SENTINEL',
    bluffFreq: 0.731927,
    threeBetFreq: 0.418263,
    tiltProne: true,
  });
  fs.writeFileSync(path.join(gameDir, 'players.json'), JSON.stringify(players));
  const running = startRun(loop);

  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  const record = readJson(path.join(gameDir, 'state.json')).lastHand;
  const privateCards = record.holes.p1;
  const prompt = upper.prompts[0];
  for (const literal of [
    ...privateCards,
    villain.archetype,
    villain.personality,
    String(villain.bluffFreq),
    String(villain.threeBetFreq),
  ]) {
    assert.equal(prompt.includes(literal), false, `private literal leaked into prompt: ${literal}`);
  }
  const deny = readJson(forbiddenFile);
  for (const literal of [...privateCards, villain.archetype, villain.personality]) {
    assert.equal(deny.includes(literal), true, `deny file omitted ${literal}`);
  }
  assert.equal(path.dirname(forbiddenFile), gameDir);
});

test('코치 oneshot은 spawn 직후 done을 기다리기 전에 pid:startTime을 bind-handle한다', { timeout: 15_000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let released = false;
  const order = [];
  const upper = makeCoachAdapter({
    rounds: [{
      gate,
      raw: JSON.stringify({ handNo: 1, text: '바인드 후 생성을 완료했습니다.' }),
      onStart: () => order.push('spawn'),
    }],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke(args) {
        if (args[0] !== 'bind-handle') return;
        assert.equal(released, false, 'done settled before bind-handle');
        order.push('bind');
        assert.equal(args[args.indexOf('--handle') + 1], '910000:coach-start-0');
      },
    },
  });
  const running = startRun(loop);

  await waitFor(() => order.includes('bind'), 'bind-handle was not invoked');
  released = true;
  release();
  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.deepEqual(order, ['spawn', 'bind']);
});

test('코치 1차 빈 text는 종료 확인 후 동일 입력 attempt 2로 교체하고 2차 실패는 generation 포함 unavailable로 봉인한다', { timeout: 15_000 }, async (t) => {
  const coachCalls = [];
  const upper = makeCoachAdapter({
    rounds: [
      { raw: JSON.stringify({ handNo: 1, text: '   ' }), terminate: { confirmed: true, reason: 'closed-one' } },
      { raw: JSON.stringify({ handNo: 1, text: '' }), terminate: { confirmed: true, reason: 'closed-two' } },
    ],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: { onCoachInvoke: (args) => coachCalls.push(args) },
  });
  const running = startRun(loop);

  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.equal(note.unavailable, true);
  assert.equal(upper.starts.length, 2);
  assert.equal(upper.terminations.length, 2);
  const statsRaw = fs.readFileSync(path.join(gameDir, '.coach-stats-1.json'), 'utf8');
  assert.equal(upper.prompts[0].includes(statsRaw), true);
  assert.equal(upper.prompts[1].includes(statsRaw), true);
  const reserves = coachCalls.filter((args) => args[0] === 'reserve');
  assert.deepEqual(reserves.map((args) => args[args.indexOf('--attempt') + 1]), ['1', '2']);
  const unavailable = coachCalls.find((args) => args[0] === 'complete-unavailable');
  assert.ok(unavailable, 'complete-unavailable was not invoked');
  assert.match(unavailable[unavailable.indexOf('--generation') + 1], /^\d+$/);
  assert.equal(unavailable[unavailable.indexOf('--snapshot-file') + 1], path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(coachCalls.filter((args) => args[0] === 'bind-handle').length, 2);
});

test('코치 terminate confirmed:false는 reason과 무관하게 교체를 금지하고 fence·adapter-disable 후 다음 핸드를 unavailable로 처리한다', { timeout: 20_000 }, async (t) => {
  const coachCalls = [];
  const upper = makeCoachAdapter({
    rounds: [{
      raw: JSON.stringify({ handNo: 1, text: '' }),
      terminate: { confirmed: false, reason: 'reason-must-not-control-the-branch' },
    }],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: { onCoachInvoke: (args) => coachCalls.push(args) },
  });
  const running = startRun(loop);
  const first = await waitForCoachNote(gameDir, 1);
  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  assert.equal(snapshot.view.handNo, 2);
  await postUserAction(lock, {
    decisionId: snapshot.view.legal.decisionId,
    action: 'fold',
  });
  const second = await waitForCoachNote(gameDir, 2);
  await stopRun(loop, running);

  assert.equal(first.unavailable, true);
  assert.equal(second.unavailable, true);
  assert.equal(upper.starts.length, 1, 'confirmed:false incorrectly allowed a replacement or later spawn');
  const verbs = coachCalls.map((args) => args[0]);
  assert.equal(verbs.includes('fence'), true);
  assert.equal(verbs.includes('adapter-disable'), true);
  const completes = coachCalls.filter((args) => args[0] === 'complete-unavailable');
  assert.equal(completes.length >= 2, true);
  assert.notEqual(completes[0].indexOf('--generation'), -1, 'fenced current generation was omitted');
  assert.equal(completes.some((args) => args.indexOf('--generation') === -1), true, 'future unavailable path reserved a generation');
  assert.equal(readJson(path.join(gameDir, '.coach-authority.json')).adapterState, 'disabled');
});

test('코치 1회성 생성이 느려도 다음 핸드 publish를 막지 않는다', { timeout: 15_000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const upper = makeCoachAdapter({
    rounds: [{ gate, raw: JSON.stringify({ handNo: 1, text: '늦은 코치' }) }],
  });
  const { gameDir, loop } = await setupCoachHand(t, { upper, loopOpts: { waitMs: 200 } });
  const running = startRun(loop);

  const nextHand = await waitForUserSnapshot(gameDir);
  assert.equal(nextHand.snapshot.view.handNo, 2);
  await waitFor(() => upper.starts.length === 1, 'slow coach oneshot did not start');
  assert.equal(upper.starts.length, 1);
  assert.equal((readJson(path.join(gameDir, 'ui-snapshot.json')).coach ?? []).length, 0);

  release();
  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  assert.equal(upper.disposed, 1);
});

test('practiceFocus 파일이 있으면 코치 프롬프트에 인라인된다', { timeout: 15_000 }, async (t) => {
  const focusSource = path.join(os.tmpdir(), `holdem-coach-focus-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(focusSource, JSON.stringify({ focus: 'TURN_BARREL_SENTINEL' }));
  t.after(() => { try { fs.unlinkSync(focusSource); } catch { /* already gone */ } });
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '연습 포커스를 반영했습니다.' }) }],
  });
  const { gameDir, loop } = await setupCoachHand(t, { upper, practiceFocusFile: focusSource });
  const running = startRun(loop);

  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.equal(upper.prompts[0].includes('TURN_BARREL_SENTINEL'), true);
  assert.equal(upper.prompts[0].includes('practiceFocus'), true);
});

test('upperAdapter가 null이면 oneshot·reserve 없이 snapshot을 전달한 complete-unavailable만 거쳐 다음 핸드로 간다', { timeout: 15_000 }, async (t) => {
  const coachCalls = [];
  const { gameDir, loop, player } = await setupCoachHand(t, {
    upper: null,
    notices: ['upper unavailable from resolver'],
    loopOpts: { onCoachInvoke: (args) => coachCalls.push(args) },
  });
  const running = startRun(loop);

  const note = await waitForCoachNote(gameDir, 1);
  const nextHand = await waitForUserSnapshot(gameDir);
  await stopRun(loop, running);

  assert.equal(note.unavailable, true);
  assert.equal(nextHand.snapshot.view.handNo, 2);
  assert.equal(typeof player.oneshotStart, 'undefined');
  assert.equal(coachCalls.some((args) => args[0] === 'reserve'), false);
  const unavailable = coachCalls.find((args) => args[0] === 'complete-unavailable');
  assert.ok(unavailable);
  assert.equal(unavailable.indexOf('--generation'), -1);
  assert.equal(unavailable[unavailable.indexOf('--snapshot-file') + 1], path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(unavailable[unavailable.indexOf('--game-dir') + 1], gameDir);
  const notices = readJson(path.join(gameDir, 'loop-state.json')).notices;
  assert.equal(notices.some((notice) => notice.includes('핸드 1') && notice.includes('고정 코치 문구')), true);
});

test('playing resume은 기존 coach Q를 descriptor·turn 전에 exact path로 먼저 게시하고 sealedSkipped를 respawn하지 않는다', { timeout: 30_000 }, async (t) => {
  for (const pendingAttempt of [false, true]) {
    await t.test(pendingAttempt ? 'recorded attempt first' : 'no recorded attempt', async (st) => {
      const gameDir = tmpGame();
      const first = createGameLoop({
        gameDir,
        resolver: resolverFor(makeAdapter()),
        opts: { port: 0, waitMs: 0 },
      });
      await first.bootstrap({ ai: 1, stack: 100 });
      putAiFirst(gameDir);
      const started = JSON.parse((await execFileAsync(process.execPath, [
        CLI, 'step', '--new-hand', '--game-dir', gameDir,
      ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
      assert.equal(started.next.toAct, 'p1');
      await execFileAsync(process.execPath, [
        CLI, 'step', 'p1', 'fold', '--expect-version', String(started.stateVersion),
        '--game-dir', gameDir,
      ], { encoding: 'utf8', timeout: 5_000 });
      const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
      const queued = await seedQueuedCoach(gameDir, owner, 1);
      await first.requestStop();

      if (pendingAttempt) {
        const engine = readJson(path.join(gameDir, 'state.json'));
        fs.writeFileSync(path.join(gameDir, '.publish-attempt.json'), JSON.stringify({
          body: {
            publishId: 1,
            messages: [{ type: 'narration', text: 'recorded-before-coach-Q' }],
          },
          expectedGameEpoch: gameEpochOf(engine.sessionToken),
        }));
      }

      const publishes = [];
      const upper = makeCoachAdapter();
      const resumed = createGameLoop({
        gameDir,
        resolver: resolverForCoach(makeAdapter(), upper),
        opts: {
          port: 0,
          waitMs: 0,
          onPublishInvoke: (args) => publishes.push(args),
        },
      });
      st.after(() => resumed.requestStop().catch(() => {}));

      await resumed.resume();

      const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
      assert.equal(snapshot.coach.some((note) => note.handNo === 1), true, 'resume returned before queued Q publication');
      assert.equal(readJson(path.join(gameDir, '.coach-authority.json')).publishQueue['1'], undefined);
      assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), false);
      assert.equal(upper.starts.length, 0, 'sealedSkipped queue was respawned');
      assert.equal(publishes.length >= 1, true);
      assert.equal(publishes[0][publishes[0].indexOf('--from') + 1], queued.exactEnvelopePath);
      assert.equal(publishes[0].includes('--retry'), pendingAttempt);
      if (pendingAttempt) {
        assert.equal(publishes.some((args) => !args.includes('--retry')), true, 'queued envelope was not published after recorded body');
      }
    });
  }
});

test('pending coach retry 후 reconcile가 일시 불가능하면 새 publishId 없이 COACH_RECONCILE_PENDING으로 중단하고 다음 resume이 reconcile-only로 해소한다', { timeout: 30_000 }, async (t) => {
  const gameDir = tmpGame();
  const initialized = await initGame(gameDir, ['--stack', '100']);
  putAiFirst(gameDir);
  const started = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'step', '--new-hand', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  await execFileAsync(process.execPath, [
    CLI, 'step', 'p1', 'fold', '--expect-version', String(started.stateVersion),
    '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 });

  const external = await startExternalServer(gameDir, initialized.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const oldOwner = 'coach-owner-before-reconcile-resume';
  writeLoopStateFixture(gameDir, initialized.sessionToken, {
    handNo: 1,
    port: external.lock.port,
    ownerSessionId: oldOwner,
  });
  const queued = await seedQueuedCoach(gameDir, oldOwner, 1);
  const envelope = readJson(queued.exactEnvelopePath);
  const attempt = {
    body: { publishId: 1, coach: envelope.coach },
    expectedGameEpoch: gameEpochOf(initialized.sessionToken),
    coachAuthority: envelope.coachAuthority,
  };
  const posted = await fetch(
    `http://127.0.0.1:${external.lock.port}/api/publish?token=${external.lock.sessionToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attempt.body),
    },
  );
  assert.equal(posted.ok, true);
  const acceptedSnapshotRaw = fs.readFileSync(path.join(gameDir, 'ui-snapshot.json'), 'utf8');
  const incompleteSnapshot = JSON.parse(acceptedSnapshotRaw);
  incompleteSnapshot.coach = [];
  fs.writeFileSync(path.join(gameDir, 'ui-snapshot.json'), JSON.stringify(incompleteSnapshot));
  fs.writeFileSync(path.join(gameDir, '.publish-attempt.json'), JSON.stringify(attempt));

  const firstPublishes = [];
  const firstUpper = makeCoachAdapter();
  const firstResume = createGameLoop({
    gameDir,
    resolver: resolverForCoach(makeAdapter(), firstUpper),
    opts: {
      port: 0,
      waitMs: 0,
      onPublishInvoke: (args) => firstPublishes.push(args),
    },
  });
  t.after(() => firstResume.requestStop().catch(() => {}));

  await assert.rejects(
    firstResume.resume(),
    (error) => error.code === 'COACH_RECONCILE_PENDING',
  );

  assert.equal(firstPublishes.length, 1, 'resume resent the same coach envelope with a new publishId');
  assert.equal(firstPublishes[0].includes('--retry'), true);
  assert.equal(readJson(path.join(gameDir, 'ui-snapshot.json')).publishId, 1);
  assert.equal(readJson(path.join(gameDir, '.coach-authority.json')).publishQueue['1'].queueId, envelope.coachAuthority.queueId);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).halt.code, 'COACH_RECONCILE_PENDING');
  assert.equal(firstUpper.starts.length, 0);

  const secondPublishes = [];
  const secondUpper = makeCoachAdapter();
  const secondResume = createGameLoop({
    gameDir,
    resolver: resolverForCoach(makeAdapter(), secondUpper),
    opts: {
      port: 0,
      waitMs: 0,
      onPublishInvoke: (args) => secondPublishes.push(args),
    },
  });
  t.after(() => secondResume.requestStop().catch(() => {}));

  await assert.rejects(
    secondResume.resume(),
    (error) => error.code === 'COACH_RECONCILE_PENDING',
  );

  assert.deepEqual(secondPublishes, [], 'reconcile-pending resume performed a network resend');
  assert.equal(secondUpper.starts.length, 0);
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).halt.code, 'COACH_RECONCILE_PENDING');
  assert.ok(readJson(path.join(gameDir, '.coach-authority.json')).publishQueue['1']);

  fs.writeFileSync(path.join(gameDir, 'ui-snapshot.json'), acceptedSnapshotRaw);
  const recoveredPublishes = [];
  const recoveredUpper = makeCoachAdapter();
  const recoveredResume = createGameLoop({
    gameDir,
    resolver: resolverForCoach(makeAdapter(), recoveredUpper),
    opts: {
      port: 0,
      waitMs: 0,
      onPublishInvoke: (args) => recoveredPublishes.push(args),
    },
  });
  t.after(() => recoveredResume.requestStop().catch(() => {}));

  const resumed = await recoveredResume.resume();

  assert.equal(resumed.phase, 'playing');
  assert.equal(Object.hasOwn(resumed, 'halt'), false);
  assert.deepEqual(recoveredPublishes, []);
  assert.equal(recoveredUpper.starts.length, 0);
  const finalAuthority = readJson(path.join(gameDir, '.coach-authority.json'));
  assert.equal(finalAuthority.publishQueue['1'], undefined);
  assert.ok(finalAuthority.publishedSeals['1']);
  assert.equal(readJson(path.join(gameDir, 'ui-snapshot.json')).publishId, 1);
});

test('live coach publish는 pending이 retry 직전 사라지고 reconcile이 pending이어도 exact envelope를 두 번 게시하지 않는다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const attemptPath = path.join(gameDir, '.publish-attempt.json');
  const controlPath = path.join(os.tmpdir(), `holdem-live-coach-control-${process.pid}-${Date.now()}`);
  const requestLog = path.join(os.tmpdir(), `holdem-live-coach-requests-${process.pid}-${Date.now()}.log`);
  const publishCalls = [];
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: 'live reconcile guard' }) }],
  });
  const loop = createGameLoop({
    gameDir,
    resolver: resolverForCoach(makeAdapter(), upper),
    opts: {
      port: 0,
      waitMs: 0,
      onPublishInvoke(args) {
        publishCalls.push(args);
        if (args.includes('--retry')) {
          try { fs.unlinkSync(attemptPath); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      },
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  const started = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'step', '--new-hand', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  await execFileAsync(process.execPath, [
    CLI, 'step', 'p1', 'fold', '--expect-version', String(started.stateVersion),
    '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 });

  const directPid = loop.serverPid;
  process.kill(directPid, 'SIGKILL');
  await waitUntilDead(directPid);
  try { fs.unlinkSync(path.join(gameDir, 'lock.json')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const relay = await startToggleAuthRelay(
    readJson(path.join(gameDir, 'state.json')).sessionToken,
    controlPath,
    requestLog,
  );
  t.after(async () => {
    await terminateIfAlive(relay.child);
    for (const file of [controlPath, requestLog]) {
      try { fs.unlinkSync(file); } catch { /* absent */ }
    }
  });
  const token = readJson(path.join(gameDir, 'state.json')).sessionToken;
  fs.writeFileSync(path.join(gameDir, 'lock.json'), JSON.stringify({
    serverPid: relay.child.pid,
    port: relay.port,
    sessionToken: token,
  }));
  fs.writeFileSync(path.join(gameDir, 'ui-snapshot.json'), JSON.stringify({
    revision: 0,
    // Proves the old recorded body by publishId so the live branch cannot pass via
    // recordedBodyProven; it must consume retry stdout hadCoach/reconcilePending.
    publishId: 1,
    view: null,
    log: [],
    coach: [],
    review: null,
    history: [],
  }));
  fs.writeFileSync(attemptPath, JSON.stringify({
    body: { publishId: 1, messages: [{ type: 'narration', text: 'pending disappears' }] },
    expectedGameEpoch: gameEpochOf(token),
  }));

  await assert.rejects(
    loop.coachPipeline(1),
    (error) => error.code === 'COACH_RECONCILE_PENDING',
  );

  const coachPublishes = fs.readFileSync(requestLog, 'utf8')
    .split('\n')
    .filter((line) => line === 'POST /api/publish');
  assert.equal(coachPublishes.length, 1, 'live guard sent the coach body more than once');
  assert.equal(publishCalls.filter((args) => args.includes('--retry')).length, 1);
  assert.equal(publishCalls.length, 2, 'live guard started a normal republish after retry');
  assert.ok(readJson(path.join(gameDir, '.coach-authority.json')).publishQueue['1']);
});

test('playing resume은 begin-owner 반환 descriptor의 redacted hand만 캡처하고 손상된 sealedSkipped archive를 읽지 않는다', { timeout: 20_000 }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  await first.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  let started = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'step', '--new-hand', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  await execFileAsync(process.execPath, [
    CLI, 'step', 'p1', 'fold', '--expect-version', String(started.stateVersion),
    '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 });
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  await seedQueuedCoach(gameDir, owner, 1);
  putAiFirst(gameDir);
  started = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'step', '--new-hand', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  await execFileAsync(process.execPath, [
    CLI, 'step', 'p1', 'fold', '--expect-version', String(started.stateVersion),
    '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 });
  await first.requestStop();
  const missingArchive = path.join(gameDir, 'hands', 'hand-0001.json');
  fs.unlinkSync(missingArchive);
  assert.equal(readJson(path.join(gameDir, 'state.json')).lastHand.handNo, 2);

  const handCalls = [];
  const resumed = createGameLoop({
    gameDir,
    resolver: resolverForCoach(makeAdapter(), null),
    opts: {
      port: 0,
      waitMs: 0,
      onEngineInvoke(args) {
        if (args[0] === 'hand') handCalls.push(Number(args[1]));
      },
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));

  await resumed.resume();
  const second = await waitForCoachNote(gameDir, 2);

  assert.equal(second.unavailable, true);
  assert.deepEqual(handCalls, [2]);
  assert.equal(readJson(path.join(gameDir, 'ui-snapshot.json')).coach.some((note) => note.handNo === 1), true);
});

test('handOver heartbeat 중 stop이 요청되면 coach task를 launch하지 않고 coachPipeline 진입도 새 child를 만들지 않는다', { timeout: 15_000 }, async (t) => {
  let loopRef = null;
  let stopPromise = null;
  let heartbeatRequestedStop = false;
  const engineHandsAfterStop = [];
  const upper = makeCoachAdapter();
  const setup = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke(args) {
        if (args[0] === 'heartbeat' && !stopPromise) {
          heartbeatRequestedStop = true;
          stopPromise = loopRef.requestStop();
        }
      },
      onEngineInvoke(args) {
        if (loopRef?.stopping && args[0] === 'hand') engineHandsAfterStop.push(Number(args[1]));
      },
    },
  });
  loopRef = setup.loop;
  const owner = readJson(path.join(setup.gameDir, 'loop-state.json')).ownerSessionId;
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', setup.gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(setup.gameDir, '.stop-guard-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  await runCoachCli(setup.gameDir, [
    'begin-owner', '--owner', owner, '--completed', '0', '--stats-file', statsPath,
    '--snapshot-file', path.join(setup.gameDir, 'ui-snapshot.json'),
  ]);
  const running = startRun(setup.loop);

  await running.catch(() => {});
  assert.equal(heartbeatRequestedStop, true, 'handOver did not reach heartbeat');
  await stopPromise;
  await setup.loop.coachPipeline(1).catch(() => {});

  assert.deepEqual(engineHandsAfterStop, []);
  assert.equal(upper.starts.length, 0);
});

test('heartbeat result-ready remediation은 다음 핸드를 막지 않지만 shutdown은 tracked remediation settle을 기다린다', { timeout: 20_000 }, async (t) => {
  let releaseGeneration;
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  let enteredTerminate;
  const terminateEntered = new Promise((resolve) => { enteredTerminate = resolve; });
  let releaseTerminate;
  const terminateGate = new Promise((resolve) => { releaseTerminate = resolve; });
  t.after(() => {
    releaseGeneration();
    releaseTerminate();
  });
  const upper = makeCoachAdapter({
    rounds: [{
      gate: generationGate,
      raw: JSON.stringify({ handNo: 1, text: '늦은 원본' }),
      terminate: async () => {
        enteredTerminate();
        await terminateGate;
        return { confirmed: true };
      },
    }],
  });
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: { waitMs: 40 },
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
  await terminateEntered;

  await waitFor(
    () => readJson(path.join(gameDir, 'state.json')).handNo >= 3,
    'next hand waited for heartbeat remediation termination',
    1_000,
  );
  let stopSettled = false;
  const stopping = loop.requestStop().finally(() => { stopSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopSettled, false, 'shutdown ignored tracked heartbeat remediation');
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true);

  releaseTerminate();
  await stopping;
  await running.catch(() => {});
});

test('heartbeat result-ready accept 실패는 handle 종료 확인·fence 후 generation-bearing unavailable로 봉인한다', { timeout: 20_000 }, async (t) => {
  const never = new Promise(() => {});
  const upper = makeCoachAdapter({
    rounds: [{
      gate: never,
      raw: JSON.stringify({ handNo: 1, text: '사용되지 않음' }),
      terminate: { confirmed: true },
    }],
  });
  const { gameDir, loop } = await setupCoachHand(t, { upper });
  const running = startRun(loop);
  const handTwo = await waitForUserSnapshot(gameDir);
  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = await waitFor(() => {
    const value = readJson(authorityPath);
    return value.hands?.['1']?.agentHandle ? value : null;
  }, 'hand 1 coach generation was not running');
  const forbidden = readJson(path.join(gameDir, '.coach-deny-1.json'))[0];
  fs.writeFileSync(authority.hands['1'].exactResultPath, JSON.stringify({
    handNo: 1,
    text: `forbidden ${forbidden}`,
  }));
  authority.hands['1'].deadlineMono = '0';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  await postUserAction(handTwo.lock, {
    decisionId: handTwo.snapshot.view.legal.decisionId,
    action: 'fold',
  });

  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);

  assert.equal(note.unavailable, true);
  assert.equal(upper.terminations.length >= 1, true);
  assert.equal(readJson(authorityPath).publishedSeals['1'].noteKind, 'unavailable');
});

test('attempt 2 reserve가 ADAPTER_DISABLED면 종료 확인된 attempt 1을 fence하고 generation-bearing unavailable로 봉인한다', { timeout: 15_000 }, async (t) => {
  let gameDir = null;
  let disabledAtAttemptTwo = false;
  const coachCalls = [];
  const upper = makeCoachAdapter({
    rounds: [{
      raw: JSON.stringify({ handNo: 1, text: '' }),
      terminate: { confirmed: true },
    }],
  });
  const setup = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onCoachInvoke(args) {
        coachCalls.push(args);
        if (
          gameDir
          && !disabledAtAttemptTwo
          && args[0] === 'reserve'
          && args[args.indexOf('--attempt') + 1] === '2'
        ) {
          disabledAtAttemptTwo = true;
          const authorityPath = path.join(gameDir, '.coach-authority.json');
          const authority = readJson(authorityPath);
          authority.adapterState = 'disabled';
          fs.writeFileSync(authorityPath, JSON.stringify(authority));
        }
      },
    },
  });
  gameDir = setup.gameDir;
  const running = startRun(setup.loop);

  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(setup.loop, running);

  assert.equal(disabledAtAttemptTwo, true);
  assert.equal(note.unavailable, true);
  assert.equal(upper.starts.length, 1);
  assert.equal(coachCalls.some((args) => args[0] === 'fence'), true);
  const unavailable = coachCalls.find((args) => args[0] === 'complete-unavailable');
  assert.ok(unavailable);
  assert.notEqual(unavailable.indexOf('--generation'), -1);
});

test('playing resume descriptor에 upper adapter interface가 없으면 해당 generation을 unavailable로 봉인한다', { timeout: 15_000 }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  await first.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  const started = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'step', '--new-hand', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  await execFileAsync(process.execPath, [
    CLI, 'step', 'p1', 'fold', '--expect-version', String(started.stateVersion),
    '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 });
  await first.requestStop();

  const coachCalls = [];
  const unusableUpper = makeAdapter();
  const resumed = createGameLoop({
    gameDir,
    resolver: resolverForCoach(makeAdapter(), unusableUpper),
    opts: {
      port: 0,
      waitMs: 0,
      onCoachInvoke: (args) => coachCalls.push(args),
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));

  await resumed.resume();
  const note = await waitForCoachNote(gameDir, 1);

  assert.equal(note.unavailable, true);
  const unavailable = coachCalls.find((args) => args[0] === 'complete-unavailable');
  assert.ok(unavailable);
  assert.notEqual(unavailable.indexOf('--generation'), -1);
  const seal = await waitFor(() => (
    readJson(path.join(gameDir, '.coach-authority.json')).publishedSeals['1'] ?? null
  ), 'upper-unusable unavailable did not reconcile to a seal');
  assert.equal(seal.noteKind, 'unavailable');
});

test('heartbeat가 generation을 먼저 retire해도 unconfirmed 종료는 STALE_GENERATION을 fenced로 보고 adapter-disable·current/future unavailable을 완수한다', { timeout: 20_000 }, async (t) => {
  let enteredTerminate;
  const terminateEntered = new Promise((resolve) => { enteredTerminate = resolve; });
  let releaseTerminate;
  const terminateGate = new Promise((resolve) => { releaseTerminate = resolve; });
  t.after(() => releaseTerminate());
  const upper = makeCoachAdapter({
    rounds: [{
      raw: JSON.stringify({ handNo: 1, text: '' }),
      terminate: async () => {
        enteredTerminate();
        await terminateGate;
        return { confirmed: false, reason: 'still-alive-after-heartbeat' };
      },
    }],
  });
  const { gameDir, loop } = await setupCoachHand(t, { upper });
  const running = startRun(loop);
  await terminateEntered;

  const authorityPath = path.join(gameDir, '.coach-authority.json');
  const authority = readJson(authorityPath);
  authority.hands['1'].deadlineMono = '0';
  fs.writeFileSync(authorityPath, JSON.stringify(authority));
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  const heartbeat = await runCoachCli(gameDir, ['heartbeat', '--owner', owner]);
  assert.deepEqual(heartbeat.actions.map((action) => action.action), ['timeout-fence']);

  releaseTerminate();
  const first = await waitForCoachNote(gameDir, 1);
  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  await postUserAction(lock, {
    decisionId: snapshot.view.legal.decisionId,
    action: 'fold',
  });
  const second = await waitForCoachNote(gameDir, 2);
  await stopRun(loop, running);

  assert.equal(first.unavailable, true);
  assert.equal(second.unavailable, true);
  assert.equal(upper.starts.length, 1);
  assert.equal(readJson(authorityPath).adapterState, 'disabled');
});

test('capture 중 adapter가 disabled되어 reserve가 ADAPTER_DISABLED면 generation 없는 unavailable fallback을 게시한다', { timeout: 15_000 }, async (t) => {
  let gameDir = null;
  let injectedDisable = false;
  const coachCalls = [];
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '스폰되면 안 됨' }) }],
  });
  const setup = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onEngineInvoke(args) {
        if (!gameDir || injectedDisable || args[0] !== 'hand') return;
        injectedDisable = true;
        const authorityPath = path.join(gameDir, '.coach-authority.json');
        const authority = readJson(authorityPath);
        authority.adapterState = 'disabled';
        fs.writeFileSync(authorityPath, JSON.stringify(authority));
      },
      onCoachInvoke(args) { coachCalls.push(args); },
    },
  });
  gameDir = setup.gameDir;
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  const stats = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'stats', '--game-dir', gameDir,
  ], { encoding: 'utf8', timeout: 5_000 })).stdout.trim());
  const statsPath = path.join(gameDir, '.adapter-race-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify(stats));
  await runCoachCli(gameDir, [
    'begin-owner', '--owner', owner, '--completed', '0', '--stats-file', statsPath,
    '--snapshot-file', path.join(gameDir, 'ui-snapshot.json'),
  ]);
  coachCalls.length = 0;
  const running = startRun(setup.loop);

  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(setup.loop, running);

  assert.equal(injectedDisable, true);
  assert.equal(note.unavailable, true);
  assert.equal(upper.starts.length, 0);
  assert.equal(coachCalls.filter((args) => args[0] === 'reserve').length, 1);
  const unavailable = coachCalls.find((args) => args[0] === 'complete-unavailable');
  assert.ok(unavailable);
  assert.equal(unavailable.includes('--generation'), false);
  assert.equal(readJson(path.join(gameDir, '.coach-authority.json')).publishedSeals['1'].noteKind, 'unavailable');
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

test('SIGTERM during D9 health await cannot unlink, spawn, retry, or resolve the attempt', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter(), loopOpts: { waitMs: 0 } });
  const lockPath = path.join(gameDir, 'lock.json');
  const originalRaw = fs.readFileSync(lockPath, 'utf8');
  const original = readJson(lockPath);
  process.kill(original.serverPid, 'SIGKILL');
  await waitUntilDead(original.serverPid);
  const originalStat = fs.lstatSync(lockPath);
  const blackholeLog = path.join(os.tmpdir(), `holdem-d9-stop-${process.pid}-${Date.now()}.log`);
  const blackhole = await startPublishFailHealthHangServer(original.port, blackholeLog);
  t.after(async () => {
    await terminateIfAlive(blackhole);
    try { fs.unlinkSync(blackholeLog); } catch { /* absent */ }
  });
  const running = startRun(loop);
  await waitWhileRunning(running, () => (
    fs.existsSync(blackholeLog) && fs.readFileSync(blackholeLog, 'utf8').includes('/api/health')
  ), 'D9 did not enter the health await');

  const stopping = loop.requestStop();
  await assert.rejects(running, (error) => error.code === 'STOPPING');
  await stopping;

  const finalStat = fs.lstatSync(lockPath);
  assert.equal(finalStat.dev, originalStat.dev);
  assert.equal(finalStat.ino, originalStat.ino, 'recovery replaced or unlinked the pinned lock while stopping');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalRaw);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), true);
  assert.equal(readLoopLog(gameDir).some((entry) => entry.event === 'server-recovered'), false);
});

test('D9 preserves an identical-byte replacement lock by pinned path identity and aborts recovery', { timeout: 15_000 }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter(), loopOpts: { waitMs: 0 } });
  const lockPath = path.join(gameDir, 'lock.json');
  const originalRaw = fs.readFileSync(lockPath, 'utf8');
  const original = readJson(lockPath);
  process.kill(original.serverPid, 'SIGKILL');
  await waitUntilDead(original.serverPid);
  const blackholeLog = path.join(os.tmpdir(), `holdem-d9-pin-${process.pid}-${Date.now()}.log`);
  const blackhole = await startPublishFailHealthHangServer(original.port, blackholeLog);
  t.after(async () => {
    await terminateIfAlive(blackhole);
    try { fs.unlinkSync(blackholeLog); } catch { /* absent */ }
  });
  const running = startRun(loop);
  await waitWhileRunning(running, () => (
    fs.existsSync(blackholeLog) && fs.readFileSync(blackholeLog, 'utf8').includes('/api/health')
  ), 'D9 did not pin the lock before its health await');

  const replacementTmp = `${lockPath}.replacement`;
  fs.writeFileSync(replacementTmp, originalRaw);
  fs.renameSync(replacementTmp, lockPath);
  const replacementStat = fs.lstatSync(lockPath);
  const outcome = await Promise.race([
    running.then(
      () => ({ type: 'resolved' }),
      (error) => ({ type: 'rejected', error }),
    ),
    waitFor(
      () => readLoopLog(gameDir).some((entry) => entry.event === 'server-recovered'),
      'recovery neither rejected nor spawned',
      4_000,
    ).then(() => ({ type: 'recovered' })),
  ]);

  assert.equal(outcome.type, 'rejected');
  assert.equal(outcome.error.code, 'SERVER_LOCK_REPLACED');
  const finalStat = fs.lstatSync(lockPath);
  assert.equal(finalStat.dev, replacementStat.dev);
  assert.equal(finalStat.ino, replacementStat.ino, 'replacement lock inode was unlinked');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalRaw);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), true);
});

test('D9 atomic retirement restores an identical-byte inode swapped at the retirement syscall', { timeout: 15_000, concurrency: false }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter(), loopOpts: { waitMs: 0 } });
  const lockPath = path.join(gameDir, 'lock.json');
  const originalRaw = fs.readFileSync(lockPath, 'utf8');
  const original = readJson(lockPath);
  process.kill(original.serverPid, 'SIGKILL');
  await waitUntilDead(original.serverPid);
  const replacementPath = `${lockPath}.retirement-swap`;
  fs.writeFileSync(replacementPath, originalRaw);
  const replacementStat = fs.lstatSync(replacementPath);

  let running;
  const outcome = await withServerLockSwapAtRetirement(lockPath, replacementPath, async (wasSwapped) => {
    running = startRun(loop);
    const observed = await Promise.race([
      running.then(
        () => ({ type: 'resolved' }),
        (error) => ({ type: 'rejected', error }),
      ),
      waitFor(
        () => readLoopLog(gameDir).some((entry) => entry.event === 'server-recovered'),
        'retirement swap neither rejected nor recovered',
        5_000,
      ).then(() => ({ type: 'recovered' })),
    ]);
    return { ...observed, swapped: wasSwapped() };
  });
  if (outcome.type === 'recovered') await stopRun(loop, running);

  assert.equal(outcome.swapped, true, 'test did not swap at the destructive retirement operation');
  assert.equal(outcome.type, 'rejected');
  assert.equal(outcome.error.code, 'SERVER_LOCK_REPLACED');
  const finalStat = fs.lstatSync(lockPath);
  assert.equal(finalStat.dev, replacementStat.dev);
  assert.equal(finalStat.ino, replacementStat.ino, 'replacement inode was not restored or preserved');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalRaw);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), true);
});

test('D9 quarantine restore never clobbers a second lock created immediately before restore', { timeout: 15_000, concurrency: false }, async (t) => {
  const { gameDir, loop } = await setupAiFirst(t, { adapter: makeAdapter(), loopOpts: { waitMs: 0 } });
  const lockPath = path.join(gameDir, 'lock.json');
  const firstRaw = fs.readFileSync(lockPath, 'utf8');
  const original = JSON.parse(firstRaw);
  process.kill(original.serverPid, 'SIGKILL');
  await waitUntilDead(original.serverPid);
  const firstReplacementPath = `${lockPath}.first-restore-swap`;
  fs.writeFileSync(firstReplacementPath, firstRaw);
  const firstStat = fs.lstatSync(firstReplacementPath);
  const secondRaw = JSON.stringify({ ...original, startedAt: 'second-lock-must-survive' });

  let running;
  const outcome = await withSecondServerLockBeforeRestore({
    lockPath,
    firstReplacementPath,
    secondRaw,
  }, async (inspect) => {
    running = startRun(loop);
    const observed = await Promise.race([
      running.then(
        () => ({ type: 'resolved' }),
        (error) => ({ type: 'rejected', error }),
      ),
      waitFor(
        () => readLoopLog(gameDir).some((entry) => entry.event === 'server-recovered'),
        'double replacement neither rejected nor recovered',
        5_000,
      ).then(() => ({ type: 'recovered' })),
    ]);
    return { ...observed, race: inspect() };
  });
  if (outcome.type === 'recovered') await stopRun(loop, running);

  assert.equal(outcome.type, 'rejected');
  assert.equal(outcome.error.code, 'SERVER_LOCK_REPLACED');
  assert.equal(outcome.race.firstSwapped, true);
  assert.equal(outcome.race.secondInserted, true, 'test never reached the restore primitive');
  const finalStat = fs.lstatSync(lockPath);
  assert.equal(finalStat.dev, outcome.race.secondStat.dev);
  assert.equal(finalStat.ino, outcome.race.secondStat.ino, 'restore clobbered the second lock');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), secondRaw);
  assert.equal(fs.existsSync(outcome.race.quarantinePath), true, 'first replacement quarantine was deleted');
  const quarantinedStat = fs.lstatSync(outcome.race.quarantinePath);
  assert.equal(quarantinedStat.dev, firstStat.dev);
  assert.equal(quarantinedStat.ino, firstStat.ino);
  assert.equal(fs.readFileSync(outcome.race.quarantinePath, 'utf8'), firstRaw);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-attempt.json')), true);
});

test('D9 stop checkpoints fence retirement, spawn, and recorded-body retry interleavings', { timeout: 30_000 }, async (t) => {
  for (const boundary of ['before-retire', 'before-spawn', 'before-retry']) {
    await t.test(boundary, async (st) => {
      let loopRef = null;
      let stopping = null;
      const seen = [];
      const setup = await setupAiFirst(st, {
        adapter: makeAdapter(),
        loopOpts: {
          waitMs: 0,
          d9Checkpoint(name) {
            seen.push(name);
            if (name === boundary && stopping === null) stopping = loopRef.requestStop();
          },
        },
      });
      loopRef = setup.loop;
      const stale = readJson(path.join(setup.gameDir, 'lock.json'));
      process.kill(stale.serverPid, 'SIGKILL');
      await waitUntilDead(stale.serverPid);
      const running = startRun(loopRef);
      const outcome = await Promise.race([
        running.then(
          () => ({ type: 'resolved' }),
          (error) => ({ type: 'rejected', error }),
        ),
        waitForUserSnapshot(setup.gameDir, 5_000).then(() => ({ type: 'continued' })),
      ]);
      if (outcome.type === 'continued') await stopRun(loopRef, running);
      if (stopping) await stopping;

      assert.equal(seen.includes(boundary), true, `${boundary} checkpoint was not reached`);
      assert.equal(outcome.type, 'rejected', `D9 continued across ${boundary}`);
      assert.equal(outcome.error.code, 'STOPPING');
      assert.equal(fs.existsSync(path.join(setup.gameDir, '.publish-attempt.json')), true);
    });
  }
});

test('production SIGTERM during runtime resolution reaps the registered probe child before releasing loop ownership', { timeout: 15_000, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-resolver-stop-bin-'));
  const runtimeLog = path.join(binDir, 'runtime.pid');
  const claudePath = path.join(binDir, 'claude');
  fs.writeFileSync(claudePath, `#!/usr/bin/env node
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(runtimeLog)}, String(process.pid) + '\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `);
  fs.chmodSync(claudePath, 0o755);
  const child = spawn(process.execPath, [
    GAME_LOOP, '--ai', '1', '--stack', '100', '--game-dir', gameDir, '--player-runtime', 'claude',
  ], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    stdio: 'ignore',
  });
  let runtimePid = null;
  t.after(async () => {
    await terminateIfAlive(child);
    if (runtimePid) {
      try { process.kill(runtimePid, 'SIGKILL'); } catch { /* already dead */ }
      await waitUntilDead(runtimePid).catch(() => {});
    }
  });
  await waitFor(() => {
    if (!fs.existsSync(runtimeLog) || !fs.existsSync(path.join(gameDir, 'loop.lock.d'))) return null;
    runtimePid = Number(fs.readFileSync(runtimeLog, 'utf8').trim().split('\n')[0]);
    return Number.isInteger(runtimePid) && runtimePid > 0;
  }, 'production resolver probe child did not start', 5_000);

  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ type: 'exit', code, signal })));
  child.kill('SIGTERM');
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 5_000)),
  ]);

  assert.deepEqual(outcome, { type: 'exit', code: 0, signal: null });
  await waitUntilDead(runtimePid);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('SIGTERM during direct server startup owns and reaps the child before health identity capture', { timeout: 15_000 }, async (t) => {
  const gameDir = tmpGame();
  const marker = path.join(gameDir, 'startup-health-pending');
  const loopUrl = pathToFileURL(path.join(ROOT, 'tools/game-loop.js')).href;
  const script = `
    import fs from 'node:fs';
    import { createGameLoop } from ${JSON.stringify(loopUrl)};
    const originalFetch = globalThis.fetch;
    let releaseHealth = null;
    globalThis.fetch = (url, options) => {
      if (String(url).includes('/api/health') && releaseHealth === null) {
        fs.writeFileSync(${JSON.stringify(marker)}, 'pending');
        return new Promise((resolve, reject) => {
          releaseHealth = () => originalFetch(url, options).then(resolve, reject);
        });
      }
      return originalFetch(url, options);
    };
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
    let handlingSignal = false;
    let stopPromise = null;
    let caught = null;
    process.once('SIGTERM', () => {
      handlingSignal = true;
      stopPromise = loop.requestStop().finally(() => releaseHealth?.());
      stopPromise.catch(() => {});
    });
    try {
      await loop.bootstrap({ai: 1, stack: 100});
    } catch (error) {
      if (!(handlingSignal && error.code === 'STOPPING')) caught = error;
    } finally {
      try {
        if (stopPromise) await stopPromise;
        else await loop.requestStop();
      } catch (error) {
        caught ??= error;
      }
    }
    process.exit(caught ? 5 : 0);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'ignore',
  });
  let serverPid = null;
  t.after(async () => {
    await terminateIfAlive(child);
    if (serverPid) {
      try { process.kill(serverPid, 'SIGKILL'); } catch { /* already dead */ }
      await waitUntilDead(serverPid).catch(() => {});
    }
  });
  await waitFor(() => {
    if (!fs.existsSync(marker)) return null;
    try {
      serverPid = readJson(path.join(gameDir, 'lock.json')).serverPid;
      return Number.isInteger(serverPid) ? serverPid : null;
    } catch {
      return null;
    }
  }, 'server startup did not reach the blocked health probe', 5_000);

  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const outcome = await exited;

  assert.deepEqual(outcome, { code: 0, signal: null });
  await waitUntilDead(serverPid);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
});

test('initial server startTime failure retains ownership after a failed kill and requestStop confirms retry cleanup', { timeout: 15_000, concurrency: false }, async () => {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  const originalKill = ChildProcess.prototype.kill;
  let serverHandle = null;
  const killAttempts = [];
  ChildProcess.prototype.kill = function failFirstStartupKill(signal) {
    if (signal === 'SIGKILL' && this.spawnargs?.includes(SERVER)) {
      serverHandle = this;
      killAttempts.push(signal);
      if (killAttempts.length === 1) return false;
    }
    return originalKill.call(this, signal);
  };
  try {
    await withFakePs(
      `if [ "$2" != "${process.pid}" ]; then exit 1; fi\nexec ${REAL_PS} "$@"`,
      async () => assert.rejects(
        loop.bootstrap({ ai: 1, stack: 100 }),
        (error) => error.code === 'SERVER_IDENTITY_UNAVAILABLE',
      ),
    );

    assert.equal(killAttempts.length, 2, 'requestStop did not retry the failed startup SIGKILL');
    assert.equal(serverHandle !== null, true);
    await waitUntilDead(serverHandle.pid);
    assert.equal(loop.serverPid, null);
    assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
  } finally {
    ChildProcess.prototype.kill = originalKill;
    if (serverHandle && serverHandle.exitCode === null && serverHandle.signalCode === null) {
      originalKill.call(serverHandle, 'SIGKILL');
      await waitUntilDead(serverHandle.pid).catch(() => {});
    }
  }
});

test('unsettled cleanup retains loop lock, blocks a contender, and releases only after a confirmed requestStop retry', { timeout: 20_000, concurrency: false }, async () => {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  const originalKill = ChildProcess.prototype.kill;
  let serverHandle = null;
  let killAttempts = 0;
  let prototypeRestored = false;
  ChildProcess.prototype.kill = function rejectStartupKills(signal) {
    if (signal === 'SIGKILL' && this.spawnargs?.includes(SERVER)) {
      serverHandle = this;
      killAttempts += 1;
      return false;
    }
    return originalKill.call(this, signal);
  };
  try {
    await withFakePs(
      `if [ "$2" != "${process.pid}" ]; then exit 1; fi\nexec ${REAL_PS} "$@"`,
      async () => assert.rejects(
        loop.bootstrap({ ai: 1, stack: 100 }),
        (error) => error.code === 'SERVER_STOP_UNCONFIRMED',
      ),
    );

    assert.equal(killAttempts >= 2, true, 'requestStop did not retry unsettled startup cleanup');
    assert.equal(loop.serverPid, serverHandle.pid, 'unsettled child ownership was discarded');
    assert.doesNotThrow(() => process.kill(serverHandle.pid, 0));
    assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true, 'cleanup failure released loop ownership');
    const failedState = readJson(path.join(gameDir, 'loop-state.json'));
    assert.equal(failedState.stoppedAt, undefined);
    assert.equal(failedState.cleanupError.code, 'SERVER_STOP_UNCONFIRMED');

    let contenderResolverCalls = 0;
    const contender = createGameLoop({
      gameDir,
      resolver: async () => {
        contenderResolverCalls += 1;
        return resolverFor(makeAdapter())();
      },
      opts: { port: 0, waitMs: 0 },
    });
    await assert.rejects(contender.resume(), (error) => error.code === 'LOCKED');
    assert.equal(contenderResolverCalls, 0, 'contender reached resolver while failed owner retained the lock');

    ChildProcess.prototype.kill = originalKill;
    prototypeRestored = true;
    await loop.requestStop();
    await waitUntilDead(serverHandle.pid);
    assert.equal(loop.serverPid, null);
    assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
    const stopped = readJson(path.join(gameDir, 'loop-state.json'));
    assert.equal(typeof stopped.stoppedAt, 'string');
    assert.equal(Object.hasOwn(stopped, 'cleanupError'), false);
  } finally {
    if (!prototypeRestored) ChildProcess.prototype.kill = originalKill;
    if (serverHandle && serverHandle.exitCode === null && serverHandle.signalCode === null) {
      originalKill.call(serverHandle, 'SIGKILL');
      await waitUntilDead(serverHandle.pid).catch(() => {});
    }
  }
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

test('production SIGTERM reports cleanup failure and exits nonzero instead of masking it', { timeout: 20_000, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-loop-main-bin-'));
  const marker = path.join(binDir, 'reuse.marker');
  const targetFile = path.join(binDir, 'reuse.pid');
  const claudePath = path.join(binDir, 'claude');
  fs.writeFileSync(claudePath, `#!/usr/bin/env node
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.readFileSync(0, 'utf8');
    if (args.includes('stream-json')) {
      process.stdout.write(JSON.stringify({type:'system',subtype:'init',tools:[],mcp_servers:[],hooks:[]}) + '\\n');
      process.stdout.write(JSON.stringify({type:'result',result:'ok'}) + '\\n');
    } else {
      process.stdout.write('ready\\n');
    }
  `);
  fs.chmodSync(claudePath, 0o755);
  const psPath = path.join(binDir, 'ps');
  fs.writeFileSync(psPath, `#!/bin/sh
    if [ -f "${marker}" ] && [ -f "${targetFile}" ]; then
      target=$(sed -n '1p' "${targetFile}")
      if [ "$2" = "$target" ]; then echo 'Mon Jan  1 00:00:00 2001'; exit 0; fi
    fi
    exec ${REAL_PS} "$@"
  `);
  fs.chmodSync(psPath, 0o755);
  let stderr = '';
  const child = spawn(process.execPath, [
    GAME_LOOP, '--ai', '1', '--stack', '100', '--game-dir', gameDir, '--player-runtime', 'claude',
  ], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let serverPid = null;
  t.after(async () => {
    await terminateIfAlive(child);
    if (serverPid) {
      try { process.kill(serverPid, 'SIGKILL'); } catch { /* already dead */ }
      await waitUntilDead(serverPid).catch(() => {});
    }
  });
  await waitFor(() => {
    try {
      const state = readJson(path.join(gameDir, 'loop-state.json'));
      const lock = readJson(path.join(gameDir, 'lock.json'));
      if (state.phase !== 'playing' || !Number.isInteger(lock.serverPid)) return null;
      serverPid = lock.serverPid;
      return lock;
    } catch {
      return null;
    }
  }, 'production game-loop did not reach playing', 10_000);
  const userTurn = await waitForUserSnapshot(gameDir, 5_000);
  const userAction = preferredUserAction(userTurn.snapshot.view.legal);
  await postUserAction(userTurn.lock, userAction);
  await waitForUserAction(gameDir, (action) => action.decisionId === userAction.decisionId, 5_000);
  fs.writeFileSync(targetFile, `${serverPid}\n`);
  fs.writeFileSync(marker, 'reuse');
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  child.kill('SIGTERM');
  const result = await exited;

  assert.deepEqual(result, { code: 5, signal: null });
  const envelope = stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).at(-1);
  assert.equal(envelope.code, 'SERVER_IDENTITY_MISMATCH');
  assert.doesNotThrow(() => process.kill(serverPid, 0), 'cleanup failure fixture server was signalled');
  const retainedOwner = readOwnedLock(gameDir, 'loop.lock.d');
  assert.notEqual(retainedOwner, null, 'nonzero SIGTERM exit removed the failed owner lock');
  assert.equal(retainedOwner.status, 'dead');
  assert.equal(retainedOwner.pid, child.pid);
  const failedState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(failedState.stoppedAt, undefined);
  assert.equal(failedState.cleanupError.code, 'SERVER_IDENTITY_MISMATCH');

  const recovery = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0, waitMs: 0 },
  });
  await recovery.resume();
  await recovery.requestStop();
  await waitUntilDead(serverPid);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
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

test('--force stale-lock cleanup atomically preserves an inode swapped at retirement', { timeout: 15_000, concurrency: false }, async (t) => {
  const gameDir = tmpGame();
  const initialized = await initGame(gameDir);
  const external = await startExternalServer(gameDir, initialized.sessionToken);
  const lockPath = path.join(gameDir, 'lock.json');
  const originalRaw = fs.readFileSync(lockPath, 'utf8');
  process.kill(external.child.pid, 'SIGKILL');
  await waitUntilDead(external.child.pid);
  const replacementPath = `${lockPath}.force-retirement-swap`;
  fs.writeFileSync(replacementPath, originalRaw);
  const replacementStat = fs.lstatSync(replacementPath);
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    opts: { port: 0 },
  });
  t.after(() => loop.requestStop().catch(() => {}));

  let swapped = false;
  await withServerLockSwapAtRetirement(lockPath, replacementPath, async (wasSwapped) => {
    await assert.rejects(
      loop.bootstrap({ ai: 1, stack: 100, force: true }),
      (error) => error.code === 'SERVER_LOCK_REPLACED',
    );
    swapped = wasSwapped();
  });

  assert.equal(swapped, true, 'test did not swap at force retirement');
  const finalStat = fs.lstatSync(lockPath);
  assert.equal(finalStat.dev, replacementStat.dev);
  assert.equal(finalStat.ino, replacementStat.ino, 'force cleanup deleted the replacement inode');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalRaw);
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
    gameEpoch: gameEpochOf(init.sessionToken),
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

test('upper-null finalization keeps notices and phase, clears REVIEW_FAILED, and reaches the Task 7 stub', async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
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
  });
  t.after(() => loop.requestStop());

  const resumed = await loop.resume();

  assert.equal(resumed.phase, 'finalizing');
  assert.equal(resumed.upperRuntime, null);
  assert.deepEqual(resumed.notices, ['prior notice', 'upper unavailable']);
  assert.equal(Object.hasOwn(resumed, 'halt'), false);
  assert.notEqual(resumed.ownerSessionId, 'old-owner');
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
