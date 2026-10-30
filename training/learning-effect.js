// 학습 효과 평가 프로토콜 v1과 평가기(#298). 순수 함수다 — 파일을 읽지 않고, 기록을 재채점하지 않는다.
//
// 무엇을 재는가: 한 참여자(store 하나)가 등록 때 봉인한 일정(기준 → 개입 → 사후)에서 **휴리스틱 기준표 일치도**가
// 어떻게 달라졌는지의 개인 연관 관측이다. 코칭의 인과 효과, 독립 전략 기준의 습득, 실제 테이블 전이·수익의 증거가 아니다.
//
//   M1  미응답·미열람 동치군 문항 일치도(전이 근사): 기준 K개 assessment의 깨끗한 문항 대 사후 K개 assessment의 깨끗한 문항.
//       답 구조 셀(fold 허용, 허용 행동 수, 합법 행동 수)로 직접 표준화한다 — 항상 fold·합법 행동 무작위처럼 변하지 않는
//       정책은 셀 구성이 바뀌어도 차이가 0 근처다.
//   M2  재연습 없는 지연 유지: 기준 문항과 사후 창의 첫 retest 응답의 짝. 그 사이 같은 동치군 노출이 없고 24시간 이상 지난 짝만.
//   문항 동치군 = (source, chartId, handClass). 같은 차트의 같은 손패는 답이 같다.
//   일치(allowed)·fold 허용·허용 행동 수는 응답 당시 이벤트의 referenceActions(빈도 > 0)로만 정한다.
// 구간·실행 선택·판정 규칙은 아래 프로토콜 상수와 등록의 봉인 일정이 정한다. 결과를 본 뒤 바꾸지 않는다.
import { createHash } from 'node:crypto';
import { parsePreflopKeyV3 } from '../shared/preflop-key.js';
import { matchReferenceActionFor, validateMixObservation } from '../shared/reference.js';
import { studyHistory, validateLearningEvents } from './study-history.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const LEARNING_EFFECT_PROTOCOL_V1 = deepFreeze({
  id: 'learning-effect/1',
  scope: { referenceSchema: 3, unit: 'one participant (one store)', itemClass: ['source', 'chartId', 'handClass'] },
  plan: {
    baselineRuns: { default: 3, min: 2, max: 5 },
    interventionDays: { default: 7, min: 1, max: 28 },
    postDays: { default: 7, min: 3, max: 14 },
  },
  selection: { runs: 'first K assessment starts per window by start time (run ledger)', retention: 'first retest per baseline run started in the post window' },
  exposure: { trackBackDays: 7, kinds: ['answer of the same item class', 'chart view of the same chart'] },
  retention: { minDelayHours: 24 },
  cells: { keys: ['foldAllowed', 'allowedCount', 'legalCount'], legalCountByContext: { 'rfi-unopened': 2, push: 2, 'vs-shove': 2, 'vs-single-raise': 3, 'vs-3bet': 3 } },
  thresholds: { mde: 0.15, z: 1.96, minM1Items: 20, minM2Pairs: 10, maxMissingCellMass: 0.2 },
  gates: { m1: 'all K baseline and all K post slots complete', m2: 'all K retest slots complete', final: 'now >= postClosesAt' },
  verdict: { magnitude: 'raw standardized difference', uncertainty: 'adjusted interval' },
  inference: { m1: 'Agresti-Caffo per cell, directly standardized to baseline cell shares', m2: 'Agresti-Min (2005) matched-pairs Wald+2' },
  statement: '휴리스틱 기준표 일치도의 개인 전후 연관 관측(근사·탐색적)이다. 코칭의 인과 효과, 독립 전략 기준의 습득, 실제 테이블 전이·수익의 증거가 아니다.',
});

/** 키를 정렬한 정규 JSON. 봉인 해시는 이 문자열의 SHA-256이다. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sealHash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const PROTOCOL_SHA256 = sealHash(LEARNING_EFFECT_PROTOCOL_V1);

function effectError(code, message) {
  return Object.assign(new Error(message), { code });
}

const validIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const iso = (ms) => new Date(ms).toISOString();
const sameSource = (a, b) => a?.id === b?.id && a?.version === b?.version && (a?.contentSha256 ?? null) === (b?.contentSha256 ?? null);

/** 등록의 일정 봉인. 값은 프로토콜 범위 안의 정수만 받는다. */
export function sealPlan(input = {}, consentedAt) {
  if (!validIso(consentedAt)) throw effectError('BAD_PLAN', 'consentedAt must be a canonical ISO time');
  const P = LEARNING_EFFECT_PROTOCOL_V1.plan;
  const pick = (key) => {
    const value = input[key] === undefined ? P[key].default : input[key];
    if (!Number.isSafeInteger(value) || value < P[key].min || value > P[key].max) {
      throw effectError('BAD_PLAN', `${key}는 ${P[key].min}~${P[key].max} 정수입니다.`);
    }
    return value;
  };
  const plan = { baselineRuns: pick('baselineRuns'), interventionDays: pick('interventionDays'), postDays: pick('postDays') };
  const postOpensAt = iso(Date.parse(consentedAt) + plan.interventionDays * DAY_MS);
  const postClosesAt = iso(Date.parse(postOpensAt) + plan.postDays * DAY_MS);
  return { plan, postOpensAt, postClosesAt, planSha256: sealHash({ protocolId: LEARNING_EFFECT_PROTOCOL_V1.id, consentedAt, plan }) };
}

