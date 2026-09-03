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

// D9 결정 identity. `training/contracts.js`가 이것을 import해 생산자·서버가 같은
// 문법을 쓴다 — 서버는 training 모듈을 부를 수 없으므로 정본이 여기에 있어야 한다.
export const EVALUATION_ID_MAX = 256;
export const EVALUATION_ID_RE = /^([0-9a-f]{64}):(d-\d+-[a-z]+-\d+):([a-z0-9-]{1,64})@(\d+\.\d+\.\d+)$/;

const HEX64_RE = /^[0-9a-f]{64}$/;
const EXPLOIT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SUMMARY_CODE_RE = /^[A-Z_]{1,64}$/;

// exploit adjustment의 어휘는 닫힌 3×3이고 생산자는 우리 evaluator다. 미지 키·미지
// 값은 드롭이 아니라 오류로 다룬다(드롭하면 게시자가 선언한 digest와 어긋난다).
export const EXPLOIT_ADJUSTMENT_KEYS = Object.freeze(['bluff', 'thinValue', 'defense']);
export const EXPLOIT_ADJUSTMENT_LEVELS = Object.freeze(['increase', 'decrease', 'hold']);

// 코치·서버가 공유하는 비공개 필드 목록과 경로 계열. 한 규칙은 한 곳에 산다.
export const PRIVATE_PLAYER_FIELDS = Object.freeze([
  'archetype', 'personality', 'bluffFreq', 'threeBetFreq', 'tiltProne',
  'policyId', 'policyVersion', 'sampledProbability', 'reasonCode', 'policySeed', 'configDigest',
]);
export const FORBIDDEN_PATH_RE = /(?:\/(?:Users|home|tmp|var|private|etc|opt|root)\b|[A-Za-z]:\\)/;
export const FORBIDDEN_PATH_LITERALS = Object.freeze(['.session-store']);

const CARD_RE = /^[2-9TJQKA][cdhs]$/;

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function privateScalar(value, label) {
  if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length === 0) {
    throw coded('PRIVATE_LITERAL_INVALID', `${label} is not a non-empty scalar`);
  }
  return String(value);
}

function privateCards(value, label) {
  if (!Array.isArray(value)
    || value.length !== 2
    || !value.every((card) => typeof card === 'string' && CARD_RE.test(card))) {
    throw coded('PRIVATE_LITERAL_INVALID', `${label} is not a two-card array`);
  }
  return value;
}

function validatePrivateRecord(record, label) {
  if (!plainObject(record) || !Number.isInteger(record.handNo) || record.handNo < 1
    || !plainObject(record.holes) || Object.keys(record.holes).length === 0
    || !plainObject(record.startStacks)) {
    throw coded('PRIVATE_LITERAL_INVALID', `${label} is not a complete hand record`);
  }
  const holeIds = Object.keys(record.holes).sort();
  const stackIds = Object.keys(record.startStacks).sort();
  if (holeIds.length !== stackIds.length
    || holeIds.some((playerId, index) => playerId !== stackIds[index])) {
    throw coded('PRIVATE_LITERAL_INVALID', `${label} participants do not bind holes to startStacks`);
  }
  const physicalCards = new Set();
  for (const [playerId, cards] of Object.entries(record.holes)) {
    if (typeof playerId !== 'string' || playerId.length === 0) {
      throw coded('PRIVATE_LITERAL_INVALID', `${label}.holes has an invalid player id`);
    }
    privateCards(cards, `${label}.holes.${playerId}`);
    for (const card of cards) {
      if (physicalCards.has(card)) {
        throw coded('PRIVATE_LITERAL_INVALID', `${label} contains duplicate physical cards`);
      }
      physicalCards.add(card);
    }
    if (typeof record.startStacks[playerId] !== 'number'
      || !Number.isFinite(record.startStacks[playerId])) {
      throw coded('PRIVATE_LITERAL_INVALID', `${label}.startStacks.${playerId} is invalid`);
    }
  }
  const reveals = record.showdown == null
    ? []
    : record.showdown?.reveals;
  if (!Array.isArray(reveals)) {
    throw coded('PRIVATE_LITERAL_INVALID', `${label}.showdown.reveals is not an array`);
  }
  const revealedPlayers = new Set();
  for (const [index, reveal] of reveals.entries()) {
    if (!plainObject(reveal) || typeof reveal.playerId !== 'string' || reveal.playerId.length === 0) {
      throw coded('PRIVATE_LITERAL_INVALID', `${label}.showdown.reveals.${index} is invalid`);
    }
    privateCards(reveal.cards, `${label}.showdown.reveals.${index}.cards`);
    if (revealedPlayers.has(reveal.playerId)
      || !Object.hasOwn(record.holes, reveal.playerId)
      || reveal.cards.some((card, cardIndex) => card !== record.holes[reveal.playerId][cardIndex])) {
      throw coded('PRIVATE_LITERAL_INVALID', `${label} reveal is not bound to the player's holes`);
    }
    revealedPlayers.add(reveal.playerId);
  }
  return record;
}

