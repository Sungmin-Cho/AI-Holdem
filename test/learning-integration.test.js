import { readFirstFixtureRecord } from './helpers/fixture-readiness.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModeDefaults, parseGameLoopArgs, engineInitFlags, gtoEvalNotice, createGameLoop } from '../tools/game-loop.js';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
test('REQ-001: new store sessions default to policy learning', () => {
  const parsed = parseGameLoopArgs(['--store-dir', '/tmp/s8-new-store']);
  const resolved = applyModeDefaults(parsed);
  assert.equal(resolved.opponentRuntime, 'policy', 'new store learning sessions must use policy opponents');
});

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newDeck } from '../engine/cards.js';
import { isPrivatePath, windowsPowerShellEnvironment } from '../shared/platform-files.js';
import { ownedProcessStartTime } from '../engine/state.js';
import { resolveRuntimes, RUNTIME_TABLE } from '../tools/player-runtime.js';
import { ensureStudyService, inspectStudyService, stopStudyService } from '../tools/study-service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine/cli.js');
const LOOP = path.join(ROOT, 'tools/game-loop.js');
const STORE_ARGS = ['--store-dir', '/tmp/s8-new-store'];
const resolve = (...args) => applyModeDefaults(parseGameLoopArgs(args));

test('S8 early: the new-store defaults are complete, pure and do not inject blinds', () => {
  const parsed = Object.freeze(parseGameLoopArgs(STORE_ARGS));
  const next = applyModeDefaults(parsed);
  assert.notEqual(next, parsed);
  assert.equal(parsed.mode, undefined);
  assert.equal(parsed.opponentRuntime, undefined);
  assert.deepEqual(next, { ...parsed, mode: 'cash-training', ai: 5, stackBb: 100, hands: 20, opponentRuntime: 'policy' });
  assert.equal(next.blinds, undefined);
  assert.deepEqual(applyModeDefaults(next), next);
});

test('S8 early: explicit learning values and LLM opponents survive default resolution', () => {
  const next = resolve(...STORE_ARGS, '--ai', '3', '--hands', '7', '--blinds', '15/30', '--stack-bb', '50', '--opponent-runtime', 'llm');
  assert.equal(next.mode, 'cash-training');
  assert.equal(next.ai, 3);
  assert.equal(next.hands, 7);
  assert.equal(next.blinds, '15/30');
  assert.equal(next.stackBb, 50);
  assert.equal(next.opponentRuntime, 'llm');
});

test('S8 early: LLM selection is an independent override of the new learning defaults', () => {
  const next = resolve(...STORE_ARGS, '--opponent-runtime', 'llm');
  assert.equal(next.opponentRuntime, 'llm');
  assert.equal(next.mode, 'cash-training');
  assert.equal(next.ai, 5);
  assert.equal(next.stackBb, 100);
  assert.equal(next.hands, 20);
});

for (const options of [
  ['--mode', 'tournament'], ['--mode', 'tournament', '--ai', '3', '--opponent-runtime', 'policy'],
  ['--ai', '2', '--stack', '900'], ['--ai', '2', '--level-every', '4'],
  ['--stack', '900', '--level-every', '4', '--blinds', '15/30', '--opponent-runtime', 'llm'],
]) {
  test(`S8 early: explicit legacy-format options remain unchanged: ${options.join(' ')}`, () => {
    const parsed = parseGameLoopArgs([...STORE_ARGS, ...options]);
    assert.deepEqual(applyModeDefaults(parsed), parsed);
  });
}

test('S8 early: explicit cash chip stacks do not receive a conflicting stack-bb default', () => {
  const next = resolve(...STORE_ARGS, '--mode', 'cash-training', '--stack', '900', '--blinds', '15/30');
  assert.equal(next.stack, 900);
  assert.equal(next.stackBb, undefined);
  assert.equal(next.blinds, '15/30');
  assert.equal(next.ai, 5);
  assert.equal(next.hands, 20);
  assert.equal(next.opponentRuntime, 'policy');
  assert.equal(engineInitFlags(next).includes('--stack-bb'), false);
});

test('S8 early: implicit and explicit legacy game-dir calls keep their old defaults', () => {
  for (const options of [[], ['--game-dir', '/tmp/s8-legacy', '--ai', '3', '--stack', '900']]) {
    const parsed = parseGameLoopArgs(options);
    assert.deepEqual(applyModeDefaults(parsed), parsed);
  }
  const parsed = parseGameLoopArgs(['--game-dir', '/tmp/s8-legacy', '--mode', 'cash-training']);
  assert.deepEqual(applyModeDefaults(parsed), { ...parsed, ai: 5 });
});

test('S8 early: resume never adds learning defaults or overrides parsed values', () => {
  for (const options of [
    [...STORE_ARGS, '--resume'],
    [...STORE_ARGS, '--resume', '--mode', 'cash-training', '--stack', '900', '--opponent-runtime', 'llm'],
    ['--game-dir', '/tmp/s8-legacy', '--resume', '--mode', 'cash-training'],
  ]) {
    const parsed = parseGameLoopArgs(options);
    assert.deepEqual(applyModeDefaults(parsed), parsed);
  }
});

test('S8 early: off-target configuration uses readable heuristic reference comparison wording', () => {
  const notice = gtoEvalNotice({ mode: 'cash-training', aiCount: 3, startStackBb: 50 });
  assert.match(notice, /휴리스틱.*기준표/);
  assert.match(notice, /6인.*100BB/);
  assert.match(notice, /4인/);
  assert.match(notice, /50BB/);
  assert.doesNotMatch(notice, /GTO|startStackBb/);
  assert.equal(gtoEvalNotice({ mode: 'cash-training', aiCount: 5, startStackBb: 99 }), null);
  assert.equal(gtoEvalNotice({ mode: 'cash-training', aiCount: 5, startStackBb: 101 }), null);
  assert.notEqual(gtoEvalNotice({ mode: 'cash-training', aiCount: 5, startStackBb: 101.1 }), null);
  assert.equal(gtoEvalNotice({ mode: 'tournament', aiCount: 3, startStackBb: 20 }), null);
});

function engine(args) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [ENGINE, ...args], { encoding: 'utf8', timeout: 10000 }, (error, stdout, stderr) => {
      let json;
      try { json = JSON.parse(stdout.trim()); } catch { /* reported with terminal output */ }
      resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, json, stderr });
    });
    registerOwnedProcess(child, 's8-engine');
  });
}

for (const options of [
  ['--mode', 'cash-training', '--stack', '900', '--stack-bb', '100'],
  ['--mode', 'cash-training', '--level-every', '8'],
  ['--mode', 'tournament', '--ai', '3', '--hands', '20'],
]) {
  test(`S8 early: explicit incompatible options remain engine-rejected: ${options.join(' ')}`, async () => {
    const parsed = parseGameLoopArgs([...STORE_ARGS, ...options]);
    const next = applyModeDefaults(parsed);
    for (const key of ['mode', 'stack', 'stackBb', 'levelEvery', 'hands', 'ai']) {
      if (parsed[key] !== undefined) assert.equal(next[key], parsed[key]);
    }
    const gameDir = createOwnedTempDir('holdem-s8-invalid');
    const result = await engine(['init', '--ai', String(next.ai), '--game-dir', gameDir, ...engineInitFlags(next)]);
    assert.equal(result.code, 2, JSON.stringify(result));
    assert.equal(result.signal, null);
    assert.equal(result.json.ok, false);
  });
}

