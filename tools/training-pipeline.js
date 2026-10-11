import { independentAssessmentEligibility } from '../shared/assistance.js';
import {referenceAssessmentEligibility} from '../shared/reference-coverage.js';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { childSpawnOptions } from '../shared/child-spawn-options.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTrainingControl,
  hasCutoffMarker,
  materializeLearningEvaluation,
  readAnnotationExactFile,
} from './training-control.js';
import { explanationEligible, validateExplanation } from '../training/explain.js';
import { isCoverageReferenceSource, referenceQuality, sanitizeCoachingText } from '../shared/reference.js';
import { evaluateExploit } from '../training/exploit/evaluator.js';
import { ensureDir, writeContained } from './training-store.js';
import { readDerivedPolicyConfigs } from './policy-player.js';
import { killGroup, readPersistedSolver } from './solver-runtime.js';
import {
  annotationBodyByteLength,
  gameEpochOf,
  isAnnotationOnlyAttempt,
  MAX_PUBLISH_BODY_BYTES,
  MAX_PUBLISH_ID,
  preserveInitialRejection,
  projectTrainingAnnotation,
  publicProofId,
  sanitizeRejectionFields,
  sha256Hex,
  trainingBodyByteLength,
  TRAINING_CHUNK_SLACK_BYTES,
} from '../publish-contract.js';
import { REJECTION_LINE_MAX_BYTES, readRecordedAttempt, rejectionRecordByteLength } from './rejection-audit.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'evaluate-cli.js');
const SOLVE_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'solve-cli.js');
const BODY_BUDGET = MAX_PUBLISH_BODY_BYTES - TRAINING_CHUNK_SLACK_BYTES;
// #274: an annotation batch is eligible only if the relay could judge it (BODY_BUDGET) and a
// refusal of it could be audited: the digest-only audit line naming every item of the batch
// must fit the bounded audit line, with the same slack the body keeps.
export const AUDIT_LINE_BUDGET = REJECTION_LINE_MAX_BYTES - TRAINING_CHUNK_SLACK_BYTES;
// A flush may settle a recorded attempt (retire it, or find it accepted) instead of sending the
// envelope it built, and then rebuild from the changed authority. Each such settlement consumes
// a recorded attempt; this bounds how many a single flush tolerates before it reports no progress.
const MAX_SETTLEMENTS_PER_FLUSH = 4;
const handPipelineTail = new Map();
const explainTail = new Map();
const solveTail = new Map();
const publishFlushTail = new Map();

function withSessionTail(tails, sessionDir, work) {
  const key = path.resolve(sessionDir);
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(work);
  tails.set(key, run.then(() => {}, () => {}));
  return run;
}

function withExplainLock(sessionDir, work) {
  return withSessionTail(explainTail, sessionDir, work);
}

// solver-runtime은 세션당 하나의 자식만 허용한다(`.solver-child.json`). 한 핸드에
// postflop 결정이 둘 이상이면 solve를 나란히 띄우는 순간 뒤엣것이 스스로
// SOLVER_BUSY를 맞고 pending으로 되돌아간다 — 자기가 만든 경합이다. 세션별로
// 직렬화한다.
function withSolveLock(sessionDir, work) {
  return withSessionTail(solveTail, sessionDir, work);
}

function withMachineFlushLock(sessionDir, work) {
  return withSessionTail(publishFlushTail, sessionDir, work);
}

