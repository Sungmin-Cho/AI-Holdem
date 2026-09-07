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
import { isPrivatePath } from '../shared/platform-files.js';
import { skipOnWin32 } from './helpers/platform.js';
import { resolveRuntimes, RUNTIME_TABLE } from '../tools/player-runtime.js';
import { ensureStudyService, inspectStudyService, stopStudyService } from '../tools/study-service.js';
import {
  scaled,
  ROOT,
  STORE_ARGS,
  resolve,
  engine,
  failedCliFixtures,
  startCli,
  within,
  until,
  stopOwnedStudy,
  command,
  ownedServiceOptions,
  launchRelay,
  processCommandLine,
} from './helpers/learning-integration-fixtures.mjs';

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

test('S8 early: the actual store CLI initializes the default policy table before an upper-only probe', { timeout: scaled(15000) }, async (t) => {
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

test('S8 early: explicit LLM store launch still requires an eligible player runtime', { timeout: scaled(15000) }, async () => {
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

test('S8 early: policy bootstrap survives failed upper selection and reports LLM feedback unavailable', { timeout: scaled(10000) }, async (t) => {
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

test('S8 full: actual store bootstrap creates private lock metadata under inherited umask 002', { timeout: scaled(15000) }, async (t) => {
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

test('S8 full: store bootstrap attaches its owner and publishes the verified study URL', { timeout: scaled(15000) }, async (t) => {
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

for (const variant of ['missing study URL', 'rotated study URL', 'actual legacy capabilities']) {
  test(`S8 full: store bootstrap replaces an authenticated owned relay with ${variant}`, { timeout: scaled(20000) }, async (t) => {
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

test('S8 full: a current-URL relay is reused and the attached store owner keeps study alive', { timeout: scaled(15000) }, async (t) => {
  // A 1s idle window against 25ms checkpoints models in-process proofs; on
  // win32 one checkpoint is seconds of PowerShell and the window cannot be kept.
  if (skipOnWin32(t, 'sub-second idle and checkpoint cadence is below the per-checkpoint proof cost on win32')) return;
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

test('S8 fixture: runner process command line is observable with inherited shell environment', () => {
  const commandLine = processCommandLine(process.pid);
  assert.ok(commandLine.includes(path.basename(process.execPath)), commandLine);
});

test('S8 full: corrupt study ownership blocks relay replacement without rewriting either file', { timeout: scaled(10000) }, async (t) => {
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

test('S8 full: capability verification rechecks the pinned relay lock before adoption', { timeout: scaled(10000), concurrency: false }, async (t) => {
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