test('S8 early: explicit chip stack and new defaults reach the real engine with preserved units', async () => {
  const gameDir = createOwnedTempDir('holdem-s8-stack');
  const next = resolve(...STORE_ARGS, '--mode', 'cash-training', '--stack', '900', '--blinds', '15/30');
  const result = await engine(['init', '--ai', String(next.ai), '--game-dir', gameDir, ...engineInitFlags(next)]);
  assert.equal(result.code, 0, JSON.stringify(result));
  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json')));
  assert.equal(state.config.startStack, 900);
  assert.equal(state.config.startStackBb, 30);
  assert.deepEqual(state.config.blinds0, [15, 30]);
  assert.equal(state.config.handLimit, 20);
});

function failedCliFixtures({ hold = false } = {}) {
  const root = createOwnedTempDir('holdem-s8-failed-clis');
  const log = path.join(root, 'invocations.jsonl');
  const release = path.join(root, 'release');
  for (const kind of ['claude', 'codex', 'grok']) {
    fs.writeFileSync(path.join(root, `${kind}.cjs`), `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind:${JSON.stringify(kind)},argv:process.argv.slice(2)})+'\\n');
process.stdin.resume();
${hold ? `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(1); }, 10);` : 'process.stdin.on("end", () => process.exit(1));'}
`, { mode: 0o700 });
  }
  const preload = path.join(root, 'fixture-preload.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawn;
const fixtures = ${JSON.stringify(Object.fromEntries(['claude', 'codex', 'grok'].map(kind => [kind, path.join(root, `${kind}.cjs`)])))};
cp.spawn = (command, args, options) => Object.hasOwn(fixtures, command)
  ? spawn(process.execPath, [fixtures[command], ...args], options) : spawn(command, args, options);
syncBuiltinESMExports();
// IPC is a fixture transport into the CLI's registered graceful shutdown handler.
// It makes no claim that Windows SIGTERM delivers a catchable signal.
process.on('message', message => { if (message === 'fixture-request-stop') process.emit('SIGTERM'); });
process.channel?.unref();
`);
  return {
    log,
    release() { fs.writeFileSync(release, 'fail the owned probe'); },
    env: { ...process.env, HOLDEM_FIXTURE_PRELOAD: preload },
  };
}

function startCli(args, env, { umask } = {}) {
  // Engineering fixtures choose an ephemeral relay while keeping the learning
  // configuration itself entirely at the CLI defaults.
  if (!args.includes('--port')) args = [...args, '--port', '0'];
  const argv = umask === undefined ? [LOOP, ...args] : ['--input-type=module', '--eval',
    `process.umask(${umask});process.argv=[process.execPath,${JSON.stringify(LOOP)},...${JSON.stringify(args)}];await import(${JSON.stringify(pathToFileURL(LOOP).href)});`];
  if (env?.HOLDEM_FIXTURE_PRELOAD) argv.unshift('--import', pathToFileURL(env.HOLDEM_FIXTURE_PRELOAD).href);
  const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  registerOwnedProcess(child, 's8-store-cli');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, closed, requestStop() {
    if (process.platform === 'win32') child.send('fixture-request-stop');
    else child.kill('SIGTERM');
  } };
}

async function within(promise, milliseconds, label = 'owned CLI') {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(predicate, cli, milliseconds = 6000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    if (cli.child.exitCode !== null || cli.child.signalCode !== null) {
      assert.fail(JSON.stringify(await cli.closed));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('owned CLI bootstrap checkpoint was not reached');
}

test('S8 early: the actual store CLI initializes the default policy table before an upper-only probe', { timeout: 15000 }, async (t) => {
  const store = createOwnedTempDir('holdem-s8-cli-store');
  const fake = failedCliFixtures({ hold: true });
  const cli = startCli(['--store-dir', store, '--player-runtime', 'claude'], fake.env);
  t.after(async () => {
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.requestStop();
    await within(cli.closed, 8000);
  });
  const invocation = await until(() => {
    return readFirstFixtureRecord(fake.log, cli.child);
  }, cli);
  assert.equal(invocation.kind, 'claude');
  assert.ok(invocation.argv.includes(RUNTIME_TABLE.claude.upper));
  assert.equal(invocation.argv.includes(RUNTIME_TABLE.claude.player), false);
  const selected = JSON.parse(fs.readFileSync(path.join(store, '.session-store/current.json')));
  const gameDir = path.join(store, '.session-store', selected.sessionRel);
  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json')));
  const loopState = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json')));
  const players = JSON.parse(fs.readFileSync(path.join(gameDir, 'players.json')));
  assert.equal(loopState.phase, 'bootstrap');
  assert.equal(loopState.opponentRuntime, 'policy');
  assert.equal(state.config.mode, 'cash-training');
  assert.equal(state.config.aiCount, 5);
  assert.equal(state.config.startStackBb, 100);
  assert.equal(state.config.handLimit, 20);
  assert.deepEqual(state.config.blinds0, [25, 50]);
  assert.equal(state.handNo, 0, 'this test checks initialization, not a 20-hand learning outcome');
  assert.match(state.policySeed, /^[a-f0-9]{64}$/);
  assert.equal(players.filter((player) => player.playerId !== 'user').length, 5);
  assert.ok(players.filter((player) => player.playerId !== 'user').every((player) => player.policy.policyVersion === '2.0.0'));
  assert.equal(fs.existsSync(path.join(gameDir, '.player-sessions.json')), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false, 'the held probe keeps this test before relay startup');
  cli.requestStop();
  const result = await within(cli.closed, 8000);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.signal, null);
});

test('S8 early: explicit LLM store launch still requires an eligible player runtime', { timeout: 15000 }, async () => {
  const store = createOwnedTempDir('holdem-s8-cli-llm');
  const fake = failedCliFixtures();
  const cli = startCli(['--store-dir', store, '--opponent-runtime', 'llm', '--player-runtime', 'claude'], fake.env);
  const result = await within(cli.closed, 10000);
  assert.equal(result.code, 4, JSON.stringify(result));
  assert.equal(result.signal, null);
  const calls = fs.readFileSync(fake.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.kind), ['claude', 'codex', 'grok']);
  for (const call of calls) assert.ok(call.argv.includes(RUNTIME_TABLE[call.kind].player));
  const selected = JSON.parse(fs.readFileSync(path.join(store, '.session-store/current.json')));
  const gameDir = path.join(store, '.session-store', selected.sessionRel);
  const loopState = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json')));
  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json')));
  assert.equal(loopState.opponentRuntime, 'llm');
  assert.equal(loopState.halt.code, 'NO_PLAYER_RUNTIME');
  assert.equal(state.config.mode, 'cash-training');
  assert.equal(state.config.aiCount, 5);
  assert.equal(state.policySeed, undefined);
  assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false);
});

test('S8 early: policy bootstrap survives failed upper selection and reports LLM feedback unavailable', { timeout: 10000 }, async (t) => {
  const gameDir = createOwnedTempDir('holdem-s8-upper-none');
  const parsed = resolve(...STORE_ARGS);
  const probes = [];
  const disposed = [];
  const loop = createGameLoop({
    gameDir,
    opts: { port: 0, opponentRuntime: parsed.opponentRuntime },
    resolver: ({ need, canaryAbsPath, registerAdapter }) => resolveRuntimes({
      need, canaryAbsPath, onAdapterCreated: registerAdapter,
      createRuntime: (kind) => ({
        kind,
        async probe(options) {
          probes.push({ kind, upper: options.upper, canaryExists: fs.existsSync(options.canaryAbsPath) });
          return { ok: false, containment: false, upper: false };
        },
        async dispose() { disposed.push(kind); },
      }),
    }),
  });
  t.after(() => loop.requestStop());
  const state = await loop.bootstrap(parsed);
  assert.equal(state.phase, 'playing');
  assert.equal(state.playerRuntime, null);
  assert.equal(state.upperRuntime, null);
  assert.equal(probes.length, 3);
  assert.ok(probes.every((probe) => probe.upper === true && probe.canaryExists));
  assert.ok(state.notices.some((notice) => /LLM.*코치.*리뷰/.test(notice)));
  assert.equal(state.notices.some((notice) => notice.includes('리뷰는 생성되지 않습니다')), false);
  assert.equal(fs.existsSync(path.join(gameDir, '.player-sessions.json')), false);
  const pid = loop.serverPid;
  await loop.requestStop();
  assert.deepEqual(disposed.sort(), ['claude', 'codex', 'grok']);
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
});

async function stopOwnedStudy(storeDir) {
  if (!fs.existsSync(path.join(storeDir, '.training', 'study-service.json'))) return;
  const service = await inspectStudyService(storeDir);
  if (service.status !== 'running') return;
  assert.equal((await stopStudyService(storeDir, { expectedInstanceId: service.instanceId })).stopped, true);
  assert.throws(() => process.kill(service.pid, 0), (error) => error.code === 'ESRCH');
}

test('S8 full: actual store bootstrap creates private lock metadata under inherited umask 002', { timeout: 15000 }, async (t) => {
  const parent = createOwnedTempDir('holdem-s8-private-store');
  fs.chmodSync(parent, 0o755);
  const store = path.join(parent, 'new-store');
  const hostMask = process.umask();
  const fake = failedCliFixtures({ hold: true });
  const cli = startCli(['--store-dir', store, '--player-runtime', 'claude'], fake.env, { umask: 0o002 });
  t.after(async () => {
    if (cli.child.exitCode === null && cli.child.signalCode === null) cli.requestStop();
    await within(cli.closed, 8000);
    await stopOwnedStudy(store);
  });
  await until(() => readFirstFixtureRecord(fake.log, cli.child), cli);
  for (const file of [store, path.join(store, 'loop.lock.d'), path.join(store, 'loop.lock.d', 'pid')])
    assert.equal(isPrivatePath(file), true, 'actual CLI ownership paths must be private');
  if (process.platform !== 'win32') assert.equal(fs.statSync(parent).mode & 0o777, 0o755, 'existing caller directories retain their mode');
  assert.equal(process.umask(), hostMask, 'the host process umask is unchanged');
});

test('S8 full: store bootstrap attaches its owner and publishes the verified study URL', { timeout: 15000 }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-study-link');
  const gameDir = path.join(storeDir, 'session');
  fs.mkdirSync(gameDir, { mode: 0o700 });
  const loop = createGameLoop({ gameDir, lockDir: storeDir,
    resolver: async () => ({ player: null, upper: null, notices: ['LLM 코치·리뷰 피드백 불가'] }),
    opts: { port: 0, waitMs: 0, storeDir, trainingEnabled: true, opponentRuntime: 'policy' } });
  t.after(async () => { await loop.requestStop(); await stopOwnedStudy(storeDir); });
  const initialized = await loop.bootstrap(resolve(...STORE_ARGS));
  const service = await inspectStudyService(storeDir);
  assert.equal(service.status, 'running', 'store bootstrap must attach a verified independent study service');
  const response = await fetch(`http://127.0.0.1:${initialized.port}/api/snapshot?token=${encodeURIComponent(initialized.sessionToken)}`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).studyUrl, service.studyUrl);
  assert.notEqual(service.pid, process.pid, 'study owns an independent process');
});

