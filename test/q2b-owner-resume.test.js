import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gameEpochOf } from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import { prepareSession } from '../engine/session-catalog.js';
import { createGameLoop } from '../tools/game-loop.js';
import { createTrainingControl } from '../tools/training-control.js';
import { createProfileStore } from '../tools/training-stores.js';

const WIN32_SKIP = process.platform === 'win32'
  ? 'production spawn uses POSIX PATH/ps/shebang fixtures'
  : undefined;

function test(name, opts, fn) {
  if (typeof opts === 'function') {
    return nodeTest(name, WIN32_SKIP ? { skip: WIN32_SKIP } : {}, opts);
  }
  return nodeTest(name, WIN32_SKIP ? { ...opts, skip: WIN32_SKIP } : opts, fn);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_CLI = path.join(ROOT, 'engine', 'cli.js');
const GAME_LOOP = path.join(ROOT, 'tools', 'game-loop.js');

function tmp(prefix = 'holdem-q2b-resume-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLoopLog(sessionDir) {
  try {
    return fs.readFileSync(path.join(sessionDir, 'loop.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(probe, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function killChild(child, signal = 'SIGKILL') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = childExit(child);
  child.kill(signal);
  await exited;
}

async function terminatePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const dead = await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }, `pid ${pid} did not stop`, 1_000).catch(() => false);
  if (dead) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

function trainingHashes(sessionDir) {
  return directoryHashes(path.join(sessionDir, 'training'));
}

function storeTrainingHashes(storeDir) {
  return directoryHashes(path.join(storeDir, '.training'));
}

function directoryHashes(root) {
  const hashes = {};
  const visit = (dir, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, rel);
      else hashes[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  visit(root);
  return hashes;
}

function writeLoopState(sessionDir, sessionToken, phase, ownerSessionId = 'owner-0') {
  fs.writeFileSync(path.join(sessionDir, 'loop-state.json'), JSON.stringify({
    phase,
    handNo: 0,
    port: null,
    sessionToken,
    gameEpoch: gameEpochOf(sessionToken),
    ownerSessionId,
    stopping: false,
    lastPublishId: null,
    playerRuntime: phase === 'finalizing' ? null : 'claude',
    upperRuntime: 'claude',
    startedAt: '2026-09-04T00:00:00.000Z',
    notices: [],
    metrics: [],
  }));
}

function writeAuthority(sessionDir, sessionToken, {
  schemaVersion = 2,
  ownerSessionId = 'owner-0',
  ownerHistory = [],
} = {}) {
  const trainingDir = path.join(sessionDir, 'training');
  fs.mkdirSync(trainingDir, { recursive: true });
  fs.writeFileSync(path.join(trainingDir, 'evaluations.jsonl'), '');
  fs.writeFileSync(path.join(trainingDir, '.training-authority.json'), JSON.stringify({
    schemaVersion,
    gameEpoch: gameEpochOf(sessionToken),
    ownerSessionId,
    ownerHistory,
    items: {},
    publishQueue: {},
    ...(schemaVersion === 2 ? { pending: {}, annotationQueue: {}, solveTasks: {} } : {}),
  }));
}

function seedCatalogSession(storeDir, phase, options = {}) {
  const prepared = prepareSession(storeDir);
  const initialized = JSON.parse(execFileSync(process.execPath, [
    ENGINE_CLI,
    'init',
    '--ai', '1',
    '--stack', '100',
    '--game-dir', prepared.stagingDir,
  ], { encoding: 'utf8' }).trim());
  fs.renameSync(prepared.stagingDir, prepared.sessionDir);
  fs.writeFileSync(
    path.join(storeDir, '.session-store', 'current.json'),
    JSON.stringify({
      gameId: prepared.gameId,
      sessionRel: `sessions/${prepared.gameId}`,
      selectionVersion: prepared.selectionVersion,
    }),
  );
  const committed = { gameId: prepared.gameId, sessionDir: prepared.sessionDir };
  writeLoopState(committed.sessionDir, initialized.sessionToken, phase);
  writeAuthority(committed.sessionDir, initialized.sessionToken, options);
  return { ...committed, sessionToken: initialized.sessionToken };
}

async function leaveSigkilledStoreOwner(storeDir) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await waitFor(() => {
    try { process.kill(child.pid, 0); return true; } catch { return false; }
  }, 'dummy owner did not start');
  const startTime = `TEST_START_${child.pid}`;
  const lockDir = path.join(storeDir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), `${child.pid}\n${startTime}`);
  await killChild(child, 'SIGKILL');
}

async function leaveSigkilledTrainingOwner(sessionDir) {
  const stateModule = pathToFileURL(path.join(ROOT, 'engine', 'state.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import { withNamedLock } from ${JSON.stringify(stateModule)};
await withNamedLock(${JSON.stringify(sessionDir)}, 'training.lock.d', async () => {
  process.stdout.write('locked\\n');
  await new Promise(() => {});
});
`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let ready = false;
  child.stdout.on('data', (chunk) => {
    if (String(chunk).includes('locked')) ready = true;
  });
  await waitFor(() => ready, 'training lock owner did not start');
  await killChild(child, 'SIGKILL');
  assert.equal(fs.existsSync(path.join(sessionDir, 'training.lock.d')), true);
}

function fakeClaudeBin() {
  const binDir = tmp('holdem-q2b-bin-');
  const claude = path.join(binDir, 'claude');
  fs.writeFileSync(claude, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.readFileSync(0, 'utf8');
if (args.includes('stream-json')) {
  process.stdout.write(JSON.stringify({type:'system', subtype:'init', tools:[], mcp_servers:[], hooks:[]}) + '\\n');
  process.stdout.write(JSON.stringify({type:'result', result:'ok'}) + '\\n');
} else {
  process.stdout.write('ready\\n');
}
`);
  fs.chmodSync(claude, 0o755);
  const ps = path.join(binDir, 'ps');
  fs.writeFileSync(ps, `#!/bin/sh
pid=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-p' ]; then pid="$2"; shift 2; else shift; fi
done
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  printf 'TEST_START_%s\\n' "$pid"
  exit 0
fi
exit 1
`);
  fs.chmodSync(ps, 0o755);
  return binDir;
}

function launchResume(storeDir, binDir) {
  const child = spawn(process.execPath, [
    GAME_LOOP,
    '--store-dir', storeDir,
    '--resume',
    '--player-runtime', 'claude',
  ], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, stderr: () => stderr };
}

async function waitForOwnerRotation(sessionDir, previousOwner, stderr) {
  return waitFor(() => {
    try {
      const current = readJson(path.join(sessionDir, 'loop-state.json'));
      if (current.ownerSessionId === previousOwner) return null;
      const authority = readJson(path.join(
        sessionDir,
        'training',
        '.training-authority.json',
      ));
      return authority.ownerSessionId === current.ownerSessionId ? current : null;
    } catch {
      return null;
    }
  }, `resume did not rotate owner: ${stderr()}`);
}

async function cleanupSession(child, sessionDir) {
  if (child) await killChild(child).catch(() => {});
  try {
    const lock = readJson(path.join(sessionDir, 'lock.json'));
    await terminatePid(lock.serverPid);
  } catch {
    // no live server lock
  }
}

function acceptedEvaluation(sessionToken, decisionId = 'd-1-preflop-0') {
  const gameEpoch = gameEpochOf(sessionToken);
  return {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch,
      decisionId,
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId,
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'preferred',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  };
}

test('Q2b two consecutive playing SIGKILL resumes transfer training ownership twice', { timeout: 60_000 }, async (t) => {
  const storeDir = tmp();
  const seeded = seedCatalogSession(storeDir, 'playing');
  const binDir = fakeClaudeBin();
  const launched = [];
  t.after(async () => {
    for (const run of launched) await cleanupSession(run.child, seeded.sessionDir);
  });
  await leaveSigkilledStoreOwner(storeDir);

  const first = launchResume(storeDir, binDir);
  launched.push(first);
  const firstState = await waitForOwnerRotation(seeded.sessionDir, 'owner-0', first.stderr);
  await killChild(first.child, 'SIGKILL');
  const tc = createTrainingControl({ storeDir });
  await tc.migrateAuthority(seeded.sessionDir, { recoverOwnerId: firstState.ownerSessionId });

  const second = launchResume(storeDir, binDir);
  launched.push(second);
  const secondState = await waitForOwnerRotation(
    seeded.sessionDir,
    firstState.ownerSessionId,
    second.stderr,
  );
  await killChild(second.child, 'SIGKILL');
  await tc.migrateAuthority(seeded.sessionDir, { recoverOwnerId: secondState.ownerSessionId });
  await leaveSigkilledTrainingOwner(seeded.sessionDir);
  await tc.migrateAuthority(seeded.sessionDir, {
    recoverOwnerId: secondState.ownerSessionId,
  });
  const auth = tc.loadAuthority(seeded.sessionDir);

  assert.equal(auth.ownerSessionId, secondState.ownerSessionId);
  assert.deepEqual(
    auth.ownerHistory.map(({ from, to, reason }) => ({ from, to, reason })),
    [
      { from: 'owner-0', to: firstState.ownerSessionId, reason: 'resume' },
      { from: firstState.ownerSessionId, to: secondState.ownerSessionId, reason: 'resume' },
    ],
  );
  await createTrainingControl({ storeDir }).reconcile(seeded.sessionDir, {
    gameEpoch: gameEpochOf(seeded.sessionToken),
    owner: secondState.ownerSessionId,
    lastHand: null,
    handsDir: path.join(seeded.sessionDir, 'hands'),
  });
  const accepted = await createTrainingControl({ storeDir }).acceptEvaluations(seeded.sessionDir, {
    gameEpoch: gameEpochOf(seeded.sessionToken),
    owner: secondState.ownerSessionId,
    handNo: 1,
    evaluations: [acceptedEvaluation(seeded.sessionToken)],
  });
  assert.equal(accepted.accepted.length, 1);
});

test('Q2b crash chain preserves exact A-to-B-to-C-to-D owner history', { timeout: 60_000 }, async (t) => {
  const storeDir = tmp();
  const seeded = seedCatalogSession(storeDir, 'playing', { ownerSessionId: 'authority-a' });
  writeLoopState(seeded.sessionDir, seeded.sessionToken, 'playing', 'persisted-b');
  const binDir = fakeClaudeBin();
  const launched = [];
  t.after(async () => {
    for (const run of launched) await cleanupSession(run.child, seeded.sessionDir);
  });
  await leaveSigkilledStoreOwner(storeDir);
  const tc = createTrainingControl({ storeDir });

  const first = launchResume(storeDir, binDir);
  launched.push(first);
  const currentC = await waitForOwnerRotation(seeded.sessionDir, 'persisted-b', first.stderr);
  await waitFor(
    () => tc.loadAuthority(seeded.sessionDir)?.ownerSessionId === currentC.ownerSessionId,
    'first resume did not publish training authority',
  );
  await killChild(first.child, 'SIGKILL');
  await tc.migrateAuthority(seeded.sessionDir, { recoverOwnerId: currentC.ownerSessionId });

  const second = launchResume(storeDir, binDir);
  launched.push(second);
  const currentD = await waitForOwnerRotation(seeded.sessionDir, currentC.ownerSessionId, second.stderr);
  await waitFor(
    () => tc.loadAuthority(seeded.sessionDir)?.ownerSessionId === currentD.ownerSessionId,
    'second resume did not publish training authority',
  );
  await killChild(second.child, 'SIGKILL');
  await tc.migrateAuthority(seeded.sessionDir, { recoverOwnerId: currentD.ownerSessionId });
  const auth = tc.loadAuthority(seeded.sessionDir);

  assert.equal(auth.ownerSessionId, currentD.ownerSessionId);
  assert.deepEqual(
    auth.ownerHistory.map(({ from, to, reason }) => ({ from, to, reason })),
    [
      { from: 'authority-a', to: 'persisted-b', reason: 'resume' },
      { from: 'persisted-b', to: currentC.ownerSessionId, reason: 'resume' },
      { from: currentC.ownerSessionId, to: currentD.ownerSessionId, reason: 'resume' },
    ],
  );
});

test('Q2b migration failure halts before rotating the persisted loop owner', { timeout: 30_000 }, async (t) => {
  const storeDir = tmp();
  const seeded = seedCatalogSession(storeDir, 'playing');
  fs.writeFileSync(
    path.join(seeded.sessionDir, 'training', '.migration-v2.json'),
    JSON.stringify({ status: 'in-progress' }),
  );
  const binDir = fakeClaudeBin();
  await leaveSigkilledStoreOwner(storeDir);
  const run = launchResume(storeDir, binDir);
  t.after(() => cleanupSession(run.child, seeded.sessionDir));

  const halted = await waitFor(() => {
    const state = readJson(path.join(seeded.sessionDir, 'loop-state.json'));
    return state.halt?.source === 'training-migration' ? state : null;
  }, `migration failure did not halt: ${run.stderr()}`);
  await killChild(run.child, 'SIGKILL');

  assert.equal(halted.ownerSessionId, 'owner-0');
  assert.equal(halted.halt.code, 'TRAINING_MIGRATION_CORRUPT');
});

test('Q2b takeover failure becomes a durable training-owner halt before producer work', { timeout: 30_000 }, async (t) => {
  const storeDir = tmp();
  const seeded = seedCatalogSession(storeDir, 'playing', { ownerHistory: {} });
  const binDir = fakeClaudeBin();
  await leaveSigkilledStoreOwner(storeDir);
  const run = launchResume(storeDir, binDir);
  t.after(() => cleanupSession(run.child, seeded.sessionDir));

  const halted = await waitFor(() => {
    const state = readJson(path.join(seeded.sessionDir, 'loop-state.json'));
    return state.halt?.source === 'training-owner' ? state : null;
  }, `takeover failure did not halt: ${run.stderr()}`);
  await killChild(run.child, 'SIGKILL');

  assert.equal(halted.halt.code, 'TRAINING_OWNER_HISTORY_INVALID');
  assert.equal(
    readLoopLog(seeded.sessionDir).some((entry) => entry.event === 'training-reconcile-registered'),
    false,
  );
});

test('Q2b playing resume logs nonfatal consumer failures and continues valid items', { timeout: 40_000 }, async (t) => {
  const storeDir = tmp();
  const seeded = seedCatalogSession(storeDir, 'playing');
  const tc = createTrainingControl({ storeDir });
  const bad = acceptedEvaluation(seeded.sessionToken, 'd-1-preflop-0');
  const good = acceptedEvaluation(seeded.sessionToken, 'd-2-preflop-0');
  await tc.acceptEvaluations(seeded.sessionDir, {
    gameEpoch: gameEpochOf(seeded.sessionToken),
    owner: 'owner-0',
    handNo: 2,
    evaluations: [bad, good],
  });
  const authority = tc.loadAuthority(seeded.sessionDir);
  const badSummary = authority.items[bad.evaluationId].summary;
  await createProfileStore(storeDir).apply({
    ...badSummary,
    payloadSha256: 'cd'.repeat(32),
  });

  const binDir = fakeClaudeBin();
  await leaveSigkilledStoreOwner(storeDir);
  const run = launchResume(storeDir, binDir);
  t.after(() => cleanupSession(run.child, seeded.sessionDir));

  const event = await waitFor(
    () => readLoopLog(seeded.sessionDir)
      .find((entry) => entry.event === 'training-consume-failed'),
    `resume did not log consumer failure: ${run.stderr()}`,
    5_000,
  );
  await killChild(run.child, 'SIGKILL');
  const after = tc.loadAuthority(seeded.sessionDir);

  assert.equal(event.failed, 1);
  assert.equal(after.items[bad.evaluationId].consumers.profiled, false);
  assert.equal(after.items[bad.evaluationId].consumers.lastError.code, 'PROFILE_EVENT_CONFLICT');
  assert.equal(after.items[good.evaluationId].consumers.profiled, true);
  assert.equal(after.items[good.evaluationId].consumers.banked, true);
});

test('Q2b finalizing resume after SIGKILL transfers owner before reconcile', { timeout: 40_000 }, async (t) => {
  const storeDir = tmp();
  const seeded = seedCatalogSession(storeDir, 'finalizing');
  const binDir = fakeClaudeBin();
  await leaveSigkilledStoreOwner(storeDir);
  const run = launchResume(storeDir, binDir);
  t.after(() => cleanupSession(run.child, seeded.sessionDir));

  const resumed = await waitForOwnerRotation(seeded.sessionDir, 'owner-0', run.stderr);
  await killChild(run.child, 'SIGKILL');
  const auth = createTrainingControl({ storeDir }).loadAuthority(seeded.sessionDir);

  assert.equal(auth.ownerSessionId, resumed.ownerSessionId);
  assert.deepEqual(
    auth.ownerHistory.map(({ from, to, reason }) => ({ from, to, reason })),
    [{ from: 'owner-0', to: resumed.ownerSessionId, reason: 'resume' }],
  );
  await createTrainingControl({ storeDir }).reconcile(seeded.sessionDir, {
    gameEpoch: gameEpochOf(seeded.sessionToken),
    owner: resumed.ownerSessionId,
    lastHand: null,
    handsDir: path.join(seeded.sessionDir, 'hands'),
  });
});

test('Q2b done resume leaves every training byte and ownerHistory unchanged', { timeout: 20_000 }, async (t) => {
  const gameDir = tmp();
  const storeDir = tmp();
  const initialized = JSON.parse(execFileSync(process.execPath, [
    ENGINE_CLI,
    'init',
    '--ai', '1',
    '--stack', '100',
    '--game-dir', gameDir,
  ], { encoding: 'utf8' }).trim());
  writeLoopState(gameDir, initialized.sessionToken, 'done');
  writeAuthority(gameDir, initialized.sessionToken, {
    schemaVersion: 2,
    ownerHistory: [{ from: 'older', to: 'owner-0', reason: 'resume', at: 'before' }],
  });
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  loopState.halt = {
    code: 'TRAINING_MIGRATION_CORRUPT',
    message: 'stale migration halt',
    source: 'training-migration',
  };
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify(loopState));
  const beforeSessionTraining = trainingHashes(gameDir);
  const beforeStoreTraining = storeTrainingHashes(storeDir);
  const beforeHistory = readJson(path.join(gameDir, 'training', '.training-authority.json')).ownerHistory;
  const lockDir = path.join(gameDir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\ntest-owned-lock`);
  const lockStat = fs.statSync(lockDir, { bigint: true });
  const initialLockHandle = {
    dir: lockDir,
    pid: process.pid,
    startTime: 'test-owned-lock',
    dev: lockStat.dev,
    ino: lockStat.ino,
  };
  const loop = createGameLoop({
    gameDir,
    initialLockHandle,
    resolver: async () => { throw new Error('done resume must not resolve runtimes'); },
    opts: { port: 0, storeDir },
  });
  t.after(() => loop.requestStop().catch(() => {}));

  const resumed = await loop.resume({ skipLock: true });
  const finished = await loop.run();

  assert.equal(resumed.phase, 'done');
  assert.equal(finished.phase, 'done');
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).halt, undefined);
  assert.deepEqual(trainingHashes(gameDir), beforeSessionTraining);
  assert.deepEqual(storeTrainingHashes(storeDir), beforeStoreTraining);
  assert.deepEqual(
    readJson(path.join(gameDir, 'training', '.training-authority.json')).ownerHistory,
    beforeHistory,
  );
});
