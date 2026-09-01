import { assertEvaluationId } from './contracts.js';
import { detailRefOf, trainingPayloadSha256 } from '../publish-contract.js';

function compactAction(action) {
  if (!action || typeof action !== 'object') return null;
  const out = { action: action.action ?? null };
  if (action.sizeBb != null) out.sizeBb = action.sizeBb;
  if (action.frequency != null) out.frequency = action.frequency;
  out.evBb = action.evBb ?? null;
  return out;
}

export function toPublicSummary(evaluation, extras = {}) {
  const evaluationId = assertEvaluationId(evaluation.evaluationId);
  const source = evaluation.source
    ? { id: evaluation.source.id, version: evaluation.source.version }
    : null;
  const summary = {
    evaluationId,
    handNo: extras.handNo,
    decisionId: evaluation.decisionId,
    status: evaluation.status,
    street: evaluation.street,
    spotKey: evaluation.spotKey ?? null,
    handClass: evaluation.handClass ?? null,
    chosen: compactAction(evaluation.chosen),
    recommended: Array.isArray(evaluation.recommended)
      ? evaluation.recommended.map(compactAction)
      : [],
    evLossBb: evaluation.evLossBb ?? null,
    grade: evaluation.grade ?? null,
    forced: Boolean(evaluation.forced),
    source,
    explanation: extras.explanation ?? null,
    detailRef: extras.detailRef ?? detailRefOf(evaluationId),
  };
  if (extras.detailSha256) summary.detailSha256 = extras.detailSha256;
  if (evaluation.code) summary.code = evaluation.code;
  if (evaluation.reason) summary.reason = evaluation.reason;
  summary.payloadSha256 = trainingPayloadSha256(summary);
  return summary;
}
