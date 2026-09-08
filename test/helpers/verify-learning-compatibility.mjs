#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { isPrivatePath } from '../../shared/platform-files.js';
import { stopOwnedProcessTree, spawnOwnedCommand } from './platform.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireOwnedLock, ownedProcessStartTime, releaseOwnedLock } from '../../engine/state.js';
import { newDeck } from '../../engine/cards.js';
import { LEGACY_REFERENCE_SOURCE as CANONICAL_REFERENCE_SOURCE } from '../../shared/reference.js';
import { evaluationIdOf } from '../../training/contracts.js';
import { assignmentFor, resolveExactPolicy, VERSION_V2 } from '../../training/policies/catalog.js';
import { createMistakeBank, createProfileStore } from '../../tools/training-stores.js';
import { createGameLoop } from '../../tools/game-loop.js';
import { ensureStudyService, inspectStudyService, stopStudyService } from '../../tools/study-service.js';
import { createOwnedTempDir, registerOwnedProcess } from './owned-fixtures.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'cli.js');
const RELAY = path.join(ROOT, 'server', 'server.js');
const REQUIRED_BASELINE = 'a4822d74a4251f199b52e0f02914ef659ea905dd';
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function receiptBody(value) {
  const { receiptSha256: ignored, ...body } = value;
  return body;
}

function seal(value) {
  const body = receiptBody(value);
  return { ...body, receiptSha256: sha256(JSON.stringify(body)) };
}

