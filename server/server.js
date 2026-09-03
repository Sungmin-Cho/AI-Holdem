#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectPrivateLiterals,
  MAX_PUBLISH_BODY_BYTES,
  MAX_PUBLISH_ID,
  payloadSha256,
  publicProofId,
  projectTrainingAnnotation,
  projectTrainingSummary,
  sha256Hex,
  textLeaksPrivate,
  validatePrivateEngineState,
} from '../publish-contract.js';
import { openContained } from '../tools/training-store.js';

const MAX_BODY = MAX_PUBLISH_BODY_BYTES;
// 서버가 읽기 전용 보안 술어로만 여는 세션 파일들. 엔진은 원자적 rename으로 쓰므로
// 부분 읽기는 없고, 이 상한을 넘는 파일은 읽기 실패(=fail-closed)로 다룬다.
const SECURITY_READ_MAX_BYTES = 4 * 1024 * 1024;
const HAND_FILE_RE = /^hand-(\d{4,})\.json$/;
const LEGACY_TRAINING_KEYS = Object.freeze([
  'evaluationId', 'handNo', 'decisionId', 'status', 'street', 'spotKey', 'handClass',
  'chosen', 'recommended', 'evLossBb', 'grade', 'forced', 'source', 'explanation',
  'detailRef', 'detailSha256', 'code', 'reason',
]);
const HEARTBEAT_MS = 15_000;
const KEEP_ALIVE_MS = 120_000;
const HEADERS_MS = 125_000;
const DEFAULT_WAIT_MS = 25_000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* leftover tmp is harmless */ }
    throw error;
  }
}

