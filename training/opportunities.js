import { assertEvaluationId } from './contracts.js';

export const PREFLOP_SPOT_RE = /^6max-100bb-(utg|hj|co|btn|sb|bb)-(rfi-unopened|vs-single-raise)$/;

export function isPreflopSpotKey(spotKey) {
  return typeof spotKey === 'string' && PREFLOP_SPOT_RE.test(spotKey);
}

export function skillKeyOf({ spotKey } = {}) {
  const match = typeof spotKey === 'string' ? PREFLOP_SPOT_RE.exec(spotKey) : null;
  if (!match) return 'unknown';
  const [, seat, context] = match;
  const pos = seat.toUpperCase();
  if (context === 'rfi-unopened') return `preflop.rfi.${pos}`;
  if (context === 'vs-single-raise') {
    return pos === 'BB' ? 'preflop.bbDefense.vsRaise' : `preflop.vsRaise.${pos}`;
  }
  return 'unknown';
}

export function classifyOpportunity(evaluation = {}) {
  let canonicalStreet = null;
  if (evaluation.evaluationId != null) {
    assertEvaluationId(evaluation.evaluationId);
    canonicalStreet = evaluation.evaluationId.split(':')[1].split('-')[2];
  }
  const street = evaluation.street ?? canonicalStreet ?? 'preflop';
  const learnable = street === 'preflop';
  return {
    skillKey: learnable
      ? (isPreflopSpotKey(evaluation.spotKey) ? skillKeyOf(evaluation) : 'preflop.unknown')
      : `postflop.${street}`,
    street,
    learnable,
    supported: evaluation.status === 'supported',
    forced: Boolean(evaluation.forced),
    grade: evaluation.grade ?? null,
    evLossBb: evaluation.evLossBb ?? null,
    providerId: evaluation.source?.id ?? 'unknown',
    providerVersion: evaluation.source?.version ?? '0.0.0',
  };
}
