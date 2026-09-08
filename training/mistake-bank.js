import { independentAssessmentEligibility } from '../shared/assistance.js';
import {referenceAssessmentEligibility} from '../shared/reference-coverage.js';
import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import { classifyOpportunity, isPreflopSpotKey } from './opportunities.js';
import { assertEvaluationId } from './contracts.js';
import { referenceQuality } from '../shared/reference.js';

const REVIEW_FIELDS = new Set([
  'lastReviewedAt', 'nextReviewAt', 'intervalDays', 'ease',
  'attempts', 'correctStreak', 'lapses',
]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function record(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function invalid(message) {
  throw coded('UNSUPPORTED_MISTAKES', message);
}

function safeKey(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'prototype'
    && !Object.hasOwn(Object.prototype, value);
}

function assertId(value) {
  if (!safeKey(value)) invalid('bank identity is invalid');
  assertEvaluationId(value);
}

function assertDigest(value) {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) invalid('bank evidence digest is invalid');
}

function timestamp(value) {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function requireIo(io, names) {
  for (const name of names) {
    if (typeof io?.[name] !== 'function') {
      const error = new Error(`training store io.${name}가 필요합니다.`);
      error.code = 'IO_NOT_INJECTED';
      throw error;
    }
  }
  return io;
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function originOf(evaluation) {
  if (evaluation.origin !== undefined
    && !['game', 'practice', 'drill', 'retest'].includes(evaluation.origin)) {
    invalid('bank evidence origin is invalid');
  }
  return ['practice', 'drill', 'retest'].includes(evaluation.origin) ? 'practice' : 'game';
}

function sourceIdentityOf(evaluation) {
  const source = evaluation.source === undefined ? {} : evaluation.source;
  if (!record(source)) invalid('bank evaluation source is invalid');
  for (const key of ['id', 'version']) {
    if (source[key] !== undefined && (typeof source[key] !== 'string' || source[key].length === 0)) {
      invalid(`bank source ${key} is invalid`);
    }
  }
  if (Object.hasOwn(source, 'contentSha256')) assertDigest(source.contentSha256);
  return {
    id: source.id ?? 'unknown',
    version: source.version ?? '0.0.0',
    ...(Object.hasOwn(source, 'contentSha256') ? { contentSha256: source.contentSha256 } : {}),
  };
}

function collectable(evaluation) {
  if (!classifyOpportunity(evaluation).learnable || evaluation.forced !== false
    || evaluation.status !== 'supported' || evaluation.grade !== 'off-policy') return false;
  const quality = referenceQuality(evaluation.source);
  return quality.quality === 'heuristic-reference' && independentAssessmentEligibility(evaluation).metricEligible;
}

function signatureOf(evaluation) {
  const source = sourceIdentityOf(evaluation);
  return JSON.stringify([
    originOf(evaluation), source.id, source.version, source.contentSha256 ?? null,
    evaluation.spotKey, evaluation.handClass,
  ]);
}

function learnableEvidence(item) {
  const spotKey = item.spotKey ?? String(item.spotSignature ?? '').split(':')[0];
  return isPreflopSpotKey(spotKey);
}

function defaultReviewState(now) {
  return {
    lastReviewedAt: null,
    nextReviewAt: now,
    intervalDays: 1,
    ease: 2.3,
    attempts: 0,
    correctStreak: 0,
    lapses: 0,
  };
}

function statsOf(data) {
  return {
    prunedUnlearnable: Number.isSafeInteger(data.meta?.prunedUnlearnable)
      && data.meta.prunedUnlearnable >= 0 ? data.meta.prunedUnlearnable : 0,
    prunedAt: typeof data.meta?.prunedAt === 'string' ? data.meta.prunedAt : null,
  };
}

function evidenceFromLegacy(item) {
  if (!record(item) || !record(item.evaluation)) invalid('legacy bank evidence item is invalid');
  if (item.schemaVersion !== undefined && item.schemaVersion !== 1) invalid('legacy item schema is invalid');
  const evaluation = item.evaluation;
  const sourceIdentity = sourceIdentityOf(evaluation);
  const quality = referenceQuality(evaluation.source);
  const origin = originOf(evaluation);
  const evidenceDigests = {};
  assertId(item.mistakeId);
  evidenceDigests[item.mistakeId] = evaluation.payloadSha256;
  const evidence = {
    mistakeId: item.mistakeId,
    evaluationId: item.mistakeId,
    payloadSha256: evaluation.payloadSha256,
    evidenceIds: item.evidenceIds === undefined ? [item.mistakeId] : item.evidenceIds,
    evidenceDigests,
    evidence: item.evidence === undefined ? (item.evidenceIds?.length ?? 1) : item.evidence,
    origin,
    sourceIdentity,
    referenceQuality: quality.quality,
    availability: quality.quality === 'heuristic-reference' ? 'available' : 'unverified',
    spotKey: evaluation.spotKey,
    handClass: evaluation.handClass,
    spotSignature: item.spotSignature,
    evidenceIdentity: signatureOf({ ...evaluation, origin }),
    skillKey: item.skillKey,
    evaluation,
    firstSeenAt: item.firstSeenAt,
    lastSeenAt: item.lastSeenAt ?? item.firstSeenAt,
  };
  // A schema-1 file may contain additive compatibility fields. Keep them for
  // validation instead of overwriting contradictions with freshly derived values.
  for (const key of Object.keys(evidence)) {
    if (Object.hasOwn(item, key)) evidence[key] = item[key];
  }
  return evidence;
}

function reviewFromLegacy(item, now) {
  const defaults = defaultReviewState(now);
  for (const key of REVIEW_FIELDS) {
    if (item[key] !== undefined) defaults[key] = item[key];
  }
  return defaults;
}

function compose(evidence, reviewState) {
  const review = reviewState ?? {};
  return { ...evidence, ...review, reviewState: { ...review } };
}

function assertReviewPatchValues(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).some((key) => !REVIEW_FIELDS.has(key))) {
    throw coded('MISTAKE_UPDATE_FORBIDDEN', 'only SRS review fields may be updated');
  }
  for (const [key, value] of Object.entries(patch)) {
    if (['lastReviewedAt', 'nextReviewAt'].includes(key)) {
      if (value !== null && !timestamp(value)) {
        throw coded('MISTAKE_UPDATE_INVALID', `${key} must be null or an ISO timestamp`);
      }
    } else if (['intervalDays', 'attempts', 'correctStreak', 'lapses'].includes(key)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw coded('MISTAKE_UPDATE_INVALID', `${key} must be a nonnegative integer`);
      }
    } else if (key === 'ease' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      throw coded('MISTAKE_UPDATE_INVALID', 'ease must be a positive finite number');
    }
  }
}

