import { fallbackLegal, legalizeEntries, raiseAmount, renormalize } from './contracts.js';

export function ruleBasedDistribution(legal, config = {}, opts = {}) {
  if (legal?.canCheck) {
    const checkFreq = config.checkFreq ?? 0.75;
    const items = [{ action: 'check', amount: 0, frequency: checkFreq, reasonCode: 'rule-check' }];
    const amount = raiseAmount(legal, opts);
    if (amount != null) {
      items.push({ action: 'raise', amount, frequency: 1 - checkFreq, reasonCode: 'rule-bet' });
    }
    const next = renormalize(items);
    return next.length ? next : fallbackLegal(legal);
  }
  const items = [
    { action: 'fold', amount: 0, frequency: config.foldVsBet ?? 0.55, reasonCode: 'rule-fold' },
    { action: 'call', amount: legal.callAmount, frequency: config.callVsBet ?? 0.35, reasonCode: 'rule-call' },
  ];
  const amount = raiseAmount(legal, opts);
  if (amount != null) {
    items.push({
      action: 'raise',
      amount,
      frequency: config.raiseVsBet ?? 0.10,
      reasonCode: 'rule-raise',
    });
  }
  const next = legalizeEntries(items, legal, opts);
  return next.length ? next : fallbackLegal(legal);
}