export function validatePrivateEngineState(engineState) {
  if (!plainObject(engineState)
    || engineState.schemaVersion !== 1
    || !Number.isInteger(engineState.stateVersion) || engineState.stateVersion < 0
    || !plainObject(engineState.config)
    || typeof engineState.sessionToken !== 'string' || engineState.sessionToken.length === 0
    || !Number.isInteger(engineState.handNo) || engineState.handNo < 0
    || !['idle', 'in_hand'].includes(engineState.phase)
    || !Array.isArray(engineState.seats) || engineState.seats.length < 2
    || typeof engineState.gameOver !== 'boolean'
    || !Object.hasOwn(engineState, 'hand')
    || !Object.hasOwn(engineState, 'lastHand')) {
    throw coded('PRIVATE_LITERAL_INVALID', 'engine state security schema is incomplete');
  }
  const seatIds = new Set();
  for (const seat of engineState.seats) {
    if (!plainObject(seat) || typeof seat.playerId !== 'string' || seat.playerId.length === 0
      || seatIds.has(seat.playerId)) {
      throw coded('PRIVATE_LITERAL_INVALID', 'engine state contains an invalid seat');
    }
    seatIds.add(seat.playerId);
  }
  if (engineState.hand !== null) {
    validatePrivateRecord({ ...engineState.hand, handNo: engineState.handNo }, 'state.hand');
  }
  if (engineState.lastHand !== null) validatePrivateRecord(engineState.lastHand, 'state.lastHand');
  if (engineState.gameOver
    && (engineState.phase !== 'idle'
      || engineState.hand !== null
      || !['win', 'lose', 'completed', 'abort'].includes(engineState.result)
      || (engineState.result !== 'abort' && engineState.lastHand === null))) {
    throw coded('PRIVATE_LITERAL_INVALID', 'gameOver is not backed by terminal engine state');
  }
  return engineState;
}

/**
 * 파싱된 JSON만 받는 순수 수집기(fs 없음). 코치(`coachForbiddenLiterals`)와 서버
 * (`collectDenyLiterals`)가 같은 규칙을 쓰기 위한 정본이다.
 * `records`는 핸드 레코드의 배열이며, 각 레코드에서 showdown으로 공개된 카드는 뺀다.
 */