function assertEnvelope(data, schemaVersion) {
  if (!record(data) || data.schemaVersion !== schemaVersion || !Array.isArray(data.items)) {
    invalid('bank schema or items are invalid');
  }
  if (data.meta !== undefined) {
    if (!record(data.meta)
      || (data.meta.prunedUnlearnable !== undefined && (!Number.isSafeInteger(data.meta.prunedUnlearnable)
        || data.meta.prunedUnlearnable < 0))
      || (data.meta.prunedAt !== undefined && data.meta.prunedAt !== null && !timestamp(data.meta.prunedAt))) {
      invalid('bank pruning metadata is invalid');
    }
  }
}

function assertEvaluation(evaluation) {
  if (!record(evaluation)) invalid('bank evaluation is invalid');
  assertId(evaluation.evaluationId);
  assertDigest(evaluation.payloadSha256);
  const [, decisionId, provider] = evaluation.evaluationId.split(':');
  const [providerId, providerVersion] = provider.split('@');
  const street = decisionId.split('-')[2];
  if ((evaluation.decisionId !== undefined && evaluation.decisionId !== decisionId)
    || (evaluation.street !== undefined && evaluation.street !== street)
    || (evaluation.source?.id !== undefined && evaluation.source.id !== providerId)
    || (evaluation.source?.version !== undefined && evaluation.source.version !== providerVersion)) {
    invalid('bank evaluation identity is inconsistent');
  }
  for (const key of ['spotKey', 'handClass']) {
    if (typeof evaluation[key] !== 'string' || evaluation[key].length === 0) {
      invalid(`bank evaluation ${key} is invalid`);
    }
  }
  if (!['supported', 'unsupported'].includes(evaluation.status)
    || (evaluation.forced !== undefined && typeof evaluation.forced !== 'boolean')
    || (evaluation.grade != null && !['preferred', 'mixed', 'low-frequency', 'off-policy'].includes(evaluation.grade))) {
    invalid('bank evaluation choice is invalid');
  }
  sourceIdentityOf(evaluation);
  originOf(evaluation);
}

