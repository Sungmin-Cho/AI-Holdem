import { legalizeOne, renormalize } from './contracts.js';

export function matchesSelector(selector, snapshot) {
  if (!selector) return true;
  if (selector.street && snapshot?.street !== selector.street) return false;
  if (selector.facingBet === true && !(snapshot?.toCall > 0)) return false;
  if (selector.facingBet === false && snapshot?.toCall > 0) return false;
  return true;
}

export function applyDeviations(entries, deviations, snapshot, legal, opts = {}) {
  const dist = new Map();
  for (const entry of entries ?? []) {
    dist.set(entry.action, { ...entry });
  }
  for (const deviation of deviations ?? []) {
    if (deviation.operation !== 'shift') continue;
    if (!matchesSelector(deviation.selector, snapshot)) continue;
    const from = dist.get(deviation.from);
    if (!from) continue;
    const take = Math.min(from.frequency, deviation.probability ?? 0);
    if (take <= 0) continue;
    from.frequency -= take;
    let to = dist.get(deviation.to);
    if (!to) {
      const legalized = legalizeOne({ action: deviation.to }, legal, opts);
      if (!legalized) continue;
      to = { ...legalized, frequency: 0, reasonCode: 'deviation' };
      dist.set(deviation.to, to);
    }
    to.frequency += take;
  }
  return renormalize([...dist.values()]);
}
