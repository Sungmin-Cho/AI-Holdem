import fs from 'node:fs';
import path from 'node:path';

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
    const parsed = Number(fs.readFileSync(fd, 'utf8').trim());
    return {
      dev: st.dev,
      ino: st.ino,
      pid: Number.isInteger(parsed) && parsed > 0 ? parsed : null,
    };
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

function isIdentityStale(id) {
  if (id.pid !== null) return !isProcessAlive(id.pid);
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