async function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 10000, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
    registerOwnedProcess(child, 's8-fixture-command');
  });
}

function ownedServiceOptions() {
  return { onChild(child) { child.ref(); registerOwnedProcess(child, 's8-study-service'); } };
}

async function launchRelay(t, gameDir, sessionToken, { studyUrl, sourceRoot = ROOT } = {}) {
  const argv = [fs.realpathSync(path.join(sourceRoot, 'server/server.js')), '--game-dir', gameDir, '--port', '0', '--token', sessionToken];
  if (studyUrl) argv.push('--study-url', studyUrl);
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  registerOwnedProcess(child, 's8-owned-relay');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stderr })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await within(closed, 4000);
  });
  const lock = await until(() => {
    const file = path.join(gameDir, 'lock.json');
    if (!fs.existsSync(file)) return null;
    const value = JSON.parse(fs.readFileSync(file));
    return value.serverPid === child.pid ? value : null;
  }, { child, closed });
  return { child, closed, lock };
}

for (const variant of ['missing study URL', 'rotated study URL', 'actual legacy capabilities']) {
  test(`S8 full: store bootstrap replaces an authenticated owned relay with ${variant}`, { timeout: 20000 }, async (t) => {
    const storeDir = createOwnedTempDir('holdem-s8-relay-adoption');
    const gameDir = path.join(storeDir, 'session');
    fs.mkdirSync(gameDir, { mode: 0o700 });
    t.after(() => stopOwnedStudy(storeDir));
    const defaults = resolve(...STORE_ARGS);
    const initialized = await engine(['init', '--game-dir', gameDir, '--ai', String(defaults.ai), ...engineInitFlags(defaults)]);
    assert.equal(initialized.code, 0);
    const before = fs.readFileSync(path.join(gameDir, 'state.json'));
    let oldStudyUrl;
    if (variant === 'rotated study URL') {
      const prior = await ensureStudyService(storeDir, ownedServiceOptions());
      oldStudyUrl = prior.studyUrl;
      await stopStudyService(storeDir, { expectedInstanceId: prior.instanceId });
    }
    const current = await ensureStudyService(storeDir, ownedServiceOptions());
    let sourceRoot = ROOT;
    if (variant === 'actual legacy capabilities') {
      sourceRoot = createOwnedTempDir('holdem-s8-old-relay-source');
      const archive = path.join(sourceRoot, 'baseline.tar');
      await command('git', ['archive', '--format=tar', '--output', archive, 'a4822d74a4251f199b52e0f02914ef659ea905dd'], { cwd: ROOT });
      await command('tar', ['-xf', archive, '-C', sourceRoot]);
    }
    const old = await launchRelay(t, gameDir, initialized.json.sessionToken, { studyUrl: oldStudyUrl, sourceRoot });
    const loop = createGameLoop({ gameDir, lockDir: storeDir,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: { port: 0, waitMs: 0, storeDir, trainingEnabled: true, opponentRuntime: 'policy' } });
    t.after(() => loop.requestStop());
    const boot = await loop.bootstrap({ ...defaults, preinitialized: initialized.json });
    assert.notEqual(loop.serverPid, old.child.pid);
    await within(old.closed, 4000);
    assert.throws(() => process.kill(old.child.pid, 0), (error) => error.code === 'ESRCH');
    const response = await fetch(`http://127.0.0.1:${boot.port}/api/snapshot?token=${encodeURIComponent(boot.sessionToken)}`);
    assert.equal((await response.json()).studyUrl, current.studyUrl);
    assert.deepEqual(fs.readFileSync(path.join(gameDir, 'state.json')), before, 'relay replacement never applies an engine action');
  });
}

