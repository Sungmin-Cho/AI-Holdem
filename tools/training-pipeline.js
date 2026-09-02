import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTrainingControl,
  hasCutoffMarker,
  readAnnotationExactFile,
} from './training-control.js';
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

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/cli.js');
const BODY_BUDGET = MAX_PUBLISH_BODY_BYTES - TRAINING_CHUNK_SLACK_BYTES;

export function isTrainingEnabled(opts = {}) {
  return opts.trainingEnabled === true || opts.storeDir !== undefined;
}

function waitChild(child, ms) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function toRunnerHandle(out) {
  if (out && typeof out.promise?.then === 'function' && typeof out.terminate === 'function') {
    return out;
  }
  if (out && typeof out.then === 'function') {
    return { promise: out, terminate: async () => ({ confirmed: true }) };
  }
  return { promise: Promise.resolve(out), terminate: async () => ({ confirmed: true }) };
}

export function defaultEvaluate(sessionDir, handNo) {
  let child = null;
  let settled = false;
  const promise = new Promise((resolve) => {
    child = execFile(process.execPath, [
      CLI, 'evaluate', '--game-dir', sessionDir, '--hand', String(handNo),
    ], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      settled = true;
      let parsed = null;
      try { parsed = JSON.parse(String(stdout ?? '').trim()); } catch { /* not json */ }
      if (!parsed && error) {
        try { parsed = JSON.parse(String(error.stdout ?? '').trim()); } catch { /* not json */ }
      }
      if (parsed?.ok) {
        resolve(parsed);
        return;
      }
      resolve({
        ok: false,
        code: parsed?.code ?? error?.code ?? 'EVALUATE_FAILED',
        message: parsed?.message ?? error?.message,
      });
    });
  });
  return {
    promise,
    async terminate() {
      if (settled || !child) return { confirmed: true };
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const confirmed = await waitChild(child, 400);
      if (!confirmed) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      return { confirmed: await waitChild(child, 400) };
    },
  };
}

export function buildExplanationPrompt(evaluation) {
  return [
    '역할: 학습 해설',
    'JSON 한 줄만 출력하라: {"evaluationId":"...","explanation":"..."}',
    'evaluator 수치를 바꾸지 마라. 새 숫자를 만들지 마라.',
    '허용 숫자 형태만 사용하라:',
    '1) 빈도: <action> <n>% 또는 <n>% <action> 또는 소수 0.nn — n은 그 action의 frequency와 결박 (영·한 별칭: raise|레이즈|오픈|3벳|3-bet|리레이즈, fold|폴드, call|콜, check|체크)',
    '2) 사이즈: <n>bb / <n> bb / <n>BB — 어떤 sizeBb와 ±0.05. EV|손실|loss|이득이 같은 절에 있으면 금지',
    '3) 핸드 번호: <handNo>',
    evaluation?.status !== 'supported'
      ? 'unsupported를 정답처럼 설명하지 마라. 핸드 번호 외 숫자를 쓰지 마라.'
      : '',
    JSON.stringify({
      evaluationId: evaluation?.evaluationId,
      status: evaluation?.status,
      grade: evaluation?.grade,
      handNo: evaluation?.handNo,
      chosen: evaluation?.chosen,
      recommended: evaluation?.recommended,
      code: evaluation?.code,
      reason: evaluation?.reason,
    }),
  ].filter(Boolean).join('\n');
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
    pending: Object.keys(auth?.pending ?? {}).length,
    supportedRate: rows.length ? supported.length / rows.length : 0,
  };
}

