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

function mutexIdentity(dir) {
  try {
    const st = fs.statSync(dir, { bigint: true });
    const pid = ownerPid(dir);
    const st2 = fs.statSync(dir, { bigint: true });
    if (st2.ino !== st.ino || st2.dev !== st.dev) return null;
    return { dev: st.dev, ino: st.ino, mtimeMs: Number(st.mtimeMs), pid };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameMutex(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.pid === b.pid);
}

function isIdentityStale(id) {
  if (id.pid !== null) return !isProcessAlive(id.pid);
  return Date.now() - id.mtimeMs >= MUTEX_STALE_MS;
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

function restoreMutex(aside, dir) {
  try {
    fs.renameSync(aside, dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    const locked = new Error('LOCKED');
    locked.code = 'LOCKED';
    throw locked;
  }
}

function reclaimMutex(dir) {
  // Steal only the stale mutex identity we observed; a replaced live lock is restored or LOCKED.
  const decided = mutexIdentity(dir);
  if (!decided || !isIdentityStale(decided)) return false;
  const confirmed = mutexIdentity(dir);
  if (!sameMutex(decided, confirmed)) return false;
  const aside = renameMutexAside(dir);
  if (aside === null) return true;
  const moved = mutexIdentity(aside);
  if (!sameMutex(decided, moved) || !isIdentityStale(moved)) {
    restoreMutex(aside, dir);
    return false;
  }
  fs.rmSync(aside, { recursive: true, force: true });
  return true;
}

function acquireMutex(gameDir, retryMs, timeoutMs) {
  const dir = mutexPath(gameDir);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (reclaimMutex(dir)) continue;
      if (Date.now() >= deadline) {
        const locked = new Error('LOCKED');
        locked.code = 'LOCKED';
        throw locked;
      }
      sleepSync(retryMs);
      continue;
    }
    try {
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
    } catch (error) {
      const aside = renameMutexAside(dir);
      if (aside !== null) {
        const moved = mutexIdentity(aside);
        if (!moved || moved.pid === null || moved.pid === process.pid) {
          fs.rmSync(aside, { recursive: true, force: true });
        } else {
          restoreMutex(aside, dir);
        }
      }
      throw error;
    }
    return;
  }
}

function releaseMutex(gameDir) {
  const dir = mutexPath(gameDir);
  const decided = mutexIdentity(dir);
  if (!decided || decided.pid !== process.pid) return;
  const aside = renameMutexAside(dir);
  if (aside === null) return;
  const moved = mutexIdentity(aside);
  if (!sameMutex(decided, moved) || moved.pid !== process.pid) {
    restoreMutex(aside, dir);
    return;
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

export function withMutation(gameDir, fn, options) {
  const retryMs = options?.retryMs ?? MUTEX_RETRY_MS;
  const timeoutMs = options?.timeoutMs ?? MUTEX_TIMEOUT_MS;
  acquireMutex(gameDir, retryMs, timeoutMs);
  try {
    const result = fn(loadState(gameDir));
    saveState(gameDir, result.state);
    return result;
  } finally {
    releaseMutex(gameDir);
  }
}
