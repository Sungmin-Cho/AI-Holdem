import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTrainingControl,
  hasExplanationCutoff,
  readAnnotationExactFile,
} from './training-control.js';
import { validateExplanation } from '../training/explain.js';
import { evaluateExploit } from '../training/exploit/evaluator.js';
import { ensureDir, writeContained } from './training-store.js';
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
const SOLVE_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'solve-cli.js');
const BODY_BUDGET = MAX_PUBLISH_BODY_BYTES - TRAINING_CHUNK_SLACK_BYTES;
const handPipelineTail = new Map();
const explainTail = new Map();
const solveTail = new Map();

function withExplainLock(sessionDir, work) {
  const key = path.resolve(sessionDir);
  const prev = explainTail.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(work);
  explainTail.set(key, run.then(() => {}, () => {}));
  return run;
}

// solver-runtime은 세션당 하나의 자식만 허용한다(`.solver-child.json`). 한 핸드에
// postflop 결정이 둘 이상이면 solve를 나란히 띄우는 순간 뒤엣것이 스스로
// SOLVER_BUSY를 맞고 pending으로 되돌아간다 — 자기가 만든 경합이다. 세션별로
// 직렬화한다.
function withSolveLock(sessionDir, work) {
  const key = path.resolve(sessionDir);
  const prev = solveTail.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(work);
  solveTail.set(key, run.then(() => {}, () => {}));
  return run;
}

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