function withAnnotationFlushLock(sessionDir, work) {
  return withSessionTail(publishFlushTail, sessionDir, work);
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

async function terminatePersistedSolver(sessionDir) {
  if (!sessionDir) return { confirmed: true };
  let persisted = readPersistedSolver(sessionDir);
  if (persisted.state === 'absent' || persisted.state === 'dead') {
    return { confirmed: true };
  }
  await killGroup(persisted.record?.pid, persisted.record?.startTime);
  persisted = readPersistedSolver(sessionDir);
  if (persisted.state === 'absent' || persisted.state === 'dead') {
    return { confirmed: true };
  }
  return { confirmed: false, reason: 'solver_child_live' };
}

function cliRunner(argv, { timeoutMs, failCode, solverSessionDir = null }) {
  let child = null;
  let settled = false;
  const promise = new Promise((resolve) => {
    child = execFile(process.execPath, argv, childSpawnOptions({
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }), (error, stdout) => {
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
      let wrapperConfirmed = settled || !child;
      if (!wrapperConfirmed) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        wrapperConfirmed = await waitChild(child, 400);
        if (!wrapperConfirmed) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          wrapperConfirmed = await waitChild(child, 400);
        }
      }
      const solver = await terminatePersistedSolver(solverSessionDir);
      if (!solver.confirmed) return solver;
      return { confirmed: wrapperConfirmed };
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
  ], { timeoutMs: 20_000, failCode: 'SOLVE_FAILED', solverSessionDir: sessionDir });
}

export function buildExplanationPrompt(evaluation) {
  return [
    '역할: 학습 해설',
    evaluation?.assistance?.hintShown ? '힌트 도움을 받은 결정이다. 독립 실력·성적 향상이라고 해설하지 마라.' : '',
    evaluation?.dealSelection?.mode && evaluation.dealSelection.mode!=='off' ? '유리한 딜로 선택된 연습 표본이다. 독립 평가·실력·수익 향상 증거가 아니다.' : '',
    'JSON 한 줄만 출력하라: {"evaluationId":"...","explanation":"..."}',
    'evaluator 수치를 바꾸지 마라. 새 숫자를 만들지 마라.',
    '이 평가는 검증된 GTO 정답이나 EV 손실이 아니라 출처가 확인된 경우에도 휴리스틱 기준표 비교다.',
    '출처가 합성·미확인이라면 추천이나 등급을 정답처럼 설명하지 마라.',
    '허용 숫자 형태만 사용하라:',
    '1) 빈도: <action> <n>% 또는 <n>% <action> 또는 소수 0.nn — n은 그 action의 frequency와 결박 (영·한 별칭: raise|레이즈|오픈|3벳|3-bet|리레이즈, fold|폴드, call|콜, check|체크)',
    '2) 사이즈: <n>bb / <n> bb / <n>BB — 어떤 sizeBb와 ±0.05. EV|손실|loss|이득이 같은 절에 있으면 금지',
    '3) 핸드 번호: <handNo>',
    evaluation?.status !== 'supported'
      ? 'unsupported를 정답처럼 설명하지 마라. 핸드 번호 외 숫자를 쓰지 마라.'
      : '',
    isCoverageReferenceSource(evaluation?.source) && !independentAssessmentEligibility(evaluation).metricEligible
      ? '투영 참고 또는 비교 불가다. 등급을 주장하지 말고 핸드 번호 외 모든 숫자를 생략하라. 직접 비교라고 쓰지 마라.' : '',
    '해설에는 아래 handClass·spotKey·street가 가리키는 손패와 상황을 구체적으로 언급하라.',
    JSON.stringify({
      handClass: evaluation?.handClass,
      spotKey: evaluation?.spotKey,
      street: evaluation?.street,
      assistance: evaluation?.assistance,
      dealSelection: evaluation?.dealSelection,
      dealSelectionContractVersion: evaluation?.dealSelectionContractVersion,
      coverage: evaluation?.coverage,
      metricEligible: independentAssessmentEligibility(evaluation).metricEligible,
      evaluationId: evaluation?.evaluationId,
      status: evaluation?.status,
      grade: evaluation?.grade,
      handNo: evaluation?.handNo,
      chosen: evaluation?.chosen,
      recommended: evaluation?.recommended,
      code: evaluation?.code,
      reason: evaluation?.reason,
      source: evaluation?.source,
    }),
  ].filter(Boolean).join('\n');
}

export function aggregateProcessRows(rows, { pending = 0 } = {}) {
  const eligible = (rows ?? []).filter((row) => {
    const quality = referenceQuality(row?.source).quality;
    if (quality === 'synthetic') return false;
    return row?.status !== 'supported' || quality === 'heuristic-reference';
  });
  const supported = eligible.filter((row) => independentAssessmentEligibility(row).metricEligible);
  const available = eligible.filter(row=>referenceAssessmentEligibility(row).referenceAvailable);
  const offPolicy = supported.filter((row) => row.grade === 'off-policy').length;
  return {
    total: eligible.length,
    supported: supported.length,
    unsupported: eligible.filter(row=>row.status!=='supported').length,
    nonComparableSupported: eligible.filter(row=>row.status==='supported'&&!independentAssessmentEligibility(row).metricEligible).length,
    assisted: eligible.filter(row=>row.assistance?.hintShown).length,
    biased: eligible.filter(row=>row.dealSelection?.mode && row.dealSelection.mode!=='off').length,
    forced: eligible.filter(row=>row.forced===true).length,
    referenceAvailable: available.length,
    exactComparable: supported.length,
    projected: available.filter(row=>row.coverage?.referenceMatch==='projected'||row.coverage?.choiceMatch==='projected').length,
    comparisonUnavailable: available.filter(row=>row.coverage?.choiceMatch==='unavailable').length,
    offPolicy,
    pending,
    supportedRate: eligible.length ? supported.length / eligible.length : 0,
  };
}

export function trainingAggregate(sessionDir) {
  const tc = createTrainingControl();
  const auth = tc.loadAuthority(sessionDir);
  const rows = Object.values(auth?.items ?? {}).flatMap((item) => {
    try {
      return [materializeLearningEvaluation(sessionDir, item)];
    } catch {
      return [];
    }
  });
  return aggregateProcessRows(rows, { pending: Object.keys(auth?.pending ?? {}).length });
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
  evaluate, explain, publish, consume, solverAdapterId, startSolve, admit, admitExplain,
}) {
  // `admit()` false means a pause is closing the gate: no new evaluator or
  // explainer child starts, and whatever is left comes back `deferred` so the
  // caller can register the hand again once play resumes (design §11.2 R1).
  // `admitExplain()` narrows only the explanation stage (finalization lets the
  // last hand explain first while other hands may still evaluate).
  const admitted = () => typeof admit !== 'function' || admit() === true;
  const explainAdmitted = () => admitted() && (typeof admitExplain !== 'function' || admitExplain() === true);
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
  if (!skipEvaluate && !admitted()) {
    return { ok: true, deferred: true, evaluations, accepted: existing, handle: evalHandle };
  }
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

  const sealExplanation = async (item, value, options) => {
    await tc.sealAnnotation(sessionDir, item.evaluationId, 'explanation', value, options);
    if (typeof publish === 'function') await publish('annotation');
  };

  let explainDeferred = false;
  for (const item of acceptedItems) {
    if (hasCutoffMarker(sessionDir)) {
      await sealExplanation(item, 'unavailable', { sealReason: 'cutoff' });
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
      if (sealedExisting.status === 'unavailable') {
        if (hasCutoffMarker(sessionDir)) {
          await sealExplanation(item, 'unavailable', { sealReason: 'cutoff' });
        } else {
          await sealExplanation(item, 'unavailable', { sealReason: 'explain-failed' });
        }
      } else {
        await sealExplanation(item, sealedExisting.value);
      }
      continue;
    }
    const evaluation = {
      ...(evaluations.find((row) => row.evaluationId === item.evaluationId) ?? item.summary),
      handNo,
      evaluationId: item.evaluationId,
    };
    if (typeof explain !== 'function') continue;
    // An unsupported decision has nothing to explain beyond its reason code:
    // seal it at once instead of spending an LLM call or leaving it pending.
    if (evaluation.status !== 'supported') {
      await sealExplanation(item, 'unavailable', { sealReason: 'not-explainable' });
      continue;
    }
    // A source no explanation could be accepted for (synthetic or unverified
    // reference) gets no LLM call; it stays unsealed until the cutoff seal.
    if (!explanationEligible(evaluation)) continue;
    // Checked between items and again once the explain lock is ours: a pipeline
    // that queued behind the lock during a pause must not start its child.
    if (!explainAdmitted()) { explainDeferred = true; continue; }
    let text = null;
    let held = false;
    await withExplainLock(sessionDir, async () => {
      if (hasCutoffMarker(sessionDir)) return;
      if (!explainAdmitted()) { held = true; return; }
      const explainHandle = toRunnerHandle(explain(evaluation));
      try {
        text = await explainHandle.promise;
      } catch { text = null; }
      // An explainer that waited (e.g. on the background probe) and found the
      // gate closed started nothing: the item stays unsealed and is re-registered.
      if (text === EXPLAIN_HELD) { held = true; text = null; }
    });
    if (hasCutoffMarker(sessionDir)) {
      await sealExplanation(item, 'unavailable', { sealReason: 'cutoff' });
      continue;
    }
    if (held) { explainDeferred = true; continue; }
    if (typeof text !== 'string' || !text.trim()) continue;
    // New model output only: drop out-of-bounds sentences before validation and
    // sealing; a stored explanation is never rewritten.
    text = sanitizeCoachingText(text).text;
    if (!text) continue;
    const check = validateExplanation(evaluation, text);
    if (!check.ok) continue;
    await sealExplanation(item, text);
  }

  return {
    ok: true,
    ...(explainDeferred ? { deferred: true } : {}),
    evaluations,
    accepted: acceptedItems,
    handle: evalHandle,
  };
}

