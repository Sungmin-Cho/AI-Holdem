import { solveWithFake } from './fake-solver.js';

export async function solvePostflop(snapshot, opts = {}) {
  return solveWithFake({
    street: snapshot?.street ?? 'flop',
    board: snapshot?.board ?? [],
    decisionId: snapshot?.decisionId ?? null,
  }, opts);
}
