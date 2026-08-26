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

function ownerPid(dir) {
  try {
    const parsed = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function mutexAsidePath(dir) {
  return `${dir}.${process.pid}.${process.hrtime.bigint()}.stale`;
}

function inodeKey(dir) {
  try {
    const st = fs.statSync(dir, { bigint: true });
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
    const pid = ownerPid(dir);
    const st2 = fs.statSync(dir, { bigint: true });
    // A replacement between the two stats invalidates the pid we just read.
    if (st2.ino !== st.ino || st2.dev !== st.dev) return null;
    return { dev: st.dev, ino: st.ino, mtimeMs: Number(st.mtimeMs), pid };
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
 * May the directory now at `moved` be destroyed on the strength of the earlier
 * judgement `expected`? Only if it is literally the same directory (inode), still
 * registers the same owner, and is still stale. Anything else — a different inode,
 * a pid that appeared meanwhile, a pid-less directory younger than the staleness
 * threshold (i.e. a lock inside its own mkdir→pid-write window) — belongs to
 * somebody else and must be put back, not deleted.
 */
export function isReclaimable(expected, moved) {
  if (!expected || !moved) return false;
  if (!sameInode(expected, moved)) return false;
  if (expected.pid !== moved.pid) return false;
  return isIdentityStale(moved);
}

function renameMutexAside(dir) {
  const aside = mutexAsidePath(dir);
  try {
    fs.renameSync(dir, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return aside;
}

function throwLocked() {
  const locked = new Error('LOCKED');
  locked.code = 'LOCKED';
  throw locked;
}

function tryRename(from, to) {
  // POSIX rename() silently replaces an *empty* destination directory, which would
  // destroy a contender still inside its own mkdir→pid-write window. Refuse to move
  // onto an occupied path at all.
  if (fs.existsSync(to)) return false;
  try {
    fs.renameSync(from, to);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true; // source already gone
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return false;
    throw error;
  }
}

export function restoreLiveMutex(aside, dir, deadline, retryMs) {
  for (;;) {
    if (tryRename(aside, dir)) return;
    if (Date.now() >= deadline) {
      if (!tryRename(aside, dir)) throwLocked();
      return;
    }
    sleepSync(retryMs);
  }
}

/**
 * Put back a directory we displaced but were not entitled to. Restoration gets its
 * own budget past the acquire deadline: whoever took `.mutex` in the meantime will
 * free it at the end of its critical section. On failure this throws LOCKED with the
 * displaced lock left intact — we never create a second lock to compensate.
 */
function restoreDisplaced(aside, dir, ctx) {
  restoreLiveMutex(aside, dir, Math.max(ctx.deadline, Date.now() + ctx.timeoutMs), ctx.retryMs);
}

function reclaimMutex(dir, ctx) {
  const decided = mutexIdentity(dir);
  if (!decided || !isIdentityStale(decided)) return false;
  // Re-read immediately before the rename. This shrinks — it cannot close — the gap
  // in which the stale directory is replaced by a live lock: rename(2) has no
  // if-inode-still-matches form, so displacement always precedes inspection.
  const expected = mutexIdentity(dir);
  if (!isReclaimable(decided, expected)) return false;
  const aside = renameMutexAside(dir);
  if (aside === null) return true; // already gone: .mutex is free
  const moved = mutexIdentity(aside);
  if (isReclaimable(expected, moved)) {
    fs.rmSync(aside, { recursive: true, force: true });
    return true;
  }
  restoreDisplaced(aside, dir, ctx);
  return false;
}

function undoOwnMutex(dir, mine, ctx) {
  const aside = renameMutexAside(dir);
  if (aside === null) return;
  if (sameInode(mine, inodeKey(aside))) {
    fs.rmSync(aside, { recursive: true, force: true });
    return;
  }
  restoreDisplaced(aside, dir, ctx);
}

function tryCreateMutex(dir, ctx) {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  // Taken before the pid write: a directory this young and pid-less is never judged
  // stale, so nobody may displace it and this inode stays proof of our own creation.
  const mine = inodeKey(dir);
  try {
    fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  } catch (error) {
    undoOwnMutex(dir, mine, ctx);
    throw error;
  }
  return true;
}

function acquireMutex(gameDir, ctx) {
  const dir = mutexPath(gameDir);
  for (;;) {
    if (tryCreateMutex(dir, ctx)) return;
    if (reclaimMutex(dir, ctx) && tryCreateMutex(dir, ctx)) return;
    if (Date.now() >= ctx.deadline) throwLocked();
    sleepSync(ctx.retryMs);
  }
}

function releaseMutex(gameDir) {
  const dir = mutexPath(gameDir);
  const decided = mutexIdentity(dir);
  if (!decided || decided.pid !== process.pid) return; // not ours: never touch it
  const aside = renameMutexAside(dir);
  if (aside === null) return;
  const moved = mutexIdentity(aside);
  if (sameInode(decided, moved) && moved.pid === process.pid) {
    fs.rmSync(aside, { recursive: true, force: true });
    return;
  }
  restoreDisplaced(aside, dir, {
    deadline: Date.now() + MUTEX_TIMEOUT_MS,
    retryMs: MUTEX_RETRY_MS,
    timeoutMs: MUTEX_TIMEOUT_MS,
  });
}

export function withMutation(gameDir, fn, options) {
  const retryMs = options?.retryMs ?? MUTEX_RETRY_MS;
  const timeoutMs = options?.timeoutMs ?? MUTEX_TIMEOUT_MS;
  acquireMutex(gameDir, { deadline: Date.now() + timeoutMs, retryMs, timeoutMs });
  try {
    const result = fn(loadState(gameDir));
    saveState(gameDir, result.state);
    return result;
  } finally {
    releaseMutex(gameDir);
  }
}
