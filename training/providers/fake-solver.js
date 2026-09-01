import { runSolver, FAKE_CHILD } from '../../tools/solver-runtime.js';

export function fakeSolverArgv() {
  return [process.execPath, FAKE_CHILD];
}

export async function solveWithFake(input, opts = {}) {
  return runSolver({ argv: fakeSolverArgv(), input, ...opts });
}
