import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

export function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmpPath, filePath);
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
// 형식은 1줄(기존 단명 락: pid만) 또는 2줄(owned 락: pid\nstartTime) 둘 다 허용한다.
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
    if (lines.length === 2 && lines[0].trim() !== '' && lines[1].trim() !== '') {
      const parsed = Number(lines[0].trim());
      return { ...base, pid: Number.isInteger(parsed) && parsed > 0 ? parsed : null, startTime: lines[1].trim() };
    }
    // 3줄 이상이거나 2줄이지만 빈 줄이 섞인 기록은 legacy도 owned도 아닌 malformed —
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
function ownedIdentityStatus(pid, recordedStartTime) {
  if (!isProcessAlive(pid)) return 'dead';
  const current = processStartTime(pid);
  if (current === null) return 'unknown';
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

// stale로 판정해 둔 pid 파일만 지운다: 다시 열어 fstat의 inode가 판정 당시와
// 일치할 때만 unlink한다. 불일치(교체된 락의 pid 파일)나 소실이면 회수를 중단한다.
function unlinkStalePidFile(dir, expectedPidFile) {
  if (!expectedPidFile) return true; // pid-less stale dir: nothing to unlink
  const pidPath = path.join(dir, 'pid');
  let fd;
  try {
    fd = fs.openSync(pidPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return false; // another reclaimer got here first
    throw error;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (st.dev !== expectedPidFile.dev || st.ino !== expectedPidFile.ino) return false;
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.unlinkSync(pidPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

/**
 * Reclamation deletes in place — no rename anywhere. POSIX rename() silently
 * replaces an *empty* destination directory, so moving a possibly-live lock is
 * itself a destruction primitive; that entire aside/restore family is gone.
 * Instead: (1) after judging staleness, re-read and require same inode + same pid +
 * still stale; (2) unlink the pid file only after fd-verifying its inode; (3) remove
 * the directory with a non-recursive rmdir, so a replacement lock that has written
 * its pid can never be swept away (ENOTEMPTY). If any check disagrees, delete
 * nothing and fall back to the mkdir loop.
 *
 * Residual window (cannot close without an inode-guarded unlink/rmdir syscall,
 * which POSIX does not offer): between the final same-inode re-check and rmdir, a
 * concurrent reclaimer may delete the stale directory and a contender may mkdir a
 * fresh one; if that fresh lock is still empty (inside its own mkdir→pid-write
 * microsecond window) our rmdir removes it. Its owner then fails its pid write with
 * ENOENT and throws — it never silently proceeds as if it held the lock.
 */
function reclaimMutex(dir) {
  const decided = mutexIdentity(dir);
  if (!decided || !isIdentityStale(decided)) return false;
  const confirmed = mutexIdentity(dir);
  if (!isReclaimable(decided, confirmed)) return false;
  if (!unlinkStalePidFile(dir, confirmed.pidFile)) return false;
  try {
    fs.rmdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return true; // another reclaimer finished the job
    if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

function undoOwnMutex(dir, mine) {
  // Called while the pid-write error is propagating; secondary failures must not
  // mask it. The inode check keeps this from ever touching somebody else's lock.
  if (!sameInode(mine, inodeKey(dir))) return;
  try { fs.unlinkSync(path.join(dir, 'pid')); } catch { /* may not exist */ }
  try { fs.rmdirSync(dir); } catch { /* stale-reclaim will collect it */ }
}

function tryCreateMutex(dir) {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
  // mkdir is the acquisition atom; pid is metadata written after. A directory this
  // young and pid-less is never judged stale, so nobody may delete it and this
  // inode stays proof of our ownership until we remove it ourselves.
  const mine = inodeKey(dir);
  try {
    fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  } catch (error) {
    undoOwnMutex(dir, mine);
    // The residual window described above: a concurrent reclaimer swept this
    // directory while it was still empty. We never held the lock, so this is an
    // acquisition miss to retry — not a failure to hand back to the caller.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return mine;
}

function acquireMutex(dir, ctx) {
  for (;;) {
    let mine = tryCreateMutex(dir);
    if (mine) return mine;
    if (reclaimMutex(dir)) {
      mine = tryCreateMutex(dir);
      if (mine) return mine;
    }
    if (Date.now() >= ctx.deadline) throwLocked();
    sleepSync(ctx.retryMs);
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
  const mine = acquireMutex(dir, { deadline: Date.now() + timeoutMs, retryMs });
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
  const mine = acquireMutex(dir, { deadline: Date.now() + timeoutMs, retryMs });
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
  const mine = acquireMutex(dir, { deadline: Date.now() + timeoutMs, retryMs });
  try {
    return await fn();
  } finally {
    releaseMutex(dir, mine);
  }
}

// 로컬 ps 호출 — 서버·네트워크와 무관하므로 sync 허용. pid는 재사용되지만
// (pid, 기동시각) 쌍은 사실상 유일하므로 owned 락의 identity로 쓴다.
export function processStartTime(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Owned 락(수명 보유 — `game/loop.lock.d/` 등)의 현재 기록을 읽는다. 락이
 * 없거나, 1줄짜리 legacy 기록이거나, malformed(3줄 이상 등)면 owned 기록이
 * 아니므로 null. `alive`는 시그널·회수 가능 여부를 가르는 유일한 근거이며,
 * `ownedIdentityStatus`가 'alive'로 **긍정 증명**했을 때만 true다 — read-time에
 * ps가 실패해 현재 startTime을 알 수 없는('unknown') 경우도 false로 떨어져,
 * 증명되지 않은 identity로는 절대 시그널하지 않는다(fail-closed).
 */
export function readOwnedLock(gameDir, name) {
  const pidFile = readPidFile(path.join(gameDir, name));
  if (!pidFile || pidFile.pid === null || pidFile.startTime === null) return null;
  const alive = ownedIdentityStatus(pidFile.pid, pidFile.startTime) === 'alive';
  return { pid: pidFile.pid, startTime: pidFile.startTime, alive };
}

function tryCreateOwnedLock(dir, startTime) {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
  const mine = inodeKey(dir);
  try {
    fs.writeFileSync(path.join(dir, 'pid'), `${process.pid}\n${startTime}`);
  } catch (error) {
    undoOwnMutex(dir, mine);
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return { dir, pid: process.pid, startTime, dev: mine.dev, ino: mine.ino };
}

/**
 * 기존 mkdir+pid 원시를 수명 보유(lifetime-owned) 락으로 확장한다: 기록은
 * pid 파일 한 개에 `pid\nstartTime` 2줄뿐(비재귀 rmdir 계약을 지키기 위해
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
export function acquireOwnedLock(gameDir, name) {
  const dir = path.join(gameDir, name);
  const startTime = processStartTime(process.pid);
  if (startTime === null) {
    const error = new Error('IDENTITY_UNAVAILABLE');
    error.code = 'IDENTITY_UNAVAILABLE';
    throw error;
  }

  let handle = tryCreateOwnedLock(dir, startTime);
  if (handle) return handle;

  const owner = readOwnedLock(gameDir, name);
  if (owner && owner.alive) throwLocked();
  if (!reclaimMutex(dir)) throwLocked();
  handle = tryCreateOwnedLock(dir, startTime);
  if (!handle) throwLocked();
  return handle;
}

export function releaseOwnedLock(handle) {
  releaseMutex(handle.dir, { dev: handle.dev, ino: handle.ino });
}
