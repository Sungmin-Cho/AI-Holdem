#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  isArgvSafeSessionId,
  RUNTIME_TABLE,
  resolveRuntimes,
} from './player-runtime.js';
import { gameEpochOf } from '../publish-contract.js';
import { canStartReplacement } from './coach-control.js';
import { assertNotSessionCatalogTarget, isAlive } from '../engine/game-archive.js';
import {
  commitSession,
  ensureSessionStore,
  prepareSession,
  resolveCurrentSession,
} from '../engine/session-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_CLI = path.join(ROOT, 'engine/cli.js');
const PUBLISH_CLI = path.join(ROOT, 'tools/publish.js');
const COACH_CLI = path.join(ROOT, 'tools/coach-control.js');
const SERVER_CLI = path.join(ROOT, 'server/server.js');
const LOOP_LOCK = 'loop.lock.d';
const COACH_GENERATION_MS = 120_000;
const REVIEW_GENERATION_MS = 300_000;
const REVIEW_HEADING_PATTERNS = Object.freeze([
  /^#{1,6}[ \t]+내 성향 통계(?:[ \t]|$)/m,
  /^#{1,6}[ \t]+결정적 핸드(?:[ \t]|$)/m,
  /^#{1,6}[ \t]+각 AI의 실제 아키타입 공개[ \t]*\+[ \t]*읽기 평가(?:[ \t]|$)/m,
  /^#{1,6}[ \t]+다음 게임에서 연습할 것(?:[ \t]|$)/m,
]);
const COACH_PRIVATE_FIELDS = ['archetype', 'personality', 'bluffFreq', 'threeBetFreq', 'tiltProne'];
const FINAL_PHASES = new Set(['finalizing', 'review_generated', 'review_published']);
// §5 종료 시퀀스: finalDeadlineMono = now + 20s, resultWaitCutoffMono = finalDeadline - 10s.
const FINALIZE_BUDGET_MS = 20_000;
const FINALIZE_CUTOFF_LEAD_MS = 10_000;
// A finalization halt is a retryable operator condition: the next --resume re-enters the
// same checkpoint. repair_failed/NO_PLAYER_RUNTIME keep their own play-time boundaries.
const RESUMABLE_FINAL_HALTS = new Set([
  'COACH_RECONCILE_PENDING',
  'FINALIZATION_ABORTED',
  'REVIEW_FAILED',
  'REVIEW_GATE_CLOSED',
]);
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
  'INVALID_SESSION_ID',
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

function isFatalRepairFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return code === 'CLOSE_UNSETTLED'
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

function readStrictServerLock(gameDir) {
  const lockPath = path.join(gameDir, 'lock.json');
  let fd;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw codedError('BAD_SERVER_LOCK', '이전 session server lock을 안전하게 열 수 없습니다.', { cause: error });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw codedError('BAD_SERVER_LOCK', '이전 session server lock inode가 올바르지 않습니다.');
    const lock = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (
      !lock || typeof lock !== 'object' || Array.isArray(lock)
      || !Number.isInteger(lock.serverPid) || lock.serverPid <= 0
      || !Number.isInteger(lock.port) || lock.port <= 0
      || typeof lock.sessionToken !== 'string' || lock.sessionToken === ''
    ) throw codedError('BAD_SERVER_LOCK', '이전 session server lock schema가 올바르지 않습니다.');
    return lock;
  } catch (error) {
    if (error.code === 'BAD_SERVER_LOCK') throw error;
    throw codedError('BAD_SERVER_LOCK', '이전 session server lock을 읽을 수 없습니다.', { cause: error });
  } finally {
    fs.closeSync(fd);
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
    ['--store-dir', 'storeDir'],
    ['--ai', 'ai'],
    ['--stack', 'stack'],
    ['--level-every', 'levelEvery'],
    ['--blinds', 'blinds'],
    ['--player-runtime', 'playerRuntime'],
    ['--practice-focus-file', 'practiceFocusFile'],
  ]);
  let sawGameDir = false;

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
    if (valueName === 'gameDir') sawGameDir = true;
    if (valueName === 'ai' || valueName === 'stack' || valueName === 'levelEvery') {
      parsed[valueName] = integerValue(value, arg);
    } else if (valueName === 'gameDir' || valueName === 'storeDir' || valueName === 'practiceFocusFile') {
      parsed[valueName] = path.resolve(value);
    } else {
      parsed[valueName] = value;
    }
  }
  if (parsed.storeDir !== undefined && sawGameDir) {
    throw codedError('USAGE', '--store-dir와 --game-dir는 함께 사용할 수 없습니다.');
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

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeTextAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* absent or preserved original failure */ }
    throw error;
  }
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