function validateGraph(data, now) {
  assertEnvelope(data, 2);
  if (!record(data.reviewState)) invalid('bank review state is invalid');
  let changed = false;
  const seenIds = new Set();
  const seenMistakes = new Set();
  const seenGroups = new Set();
  for (const item of data.items) {
    if (!record(item)) invalid('bank evidence item is invalid');
    if (Object.hasOwn(item, 'reviewState') || [...REVIEW_FIELDS].some((key) => Object.hasOwn(item, key))) {
      invalid('bank evidence must not contain practice review state');
    }
    assertId(item.mistakeId);
    assertEvaluation(item.evaluation);
    if (seenMistakes.has(item.mistakeId) || seenGroups.has(item.evidenceIdentity)) {
      throw coded('MISTAKE_EVIDENCE_CONFLICT', 'bank evidence item or group is duplicated');
    }
    const evaluation = item.evaluation;
    const source = sourceIdentityOf(evaluation);
    if (item.evaluationId !== item.mistakeId || evaluation.evaluationId !== item.mistakeId
      || item.payloadSha256 !== evaluation.payloadSha256
      || item.origin !== originOf(evaluation)
      || item.spotKey !== evaluation.spotKey || item.handClass !== evaluation.handClass
      || item.spotSignature !== `${evaluation.spotKey}:${evaluation.handClass}`
      || item.evidenceIdentity !== signatureOf(evaluation)
      || !record(item.sourceIdentity)
      || Object.keys(item.sourceIdentity).some((key) => !['id', 'version', 'contentSha256'].includes(key))
      || ['id', 'version', 'contentSha256'].some((key) => item.sourceIdentity[key] !== source[key])) {
      invalid('bank evidence identity or payload binding is inconsistent');
    }
    if (typeof item.skillKey !== 'string' || item.skillKey.length === 0
      || (isPreflopSpotKey(item.spotKey) && item.skillKey !== classifyOpportunity(evaluation).skillKey)) {
      invalid('bank evidence skill binding is inconsistent');
    }
    seenMistakes.add(item.mistakeId);
    seenGroups.add(item.evidenceIdentity);
    if (item.evidenceIds === undefined) {
      item.evidenceIds = [item.mistakeId];
      changed = true;
    }
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0
      || !item.evidenceIds.includes(item.mistakeId)) invalid('bank evidence ids are invalid');
    const itemIds = new Set(item.evidenceIds);
    for (const id of item.evidenceIds) {
      assertId(id);
      if (seenIds.has(id)) throw coded('MISTAKE_EVIDENCE_CONFLICT', 'bank evidence identity is duplicated');
      seenIds.add(id);
    }
    if (item.evidence === undefined) {
      item.evidence = item.evidenceIds.length;
      changed = true;
    }
    if (item.evidence !== item.evidenceIds.length) invalid('bank evidence count is inconsistent');
    if (item.evidenceDigests === undefined) {
      item.evidenceDigests = { [item.mistakeId]: item.payloadSha256 };
      changed = true;
    }
    if (!record(item.evidenceDigests)
      || !Object.hasOwn(item.evidenceDigests, item.mistakeId)
      || item.evidenceDigests[item.mistakeId] !== item.payloadSha256) {
      invalid('bank primary evidence digest binding is invalid');
    }
    for (const [id, digest] of Object.entries(item.evidenceDigests)) {
      if (!itemIds.has(id)) invalid('bank evidence digest has no matching identity');
      assertDigest(digest);
    }
    if (source.id === 'local-preflop-baseline' && source.version === '2.0.0'
      && !referenceAssessmentEligibility(item.evaluation).metricEligible) invalid('v2 bank evidence is not an exact comparison');
    const quality = referenceQuality(source).quality;
    const derived = { referenceQuality: quality, availability: quality === 'heuristic-reference' ? 'available' : 'unverified' };
    for (const [key, value] of Object.entries(derived)) {
      if (item[key] === undefined) {
        item[key] = value;
        changed = true;
      } else if (item[key] !== value) invalid(`bank ${key} contradicts its source evidence`);
    }
    for (const key of ['firstSeenAt', 'lastSeenAt']) {
      if (item[key] !== undefined && !timestamp(item[key])) invalid(`bank ${key} is invalid`);
    }
    if (!Object.hasOwn(data.reviewState, item.mistakeId)) {
      data.reviewState[item.mistakeId] = defaultReviewState(now());
      changed = true;
    }
  }
  for (const [id, review] of Object.entries(data.reviewState)) {
    if (!safeKey(id) || !seenMistakes.has(id)) invalid('bank review state has no matching evidence item');
    assertReviewPatchValues(review);
  }
  return changed;
}

