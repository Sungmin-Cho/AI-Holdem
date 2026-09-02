import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import { skillKeyOf } from './opportunities.js';
import { readJsonSecure, writeJsonSecure, ensureDir } from '../tools/training-store.js';

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function collectable(evaluation) {
  if (evaluation.forced) return false;
  if (evaluation.status !== 'supported') return false;
  return evaluation.grade === 'off-policy' || evaluation.grade === 'low-frequency';
}

function signatureOf(evaluation) {
  return `${evaluation.spotKey}:${evaluation.handClass}`;
}

export function createMistakeBank(storeDir, { now = () => new Date().toISOString() } = {}) {
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
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, items: [] };
      throw error;
    }
  }

  async function collect(evaluation) {
    return withLock(() => {
      const data = load();
      if (!collectable(evaluation)) return { added: false, item: null };
      const existingId = data.items.find((item) => item.mistakeId === evaluation.evaluationId);
      if (existingId) {
        existingId.evidenceIds = existingId.evidenceIds ?? [existingId.mistakeId];
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
        skillKey: skillKeyOf(evaluation),
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

  return { collect, list, update, file };
}
