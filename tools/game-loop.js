#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireOwnedLock,
  processStartTime,
  readOwnedLock,
  releaseOwnedLock,
  writeJsonAtomic,
} from '../engine/state.js';
import {
  buildPlayerPrompt,
  extractJsonLine,
  RUNTIME_TABLE,
  resolveRuntimes,
} from './player-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_CLI = path.join(ROOT, 'engine/cli.js');
const PUBLISH_CLI = path.join(ROOT, 'tools/publish.js');
const SERVER_CLI = path.join(ROOT, 'server/server.js');
const LOOP_LOCK = 'loop.lock.d';
const FINAL_PHASES = new Set(['finalizing', 'review_generated', 'review_published']);
const DEFAULT_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? null;

function codedError(code, message, extra = {}) {
  const error = new Error(message ?? code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function readJsonOptional(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw codedError(`BAD_${label}`, `${label}을 읽을 수 없습니다.`, { cause: error });
  }
}

function integerValue(value, flag) {
  if (!/^\d+$/.test(String(value))) throw codedError('USAGE', `${flag}는 양의 정수여야 합니다.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw codedError('USAGE', `${flag}는 양의 정수여야 합니다.`);
  return parsed;
}

export function parseGameLoopArgs(argv) {
  const parsed = {
    gameDir: path.resolve('game'),
    ai: undefined,
    stack: undefined,
    levelEvery: undefined,
    blinds: undefined,
    force: false,
    resume: false,
    playerRuntime: undefined,
    practiceFocusFile: undefined,
  };
  const bools = new Map([
    ['--force', 'force'],
    ['--resume', 'resume'],
  ]);
  const values = new Map([
    ['--game-dir', 'gameDir'],
    ['--ai', 'ai'],
    ['--stack', 'stack'],
    ['--level-every', 'levelEvery'],
    ['--blinds', 'blinds'],
    ['--player-runtime', 'playerRuntime'],
    ['--practice-focus-file', 'practiceFocusFile'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const boolName = bools.get(arg);
    if (boolName) {
      parsed[boolName] = true;
      continue;
    }
    const valueName = values.get(arg);
    if (!valueName) throw codedError('USAGE', `알 수 없는 옵션: ${arg}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw codedError('USAGE', `${arg}의 값이 필요합니다.`);
    index += 1;
    if (valueName === 'ai' || valueName === 'stack' || valueName === 'levelEvery') {
      parsed[valueName] = integerValue(value, arg);
    } else if (valueName === 'gameDir' || valueName === 'practiceFocusFile') {
      parsed[valueName] = path.resolve(value);
    } else {
      parsed[valueName] = value;
    }
  }
  return parsed;
}

export function exitCodeFor(error) {
  if (!error) return 0;
  if (error.code === 'USAGE' || error.code === 'repair_failed' || error.code === 'REPAIR_FAILED') return 2;
  if (error.code === 'REVIEW_FAILED') return 3;
  if (error.code === 'NO_PLAYER_RUNTIME') return 4;
  return 5;
}

function isoNow(now) {
  const value = now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return String(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function legalFromMessage(message) {
  if (typeof message !== 'string') return null;
  const match = /legal 수치: canCheck=(true|false) callAmount=(\d+) canRaise=(true|false) minRaiseTo=(\d+) maxRaiseTo=(\d+)/.exec(message);
  if (!match) return null;
  return {
    canCheck: match[1] === 'true',
    callAmount: Number(match[2]),
    canRaise: match[3] === 'true',
    minRaiseTo: Number(match[4]),
    maxRaiseTo: Number(match[5]),
  };
}

function validatedDecision(raw, next) {
  const parsed = extractJsonLine(raw);
  const legal = legalFromMessage(next.message);
  if (!parsed || !legal || parsed.decisionId !== next.decisionId) return null;
  if (parsed.action === 'fold') return { action: 'fold' };
  if (parsed.action === 'check') return legal.canCheck ? { action: 'check' } : null;
  if (parsed.action === 'call') {
    return !legal.canCheck && legal.callAmount > 0 ? { action: 'call' } : null;
  }
  if (parsed.action !== 'raise' || !legal.canRaise || !Number.isInteger(parsed.amount)) return null;
  if (legal.minRaiseTo > legal.maxRaiseTo) {
    return parsed.amount === legal.maxRaiseTo ? { action: 'raise', amount: parsed.amount } : null;
  }
  return parsed.amount >= legal.minRaiseTo && parsed.amount <= legal.maxRaiseTo
    ? { action: 'raise', amount: parsed.amount }
    : null;
}

export function createGameLoop({ gameDir, resolver = resolveRuntimes, opts = {} }) {
  if (!gameDir) throw codedError('USAGE', 'gameDir가 필요합니다.');
  if (typeof resolver !== 'function') throw codedError('USAGE', 'resolver가 필요합니다.');

  const root = path.resolve(gameDir);
  const now = opts.now ?? (() => new Date());
  const requestedPort = opts.port ?? 8877;
  const pollMs = opts.pollMs ?? 20;
  const serverStartMs = opts.serverStartMs ?? 5_000;
  const childTimeoutMs = opts.childTimeoutMs ?? 30_000;
  const osVerifyMs = opts.osVerifyMs ?? 1_000;
  const waitMs = opts.waitMs ?? 0;
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  const lsofPath = opts.lsofPath ?? DEFAULT_LSOF;
  const loopStatePath = path.join(root, 'loop-state.json');
  const engineStatePath = path.join(root, 'state.json');
  const playersPath = path.join(root, 'players.json');
  const sessionsPath = path.join(root, '.player-sessions.json');
  const lockPath = path.join(root, 'lock.json');
  const canaries = new Set();
  const activeChildren = new Set();
  const adapters = new Set();
  const archiveCheckedHands = new Set();

  let lockHandle = null;
  let serverChild = null;
  let serverPid = null;
  let serverIdentity = null;
  let serverAdopted = false;
  let logFd = null;
  let playerAdapter = null;
  let upperAdapter = null;
  let playerSessions = null;
  let resumeEntryPending = false;
  let stopRequested = false;
  let stopPromise = null;

  const log = (event, fields = {}) => {
    const record = { at: isoNow(now), event, ...fields };
    if (logFd !== null) fs.writeSync(logFd, `${JSON.stringify(record)}\n`);
    opts.log?.(record);
  };

  const openLog = () => {
    if (logFd !== null) return;
    fs.mkdirSync(root, { recursive: true });
    logFd = fs.openSync(path.join(root, 'loop.log'), 'a');
  };

  const readLoopState = () => readJsonOptional(loopStatePath, 'LOOP_STATE');
  const readServerLock = () => {
    let raw;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK을 읽을 수 없습니다.', { cause: error });
    }
    let lock;
    try {
      lock = JSON.parse(raw);
    } catch (error) {
      throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK JSON이 올바르지 않습니다.', { cause: error });
    }
    if (
      !lock
      || typeof lock !== 'object'
      || Array.isArray(lock)
      || !Number.isSafeInteger(lock.serverPid)
      || lock.serverPid < 1
      || !Number.isSafeInteger(lock.port)
      || lock.port < 1
      || lock.port > 65_535
      || typeof lock.sessionToken !== 'string'
      || lock.sessionToken.length === 0
    ) {
      throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK pid/port/sessionToken 계약이 올바르지 않습니다.');
    }
    return lock;
  };
  const writeLoopState = (patch) => {
    const current = readLoopState() ?? {};
    const next = { ...current, ...patch };
    writeJsonAtomic(loopStatePath, next);
    return next;
  };

  const releaseLock = () => {
    if (!lockHandle) return;
    releaseOwnedLock(lockHandle);
    lockHandle = null;
  };

  const acquireLoopLock = ({ mode, force = false }) => {
    if (lockHandle) throw codedError('LOCKED', '이 loop 인스턴스가 이미 락을 보유하고 있습니다.');
    // acquireOwnedLock은 일반 pid-less mutex와의 호환 때문에 오래된 unknown 기록을
    // mtime으로 회수할 수 있다. loop 락은 init의 파괴 경계를 보호하므로 더 엄격하다:
    // 존재하지만 identity가 불명인 기록은 나이와 무관하게 먼저 fail-closed한다.
    const observed = readOwnedLock(root, LOOP_LOCK);
    if (observed?.status === 'unknown') {
      throw codedError('LOOP_LOCK_UNKNOWN', 'loop 락 identity를 확인할 수 없어 중단합니다.');
    }
    try {
      lockHandle = acquireOwnedLock(root, LOOP_LOCK);
      return;
    } catch (error) {
      if (error.code === 'IDENTITY_UNAVAILABLE') throw error;
      if (error.code !== 'LOCKED') throw error;
      const owner = readOwnedLock(root, LOOP_LOCK);
      if (owner?.status === 'unknown') {
        throw codedError('LOOP_LOCK_UNKNOWN', 'loop 락 identity를 확인할 수 없어 중단합니다.');
      }
      if (owner?.status === 'dead') {
        throw codedError('LOOP_LOCK_UNRECLAIMABLE', '죽은 loop 락을 안전하게 회수할 수 없습니다.');
      }
      if (mode === 'bootstrap') {
        if (force) {
          throw codedError('FORCE_STOP_TASK_5C', '--force 소유자 정지는 Task 5C에서 구현됩니다.');
        }
        throw codedError('ACTIVE_GAME', '이미 진행 중인 게임이 있습니다.');
      }
      throw codedError('LOCKED', '다른 loop가 resume을 소유하고 있습니다.');
    }
  };

  const runJsonChild = (script, args) => new Promise((resolve, reject) => {
    const argv = [script, ...args, '--game-dir', root];
    const child = execFile(process.execPath, argv, {
      encoding: 'utf8',
      timeout: childTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      activeChildren.delete(child);
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok === false) {
        reject(codedError(
          envelope?.code ?? error?.code ?? 'CHILD_FAILED',
          envelope?.message ?? String(stderr).trim() ?? '자식 프로세스가 실패했습니다.',
          { cause: error, envelope },
        ));
        return;
      }
      if (!envelope || envelope.ok !== true) {
        reject(codedError('BAD_CHILD_OUTPUT', `${path.basename(script)} 출력이 JSON 성공 envelope가 아닙니다.`));
        return;
      }
      resolve(envelope);
    });
    activeChildren.add(child);
  });

  const runCli = (args) => runJsonChild(ENGINE_CLI, args);
  const runPublish = (args) => runJsonChild(PUBLISH_CLI, args);

  const serverHealthy = async (port) => {
    if (!Number.isInteger(port) || port < 1) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
      return response.ok && (await response.json()).ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const listenerOwnedBy = (pid, port) => new Promise((resolve, reject) => {
    if (!lsofPath) {
      reject(codedError('SERVER_LISTENER_UNAVAILABLE', 'pid↔port 검증 도구를 찾을 수 없습니다.'));
      return;
    }
    const child = execFile(lsofPath, [
      '-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fptn',
    ], {
      encoding: 'utf8',
      timeout: osVerifyMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      activeChildren.delete(child);
      if (error) {
        if (Number(error.code) === 1 && !error.killed && !error.signal && String(stderr).trim() === '') {
          resolve(false);
          return;
        }
        reject(codedError(
          'SERVER_LISTENER_UNAVAILABLE',
          'pid↔port OS 검증을 완료할 수 없습니다.',
          { cause: error },
        ));
        return;
      }
      const lines = String(stdout).split(/\r?\n/);
      resolve(lines.includes(`p${pid}`) && lines.includes(`n127.0.0.1:${port}`));
    });
    activeChildren.add(child);
  });

  const assertAuthenticatedServer = async (port, sessionToken) => {
    const requestSnapshot = async (token) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/snapshot?token=${encodeURIComponent(token)}`,
          { signal: controller.signal },
        );
        let body = null;
        try { body = await response.json(); } catch { /* validated by caller */ }
        return { response, body };
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const challenge = `SIDECAR_AUTH_CHALLENGE_${randomBytes(24).toString('hex')}`;
      const denied = await requestSnapshot(challenge);
      if (denied.response.status !== 401 || denied.body?.code !== 'UNAUTHORIZED') {
        throw codedError('SERVER_AUTH_FAILED', '서버가 fresh wrong-token challenge를 거부하지 않았습니다.');
      }
      const { response, body: snapshot } = await requestSnapshot(sessionToken);
      if (!response.ok) throw codedError('SERVER_AUTH_FAILED', '서버 token 인증 probe가 거부됐습니다.');
      if (
        !snapshot
        || typeof snapshot !== 'object'
        || !Number.isInteger(snapshot.revision)
        || !Object.hasOwn(snapshot, 'view')
        || !Array.isArray(snapshot.log)
        || !Array.isArray(snapshot.coach)
      ) {
        throw codedError('SERVER_AUTH_FAILED', '서버 token 인증 응답이 relay snapshot 계약과 다릅니다.');
      }
    } catch (error) {
      if (error.code === 'SERVER_AUTH_FAILED') throw error;
      throw codedError('SERVER_AUTH_UNAVAILABLE', '서버 token 인증 probe를 완료할 수 없습니다.', { cause: error });
    }
  };

  const assertServerBinding = async ({ serverPid: pid, port, sessionToken }) => {
    let ownsListener;
    try {
      ownsListener = await listenerOwnedBy(pid, port);
    } catch (error) {
      throw error;
    }
    if (!ownsListener) {
      throw codedError('SERVER_LISTENER_MISMATCH', 'lock.serverPid가 lock.port listener를 소유하지 않습니다.');
    }
    await assertAuthenticatedServer(port, sessionToken);
  };

  const ensureServer = async (sessionToken) => {
    const existing = readServerLock();
    if (existing) {
      if (existing.sessionToken !== sessionToken) {
        throw codedError('SERVER_LOCK_MISMATCH', '기존 server lock의 sessionToken이 현재 게임과 다릅니다.');
      }
      await assertServerBinding(existing);
      if (!Number.isInteger(existing.serverPid) || !processAlive(existing.serverPid)) {
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', '재사용 서버 pid를 확인할 수 없습니다.');
      }
      const startTime = processStartTime(existing.serverPid);
      if (startTime === null) {
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', '재사용 서버 startTime을 확인할 수 없습니다.');
      }
      const confirmed = readServerLock();
      if (
        confirmed?.serverPid !== existing.serverPid
        || confirmed.port !== existing.port
        || confirmed.sessionToken !== sessionToken
        || processStartTime(existing.serverPid) !== startTime
      ) {
        throw codedError('SERVER_IDENTITY_CHANGED', '재사용 서버 identity가 adoption 중 바뀌었습니다.');
      }
      await assertServerBinding(confirmed);
      if (processStartTime(existing.serverPid) !== startTime) {
        throw codedError('SERVER_IDENTITY_CHANGED', '재사용 서버 identity가 binding 재검증 뒤 바뀌었습니다.');
      }
      serverPid = existing.serverPid;
      serverIdentity = { pid: existing.serverPid, startTime };
      serverAdopted = true;
      return existing.port;
    }

    const argv = [
      SERVER_CLI,
      '--game-dir', root,
      '--port', String(requestedPort),
      '--token', sessionToken,
    ];
    const child = spawn(process.execPath, argv, {
      cwd: ROOT,
      stdio: 'ignore',
    });
    serverChild = child;
    serverPid = child.pid ?? null;
    serverAdopted = false;
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    log('server-spawn', { pid: serverPid, requestedPort });

    const deadline = Date.now() + serverStartMs;
    while (Date.now() < deadline) {
      if (spawnError) throw codedError('SERVER_START_FAILED', spawnError.message, { cause: spawnError });
      if (child.exitCode !== null || child.signalCode !== null) {
        throw codedError('SERVER_START_FAILED', `서버 자식이 조기 종료했습니다: ${child.exitCode ?? child.signalCode}`);
      }
      const lock = readServerLock();
      if (
        lock?.serverPid === child.pid
        && lock.sessionToken === sessionToken
        && await serverHealthy(lock.port)
      ) {
        serverPid = lock.serverPid;
        const startTime = processStartTime(lock.serverPid);
        serverIdentity = startTime === null ? null : { pid: lock.serverPid, startTime };
        return lock.port;
      }
      await sleep(pollMs);
    }
    throw codedError('SERVER_START_TIMEOUT', '서버 health 확인 시간이 초과됐습니다.');
  };

  const createCanaryAndResolve = async (need) => {
    const canaryAbsPath = path.join(root, `.runtime-canary-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(canaryAbsPath, `SIDECAR_CANARY_${randomBytes(24).toString('hex')}`);
    canaries.add(canaryAbsPath);
    try {
      return await resolver({ need, canaryAbsPath });
    } finally {
      try { fs.unlinkSync(canaryAbsPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      canaries.delete(canaryAbsPath);
    }
  };

  const selectAdapters = (resolved) => {
    playerAdapter = resolved.player ?? null;
    upperAdapter = resolved.upper ?? null;
    if (playerAdapter) adapters.add(playerAdapter);
    if (upperAdapter) adapters.add(upperAdapter);
  };

  const haltNoPlayer = async (notices) => {
    writeLoopState({
      notices,
      halt: {
        code: 'NO_PLAYER_RUNTIME',
        message: '적격 플레이어 런타임이 없습니다.',
      },
    });
    throw codedError('NO_PLAYER_RUNTIME', '적격 플레이어 런타임이 없습니다.');
  };

  const warmPlayers = async () => {
    if (!playerAdapter) throw codedError('NO_PLAYER_RUNTIME', '적격 플레이어 런타임이 없습니다.');
    const players = readJsonOptional(playersPath, 'PLAYERS');
    if (!Array.isArray(players)) throw codedError('BAD_PLAYERS', 'players.json이 배열이 아닙니다.');
    const aiPlayers = players.filter((player) => player.playerId !== 'user');
    const createdAt = readLoopState()?.startedAt ?? isoNow(now);
    const settled = await Promise.allSettled(aiPlayers.map(async (persona) => {
      const prompt = buildPlayerPrompt({ persona });
      const result = await playerAdapter.warmup({ playerId: persona.playerId, prompt });
      if (!result || typeof result.sessionId !== 'string' || result.sessionId === '') {
        throw codedError('NO_SESSION', `플레이어 ${persona.playerId} 세션이 없습니다.`);
      }
      return [persona.playerId, {
        runtime: playerAdapter.kind,
        sessionId: result.sessionId,
        createdAt,
      }];
    }));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const rows = settled.map((result) => result.value);
    const sessions = Object.fromEntries(rows);
    writeJsonAtomic(sessionsPath, sessions);
    playerSessions = sessions;
    return sessions;
  };

  const stopDirectServerChild = async () => {
    const child = serverChild;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      let exited = false;
      const exit = new Promise((resolve) => child.once('exit', () => {
        exited = true;
        resolve();
      }));
      child.kill('SIGTERM');
      await Promise.race([exit, sleep(1_000)]);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exit, sleep(1_000)]);
      }
      if (!exited && child.exitCode === null && child.signalCode === null) {
        throw codedError('SERVER_STOP_UNCONFIRMED', '직접 server child 종료를 확인하지 못했습니다.');
      }
    }
    serverChild = null;
    serverIdentity = null;
    serverPid = null;
  };

  const adoptedIdentityStatus = () => {
    const identity = serverIdentity;
    if (!identity) throw codedError('SERVER_IDENTITY_UNAVAILABLE', '재사용 서버 identity가 없습니다.');
    if (!processAlive(identity.pid)) return 'dead';
    const current = processStartTime(identity.pid);
    if (current === null) {
      throw codedError('SERVER_IDENTITY_UNAVAILABLE', '재사용 서버 startTime 재검증에 실패했습니다.');
    }
    if (current !== identity.startTime) {
      throw codedError('SERVER_IDENTITY_MISMATCH', '재사용 서버 pid가 다른 프로세스로 바뀌었습니다.');
    }
    return 'alive';
  };

  const waitForAdoptedDeath = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!processAlive(serverIdentity.pid)) return true;
      await sleep(pollMs);
    }
    return !processAlive(serverIdentity.pid);
  };

  const signalAdoptedServer = (signal) => {
    if (adoptedIdentityStatus() === 'dead') return false;
    try {
      process.kill(serverIdentity.pid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw codedError('SERVER_SIGNAL_FAILED', `재사용 서버 ${signal} 전송에 실패했습니다.`, { cause: error });
    }
  };

  const stopServer = async () => {
    if (!serverAdopted) {
      await stopDirectServerChild();
      return;
    }
    if (adoptedIdentityStatus() === 'dead') return;
    signalAdoptedServer('SIGTERM');
    if (!await waitForAdoptedDeath(1_000)) {
      // pid+startTime을 KILL 직전에 다시 확인한다. unknown/mismatch면 신호 없이 실패한다.
      signalAdoptedServer('SIGKILL');
      if (!await waitForAdoptedDeath(1_000)) {
        throw codedError('SERVER_STOP_UNCONFIRMED', '재사용 서버 종료를 확인하지 못했습니다.');
      }
    }
    serverIdentity = null;
    serverPid = null;
    serverAdopted = false;
  };

  const currentWatchdog = () => {
    const profile = opts.watchdog
      ?? playerAdapter?.watchdog
      ?? RUNTIME_TABLE[playerAdapter?.kind]?.watchdog;
    if (
      !profile
      || !Number.isFinite(profile.t1Ms)
      || profile.t1Ms < 0
      || !Number.isFinite(profile.t2Ms)
      || profile.t2Ms < 0
    ) {
      throw codedError('BAD_WATCHDOG', `런타임 ${playerAdapter?.kind ?? '?'}의 watchdog이 없습니다.`);
    }
    return profile;
  };

  const decideOnce = async (input, timeoutMs) => {
    const started = monotonicNow();
    try {
      // Task 4 adapter owns the child timeout contract: it kills and rejects before
      // this promise settles. Starting a second request before that settlement would
      // let two resume calls race on one persistent player session.
      const result = await playerAdapter.decide({ ...input, timeoutMs });
      return { ok: true, raw: result?.raw, modelMs: Math.max(0, monotonicNow() - started) };
    } catch (error) {
      return { ok: false, error, modelMs: Math.max(0, monotonicNow() - started) };
    }
  };

  const decideWithWatchdog = async (next, stateVersion) => {
    if (!playerAdapter || typeof playerAdapter.decide !== 'function') {
      throw codedError('NO_PLAYER_RUNTIME', 'AI 결정을 수행할 플레이어 어댑터가 없습니다.');
    }
    playerSessions ??= readJsonOptional(sessionsPath, 'PLAYER_SESSIONS');
    const session = playerSessions?.[next.toAct];
    if (!session || typeof session.sessionId !== 'string' || session.sessionId === '') {
      throw codedError('NO_SESSION', `플레이어 ${next.toAct} 세션이 없습니다.`);
    }
    const watchdog = currentWatchdog();
    const timeouts = [watchdog.t1Ms, watchdog.t2Ms];
    const startedAt = monotonicNow();
    let modelMs = 0;
    let parseMs = 0;
    let stepMs = 0;
    const applyDecision = async (action) => {
      const stepArgs = ['step', next.toAct];
      if (action === null) {
        stepArgs.push('--force-default');
      } else {
        stepArgs.push(action.action);
        if (action.action === 'raise') stepArgs.push(String(action.amount));
      }
      stepArgs.push('--expect-version', String(stateVersion));
      const stepStarted = monotonicNow();
      try {
        return await runCli(stepArgs);
      } finally {
        stepMs += Math.max(0, monotonicNow() - stepStarted);
      }
    };
    for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
      const round = await decideOnce({
        playerId: next.toAct,
        sessionId: session.sessionId,
        message: next.message,
      }, timeouts[attempt]);
      modelMs += round.modelMs;
      if (!round.ok) continue;
      const parseStarted = monotonicNow();
      const action = validatedDecision(round.raw, next);
      parseMs += Math.max(0, monotonicNow() - parseStarted);
      if (action) {
        let envelope;
        try {
          envelope = await applyDecision(action);
        } catch (error) {
          if (error.code === 'ILLEGAL_ACTION') continue;
          throw error;
        }
        return {
          envelope,
          outcome: attempt === 0 ? 'accepted' : 'retried_accepted',
          startedAt,
          modelMs,
          parseMs,
          stepMs,
        };
      }
    }
    const envelope = await applyDecision(null);
    return {
      envelope,
      outcome: 'forced_default',
      startedAt,
      modelMs,
      parseMs,
      stepMs,
    };
  };

  const recoverServerForPublish = async () => {
    if (stopRequested) throw codedError('STOPPING', '정지 중에는 서버를 재기동하지 않습니다.');
    const expected = readServerLock();
    if (expected && await serverHealthy(expected.port)) return expected.port;
    if (expected && processAlive(expected.serverPid)) {
      if (expected.serverPid !== serverPid) {
        throw codedError('SERVER_IDENTITY_CHANGED', '게시 복구 중 server lock 소유자가 바뀌었습니다.');
      }
      await stopServer();
    } else if (serverChild?.pid === expected?.serverPid) {
      serverChild = null;
      serverIdentity = null;
      serverPid = null;
      serverAdopted = false;
    }

    const current = readServerLock();
    if (current) {
      if (
        !expected
        || current.serverPid !== expected.serverPid
        || current.port !== expected.port
        || current.sessionToken !== expected.sessionToken
      ) {
        throw codedError('SERVER_IDENTITY_CHANGED', '게시 복구 중 server lock이 교체됐습니다.');
      }
      if (processAlive(current.serverPid)) {
        throw codedError('SERVER_STOP_UNCONFIRMED', '기존 서버가 살아 있어 lock을 지울 수 없습니다.');
      }
      fs.unlinkSync(lockPath);
    }
    const sessionToken = readLoopState()?.sessionToken;
    if (typeof sessionToken !== 'string' || sessionToken === '') {
      throw codedError('NO_GAME', '게시 복구에 필요한 sessionToken이 없습니다.');
    }
    const port = await ensureServer(sessionToken);
    writeLoopState({ port });
    log('server-recovered', { port, serverPid });
    return port;
  };

  const executePublish = async (args) => {
    try {
      return await runPublish(args);
    } catch (error) {
      if (error.code !== 'PUBLISH_FAILED') throw error;
      await recoverServerForPublish();
      const retryArgs = args.includes('--retry') ? args : [...args, '--retry'];
      return runPublish(retryArgs);
    }
  };

  const turnPath = path.join(root, '.turn.json');
  const publishEnvelope = async (envelope, flags = []) => {
    writeJsonAtomic(turnPath, envelope);
    const args = ['--from', turnPath, ...flags];
    let out;
    try {
      out = await executePublish(args);
    } catch (error) {
      if (error.code !== 'ATTEMPT_PENDING') throw error;
      await executePublish(['--from', turnPath, '--retry']);
      out = await executePublish(args);
    }
    const patch = {};
    if (Number.isInteger(out.publishId)) patch.lastPublishId = out.publishId;
    if (Number.isInteger(out.handNo)) patch.handNo = out.handNo;
    if (Object.keys(patch).length) writeLoopState(patch);
    return out;
  };

  const waitFlags = () => ['--wait', '--wait-ms', String(waitMs)];

  const checkArchivePending = async (out) => {
    if (!out?.archivePending) return;
    const handNo = Number(out.handNo);
    if (archiveCheckedHands.has(handNo)) return;
    archiveCheckedHands.add(handNo);
    const checked = await runCli(['resume-check']);
    log('archive-resume-check', { handNo, archiveStatus: checked.archiveStatus });
    if (checked.archiveStatus !== 'repair_failed') return;
    const message = `핸드 ${handNo} 아카이브 복구에 실패해 새 핸드를 시작하지 않습니다.`;
    writeLoopState({
      handNo,
      halt: { code: 'repair_failed', message },
    });
    throw codedError('repair_failed', message);
  };

  const appendMetric = (metric) => {
    const state = readLoopState();
    const metrics = Array.isArray(state?.metrics) ? [...state.metrics, metric] : [metric];
    writeLoopState({ metrics });
  };

  const requestStop = () => {
    if (stopPromise) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      let stopError = null;
      for (const child of activeChildren) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
      try {
        await stopServer();
      } catch (error) {
        stopError = error;
      }
      for (const adapter of adapters) {
        if (typeof adapter.dispose === 'function') await adapter.dispose();
      }
      adapters.clear();
      for (const canary of canaries) {
        try { fs.unlinkSync(canary); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      canaries.clear();
      releaseLock();
      if (logFd !== null) {
        fs.closeSync(logFd);
        logFd = null;
      }
      if (stopError) throw stopError;
    })();
    return stopPromise;
  };

  const bootstrap = async ({
    ai,
    stack,
    levelEvery,
    blinds,
    force = false,
    practiceFocusFile,
  } = {}) => {
    acquireLoopLock({ mode: 'bootstrap', force });
    try {
      // engine init의 legacy readLock은 malformed/falsy 값을 부재로 접는다. 파괴적
      // archive/init 경계에 들어가기 전에 sidecar의 strict schema로 먼저 차단한다.
      readServerLock();
      const initArgs = ['init', '--ai', String(ai)];
      if (stack !== undefined) initArgs.push('--stack', String(stack));
      if (levelEvery !== undefined) initArgs.push('--level-every', String(levelEvery));
      if (blinds !== undefined) initArgs.push('--blinds', String(blinds));
      if (force) initArgs.push('--force');
      const initialized = await runCli(initArgs);
      openLog();
      const startedAt = isoNow(now);
      writeLoopState({
        phase: 'bootstrap',
        handNo: 0,
        port: null,
        sessionToken: initialized.sessionToken,
        gameEpoch: initialized.sessionToken,
        ownerSessionId: randomUUID(),
        lastPublishId: null,
        playerRuntime: null,
        upperRuntime: null,
        startedAt,
        ...(initialized.archivedTo ? { archivedTo: initialized.archivedTo } : {}),
        notices: [],
        metrics: [],
      });
      log('bootstrap-initialized', { sessionToken: initialized.sessionToken });

      const resolved = await createCanaryAndResolve('player+upper');
      const notices = Array.isArray(resolved?.notices) ? resolved.notices : [];
      selectAdapters(resolved ?? {});
      writeLoopState({
        notices,
        playerRuntime: playerAdapter?.kind ?? null,
        upperRuntime: upperAdapter?.kind ?? null,
      });
      if (!playerAdapter) await haltNoPlayer(notices);

      const port = await ensureServer(initialized.sessionToken);
      writeLoopState({ port });
      if (practiceFocusFile !== undefined) {
        fs.copyFileSync(path.resolve(practiceFocusFile), path.join(root, '.practice-focus.json'));
      }
      await warmPlayers();
      const state = writeLoopState({ phase: 'playing' });
      log('bootstrap-playing', { port });
      return state;
    } catch (error) {
      await requestStop();
      throw error;
    }
  };

  const resolveForPhase = async (phase, engineState, existingState) => {
    if (FINAL_PHASES.has(phase)) {
      const resolved = await createCanaryAndResolve('upper-only');
      selectAdapters(resolved ?? {});
      const notices = [
        ...(Array.isArray(existingState.notices) ? existingState.notices : []),
        ...(Array.isArray(resolved?.notices) ? resolved.notices : []),
      ];
      return writeLoopState({
        notices,
        upperRuntime: upperAdapter?.kind ?? null,
      });
    }
    if (phase === 'done') return existingState;
    if (phase !== 'bootstrap' && phase !== 'playing') {
      throw codedError('BAD_LOOP_PHASE', `알 수 없는 loop phase: ${phase}`);
    }
    if (!engineState) throw codedError('NO_GAME', 'engine state가 없습니다.');

    const resolved = await createCanaryAndResolve('player+upper');
    selectAdapters(resolved ?? {});
    const notices = [
      ...(Array.isArray(existingState.notices) ? existingState.notices : []),
      ...(Array.isArray(resolved?.notices) ? resolved.notices : []),
    ];
    writeLoopState({
      notices,
      playerRuntime: playerAdapter?.kind ?? null,
      upperRuntime: upperAdapter?.kind ?? null,
    });
    if (!playerAdapter) await haltNoPlayer(notices);
    const port = await ensureServer(engineState.sessionToken);
    writeLoopState({ port });
    await warmPlayers();
    return writeLoopState({ phase: 'playing' });
  };

  const resume = async () => {
    acquireLoopLock({ mode: 'resume' });
    try {
      const engineState = readJsonOptional(engineStatePath, 'ENGINE_STATE');
      let state = readLoopState();
      if (!engineState) throw codedError('NO_GAME', 'resume할 engine 상태가 없습니다.');
      openLog();

      const ownerSessionId = randomUUID();
      if (!state) {
        const phase = engineState.gameOver ? 'finalizing' : 'playing';
        state = writeLoopState({
          phase,
          handNo: engineState.handNo ?? 0,
          port: null,
          sessionToken: engineState.sessionToken,
          gameEpoch: engineState.sessionToken,
          ownerSessionId,
          lastPublishId: null,
          playerRuntime: null,
          upperRuntime: null,
          startedAt: isoNow(now),
          notices: [],
          metrics: [],
        });
      } else {
        state = writeLoopState({ ownerSessionId });
      }

      let phase = state.phase;
      if (phase === 'playing' && engineState?.gameOver) {
        phase = 'finalizing';
        state = writeLoopState({ phase });
      }
      const resumed = await resolveForPhase(phase, engineState, state);
      resumeEntryPending = resumed.phase === 'playing';
      log('resume-ready', { phase: resumed.phase });
      return resumed;
    } catch (error) {
      await requestStop();
      throw error;
    }
  };

  const run = async () => {
    let state = readLoopState();
    if (!state) throw codedError('NOT_BOOTSTRAPPED', 'bootstrap 또는 resume이 필요합니다.');
    if (state.halt?.code) throw codedError(state.halt.code, state.halt.message);
    if (FINAL_PHASES.has(state.phase)) {
      throw codedError('FINALIZATION_TASK_7', 'finalization은 Task 7에서 구현됩니다.');
    }
    if (state.phase === 'done') return state;
    if (state.phase !== 'playing') {
      throw codedError('BOOTSTRAP_INCOMPLETE', `run할 수 없는 phase: ${state.phase}`);
    }

    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (!engine) throw codedError('NO_GAME', 'engine state가 없습니다.');
    if (engine.gameOver) {
      writeLoopState({ phase: 'finalizing', handNo: engine.handNo ?? state.handNo });
      throw codedError('FINALIZATION_TASK_7', 'finalization은 Task 7에서 구현됩니다.');
    }

    let out;
    if (resumeEntryPending) {
      const current = await runCli(['step']);
      if (fs.existsSync(path.join(root, '.publish-attempt.json'))) {
        await publishEnvelope(current, ['--retry']);
      }
      const checked = await runCli(['resume-check']);
      const checkedHandNo = Number(current.view?.handNo ?? state.handNo);
      if (Number.isSafeInteger(checkedHandNo) && checkedHandNo >= 0) {
        archiveCheckedHands.add(checkedHandNo);
      }
      log('resume-archive-check', { handNo: checkedHandNo, archiveStatus: checked.archiveStatus });
      if (checked.archiveStatus === 'repair_failed') {
        const message = 'resume 중 아카이브 복구에 실패해 게임을 중단합니다.';
        writeLoopState({ halt: { code: 'repair_failed', message } });
        throw codedError('repair_failed', message);
      }
      const synchronized = await runCli(['step']);
      out = await publishEnvelope(synchronized, ['--view-only', ...waitFlags()]);
      resumeEntryPending = false;
    } else if (engine.hand) {
      const synchronized = await runCli(['step']);
      out = await publishEnvelope(synchronized, ['--view-only', ...waitFlags()]);
    } else {
      const started = await runCli(['step', '--new-hand']);
      out = await publishEnvelope(started, waitFlags());
    }

    while (!stopRequested) {
      await checkArchivePending(out);
      if (out.handOver) {
        log('coach-task-6-stub', { handNo: out.handNo });
        const userBusted = Array.isArray(out.control?.bust) && out.control.bust.includes('user');
        if (out.gameOver || userBusted) {
          state = writeLoopState({ phase: 'finalizing', handNo: out.handNo });
          throw codedError('FINALIZATION_TASK_7', 'finalization은 Task 7에서 구현됩니다.');
        }
        const started = await runCli(['step', '--new-hand']);
        const narration = started.events?.find((event) => event.type === 'level_up');
        const flags = narration
          ? ['--narration', `블라인드 ${narration.sb}/${narration.bb}`, ...waitFlags()]
          : waitFlags();
        out = await publishEnvelope(started, flags);
        continue;
      }

      if (out.next?.kind === 'user') {
        throw codedError('USER_HAND_LOOP_TASK_5C', 'user wait/action 경로는 Task 5C에서 구현됩니다.');
      }
      if (out.next?.kind !== 'ai') {
        throw codedError('BAD_NEXT', '다음 행동자 계약이 ai/user가 아닙니다.');
      }

      const next = out.next;
      let decision;
      try {
        decision = await decideWithWatchdog(next, out.stateVersion);
      } catch (error) {
        if (error.code !== 'VERSION_MISMATCH') throw error;
        const synchronized = await runCli(['step']);
        log('version-resync', {
          staleDecisionId: next.decisionId,
          stateVersion: synchronized.stateVersion,
        });
        out = await publishEnvelope(synchronized, ['--view-only', ...waitFlags()]);
        continue;
      }
      const elapsedMs = Math.max(0, monotonicNow() - decision.startedAt);
      const publishStarted = monotonicNow();
      out = await publishEnvelope(decision.envelope, waitFlags());
      const publishMs = Math.max(0, monotonicNow() - publishStarted);
      appendMetric({
        playerId: next.toAct,
        decisionId: next.decisionId,
        runtime: playerAdapter.kind,
        outcome: decision.outcome,
        elapsedMs,
        modelMs: decision.modelMs,
        parseMs: decision.parseMs,
        stepMs: decision.stepMs,
        publishMs,
      });
    }
    return readLoopState();
  };

  return {
    bootstrap,
    resume,
    run,
    requestStop,
    get stopping() { return stopRequested; },
    get serverPid() { return serverPid; },
  };
}