function loadHandRecord(sessionDir, handNo) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    if (state.lastHand?.handNo === handNo) return state.lastHand;
  } catch { /* fall through to archive */ }
  const file = path.join(sessionDir, 'hands', `hand-${String(handNo).padStart(4, '0')}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function userDecisionsOf(record) {
  if (!record || !Array.isArray(record.decisions)) return [];
  return record.decisions.filter((snap) => snap.actorId === 'user');
}

async function recordEvaluateFailure(tc, sessionDir, {
  handNo, gameEpoch, owner, code,
}) {
  const snaps = userDecisionsOf(loadHandRecord(sessionDir, handNo));
  const ids = snaps.length ? snaps.map((snap) => snap.decisionId) : [`hand-${handNo}`];
  for (const decisionId of ids) {
    await tc.recordPending(sessionDir, decisionId, {
      handNo,
      reason: code ?? 'EVALUATE_FAILED',
      gameEpoch,
      owner,
    });
  }
}

export async function runHandPipeline({
  sessionDir, handNo, gameEpoch, owner, storeDir,
  evaluate, explain, publish, consume,
}) {
  const tc = createTrainingControl({ storeDir });
  const evalHandle = typeof evaluate === 'function'
    ? toRunnerHandle(evaluate(sessionDir, handNo))
    : defaultEvaluate(sessionDir, handNo);
  let evaluated;
  try {
    evaluated = await evalHandle.promise;
  } catch (error) {
    evaluated = { ok: false, code: error.code ?? 'EVALUATE_FAILED', message: error.message };
  }
  if (!evaluated?.ok) {
    const code = evaluated?.code ?? 'EVALUATE_FAILED';
    await recordEvaluateFailure(tc, sessionDir, {
      handNo, gameEpoch, owner, code,
    });
    return {
      ok: false, code, evaluations: [], handle: evalHandle,
    };
  }

  const accepted = await tc.acceptEvaluations(sessionDir, {
    gameEpoch,
    owner,
    handNo,
    evaluations: evaluated.evaluations ?? [],
  });
  if (typeof consume === 'function') {
    try { await consume(); } catch { /* consumers retry independently */ }
  }
  if (typeof publish === 'function') await publish('machine');

  for (const item of accepted.accepted ?? []) {
    if (hasCutoffMarker(sessionDir)) {
      await tc.sealAnnotation(sessionDir, item.evaluationId, 'explanation', 'unavailable');
      continue;
    }
    const existing = item.annotations?.explanation
      ?? tc.loadAuthority(sessionDir)?.items?.[item.evaluationId]?.annotations?.explanation;
    if (existing?.status === 'ready' || existing?.status === 'unavailable') continue;
    let sealedExisting = null;
    try {
      sealedExisting = readAnnotationExactFile(sessionDir, item.detailRef, 'explanation');
    } catch { /* first attempt */ }
    if (sealedExisting) {
      await tc.sealAnnotation(
        sessionDir,
        item.evaluationId,
        'explanation',
        sealedExisting.status === 'unavailable' ? 'unavailable' : sealedExisting.value,
      );
      continue;
    }
    const evaluation = {
      ...((evaluated.evaluations ?? []).find((row) => row.evaluationId === item.evaluationId) ?? item.summary),
      handNo,
      evaluationId: item.evaluationId,
    };
    if (typeof explain !== 'function') continue;
    const explainHandle = toRunnerHandle(explain(evaluation));
    let text = null;
    try {
      text = await explainHandle.promise;
    } catch { text = null; }
    if (hasCutoffMarker(sessionDir)) {
      await tc.sealAnnotation(sessionDir, item.evaluationId, 'explanation', 'unavailable');
      continue;
    }
    if (typeof text !== 'string' || !text.trim()) continue;
    const check = validateExplanation(evaluation, text);
    if (!check.ok) continue;
    await tc.sealAnnotation(sessionDir, item.evaluationId, 'explanation', text);
  }

  if (typeof publish === 'function') await publish('annotation');
  return {
    ok: true,
    evaluations: evaluated.evaluations ?? [],
    accepted: accepted.accepted,
    handle: evalHandle,
  };
}

export async function ingestHand({
  sessionDir, handNo, gameEpoch, owner, explain, evaluate,
}) {
  return runHandPipeline({
    sessionDir, handNo, gameEpoch, owner, explain, evaluate,
  });
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

async function publishSideEnvelope(executePublish, file) {
  try {
    return await executePublish(['--from', file]);
  } catch (error) {
    if (error.code !== 'ATTEMPT_PENDING' && error.code !== 'LOCK_TIMEOUT') throw error;
    if (error.code === 'ATTEMPT_PENDING') {
      try {
        await executePublish(['--from', file, '--retry']);
      } catch (retryError) {
        if (retryError.code !== 'NO_ATTEMPT') throw retryError;
      }
    }
    return executePublish(['--from', file]);
  }
}

export async function flushMachinePublish(sessionDir, {
  gameEpoch, executePublish, storeDir, shouldStop,
}) {
  const tc = createTrainingControl({ storeDir });
  for (;;) {
    if (shouldStop?.()) return;
    const envelope = unpublishedEnvelope(sessionDir, { gameEpoch });
    if (!envelope) return;
    const file = writeTrainingEnvelope(sessionDir, envelope);
    await publishSideEnvelope(executePublish, file);
    for (const item of envelope.training) {
      try {
        await tc.markPublished(sessionDir, item.evaluationId, item.payloadSha256);
      } catch { /* already marked or conflict is logged by caller */ }
    }
  }
}

export async function flushAnnotationPublish(sessionDir, {
  gameEpoch, executePublish, storeDir, shouldStop,
}) {
  const tc = createTrainingControl({ storeDir });
  for (;;) {
    if (shouldStop?.()) return;
    const envelope = annotationEnvelope(sessionDir, { gameEpoch });
    if (!envelope) return;
    const file = writeTrainingEnvelope(sessionDir, envelope);
    await publishSideEnvelope(executePublish, file);
    for (const item of envelope.trainingAnnotations) {
      try {
        await tc.markAnnotationPublished(sessionDir, item.evaluationId, item.field, item.valueSha256);
      } catch { /* already marked or conflict is logged by caller */ }
    }
  }
}

export async function retryUnresolvedTrainingAttempt(sessionDir, { executePublish, storeDir }) {
  const attemptFile = path.join(sessionDir, '.publish-attempt.json');
  if (!fs.existsSync(attemptFile)) return;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
  } catch {
    return;
  }
  const isTraining = Boolean(record.trainingAuthority || record.annotationAuthority
    || record.body?.training || record.body?.trainingAnnotations);
  if (!isTraining) return;
  const envelope = record.body?.training
    ? { training: record.body.training, trainingAuthority: record.trainingAuthority }
    : {
      trainingAnnotations: record.body.trainingAnnotations,
      annotationAuthority: record.annotationAuthority,
    };
  const file = writeTrainingEnvelope(sessionDir, envelope);
  await executePublish(['--from', file, '--retry']);
  const tc = createTrainingControl({ storeDir });
  for (const item of record.body?.training ?? []) {
    try { await tc.markPublished(sessionDir, item.evaluationId, item.payloadSha256); } catch { /* already marked */ }
  }
  for (const item of record.body?.trainingAnnotations ?? []) {
    try {
      await tc.markAnnotationPublished(sessionDir, item.evaluationId, item.field, item.valueSha256);
    } catch { /* already marked */ }
  }
}

export { gameEpochOf };