export function collectPrivateLiterals({ players, engineState, records } = {}) {
  const values = [];
  const list = Array.isArray(players) ? players : players?.players;
  if (!Array.isArray(list) || !Array.isArray(records)) {
    throw coded('PRIVATE_LITERAL_INVALID', 'private literal inputs are incomplete');
  }
  validatePrivateEngineState(engineState);
  const playerIds = new Set();
  for (const player of list) {
    if (!plainObject(player) || typeof player.playerId !== 'string' || player.playerId.length === 0) {
      throw coded('PRIVATE_LITERAL_INVALID', 'players contains an invalid row');
    }
    if (playerIds.has(player.playerId)) {
      throw coded('PRIVATE_LITERAL_INVALID', 'players contains a duplicate player id');
    }
    playerIds.add(player.playerId);
    if (player.playerId === 'user') continue;
    for (const field of PRIVATE_PLAYER_FIELDS) {
      const value = player?.[field];
      if (value !== undefined && value !== null) values.push(privateScalar(value, `player.${field}`));
    }
    if (player.policy !== undefined && player.policy !== null) {
      if (!plainObject(player.policy)) {
        throw coded('PRIVATE_LITERAL_INVALID', 'player.policy is not an object');
      }
      values.push(JSON.stringify(player.policy));
      for (const [field, value] of Object.entries(player.policy)) {
        values.push(privateScalar(value, `player.policy.${field}`));
      }
    }
  }
  const seatIds = engineState.seats.map((seat) => seat.playerId);
  if (playerIds.size !== seatIds.length || seatIds.some((playerId) => !playerIds.has(playerId))) {
    throw coded('PRIVATE_LITERAL_INVALID', 'players do not bind every engine seat');
  }
  if (engineState.policySeed !== undefined && engineState.policySeed !== null) {
    values.push(privateScalar(engineState.policySeed, 'state.policySeed'));
  }
  for (const [recordIndex, candidate] of records.entries()) {
    const record = validatePrivateRecord(candidate, `records.${recordIndex}`);
    const revealedPlayers = new Set((record.showdown?.reveals ?? []).map((reveal) => reveal.playerId));
    for (const [playerId, cards] of Object.entries(record.holes)) {
      if (playerId === 'user' || revealedPlayers.has(playerId)) continue;
      for (const card of cards) {
        values.push(String(card));
      }
    }
  }
  return [...new Set(values)];
}

/**
 * 수집된 literal 하나라도 들어 있거나 절대 경로·저장소 표지가 보이면 참.
 * `literals`가 비어 있어도 경로 계열은 검사한다 — 다만 호출자는 빈 목록 자체를
 * fail-closed 조건으로 다뤄야 한다(수집에 실패한 것과 구별되지 않기 때문).
 */
export function textLeaksPrivate(text, literals) {
  if (typeof text !== 'string' || !text) return false;
  if (FORBIDDEN_PATH_RE.test(text)) return true;
  if (FORBIDDEN_PATH_LITERALS.some((literal) => text.includes(literal))) return true;
  return (Array.isArray(literals) ? literals : []).some(
    (literal) => typeof literal === 'string' && literal.length > 0 && text.includes(literal),
  );
}

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
  // identity는 문법으로만 확인된다. 문자열이기만 하면 `__proto__` 같은 값이
  // 맵 키로 흘러들고, detail 증명을 다른 결정에 결박할 여지가 생긴다.
  if (typeof item.evaluationId !== 'string'
    || item.evaluationId.length > EVALUATION_ID_MAX
    || !EVALUATION_ID_RE.test(item.evaluationId)) {
    throw coded('TRAINING_PROOF_MISMATCH', 'evaluationId is not a contract identity');
  }
  if (item.handNo != null && !Number.isInteger(item.handNo)) {
    throw coded('TRAINING_PROOF_MISMATCH', 'handNo must be an integer');
  }
  if (item.decisionId != null && typeof item.decisionId !== 'string') {
    throw coded('TRAINING_PROOF_MISMATCH', 'decisionId must be a string');
  }
  if (item.status != null && typeof item.status !== 'string') {
    throw coded('TRAINING_PROOF_MISMATCH', 'status must be a string');
  }
  if (item.street != null && typeof item.street !== 'string') {
    throw coded('TRAINING_PROOF_MISMATCH', 'street must be a string');
  }
  if (item.evLossBb != null && !Number.isFinite(item.evLossBb)) {
    throw coded('TRAINING_PROOF_MISMATCH', 'evLossBb must be a finite number');
  }
  if (item.grade != null && typeof item.grade !== 'string') {
    throw coded('TRAINING_PROOF_MISMATCH', 'grade must be a string');
  }
  if (item.forced != null && typeof item.forced !== 'boolean') {
    throw coded('TRAINING_PROOF_MISMATCH', 'forced must be a boolean');
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
    forced: item.forced === true,
    source: compactSource(item.source),
  };
  // D9 ③: detailRef는 이 evaluation에서 파생된 값이어야 한다. 문법만 보면 유효한
  // 토큰 보유자가 A의 summary에 B의 detail 증명을 실을 수 있다.
  if (item.detailRef !== undefined) {
    if (typeof item.detailRef !== 'string'
      || !HEX64_RE.test(item.detailRef)
      || item.detailRef !== detailRefOf(item.evaluationId)) {
      throw coded('TRAINING_PROOF_MISMATCH', 'detailRef is not derived from this evaluationId');
    }
    out.detailRef = item.detailRef;
  }
  if (Object.hasOwn(item, 'detailSha256')) {
    if (typeof item.detailSha256 !== 'string' || !HEX64_RE.test(item.detailSha256)) {
      throw coded('TRAINING_PROOF_MISMATCH', 'detailSha256 must be a sha256 digest');
    }
    out.detailSha256 = item.detailSha256;
  }
  if (item.code) out.code = item.code;
  if (item.reason) out.reason = item.reason;
  out.recommendedTruncated = item.recommendedTruncated === true;
  out.payloadSha256 = trainingPayloadSha256(out);
  return out;
}