/** Returned by an explainer that declined to start because the gate closed while it waited. */
export const EXPLAIN_HELD = Symbol('explain-held');

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
    // cutoff는 claim을 기다리는 동안에도 지나갈 수 있다. 자식을 띄우기 직전에
    // 다시 확인해야 종료 확인 절차가 이미 끝난 뒤에 새 solver가 태어나는 창이
    // 닫힌다. finally가 점유를 풀어 주므로 여기서 나가도 잔해는 없다.
    if (shouldStop?.()) return { ok: false, code: 'SOLVE_CUTOFF' };
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
  const derived = readDerivedPolicyConfigs(sessionDir);
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
          derived,
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

// 게시 경로는 매 턴 호출된다. 여기서 던지면 training 장애가 턴 게시 장애가 된다 —
// training은 자기 소비자에게 계속 크게 실패하되, 게임 진행은 막지 않는다.
function authorityForPublish(sessionDir) {
  try {
    return createTrainingControl().loadAuthority(sessionDir);
  } catch {
    return null;
  }
}

export function unpublishedEnvelope(sessionDir, { gameEpoch } = {}) {
  const auth = authorityForPublish(sessionDir);
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

function annotationEnvelopeState(sessionDir, { gameEpoch } = {}) {
  const auth = authorityForPublish(sessionDir);
  if (!auth) return { envelope: null, recoveryNeeded: false };
  const entries = [];
  const soloEntries = [];
  let recoveryNeeded = false;
  for (const [evaluationId, fields] of Object.entries(auth.annotationQueue ?? {})) {
    const item = auth.items[evaluationId];
    if (!item) continue;
    for (const [field, queued] of Object.entries(fields ?? {})) {
      if (queued?.published) continue;
      let canonical;
      try {
        canonical = readAnnotationExactFile(sessionDir, item.detailRef, field);
      } catch {
        recoveryNeeded = true;
        continue;
      }
      const projected = projectTrainingAnnotation({
        evaluationId,
        payloadSha256: item.payloadSha256,
        field,
        status: canonical.status,
        value: canonical.value,
      });
      const entry = {
        ...projected,
        annotationProof: {
          id: publicProofId(`${evaluationId}:${field}`),
          valueSha256: projected.valueSha256,
        },
      };
      if (queued?.solo === true) soloEntries.push(entry);
      else entries.push(entry);
    }
  }
  // An entry that shared a refused body (retireRejectedAnnotations) travels alone, so the
  // relay's refusal can name it; the rest keep chunking together and go first.
  if (entries.length === 0 && soloEntries.length > 0) entries.push(soloEntries[0]);
  if (entries.length === 0) return { envelope: null, recoveryNeeded };
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
    const auditBytes = rejectionRecordByteLength(annotationAuthority.items);
    if (bytes > BODY_BUDGET || auditBytes > AUDIT_LINE_BUDGET) {
      if (chunk.length === 0) chunk.push(entry);
      break;
    }
    chunk.push(entry);
  }
  if (chunk.length === 0) return { envelope: null, recoveryNeeded };
  return {
    recoveryNeeded,
    envelope: {
      trainingAnnotations: chunk,
      annotationAuthority: {
        expectedGameEpoch: gameEpoch ?? auth.gameEpoch,
        items: chunk.map((row) => ({
          evaluationId: row.evaluationId,
          field: row.field,
          valueSha256: row.valueSha256,
        })),
      },
    },
  };
}

