import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrainingControl } from './training-control.js';
import { validateExplanation } from '../training/explain.js';
import { readJsonl, writeJsonSecure } from './training-store.js';
import { gameEpochOf } from '../publish-contract.js';

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/cli.js');

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
  const rows = readJsonl(path.join(sessionDir, 'training', 'evaluations.jsonl'));
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
  const explanations = {};
  if (typeof explain === 'function') {
    for (const evaluation of evaluated.evaluations ?? []) {
      try {
        const text = await explain(evaluation);
        const check = validateExplanation({ ...evaluation, handNo }, text);
        if (check.ok) explanations[evaluation.evaluationId] = text;
      } catch {
        /* explanation is optional; machine eval still ships */
      }
    }
  }
  const tc = createTrainingControl();
  await tc.acceptEvaluations(sessionDir, {
    gameEpoch,
    owner,
    handNo,
    evaluations: evaluated.evaluations ?? [],
    explanations,
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
    evaluate: evaluate ?? (async ({ handNo }) => {
      const result = await evaluateCli(sessionDir, handNo);
      return result.ok ? (result.evaluations ?? []) : [];
    }),
  });
}

export function unpublishedEnvelope(sessionDir, { gameEpoch } = {}) {
  const tc = createTrainingControl();
  const auth = tc.loadAuthority(sessionDir);
  if (!auth) return null;
  const rows = readJsonl(path.join(sessionDir, 'training', 'evaluations.jsonl'));
  const unpublished = rows.filter((row) => auth.items[row.evaluationId]?.status !== 'published');
  if (unpublished.length === 0) return null;
  const first = unpublished[0];
  const queued = auth.publishQueue[first.evaluationId];
  const envelope = {
    training: unpublished,
  };
  if (queued) {
    envelope.trainingAuthority = {
      expectedGameEpoch: gameEpoch ?? auth.gameEpoch,
      evaluationId: first.evaluationId,
      payloadSha256: queued.payloadSha256,
    };
  }
  return envelope;
}

export function writeTrainingEnvelope(sessionDir, envelope) {
  const file = path.join(sessionDir, 'training', '.publish-envelope.json');
  writeJsonSecure(file, envelope);
  return file;
}

export { gameEpochOf };