test('S8 full: a current-URL relay is reused and the attached store owner keeps study alive', { timeout: 15000 }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-study-parent');
  const gameDir = path.join(storeDir, 'session');
  fs.mkdirSync(gameDir, { mode: 0o700 });
  t.after(() => stopOwnedStudy(storeDir));
  const defaults = resolve(...STORE_ARGS);
  const initialized = await engine(['init', '--game-dir', gameDir, '--ai', String(defaults.ai), ...engineInitFlags(defaults)]);
  assert.equal(initialized.code, 0);
  const service = await ensureStudyService(storeDir, {
    ...ownedServiceOptions(), testOptions: { idleTimeoutMs: 1000, checkpointMs: 25 },
  });
  const relay = await launchRelay(t, gameDir, initialized.json.sessionToken, { studyUrl: service.studyUrl });
  const hostMask = process.umask();
  const loop = createGameLoop({ gameDir, lockDir: storeDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 0, storeDir, trainingEnabled: true, opponentRuntime: 'policy' } });
  t.after(() => loop.requestStop());
  await loop.bootstrap({ ...defaults, preinitialized: initialized.json });
  assert.equal(loop.serverPid, relay.child.pid);
  assert.equal(process.umask(), hostMask, 'the programmatic API does not change caller creation mode');
  await new Promise((resolve) => setTimeout(resolve, 1250));
  assert.equal((await inspectStudyService(storeDir)).instanceId, service.instanceId,
    'without parent attachment the idle service would have stopped');
});

async function waitValue(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('owned integration state did not converge');
}

async function relayRequest(lock, route, body) {
  const response = await fetch(`http://127.0.0.1:${lock.port}${route}?token=${encodeURIComponent(lock.sessionToken)}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(1500),
  });
  return { status: response.status, body: await response.json() };
}

async function studyRequest(service, route, body) {
  const response = await fetch(`http://127.0.0.1:${service.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-drill-token': new URL(service.studyUrl).hash.slice(7), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

function processCommandLine(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  if (process.platform !== 'win32') return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 5000 }).trim();
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
  { env: windowsPowerShellEnvironment(), encoding: 'utf8', timeout: 15000 }).replace(/^\uFEFF/, '').trim();
}

test('S8 fixture: runner process command line is observable with inherited shell environment', () => {
  const commandLine = processCommandLine(process.pid);
  assert.ok(commandLine.includes(path.basename(process.execPath)), commandLine);
});

function captureCliRelay(gameDir) {
  const file = gameDir && path.join(gameDir, 'lock.json');
  if (!file || !fs.existsSync(file)) return null;
  const lock = JSON.parse(fs.readFileSync(file));
  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json')));
  assert.equal(lock.sessionToken, state.sessionToken);
  const startTime = ownedProcessStartTime(lock.serverPid);
  if (startTime === null) {
    assert.throws(() => process.kill(lock.serverPid, 0), (error) => error.code === 'ESRCH');
    return null;
  }
  const args = processCommandLine(lock.serverPid);
  assert.ok(args.includes(path.join(ROOT, 'server/server.js')));
  assert.ok(args.includes(gameDir) || args.includes(fs.realpathSync(gameDir)));
  return { pid: lock.serverPid, startTime, args };
}