function sendJson(res, status, obj) {
  if (res.writableEnded || res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function tokensEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function emptyState() {
  return {
    revision: 0,
    view: null,
    log: [],
    coach: [],
    training: [],
    trainingAnnotations: Object.create(null),
    review: undefined,
    publishId: undefined,
    history: [],
  };
}

function annotationsToArray(map) {
  const out = [];
  for (const fields of Object.values(map ?? {})) {
    for (const row of Object.values(fields ?? {})) {
      out.push({
        evaluationId: row.evaluationId,
        payloadSha256: row.payloadSha256,
        field: row.field,
        status: row.status,
        value: row.value,
        valueSha256: row.valueSha256,
      });
    }
  }
  out.sort((a, b) => String(a.evaluationId).localeCompare(String(b.evaluationId))
    || String(a.field).localeCompare(String(b.field)));
  return out;
}

function persistedAnnotationCandidates(raw, split) {
  const candidates = [];
  if (Array.isArray(raw)) {
    for (const row of raw) candidates.push({ row, outerId: null, outerField: null });
  } else if (raw && typeof raw === 'object') {
    for (const [outerId, fields] of Object.entries(raw)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        candidates.push({ row: null, outerId, outerField: null });
        continue;
      }
      for (const [outerField, row] of Object.entries(fields)) {
        candidates.push({ row, outerId, outerField });
      }
    }
  }
  for (const [outerId, fields] of Object.entries(split ?? {})) {
    for (const [outerField, row] of Object.entries(fields ?? {})) {
      candidates.push({ row, outerId, outerField });
    }
  }
  return candidates;
}

function annotationCandidateKeys({ row, outerId, outerField }) {
  const keys = new Set();
  if (typeof outerId === 'string' && typeof outerField === 'string') {
    keys.add(`${outerId}:${outerField}`);
  }
  if (typeof row?.evaluationId === 'string' && typeof row?.field === 'string') {
    keys.add(`${row.evaluationId}:${row.field}`);
  }
  return [...keys];
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readSecurityJson(root, segments) {
  return JSON.parse(
    openContained(root, segments, { maxBytes: SECURITY_READ_MAX_BYTES }).toString('utf8'),
  );
}

// 위조된 POST로는 바꿀 수 없는 유일한 진실. 부재·symlink·파싱 실패·타입 불일치는
// 전부 "아직 끝나지 않았다"로 읽는다(fail-closed).
function engineGameOver(root, expectedSessionToken) {
  try {
    return validatePrivateEngineState(
      readSecurityJson(root, ['state.json']),
      { expectedSessionToken },
    ).gameOver === true;
  } catch {
    return false;
  }
}

/**
 * 세션 전 핸드의 미공개 상대 카드 **합집합**과 비공개 정책 값을 매 호출마다 다시 읽는다.
 * 게시자가 주장하는 handNo·machine item으로 핸드를 고르지 않으며(같은 POST에서 위조
 * 가능하다) 캐시하지도 않는다 — `hands/`는 그대로인 채 `state.json`의 진행 중 핸드나
 * `players.json`만 바뀌는 갱신을 놓치기 때문이다. 자료를 하나라도 읽지 못하거나 수집
 * 결과가 0건이면 throw한다(호출자가 fail-closed로 거부한다).
 */
function collectDenyLiterals(root, expectedSessionToken) {
  const players = readSecurityJson(root, ['players.json']);
  const engineState = readSecurityJson(root, ['state.json']);
  validatePrivateEngineState(engineState, { expectedSessionToken });
  const records = [];
  if (engineState?.hand) records.push({ ...engineState.hand, handNo: engineState.handNo });
  if (engineState?.lastHand) records.push(engineState.lastHand);

  const names = fs.readdirSync(path.join(root, 'hands'));
  if (!names.some((entry) => HAND_FILE_RE.test(entry))) {
    throw coded('HAND_ARCHIVE_MISSING', '보안 술어에 필요한 hand archive가 없습니다.');
  }
  const archives = names.flatMap((name) => {
    const match = HAND_FILE_RE.exec(name);
    if (!match) return [];
    const handNo = Number(match[1]);
    if (!Number.isSafeInteger(handNo) || handNo < 1
      || `hand-${String(handNo).padStart(4, '0')}.json` !== name) {
      throw coded('HAND_ARCHIVE_INVALID', `${name}은 canonical hand archive 이름이 아닙니다.`);
    }
    return [{ name, handNo }];
  }).sort((left, right) => left.handNo - right.handNo);
  const archived = new Set();
  for (const { name, handNo } of archives) {
    if (archived.has(handNo)) throw coded('HAND_ARCHIVE_INVALID', `${name}의 handNo가 중복됩니다.`);
    const record = readSecurityJson(root, ['hands', name]);
    if (record?.handNo !== handNo) {
      throw coded('HAND_ARCHIVE_INVALID', `${name}의 handNo가 파일명과 다릅니다.`);
    }
    records.push(record);
    archived.add(handNo);
  }
  // lastHandNo 자체가 비정상적으로 커도 그 수만큼 루프하지 않는다. 실제 파일 수와
  // 정렬된 번호를 한 번 대조해 빠진 archive를 fail-closed로 찾는다.
  const lastHandNo = engineState?.lastHand?.handNo;
  if (Number.isInteger(lastHandNo)) {
    if (archives.length !== lastHandNo
      || archives.some(({ handNo }, index) => handNo !== index + 1)) {
      throw coded('HAND_ARCHIVE_MISSING', '완료된 hand archive 연속성이 깨졌습니다.');
    }
  }

  const literals = collectPrivateLiterals({ players, engineState, records });
  if (literals.length === 0) {
    throw coded('DENY_LITERALS_EMPTY', 'deny literal 목록이 비어 있습니다.');
  }
  return literals;
}

function legacyTrainingPayloadSha256(item) {
  const canonical = {};
  for (const key of LEGACY_TRAINING_KEYS) {
    if (item?.[key] !== undefined) canonical[key] = item[key];
  }
  return sha256Hex(JSON.stringify(canonical));
}

function storedTrainingDigestMatches(item, projected, { allowLegacyExplanation = false } = {}) {
  if (typeof item?.payloadSha256 !== 'string') return false;
  if (Object.hasOwn(item, 'explanation')) {
    return allowLegacyExplanation
      ? item.payloadSha256 === legacyTrainingPayloadSha256(item)
      : item.payloadSha256 === projected.payloadSha256;
  }
  return item.payloadSha256 === projected.payloadSha256;
}

function migrateLoadedTraining(rawTraining, { allowLegacyExplanation = false } = {}) {
  const byId = new Map();
  const split = Object.create(null);
  let dropped = 0;
  const rows = Array.isArray(rawTraining) ? rawTraining : [];
  const idCounts = new Map();
  for (const item of rows) {
    if (typeof item?.evaluationId !== 'string') continue;
    idCounts.set(item.evaluationId, (idCounts.get(item.evaluationId) ?? 0) + 1);
  }
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      dropped += 1;
      continue;
    }
    if (typeof item.evaluationId === 'string' && idCounts.get(item.evaluationId) > 1) {
      dropped += 1;
      continue;
    }
    const explanation = item.explanation;
    const rest = { ...item };
    delete rest.explanation;
    let projected;
    try {
      projected = projectTrainingSummary(rest);
    } catch {
      dropped += 1;
      continue;
    }
    if (!storedTrainingDigestMatches(item, projected, { allowLegacyExplanation })) {
      dropped += 1;
      continue;
    }
    byId.set(projected.evaluationId, projected);
    if (allowLegacyExplanation && typeof explanation === 'string' && explanation.length) {
      try {
        const ann = projectTrainingAnnotation({
          evaluationId: projected.evaluationId,
          payloadSha256: projected.payloadSha256,
          field: 'explanation',
          status: 'ready',
          value: explanation,
        });
        split[ann.evaluationId] = split[ann.evaluationId] ?? Object.create(null);
        split[ann.evaluationId].explanation = ann;
      } catch { dropped += 1; }
    }
  }
  return { training: [...byId.values()], split, dropped };
}

