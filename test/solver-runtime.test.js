import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processStartTime, writeJsonAtomic } from '../engine/state.js';
import { createCoachControl } from '../tools/coach-control.js';
import {
  FAKE_CHILD, hasLiveSolverChild, readPersistedSolver, runSolver,
} from '../tools/solver-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOLVE = path.join(ROOT, 'tools/solve-cli.js');

const GRANDCHILD_SCRIPT = [
  "const { spawn } = require('child_process');",
  "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  'process.on("SIGTERM", () => {});',
  'setInterval(() => {}, 1000);',
].join('\n');

const ORPHAN_SCRIPT = [
  "const { spawn } = require('child_process');",
  "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref();",
  'process.exit(0);',
].join('\n');

function tmpSolver() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-solver-'));
}

function persistPath(dir) {
  return path.join(dir, '.solver-child.json');
}

function processGroupPids(pgid) {
  try {
    const out = execFileSync('ps', ['-o', 'pid=', '-g', String(pgid)], { encoding: 'utf8' });
    return [...new Set(out.trim().split(/\s+/).filter(Boolean).map(Number))]
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  for (const child of processGroupPids(pid)) {
    try { process.kill(child, 'SIGKILL'); } catch { /* gone */ }
  }
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (lastError) throw new Error(`${message}: ${lastError.message}`);
  assert.fail(message);
}

async function cleanupSolverDir(dir) {
  let pid = null;
  try {
    pid = JSON.parse(fs.readFileSync(persistPath(dir), 'utf8'))?.pid ?? null;
  } catch { /* absent */ }
  killTree(pid);
  await waitFor(() => {
    if (pid && processGroupPids(pid).length) return false;
    return !hasLiveSolverChild();
  }, 'solver child did not exit after cleanup', 2_000);
  fs.rmSync(dir, { recursive: true, force: true });
}

test('ok fake solver returns heuristic result without EV', async () => {
  const result = await runSolver({ timeoutMs: 2_000 });
  assert.equal(result.accuracy, 'heuristic');
  assert.equal(result.evBb, null);
  assert.equal(hasLiveSolverChild(), false);
});

test('timeout/flood/partial/die fault matrix', async () => {
  await assert.rejects(
    () => runSolver({ timeoutMs: 200, env: { SOLVER_FAULT: 'timeout' } }),
    (error) => error.code === 'SOLVER_TIMEOUT',
  );
  await assert.rejects(
    () => runSolver({ timeoutMs: 1_000, maxStdoutBytes: 8_192, env: { SOLVER_FAULT: 'flood' } }),
    (error) => error.code === 'SOLVER_STDOUT_CAP',
  );
  await assert.rejects(
    () => runSolver({ timeoutMs: 1_000, env: { SOLVER_FAULT: 'partial' } }),
    (error) => error.code === 'SOLVER_MALFORMED',
  );
  await assert.rejects(
    () => runSolver({ timeoutMs: 1_000, env: { SOLVER_FAULT: 'die' } }),
    (error) => error.code === 'SOLVER_EXIT',
  );
  assert.equal(hasLiveSolverChild(), false);
});

test('ignore-term is killed and a second solve is not started while live', async () => {
  const first = runSolver({ timeoutMs: 300, env: { SOLVER_FAULT: 'ignore-term' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (hasLiveSolverChild()) {
    await assert.rejects(() => runSolver({ timeoutMs: 200 }), (error) => error.code === 'SOLVER_BUSY');
  }
  await assert.rejects(() => first, (error) => error.code === 'SOLVER_TIMEOUT');
  assert.equal(hasLiveSolverChild(), false);
});

test('solve-cli prints heuristic envelope', () => {
  const out = JSON.parse(execFileSync(process.execPath, [SOLVE], { encoding: 'utf8' }).trim());
  assert.equal(out.ok, true);
  assert.equal(out.result.evBb, null);
});

test('startTime failure with a live grandchild stays unconfirmed and holds SOLVER_BUSY', async (t) => {
  const dir = tmpSolver();
  t.after(() => cleanupSolverDir(dir));
  await assert.rejects(
    () => runSolver({
      argv: [process.execPath, '-e', GRANDCHILD_SCRIPT],
      gameDir: dir,
      timeoutMs: 800,
      processStartTime: () => null,
    }),
    (error) => error.code === 'SOLVER_TERMINATION_UNCONFIRMED',
  );
  assert.equal(hasLiveSolverChild(), true);
  const persisted = readPersistedSolver(dir);
  assert.equal(['live', 'unreadable'].includes(persisted.state), true);
  const pid = persisted.record?.pid;
  assert.ok(Number.isInteger(pid));
  await waitFor(() => processGroupPids(pid).length > 1, 'grandchild did not stay in the process group');
  await assert.rejects(
    () => runSolver({ gameDir: dir, timeoutMs: 200 }),
    (error) => error.code === 'SOLVER_BUSY',
  );
});

test('PID reuse with a different startTime does not kill the reused process', async (t) => {
  const dir = tmpSolver();
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  dummy.unref();
  t.after(async () => {
    killTree(dummy.pid);
    await cleanupSolverDir(dir);
  });
  const realStart = await waitFor(() => processStartTime(dummy.pid), 'dummy startTime');
  assert.notEqual(realStart, 'Mon Jan  1 00:00:00 2001');
  fs.writeFileSync(persistPath(dir), JSON.stringify({
    pid: dummy.pid,
    startTime: 'Mon Jan  1 00:00:00 2001',
  }));
  assert.equal(readPersistedSolver(dir)?.state, 'dead');
  const result = await runSolver({ gameDir: dir, timeoutMs: 2_000 });
  assert.equal(result.accuracy, 'heuristic');
  process.kill(dummy.pid, 0);
});

test('malformed solver record is unreadable: runSolver BUSY and rollback refused', async () => {
  const dir = tmpSolver();
  fs.writeFileSync(persistPath(dir), '{');
  writeJsonAtomic(path.join(dir, 'state.json'), { lastHand: null });
  assert.equal(readPersistedSolver(dir)?.state, 'unreadable');
  await assert.rejects(
    () => runSolver({ gameDir: dir, timeoutMs: 500 }),
    (error) => error.code === 'SOLVER_BUSY',
  );
  const cc = createCoachControl();
  const guard = await cc.assertRollbackAllowed(dir);
  assert.equal(guard.code, 'ROLLBACK_REFUSED');
  assert.equal(guard.reasons.some((reason) => reason.code === 'solver_record_unreadable'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('leader gone with a descendant still in the process group is live', async (t) => {
  const dir = tmpSolver();
  const leader = spawn(process.execPath, ['-e', ORPHAN_SCRIPT], {
    detached: true,
    stdio: 'ignore',
  });
  const pid = leader.pid;
  const startTime = await waitFor(() => processStartTime(pid), 'leader startTime');
  t.after(async () => {
    killTree(pid);
    await cleanupSolverDir(dir);
  });
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }, 'leader did not exit');
  await waitFor(
    () => processGroupPids(pid).some((child) => child !== pid),
    'descendant did not remain after leader exit',
  );
  fs.writeFileSync(persistPath(dir), JSON.stringify({ pid, startTime }));
  assert.equal(readPersistedSolver(dir)?.state, 'live');
  await assert.rejects(
    () => runSolver({ gameDir: dir, timeoutMs: 500 }),
    (error) => error.code === 'SOLVER_BUSY',
  );
});
