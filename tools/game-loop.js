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
import { gameEpochOf } from '../publish-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_CLI = path.join(ROOT, 'engine/cli.js');
const PUBLISH_CLI = path.join(ROOT, 'tools/publish.js');
const SERVER_CLI = path.join(ROOT, 'server/server.js');
const LOOP_LOCK = 'loop.lock.d';
const FINAL_PHASES = new Set(['finalizing', 'review_generated', 'review_published']);
const DEFAULT_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? null;
const DEFAULT_WAIT_NETWORK_MARGIN_MS = 11_000;
const FATAL_RUNTIME_CODES = new Set([
  'CHILD_CLOSE_UNCONFIRMED',
  'CHILD_SIGNAL_FAILED',
  'CHILD_STOP_UNCONFIRMED',
  'CLOSE_UNSETTLED',
  'IDENTITY_UNAVAILABLE',
  'IDENTITY_UNVERIFIABLE',
  'IDENTITY_MISMATCH',
  'RUNTIME_CLOSED',
  'RUNTIME_DISPOSING',
  'SIGNAL_FAILED',
]);
const RESTORED_SESSION_REJECTION_CODES = new Set([
  'CLI_FAILED',
  'INVALID_SESSION',
  'NO_SESSION',
  'SESSION_EXPIRED',
  'SESSION_NOT_FOUND',
]);

function isFatalRuntimeFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return FATAL_RUNTIME_CODES.has(code)
    || code.includes('IDENTITY_')
    || code.includes('SIGNAL_')
    || code.endsWith('_CLOSE_UNCONFIRMED')
    || code.endsWith('_STOP_UNCONFIRMED');
}

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

const USER_ACTIONS = new Set(['fold', 'check', 'call', 'raise']);

function validatedUserAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !USER_ACTIONS.has(raw.action)) return null;
  if (raw.action === 'raise') {
    if (!Number.isSafeInteger(raw.amount) || raw.amount < 1) return null;
    return { action: 'raise', amount: raw.amount };
  }
  // 숫자라도 raise 외 action의 amount는 engine argv에 싣을 의미가 없다.
  // 예상 못 한 필드를 버리지 말고 요청 전체를 거부해 경계를 명확히 한다.
  if (raw.amount !== undefined) return null;
  return { action: raw.action };
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
  const waitMs = opts.waitMs ?? 60_000;
  const waitNetworkMarginMs = opts.waitNetworkMarginMs ?? DEFAULT_WAIT_NETWORK_MARGIN_MS;
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  const lsofPath = opts.lsofPath ?? DEFAULT_LSOF;
  const signalProcess = opts.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const forceStopMs = opts.forceStopMs ?? 5_000;
  const forceKillMs = opts.forceKillMs ?? 200;
  const loopStatePath = path.join(root, 'loop-state.json');
  const engineStatePath = path.join(root, 'state.json');
  const playersPath = path.join(root, 'players.json');
  const sessionsPath = path.join(root, '.player-sessions.json');
  const lockPath = path.join(root, 'lock.json');
  const canaries = new Set();
  const activeChildren = new Set();
  const adapters = new Set();
  const adapterDisposals = new Map();
  const archiveCheckedHands = new Set();
  const restoredPlayerSessions = new Set();

  let lockHandle = null;
  let serverChild = null;
  let serverPid = null;
  let serverIdentity = null;
  let serverAdopted = false;
  let serverStartupIdentityMissing = false;
  let logFd = null;
  let playerAdapter = null;
  let upperAdapter = null;
  let playerSessions = null;
  let resumeEntryPending = false;
  let stopRequested = false;
  let stopPromise = null;
  let atomicTransition = null;
  let resolverPromise = null;

  const assertNotStopping = () => {
    if (stopRequested) throw codedError('STOPPING', '정지 중에는 서버 복구·게시 재시도를 시작하지 않습니다.');
  };

  const d9Checkpoint = (name) => {
    opts.d9Checkpoint?.(name);
    assertNotStopping();
  };

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
  const parseServerLock = (raw) => {
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
  const openServerLockPin = () => {
    let fd;
    try {
      fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK을 열 수 없습니다.', { cause: error });
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) {
        throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK이 일반 단일-link 파일이 아닙니다.');
      }
      const raw = fs.readFileSync(fd, 'utf8');
      return { fd, stat, raw, lock: parseServerLock(raw) };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };
  const closeServerLockPin = (pin) => {
    if (!pin || pin.fd === null) return;
    fs.closeSync(pin.fd);
    pin.fd = null;
  };
  const assertPinnedServerLock = (pin) => {
    if (!pin) throw codedError('SERVER_LOCK_REPLACED', '고정한 server lock identity가 없습니다.');
    let stat;
    let raw;
    try {
      stat = fs.lstatSync(lockPath, { bigint: true });
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
      throw codedError('SERVER_LOCK_REPLACED', '검증 중 server lock이 사라졌습니다.', { cause: error });
    }
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.dev !== pin.stat.dev
      || stat.ino !== pin.stat.ino
      || raw !== pin.raw
    ) {
      throw codedError('SERVER_LOCK_REPLACED', '검증 중 server lock path identity 또는 bytes가 교체됐습니다.');
    }
    return parseServerLock(raw);
  };
  const retirePinnedServerLock = (pin) => {
    assertNotStopping();
    if (!pin || pin.fd === null) {
      throw codedError('SERVER_LOCK_REPLACED', 'retirement할 server lock descriptor가 없습니다.');
    }
    // pathname을 검증한 뒤 unlink하면 그 두 syscall 사이에 들어온 replacement를 지울 수
    // 있다. 먼저 예측 불가능한 같은-directory quarantine으로 원자 이동하고, 실제로
    // 이동된 inode/bytes가 descriptor와 같을 때만 그 quarantine을 지운다.
    const quarantinePath = path.join(root, `.lock.json.retired-${randomUUID()}`);
    try {
      fs.renameSync(lockPath, quarantinePath);
    } catch (error) {
      throw codedError('SERVER_LOCK_REPLACED', 'server lock retirement 원자 이동에 실패했습니다.', { cause: error });
    }

    let movedMatches = false;
    try {
      const moved = fs.lstatSync(quarantinePath, { bigint: true });
      const raw = fs.readFileSync(quarantinePath, 'utf8');
      movedMatches = moved.isFile()
        && !moved.isSymbolicLink()
        && moved.dev === pin.stat.dev
        && moved.ino === pin.stat.ino
        && raw === pin.raw;
    } catch {
      movedMatches = false;
    }

    if (!movedMatches) {
      // replacement가 이동됐다. rename은 destination을 조용히 덮어쓰므로 복구에 쓰지
      // 않는다. 같은-directory hard link는 EEXIST로 두 파일을 모두 보존하며, 성공 시
      // source/destination이 같은 inode임을 증명한 뒤에만 quarantine 이름을 제거한다.
      try {
        fs.linkSync(quarantinePath, lockPath);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw codedError('SERVER_LOCK_REPLACED', '새 server lock이 있어 quarantine replacement를 함께 보존합니다.', {
            cause: error,
            quarantinePath,
          });
        }
        throw codedError('SERVER_LOCK_REPLACED', 'quarantine replacement를 non-clobber 복구하지 못했습니다.', {
          cause: error,
          quarantinePath,
        });
      }

      let quarantineStat;
      let restoredStat;
      try {
        quarantineStat = fs.lstatSync(quarantinePath, { bigint: true });
        restoredStat = fs.lstatSync(lockPath, { bigint: true });
      } catch (error) {
        throw codedError('SERVER_LOCK_REPLACED', '복구된 replacement identity를 확인할 수 없어 두 경로를 보존합니다.', {
          cause: error,
          quarantinePath,
        });
      }
      if (
        quarantineStat.dev !== restoredStat.dev
        || quarantineStat.ino !== restoredStat.ino
      ) {
        throw codedError('SERVER_LOCK_REPLACED', '복구 경로가 quarantine replacement와 다른 inode라 둘 다 보존합니다.', {
          quarantinePath,
        });
      }
      try {
        fs.unlinkSync(quarantinePath);
      } catch (error) {
        throw codedError('SERVER_LOCK_REPLACED', '복구 성공 뒤 quarantine 이름을 제거하지 못해 두 경로를 보존합니다.', {
          cause: error,
          quarantinePath,
        });
      }
      throw codedError('SERVER_LOCK_REPLACED', 'retirement 직전 server lock inode 또는 bytes가 교체됐습니다.');
    }

    fs.unlinkSync(quarantinePath);
    const pinned = fs.fstatSync(pin.fd, { bigint: true });
    if (pinned.nlink !== 0n) {
      throw codedError('SERVER_LOCK_REPLACED', '고정한 server lock inode retirement를 확인하지 못했습니다.');
    }
  };
  const readServerLock = () => {
    const pin = openServerLockPin();
    if (!pin) return null;
    try {
      return pin.lock;
    } finally {
      closeServerLockPin(pin);
    }
  };
  const writeLoopState = (patch) => {
    const current = readLoopState() ?? {};
    const next = { ...current, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
    }
    writeJsonAtomic(loopStatePath, next);
    return next;
  };

  const releaseLock = () => {
    if (!lockHandle) return;
    releaseOwnedLock(lockHandle);
    lockHandle = null;
  };

  const acquireLoopLock = async ({ mode, force = false }) => {
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
          await stopExistingLoopForForce(owner);
          lockHandle = acquireOwnedLock(root, LOOP_LOCK);
          return;
        }
        throw codedError('ACTIVE_GAME', '이미 진행 중인 게임이 있습니다.');
      }
      throw codedError('LOCKED', '다른 loop가 resume을 소유하고 있습니다.');
    }
  };

  const timeoutForChild = (args) => {
    const waits = args.includes('--wait') || args.includes('--wait-only');
    if (!waits) return childTimeoutMs;
    const index = args.lastIndexOf('--wait-ms');
    const declared = index === -1 ? waitMs : Number(args[index + 1]);
    const boundedWait = Number.isFinite(declared) && declared >= 0 ? declared : waitMs;
    // publish.js의 network abort margin(10s)보다 바깥 supervisor가 더 길어야
    // wait child가 자신의 truthful timeout envelope를 쓸 기회를 갖는다.
    return Math.max(childTimeoutMs, boundedWait + waitNetworkMarginMs);
  };

  const runJsonChild = (script, args) => new Promise((resolve, reject) => {
    const argv = [script, ...args, '--game-dir', root];
    const child = execFile(process.execPath, argv, {
      encoding: 'utf8',
      timeout: timeoutForChild(args),
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
  const runPublish = (args) => {
    opts.onPublishInvoke?.([...args]);
    return runJsonChild(PUBLISH_CLI, args);
  };

  const serverHealthy = async (port, { stopAware = false } = {}) => {
    if (!Number.isInteger(port) || port < 1) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
      if (stopAware) assertNotStopping();
      const body = await response.json();
      if (stopAware) assertNotStopping();
      return response.ok && body.ok === true;
    } catch (error) {
      if (error.code === 'STOPPING') throw error;
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

  const assertAuthenticatedServer = async (port, sessionToken, { stopAware = false } = {}) => {
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
      if (stopAware) assertNotStopping();
      if (denied.response.status !== 401 || denied.body?.code !== 'UNAUTHORIZED') {
        throw codedError('SERVER_AUTH_FAILED', '서버가 fresh wrong-token challenge를 거부하지 않았습니다.');
      }
      const { response, body: snapshot } = await requestSnapshot(sessionToken);
      if (stopAware) assertNotStopping();
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
      if (error.code === 'STOPPING') throw error;
      if (error.code === 'SERVER_AUTH_FAILED') throw error;
      throw codedError('SERVER_AUTH_UNAVAILABLE', '서버 token 인증 probe를 완료할 수 없습니다.', { cause: error });
    }
  };

  const assertServerBinding = async ({ serverPid: pid, port, sessionToken }, { stopAware = false } = {}) => {
    let ownsListener;
    try {
      ownsListener = await listenerOwnedBy(pid, port);
      if (stopAware) assertNotStopping();
    } catch (error) {
      throw error;
    }
    if (!ownsListener) {
      throw codedError('SERVER_LISTENER_MISMATCH', 'lock.serverPid가 lock.port listener를 소유하지 않습니다.');
    }
    await assertAuthenticatedServer(port, sessionToken, { stopAware });
    if (stopAware) assertNotStopping();
  };

  const identityStillAlive = (pid, startTime) => {
    if (!processAlive(pid)) return false;
    const current = processStartTime(pid);
    if (current === null) {
      throw codedError('IDENTITY_UNAVAILABLE', `pid ${pid} startTime을 재검증할 수 없습니다.`);
    }
    return current === startTime;
  };

  const sendSignal = (pid, signal, code) => {
    try {
      signalProcess(pid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw codedError(code, `pid ${pid}에 ${signal} 전송을 완료하지 못했습니다.`, { cause: error });
    }
  };

  const waitForIdentityDeath = async (pid, startTime, timeoutMs, {
    unavailableCode,
    mismatchCode,
    label,
  }) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!processAlive(pid)) return true;
      const current = processStartTime(pid);
      if (current === null) {
        // 종료 직후 kill(0)은 아직 성공하지만 ps identity가 먼저 사라지는
        // 짧은 전이 창이 있다. unknown을 사망으로 승격하지 않고 deadline까지 재확인한다.
        await sleep(pollMs);
        continue;
      }
      if (current !== startTime) {
        // pid 재사용은 원래 대상의 사망 증거가 아니다. 새 프로세스를
        // 살려 둔 채 아카이브나 추가 시그널로 진행하지 않는다.
        throw codedError(mismatchCode, `${label} pid가 다른 프로세스로 재사용됐습니다.`);
      }
      await sleep(pollMs);
    }
    if (!processAlive(pid)) return true;
    const current = processStartTime(pid);
    if (current === null) {
      throw codedError(unavailableCode, `${label} pid identity를 재검증할 수 없습니다.`);
    }
    if (current !== startTime) {
      throw codedError(mismatchCode, `${label} pid가 다른 프로세스로 재사용됐습니다.`);
    }
    return false;
  };

  const assertSameLoopOwner = (expected) => {
    const current = readOwnedLock(root, LOOP_LOCK);
    if (
      current?.status !== 'alive'
      || current.pid !== expected.pid
      || current.startTime !== expected.startTime
    ) {
      throw codedError('LOOP_IDENTITY_CHANGED', '정지 대상 loop identity가 바뀌어 시그널을 보내지 않습니다.');
    }
    return current;
  };

  const stopExistingLoopForForce = async (owner) => {
    const expected = { pid: owner.pid, startTime: owner.startTime };
    const signalLoopOwner = (signal) => {
      assertSameLoopOwner(expected);
      // lock 동일성 검사 직후 startTime을 한 번 더 맞춘 뒤 동기적으로 시그널한다.
      if (!identityStillAlive(expected.pid, expected.startTime)) {
        throw codedError('LOOP_IDENTITY_MISMATCH', '정지 대상 loop pid identity가 바뀌었습니다.');
      }
      return sendSignal(expected.pid, signal, 'LOOP_SIGNAL_FAILED');
    };
    signalLoopOwner('SIGTERM');
    if (await waitForIdentityDeath(expected.pid, expected.startTime, forceStopMs, {
      unavailableCode: 'LOOP_IDENTITY_UNAVAILABLE',
      mismatchCode: 'LOOP_IDENTITY_MISMATCH',
      label: 'loop',
    })) return;
    // KILL 직전에도 lock pid+startTime이 같은 소유자를 가리킬 때만 신호한다.
    signalLoopOwner('SIGKILL');
    if (!await waitForIdentityDeath(expected.pid, expected.startTime, forceKillMs, {
      unavailableCode: 'LOOP_IDENTITY_UNAVAILABLE',
      mismatchCode: 'LOOP_IDENTITY_MISMATCH',
      label: 'loop',
    })) {
      throw codedError('LOOP_ALIVE', '기존 게임 루프 종료를 확인하지 못해 아카이브하지 않습니다.');
    }
  };

  const assertSameForceServer = async (expected) => {
    const current = readServerLock();
    if (
      current?.serverPid !== expected.serverPid
      || current.port !== expected.port
      || current.sessionToken !== expected.sessionToken
    ) {
      throw codedError('SERVER_IDENTITY_CHANGED', '정지 대상 server lock이 바뀌어 시그널을 보내지 않습니다.');
    }
    if (!identityStillAlive(expected.serverPid, expected.startTime)) {
      throw codedError('SERVER_IDENTITY_MISMATCH', '정지 대상 server pid가 재사용되어 시그널을 보내지 않습니다.');
    }
    await assertServerBinding(current);
  };

  const signalSameForceServer = (expected, signal) => {
    const current = readServerLock();
    if (
      current?.serverPid !== expected.serverPid
      || current.port !== expected.port
      || current.sessionToken !== expected.sessionToken
    ) {
      throw codedError('SERVER_IDENTITY_CHANGED', '시그널 직전 server lock이 바뀌었습니다.');
    }
    // listener/token 검증은 await를 포함하므로, 그 뒤 신호 직전에
    // pid+startTime을 다시 맞춰 async 간격에서의 pid 재사용을 차단한다.
    if (!identityStillAlive(expected.serverPid, expected.startTime)) {
      throw codedError('SERVER_IDENTITY_MISMATCH', '정지 대상 server pid가 재사용됐습니다.');
    }
    return sendSignal(expected.serverPid, signal, 'SERVER_SIGNAL_FAILED');
  };

  const removeStoppedForceServerLock = (expected, pin) => {
    const current = assertPinnedServerLock(pin);
    if (
      current.serverPid !== expected.serverPid
      || current.port !== expected.port
      || current.sessionToken !== expected.sessionToken
    ) {
      throw codedError('SERVER_IDENTITY_CHANGED', '종료 확인 후 server lock이 바뀌었습니다.');
    }
    if (processAlive(current.serverPid)) {
      if (expected.startTime !== undefined) {
        const currentStart = processStartTime(current.serverPid);
        if (currentStart === null) {
          throw codedError('SERVER_IDENTITY_UNAVAILABLE', '종료 후 server pid identity를 확인할 수 없습니다.');
        }
        if (currentStart !== expected.startTime) {
          throw codedError('SERVER_IDENTITY_MISMATCH', '종료 후 server pid가 재사용되어 lock을 제거하지 않습니다.');
        }
      }
      throw codedError('SERVER_ALIVE', '기존 게임 서버가 살아 있어 lock을 제거하지 않습니다.');
    }
    retirePinnedServerLock(pin);
  };

  const stopRereadServerForForce = async () => {
    // Loop 사망 확인 뒤 lock.json을 새로 읽는다. loop가 종료 직전 교체한 서버가
    // 있더라도, force 시작 전에 보았던 낡은 pid가 아니라 이 identity만 대상이다.
    const pin = openServerLockPin();
    if (!pin) return;
    try {
      const lock = pin.lock;
      if (!processAlive(lock.serverPid)) {
        // 시그널 대상이 없는 stale lock도 처음 고정한 descriptor 자체만 retire한다.
        removeStoppedForceServerLock(lock, pin);
        return;
      }
      const startTime = processStartTime(lock.serverPid);
      if (startTime === null) {
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', 'force server startTime을 확인할 수 없습니다.');
      }
      const expected = { ...lock, startTime };
      await assertSameForceServer(expected);
      signalSameForceServer(expected, 'SIGTERM');
      if (await waitForIdentityDeath(expected.serverPid, expected.startTime, forceStopMs, {
        unavailableCode: 'SERVER_IDENTITY_UNAVAILABLE',
        mismatchCode: 'SERVER_IDENTITY_MISMATCH',
        label: 'server',
      })) {
        removeStoppedForceServerLock(expected, pin);
        return;
      }
      await assertSameForceServer(expected);
      signalSameForceServer(expected, 'SIGKILL');
      if (!await waitForIdentityDeath(expected.serverPid, expected.startTime, forceKillMs, {
        unavailableCode: 'SERVER_IDENTITY_UNAVAILABLE',
        mismatchCode: 'SERVER_IDENTITY_MISMATCH',
        label: 'server',
      })) {
        throw codedError('SERVER_ALIVE', '기존 게임 서버 종료를 확인하지 못해 아카이브하지 않습니다.');
      }
      removeStoppedForceServerLock(expected, pin);
    } finally {
      closeServerLockPin(pin);
    }
  };

  const ensureServer = async (sessionToken, {
    port: desiredPort = requestedPort,
    pin: providedPin = null,
    stopAware = true,
    recovery = false,
  } = {}) => {
    if (stopAware) assertNotStopping();
    if (!Number.isSafeInteger(desiredPort) || desiredPort < 0 || desiredPort > 65_535) {
      throw codedError('BAD_SERVER_PORT', `서버 재기동 port가 올바르지 않습니다: ${desiredPort}`);
    }
    const ownsPin = providedPin === null;
    let pin = providedPin ?? openServerLockPin();
    try {
      const existing = pin?.lock ?? null;
      if (existing) {
        if (existing.sessionToken !== sessionToken) {
          throw codedError('SERVER_LOCK_MISMATCH', '기존 server lock의 sessionToken이 현재 게임과 다릅니다.');
        }
        if (processAlive(existing.serverPid)) {
          const startTime = processStartTime(existing.serverPid);
          if (startTime === null) {
            throw codedError('SERVER_IDENTITY_UNAVAILABLE', '재사용 서버 startTime을 확인할 수 없습니다.');
          }
          await assertServerBinding(existing, { stopAware });
          if (stopAware) assertNotStopping();
          const confirmed = assertPinnedServerLock(pin);
          if (
            confirmed.serverPid !== existing.serverPid
            || confirmed.port !== existing.port
            || confirmed.sessionToken !== sessionToken
            || processStartTime(existing.serverPid) !== startTime
          ) {
            throw codedError('SERVER_IDENTITY_CHANGED', '재사용 서버 identity가 adoption 중 바뀌었습니다.');
          }
          await assertServerBinding(confirmed, { stopAware });
          if (stopAware) assertNotStopping();
          if (processStartTime(existing.serverPid) !== startTime) {
            throw codedError('SERVER_IDENTITY_CHANGED', '재사용 서버 identity가 binding 재검증 뒤 바뀌었습니다.');
          }
          serverChild = serverChild?.pid === existing.serverPid ? serverChild : null;
          serverPid = existing.serverPid;
          serverIdentity = { pid: existing.serverPid, startTime };
          serverAdopted = serverChild === null;
          serverStartupIdentityMissing = false;
          return existing.port;
        }

        const confirmed = assertPinnedServerLock(pin);
        if (processAlive(confirmed.serverPid)) {
          throw codedError('SERVER_IDENTITY_CHANGED', '죽은 server pid가 확인 중 다시 살아났습니다.');
        }
        if (stopAware) assertNotStopping();
        retirePinnedServerLock(pin);
      }

      if (recovery) d9Checkpoint('before-spawn');
      else if (stopAware) assertNotStopping();
      const argv = [
        SERVER_CLI,
        '--game-dir', root,
        '--port', String(desiredPort),
        '--token', sessionToken,
      ];
      const child = spawn(process.execPath, argv, {
        cwd: ROOT,
        stdio: 'ignore',
      });
      serverChild = child;
      serverPid = child.pid ?? null;
      serverAdopted = false;
      serverStartupIdentityMissing = false;
      serverIdentity = null;
      let spawnError = null;
      child.once('error', (error) => { spawnError = error; });
      const spawnedStartTime = serverPid === null ? null : processStartTime(serverPid);
      if (spawnedStartTime === null) {
        // spawn handle은 이미 우리 소유다. identity를 세울 수 없는 자식은 첫 await 전에
        // 즉시 KILL+exit 확인한다. 확인 실패면 handle을 유지해 bootstrap catch의
        // requestStop이 같은 직접 자식을 다시 종료하고 확인하게 한다.
        serverStartupIdentityMissing = true;
        await terminateUnidentifiedDirectServerChild(500);
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', '새 server child startTime을 spawn 직후 확인할 수 없습니다.');
      }
      serverIdentity = { pid: serverPid, startTime: spawnedStartTime };
      log('server-spawn', { pid: serverPid, requestedPort: desiredPort });

      const deadline = Date.now() + serverStartMs;
      while (Date.now() < deadline) {
        if (stopAware) assertNotStopping();
        if (spawnError) throw codedError('SERVER_START_FAILED', spawnError.message, { cause: spawnError });
        if (child.exitCode !== null || child.signalCode !== null) {
          throw codedError('SERVER_START_FAILED', `서버 자식이 조기 종료했습니다: ${child.exitCode ?? child.signalCode}`);
        }
        const lock = readServerLock();
        if (
          lock?.serverPid === child.pid
          && lock.sessionToken === sessionToken
          && await serverHealthy(lock.port, { stopAware })
        ) {
          if (stopAware) assertNotStopping();
          serverPid = lock.serverPid;
          const startTime = processStartTime(lock.serverPid);
          if (startTime === null) {
            throw codedError('SERVER_IDENTITY_UNAVAILABLE', '새 server child startTime을 확인할 수 없습니다.');
          }
          if (
            serverIdentity?.pid !== lock.serverPid
            || serverIdentity.startTime !== startTime
          ) {
            throw codedError('SERVER_IDENTITY_CHANGED', '새 server child identity가 startup 중 바뀌었습니다.');
          }
          return lock.port;
        }
        await sleep(pollMs);
        if (stopAware) assertNotStopping();
      }
      throw codedError('SERVER_START_TIMEOUT', '서버 health 확인 시간이 초과됐습니다.');
    } finally {
      if (ownsPin) closeServerLockPin(pin);
    }
  };

  const startAdapterDisposal = (adapter) => {
    if (!adapter || adapterDisposals.has(adapter)) return adapterDisposals.get(adapter) ?? Promise.resolve();
    let disposal;
    try {
      // createPlayerRuntime.dispose()는 호출 동기 구간에서 runtime을 영구 closed로 만든다.
      // stop 중 새로 등록된 adapter가 다음 probe child를 만들기 전에 이 호출을 시작한다.
      disposal = typeof adapter.dispose === 'function'
        ? Promise.resolve(adapter.dispose())
        : Promise.resolve();
    } catch (error) {
      disposal = Promise.reject(error);
    }
    disposal.catch(() => {});
    adapterDisposals.set(adapter, disposal);
    return disposal;
  };

  const registerAdapter = (adapter) => {
    if (!adapter) return;
    adapters.add(adapter);
    if (stopRequested) startAdapterDisposal(adapter);
  };

  const createCanaryAndResolve = async (need) => {
    if (resolverPromise) throw codedError('RESOLVER_OVERLAP', 'runtime resolver 호출이 중첩됐습니다.');
    const canaryAbsPath = path.join(root, `.runtime-canary-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(canaryAbsPath, `SIDECAR_CANARY_${randomBytes(24).toString('hex')}`);
    canaries.add(canaryAbsPath);
    const invocation = Promise.resolve().then(() => resolver({
      need,
      canaryAbsPath,
      registerAdapter,
    }));
    resolverPromise = invocation;
    try {
      const resolved = await invocation;
      assertNotStopping();
      return resolved;
    } finally {
      if (resolverPromise === invocation) resolverPromise = null;
      try { fs.unlinkSync(canaryAbsPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      canaries.delete(canaryAbsPath);
    }
  };

  const selectAdapters = (resolved) => {
    playerAdapter = resolved.player ?? null;
    upperAdapter = resolved.upper ?? null;
    registerAdapter(playerAdapter);
    registerAdapter(upperAdapter);
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

  const createPlayerSession = async (persona, createdAt) => {
    const prompt = buildPlayerPrompt({ persona });
    const result = await playerAdapter.warmup({ playerId: persona.playerId, prompt });
    if (!result || typeof result.sessionId !== 'string' || result.sessionId === '') {
      throw codedError('NO_SESSION', `플레이어 ${persona.playerId} 세션이 없습니다.`);
    }
    return {
      runtime: playerAdapter.kind,
      sessionId: result.sessionId,
      createdAt,
    };
  };

  const preparePlayerSessions = async ({ reuseExisting = false } = {}) => {
    if (!playerAdapter) throw codedError('NO_PLAYER_RUNTIME', '적격 플레이어 런타임이 없습니다.');
    const players = readJsonOptional(playersPath, 'PLAYERS');
    if (!Array.isArray(players)) throw codedError('BAD_PLAYERS', 'players.json이 배열이 아닙니다.');
    const aiPlayers = players.filter((player) => player.playerId !== 'user');
    const createdAt = readLoopState()?.startedAt ?? isoNow(now);
    let existing = {};
    if (reuseExisting) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
      } catch {
        // 파일 전체가 없거나 손상돼도 게임 identity와는 독립이다. 해당 entry들을 아래에서
        // 페르소나 카드로 다시 만들고 repaired map을 원자 기록한다.
        existing = {};
      }
    }
    restoredPlayerSessions.clear();
    const settled = await Promise.allSettled(aiPlayers.map(async (persona) => {
      const prior = existing[persona.playerId];
      if (
        reuseExisting
        && prior
        && typeof prior === 'object'
        && !Array.isArray(prior)
        && prior.runtime === playerAdapter.kind
        && typeof prior.sessionId === 'string'
        && prior.sessionId !== ''
        && typeof prior.createdAt === 'string'
        && prior.createdAt !== ''
      ) {
        restoredPlayerSessions.add(persona.playerId);
        return [persona.playerId, {
          runtime: prior.runtime,
          sessionId: prior.sessionId,
          createdAt: prior.createdAt,
        }];
      }
      restoredPlayerSessions.delete(persona.playerId);
      return [persona.playerId, await createPlayerSession(persona, createdAt)];
    }));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const rows = settled.map((result) => result.value);
    const sessions = Object.fromEntries(rows);
    writeJsonAtomic(sessionsPath, sessions);
    playerSessions = sessions;
    return sessions;
  };
  const warmPlayers = () => preparePlayerSessions({ reuseExisting: false });
  const restorePlayers = () => preparePlayerSessions({ reuseExisting: true });

  const repairRestoredPlayerSession = async (playerId) => {
    if (!restoredPlayerSessions.has(playerId)) return null;
    // consume-before-await prevents a rejected warmup or fresh-session call from recursively
    // recreating the same player. A later process resume may try the still-persisted old entry.
    restoredPlayerSessions.delete(playerId);
    const players = readJsonOptional(playersPath, 'PLAYERS');
    const persona = Array.isArray(players)
      ? players.find((player) => player?.playerId === playerId && playerId !== 'user')
      : null;
    if (!persona) throw codedError('BAD_PLAYERS', `복구할 플레이어 ${playerId} 페르소나가 없습니다.`);
    const repaired = await createPlayerSession(persona, isoNow(now));
    playerSessions = { ...(playerSessions ?? {}), [playerId]: repaired };
    writeJsonAtomic(sessionsPath, playerSessions);
    log('player-session-recreated', { playerId, runtime: repaired.runtime });
    return repaired;
  };

  const clearDirectServerOwnership = () => {
    serverChild = null;
    serverIdentity = null;
    serverPid = null;
    serverAdopted = false;
    serverStartupIdentityMissing = false;
  };

  const terminateUnidentifiedDirectServerChild = async (timeoutMs = 500) => {
    const child = serverChild;
    if (!child) return true;
    if (child.exitCode !== null || child.signalCode !== null) {
      clearDirectServerOwnership();
      return true;
    }
    try { child.kill('SIGKILL'); } catch { /* exit confirmation below remains authoritative */ }
    if (await waitForChildExit(child, timeoutMs)) {
      clearDirectServerOwnership();
      return true;
    }
    return false;
  };

  const stopDirectServerChild = async () => {
    const child = serverChild;
    if (!child) return;
    if (serverStartupIdentityMissing) {
      if (!await terminateUnidentifiedDirectServerChild(500)) {
        throw codedError('SERVER_STOP_UNCONFIRMED', 'identity 미확인 startup server child 종료를 확인하지 못했습니다.');
      }
      return;
    }
    const signalDirectChild = (signal) => {
      if (child.exitCode !== null || child.signalCode !== null || !processAlive(child.pid)) return false;
      const identity = serverIdentity;
      if (!identity || identity.pid !== child.pid) {
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', '직접 server child의 시작 identity가 없습니다.');
      }
      const current = processStartTime(child.pid);
      if (current === null) {
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', '직접 server child startTime을 시그널 직전 확인할 수 없습니다.');
      }
      if (current !== identity.startTime) {
        throw codedError('SERVER_IDENTITY_MISMATCH', '직접 server child pid가 다른 프로세스로 재사용됐습니다.');
      }
      const delivered = child.kill(signal);
      if (delivered === false && child.exitCode === null && child.signalCode === null && processAlive(child.pid)) {
        throw codedError('SERVER_SIGNAL_FAILED', `직접 server child에 ${signal}을 전달하지 못했습니다.`);
      }
      return delivered;
    };
    if (child.exitCode === null && child.signalCode === null) {
      let exited = false;
      const exit = new Promise((resolve) => child.once('exit', () => {
        exited = true;
        resolve();
      }));
      signalDirectChild('SIGTERM');
      await Promise.race([exit, sleep(1_000)]);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        signalDirectChild('SIGKILL');
        await Promise.race([exit, sleep(1_000)]);
      }
      if (!exited && child.exitCode === null && child.signalCode === null) {
        throw codedError('SERVER_STOP_UNCONFIRMED', '직접 server child 종료를 확인하지 못했습니다.');
      }
    }
    clearDirectServerOwnership();
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

  const beginAtomicTransition = () => {
    if (stopRequested) throw codedError('STOPPING', '정지 요청 뒤에는 새 step을 시작하지 않습니다.');
    if (atomicTransition) throw codedError('TRANSITION_OVERLAP', 'step+publish 원자 단위가 중첩됐습니다.');
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const unit = {
      promise,
      finish() {
        if (atomicTransition === unit) atomicTransition = null;
        settle();
      },
    };
    atomicTransition = unit;
    return unit;
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
    let session = playerSessions?.[next.toAct];
    if (!session || typeof session.sessionId !== 'string' || session.sessionId === '') {
      throw codedError('NO_SESSION', `플레이어 ${next.toAct} 세션이 없습니다.`);
    }
    const watchdog = currentWatchdog();
    const timeouts = [watchdog.t1Ms, watchdog.t2Ms];
    const startedAt = monotonicNow();
    let modelMs = 0;
    let parseMs = 0;
    let stepMs = 0;
    let sessionRepaired = false;
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
      const atomicUnit = beginAtomicTransition();
      try {
        const envelope = await runCli(stepArgs);
        return { envelope, atomicUnit };
      } catch (error) {
        atomicUnit.finish();
        throw error;
      } finally {
        stepMs += Math.max(0, monotonicNow() - stepStarted);
      }
    };
    for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
      let round = await decideOnce({
        playerId: next.toAct,
        sessionId: session.sessionId,
        message: next.message,
      }, timeouts[attempt]);
      modelMs += round.modelMs;
      if (
        !round.ok
        && !isFatalRuntimeFailure(round.error)
        && RESTORED_SESSION_REJECTION_CODES.has(round.error?.code)
        && restoredPlayerSessions.has(next.toAct)
      ) {
        const repaired = await repairRestoredPlayerSession(next.toAct);
        if (repaired) {
          session = repaired;
          sessionRepaired = true;
          round = await decideOnce({
            playerId: next.toAct,
            sessionId: session.sessionId,
            message: next.message,
          }, timeouts[attempt]);
          modelMs += round.modelMs;
        }
      } else if (round.ok) {
        // A successful call proves the restored remote session is usable; later transient
        // failures must follow the ordinary watchdog rather than trigger recreation.
        restoredPlayerSessions.delete(next.toAct);
      }
      if (!round.ok) {
        if (isFatalRuntimeFailure(round.error)) throw round.error;
        continue;
      }
      const parseStarted = monotonicNow();
      const action = validatedDecision(round.raw, next);
      parseMs += Math.max(0, monotonicNow() - parseStarted);
      if (action) {
        let applied;
        try {
          applied = await applyDecision(action);
        } catch (error) {
          if (error.code === 'ILLEGAL_ACTION') continue;
          throw error;
        }
        return {
          envelope: applied.envelope,
          atomicUnit: applied.atomicUnit,
          outcome: attempt === 0 && !sessionRepaired ? 'accepted' : 'retried_accepted',
          sessionRepaired,
          startedAt,
          modelMs,
          parseMs,
          stepMs,
        };
      }
    }
    const applied = await applyDecision(null);
    return {
      envelope: applied.envelope,
      atomicUnit: applied.atomicUnit,
      outcome: 'forced_default',
      sessionRepaired,
      startedAt,
      modelMs,
      parseMs,
      stepMs,
    };
  };

  const recoverServerForPublish = async () => {
    assertNotStopping();
    const state = readLoopState();
    const sessionToken = state?.sessionToken;
    if (typeof sessionToken !== 'string' || sessionToken === '') {
      throw codedError('NO_GAME', '게시 복구에 필요한 sessionToken이 없습니다.');
    }
    const pin = openServerLockPin();
    const expected = pin?.lock ?? null;
    const actualPort = expected?.port
      ?? (Number.isSafeInteger(state?.port) && state.port > 0 ? state.port : requestedPort);
    try {
      if (expected) {
        if (expected.sessionToken !== sessionToken) {
          throw codedError('SERVER_LOCK_MISMATCH', '게시 복구 server lock의 sessionToken이 현재 게임과 다릅니다.');
        }
        const healthy = await serverHealthy(expected.port, { stopAware: true });
        d9Checkpoint('after-health');
        if (healthy) {
          // health만으로는 신뢰하지 않는다. adoption과 동일하게 listener,
          // wrong-token/real-token, startTime, pinned lock을 두 번 맞춘 서버만 재사용한다.
          const port = await ensureServer(sessionToken, {
            port: actualPort,
            pin,
            stopAware: true,
            recovery: true,
          });
          d9Checkpoint('after-verified-reuse');
          writeLoopState({ port });
          log('server-recovery-verified', { port, serverPid });
          return port;
        }

        if (processAlive(expected.serverPid)) {
          if (expected.serverPid !== serverPid) {
            throw codedError('SERVER_IDENTITY_CHANGED', '게시 복구 중 검증하지 못한 server lock 소유자가 살아 있습니다.');
          }
          assertPinnedServerLock(pin);
          await stopServer();
          d9Checkpoint('after-stop-server');
        } else if (serverChild?.pid === expected.serverPid) {
          serverChild = null;
          serverIdentity = null;
          serverPid = null;
          serverAdopted = false;
          serverStartupIdentityMissing = false;
        }

        const confirmed = assertPinnedServerLock(pin);
        if (processAlive(confirmed.serverPid)) {
          throw codedError('SERVER_STOP_UNCONFIRMED', '기존 서버가 살아 있어 lock을 지울 수 없습니다.');
        }
        d9Checkpoint('before-retire');
        retirePinnedServerLock(pin);
      }

      d9Checkpoint('before-ensure-server');
      const port = await ensureServer(sessionToken, {
        port: actualPort,
        stopAware: true,
        recovery: true,
      });
      d9Checkpoint('after-ensure-server');
      writeLoopState({ port });
      log('server-recovered', { port, serverPid });
      return port;
    } finally {
      closeServerLockPin(pin);
    }
  };

  const executePublish = async (args) => {
    try {
      return await runPublish(args);
    } catch (error) {
      if (error.code !== 'PUBLISH_FAILED' && error.code !== 'PUBLISH_REJECTED') throw error;
      await recoverServerForPublish();
      d9Checkpoint('before-retry');
      const retryArgs = args.includes('--retry') ? args : [...args, '--retry'];
      return runPublish(retryArgs);
    }
  };

  const turnPath = path.join(root, '.turn.json');
  const publishEnvelope = async (envelope, flags = []) => {
    writeJsonAtomic(turnPath, envelope);
    let currentArgs = ['--from', turnPath, ...flags];
    let args = currentArgs;
    let resolvingPending = false;
    const recovered = new Set();
    let out;
    for (;;) {
      try {
        // A retry with a still-present record publishes the old exact body; once that
        // succeeds the current transition must still publish. If the record vanished
        // before invocation, --retry publishes the current turn itself and is terminal.
        const resolvingRecordedBody = resolvingPending
          && fs.existsSync(path.join(root, '.publish-attempt.json'));
        out = await executePublish(args);
        if (resolvingPending && resolvingRecordedBody) {
          resolvingPending = false;
          args = currentArgs;
          continue;
        }
        break;
      } catch (error) {
        const code = error.code;
        if (recovered.has(code)) throw error;
        if (code === 'ATTEMPT_PENDING') {
          recovered.add(code);
          assertNotStopping();
          await opts.attemptPendingCheckpoint?.();
          assertNotStopping();
          resolvingPending = true;
          args = ['--from', turnPath, '--retry'];
          continue;
        }
        if (code === 'BAD_ATTEMPT' || code === 'BAD_ATTEMPT_VERSION') {
          recovered.add(code);
          assertNotStopping();
          const pendingPath = path.join(root, '.publish-attempt.json');
          try { fs.unlinkSync(pendingPath); } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          }
          assertNotStopping();
          const synchronized = await runCli(['step']);
          assertNotStopping();
          writeJsonAtomic(turnPath, synchronized);
          const recoveryFlags = flags.filter((flag) => flag !== '--retry' && flag !== '--view-only');
          currentArgs = ['--from', turnPath, '--view-only', ...recoveryFlags];
          args = currentArgs;
          resolvingPending = false;
          log('publish-recovery', { code, mode: 'view-only-resync' });
          continue;
        }
        if (code === 'BAD_SNAPSHOT') {
          recovered.add(code);
          await recoverServerForPublish();
          assertNotStopping();
          const snapshotPath = path.join(root, 'ui-snapshot.json');
          try { fs.unlinkSync(snapshotPath); } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          }
          assertNotStopping();
          log('publish-recovery', { code, mode: 'snapshot-rebuild' });
          continue;
        }
        if (code === 'LOCK_TIMEOUT') {
          recovered.add(code);
          assertNotStopping();
          log('publish-recovery', { code, mode: 'retry-once' });
          continue;
        }
        if (code === 'NO_LOCK') {
          recovered.add(code);
          await recoverServerForPublish();
          assertNotStopping();
          log('publish-recovery', { code, mode: 'server-lock-rebuild' });
          continue;
        }
        throw error;
      }
    }
    const patch = {};
    if (Number.isInteger(out.publishId)) patch.lastPublishId = out.publishId;
    if (Number.isInteger(out.handNo)) patch.handNo = out.handNo;
    if (Object.keys(patch).length) writeLoopState(patch);
    return out;
  };

  const runAtomicStepPublish = async (stepArgs, publishFlags = []) => {
    const atomicUnit = beginAtomicTransition();
    try {
      const envelope = await runCli(stepArgs);
      const flags = typeof publishFlags === 'function' ? publishFlags(envelope) : publishFlags;
      return await publishEnvelope(envelope, flags);
    } finally {
      atomicUnit.finish();
    }
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

  const waitOnlyForUser = () => executePublish([
    '--from', turnPath,
    '--wait-only', '--wait-ms', String(waitMs),
  ]);

  const republishAfterRejectedUserAction = async (code) => {
    const synchronized = await runCli(['step']);
    const narration = code === 'VERSION_MISMATCH'
      ? '게임 상태가 변경되어 최신 결정으로 다시 기다립니다.'
      : '입력한 액션이 허용되지 않아 같은 결정을 다시 기다립니다.';
    // First emit the contract's view-only+narration republish. The relay retains a
    // possibly response-lost action for view-only publishes, so an authoritative
    // empty-event publish follows to acknowledge this positively rejected action
    // before entering the next wait; otherwise the rejected action is replayed forever.
    await publishEnvelope(synchronized, ['--view-only', '--narration', narration]);
    log('user-action-rejected', { code, decisionId: synchronized.next?.decisionId ?? null });
    return publishEnvelope(synchronized, waitFlags());
  };

  const handleUserTurn = async (out) => {
    const next = out.next;
    if (out.waitError) {
      log('user-wait-error', { decisionId: next.decisionId, message: out.waitError });
      if (stopRequested) return null;
      // health만 맞는 foreign listener에 view-only state를 게시하지 않는다. D9와 같은
      // pid↔port↔token↔startTime↔pinned-lock 전체 증명을 통과한 server만 재사용한다.
      await recoverServerForPublish();
      assertNotStopping();
      const synchronized = await runCli(['step']);
      assertNotStopping();
      await publishEnvelope(synchronized, ['--view-only']);
      assertNotStopping();
      log('user-view-republished', { decisionId: synchronized.next?.decisionId ?? null });
      return waitOnlyForUser();
    }

    const submitted = out.userAction;
    if (!submitted || submitted.timeout) {
      log('user-wait-timeout', { decisionId: next.decisionId });
      return waitOnlyForUser();
    }
    if (submitted.decisionId !== next.decisionId) {
      log('user-stale-decision', {
        expectedDecisionId: next.decisionId,
        receivedDecisionId: submitted.decisionId ?? null,
      });
      return waitOnlyForUser();
    }

    // Relay payload는 외부 입력이다. action/amount를 semantic argv로 검증한 뒤에만
    // engine 인자를 만든다. 특히 `--force-default`가 user 경로에서 flag가 될 수 없다.
    const action = validatedUserAction(submitted);
    if (!action) {
      if (stopRequested) return null;
      return republishAfterRejectedUserAction('ILLEGAL_ACTION');
    }

    const stepArgs = ['step', 'user', action.action];
    if (action.amount !== undefined) stepArgs.push(String(action.amount));
    stepArgs.push('--expect-version', String(out.stateVersion));
    try {
      return await runAtomicStepPublish(stepArgs, waitFlags());
    } catch (error) {
      if (error.code !== 'ILLEGAL_ACTION' && error.code !== 'VERSION_MISMATCH') throw error;
      if (stopRequested) return null;
      return republishAfterRejectedUserAction(error.code);
    }
  };

  const waitForChildExit = async (child, timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    let exited = false;
    const exit = new Promise((resolve) => child.once('exit', () => {
      exited = true;
      resolve();
    }));
    await Promise.race([exit, sleep(timeoutMs)]);
    return exited || child.exitCode !== null || child.signalCode !== null;
  };

  const terminateActiveChildren = async () => {
    const children = [...activeChildren];
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      if (await waitForChildExit(child, 500)) return;
      child.kill('SIGKILL');
      if (!await waitForChildExit(child, 500)) {
        throw codedError('CHILD_STOP_UNCONFIRMED', `자식 pid ${child.pid} 종료를 확인하지 못했습니다.`);
      }
    }));
  };

  const requestStop = () => {
    if (stopPromise) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      let stopError = null;
      try {
        if (fs.existsSync(loopStatePath)) {
          writeLoopState({ stopping: true, stopRequestedAt: isoNow(now) });
        }
      } catch (error) {
        stopError = error;
      }
      const inFlight = atomicTransition;
      if (inFlight) {
        // The mutation and its matching publish are one recoverable unit. Its own
        // error is observed by run(); shutdown still proceeds after it settles.
        await inFlight.promise;
      }
      const resolving = resolverPromise;
      // 먼저 현재까지 생성된 adapter를 닫아 in-flight probe를 취소한다. resolver가
      // fallback adapter를 더 만들면 registerAdapter가 즉시 그 adapter도 닫는다.
      for (const adapter of adapters) startAdapterDisposal(adapter);
      if (resolving) {
        try { await resolving; } catch { /* bootstrap/resume 호출자가 원래 오류를 관찰한다 */ }
      }
      // resolver settlement 뒤에는 더 이상 새 adapter가 생기지 않는다. 전부 settle한
      // 뒤에만 loop lock을 풀어 probe child가 ownership 밖으로 탈출하지 못하게 한다.
      for (const adapter of adapters) startAdapterDisposal(adapter);
      const disposalResults = await Promise.allSettled([...adapterDisposals.values()]);
      const disposalFailure = disposalResults.find((result) => result.status === 'rejected');
      if (disposalFailure) stopError ??= disposalFailure.reason;
      try {
        await terminateActiveChildren();
      } catch (error) {
        stopError ??= error;
      }
      try {
        await stopServer();
      } catch (error) {
        stopError ??= error;
      }
      adapters.clear();
      for (const canary of canaries) {
        try { fs.unlinkSync(canary); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      canaries.clear();
      try {
        if (fs.existsSync(loopStatePath)) {
          writeLoopState({ stopping: true, stoppedAt: isoNow(now) });
        }
      } catch (error) {
        stopError ??= error;
      }
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
    await acquireLoopLock({ mode: 'bootstrap', force });
    try {
      if (force) {
        // force는 loop 유무와 무관하게 sidecar의 pid+startTime+listener+token
        // 사다리를 수행한다. 이 후 lock 부재가 증명된 상태에서만 init한다.
        await stopRereadServerForForce();
      }
      // engine init의 legacy readLock은 malformed/falsy 값을 부재로 접는다. 파괴적
      // archive/init 경계에 들어가기 전에 sidecar의 strict schema로 먼저 차단한다.
      readServerLock();
      const initArgs = ['init', '--ai', String(ai)];
      if (stack !== undefined) initArgs.push('--stack', String(stack));
      if (levelEvery !== undefined) initArgs.push('--level-every', String(levelEvery));
      if (blinds !== undefined) initArgs.push('--blinds', String(blinds));
      // Engine의 legacy --force는 PID-only server 정지를 포함한다. sidecar가
      // 안전하게 server lock을 없앤 후이므로 init에 force를 위임하지 않는다.
      const initialized = await runCli(initArgs);
      openLog();
      const startedAt = isoNow(now);
      writeLoopState({
        phase: 'bootstrap',
        handNo: 0,
        port: null,
        sessionToken: initialized.sessionToken,
        gameEpoch: gameEpochOf(initialized.sessionToken),
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
        ...(existingState.halt?.code === 'REVIEW_FAILED' ? { halt: undefined } : {}),
      });
    }
    if (phase === 'done') {
      const liveLock = readServerLock();
      if (liveLock && processAlive(liveLock.serverPid)) {
        const port = await ensureServer(engineState.sessionToken, { port: liveLock.port });
        return writeLoopState({ port });
      }
      return existingState;
    }
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
      ...(existingState.halt?.code === 'NO_PLAYER_RUNTIME' && playerAdapter ? { halt: undefined } : {}),
    });
    if (!playerAdapter) await haltNoPlayer(notices);
    const desiredPort = Number.isSafeInteger(existingState.port) && existingState.port > 0
      ? existingState.port
      : requestedPort;
    const port = await ensureServer(engineState.sessionToken, { port: desiredPort });
    writeLoopState({ port });
    await restorePlayers();
    return writeLoopState({ phase: 'playing' });
  };

  const resume = async () => {
    await acquireLoopLock({ mode: 'resume' });
    let lifecycleStarted = false;
    try {
      const engineState = readJsonOptional(engineStatePath, 'ENGINE_STATE');
      let state = readLoopState();
      if (!engineState) throw codedError('NO_GAME', 'resume할 engine 상태가 없습니다.');
      if (typeof engineState.sessionToken !== 'string' || engineState.sessionToken === '') {
        throw codedError('BAD_ENGINE_IDENTITY', 'resume할 engine sessionToken이 없습니다.');
      }
      const canonicalEpoch = gameEpochOf(engineState.sessionToken);
      if (state && (
        state.sessionToken !== engineState.sessionToken
        || state.gameEpoch !== canonicalEpoch
      )) {
        throw codedError(
          'LOOP_STATE_IDENTITY_MISMATCH',
          'loop-state sessionToken/gameEpoch가 engine identity와 일치하지 않습니다.',
        );
      }
      openLog();
      lifecycleStarted = true;

      const ownerSessionId = randomUUID();
      if (!state) {
        const phase = engineState.gameOver ? 'finalizing' : 'playing';
        state = writeLoopState({
          phase,
          handNo: engineState.handNo ?? 0,
          port: null,
          sessionToken: engineState.sessionToken,
          gameEpoch: canonicalEpoch,
          ownerSessionId,
          stopping: false,
          lastPublishId: null,
          playerRuntime: null,
          upperRuntime: null,
          startedAt: isoNow(now),
          notices: [],
          metrics: [],
        });
      } else {
        state = writeLoopState({ ownerSessionId, stopping: false });
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
      if (lifecycleStarted) await requestStop();
      else releaseLock();
      throw error;
    }
  };

  const run = async () => {
    let state = readLoopState();
    if (!state) throw codedError('NOT_BOOTSTRAPPED', 'bootstrap 또는 resume이 필요합니다.');
    const repairingOnResume = resumeEntryPending && state.halt?.code === 'repair_failed';
    if (state.halt?.code && !repairingOnResume) throw codedError(state.halt.code, state.halt.message);
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
      if (readLoopState()?.halt?.code === 'repair_failed') writeLoopState({ halt: undefined });
      resumeEntryPending = false;
      if (engine.hand) {
        out = await publishEnvelope(current, ['--view-only', ...waitFlags()]);
      } else {
        out = await runAtomicStepPublish(['step', '--new-hand'], waitFlags());
      }
    } else if (engine.hand) {
      const synchronized = await runCli(['step']);
      out = await publishEnvelope(synchronized, ['--view-only', ...waitFlags()]);
    } else {
      out = await runAtomicStepPublish(['step', '--new-hand'], waitFlags());
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
        if (stopRequested) break;
        out = await runAtomicStepPublish(['step', '--new-hand'], (started) => {
          const narration = started.events?.find((event) => event.type === 'level_up');
          return narration
            ? ['--narration', `블라인드 ${narration.sb}/${narration.bb}`, ...waitFlags()]
            : waitFlags();
        });
        continue;
      }

      if (out.next?.kind === 'user') {
        try {
          out = await handleUserTurn(out);
        } catch (error) {
          if (stopRequested && error.code !== 'STOPPING') break;
          throw error;
        }
        if (out === null) break;
        continue;
      }
      if (out.next?.kind !== 'ai') {
        throw codedError('BAD_NEXT', '다음 행동자 계약이 ai/user가 아닙니다.');
      }

      const next = out.next;
      let decision;
      try {
        decision = await decideWithWatchdog(next, out.stateVersion);
      } catch (error) {
        if (stopRequested && error.code !== 'STOPPING') break;
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
      const metric = {
        playerId: next.toAct,
        decisionId: next.decisionId,
        runtime: playerAdapter.kind,
        outcome: decision.outcome,
        elapsedMs,
        modelMs: decision.modelMs,
        parseMs: decision.parseMs,
        stepMs: decision.stepMs,
        ...(decision.sessionRepaired ? { sessionRepaired: true } : {}),
      };
      try {
        out = await publishEnvelope(decision.envelope, waitFlags());
        const publishMs = Math.max(0, monotonicNow() - publishStarted);
        appendMetric({ ...metric, publishMs });
      } catch (error) {
        // Engine step이 적용된 이상 게시 실패로 표본을 숨기지 않는다.
        // outcome은 모델 결정 결과를 그대로 두고, 게시 경계는 별도 code로 정직하게 표시한다.
        appendMetric({
          ...metric,
          publishMs: Math.max(0, monotonicNow() - publishStarted),
          publishError: error.code ?? 'ERROR',
        });
        throw error;
      } finally {
        decision.atomicUnit.finish();
      }
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
  let handlingSignal = false;
  let signalStopPromise = null;
  let signalStopError = null;
  try {
    const args = parseGameLoopArgs(process.argv.slice(2));
    if (!args.resume && args.ai === undefined) throw codedError('USAGE', '--ai가 필요합니다.');
    const resolver = ({ need, canaryAbsPath, registerAdapter }) => resolveRuntimes({
      need,
      canaryAbsPath,
      preferred: args.playerRuntime ?? null,
      onAdapterCreated: registerAdapter,
    });
    loop = createGameLoop({ gameDir: args.gameDir, resolver });
    process.once('SIGTERM', () => {
      if (handlingSignal) return;
      handlingSignal = true;
      signalStopPromise = loop.requestStop().catch((error) => {
        signalStopError = error;
      });
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
    // 정상 SIGTERM 처리 중의 STOPPING은 실패가 아니다. 다른 runtime/cleanup
    // 실패는 그대로 보고하고 비정상 종료한다.
    if (!(handlingSignal && error.code === 'STOPPING')) caught = error;
  } finally {
    if (loop) {
      try {
        if (signalStopPromise) await signalStopPromise;
        else await loop.requestStop();
      } catch (error) {
        caught ??= error;
      }
    }
    if (signalStopError) caught = signalStopError;
  }
  if (caught) {
    try {
      fs.writeSync(2, `${JSON.stringify({ ok: false, code: caught.code ?? 'ERROR', message: caught.message })}\n`);
    } catch { /* stderr unavailable */ }
  }
  process.exit(exitCodeFor(caught));
}

const isDirectRun = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