export function annotationEnvelope(sessionDir, options = {}) {
  return annotationEnvelopeState(sessionDir, options).envelope;
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

// #274: settle a relay refusal through the caller's hook. A failure of that settlement (relay
// verification, retirement, evidence) is the answer, but it carries the first refusal's closed
// status/code beside its own code rather than replacing it (preserveInitialRejection).
async function settleRejection(retirePending, error) {
  if (typeof retirePending !== 'function') return false;
  try {
    return await retirePending(error);
  } catch (failure) {
    const preserved = preserveInitialRejection(failure, error);
    // A refusal the recheck itself produced is the settlement's answer, not a refusal of the
    // envelope being flushed: the flush must not try to settle it again.
    if (preserved && typeof preserved === 'object') preserved.settlementFailure = true;
    throw preserved;
  }
}

// A recorded attempt the publisher found stale against the current annotation authority (an
// entry it carried was retired or published meanwhile) is removed by the publisher before
// anything is sent and reported as STALE_ANNOTATION_AUTHORITY. Nothing of it was applied; the
// queue it was built from has moved on. True only when the publisher did remove it — a record
// that is still there is not settled and keeps its failure.
function staleAttemptRemoved(sessionDir, error) {
  return error?.code === 'STALE_ANNOTATION_AUTHORITY'
    && typeof sessionDir === 'string'
    && !fs.existsSync(path.join(sessionDir, '.publish-attempt.json'));
}

// Returns the publisher's reply, or `{ settledPending: true }` when a recorded attempt was
// settled (retired on evidence, taken by the relay after all, or found stale against the
// current authority and removed unsent) instead of this envelope: the queue the envelope was
// built from changed, so the caller rebuilds it rather than sending a body whose authority is
// now stale.
async function publishSideEnvelope(executePublish, file, retirePending = null, sessionDir = null) {
  try {
    return await executePublish(['--from', file]);
  } catch (error) {
    if (error.code !== 'ATTEMPT_PENDING' && error.code !== 'LOCK_TIMEOUT') throw error;
    if (error.code === 'ATTEMPT_PENDING') {
      try {
        await executePublish(['--from', file, '--retry']);
      } catch (retryError) {
        // Resolved by someone else between the two calls — possibly a retirement whose queue
        // settlement is still pending. The envelope was built before that: the caller
        // reconciles outstanding evidence and rebuilds rather than sending it as it is.
        if (retryError.code === 'NO_ATTEMPT') return { settledPending: true };
        // A rejected explanatory attempt must not hold this envelope hostage: retire it
        // (with evidence); anything else stays a failure.
        if (retryError.code === 'PUBLISH_REJECTED' && await settleRejection(retirePending, retryError)) {
          return { settledPending: true };
        }
        if (staleAttemptRemoved(sessionDir, retryError)) return { settledPending: true };
        throw retryError;
      }
    }
    return executePublish(['--from', file]);
  }
}

function noProgressError(kind, why) {
  const error = new Error(`training ${kind} flush made no queue progress${why ? ` (${why})` : ''}`);
  error.code = 'TRAINING_FLUSH_NO_PROGRESS';
  return error;
}

function envelopeItemSet(kind, envelope) {
  const rows = kind === 'machine' ? envelope.training : envelope.trainingAnnotations;
  return JSON.stringify(rows.map((row) => (
    kind === 'machine'
      ? [row.evaluationId, row.payloadSha256]
      : [row.evaluationId, row.field, row.valueSha256]
  )));
}

function markFailure(error) {
  const causeCode = error?.code ?? 'ERROR';
  const wrapped = new Error(`training publish mark failed: ${causeCode}`);
  wrapped.code = 'TRAINING_MARK_FAILED';
  wrapped.cause = error;
  wrapped.causeCode = causeCode;
  return wrapped;
}

async function markPublishedOrThrow(work) {
  try {
    return await work();
  } catch (error) {
    if (error?.code === 'ALREADY_PUBLISHED') return { noop: true };
    throw markFailure(error);
  }
}

export async function reconcileAnnotationQueue(sessionDir, {
  storeDir,
  trainingControl,
  onNotice,
} = {}) {
  const tc = trainingControl?.reconcileAnnotationQueue
    ? trainingControl
    : createTrainingControl({ storeDir });
  const result = await tc.reconcileAnnotationQueue(sessionDir);
  for (const notice of result?.notices ?? []) onNotice?.(notice);
  return result;
}

export async function flushMachinePublish(sessionDir, {
  gameEpoch, executePublish, storeDir, shouldStop, trainingControl, retirePending,
}) {
  return withMachineFlushLock(sessionDir, async () => {
    const tc = trainingControl ?? createTrainingControl({ storeDir });
    let previousItems = null;
    let settlements = 0;
    for (;;) {
      if (shouldStop?.()) return;
      const envelope = unpublishedEnvelope(sessionDir, { gameEpoch });
      if (!envelope) return;
      const itemSet = envelopeItemSet('machine', envelope);
      if (itemSet === previousItems) throw noProgressError('machine');
      previousItems = itemSet;
      const file = writeTrainingEnvelope(sessionDir, envelope, { kind: 'machine' });
      try {
        const out = await publishSideEnvelope(executePublish, file, retirePending, sessionDir);
        if (out?.settledPending) {
          // A recorded attempt was settled, not this envelope: rebuild from the authority as
          // it is now (the same items are not "no progress" — nothing was sent).
          settlements += 1;
          if (settlements > MAX_SETTLEMENTS_PER_FLUSH) throw noProgressError('machine', 'settlements');
          previousItems = null;
          continue;
        }
        for (const item of envelope.training) {
          await markPublishedOrThrow(() => (
            tc.markPublished(sessionDir, item.evaluationId, item.payloadSha256)
          ));
        }
      } finally {
        unlinkEnvelope(file);
      }
    }
  });
}

export async function flushAnnotationPublish(sessionDir, {
  gameEpoch, executePublish, storeDir, shouldStop, trainingControl, onNotice, retirePending,
}) {
  return withAnnotationFlushLock(sessionDir, async () => {
    const tc = trainingControl ?? createTrainingControl({ storeDir });
    // #274: a retirement an interruption left half done (attempt removed, queue not settled)
    // is settled from its private evidence before any new annotation body is built — never
    // re-decided by a new publication whose answer may depend on the hand now being played.
    await settleInterruptedRetirement(tc, sessionDir, onNotice);
    let previousItems = null;
    // Consecutive settlements that removed nothing from the queue. A settlement is progress
    // only when a member this envelope was built from is no longer queued afterwards — retired
    // (closed on evidence) or published and marked — never because the authority's bytes or
    // the rebuilt envelope merely changed. Isolating a refused batch into singletons removes
    // nothing and spends one unit; each refused member then actually retired resets it. So a
    // long queue of refused notes still drains, while a settlement that keeps settling nothing
    // is still finite: MAX_SETTLEMENTS_PER_FLUSH consecutive stalls end the flush.
    let stalls = 0;
    let membersBefore = new Set();
    const settledAndRebuild = async (why) => {
      await settleInterruptedRetirement(tc, sessionDir, onNotice);
      const membersAfter = queuedAnnotationMembers(tc, sessionDir);
      const progressed = [...membersBefore].some((member) => !membersAfter.has(member));
      stalls = progressed ? 0 : stalls + 1;
      if (stalls > MAX_SETTLEMENTS_PER_FLUSH) throw noProgressError('annotation', why);
      previousItems = null;
    };
    for (;;) {
      if (shouldStop?.()) return;
      const state = annotationEnvelopeState(sessionDir, { gameEpoch });
      if (state.recoveryNeeded) {
        await reconcileAnnotationQueue(sessionDir, {
          storeDir, trainingControl: tc, onNotice,
        });
        continue;
      }
      const { envelope } = state;
      if (!envelope) return;
      const itemSet = envelopeItemSet('annotation', envelope);
      if (itemSet === previousItems) throw noProgressError('annotation');
      previousItems = itemSet;
      membersBefore = queuedAnnotationMembers(tc, sessionDir);
      const file = writeTrainingEnvelope(sessionDir, envelope, { kind: 'annotation' });
      try {
        let out;
        try {
          out = await publishSideEnvelope(executePublish, file, retirePending, sessionDir);
        } catch (error) {
          // The publisher refused to judge this body while retirement evidence is outstanding
          // (a refused explanation whose queue settlement has not happened yet — it may be
          // waiting behind another holder of the training lock). Settle that evidence first,
          // then rebuild from the settled queue — bounded like any other settlement. The
          // evidence itself is never consumed here without its own verification.
          if (error?.settlementFailure !== true && error?.code === 'REJECTION_EVIDENCE_PENDING') {
            await settledAndRebuild('evidence settlements');
            continue;
          }
          // This envelope no longer matches the authority it was built from (an entry it
          // carries was retired or published by a concurrent settlement between the build and
          // the send): the publisher refused it unsent and recorded nothing. Rebuild from the
          // authority as it is now — bounded like any other settlement.
          if (error?.settlementFailure !== true && staleAttemptRemoved(sessionDir, error)) {
            await settledAndRebuild('stale rebuilds');
            continue;
          }
          // The relay refused this body. An explanatory annotation refused with a retirable code is
          // retired (with evidence) rather than left to block every later publish; any other
          // refusal stays an error with the attempt kept. The next envelope is rebuilt from the
          // settled queue and must differ from this one (the no-progress guard above).
          if (error?.settlementFailure === true
            || !(error?.code === 'PUBLISH_REJECTED' && await settleRejection(retirePending, error))) throw error;
          // Settled — by this caller, or elsewhere: another retirement of the same body may have
          // got there first while its queue settlement still waits behind an ordinary holder of
          // the training lock, so the queue this envelope was built from need not have changed
          // yet. Account for that outstanding evidence before judging progress: settle it (only
          // ever through its own verification), bounded like every other settlement, and rebuild
          // from the queue as it is then.
          await settledAndRebuild('rejection settlements');
          continue;
        }
        if (out?.settledPending) {
          // A recorded attempt (an earlier refused body) was settled instead of this envelope,
          // and the queue it was built from changed: reconcile any evidence that settlement
          // left outstanding, then rebuild within this same flush so the unrelated annotations
          // it carried are still published, never the stale body.
          await settledAndRebuild('settlements');
          continue;
        }
        for (const item of envelope.trainingAnnotations) {
          await markPublishedOrThrow(() => tc.markAnnotationPublished(
            sessionDir,
            item.evaluationId,
            item.field,
            item.valueSha256,
          ));
        }
      } finally {
        unlinkEnvelope(file);
      }
    }
  });
}

// The members of the annotation queue as the authority holds them now — "evaluationId:field"
// for every queued field — the identity against which a settlement counts as progress. An
// unreadable or absent authority has no members.
function queuedAnnotationMembers(tc, sessionDir) {
  const members = new Set();
  let auth = null;
  try { auth = typeof tc.loadAuthority === 'function' ? tc.loadAuthority(sessionDir) : null; } catch { auth = null; }
  const queue = auth?.annotationQueue;
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) return members;
  for (const [evaluationId, fields] of Object.entries(queue)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const field of Object.keys(fields)) members.add(`${evaluationId}:${field}`);
  }
  return members;
}