function cliRunner(argv, { timeoutMs, failCode }) {
  let child = null;
  let settled = false;
  const promise = new Promise((resolve) => {
    child = execFile(process.execPath, argv, {
      encoding: 'utf8',
      timeout: timeoutMs,
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
        code: parsed?.code ?? error?.code ?? failCode,
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

export function defaultEvaluate(sessionDir, handNo, { solverAdapterId = null } = {}) {
  const argv = [CLI, 'evaluate', '--game-dir', sessionDir, '--hand', String(handNo)];
  if (solverAdapterId) argv.push('--solver', solverAdapterId);
  return cliRunner(argv, { timeoutMs: 15_000, failCode: 'EVALUATE_FAILED' });
}

export function defaultSolve({ sessionDir, decisionId, handNo, adapterId }) {
  return cliRunner([
    SOLVE_CLI,
    '--game-dir', sessionDir,
    '--hand', String(handNo),
    '--decision', decisionId,
    '--adapter', adapterId,
  ], { timeoutMs: 20_000, failCode: 'SOLVE_FAILED' });
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
  handNo, gameEpoch, owner, code, decisionIds, skip,
}) {
  const snaps = userDecisionsOf(loadHandRecord(sessionDir, handNo));
  const fallback = snaps.length ? snaps.map((snap) => snap.decisionId) : [`hand-${handNo}`];
  const ids = (decisionIds?.length ? decisionIds : fallback)
    // solve로 미뤄진 결정에 evaluate 실패 사유를 덮어쓰지 않는다 — 그 pending은
    // solver가 소유한다.
    .filter((decisionId) => !skip?.has(decisionId));
  for (const decisionId of ids) {
    await tc.recordPending(sessionDir, decisionId, {
      handNo,
      reason: code ?? 'EVALUATE_FAILED',
      gameEpoch,
      owner,
    });
  }
}

function loadEvaluationDetail(sessionDir, item) {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(sessionDir, 'training', 'details', `${item.detailRef}.json`),
      'utf8',
    ));
  } catch {
    return { ...item.summary, evaluationId: item.evaluationId, handNo: item.handNo };
  }
}

function itemsCoveringHand(tc, sessionDir, handNo) {
  const auth = tc.loadAuthority(sessionDir);
  if (!auth) return [];
  return Object.values(auth.items).filter((item) => item.handNo === handNo);
}

function uncoveredDecisionIds(tc, sessionDir, handNo, existing) {
  const coveredIds = new Set(existing.map((item) => item.decisionId));
  const snaps = userDecisionsOf(loadHandRecord(sessionDir, handNo));
  const missing = snaps
    .map((snap) => snap.decisionId)
    .filter((id) => !coveredIds.has(id));
  const auth = tc.loadAuthority(sessionDir);
  for (const [decisionId, entry] of Object.entries(auth?.pending ?? {})) {
    if (Number(entry?.handNo) !== Number(handNo)) continue;
    if (coveredIds.has(decisionId)) continue;
    if (!missing.includes(decisionId)) missing.push(decisionId);
  }
  return missing;
}

function solvePendingIds(tc, sessionDir) {
  const auth = tc.loadAuthority(sessionDir);
  const ids = new Set();
  for (const [decisionId, entry] of Object.entries(auth?.pending ?? {})) {
    if (typeof entry?.adapterId === 'string') ids.add(decisionId);
  }
  return ids;
}

async function runHandPipelineUnlocked({
  sessionDir, handNo, gameEpoch, owner, storeDir,
  evaluate, explain, publish, consume, solverAdapterId, startSolve,
}) {
  const tc = createTrainingControl({ storeDir });
  const existing = itemsCoveringHand(tc, sessionDir, handNo);
  // 이미 solve로 미뤄진 결정은 evaluate 경로에서 완전히 빠진다. 여기서 빼지
  // 않으면 `--solver` 없는 resume이 unsupported item을 먼저 만들어 solve 결과
  // accept가 EVALUATION_CONFLICT가 된다.
  const deferred = solvePendingIds(tc, sessionDir);
  const missingIds = uncoveredDecisionIds(tc, sessionDir, handNo, existing)
    .filter((id) => !deferred.has(id));
  const skipEvaluate = existing.length > 0 && missingIds.length === 0;
  let acceptedItems = existing;
  let evaluations = existing.map((item) => loadEvaluationDetail(sessionDir, item));
  let evalHandle = {
    promise: Promise.resolve(null),
    terminate: async () => ({ confirmed: true }),
  };
  if (!skipEvaluate) {
    evalHandle = typeof evaluate === 'function'
      ? toRunnerHandle(evaluate(sessionDir, handNo, { solverAdapterId }))
      : defaultEvaluate(sessionDir, handNo, { solverAdapterId });
    let evaluated;
    try {
      evaluated = await evalHandle.promise;
    } catch (error) {
      evaluated = { ok: false, code: error.code ?? 'EVALUATE_FAILED', message: error.message };
    }
    if (!evaluated?.ok) {
      const code = evaluated?.code ?? 'EVALUATE_FAILED';
      await recordEvaluateFailure(tc, sessionDir, {
        handNo, gameEpoch, owner, code, decisionIds: missingIds, skip: deferred,
      });
      return {
        ok: false, code, evaluations: [], handle: evalHandle,
      };
    }
    for (const decisionId of evaluated.pendingSolve ?? []) {
      await tc.recordPending(sessionDir, decisionId, {
        handNo,
        reason: 'solve',
        adapterId: solverAdapterId,
        gameEpoch,
        owner,
      });
      deferred.add(decisionId);
    }
    const incoming = (evaluated.evaluations ?? []).filter((row) => !deferred.has(row.decisionId));
    const toAccept = existing.length === 0
      ? incoming
      : incoming.filter((row) => missingIds.includes(row.decisionId));
    const accepted = await tc.acceptEvaluations(sessionDir, {
      gameEpoch,
      owner,
      handNo,
      evaluations: toAccept,
    });
    const byId = new Map(existing.map((item) => [item.evaluationId, item]));
    for (const item of accepted.accepted ?? []) byId.set(item.evaluationId, item);
    acceptedItems = [...byId.values()];
    const details = new Map(evaluations.map((row) => [row.evaluationId, row]));
    for (const row of evaluated.evaluations ?? []) {
      if (row?.evaluationId) details.set(row.evaluationId, row);
    }
    evaluations = [...details.values()];
  }

  // 미뤄진 결정마다 solve task를 연다. resume은 `--solver` 없이도 pending에
  // 적힌 adapterId로 재개한다 — 플래그는 새 pending 생성만 게이트한다.
  if (typeof startSolve === 'function') {
    const auth = tc.loadAuthority(sessionDir);
    for (const decisionId of deferred) {
      const entry = auth?.pending?.[decisionId];
      if (!entry?.adapterId) continue;
      if (entry.handNo != null && Number(entry.handNo) !== Number(handNo)) continue;
      if (auth?.solveTasks?.[decisionId]) continue;
      startSolve({
        sessionDir,
        decisionId,
        handNo: entry.handNo ?? handNo,
        adapterId: entry.adapterId,
        gameEpoch,
        owner,
      });
    }
  }

  if (typeof publish === 'function') await publish('machine');
  if (typeof consume === 'function') {
    try { await consume(); } catch { /* consumers retry independently */ }
  }

  const sealExplanation = async (item, value) => {
    await tc.sealAnnotation(sessionDir, item.evaluationId, 'explanation', value);
    if (typeof publish === 'function') await publish('annotation');
  };

  for (const item of acceptedItems) {
    if (hasExplanationCutoff(sessionDir)) {
      await sealExplanation(item, 'unavailable');
      continue;
    }
    const existingAnn = item.annotations?.explanation
      ?? tc.loadAuthority(sessionDir)?.items?.[item.evaluationId]?.annotations?.explanation;
    if (existingAnn?.status === 'ready' || existingAnn?.status === 'unavailable') continue;
    let sealedExisting = null;
    try {
      sealedExisting = readAnnotationExactFile(sessionDir, item.detailRef, 'explanation');
    } catch { /* first attempt */ }
    if (sealedExisting) {
      await sealExplanation(
        item,
        sealedExisting.status === 'unavailable' ? 'unavailable' : sealedExisting.value,
      );
      continue;
    }
    const evaluation = {
      ...(evaluations.find((row) => row.evaluationId === item.evaluationId) ?? item.summary),
      handNo,
      evaluationId: item.evaluationId,
    };
    if (typeof explain !== 'function') continue;
    let text = null;
    await withExplainLock(sessionDir, async () => {
      if (hasExplanationCutoff(sessionDir)) return;
      const explainHandle = toRunnerHandle(explain(evaluation));
      try {
        text = await explainHandle.promise;
      } catch { text = null; }
    });
    if (hasExplanationCutoff(sessionDir)) {
      await sealExplanation(item, 'unavailable');
      continue;
    }
    if (typeof text !== 'string' || !text.trim()) continue;
    const check = validateExplanation(evaluation, text);
    if (!check.ok) continue;
    await sealExplanation(item, text);
  }

  return {
    ok: true,
    evaluations,
    accepted: acceptedItems,
    handle: evalHandle,
  };
}

export async function runHandPipeline(opts) {
  const key = `${opts.sessionDir}\0${opts.handNo}`;
  const prev = handPipelineTail.get(key) ?? Promise.resolve();
  const work = prev.catch(() => {}).then(() => runHandPipelineUnlocked(opts));
  handPipelineTail.set(key, work);
  try {
    return await work;
  } finally {
    if (handPipelineTail.get(key) === work) handPipelineTail.delete(key);
  }
}

export async function ingestHand({
  sessionDir, handNo, gameEpoch, owner, explain, evaluate,
}) {
  return runHandPipeline({
    sessionDir, handNo, gameEpoch, owner, explain, evaluate,
  });
}

/**
 * One deferred postflop solve. The authority `solveTasks` map holds the task
 * while it runs (R10 rollback quiescence), the result is accepted as an
 * ordinary `evaluated` item, and any failure keeps the `pending` entry with its
 * adapterId so a later resume or bootstrap sweep can retry it.
 */
export async function runSolveTask(opts) {
  return withSolveLock(opts.sessionDir, () => runSolveTaskUnlocked(opts));
}

async function runSolveTaskUnlocked({
  sessionDir, decisionId, handNo, adapterId, gameEpoch, owner, storeDir,
  solve, publish, consume, shouldStop,
}) {
  // 큐에서 기다리는 동안 cutoff가 지났을 수 있다. 그러면 자식을 새로 띄우지
  // 않고 pending을 그대로 둔다 — cutoff 시 pending 유지가 계약이다.
  if (shouldStop?.()) return { ok: false, code: 'SOLVE_CUTOFF' };
  const tc = createTrainingControl({ storeDir });
  const keepPending = async (code) => {
    try {
      await tc.recordPending(sessionDir, decisionId, {
        handNo, reason: code, adapterId, gameEpoch, owner,
      });
    } catch { /* the existing pending entry is already the record */ }
  };
  // 점유를 잡지 못하면 다른 solve가 이미 이 결정을 들고 있다는 뜻이다. 그
  // 경우 pending도 건드리지 않고 물러난다 — 여기서 덮어쓰면 살아 있는 자식의
  // 점유 기록을 지워 rollback guard가 live solve를 놓친다.
  const claim = await tc.claimSolveTask(sessionDir, decisionId, { handNo, adapterId });
  if (!claim?.claimed) {
    return { ok: false, code: claim?.code ?? 'SOLVE_ALREADY_RUNNING' };
  }
  try {
    let solved;
    try {
      const runner = typeof solve === 'function' ? solve : defaultSolve;
      const handle = toRunnerHandle(runner({ sessionDir, decisionId, handNo, adapterId }));
      solved = await handle.promise;
    } catch (error) {
      solved = { ok: false, code: error.code ?? 'SOLVE_FAILED' };
    }
    if (!solved?.ok) {
      const code = solved?.code ?? 'SOLVE_FAILED';
      await keepPending(code);
      return { ok: false, code };
    }
    const incoming = (solved.evaluations ?? []).filter((row) => row?.decisionId === decisionId);
    if (incoming.length === 0) {
      await keepPending('NO_EVALUATION');
      return { ok: false, code: 'NO_EVALUATION' };
    }
    try {
      await tc.acceptEvaluations(sessionDir, {
        gameEpoch, owner, handNo, evaluations: incoming,
      });
    } catch (error) {
      const code = error.code ?? 'SOLVE_ACCEPT_FAILED';
      await keepPending(code);
      return { ok: false, code };
    }
    if (typeof publish === 'function') await publish('machine');
    if (typeof consume === 'function') {
      try { await consume(); } catch { /* consumers retry independently */ }
    }
    return { ok: true };
  } finally {
    await tc.releaseSolveTask(sessionDir, decisionId, claim.token);
  }
}

function livePotOpponents(snapshot) {
  return (snapshot?.publicSeats ?? [])
    .filter((seat) => seat?.playerId !== snapshot.actorId && !seat?.folded && !seat?.out)
    .map((seat) => ({
      playerId: seat.playerId,
      contribution: Number.isFinite(seat.contribution) ? seat.contribution : 0,
    }));
}

function policyOf(players, playerId) {
  const player = (players ?? []).find((row) => row?.playerId === playerId);
  return player?.policy ?? null;
}

/**
 * Seals one `exploit` annotation per already-evaluated item, covering every
 * opponent still in the pot at decision time. Called at finalize after the
 * training settle and **before** the cutoff marker: the marker fences
 * `explanation` only, but the reveal stage runs after the marker, so computing
 * exploit there would orphan the last hand's annotations.
 */
export async function sealExploitAnnotations({
  sessionDir, storeDir, players, publish,
}) {
  const tc = createTrainingControl({ storeDir });
  const auth = tc.loadAuthority(sessionDir);
  if (!auth) return { sealed: 0, skipped: 0 };
  let sealed = 0;
  let skipped = 0;
  for (const item of Object.values(auth.items)) {
    // pending 결정은 건너뛴다 — item이 없는 annotation은 ANNOTATION_ORPHAN이다.
    if (item.status !== 'evaluated' && item.status !== 'published') continue;
    if (item.annotations?.exploit) continue;
    const record = loadHandRecord(sessionDir, item.handNo);
    const snapshot = (record?.decisions ?? [])
      .find((snap) => snap.actorId === 'user' && snap.decisionId === item.decisionId);
    if (!snapshot) {
      skipped += 1;
      continue;
    }
    const detail = loadEvaluationDetail(sessionDir, item);
    const rows = [];
    let unevaluated = 0;
    for (const opponent of livePotOpponents(snapshot)) {
      const policy = policyOf(players, opponent.playerId);
      if (!policy) {
        unevaluated += 1;
        continue;
      }
      let evaluated;
      try {
        evaluated = evaluateExploit({
          gto: detail,
          policy,
          snapshot,
          chosen: snapshot.chosenAction,
        });
      } catch {
        unevaluated += 1;
        continue;
      }
      if (evaluated?.exploit?.status !== 'supported') {
        unevaluated += 1;
        continue;
      }
      rows.push({
        opponentId: opponent.playerId,
        policyId: evaluated.exploit.opponentModelId,
        adjustment: evaluated.exploit.adjustment,
        comparison: { summaryCode: evaluated.comparison.summaryCode },
        contribution: opponent.contribution,
      });
    }
    // 부분 결과는 봉인하지 않는다. annotation은 terminal set-once이므로 한
    // 상대라도 평가하지 못한 채 봉인하면 틀린 `primary`가 영구히 박힌다. 상대
    // 전원을 평가할 수 없으면 annotation을 아예 남기지 않는 쪽이 fail-closed다.
    if (rows.length === 0 || unevaluated > 0) {
      skipped += 1;
      continue;
    }
    // primary는 결정 시점 pot 기여가 가장 큰 상대다. 동률은 id 순으로 고정해
    // 같은 입력이 같은 annotation digest를 내도록 한다.
    const primary = [...rows]
      .sort((left, right) => right.contribution - left.contribution
        || String(left.opponentId).localeCompare(String(right.opponentId)))[0].opponentId;
    const value = {
      opponents: rows.map(({ contribution, ...row }) => row),
      primary,
    };
    const result = await tc.sealAnnotation(sessionDir, item.evaluationId, 'exploit', value);
    if (result?.ok) sealed += 1;
    else skipped += 1;
  }
  if (sealed > 0 && typeof publish === 'function') await publish('annotation');
  return { sealed, skipped };
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

export function writeTrainingEnvelope(sessionDir, envelope, { kind = 'mixed' } = {}) {
  ensureDir(path.join(sessionDir, 'training'));
  const unique = `${kind}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.json`;
  const name = `.publish-envelope-${unique}`;
  writeContained(sessionDir, ['training', name], JSON.stringify(envelope), { mode: 'create' });
  return path.join(sessionDir, 'training', name);
}

function unlinkEnvelope(file) {
  try { fs.unlinkSync(file); } catch { /* leftover envelope is non-authoritative */ }
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
    const file = writeTrainingEnvelope(sessionDir, envelope, { kind: 'machine' });
    try {
      await publishSideEnvelope(executePublish, file);
      for (const item of envelope.training) {
        try {
          await tc.markPublished(sessionDir, item.evaluationId, item.payloadSha256);
        } catch { /* already marked or conflict is logged by caller */ }
      }
    } finally {
      unlinkEnvelope(file);
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
    const file = writeTrainingEnvelope(sessionDir, envelope, { kind: 'annotation' });
    try {
      await publishSideEnvelope(executePublish, file);
      for (const item of envelope.trainingAnnotations) {
        try {
          await tc.markAnnotationPublished(sessionDir, item.evaluationId, item.field, item.valueSha256);
        } catch { /* already marked or conflict is logged by caller */ }
      }
    } finally {
      unlinkEnvelope(file);
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
  const file = writeTrainingEnvelope(sessionDir, envelope, { kind: 'retry' });
  try {
    await executePublish(['--from', file, '--retry']);
  } finally {
    unlinkEnvelope(file);
  }
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
