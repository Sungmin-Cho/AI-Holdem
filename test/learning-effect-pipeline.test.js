// #298: 평가기 파이프라인 — 봉인 일정·슬롯·시간 경계·노출·재연습·상태. 이벤트는 실제 drill 경로가 만든 v3 응답을
// 실행 id와 시각만 바꿔 다시 쓴 것이다(재채점 없음). 합성 시나리오는 규칙 검증이지 사용자 학습 효과의 증거가 아니다.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { answerQuestion, nextQuestion, startDrill } from '../tools/drill-cli.js';
import { createProfileStore } from '../tools/training-stores.js';
import { loadReferenceDataset } from '../tools/preflop-dataset.js';
import { lookup } from '../training/providers/preflop-json.js';
import { V2_REFERENCE_SOURCE, V3_REFERENCE_SOURCE } from '../shared/reference.js';
import { LEARNING_EFFECT_PROTOCOL_V1, PROTOCOL_SHA256, evaluateLearningEffect, sealPlan } from '../training/learning-effect.js';

const source = { ...V3_REFERENCE_SOURCE };
const dataset = loadReferenceDataset(source);
const chartOf = (spotKey) => dataset.data.spots[spotKey] ?? null;
const DAY = 86_400_000;
const C = Date.parse('2026-10-01T00:00:00.000Z');
const at = (ms) => new Date(C + ms).toISOString();
const H = 3_600_000;
const M = 60_000;

// 실제 drill 경로로 v3 문항에 답한다. pick: 'top'(기준표 최빈 행동) | 'off'(빈도 0인 합법 행동, 없으면 top).
function choose(question, pick) {
  const found = lookup(dataset, question.prompt);
  const legal = question.prompt.legalActions.map((entry) => {
    const [action, size] = entry.split(':');
    return { action, ...(size ? { sizeBb: Number(size) } : {}) };
  });
  const freq = (action) => (found.status === 'supported' ? found.actions.find((row) => row.action === action)?.frequency ?? 0 : 0);
  const top = [...legal].sort((a, b) => freq(b.action) - freq(a.action))[0];
  if (pick === 'off') return legal.find((row) => freq(row.action) === 0) ?? top;
  return top;
}

async function answerRun(storeDir, started, pick) {
  for (;;) {
    const next = await nextQuestion(storeDir);
    if (next.done || !next.question) return;
    const choice = choose(next.question, typeof pick === 'function' ? pick(next.index) : pick);
    await answerQuestion(storeDir, { sessionId: started.sessionId, questionId: next.question.questionId, attemptNo: next.index, ...choice });
  }
}

const pool = { runs: [], store: null };
async function eventsOf(storeDir) {
  return createProfileStore(storeDir).readEventSnapshot();
}

before(async () => {
  pool.store = createOwnedTempDir('effect-pool');
  // 서로 다른 미응답 문항으로 된 assessment 여섯 개. 일치 패턴을 섞어 둔다.
  const picks = ['top', 'off', (i) => (i % 2 ? 'top' : 'off'), 'top', 'off', 'off'];
  for (const [i, pick] of picks.entries()) {
    const started = await startDrill(pool.store, { mode: 'assessment', source, seed: `pool-${i}` });
    await answerRun(pool.store, started, pick);
  }
  const events = await eventsOf(pool.store);
  const byRun = new Map();
  for (const event of events) {
    if (!byRun.has(event.studyRun.id)) byRun.set(event.studyRun.id, []);
    byRun.get(event.studyRun.id).push(event);
  }
  pool.runs = [...byRun.values()].map((run) => run.sort((a, b) => a.studyRun.index - b.studyRun.index));
});

const hex = () => randomBytes(32).toString('hex');
function relabel(event, { runId = null, mode = null, total = null, index = null, startedAt = null, assessmentId = null, appliedAt }) {
  const id = hex();
  const [, decision, provider] = event.evaluationId.split(':');
  const copy = structuredClone(event);
  copy.evaluationId = `${id}:${decision}:${provider}`;
  copy.payloadSha256 = id;
  copy.appliedAt = appliedAt;
  if (runId) copy.studyRun = { id: runId, mode, total, index, startedAt, ...(assessmentId ? { assessmentId } : {}) };
  else delete copy.studyRun;
  return copy;
}

