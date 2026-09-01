import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FAKE_CHILD, hasLiveSolverChild, runSolver,
} from '../tools/solver-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOLVE = path.join(ROOT, 'tools/solve-cli.js');

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
