import { createHash } from 'node:crypto';

export const MAX_PUBLISH_BODY_BYTES = 65_536;
export const MAX_PUBLISH_ID = Number.MAX_SAFE_INTEGER;
export const SUPPORTED_COACH_AUTHORITY_SCHEMAS = Object.freeze([2]);

export function utf8ByteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : String(value), 'utf8');
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function canonicalPayloadJson({ handNo, text, overfold = false, unavailable = false }) {
  return JSON.stringify({
    handNo,
    text,
    overfold: Boolean(overfold),
    unavailable: Boolean(unavailable),
  });
}

export function payloadSha256(tuple) {
  return sha256Hex(canonicalPayloadJson(tuple));
}

export function publicProofId(queueId) {
  return sha256Hex(queueId);
}

export function proofBearingCoachNote(tuple, proof) {
  const note = { handNo: tuple.handNo, text: tuple.text };
  if (tuple.overfold) note.overfold = true;
  if (tuple.unavailable) note.unavailable = true;
  note.coachProof = { id: proof.id, payloadSha256: proof.payloadSha256 };
  return note;
}

export function proofBearingPublishBody(tuple, proof, publishId = MAX_PUBLISH_ID) {
  return JSON.stringify({
    publishId,
    coach: [proofBearingCoachNote(tuple, proof)],
  });
}

export function publishBodyByteLength(tuple, proof, publishId = MAX_PUBLISH_ID) {
  return utf8ByteLength(proofBearingPublishBody(tuple, proof, publishId));
}

export function gameEpochOf(sessionToken) {
  return sha256Hex(sessionToken);
}

export const SUPPORTED_TRAINING_AUTHORITY_SCHEMAS = Object.freeze([1, 2]);
export const TRAINING_CHUNK_SLACK_BYTES = 4096;
export const TRAINING_SUMMARY_LIMITS = Object.freeze({
  reason: 256,
  key: 64,
  version: 32,
  explanation: 600,
});

const ALLOWED_ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'bet']);

const TRAINING_SUMMARY_KEYS = Object.freeze([
  'evaluationId',
  'handNo',
  'decisionId',
  'status',
  'street',
  'spotKey',
  'handClass',
  'chosen',
  'recommended',
  'evLossBb',
  'grade',
  'forced',
  'source',
  'recommendedTruncated',
  'detailRef',
  'detailSha256',
  'code',
  'reason',
]);

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertCappedString(value, max, label) {
  if (value == null) return;
  if (typeof value !== 'string') {
    throw coded('TRAINING_PROOF_MISMATCH', `${label} must be a string`);
  }
  if (value.length > max) {
    throw coded('SUMMARY_FIELD_TOO_LONG', `${label} exceeds ${max} characters`);
  }
}

export function compactAction(action) {
  if (action == null) return null;
  if (typeof action !== 'object' || Array.isArray(action)) {
    throw coded('TRAINING_PROOF_MISMATCH', 'action must be an object');
  }
  const name = action.action;
  if (name != null) {
    if (typeof name !== 'string' || !ALLOWED_ACTIONS.has(name)) {
      throw coded('TRAINING_PROOF_MISMATCH', 'action leaf type invalid');
    }
  }
  const out = { action: name ?? null };
  if (action.sizeBb != null) {
    if (!Number.isFinite(action.sizeBb)) {
      throw coded('TRAINING_PROOF_MISMATCH', 'sizeBb must be a finite number');
    }
    out.sizeBb = action.sizeBb;
  }
  if (action.frequency != null) {
    if (!Number.isFinite(action.frequency) || action.frequency < 0 || action.frequency > 1) {
      throw coded('TRAINING_PROOF_MISMATCH', 'frequency must be a number in 0..1');
    }
    out.frequency = action.frequency;
  }
  if (action.evBb != null) {
    if (!Number.isFinite(action.evBb)) {
      throw coded('TRAINING_PROOF_MISMATCH', 'evBb must be a finite number');
    }
    out.evBb = action.evBb;
  } else {
    out.evBb = null;
  }
  return out;
}

function compactSource(source) {
  if (source == null) return null;
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw coded('TRAINING_PROOF_MISMATCH', 'source must be an object');
  }
  if (source.id != null && typeof source.id !== 'string') {
    throw coded('TRAINING_PROOF_MISMATCH', 'source.id leaf type invalid');
  }
  if (source.version != null && typeof source.version !== 'string') {
    throw coded('TRAINING_PROOF_MISMATCH', 'source.version leaf type invalid');
  }
  assertCappedString(source.id, TRAINING_SUMMARY_LIMITS.key, 'source.id');
  assertCappedString(source.version, TRAINING_SUMMARY_LIMITS.version, 'source.version');
  const out = {};
  if (source.id !== undefined) out.id = source.id;
  if (source.version !== undefined) out.version = source.version;
  return out;
}