// 한 실행을 그 시각에 다시 쓴다. 응답은 시작 1분 뒤부터 1분 간격이다.
function placeRun(events, { mode = 'assessment', startMs, assessmentId = null, answerOffsetMs = M, runId = randomUUID() }) {
  const startedAt = at(startMs);
  const placed = events.map((event, index) => relabel(event, {
    runId, mode, total: events.length, index, startedAt, assessmentId, appliedAt: at(startMs + answerOffsetMs + index * M),
  }));
  const row = { type: 'start', startId: randomUUID(), runId, mode, total: events.length, startedAt, sourceIdentity: source,
    ...(assessmentId ? { assessmentId } : {}) };
  return { runId, events: placed, row };
}

function enrollment(plan = { baselineRuns: 2 }) {
  const consentedAt = at(0);
  const sealed = sealPlan(plan, consentedAt);
  return { id: randomUUID(), protocolId: LEARNING_EFFECT_PROTOCOL_V1.id, protocolSha256: PROTOCOL_SHA256, source, consentedAt,
    plan: sealed.plan, planSha256: sealed.planSha256, postOpensAt: sealed.postOpensAt, postClosesAt: sealed.postClosesAt, withdrawnAt: null };
}

const ledger = (kind, rows, coverageFrom) => ({ status: 'ok', ledger: { schemaVersion: 1, kind, createdAt: coverageFrom, coverageFrom, rows,
  dropped: 0, droppedThrough: null, resets: [] } });

// 기본 시나리오: K=2. 기준 2회(동의 +1h, +2h), 사후 2회(+8d, +8d+1h), 기준마다 retest(+9d, +9d+1h). 평가 시각 +15d.
function scenario(overrides = {}) {
  const [b1, b2, p1, p2] = pool.runs;
  const baseline = [placeRun(b1, { startMs: 1 * H }), placeRun(b2, { startMs: 2 * H })];
  const post = [placeRun(p1, { startMs: 8 * DAY }), placeRun(p2, { startMs: 8 * DAY + H })];
  const retests = baseline.map((run, i) => placeRun(i === 0 ? b1 : b2, { mode: 'retest', startMs: 9 * DAY + i * H, assessmentId: run.runId }));
  const parts = { baseline, post, retests, extraEvents: [], extraRows: [], exposureRows: [], ...overrides };
  const events = [...parts.baseline, ...parts.post, ...parts.retests].flatMap((run) => run.events).concat(parts.extraEvents);
  const rows = [...parts.baseline, ...parts.post, ...parts.retests].map((run) => run.row).concat(parts.extraRows);
  return {
    parts,
    input: {
      events, enrollment: parts.enrollment ?? enrollment(), now: parts.now ?? at(15 * DAY), chartOf,
      runLog: parts.runLog ?? ledger('run', rows, at(0)),
      exposureLog: parts.exposureLog ?? ledger('exposure', parts.exposureRows, at(-7 * DAY)),
      currentRunId: parts.currentRunId ?? null,
    },
  };
}

const sumExcluded = (excluded) => Object.values(excluded).reduce((sum, n) => sum + n, 0);

test('the full sealed schedule gives a FINAL report with every slot complete and every item accounted for', () => {
  const { input } = scenario();
  const report = evaluateLearningEffect(input);
  assert.equal(report.status, 'FINAL', JSON.stringify(report.reasons));
  assert.deepEqual(report.runs.baseline.byStatus, { complete: 2 });
  assert.deepEqual(report.runs.post.byStatus, { complete: 2 });
  assert.deepEqual(report.runs.retention.byStatus, { complete: 2 });
  assert.equal(report.items.baseline.clean + sumExcluded(report.items.baseline.excluded), 20);
  assert.equal(report.items.post.clean + sumExcluded(report.items.post.excluded), 20);
  assert.equal(report.m2.n + sumExcluded(report.m2.excluded), 20);
  assert.notEqual(report.m1.reason, 'INCOMPLETE_SLOTS');
  assert.equal(report.exposure.covered, true);
  assert.match(report.statement, /연관 관측/);
  assert.ok(['IMPROVED', 'DECLINED', 'NO_MEANINGFUL_CHANGE', 'INCONCLUSIVE'].includes(report.m1.verdict), report.m1.verdict);
  assert.ok(Array.isArray(report.m1.ci) && report.m1.ci[0] < report.m1.ci[1]);
  // retest가 기준 응답을 그대로 재현하므로(같은 선택) 불일치 짝이 없다: 20짝에서 변화 없음으로 판정된다.
  assert.equal(report.m2.table.n10 + report.m2.table.n01, 0);
  assert.equal(report.m2.n, 20);
  assert.equal(report.m2.verdict, 'NO_MEANINGFUL_CHANGE');
  assert.equal(report.pattern, null);
});

