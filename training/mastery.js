export function confidenceOf(opportunities) {
  const n = Number(opportunities) || 0;
  return Math.min(1, n / 20);
}

export function masteryOf({ preferredActionRate = 0, opportunities = 0 } = {}) {
  const confidence = confidenceOf(opportunities);
  return Math.round((preferredActionRate ?? 0) * 100 * (0.5 + 0.5 * confidence));
}