// 복원은 live merge와 같은 다섯 술어를 통과한 항목만 남긴다: ① 투영 성공 + 저장된
// `valueSha256`이 재계산값과 일치 ② `payloadSha256`이 존재하고 복원된 machine item과
// 일치 ③ 최종 상태에 같은 digest로 존재(set-once) ④ explanation은 deny-literal
// ⑤ exploit은 엔진 `gameOver`. 하나라도 어긋나면 드롭한다.
function restoreAnnotationRow(row, { machine, literals, gate }) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (!machine) return null;
  let projected;
  try {
    projected = projectTrainingAnnotation(row);
  } catch {
    return null;
  }
  if (typeof row.valueSha256 !== 'string' || row.valueSha256 !== projected.valueSha256) return null;
  if (typeof projected.payloadSha256 !== 'string'
    || projected.payloadSha256 !== machine.payloadSha256) {
    return null;
  }
  if (projected.field === 'explanation') {
    if (!literals || textLeaksPrivate(projected.value, literals)) return null;
  }
  if (projected.field === 'exploit' && !gate.gameOver) return null;
  return projected;
}

function restoreHistory(rawHistory, context) {
  const restored = [];
  let dropped = 0;
  for (const entry of Array.isArray(rawHistory) ? rawHistory : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }
    const source = entry.payload;
    const payload = source && typeof source === 'object' && !Array.isArray(source)
      ? { ...source }
      : {};
    if ('training' in payload) {
      const itemsById = new Map();
      const historyTraining = Array.isArray(payload.training) ? payload.training : [];
      const historyIdCounts = new Map();
      for (const item of historyTraining) {
        if (typeof item?.evaluationId !== 'string') continue;
        historyIdCounts.set(item.evaluationId, (historyIdCounts.get(item.evaluationId) ?? 0) + 1);
      }
      for (const item of historyTraining) {
        if (typeof item?.evaluationId === 'string' && historyIdCounts.get(item.evaluationId) > 1) {
          dropped += 1;
          continue;
        }
        let projected;
        try {
          projected = projectTrainingSummary(item);
        } catch {
          dropped += 1;
          continue;
        }
        const machine = context.machineById.get(projected.evaluationId);
        if (!storedTrainingDigestMatches(item, projected, {
          allowLegacyExplanation: context.allowLegacyExplanation,
        })
          || !machine
          || machine.payloadSha256 !== projected.payloadSha256) {
          dropped += 1;
          continue;
        }
        itemsById.set(projected.evaluationId, projected);
      }
      const items = [...itemsById.values()];
      if (items.length) payload.training = items;
      else delete payload.training;
    }
    if ('trainingAnnotations' in payload) {
      const rowsByKey = new Map();
      const historyAnnotations = Array.isArray(payload.trainingAnnotations)
        ? payload.trainingAnnotations
        : [];
      const historyAnnotationCounts = new Map();
      for (const row of historyAnnotations) {
        if (typeof row?.evaluationId !== 'string' || typeof row?.field !== 'string') continue;
        const key = `${row.evaluationId}:${row.field}`;
        historyAnnotationCounts.set(key, (historyAnnotationCounts.get(key) ?? 0) + 1);
      }
      for (const row of historyAnnotations) {
        const rawKey = typeof row?.evaluationId === 'string' && typeof row?.field === 'string'
          ? `${row.evaluationId}:${row.field}`
          : null;
        if (rawKey && historyAnnotationCounts.get(rawKey) > 1) {
          dropped += 1;
          continue;
        }
        const machine = context.machineById.get(row?.evaluationId);
        const projected = restoreAnnotationRow(row, { ...context, machine });
        const settled = projected
          ? context.annotations[projected.evaluationId]?.[projected.field]
          : null;
        if (!projected || !settled || settled.valueSha256 !== projected.valueSha256) {
          dropped += 1;
          continue;
        }
        const key = `${projected.evaluationId}:${projected.field}`;
        rowsByKey.set(key, projected);
      }
      const rows = [...rowsByKey.values()];
      if (rows.length) payload.trainingAnnotations = rows;
      else delete payload.trainingAnnotations;
    }
    restored.push({ revision: Number(entry.revision) || 0, at: entry.at, payload });
  }
  return { history: restored, dropped };
}

