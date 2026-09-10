import { createHash } from 'node:crypto';

export const POLICY_ACTIONS = new Set(['fold', 'check', 'call', 'raise']);
export const VERSION_V2 = '2.2.0';
export const PREDECESSOR_VERSIONS_V2 = Object.freeze(['2.0.0', '2.1.0']);

export function isStrategyV2(config) {
  return config?.base === 'strategy-v2';
}

export function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function configDigestOf(config) {
  const copy = { ...config };
  delete copy.configDigest;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

export function raiseAmount(legal, { sizeBb, bb } = {}) {
  if (!legal?.canRaise) return null;
  if (legal.minRaiseTo > legal.maxRaiseTo) return legal.maxRaiseTo;
  if (sizeBb != null && bb) {
    const amount = Math.round(sizeBb * bb);
    if (amount >= legal.minRaiseTo && amount <= legal.maxRaiseTo) return amount;
  }
  return legal.minRaiseTo;
}

export function clampRaiseTo(target, legal) {
  if (!legal?.canRaise) return null;
  if (legal.minRaiseTo > legal.maxRaiseTo) return legal.maxRaiseTo;
  if (target < legal.minRaiseTo) return legal.minRaiseTo;
  if (target > legal.maxRaiseTo) return legal.maxRaiseTo;
  return target;
}

export function legalizeOne(entry, legal, { bb } = {}) {
  if (!entry || !POLICY_ACTIONS.has(entry.action)) return null;
  if (entry.action === 'fold') {
    if (legal.canCheck) return { action: 'check', amount: 0 };
    return { action: 'fold', amount: 0 };
  }
  if (entry.action === 'check') {
    if (!legal.canCheck) return null;
    return { action: 'check', amount: 0 };
  }
  if (entry.action === 'call') {
    if (legal.canCheck || !(legal.callAmount > 0)) return null;
    return { action: 'call', amount: legal.callAmount };
  }
  const amount = Number.isSafeInteger(entry.raiseTo)
    ? clampRaiseTo(entry.raiseTo, legal)
    : raiseAmount(legal, { sizeBb: entry.sizeBb, bb });
  if (amount == null) return null;
  return { action: 'raise', amount };
}

export function renormalize(entries) {
  const grouped = new Map();
  for (const entry of entries ?? []) {
    if (!entry || !(entry.frequency > 0)) continue;
    const key = `${entry.action}:${entry.amount ?? 0}`;
    const prev = grouped.get(key);
    if (prev) prev.frequency += entry.frequency;
    else grouped.set(key, { ...entry });
  }
  const list = [...grouped.values()];
  const sum = list.reduce((total, entry) => total + entry.frequency, 0);
  if (sum <= 0) return [];
  return list.map((entry) => ({ ...entry, frequency: entry.frequency / sum }));
}

export function legalizeEntries(entries, legal, opts = {}) {
  const mapped = [];
  for (const entry of entries ?? []) {
    const next = legalizeOne(entry, legal, opts);
    if (next) mapped.push({ ...entry, ...next });
  }
  return renormalize(mapped);
}

export function fallbackLegal(legal) {
  if (legal?.canCheck) {
    return [{ action: 'check', amount: 0, frequency: 1, reasonCode: 'fallback-check' }];
  }
  return [{ action: 'fold', amount: 0, frequency: 1, reasonCode: 'fallback-fold' }];
}

export function validatePolicyOutput(out, legal) {
  if (!out || !POLICY_ACTIONS.has(out.action)) {
    throw coded('POLICY_ILLEGAL', 'policy 액션이 없습니다.');
  }
  if (out.action === 'check' && !legal.canCheck) throw coded('POLICY_ILLEGAL', 'check 불가');
  if (out.action === 'fold' && legal.canCheck) throw coded('POLICY_ILLEGAL', 'check 가능 시 fold 불가');
  if (out.action === 'call' && (legal.canCheck || !(legal.callAmount > 0))) {
    throw coded('POLICY_ILLEGAL', 'call 불가');
  }
  if (out.action === 'raise') {
    if (!legal.canRaise) throw coded('POLICY_ILLEGAL', 'raise 불가');
    if (!Number.isInteger(out.amount)) throw coded('POLICY_ILLEGAL', 'raise-to 정수');
    if (legal.minRaiseTo > legal.maxRaiseTo) {
      if (out.amount !== legal.maxRaiseTo) throw coded('POLICY_ILLEGAL', '올인만 가능');
    } else if (out.amount < legal.minRaiseTo || out.amount > legal.maxRaiseTo) {
      throw coded('POLICY_ILLEGAL', 'raise-to 범위');
    }
  }
  return out;
}
