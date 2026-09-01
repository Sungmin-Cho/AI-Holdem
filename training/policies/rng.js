import { createHash } from 'node:crypto';

export function deriveUnit(policySeed, gameEpoch, decisionId, policyId) {
  if ([policySeed, gameEpoch, decisionId, policyId].some((value) => value == null || value === '')) {
    const error = new Error('rng 입력이 비어 있습니다.');
    error.code = 'POLICY_RNG_INVALID';
    throw error;
  }
  const digest = createHash('sha256')
    .update(`${policySeed}|${gameEpoch}|${decisionId}|${policyId}`)
    .digest();
  const n = digest.readUInt32BE(0) * (2 ** 21) + (digest.readUInt32BE(4) >>> 11);
  return n / (2 ** 53);
}

export function sampleWeighted(items, unit) {
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('빈 분포입니다.');
    error.code = 'POLICY_DIST_EMPTY';
    throw error;
  }
  const u = Math.min(Math.max(Number(unit), 0), 1 - Number.EPSILON);
  let acc = 0;
  for (const item of items) {
    acc += item.frequency;
    if (u < acc) return item;
  }
  return items[items.length - 1];
}