async function cleanupCli(cli, gameDir) {
  const relay = captureCliRelay(gameDir);
  if (cli.child.exitCode === null && cli.child.signalCode === null) {
    cli.requestStop();
    try { await within(cli.closed, 1000, 'fixture cleanup CLI'); }
    catch { cli.child.kill('SIGKILL'); }
  }
  await within(cli.closed, 4000, 'fixture cleanup CLI after signal');
  if (relay) {
    const alive = () => { try { process.kill(relay.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (!alive()) break;
      assert.equal(ownedProcessStartTime(relay.pid), relay.startTime);
      assert.equal(processCommandLine(relay.pid), relay.args);
      process.kill(relay.pid, signal);
      const deadline = Date.now() + 2000;
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(alive(), false, 'the fixture relay cannot outlive its CLI');
  }
  console.log(`S8_CLI_RESOURCE_CLEANUP ${JSON.stringify({ pid: cli.child.pid, relayPid: relay?.pid ?? null, childDead: true, relayDead: true })}`);
}

async function stopWaitingCli(cli, gameDir) {
  const waiting = await waitValue(async () => {
    const lock = JSON.parse(fs.readFileSync(path.join(gameDir, 'lock.json')));
    const snapshot = await relayRequest(lock, '/api/snapshot');
    return snapshot.body.view?.legal?.toAct === 'user' ? { lock, legal: snapshot.body.view.legal } : null;
  }, 8000);
  const before = fs.readFileSync(path.join(gameDir, 'state.json'));
  cli.requestStop();
  await waitValue(() => JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json'))).stopping === true);
  const action = { decisionId: waiting.legal.decisionId, requestId: randomUUID(), action: 'fold' };
  assert.equal((await relayRequest(waiting.lock, '/api/action', action)).status, 200);
  const result = await within(cli.closed, 8000, 'next store CLI after its pending wait settles');
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.signal, null);
  const receipt = JSON.parse(fs.readFileSync(path.join(gameDir, 'ui-action-receipt.json')));
  assert.equal(receipt.phase, 'delivered');
  assert.equal(receipt.requestId, action.requestId);
  assert.equal(receipt.decisionId, action.decisionId);
  assert.deepEqual(fs.readFileSync(path.join(gameDir, 'state.json')), before,
    'stopping must retain the delivered receipt for resume without applying it');
  return { requestId: action.requestId, decisionId: action.decisionId,
    stoppingBeforeDelivery: true, receiptPhase: receipt.phase, engineApplied: false, queuedForResume: true };
}

async function snapshotForActiveGame(stateFile, request) {
  const completed = () => JSON.parse(fs.readFileSync(stateFile)).gameOver === true;
  // Engine completion precedes relay teardown and the loop's final done patch.
  // The action driver relinquishes HTTP here; its caller still awaits run().
  if (completed()) return null;
  try { return await request(); }
  catch (error) {
    if (completed()) return null;
    throw error;
  }
}

test('S8 driver releases the relay when the engine completes before loop finalization', async () => {
  const file = path.join(createOwnedTempDir('holdem-s8-terminal-fence'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ handNo: 20, gameOver: true, result: 'completed' }));
  let requests = 0;
  const snapshot = await snapshotForActiveGame(file, async () => { requests++; throw new Error('relay is closing'); });
  assert.equal(snapshot, null);
  assert.equal(requests, 0, 'engine completion releases HTTP polling before phase done');
});

test('S8 driver rechecks engine completion if relay loss races its state read', async () => {
  const file = path.join(createOwnedTempDir('holdem-s8-terminal-race'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ gameOver: false }));
  const snapshot = await snapshotForActiveGame(file, async () => {
    fs.writeFileSync(file, JSON.stringify({ handNo: 20, gameOver: true, result: 'completed' }));
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  assert.equal(snapshot, null);
});

test('S8 driver preserves premature relay loss and unreadable engine state as failures', async () => {
  const file = path.join(createOwnedTempDir('holdem-s8-premature-loss'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ gameOver: false }));
  const original = new Error('premature relay loss');
  await assert.rejects(snapshotForActiveGame(file, async () => { throw original; }), error => error === original);
  fs.writeFileSync(file, '{');
  await assert.rejects(snapshotForActiveGame(file, async () => ({ status: 200 })), SyntaxError);
});

test('S8 full: default 20-hand production session records support then study remains usable and reusable', { timeout: 240000 }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-default20');
  const fake = failedCliFixtures({ hold: true });
  const initialCli = startCli(['--store-dir', storeDir], fake.env);
  let loop;
  let gameDir;
  let nextCli;
  let nextGameDir;
  const diagnosticStarted = Date.now();
  let checkpoint = 'initial-probe';
  const phaseObservations = [];
  const errorDetail = (error, depth = 0) => {
    if (!error || depth > 3) return null;
    // CLI assertions can embed capabilities. Keep call sites and safe error
    // categories, while removing URLs and token-shaped values from messages.
    const redact = value => String(value ?? '').replace(/https?:\/\/[^\s"']+/g, '[url]')
      .replace(/[a-f0-9]{32,}/gi, '[opaque]')
      .replace(/(token["'\s:=]+)[^\s,}"']+/gi, '$1[redacted]');
    return { name: error.name, code: error.code, message: redact(error.message),
      stack: String(error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6),
      cause: errorDetail(error.cause, depth + 1),
      errors: Array.from(error.errors ?? []).map(item => errorDetail(item, depth + 1)) };
  };
  const stateDiagnostic = dir => {
    if (!dir) return null;
    const read = file => { try { return JSON.parse(fs.readFileSync(path.join(dir, file))); } catch (error) { return { readCode: error.code ?? error.name }; } };
    const state = read('state.json');
    const persistedLoop = read('loop-state.json');
    const action = read('ui-action-receipt.json');
    return { handNo: state.handNo, gameOver: state.gameOver, result: state.result,
      phase: persistedLoop.phase, stopping: persistedLoop.stopping,
      haltCode: persistedLoop.halt?.code, stateReadCode: state.readCode, loopReadCode: persistedLoop.readCode,
      actionPhase: action.phase, decisionId: action.decisionId, actionCode: action.code };
  };
  const diagnostic = (event, error) => console.log(`S8_DEFAULT20_DIAGNOSTIC ${JSON.stringify({
    elapsedMs: Date.now() - diagnosticStarted, event, checkpoint,
    initial: stateDiagnostic(gameDir), next: stateDiagnostic(nextGameDir),
    error: errorDetail(error), phaseObservations,
  })}`);
  t.after(async () => {
    const failures = [];
    diagnostic('cleanup-start');
    for (const [label, cleanup] of [
      ['loop-stop', () => loop?.requestStop()],
      ['next-cli-stop', () => nextCli ? cleanupCli(nextCli, nextGameDir) : undefined],
      ['initial-cli-stop', () => cleanupCli(initialCli, null)],
      ['study-stop', () => stopOwnedStudy(storeDir)],
    ]) { try { await cleanup(); } catch (error) { diagnostic(`cleanup-failure:${label}`, error); failures.push(error); } }
    diagnostic('cleanup-end');
    if (failures.length) throw new AggregateError(failures, 'default20 fixture cleanup failed');
  });
  try {
    await until(() => readFirstFixtureRecord(fake.log, initialCli.child), initialCli);
    initialCli.requestStop();
    assert.equal((await within(initialCli.closed, 8000, 'default20 initialized CLI stop')).code, 0);
    const selected = JSON.parse(fs.readFileSync(path.join(storeDir, '.session-store/current.json')));
    gameDir = path.join(storeDir, '.session-store', selected.sessionRel);
    const stateFile = path.join(gameDir, 'state.json');
    const initialized = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(initialized.config.mode, 'cash-training');
    assert.equal(initialized.config.aiCount, 5);
    assert.equal(initialized.config.startStackBb, 100);
    assert.equal(initialized.config.handLimit, 20);
    assert.equal(initialized.handNo, 0);
    // Controlled initial input only. Later hands retain the production shuffle;
    // all observed deck state and actions are included in the audit transcript.
    initialized.button = 2; // next button3/SB4/BB5 makes user the first actor.
    fs.writeFileSync(stateFile, JSON.stringify(initialized));
    const firstDeck = newDeck();
    const first = await engine(['step', '--new-hand', '--deck', firstDeck.join(','), '--game-dir', gameDir]);
    assert.equal(first.code, 0, JSON.stringify(first));
    assert.equal(first.json.next.kind, 'user');
    loop = createGameLoop({ gameDir, lockDir: storeDir,
      resolver: async () => ({ player: null, upper: null, notices: ['LLM 코치·리뷰 피드백 불가'] }),
      opts: { port: 0, waitMs: 40, storeDir, trainingEnabled: true } });
    const resumed = await loop.resume();
    assert.equal(resumed.opponentRuntime, 'policy');
    const service = await inspectStudyService(storeDir);
    assert.equal(service.status, 'running');
    const relayPid = loop.serverPid;
    checkpoint = 'drive-20-hands';
    diagnostic('drive-start');
    const driveStarted = Date.now();
    const observedHands = new Map();
    const actions = [];
    const sent = new Set();
    let settled = false;
    const running = loop.run().finally(() => { settled = true; });
    running.catch(() => {});
    const driver = (async () => {
      // Isolated default20 took 68s; a full-suite run reached 117s. Preserve
      // all 20 random production hands and leave 40s for finalization/cleanup.
      const deadline = Date.now() + 200000;
      while (!settled && Date.now() < deadline) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        if (state.hand && !observedHands.has(state.handNo)) {
          observedHands.set(state.handNo, { handNo: state.handNo, button: state.button,
            holes: state.hand.holes, board: state.hand.board, remainingDeck: state.hand.deck });
        }
        const phase = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json'))).phase;
        const previous = phaseObservations.at(-1);
        if (previous?.handNo !== state.handNo || previous?.phase !== phase) {
          phaseObservations.push({ elapsedMs: Date.now() - driveStarted, handNo: state.handNo, phase });
          diagnostic('drive-phase');
        }
        if (phase === 'done') break;
        let lock;
        const snapshot = await snapshotForActiveGame(stateFile, () => {
          lock = JSON.parse(fs.readFileSync(path.join(gameDir, 'lock.json')));
          return relayRequest(lock, '/api/snapshot');
        });
        if (snapshot === null) { diagnostic('engine-complete-release-relay'); break; }
        assert.equal(snapshot.status, 200);
        const legal = snapshot.body.view?.legal;
        if (legal?.toAct === 'user' && !sent.has(legal.decisionId)) {
          if (actions.length === 0) {
            const invalid = { decisionId: legal.decisionId, requestId: randomUUID(), action: 'raise', amount: 1 };
            assert.equal((await relayRequest(lock, '/api/action', invalid)).status, 200);
            const rejected = await waitValue(async () => {
              const result = await relayRequest(lock, '/api/action-status');
              return result.body.requestId === invalid.requestId && result.body.phase === 'rejected' ? result : null;
            });
            assert.equal(rejected.body.decisionId, legal.decisionId);
            const replay = await relayRequest(lock, '/api/action', invalid);
            assert.equal(replay.status, 409);
            assert.equal(replay.body.code, 'ACTION_REJECTED');
            actions.push({ ...invalid, phase: 'rejected' });
          }
          const action = { decisionId: legal.decisionId, requestId: randomUUID(), action: legal.canCheck ? 'check' : 'fold' };
          const accepted = await relayRequest(lock, '/api/action', action);
          assert.equal(accepted.status, 200, JSON.stringify(accepted));
          actions.push(action);
          sent.add(legal.decisionId);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!settled) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        const phase = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json'))).phase;
        if (phase !== 'done' && !state.gameOver) {
          throw new Error(`default20 action driver deadline: ${JSON.stringify({ handNo: state.handNo, phase, actions: actions.length, phaseObservations })}`);
        }
        await within(running, 15000, `default20 finalization ${JSON.stringify({ handNo: state.handNo, phase, phaseObservations })}`);
      }
    })();
    driver.catch(() => loop.requestStop());
    const [finished] = await Promise.all([running, driver]);
    console.log(`S8_DEFAULT20_PHASES ${JSON.stringify(phaseObservations)}`);
    assert.equal(finished.phase, 'done', JSON.stringify(finished.halt));
    const finalBytes = fs.readFileSync(stateFile);
    const finalState = JSON.parse(finalBytes);
    assert.equal(finalState.handNo, 20);
    assert.equal(finalState.result, 'completed');
    assert.equal(finalState.gameOver, true);
    assert.throws(() => process.kill(relayPid, 0), (error) => error.code === 'ESRCH');
    const evaluations = fs.readFileSync(path.join(gameDir, 'training/evaluations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(evaluations.some((row) => row.status === 'supported' && row.forced === false),
      'the default configuration must produce an actual supported user opportunity');
    assert.equal(new Set(evaluations.map((row) => row.evaluationId)).size, evaluations.length);
    checkpoint = 'postgame-study';
    diagnostic('postgame-start');
    const before = (await studyRequest(service, '/api/summary')).summary;
    assert.ok(before.game.overall.supportedDecisions >= 1);
    for (const [index, handClass] of ['AJo', '72o', 'KK'].entries()) {
      await studyRequest(service, '/api/start', { mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened',
        handClass, idempotencyKey: `postgame-practice-${index}` });
      const current = await studyRequest(service, '/api/current');
      await studyRequest(service, '/api/answer', { sessionId: current.sessionId,
        questionId: current.question.questionId, action: 'fold', attemptNo: 0 });
    }
    const after = (await studyRequest(service, '/api/summary')).summary;
    assert.deepEqual(after.game, before.game, 'practice must not change any game metric, candidate or calibration');
    assert.equal(after.practice.overall.supportedDecisions, before.practice.overall.supportedDecisions + 3);
    checkpoint = 'next-cli-bootstrap';
    diagnostic('next-cli-start');
    const nextFake = failedCliFixtures({ hold: true });
    nextCli = startCli(['--store-dir', storeDir], nextFake.env);
    await until(() => {
      const current = JSON.parse(fs.readFileSync(path.join(storeDir, '.session-store/current.json')));
      if (current.gameId === selected.gameId) return null;
      nextGameDir = path.join(storeDir, '.session-store', current.sessionRel);
      return readFirstFixtureRecord(nextFake.log, nextCli.child);
    }, nextCli, 10000);
    const nextStateFile = path.join(nextGameDir, 'state.json');
    const nextInitial = JSON.parse(fs.readFileSync(nextStateFile));
    assert.equal(nextInitial.handNo, 0);
    nextInitial.button = 2;
    fs.writeFileSync(nextStateFile, JSON.stringify(nextInitial));
    nextFake.release();
    const next = await until(() => {
      const current = JSON.parse(fs.readFileSync(path.join(storeDir, '.session-store/current.json')));
      if (current.gameId === selected.gameId) return null;
      const nextDir = path.join(storeDir, '.session-store', current.sessionRel);
      const loopFile = path.join(nextDir, 'loop-state.json');
      if (!fs.existsSync(loopFile)) return null;
      const nextState = JSON.parse(fs.readFileSync(loopFile));
      return nextState.phase === 'playing' ? { current, state: nextState } : null;
    }, nextCli, 10000);
    assert.equal((await inspectStudyService(storeDir)).instanceId, service.instanceId);
    assert.equal((await relayRequest({ port: next.state.port, sessionToken: next.state.sessionToken }, '/api/snapshot')).body.studyUrl, service.studyUrl);
    checkpoint = 'next-cli-stop';
    diagnostic('next-stop-start');
    const nextStop = await stopWaitingCli(nextCli, nextGameDir);
    checkpoint = 'delivered-action-recovery';
    diagnostic('recovery-start');
    const recoveredUserApplies = [];
    loop = createGameLoop({ gameDir: nextGameDir, lockDir: storeDir,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: { port: 0, waitMs: 40, storeDir, trainingEnabled: true,
        onEngineInvoke(args) { if (args[0] === 'step' && args[1] === 'user') recoveredUserApplies.push(args); } } });
    await loop.resume();
    const recovering = loop.run();
    recovering.catch(() => {});
    await waitValue(() => {
      const receipt = JSON.parse(fs.readFileSync(path.join(nextGameDir, 'ui-action-receipt.json')));
      return receipt.requestId === nextStop.requestId && receipt.phase === 'consumed';
    });
    await loop.requestStop();
    await within(recovering, 8000, 'default20 delivered-action recovery stop');
    assert.equal(recoveredUserApplies.length, 1, 'resume applies the delivered action exactly once');
    const recoveredState = JSON.parse(fs.readFileSync(nextStateFile));
    const applied = [recoveredState.hand, recoveredState.lastHand].filter(Boolean)
      .flatMap((hand) => hand.decisions ?? []).filter((row) => row.decisionId === nextStop.decisionId);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].chosenAction.action, 'fold');
    nextStop.recoveredOnce = true;
    assert.deepEqual(fs.readFileSync(stateFile), finalBytes);
    assert.equal(observedHands.size, 20, 'retain every observed hand deck for the integration audit');
    console.log(`S8_DEFAULT20_EVIDENCE ${JSON.stringify({ policySeed: initialized.policySeed,
      controlledInitialButton: 2, firstDeck, hands: [...observedHands.values()], actions,
      completedHands: 20, supported: before.game.overall.supportedDecisions,
      unsupported: before.game.overall.unsupportedDecisions, studyReused: true, gameMetricsPreserved: true, nextStop })}`);
    diagnostic('main-complete');
  } catch (error) {
    diagnostic('main-failure', error);
    throw error;
  }
});

for (const scenario of ['limp', 'off-size', 'multiway', 'four-bet']) {
  test(`S8 full: actual engine decisions retain the ${scenario} exclusion`, async () => {
    const gameDir = createOwnedTempDir('holdem-s8-exclusion');
    const defaults = resolve(...STORE_ARGS);
    const initialized = await engine(['init', '--game-dir', gameDir, '--ai', String(defaults.ai), ...engineInitFlags(defaults)]);
    assert.equal(initialized.code, 0);
    const file = path.join(gameDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(file));
    state.button = scenario === 'off-size' ? 2 : 3;
    fs.writeFileSync(file, JSON.stringify(state));
    let turn = await engine(['step', '--new-hand', '--deck', newDeck().join(','), '--game-dir', gameDir]);
    assert.equal(turn.code, 0);
    const transcript = [];
    const step = async (action, amount) => {
      const playerId = turn.json.next.toAct;
      transcript.push({ playerId, action, ...(amount === undefined ? {} : { amount }) });
      turn = await engine(['step', playerId, action, ...(amount === undefined ? [] : [String(amount)]),
        '--expect-version', String(turn.json.stateVersion), '--game-dir', gameDir]);
      assert.equal(turn.code, 0, JSON.stringify(turn));
    };
    if (scenario !== 'off-size') {
      assert.equal(turn.json.next.toAct, 'p1');
      await step(scenario === 'limp' ? 'call' : 'raise', scenario === 'limp' ? undefined : 125);
      if (scenario === 'multiway') await step('call');
      if (scenario === 'four-bet') await step('raise', 425);
      while (turn.json.next.toAct !== 'user') await step('fold');
    }
    const userDecisionId = turn.json.next.decisionId;
    if (scenario === 'off-size') await step('raise', 150);
    else if (scenario === 'four-bet') await step('raise', 1000);
    else await step(scenario === 'limp' ? 'check' : 'fold');
    for (let moves = 0; turn.json.next && moves < 30; moves += 1) await step('fold');
    assert.equal(turn.json.handOver, true);
    const evaluated = JSON.parse(await command(process.execPath,
      [path.join(ROOT, 'tools/evaluate-cli.js'), 'evaluate', '--game-dir', gameDir, '--hand', '1']));
    const row = evaluated.evaluations.find((item) => item.decisionId === userDecisionId);
    assert.equal(row.status, 'unsupported');
    assert.equal(row.grade, null);
    assert.equal(row.evLossBb, null);
    const reason = scenario === 'off-size' ? 'RFI size must be 2.5bb'
      : scenario === 'four-bet' ? 'multiway / 4bet tree unsupported' : 'limped/multiway tree';
    assert.equal(row.reason, reason);
    console.log(`S8_EXCLUSION_EVIDENCE ${JSON.stringify({ scenario, transcript, decisionId: userDecisionId,
      status: row.status, code: row.code, reason: row.reason })}`);
  });
}

test('S8 full: private CLI creation never relabels an existing live foreign loop lock', { timeout: 15000 }, async () => {
  const storeDir = createOwnedTempDir('holdem-s8-foreign-loop');
  fs.chmodSync(storeDir, 0o755);
  const lock = path.join(storeDir, 'loop.lock.d');
  fs.mkdirSync(lock);
  fs.chmodSync(lock, 0o775);
  const pidFile = path.join(lock, 'pid');
  const bytes = `${process.pid}:${ownedProcessStartTime(process.pid)}`;
  fs.writeFileSync(pidFile, bytes);
  fs.chmodSync(pidFile, 0o664);
  const before = fs.statSync(lock);
  const priorModes = [lock, pidFile, storeDir].map(file => fs.statSync(file).mode);
  const cli = startCli(['--store-dir', storeDir], failedCliFixtures().env, { umask: 0o002 });
  const result = await within(cli.closed, 8000);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ACTIVE_GAME/);
  assert.equal(fs.statSync(lock).ino, before.ino);
  assert.deepEqual([lock, pidFile, storeDir].map(file => fs.statSync(file).mode), priorModes);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), bytes);
});

test('S8 full: package study commands require an explicit store and own service start and stop', { timeout: 15000 }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-study-command');
  t.after(() => stopOwnedStudy(storeDir));
  const npm = process.platform === 'win32' ? process.execPath : path.join(path.dirname(process.execPath), 'npm');
  const npmArgs = process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];
  await assert.rejects(command(npm, [...npmArgs, 'run', '--silent', 'study'], { cwd: ROOT }), /usage:/);
  assert.equal(fs.existsSync(path.join(storeDir, '.training')), false);
  const output = await command(npm, [...npmArgs, 'run', '--silent', 'study', '--', storeDir], { cwd: ROOT });
  const service = await inspectStudyService(storeDir);
  assert.equal(output.trim(), service.studyUrl);
  await command(npm, [...npmArgs, 'run', '--silent', 'study:stop', '--', storeDir], { cwd: ROOT });
  assert.throws(() => process.kill(service.pid, 0), (error) => error.code === 'ESRCH');
});