function canonicalCandidate(target) {
  const resolved = path.resolve(target);
  const suffix = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw coded('COMPATIBILITY_OUTPUT_UNSAFE');
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function defaultProtectedRoot() {
  const commonText = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const common = path.isAbsolute(commonText) ? commonText : path.resolve(ROOT, commonText);
  return canonicalCandidate(path.join(path.dirname(common), 'game'));
}

export function assertCompatibilityDestination(outDir, { protectedRoot = defaultProtectedRoot() } = {}) {
  if (typeof outDir !== 'string' || !outDir || outDir.includes('\0')) throw coded('COMPATIBILITY_OUTPUT_UNSAFE');
  const output = canonicalCandidate(outDir);
  const protectedPath = canonicalCandidate(protectedRoot);
  if (output === protectedPath || output.startsWith(`${protectedPath}${path.sep}`)) {
    throw coded('PROTECTED_STORE_OUTPUT_FORBIDDEN');
  }
  return output;
}

function safeOutputDir(dir) {
  const resolved = assertCompatibilityDestination(dir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded('COMPATIBILITY_OUTPUT_UNSAFE');
  return resolved;
}

function writeJson(file, value) {
  safeOutputDir(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function hashTree(root) {
  const rows = [];
  const visit = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(file);
      if (entry.isSymbolicLink()) rows.push({ path: next, type: 'symlink', target: fs.readlinkSync(file) });
      else if (entry.isDirectory()) visit(file, next);
      else if (entry.isFile()) rows.push({ path: next, type: 'file', size: stat.size, sha256: sha256(fs.readFileSync(file)) });
      else rows.push({ path: next, type: 'other' });
    }
  };
  visit(root);
  return sha256(JSON.stringify(rows));
}

async function until(read, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    try { value = await read(); } catch { value = null; }
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw coded('COMPATIBILITY_WAIT_TIMEOUT');
}

function commandEnvironment(tmpDir) {
  return {
    ...Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM']
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    TMPDIR: tmpDir,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
}

export async function runOwned(command, args, { cwd = ROOT, tmpDir, timeoutMs = 30_000 } = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let outputLimited = false;
  let spawnError = null;
  const child = registerOwnedProcess(spawnOwnedCommand(command, args, {
    cwd,
    env: commandEnvironment(tmpDir),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }), `compatibility ${path.basename(command)}`);
  const kill = () => stopOwnedProcessTree(child);
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  const append = (kind, chunk) => {
    if (kind === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
      outputLimited = true;
      kill();
    }
  };
  child.stdout.setEncoding('utf8').on('data', (chunk) => append('stdout', chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => append('stderr', chunk));
  child.on('error', (error) => { spawnError = { code: error.code ?? null, message: error.message }; });
  const [exitCode, signal] = await new Promise((resolve) => child.on('close', (...result) => resolve(result)));
  clearTimeout(timer);
  kill(); // A successful leader exit must not strand same-group descendants.
  return seal({
    schemaVersion: 1,
    command: [command, ...args],
    cwd: path.resolve(cwd),
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode,
    signal,
    timedOut,
    outputLimited,
    spawnError,
    stdout,
    stderr,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  });
}

function assertSuccessfulProcess(result, code = 'COMPATIBILITY_CHILD_FAILED') {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.outputLimited || result.spawnError !== null) {
    throw coded(code);
  }
  return result;
}

function processSummary(command, result, { expectedFailure = false, redactions = [] } = {}) {
  const redact = (value) => redactions.reduce((text, secret) => (
    secret ? text.replaceAll(secret, '[redacted]') : text
  ), String(value));
  const stdout = redact(result.stdout);
  const stderr = redact(result.stderr);
  return seal({
    schemaVersion: 1,
    command,
    argv: result.command.map(redact),
    cwd: result.cwd,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimited: result.outputLimited,
    spawnError: result.spawnError,
    stdout,
    stderr,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    ...(redactions.length ? {
      rawStdoutSha256: result.stdoutSha256,
      rawStderrSha256: result.stderrSha256,
    } : {}),
    ...(expectedFailure ? { expectedFailure: true } : {}),
  });
}

function parseJsonStdout(result, code = 'COMPATIBILITY_CHILD_OUTPUT_INVALID') {
  assertSuccessfulProcess(result, code);
  try { return JSON.parse(result.stdout.trim()); }
  catch { throw coded(code); }
}

export function parseCompatibilityArgs(argv) {
  const usage = () => { throw coded('COMPATIBILITY_USAGE', 'usage: verify-learning-compatibility.mjs --baseline SHA40 --out-dir DIR'); };
  if (!Array.isArray(argv) || argv.length !== 4) usage();
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--baseline', '--out-dir'].includes(flag) || typeof value !== 'string' || !value
      || Object.hasOwn(values, flag)) usage();
    values[flag] = value;
  }
  if (values['--baseline'] !== REQUIRED_BASELINE || !values['--out-dir']) usage();
  return { baseline: values['--baseline'], outDir: values['--out-dir'] };
}

export function classifyRollbackSafety(receipt, authoritativeView) {
  if (!receipt || typeof receipt !== 'object') return { safe: false, code: 'OUTCOME_UNRESOLVED' };
  if (['consumed', 'rejected'].includes(receipt.phase)) return { safe: true, code: null };
  if (['accepted', 'delivered'].includes(receipt.phase)) return { safe: false, code: 'OUTCOME_UNRESOLVED' };
  if (authoritativeView?.legal?.decisionId == null) return { safe: false, code: 'OUTCOME_UNRESOLVED' };
  return { safe: false, code: 'OUTCOME_UNRESOLVED' };
}

function evaluationFixture() {
  return {
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-1-preflop-0',
      providerId: CANONICAL_REFERENCE_SOURCE.id,
      providerVersion: CANONICAL_REFERENCE_SOURCE.version,
    }),
    payloadSha256: 'cd'.repeat(32),
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    grade: 'off-policy',
    forced: false,
    evLossBb: null,
    source: { ...CANONICAL_REFERENCE_SOURCE },
    chosen: { action: 'fold', frequency: 0.2, evBb: null },
    recommended: [
      { action: 'fold', frequency: 0.2, evBb: null },
      { action: 'raise', sizeBb: 2.5, frequency: 0.8, evBb: null },
    ],
    origin: 'game',
  };
}