function legacyTrainingSnapshot(gameDir) {
  try {
    const authority = readSecurityJson(gameDir, ['training', '.training-authority.json']);
    return authority?.schemaVersion === 1;
  } catch {
    return false;
  }
}

function loadUiState(gameDir, expectedSessionToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(gameDir, 'ui-snapshot.json'), 'utf8'));
    const allowLegacyExplanation = legacyTrainingSnapshot(gameDir);
    const migrated = migrateLoadedTraining(raw.training, { allowLegacyExplanation });
    const machineById = new Map(migrated.training.map((row) => [row.evaluationId, row]));

    // 보안 자료는 이 로드에서 한 번 읽는다. 읽지 못하면 explanation은 전부 드롭한다.
    let literals = null;
    try {
      literals = collectDenyLiterals(gameDir, expectedSessionToken);
    } catch {
      literals = null;
    }
    const gate = { gameOver: engineGameOver(gameDir, expectedSessionToken) };

    const restoredAnnotations = Object.create(null);
    let droppedAnnotations = migrated.dropped;
    const annotationCandidates = persistedAnnotationCandidates(
      raw.trainingAnnotations,
      migrated.split,
    );
    const annotationCounts = new Map();
    const keysByCandidate = annotationCandidates.map(annotationCandidateKeys);
    for (const keys of keysByCandidate) {
      for (const key of keys) {
        annotationCounts.set(key, (annotationCounts.get(key) ?? 0) + 1);
      }
    }
    for (const [index, { row, outerId, outerField }] of annotationCandidates.entries()) {
      if (keysByCandidate[index].some((key) => annotationCounts.get(key) > 1)) {
        droppedAnnotations += 1;
        continue;
      }
      const machine = machineById.get(row?.evaluationId);
      const projected = restoreAnnotationRow(row, { machine, literals, gate });
      if (!projected
        || (outerId !== null && outerId !== projected.evaluationId)
        || (outerField !== null && outerField !== projected.field)) {
        droppedAnnotations += 1;
        continue;
      }
      const previous = restoredAnnotations[projected.evaluationId]?.[projected.field];
      if (previous) {
        droppedAnnotations += 1;
        continue;
      }
      restoredAnnotations[projected.evaluationId] = restoredAnnotations[projected.evaluationId]
        ?? Object.create(null);
      restoredAnnotations[projected.evaluationId][projected.field] = projected;
    }
    const replay = restoreHistory(raw.history, {
      machineById, literals, gate, annotations: restoredAnnotations, allowLegacyExplanation,
    });
    if (droppedAnnotations || replay.dropped) {
      process.stderr.write(`ui-snapshot restore dropped ${droppedAnnotations} annotation(s) and ${replay.dropped} history row(s)\n`);
    }
    return {
      revision: Number(raw.revision) || 0,
      view: raw.view ?? null,
      log: Array.isArray(raw.log) ? raw.log : [],
      coach: Array.isArray(raw.coach) ? mergeCoach([], raw.coach) : [],
      training: migrated.training,
      trainingAnnotations: restoredAnnotations,
      review: raw.review,
      publishId: raw.publishId,
      history: replay.history,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

function v2ProofRequired(gameDir) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(gameDir, '.coach-authority.json'), 'utf8'));
    return auth.schemaVersion === 2;
  } catch {
    return false;
  }
}

function hasCoachProof(note) {
  const proof = note?.coachProof;
  return Boolean(
    proof
    && typeof proof.id === 'string'
    && typeof proof.payloadSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(proof.id)
    && /^[0-9a-f]{64}$/.test(proof.payloadSha256),
  );
}

