import { assertEvaluationId } from './contracts.js';
import {
  detailRefOf,
  projectTrainingSummary,
} from '../publish-contract.js';

export function toPublicSummary(evaluation, extras = {}) {
  const evaluationId = assertEvaluationId(evaluation.evaluationId);
  const recommended = Array.isArray(evaluation.recommended)
    ? [...evaluation.recommended].sort((left, right) => (right.frequency ?? 0) - (left.frequency ?? 0)
      || String(left.action ?? '').localeCompare(String(right.action ?? '')))
    : [];
  const truncated = recommended.length > 4;
  return projectTrainingSummary({
    ...evaluation,
    evaluationId,
    recommended: recommended.slice(0, 4),
    recommendedTruncated: truncated,
    handNo: extras.handNo,
    detailRef: extras.detailRef ?? detailRefOf(evaluationId),
    detailSha256: extras.detailSha256,
  });
}