test('S8 full: relay recovery restarts a stopped study service and publishes its rotated URL', { timeout: 15000 }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-rotation-heal');
  const gameDir = path.join(storeDir, 'session');
  fs.mkdirSync(gameDir, { mode: 0o700 });
  const loop = createGameLoop({ gameDir, lockDir: storeDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 40, storeDir, trainingEnabled: true, opponentRuntime: 'policy' } });
  t.after(async () => { await loop.requestStop(); await stopOwnedStudy(storeDir); });
  await loop.bootstrap(resolve(...STORE_ARGS));
  const firstService = await inspectStudyService(storeDir);
  const oldPid = loop.serverPid;
  await stopStudyService(storeDir, { expectedInstanceId: firstService.instanceId });
  process.kill(oldPid, 'SIGTERM'); // This is the child just created by the owned loop.
  await waitValue(() => { try { process.kill(oldPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  const running = loop.run();
  running.catch(() => {});
  const healed = await waitValue(async () => {
    const file = path.join(gameDir, 'lock.json');
    if (!fs.existsSync(file)) return null; // verified stale-lock retirement precedes the new listener
    const lock = JSON.parse(fs.readFileSync(file));
    if (lock.serverPid === oldPid) return null;
    const snapshot = await relayRequest(lock, '/api/snapshot');
    return snapshot.body.view?.legal?.decisionId ? { lock, snapshot } : null;
  });
  const service = await inspectStudyService(storeDir);
  assert.notEqual(service.instanceId, firstService.instanceId);
  assert.notEqual(service.studyUrl, firstService.studyUrl);
  assert.equal(healed.snapshot.body.studyUrl, service.studyUrl);
  assert.equal(JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json'))).handNo, 1);
  await loop.requestStop();
  await running;
  assert.equal((await inspectStudyService(storeDir)).instanceId, service.instanceId);
});

test('S8 full: corrupt study ownership blocks relay replacement without rewriting either file', { timeout: 10000 }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-corrupt-study');
  const gameDir = path.join(storeDir, 'session');
  fs.mkdirSync(gameDir, { mode: 0o700 });
  const defaults = resolve(...STORE_ARGS);
  const initialized = await engine(['init', '--game-dir', gameDir, '--ai', String(defaults.ai), ...engineInitFlags(defaults)]);
  assert.equal(initialized.code, 0);
  fs.mkdirSync(path.join(storeDir, '.training'), { mode: 0o700 });
  const descriptor = path.join(storeDir, '.training', 'study-service.json');
  const corrupt = '{"schemaVersion":999}';
  fs.writeFileSync(descriptor, corrupt, { mode: 0o600 });
  const relay = await launchRelay(t, gameDir, initialized.json.sessionToken);
  const lockFile = path.join(gameDir, 'lock.json');
  const lockBefore = fs.readFileSync(lockFile);
  const loop = createGameLoop({ gameDir, lockDir: storeDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 0, storeDir, trainingEnabled: true, opponentRuntime: 'policy' } });
  t.after(() => loop.requestStop());
  await assert.rejects(loop.bootstrap({ ...defaults, preinitialized: initialized.json }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  assert.equal(fs.readFileSync(descriptor, 'utf8'), corrupt);
  assert.deepEqual(fs.readFileSync(lockFile), lockBefore);
  assert.doesNotThrow(() => process.kill(relay.child.pid, 0));
});

test('S8 full: capability verification rechecks the pinned relay lock before adoption', { timeout: 10000, concurrency: false }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-capability-race');
  const gameDir = path.join(storeDir, 'session');
  fs.mkdirSync(gameDir, { mode: 0o700 });
  t.after(() => stopOwnedStudy(storeDir));
  const defaults = resolve(...STORE_ARGS);
  const initialized = await engine(['init', '--game-dir', gameDir, '--ai', String(defaults.ai), ...engineInitFlags(defaults)]);
  const service = await ensureStudyService(storeDir, ownedServiceOptions());
  const relay = await launchRelay(t, gameDir, initialized.json.sessionToken, { studyUrl: service.studyUrl });
  const lockFile = path.join(gameDir, 'lock.json');
  const replacement = JSON.stringify({ ...relay.lock, sessionToken: 'foreign-owner-token' });
  const originalFetch = globalThis.fetch;
  let replaced = false;
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (!replaced && String(url) === `http://127.0.0.1:${relay.lock.port}/api/health`
      && options?.headers?.['x-session-token'] === initialized.json.sessionToken) {
      fs.renameSync(lockFile, path.join(gameDir, 'original-owned-lock.json'));
      fs.writeFileSync(lockFile, replacement);
      replaced = true;
    }
    return response;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const loop = createGameLoop({ gameDir, lockDir: storeDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 0, storeDir, trainingEnabled: true, opponentRuntime: 'policy' } });
  t.after(() => loop.requestStop());
  await assert.rejects(loop.bootstrap({ ...defaults, preinitialized: initialized.json }), { code: 'SERVER_LOCK_REPLACED' });
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), replacement);
  assert.doesNotThrow(() => process.kill(relay.child.pid, 0), 'changed ownership must not acquire kill authority');
});