async function main() {
  let loop = null;
  let caught = null;
  try {
    const args = parseGameLoopArgs(process.argv.slice(2));
    if (!args.resume && args.ai === undefined) throw codedError('USAGE', '--ai가 필요합니다.');
    const resolver = ({ need, canaryAbsPath }) => resolveRuntimes({
      need,
      canaryAbsPath,
      preferred: args.playerRuntime ?? null,
    });
    loop = createGameLoop({ gameDir: args.gameDir, resolver });
    let handlingSignal = false;
    process.once('SIGTERM', () => {
      if (handlingSignal) return;
      handlingSignal = true;
      loop.requestStop().finally(() => process.exit(0));
    });
    if (args.resume) await loop.resume();
    else await loop.bootstrap({
      ai: args.ai,
      stack: args.stack,
      levelEvery: args.levelEvery,
      blinds: args.blinds,
      force: args.force,
      practiceFocusFile: args.practiceFocusFile,
    });
    await loop.run();
  } catch (error) {
    caught = error;
    try {
      fs.writeSync(2, `${JSON.stringify({ ok: false, code: error.code ?? 'ERROR', message: error.message })}\n`);
    } catch { /* stderr unavailable */ }
  } finally {
    if (loop) await loop.requestStop();
  }
  process.exit(exitCodeFor(caught));
}

const isDirectRun = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
