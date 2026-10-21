#!/usr/bin/env node
// 게임 시작처럼 warmup N개를 **동시에** 띄울 때와 **하나씩** 띄울 때를 같은 실제 경로로 재는 **선택 실행** 측정 도구(#312).
//
// 운영(`tools/game-loop.js` preparePlayerSessions)은 AI 좌석마다 한 어댑터로 서로 다른 페르소나의 warmup을 동시에 연다.
// 비교 도구(`compare-codex-players.js`)는 호출을 전부 순차로 돌리므로 그 조건을 재지 못한다. 이 도구가 그 차이를 잰다.
//
// 지키는 규칙(비교 도구와 같다):
//   - 기본 실행은 계획만 출력하고 아무 자식도 띄우지 않는다. 실제 호출은 `--live`가 있을 때만이다.
//   - 실제 `createPlayerRuntime` 경로를 쓴다: no-tool probe(카나리 부정 검증)·warmup. 모델/effort는 `benchmarkPlayerPin`으로만
//     정하고 exec 래퍼는 argv를 기록만 한다. 실제로 돌린 warmup마다 자기 자식 argv가 관측되고 요청과 일치해야 측정이다.
//   - 자식마다 단조 시계 타임라인을 남긴다(spawn·JSONL 이벤트 이름·신호·exit·close). 원문은 남기지 않는다.
//   - 타임아웃은 어댑터가 자식을 죽이고 close를 확인한 뒤에만 돌려준다. 종료를 확인하지 못하면 그 즉시 남은 호출을
//     멈추고 임시 디렉터리를 지우지 않는다. 어댑터는 항상 dispose한다. cwd·카나리는 이번 실행의 임시 디렉터리뿐이다.
//   - 순서 편향을 줄이려고 라운드마다 변형 순서를 번갈아 돌리고, 변형마다 parallel/sequential 순서를 라운드와 변형 번호의
//     짝홀로 번갈아 돈다.
//   - `budgetMs`는 새 호출 시작 예산이다. parallel 묶음은 묶음 시작 전에 상한 하나를, sequential은 호출마다 상한 하나를 본다.
//   - 판정 기준(설계 §A5 L3, 측정 전 고정): C1 warmup timeout 0건, C2 60초 초과 건수와 그 구간 위치, C3 변형별
//     parallel 중앙값 ≥ 1.5 × sequential 중앙값 **이고** 차이 ≥ 2초면 "병렬 영향 관측". 합격(`ok`)은 실행 건전성과
//     계획한 warmup의 전부 응답이다. 어느 것도 분포 보장·운영 안정성의 인증이 아니다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ARCHETYPES, PERSONA_PROFILES } from '../engine/personas.js';
import { PERSONA_NAMES } from '../shared/reserved-names.js';
import { buildPlayerPrompt, createPlayerRuntime, spawnCli } from './player-runtime.js';
import {
  COMPARISON_VARIANTS, createVariantRun, disposeAll, errorDetails, isUnsafeTermination, median, mismatchRecord,
  observeArgv, probeNotRun, probeVariant, timelineView,
} from './compare-codex-players.js';

export const WARMUP_CONCURRENCY_SCHEMA = 'codex-warmup-concurrency/1';
export const WARMUP_CONCURRENCY_LIMITS = Object.freeze({
  defaultBatchSize: 5, maxBatchSize: 8,
  defaultRounds: 4, maxRounds: 8,
  defaultTimeoutMs: 120_000, minTimeoutMs: 250, maxTimeoutMs: 300_000,
  defaultBudgetMs: 30 * 60_000, maxBudgetMs: 60 * 60_000,
});
export const WARMUP_CONCURRENCY_CRITERIA = Object.freeze({ over60sMs: 60_000, parallelRatio: 1.5, parallelDiffMs: 2_000 });
export const MODES = Object.freeze(['parallel', 'sequential']);
const CAVEATS = Object.freeze([
  '표본이 작아(변형·모드마다 라운드 × 묶음 크기) 지연은 관측 목록이다. 분포·p95 안전 증명이 아니다.',
  '운영과 같이 한 어댑터·서로 다른 페르소나로 묶음을 띄우지만 relay·게임 상태는 없다. 운영 전체 경로의 재현이 아니다.',
  'turn 구간은 CLI가 보고한 이벤트 사이의 관측값이다(provider 대기의 대리값, 직접 측정 아님).',
  '호스트 부하(다른 프로세스)는 통제하지 않았다. 묶음마다 시작 시 loadavg를 싣는다.',
]);