test('S8 full: optional relay port is validated and never becomes an engine option', () => {
  assert.equal(parseGameLoopArgs([...STORE_ARGS, '--port', '0']).port, 0);
  assert.equal(parseGameLoopArgs([...STORE_ARGS, '--port', '65535']).port, 65535);
  assert.equal(Object.hasOwn(parseGameLoopArgs(STORE_ARGS), 'port'), false);
  for (const value of ['-1', '65536', '1.5', 'NaN', '1e2']) {
    assert.throws(() => parseGameLoopArgs([...STORE_ARGS, '--port', value]), { code: 'USAGE' });
  }
  assert.equal(engineInitFlags(resolve(...STORE_ARGS, '--port', '0')).includes('--port'), false);
});

test('S8 full: actual store CLI forwards port zero to an ephemeral authenticated relay', { timeout: 15000 }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-cli-port');
  const fake = failedCliFixtures({ hold: true });
  const cli = startCli(['--store-dir', storeDir, '--port', '0'], fake.env);
  let gameDir;
  t.after(async () => { await cleanupCli(cli, gameDir); await stopOwnedStudy(storeDir); });
  await until(() => readFirstFixtureRecord(fake.log, cli.child), cli);
  const current = JSON.parse(fs.readFileSync(path.join(storeDir, '.session-store/current.json')));
  gameDir = path.join(storeDir, '.session-store', current.sessionRel);
  const file = path.join(gameDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(file));
  assert.equal(state.handNo, 0);
  state.button = 2;
  fs.writeFileSync(file, JSON.stringify(state));
  fake.release();
  const lock = await until(() => {
    const file = path.join(gameDir, 'lock.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
  }, cli);
  assert.ok(lock.port > 0 && lock.port <= 65535);
  assert.match(captureCliRelay(gameDir).args, /--port 0(?: |$)/);
  assert.equal((await relayRequest(lock, '/api/snapshot')).status, 200);
  await waitValue(async () => (await relayRequest(lock, '/api/snapshot')).body.view?.legal?.toAct === 'user');
  // Deliberately leave the protected wait unresolved to exercise failure cleanup.
  // The default20 journey separately proves graceful delivery and once-only resume.
  await cleanupCli(cli, gameDir);
  assert.equal(cli.child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(lock.serverPid, 0), (error) => error.code === 'ESRCH');
  assert.equal((await inspectStudyService(storeDir)).status, 'running');
});