async function buildCurrentFixtures(storeDir) {
  const evaluation = evaluationFixture();
  const profileStore = createProfileStore(storeDir, { now: () => '2026-09-06T00:00:00.000Z' });
  const applied = await profileStore.apply(evaluation);
  if (applied.applied !== true || applied.profile.schemaVersion !== 6) throw coded('CURRENT_PROFILE_FIXTURE_FAILED');
  const bank = createMistakeBank(storeDir, { now: () => '2026-09-06T00:00:00.000Z' });
  const collected = await bank.collect(evaluation);
  if (collected.added !== true) throw coded('CURRENT_BANK_FIXTURE_FAILED');
  const policy = assignmentFor('TAG');
  if (policy.policyVersion !== VERSION_V2) throw coded('CURRENT_POLICY_FIXTURE_FAILED');
  const policyFile = path.join(storeDir, '.training', 'policy-v2.json');
  const evaluationFile = path.join(storeDir, '.training', 'evaluation.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  fs.writeFileSync(evaluationFile, JSON.stringify(evaluation), { mode: 0o600 });
  fs.writeFileSync(path.join(storeDir, 'players.json'), JSON.stringify([
    { playerId: 'user', archetype: 'Human' },
    { playerId: 'p1', archetype: 'TAG', policy },
  ]), { mode: 0o600 });
  return { evaluation, profileStore, bank, policy, policyFile, evaluationFile };
}

async function archiveBaseline(baseline, tmpDir) {
  const archiveRoot = createOwnedTempDir('holdem-compat-archive');
  const tarFile = path.join(archiveRoot, 'baseline.tar');
  const tree = path.join(archiveRoot, 'tree');
  fs.mkdirSync(tree, { mode: 0o700 });
  const archive = await runOwned('git', ['archive', '--format=tar', `--output=${tarFile}`, baseline], {
    cwd: ROOT, tmpDir, timeoutMs: 120_000,
  });
  assertSuccessfulProcess(archive, 'BASELINE_ARCHIVE_FAILED');
  const extract = await runOwned('tar', ['-xf', tarFile, '-C', tree], { cwd: ROOT, tmpDir, timeoutMs: 120_000 });
  assertSuccessfulProcess(extract, 'BASELINE_ARCHIVE_FAILED');
  const expected = await runOwned('git', ['rev-parse', `${baseline}^{commit}`], { cwd: ROOT, tmpDir });
  const commit = assertSuccessfulProcess(expected, 'BASELINE_ARCHIVE_FAILED').stdout.trim();
  if (commit !== baseline) throw coded('BASELINE_ARCHIVE_FAILED');
  return {
    tree,
    evidence: {
      commit,
      archiveSha256: sha256(fs.readFileSync(tarFile)),
      actualReader: true,
      archiveProcess: processSummary('git archive', archive),
      extractProcess: processSummary('tar extract', extract),
    },
  };
}

async function runPriorProfileCli({ baselineTree, storeDir, evaluationFile, tmpDir }) {
  // macOS /var and /private/var aliases otherwise defeat the old direct-run guard.
  const cli = fs.realpathSync(path.join(baselineTree, 'tools', 'profile-cli.js'));
  const commands = [];
  const outputs = {};
  for (const command of ['rebuild', 'show', 'apply']) {
    const args = [cli, command, '--store-dir', fs.realpathSync(storeDir)];
    if (command === 'apply') args.push('--evaluation-file', fs.realpathSync(evaluationFile));
    const processResult = await runOwned(process.execPath, args, { cwd: baselineTree, tmpDir, timeoutMs: 60_000 });
    outputs[command] = parseJsonStdout(processResult, 'PRIOR_PROFILE_READER_FAILED');
    commands.push(processSummary(command, processResult));
  }
  if (outputs.rebuild.profile?.schemaVersion !== 3 || outputs.show.profile?.schemaVersion !== 3
    || outputs.apply.applied !== false) throw coded('PRIOR_PROFILE_READER_FAILED');
  return { commands, outputs };
}

async function priorPolicyReader({ baselineTree, policyFile, storeDir, tmpDir }) {
  const before = hashTree(storeDir);
  const player = pathToFileURL(fs.realpathSync(path.join(baselineTree, 'tools', 'policy-player.js'))).href;
  const script = `import {stampPlayerPolicies} from ${JSON.stringify(player)};let code=null;
try{stampPlayerPolicies(process.argv[1]);}catch(error){code=error.code??error.message;}
process.stdout.write(JSON.stringify({code}));`;
  const run = await runOwned(process.execPath, ['--input-type=module', '-e', script, fs.realpathSync(storeDir)], {
    cwd: baselineTree, tmpDir,
  });
  const result = parseJsonStdout(run, 'PRIOR_POLICY_READER_FAILED');
  const after = hashTree(storeDir);
  if (result.code !== 'POLICY_CONFIG_MISMATCH' || before !== after) throw coded('PRIOR_POLICY_READER_FAILED');
  return { code: result.code, wrote: before !== after, process: processSummary('prior policy reader', run) };
}

async function priorBankReader({ baselineTree, storeDir, tmpDir }) {
  const before = hashTree(storeDir);
  const stores = pathToFileURL(fs.realpathSync(path.join(baselineTree, 'tools', 'training-stores.js'))).href;
  const script = `import {createMistakeBank} from ${JSON.stringify(stores)};let code=null;
try{await createMistakeBank(process.argv[1]).list();}catch(error){code=error.code??error.message;}
process.stdout.write(JSON.stringify({code}));`;
  const run = await runOwned(process.execPath, ['--input-type=module', '-e', script, fs.realpathSync(storeDir)], {
    cwd: baselineTree, tmpDir,
  });
  const result = parseJsonStdout(run, 'PRIOR_BANK_READER_FAILED');
  const after = hashTree(storeDir);
  if (result.code !== 'UNSUPPORTED_MISTAKES' || before !== after) throw coded('PRIOR_BANK_READER_FAILED');
  return { code: result.code, wrote: before !== after, process: processSummary('prior bank reader', run) };
}

async function priorLockProtection({ baselineTree, storeDir, tmpDir }) {
  const lock = acquireOwnedLock(path.join(storeDir, '.training'), 'profile.lock.d');
  try {
    const before = hashTree(storeDir);
    const cli = fs.realpathSync(path.join(baselineTree, 'tools', 'profile-cli.js'));
    const run = await runOwned(process.execPath, [
      cli, 'show', '--store-dir', fs.realpathSync(storeDir),
    ], { cwd: baselineTree, tmpDir, timeoutMs: 30_000 });
    let output;
    try { output = JSON.parse(run.stdout.trim()); } catch { throw coded('PRIOR_LOCK_PROTECTION_FAILED'); }
    const after = hashTree(storeDir);
    if (run.exitCode !== 1 || run.signal !== null || run.timedOut || run.outputLimited
      || run.spawnError !== null || output.code !== 'LOCKED' || before !== after) {
      throw coded('PRIOR_LOCK_PROTECTION_FAILED');
    }
    return {
      code: output.code,
      wrote: before !== after,
      process: processSummary('prior locked profile reader', run, { expectedFailure: true }),
    };
  } finally {
    releaseOwnedLock(lock);
  }
}

function descriptor(storeDir) {
  const file = path.join(storeDir, '.training', 'study-service.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !isPrivatePath(file)) {
    throw coded('STUDY_DESCRIPTOR_UNSAFE');
  }
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes);
  for (const key of ['drillToken', 'controlToken']) if (!SHA256.test(value[key] ?? '')) throw coded('STUDY_DESCRIPTOR_UNSAFE');
  return { bytes, value };
}