function measureError(code, message) {
  return Object.assign(new Error(message), { code });
}

const OPTION_KEYS = Object.freeze(['batchSize', 'rounds', 'timeoutMs', 'warmupTimeoutMs', 'budgetMs']);

export function validateWarmupOptions(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !OPTION_KEYS.includes(key))) {
    throw measureError('BAD_OPTIONS', `BAD_OPTIONS: ${OPTION_KEYS.join('·')}만 받습니다.`);
  }
  const L = WARMUP_CONCURRENCY_LIMITS;
  const pick = (key, fallback, min, max) => {
    const value = raw[key] === undefined ? fallback : raw[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw measureError('BAD_OPTIONS', `BAD_OPTIONS: ${key}는 ${min}~${max} 정수입니다.`);
    }
    return value;
  };
  const timeoutMs = pick('timeoutMs', L.defaultTimeoutMs, L.minTimeoutMs, L.maxTimeoutMs);
  return {
    batchSize: pick('batchSize', L.defaultBatchSize, 1, L.maxBatchSize),
    rounds: pick('rounds', L.defaultRounds, 1, L.maxRounds),
    timeoutMs,
    warmupTimeoutMs: pick('warmupTimeoutMs', timeoutMs, L.minTimeoutMs, L.maxTimeoutMs),
    budgetMs: pick('budgetMs', L.defaultBudgetMs, L.minTimeoutMs, L.maxBudgetMs),
  };
}

/** 묶음 순서표. 라운드마다 변형 순서를 번갈고, 변형마다 모드 순서를 (라운드 + 변형 번호) 짝홀로 번갈는다. */
export function warmupSchedule(options) {
  const { rounds } = validateWarmupOptions(options);
  const batches = [];
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0 ? [0, 1] : [1, 0];
    for (const variantIndex of order) {
      const modes = (round + variantIndex) % 2 === 0 ? ['parallel', 'sequential'] : ['sequential', 'parallel'];
      for (const mode of modes) batches.push({ round, variantIndex, mode });
    }
  }
  return batches.map((entry, index) => ({ ...entry, index }));
}

/** 운영 페르소나 문면을 고정 순서로 쓴다(이름 i번째, 유형 i번째 순환). */
export function measurementPersonas(count) {
  return Array.from({ length: count }, (_, i) => {
    const archetype = ARCHETYPES[i % ARCHETYPES.length];
    return { playerId: `p${i + 1}`, name: PERSONA_NAMES[i], archetype, ...PERSONA_PROFILES[archetype] };
  });
}

