export const ERRORS = Object.freeze({
  UNSUPPORTED_SPOT: 'UNSUPPORTED_SPOT',
  UNSUPPORTED_SIZE: 'UNSUPPORTED_SIZE',
  UNSUPPORTED_STACK: 'UNSUPPORTED_STACK',
  DATASET_INVALID: 'DATASET_INVALID',
  SNAPSHOT_INVALID: 'SNAPSHOT_INVALID',
});

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