async function settleInterruptedRetirement(tc, sessionDir, onRetired = null) {
  if (typeof tc.reconcileRetiredAnnotations !== 'function') return null;
  const settled = await tc.reconcileRetiredAnnotations(sessionDir);
  if (settled && !settled.pending) {
    onRetired?.(`게시 거절된 학습 설명 정리 완료: publishId ${settled.publishId}`);
  }
  return settled;
}

// The recorded attempt through the bounded, preinspected, non-blocking reader: null ONLY when
// the entry is truly absent. A special file, a link, a hard link, an oversize or replaced entry,
// or one that is not a JSON object is "in doubt": the caller must neither send, dispose nor
// remove anything on it, so that reads as an explicit, closed failure instead.
function readAttemptRecord(sessionDir) {
  let read;
  try {
    read = readRecordedAttempt(sessionDir);
  } catch (error) {
    throw retireError('REJECTION_EVIDENCE_UNAVAILABLE', '기록된 게시 시도를 안전하게 읽지 못했습니다.', error);
  }
  if (read.absent) return null;
  let record;
  try {
    record = JSON.parse(read.raw);
  } catch {
    throw retireError('REJECTION_EVIDENCE_UNAVAILABLE', '기록된 게시 시도가 JSON이 아닙니다.');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw retireError('REJECTION_EVIDENCE_UNAVAILABLE', '기록된 게시 시도가 JSON 객체가 아닙니다.');
  }
  return record;
}

