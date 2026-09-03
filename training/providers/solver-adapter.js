import { solveWithFake } from './fake-solver.js';

export const DEFAULT_SOLVER_ADAPTER = 'fake-solver';

// CI가 쓰는 adapter는 fake 하나다. 실제 solver는 사용자 설치형이며 여기에
// 등록되지 않은 id는 fail-closed로 거부한다 — 조용히 fake로 떨어지면 "solve
// 했다"는 거짓 증거가 남는다.
const ADAPTERS = new Map([
  [DEFAULT_SOLVER_ADAPTER, solveWithFake],
]);

export function solverAdapterIds() {
  return [...ADAPTERS.keys()];
}

export async function solvePostflop(snapshot, opts = {}) {
  const { adapterId = DEFAULT_SOLVER_ADAPTER, ...rest } = opts;
  const adapter = ADAPTERS.get(adapterId);
  if (!adapter) {
    const error = new Error(`알 수 없는 solver adapter: ${adapterId}`);
    error.code = 'SOLVER_ADAPTER_UNKNOWN';
    throw error;
  }
  return adapter({
    street: snapshot?.street ?? 'flop',
    board: snapshot?.board ?? [],
    decisionId: snapshot?.decisionId ?? null,
  }, rest);
}
