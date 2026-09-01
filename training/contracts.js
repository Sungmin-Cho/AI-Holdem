export const ERRORS = Object.freeze({
  UNSUPPORTED_SPOT: 'UNSUPPORTED_SPOT',
  UNSUPPORTED_SIZE: 'UNSUPPORTED_SIZE',
  UNSUPPORTED_STACK: 'UNSUPPORTED_STACK',
  DATASET_INVALID: 'DATASET_INVALID',
  SNAPSHOT_INVALID: 'SNAPSHOT_INVALID',
  EVALUATION_ID_INVALID: 'EVALUATION_ID_INVALID',
});

const EVALUATION_ID_RE = /^([0-9a-f]{64}):(d-\d+-[a-z]+-\d+):([a-z0-9-]{1,64})@(\d+\.\d+\.\d+)$/;
const EVALUATION_ID_MAX = 256;

const FREQ_EPS = 1e-6;

export function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || typeof snapshot.decisionId !== 'string') {
    throw coded(ERRORS.SNAPSHOT_INVALID, 'decision snapshot이 올바르지 않습니다.');
  }
  if (!Array.isArray(snapshot.holeCards) || snapshot.holeCards.length !== 2) {
    throw coded(ERRORS.SNAPSHOT_INVALID, 'holeCards가 없습니다.');
  }
}

export function frequenciesSumToOne(actions, { tolerance = 0.01 } = {}) {
  const sum = actions.reduce((total, action) => total + (action.frequency ?? 0), 0);
  return Math.abs(sum - 1) <= tolerance + FREQ_EPS;
}

export function evaluationIdOf({ gameEpoch, decisionId, providerId, providerVersion }) {
  return `${gameEpoch}:${decisionId}:${providerId}@${providerVersion}`;
}

export function assertEvaluationId(evaluationId) {
  if (typeof evaluationId !== 'string'
    || evaluationId.length > EVALUATION_ID_MAX
    || !EVALUATION_ID_RE.test(evaluationId)) {
    throw coded(ERRORS.EVALUATION_ID_INVALID, 'evaluationId가 계약 문법을 벗어났습니다.');
  }
  return evaluationId;
}