async function markBodyAnnotationsPublished(tc, sessionDir, body) {
  for (const item of body?.trainingAnnotations ?? []) {
    await markPublishedOrThrow(() => tc.markAnnotationPublished(
      sessionDir,
      item.evaluationId,
      item.field,
      item.valueSha256,
    ));
  }
}

function retireError(code, message) {
  return Object.assign(new Error(message), { code });
}

// The relay identity the caller verified, as the publisher needs it: pid, start time, port
// and the game epoch of the token that verification used.
function relayBindingArgs(binding, expectedGameEpoch) {
  if (!binding || typeof binding !== 'object'
    || !Number.isSafeInteger(binding.pid) || binding.pid < 1
    || typeof binding.startTime !== 'string' || binding.startTime.length === 0
    || !Number.isInteger(binding.port) || binding.port < 1 || binding.port > 65535
    || typeof binding.sessionToken !== 'string' || binding.sessionToken.length === 0
    || gameEpochOf(binding.sessionToken) !== expectedGameEpoch) {
    throw retireError('RELAY_BINDING_UNVERIFIED', '검증된 relay identity가 없어 게시 거절을 폐기하지 않습니다.');
  }
  return ['--relay-pid', String(binding.pid), '--relay-start-time', binding.startTime,
    '--relay-port', String(binding.port)];
}

/**
 * #274: settle the recorded annotation attempt after the relay refused it. Only an attempt of
 * annotations alone qualifies. The relay is re-verified (`verifyRelay`) and its identity
 * (`relayBinding()`, required) travels to the publisher with the exact attempt digest this
 * read saw. Under its publish lock the publisher resends that attempt only if it is still the
 * same one, only to that relay (re-checked before the POST and again after the reply), and
 * retires it only when the relay refuses that body again with a retirable code
 * (RETIRABLE_ANNOTATION_REJECTIONS — FORBIDDEN_LITERAL is a conservative choice, see there),
 * leaving durable evidence the training control checks before it drops anything from the
 * queue. Whatever the publisher reports must name this exact body, or nothing is settled.
 * Returns `{ retired }`, `{ published }` (the relay took it after all), `{ settledElsewhere }`
 * (the attempt was already gone) or `{ retired:false }` (nothing retirable here). A refusal
 * that is not retirable, a changed attempt, a transport failure or an unverifiable relay
 * throws — the attempt and the queue are untouched.
 */
