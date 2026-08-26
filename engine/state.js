import fs from 'node:fs';
import path from 'node:path';

const MUTEX_RETRY_MS = 100;
const MUTEX_TIMEOUT_MS = 3000;
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
    return Number.isInteger(parsed) ? parsed : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function reclaimMutex(dir) {
  const pid = ownerPid(dir);
  if (pid === null) {
    // Missing pid is likely still being written; do not steal a fresh mutex.
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      return false;
    }
    if (Date.now() - mtimeMs < MUTEX_RETRY_MS) return false;
  } else if (isProcessAlive(pid)) {
    return false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function acquireMutex(gameDir) {
  const dir = mutexPath(gameDir);
  const deadline = Date.now() + MUTEX_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      try {
        fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (reclaimMutex(dir)) continue;
      if (Date.now() >= deadline) {
        const locked = new Error('LOCKED');
        locked.code = 'LOCKED';
        throw locked;
      }
      sleepSync(MUTEX_RETRY_MS);
    }
  }
}

function releaseMutex(gameDir) {
  fs.rmSync(mutexPath(gameDir), { recursive: true, force: true });
}

export function withMutation(gameDir, fn) {
  acquireMutex(gameDir);
  try {
    const result = fn(loadState(gameDir));
    saveState(gameDir, result.state);
    return result;
  } finally {
    releaseMutex(gameDir);
  }
}
