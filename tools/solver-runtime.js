import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime } from '../engine/state.js';
import { assertSolverResult } from '../training/postflop/contracts.js';

const FAKE_CHILD = fileURLToPath(new URL('./fake-solver-child.js', import.meta.url));
const DEFAULT_STDOUT = 256 * 1024;
const DEFAULT_RSS_KB = 256 * 1024;
const SOLVER_RECORD = '.solver-child.json';
const live = new Map();

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rssKb(pid) {
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

export async function killGroup(pid, startTime, startTimeOf) {
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

export function readPersistedSolver(gameDir, { processStartTime: startTimeOf = processStartTime } = {}) {
  if (!gameDir) return { state: 'absent', record: null };
  const file = path.join(gameDir, SOLVER_RECORD);
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
  fs.writeFileSync(path.join(gameDir, SOLVER_RECORD), JSON.stringify(record));
}

function clearPersist(gameDir) {
  if (!gameDir) return;
  try { fs.unlinkSync(path.join(gameDir, SOLVER_RECORD)); } catch { /* gone */ }
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
  const child = spawn(argv[0], argv.slice(1), {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const startTime = startTimeOf(child.pid);
  live.set(child.pid, { startTime, child });
  if (gameDir) persistSolver(gameDir, { pid: child.pid, startTime });
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
    clearPersist(gameDir);
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
  }, 50);

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
