export function confidenceOf(opportunities) {
  const n = Number(opportunities) || 0;
  return Math.min(1, n / 20);
}

export function sampleWeightOf(observations) {
  const n = Math.max(0, Number(observations) || 0);
  return Math.min(1, n / 20);
}

export function learningRates({ supported = 0, allowed = 0, preferred = 0 } = {}) {
  return {
    allowedActionRate: supported ? allowed / supported : 0,
    modalActionRate: supported ? preferred / supported : 0,
    sampleWeight: sampleWeightOf(supported),
  };
}

export function masteryOf({ preferredActionRate = 0, opportunities = 0 } = {}) {
  const confidence = confidenceOf(opportunities);
  return Math.round((preferredActionRate ?? 0) * 100 * (0.5 + 0.5 * confidence));
}