export function detailRefOf(evaluationId) {
  return sha256Hex(String(evaluationId));
}

export function canonicalTrainingJson(summary) {
  const out = {};
  for (const key of TRAINING_SUMMARY_KEYS) {
    if (summary?.[key] !== undefined) out[key] = summary[key];
  }
  return JSON.stringify(out);
}

export function trainingPayloadSha256(summary) {
  return sha256Hex(canonicalTrainingJson(summary));
}

export function projectTrainingSummary(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw coded('TRAINING_PROOF_MISMATCH', 'training summary must be an object');
  }
  assertCappedString(item.reason, TRAINING_SUMMARY_LIMITS.reason, 'reason');
  assertCappedString(item.spotKey, TRAINING_SUMMARY_LIMITS.key, 'spotKey');
  assertCappedString(item.handClass, TRAINING_SUMMARY_LIMITS.key, 'handClass');
  assertCappedString(item.code, TRAINING_SUMMARY_LIMITS.key, 'code');
  const recommended = Array.isArray(item.recommended) ? item.recommended.map(compactAction) : [];
  const out = {
    evaluationId: item.evaluationId,
    handNo: item.handNo,
    decisionId: item.decisionId,
    status: item.status,
    street: item.street,
    spotKey: item.spotKey ?? null,
    handClass: item.handClass ?? null,
    chosen: compactAction(item.chosen),
    recommended,
    evLossBb: item.evLossBb ?? null,
    grade: item.grade ?? null,
    forced: Boolean(item.forced),
    source: compactSource(item.source),
  };
  if (item.detailRef !== undefined) out.detailRef = item.detailRef;
  if (item.detailSha256) out.detailSha256 = item.detailSha256;
  if (item.code) out.code = item.code;
  if (item.reason) out.reason = item.reason;
  out.recommendedTruncated = item.recommendedTruncated === true;
  out.payloadSha256 = trainingPayloadSha256(out);
  return out;
}

function projectExploitValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit value must be an object');
  }
  const opponents = Array.isArray(value.opponents)
    ? value.opponents.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit opponent must be an object');
      }
      const out = {
        opponentId: row.opponentId,
        policyId: row.policyId,
        adjustment: row.adjustment,
      };
      if (row.comparison && typeof row.comparison === 'object' && !Array.isArray(row.comparison)) {
        out.comparison = { summaryCode: row.comparison.summaryCode };
      }
      return out;
    })
    : [];
  return { opponents, primary: value.primary };
}

export function annotationCanonicalJson({ field, status, value }) {
  return JSON.stringify({ field, status, value });
}

export function annotationValueSha256(tuple) {
  return sha256Hex(annotationCanonicalJson(tuple));
}

export function projectTrainingAnnotation({ evaluationId, payloadSha256, field, value, status }) {
  if (field !== 'explanation' && field !== 'exploit') {
    throw coded('ANNOTATION_PROOF_MISMATCH', 'annotation field is invalid');
  }
  if (status !== 'ready' && status !== 'unavailable') {
    throw coded('ANNOTATION_PROOF_MISMATCH', 'annotation status is invalid');
  }
  let projectedValue = null;
  if (status === 'unavailable') {
    projectedValue = null;
  } else if (field === 'explanation') {
    if (typeof value !== 'string') {
      throw coded('ANNOTATION_PROOF_MISMATCH', 'explanation must be a string');
    }
    if (value.length > TRAINING_SUMMARY_LIMITS.explanation) {
      throw coded('ANNOTATION_PROOF_MISMATCH', 'explanation exceeds 600 characters');
    }
    projectedValue = value;
  } else {
    projectedValue = projectExploitValue(value);
  }
  return {
    evaluationId,
    payloadSha256,
    field,
    status,
    value: projectedValue,
    valueSha256: annotationValueSha256({ field, status, value: projectedValue }),
  };
}

export function trainingBodyByteLength({ publishId = MAX_PUBLISH_ID, training, trainingAuthority }) {
  return utf8ByteLength(JSON.stringify({ publishId, training, trainingAuthority }));
}

export function annotationBodyByteLength({
  publishId = MAX_PUBLISH_ID, trainingAnnotations, annotationAuthority,
}) {
  return utf8ByteLength(JSON.stringify({ publishId, trainingAnnotations, annotationAuthority }));
}
