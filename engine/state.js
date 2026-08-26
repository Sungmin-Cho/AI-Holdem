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

function isMutexStale(dir) {
  const pid = ownerPid(dir);
  if (pid !== null) return !isProcessAlive(pid);
  try {
    return Date.now() - fs.statSync(dir).mtimeMs >= MUTEX_STALE_MS;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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

function reclaimMutex(dir) {
  if (!isMutexStale(dir)) return false;
  const aside = renameMutexAside(dir);
  if (aside === null) return true;
  if (!isMutexStale(aside)) {
    try { fs.renameSync(aside, dir); } catch { /* another mkdir won the name */ }
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
      if (aside !== null) fs.rmSync(aside, { recursive: true, force: true });
      throw error;
    }
    return;
  }
}

function releaseMutex(gameDir) {
  const dir = mutexPath(gameDir);
  if (ownerPid(dir) !== process.pid) return;
  const aside = renameMutexAside(dir);
  if (aside === null) return;
  if (ownerPid(aside) !== process.pid) {
    try { fs.renameSync(aside, dir); } catch { /* another mkdir won the name */ }
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
