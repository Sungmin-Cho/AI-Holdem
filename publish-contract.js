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