function projectExploitAdjustment(adjustment) {
  if (typeof adjustment !== 'object' || adjustment === null || Array.isArray(adjustment)) {
    throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit adjustment must be an object');
  }
  // 삽입 순서를 그대로 보존한다 — canonical 바이트가 그 순서를 따른다.
  const next = Object.create(null);
  for (const [key, level] of Object.entries(adjustment)) {
    if (!EXPLOIT_ADJUSTMENT_KEYS.includes(key)) {
      throw coded('ANNOTATION_PROOF_MISMATCH', `exploit adjustment key is not in the vocabulary: ${key}`);
    }
    if (typeof level !== 'string' || !EXPLOIT_ADJUSTMENT_LEVELS.includes(level)) {
      throw coded('ANNOTATION_PROOF_MISMATCH', `exploit adjustment level is not in the vocabulary: ${key}`);
    }
    next[key] = level;
  }
  if (Object.keys(next).length === 0) {
    throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit adjustment must not be empty');
  }
  return next;
}

function projectExploitValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit value must be an object');
  }
  if (!Array.isArray(value.opponents) || value.opponents.length === 0) {
    throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit opponents must be a non-empty array');
  }
  const opponents = value.opponents.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit opponent must be an object');
      }
      if (typeof row.opponentId !== 'string' || !EXPLOIT_ID_RE.test(row.opponentId)) {
        throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit opponentId is not an identifier');
      }
      if (typeof row.policyId !== 'string' || !EXPLOIT_ID_RE.test(row.policyId)) {
        throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit policyId is not an identifier');
      }
      if (!plainObject(row.comparison)
        || typeof row.comparison.summaryCode !== 'string'
        || !SUMMARY_CODE_RE.test(row.comparison.summaryCode)) {
        throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit comparison.summaryCode is not a code');
      }
      const out = {
        opponentId: row.opponentId,
        policyId: row.policyId,
        adjustment: projectExploitAdjustment(row.adjustment),
        comparison: { summaryCode: row.comparison.summaryCode },
      };
      return out;
    });
  const named = opponents.some((row) => row.opponentId === value.primary);
  if (typeof value.primary !== 'string' || !named) {
    throw coded('ANNOTATION_PROOF_MISMATCH', 'exploit primary must name one of the opponents');
  }
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
