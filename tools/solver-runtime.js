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
const live = new Map();

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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

async function killGroup(pid, startTime) {
  const stillOurs = () => processStartTime(pid) === startTime;
  try { process.kill(-pid, 'SIGTERM'); } catch (error) {
    if (error.code !== 'ESRCH') {
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    }
  }
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    if (!stillOurs()) return { confirmed: true };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try { process.kill(-pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  return stillOurs()
    ? { confirmed: false, reason: 'termination_unconfirmed' }
    : { confirmed: true };
}

export function hasLiveSolverChild() {
  for (const [pid, rec] of [...live.entries()]) {
    if (processStartTime(pid) !== rec.startTime) live.delete(pid);
  }
  return live.size > 0;
}

export function readPersistedSolver(gameDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(gameDir, '.solver-child.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function hasPersistedLiveSolver(gameDir) {
  const rec = readPersistedSolver(gameDir);
  if (!rec?.pid || !rec.startTime) return false;
  return processStartTime(rec.pid) === rec.startTime;
}

export async function runSolver({
  argv = [process.execPath, FAKE_CHILD],
  input = {},
  timeoutMs = 2_000,
  maxStdoutBytes = DEFAULT_STDOUT,
  maxRssKb = DEFAULT_RSS_KB,
  env = {},
  gameDir = null,
} = {}) {
  if (hasLiveSolverChild()) {
    throw coded('SOLVER_BUSY', '살아 있는 solver 자식이 있어 replacement를 기동하지 않습니다.');
  }
  const child = spawn(argv[0], argv.slice(1), {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const startTime = processStartTime(child.pid);
  live.set(child.pid, { startTime, child });
  if (gameDir) {
    fs.writeFileSync(path.join(gameDir, '.solver-child.json'), JSON.stringify({
      pid: child.pid,
      startTime,
    }));
  }
  let stdout = Buffer.alloc(0);
  let settled = false;
  const finish = async (error, value) => {
    if (settled) return;
    settled = true;
    const killed = await killGroup(child.pid, startTime);
    live.delete(child.pid);
    if (gameDir) {
      try { fs.unlinkSync(path.join(gameDir, '.solver-child.json')); } catch { /* gone */ }
    }
    if (error) {
      if (!killed.confirmed) error.termination = killed;
      throw error;
    }
    return value;
  };

  child.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > maxStdoutBytes) {
      child.emit('solver-cap');
    }
  });

  const rssTimer = setInterval(() => {
    const rss = rssKb(child.pid);
    if (rss != null && rss > maxRssKb) child.emit('solver-rss');
  }, 50);

  const timer = setTimeout(() => child.emit('solver-timeout'), timeoutMs);
  child.stdin.write(`${JSON.stringify(input)}\n`);
  child.stdin.end();

  return new Promise((resolve, reject) => {
    const fail = (code, message) => {
      clearTimeout(timer);
      clearInterval(rssTimer);
      finish(coded(code, message)).catch(reject);
    };
    child.once('solver-timeout', () => fail('SOLVER_TIMEOUT', 'solver deadline exceeded'));
    child.once('solver-cap', () => fail('SOLVER_STDOUT_CAP', 'solver stdout exceeded cap'));
    child.once('solver-rss', () => fail('SOLVER_RSS', 'solver RSS exceeded ceiling'));
    child.once('error', (error) => fail(error.code ?? 'SOLVER_SPAWN', error.message));
    child.once('close', (code) => {
      clearTimeout(timer);
      clearInterval(rssTimer);
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