export function createGameLoop({ gameDir, lockDir = gameDir, initialLockHandle = null, resolver = resolveRuntimes, opts = {} }) {
  if (!gameDir) throw codedError('USAGE', 'gameDir가 필요합니다.');
  if (typeof resolver !== 'function') throw codedError('USAGE', 'resolver가 필요합니다.');

  const root = path.resolve(gameDir);
  const lockRoot = path.resolve(lockDir);
  const now = opts.now ?? (() => new Date());
  const requestedPort = opts.port ?? 8877;
  const pollMs = opts.pollMs ?? 20;
  const serverStartMs = opts.serverStartMs ?? 5_000;
  const childTimeoutMs = opts.childTimeoutMs ?? 30_000;
  const osVerifyMs = opts.osVerifyMs ?? 1_000;
  const waitMs = opts.waitMs ?? 60_000;
  const waitNetworkMarginMs = opts.waitNetworkMarginMs ?? DEFAULT_WAIT_NETWORK_MARGIN_MS;
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  // publish.js compares --deadline-monotonic-ns against its own process.hrtime.bigint(),
  // which is the system monotonic clock: the two processes share the origin.
  const monotonicNs = opts.monotonicNs ?? (() => process.hrtime.bigint());
  const finalizeBudgetMs = opts.finalizeBudgetMs ?? FINALIZE_BUDGET_MS;
  const finalizeCutoffLeadMs = Math.min(
    opts.finalizeCutoffLeadMs ?? FINALIZE_CUTOFF_LEAD_MS,
    finalizeBudgetMs,
  );
  const orphanTerminateGraceMs = opts.orphanTerminateGraceMs ?? 5_000;
  const orphanTerminateKillWaitMs = opts.orphanTerminateKillWaitMs ?? 2_000;
  const resumeReclaimResidualMs = opts.resumeReclaimResidualMs ?? 5_000;
  const minRepairFloorMs = opts.minRepairFloorMs ?? 2_000;
  const lsofPath = opts.lsofPath ?? DEFAULT_LSOF;
  const signalProcess = opts.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const forceStopMs = opts.forceStopMs ?? 5_000;
  const forceKillMs = opts.forceKillMs ?? 200;
  const loopStatePath = path.join(root, 'loop-state.json');
  const engineStatePath = path.join(root, 'state.json');
  const playersPath = path.join(root, 'players.json');
  const sessionsPath = path.join(root, '.player-sessions.json');
  const reviewPath = path.join(root, 'review.md');
  const reviewEnvelopePath = path.join(root, '.review.json');
  const publishAttemptPath = path.join(root, '.publish-attempt.json');
  const lockPath = path.join(root, 'lock.json');
  const canaries = new Set();
  const activeChildren = new Set();
  const adapters = new Set();
  const adapterDisposals = new Map();
  const coachTasks = new Set();
  const coachAttempts = new Map();
  const archiveCheckedHands = new Set();
  const restoredPlayerSessions = new Set();

  let lockHandle = initialLockHandle;
  let serverChild = null;
  let serverPid = null;
  let serverIdentity = null;
  let serverAdopted = false;
  let serverStartupIdentityMissing = false;
  let logFd = null;
  let playerAdapter = null;
  let upperAdapter = null;
  let coachAdapterDisabled = false;
  let playerSessions = null;
  let resumeEntryPending = false;
  let stopRequested = false;
  let stopPromise = null;
  let pendingFinalStatePatch = null;
  let atomicTransition = null;
  let resolverPromise = null;
  let finalizationCutoff = false;
  let publishDeadlineNs = null;
  let finalizeResultWaitCutoffNs = null;
  let finalizationDeadlineNs = null;
  let finalizationDeadlineStartedAt = null;
  let finalizationPriorTerminationConfirmed = true;

  // §9.2 (2): during the finalizing result-wait window a failed attempt may only be
  // replaced while at least 5s of that window remain. Outside finalization the play-time
  // replacement contract is unchanged.
  const coachReplacementAllowed = () => (
    finalizeResultWaitCutoffNs === null
    || canStartReplacement(monotonicNs(), finalizeResultWaitCutoffNs)
  );

  const assertBeforeResultWaitCutoff = () => {
    if (
      finalizeResultWaitCutoffNs !== null
      && remainingMsUntil(finalizeResultWaitCutoffNs) <= 0
    ) throw finalizationResultWaitCutoffError();
  };

  // Coach work stops taking new authority/publication steps once shutdown or the
  // game-over cutoff owns the sequence. After the cutoff, `finalize-cutoff` seals every
  // still-missing hand in one transaction and the residual drain publishes it.
  const coachWorkSuspended = () => stopRequested || finalizationCutoff;

  // During finalization every accepted note remains in the owner-neutral Q until the
  // cutoff transaction has stopped play-time publishers. The residual drain is the only
  // publication path and carries the same final deadline.
  const coachPublicationDeferred = () => (
    coachWorkSuspended() || finalizationDeadlineNs !== null
  );

  const remainingMsUntil = (deadlineNs) => {
    const left = deadlineNs - monotonicNs();
    return left <= 0n ? 0 : Math.ceil(Number(left) / 1e6);
  };

  const finalizationDeadlineError = () => codedError(
    'FINALIZATION_DEADLINE_EXCEEDED',
    'finalization 공통 deadline이 만료됐습니다.',
  );

  const finalizationResultWaitCutoffError = () => codedError(
    'FINALIZATION_RESULT_WAIT_CUTOFF',
    'finalization result-wait cutoff가 만료됐습니다.',
  );

  const ensureFinalizationDeadline = () => {
    if (finalizationDeadlineNs === null) {
      finalizationDeadlineNs = monotonicNs() + BigInt(finalizeBudgetMs) * 1_000_000n;
      finalizationDeadlineStartedAt = isoNow(now);
    }
    return finalizationDeadlineNs;
  };

  const ensureFinalizationResultWaitCutoff = () => {
    const deadlineNs = ensureFinalizationDeadline();
    if (finalizeResultWaitCutoffNs === null) {
      finalizeResultWaitCutoffNs = deadlineNs - BigInt(finalizeCutoffLeadMs) * 1_000_000n;
    }
    return { deadlineNs, resultWaitCutoffNs: finalizeResultWaitCutoffNs };
  };

  const assertFinalizationDeadline = () => {
    if (finalizationDeadlineNs !== null && remainingMsUntil(finalizationDeadlineNs) <= 0) {
      throw finalizationDeadlineError();
    }
  };

  const settleOrTimeout = async (promise, ms) => {
    let timer = null;
    try {
      return await Promise.race([
        promise.then(() => true, () => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const settleValueBeforeDeadline = async (promise, deadlineNs) => {
    // Observe both outcomes before consulting the deadline. Callers have already invoked
    // terminate(), so an expired deadline must not leave a rejected Promise unattached.
    const observed = Promise.resolve(promise).then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error }),
    );
    const remaining = remainingMsUntil(deadlineNs);
    if (remaining <= 0) return { settled: false };
    let timer = null;
    try {
      return await Promise.race([
        observed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ settled: false }), remaining);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

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
    const observed = readOwnedLock(lockRoot, LOOP_LOCK);
    if (observed?.status === 'unknown') {
      throw codedError('LOOP_LOCK_UNKNOWN', 'loop 락 identity를 확인할 수 없어 중단합니다.');
    }
    try {
      lockHandle = acquireOwnedLock(lockRoot, LOOP_LOCK);
      return;
    } catch (error) {
      if (error.code === 'IDENTITY_UNAVAILABLE') throw error;
      if (error.code !== 'LOCKED') throw error;
      const owner = readOwnedLock(lockRoot, LOOP_LOCK);
      if (owner?.status === 'unknown') {
        throw codedError('LOOP_LOCK_UNKNOWN', 'loop 락 identity를 확인할 수 없어 중단합니다.');
      }
      if (owner?.status === 'dead') {
        throw codedError('LOOP_LOCK_UNRECLAIMABLE', '죽은 loop 락을 안전하게 회수할 수 없습니다.');
      }
      if (mode === 'bootstrap') {
        if (force) {
          await stopExistingLoopForForce(owner);
          lockHandle = acquireOwnedLock(lockRoot, LOOP_LOCK);
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

  const runJsonChild = (script, args, {
    deadlineNs: deadlineOverrideNs,
    deadlineError = finalizationDeadlineError,
  } = {}) => {
    const deadlineNs = deadlineOverrideNs ?? finalizationDeadlineNs;
    const ordinaryTimeout = timeoutForChild(args);
    const deadlineRemaining = deadlineNs === null ? null : remainingMsUntil(deadlineNs);
    if (deadlineRemaining !== null && deadlineRemaining <= 0) {
      return Promise.reject(deadlineError());
    }
    const deadlineLimited = deadlineRemaining !== null && deadlineRemaining <= ordinaryTimeout;
    const timeout = deadlineLimited ? Math.max(1, deadlineRemaining) : ordinaryTimeout;
    return new Promise((resolve, reject) => {
      const childArgs = [...args, '--game-dir', root];
      const argv = [script, ...childArgs];
      if (script === ENGINE_CLI) opts.onEngineInvoke?.([...childArgs]);
      if (script === COACH_CLI) opts.onCoachInvoke?.([...childArgs]);
      const child = execFile(process.execPath, argv, {
        encoding: 'utf8',
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        activeChildren.delete(child);
        let envelope = null;
        try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
        if (error || envelope?.ok === false) {
          if (
            deadlineNs !== null
            && (envelope?.code === 'DEADLINE_EXPIRED'
              || (deadlineLimited && (error?.code === 'ETIMEDOUT' || error?.killed === true)))
          ) {
            reject(deadlineError());
            return;
          }
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
        if (deadlineNs !== null && remainingMsUntil(deadlineNs) <= 0) {
          reject(deadlineError());
          return;
        }
        resolve(envelope);
      });
      activeChildren.add(child);
    });
  };

  const runCli = (args, supervisor) => runJsonChild(
    ENGINE_CLI,
    args[0] === 'resume-check' && lockRoot !== root
      ? [...args, '--lock-dir', lockRoot]
      : args,
    supervisor,
  );
  const runCoach = (args, supervisor) => runJsonChild(COACH_CLI, args, supervisor);
  const resultWaitSupervisor = () => (
    finalizeResultWaitCutoffNs === null
      ? undefined
      : {
          deadlineNs: finalizeResultWaitCutoffNs,
          deadlineError: finalizationResultWaitCutoffError,
        }
  );
  const runCliBeforeResultCutoff = (args) => runCli(args, resultWaitSupervisor());
  const runCoachBeforeResultCutoff = (args) => runCoach(args, resultWaitSupervisor());
  const runPublish = (args) => {
    // After the cutoff every publication must carry the single finalization deadline:
    // publish.js refuses new play-time bodies once `noNewPlayTimePublishers` is set, and
    // the deadline is what bounds the residual drain to the remaining budget.
    const deadlined = publishDeadlineNs !== null && !args.includes('--deadline-monotonic-ns')
      ? [...args, '--deadline-monotonic-ns', String(publishDeadlineNs)]
      : args;
    opts.onPublishInvoke?.([...deadlined]);
    return runJsonChild(PUBLISH_CLI, deadlined);
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
    const current = readOwnedLock(lockRoot, LOOP_LOCK);
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

  const createPlayerSession = async (persona, createdAt, { deadlineAt = null } = {}) => {
    const prompt = buildPlayerPrompt({ persona });
    const timeoutMs = deadlineAt === null ? null : Math.ceil(deadlineAt - monotonicNow());
    if (timeoutMs !== null && timeoutMs <= 0) {
      throw codedError('TIMEOUT', `플레이어 ${persona.playerId} 세션 복구 예산이 만료됐습니다.`);
    }
    const result = await playerAdapter.warmup({
      playerId: persona.playerId,
      prompt,
      ...(timeoutMs === null ? {} : { timeoutMs }),
    });
    if (!result || typeof result.sessionId !== 'string' || result.sessionId === '') {
      throw codedError('NO_SESSION', `플레이어 ${persona.playerId} 세션이 없습니다.`);
    }
    if (!isArgvSafeSessionId(result.sessionId)) {
      throw codedError('INVALID_SESSION_ID', `플레이어 ${persona.playerId} 세션 id 형식이 안전하지 않습니다.`);
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
        && isArgvSafeSessionId(prior.sessionId)
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

  const repairRestoredPlayerSession = async (playerId, { deadlineAt }) => {
    if (!restoredPlayerSessions.has(playerId)) return null;
    // consume-before-await prevents a rejected warmup or fresh-session call from recursively
    // recreating the same player. A later process resume may try the still-persisted old entry.
    restoredPlayerSessions.delete(playerId);
    const players = readJsonOptional(playersPath, 'PLAYERS');
    const persona = Array.isArray(players)
      ? players.find((player) => player?.playerId === playerId && playerId !== 'user')
      : null;
    if (!persona) throw codedError('BAD_PLAYERS', `복구할 플레이어 ${playerId} 페르소나가 없습니다.`);
    const repaired = await createPlayerSession(persona, isoNow(now), { deadlineAt });
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
    if (!isArgvSafeSessionId(session.sessionId)) {
      throw codedError('INVALID_SESSION_ID', `플레이어 ${next.toAct} 세션 id 형식이 안전하지 않습니다.`);
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
      const attemptDeadlineAt = monotonicNow() + timeouts[attempt];
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
        const minRepairMs = Math.min(minRepairFloorMs, Math.ceil(timeouts[attempt] / 8));
        const remainingBeforeRepair = Math.max(0, Math.ceil(attemptDeadlineAt - monotonicNow()));
        if (remainingBeforeRepair < minRepairMs) continue;
        let repaired = null;
        try {
          repaired = await repairRestoredPlayerSession(next.toAct, { deadlineAt: attemptDeadlineAt });
        } catch (error) {
          if (isFatalRepairFailure(error)) throw error;
          log('player-session-repair-failed', {
            playerId: next.toAct,
            code: error.code ?? 'REPAIR_FAILED',
          });
          continue;
        }
        if (repaired) {
          session = repaired;
          sessionRepaired = true;
          const remainingBeforeRetry = Math.max(0, Math.ceil(attemptDeadlineAt - monotonicNow()));
          if (remainingBeforeRetry > 0) {
            round = await decideOnce({
              playerId: next.toAct,
              sessionId: session.sessionId,
              message: next.message,
            }, remainingBeforeRetry);
            modelMs += round.modelMs;
          } else {
            round = { ok: false, error: codedError('TIMEOUT', 'session repair 뒤 재결정 예산이 만료됐습니다.'), modelMs: 0 };
          }
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
    // §9.2 (3): the cutoff stops new play-time publishers locally, before the authority
    // flag exists. Coach seals keep flowing through executeCoachPublish under a deadline.
    if (finalizationCutoff) {
      throw codedError('PLAYTIME_PUBLISH_STOPPED', 'game-over cutoff 이후 play-time 게시를 시작하지 않습니다.');
    }
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
        if (code === 'NO_ATTEMPT' && resolvingPending) {
          resolvingPending = false;
          args = currentArgs;
          continue;
        }
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

  const coachSnapshotPath = path.join(root, 'ui-snapshot.json');
  const coachStatsPath = (handNo) => path.join(root, `.coach-stats-${handNo}.json`);
  const coachHandPath = (handNo) => path.join(root, `.coach-hand-${handNo}-redacted.json`);
  const coachDenyPath = (handNo) => path.join(root, `.coach-deny-${handNo}.json`);
  const coachAuthorityPath = path.join(root, '.coach-authority.json');
  const coachAttemptKey = (handNo, generation) => `${handNo}:${generation}`;

  const semanticChildPayload = (envelope) => {
    const payload = { ...envelope };
    delete payload.ok;
    delete payload.events;
    delete payload.stateVersion;
    return payload;
  };

  const appendNotice = (message) => {
    const state = readLoopState();
    if (!state) return;
    const notices = Array.isArray(state.notices) ? [...state.notices] : [];
    if (!notices.includes(message)) notices.push(message);
    writeLoopState({ notices });
  };

  const captureCoachStats = async (label, { beforeResultCutoff = false } = {}) => {
    const runner = beforeResultCutoff ? runCliBeforeResultCutoff : runCli;
    const captured = semanticChildPayload(await runner(['stats']));
    const filePath = label === 'owner'
      ? path.join(root, '.coach-owner-stats.json')
      : coachStatsPath(label);
    writeJsonAtomic(filePath, captured);
    return { path: filePath, raw: fs.readFileSync(filePath, 'utf8') };
  };

  const captureCoachHand = async (handNo, { beforeResultCutoff = false } = {}) => {
    const runner = beforeResultCutoff ? runCliBeforeResultCutoff : runCli;
    const captured = semanticChildPayload(await runner(['hand', String(handNo), '--redacted']));
    const filePath = coachHandPath(handNo);
    writeJsonAtomic(filePath, captured);
    return { path: filePath, raw: fs.readFileSync(filePath, 'utf8') };
  };

  const captureCoachInputs = async (handNo, prepared = null) => {
    if (prepared) return prepared;
    // reserve consumes the stats file synchronously. Both captures therefore finish before
    // the first reservation, and the exact bytes written here are reused in the prompt.
    const hand = await captureCoachHand(handNo, { beforeResultCutoff: true });
    const stats = await captureCoachStats(handNo, { beforeResultCutoff: true });
    return { hand, stats };
  };

  const fullHandRecord = (handNo) => {
    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (engine?.lastHand?.handNo === handNo) return engine.lastHand;
    const archivePath = path.join(root, 'hands', `hand-${String(handNo).padStart(4, '0')}.json`);
    return readJsonOptional(archivePath, 'HAND_RECORD');
  };

  const coachForbiddenLiterals = (handNo) => {
    const values = [];
    const players = readJsonOptional(playersPath, 'PLAYERS');
    for (const player of Array.isArray(players) ? players : []) {
      if (player?.playerId === 'user') continue;
      for (const field of COACH_PRIVATE_FIELDS) {
        const value = player?.[field];
        if (value !== undefined && value !== null && String(value).length > 0) values.push(String(value));
      }
    }
    const record = fullHandRecord(handNo);
    const publicCards = new Set(
      (record?.showdown?.reveals ?? []).flatMap((reveal) => reveal?.cards ?? []),
    );
    for (const [playerId, cards] of Object.entries(record?.holes ?? {})) {
      if (playerId === 'user') continue;
      for (const card of cards ?? []) {
        if (!publicCards.has(card)) values.push(String(card));
      }
    }
    return [...new Set(values)];
  };

  const writeCoachDeny = (handNo) => {
    const literals = coachForbiddenLiterals(handNo);
    if (literals.length === 0) {
      throw codedError('BAD_COACH_DENY', `핸드 ${handNo} private literal deny 목록이 비어 있습니다.`);
    }
    const filePath = coachDenyPath(handNo);
    writeJsonAtomic(filePath, literals);
    return { path: filePath, literals };
  };

  const buildCoachPrompt = ({ handNo, inputs, overfoldReserved, retry = false }) => {
    let practiceFocus = '없음';
    try {
      practiceFocus = fs.readFileSync(path.join(root, '.practice-focus.json'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const prompt = [
      '너는 공정한 홀덤 코치다. 아래에 인라인된 입력만 사용한다. 다른 파일·도구·네트워크를 조회하지 마라.',
      '입력에 없는 상대 홀카드·덱·아키타입·스타일을 추측하거나 언급하지 마라.',
      '',
      `hand ${handNo} (redacted):`,
      inputs.hand.raw,
      '',
      'stats (reserve가 읽은 동일 캡처):',
      inputs.stats.raw,
      '',
      'practiceFocus:',
      practiceFocus,
      '',
      `과폴드 코멘트: ${overfoldReserved ? '허용' : '금지'}`,
      '',
      '할 일: 사용자의 주요 결정 1~2개를 한국어 1~2줄로 평가한다. 프리플랍 폴드도 예외가 아니다.',
      '폴드가 타당하면 포지션·홀카드·선행 액션 중 의미 있는 공개 근거로 무난한 폴드라고 평가한다.',
      '특별한 누수가 없다면 억지로 비판하거나 존재하지 않는 상대 레인지·숫자를 만들지 마라.',
      '팟 오즈가 실제 결정에 의미 있을 때만 숫자를 사용한다.',
      overfoldReserved
        ? '이 핸드는 과폴드 누수 코멘트를 한 번 사용할 수 있고, 사용하면 "overfold":true를 추가한다.'
        : '이 핸드에서는 과폴드 누수 코멘트를 사용하지 마라.',
      '',
      `출력은 JSON 한 줄만: {"handNo":${handNo},"text":"..."}`,
      'text.trim()은 비어 있으면 안 되고, 설명·마크다운·코드펜스·추가 필드는 금지한다.',
    ].join('\n');
    return retry
      ? `${prompt}\n재시도 사유: 직전 출력이 기계적 JSON 계약을 만족하지 못했다. 부분 출력은 무시하고 동일 입력으로 새로 작성하라.`
      : prompt;
  };

  const validateCoachNote = (raw, handNo, forbiddenLiterals) => {
    const note = extractJsonLine(raw);
    if (!note || typeof note !== 'object' || Array.isArray(note)) {
      throw codedError('INVALID_COACH_OUTPUT', '코치 출력이 JSON 객체가 아닙니다.');
    }
    const allowed = new Set(['handNo', 'text', 'overfold', 'unavailable']);
    if (
      note.handNo !== handNo
      || typeof note.text !== 'string'
      || note.text.trim() === ''
      || (note.overfold !== undefined && note.overfold !== true)
      || (note.unavailable !== undefined && note.unavailable !== true)
      || Object.keys(note).some((field) => !allowed.has(field))
    ) {
      throw codedError('INVALID_COACH_OUTPUT', '코치 출력 필드 계약이 올바르지 않습니다.');
    }
    if (forbiddenLiterals.some((literal) => literal && note.text.includes(literal))) {
      throw codedError('INVALID_COACH_OUTPUT', '코치 출력에 private literal이 포함됐습니다.');
    }
    return note;
  };

  const readCoachAuthority = () => readJsonOptional(coachAuthorityPath, 'COACH_AUTHORITY');

  const canonicalCoachAuthorityEpoch = () => {
    const loopState = readLoopState();
    const engineState = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (typeof engineState?.sessionToken !== 'string' || engineState.sessionToken === '') {
      throw codedError('COACH_EPOCH_UNVERIFIABLE', 'engine의 canonical game epoch를 확인할 수 없습니다.');
    }
    const canonicalEpoch = gameEpochOf(engineState.sessionToken);
    if (
      loopState?.sessionToken !== engineState.sessionToken
      || loopState?.gameEpoch !== canonicalEpoch
    ) {
      throw codedError('COACH_EPOCH_UNVERIFIABLE', 'loop-state와 engine의 canonical game epoch가 일치하지 않습니다.');
    }
    return canonicalEpoch;
  };

  const parsePersistedCoachHandle = (raw) => {
    if (typeof raw !== 'string') return null;
    const separator = raw.indexOf(':');
    if (separator <= 0 || separator === raw.length - 1) return null;
    const pid = Number(raw.slice(0, separator));
    const startTime = raw.slice(separator + 1);
    if (!Number.isSafeInteger(pid) || pid < 1 || startTime === '') return null;
    return { pid, startTime };
  };

  const persistedCoachIdentityState = ({ pid, startTime }) => {
    if (!processAlive(pid)) return 'dead';
    const current = processStartTime(pid);
    if (current === null) return 'unknown';
    return current === startTime ? 'alive' : 'mismatch';
  };

  const waitForPersistedCoachDeath = async (identity, maxWaitMs, deadlineNs) => {
    const phaseDeadline = monotonicNs() + BigInt(Math.max(0, maxWaitMs)) * 1_000_000n;
    const deadline = phaseDeadline < deadlineNs ? phaseDeadline : deadlineNs;
    for (;;) {
      const state = persistedCoachIdentityState(identity);
      if (state === 'dead' || state === 'mismatch') return state;
      const remaining = remainingMsUntil(deadline);
      if (remaining <= 0) return persistedCoachIdentityState(identity);
      await sleep(Math.min(pollMs, remaining));
    }
  };

  const waitForPersistedCoachIdentity = async (identity, deadlineNs) => {
    for (;;) {
      const state = persistedCoachIdentityState(identity);
      if (state !== 'unknown') return state;
      const remaining = remainingMsUntil(deadlineNs);
      if (remaining <= 0) return 'unknown';
      await sleep(Math.min(pollMs, remaining));
    }
  };

  const terminatePersistedCoachAttempt = async (attempt, deadlineNs, {
    allowCurrentReservedWithoutHandle = false,
    identityDeadlineNs = deadlineNs,
  } = {}) => {
    if (
      allowCurrentReservedWithoutHandle
      && attempt.source === 'active'
      && attempt.status === 'reserved'
      && !attempt.agentHandle
    ) {
      return { confirmed: true, reason: 'NOT_SPAWNED', cleanupState: 'released' };
    }
    const identity = parsePersistedCoachHandle(attempt.agentHandle);
    if (!identity) {
      return { confirmed: false, reason: 'IDENTITY_UNAVAILABLE', cleanupState: 'termination_unconfirmed' };
    }
    let state = await waitForPersistedCoachIdentity(identity, identityDeadlineNs);
    if (state === 'dead') return { confirmed: true, cleanupState: 'released' };
    // A different startTime proves that the recorded process identity is gone. Never
    // signal the replacement pid; close the stale record as released instead.
    if (state === 'mismatch') {
      return { confirmed: true, reason: 'IDENTITY_REPLACED', cleanupState: 'released' };
    }
    if (state !== 'alive') {
      return { confirmed: false, reason: 'IDENTITY_UNKNOWN', cleanupState: 'termination_unconfirmed' };
    }

    try {
      signalProcess(identity.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        return { confirmed: false, reason: 'SIGNAL_FAILED', cleanupState: 'termination_unconfirmed' };
      }
    }
    state = await waitForPersistedCoachDeath(identity, orphanTerminateGraceMs, deadlineNs);
    if (state === 'dead') return { confirmed: true, cleanupState: 'released' };
    if (state === 'mismatch') {
      return { confirmed: true, reason: 'IDENTITY_REPLACED', cleanupState: 'released' };
    }
    if (state !== 'alive') {
      return { confirmed: false, reason: 'IDENTITY_UNKNOWN', cleanupState: 'termination_unconfirmed' };
    }
    if (remainingMsUntil(deadlineNs) <= 0) {
      return { confirmed: false, reason: 'DEADLINE_EXCEEDED', cleanupState: 'termination_unconfirmed' };
    }

    try {
      signalProcess(identity.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        return { confirmed: false, reason: 'SIGNAL_FAILED', cleanupState: 'termination_unconfirmed' };
      }
    }
    state = await waitForPersistedCoachDeath(identity, orphanTerminateKillWaitMs, deadlineNs);
    if (state === 'dead') return { confirmed: true, cleanupState: 'released' };
    if (state === 'mismatch') {
      return { confirmed: true, reason: 'IDENTITY_REPLACED', cleanupState: 'released' };
    }
    return {
      confirmed: false,
      reason: state === 'alive' ? 'STILL_ALIVE' : 'IDENTITY_UNKNOWN',
      cleanupState: 'termination_unconfirmed',
    };
  };

  const persistedCoachAttempts = () => {
    const auth = readCoachAuthority();
    if (!auth) return { owner: null, attempts: [], authorityPresent: false };
    const owner = auth.activeOwnerSessionId;
    let canonicalEpoch;
    try {
      canonicalEpoch = canonicalCoachAuthorityEpoch();
    } catch (error) {
      return {
        owner,
        attempts: [],
        authorityError: {
          reason: error.code ?? 'COACH_EPOCH_UNVERIFIABLE',
          expectedGameEpoch: null,
          actualGameEpoch: auth.gameEpoch ?? null,
        },
      };
    }
    if (auth.gameEpoch !== canonicalEpoch) {
      return {
        owner,
        attempts: [],
        authorityError: {
          reason: 'STALE_GAME_EPOCH',
          expectedGameEpoch: canonicalEpoch,
          actualGameEpoch: auth.gameEpoch ?? null,
        },
      };
    }
    const attempts = [];
    for (const [handKey, hand] of Object.entries(auth.hands ?? {})) {
      if (!['reserved', 'running'].includes(hand?.status)
        && !(hand?.status === 'terminal' && hand?.resultState === 'unread')) continue;
      attempts.push({
        source: 'active',
        handNo: Number(handKey),
        generation: hand.generation,
        status: hand.status,
        agentHandle: hand.agentHandle,
        cleanupAuthorized: true,
      });
    }
    for (const row of auth.retiredAttempts ?? []) {
      if (row?.cleanupState === 'released') continue;
      const reclaimable = row?.ownerSessionId === owner
        || (row?.cleanupEligible === true && row?.replacementGeneration != null);
      const unresolved = ['termination_unconfirmed', 'release_failed'].includes(row?.cleanupState);
      if (!reclaimable && !unresolved) continue;
      if (typeof row?.agentHandle !== 'string' && !unresolved) continue;
      attempts.push({
        source: 'retired',
        handNo: row.handNo,
        generation: row.generation,
        status: row.cleanupState,
        agentHandle: row.agentHandle,
        cleanupAuthorized: reclaimable,
      });
    }
    return { owner, attempts, authorityPresent: true };
  };

  const closePersistedCoachWorkersCore = async ({
    deadlineNs,
    identityDeadlineNs,
    deadlineError,
    reasonPrefix,
    allowCurrentReservedWithoutHandle,
  }) => {
    const { owner, attempts, authorityError, authorityPresent = true } = persistedCoachAttempts();
    if (authorityError) {
      return {
        confirmed: false,
        owner,
        authorityPresent,
        unresolved: [{
          handNo: null,
          generation: null,
          cleanupAuthorized: false,
          ...authorityError,
        }],
      };
    }
    if (attempts.length === 0) {
      return { confirmed: true, owner, unresolved: [], authorityPresent };
    }
    if (typeof owner !== 'string' || owner === '') {
      return {
        confirmed: false,
        owner,
        authorityPresent,
        unresolved: [{
          handNo: null,
          generation: null,
          reason: 'NO_COACH_OWNER',
          cleanupAuthorized: false,
        }],
      };
    }
    const outcomes = await Promise.all(attempts.map(async (attempt) => ({
      attempt,
      result: await terminatePersistedCoachAttempt(attempt, deadlineNs, {
        allowCurrentReservedWithoutHandle,
        identityDeadlineNs,
      }),
    })));

    // Each hand preserves fence→cleanup ordering, but all hand closures start together.
    // The authority lock serializes its tiny critical sections while the parent keeps one
    // absolute deadline instead of multiplying child timeouts by the hand count.
    const closed = await Promise.all(outcomes.map(async ({ attempt, result }) => {
      let childFailure = null;
      if (attempt.source === 'active') {
        try {
          await runCoach([
            'fence', '--owner', owner,
            '--hand', String(attempt.handNo),
            '--generation', String(attempt.generation),
            '--reason', result.confirmed ? `${reasonPrefix}-closed` : `${reasonPrefix}-unconfirmed`,
          ], { deadlineNs, deadlineError });
        } catch (error) {
          if (error.code === deadlineError().code) throw error;
          if (error.code !== 'STALE_GENERATION') {
            childFailure = { reason: 'FENCE_CHILD_FAILED', cleanupAuthorized: false };
          }
        }
      }
      if (attempt.cleanupAuthorized && childFailure === null) {
        try {
          await runCoach([
            'cleanup-result', '--owner', owner,
            '--hand', String(attempt.handNo),
            '--generation', String(attempt.generation),
            '--cleanup-state', result.cleanupState,
          ], { deadlineNs, deadlineError });
        } catch (error) {
          if (error.code === deadlineError().code) throw error;
          childFailure = { reason: 'CLEANUP_CHILD_FAILED', cleanupAuthorized: true };
        }
      }
      const effectiveResult = childFailure === null
        ? result
        : {
            confirmed: false,
            reason: childFailure.reason,
            cleanupState: 'termination_unconfirmed',
            cleanupAuthorized: childFailure.cleanupAuthorized,
          };
      if (effectiveResult.confirmed !== true) {
        log(`${reasonPrefix}-unconfirmed`, {
          handNo: attempt.handNo,
          generation: attempt.generation,
          reason: effectiveResult.reason,
        });
      }
      return { attempt, result: effectiveResult };
    }));
    const unresolved = closed
      .filter(({ result }) => result.confirmed !== true)
      .map(({ attempt, result }) => ({
        handNo: attempt.handNo,
        generation: attempt.generation,
        reason: result.reason,
        cleanupAuthorized: result.cleanupAuthorized ?? attempt.cleanupAuthorized,
      }));
    const confirmed = unresolved.length === 0;
    if (!confirmed) {
      try {
        await runCoach([
          'adapter-disable', '--owner', owner,
          '--reason', `${reasonPrefix}-termination-unconfirmed`,
        ], { deadlineNs, deadlineError });
        coachAdapterDisabled = true;
      } catch (error) {
        if (error.code === deadlineError().code) throw error;
        unresolved.push({
          handNo: null,
          generation: null,
          reason: 'ADAPTER_DISABLE_CHILD_FAILED',
          cleanupAuthorized: false,
        });
      }
    }
    return { confirmed: unresolved.length === 0, owner, unresolved, authorityPresent };
  };

  const closePersistedCoachWorkers = async ({ allowCurrentReservedWithoutHandle = false } = {}) => {
    const deadlineNs = ensureFinalizationDeadline();
    return closePersistedCoachWorkersCore({
      deadlineNs,
      identityDeadlineNs: finalizeResultWaitCutoffNs ?? deadlineNs,
      deadlineError: finalizationDeadlineError,
      reasonPrefix: 'finalize-persisted',
      allowCurrentReservedWithoutHandle,
    });
  };

  const resumeReclaimDeadlineError = () => codedError(
    'RESUME_RECLAIM_DEADLINE_EXCEEDED',
    'playing resume persisted coach 회수 deadline이 만료됐습니다.',
  );

  const reclaimPersistedCoachWorkersForResume = async (completedHands) => {
    const budgetMs = orphanTerminateGraceMs + orphanTerminateKillWaitMs + resumeReclaimResidualMs;
    const deadlineNs = monotonicNs() + BigInt(budgetMs) * 1_000_000n;
    const identityDeadlineNs = deadlineNs - BigInt(resumeReclaimResidualMs) * 1_000_000n;
    let result;
    try {
      result = await closePersistedCoachWorkersCore({
        deadlineNs,
        identityDeadlineNs,
        deadlineError: resumeReclaimDeadlineError,
        reasonPrefix: 'resume-persisted',
        allowCurrentReservedWithoutHandle: false,
      });
    } catch (error) {
      if (error.code !== 'RESUME_RECLAIM_DEADLINE_EXCEEDED') throw error;
      result = {
        confirmed: false,
        owner: persistedCoachAttempts().owner,
        authorityPresent: persistedCoachAttempts().authorityPresent ?? false,
        unresolved: [{
          handNo: null,
          generation: null,
          reason: error.code,
          cleanupAuthorized: false,
        }],
      };
    }
    if (result.authorityPresent === false && completedHands >= 1) {
      return {
        ...result,
        confirmed: false,
        unresolved: [...result.unresolved, {
          handNo: null,
          generation: null,
          reason: 'AUTHORITY_MISSING',
          cleanupAuthorized: false,
        }],
      };
    }
    return result;
  };

  const coachEnvelopePathFor = (handNo, fallback = null) => (
    readCoachAuthority()?.publishQueue?.[String(handNo)]?.exactEnvelopePath
    ?? fallback
  );

  const ensureCoachPublishReconciled = async (handNo) => {
    let queued = readCoachAuthority()?.publishQueue?.[String(handNo)];
    if (!queued) return;
    await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
    queued = readCoachAuthority()?.publishQueue?.[String(handNo)];
    if (queued) {
      throw codedError(
        'COACH_RECONCILE_PENDING',
        `핸드 ${handNo} 코치 게시 후 reconcile 증명을 확인하지 못했습니다.`,
      );
    }
  };

  const executeCoachPublish = async (handNo, exactEnvelopePath) => {
    const args = ['--from', exactEnvelopePath];
    try {
      const published = await executePublish(args);
      await ensureCoachPublishReconciled(handNo);
      return published;
    } catch (error) {
      if (error.code === 'COACH_RECONCILE_PENDING') throw error;
      if (error.code === 'LOCK_TIMEOUT') {
        const published = await executePublish(args);
        await ensureCoachPublishReconciled(handNo);
        return published;
      }
      if (error.code !== 'ATTEMPT_PENDING') throw error;
      let attemptedCoachQueueId = null;
      let attemptedPublishId = null;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, '.publish-attempt.json'), 'utf8'));
        attemptedCoachQueueId = record?.coachAuthority?.queueId ?? null;
        attemptedPublishId = Number.isInteger(record?.body?.publishId) ? record.body.publishId : null;
      } catch { /* publish.js owns malformed/stale attempt classification */ }
      let retried;
      try {
        retried = await executePublish([...args, '--retry']);
      } catch (retryError) {
        if (retryError.code !== 'NO_ATTEMPT') throw retryError;
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${handNo} 코치 retry 직전 attempt가 사라져 반영 여부를 확인하지 못했습니다.`,
        );
      }
      await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
      const auth = readCoachAuthority();
      if (auth?.publishedSeals?.[String(handNo)]) return { ok: true, reconciled: true };
      const currentQueueId = auth?.publishQueue?.[String(handNo)]?.queueId ?? null;
      const retryPublishedCurrent = (
        (attemptedCoachQueueId && attemptedCoachQueueId === currentQueueId)
        || (!attemptedCoachQueueId && retried?.hadCoach === true)
      );
      if (retryPublishedCurrent || retried?.reconcilePending === true) {
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${handNo} 코치 retry 후 reconcile 증명을 확인하지 못했습니다.`,
        );
      }
      let recordedBodyProven = false;
      if (attemptedPublishId !== null) {
        try {
          recordedBodyProven = Number(readJsonOptional(coachSnapshotPath, 'COACH_SNAPSHOT')?.publishId) >= attemptedPublishId;
        } catch { /* an unavailable snapshot is not publication proof */ }
      }
      if (!attemptedCoachQueueId && !recordedBodyProven) {
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${handNo} 코치 retry 중 recorded body 반영을 확인하지 못했습니다.`,
        );
      }
      const published = await executePublish(args);
      await ensureCoachPublishReconciled(handNo);
      return published;
    }
  };

  const completeCoachUnavailable = async ({ owner, handNo, generation, reason, fallbackEnvelopePath = null }) => {
    // Past the cutoff the single finalize-cutoff transaction owns every remaining seal;
    // a racing per-hand seal would fight it for the same handNo.
    if (finalizationCutoff) return;
    const args = [
      'complete-unavailable',
      '--owner', owner,
      '--hand', String(handNo),
      ...(generation == null ? [] : ['--generation', String(generation)]),
      '--reason', reason,
      '--snapshot-file', coachSnapshotPath,
    ];
    await runCoachBeforeResultCutoff(args);
    const exactEnvelopePath = coachEnvelopePathFor(handNo, fallbackEnvelopePath);
    if (!exactEnvelopePath) throw codedError('NO_COACH_ENVELOPE', `핸드 ${handNo} unavailable envelope이 없습니다.`);
    if (coachPublicationDeferred()) return;
    await executeCoachPublish(handNo, exactEnvelopePath);
  };

  const reserveCoach = (owner, handNo, attempt, statsPath) => runCoachBeforeResultCutoff([
    'reserve',
    '--owner', owner,
    '--hand', String(handNo),
    '--attempt', String(attempt),
    '--consider-overfold',
    '--stats-file', statsPath,
    '--snapshot-file', coachSnapshotPath,
  ]);

  const coachPipeline = async (handNo, { descriptor: initialDescriptor = null, prepared = null } = {}) => {
    if (coachWorkSuspended()) return;
    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') throw codedError('NO_COACH_OWNER', '코치 ownerSessionId가 없습니다.');
    const upperUsable = upperAdapter && typeof upperAdapter.oneshotStart === 'function';
    if (coachAdapterDisabled || upperAdapter === null) {
      appendNotice(`상위 모델 런타임이 없어 핸드 ${handNo}은 고정 코치 문구로 대체합니다.`);
      await completeCoachUnavailable({
        owner,
        handNo,
        generation: initialDescriptor?.generation,
        reason: coachAdapterDisabled ? 'adapter-disabled' : 'upper-unavailable',
        fallbackEnvelopePath: initialDescriptor?.exactEnvelopePath,
      });
      return;
    }
    // A non-null object that does not implement the probed interface is not a truthful
    // upper-null result. It still must seal the hand; a live descriptor requires its
    // exact generation, while a play-time hand without a reservation uses fallback.
    if (!upperUsable) {
      coachAdapterDisabled = true;
      appendNotice(`핸드 ${handNo} 코치 adapter 인터페이스가 없어 고정 문구로 대체합니다.`);
      await completeCoachUnavailable({
        owner,
        handNo,
        generation: initialDescriptor?.generation,
        reason: 'upper-interface-unavailable',
        fallbackEnvelopePath: initialDescriptor?.exactEnvelopePath,
      });
      return;
    }

    const inputs = await captureCoachInputs(handNo, prepared);
    if (typeof opts.coachCaptureCheckpoint === 'function') {
      await opts.coachCaptureCheckpoint({ handNo });
    }
    if (coachWorkSuspended()) return;
    const deny = writeCoachDeny(handNo);
    let descriptor = initialDescriptor;
    if (!descriptor) {
      if (coachWorkSuspended()) return;
      try {
        descriptor = await reserveCoach(owner, handNo, 1, inputs.stats.path);
      } catch (reserveError) {
        if (reserveError.code !== 'ADAPTER_DISABLED') throw reserveError;
        // Adapter authority can change while the redacted captures are running. No
        // generation exists when the initial reserve is rejected, so use the explicit
        // generation-less fallback instead of degrading to a log-only coach gap.
        coachAdapterDisabled = true;
        appendNotice(`핸드 ${handNo} 코치 reserve 전 adapter가 disabled되어 고정 문구로 대체합니다.`);
        await completeCoachUnavailable({
          owner,
          handNo,
          reason: 'adapter-disabled-before-reserve',
        });
        return;
      }
    }
    if (coachWorkSuspended()) return;
    for (let attempt = Number(descriptor.attempt ?? 1); attempt <= 2; attempt += 1) {
      const currentDescriptor = descriptor;
      if (attempt > 1 && !coachReplacementAllowed()) {
        appendNotice(`핸드 ${handNo} 코치 교체 시작 경계에서 예산(5초)이 남지 않아 고정 문구로 대체합니다.`);
        await completeCoachUnavailable({
          owner,
          handNo,
          generation: currentDescriptor.generation,
          reason: 'finalize-no-replacement-budget',
          fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
        });
        return;
      }
      const prompt = buildCoachPrompt({
        handNo,
        inputs,
        overfoldReserved: currentDescriptor.overfoldReserved === true,
        retry: attempt === 2,
      });
      let handle = null;
      let accepted = false;
      let heartbeatTimedOut = false;
      try {
        if (coachWorkSuspended()) return;
        if (typeof opts.coachSpawnCheckpoint === 'function') {
          await opts.coachSpawnCheckpoint({ handNo, attempt });
        }
        assertBeforeResultWaitCutoff();
        handle = upperAdapter.oneshotStart({
          tier: 'upper',
          prompt,
          timeoutMs: COACH_GENERATION_MS,
        });
        let interrupt;
        const interrupted = new Promise((_, reject) => {
          interrupt = (code = 'COACH_HEARTBEAT_TIMEOUT') => reject(codedError(
            code,
            code === 'COACH_RESULT_ACCEPTED'
              ? '코치 heartbeat가 준비된 결과를 승격했습니다.'
              : '코치 heartbeat deadline이 만료됐습니다.',
          ));
        });
        // bind-handle is awaited before Promise.race below. Observe the interrupt Promise
        // immediately so a cutoff/heartbeat rejection during that child cannot be unhandled.
        interrupted.catch(() => {});
        const record = { handNo, generation: currentDescriptor.generation, attempt, handle, interrupt };
        coachAttempts.set(coachAttemptKey(handNo, currentDescriptor.generation), record);
        await runCoachBeforeResultCutoff([
          'bind-handle',
          '--owner', owner,
          '--hand', String(handNo),
          '--generation', String(currentDescriptor.generation),
          '--handle', `${handle.pid}:${handle.startTime}`,
        ]);
        const completed = await Promise.race([handle.done, interrupted]);
        assertBeforeResultWaitCutoff();
        const note = validateCoachNote(completed?.raw, handNo, deny.literals);
        writeJsonAtomic(currentDescriptor.exactResultPath, note);
        await runCoachBeforeResultCutoff([
          'accept',
          '--owner', owner,
          '--hand', String(handNo),
          '--generation', String(currentDescriptor.generation),
          '--forbidden-file', deny.path,
        ]);
        accepted = true;
        // A cutoff between accept and publish leaves this hand in the authority Q; the
        // post-cutoff residual drain owns it from there.
        if (!coachPublicationDeferred()) await executeCoachPublish(handNo, currentDescriptor.exactEnvelopePath);
        return;
      } catch (error) {
        if (error.code === 'COACH_RESULT_ACCEPTED') return;
        heartbeatTimedOut = error.code === 'COACH_HEARTBEAT_TIMEOUT';
        if (accepted) throw error;
        if (coachWorkSuspended()) return;
        const termination = handle && typeof handle.terminate === 'function'
          ? await handle.terminate()
          : { confirmed: false };
        // Only the boolean confirmation authorizes replacement. `reason` is diagnostic,
        // never a hidden success signal.
        if (termination?.confirmed !== true) {
          if (!heartbeatTimedOut) {
            try {
              await runCoachBeforeResultCutoff([
                'fence',
                '--owner', owner,
                '--hand', String(handNo),
                '--generation', String(currentDescriptor.generation),
                '--reason', 'termination-unconfirmed',
              ]);
            } catch (fenceError) {
              // heartbeat may retire this exact generation while terminate() is still
              // pending. STALE_GENERATION then means there is no live generation left to
              // fence; it must not skip the fail-closed adapter transition below.
              if (fenceError.code !== 'STALE_GENERATION') throw fenceError;
              log('coach-fence-already-retired', {
                handNo,
                generation: currentDescriptor.generation,
              });
            }
          }
          await runCoachBeforeResultCutoff([
            'adapter-disable',
            '--owner', owner,
            '--reason', 'termination-unconfirmed',
          ]);
          coachAdapterDisabled = true;
          await completeCoachUnavailable({
            owner,
            handNo,
            generation: currentDescriptor.generation,
            reason: 'termination-unconfirmed',
            fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
          });
          return;
        }
        if (coachWorkSuspended()) return;
        if (attempt === 1) {
          if (!coachReplacementAllowed()) {
            appendNotice(`핸드 ${handNo} 코치 교체 예산(5초)이 남지 않아 고정 문구로 대체합니다.`);
            await completeCoachUnavailable({
              owner,
              handNo,
              generation: currentDescriptor.generation,
              reason: 'finalize-no-replacement-budget',
              fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
            });
            return;
          }
          try {
            if (coachWorkSuspended()) return;
            descriptor = await reserveCoach(owner, handNo, 2, inputs.stats.path);
          } catch (reserveError) {
            if (reserveError.code !== 'ADAPTER_DISABLED') throw reserveError;
            coachAdapterDisabled = true;
            try {
              await runCoachBeforeResultCutoff([
                'fence',
                '--owner', owner,
                '--hand', String(handNo),
                '--generation', String(currentDescriptor.generation),
                '--reason', 'adapter-disabled-before-attempt-2',
              ]);
            } catch (fenceError) {
              if (fenceError.code !== 'STALE_GENERATION') throw fenceError;
            }
            await completeCoachUnavailable({
              owner,
              handNo,
              generation: currentDescriptor.generation,
              reason: 'adapter-disabled-before-attempt-2',
              fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
            });
            return;
          }
          continue;
        }
        await completeCoachUnavailable({
          owner,
          handNo,
          generation: currentDescriptor.generation,
          reason: error.code ?? 'invalid-coach-output',
          fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
        });
        return;
      } finally {
        const key = coachAttemptKey(handNo, currentDescriptor.generation);
        if (coachAttempts.get(key)?.handle === handle) {
          coachAttempts.delete(key);
        }
      }
    }
  };

  const trackCoachTask = (handNo, work) => {
    let task;
    task = Promise.resolve()
      .then(() => (typeof work === 'function' ? work() : work))
      .catch((error) => {
        appendNotice(`핸드 ${handNo} 코치 파이프라인 오류: ${error.code ?? 'ERROR'}`);
        log('coach-error', { handNo, code: error.code ?? 'ERROR' });
      })
      .finally(() => coachTasks.delete(task));
    coachTasks.add(task);
    return task;
  };

  const launchCoachPipeline = (handNo, options = {}) => (
    trackCoachTask(handNo, () => coachPipeline(handNo, options))
  );

  const publishQueuedCoachHand = async (handNo) => {
    const exactEnvelopePath = coachEnvelopePathFor(handNo);
    if (exactEnvelopePath && !coachPublicationDeferred()) await executeCoachPublish(handNo, exactEnvelopePath);
  };

  const drainQueuedCoachPublications = async ({ reconcileOnly = false } = {}) => {
    const attemptPath = path.join(root, '.publish-attempt.json');
    // begin-owner also reconciles under the authority lock, but keep this boundary
    // explicit: no queued envelope may reach the network before the latest snapshot has
    // had a reconcile-only chance to prove it was already published.
    await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
    for (;;) {
      const auth = readCoachAuthority();
      const queued = Object.values(auth?.publishQueue ?? {})
        .sort((left, right) => left.handNo - right.handNo)[0];
      if (!queued) return;
      if (reconcileOnly) {
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${queued.handNo} 코치 Q의 reconcile 증명을 아직 확인하지 못했습니다.`,
        );
      }
      if (fs.existsSync(attemptPath)) {
        let attemptedCoachQueueId = null;
        try {
          const record = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
          if (typeof record?.coachAuthority?.queueId === 'string') {
            attemptedCoachQueueId = record.coachAuthority.queueId;
          }
        } catch {
          // publish.js owns malformed/stale attempt classification and recovery codes.
        }
        // The recorded body owns the current publishId regardless of which queued hand
        // supplied --from. Retry it first, then re-read authority before choosing a Q.
        await executePublish(['--from', queued.exactEnvelopePath, '--retry']);
        await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
        if (attemptedCoachQueueId) {
          const pending = Object.values(readCoachAuthority()?.publishQueue ?? {})
            .find((item) => item.queueId === attemptedCoachQueueId);
          if (pending) {
            throw codedError(
              'COACH_RECONCILE_PENDING',
              `핸드 ${pending.handNo} 코치 게시는 응답했지만 reconcile 증명을 확인하지 못했습니다.`,
            );
          }
        }
        continue;
      }
      await executeCoachPublish(queued.handNo, queued.exactEnvelopePath);
      let remaining = readCoachAuthority()?.publishQueue?.[String(queued.handNo)];
      if (remaining?.queueId === queued.queueId) {
        await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
        remaining = readCoachAuthority()?.publishQueue?.[String(queued.handNo)];
      }
      if (remaining?.queueId === queued.queueId) {
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${queued.handNo} 코치 Q 게시 후 reconcile 증명을 확인하지 못했습니다.`,
        );
      }
    }
  };

  const beginCoachOwner = async (completed, { drainQueued = true } = {}) => {
    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') throw codedError('NO_COACH_OWNER', '코치 ownerSessionId가 없습니다.');
    const reconcileOnly = readLoopState()?.halt?.code === 'COACH_RECONCILE_PENDING';
    const stats = await captureCoachStats('owner', { beforeResultCutoff: true });
    const begun = await runCoachBeforeResultCutoff([
      'begin-owner',
      '--owner', owner,
      '--completed', String(completed),
      '--stats-file', stats.path,
      '--snapshot-file', coachSnapshotPath,
    ]);
    if (begun.adapterState === 'disabled' || begun.adapterState === 'unavailable') {
      coachAdapterDisabled = true;
    }
    // begin-owner has already reconciled the snapshot and atomically selected missing
    // descriptors. Existing owner-neutral Q must become visible before any new worker or
    // turn publication can overtake it; sealedSkipped is never a spawn list.
    if (drainQueued) {
      try {
        await drainQueuedCoachPublications({ reconcileOnly });
      } catch (error) {
        if (error.code === 'COACH_RECONCILE_PENDING') {
          writeLoopState({
            halt: {
              code: 'COACH_RECONCILE_PENDING',
              message: error.message,
            },
          });
        }
        throw error;
      }
      if (readLoopState()?.halt?.code === 'COACH_RECONCILE_PENDING') {
        writeLoopState({ halt: undefined });
      }
    }
    for (const descriptor of begun.descriptors ?? []) {
      if (stopRequested) break;
      const hand = await captureCoachHand(descriptor.handNo, { beforeResultCutoff: true });
      if (stopRequested) break;
      launchCoachPipeline(descriptor.handNo, {
        descriptor,
        prepared: { hand, stats },
      });
    }
    for (const handNo of begun.unavailableSealed ?? []) {
      if (stopRequested) break;
      trackCoachTask(handNo, () => publishQueuedCoachHand(handNo));
    }
    return begun;
  };

  const fenceHeartbeatGeneration = async (owner, action, reason, { beforeResultCutoff = false } = {}) => {
    try {
      const runner = beforeResultCutoff ? runCoachBeforeResultCutoff : runCoach;
      await runner([
        'fence',
        '--owner', owner,
        '--hand', String(action.handNo),
        '--generation', String(action.generation),
        '--reason', reason,
      ]);
    } catch (error) {
      if (error.code !== 'STALE_GENERATION') throw error;
    }
  };

  const remediateHeartbeatAction = async (owner, action) => {
    assertBeforeResultWaitCutoff();
    const record = coachAttempts.get(coachAttemptKey(action.handNo, action.generation));
    if (action.action === 'timeout-fence') {
      if (record) record.interrupt();
      else {
        await completeCoachUnavailable({
          owner,
          handNo: action.handNo,
          generation: action.generation,
          reason: 'heartbeat-timeout',
        });
      }
      return;
    }
    if (action.action !== 'result-ready') return;

    let accepted = false;
    try {
      const deny = writeCoachDeny(action.handNo);
      await runCoachBeforeResultCutoff([
        'accept',
        '--owner', owner,
        '--hand', String(action.handNo),
        '--generation', String(action.generation),
        '--forbidden-file', deny.path,
      ]);
      accepted = true;
      await publishQueuedCoachHand(action.handNo);
    } catch (error) {
      if (!record) throw error;
      const termination = await record.handle.terminate();
      if (accepted) {
        if (termination?.confirmed !== true) {
          await runCoachBeforeResultCutoff([
            'adapter-disable',
            '--owner', owner,
            '--reason', 'result-ready-termination-unconfirmed',
          ]);
          coachAdapterDisabled = true;
        }
        record.interrupt('COACH_RESULT_ACCEPTED');
        throw error;
      }
      await fenceHeartbeatGeneration(owner, action, 'result-ready-accept-failed', { beforeResultCutoff: true });
      if (termination?.confirmed !== true) {
        await runCoachBeforeResultCutoff([
          'adapter-disable',
          '--owner', owner,
          '--reason', 'result-ready-termination-unconfirmed',
        ]);
        coachAdapterDisabled = true;
      }
      await completeCoachUnavailable({
        owner,
        handNo: action.handNo,
        generation: action.generation,
        reason: error.code ?? 'result-ready-accept-failed',
      });
      record.interrupt('COACH_RESULT_ACCEPTED');
      return;
    }

    if (record) {
      const termination = await record.handle.terminate();
      if (termination?.confirmed !== true) {
        await runCoachBeforeResultCutoff([
          'adapter-disable',
          '--owner', owner,
          '--reason', 'result-ready-termination-unconfirmed',
        ]);
        coachAdapterDisabled = true;
      }
      record.interrupt('COACH_RESULT_ACCEPTED');
    }
  };

  const heartbeatCoach = async () => {
    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') return;
    // A fresh game has no authority until its first reserve/unavailable seal. There is
    // nothing to heartbeat before then, and manufacturing it during bootstrap would make
    // game startup depend on the publication lock.
    if (!fs.existsSync(coachAuthorityPath)) return;
    const heartbeat = await runCoachBeforeResultCutoff(['heartbeat', '--owner', owner]);
    if (stopRequested) return;
    for (const action of heartbeat.actions ?? []) {
      if (stopRequested) break;
      log('coach-heartbeat', {
        handNo: action.handNo,
        action: action.action,
        generation: action.generation,
      });
      trackCoachTask(action.handNo, () => remediateHeartbeatAction(owner, action));
    }
  };

  const settleCoachTasks = async (deadlineNs) => {
    for (;;) {
      if (coachTasks.size === 0) return true;
      const remaining = remainingMsUntil(deadlineNs);
      if (remaining <= 0) return false;
      await settleOrTimeout(Promise.allSettled([...coachTasks]), remaining);
    }
  };

  // §9.2 (3): the sidecar owns termination; coach-control only records the boolean the
  // sidecar proves here. Only a positive confirmation authorizes an open review gate —
  // an unconfirmed worker is fenced and disables the adapter exactly as in play time.
  const terminateLiveCoachGenerations = async (owner, deadlineNs) => {
    const records = [...coachAttempts.values()];
    const outcomes = await Promise.all(records.map(async (record) => {
      let invocation;
      try {
        invocation = record.handle.terminate();
      } catch (error) {
        invocation = Promise.reject(error);
      }
      const settled = await settleValueBeforeDeadline(invocation, deadlineNs);
      if (settled.error) {
        log('finalize-terminate-error', {
          handNo: record.handNo,
          code: settled.error.code ?? 'ERROR',
        });
      }
      return {
        record,
        confirmed: settled.settled && !settled.error && settled.value?.confirmed === true,
      };
    }));

    let confirmed = true;
    for (const outcome of outcomes) {
      if (!outcome.confirmed) confirmed = false;
      outcome.record.interrupt('COACH_FINALIZE_CUTOFF');
    }
    if (!confirmed && remainingMsUntil(deadlineNs) > 0) {
      for (const outcome of outcomes.filter((row) => !row.confirmed)) {
        await fenceHeartbeatGeneration(
          owner,
          { handNo: outcome.record.handNo, generation: outcome.record.generation },
          'finalize-termination-unconfirmed',
        );
      }
      await runCoach([
        'adapter-disable',
        '--owner', owner,
        '--reason', 'finalize-termination-unconfirmed',
      ]);
      coachAdapterDisabled = true;
    }
    const tasksSettled = await settleCoachTasks(deadlineNs);
    return confirmed
      && tasksSettled
      && coachAttempts.size === 0
      && coachTasks.size === 0;
  };

  const haltFinalization = (code, message) => {
    appendNotice(message);
    writeLoopState({ halt: { code, message } });
    log('finalize-halt', { code });
    return codedError(code, message);
  };

  const persistedCoachRecovery = ({ owner, unresolved }) => {
    const commands = unresolved
      .filter((attempt) => attempt.cleanupAuthorized)
      .map((attempt) => ({
        program: process.execPath,
        args: [
          COACH_CLI, 'cleanup-result',
          '--owner', owner,
          '--hand', String(attempt.handNo),
          '--generation', String(attempt.generation),
          '--cleanup-state', 'released',
          '--game-dir', root,
        ],
      }));
    return {
      code: 'COACH_HANDLE_UNRESOLVED',
      owner,
      attempts: unresolved,
      prerequisites: {
        authenticatedServerLock: true,
        sessionToken: readLoopState()?.sessionToken ?? null,
      },
      commands,
    };
  };

  const haltForPersistedCoachRecovery = ({ owner, unresolved }) => {
    const recovery = persistedCoachRecovery({ owner, unresolved });
    const commands = recovery.commands;
    const message = commands.length > 0
      ? 'persisted 코치 handle identity를 확인할 수 없어 owner 교대를 중단합니다. 같은 sessionToken의 인증 server lock을 복구하고 halt.recovery.commands를 검토·실행한 뒤 resume하세요.'
      : 'persisted 코치 handle identity와 cleanup owner를 확인할 수 없어 owner 교대를 중단합니다. authority 수동 복구가 필요합니다.';
    appendNotice(message);
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        cutoff: {
          ...(current.cutoff ?? {}),
          at: isoNow(now),
          terminationConfirmed: false,
          reason: 'persisted_worker_unresolved',
          reviewGate: 'closed',
        },
        recovery,
      },
      halt: { code: 'FINALIZATION_ABORTED', message, recovery },
    });
    log('finalize-halt', { code: 'FINALIZATION_ABORTED', reason: 'persisted_worker_unresolved' });
    return codedError('FINALIZATION_ABORTED', message, { recovery });
  };

  const haltForPlayingCoachRecovery = ({ owner, unresolved }) => {
    const recovery = persistedCoachRecovery({ owner, unresolved });
    const message = recovery.commands.length > 0
      ? 'persisted 코치 handle identity를 확인할 수 없어 playing owner 교대를 중단합니다. 인증 server lock 아래 cleanup-result를 검토·실행한 뒤 resume하세요.'
      : 'persisted 코치 authority 또는 handle을 확인할 수 없어 playing owner 교대를 중단합니다. 수동 복구가 필요합니다.';
    appendNotice(message);
    writeLoopState({ halt: { code: 'COACH_HANDLE_UNRESOLVED', message, recovery } });
    log('resume-halt', { code: 'COACH_HANDLE_UNRESOLVED' });
    return codedError('COACH_HANDLE_UNRESOLVED', message, { recovery });
  };

  const clearPlayingCoachRecoveryHalt = () => {
    if (readLoopState()?.halt?.code === 'COACH_HANDLE_UNRESOLVED') {
      writeLoopState({ halt: undefined });
    }
  };

  const baseFinalizationCheckpoint = () => ({
    startedAt: finalizationDeadlineStartedAt ?? isoNow(now),
    budgetMs: finalizeBudgetMs,
    resultWaitMs: finalizeBudgetMs - finalizeCutoffLeadMs,
  });

  const enterReviewGenerationScope = async (completed) => {
    // The 20-second coach-cutoff budget ends at the open review gate. Evaluator and
    // synthesizer calls in Task 7B own independent 300-second generation deadlines.
    finalizationDeadlineNs = null;
    finalizationDeadlineStartedAt = null;
    finalizeResultWaitCutoffNs = null;
    publishDeadlineNs = null;
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        deadlineScope: 'review_generation',
        reviewGenerationTimeoutMs: REVIEW_GENERATION_MS,
      },
    });
    await opts.reviewGateCheckpoint?.();
    // A fresh child after the reset is the handoff proof: it must not inherit the expired
    // cutoff supervisor timeout, and it revalidates the durable authority gate for 7B.
    const handoff = await runCoach(['completeness', '--completed', String(completed)]);
    if (handoff.reviewGateOpen !== true) {
      throw haltFinalization(
        'REVIEW_GATE_CLOSED',
        'Task 7B handoff에서 코치 completeness review gate를 재확인하지 못했습니다.',
      );
    }
    const refreshed = readLoopState()?.finalization ?? {};
    writeLoopState({
      finalization: {
        ...refreshed,
        reviewHandoff: { at: isoNow(now), reviewGateOpen: true },
      },
    });
    return handoff;
  };

  const validateReviewOutput = (raw, { requireHeadings = false } = {}) => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw codedError('INVALID_REVIEW_OUTPUT', '리뷰 모델 출력이 비어 있습니다.');
    }
    const text = raw.trim();
    if (requireHeadings && REVIEW_HEADING_PATTERNS.some((pattern) => !pattern.test(text))) {
      throw codedError('INVALID_REVIEW_OUTPUT', '종합 리뷰에 필수 한국어 heading 네 개가 없습니다.');
    }
    return text;
  };

  const terminateReviewAttempt = async (handle) => {
    if (!handle) return { confirmed: true, reason: 'NOT_SPAWNED' };
    if (typeof handle.terminate !== 'function') {
      return { confirmed: false, reason: 'TERMINATE_UNAVAILABLE' };
    }
    try {
      const result = await handle.terminate();
      return result && typeof result === 'object'
        ? result
        : { confirmed: false, reason: 'BAD_TERMINATE_RESULT' };
    } catch (error) {
      return { confirmed: false, reason: error.code ?? 'TERMINATE_FAILED' };
    }
  };

  const runReviewStage = async ({ stage, prompt, requireHeadings = false }) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let handle = null;
      let failure = null;
      try {
        handle = upperAdapter.oneshotStart({
          tier: 'upper',
          prompt,
          timeoutMs: REVIEW_GENERATION_MS,
        });
        if (!handle || !handle.done || typeof handle.done.then !== 'function') {
          throw codedError('INVALID_REVIEW_HANDLE', `${stage} oneshot handle 계약이 올바르지 않습니다.`);
        }
        const completed = await handle.done;
        return validateReviewOutput(completed?.raw, { requireHeadings });
      } catch (error) {
        failure = error;
      }

      // Each failed attempt owns a distinct child and distinct 300-second adapter timer.
      // A second child may start only after the first child has positively terminated.
      const termination = await terminateReviewAttempt(handle);
      log('review-attempt-failed', {
        stage,
        attempt,
        code: failure?.code ?? 'ERROR',
        terminationConfirmed: termination.confirmed === true,
      });
      if (attempt === 1 && termination.confirmed === true) continue;
      if (attempt === 1) {
        throw codedError(
          'REVIEW_TERMINATION_UNCONFIRMED',
          `${stage} 첫 시도 종료를 확인하지 못해 교체 시도를 시작하지 않습니다.`,
          { cause: failure },
        );
      }
      throw codedError(
        'REVIEW_ATTEMPTS_EXHAUSTED',
        `${stage} 출력이 두 번 모두 계약을 만족하지 못했습니다.`,
        { cause: failure },
      );
    }
    throw codedError('REVIEW_ATTEMPTS_EXHAUSTED', `${stage} 시도를 완료하지 못했습니다.`);
  };

  const buildEvaluatorPrompt = ({ completed, hands, statsRaw }) => [
    '역할: 격리 evaluator',
    '아래 인라인 입력만 사용하고 파일·도구·네트워크를 조회하지 마라.',
    '각 결정 시점에 사용자가 볼 수 있었던 공개 정보만으로 과정 품질을 한국어로 평가하라.',
    '실제 게임 결과와 players.json/상대 아키타입은 제공되지 않았으며 추측하거나 언급하지 마라.',
    '표본이 30핸드 미만이면 반드시 참고용이라고 명시하라.',
    '',
    `completed hands: ${completed}`,
    ...hands.flatMap(({ handNo, raw }) => [
      '',
      `hand ${handNo} (redacted):`,
      raw,
    ]),
    '',
    'stats:',
    statsRaw,
    '',
    '출력은 비어 있지 않은 한국어 과정 평가 본문만 작성하라.',
  ].join('\n');

  const buildSynthesizerPrompt = ({ evaluator, result, playersRaw }) => [
    '역할: 종합자',
    '아래 인라인 입력만 사용하고 파일·도구·네트워크를 조회하지 마라.',
    'evaluator의 결과 독립적 과정 평가를 보존한 뒤 게임 결과와 실제 AI 아키타입을 분리해 해석하라.',
    '결과가 좋았다고 나쁜 과정을 칭찬하거나 결과가 나쁘다고 좋은 과정을 비난하지 마라.',
    '',
    'evaluator output:',
    evaluator,
    '',
    'game result:',
    JSON.stringify({ result }),
    '',
    'players.json:',
    playersRaw,
    '',
    '마크다운 본문에 다음 네 heading을 모두 그대로 포함하라:',
    '## 내 성향 통계',
    '## 결정적 핸드 2~3개 리플레이',
    '## 각 AI의 실제 아키타입 공개 + 읽기 평가',
    '## 다음 게임에서 연습할 것',
    '마지막 항목에는 다음 게임에서 연습할 것 1~2가지를 제시하라.',
  ].join('\n');

  const generateReview = async ({ completed, statsRaw }) => {
    try {
      const hands = [];
      for (let handNo = 1; handNo <= completed; handNo += 1) {
        const captured = semanticChildPayload(await runCli(['hand', String(handNo), '--redacted']));
        hands.push({ handNo, raw: JSON.stringify(captured) });
      }
      const evaluatorPrompt = buildEvaluatorPrompt({ completed, hands, statsRaw });
      const evaluator = await runReviewStage({
        stage: 'evaluator',
        prompt: evaluatorPrompt,
      });

      const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
      const players = readJsonOptional(playersPath, 'PLAYERS');
      if (!engine || engine.gameOver !== true || typeof engine.result !== 'string') {
        throw codedError('BAD_REVIEW_RESULT', '종합 리뷰에 필요한 종료 결과가 없습니다.');
      }
      if (!Array.isArray(players)) {
        throw codedError('BAD_PLAYERS', '종합 리뷰에 필요한 players.json이 배열이 아닙니다.');
      }
      const synthesizerPrompt = buildSynthesizerPrompt({
        evaluator,
        result: engine.result,
        playersRaw: JSON.stringify(players),
      });
      return await runReviewStage({
        stage: 'synthesizer',
        prompt: synthesizerPrompt,
        requireHeadings: true,
      });
    } catch (error) {
      throw haltFinalization(
        'REVIEW_FAILED',
        `종합 리뷰 생성을 완료하지 못했습니다(${error.code ?? 'ERROR'}). 게임 상태와 코치 노트는 그대로 남습니다.`,
      );
    }
  };

  const checkpointGeneratedReview = (review) => {
    writeTextAtomic(reviewPath, review);
    const persisted = fs.readFileSync(reviewPath, 'utf8');
    const reviewSha256 = sha256Text(persisted);
    return writeLoopState({
      phase: 'review_generated',
      reviewSha256,
      halt: undefined,
    });
  };

  const readGeneratedReview = () => {
    const state = readLoopState();
    let review;
    try {
      review = fs.readFileSync(reviewPath, 'utf8');
    } catch (error) {
      throw haltFinalization(
        'REVIEW_FAILED',
        `review_generated 체크포인트의 review.md를 읽지 못했습니다(${error.code ?? 'ERROR'}). 재생성하지 않습니다.`,
      );
    }
    let validated;
    try {
      validated = validateReviewOutput(review, { requireHeadings: true });
    } catch (error) {
      throw haltFinalization(
        'REVIEW_FAILED',
        `review_generated 체크포인트의 review.md가 검증에 실패했습니다(${error.code ?? 'ERROR'}). 재생성하지 않습니다.`,
      );
    }
    if (validated !== review || state?.reviewSha256 !== sha256Text(review)) {
      throw haltFinalization(
        'REVIEW_FAILED',
        'review_generated 체크포인트의 review.md digest가 일치하지 않아 재생성·게시하지 않습니다.',
      );
    }
    return { review, reviewSha256: state.reviewSha256 };
  };

  const snapshotReviewStatus = (reviewSha256) => {
    const snapshot = readJsonOptional(coachSnapshotPath, 'UI_SNAPSHOT');
    const matches = typeof snapshot?.review === 'string'
      && sha256Text(snapshot.review) === reviewSha256;
    return {
      matches,
      publishId: Number.isInteger(snapshot?.publishId) ? snapshot.publishId : null,
    };
  };

  const checkpointReviewPublished = ({ publishId = null } = {}) => writeLoopState({
    phase: 'review_published',
    ...(Number.isInteger(publishId) ? { lastPublishId: publishId } : {}),
    halt: undefined,
  });

  const publishGeneratedReview = async () => {
    const generated = readGeneratedReview();
    writeJsonAtomic(reviewEnvelopePath, { review: generated.review });

    // One loop step resolves either an already-recorded exact body or creates the review
    // attempt. Before every new body, compare the durable snapshot digest so an ack that
    // landed before the phase write never burns a second publishId.
    for (let step = 0; step < 4; step += 1) {
      const retry = fs.existsSync(publishAttemptPath);
      if (!retry) {
        const before = snapshotReviewStatus(generated.reviewSha256);
        if (before.matches) {
          // postPublish() persists the snapshot before publish.js removes its attempt.
          // Recheck that no recorded body appeared across the digest read; such a body
          // must be retried (same publishId) rather than abandoned at done.
          if (fs.existsSync(publishAttemptPath)) continue;
          return checkpointReviewPublished({ publishId: before.publishId });
        }
      }
      let published;
      try {
        published = await executePublish([
          '--from', reviewEnvelopePath,
          ...(retry ? ['--retry'] : []),
        ]);
      } catch (error) {
        // A publisher may win the attempt-file race after the check above. The next loop
        // iteration sees that record and resolves it with --retry before our review body.
        if (error.code === 'ATTEMPT_PENDING') continue;
        throw haltFinalization(
          'REVIEW_FAILED',
          `종합 리뷰 게시를 완료하지 못했습니다(${error.code ?? 'ERROR'}). review_generated에서 재개할 수 있습니다.`,
        );
      }
      if (Number.isInteger(published?.publishId)) writeLoopState({ lastPublishId: published.publishId });
      if (!retry) {
        const afterPublish = snapshotReviewStatus(generated.reviewSha256);
        if (!afterPublish.matches) {
          throw haltFinalization(
            'REVIEW_FAILED',
            '종합 리뷰 non-retry 게시 응답 뒤 ui-snapshot digest가 일치하지 않아 새 publishId 없이 review_generated에서 멈춥니다.',
          );
        }
        return checkpointReviewPublished({ publishId: afterPublish.publishId });
      }
    }

    const after = snapshotReviewStatus(generated.reviewSha256);
    if (!after.matches) {
      throw haltFinalization(
        'REVIEW_FAILED',
        '종합 리뷰 게시 응답 뒤 ui-snapshot digest를 확인하지 못해 review_generated에서 멈춥니다.',
      );
    }
    return checkpointReviewPublished({ publishId: after.publishId });
  };

  const finishDoneLifecycle = async () => {
    const current = readLoopState();
    try {
      fs.unlinkSync(sessionsPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        persistCleanupFailure(error);
        throw error;
      }
    }
    playerSessions = null;
    restoredPlayerSessions.clear();
    const finalStatePatch = () => ({
      phase: 'done',
      finishedAt: current?.finishedAt ?? isoNow(now),
      halt: undefined,
    });
    if (typeof opts.beforeDoneRequestStop === 'function') opts.beforeDoneRequestStop();
    await requestStop({ finalStatePatch });
    return readLoopState() ?? current;
  };

  const abortExpiredFinalization = () => {
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        cutoff: {
          ...(current.cutoff ?? {}),
          at: isoNow(now),
          terminationConfirmed: false,
          reason: 'deadline_exceeded',
          reviewGate: 'closed',
        },
      },
    });
    return haltFinalization(
      'FINALIZATION_ABORTED',
      'finalization 공통 deadline이 만료돼 리뷰 게이트를 열지 않습니다.',
    );
  };

  const abortResultWaitCutoff = () => {
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        cutoff: {
          ...(current.cutoff ?? {}),
          at: isoNow(now),
          terminationConfirmed: false,
          reason: 'result_wait_cutoff_exceeded',
          reviewGate: 'closed',
        },
      },
    });
    return haltFinalization(
      'FINALIZATION_ABORTED',
      'finalization result-wait cutoff 안에 owner/coach 사전 작업을 완료하지 못해 중단합니다.',
    );
  };

  const abortCompletedHandAuthority = (reason, message, terminationConfirmed) => {
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        cutoff: {
          ...(current.cutoff ?? {}),
          at: isoNow(now),
          terminationConfirmed,
          reason,
          reviewGate: 'closed',
        },
      },
    });
    return haltFinalization('FINALIZATION_ABORTED', message);
  };

  const completedHandFromEngine = (terminationConfirmed) => {
    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    const completed = engine?.lastHand?.handNo;
    if (!Number.isSafeInteger(completed) || completed < 0) {
      throw abortCompletedHandAuthority(
        'invalid_engine_last_hand',
        '종료 engine lastHand.handNo가 안전한 0 이상 정수가 아니어서 리뷰 게이트를 열지 않습니다.',
        terminationConfirmed,
      );
    }
    return completed;
  };

  const assertStatsCompletedHand = (completed, statsRaw, terminationConfirmed) => {
    let sample;
    try {
      sample = JSON.parse(statsRaw)?.perPlayer?.user?.sample;
    } catch {
      sample = undefined;
    }
    if (!Number.isSafeInteger(sample) || sample < 0) {
      throw abortCompletedHandAuthority(
        'invalid_stats_sample',
        'stats user.sample이 안전한 0 이상 정수가 아니어서 리뷰 게이트를 열지 않습니다.',
        terminationConfirmed,
      );
    }
    if (sample !== completed) {
      throw abortCompletedHandAuthority(
        'completed_stats_disagreement',
        `engine lastHand.handNo(${completed})와 stats user.sample(${sample})이 일치하지 않아 리뷰 게이트를 열지 않습니다.`,
        terminationConfirmed,
      );
    }
  };

  const translateFinalizationDeadline = (error) => {
    if (error?.code === 'FINALIZATION_RESULT_WAIT_CUTOFF') return abortResultWaitCutoff();
    if (error?.code !== 'FINALIZATION_DEADLINE_EXCEEDED') return error;
    return abortExpiredFinalization();
  };

  // 종료 시퀀스 §5/§9.2. Phase는 이미 finalizing이고, 각 단계가 loop-state 체크포인트다.
  const finalize = async () => {
    if (readLoopState()?.phase !== 'finalizing') {
      throw codedError(
        'BAD_LOOP_PHASE',
        'finalize는 finalizing phase에서만 실행할 수 있습니다.',
      );
    }
    // finalDeadline/resultWaitCutoff는 owner transfer를 포함한 이 종료 시도에서 한
    // 번만 정한다. finalizing resume은 begin-owner 전에 이미 같은 값을 설치한다.
    const {
      deadlineNs: finalDeadlineNs,
      resultWaitCutoffNs,
    } = ensureFinalizationResultWaitCutoff();
    const checkpoint = baseFinalizationCheckpoint();
    writeLoopState({ finalization: checkpoint });
    log('finalize-start', { budgetMs: finalizeBudgetMs, resultWaitMs: checkpoint.resultWaitMs });

    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') {
      throw codedError('NO_COACH_OWNER', '코치 ownerSessionId가 없습니다.');
    }

    // (1) heartbeat의 result-ready/timeout-fence와 이미 쓰인 result를 먼저 소비한다.
    try {
      await heartbeatCoach();
    } catch (error) {
      appendNotice(`코치 heartbeat 오류: ${error.code ?? 'ERROR'}`);
      log('coach-heartbeat-error', { phase: 'finalizing', code: error.code ?? 'ERROR' });
    }
    if (stopRequested) return readLoopState();

    // (2) running generation은 cutoff까지만 기다린다.
    const settled = await settleCoachTasks(resultWaitCutoffNs);
    log('finalize-coach-settled', { settled, pending: coachTasks.size });
    if (stopRequested) return readLoopState();

    // (3) cutoff: 새 play-time publisher 금지 + live worker 종료 확인.
    finalizationCutoff = true;
    const signalAuthority = persistedCoachAttempts();
    if (signalAuthority.authorityError) {
      throw haltForPersistedCoachRecovery({
        owner: signalAuthority.owner,
        unresolved: [{
          handNo: null,
          generation: null,
          cleanupAuthorized: false,
          ...signalAuthority.authorityError,
        }],
      });
    }
    const trackedTerminationConfirmed = await terminateLiveCoachGenerations(owner, finalDeadlineNs);
    const postCutoffPersisted = remainingMsUntil(finalDeadlineNs) > 0
      ? await closePersistedCoachWorkers({ allowCurrentReservedWithoutHandle: true })
      : { confirmed: false, unresolved: [] };
    const terminationConfirmed = finalizationPriorTerminationConfirmed
      && trackedTerminationConfirmed
      && postCutoffPersisted.confirmed
      && coachAttempts.size === 0
      && coachTasks.size === 0;
    assertFinalizationDeadline();

    // (4) 한 transaction으로 missing 전체를 fence + unavailable Q seal.
    const completed = completedHandFromEngine(terminationConfirmed);
    const stats = await captureCoachStats('final');
    assertStatsCompletedHand(completed, stats.raw, terminationConfirmed);
    let cutoff;
    try {
      cutoff = await runCoach([
        'finalize-cutoff',
        '--owner', owner,
        '--completed', String(completed),
        '--stats-file', stats.path,
        '--snapshot-file', coachSnapshotPath,
        '--termination-confirmed', terminationConfirmed ? 'true' : 'false',
      ]);
    } catch (error) {
      if (error.code !== 'FINALIZATION_ABORTED') throw error;
      const reason = error.envelope?.reason ?? 'unknown';
      writeLoopState({
        finalization: {
          ...checkpoint,
          cutoff: { at: isoNow(now), terminationConfirmed, reason, reviewGate: 'closed' },
        },
      });
      throw haltFinalization(
        'FINALIZATION_ABORTED',
        `코치 finalization이 ${reason}로 중단돼 리뷰 게이트를 열지 않습니다.`,
      );
    }
    const completeness = cutoff.completeness ?? {};
    writeLoopState({
      finalization: {
        ...checkpoint,
        cutoff: {
          at: isoNow(now),
          terminationConfirmed,
          completed,
          sealed: cutoff.sealed ?? [],
          reviewGate: cutoff.reviewGate ?? 'closed',
          pending: completeness.pending ?? [],
          missing: completeness.missing ?? [],
        },
      },
    });
    log('finalize-cutoff', {
      completed,
      sealed: cutoff.sealed ?? [],
      reviewGate: cutoff.reviewGate ?? 'closed',
    });

    // (5) 그 다음에만 남은 예산으로 attempt/Q를 해소한다.
    publishDeadlineNs = finalDeadlineNs;
    try {
      await drainQueuedCoachPublications();
    } catch (error) {
      if (error.code === 'COACH_RECONCILE_PENDING') {
        writeLoopState({
          halt: { code: 'COACH_RECONCILE_PENDING', message: error.message },
        });
      }
      throw error;
    } finally {
      publishDeadlineNs = null;
    }
    log('finalize-drained', { remainingMs: remainingMsUntil(finalDeadlineNs) });

    // (6) missing handNo를 성공처럼 숨기지 않는다.
    if ((cutoff.reviewGate ?? 'closed') !== 'open') {
      const missing = completeness.missing ?? [];
      throw haltFinalization(
        'REVIEW_GATE_CLOSED',
        `코치 봉인이 1..${completed} 핸드를 덮지 못해(누락 ${missing.join(',') || '불명'}) 리뷰를 시작하지 않습니다.`,
      );
    }
    if (!upperAdapter || typeof upperAdapter.oneshotStart !== 'function') {
      throw haltFinalization(
        'REVIEW_FAILED',
        '상위 모델 런타임이 없어 종합 리뷰를 만들지 않습니다. 게임 상태와 코치 노트는 그대로 남습니다.',
      );
    }
    await enterReviewGenerationScope(completed);
    const review = await generateReview({ completed, statsRaw: stats.raw });
    return checkpointGeneratedReview(review);
  };

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

  const persistCleanupFailure = (error) => {
    try {
      if (!fs.existsSync(loopStatePath)) return;
      writeLoopState({
        stopping: true,
        stoppedAt: undefined,
        cleanupFailedAt: isoNow(now),
        cleanupError: {
          code: error.code ?? 'ERROR',
          message: error.message ?? String(error),
        },
      });
    } catch { /* 원래 cleanup failure와 lock ownership을 보존한다 */ }
  };

  const requestStop = ({ finalStatePatch = null } = {}) => {
    if (finalStatePatch !== null) pendingFinalStatePatch = finalStatePatch;
    if (stopPromise) return stopPromise;
    stopRequested = true;
    const attempt = (async () => {
      let stopError = null;
      try {
        if (fs.existsSync(loopStatePath)) {
          writeLoopState({ stopping: true, stoppedAt: undefined, stopRequestedAt: isoNow(now) });
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
      // Coach work is nonblocking only with respect to the next hand. Shutdown still owns
      // every task until the upper adapter has cancelled it and its authority/file work settles.
      await Promise.allSettled([...coachTasks]);
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
      if (!disposalFailure) adapters.clear();
      for (const canary of [...canaries]) {
        try { fs.unlinkSync(canary); } catch (error) {
          if (error.code !== 'ENOENT') {
            stopError ??= error;
            continue;
          }
        }
        canaries.delete(canary);
      }

      if (stopError) {
        persistCleanupFailure(stopError);
        throw stopError;
      }

      if (logFd !== null) {
        try {
          fs.closeSync(logFd);
          logFd = null;
        } catch (error) {
          stopError = error;
        }
      }
      if (stopError) {
        persistCleanupFailure(stopError);
        throw stopError;
      }

      try {
        if (fs.existsSync(loopStatePath)) {
          const resolvedFinalStatePatch = typeof pendingFinalStatePatch === 'function'
            ? pendingFinalStatePatch()
            : (pendingFinalStatePatch ?? {});
          writeLoopState({
            stopping: true,
            stoppedAt: isoNow(now),
            cleanupFailedAt: undefined,
            cleanupError: undefined,
            ...resolvedFinalStatePatch,
          });
        }
        releaseLock();
      } catch (error) {
        persistCleanupFailure(error);
        throw error;
      }
    })();
    stopPromise = attempt;
    attempt.catch(() => {
      // A failed attempt keeps ownership/resources but may be retried after the external
      // condition changes (child exits, signal works, filesystem recovers). Concurrent
      // callers during this attempt still shared the exact same Promise above.
      if (stopPromise === attempt) stopPromise = null;
    });
    return attempt;
  };

  const bootstrap = async ({
    ai,
    stack,
    levelEvery,
    blinds,
    force = false,
    practiceFocusFile,
    preinitialized,
    skipLock = false,
  } = {}) => {
    if (skipLock) {
      if (!lockHandle) throw codedError('LOCKED', 'launcher loop lock handle이 없습니다.');
    } else {
      await acquireLoopLock({ mode: 'bootstrap', force });
    }
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
      const initialized = preinitialized ?? await runCli(initArgs);
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

  const resolveForPhase = async (phase, engineState, existingState, {
    beforePlayerRestore = null,
  } = {}) => {
    if (FINAL_PHASES.has(phase)) {
      if (!engineState) throw codedError('NO_GAME', 'engine state가 없습니다.');
      const resolved = await createCanaryAndResolve('upper-only');
      selectAdapters(resolved ?? {});
      const notices = [
        ...(Array.isArray(existingState.notices) ? existingState.notices : []),
        ...(Array.isArray(resolved?.notices) ? resolved.notices : []),
      ];
      writeLoopState({
        notices,
        upperRuntime: upperAdapter?.kind ?? null,
        ...(RESUMABLE_FINAL_HALTS.has(existingState.halt?.code) ? { halt: undefined } : {}),
      });
      // 종료 시퀀스도 잔여 Q·리뷰를 게시해야 한다. 플레이어 워밍업은 여전히 생략하지만
      // 서버는 이 지점부터 살아 있어야 한다.
      const desiredPort = Number.isSafeInteger(existingState.port) && existingState.port > 0
        ? existingState.port
        : requestedPort;
      const port = await ensureServer(engineState.sessionToken, { port: desiredPort });
      return writeLoopState({ port });
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
    if (typeof beforePlayerRestore === 'function') await beforePlayerRestore();
    await restorePlayers();
    return writeLoopState({ phase: 'playing' });
  };

  const resume = async ({ skipLock = false } = {}) => {
    if (skipLock) {
      if (!lockHandle) throw codedError('LOCKED', 'launcher loop lock handle이 없습니다.');
    } else {
      await acquireLoopLock({ mode: 'resume' });
    }
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
      const priorPlayingRecoveryHalt = state.halt?.code === 'COACH_HANDLE_UNRESOLVED';
      let resumed = await resolveForPhase(phase, engineState, state, {
        beforePlayerRestore: phase === 'playing'
          ? async () => {
            const persisted = await reclaimPersistedCoachWorkersForResume(
              Number(engineState.lastHand?.handNo ?? 0),
            );
            if (!persisted.confirmed) throw haltForPlayingCoachRecovery(persisted);
            if (priorPlayingRecoveryHalt && persisted.authorityPresent !== true) {
              throw codedError(
                'COACH_HANDLE_UNRESOLVED',
                readLoopState()?.halt?.message ?? 'persisted coach recovery evidence가 부족합니다.',
              );
            }
            clearPlayingCoachRecoveryHalt();
          }
          : null,
      });
      // §5 finalizing 1: --resume으로 종료 국면에 들어온 경우에만 owner를 교체한다.
      // begin-owner가 seal/Q에 없는 핸드만 새 descriptor로 돌려주므로, 살아 있는
      // generation이 없는 크래시 재개에서만 그 핸드를 다시 스폰한다.
      if (resumed.phase === 'playing') {
        await beginCoachOwner(Number(engineState.lastHand?.handNo ?? 0));
        resumed = readLoopState();
      } else if (resumed.phase === 'finalizing') {
        ensureFinalizationResultWaitCutoff();
        const persisted = await closePersistedCoachWorkers();
        finalizationPriorTerminationConfirmed = persisted.confirmed;
        if (!persisted.confirmed) throw haltForPersistedCoachRecovery(persisted);
        await beginCoachOwner(
          Number(engineState.lastHand?.handNo ?? 0),
          { drainQueued: false },
        );
        resumed = readLoopState();
      }
      resumeEntryPending = resumed.phase === 'playing';
      log('resume-ready', { phase: resumed.phase });
      return resumed;
    } catch (error) {
      const translated = translateFinalizationDeadline(error);
      if (lifecycleStarted) await requestStop();
      else releaseLock();
      throw translated;
    }
  };

  const runFinalization = async () => {
    try {
      let state = readLoopState();
      if (state?.phase === 'finalizing') {
        await finalize();
        state = readLoopState();
      }
      if (state?.phase === 'review_generated') {
        await publishGeneratedReview();
        state = readLoopState();
      }
      if (state?.phase === 'review_published') return finishDoneLifecycle();
      if (state?.phase === 'done') return finishDoneLifecycle();
      if (stopRequested) return readLoopState() ?? state;
      throw codedError('BAD_LOOP_PHASE', `종료 시퀀스를 재개할 수 없는 phase: ${state?.phase ?? '없음'}`);
    } catch (error) {
      throw translateFinalizationDeadline(error);
    }
  };

  const run = async () => {
    let state = readLoopState();
    if (!state) throw codedError('NOT_BOOTSTRAPPED', 'bootstrap 또는 resume이 필요합니다.');
    const repairingOnResume = resumeEntryPending && state.halt?.code === 'repair_failed';
    if (state.halt?.code && !repairingOnResume) throw codedError(state.halt.code, state.halt.message);
    if (FINAL_PHASES.has(state.phase)) return runFinalization();
    if (state.phase === 'done') return finishDoneLifecycle();
    if (state.phase !== 'playing') {
      throw codedError('BOOTSTRAP_INCOMPLETE', `run할 수 없는 phase: ${state.phase}`);
    }

    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (!engine) throw codedError('NO_GAME', 'engine state가 없습니다.');
    if (engine.gameOver) {
      writeLoopState({ phase: 'finalizing', handNo: engine.handNo ?? state.handNo });
      return runFinalization();
    }

    let out;
    if (resumeEntryPending) {
      const current = await runCli(['step']);
      if (fs.existsSync(path.join(root, '.publish-attempt.json'))) {
        await publishEnvelope(current, ['--retry']);
      }
      const checked = await runCli(['resume-check']);
      const checkedHandNo = Number(engine.lastHand?.handNo ?? 0);
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
        const userBusted = Array.isArray(out.control?.bust) && out.control.bust.includes('user');
        const ending = out.gameOver || userBusted;
        if (ending) ensureFinalizationResultWaitCutoff();
        try {
          await heartbeatCoach();
        } catch (error) {
          appendNotice(`코치 heartbeat 오류: ${error.code ?? 'ERROR'}`);
          log('coach-heartbeat-error', { handNo: out.handNo, code: error.code ?? 'ERROR' });
        }
        if (stopRequested) break;
        launchCoachPipeline(out.handNo);
        if (ending) {
          // §5 finalizing 1: handOver 분기가 이미 async로 띄운 마지막 핸드 generation을
          // 그대로 둔다. 여기서 reserve를 다시 부르면 그 prior가 discard된다.
          writeLoopState({ phase: 'finalizing', handNo: out.handNo });
          return await runFinalization();
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
    coachPipeline,
    requestStop,
    get stopping() { return stopRequested; },
    get serverPid() { return serverPid; },
  };
}

function initializePreparedSession(gameDir, args) {
  const initArgs = ['init', '--ai', String(args.ai), '--game-dir', gameDir];
  if (args.stack !== undefined) initArgs.push('--stack', String(args.stack));
  if (args.levelEvery !== undefined) initArgs.push('--level-every', String(args.levelEvery));
  if (args.blinds !== undefined) initArgs.push('--blinds', String(args.blinds));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [ENGINE_CLI, ...initArgs], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok !== true) {
        reject(codedError(
          envelope?.code ?? error?.code ?? 'CHILD_FAILED',
          envelope?.message || String(stderr).trim() || 'engine init이 실패했습니다.',
          { cause: error, envelope },
        ));
        return;
      }
      resolve(envelope);
    });
  });
}

async function main() {
  let loop = null;
  let preparedInitialization = null;
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
    if (args.storeDir !== undefined) {
      if (args.force) throw codedError('FORCE_UNAVAILABLE', '--store-dir MVP에서는 --force를 지원하지 않습니다.');
      ensureSessionStore(args.storeDir);
      let storeLockHandle;
      try {
        storeLockHandle = acquireOwnedLock(args.storeDir, LOOP_LOCK);
      } catch (error) {
        if (error.code === 'LOCKED') throw codedError('ACTIVE_GAME', '이미 진행 중인 게임이 있습니다.');
        throw error;
      }
      try {
        if (args.resume) {
          const current = resolveCurrentSession(args.storeDir);
          if (!current) throw codedError('NO_GAME', '재개할 current session이 없습니다.');
          loop = createGameLoop({
            gameDir: current.sessionDir,
            lockDir: args.storeDir,
            initialLockHandle: storeLockHandle,
            resolver,
          });
        } else {
          const previous = resolveCurrentSession(args.storeDir);
          const previousServer = previous ? readStrictServerLock(previous.sessionDir) : null;
          if (previousServer && isAlive(previousServer.serverPid)) {
            throw codedError('ACTIVE_GAME', '이전 session server가 아직 실행 중입니다.');
          }
          const prepared = prepareSession(args.storeDir);
          const initialized = await initializePreparedSession(prepared.stagingDir, args);
          preparedInitialization = initialized;
          const committed = commitSession(args.storeDir, prepared);
          loop = createGameLoop({
            gameDir: committed.sessionDir,
            lockDir: args.storeDir,
            initialLockHandle: storeLockHandle,
            resolver,
          });
        }
      } catch (error) {
        if (!loop) releaseOwnedLock(storeLockHandle);
        throw error;
      }
    } else {
      assertNotSessionCatalogTarget(args.gameDir);
      loop = createGameLoop({ gameDir: args.gameDir, resolver });
    }
    process.once('SIGTERM', () => {
      if (handlingSignal) return;
      handlingSignal = true;
      signalStopPromise = loop.requestStop().catch((error) => {
        signalStopError = error;
      });
    });
    if (args.resume) await loop.resume({ skipLock: args.storeDir !== undefined });
    else await loop.bootstrap({
      ai: args.ai,
      stack: args.stack,
      levelEvery: args.levelEvery,
      blinds: args.blinds,
      force: args.force,
      practiceFocusFile: args.practiceFocusFile,
      preinitialized: preparedInitialization,
      skipLock: args.storeDir !== undefined,
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
