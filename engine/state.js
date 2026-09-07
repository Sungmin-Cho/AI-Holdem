import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { processStartTime, win32ProcessStartTime, validWin32StartTime } from './process-identity.js';

export { processStartTime } from './process-identity.js';

const MUTEX_RETRY_MS = 100;
const MUTEX_TIMEOUT_MS = 3000;
const MUTEX_STALE_MS = MUTEX_TIMEOUT_MS * 2;
const sleepLock = new Int32Array(new SharedArrayBuffer(4));

// withMutation is sync, so the 100ms mutex retry uses Atomics.wait rather than timers.
function sleepSync(ms) {
  Atomics.wait(sleepLock, 0, 0, ms);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Windows refuses a rename while any reader holds the destination open, and a
// relay reading state.json holds it for a moment on every request. That is a
// collision to wait out, not a verdict: retry the same rename a bounded number
// of times, and if it still fails, fail.
const RENAME_RETRY_MS = 25;
const RENAME_RETRIES = process.platform === 'win32' ? 20 : 0;
function commitTmp(tmpPath, filePath) {
  // Rename is the commit boundary on every platform. Sharing violations are
  // failures, never permission to expose a partially copied destination.
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(tmpPath, filePath); return; } catch (error) {
      if (attempt >= RENAME_RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      sleepSync(RENAME_RETRY_MS);
    }
  }
}

export function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj), 'utf8');
    commitTmp(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* leftover tmp is harmless */ }
    throw error;
  }
}

export function loadState(gameDir) {
  return readJson(path.join(gameDir, 'state.json'));
}

export function saveState(gameDir, state) {
  state.stateVersion += 1;
  writeJsonAtomic(path.join(gameDir, 'state.json'), state);
}

function handFile(gameDir, handNo) {
  return path.join(gameDir, 'hands', `hand-${String(handNo).padStart(4, '0')}.json`);
}

export function readHand(gameDir, n) {
  return readJson(handFile(gameDir, n));
}

export function writeHandArchive(gameDir, record) {
  writeJsonAtomic(handFile(gameDir, record.handNo), record);
}

function mutexPath(gameDir) {
  return path.join(gameDir, '.mutex');
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

// pid 파일을 fd로 읽어 내용과 inode를 함께 얻는다. 이후 unlink는 이 inode가
// 그대로일 때만 하므로, 경로가 다른 락의 pid 파일로 바뀐 경우를 걸러낼 수 있다.
// 단명 락은 PID 1줄, legacy owned는 2줄, canonical owned는 정확히 3줄이다.
function readPidFile(dir) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, 'pid'), 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const lines = fs.readFileSync(fd, 'utf8').split('\n');
    const base = { dev: st.dev, ino: st.ino };
    if (lines.length === 1) {
      const parsed = Number(lines[0].trim());
      return { ...base, pid: Number.isInteger(parsed) && parsed > 0 ? parsed : null, startTime: null };
    }
    // Three lines deliberately fail closed in pre-versioned owned-lock readers.
    const owned = parseOwnedLockIdentity(lines.join('\n'));
    if (owned) return { ...base, ...owned };
    if (lines.length === 2 && lines[0].trim() !== '' && lines[1].trim() !== ''
      && !/^(?:utc|win32)-/.test(lines[1].trim())) {
      const parsed = Number(lines[0].trim());
      return { ...base, pid: Number.isInteger(parsed) && parsed > 0 ? parsed : null, startTime: lines[1].trim() };
    }
    // 인식하지 못한 버전·형식·추가 줄은 malformed —
    // pid-less 취급(mtime staleness 경로)으로 fail-closed, 절대 owned·alive로 해석하지 않는다.
    return { ...base, pid: null, startTime: null };
  } finally {
    fs.closeSync(fd);
  }
}