test('memorization only: the same items improve on retest while new items do not — retention without transfer', async () => {
  const [, off1, , , off2, off3] = pool.runs;
  // 기준과 사후는 모두 빈도 0 행동을 고른 실행이다. retest는 같은 문항을 기준표 최빈 행동으로 다시 답한다.
  const store = createOwnedTempDir('effect-memorize');
  const retestFor = async (run) => {
    const out = [];
    for (const [i, event] of run.entries()) {
      const started = await startDrill(store, { mode: 'free', source, seed: `m-${i}-${event.mixObservation.spotKey}`,
        spotKey: event.mixObservation.spotKey, handClass: event.mixObservation.handClass });
      await answerRun(store, started, 'top');
    }
    const all = await eventsOf(store);
    for (const event of run) {
      out.push(all.findLast((candidate) => candidate.mixObservation.spotKey === event.mixObservation.spotKey
        && candidate.mixObservation.handClass === event.mixObservation.handClass));
    }
    return out;
  };
  const baseline = [placeRun(off1, { startMs: 1 * H }), placeRun(off2, { startMs: 2 * H })];
  const retests = [
    placeRun(await retestFor(off1), { mode: 'retest', startMs: 9 * DAY, assessmentId: baseline[0].runId }),
    placeRun(await retestFor(off2), { mode: 'retest', startMs: 9 * DAY + H, assessmentId: baseline[1].runId }),
  ];
  const [, , mixed] = pool.runs;
  const post = [placeRun(off3, { startMs: 8 * DAY }), placeRun(mixed, { startMs: 8 * DAY + H })];
  const report = evaluateLearningEffect(scenario({ baseline, post, retests }).input);
  assert.equal(report.status, 'FINAL');
  assert.ok(report.m2.table.n01 >= 10, JSON.stringify(report.m2.table));
  assert.equal(report.m2.table.n10, 0);
  assert.equal(report.m2.verdict, 'IMPROVED');
  assert.notEqual(report.m1.verdict, 'IMPROVED', JSON.stringify(report.m1.rawRate));
  assert.equal(report.pattern, 'retention-without-transfer');
});

test('status gates: not enrolled, withdrawn, interim before the post window closes, tampered seal, late run ledger', () => {
  const { input } = scenario();
  assert.equal(evaluateLearningEffect({ ...input, enrollment: null }).status, 'NOT_ENROLLED');
  assert.equal(evaluateLearningEffect({ ...input, enrollment: { ...input.enrollment, withdrawnAt: at(DAY) } }).status, 'WITHDRAWN');
  const interim = evaluateLearningEffect({ ...input, now: at(10 * DAY) });
  assert.equal(interim.status, 'INTERIM');
  assert.equal(interim.m1, undefined, 'no verdict before the window closes, even with every slot complete');
  const tampered = evaluateLearningEffect({ ...input, enrollment: { ...input.enrollment, postClosesAt: at(9 * DAY) } });
  assert.deepEqual([tampered.status, tampered.reasons], ['NON_COMPARABLE', ['PLAN_SEAL_MISMATCH']]);
  const late = evaluateLearningEffect({ ...input, runLog: ledger('run', input.runLog.ledger.rows, at(1)) });
  assert.deepEqual([late.status, late.reasons], ['NON_COMPARABLE', ['RUN_LOG_INCOMPLETE']]);
  assert.deepEqual(evaluateLearningEffect({ ...input, chartOf: undefined }).reasons, ['SOURCE_UNAVAILABLE']);
});