// ── 통계 ─────────────────────────────────────────────────────────────────────

const round = (value) => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10_000) / 10_000);

/** 셀별 Agresti–Caffo를 기준 셀 비율로 직접 표준화한다. cells: [{ w, x1, n1, x2, n2 }] (1 = 기준, 2 = 사후). */
export function standardizedDifference(cells, z = LEARNING_EFFECT_PROTOCOL_V1.thresholds.z) {
  let center = 0;
  let raw = 0;
  let variance = 0;
  for (const { w, x1, n1, x2, n2 } of cells) {
    const p1 = (x1 + 1) / (n1 + 2);
    const p2 = (x2 + 1) / (n2 + 2);
    center += w * (p2 - p1);
    raw += w * (x2 / n2 - x1 / n1);
    variance += w * w * (p1 * (1 - p1) / (n1 + 2) + p2 * (1 - p2) / (n2 + 2));
  }
  const se = Math.sqrt(variance);
  return { center, raw, se, ci: [center - z * se, center + z * se] };
}

/** Agresti–Min(2005) matched-pairs Wald+2: 네 칸에 0.5씩. n01 = 기준 불일치→재평가 일치, n10 = 그 반대. */
export function pairedDifference({ n01, n10, n }, z = LEARNING_EFFECT_PROTOCOL_V1.thresholds.z) {
  const nn = n + 2;
  const p01 = (n01 + 0.5) / nn;
  const p10 = (n10 + 0.5) / nn;
  const center = p01 - p10;
  const se = Math.sqrt(Math.max(0, p01 + p10 - center * center) / nn);
  return { center, raw: n ? (n01 - n10) / n : null, se, ci: [center - z * se, center + z * se] };
}

/**
 * 판정. 크기(MDE)와 방향은 **원자료** 표준화 차이(`raw`)로 본다 — 셀 기대 점수가 일정한 정책에서 정확히 0이다.
 * 보정 구간(`[lo, hi]`)은 불확실성 판정에만 쓴다(보정 중심은 셀 표본 크기가 다르면 0이 아닐 수 있다).
 */
export function verdictOf(raw, [lo, hi], mde = LEARNING_EFFECT_PROTOCOL_V1.thresholds.mde) {
  if (lo > 0 && raw >= mde) return 'IMPROVED';
  if (hi < 0 && raw <= -mde) return 'DECLINED';
  if (lo > -mde && hi < mde) return 'NO_MEANINGFUL_CHANGE';
  return 'INCONCLUSIVE';
}

// ── 문항 ─────────────────────────────────────────────────────────────────────

function observationOf(event) {
  try { return validateMixObservation(event.mixObservation); } catch { return null; }
}

/** 응답 이벤트 하나의 문항 정보. 지원하지 않는 문항이면 null. */
function itemOf(event, chartOf) {
  const observation = observationOf(event);
  if (!observation) return null;
  const parsed = parsePreflopKeyV3(observation.spotKey);
  const chartId = chartOf(observation.spotKey);
  const legalCount = parsed ? LEARNING_EFFECT_PROTOCOL_V1.cells.legalCountByContext[parsed.context] : undefined;
  const allowedRows = observation.referenceActions.filter((row) => row.frequency > 0);
  return {
    evaluationId: event.evaluationId,
    runId: event.studyRun?.id ?? null,
    index: event.studyRun?.index ?? null,
    at: event.appliedAt,
    spotKey: observation.spotKey,
    handClass: observation.handClass,
    chartId: typeof chartId === 'string' ? chartId : null,
    classKey: typeof chartId === 'string' ? JSON.stringify([chartId, observation.handClass]) : null,
    context: parsed?.context ?? null,
    seated: parsed?.seated ?? null,
    stackBb: parsed?.stackBb ?? null,
    legalCount: legalCount ?? null,
    allowed: (matchReferenceActionFor(observation.sourceIdentity, observation.referenceActions, observation.chosenAction)?.frequency ?? 0) > 0,
    foldAllowed: allowedRows.some((row) => row.action === 'fold'),
    allowedCount: allowedRows.length,
    sourceIdentity: observation.sourceIdentity,
  };
}

