import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyModeDefaults, parseGameLoopArgs } from '../../tools/game-loop.js';
import { createOwnedTempDir, registerOwnedProcess } from './owned-fixtures.mjs';
import { windowsPowerShellEnvironment } from '../../shared/platform-files.js';
import { ownedProcessStartTime } from '../../engine/state.js';
import { inspectStudyService, stopStudyService, HTTP_WAIT_MS } from '../../tools/study-service.js';

// Every wait in this file is sized for a host whose proofs are in-process. On
// win32 each proof is a PowerShell child and a cold study start alone may take
// two minutes, so the same waits need an order of magnitude more.
export const scaled = (ms) => (process.platform === 'win32' ? ms * 10 : ms);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ENGINE = path.join(ROOT, 'engine/cli.js');
export const LOOP = path.join(ROOT, 'tools/game-loop.js');
export const STORE_ARGS = ['--store-dir', '/tmp/s8-new-store'];
export const resolve = (...args) => applyModeDefaults(parseGameLoopArgs(args));

export function engine(args) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [ENGINE, ...args], { encoding: 'utf8', timeout: scaled(10000) }, (error, stdout, stderr) => {
      let json;
      try { json = JSON.parse(stdout.trim()); } catch { /* reported with terminal output */ }
      resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, json, stderr });
    });
    registerOwnedProcess(child, 's8-engine');
  });
}

export function failedCliFixtures({ hold = false } = {}) {
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

export function startCli(args, env, { umask } = {}) {
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

export async function within(promise, milliseconds, label = 'owned CLI') {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function until(predicate, cli, milliseconds = scaled(6000)) {
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

export async function stopOwnedStudy(storeDir) {
  if (!fs.existsSync(path.join(storeDir, '.training', 'study-service.json'))) return;
  try {
    const service = await inspectStudyService(storeDir);
    if (service.status !== 'running') return;
    assert.equal((await stopStudyService(storeDir, { expectedInstanceId: service.instanceId })).stopped, true);
    assert.throws(() => process.kill(service.pid, 0), (error) => error.code === 'ESRCH');
  } catch (error) {
    if (error.code !== 'STUDY_DESCRIPTOR_CORRUPT') throw error;
  }
}

export async function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: scaled(10000), ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
    registerOwnedProcess(child, 's8-fixture-command');
  });
}

export function ownedServiceOptions() {
  return { onChild(child) { child.ref(); registerOwnedProcess(child, 's8-study-service'); } };
}

export async function launchRelay(t, gameDir, sessionToken, { studyUrl, sourceRoot = ROOT } = {}) {
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

export async function waitValue(probe, timeoutMs = scaled(5000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('owned integration state did not converge');
}

export async function relayRequest(lock, route, body) {
  const response = await fetch(`http://127.0.0.1:${lock.port}${route}?token=${encodeURIComponent(lock.sessionToken)}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(scaled(1500)),
  });
  return { status: response.status, body: await response.json() };
}

export async function studyRequest(service, route, body) {
  const response = await fetch(`http://127.0.0.1:${service.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-drill-token': new URL(service.studyUrl).hash.slice(7), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(HTTP_WAIT_MS),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

export function processCommandLine(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  if (process.platform !== 'win32') return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: scaled(5000) }).trim();
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
  // Get-CimInstance lives in a module, so this call needs the system module path.
  { env: windowsPowerShellEnvironment(process.env, undefined, { modules: 'system' }), encoding: 'utf8', timeout: scaled(15000) }).replace(/^\uFEFF/, '').trim();
}

export function captureCliRelay(gameDir) {
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

export async function cleanupCli(cli, gameDir) {
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

export async function stopWaitingCli(cli, gameDir) {
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

export async function snapshotForActiveGame(stateFile, request) {
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