test('a baseline run finished after the post window opened, or a post run finished after it closed, is not a complete slot', () => {
  const [b1, b2] = pool.runs;
  const crossing = scenario({ baseline: [placeRun(b1, { startMs: 1 * H }), placeRun(b2, { startMs: 7 * DAY - 5 * M })] });
  const base = evaluateLearningEffect(crossing.input);
  assert.equal(base.status, 'FINAL');
  assert.equal(base.runs.baseline.byStatus.complete, 1);
  assert.equal(base.m1.verdict, 'INSUFFICIENT');
  assert.equal(base.m1.reason, 'INCOMPLETE_SLOTS');
  const [, , p1, p2] = pool.runs;
  const lateRun = scenario({ post: [placeRun(p1, { startMs: 8 * DAY }), placeRun(p2, { startMs: 14 * DAY - 5 * M })] });
  const post = evaluateLearningEffect(lateRun.input);
  assert.equal(post.runs.post.byStatus.complete, 1);
  assert.equal(post.m1.reason, 'INCOMPLETE_SLOTS');
});

test('slots: an unstarted slot, an abandoned run that was replaced, an unconfirmed start and another source are each counted, never scored as zero', () => {
  const [, , p1] = pool.runs;
  const onlyOne = scenario({ post: [placeRun(p1, { startMs: 8 * DAY })] });
  const one = evaluateLearningEffect(onlyOne.input);
  assert.equal(one.runs.post.notStarted, 1);
  assert.equal(one.m1.reason, 'INCOMPLETE_SLOTS');

  const abandoned = randomUUID();
  const replaced = scenario({ extraRows: [
    { type: 'start', startId: randomUUID(), runId: abandoned, mode: 'assessment', total: 10, startedAt: at(8 * DAY - H), sourceIdentity: source },
  ] });
  // 응답 0건 실행이 사후 창 앞에서 시작됐다(개입 활동). 사후 창 안의 미확인 시작과 확인된 교체를 따로 본다.
  const unconfirmedRun = randomUUID();
  const confirmedRun = randomUUID();
  const s = scenario({ extraRows: [
    { type: 'start', startId: randomUUID(), runId: unconfirmedRun, mode: 'assessment', total: 10, startedAt: at(7 * DAY + H), sourceIdentity: source },
    { type: 'start', startId: randomUUID(), runId: randomUUID(), mode: 'assessment', total: 10, startedAt: at(7 * DAY + 2 * H), sourceIdentity: { ...V2_REFERENCE_SOURCE } },
  ] });
  const report = evaluateLearningEffect(s.input);
  assert.equal(report.runs.post.unconfirmedStarts, 1);
  assert.equal(report.runs.post.sourceMismatch, 1);
  assert.deepEqual(report.runs.post.byStatus, { complete: 2 }, 'neither takes a slot');
  assert.equal(evaluateLearningEffect(replaced.input).runs.baseline.extra, 0);

  const withReplace = scenario({ extraRows: [
    { type: 'start', startId: randomUUID(), runId: confirmedRun, mode: 'assessment', total: 10, startedAt: at(7 * DAY + H), sourceIdentity: source },
    { type: 'replace', startId: randomUUID(), at: at(7 * DAY + 2 * H), mode: 'free', replacedRunId: confirmedRun },
  ] });
  const r = evaluateLearningEffect(withReplace.input);
  assert.deepEqual(r.runs.post.byStatus, { UNANSWERED: 1, complete: 1 });
  assert.equal(r.runs.post.extra, 1);
  assert.equal(r.m1.reason, 'INCOMPLETE_SLOTS', 'the abandoned first slot stops the verdict; the later run cannot take its place');
  assert.equal(r.runs.replacements, 1);
  // 지금 세션인 미응답 실행도 확인된 시작이다.
  assert.equal(evaluateLearningEffect({ ...s.input, currentRunId: unconfirmedRun }).runs.post.unconfirmedStarts, 0);
});

function sharedChartPartner(event) {
  const { spotKey, handClass } = event.mixObservation;
  const chartId = chartOf(spotKey);
  for (const [other, id] of Object.entries(dataset.data.spots)) {
    if (other === spotKey || id !== chartId) continue;
    if (lookup(dataset, { spotKey: other, handClass }).status === 'supported') return other;
  }
  return null;
}