// The full closed identity of one recorded attempt — body digest, publishId, game epoch — or
// null for anything partial, malformed or absent. Diagnostic tuples are never an identity.
function attemptIdentityOf(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const { bodySha256, publishId, expectedGameEpoch } = identity;
  if (!/^[0-9a-f]{64}$/.test(bodySha256 ?? '') || !Number.isSafeInteger(publishId) || publishId < 1
    || !/^[0-9a-f]{64}$/.test(expectedGameEpoch ?? '')) return null;
  return { bodySha256, publishId, expectedGameEpoch };
}

// Proof that EXACTLY `identity` was settled, the one check every "settled elsewhere" answer of
// the retirement helper goes through: either the reconcile just run applied surviving
// evidence of that very identity (all three fields), or its completed retirement is proven
// from the durable audit row and the durable queue disposition under the training lock
// (verifyCompletedRetirement). Another body's evidence reconciling, a file that is simply
// gone, a publisher's NO_ATTEMPT, or a partial identity prove nothing: null, and the caller
// keeps its refusal — the queue, the record and the engine untouched.
async function provenSettlementOf(tc, sessionDir, identity, settled) {
  const exact = attemptIdentityOf(identity);
  if (!exact) return null;
  if (settled && settled.pending === false
    && settled.bodySha256 === exact.bodySha256 && settled.publishId === exact.publishId
    && settled.expectedGameEpoch === exact.expectedGameEpoch) {
    return { retired: false, settledElsewhere: true };
  }
  if (typeof tc.verifyCompletedRetirement === 'function') {
    const completed = await tc.verifyCompletedRetirement(sessionDir, exact);
    if (completed?.settled === true) return { retired: false, settledElsewhere: true, completed: true };
  }
  return null;
}

export async function retireRejectedAnnotationAttempt(sessionDir, {
  executePublish, storeDir, trainingControl, verifyRelay, relayBinding, onRetired, expectedAttempt = null,
}) {
  const record = readAttemptRecord(sessionDir);
  if (record === null) {
    // No record to read: a competing settlement may have taken it before this read. An absent
    // file proves nothing by itself. Outstanding evidence — of this attempt or of another body
    // in this game — is reconciled on its own merits (verified, applied once), but only proof
    // for the captured identity itself settles THIS refusal: surviving evidence of exactly that
    // identity, or its completed retirement proven from audit and disposition. Anything else
    // keeps the refusal; without a captured identity nothing can be proven.
    const tc = trainingControl ?? createTrainingControl({ storeDir });
    const settled = await settleInterruptedRetirement(tc, sessionDir);
    return (await provenSettlementOf(tc, sessionDir, expectedAttempt, settled)) ?? { retired: false };
  }
  if (!isAnnotationOnlyAttempt(record)) return { retired: false };
  const found = {
    bodySha256: sha256Hex(JSON.stringify(record.body)),
    publishId: record.body?.publishId,
    expectedGameEpoch: record.expectedGameEpoch,
  };
  const captured = attemptIdentityOf(expectedAttempt);
  if (captured && (found.bodySha256 !== captured.bodySha256 || found.publishId !== captured.publishId
    || found.expectedGameEpoch !== captured.expectedGameEpoch)) {
    // The record on disk is not the refused attempt this caller captured (all three fields
    // must agree): a replacement recorded meanwhile. Nothing of it is sent or marked by this
    // caller. The captured attempt itself may have been settled in between — only proof for
    // exactly that identity settles it; otherwise the refusal stands, the replacement untouched.
    const tc = trainingControl ?? createTrainingControl({ storeDir });
    const settled = await settleInterruptedRetirement(tc, sessionDir);
    return (await provenSettlementOf(tc, sessionDir, captured, settled)) ?? { retired: false, replaced: true };
  }
  if (typeof relayBinding !== 'function') {
    throw retireError('RELAY_BINDING_UNVERIFIED', '검증된 relay identity가 없어 게시 거절을 폐기하지 않습니다.');
  }
  const expectedGameEpoch = record.expectedGameEpoch;
  const expectedSha256 = sha256Hex(JSON.stringify(record.body));
  const expectedPublishId = record.body.publishId;
  const tc = trainingControl ?? createTrainingControl({ storeDir });
  // Settle an earlier interrupted retirement first: the publisher refuses to retire another
  // body while unsettled evidence of a different one is on disk.
  await settleInterruptedRetirement(tc, sessionDir);
  await verifyRelay?.();
  const bindingArgs = relayBindingArgs(relayBinding(), expectedGameEpoch);
  const file = writeTrainingEnvelope(sessionDir, {
    trainingAnnotations: record.body.trainingAnnotations,
    annotationAuthority: record.annotationAuthority,
  }, { kind: 'retire' });
  let out;
  try {
    out = await executePublish(['--from', file, '--retire-rejected',
      '--expect-attempt-sha256', expectedSha256, '--expect-game-epoch', expectedGameEpoch,
      ...bindingArgs]);
  } catch (error) {
    // The record this helper read is gone by the time the publisher looked under its lock. A
    // vanished file proves nothing: only proof for exactly the identity read here — its
    // surviving evidence reconciled now, or its completed retirement proven from audit and
    // disposition — settles it. Otherwise this is a closed NO_ATTEMPT: the refusal (kept beside
    // it by the caller) stands, the queue is untouched, nothing is marked or re-sent.
    if (error?.code === 'NO_ATTEMPT') {
      const reconciled = await settleInterruptedRetirement(tc, sessionDir);
      const proven = await provenSettlementOf(tc, sessionDir, {
        bodySha256: expectedSha256, publishId: expectedPublishId, expectedGameEpoch,
      }, reconciled);
      if (proven) return proven;
      throw retireError('NO_ATTEMPT', '읽은 게시 시도가 전송 전에 사라졌고 그 정산의 증거도 없어 정리하지 않았습니다.');
    }
    // The publisher verified this exact record, found an entry it carries no longer queued (a
    // concurrent retirement or publication settled it after this body was built and refused)
    // and removed it unsent: nothing of it was applied or evidenced, and the queue has moved
    // on. The caller rebuilds from the authority. A record still on disk is not settled.
    if (staleAttemptRemoved(sessionDir, error)) return { retired: false, settledElsewhere: true, stale: true };
    throw error;
  } finally {
    unlinkEnvelope(file);
  }
  if (out?.retired !== true) {
    if (out?.bodySha256 !== expectedSha256 || out?.publishId !== expectedPublishId) {
      throw retireError('RETIRE_RESULT_UNBOUND', '게시 결과가 읽은 시도의 본문과 일치하지 않아 아무것도 정리하지 않았습니다.');
    }
    await markBodyAnnotationsPublished(tc, sessionDir, record.body);
    return { retired: false, published: true };
  }
  if (out.rejection?.bodySha256 !== expectedSha256 || out.rejection?.publishId !== expectedPublishId
    || out.rejection?.expectedGameEpoch !== expectedGameEpoch) {
    throw retireError('RETIRE_RESULT_UNBOUND', '거절 결과가 읽은 시도의 본문과 일치하지 않아 아무것도 정리하지 않았습니다.');
  }
  const settled = await tc.retireRejectedAnnotations(sessionDir, out.rejection);
  const { httpStatus, serverCode } = sanitizeRejectionFields(
    out.rejection?.httpStatus, out.rejection?.serverCode,
  );
  const disposition = { dropped: settled.retired, isolated: settled.isolated, skipped: settled.skipped };
  onRetired?.({ publishId: out.rejection?.publishId, httpStatus, serverCode, ...disposition });
  return { retired: true, ...disposition };
}

