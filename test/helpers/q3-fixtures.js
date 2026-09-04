import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processStartTime } from '../../engine/state.js';
import { evaluationIdOf } from '../../training/contracts.js';

export function tmpQ3(prefix = 'holdem-q3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

export function q3Evaluation(gameEpoch, decisionId = 'd-1-preflop-0') {
  return {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch,
      decisionId,
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId,
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96, evBb: null }],
    chosen: { action: 'fold', frequency: 0.04, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'mixed',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  };
}

export async function waitFor(probe, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (lastError) throw new Error(`${message}: ${lastError.message}`);
  throw new Error(message);
}

export async function spawnTokenChild(token) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AI_HOLDEM_SOLVER_TOKEN: token },
  });
  child.unref();
  await waitFor(() => processIsAlive(child.pid), `token child ${child.pid} did not start`);
  const startTime = processStartTime(child.pid) ?? 'Wed Sep  4 12:34:56 2026';
  return { child, pid: child.pid, startTime };
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export async function killProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone or not a group leader */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await waitFor(
    () => !processIsAlive(pid),
    `process group ${pid} did not exit during test cleanup`,
    3_000,
  ).catch(() => {});
}