test('exposure: a chart view, an answer of the same class under another spot, an answer during the open run, and a late ledger each exclude items', async () => {
  const { parts } = scenario();
  const target = parts.post[0].events.find((event) => sharedChartPartner(event));
  assert.ok(target, 'a post item whose chart is shared with another practice spot');
  const chart = evaluateLearningEffect(scenario({ exposureRows: [
    { at: at(3 * DAY), sourceIdentity: source, spotKey: sharedChartPartner(target) },
  ] }).input);
  assert.ok(chart.items.post.excluded.KNOWN_EXPOSURE_CHART >= 1);

  // 같은 차트를 쓰는 다른 spot의 같은 손패를 실제 drill로 답한 이벤트(개입 기간, 연습).
  const store = createOwnedTempDir('effect-partner');
  const partner = sharedChartPartner(target);
  const started = await startDrill(store, { mode: 'free', source, seed: 'partner', spotKey: partner, handClass: target.mixObservation.handClass });
  await answerRun(store, started, 'top');
  const [answer] = await eventsOf(store);
  assert.equal(answer.mixObservation.spotKey, partner);
  const practiced = evaluateLearningEffect(scenario({ extraEvents: [relabel(answer, { appliedAt: at(3 * DAY) })] }).input);
  assert.ok(practiced.items.post.excluded.KNOWN_EXPOSURE_ANSWER >= 1);
  // 사후 실행이 열린 동안 그 문항 응답 직전에 같은 동치군을 다른 경로로 답했다.
  const itemAt = Date.parse(target.appliedAt);
  const duringRun = scenario();
  const placedTarget = duringRun.parts.post[0].events[parts.post[0].events.indexOf(target)];
  const during = evaluateLearningEffect({ ...duringRun.input,
    events: [...duringRun.input.events, relabel(answer, { appliedAt: new Date(Date.parse(placedTarget.appliedAt) - 1000).toISOString() })] });
  assert.ok(during.items.post.excluded.KNOWN_EXPOSURE_ANSWER >= 1, `answer before the item at ${itemAt}`);

  const lateLedger = evaluateLearningEffect(scenario({ exposureLog: ledger('exposure', [], at(-DAY)) }).input);
  assert.equal(lateLedger.exposure.covered, false);
  assert.equal(lateLedger.items.baseline.clean, 0, 'unverifiable chart exposure is not treated as no exposure');
  assert.ok(lateLedger.items.baseline.excluded.EXPOSURE_UNKNOWN > 0);
});

test('M2 excludes a pair whose class was practiced between the baseline answer and the retest answer', async () => {
  const { parts } = scenario();
  const item = parts.baseline[0].events[0];
  const store = createOwnedTempDir('effect-rehearse');
  const started = await startDrill(store, { mode: 'free', source, seed: 'rehearse', spotKey: item.mixObservation.spotKey, handClass: item.mixObservation.handClass });
  await answerRun(store, started, 'top');
  const [practice] = await eventsOf(store);
  const report = evaluateLearningEffect(scenario({ extraEvents: [relabel(practice, { appliedAt: at(5 * DAY) })] }).input);
  assert.equal(report.m2.excluded.REHEARSED, 1);
  const rehearsedTotal = Object.values(report.m2.rehearsed).reduce((sum, n) => sum + n, 0);
  assert.equal(rehearsedTotal, 1, 'the rehearsed pair is kept apart as a descriptive count');
});

test('republished events count once, conflicting ones stop the report, and a final report does not change later', () => {
  const { input } = scenario();
  const once = evaluateLearningEffect(input);
  const twice = evaluateLearningEffect({ ...input, events: [...input.events, ...input.events.slice(0, 5)] });
  assert.deepEqual(twice.m1, once.m1);
  assert.deepEqual(twice.items, once.items);
  const conflict = { ...input.events[0], grade: input.events[0].grade === 'preferred' ? 'off-policy' : 'preferred' };
  assert.throws(() => evaluateLearningEffect({ ...input, events: [...input.events, conflict] }), { code: /PROFILE_EVENT/ });
  // 창이 닫힌 뒤 새 사후 실행이 시작돼도 최종 판정은 같다.
  const [, , , , extra] = pool.runs;
  const after = placeRun(extra, { startMs: 20 * DAY });
  const later = evaluateLearningEffect({ ...input, now: at(30 * DAY), events: [...input.events, ...after.events],
    runLog: ledger('run', [...input.runLog.ledger.rows, after.row], at(0)) });
  assert.deepEqual(later.m1, once.m1);
  assert.deepEqual(later.m2, once.m2);
  assert.deepEqual(later.runs.post, once.runs.post);
});
