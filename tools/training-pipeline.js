import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrainingControl, readAnnotationExactFile } from './training-control.js';
import { validateExplanation } from '../training/explain.js';
import { writeJsonSecure } from './training-store.js';
import {
  annotationBodyByteLength,
  gameEpochOf,
  MAX_PUBLISH_BODY_BYTES,
  MAX_PUBLISH_ID,
  projectTrainingAnnotation,
  publicProofId,
  trainingBodyByteLength,
  TRAINING_CHUNK_SLACK_BYTES,
} from '../publish-contract.js';

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/cli.js');
const BODY_BUDGET = MAX_PUBLISH_BODY_BYTES - TRAINING_CHUNK_SLACK_BYTES;

export function isTrainingEnabled(opts = {}) {
  return opts.trainingEnabled === true || opts.storeDir !== undefined;
}

async function evaluateCli(sessionDir, handNo) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      CLI, 'evaluate', '--game-dir', sessionDir, '--hand', String(handNo),
    ], { encoding: 'utf8', timeout: 15_000 });
    return JSON.parse(stdout.trim());
  } catch (error) {
    let parsed = null;
    try { parsed = JSON.parse(String(error.stdout ?? '').trim()); } catch { /* not json */ }
    return {
      ok: false,
      code: parsed?.code ?? error.code ?? 'EVALUATE_FAILED',
      message: parsed?.message ?? error.message,
    };
  }
}

export function trainingAggregate(sessionDir) {
  const tc = createTrainingControl();
  const auth = tc.loadAuthority(sessionDir);
  const rows = Object.values(auth?.items ?? {}).map((item) => item.summary).filter(Boolean);
  const supported = rows.filter((row) => row.status === 'supported');
  const offPolicy = supported.filter((row) => row.grade === 'off-policy').length;
  return {
    total: rows.length,
    supported: supported.length,
    unsupported: rows.length - supported.length,
    offPolicy,
    supportedRate: rows.length ? supported.length / rows.length : 0,
  };
}

export async function ingestHand({
  sessionDir, handNo, gameEpoch, owner, explain,
}) {
  const evaluated = await evaluateCli(sessionDir, handNo);
  if (!evaluated?.ok) {
    return { ok: false, code: evaluated?.code ?? 'EVALUATE_FAILED', evaluations: [] };
  }
  if (typeof explain === 'function') {
    for (const evaluation of evaluated.evaluations ?? []) {
      try {
        const text = await explain(evaluation);
        validateExplanation({ ...evaluation, handNo }, text);
      } catch {
        /* explanation is sealed in P0-2; machine eval still ships */
      }
    }
  }
  const tc = createTrainingControl();
  await tc.acceptEvaluations(sessionDir, {
    gameEpoch,
    owner,
    handNo,
    evaluations: evaluated.evaluations ?? [],
  });
  return { ok: true, evaluations: evaluated.evaluations ?? [] };
}

export async function reconcileSession({
  sessionDir, gameEpoch, owner, lastHand, evaluate,
}) {
  const tc = createTrainingControl();
  return tc.reconcile(sessionDir, {
    gameEpoch,
    owner,
    lastHand,
    handsDir: path.join(sessionDir, 'hands'),
    evaluate,
  });
}

export function unpublishedEnvelope(sessionDir, { gameEpoch } = {}) {
  const tc = createTrainingControl();
  const auth = tc.loadAuthority(sessionDir);
  if (!auth) return null;
  const unpublished = Object.values(auth.items)
    .filter((item) => item.status !== 'published' && auth.publishQueue[item.evaluationId] && item.summary)
    .sort((left, right) => (left.handNo ?? 0) - (right.handNo ?? 0)
      || String(left.evaluationId).localeCompare(String(right.evaluationId)));
  if (unpublished.length === 0) return null;
  const chunk = [];
  for (const item of unpublished) {
    const next = [...chunk, item];
    const training = next.map((row) => row.summary);
    const trainingAuthority = {
      expectedGameEpoch: gameEpoch ?? auth.gameEpoch,
      items: next.map((row) => ({
        evaluationId: row.evaluationId,
        payloadSha256: row.payloadSha256,
      })),
    };
    const bytes = trainingBodyByteLength({
      publishId: MAX_PUBLISH_ID,
      training,
      trainingAuthority,
    });
    if (bytes > BODY_BUDGET) {
      if (chunk.length === 0) chunk.push(item);
      break;
    }
    chunk.push(item);
  }
  if (chunk.length === 0) return null;
  return {
    training: chunk.map((row) => row.summary),
    trainingAuthority: {
      expectedGameEpoch: gameEpoch ?? auth.gameEpoch,
      items: chunk.map((row) => ({
        evaluationId: row.evaluationId,
        payloadSha256: row.payloadSha256,
      })),
    },
  };
}

export function annotationEnvelope(sessionDir, { gameEpoch } = {}) {
  const tc = createTrainingControl();
  const auth = tc.loadAuthority(sessionDir);
  if (!auth) return null;
  const entries = [];
  for (const [evaluationId, fields] of Object.entries(auth.annotationQueue ?? {})) {
    const item = auth.items[evaluationId];
    if (!item) continue;
    for (const [field, queued] of Object.entries(fields ?? {})) {
      if (queued?.published) continue;
      let canonical;
      try {
        canonical = readAnnotationExactFile(sessionDir, item.detailRef, field);
      } catch {
        continue;
      }
      const projected = projectTrainingAnnotation({
        evaluationId,
        payloadSha256: item.payloadSha256,
        field,
        status: canonical.status,
        value: canonical.value,
      });
      entries.push({
        ...projected,
        annotationProof: {
          id: publicProofId(`${evaluationId}:${field}`),
          valueSha256: projected.valueSha256,
        },
      });
    }
  }
  if (entries.length === 0) return null;
  const chunk = [];
  for (const entry of entries) {
    const next = [...chunk, entry];
    const annotationAuthority = {
      expectedGameEpoch: gameEpoch ?? auth.gameEpoch,
      items: next.map((row) => ({
        evaluationId: row.evaluationId,
        field: row.field,
        valueSha256: row.valueSha256,
      })),
    };
    const bytes = annotationBodyByteLength({
      publishId: MAX_PUBLISH_ID,
      trainingAnnotations: next,
      annotationAuthority,
    });
    if (bytes > BODY_BUDGET) {
      if (chunk.length === 0) chunk.push(entry);
      break;
    }
    chunk.push(entry);
  }
  if (chunk.length === 0) return null;
  return {
    trainingAnnotations: chunk,
    annotationAuthority: {
      expectedGameEpoch: gameEpoch ?? auth.gameEpoch,
      items: chunk.map((row) => ({
        evaluationId: row.evaluationId,
        field: row.field,
        valueSha256: row.valueSha256,
      })),
    },
  };
}

export function writeTrainingEnvelope(sessionDir, envelope) {
  const file = path.join(sessionDir, 'training', '.publish-envelope.json');
  writeJsonSecure(file, envelope);
  return file;
}

export { gameEpochOf };
