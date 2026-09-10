// Provisional operational limits, not measured model-thinking requirements.
// Soft wait never cancels a child. The hard limit includes CLI startup/repair.
export const DEFAULT_PLAYER_BUDGET = Object.freeze({ softMs: 25_000, hardMs: 300_000 });

export function playerBudget(input = {}) {
  const value = { ...DEFAULT_PLAYER_BUDGET, ...input };
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['softMs', 'hardMs'].includes(key))
    || !Number.isSafeInteger(value.softMs) || value.softMs < 1
    || !Number.isSafeInteger(value.hardMs) || value.hardMs < 1
    || value.hardMs > 3_600_000 || value.softMs >= value.hardMs) {
    throw Object.assign(new Error('LLM 대기 예산은 0 < soft < hard <= 3600000 ms여야 합니다.'), { code: 'BAD_PLAYER_BUDGET' });
  }
  return value;
}

export function playerFailureCategory(code) {
  if (code === 'TIMEOUT') return 'timeout';
  if (['CHILD_CLOSE_UNCONFIRMED', 'CHILD_SIGNAL_FAILED', 'IDENTITY_UNAVAILABLE'].includes(code)) return 'termination';
  if (['NO_SESSION', 'SESSION_NOT_FOUND', 'SESSION_EXPIRED'].includes(code)) return 'session';
  if (code === 'ILLEGAL_ACTION') return 'illegal_action';
  if (code === 'INVALID_DECISION') return 'response_format';
  return 'transport';
}
