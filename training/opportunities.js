export function skillKeyOf({ spotKey } = {}) {
  if (typeof spotKey !== 'string' || !spotKey) return 'preflop.unknown';
  const parts = spotKey.split('-');
  const pos = (parts[2] ?? 'unk').toUpperCase();
  const context = parts.slice(3).join('-');
  if (context === 'rfi-unopened') return `preflop.rfi.${pos}`;
  if (context === 'vs-single-raise') {
    return pos === 'BB' ? 'preflop.bbDefense.vsRaise' : `preflop.vsRaise.${pos}`;
  }
  return `preflop.other.${pos}`;
}

export function classifyOpportunity(evaluation) {
  return {
    skillKey: skillKeyOf(evaluation),
    street: evaluation.street ?? 'preflop',
    supported: evaluation.status === 'supported',
    forced: Boolean(evaluation.forced),
    grade: evaluation.grade ?? null,
    evLossBb: evaluation.evLossBb ?? null,
    providerId: evaluation.source?.id ?? 'unknown',
    providerVersion: evaluation.source?.version ?? '0.0.0',
  };
}