export function warmupPlan(options) {
  const normalized = validateWarmupOptions(options);
  const perVariant = normalized.rounds * 2 * normalized.batchSize;
  return {
    ...normalized,
    variants: COMPARISON_VARIANTS.map(({ id, model, effort }) => ({ id, model, effort })),
    schedule: warmupSchedule(normalized).map(({ round, variantIndex, mode }) => ({ round, variant: COMPARISON_VARIANTS[variantIndex].id, mode })),
    warmupsPerVariant: perVariant,
    maxModelCalls: COMPARISON_VARIANTS.length * (1 + perVariant),
    criteria: { ...WARMUP_CONCURRENCY_CRITERIA },
  };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

function notRun(batch, call, reason) {
  return {
    round: batch.round, mode: batch.mode, index: call, status: 'skipped', errorCode: reason, warmupMs: null,
    observedCalls: 0, argvModel: null, argvEffort: null, mismatch: null, errorDetails: null, records: [],
  };
}

/**
 * `deps`는 테스트용 이음새다: createRuntime·exec·runtimeOpts·tmpRoot·now(예산·소요 시계)·monotonic(타임라인 시계)·
 * loadavg·stopSignal(AbortSignal).
 */
export async function runWarmupConcurrency(rawOptions = {}, deps = {}) {
  const options = validateWarmupOptions(rawOptions);
  const createRuntime = deps.createRuntime ?? createPlayerRuntime;
  const baseExec = deps.exec ?? spawnCli;
  const now = deps.now ?? (() => performance.now());
  const mono = deps.monotonic ?? (() => performance.now());
  const loadavg = deps.loadavg ?? os.loadavg;
  const stopSignal = deps.stopSignal ?? null;
  const stopRequested = () => stopSignal?.aborted === true;
  const personas = measurementPersonas(options.batchSize);
  const prompts = personas.map((persona) => buildPlayerPrompt({ persona }));
  const schedule = warmupSchedule(options);

  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(deps.tmpRoot ?? os.tmpdir()), 'ai-holdem-warmup-'));
  const cwdRoot = path.join(tmp, 'cwd');
  fs.mkdirSync(cwdRoot);
  const canaryAbsPath = path.join(tmp, `canary-${randomUUID()}.txt`);
  fs.writeFileSync(canaryAbsPath, `SENTINEL-warmup-${randomUUID()}\n`);

  const startedAtIso = new Date().toISOString();
  const startedAt = now();
  const monoStartedAt = mono();
  const loadStart = [...loadavg()];
  const deadline = startedAt + options.budgetMs;
  let aborted = null;
  let cleanup = null;
  // spawn 순간의 꼬리표. 어댑터 warmup은 첫 await 전에 동기적으로 자식을 띄우므로, 호출 직전에 세우고 직후에 지운다.
  let currentTag = null;
  const runs = [];
  const batches = [];
  const stopAt = (where) => {
    if (!aborted && stopRequested()) aborted = { code: 'STOPPED', variant: null, ...where, signal: stopSignal.reason?.signal ?? null };
    return Boolean(aborted);
  };

  const runCall = async (run, batch, callIndex) => {
    const tag = `${batch.index}:${callIndex}`;
    const began = now();
    currentTag = tag;
    let pending;
    try {
      pending = run.adapter.warmup({
        playerId: personas[callIndex].playerId, prompt: prompts[callIndex], timeoutMs: options.warmupTimeoutMs,
        ...(stopSignal ? { signal: stopSignal } : {}),
      });
    } finally {
      currentTag = null;
    }
    const record = { ...notRun(batch, callIndex, null), status: 'failed' };
    try {
      await pending;
      record.status = 'answered';
    } catch (error) {
      record.errorCode = error?.code ?? 'ERROR';
      record.errorDetails = errorDetails(error);
      record.status = isUnsafeTermination(record.errorCode) ? 'termination_unconfirmed'
        : record.errorCode === 'TIMEOUT' ? 'timeout' : record.errorCode === 'INTERRUPTED' ? 'interrupted' : 'failed';
    }
    record.warmupMs = Math.round(now() - began);
    record.records = run.callLog.filter((entry) => entry.tag === tag);
    const observed = record.records.map((entry) => observeArgv(run.argvLog[run.callLog.indexOf(entry)]));
    record.observedCalls = observed.length;
    record.argvModel = observed.at(-1)?.model ?? null;
    record.argvEffort = observed.at(-1)?.effort ?? null;
    const wrong = observed.filter((call) => call.model !== run.variant.model || call.effort !== run.variant.effort).length;
    const adapterModel = run.adapter.models?.player ?? null;
    if (wrong > 0 || adapterModel !== run.variant.model) {
      record.mismatch = mismatchRecord(run.variant, adapterModel, {
        argvModels: [...new Set(observed.map((call) => call.model))], argvEfforts: [...new Set(observed.map((call) => call.effort))],
        modelOccurrences: observed.flatMap((call) => call.models), effortOccurrences: observed.flatMap((call) => call.efforts),
        count: observed.length,
      });
    }
    // 응답은 받았지만 그 호출의 자식이 관측되지 않았다 — 어댑터의 주장일 뿐 측정이 아니다.
    if (record.status === 'answered' && record.observedCalls === 0) {
      record.status = 'unobserved';
      record.errorCode = 'NO_CHILD_OBSERVED';
    }
    if (record.status === 'termination_unconfirmed') run.halted = true;
    return record;
  };

  const runBatch = async (run, batch) => {
    const entry = { round: batch.round, variant: run.variant.id, mode: batch.mode, index: batch.index,
      size: options.batchSize, startedAtMs: Math.round(mono() - monoStartedAt), loadavg: [...loadavg()],
      wallMs: null, maxInFlight: 0, calls: [] };
    let inFlight = 0;
    const tracked = async (callIndex) => {
      inFlight += 1;
      entry.maxInFlight = Math.max(entry.maxInFlight, inFlight);
      try { return await runCall(run, batch, callIndex); } finally { inFlight -= 1; }
    };
    const began = now();
    const indices = Array.from({ length: options.batchSize }, (_, i) => i);
    if (batch.mode === 'parallel') {
      if (deadline - now() < options.warmupTimeoutMs) entry.calls = indices.map((i) => notRun(batch, i, 'BUDGET_EXHAUSTED'));
      else {
        const settled = await Promise.allSettled(indices.map((i) => tracked(i)));
        entry.calls = settled.map((result, i) => (result.status === 'fulfilled' ? result.value
          : { ...notRun(batch, i, result.reason?.code ?? 'ERROR'), status: 'failed' }));
      }
    } else {
      for (const i of indices) {
        if (aborted || run.halted || stopRequested()) { entry.calls.push(notRun(batch, i, aborted?.code ?? (run.halted ? 'VARIANT_HALTED' : 'STOPPED'))); continue; }
        if (deadline - now() < options.warmupTimeoutMs) { entry.calls.push(notRun(batch, i, 'BUDGET_EXHAUSTED')); continue; }
        entry.calls.push(await tracked(i));
      }
    }
    entry.wallMs = Math.round(now() - began);
    return entry;
  };

  try {
    for (const variant of COMPARISON_VARIANTS) {
      runs.push(createVariantRun(variant, {
        createRuntime, baseExec, mono, cwdRoot, runtimeOpts: deps.runtimeOpts, tagOf: () => currentTag,
      }));
    }
    for (const run of runs) {
      if (stopAt({ phase: 'probe' })) break;
      if (deadline - now() < options.timeoutMs) { run.probe = probeNotRun('예산 소진으로 probe를 건너뜁니다.'); continue; }
      const unsafe = await probeVariant(run, { canaryAbsPath, timeoutMs: options.timeoutMs, now });
      if (unsafe && !aborted) aborted = unsafe;
      stopAt({ phase: 'probe' });
    }
    for (const batch of schedule) {
      const run = runs[batch.variantIndex];
      const skip = (reason) => batches.push({ round: batch.round, variant: run.variant.id, mode: batch.mode, index: batch.index,
        size: options.batchSize, startedAtMs: null, loadavg: null, wallMs: null, maxInFlight: 0,
        calls: Array.from({ length: options.batchSize }, (_, i) => notRun(batch, i, reason)) });
      if (stopAt({ phase: 'batch', round: batch.round })) { skip(aborted.code); continue; }
      if (run.halted) { skip('VARIANT_HALTED'); continue; }
      if (!run.probe.verified) { skip(run.probe.attempted ? 'PROBE_NOT_VERIFIED' : 'PROBE_NOT_RUN'); continue; }
      run.phase = `warmup-${batch.mode}`;
      const entry = await runBatch(run, batch);
      batches.push(entry);
      const unsafe = entry.calls.find((call) => call.status === 'termination_unconfirmed');
      if (unsafe && !aborted) aborted = { code: 'TERMINATION_UNCONFIRMED', variant: run.variant.id, phase: 'batch', round: batch.round, mode: batch.mode };
      stopAt({ phase: 'batch', round: batch.round });
    }
  } finally {
    cleanup = await disposeAll(runs, tmp, { mono, monoStartedAt });
  }
  stopAt({ phase: 'cleanup' });

  // 타임라인은 dispose 뒤에 렌더링한다 — 정리 중에 늦게 닫힌 자식도 그 close 시각으로 보인다.
  const rendered = batches.map((batch) => ({
    ...batch,
    calls: batch.calls.map(({ records, ...call }) => ({ ...call, timelines: records.map((record) => timelineView(record, monoStartedAt)) })),
  }));
  const untagged = runs.reduce((sum, run) => sum + run.callLog.filter((record) => record.phase.startsWith('warmup-') && record.tag === null).length, 0);
  const variants = runs.map((run) => ({
    id: run.variant.id,
    requested: { model: run.variant.model, effort: run.variant.effort },
    adapterModel: run.adapter?.models?.player ?? null,
    probe: { ...run.probe, timelines: run.probeCalls.map((record) => timelineView(record, monoStartedAt)) },
    summary: summarizeVariant(run.variant.id, rendered, options),
  }));
  const verdict = judgeWarmups({ options, variants, batches: rendered, aborted, cleanup, untagged });
  return {
    schema: WARMUP_CONCURRENCY_SCHEMA,
    startedAtIso,
    options,
    criteria: { ...WARMUP_CONCURRENCY_CRITERIA },
    environment: { node: process.version, platform: process.platform, arch: process.arch, loadavg: { start: loadStart, end: [...loadavg()] } },
    elapsedMs: Math.round(now() - startedAt),
    personas: personas.map(({ playerId, archetype }) => ({ playerId, archetype })),
    variants,
    batches: rendered,
    untaggedChildren: untagged,
    aborted,
    cleanup,
    ...verdict,
    caveats: [...CAVEATS],
  };
}