function validateIncomingCoach(existing, incoming, gameDir) {
  const required = v2ProofRequired(gameDir);
  for (const note of incoming) {
    if (required && !hasCoachProof(note)) return 'COACH_PROOF_REQUIRED';
    if (!hasCoachProof(note)) continue;
    if (!Number.isInteger(note.handNo) || typeof note.text !== 'string' || !note.text.trim()) {
      return 'COACH_PROOF_MISMATCH';
    }
    if (note.overfold !== undefined && note.overfold !== true) return 'COACH_PROOF_MISMATCH';
    if (note.unavailable !== undefined && note.unavailable !== true) return 'COACH_PROOF_MISMATCH';
    const digest = payloadSha256({
      handNo: note.handNo,
      text: note.text,
      overfold: note.overfold === true,
      unavailable: note.unavailable === true,
    });
    if (digest !== note.coachProof.payloadSha256) return 'COACH_PROOF_MISMATCH';
    const prev = existing.find((entry) => entry.handNo === note.handNo);
    if (prev) {
      const incomingOverfold = note.overfold === true;
      const sticky = Boolean(prev.overfold) || incomingOverfold;
      if (sticky !== incomingOverfold) return 'COACH_SEMANTIC_CONFLICT';
    }
  }
  return null;
}

// Coaching runs in the background, so notes arrive out of order and sometimes twice.
// Keyed by handNo and sorted, the array reads the same however they arrive — including
// when an older snapshot written before this rule is loaded back.
function mergeTraining(existing, incoming) {
  const merged = [...existing];
  const projectedIncoming = [];
  for (const item of incoming) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.evaluationId !== 'string'
      || typeof item.payloadSha256 !== 'string') {
      return { error: 'TRAINING_PROOF_REQUIRED' };
    }
    let projected;
    try {
      projected = projectTrainingSummary(item);
    } catch (error) {
      return { error: error.code === 'SUMMARY_FIELD_TOO_LONG' ? 'TRAINING_PROOF_MISMATCH' : (error.code ?? 'TRAINING_PROOF_MISMATCH') };
    }
    if (item.payloadSha256 !== projected.payloadSha256) {
      return { error: 'TRAINING_PROOF_MISMATCH' };
    }
    projectedIncoming.push(projected);
    const at = merged.findIndex((row) => row.evaluationId === projected.evaluationId);
    if (at === -1) {
      merged.push(projected);
      continue;
    }
    if (merged[at].payloadSha256 !== projected.payloadSha256) {
      return { error: 'TRAINING_PROOF_MISMATCH' };
    }
  }
  merged.sort((a, b) => (a.handNo ?? 0) - (b.handNo ?? 0)
    || String(a.evaluationId).localeCompare(String(b.evaluationId)));
  return { merged, projectedIncoming };
}

function mergeTrainingAnnotations(existing, incoming, trainingItems, gameDir, expectedSessionToken) {
  const next = Object.create(null);
  for (const [key, fields] of Object.entries(existing ?? {})) {
    next[key] = Object.assign(Object.create(null), fields);
  }
  // deny 목록은 요청마다 한 번 읽는다(요청 간 캐시 없음).
  let literals;
  const projectedIncoming = [];
  for (const raw of incoming) {
    const proof = raw?.annotationProof;
    if (!proof
      || typeof proof.id !== 'string'
      || typeof proof.valueSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(proof.id)
      || !/^[0-9a-f]{64}$/.test(proof.valueSha256)) {
      return { error: 'ANNOTATION_PROOF_MISMATCH', status: 400 };
    }
    let projected;
    try {
      projected = projectTrainingAnnotation(raw);
    } catch (error) {
      return { error: error.code ?? 'ANNOTATION_PROOF_MISMATCH', status: 400 };
    }
    if (projected.valueSha256 !== proof.valueSha256
      || (typeof raw.valueSha256 === 'string' && raw.valueSha256 !== projected.valueSha256)
      || proof.id !== publicProofId(`${projected.evaluationId}:${projected.field}`)) {
      return { error: 'ANNOTATION_PROOF_MISMATCH', status: 400 };
    }
    const machine = trainingItems.find((row) => row.evaluationId === projected.evaluationId);
    if (!machine) return { error: 'ANNOTATION_ORPHAN', status: 409 };
    if (machine.payloadSha256 !== projected.payloadSha256) {
      return { error: 'ANNOTATION_PROOF_MISMATCH', status: 400 };
    }
    if (projected.field === 'explanation') {
      if (literals === undefined) {
        try {
          literals = collectDenyLiterals(gameDir, expectedSessionToken);
        } catch {
          literals = null;
        }
      }
      if (literals === null) {
        return { error: 'FORBIDDEN_LITERAL_UNAVAILABLE', status: 500 };
      }
      if (textLeaksPrivate(projected.value, literals)) {
        return { error: 'FORBIDDEN_LITERAL', status: 400 };
      }
    }
    // 게시자의 view(요청 본문이든 저장된 것이든)는 이 게이트의 입력이 아니다.
    if (projected.field === 'exploit' && !engineGameOver(gameDir, expectedSessionToken)) {
      return { error: 'EXPLOIT_BEFORE_GAMEOVER', status: 409 };
    }
    const prev = next[projected.evaluationId]?.[projected.field];
    if (prev) {
      if (prev.valueSha256 === projected.valueSha256) {
        projectedIncoming.push(projected);
        continue;
      }
      return { error: 'ANNOTATION_CONFLICT', status: 409 };
    }
    next[projected.evaluationId] = next[projected.evaluationId] ?? Object.create(null);
    next[projected.evaluationId][projected.field] = projected;
    projectedIncoming.push(projected);
  }
  return { merged: next, projectedIncoming };
}