export async function retryUnresolvedTrainingAttempt(sessionDir, {
  executePublish, storeDir, retirePending,
}) {
  // The bounded, non-blocking reader: an absent record is nothing to retry; an entry in doubt
  // (special file, link, oversize, not a JSON object) is an explicit failure, never sent.
  const record = readAttemptRecord(sessionDir);
  if (record === null) return;
  const isTraining = Boolean(record.trainingAuthority || record.annotationAuthority
    || record.body?.training || record.body?.trainingAnnotations);
  if (!isTraining) return;
  const envelope = record.body?.training
    ? { training: record.body.training, trainingAuthority: record.trainingAuthority }
    : {
      trainingAnnotations: record.body.trainingAnnotations,
      annotationAuthority: record.annotationAuthority,
    };
  // #274: the queue entries marked below are the ones of the body captured HERE. The resend is
  // bound to that exact record (digest and epoch, enforced by the publisher under its lock
  // before anything is sent — a replacement recorded meanwhile stays unsent and intact), and
  // the accepted reply must name that body before anything is marked.
  const expectedSha256 = sha256Hex(JSON.stringify(record.body));
  const expectedPublishId = record.body?.publishId;
  const expectedGameEpoch = record.expectedGameEpoch;
  if (!/^[0-9a-f]{64}$/.test(expectedGameEpoch ?? '') || !Number.isSafeInteger(expectedPublishId)) {
    throw retireError('BAD_ATTEMPT', '기록된 게시 시도에 게임 epoch 또는 publishId가 없어 재시도를 묶을 수 없습니다.');
  }
  const file = writeTrainingEnvelope(sessionDir, envelope, { kind: 'retry' });
  let out;
  try {
    out = await executePublish(['--from', file, '--retry',
      '--expect-attempt-sha256', expectedSha256, '--expect-game-epoch', expectedGameEpoch]);
  } catch (error) {
    if (error?.code === 'PUBLISH_REJECTED' && await settleRejection(retirePending, error)) return;
    throw error;
  } finally {
    unlinkEnvelope(file);
  }
  if (out?.bodySha256 !== expectedSha256 || out?.publishId !== expectedPublishId) {
    throw retireError('RETIRE_RESULT_UNBOUND', '재시도 결과가 읽은 시도의 본문과 일치하지 않아 아무것도 표시하지 않았습니다.');
  }
  const tc = createTrainingControl({ storeDir });
  for (const item of record.body?.training ?? []) {
    await markPublishedOrThrow(() => (
      tc.markPublished(sessionDir, item.evaluationId, item.payloadSha256)
    ));
  }
  await markBodyAnnotationsPublished(tc, sessionDir, record.body);
}

export { gameEpochOf };