export function createMistakeBank(storeDir, { now = () => new Date().toISOString(), io } = {}) {
  const { readJsonSecure, writeJsonSecure, ensureDir } = requireIo(
    io, ['readJsonSecure', 'writeJsonSecure', 'ensureDir'],
  );
  const root = path.join(storeDir, '.training');
  const file = path.join(root, 'mistakes.json');

  async function withLock(fn) {
    ensureDir(root);
    return withNamedLock(root, 'mistakes.lock.d', fn);
  }

  function emptyData() {
    return {
      schemaVersion: 2,
      items: [],
      reviewState: {},
      meta: { prunedUnlearnable: 0, prunedAt: null },
    };
  }

  function migrateV1(data) {
    assertEnvelope(data, 1);
    const migrated = emptyData();
    migrated.meta = data.meta ?? migrated.meta;
    if (data.reviewState !== undefined) {
      if (!record(data.reviewState)) invalid('legacy bank review state is invalid');
      migrated.reviewState = data.reviewState;
    }
    for (const item of data.items) {
      const evidence = evidenceFromLegacy(item);
      migrated.items.push(evidence);
      if (Object.hasOwn(migrated.reviewState, evidence.mistakeId)) {
        for (const key of REVIEW_FIELDS) {
          if (Object.hasOwn(item, key) && item[key] !== migrated.reviewState[evidence.mistakeId]?.[key]) {
            invalid('legacy review state is inconsistent');
          }
        }
      } else {
        migrated.reviewState[evidence.mistakeId] = reviewFromLegacy(item, now());
      }
    }
    return migrated;
  }

  function load() {
    let data;
    try {
      data = readJsonSecure(file);
    } catch (error) {
      if (error.code === 'ENOENT') return { data: emptyData(), changed: false };
      throw error;
    }
    const migratedFromV1 = data?.schemaVersion === 1;
    if (migratedFromV1) data = migrateV1(data);
    // No repair, prune, or migration is committed until every item and every
    // map edge has been checked, including rows that Q4 will subsequently prune.
    let changed = validateGraph(data, now) || migratedFromV1;
    const kept = data.items.filter(learnableEvidence);
    const pruned = data.items.length - kept.length;
    if (pruned > 0) {
      const keptIds = new Set(kept.map((item) => item.mistakeId));
      for (const id of Object.keys(data.reviewState)) if (!keptIds.has(id)) delete data.reviewState[id];
      data.items = kept;
      const prior = statsOf(data).prunedUnlearnable;
      data.meta = { ...data.meta, prunedUnlearnable: prior + pruned, prunedAt: now() };
      changed = true;
    }
    return { data, changed };
  }

  function save(data) {
    validateGraph(data, now);
    writeJsonSecure(file, data);
  }

  function loadForRead() {
    const { data, changed } = load();
    if (changed) save(data);
    return data;
  }

  async function collect(evaluation) {
    return withLock(() => {
      const { data, changed } = load();
      if (!collectable(evaluation)) {
        if (changed) save(data);
        return { added: false, item: null };
      }
      assertEvaluation(evaluation);
      const identity = signatureOf(evaluation);
      const existingId = data.items.find((item) => item.evidenceIds.includes(evaluation.evaluationId));
      if (existingId) {
        const knownDigest = existingId.evidenceDigests?.[evaluation.evaluationId];
        if ((knownDigest && knownDigest !== evaluation.payloadSha256)
          || existingId.evidenceIdentity !== identity) {
          throw coded('MISTAKE_EVIDENCE_CONFLICT', 'same evaluationId has different evidence');
        }
        if (changed) save(data);
        return { added: false, item: compose(existingId, data.reviewState[existingId.mistakeId]) };
      }
      const sameEvidence = data.items.find((item) => item.evidenceIdentity === identity);
      if (sameEvidence) {
        sameEvidence.evidenceIds.push(evaluation.evaluationId);
        sameEvidence.evidenceDigests[evaluation.evaluationId] = evaluation.payloadSha256;
        sameEvidence.evidence = sameEvidence.evidenceIds.length;
        sameEvidence.lastSeenAt = now();
        save(data);
        return { added: false, item: compose(sameEvidence, data.reviewState[sameEvidence.mistakeId]) };
      }
      const sourceIdentity = sourceIdentityOf(evaluation);
      const item = {
        mistakeId: evaluation.evaluationId,
        evaluationId: evaluation.evaluationId,
        payloadSha256: evaluation.payloadSha256,
        evidenceIds: [evaluation.evaluationId],
        evidenceDigests: { [evaluation.evaluationId]: evaluation.payloadSha256 },
        evidence: 1,
        origin: originOf(evaluation),
        sourceIdentity,
        referenceQuality: 'heuristic-reference',
        availability: 'available',
        spotKey: evaluation.spotKey,
        handClass: evaluation.handClass,
        spotSignature: `${evaluation.spotKey}:${evaluation.handClass}`,
        evidenceIdentity: identity,
        skillKey: classifyOpportunity(evaluation).skillKey,
        evaluation,
        firstSeenAt: now(),
        lastSeenAt: now(),
      };
      data.items.push(item);
      data.reviewState[item.mistakeId] = defaultReviewState(now());
      save(data);
      return { added: true, item: compose(item, data.reviewState[item.mistakeId]) };
    });
  }

  async function listEvidence({ origin } = {}) {
    return withLock(() => loadForRead().items
      .filter((item) => origin === undefined || item.origin === origin)
      .map((item) => cloneEvidence(item)));
  }

  function cloneEvidence(item) {
    return JSON.parse(JSON.stringify(item));
  }

  async function list() {
    return withLock(() => {
      const data = loadForRead();
      return data.items
        .filter((item) => collectable(item.evaluation))
        .map((item) => compose(cloneEvidence(item), data.reviewState[item.mistakeId]));
    });
  }

  async function stats() {
    return withLock(() => statsOf(loadForRead()));
  }

  function assertReviewPatch(patch) {
    assertReviewPatchValues(patch);
  }

  async function updateReviewState(mistakeId, patch) {
    return withLock(() => {
      assertReviewPatch(patch);
      const { data, changed } = load();
      const item = data.items.find((row) => row.mistakeId === mistakeId);
      if (!item) {
        if (changed) save(data);
        return null;
      }
      data.reviewState[mistakeId] = { ...data.reviewState[mistakeId], ...patch };
      save(data);
      return compose(cloneEvidence(item), data.reviewState[mistakeId]);
    });
  }

  async function update(mistakeId, patch) {
    return updateReviewState(mistakeId, patch);
  }

  async function migrateDigests({ oldToNew = {}, byEvaluationId = {} } = {}) {
    return withLock(() => {
      const { data, changed: loadedChange } = load();
      let changed = false;
      for (const item of data.items) {
        for (const [evaluationId, current] of Object.entries(item.evidenceDigests ?? {})) {
          const mapped = byEvaluationId[evaluationId]?.new ?? oldToNew[current] ?? current;
          if (mapped === current) continue;
          item.evidenceDigests[evaluationId] = mapped;
          if (evaluationId === item.mistakeId) {
            item.payloadSha256 = mapped;
            if (item.evaluation) item.evaluation.payloadSha256 = mapped;
          }
          changed = true;
        }
      }
      if (changed || loadedChange) save(data);
      return { changed };
    });
  }

  return { collect, listEvidence, list, stats, updateReviewState, update, migrateDigests, file };
}
