import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import { classifyOpportunity, isPreflopSpotKey } from './opportunities.js';

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

function collectable(evaluation) {
  if (!classifyOpportunity(evaluation).learnable) return false;
  if (evaluation.forced) return false;
  if (evaluation.status !== 'supported') return false;
  return evaluation.grade === 'off-policy' || evaluation.grade === 'low-frequency';
}

function signatureOf(evaluation) {
  return `${evaluation.spotKey}:${evaluation.handClass}`;
}

function learnableSignature(item) {
  const [spotKey] = String(item?.spotSignature ?? '').split(':');
  return isPreflopSpotKey(spotKey);
}

function statsOf(data) {
  return {
    prunedUnlearnable: Number.isSafeInteger(data.meta?.prunedUnlearnable)
      && data.meta.prunedUnlearnable >= 0
      ? data.meta.prunedUnlearnable
      : 0,
    prunedAt: typeof data.meta?.prunedAt === 'string' ? data.meta.prunedAt : null,
  };
}

// R12: fs helper는 주입받는다. 기본값은 없다 — 기본값이 있으면 training이
// 다시 tools를 import하게 되고, 그것이 결함 #20의 역전 그 자체다.
export function createMistakeBank(storeDir, { now = () => new Date().toISOString(), io } = {}) {
  const { readJsonSecure, writeJsonSecure, ensureDir } = requireIo(io, ['readJsonSecure', 'writeJsonSecure', 'ensureDir']);
  const root = path.join(storeDir, '.training');
  const file = path.join(root, 'mistakes.json');

  async function withLock(fn) {
    ensureDir(root);
    return withNamedLock(root, 'mistakes.lock.d', fn);
  }

  function load() {
    try {
      const data = readJsonSecure(file);
      if (data.schemaVersion !== 1) throw coded('UNSUPPORTED_MISTAKES', `schema ${data.schemaVersion}`);
      const items = Array.isArray(data.items) ? data.items : [];
      const kept = items.filter(learnableSignature);
      const pruned = items.length - kept.length;
      if (pruned > 0) {
        const prior = statsOf(data).prunedUnlearnable;
        data.items = kept;
        data.meta = {
          ...(data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta)
            ? data.meta
            : {}),
          prunedUnlearnable: prior + pruned,
          prunedAt: now(),
        };
        writeJsonSecure(file, data);
      }
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          schemaVersion: 1,
          items: [],
          meta: { prunedUnlearnable: 0, prunedAt: null },
        };
      }
      throw error;
    }
  }

  async function collect(evaluation) {
    return withLock(() => {
      const data = load();
      if (!collectable(evaluation)) return { added: false, item: null };
      const existingId = data.items.find((item) => item.mistakeId === evaluation.evaluationId);
      if (existingId) {
        if (!Object.prototype.hasOwnProperty.call(existingId, 'evidenceIds')) {
          existingId.evidenceIds = [existingId.mistakeId];
          writeJsonSecure(file, data);
        }
        return { added: false, item: existingId };
      }
      const sig = signatureOf(evaluation);
      const sameSpot = data.items.find((item) => item.spotSignature === sig);
      if (sameSpot) {
        sameSpot.evidenceIds = sameSpot.evidenceIds ?? [sameSpot.mistakeId];
        if (sameSpot.evidenceIds.includes(evaluation.evaluationId)) {
          return { added: false, item: sameSpot };
        }
        sameSpot.evidenceIds.push(evaluation.evaluationId);
        sameSpot.evidence = sameSpot.evidenceIds.length;
        sameSpot.lastSeenAt = now();
        writeJsonSecure(file, data);
        return { added: false, item: sameSpot };
      }
      const item = {
        schemaVersion: 1,
        mistakeId: evaluation.evaluationId,
        spotSignature: sig,
        skillKey: classifyOpportunity(evaluation).skillKey,
        evaluation,
        firstSeenAt: now(),
        lastReviewedAt: null,
        nextReviewAt: now(),
        intervalDays: 1,
        ease: 2.3,
        attempts: 0,
        correctStreak: 0,
        lapses: 0,
        evidence: 1,
        evidenceIds: [evaluation.evaluationId],
      };
      data.items.push(item);
      writeJsonSecure(file, data);
      return { added: true, item };
    });
  }

  async function list() {
    return withLock(() => load().items);
  }

  async function stats() {
    return withLock(() => statsOf(load()));
  }

  async function update(mistakeId, patch) {
    return withLock(() => {
      const data = load();
      const item = data.items.find((row) => row.mistakeId === mistakeId);
      if (!item) return null;
      Object.assign(item, patch);
      writeJsonSecure(file, data);
      return item;
    });
  }

  async function migrateDigests({ oldToNew = {}, byEvaluationId = {} } = {}) {
    return withLock(() => {
      const data = load();
      let changed = false;
      for (const item of data.items ?? []) {
        const evaluation = item.evaluation;
        if (!evaluation) continue;
        const current = evaluation.payloadSha256;
        const mapped = byEvaluationId[item.mistakeId]?.new
          ?? oldToNew[current]
          ?? current;
        if (mapped === current) continue;
        evaluation.payloadSha256 = mapped;
        changed = true;
      }
      if (changed) writeJsonSecure(file, data);
      return { changed };
    });
  }

  return {
    collect, list, stats, update, migrateDigests, file,
  };
}