function mergeCoach(existing, incoming) {
  const merged = [...existing];
  for (const note of incoming) {
    const at = merged.findIndex((entry) => entry.handNo === note.handNo);
    if (hasCoachProof(note)) {
      if (at === -1) merged.push(note);
      else merged[at] = note;
      continue;
    }
    if (at === -1) { merged.push(note); continue; }
    // The once-per-game overfold comment is recorded here; a later edit of the same
    // note must not erase the fact that it was spent.
    const overfold = merged[at].overfold || note.overfold;
    merged[at] = overfold ? { ...note, overfold: true } : note;
  }
  return merged.sort((a, b) => (a.handNo ?? 0) - (b.handNo ?? 0));
}

function publicSnapshot(state) {
  const snap = {
    revision: state.revision,
    view: state.view,
    log: state.log,
    coach: state.coach,
    training: state.training ?? [],
    trainingAnnotations: annotationsToArray(state.trainingAnnotations),
  };
  if (state.review !== undefined) snap.review = state.review;
  return snap;
}

function persistUiState(gameDir, state) {
  const file = {
    revision: state.revision,
    view: state.view,
    log: state.log,
    coach: state.coach,
    training: state.training ?? [],
    trainingAnnotations: state.trainingAnnotations ?? {},
    publishId: state.publishId,
    history: state.history,
  };
  if (state.review !== undefined) file.review = state.review;
  writeJsonAtomic(path.join(gameDir, 'ui-snapshot.json'), file);
}