// ── 요약·판정 ────────────────────────────────────────────────────────────────

// C3 판정용 중앙값: 짝수 표본은 가운데 두 값의 평균을 반올림하지 않는다(공용 median은 표시용으로 반올림한다).
function exactMedian(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stats(values) {
  return { observations: values, median: median(values), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
}

export function summarizeVariant(variantId, batches, options) {
  const out = {};
  for (const mode of MODES) {
    const mine = batches.filter((batch) => batch.variant === variantId && batch.mode === mode);
    const calls = mine.flatMap((batch) => batch.calls);
    const count = (status) => calls.filter((call) => call.status === status).length;
    const answered = calls.filter((call) => call.status === 'answered');
    const latencies = answered.map((call) => call.warmupMs);
    const derived = (key) => answered.flatMap((call) => call.timelines.map((timeline) => timeline.derived[key])).filter((value) => typeof value === 'number');
    out[mode] = {
      planned: options.rounds * options.batchSize,
      attempted: calls.filter((call) => call.status !== 'skipped').length,
      answered: answered.length, timeout: count('timeout'), failed: count('failed'), interrupted: count('interrupted'),
      terminationUnconfirmed: count('termination_unconfirmed'), unobserved: count('unobserved'), skipped: count('skipped'),
      modelMismatches: calls.filter((call) => call.mismatch).length,
      warmupMs: { ...stats(latencies), over60s: latencies.filter((ms) => ms > WARMUP_CONCURRENCY_CRITERIA.over60sMs).length },
      phases: { bootMs: stats(derived('bootMs')), turnMs: stats(derived('turnMs')), exitToCloseMs: stats(derived('exitToCloseMs')) },
      batchWallMs: stats(mine.map((batch) => batch.wallMs).filter((value) => typeof value === 'number')),
      maxInFlight: Math.max(0, ...mine.map((batch) => batch.maxInFlight)),
    };
  }
  const p = exactMedian(out.parallel.warmupMs.observations);
  const s = exactMedian(out.sequential.warmupMs.observations);
  // ratio는 표시용(소수 둘째 자리)이다. C3 판정은 원 중앙값으로 한다.
  out.parallelVsSequential = {
    parallelMedianMs: p, sequentialMedianMs: s,
    ratio: p !== null && s !== null && s > 0 ? Math.round((p / s) * 100) / 100 : null,
    diffMs: p !== null && s !== null ? p - s : null,
  };
  return out;
}

/** ok = executionOk && complete. 판정(C1–C3)은 ok일 때만 결론이고, 아니면 관측값만 남는다. */
export function judgeWarmups({ options, variants, batches, aborted, cleanup, untagged }) {
  const failures = [];
  const fail = (gate, variant, code, detail) => failures.push({ gate, variant, code, ...(detail === undefined ? {} : { detail }) });
  if (aborted?.code === 'STOPPED') fail('complete', aborted.variant, 'STOPPED', aborted.phase);
  else if (aborted) fail('executionOk', aborted.variant, aborted.code, aborted.phase);
  if (cleanup.disposed !== true) fail('executionOk', null, 'DISPOSE_UNCONFIRMED');
  if (cleanup.removed !== true) fail('executionOk', null, 'TMP_NOT_REMOVED');
  if (untagged > 0) fail('executionOk', null, 'UNATTRIBUTED_CHILD', untagged);
  for (const variant of variants) {
    if (variant.probe.attempted && variant.probe.observedCalls === 0) fail('executionOk', variant.id, 'NO_CHILD_OBSERVED', 'probe');
    if (variant.probe.mismatch) fail('executionOk', variant.id, 'MODEL_MISMATCH', 'probe');
    for (const mode of MODES) {
      const s = variant.summary[mode];
      if (s.modelMismatches > 0) fail('executionOk', variant.id, 'MODEL_MISMATCH', { mode, calls: s.modelMismatches });
      if (s.unobserved > 0) fail('executionOk', variant.id, 'NO_CHILD_OBSERVED', { mode, calls: s.unobserved });
      if (!aborted && s.terminationUnconfirmed > 0) fail('executionOk', variant.id, 'TERMINATION_UNCONFIRMED', mode);
    }
  }
  for (const variant of variants) {
    if (!variant.probe.verified) fail('complete', variant.id, 'PROBE_NOT_PASSED', variant.probe.notice ?? variant.probe.unverified ?? null);
    for (const mode of MODES) {
      const s = variant.summary[mode];
      if (s.answered !== s.planned) {
        fail('complete', variant.id, 'WARMUPS_MISSING', { mode, planned: s.planned, answered: s.answered, timeout: s.timeout, failed: s.failed, skipped: s.skipped });
      }
    }
  }
  const executionOk = !failures.some((failure) => failure.gate === 'executionOk');
  const complete = !failures.some((failure) => failure.gate === 'complete');
  const ok = executionOk && complete;
  const C = WARMUP_CONCURRENCY_CRITERIA;
  const findings = {
    // C1: 운영 상한(120초)에 걸린 warmup. 1건이라도 있으면 게임 시작이 실패하는 경로가 관측된 것이다.
    c1Timeouts: variants.map((variant) => ({ variant: variant.id, parallel: variant.summary.parallel.timeout, sequential: variant.summary.sequential.timeout })),
    // C2: 60초 초과 응답과 그 호출의 구간(boot/turn/close).
    c2Over60s: batches.flatMap((batch) => batch.calls.filter((call) => call.status === 'answered' && call.warmupMs > C.over60sMs)
      .map((call) => ({ variant: batch.variant, mode: batch.mode, round: batch.round, index: call.index, warmupMs: call.warmupMs,
        phases: call.timelines.map((timeline) => ({ bootMs: timeline.derived.bootMs, turnMs: timeline.derived.turnMs, exitToCloseMs: timeline.derived.exitToCloseMs })) }))),
    // C3: 변형별 병렬 영향(사전 고정 기준). ok가 아니면 결론을 내지 않는다(null).
    c3ParallelEffect: variants.map((variant) => {
      const { ratio, diffMs, parallelMedianMs: p, sequentialMedianMs: s } = variant.summary.parallelVsSequential;
      return { variant: variant.id, ratio, diffMs,
        observed: !ok || p === null || s === null ? null : p >= C.parallelRatio * s && p - s >= C.parallelDiffMs };
    }),
  };
  return { executionOk, complete, ok, failures, findings, planned: { batches: COMPARISON_VARIANTS.length * options.rounds * 2 } };
}

// ── 출력·CLI ─────────────────────────────────────────────────────────────────

const failureText = ({ gate, variant, code, detail }) => `${gate} ${variant ?? '-'} ${code}${detail === undefined || detail === null ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`;

export function formatWarmupReport(report) {
  const o = report.options;
  const lines = [`codex warmup 동시성 측정 — 묶음 ${o.batchSize} × 라운드 ${o.rounds}, 상한 probe ${o.timeoutMs}ms · warmup ${o.warmupTimeoutMs}ms, 소요 ${report.elapsedMs}ms`];
  for (const variant of report.variants) {
    lines.push('', `[${variant.id}] 요청 ${variant.requested.model}/${variant.requested.effort} · probe ${variant.probe.verified ? '통과' : `미통과(${variant.probe.unverified ?? '?'})`}`);
    for (const mode of MODES) {
      const s = variant.summary[mode];
      lines.push(`  ${mode}: 응답 ${s.answered}/${s.planned} · timeout ${s.timeout} · 실패 ${s.failed} · 건너뜀 ${s.skipped} · 동시 최대 ${s.maxInFlight}`);
      lines.push(`    warmup ms 중앙 ${s.warmupMs.median ?? '-'} · 최대 ${s.warmupMs.max ?? '-'} · 60초 초과 ${s.warmupMs.over60s} · boot 중앙 ${s.phases.bootMs.median ?? '-'} · turn 중앙 ${s.phases.turnMs.median ?? '-'} · 묶음 wall 최대 ${s.batchWallMs.max ?? '-'}`);
    }
    const c = variant.summary.parallelVsSequential;
    lines.push(`  parallel/sequential 중앙값 비율 ${c.ratio ?? '-'} · 차이 ${c.diffMs ?? '-'}ms`);
  }
  lines.push('', `판정: ${report.ok ? '완전(ok)' : '불합격(ok=false)'} — executionOk=${report.executionOk} · complete=${report.complete}`);
  for (const failure of report.failures) lines.push(`  - ${failureText(failure)}`);
  lines.push(`C1 timeout: ${JSON.stringify(report.findings.c1Timeouts)}`);
  lines.push(`C2 60초 초과: ${report.findings.c2Over60s.length}건`);
  lines.push(`C3 병렬 영향: ${JSON.stringify(report.findings.c3ParallelEffect)}`);
  lines.push(`정리: dispose ${report.cleanup.disposed ? '확인' : '실패'} · 임시 디렉터리 ${report.cleanup.removed ? '삭제' : `보존 ${report.cleanup.tmp}`}`);
  for (const caveat of report.caveats) lines.push(`주의: ${caveat}`);
  return lines.join('\n');
}

const USAGE = `사용법: node tools/measure-codex-warmup.js [--live] [--batch-size N] [--rounds N] [--timeout-ms N] [--warmup-timeout-ms N] [--budget-ms N] [--json]
  --live 없이 실행하면 계획만 출력하고 codex를 부르지 않는다.
  --timeout-ms는 probe 상한이자 --warmup-timeout-ms의 기본값이다(기본 ${WARMUP_CONCURRENCY_LIMITS.defaultTimeoutMs}ms = 운영 시작 warmup 상한).
  종료 코드: 0 = 완전(ok) · 3 = 실행했지만 불완전(ok=false) · 2 = 인자 오류 · 1 = 실행 오류`;

export function parseWarmupArgs(argv) {
  const parsed = { live: false, json: false, options: {} };
  const numeric = { '--batch-size': 'batchSize', '--rounds': 'rounds', '--timeout-ms': 'timeoutMs', '--warmup-timeout-ms': 'warmupTimeoutMs', '--budget-ms': 'budgetMs' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') parsed.live = true;
    else if (arg === '--json') parsed.json = true;
    else if (Object.hasOwn(numeric, arg)) {
      const text = argv[i + 1];
      if (typeof text !== 'string' || !/^\d{1,9}$/.test(text)) throw measureError('BAD_ARGS', `BAD_ARGS: ${arg}에는 정수가 필요합니다.`);
      parsed.options[numeric[arg]] = Number(text);
      i += 1;
    } else throw measureError('BAD_ARGS', `BAD_ARGS: 알 수 없는 인자 ${String(arg).slice(0, 40)}`);
  }
  validateWarmupOptions(parsed.options);
  return parsed;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) {
  let parsed;
  try {
    parsed = parseWarmupArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (!parsed.live) {
    const plan = warmupPlan(parsed.options);
    stdout.write(parsed.json ? `${JSON.stringify({ executed: false, plan }, null, 2)}\n` : `실행하지 않음(--live 없음). 계획: ${JSON.stringify(plan)}\n`);
    return 0;
  }
  // 첫 신호는 새 호출을 멈추고 진행 중 warmup을 중단해 정리한 뒤 불완전 보고서를 낸다. 둘째 신호부터는 기본 동작이다.
  const signals = deps.signalSource ?? process;
  const controller = new AbortController();
  const handlers = new Map();
  const detach = () => { for (const [name, handler] of handlers) signals.removeListener(name, handler); handlers.clear(); };
  for (const name of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      detach();
      stderr.write(`${name} 수신: 새 호출을 멈추고 진행 중인 warmup을 중단해 정리합니다. 진행 중인 probe는 끝나거나 상한에 이를 때까지 기다립니다.\n`);
      controller.abort({ signal: name });
    };
    handlers.set(name, handler);
    signals.on(name, handler);
  }
  let report;
  try {
    report = await runWarmupConcurrency(parsed.options, { ...deps, stopSignal: controller.signal });
  } finally {
    detach();
  }
  stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatWarmupReport(report)}\n`);
  if (report.ok) return 0;
  stderr.write(`측정 불합격(ok=false): ${report.failures.map(failureText).join(' | ')}\n`);
  return 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`실행 오류: ${error.code ?? 'ERROR'} ${error.message}\n`);
    process.exitCode = 1;
  }
}