const cellKey = (item) => JSON.stringify([item.foldAllowed ? 1 : 0, item.allowedCount, item.legalCount]);

function countBy(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function tvd(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const na = Object.values(a).reduce((sum, v) => sum + v, 0);
  const nb = Object.values(b).reduce((sum, v) => sum + v, 0);
  if (!na || !nb) return null;
  let total = 0;
  for (const key of keys) total += Math.abs((a[key] ?? 0) / na - (b[key] ?? 0) / nb);
  return round(total / 2);
}

const rate = (items, pick) => (items.length ? round(items.filter(pick).length / items.length) : null);

// ── 지표(문항 객체 위의 순수 계산) ────────────────────────────────────────────

/**
 * M1. 깨끗한 문항 { allowed, foldAllowed, allowedCount, legalCount, ... } 두 집합의 답 구조 셀 표준화 차이와 판정.
 * `slotsComplete`가 거짓이면 판정 없이 INSUFFICIENT(INCOMPLETE_SLOTS)다(부분 자료는 기술값만).
 */
export function m1Of(baselineClean, postClean, { slotsComplete = true } = {}) {
  const T = LEARNING_EFFECT_PROTOCOL_V1.thresholds;
  const byCell = (items) => {
    const map = new Map();
    for (const item of items) {
      const key = cellKey(item);
      const cell = map.get(key) ?? { n: 0, x: 0 };
      cell.n += 1;
      if (item.allowed) cell.x += 1;
      map.set(key, cell);
    }
    return map;
  };
  const b = byCell(baselineClean);
  const p = byCell(postClean);
  const nBase = baselineClean.length;
  const nPost = postClean.length;
  const missingMass = nBase ? [...b.entries()].filter(([key]) => !p.has(key)).reduce((sum, [, cell]) => sum + cell.n / nBase, 0) : null;
  const common = [...b.keys()].filter((key) => p.has(key));
  const commonBase = common.reduce((sum, key) => sum + b.get(key).n, 0);
  const commonPost = common.reduce((sum, key) => sum + p.get(key).n, 0);
  const cells = [...new Set([...b.keys(), ...p.keys()])].sort().map((key) => {
    const [foldAllowed, allowedCount, legalCount] = JSON.parse(key);
    return { foldAllowed: foldAllowed === 1, allowedCount, legalCount, baseline: b.get(key) ?? { n: 0, x: 0 }, post: p.get(key) ?? { n: 0, x: 0 } };
  });
  const out = { nBase, nPost, nBaseCommon: commonBase, nPostCommon: commonPost, missingMass: round(missingMass), cells,
    rawRate: { baseline: rate(baselineClean, (item) => item.allowed), post: rate(postClean, (item) => item.allowed) },
    foldBaseline: { baseline: rate(baselineClean, (item) => item.foldAllowed), post: rate(postClean, (item) => item.foldAllowed) } };
  if (!slotsComplete) return { ...out, verdict: 'INSUFFICIENT', reason: 'INCOMPLETE_SLOTS' };
  if (nBase && missingMass > T.maxMissingCellMass) return { ...out, verdict: 'NON_COMPARABLE', reason: 'DISTRIBUTION_MISMATCH' };
  if (commonBase < T.minM1Items || commonPost < T.minM1Items) return { ...out, verdict: 'INSUFFICIENT', reason: 'TOO_FEW_CLEAN_ITEMS' };
  const diff = standardizedDifference(common.map((key) => ({
    w: b.get(key).n / commonBase, x1: b.get(key).x, n1: b.get(key).n, x2: p.get(key).x, n2: p.get(key).n,
  })));
  return { ...out, renormalized: missingMass > 0, raw: round(diff.raw), center: round(diff.center), se: round(diff.se),
    ci: diff.ci.map(round), verdict: verdictOf(diff.raw, diff.ci) };
}

/** M2. 깨끗한 짝 표 { n11, n10, n01, n00 }(첫 자리 기준, 둘째 자리 재평가)의 짝지은 차이와 판정. */
export function m2Of({ table, rehearsed = { n11: 0, n10: 0, n01: 0, n00: 0 }, excluded = {}, delays = [] }, { slotsComplete = true } = {}) {
  const T = LEARNING_EFFECT_PROTOCOL_V1.thresholds;
  const n = table.n11 + table.n10 + table.n01 + table.n00;
  const sorted = [...delays].sort((x, y) => x - y);
  const out = { n, table: { ...table }, excluded, rehearsed,
    delayHours: { n: sorted.length, min: round(sorted[0] ?? null), median: round(sorted.length ? sorted[(sorted.length - 1) >> 1] : null), max: round(sorted.at(-1) ?? null) } };
  if (!slotsComplete) return { ...out, verdict: 'INSUFFICIENT', reason: 'INCOMPLETE_SLOTS' };
  if (n < T.minM2Pairs) return { ...out, verdict: 'INSUFFICIENT', reason: 'TOO_FEW_CLEAN_PAIRS' };
  const diff = pairedDifference({ n01: table.n01, n10: table.n10, n });
  return { ...out, raw: round(diff.raw), center: round(diff.center), se: round(diff.se), ci: diff.ci.map(round), verdict: verdictOf(diff.raw, diff.ci) };
}

/** M1이 판정 가능할 때만 패턴을 붙인다. */
export function patternOf(m1, m2) {
  const evaluable = ['IMPROVED', 'DECLINED', 'NO_MEANINGFUL_CHANGE', 'INCONCLUSIVE'].includes(m1.verdict);
  if (!evaluable) return 'transfer-not-evaluable';
  return m2.verdict === 'IMPROVED' && m1.verdict !== 'IMPROVED' ? 'retention-without-transfer' : null;
}

// ── 평가 ─────────────────────────────────────────────────────────────────────

const timeOfRow = (row) => (row.type === 'start' ? row.startedAt : row.at);
const before = (iso1, iso2) => Date.parse(iso1) < Date.parse(iso2);
const minusMs = (value, ms) => new Date(Date.parse(value) - ms).toISOString();

/**
 * 한 구간의 측정 실행 슬롯. 완료 여부로 고르지 않는다 — **확인된** 시작 가운데 시작 순서로 처음 K개다.
 * 시작 확인: 그 runId의 응답 이벤트가 있거나, 지금 세션이 그 실행이거나, 뒤 교체 행이 그 실행을 교체했다.
 */
function slotsOf({ starts, from, to, k, source, history, confirmed, mode, extraFilter = () => true }) {
  const inWindow = starts.filter((row) => row.mode === mode && !before(row.startedAt, from) && before(row.startedAt, to) && extraFilter(row));
  const mismatched = inWindow.filter((row) => !sameSource(row.sourceIdentity, source));
  const own = inWindow.filter((row) => sameSource(row.sourceIdentity, source));
  const empty = own.filter((row) => row.runId === null);
  const unconfirmed = own.filter((row) => row.runId !== null && !confirmed(row.runId));
  const real = own.filter((row) => row.runId !== null && confirmed(row.runId));
  const runsById = new Map([...history.assessments, ...history.retests].map((run) => [run.id, run]));
  const selected = real.slice(0, k).map((row) => {
    const run = runsById.get(row.runId) ?? null;
    return { runId: row.runId, startId: row.startId, startedAt: row.startedAt, total: row.total, assessmentId: row.assessmentId ?? null,
      status: run?.complete ? 'complete' : run ? (run.reason ?? 'INCOMPLETE_RUN') : 'UNANSWERED' };
  });
  return {
    selected,
    denominators: {
      planned: k, started: real.length, selected: selected.length, notStarted: Math.max(0, k - selected.length),
      extra: Math.max(0, real.length - k), unconfirmedStarts: unconfirmed.length, emptyQueueStarts: empty.length,
      sourceMismatch: mismatched.length, byStatus: countBy(selected, (entry) => entry.status),
    },
  };
}

/** 등록 한 건이 평가 가능한지의 불가 사유(순서 보존). 철회·미등록은 호출 전에 걸러진다. */
export function enrollmentReasons({ enrollment, runLog, sourceAvailable }) {
  const P = LEARNING_EFFECT_PROTOCOL_V1;
  const reasons = [];
  if (enrollment.protocolId !== P.id || enrollment.protocolSha256 !== PROTOCOL_SHA256) reasons.push('PROTOCOL_MISMATCH');
  let sealed = null;
  try { sealed = sealPlan(enrollment.plan, enrollment.consentedAt); } catch { reasons.push('PLAN_INVALID'); }
  if (sealed && (sealed.planSha256 !== enrollment.planSha256 || sealed.postOpensAt !== enrollment.postOpensAt
    || sealed.postClosesAt !== enrollment.postClosesAt)) reasons.push('PLAN_SEAL_MISMATCH');
  if (!sourceAvailable) reasons.push('SOURCE_UNAVAILABLE');
  if (runLog?.status !== 'ok' || Date.parse(runLog.ledger.coverageFrom) > Date.parse(enrollment.consentedAt)) reasons.push('RUN_LOG_INCOMPLETE');
  return reasons;
}

/**
 * 등록의 측정 슬롯(기준·사후·retest 유지 측정)과 그 계산에 쓰는 중간값. 평가기와 학습 화면의 등록 뷰가 같은 규칙을 쓰도록 분리했다.
 * valid는 validateLearningEvents를 거친 이벤트다.
 */
export function measurementSlots({ valid, runLog, enrollment, now, currentRunId = null }) {
  const { consentedAt, postOpensAt, postClosesAt, source } = enrollment;
  const k = enrollment.plan.baselineRuns;
  const final = !before(now, postClosesAt);
  // 기준 실행은 사후 창이 열리기 전에 완료돼야 한다. 사후·retest는 창이 닫히기 전(appliedAt < postClosesAt)의 응답만 본다.
  const baseAsOf = minusMs(postOpensAt, 1);
  const postAsOf = final ? minusMs(postClosesAt, 1) : now;
  const historyBase = studyHistory(valid, before(now, baseAsOf) ? now : baseAsOf);
  const historyPost = studyHistory(valid, postAsOf);
  const runRows = [...runLog.ledger.rows].sort((a, b) => Date.parse(timeOfRow(a)) - Date.parse(timeOfRow(b)));
  const starts = runRows.filter((row) => row.type === 'start' && !before(row.startedAt, consentedAt) && !before(postAsOf, row.startedAt));
  const answeredRuns = new Set(valid.map((event) => event.studyRun?.id).filter(Boolean));
  const replacedRuns = new Set(runRows.filter((row) => row.type === 'replace').map((row) => row.replacedRunId));
  const confirmed = (runId) => answeredRuns.has(runId) || runId === currentRunId || replacedRuns.has(runId);
  const baseline = slotsOf({ starts, from: consentedAt, to: postOpensAt, k, source, history: historyBase, confirmed, mode: 'assessment' });
  const post = slotsOf({ starts, from: postOpensAt, to: postClosesAt, k, source, history: historyPost, confirmed, mode: 'assessment' });
  const retestStarts = starts.filter((row) => row.mode === 'retest');
  // retest 슬롯은 항상 K개다. 기준 슬롯이 없거나 기준이 사후 창 전에 끝나지 않았으면 그 retest는 유지 측정이 아니다.
  const retention = Array.from({ length: k }, (_, i) => {
    const entry = baseline.selected[i];
    if (!entry) return { assessmentId: null, runId: null, startedAt: null, status: 'NO_BASELINE' };
    const slot = slotsOf({ starts: retestStarts, from: postOpensAt, to: postClosesAt, k: 1, source, history: historyPost, confirmed,
      mode: 'retest', extraFilter: (row) => row.assessmentId === entry.runId });
    const picked = slot.selected[0] ?? { runId: null, startedAt: null, status: 'NOT_STARTED' };
    return { assessmentId: entry.runId, ...picked,
      status: entry.status !== 'complete' && picked.status === 'complete' ? 'BASELINE_INCOMPLETE' : picked.status };
  });
  // 사후 창 retest 시작 전체의 분모(첫 retest 말고 나머지·미확인·빈 큐·다른 source·기준 아닌 평가의 retest).
  const retestWindow = slotsOf({ starts: retestStarts, from: postOpensAt, to: postClosesAt, k: 0, source, history: historyPost, confirmed, mode: 'retest' });
  return { k, final, baseAsOf, postAsOf, historyBase, historyPost, runRows, starts, baseline, post, retention, retestWindow, retestStarts };
}

/**
 * evaluateLearningEffect({ events, exposureLog, runLog, enrollment, now, chartOf, stratumOf, currentRunId, inputs })
 *   events        검증 전 프로필 이벤트 배열(전체 이력)
 *   exposureLog   노출 원장 판독 결과, runLog: 실행 원장 판독 결과({ status, ledger })
 *   enrollment    등록 기록 한 건(없으면 NOT_ENROLLED)
 *   chartOf(spotKey)  등록 source 데이터셋의 chartId(없으면 null). 함수가 없으면 SOURCE_UNAVAILABLE.
 *   stratumOf(spotKey, handClass)  기술용 난이도 층. currentRunId: 지금 세션의 실행 id(시작 확인용).
 *   inputs        보고서에 싣는 입력 파일 digest(호출자가 계산).
 * 같은 입력이면 같은 보고서다. 보고서는 현재 보존된 자료로 다시 계산한 값이다(원장 상한·손상 뒤에는 달라질 수 있다).
 */
export function evaluateLearningEffect({ events, exposureLog, runLog, enrollment, now, chartOf, stratumOf = () => null, currentRunId = null, inputs = null }) {
  const P = LEARNING_EFFECT_PROTOCOL_V1;
  if (!validIso(now)) throw effectError('BAD_EVALUATION', 'now must be a canonical ISO time');
  const base = {
    schema: 'learning-effect-report/1',
    protocol: { id: P.id, sha256: PROTOCOL_SHA256 },
    enrollment: enrollment ? {
      id: enrollment.id, source: enrollment.source, consentedAt: enrollment.consentedAt, plan: enrollment.plan,
      postOpensAt: enrollment.postOpensAt, postClosesAt: enrollment.postClosesAt, withdrawnAt: enrollment.withdrawnAt ?? null,
    } : null,
    now,
    inputs,
    statement: P.statement,
    scope: '추적 가능한 노출(측정·연습 응답, 관측이 있는 게임 응답, 차트 열람) 기준이다.',
  };
  if (!enrollment) return { ...base, status: 'NOT_ENROLLED', reasons: [] };
  if (enrollment.withdrawnAt) return { ...base, status: 'WITHDRAWN', reasons: [] };
  const reasons = enrollmentReasons({ enrollment, runLog, sourceAvailable: typeof chartOf === 'function' });
  if (reasons.length) return { ...base, status: 'NON_COMPARABLE', reasons };

  const { consentedAt, postOpensAt, postClosesAt, source } = enrollment;
  const k = enrollment.plan.baselineRuns;
  const schedule = { consentedAt, postOpensAt, postClosesAt };
  const valid = validateLearningEvents(events);
  const { final, baseAsOf, postAsOf, historyPost, runRows, starts, baseline, post, retention, retestWindow } = measurementSlots({
    valid, runLog, enrollment, now, currentRunId });
  const selectedRetests = new Set(retention.map((entry) => entry.runId).filter(Boolean));
  // 기준표 답이 있는(supported) 결정인데 관측이 없어(coverage 투영·보조 사용) 동치군을 알 수 없는 것만 센다.
  const untrackedDecisions = valid.filter((event) => event.status === 'supported' && sameSource(event.sourceIdentity, source) && !observationOf(event)
    && validIso(event.appliedAt) && !before(event.appliedAt, minusMs(consentedAt, P.exposure.trackBackDays * DAY_MS))
    && before(event.appliedAt, postClosesAt)).length;
  const runs = {
    baseline: baseline.denominators, post: post.denominators,
    retention: { planned: k, byStatus: countBy(retention, (entry) => entry.status),
      started: retestWindow.denominators.started, extra: retestWindow.denominators.started - selectedRetests.size,
      unconfirmedStarts: retestWindow.denominators.unconfirmedStarts, emptyQueueStarts: retestWindow.denominators.emptyQueueStarts,
      sourceMismatch: retestWindow.denominators.sourceMismatch },
    interventionRetests: starts.filter((row) => row.mode === 'retest' && before(row.startedAt, postOpensAt)).length,
    replacements: runRows.filter((row) => row.type === 'replace' && !before(row.at, consentedAt) && !before(postAsOf, row.at)).length,
    untrackedDecisions,
  };
  if (!final) return { ...base, status: 'INTERIM', reasons: [], schedule: { ...schedule, asOf: now }, runs };

  // ── 노출 사건 ───────────────────────────────────────────────────────────────
  // 알려진 양성 노출(이벤트·원장에 남은 것)은 시각 제한 없이 본다. 완전성(coverage)은 추적 시작부터만 요구한다.
  const trackStart = minusMs(consentedAt, P.exposure.trackBackDays * DAY_MS);
  const exposureOk = exposureLog?.status === 'ok';
  const exposureCovered = exposureOk && Date.parse(exposureLog.ledger.coverageFrom) <= Date.parse(trackStart);
  const answers = [];
  for (const event of valid) {
    const observation = observationOf(event);
    if (!observation || !sameSource(observation.sourceIdentity, source) || !validIso(event.appliedAt)) continue;
    const chartId = chartOf(observation.spotKey);
    if (typeof chartId !== 'string') continue;
    answers.push({ evaluationId: event.evaluationId, runId: event.studyRun?.id ?? null, at: Date.parse(event.appliedAt),
      classKey: JSON.stringify([chartId, observation.handClass]) });
  }
  const views = (exposureOk ? exposureLog.ledger.rows : [])
    .filter((row) => sameSource(row.sourceIdentity, source))
    .map((row) => ({ at: Date.parse(row.at), chartId: chartOf(row.spotKey) }))
    .filter((row) => typeof row.chartId === 'string');

  const itemsOfRun = (runId, asOfIso) => {
    const out = [];
    let ineligible = 0;
    const indices = new Set();
    let events = 0;
    for (const event of valid) {
      if (event.studyRun?.id !== runId || Date.parse(event.appliedAt) > Date.parse(asOfIso)) continue;
      events += 1;
      if (Number.isSafeInteger(event.studyRun.index)) indices.add(event.studyRun.index);
      const item = itemOf(event, chartOf);
      if (!item || item.classKey === null || item.legalCount === null) ineligible += 1;
      else out.push(item);
    }
    return { items: out.sort((a, b) => a.index - b.index), ineligible, indices, events };
  };
  // 점수에 쓰지 않는 실행의 문항 분모: 계획 문항 인덱스마다 응답 여부를 센다. 같은 인덱스의 중복 이벤트는 문항이 아니라
  // 진단값(`duplicateEvents`)이다 — 그래야 n + 제외 합이 계획 문항 수와 맞는다.
  // 계획 범위 밖의 고유 인덱스(원장과 이벤트의 문항 수 불일치)는 `outOfPlanIndices`로 따로 센다.
  const diagnostics = { duplicateEvents: 0, outOfPlanIndices: 0 };
  const unscored = (entry, run, exclude, answeredReason = 'INCOMPLETE_RUN') => {
    const answered = [...run.indices].filter((index) => index >= 0 && index < entry.total).length;
    diagnostics.duplicateEvents += Math.max(0, run.events - run.indices.size);
    diagnostics.outOfPlanIndices += run.indices.size - answered;
    exclude(answeredReason, answered);
    exclude('UNANSWERED', Math.max(0, entry.total - answered));
  };

  // M1 문항 적격: 그 문항의 응답 직전까지 같은 동치군의 노출 사건이 없어야 깨끗하다(자기 응답 제외).
  const classify = (selection, asOfIso) => {
    const clean = [];
    const excluded = {};
    const exclude = (reason, n = 1) => { if (n) excluded[reason] = (excluded[reason] ?? 0) + n; };
    let planned = 0;
    for (const entry of selection.selected) {
      planned += entry.total;
      const run = itemsOfRun(entry.runId, asOfIso);
      const { items, ineligible } = run;
      if (entry.status !== 'complete') {
        // 미완료 슬롯의 응답은 점수에 쓰지 않는다. 응답한 문항·답하지 않은 문항을 사유별로 센다(0점으로 접지 않는다).
        unscored(entry, run, exclude);
        continue;
      }
      exclude('INELIGIBLE_EVENT', ineligible);
      for (const item of items) {
        const at = Date.parse(item.at);
        const prior = answers.filter((answer) => answer.classKey === item.classKey && answer.at <= at && answer.evaluationId !== item.evaluationId);
        if (prior.some((answer) => answer.runId === entry.runId)) exclude('DUPLICATE_CLASS');
        else if (prior.length) exclude('KNOWN_EXPOSURE_ANSWER');
        else if (views.some((view) => view.chartId === item.chartId && view.at <= at)) exclude('KNOWN_EXPOSURE_CHART');
        else if (!exposureCovered) exclude('EXPOSURE_UNKNOWN');
        else clean.push(item);
      }
    }
    return { clean, excluded, planned };
  };
  const baseAsOfFinal = baseAsOf;
  const baselineItems = classify(baseline, baseAsOfFinal);
  const postItems = classify(post, postAsOf);
  const slotsComplete = (selection) => selection.selected.length === k && selection.selected.every((entry) => entry.status === 'complete');

  // ── M1 ─────────────────────────────────────────────────────────────────────
  const m1 = m1Of(baselineItems.clean, postItems.clean, { slotsComplete: slotsComplete(baseline) && slotsComplete(post) });

  // ── M2 ─────────────────────────────────────────────────────────────────────
  const m2 = (() => {
    const table = { n11: 0, n10: 0, n01: 0, n00: 0 };
    const rehearsed = { n11: 0, n10: 0, n01: 0, n00: 0 };
    const excluded = {};
    const delays = [];
    const exclude = (reason, n = 1) => { if (n) excluded[reason] = (excluded[reason] ?? 0) + n; };
    const tally = (into, b, r) => { into[`n${b ? 1 : 0}${r ? 1 : 0}`] += 1; };
    let planned = 0;
    for (const entry of retention.filter((candidate) => candidate.runId !== null)) {
      planned += entry.total;
      const retest = itemsOfRun(entry.runId, postAsOf);
      if (entry.status !== 'complete') {
        // 점수에 쓰지 않는 retest의 문항도 분모에 남긴다: 기준 미완료면 그 사유로, 미완료 retest면 응답·미응답으로.
        if (entry.status === 'BASELINE_INCOMPLETE') {
          exclude('BASELINE_INCOMPLETE', entry.total);
          diagnostics.duplicateEvents += Math.max(0, retest.events - retest.indices.size);
        } else unscored(entry, retest, exclude);
        continue;
      }
      const baselineByPair = new Map(itemsOfRun(entry.assessmentId, baseAsOfFinal).items.map((item) => [`${item.spotKey}:${item.handClass}`, item]));
      exclude('INELIGIBLE_EVENT', retest.ineligible);
      for (const r of retest.items) {
        const b = baselineByPair.get(`${r.spotKey}:${r.handClass}`);
        if (!b) { exclude('INELIGIBLE_EVENT'); continue; }
        const bAt = Date.parse(b.at);
        const rAt = Date.parse(r.at);
        // 두 끝(기준 응답·재평가 응답)을 뺀 사이의 노출. 같은 시각은 순서를 알 수 없으므로 노출로 본다.
        const between = answers.some((answer) => answer.classKey === b.classKey && answer.at >= bAt && answer.at <= rAt
          && answer.evaluationId !== b.evaluationId && answer.evaluationId !== r.evaluationId)
          || views.some((view) => view.chartId === b.chartId && view.at >= bAt && view.at <= rAt);
        if (between) { exclude('REHEARSED'); tally(rehearsed, b.allowed, r.allowed); continue; }
        if (Date.parse(entry.startedAt) - bAt < P.retention.minDelayHours * HOUR_MS) { exclude('DELAY_TOO_SHORT'); continue; }
        if (!exposureCovered) { exclude('EXPOSURE_UNKNOWN'); continue; }
        tally(table, b.allowed, r.allowed);
        delays.push((rAt - bAt) / HOUR_MS);
      }
    }
    return { ...m2Of({ table, rehearsed, excluded, delays },
      { slotsComplete: retention.length === k && retention.every((entry) => entry.status === 'complete') }), planned };
  })();

  const pattern = patternOf(m1, m2);

  // ── 기술 통계(효과 지표 아님) ─────────────────────────────────────────────────
  const describeItems = (items) => ({
    strata: countBy(items, (item) => stratumOf(item.spotKey, item.handClass) ?? 'unknown'),
    contexts: countBy(items, (item) => item.context ?? 'unknown'),
    seated: countBy(items, (item) => String(item.seated ?? 'unknown')),
    stackBb: countBy(items, (item) => String(item.stackBb ?? 'unknown')),
  });
  const db = describeItems(baselineItems.clean);
  const dp = describeItems(postItems.clean);
  const selectedIds = new Set([...baseline.selected, ...post.selected, ...retention].map((entry) => entry.runId).filter(Boolean));
  // 기술값은 등록 source의 적격 문항만, 연습과 게임을 나눠 싣는다. 사후 창의 비측정 활동도 따로 싣는다.
  const activityIn = (fromIso, toIso) => {
    const rows = valid.filter((event) => !before(event.appliedAt, fromIso) && before(event.appliedAt, toIso) && !selectedIds.has(event.studyRun?.id))
      .map((event) => ({ event, item: itemOf(event, chartOf) }))
      .filter(({ item }) => item && item.classKey !== null && item.legalCount !== null && sameSource(item.sourceIdentity, source));
    const part = (origin) => {
      const items = rows.filter(({ event }) => (['practice', 'drill', 'retest'].includes(event.origin) ? 'practice' : 'game') === origin).map(({ item }) => item);
      return { answers: items.length, allowedRate: rate(items, (item) => item.allowed) };
    };
    return {
      practice: part('practice'), game: part('game'),
      chartViews: views.filter((view) => view.at >= Date.parse(fromIso) && view.at < Date.parse(toIso)).length,
    };
  };
  const descriptive = {
    baseline: db, post: dp,
    tvd: { strata: tvd(db.strata, dp.strata), contexts: tvd(db.contexts, dp.contexts), seated: tvd(db.seated, dp.seated), stackBb: tvd(db.stackBb, dp.stackBb) },
    intervention: activityIn(consentedAt, postOpensAt),
    postWindowActivity: activityIn(postOpensAt, postClosesAt),
    unknownPreTrackingExposure: historyPost.unknownPreTrackingExposure,
  };
  return {
    ...base,
    status: 'FINAL',
    reasons: [],
    schedule: { ...schedule, asOf: postClosesAt },
    runs,
    items: { baseline: { planned: baselineItems.planned, clean: baselineItems.clean.length, excluded: baselineItems.excluded },
      post: { planned: postItems.planned, clean: postItems.clean.length, excluded: postItems.excluded } },
    exposure: { ledgerStatus: exposureLog?.status ?? 'absent', covered: exposureCovered, trackStart },
    m1, m2, pattern, descriptive, diagnostics,
    caveats: [
      '보고서는 현재 보존된 자료로 다시 계산한 값이다. 최종 결과를 남기려면 report --json 출력을 저장하라(inputs에 입력 digest가 있다).',
      '판정의 크기는 원자료 표준화 차이, 불확실성은 보정 구간이다. 문항 독립을 가정한 근사이고 같은 실행·같은 차트 안의 상관은 다루지 않았다(탐색적 개인 관측).',
      '표본 하한(M1 20문항, M2 10짝)은 계산 허용 하한이다. 검정력 보장이 아니다.',
      '추적 시작(등록 7일 전) 이전의 노출, 관측이 없는 게임 결정(untrackedDecisions), 코치 노트 속 다른 손패 언급은 문항 단위로 알 수 없다.',
      '휴리스틱 기준표 일치도다. 독립 전략 기준·실제 테이블 전이·수익을 재지 않는다.',
    ],
  };
}
