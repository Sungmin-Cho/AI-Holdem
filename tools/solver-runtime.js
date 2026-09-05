import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime, writeJsonAtomic } from '../engine/state.js';
import { assertSolverResult } from '../training/postflop/contracts.js';

const FAKE_CHILD = fileURLToPath(new URL('./fake-solver-child.js', import.meta.url));
const DEFAULT_STDOUT = 256 * 1024;
const DEFAULT_RSS_KB = 256 * 1024;
// `rssKb` shells out to `ps`; 50ms spawned twenty processes a second for a
// ceiling that moves far more slowly than that.
export const SOLVER_POLL_MS = 250;
const SOLVER_RECORD = '.solver-child.json';
const SOLVER_TOKEN_ENV = 'AI_HOLDEM_SOLVER_TOKEN';
const SPAWN_DISCOVERY_RETRIES = 3;
const live = new Map();
const syncSleepCell = new Int32Array(new SharedArrayBuffer(4));

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  Atomics.wait(syncSleepCell, 0, 0, ms);
}

function rssKb(pid) {
  if (process.platform === 'win32') return null;
  try {
    const out = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+)/.exec(out);
    if (match) return Number(match[1]);
  } catch { /* darwin */ }
  try {
    const text = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function parsePidList(text) {
  return [...new Set(String(text).trim().split(/\s+/).filter(Boolean).map(Number))]
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function processGroupPids(pgid) {
  if (process.platform === 'win32') return { ok: false, pids: [] };
  if (!Number.isInteger(pgid) || pgid <= 0) return { ok: false, pids: [] };
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
    const pids = [];
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      const group = Number(parts[1]);
      if (group === pgid && Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    return { ok: true, pids: [...new Set(pids)] };
  } catch { /* fall through to ps -g */ }
  try {
    const out = execFileSync('ps', ['-o', 'pid=', '-g', String(pgid)], { encoding: 'utf8' });
    return { ok: true, pids: parsePidList(out) };
  } catch {
    return { ok: false, pids: [] };
  }
}

function isStartTime(value) {
  return typeof value === 'string' && value.length > 0;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function occupancyOf(pid, startTime, startTimeOf) {
  const leaderStart = startTimeOf(pid);
  if (isStartTime(startTime) && leaderStart === startTime) {
    return { live: true, readable: true };
  }
  const group = processGroupPids(pid);
  if (!group.ok) return { live: true, readable: false };
  const descendants = group.pids.filter((member) => member !== pid);
  if (descendants.length) return { live: true, readable: true };
  const leaderPresent = group.pids.includes(pid) || pidAlive(pid);
  if (leaderStart == null && leaderPresent) {
    return { live: true, readable: false };
  }
  if (!isStartTime(startTime)) {
    if (leaderStart != null || leaderPresent) return { live: true, readable: false };
    return { live: false, readable: true };
  }
  return { live: false, readable: true };
}

export async function killGroup(pid, startTime, startTimeOf = processStartTime) {
  if (!isStartTime(startTime)) {
    return { confirmed: false, reason: 'termination_unconfirmed' };
  }
  const current = startTimeOf(pid);
  if (current == null) {
    const group = processGroupPids(pid);
    if (!group.ok) return { confirmed: false, reason: 'termination_unconfirmed' };
    if (group.pids.includes(pid) || group.pids.some((member) => member !== pid)) {
      return { confirmed: false, reason: 'termination_unconfirmed' };
    }
    return { confirmed: true };
  }
  if (current !== startTime) {
    const group = processGroupPids(pid);
    if (!group.ok) return { confirmed: false, reason: 'termination_unconfirmed' };
    if (group.pids.some((member) => member !== pid)) {
      return { confirmed: false, reason: 'termination_unconfirmed' };
    }
    return { confirmed: true };
  }
  if (process.platform === 'win32') {
    const again = startTimeOf(pid);
    if (again !== startTime) {
      return { confirmed: !pidAlive(pid) || again == null };
    }
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      execFileSync(exe, ['/PID', String(pid), '/T', '/F'], {
        timeout: 3_000,
        windowsHide: true,
      });
    } catch { /* identity postcondition decides */ }
    const after = startTimeOf(pid);
    if (after !== startTime && !pidAlive(pid)) return { confirmed: true };
    if (after !== startTime) return { confirmed: true };
    return { confirmed: false, reason: 'termination_unconfirmed' };
  }
  try { process.kill(-pid, 'SIGTERM'); } catch (error) {
    if (error.code !== 'ESRCH') {
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    }
  }
  const termDeadline = Date.now() + 400;
  while (Date.now() < termDeadline) {
    const group = processGroupPids(pid);
    if (group.ok && group.pids.length === 0) return { confirmed: true };
    await sleep(20);
  }
  const beforeKill = startTimeOf(pid);
  if (beforeKill !== startTime) {
    const group = processGroupPids(pid);
    if (!group.ok) return { confirmed: false, reason: 'termination_unconfirmed' };
    if (group.pids.length === 0) return { confirmed: true };
    return { confirmed: false, reason: 'termination_unconfirmed' };
  }
  try { process.kill(-pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  }
  const killDeadline = Date.now() + 200;
  while (Date.now() < killDeadline) {
    const group = processGroupPids(pid);
    if (group.ok && group.pids.length === 0) return { confirmed: true };
    await sleep(20);
  }
  const group = processGroupPids(pid);
  if (!group.ok) return { confirmed: false, reason: 'termination_unconfirmed' };
  return group.pids.length === 0
    ? { confirmed: true }
    : { confirmed: false, reason: 'termination_unconfirmed' };
}

export function hasLiveSolverChild(startTimeOf = processStartTime) {
  for (const [pid, rec] of [...live.entries()]) {
    const occupancy = occupancyOf(pid, rec.startTime, startTimeOf);
    if (!occupancy.live && occupancy.readable) live.delete(pid);
  }
  return live.size > 0;
}

function solverRecordPath(gameDir) {
  return path.join(gameDir, SOLVER_RECORD);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function discoverTokenProcesses(spawnToken) {
  if (process.platform === 'win32') return { ok: false, matches: [] };
  const listFlag = process.platform === 'darwin' ? '-axE' : '-axe';
  let output;
  try {
    output = execFileSync('ps', [listFlag, '-o', 'pid=,lstart=,command='], { encoding: 'utf8' });
  } catch {
    return { ok: false, matches: [] };
  }
  const tokenPattern = new RegExp(
    `(?:^|\\s)${SOLVER_TOKEN_ENV}=${escapeRegExp(spawnToken)}(?:\\s|$)`,
  );
  const matches = [];
  for (const line of output.split('\n')) {
    if (!tokenPattern.test(line)) continue;
    const parsed = /^\s*(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+/.exec(line);
    if (!parsed) return { ok: false, matches: [] };
    const pid = Number(parsed[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !isStartTime(parsed[2])) {
      return { ok: false, matches: [] };
    }
    matches.push({ pid, startTime: parsed[2] });
  }
  const byIdentity = new Map(matches.map((entry) => [`${entry.pid}\0${entry.startTime}`, entry]));
  return { ok: true, matches: [...byIdentity.values()] };
}

function clearPersistedReservation(gameDir, spawnToken) {
  if (!gameDir) return false;
  const file = solverRecordPath(gameDir);
  if (spawnToken !== undefined) {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current?.spawnToken !== spawnToken) return false;
    } catch {
      return false;
    }
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function resolveSpawningRecord(gameDir, rec, startTimeOf) {
  if (!Number.isInteger(rec.wrapperPid) || rec.wrapperPid <= 0
    || !isStartTime(rec.wrapperStartTime)
    || typeof rec.spawnToken !== 'string' || rec.spawnToken.length === 0) {
    return { state: 'unreadable', record: rec };
  }
  const wrapperStart = startTimeOf(rec.wrapperPid);
  if (wrapperStart === rec.wrapperStartTime) return { state: 'live', record: rec };
  if (wrapperStart == null && pidAlive(rec.wrapperPid)) {
    return { state: 'unreadable', record: rec };
  }

  for (let attempt = 0; attempt <= SPAWN_DISCOVERY_RETRIES; attempt += 1) {
    if (attempt > 0) sleepSync(SOLVER_POLL_MS);
    const discovered = discoverTokenProcesses(rec.spawnToken);
    if (!discovered.ok || discovered.matches.length > 1) {
      return { state: 'unreadable', record: rec };
    }
    if (discovered.matches.length === 1) {
      const match = discovered.matches[0];
      if (startTimeOf(match.pid) !== match.startTime) {
        return { state: 'unreadable', record: rec };
      }
      const promoted = {
        ...rec,
        state: 'live',
        pid: match.pid,
        startTime: match.startTime,
      };
      writeJsonAtomic(solverRecordPath(gameDir), promoted);
      return { state: 'live', record: promoted };
    }
  }
  clearPersistedReservation(gameDir, rec.spawnToken);
  return { state: 'absent', record: null };
}

export function readPersistedSolver(gameDir, { processStartTime: startTimeOf = processStartTime } = {}) {
  if (!gameDir) return { state: 'absent', record: null };
  const file = solverRecordPath(gameDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', record: null };
    return { state: 'unreadable', record: null };
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { state: 'unreadable', record: null };
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { state: 'unreadable', record: rec ?? null };
  }
  if (rec.state === 'spawning') return resolveSpawningRecord(gameDir, rec, startTimeOf);
  if (rec.state !== undefined && rec.state !== 'live') {
    return { state: 'unreadable', record: rec };
  }
  const pid = rec.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'unreadable', record: rec };
  }
  const startTime = rec.startTime;
  if (!isStartTime(startTime)) {
    if (startTime == null || startTime === '') {
      const occupancy = occupancyOf(pid, startTime, startTimeOf);
      if (!occupancy.readable) return { state: 'unreadable', record: rec };
      return { state: occupancy.live ? 'unreadable' : 'dead', record: rec };
    }
    return { state: 'unreadable', record: rec };
  }
  const occupancy = occupancyOf(pid, startTime, startTimeOf);
  if (!occupancy.readable) return { state: 'unreadable', record: rec };
  return { state: occupancy.live ? 'live' : 'dead', record: rec };
}

export function hasPersistedLiveSolver(gameDir) {
  const rec = readPersistedSolver(gameDir);
  return rec.state === 'live' || rec.state === 'unreadable';
}

function persistSolver(gameDir, record) {
  writeJsonAtomic(solverRecordPath(gameDir), record);
}

function clearPersist(gameDir, spawnToken) {
  clearPersistedReservation(gameDir, spawnToken);
}

export async function runSolver({
  argv = [process.execPath, FAKE_CHILD],
  input = {},
  timeoutMs = 2_000,
  maxStdoutBytes = DEFAULT_STDOUT,
  maxRssKb = DEFAULT_RSS_KB,
  env = {},
  gameDir = null,
  processStartTime: startTimeOf = processStartTime,
} = {}) {
  if (hasLiveSolverChild(startTimeOf)) {
    throw coded('SOLVER_BUSY', '살아 있는 solver 자식이 있어 replacement를 기동하지 않습니다.');
  }
  if (gameDir) {
    const persisted = readPersistedSolver(gameDir, { processStartTime: startTimeOf });
    if (persisted.state === 'live' || persisted.state === 'unreadable') {
      throw coded('SOLVER_BUSY', '살아 있는 solver 자식이 있어 replacement를 기동하지 않습니다.');
    }
  }
  const spawnToken = randomUUID();
  if (gameDir) {
    const wrapperStartTime = startTimeOf(process.pid);
    if (!isStartTime(wrapperStartTime)) {
      throw coded('SOLVER_WRAPPER_IDENTITY_UNAVAILABLE', 'solver wrapper startTime을 얻지 못했습니다.');
    }
    persistSolver(gameDir, {
      state: 'spawning',
      wrapperPid: process.pid,
      wrapperStartTime,
      spawnToken,
      at: new Date().toISOString(),
    });
  }
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, [SOLVER_TOKEN_ENV]: spawnToken },
    });
  } catch (error) {
    clearPersist(gameDir, spawnToken);
    const failure = coded('SOLVER_SPAWN', error.message);
    failure.cause = error;
    throw failure;
  }
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    const error = await new Promise((resolve) => child.once('error', resolve));
    clearPersist(gameDir, spawnToken);
    const failure = coded('SOLVER_SPAWN', error.message);
    failure.cause = error;
    throw failure;
  }
  const startTime = startTimeOf(child.pid);
  live.set(child.pid, { startTime, child });
  if (gameDir) {
    persistSolver(gameDir, {
      state: 'live',
      pid: child.pid,
      startTime,
      spawnToken,
      at: new Date().toISOString(),
    });
  }
  let stdout = Buffer.alloc(0);
  let settled = false;
  let timer = null;
  let rssTimer = null;
  const finish = async (error, value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (rssTimer) clearInterval(rssTimer);
    const killed = await killGroup(child.pid, startTime, startTimeOf);
    if (!killed.confirmed) {
      const unconfirmed = coded(
        'SOLVER_TERMINATION_UNCONFIRMED',
        'solver 자식 종료를 확인하지 못했습니다.',
      );
      unconfirmed.termination = killed;
      if (error) unconfirmed.cause = error;
      throw unconfirmed;
    }
    live.delete(child.pid);
    clearPersist(gameDir, spawnToken);
    if (error) throw error;
    return value;
  };

  if (startTime == null) {
    return finish(coded('SOLVER_TERMINATION_UNCONFIRMED', 'solver startTime을 얻지 못했습니다.'));
  }

  child.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > maxStdoutBytes) {
      child.emit('solver-cap');
    }
  });

  rssTimer = setInterval(() => {
    const rss = rssKb(child.pid);
    if (rss != null && rss > maxRssKb) child.emit('solver-rss');
  }, SOLVER_POLL_MS);

  timer = setTimeout(() => child.emit('solver-timeout'), timeoutMs);
  child.stdin.write(`${JSON.stringify(input)}\n`);
  child.stdin.end();

  return new Promise((resolve, reject) => {
    const fail = (code, message) => {
      finish(coded(code, message)).catch(reject);
    };
    child.once('solver-timeout', () => fail('SOLVER_TIMEOUT', 'solver deadline exceeded'));
    child.once('solver-cap', () => fail('SOLVER_STDOUT_CAP', 'solver stdout exceeded cap'));
    child.once('solver-rss', () => fail('SOLVER_RSS', 'solver RSS exceeded ceiling'));
    child.once('error', (error) => fail(error.code ?? 'SOLVER_SPAWN', error.message));
    child.once('close', (code) => {
      if (settled) return;
      const text = stdout.toString('utf8').trim();
      if (!text) {
        fail('SOLVER_EXIT', `solver exited ${code ?? 'null'}`);
        return;
      }
      let parsed;
      try { parsed = JSON.parse(text); } catch {
        fail('SOLVER_MALFORMED', 'solver stdout is not JSON');
        return;
      }
      try {
        const result = assertSolverResult(parsed);
        result.detailSha256 = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
        finish(null, result).then(resolve, reject);
      } catch (error) {
        fail(error.code ?? 'SOLVER_INVALID', error.message);
      }
    });
  });
}

export { FAKE_CHILD };
