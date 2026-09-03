import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { withNamedLock } from '../engine/state.js';
import { assertEvaluationId } from '../training/contracts.js';
import { toPublicSummary } from '../training/public-view.js';
import { createProfileStore, createMistakeBank } from './training-stores.js';
import {
  SUPPORTED_TRAINING_AUTHORITY_SCHEMAS,
  detailRefOf,
  legacyExplanationAnnotation,
  projectTrainingAnnotation,
  projectTrainingSummary,
  sha256Hex,
} from '../publish-contract.js';
import {
  appendJsonl,
  ensureDir,
  openContained,
  readJsonl,
  readJsonSecure,
  writeContained,
  writeJsonSecure,
  writeTextSecure,
} from './training-store.js';

export const TRAINING_LOCK = 'training.lock.d';
export const SUPPORTED_SCHEMAS = SUPPORTED_TRAINING_AUTHORITY_SCHEMAS;
const ANNOTATION_MAX_BYTES = 64_000;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function trainingDir(sessionDir) {
  return path.join(sessionDir, 'training');
}

function authPath(sessionDir) {
  return path.join(trainingDir(sessionDir), '.training-authority.json');
}

function evaluationsPath(sessionDir) {
  return path.join(trainingDir(sessionDir), 'evaluations.jsonl');
}

function detailsDir(sessionDir) {
  return path.join(trainingDir(sessionDir), 'details');
}

function markerPath(sessionDir) {
  return path.join(trainingDir(sessionDir), '.migration-v2.json');
}

function digestMapPath(sessionDir) {
  return path.join(trainingDir(sessionDir), '.digest-map-v2.json');
}

export function annotationExactSegments(detailRef, field) {
  return ['annotations', `${detailRef}.${field}.json`];
}

export function cutoffMarkerPath(sessionDir) {
  return path.join(trainingDir(sessionDir), '.cutoff');
}

const explanationCutoffSessions = new Set();

export function enterExplanationCutoff(sessionDir) {
  explanationCutoffSessions.add(path.resolve(sessionDir));
}

export function hasCutoffMarker(sessionDir) {
  try {
    return fs.lstatSync(cutoffMarkerPath(sessionDir)).isFile();
  } catch {
    return false;
  }
}

export function hasExplanationCutoff(sessionDir) {
  return explanationCutoffSessions.has(path.resolve(sessionDir)) || hasCutoffMarker(sessionDir);
}

function inspectCutoffMarker(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isFile()) return { reused: true };
    throw coded('UNSAFE_PATH', `${file}는 안전한 일반 파일이 아닙니다.`);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeCutoffMarkerUnlocked(sessionDir, { write = writeContained } = {}) {
  ensureDir(trainingDir(sessionDir));
  const file = cutoffMarkerPath(sessionDir);
  const existing = inspectCutoffMarker(file);
  if (existing) {
    enterExplanationCutoff(sessionDir);
    return existing;
  }
  try {
    write(
      sessionDir,
      ['training', '.cutoff'],
      JSON.stringify({ at: new Date().toISOString() }),
      { mode: 'create' },
    );
    enterExplanationCutoff(sessionDir);
    return { reused: false };
  } catch (error) {
    if (error.code !== 'EXISTS') throw error;
    const reused = inspectCutoffMarker(file);
    if (reused) {
      enterExplanationCutoff(sessionDir);
      return reused;
    }
    throw coded('UNSAFE_PATH', `${file}는 안전한 일반 파일이 아닙니다.`);
  }
}

function emptyAuth({ gameEpoch, owner }) {
  return {
    schemaVersion: 2,
    gameEpoch,
    ownerSessionId: owner,
    items: {},
    publishQueue: {},
    pending: {},
    annotationQueue: {},
    solveTasks: {},
  };
}

