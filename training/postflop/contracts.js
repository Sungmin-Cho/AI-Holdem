export const SOLVER_ACCURACY = Object.freeze(['heuristic', 'simulated', 'exact']);

export function emptyRangeMatrix() {
  return { schemaVersion: 1, accuracy: 'heuristic', cells: [], evBb: null };
}

export function assertSolverResult(result) {
  if (!result || result.schemaVersion !== 1) {
    const error = new Error('invalid solver result');
    error.code = 'SOLVER_INVALID';
    throw error;
  }
  if (result.accuracy === 'heuristic' && result.evBb != null) {
    const error = new Error('heuristic solver must not invent EV');
    error.code = 'FAKE_EV';
    throw error;
  }
  return result;
}