function inodeKey(p) {
  try {
    const st = fs.statSync(p, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameInode(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

function mutexIdentity(dir) {
  try {
    const st = fs.statSync(dir, { bigint: true });
    const pidFile = readPidFile(dir);
    const st2 = fs.statSync(dir, { bigint: true });
    // A replacement between the two stats invalidates the pid we just read.
    if (st2.ino !== st.ino || st2.dev !== st.dev) return null;
    return {
      dev: st.dev,
      ino: st.ino,
      mtimeMs: Number(st.mtimeMs),
      pid: pidFile ? pidFile.pid : null,
      pidFile,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// pid+startTime identity의 3상태 판정. read-time에 ps가 실패하면(현재 startTime을
// 알 수 없음) 생존도 사망도 증명되지 않은 'unknown'이다 — 이 경우를 죽음과
// 같이 취급하면(예: null !== recordedStartTime) 살아 있는 소유자가 회수되는
// fail-open이 생긴다. isIdentityStale·readOwnedLock 양쪽 모두 'unknown'을
// 'dead'가 아닌 별도 상태로 다뤄야 한다.
export function ownedIdentityStatus(pid, recordedStartTime, startTimeOf = ownedProcessStartTime) {
  // Parsed two-line legacy records retain the accepted positively-dead PID
  // reclamation boundary; live legacy can never authorize identity or signals.
  if (!isProcessAlive(pid)) return 'dead';
  // Unqualified legacy stamps cannot prove identity across caller timezones.
  if (!validOwnedIdentity(recordedStartTime)) return 'unknown';
  const current = resolveOwnedStartTime(pid, startTimeOf);
  if (!validOwnedIdentity(current) || current.split(':', 1)[0] !== recordedStartTime.split(':', 1)[0]) return 'unknown';
  return current === recordedStartTime ? 'alive' : 'dead';
}

function isIdentityStale(id) {
  if (id.pid !== null) {
    // owned 락(2줄 기록)은 startTime이 남아 있다: pid 생존만으로는 재사용된
    // pid를 원래 소유자로 오판할 수 있으므로 pid+startTime 일치까지 재검증한다.
    // 기존 1줄 기록(startTime 없음)의 판정은 이전과 동일하게 pid 생존만 본다.
    const startTime = id.pidFile ? id.pidFile.startTime : null;
    if (startTime !== null) return ownedIdentityStatus(id.pid, startTime) === 'dead';
    return !isProcessAlive(id.pid);
  }
  return Date.now() - id.mtimeMs >= MUTEX_STALE_MS;
}

/**
 * May the directory now judged as `current` be destroyed on the strength of the
 * earlier judgement `expected`? Only if it is literally the same directory (inode),
 * still registers the same owner, and is still stale. Anything else — a different
 * inode, a pid that appeared meanwhile, a pid-less directory younger than the
 * staleness threshold (i.e. a lock inside its own mkdir→pid-write window) — belongs
 * to somebody else and must not be touched.
 */
export function isReclaimable(expected, current) {
  if (!expected || !current) return false;
  if (!sameInode(expected, current)) return false;
  if (expected.pid !== current.pid) return false;
  return isIdentityStale(current);
}

function throwLocked() {
  const locked = new Error('LOCKED');
  locked.code = 'LOCKED';
  throw locked;
}

// (legacy) fd로 inode를 대조한 뒤 경로로 unlink한다. 검증과 unlink 사이에 경로가 산 락의
// pid 파일로 재바인딩될 수 있으므로(#148) 하드링크를 만들 수 없는 파일시스템의 폴백과
// 소유자 자신의 해제(자기 디렉터리는 자기 pid로 비어 있지 않아 재바인딩되지 않는다)에만 쓴다.
function unlinkStalePidFileLegacy(dir, expectedPidFile, hooks) {
  if (!expectedPidFile) return true;
  const pidPath = path.join(dir, 'pid');
  let fd;
  try {
    fd = fs.openSync(pidPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (st.dev !== expectedPidFile.dev || st.ino !== expectedPidFile.ino) return false;
  } finally {
    fs.closeSync(fd);
  }
  hooks?.beforeUnlinkPid?.(dir);
  try {
    fs.unlinkSync(pidPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

// 회수자가 stale pid 파일에 붙이는 하드링크 aside. 고유 이름이라 우리만 만들고 우리만 지운다.
const RECLAIM_ASIDE = /^pid\.reclaim\.(\d+)\.[0-9a-f]{8}$/;
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);

function asideNameFor() {
  return `pid.reclaim.${process.pid}.${randomBytes(4).toString('hex')}`;
}

function listReclaimAsides(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const name of names) {
    const match = RECLAIM_ASIDE.exec(name);
    if (match) out.push({ name, reclaimerPid: Number(match[1]) });
  }
  return out;
}

// 회수자가 죽어 남긴 aside만 지운다(고유 이름 — 경로 재바인딩 불가). 살아 있는 회수자의
// aside는 진행 중인 회수의 흔적이므로 건드리지 않는다.
function sweepOrphanAsides(dir) {
  let removed = 0;
  let remaining = 0;
  for (const aside of listReclaimAsides(dir)) {
    if (isProcessAlive(aside.reclaimerPid)) { remaining += 1; continue; }
    try {
      fs.unlinkSync(path.join(dir, aside.name));
      removed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { removed, remaining };
}

// 비재귀 rmdir. 비어 있지 않은 디렉터리(pid를 기록한 산 락 포함)는 절대 쓸리지 않는다.
// ENOTEMPTY가 고아 aside 때문이면 한 번 치우고 다시 시도한다.
function rmdirReclaimed(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmdirSync(dir);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true; // another reclaimer finished the job
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
      if (attempt > 0 || sweepOrphanAsides(dir).removed === 0) return false;
    }
  }
}

// pid 파일 없이 aside만 남은 디렉터리는 보유 중이 아니다: 보유자는 항상 dir/pid를 가지며
// 새 락은 aside를 가질 수 없다(link의 원본이 dir/pid이므로). 고아 aside를 치우고 비면
// 즉시 rmdir한다. 해당 없음(aside 없음)이면 null.
function reclaimAsideLeftovers(dir) {
  if (listReclaimAsides(dir).length === 0) return null;
  if (sweepOrphanAsides(dir).remaining > 0) return false;
  return rmdirReclaimed(dir);
}

/**
 * stale로 판정한 pid 파일을 떼어 낸다 — 경로에 대한 파괴 연산은 그 경로가 산 락으로
 * 재바인딩될 수 없음이 증명될 때만 한다.
 * (1) link(dir/pid, aside): 이름을 하나 더할 뿐 아무것도 옮기거나 교체하지 않는다.
 * (2) aside를 열어 inode를 판정 당시와 대조한다. 불일치면 산 락의 pid에 이름을 붙인 것이다 —
 *     aside(고유 이름)만 지우고 물러난다. 산 락에서는 아무것도 제거되지 않았다.
 * (3) 일치하면 aside가 그 디렉터리를 비어 있지 않게 고정하므로 rmdir도 mkdir도 불가능하고,
 *     dir/pid는 판정한 그 파일이거나 이미 부재다. 그때만 dir/pid를 지우고 aside를 지운다.
 * rename은 쓰지 않는다: rename은 이동·교체 원시라 잘못 잡으면 산 락이 경로에서 사라진다.
 */
function detachStalePidFile(dir, expectedPidFile, hooks) {
  if (!expectedPidFile) return true; // pid-less stale dir: nothing to unlink
  const pidPath = path.join(dir, 'pid');
  const link = hooks?.link ?? fs.linkSync;
  let aside;
  for (let attempt = 0; ; attempt += 1) {
    aside = path.join(dir, asideNameFor());
    try {
      link(pidPath, aside);
      break;
    } catch (error) {
      if (error.code === 'ENOENT') return false; // another reclaimer got here first
      if (error.code === 'EEXIST' && attempt === 0) continue;
      if (error.code === 'EINVAL') {
        // APFS answers EINVAL (not ENOENT) when the directory itself is being removed or
        // replaced under the link. Transient: the source is gone or no longer ours to judge.
        const now = readPidFile(dir);
        if (!now || now.dev !== expectedPidFile.dev || now.ino !== expectedPidFile.ino) return false;
        if (attempt < 2) continue;
        return unlinkStalePidFileLegacy(dir, expectedPidFile, hooks);
      }
      if (LINK_UNSUPPORTED.has(error.code)) return unlinkStalePidFileLegacy(dir, expectedPidFile, hooks);
      throw error;
    }
  }
  hooks?.afterLink?.(dir, aside);
  let matches = false;
  let fd;
  try {
    fd = fs.openSync(aside, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    matches = st.dev === expectedPidFile.dev && st.ino === expectedPidFile.ino;
  } finally {
    fs.closeSync(fd);
  }
  if (!matches) {
    try { fs.unlinkSync(aside); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // 그 사이 소유자가 해제하며 우리 aside 때문에 rmdir에 실패했다면 여기서 치운다.
    try { fs.rmdirSync(dir); } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
    }
    return false;
  }
  hooks?.beforeUnlinkPid?.(dir);
  try { fs.unlinkSync(pidPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.unlinkSync(aside); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return true;
}

function reclaimMutex(dir, hooks) {
  const decided = mutexIdentity(dir);
  if (!decided) return false;
  if (!decided.pidFile) {
    const leftovers = reclaimAsideLeftovers(dir);
    if (leftovers !== null) return leftovers;
  }
  if (!isIdentityStale(decided)) return false;
  const confirmed = mutexIdentity(dir);
  if (!isReclaimable(decided, confirmed)) return false;
  hooks?.afterJudge?.(dir);
  if (!detachStalePidFile(dir, confirmed.pidFile, hooks)) return false;
  hooks?.beforeRmdir?.(dir);
  return rmdirReclaimed(dir);
}

// Lifetime-owned locks require a complete pid+startTime identity. They never use
// the generic pid-less/legacy mtime fallback: an unknown owned record may belong
// to a live process whose metadata is partial or temporarily unreadable.
function ownedIdentityIsDead(id, startTimeOf = processStartTime) {
  const pidFile = id?.pidFile;
  return Boolean(
    pidFile
    && pidFile.pid !== null
    && pidFile.startTime !== null
    && ownedIdentityStatus(pidFile.pid, pidFile.startTime, startTimeOf) === 'dead'
  );
}

function sameOwnedIdentity(expected, current) {
  if (!expected || !current || !sameInode(expected, current)) return false;
  const a = expected.pidFile;
  const b = current.pidFile;
  return Boolean(
    a
    && b
    && a.dev === b.dev
    && a.ino === b.ino
    && a.pid === b.pid
    && a.startTime === b.startTime
  );
}

function reclaimOwnedMutex(dir, startTimeOf = processStartTime, hooks) {
  const decided = mutexIdentity(dir);
  if (decided && !decided.pidFile) {
    const leftovers = reclaimAsideLeftovers(dir);
    if (leftovers !== null) return leftovers;
  }
  if (!ownedIdentityIsDead(decided, startTimeOf)) return false;
  const confirmed = mutexIdentity(dir);
  if (!sameOwnedIdentity(decided, confirmed) || !ownedIdentityIsDead(confirmed, startTimeOf)) return false;
  hooks?.afterJudge?.(dir);
  if (!detachStalePidFile(dir, confirmed.pidFile, hooks)) return false;
  hooks?.beforeRmdir?.(dir);
  return rmdirReclaimed(dir);
}

/**
 * 획득 = 비어 있지 않은 디렉터리를 원자적으로 설치한다. 고유 이름의 임시 디렉터리
 * `<dir>.<pid>.<hex8>.tmp`에 pid를 먼저 기록하고 `rename(tmp, dir)`로 옮긴다:
 * dir가 없으면 성공, 비어 있지 않으면(보유 중·stale) ENOTEMPTY/EEXIST, 비어 있으면 교체된다.
 * 산 락은 태어날 때부터 비어 있지 않으므로 "비어 있는 dir"는 언제나 죽은 락의 잔해이고,
 * 그것을 교체하는 rename은 파괴가 아니다. `mine`은 고유 경로의 stat이라 경로 조회
 * 경쟁이 없다(rename은 inode를 보존한다). mkdir→pid 기록 사이의 "빈 새 락" 창이 없으므로
 * 늦은 회수자의 rmdir이 새 락을 쓸어 갈 수 없다(ENOTEMPTY).
 */
const LOCK_TMP_SUFFIX = /^\.(\d+)\.[0-9a-f]{8}\.tmp$/;

function tmpDirFor(dir) {
  return `${dir}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

function removeTmpDir(tmp) {
  try { fs.unlinkSync(path.join(tmp, 'pid')); } catch { /* may not exist */ }
  try { fs.rmdirSync(tmp); } catch { /* may not exist */ }
}

// 죽은 프로세스가 rename 전에 남긴 임시 디렉터리만 치운다(고유 이름 — 경로 재바인딩 불가).
function sweepDeadTmpDirs(dir) {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  let names;
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    const match = LOCK_TMP_SUFFIX.exec(name.slice(base.length));
    if (!match || isProcessAlive(Number(match[1]))) continue;
    removeTmpDir(path.join(parent, name));
  }
}

function prepareTmpDir(dir, content, state) {
  if (state.tmp) return;
  const tmp = tmpDirFor(dir);
  fs.mkdirSync(tmp);
  try {
    fs.writeFileSync(path.join(tmp, 'pid'), content, { mode: 0o600 });
    state.mine = inodeKey(tmp);
    state.tmp = tmp;
  } catch (error) {
    removeTmpDir(tmp);
    throw error;
  }
}

const OCCUPIED = new Set(['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

// null = dir is occupied (held, stale, or a transient rename refusal); the caller judges and retries.
function installMutex(dir, content, hooks, state) {
  prepareTmpDir(dir, content, state);
  hooks?.beforeInstall?.(dir, state.tmp);
  try {
    fs.renameSync(state.tmp, dir);
  } catch (error) {
    if (OCCUPIED.has(error.code)) return null;
    if (error.code === 'ENOENT') { // our tmp vanished (a foreign sweep) — rebuild on the next round
      removeTmpDir(state.tmp);
      state.tmp = null;
      return null;
    }
    throw error;
  }
  const mine = state.mine;
  state.tmp = null;
  state.mine = null;
  return mine;
}

function acquireMutex(dir, ctx) {
  sweepDeadTmpDirs(dir);
  const state = { tmp: null, mine: null };
  try {
    for (;;) {
      // rename은 dir가 없을 때, 또는 방금 회수해 비웠을 때만 시도한다. 존재하는 dir는 먼저
      // 판정한다 — 젊은 빈 디렉터리(legacy mkdir→pid 창)는 회수 대상이 아니므로 덮지 않는다.
      let mine = inodeKey(dir) ? null : installMutex(dir, String(process.pid), ctx.hooks, state);
      if (mine) return mine;
      if (reclaimMutex(dir, ctx.hooks)) {
        mine = installMutex(dir, String(process.pid), ctx.hooks, state);
        if (mine) return mine;
      }
      if (Date.now() >= ctx.deadline) throwLocked();
      sleepSync(ctx.retryMs);
    }
  } finally {
    if (state.tmp) removeTmpDir(state.tmp);
  }
}

function releaseMutex(dir, mine) {
  // Our pid is alive, so no reclaimer may have deleted our lock: if the inode still
  // matches the one mkdir gave us, the lock is ours to dismantle — pid file first,
  // then the (now empty) directory. Never recursive, never rename.
  if (!sameInode(mine, inodeKey(dir))) return;
  try {
    fs.unlinkSync(path.join(dir, 'pid'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    fs.rmdirSync(dir);
  } catch (error) {
    // ENOTEMPTY: foreign content appeared in our lock dir; leave it to go stale
    // rather than recursively deleting what we did not write.
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  }
}

export function withMutation(gameDir, fn, options) {
  const retryMs = options?.retryMs ?? MUTEX_RETRY_MS;
  const timeoutMs = options?.timeoutMs ?? MUTEX_TIMEOUT_MS;
  const dir = mutexPath(gameDir);
  const mine = acquireMutex(dir, { deadline: Date.now() + timeoutMs, retryMs, hooks: options?.hooks });
  try {
    const result = fn(loadState(gameDir));
    saveState(gameDir, result.state);
    return result;
  } finally {
    releaseMutex(dir, mine);
  }
}

export function runExclusive(gameDir, fn, options) {
  const retryMs = options?.retryMs ?? MUTEX_RETRY_MS;
  const timeoutMs = options?.timeoutMs ?? MUTEX_TIMEOUT_MS;
  fs.mkdirSync(gameDir, { recursive: true });
  const dir = mutexPath(gameDir);
  const mine = acquireMutex(dir, { deadline: Date.now() + timeoutMs, retryMs, hooks: options?.hooks });
  try {
    return fn();
  } finally {
    releaseMutex(dir, mine);
  }
}

/**
 * The same identity-checked lock, under a caller-chosen name and around an async
 * body — for critical sections outside state mutation (publishing to the relay).
 * Sharing the primitive is the point: a second, hand-rolled lock would repeat the
 * TOCTOU and ownership mistakes this one was written to avoid.
 *
 * `timeoutMs` must exceed the staleness threshold, or a waiter gives up before it
 * is ever allowed to reclaim a dead owner's lock.
 */
export async function withNamedLock(gameDir, name, fn, options) {
  const retryMs = options?.retryMs ?? MUTEX_RETRY_MS;
  const timeoutMs = options?.timeoutMs ?? MUTEX_TIMEOUT_MS;
  const dir = path.join(gameDir, name);
  const mine = acquireMutex(dir, { deadline: Date.now() + timeoutMs, retryMs, hooks: options?.hooks });
  try {
    return await fn();
  } finally {
    releaseMutex(dir, mine);
  }
}

// 로컬 ps 호출 — 서버·네트워크와 무관하므로 sync 허용. pid는 재사용되지만
// (pid, 기동시각) 쌍은 사실상 유일하므로 owned 락의 identity로 쓴다.
const OWNED_TIMESTAMP = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) ([0-2]\d):([0-5]\d):([0-5]\d) (\d{4})$/;
function validOwnedTimestamp(value) {
  const match = typeof value === 'string' && OWNED_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, weekday, month, day, hour, minute, second, year] = match;
  const monthIndex = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(month);
  if (+year < 1970 || +hour > 23 || +day < 1) return false;
  const date = new Date(Date.UTC(+year, monthIndex, +day, +hour, +minute, +second));
  return date.getUTCFullYear() === +year && date.getUTCMonth() === monthIndex
    && date.getUTCDate() === +day && ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getUTCDay()] === weekday;
}

function resolveOwnedStartTime(pid, probe) {
  if (probe === processStartTime || probe === ownedProcessStartTime) return ownedProcessStartTime(pid);
  const value = probe(pid);
  if (value == null || validOwnedIdentity(value)) return value;
  // Preserve the public raw-probe injection seam, but qualify it only after a
  // real matching platform read. Arbitrary/unavailable probe values fail closed.
  return value === processStartTime(pid) ? ownedProcessStartTime(pid) : null;
}

function validOwnedIdentity(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('utc-v1:')) return validOwnedTimestamp(value.slice(7));
  // The owned wire is exactly the Windows round-trip 'o' format. Shorter
  // fractions can denote the same instant but must never become a different PID
  // identity through string comparison; keep raw adapter flexibility separate.
  if (value.startsWith('win32-v1:')) return /\.\d{7}Z$/.test(value) && validWin32StartTime(value.slice(9));
  return false;
}

/** Parse only the exact canonical lifetime wire after a caller's bounded safe read.
 * Legacy and unknown formats return null; they cannot authorize a current owner. */
export function parseOwnedLockIdentity(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  if (lines.length !== 3 || !/^[1-9]\d*$/.test(lines[0]) || !validOwnedIdentity(`${lines[1]}:${lines[2]}`)) return null;
  const pid = Number(lines[0]);
  return Number.isSafeInteger(pid) ? { pid, startTime: `${lines[1]}:${lines[2]}` } : null;
}

/** Versioned identity for lifetime locks only; legacy processStartTime is unchanged. */
export function ownedProcessStartTime(pid) {
  if (process.platform === 'win32') {
    const stamp = win32ProcessStartTime(pid);
    return stamp === null ? null : `win32-v1:${stamp}`;
  }
  if (!['darwin', 'linux'].includes(process.platform)) return null;
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 3000, env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' },
    }).trim();
    return validOwnedTimestamp(value) ? `utc-v1:${value}` : null;
  } catch { return null; }
}

/**
 * Owned 락(수명 보유 — `game/loop.lock.d/` 등)의 현재 기록을 읽는다. 락 경로가
 * 없을 때만 null이다. 기록이 partial/legacy/malformed/unreadable이면 존재는 하지만
 * identity를 증명할 수 없으므로 `{ alive:false, status:'unknown' }`을 돌려준다.
 * canonical 3줄 기록만 alive를 증명한다. 살아 있는 2줄 legacy는 unknown으로 보호한다.
 * 기존 호출자를 위해 pid/startTime/alive 필드는 그대로 유지하며, `alive`는
 * `ownedIdentityStatus`가 'alive'로 **긍정 증명**했을 때만 true다.
 */
export function readOwnedLock(gameDir, name, { processStartTime: startTimeOf = processStartTime } = {}) {
  const dir = path.join(gameDir, name);
  let pidFile;
  try {
    pidFile = readPidFile(dir);
  } catch {
    return { pid: null, startTime: null, alive: false, status: 'unknown' };
  }
  if (!pidFile) {
    if (!inodeKey(dir)) return null;
    return { pid: null, startTime: null, alive: false, status: 'unknown' };
  }
  if (pidFile.pid === null || pidFile.startTime === null) {
    return {
      pid: pidFile.pid,
      startTime: pidFile.startTime,
      alive: false,
      status: 'unknown',
    };
  }
  const status = ownedIdentityStatus(pidFile.pid, pidFile.startTime, startTimeOf);
  return {
    pid: pidFile.pid,
    startTime: pidFile.startTime,
    alive: status === 'alive',
    status,
  };
}

function installOwnedLock(dir, startTime, hooks, state) {
  const separator = startTime.indexOf(':');
  const content = `${process.pid}\n${startTime.slice(0, separator)}\n${startTime.slice(separator + 1)}`;
  const mine = installMutex(dir, content, hooks, state);
  return mine ? { dir, pid: process.pid, startTime, dev: mine.dev, ino: mine.ino } : null;
}

/**
 * 기존 mkdir+pid 원시를 수명 보유(lifetime-owned) 락으로 확장한다: 기록은
 * pid 파일 한 개에 `pid\nutc-v1\nUTC timestamp` 3줄뿐(비재귀 rmdir 계약을 지키기 위해
 * 그 외 파일은 절대 만들지 않는다), staleness는 mtime이 아니라 `readOwnedLock`의
 * `alive` 판정 하나로만 결정된다 — 살아 있는 소유자는 시간이 얼마나 지나도
 * 회수되지 않는다. 죽은 것으로 판정되면 기존 reclaim 경로(inode 검증
 * unlink+rmdir)를 그대로 재사용해 회수하고 한 번만 재시도한다.
 *
 * 자기 자신의 startTime을 mkdir보다 먼저 확인한다: ps 실패로 null이면 identity를
 * 세울 수 없으므로 디렉터리·pid 파일을 아예 만들지 않고 실패한다. `LOCKED`와
 * 혼동되지 않도록 별도 코드(`IDENTITY_UNAVAILABLE`)로 던진다 — 상대측 회수 로직이
 * "내가 owner인데 락을 못 세웠다"를 "누가 락을 쥐고 있다"와 구별할 수 있어야 한다.
 */
export function acquireOwnedLock(gameDir, name, { processStartTime: startTimeOf = processStartTime, hooks } = {}) {
  const dir = path.join(gameDir, name);
  const startTime = resolveOwnedStartTime(process.pid, startTimeOf);
  if (!validOwnedIdentity(startTime)) {
    const error = new Error('IDENTITY_UNAVAILABLE');
    error.code = 'IDENTITY_UNAVAILABLE';
    throw error;
  }
  sweepDeadTmpDirs(dir);
  const state = { tmp: null, mine: null };
  try {
    // fail-closed 정책: 이미 존재하는 dir는 rename으로 덮지 않고 먼저 판정한다(빈 dir·unknown 기록은 LOCKED).
    if (!inodeKey(dir)) {
      const handle = installOwnedLock(dir, startTime, hooks, state);
      if (handle) return handle;
    }
    // pid 파일 없이 회수 aside만 남은 디렉터리는 죽은 회수자의 잔해다(보유 중이 아니다).
    const seen = mutexIdentity(dir);
    if (seen && !seen.pidFile && reclaimAsideLeftovers(dir) === true) {
      const handle = installOwnedLock(dir, startTime, hooks, state);
      if (handle) return handle;
    }
    const owner = readOwnedLock(gameDir, name, { processStartTime: startTimeOf });
    if (!owner || owner.status !== 'dead') throwLocked();
    if (!reclaimOwnedMutex(dir, startTimeOf, hooks)) throwLocked();
    const handle = installOwnedLock(dir, startTime, hooks, state);
    if (!handle) throwLocked();
    return handle;
  } finally {
    if (state.tmp) removeTmpDir(state.tmp);
  }
}

export function releaseOwnedLock(handle) {
  const current = mutexIdentity(handle.dir);
  const pidFile = current?.pidFile;
  if (
    !sameInode(handle, current)
    || !pidFile
    || pidFile.pid !== handle.pid
    || pidFile.startTime !== handle.startTime
  ) return;
  if (!unlinkStalePidFileLegacy(handle.dir, pidFile)) return;
  try {
    fs.rmdirSync(handle.dir);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  }
}