function readMarker(sessionDir) {
  try {
    return readJsonSecure(markerPath(sessionDir));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function loadProcessed(storeDir) {
  try {
    const profile = readJsonSecure(path.join(storeDir, '.training', 'profile.json'));
    return profile?.processed ?? {};
  } catch {
    return {};
  }
}

function loadMistakeIds(storeDir) {
  try {
    const data = readJsonSecure(path.join(storeDir, '.training', 'mistakes.json'));
    return new Set((data.items ?? []).map((item) => item.mistakeId));
  } catch {
    return new Set();
  }
}

export function writeAnnotationExactFile(sessionDir, detailRef, field, canonical) {
  const root = trainingDir(sessionDir);
  ensureDir(path.join(root, 'annotations'));
  const bytes = JSON.stringify(canonical);
  const segments = annotationExactSegments(detailRef, field);
  try {
    writeContained(root, segments, bytes, { mode: 'create' });
  } catch (error) {
    if (error.code !== 'EXISTS') throw error;
    const existing = openContained(root, segments, { maxBytes: ANNOTATION_MAX_BYTES }).toString('utf8');
    if (existing !== bytes) return { reused: true, conflict: true };
    return { reused: true, conflict: false };
  }
  return { reused: false, conflict: false };
}

export function readAnnotationExactFile(sessionDir, detailRef, field) {
  const buf = openContained(trainingDir(sessionDir), annotationExactSegments(detailRef, field), {
    maxBytes: ANNOTATION_MAX_BYTES,
  });
  return JSON.parse(buf.toString('utf8'));
}

function resolveV1Attempt(sessionDir, items) {
  const attemptFile = path.join(sessionDir, '.publish-attempt.json');
  if (!fs.existsSync(attemptFile)) {
    return {
      resolved: false, applied: false, appliedIds: [], appliedAnnotationIds: [],
    };
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
  } catch {
    return {
      resolved: false, applied: false, appliedIds: [], appliedAnnotationIds: [],
    };
  }
  const trainingAuthz = record.trainingAuthority;
  const bodyTraining = Array.isArray(record.body?.training) ? record.body.training : [];
  const isTrainingAttempt = Boolean(trainingAuthz) || bodyTraining.length > 0;
  if (!isTrainingAttempt) {
    return {
      resolved: false, applied: false, appliedIds: [], appliedAnnotationIds: [],
    };
  }
  const v1Shape = Boolean(trainingAuthz?.evaluationId) && !Array.isArray(trainingAuthz?.items);
  if (!v1Shape && !bodyTraining.length) {
    return {
      resolved: false, applied: false, appliedIds: [], appliedAnnotationIds: [],
    };
  }
  const evalIds = Array.isArray(trainingAuthz?.items)
    ? trainingAuthz.items.map((entry) => entry.evaluationId)
    : [
      trainingAuthz?.evaluationId,
      ...bodyTraining.map((row) => row?.evaluationId),
    ].filter(Boolean);
  let snapshotPublishId = 0;
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ui-snapshot.json'), 'utf8'));
    snapshotPublishId = Number(snap.publishId) || 0;
  } catch { /* no snapshot */ }
  const attemptId = Number(record.body?.publishId) || 0;
  const applied = attemptId > 0 && snapshotPublishId >= attemptId;
  const appliedIds = [];
  const appliedAnnotationIds = [];
  const legacyExplanationIds = new Set(bodyTraining
    .filter((row) => row && Object.prototype.hasOwnProperty.call(row, 'explanation'))
    .map((row) => row.evaluationId));
  let changed = false;
  if (applied) {
    for (const id of evalIds) {
      if (!items[id]) continue;
      if (items[id].status !== 'published' || items[id].consumers?.published !== true) changed = true;
      items[id].status = 'published';
      items[id].consumers = { ...(items[id].consumers ?? {}), published: true };
      appliedIds.push(id);
      if (legacyExplanationIds.has(id) && items[id].annotations?.explanation) {
        if (items[id].annotations.explanation.published !== true) changed = true;
        items[id].annotations.explanation.published = true;
        appliedAnnotationIds.push(id);
      }
    }
  }
  return {
    resolved: true, applied, appliedIds, appliedAnnotationIds, attemptFile, changed,
  };
}

function rewriteJsonlFromItems(sessionDir, auth, { writeTextSecure: writeText = writeTextSecure } = {}) {
  const lines = Object.values(auth.items ?? {})
    .sort((left, right) => (left.handNo ?? 0) - (right.handNo ?? 0)
      || String(left.evaluationId).localeCompare(String(right.evaluationId)))
    .map((item) => JSON.stringify(item.summary));
  writeText(evaluationsPath(sessionDir), lines.length ? `${lines.join('\n')}\n` : '');
}

function migrationWriters(overrides = {}) {
  return {
    writeJsonSecure: overrides.writeJsonSecure ?? writeJsonSecure,
    writeTextSecure: overrides.writeTextSecure ?? writeTextSecure,
    unlinkSync: overrides.unlinkSync ?? ((file) => fs.unlinkSync(file)),
  };
}

function sessionDoneMarker() {
  return {
    status: 'session-done',
    at: new Date().toISOString(),
    digestMapRef: '.digest-map-v2.json',
  };
}

function removeMigrationFile(file) {
  try {
    if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
  } catch { /* rollback cleanup is best-effort; the original failure remains authoritative */ }
}

function migrationNotices(auth) {
  const overCap = Object.values(auth?.items ?? {}).filter(
    (item) => item.annotations?.explanation?.sealReason === 'LEGACY_OVER_CAP',
  ).length;
  return overCap > 0
    ? [`legacy explanation ${overCap}건 상한 초과 → unavailable`]
    : [];
}

function migrationResult(auth, { includeNotices = false } = {}) {
  return auth ? { ...auth, notices: includeNotices ? migrationNotices(auth) : [] } : null;
}

function finishResolvedAttempt(sessionDir, auth, writers) {
  const attempt = resolveV1Attempt(sessionDir, auth.items ?? {});
  if (!attempt.resolved) return false;
  let changed = attempt.changed;
  for (const id of attempt.appliedIds) {
    if (Object.prototype.hasOwnProperty.call(auth.publishQueue ?? {}, id)) {
      delete auth.publishQueue[id];
      changed = true;
    }
  }
  for (const id of attempt.appliedAnnotationIds) {
    if (auth.annotationQueue?.[id]?.explanation) {
      delete auth.annotationQueue[id].explanation;
      if (Object.keys(auth.annotationQueue[id]).length === 0) delete auth.annotationQueue[id];
      changed = true;
    }
  }
  if (changed) writers.writeJsonSecure(authPath(sessionDir), auth);
  writers.unlinkSync(attempt.attemptFile);
  return true;
}

function migrateV1ToV2Unlocked(sessionDir, auth, { storeDir, io = {} } = {}) {
  const writers = migrationWriters(io);
  const marker = readMarker(sessionDir);
  if (auth.schemaVersion === 2) {
    let resumedMigration = false;
    if (marker?.status === 'in-progress') {
      if (!fs.existsSync(digestMapPath(sessionDir))) {
        throw coded(
          'TRAINING_MIGRATION_CORRUPT',
          'v2 authority의 in-progress 마이그레이션에 digest map이 없습니다.',
        );
      }
      rewriteJsonlFromItems(sessionDir, auth, writers);
      writers.writeJsonSecure(markerPath(sessionDir), sessionDoneMarker());
      finishResolvedAttempt(sessionDir, auth, writers);
      resumedMigration = true;
    } else if (marker?.status === 'session-done' || marker?.status === 'complete') {
      resumedMigration = finishResolvedAttempt(sessionDir, auth, writers);
    }
    return migrationResult(auth, { includeNotices: resumedMigration });
  }
  if (auth.schemaVersion !== 1) {
    throw coded('UNSUPPORTED_TRAINING_AUTHORITY', `schema ${auth.schemaVersion}`);
  }

  try {
    writers.writeJsonSecure(markerPath(sessionDir), {
      status: 'in-progress',
      at: new Date().toISOString(),
    });

    const rows = readJsonl(evaluationsPath(sessionDir));
    const rowById = new Map(rows.map((row) => [row.evaluationId, row]));
    const oldToNew = {};
    const byEvaluationId = {};
    const newItems = {};
    const newQueue = {};
    const annotationQueue = {};
    const pending = auth.pending && typeof auth.pending === 'object' && !Array.isArray(auth.pending)
      ? { ...auth.pending }
      : {};
    const processed = storeDir ? loadProcessed(storeDir) : {};
    const mistakeIds = storeDir ? loadMistakeIds(storeDir) : new Set();

    for (const [id, item] of Object.entries(auth.items ?? {})) {
      const row = rowById.get(id);
      const detailRef = item.detailRef ?? row?.detailRef ?? detailRefOf(id);
      let evaluation = null;
      try {
        evaluation = readJsonSecure(path.join(detailsDir(sessionDir), `${detailRef}.json`));
      } catch {
        evaluation = row ?? null;
      }
      const explanation = row && Object.prototype.hasOwnProperty.call(row, 'explanation')
        ? row.explanation
        : null;
      let summary;
      if (evaluation?.evaluationId) {
        summary = toPublicSummary(evaluation, {
          handNo: item.handNo ?? row?.handNo,
          detailRef,
          detailSha256: item.detailSha256 ?? row?.detailSha256,
        });
      } else if (row) {
        const rest = { ...row };
        delete rest.explanation;
        delete rest.payloadSha256;
        summary = projectTrainingSummary({
          ...rest,
          recommendedTruncated: rest.recommendedTruncated === true,
        });
      } else {
        continue;
      }
      oldToNew[item.payloadSha256] = summary.payloadSha256;
      byEvaluationId[id] = { old: item.payloadSha256, new: summary.payloadSha256 };

      const annotations = {};
      const legacyAnnotation = legacyExplanationAnnotation(explanation);
      if (legacyAnnotation) {
        const projected = projectTrainingAnnotation({
          evaluationId: id,
          payloadSha256: summary.payloadSha256,
          field: 'explanation',
          status: legacyAnnotation.status,
          value: legacyAnnotation.value,
        });
        annotations.explanation = {
          status: legacyAnnotation.status,
          valueSha256: projected.valueSha256,
          published: item.status === 'published',
          ...(legacyAnnotation.sealReason ? { sealReason: legacyAnnotation.sealReason } : {}),
        };
        const written = writeAnnotationExactFile(sessionDir, summary.detailRef, 'explanation', {
          field: 'explanation',
          status: legacyAnnotation.status,
          value: legacyAnnotation.value,
        });
        if (written.conflict) {
          throw coded('ANNOTATION_CONFLICT', 'legacy explanation exact-file이 기존 값과 다릅니다.');
        }
        if (item.status !== 'published') {
          annotationQueue[id] = annotationQueue[id] ?? {};
          annotationQueue[id].explanation = {
            evaluationId: id,
            field: 'explanation',
            valueSha256: projected.valueSha256,
            payloadSha256: summary.payloadSha256,
            published: false,
          };
        }
      }

      newItems[id] = {
        status: item.status === 'published' ? 'published' : 'evaluated',
        handNo: item.handNo,
        decisionId: item.decisionId,
        evaluationId: id,
        payloadSha256: summary.payloadSha256,
        detailRef: summary.detailRef,
        detailSha256: item.detailSha256 ?? summary.detailSha256,
        summary,
        consumers: {
          published: item.status === 'published',
          profiled: Object.prototype.hasOwnProperty.call(processed, id),
          banked: mistakeIds.has(id),
        },
        annotations,
      };
    }

    const attempt = resolveV1Attempt(sessionDir, newItems);
    for (const id of attempt.appliedAnnotationIds) {
      if (annotationQueue[id]?.explanation) {
        delete annotationQueue[id].explanation;
        if (Object.keys(annotationQueue[id]).length === 0) delete annotationQueue[id];
      }
    }
    for (const [id, item] of Object.entries(newItems)) {
      if (item.status === 'published') continue;
      newQueue[id] = {
        evaluationId: id,
        handNo: item.handNo,
        payloadSha256: item.payloadSha256,
      };
    }

    const v2 = {
      schemaVersion: 2,
      gameEpoch: auth.gameEpoch,
      ownerSessionId: auth.ownerSessionId,
      items: newItems,
      publishQueue: newQueue,
      pending,
      annotationQueue,
      solveTasks: {},
    };
    writers.writeJsonSecure(digestMapPath(sessionDir), {
      schemaVersion: 1,
      oldToNew,
      byEvaluationId,
    });
    writers.writeJsonSecure(authPath(sessionDir), v2);
    rewriteJsonlFromItems(sessionDir, v2, writers);
    writers.writeJsonSecure(markerPath(sessionDir), sessionDoneMarker());
    if (attempt.resolved) writers.unlinkSync(attempt.attemptFile);
    return migrationResult(v2, { includeNotices: true });
  } catch (error) {
    let diskAuthority = null;
    try {
      diskAuthority = readJsonSecure(authPath(sessionDir));
    } catch {
      // Without readable disk truth, do not guess that a commit did or did not happen.
    }
    if (diskAuthority?.schemaVersion === 1) {
      removeMigrationFile(markerPath(sessionDir));
      removeMigrationFile(digestMapPath(sessionDir));
    }
    throw error;
  }
}

// 한 세션의 authority는 그 세션 소유다. 죽은 줄 알았던 이전 owner가 살아 돌아와
// 쓰면 두 사이드카가 같은 파일을 갈라 쓰게 된다 — 소유자가 다르면 거부한다.
function assertOwner(auth, owner) {
  const current = auth.ownerSessionId;
  if (typeof current !== 'string' || current === '') return;
  if (current === owner) return;
  throw coded(
    'TRAINING_OWNER_MISMATCH',
    `training authority는 ${current} 소유입니다(요청: ${owner ?? 'unnamed'}).`,
  );
}

function loadAuthorityUnlocked(sessionDir) {
  try {
    const auth = readJsonSecure(authPath(sessionDir));
    const marker = readMarker(sessionDir);
    if (auth.schemaVersion === 1) {
      throw coded('TRAINING_AUTHORITY_V1', 'v1 training authority는 명시적으로 마이그레이션해야 합니다.');
    }
    if (auth.schemaVersion !== 2) {
      throw coded('UNSUPPORTED_TRAINING_AUTHORITY', `schema ${auth.schemaVersion}`);
    }
    if (marker?.status === 'in-progress') {
      if (!fs.existsSync(digestMapPath(sessionDir))) {
        throw coded(
          'TRAINING_MIGRATION_CORRUPT',
          'v2 authority의 in-progress 마이그레이션에 digest map이 없습니다.',
        );
      }
      throw coded('TRAINING_MIGRATION_INCOMPLETE', 'training authority 마이그레이션이 완료되지 않았습니다.');
    }
    if (!auth.items || typeof auth.items !== 'object' || Array.isArray(auth.items)) {
      throw coded('UNSUPPORTED_TRAINING_AUTHORITY', 'items');
    }
    auth.pending = auth.pending && typeof auth.pending === 'object' && !Array.isArray(auth.pending)
      ? auth.pending
      : {};
    auth.annotationQueue = auth.annotationQueue && typeof auth.annotationQueue === 'object'
      && !Array.isArray(auth.annotationQueue)
      ? auth.annotationQueue
      : {};
    auth.publishQueue = auth.publishQueue && typeof auth.publishQueue === 'object'
      && !Array.isArray(auth.publishQueue)
      ? auth.publishQueue
      : {};
    auth.solveTasks = auth.solveTasks && typeof auth.solveTasks === 'object'
      && !Array.isArray(auth.solveTasks)
      ? auth.solveTasks
      : {};
    return auth;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'UNSAFE_PATH') {
      if (error.code === 'UNSAFE_PATH' && fs.existsSync(authPath(sessionDir))) throw error;
    }
    if (error.code === 'ENOENT') return null;
    try {
      fs.accessSync(authPath(sessionDir));
    } catch (accessError) {
      if (accessError.code === 'ENOENT') return null;
    }
    if (['UNSUPPORTED_TRAINING_AUTHORITY', 'TRAINING_AUTHORITY_V1',
      'TRAINING_MIGRATION_INCOMPLETE', 'TRAINING_MIGRATION_CORRUPT'].includes(error.code)) throw error;
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function persistAuth(sessionDir, auth) {
  writeJsonSecure(authPath(sessionDir), auth);
}

function userDecisionsOf(record) {
  if (!record || !Array.isArray(record.decisions)) return [];
  return record.decisions.filter((snap) => snap.actorId === 'user');
}

function collectRecords({ lastHand, handsDir }) {
  const byHand = new Map();
  if (lastHand?.handNo) byHand.set(lastHand.handNo, lastHand);
  if (handsDir && fs.existsSync(handsDir)) {
    for (const name of fs.readdirSync(handsDir)) {
      const match = /^hand-(\d+)\.json$/.exec(name);
      if (!match) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(handsDir, name), 'utf8'));
        if (Number.isInteger(record?.handNo)) byHand.set(record.handNo, record);
      } catch {
        /* unreadable archive is ignored; lastHand may still cover it */
      }
    }
  }
  return [...byHand.values()].sort((a, b) => a.handNo - b.handNo);
}