function redactedDescriptor(proof) {
  const { value, bytes } = proof;
  return {
    schemaVersion: value.schemaVersion,
    pid: value.pid,
    startTime: value.startTime,
    instanceId: value.instanceId,
    storeIdentity: value.storeIdentity,
    port: value.port,
    descriptorSha256: sha256(bytes),
    drillTokenSha256: sha256(value.drillToken),
    controlTokenSha256: sha256(value.controlToken),
  };
}

async function httpJson(port, route, { token, control = false, body } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: token ? { [control ? 'x-study-control' : 'x-drill-token']: token } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(process.platform === 'win32' ? 30_000 : 3_000),
    });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    const cause = error?.cause?.code ?? error?.cause?.name ?? 'none';
    error.message = `${error.message} cause=${cause}`;
    throw error;
  }
}

async function relayRequest(lock, route, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${lock.port}${route}`, {
    method,
    headers: { 'x-session-token': lock.sessionToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(process.platform === 'win32' ? 30_000 : 3_000),
  });
  return { status: response.status, body: await response.json() };
}

async function startRelayProcess(gameDir, token, tmpDir) {
  const actualArgv = [process.execPath, RELAY, '--game-dir', gameDir, '--port', '0', '--token', token];
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = registerOwnedProcess(spawn(actualArgv[0], actualArgv.slice(1), {
    cwd: ROOT,
    env: commandEnvironment(tmpDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  }), 'compatibility relay');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
  const lock = await until(() => {
    const file = path.join(gameDir, 'lock.json');
    return fs.existsSync(file) && stdout.includes('listening') ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  });
  return {
    child,
    lock,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const terminal = await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(coded('COMPATIBILITY_RELAY_STOP_TIMEOUT')), 3_000)),
      ]);
      return seal({
        schemaVersion: 1,
        command: 'actual relay',
        argv: actualArgv.map((arg, index) => (actualArgv[index - 1] === '--token' ? '[redacted]' : arg)),
        commandSha256: sha256(JSON.stringify(actualArgv)),
        cwd: ROOT,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        exitCode: terminal.exitCode,
        signal: terminal.signal,
        timedOut: false,
        outputLimited: false,
        spawnError: null,
        stdout,
        stderr,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        expectedSignal: 'SIGTERM',
      });
    },
  };
}

async function actualActionRecovery(tmpDir) {
  const gameDir = createOwnedTempDir('holdem-compat-action');
  const init = await runOwned(process.execPath, [ENGINE, 'init', '--ai', '5', '--mode', 'cash-training',
    '--stack-bb', '100', '--hands', '2', '--opponent-runtime', 'policy', '--game-dir', gameDir], {
    cwd: ROOT, tmpDir,
  });
  const initialized = parseJsonStdout(init, 'ACTION_RECOVERY_INIT_FAILED');
  const stateFile = path.join(gameDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.button = 2;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const newHand = await runOwned(process.execPath, [ENGINE, 'step', '--new-hand', '--deck', newDeck().join(','),
    '--game-dir', gameDir], { cwd: ROOT, tmpDir });
  const turn = parseJsonStdout(newHand, 'ACTION_RECOVERY_INIT_FAILED');
  if (turn.next?.kind !== 'user' || typeof turn.next.decisionId !== 'string') throw coded('ACTION_RECOVERY_INIT_FAILED');
  const engineBefore = fs.readFileSync(stateFile);
  const beforeStateVersion = JSON.parse(engineBefore).stateVersion;
  const relay = await startRelayProcess(gameDir, initialized.sessionToken, tmpDir);
  let relayTerminal;
  let loop;
  let running;
  let recoveryRelay;
  try {
    const published = await relayRequest(relay.lock, '/api/publish', {
      method: 'POST', body: { publishId: 1, view: turn.view },
    });
    if (published.status !== 200) throw coded('ACTION_RECOVERY_RELAY_FAILED');
    const action = { decisionId: turn.next.decisionId, requestId: 'compat-actual-action', action: 'fold' };
    const acceptedResponse = await relayRequest(relay.lock, '/api/action', { method: 'POST', body: action });
    if (acceptedResponse.status !== 200) throw coded('ACTION_RECOVERY_RELAY_FAILED');
    const receiptFile = path.join(gameDir, 'ui-action-receipt.json');
    const accepted = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const acceptedEngineBefore = sha256(fs.readFileSync(stateFile));
    const acceptedSafety = classifyRollbackSafety(accepted, turn.view);
    const acceptedEngineAfter = sha256(fs.readFileSync(stateFile));
    const deliveredResponse = await relayRequest(relay.lock,
      `/api/wait-action?expectDecisionId=${encodeURIComponent(turn.next.decisionId)}&timeoutMs=1000&token=${encodeURIComponent(relay.lock.sessionToken)}`);
    if (deliveredResponse.status !== 200 || deliveredResponse.body.requestId !== action.requestId) {
      throw coded('ACTION_RECOVERY_RELAY_FAILED');
    }
    const delivered = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const deliveredEngineBefore = sha256(fs.readFileSync(stateFile));
    const deliveredSafety = classifyRollbackSafety(delivered, null);
    const deliveredEngineAfter = sha256(fs.readFileSync(stateFile));
    if (accepted.phase !== 'accepted' || delivered.phase !== 'delivered'
      || acceptedSafety.code !== 'OUTCOME_UNRESOLVED' || deliveredSafety.code !== 'OUTCOME_UNRESOLVED'
      || acceptedEngineBefore !== acceptedEngineAfter || deliveredEngineBefore !== deliveredEngineAfter
      || !engineBefore.equals(fs.readFileSync(stateFile))) throw coded('ROLLBACK_UNRESOLVED_MUTATED');
    relayTerminal = await relay.stop();
    loop = createGameLoop({
      gameDir,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: {
        port: 0,
        waitMs: 40,
        opponentRuntime: 'policy',
        trainingEnabled: false,
        onEngineInvoke(args) { if (args[0] === 'step' && args[1] === 'user') engineInvocations.push([...args]); },
      },
    });
    const engineInvocations = [];
    await loop.resume();
    const recoveryRelayPid = loop.serverPid;
    const recoveryRelayStartTime = ownedProcessStartTime(recoveryRelayPid);
    if (!Number.isSafeInteger(recoveryRelayPid) || recoveryRelayPid < 1 || recoveryRelayStartTime === null) {
      throw coded('ACTION_RECOVERY_RELAY_FAILED');
    }
    running = loop.run();
    running.catch(() => {});
    const synchronized = await until(() => {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      return receipt.phase === 'consumed' ? receipt : null;
    });
    await loop.requestStop();
    await running;
    let recoveryRelayDead = false;
    try { process.kill(recoveryRelayPid, 0); } catch (error) { recoveryRelayDead = error.code === 'ESRCH'; }
    if (!recoveryRelayDead) throw coded('ACTION_RECOVERY_RELAY_FAILED');
    recoveryRelay = { pid: recoveryRelayPid, startTime: recoveryRelayStartTime, dead: true };
    const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const decisions = [recovered.hand, recovered.lastHand].filter(Boolean)
      .flatMap((hand) => hand.decisions ?? [])
      .filter((decision) => decision.decisionId === action.decisionId);
    if (synchronized.requestId !== action.requestId || synchronized.reason !== 'ACTION_APPLIED'
      || engineInvocations.length !== 1 || decisions.length !== 1
      || decisions[0].chosenAction?.action !== 'fold' || recovered.stateVersion <= beforeStateVersion) {
      throw coded('ACTION_RECOVERY_NOT_EXACTLY_ONCE');
    }
    return {
      unresolvedAccepted: {
        phase: accepted.phase, code: acceptedSafety.code, sideEffects: acceptedEngineBefore !== acceptedEngineAfter,
      },
      unresolvedDelivered: {
        phase: delivered.phase, code: deliveredSafety.code, sideEffects: deliveredEngineBefore !== deliveredEngineAfter,
      },
      synchronized: { phase: synchronized.phase, reason: synchronized.reason, requestId: synchronized.requestId },
      engine: {
        beforeStateVersion,
        afterStateVersion: recovered.stateVersion,
        applicationCount: decisions.length,
        invocationCount: engineInvocations.length,
        chosenAction: decisions[0].chosenAction.action,
      },
      setupCommands: [
        processSummary('engine init', init, { redactions: [initialized.sessionToken] }),
        processSummary('engine controlled new hand', newHand),
      ],
      relay: relayTerminal,
      recoveryRelay,
    };
  } finally {
    if (!relayTerminal) {
      try { relayTerminal = await relay.stop(); } catch { /* owned fixture cleanup remains authoritative */ }
    }
    if (loop) {
      try { await loop.requestStop(); } catch { /* preserve primary failure */ }
    }
    if (running) await running.catch(() => {});
  }
}

async function studyRotationRehearsal() {
  const storeDir = createOwnedTempDir('holdem-compat-study');
  const parent = acquireOwnedLock(storeDir, 'loop.lock.d');
  const services = [];
  const options = {
    parentIdentity: { pid: parent.pid, startTime: parent.startTime },
    // On win32 a checkpoint is seconds of PowerShell, and a rotation step can
    // take a minute; a 5s idle window would end the service between steps.
    testOptions: { idleTimeoutMs: process.platform === 'win32' ? 120_000 : 5_000, checkpointMs: 50 },
    onChild(child) {
      child.ref();
      services.push(registerOwnedProcess(child, 'compatibility study service'));
    },
  };
  let firstHandle;
  let secondHandle;
  try {
    firstHandle = await ensureStudyService(storeDir, options);
    const first = descriptor(storeDir);
    const firstPublic = await inspectStudyService(storeDir);
    if (firstPublic.instanceId !== firstHandle.instanceId || first.value.instanceId !== firstHandle.instanceId) {
      throw coded('STUDY_IDENTITY_MISMATCH');
    }
    const firstStop = await stopStudyService(storeDir, { expectedInstanceId: firstHandle.instanceId });
    secondHandle = await ensureStudyService(storeDir, options);
    const second = descriptor(storeDir);
    if (second.value.instanceId === first.value.instanceId
      || second.value.drillToken === first.value.drillToken
      || second.value.controlToken === first.value.controlToken) throw coded('STUDY_CAPABILITY_NOT_ROTATED');
    const oldDrill = await httpJson(secondHandle.port, '/api/health', { token: first.value.drillToken });
    const oldControl = await httpJson(secondHandle.port, '/internal/shutdown', {
      token: first.value.controlToken,
      control: true,
      body: { expectedInstanceId: secondHandle.instanceId },
    });
    if (oldDrill.status !== 401 || oldControl.status !== 401) throw coded('STUDY_CAPABILITY_NOT_ROTATED');
    const body = { mode: 'free', seed: '1', idempotencyKey: 'compatibility-once-only' };
    const firstStart = await httpJson(secondHandle.port, '/api/start', { token: second.value.drillToken, body });
    const afterFirst = hashTree(storeDir);
    const secondStart = await httpJson(secondHandle.port, '/api/start', { token: second.value.drillToken, body });
    const afterSecond = hashTree(storeDir);
    if (firstStart.status !== 200 || secondStart.status !== 200
      || firstStart.body.sessionId !== secondStart.body.sessionId || afterFirst !== afterSecond) {
      throw coded('ROLLBACK_EFFECT_NOT_EXACTLY_ONCE');
    }
    const secondStop = await stopStudyService(storeDir, { expectedInstanceId: secondHandle.instanceId });
    return {
      firstDescriptor: redactedDescriptor(first),
      firstStop,
      rebootstrap: {
        instanceRotated: second.value.instanceId !== first.value.instanceId,
        drillTokenRotated: second.value.drillToken !== first.value.drillToken,
        controlTokenRotated: second.value.controlToken !== first.value.controlToken,
        oldDrillStatus: oldDrill.status,
        oldControlStatus: oldControl.status,
        descriptor: redactedDescriptor(second),
        stopped: secondStop.stopped,
      },
      drillIdempotence: { count: 1, sameSession: firstStart.body.sessionId === secondStart.body.sessionId },
    };
  } finally {
    if (secondHandle) {
      try { await stopStudyService(storeDir, { expectedInstanceId: secondHandle.instanceId }); }
      catch (error) { if (!['STUDY_IDENTITY_MISMATCH', 'STUDY_DESCRIPTOR_CORRUPT'].includes(error.code)) throw error; }
    } else if (firstHandle) {
      try { await stopStudyService(storeDir, { expectedInstanceId: firstHandle.instanceId }); }
      catch (error) { if (!['STUDY_IDENTITY_MISMATCH', 'STUDY_DESCRIPTOR_CORRUPT'].includes(error.code)) throw error; }
    }
    releaseOwnedLock(parent);
  }
}

async function rollbackRehearsal(tmpDir) {
  return {
    actionRecovery: await actualActionRecovery(tmpDir),
    serviceRotation: await studyRotationRehearsal(),
  };
}

export async function runCompatibilityVerification({ baseline, outDir }) {
  if (baseline !== REQUIRED_BASELINE || !outDir) throw coded('COMPATIBILITY_USAGE');
  const output = safeOutputDir(outDir);
  const tmpDir = createOwnedTempDir('holdem-compat-cmdtmp');
  const currentStore = createOwnedTempDir('holdem-compat-current');
  const readerRoot = createOwnedTempDir('holdem-compat-reader');
  const current = await buildCurrentFixtures(currentStore);
  const readerStore = path.join(readerRoot, 'store');
  fs.cpSync(currentStore, readerStore, { recursive: true, errorOnExist: true });
  const readerEvaluation = path.join(readerStore, '.training', 'evaluation.json');
  const eventFile = path.join(readerStore, '.training', 'profile-events.jsonl');
  const eventBytesBefore = fs.readFileSync(eventFile);
  const evaluationBytesBefore = fs.readFileSync(readerEvaluation);
  const initialProfile = await current.profileStore.show();
  const processedDigests = { ...initialProfile.processed };
  const processedIds = Object.keys(processedDigests).sort();
  const archived = await archiveBaseline(baseline, tmpDir);
  const priorProfile = await runPriorProfileCli({
    baselineTree: archived.tree,
    storeDir: readerStore,
    evaluationFile: readerEvaluation,
    tmpDir,
  });
  const eventBytesAfter = fs.readFileSync(eventFile);
  if (!eventBytesBefore.equals(eventBytesAfter)) throw coded('PRIOR_PROFILE_REWROTE_EVENTS');
  const priorReaders = {
    policy: await priorPolicyReader({
      baselineTree: archived.tree,
      policyFile: path.join(readerStore, '.training', 'policy-v2.json'),
      storeDir: readerStore,
      tmpDir,
    }),
    bank: await priorBankReader({ baselineTree: archived.tree, storeDir: readerStore, tmpDir }),
    lockProtection: await priorLockProtection({ baselineTree: archived.tree, storeDir: readerStore, tmpDir }),
  };
  const resumedProfile = await createProfileStore(readerStore).show();
  const resumedPolicy = resolveExactPolicy(current.policy);
  const resumedBank = await createMistakeBank(readerStore).listEvidence({ origin: 'game' });
  const currentProcessedDigests = { ...resumedProfile.processed };
  const currentProcessedIds = Object.keys(resumedProfile.processed).sort();
  if (resumedProfile.schemaVersion !== 6 || JSON.stringify(processedIds) !== JSON.stringify(currentProcessedIds)
    || JSON.stringify(processedDigests) !== JSON.stringify(currentProcessedDigests)
    || resumedPolicy.policyId !== 'tag-v2' || resumedBank.length !== 1
    || resumedBank[0].payloadSha256 !== current.evaluation.payloadSha256
    || !eventBytesBefore.equals(fs.readFileSync(eventFile))
    || !evaluationBytesBefore.equals(fs.readFileSync(readerEvaluation))) throw coded('CURRENT_COMPATIBILITY_RESUME_FAILED');
  const rollback = await rollbackRehearsal(tmpDir);
  const result = seal({
    schemaVersion: 1,
    pass: true,
    baseline,
    archive: archived.evidence,
    profile: {
      sourceSchemaVersion: 4,
      priorSchemaVersion: priorProfile.outputs.show.profile.schemaVersion,
      processedIds,
      currentProcessedIds,
      processedDigests,
      currentProcessedDigests,
      eventBytesBeforeSha256: sha256(eventBytesBefore),
      eventBytesAfterSha256: sha256(eventBytesAfter),
      evaluationBytesBeforeSha256: sha256(evaluationBytesBefore),
      evaluationBytesAfterSha256: sha256(fs.readFileSync(readerEvaluation)),
      priorCommands: priorProfile.commands,
    },
    priorReaders,
    currentResume: {
      profileSchemaVersion: resumedProfile.schemaVersion,
      policyId: resumedPolicy.policyId,
      bankEvidenceCount: resumedBank.length,
      bankPayloadSha256: resumedBank[0].payloadSha256,
    },
    rollback,
    limitations: {
      providerSmoke: 'not-run',
      humanLearningEvidence: 'none',
      solverCorrectnessEvidence: 'none',
    },
  });
  writeJson(path.join(output, 'result.json'), result);
  return result;
}

async function main() {
  let parsed;
  try {
    parsed = parseCompatibilityArgs(process.argv.slice(2));
    const result = await runCompatibilityVerification(parsed);
    process.stdout.write(`${JSON.stringify({ pass: result.pass, baseline: result.baseline, receiptSha256: result.receiptSha256 })}\n`);
  } catch (error) {
    const argv = process.argv.slice(2);
    const index = argv.indexOf('--out-dir');
    if (index >= 0 && argv[index + 1]) {
      try {
        const result = seal({ schemaVersion: 1, pass: false, baseline: parsed?.baseline ?? null, code: error.code ?? 'COMPATIBILITY_FAILED' });
        writeJson(path.join(safeOutputDir(argv[index + 1]), 'result.json'), result);
      } catch (destinationError) {
        process.stderr.write(`${destinationError.code ?? 'COMPATIBILITY_OUTPUT_UNSAFE'}\n`);
        process.exitCode = 1;
        return;
      }
    }
    process.stderr.write(`${error.code ?? 'COMPATIBILITY_FAILED'}\n`);
    process.exitCode = 1;
  }
}

export function compatibilityCliEnabled(env = process.env) {
  return !env.NODE_TEST_CONTEXT;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (direct && compatibilityCliEnabled()) await main();