function writeSse(res, revision, payload) {
  res.write(`id: ${revision}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function parseArgs(argv) {
  const out = { gameDir: 'game', port: 8877, token: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--game-dir' && next != null) { out.gameDir = next; i += 1; }
    else if (arg === '--port' && next != null) { out.port = Number(next); i += 1; }
    else if (arg === '--token' && next != null) { out.token = next; i += 1; }
  }
  return out;
}

function readRawBody(req, res) {
  return new Promise((resolve) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_BODY) {
      sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
      req.resume();
      req.destroy();
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => finish(null));
  });
}

async function readJsonBody(req, res) {
  const raw = await readRawBody(req, res);
  if (raw == null) return null;
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, code: 'BAD_JSON' });
      return null;
    }
    return parsed;
  } catch {
    sendJson(res, 400, { ok: false, code: 'BAD_JSON' });
    return null;
  }
}

function readTrainingDetail(root, ref, expectedSha) {
  const buf = openContained(root, ['training', 'details', `${ref}.json`], { maxBytes: 1_000_000 });
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== expectedSha) throw new Error('digest');
  return JSON.parse(buf.toString('utf8'));
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  const root = path.normalize(`${PUBLIC_DIR}${path.sep}`);
  if (abs !== path.normalize(PUBLIC_DIR) && !abs.startsWith(root)) {
    sendJson(res, 403, { ok: false, code: 'FORBIDDEN' });
    return;
  }
  fs.stat(abs, (statErr, st) => {
    if (statErr || !st.isFile()) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      return;
    }
    fs.readFile(abs, (readErr, data) => {
      if (readErr) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

export function startServer({ gameDir, port = 8877, token }) {
  if (!gameDir) throw new Error('gameDir required');
  if (typeof token !== 'string' || token.length === 0) throw new Error('token required');
  const root = path.resolve(gameDir);
  fs.mkdirSync(root, { recursive: true });

  const state = loadUiState(root, token);
  const sseClients = new Set();
  const waiters = new Set();
  let slot = null;
  let delivered = null;

  const checkToken = (provided, res) => {
    if (tokensEqual(provided, token)) return true;
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' });
    return false;
  };

  const currentDecisionId = () => state.view?.legal?.decisionId ?? null;

  const deliverSlot = () => {
    if (!slot) return;
    for (const waiter of waiters) {
      if (waiter.expectDecisionId && waiter.expectDecisionId !== slot.decisionId) continue;
      const taken = slot;
      slot = null;
      // Delivery is not proof of receipt: an HTTP response can be lost, and the user's
      // action bar is already disabled, so a consumed-and-forgotten action stalls the
      // hand with nobody able to resend it. Kept until the next decision is published.
      delivered = taken;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.finish(taken);
      return;
    }
  };

  const handlePublish = (body, res) => {
    if (!Number.isInteger(body.publishId) || body.publishId < 1 || body.publishId > MAX_PUBLISH_ID) {
      sendJson(res, 400, { ok: false, code: 'BAD_PUBLISH_ID' });
      return;
    }
    // publishIds only ever move forward, so anything at or below the last one is a
    // resend of something already applied — not just the immediately previous id.
    // Answering it as already-done is what makes a publisher's retry safe.
    const alreadyApplied = Number.isInteger(state.publishId)
      ? body.publishId <= state.publishId
      : false;
    if (alreadyApplied) {
      sendJson(res, 200, { ok: true, revision: state.revision });
      return;
    }

    // Build the whole next state to the side, persist it, and only then commit.
    // Mutating first would leave memory ahead of disk after a write failure, and the
    // publisher's same-id retry would then hit the duplicate fast-path above — reported
    // as published, present nowhere.
    const next = {
      revision: state.revision + 1,
      publishId: body.publishId,
      view: state.view,
      log: state.log,
      coach: state.coach,
      training: state.training ?? [],
      trainingAnnotations: state.trainingAnnotations ?? {},
      review: state.review,
      history: state.history,
    };

    const payload = {};
    if (body.view !== undefined) {
      next.view = body.view;
      payload.view = body.view;
    }
    if (Array.isArray(body.events) && body.events.length) {
      next.log = [...next.log, ...body.events];
      payload.events = body.events;
    }
    if (Array.isArray(body.messages) && body.messages.length) {
      next.log = [...next.log, ...body.messages];
      payload.messages = body.messages;
    }
    if (Array.isArray(body.coach) && body.coach.length) {
      const coachError = validateIncomingCoach(next.coach, body.coach, root);
      if (coachError) {
        sendJson(res, 400, { ok: false, code: coachError });
        return;
      }
      next.coach = mergeCoach(next.coach, body.coach);
      payload.coach = body.coach;
    }
    if (body.review !== undefined) {
      next.review = body.review;
      payload.review = body.review;
    }
    if (Array.isArray(body.training) && body.training.length) {
      const merged = mergeTraining(next.training, body.training);
      if (merged.error) {
        sendJson(res, 400, { ok: false, code: merged.error });
        return;
      }
      next.training = merged.merged;
      payload.training = merged.projectedIncoming;
    }
    if (Array.isArray(body.trainingAnnotations) && body.trainingAnnotations.length) {
      const merged = mergeTrainingAnnotations(
        next.trainingAnnotations,
        body.trainingAnnotations,
        next.training,
        root,
        token,
      );
      if (merged.error) {
        sendJson(res, merged.status ?? 400, { ok: false, code: merged.error });
        return;
      }
      next.trainingAnnotations = merged.merged;
      payload.trainingAnnotations = merged.projectedIncoming;
    }

    // Stamped for turn-latency measurement; kept off the payload so clients see no change.
    next.history = [...next.history, { revision: next.revision, at: new Date().toISOString(), payload }];

    try {
      persistUiState(root, next);
    } catch {
      sendJson(res, 500, { ok: false, code: 'PERSIST_FAILED' });
      return;
    }

    Object.assign(state, next);
    // Any published view means the dealer got the action and moved on — either it was
    // applied, or it was refused and re-asked. Re-delivering past this point would feed
    // a refused action straight back into the wait it just re-entered, forever.
    // A view-only republish is the exception: it re-shows a state rather than
    // acknowledging anything, so a resuming dealer must still be able to collect an
    // action whose response was lost.
    if (body.view !== undefined && body.viewOnly !== true) delivered = null;
    for (const client of sseClients) {
      try { writeSse(client.res, state.revision, payload); } catch { /* disconnected */ }
    }
    sendJson(res, 200, { ok: true, revision: state.revision });
  };

  const handleAction = (body, res) => {
    const current = currentDecisionId();
    if (current == null || body.decisionId !== current) {
      sendJson(res, 409, { ok: false, code: 'STALE_DECISION' });
      return;
    }
    const next = { decisionId: body.decisionId, action: body.action };
    if (body.amount !== undefined) next.amount = body.amount;
    slot = next;
    deliverSlot();
    sendJson(res, 200, { ok: true });
  };

  const attachSse = (req, res, url) => {
    const afterRaw = Number(url.searchParams.get('after'));
    const after = Number.isFinite(afterRaw) ? afterRaw : 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.socket?.setNoDelay(true);

    const client = {
      res,
      heartbeat: setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { /* gone */ }
      }, HEARTBEAT_MS),
    };
    sseClients.add(client);
    for (const entry of state.history) {
      if (entry.revision > after) writeSse(res, entry.revision, entry.payload);
    }

    const cleanup = () => {
      clearInterval(client.heartbeat);
      sseClients.delete(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  };

  const attachWait = (req, res, url) => {
    const expectDecisionId = url.searchParams.get('expectDecisionId') ?? '';
    let timeoutMs = Number(url.searchParams.get('timeoutMs'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = DEFAULT_WAIT_MS;

    const finish = (payload) => {
      sendJson(res, 200, payload);
    };

    if (slot && (!expectDecisionId || slot.decisionId === expectDecisionId)) {
      const taken = slot;
      slot = null;
      delivered = taken;
      finish(taken);
      return;
    }

    // The same decision asked twice means the first answer never arrived.
    if (delivered && expectDecisionId && delivered.decisionId === expectDecisionId) {
      finish(delivered);
      return;
    }

    const waiter = { expectDecisionId, finish, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      finish({ timeout: true });
    }, timeoutMs);
    waiters.add(waiter);
    req.on('close', () => {
      if (waiters.has(waiter)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
      }
    });
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      if (!checkToken(url.searchParams.get('token'), res)) return;
      attachSse(req, res, url);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      if (!checkToken(url.searchParams.get('token'), res)) return;
      sendJson(res, 200, publicSnapshot(state));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/training-detail') {
      if (!checkToken(url.searchParams.get('token'), res)) return;
      const ref = url.searchParams.get('ref') ?? '';
      if (!/^[0-9a-f]{64}$/.test(ref)) {
        sendJson(res, 400, { ok: false, code: 'BAD_DETAIL_REF' });
        return;
      }
      const item = (state.training ?? []).find((row) => row.detailRef === ref);
      if (!item?.detailSha256) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      try {
        const detail = readTrainingDetail(root, ref, item.detailSha256);
        sendJson(res, 200, { ok: true, detail });
      } catch {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/wait-action') {
      if (!checkToken(url.searchParams.get('token'), res)) return;
      attachWait(req, res, url);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/publish') {
      const body = await readJsonBody(req, res);
      if (body == null) return;
      if (!checkToken(url.searchParams.get('token') ?? body.token, res)) return;
      handlePublish(body, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readJsonBody(req, res);
      if (body == null) return;
      if (!checkToken(url.searchParams.get('token') ?? body.token, res)) return;
      handleAction(body, res);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(pathname, res);
      return;
    }

    sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL' });
      else res.destroy();
    });
  });

  // Node's default requestTimeout (300s) would kill SSE and long-poll.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = HEADERS_MS;

  const close = () => new Promise((resolve, reject) => {
    for (const client of sseClients) {
      clearInterval(client.heartbeat);
      try { client.res.end(); } catch { /* already closed */ }
    }
    sseClients.clear();
    for (const waiter of waiters) clearTimeout(waiter.timer);
    waiters.clear();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const actualPort = server.address().port;
      writeJsonAtomic(path.join(root, 'lock.json'), {
        serverPid: process.pid,
        port: actualPort,
        sessionToken: token,
        startedAt: new Date().toISOString(),
      });
      resolve({ server, port: actualPort, close });
    });
  });
}

const isDirectRun = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.token) {
    console.error('usage: node server/server.js --game-dir game --port 8877 --token <t>');
    process.exit(2);
  }
  const { port } = await startServer(opts);
  process.stdout.write(`listening 127.0.0.1:${port}\n`);
}