function recordPendingUnlocked(auth, decisionId, { handNo, reason, adapterId } = {}) {
  const existing = auth.pending[decisionId];
  const entry = {
    handNo,
    reason,
    attempts: (existing?.attempts ?? 0) + 1,
    lastTriedAt: new Date().toISOString(),
  };
  const keepAdapter = adapterId ?? existing?.adapterId;
  if (keepAdapter) entry.adapterId = keepAdapter;
  auth.pending[decisionId] = entry;
  return auth.pending[decisionId];
}

function profileConsumerReady(sessionDir) {
  const marker = readMarker(sessionDir);
  if (!marker) return true;
  return marker.status === 'complete';
}

export function createTrainingControl({ storeDir, io } = {}) {
  async function withLock(sessionDir, fn) {
    return withNamedLock(sessionDir, TRAINING_LOCK, fn);
  }

  async function withMigrationLock(sessionDir, fn) {
    return withNamedLock(sessionDir, TRAINING_LOCK, fn, { timeoutMs: 10_000 });
  }

  function loadAuthority(sessionDir) {
    return loadAuthorityUnlocked(sessionDir, { storeDir });
  }

  async function migrateAuthority(sessionDir) {
    return withMigrationLock(sessionDir, () => {
      let auth;
      try {
        auth = readJsonSecure(authPath(sessionDir));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      return migrateV1ToV2Unlocked(sessionDir, auth, { storeDir, io });
    });
  }

  async function acceptEvaluations(sessionDir, {
    gameEpoch, owner, handNo, evaluations,
  }) {
    return withLock(sessionDir, () => {
      let auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (auth && auth.gameEpoch !== gameEpoch) {
        if (Object.keys(auth.items ?? {}).length > 0) {
          throw coded('TRAINING_EPOCH_MISMATCH', 'training authority gameEpoch가 일치하지 않습니다.');
        }
        auth.gameEpoch = gameEpoch;
      }
      if (!auth) auth = emptyAuth({ gameEpoch, owner });
      assertOwner(auth, owner);
      auth.ownerSessionId = owner;
      auth.pending = auth.pending ?? {};
      auth.annotationQueue = auth.annotationQueue ?? {};
      const accepted = [];
      for (const evaluation of evaluations ?? []) {
        const evaluationId = assertEvaluationId(evaluation.evaluationId);
        const detailRef = detailRefOf(evaluationId);
        ensureDir(detailsDir(sessionDir));
        const detailPath = path.join(detailsDir(sessionDir), `${detailRef}.json`);
        const detailRaw = JSON.stringify(evaluation);
        const detailSha256 = sha256Hex(detailRaw);
        let summary;
        try {
          summary = toPublicSummary(evaluation, { handNo, detailSha256, detailRef });
        } catch (error) {
          if (error.code === 'SUMMARY_FIELD_TOO_LONG') {
            recordPendingUnlocked(auth, evaluation.decisionId, {
              handNo,
              reason: 'SUMMARY_FIELD_TOO_LONG',
            });
            persistAuth(sessionDir, auth);
          }
          throw error;
        }
        const existing = auth.items[evaluationId];
        if (existing) {
          if (existing.payloadSha256 !== summary.payloadSha256) {
            throw coded('EVALUATION_CONFLICT', '같은 evaluationId에 다른 digest가 있습니다.');
          }
          accepted.push(existing);
          continue;
        }
        writeJsonSecure(detailPath, evaluation);
        const pending = auth.pending[evaluation.decisionId];
        const attempts = pending?.attempts;
        delete auth.pending[evaluation.decisionId];
        const item = {
          status: 'evaluated',
          handNo,
          decisionId: evaluation.decisionId,
          evaluationId,
          payloadSha256: summary.payloadSha256,
          detailRef,
          detailSha256,
          summary,
          consumers: { published: false, profiled: false, banked: false },
          annotations: {},
        };
        if (attempts != null) item.attempts = attempts;
        auth.items[evaluationId] = item;
        auth.publishQueue[evaluationId] = {
          evaluationId,
          handNo,
          payloadSha256: summary.payloadSha256,
        };
        persistAuth(sessionDir, auth);
        appendJsonl(evaluationsPath(sessionDir), summary);
        accepted.push(item);
      }
      persistAuth(sessionDir, auth);
      return { accepted };
    });
  }

  async function reconcile(sessionDir, {
    gameEpoch, owner, lastHand, handsDir,
  }) {
    return withLock(sessionDir, () => {
      let auth = loadAuthorityUnlocked(sessionDir, { storeDir }) ?? emptyAuth({ gameEpoch, owner });
      if (auth.gameEpoch !== gameEpoch && Object.keys(auth.items).length) {
        throw coded('TRAINING_EPOCH_MISMATCH', 'training authority gameEpoch가 일치하지 않습니다.');
      }
      if (!Object.keys(auth.items).length && !Object.keys(auth.pending ?? {}).length) {
        auth = emptyAuth({ gameEpoch, owner });
      }
      auth.gameEpoch = gameEpoch;
      auth.ownerSessionId = owner;
      auth.pending = auth.pending ?? {};
      auth.annotationQueue = auth.annotationQueue ?? {};
      const rows = readJsonl(evaluationsPath(sessionDir));
      let repaired = 0;
      const created = 0;

      for (const row of rows) {
        if (!row?.evaluationId || auth.items[row.evaluationId]) continue;
        const detailRef = row.detailRef ?? detailRefOf(row.evaluationId);
        let evaluation = null;
        try {
          evaluation = readJsonSecure(path.join(detailsDir(sessionDir), `${detailRef}.json`));
        } catch {
          continue;
        }
        const summary = toPublicSummary(evaluation, {
          handNo: row.handNo,
          detailRef,
          detailSha256: row.detailSha256 ?? sha256Hex(JSON.stringify(evaluation)),
        });
        auth.items[row.evaluationId] = {
          status: 'evaluated',
          handNo: row.handNo,
          decisionId: row.decisionId ?? evaluation.decisionId,
          evaluationId: row.evaluationId,
          payloadSha256: summary.payloadSha256,
          detailRef,
          detailSha256: summary.detailSha256,
          summary,
          consumers: { published: false, profiled: false, banked: false },
          annotations: {},
        };
        auth.publishQueue[row.evaluationId] = {
          evaluationId: row.evaluationId,
          handNo: row.handNo,
          payloadSha256: summary.payloadSha256,
        };
        repaired += 1;
      }

      const haveRow = new Set(rows.map((row) => row.evaluationId));
      for (const item of Object.values(auth.items)) {
        if (haveRow.has(item.evaluationId) || !item.summary) continue;
        appendJsonl(evaluationsPath(sessionDir), item.summary);
        haveRow.add(item.evaluationId);
        repaired += 1;
      }

      const missing = [];
      const covered = new Set([
        ...Object.values(auth.items).map((item) => item.decisionId),
        ...Object.keys(auth.pending),
      ]);
      for (const record of collectRecords({ lastHand, handsDir })) {
        for (const snap of userDecisionsOf(record)) {
          if (covered.has(snap.decisionId)) continue;
          recordPendingUnlocked(auth, snap.decisionId, {
            handNo: record.handNo,
            reason: 'MISSING_EVALUATION',
          });
          missing.push({ handNo: record.handNo, decisionId: snap.decisionId });
          covered.add(snap.decisionId);
        }
      }

      persistAuth(sessionDir, auth);
      return {
        created, repaired, missing, pending: auth.pending, authority: auth,
      };
    });
  }

  function pendingItems(sessionDir) {
    const auth = loadAuthorityUnlocked(sessionDir, { storeDir });
    if (!auth) return [];
    return Object.values(auth.items).filter((item) => item.status !== 'published');
  }

  async function markPublished(sessionDir, evaluationId, payloadSha256) {
    return withLock(sessionDir, () => {
      const auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (!auth) throw coded('NO_TRAINING_AUTHORITY', 'training authority가 없습니다.');
      const item = auth.items[evaluationId];
      if (!item) throw coded('NO_TRAINING_ITEM', evaluationId);
      if (item.payloadSha256 !== payloadSha256) {
        throw coded('EVALUATION_CONFLICT', '같은 evaluationId에 다른 digest가 있습니다.');
      }
      item.status = 'published';
      item.consumers = { ...(item.consumers ?? {}), published: true };
      delete auth.publishQueue[evaluationId];
      persistAuth(sessionDir, auth);
      return item;
    });
  }

  async function markConsumer(sessionDir, evaluationId, name, value) {
    return withLock(sessionDir, () => {
      const auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (!auth) throw coded('NO_TRAINING_AUTHORITY', 'training authority가 없습니다.');
      const item = auth.items[evaluationId];
      if (!item) throw coded('NO_TRAINING_ITEM', evaluationId);
      if (!['published', 'profiled', 'banked'].includes(name)) {
        throw coded('USAGE', `unknown consumer ${name}`);
      }
      item.consumers = { ...(item.consumers ?? {}), [name]: Boolean(value) };
      persistAuth(sessionDir, auth);
      return item;
    });
  }

  async function recordPending(sessionDir, decisionId, { handNo, reason, gameEpoch, owner, adapterId } = {}) {
    return withLock(sessionDir, () => {
      let auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (!auth) auth = emptyAuth({ gameEpoch: gameEpoch ?? null, owner: owner ?? null });
      // Same authority, same rule. Omitting the owner is not a way past it:
      // once an authority is owned, a writer has to say who it is.
      assertOwner(auth, owner ?? null);
      const entry = recordPendingUnlocked(auth, decisionId, { handNo, reason, adapterId });
      persistAuth(sessionDir, auth);
      return entry;
    });
  }

  // 진행 중인 solve를 권위에 남긴다. rollback guard(R10)가 `solveTasks`가 비어
  // 있는지로 quiescence를 판정하므로, 시작과 종료가 모두 락 아래에서 보여야
  // 한다. 점유는 토큰으로 소유자에게 묶인다 — 잡은 쪽만 풀 수 있다.
  async function claimSolveTask(sessionDir, decisionId, entry) {
    return withLock(sessionDir, () => {
      const auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (!auth) return { claimed: false, code: 'NO_TRAINING_AUTHORITY' };
      auth.solveTasks = auth.solveTasks ?? {};
      const existing = auth.solveTasks[decisionId];
      if (existing) {
        return { claimed: false, code: 'SOLVE_ALREADY_RUNNING', task: existing };
      }
      const token = randomBytes(16).toString('hex');
      // entry를 먼저 펴야 호출자가 준 필드가 소유권 토큰이나 decisionId를
      // 덮어쓰지 못한다 — 예측 가능한 토큰이 들어오면 아무나 점유를 풀 수 있다.
      auth.solveTasks[decisionId] = { ...entry, decisionId, token };
      persistAuth(sessionDir, auth);
      return { claimed: true, token };
    });
  }

  // 크래시로 claim과 release 사이가 끊기면 점유가 영속 파일에 남아 resume의
  // 재기동과 rollback guard를 영구히 막는다. loop 락이 세션당 사이드카를 하나로
  // 강제하므로, 살아 있는 프로세스가 소유하지 않은 점유는 정의상 죽은 것이다.
  async function reapSolveTasks(sessionDir, { keepDecisionIds = [] } = {}) {
    return withLock(sessionDir, () => {
      const auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (!auth) return { reaped: 0 };
      const keep = new Set(keepDecisionIds);
      const stale = Object.keys(auth.solveTasks ?? {}).filter((id) => !keep.has(id));
      for (const decisionId of stale) delete auth.solveTasks[decisionId];
      if (stale.length > 0) persistAuth(sessionDir, auth);
      return { reaped: stale.length, decisionIds: stale };
    });
  }

  async function releaseSolveTask(sessionDir, decisionId, token) {
    return withLock(sessionDir, () => {
      const auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (!auth) return { released: false };
      const existing = auth.solveTasks?.[decisionId];
      if (!existing || existing.token !== token) return { released: false };
      delete auth.solveTasks[decisionId];
      persistAuth(sessionDir, auth);
      return { released: true };
    });
  }

  async function writeCutoffMarker(sessionDir) {
    return withLock(sessionDir, () => writeCutoffMarkerUnlocked(sessionDir));
  }

  async function sealAnnotation(sessionDir, evaluationId, field, valueOrUnavailable) {
    return withLock(sessionDir, () => {
      const auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (!auth) return { ok: false, code: 'NO_TRAINING_ITEM' };
      const item = auth.items[evaluationId];
      if (!item) return { ok: false, code: 'NO_TRAINING_ITEM' };
      let status = valueOrUnavailable === 'unavailable' ? 'unavailable' : 'ready';
      let value = status === 'unavailable' ? null : valueOrUnavailable;
      if (field === 'explanation' && status === 'ready' && hasExplanationCutoff(sessionDir)) {
        status = 'unavailable';
        value = null;
      }
      const existing = item.annotations?.[field];
      if (existing?.status === 'unavailable') {
        return { ok: true, discarded: true };
      }
      let projected;
      try {
        projected = projectTrainingAnnotation({
          evaluationId,
          payloadSha256: item.payloadSha256,
          field,
          status,
          value,
        });
      } catch (error) {
        return { ok: false, code: error.code ?? 'ANNOTATION_PROOF_MISMATCH' };
      }
      if (existing?.status === 'ready') {
        if (existing.valueSha256 === projected.valueSha256) return { ok: true, noop: true };
        return { ok: false, code: 'ANNOTATION_CONFLICT' };
      }
      const written = writeAnnotationExactFile(sessionDir, item.detailRef, field, {
        field,
        status,
        value: projected.value,
      });
      if (written.conflict) return { ok: true, discarded: true };
      item.annotations = item.annotations ?? {};
      item.annotations[field] = {
        status,
        valueSha256: projected.valueSha256,
        published: false,
      };
      auth.annotationQueue[evaluationId] = auth.annotationQueue[evaluationId] ?? {};
      auth.annotationQueue[evaluationId][field] = {
        evaluationId,
        field,
        valueSha256: projected.valueSha256,
        payloadSha256: item.payloadSha256,
        published: false,
      };
      persistAuth(sessionDir, auth);
      return { ok: true, annotation: item.annotations[field], converted: status === 'unavailable' && valueOrUnavailable !== 'unavailable' };
    });
  }

  async function markAnnotationPublished(sessionDir, evaluationId, field, valueSha256) {
    return withLock(sessionDir, () => {
      const auth = loadAuthorityUnlocked(sessionDir, { storeDir });
      if (!auth) throw coded('NO_TRAINING_AUTHORITY', 'training authority가 없습니다.');
      const item = auth.items[evaluationId];
      if (!item) throw coded('NO_TRAINING_ITEM', evaluationId);
      const annotation = item.annotations?.[field];
      if (!annotation) throw coded('NO_TRAINING_ITEM', `${evaluationId}:${field}`);
      if (annotation.valueSha256 !== valueSha256) {
        throw coded('ANNOTATION_CONFLICT', '같은 annotation에 다른 digest가 있습니다.');
      }
      annotation.published = true;
      const queued = auth.annotationQueue[evaluationId];
      if (queued) {
        delete queued[field];
        if (Object.keys(queued).length === 0) delete auth.annotationQueue[evaluationId];
      }
      persistAuth(sessionDir, auth);
      return item;
    });
  }

  async function consumeTrainingItems(sessionDir, { storeDir: consumeStore } = {}) {
    const activeStore = consumeStore ?? storeDir;
    if (activeStore && !profileConsumerReady(sessionDir)) {
      return { skipped: true, profiled: 0, banked: 0, applied: 0 };
    }
    return withLock(sessionDir, async () => {
      const auth = loadAuthorityUnlocked(sessionDir, { storeDir: activeStore });
      if (!auth) return { profiled: 0, banked: 0, applied: 0 };
      let profiled = 0;
      let banked = 0;
      let applied = 0;
      if (activeStore) {
        const store = createProfileStore(activeStore);
        const bank = createMistakeBank(activeStore);
        for (const item of Object.values(auth.items)) {
          item.consumers = item.consumers ?? { published: false, profiled: false, banked: false };
          if (!item.consumers.profiled) {
            const result = await store.apply(item.summary);
            if (result?.applied === true || result?.applied === false) {
              item.consumers.profiled = true;
              profiled += 1;
              if (result.applied === true) applied += 1;
            }
          }
          if (!item.consumers.banked) {
            await bank.collect(item.summary);
            item.consumers.banked = true;
            banked += 1;
          }
        }
      }
      persistAuth(sessionDir, auth);
      return { profiled, banked, applied };
    });
  }

  return {
    acceptEvaluations,
    reconcile,
    loadAuthority,
    migrateAuthority,
    pendingItems,
    markPublished,
    markConsumer,
    recordPending,
    claimSolveTask,
    releaseSolveTask,
    reapSolveTasks,
    sealAnnotation,
    markAnnotationPublished,
    writeCutoffMarker,
    consumeTrainingItems,
    withLock,
  };
}
