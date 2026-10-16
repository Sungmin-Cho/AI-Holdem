#!/usr/bin/env node
// 옛 Luna/모델 기본값과 Sol/low를 같은 공개 스냅샷으로 나란히 재는 **선택 실행** 비교 도구.
//
// 이 도구가 하는 일은 "두 설정이 같은 합법 응답 형식을 얼마나 안정적으로, 얼마나 빨리 내는가"의 관측이다.
// 승률·전략 우열·학습 효과의 증거가 아니다. 표본이 6개 안팎이라 지연도 분포가 아니라 관측 목록으로만 싣는다.
//
// 지키는 규칙:
//   - 기본 실행은 계획만 출력하고 아무 자식도 띄우지 않는다. 실제 호출은 `--live`가 있을 때만이다.
//   - 실제 `createPlayerRuntime` 경로를 쓴다: no-tool probe(카나리 부정 검증)·warmup·resume이 그대로 돈다.
//     모델/effort는 `benchmarkPlayerPin`이 검증한 어댑터 로컬 핀으로만 정하고 argv를 가로채 바꾸지 않는다.
//     exec 래퍼는 argv를 **기록만** 하고 원본 exec에 그대로 넘긴다(요청한 모델/effort와 실제 argv를 대조하려는 것).
//     대조는 probe와 표본의 warmup·decide 단계 각각에 대해 한다. 실제로 돌린 단계마다 자식 argv가 한 건 이상 관측돼야
//     하고(없으면 NO_CHILD_OBSERVED), 어댑터가 보고하는 해석 모델이나 "통과" 주장이 관측된 실행을 대신하지 못한다.
//   - 호출은 전부 순차다. 스팟마다 두 설정의 순서를 번갈아 돌려 순서 편향을 줄인다.
//   - cwd·카나리는 이번 실행의 임시 디렉터리뿐이다. 게임/학습 store·세션 파일을 열지도 쓰지도 않는다.
//   - 타임아웃은 어댑터가 자식을 죽이고 close를 확인한 뒤에만 돌려준다. 종료를 확인하지 못하면 그 즉시
//     남은 호출을 중단하고 임시 디렉터리를 지우지 않는다. 어댑터는 항상 dispose한다.
//   - 프롬프트·모델 원문 출력은 보고서에 싣지 않는다(정규화된 reason 한 줄과 합법성 판정만).
//   - 합격(`ok`)은 세 게이트의 논리곱이다: 실행 건전성(`executionOk`)·요청한 측정을 전부 얻음(`complete`)·
//     얻은 응답이 전부 합법(`allDecisionsLegal`). 부분·무효·불가 비교는 관측 자료로는 보고서에 남지만
//     합격이 아니고 CLI는 0이 아닌 코드로 끝난다. 합격도 운영 준비·전략 우열의 인증이 아니다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newDeck } from '../engine/cards.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { turnSummary } from '../engine/views.js';
import { DEFAULT_PLAYER_BUDGET } from '../shared/player-budget.js';
import { classifyDecision } from './player-decision.js';
import { benchmarkPlayerPin, buildPlayerPrompt, createPlayerRuntime, RUNTIME_TABLE, spawnCli } from './player-runtime.js';

export const COMPARISON_VARIANTS = Object.freeze([
  Object.freeze({ id: 'luna-default', model: 'gpt-6-luna', effort: 'model-default' }),
  Object.freeze({ id: 'sol-low', model: 'gpt-6.1-sol', effort: 'low' }),
]);

export const COMPARISON_LIMITS = Object.freeze({
  defaultSamples: 6, maxSamples: 8,
  defaultTimeoutMs: 60_000, minTimeoutMs: 250, maxTimeoutMs: DEFAULT_PLAYER_BUDGET.hardMs,
  defaultBudgetMs: 15 * 60_000, maxBudgetMs: 60 * 60_000,
});

export const COMPARISON_CAVEATS = Object.freeze([
  '표본이 작아(스팟당 1회) 지연·실패율은 관측 목록일 뿐 분포·p95 안전 증명이 아니다.',
  '행동·금액·사유의 차이는 같은 스팟에서의 단발 출력 비교다. 승률·EV·GTO 정답·전략 우열을 추론하지 않는다.',
  '모델은 요청 id와 실제 자식 argv(probe·warmup·decide 단계별)·어댑터 해석값만 대조한다. codex 스트림에는 서빙된 모델 id가 없다.',
  '운영 루프의 결정 예산은 soft 25초/hard 300초이고 어댑터 직접 호출 기본은 25초다. 여기서는 --timeout-ms가 호출별 상한이다.',
  'ok=true는 이번 관측이 끝까지 안전하게 돌았고 요청한 측정을 전부 얻었으며 모든 응답이 합법이었다는 뜻일 뿐, 운영 준비·품질의 인증이 아니다.',
]);

const SOFT_MS = DEFAULT_PLAYER_BUDGET.softMs;
const PERSONA = Object.freeze({
  name: '비교용', speech: '차분하게 계산해 볼게요.', personality: '신중하고 공격적인 정석파', archetype: 'TAG',
});
const PLAYER_ID = 'user';

function comparisonError(code, message) {
  return Object.assign(new Error(message), { code });
}

// ── 공개 스냅샷 ──────────────────────────────────────────────────────────────
// 3인(user=BTN, p1=SB, p2=BB), 100BB, 블라인드 25/50. 덱 순서: p1·p2·user 첫 장, p1·p2·user 둘째 장, 보드 5장.
// 모든 스팟은 엔진의 실제 `turnSummary`가 만든 요약이며, 두 설정에 똑같은 문자열이 간다.
const SPOT_DEFINITIONS = Object.freeze([
  { id: 'preflop-open-btn', label: '프리플랍 BTN 오픈 결정', hero: 'user', script: [],
    holes: { user: ['As', 'Qd'], p1: ['7c', '2d'], p2: ['Th', '3s'] }, board: ['Ks', '8d', '4c', 'Jh', '2s'] },
  { id: 'preflop-facing-open-bb', label: '프리플랍 BB, BTN 150 오픈에 대한 응답', hero: 'p2', script: ['raise:150', 'fold'],
    holes: { user: ['8h', '8d'], p1: ['5s', '2h'], p2: ['Kc', 'Jc'] }, board: ['7d', '6s', '2c', 'Qd', '3h'] },
  { id: 'preflop-facing-3bet-btn', label: '프리플랍 BTN 오픈 후 SB 3벳에 대한 응답', hero: 'user', script: ['raise:150', 'raise:500', 'fold'],
    holes: { user: ['9h', '9d'], p1: ['Ac', 'Kd'], p2: ['6s', '3c'] }, board: ['2h', '7c', 'Jd', 'Ts', '4h'] },
  { id: 'flop-facing-bet-bb', label: '플랍 BB, SB 100 베팅에 대한 응답(플러시 드로와 백도어 스트레이트 가능성)', hero: 'p2',
    script: ['cc', 'cc', 'cc', 'raise:100'],
    holes: { user: ['Ah', 'Jd'], p1: ['Qh', 'Qc'], p2: ['9s', '8s'] }, board: ['Ks', '7s', '2c', 'Td', '4h'] },
  { id: 'turn-facing-bet-btn', label: '턴 BTN, BB 250 베팅에 대한 응답(너츠 플러시 드로)', hero: 'user',
    script: ['cc', 'cc', 'cc', 'cc', 'cc', 'cc', 'cc', 'raise:250'],
    holes: { user: ['Ac', '5c'], p1: ['Jd', 'Tc'], p2: ['Kd', '8s'] }, board: ['9c', '6d', '2h', 'Kc', '3d'] },
  { id: 'river-facing-overbet-bb', label: '리버 BB, SB 300 오버벳에 대한 응답(약한 원페어)', hero: 'p2',
    script: ['cc', 'cc', 'cc', 'cc', 'cc', 'cc', 'cc', 'cc', 'cc', 'raise:300'],
    holes: { user: ['8c', '7c'], p1: ['Kh', 'Th'], p2: ['Ad', '9d'] }, board: ['Qs', '9h', '4d', '2c', 'Js'] },
  { id: 'flop-checked-to-bb', label: '플랍 BB, SB가 체크한 뒤 선택(QJ 수딧, 다이아몬드 백도어 플러시 가능성)', hero: 'p2', script: ['cc', 'cc', 'cc', 'cc'],
    holes: { user: ['Ac', 'Kd'], p1: ['9h', '8h'], p2: ['Qd', 'Jd'] }, board: ['7h', '6d', '2s', 'Ts', '3c'] },
  { id: 'preflop-short-stack-12bb', label: '프리플랍 12BB 숏스택 BTN 결정', hero: 'user', script: [], stacks: { user: 600 },
    holes: { user: ['Ac', '5h'], p1: ['Qc', '8d'], p2: ['Js', '4d'] }, board: ['2h', '9c', 'Kd', '3s', '7s'] },
]);

function deckFor({ holes, board }) {
  const head = [holes.p1[0], holes.p2[0], holes.user[0], holes.p1[1], holes.p2[1], holes.user[1], ...board];
  if (new Set(head).size !== head.length) throw comparisonError('BAD_SPOT', 'BAD_SPOT: 중복 카드가 있습니다.');
  return [...head, ...newDeck().filter((card) => !head.includes(card))];
}

function buildSpot(definition) {
  const game = createGame({ aiCount: 2 });
  game.button = 2;
  for (const seat of game.seats) {
    if (definition.stacks && Object.hasOwn(definition.stacks, seat.playerId)) seat.stack = definition.stacks[seat.playerId];
  }
  let state = startHand(game, { deck: deckFor(definition) }).state;
  for (const step of definition.script) {
    const legal = legalFor(state);
    if (legal.handOver) throw comparisonError('BAD_SPOT', `BAD_SPOT: ${definition.id} 스크립트가 핸드 종료 뒤에도 남았습니다.`);
    if (step === 'fold') state = applyAction(state, legal.toAct, 'fold').state;
    else if (step === 'cc') state = applyAction(state, legal.toAct, legal.canCheck ? 'check' : 'call').state;
    else if (/^raise:\d+$/.test(step)) state = applyAction(state, legal.toAct, 'raise', Number(step.slice(6))).state;
    else throw comparisonError('BAD_SPOT', `BAD_SPOT: 알 수 없는 스크립트 단계 ${step}`);
  }
  const legal = legalFor(state);
  if (legal.toAct !== definition.hero) {
    throw comparisonError('BAD_SPOT', `BAD_SPOT: ${definition.id}의 행동자가 ${legal.toAct}입니다(기대 ${definition.hero}).`);
  }
  const message = turnSummary(state, legal.toAct);
  return Object.freeze({
    id: definition.id, label: definition.label, street: state.hand.street,
    hero: legal.toAct, decisionId: legal.decisionId, message,
  });
}

export function buildComparisonSpots(count = COMPARISON_LIMITS.defaultSamples) {
  if (!Number.isInteger(count) || count < 1 || count > SPOT_DEFINITIONS.length) {
    throw comparisonError('BAD_COMPARISON_OPTIONS', `BAD_COMPARISON_OPTIONS: 스팟 수는 1~${SPOT_DEFINITIONS.length}입니다.`);
  }
  return SPOT_DEFINITIONS.slice(0, count).map(buildSpot);
}

// ── 옵션 ─────────────────────────────────────────────────────────────────────

export function validateComparisonOptions(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !['samples', 'timeoutMs', 'budgetMs'].includes(key))) {
    throw comparisonError('BAD_COMPARISON_OPTIONS', 'BAD_COMPARISON_OPTIONS: samples·timeoutMs·budgetMs만 받습니다.');
  }
  const L = COMPARISON_LIMITS;
  const pick = (key, fallback, min, max) => {
    const value = raw[key] === undefined ? fallback : raw[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw comparisonError('BAD_COMPARISON_OPTIONS', `BAD_COMPARISON_OPTIONS: ${key}는 ${min}~${max} 정수입니다.`);
    }
    return value;
  };
  const options = {
    samples: pick('samples', L.defaultSamples, 1, Math.min(L.maxSamples, SPOT_DEFINITIONS.length)),
    timeoutMs: pick('timeoutMs', L.defaultTimeoutMs, L.minTimeoutMs, L.maxTimeoutMs),
    budgetMs: pick('budgetMs', L.defaultBudgetMs, L.minTimeoutMs, L.maxBudgetMs),
  };
  return options;
}

/** 실제 호출 수의 상한: 변형마다 probe 1 + 표본마다 warmup·decide 2. */
export function comparisonPlan(options) {
  const normalized = validateComparisonOptions(options);
  return {
    ...normalized,
    variants: COMPARISON_VARIANTS.map(({ id, model, effort }) => ({ id, model, effort })),
    spots: buildComparisonSpots(normalized.samples).map(({ id, label, street }) => ({ id, label, street })),
    maxModelCalls: COMPARISON_VARIANTS.length * (1 + 2 * normalized.samples),
    worstCaseWallMs: Math.min(normalized.budgetMs, COMPARISON_VARIANTS.length * (1 + 2 * normalized.samples) * normalized.timeoutMs),
  };
}

// ── 관측 ─────────────────────────────────────────────────────────────────────

function observeArgv(args) {
  const models = [], efforts = [];
  const valueOf = (raw) => {
    const value = String(raw ?? '').trim();
    return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-m' || arg === '--model') models.push(args[++i] ?? null);
    else if (/^(?:--model|-m)=/.test(arg)) models.push(arg.slice(arg.indexOf('=') + 1));
    else if (/^-m[^-]/.test(arg)) models.push(arg.slice(2));
    else {
      const config = arg === '-c' || arg === '--config' ? args[++i]
        : /^(?:--config|-c)=/.test(arg) ? arg.slice(arg.indexOf('=') + 1)
          : /^-c[^-]/.test(arg) ? arg.slice(2) : null;
      const match = /^\s*(model|model_reasoning_effort)\s*=([\s\S]*)$/.exec(config ?? '');
      if (match) (match[1] === 'model' ? models : efforts).push(valueOf(match[2]));
    }
  }
  return {
    model: models.length === 1 ? models[0] : models.length === 0 ? null : 'multiple',
    effort: efforts.length === 0 ? 'model-default' : efforts.length === 1 ? efforts[0] : 'multiple',
    models, efforts,
  };
}

/** `from` 이후 argvLog에 쌓인 실제 자식 argv를 요청한 모델/effort와 대조한다. */
function observeCalls(argvLog, from, variant) {
  const calls = argvLog.slice(from).map(observeArgv);
  const last = calls.at(-1) ?? null;
  return {
    count: calls.length,
    argvModel: last?.model ?? null, argvEffort: last?.effort ?? null,
    argvModels: [...new Set(calls.map((call) => call.model))], argvEfforts: [...new Set(calls.map((call) => call.effort))],
    modelOccurrences: calls.flatMap((call) => call.models), effortOccurrences: calls.flatMap((call) => call.efforts),
    wrong: calls.filter((call) => call.model !== variant.model || call.effort !== variant.effort).length,
  };
}

function mismatchRecord(variant, adapterModel, observed) {
  return {
    requestedModel: variant.model, requestedEffort: variant.effort,
    adapterModel, argvModels: observed.argvModels, argvEfforts: observed.argvEfforts,
    modelOccurrences: observed.modelOccurrences, effortOccurrences: observed.effortOccurrences, callsChecked: observed.count,
  };
}

/** probe를 돌지 않았거나 아직 돌기 전의 상태. */
function probeNotRun(notice) {
  return {
    attempted: false, ok: false, containment: false, elapsedMs: 0, notice,
    observedCalls: 0, argvModel: null, argvEffort: null, mismatch: null, verified: false, unverified: 'NOT_RUN',
  };
}

const SAMPLE_PHASES = Object.freeze(['warmup', 'decide']);

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const UNSAFE_NOTICE = /CHILD_(?:SIGNAL_FAILED|CLOSE_UNCONFIRMED)/;
const isUnsafeTermination = (code) => code === 'CHILD_SIGNAL_FAILED' || code === 'CHILD_CLOSE_UNCONFIRMED';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(variant, samples) {
  const count = (status) => samples.filter((sample) => sample.status === status).length;
  const attempted = samples.filter((sample) => sample.status !== 'skipped');
  const decided = samples.filter((sample) => typeof sample.decideMs === 'number');
  const latencies = decided.map((sample) => sample.decideMs);
  const actions = {};
  for (const sample of samples) if (sample.legal) actions[sample.action] = (actions[sample.action] ?? 0) + 1;
  return {
    samples: samples.length, attempted: attempted.length,
    legal: count('ok'), invalid: count('invalid'), timeout: count('timeout'), failed: count('failed'),
    terminationUnconfirmed: count('termination_unconfirmed'), skipped: count('skipped'),
    // unobserved: 응답은 받았지만 그 단계에서 자식 argv가 하나도 관측되지 않은 표본. 합법 응답으로 세지 않는다.
    unobserved: count('unobserved'),
    unobservedPhases: samples.reduce((sum, sample) => sum + (sample.unobservedPhases?.length ?? 0), 0),
    modelMismatches: samples.filter((sample) => sample.mismatch).length,
    decideMs: {
      observations: latencies, median: median(latencies),
      min: latencies.length ? Math.min(...latencies) : null, max: latencies.length ? Math.max(...latencies) : null,
      overSoft25s: latencies.filter((ms) => ms > SOFT_MS).length,
    },
    actions,
    // 어댑터의 ok·containment 주장만으로는 통과가 아니다 — 실제 probe 자식 argv가 관측되고 요청과 일치해야 한다.
    probeOk: variant.probe.verified === true,
  };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

/**
 * 두 설정을 같은 스팟으로 돌린다. `deps`는 테스트용 이음새다:
 *   createRuntime(kind, opts) — 기본 `createPlayerRuntime`; exec — 기본 `spawnCli`; runtimeOpts — 어댑터 추가 옵션;
 *   tmpRoot — 임시 디렉터리 부모; now — 시계(ms).
 */
export async function runComparison(rawOptions = {}, deps = {}) {
  const options = validateComparisonOptions(rawOptions);
  const createRuntime = deps.createRuntime ?? createPlayerRuntime;
  const baseExec = deps.exec ?? spawnCli;
  const now = deps.now ?? Date.now;
  const spots = buildComparisonSpots(options.samples);
  const prompt = buildPlayerPrompt({ persona: PERSONA });

  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(deps.tmpRoot ?? os.tmpdir()), 'ai-holdem-compare-'));
  const cwdRoot = path.join(tmp, 'cwd');
  fs.mkdirSync(cwdRoot);
  const canaryAbsPath = path.join(tmp, `canary-${randomUUID()}.txt`);
  fs.writeFileSync(canaryAbsPath, `SENTINEL-compare-${randomUUID()}\n`);

  const startedAt = now();
  const deadline = startedAt + options.budgetMs;
  let aborted = null;
  let cleanup = null;
  // 어댑터는 만들어지는 대로 runs에 넣는다 — 둘째 생성이 던져도 첫째는 finally에서 dispose된다.
  const runs = [];

  try {
    for (const variant of COMPARISON_VARIANTS) {
      const argvLog = [];
      const pin = benchmarkPlayerPin('codex', { model: variant.model, effort: variant.effort });
      const adapter = createRuntime('codex', {
        ...(deps.runtimeOpts ?? {}),
        cwdRoot,
        benchmarkPin: pin,
        exec: (spec) => {
          const child = baseExec(spec);
          if (Number.isInteger(child?.pid) && child.pid > 0) argvLog.push([...spec.args]);
          return child;
        },
      });
      runs.push({ variant, adapter, argvLog, halted: false, probe: probeNotRun('probe를 돌지 않았습니다.'), samples: [] });
    }
    // 1) 실제 no-tool probe. 어댑터의 통과 주장은 실제 probe 자식 argv가 관측되고 요청한 모델/effort와 일치할 때만
    //    `verified`다. 통과(verified)하지 못한 설정은 표본을 돌지 않거나(실패·미관측) 불합격으로 보고된다(불일치).
    for (const run of runs) {
      if (aborted) break;
      if (deadline - now() < options.timeoutMs) { run.probe = probeNotRun('예산 소진으로 probe를 건너뜁니다.'); continue; }
      const argvFrom = run.argvLog.length;
      let claim;
      try {
        const result = await run.adapter.probe({ canaryAbsPath, timeoutMs: options.timeoutMs });
        claim = {
          ok: result.ok === true, containment: result.containment === true, elapsedMs: result.elapsedMs ?? null,
          ...(result.notice ? { notice: String(result.notice) } : {}),
        };
        if (claim.notice && UNSAFE_NOTICE.test(claim.notice)) aborted = { code: 'TERMINATION_UNCONFIRMED', variant: run.variant.id, phase: 'probe' };
      } catch (error) {
        claim = { ok: false, containment: false, elapsedMs: null, notice: `probe 오류: ${error.code ?? 'ERROR'}` };
        if (isUnsafeTermination(error.code)) aborted = { code: 'TERMINATION_UNCONFIRMED', variant: run.variant.id, phase: 'probe' };
      }
      const observed = observeCalls(run.argvLog, argvFrom, run.variant);
      const adapterModel = run.adapter.models?.player ?? null;
      const mismatch = observed.wrong > 0 ? mismatchRecord(run.variant, adapterModel, observed) : null;
      const unverified = !(claim.ok && claim.containment) ? 'PROBE_FAILED'
        : observed.count === 0 ? 'NO_CHILD_OBSERVED'
          : mismatch ? 'MODEL_MISMATCH' : null;
      run.probe = {
        attempted: true, ...claim,
        observedCalls: observed.count, argvModel: observed.argvModel, argvEffort: observed.argvEffort, mismatch,
        verified: unverified === null, unverified,
      };
    }

    // 2) 스팟마다 두 설정을 번갈아 돌린다.
    for (const [spotIndex, spot] of spots.entries()) {
      const runOrder = spotIndex % 2 === 0 ? [0, 1] : [1, 0];
      for (const [position, runIndex] of runOrder.entries()) {
        const run = runs[runIndex];
        const sample = await runSample({ run, spot, position, prompt, options, deadline, now, aborted: () => aborted });
        run.samples[spotIndex] = sample;
        if (sample.status === 'termination_unconfirmed' && !aborted) {
          aborted = { code: 'TERMINATION_UNCONFIRMED', variant: run.variant.id, phase: 'sample', spot: spot.id };
        }
      }
    }
  } finally {
    // 3) 어댑터는 항상 dispose한다. 한 번 실패하면 짧게 기다렸다가 다시 확인한다.
    cleanup = await disposeAll(runs, tmp);
  }

  const variants = runs.map((run) => {
    const samples = spots.map((spot, i) => run.samples[i] ?? skipped(run, spot, 'NOT_REACHED'));
    return {
      id: run.variant.id,
      requested: { model: run.variant.model, effort: run.variant.effort },
      adapterModel: run.adapter.models?.player ?? null,
      probe: run.probe,
      samples,
      summary: summarize(run, samples),
    };
  });
  const sameAction = [];
  for (const [i, spot] of spots.entries()) {
    const [a, b] = variants.map((variant) => variant.samples[i]);
    if (a.legal && b.legal) sameAction.push({ spot: spot.id, same: a.action === b.action, amountsEqual: a.amount === b.amount });
  }
  // 불일치 목록은 probe 단계와 표본(warmup·decide) 단계를 모두 싣는다.
  const mismatches = variants.flatMap((variant) => [
    ...(variant.probe.mismatch ? [{ variant: variant.id, phase: 'probe', spot: null, ...variant.probe.mismatch }] : []),
    ...variant.samples.filter((sample) => sample.mismatch)
      .map((sample) => ({ variant: variant.id, phase: 'sample', spot: sample.spotId, ...sample.mismatch })),
  ]);
  const verdict = judgeComparison({ options, variants, aborted, mismatches, cleanup });
  const finishedAt = now();
  return {
    schema: 'codex-player-comparison/3',
    options,
    budget: { softMs: DEFAULT_PLAYER_BUDGET.softMs, hardMs: DEFAULT_PLAYER_BUDGET.hardMs, adapterDirectDefaultMs: RUNTIME_TABLE.codex.watchdog.t1Ms },
    elapsedMs: finishedAt - startedAt,
    spots: spots.map(({ id, label, street }) => ({ id, label, street })),
    variants,
    agreement: { comparedSpots: sameAction.length, sameAction: sameAction.filter((x) => x.same).length, detail: sameAction },
    mismatches,
    aborted,
    cleanup,
    ...verdict,
    caveats: [...COMPARISON_CAVEATS],
  };
}

// ── 판정 ─────────────────────────────────────────────────────────────────────

/** 변형 하나의 게이트. `obtained`는 응답을 받아 합법성까지 판정한 표본(ok·invalid)이다. */
function variantGates(summary, requested) {
  const obtained = summary.legal + summary.invalid;
  return {
    complete: summary.probeOk && summary.samples === requested && obtained === requested && summary.skipped === 0,
    // 받은 응답이 하나도 없으면 "전부 합법"은 공허한 참이다 — 닫는다.
    allDecisionsLegal: obtained > 0 && summary.invalid === 0,
  };
}

/**
 * ok = executionOk && complete && allDecisionsLegal.
 *   executionOk       하네스가 안전하게 돌았다: 자식 종료 미확인으로 중단하지 않았고, 요청과 다른 모델/effort로 나간 호출이
 *                     (probe·warmup·decide 어느 단계에도) 없고, 실제로 돌린 모든 단계에서 자식 argv가 관측됐고,
 *                     어댑터를 전부 dispose했고 임시 디렉터리를 지웠다.
 *   complete          변형마다 probe가 검증됐고(통과 주장 + 자식 argv 관측 + 요청과 일치) 요청한 모든 표본의 응답을
 *                     실제 자식으로부터 얻었다(건너뜀·타임아웃·호출 실패·미관측 없음).
 *   allDecisionsLegal 변형마다 응답을 하나 이상 얻었고 얻은 응답이 전부 합법이다.
 * 실패한 호출·타임아웃·무효 응답은 변형 표본에 그대로 남는다 — 판정과 별개로 쓸 수 있는 관측 자료다.
 */
function judgeComparison({ options, variants, aborted, mismatches, cleanup }) {
  // 변형마다 `gates`를 붙인다(보고서의 변형 객체가 그대로 나간다).
  const failures = [];
  const fail = (gate, variant, code, detail) => failures.push({ gate, variant, code, ...(detail === undefined ? {} : { detail }) });

  if (aborted) fail('executionOk', aborted.variant, aborted.code, aborted.phase);
  for (const variant of variants) {
    if (!aborted && variant.summary.terminationUnconfirmed > 0) fail('executionOk', variant.id, 'TERMINATION_UNCONFIRMED');
    // 실제로 돌린 단계인데 자식 argv가 하나도 관측되지 않았다 — 측정이 아니라 어댑터의 주장만 있는 것이다.
    if (variant.probe.attempted && variant.probe.observedCalls === 0) fail('executionOk', variant.id, 'NO_CHILD_OBSERVED', 'probe');
    if (variant.summary.unobservedPhases > 0) {
      fail('executionOk', variant.id, 'NO_CHILD_OBSERVED', { samples: variant.summary.unobserved, phases: variant.summary.unobservedPhases });
    }
    const bad = mismatches.filter((entry) => entry.variant === variant.id).length;
    if (bad > 0) fail('executionOk', variant.id, 'MODEL_MISMATCH', bad);
  }
  if (cleanup.disposed !== true) fail('executionOk', null, 'DISPOSE_UNCONFIRMED');
  if (cleanup.removed !== true) fail('executionOk', null, 'TMP_NOT_REMOVED');

  for (const variant of variants) {
    const s = variant.summary;
    variant.gates = variantGates(s, options.samples);
    const before = failures.length;
    if (!s.probeOk) fail('complete', variant.id, 'PROBE_NOT_PASSED', variant.probe.notice ?? variant.probe.unverified ?? null);
    if (s.unobserved > 0) fail('complete', variant.id, 'NO_CHILD_OBSERVED', s.unobserved);
    if (s.skipped > 0) fail('complete', variant.id, 'SKIPPED', s.skipped);
    if (s.timeout > 0) fail('complete', variant.id, 'TIMEOUT', s.timeout);
    if (s.failed > 0) fail('complete', variant.id, 'CALL_FAILED', s.failed);
    if (s.terminationUnconfirmed > 0) fail('complete', variant.id, 'TERMINATION_UNCONFIRMED', s.terminationUnconfirmed);
    if (!variant.gates.complete && failures.length === before) fail('complete', variant.id, 'MEASUREMENTS_MISSING');
    if (s.invalid > 0) fail('allDecisionsLegal', variant.id, 'ILLEGAL_DECISION', s.invalid);
    if (s.legal + s.invalid === 0) fail('allDecisionsLegal', variant.id, 'NO_DECISIONS_OBSERVED');
  }
  const executionOk = !failures.some((failure) => failure.gate === 'executionOk');
  const complete = variants.every((variant) => variant.gates.complete);
  const allDecisionsLegal = variants.every((variant) => variant.gates.allDecisionsLegal);
  return { executionOk, complete, allDecisionsLegal, ok: executionOk && complete && allDecisionsLegal, failures };
}

function skipped(run, spot, reason) {
  return {
    spotId: spot.id, status: 'skipped', legal: false, action: null, amount: null, reason: null, errorCode: reason,
    warmupMs: null, decideMs: null, argvModel: null, argvEffort: null, mismatch: null,
    // 단계별로 관측된 실제 자식 argv 수. null = 그 단계를 돌리지 않았다. 돌렸는데 0이면 unobservedPhases에 든다.
    observedCalls: { warmup: null, decide: null }, unobservedPhases: [],
  };
}

async function runSample({ run, spot, position, prompt, options, deadline, now, aborted }) {
  const { variant, adapter, argvLog } = run;
  if (aborted()) return skipped(run, spot, 'ABORTED');
  if (run.halted) return skipped(run, spot, 'VARIANT_HALTED');
  if (!(run.probe.ok && run.probe.containment)) return skipped(run, spot, 'PROBE_FAILED');
  // probe 자식이 관측되지 않았으면 컨테인먼트가 실제로 검증된 적이 없다 — 그 설정으로는 자식을 더 띄우지 않는다.
  if (run.probe.observedCalls === 0) return skipped(run, spot, 'PROBE_UNOBSERVED');
  const record = { ...skipped(run, spot, null), status: 'failed', order: position };
  const argvFrom = argvLog.length;
  const phaseFrom = {};
  const beginPhase = (phase) => { phaseFrom[phase] = argvLog.length; };
  const endPhase = (phase) => { record.observedCalls[phase] = argvLog.length - phaseFrom[phase]; };
  const finish = () => {
    const observed = observeCalls(argvLog, argvFrom, variant);
    record.argvModel = observed.argvModel;
    record.argvEffort = observed.argvEffort;
    record.adapterModel = adapter.models?.player ?? null;
    const adapterWrong = record.adapterModel !== variant.model;
    record.mismatch = observed.wrong > 0 || adapterWrong ? mismatchRecord(variant, record.adapterModel, observed) : null;
    record.unobservedPhases = SAMPLE_PHASES.filter((phase) => record.observedCalls[phase] === 0);
    // 어댑터가 응답을 돌려줬어도 그 단계에서 자식이 관측되지 않았으면 측정이 아니다. 어댑터 해석 모델이 요청과
    // 같다는 것도 실행의 증거가 아니다. 이미 실패·타임아웃·종료 미확인인 표본은 그 진단을 유지한다.
    if (record.unobservedPhases.length > 0 && (record.status === 'ok' || record.status === 'invalid')) {
      record.status = 'unobserved';
      record.legal = false;
      record.action = null;
      record.amount = null;
      record.reason = null;
      delete record.rejectionDetail;
      record.errorCode = 'NO_CHILD_OBSERVED';
      record.errorPhase = record.unobservedPhases[0];
    }
    return record;
  };
  const guardBudget = () => deadline - now() < options.timeoutMs;
  const classify = (error, phase) => {
    record.errorCode = error?.code ?? 'ERROR';
    record.errorPhase = phase;
    if (isUnsafeTermination(record.errorCode)) { record.status = 'termination_unconfirmed'; run.halted = true; }
    else record.status = record.errorCode === 'TIMEOUT' ? 'timeout' : 'failed';
    return finish();
  };

  if (guardBudget()) return skipped(run, spot, 'BUDGET_EXHAUSTED');
  let sessionId;
  let began = now();
  beginPhase('warmup');
  try {
    ({ sessionId } = await adapter.warmup({ playerId: PLAYER_ID, prompt, timeoutMs: options.timeoutMs }));
    record.warmupMs = now() - began;
    endPhase('warmup');
  } catch (error) {
    record.warmupMs = now() - began;
    endPhase('warmup');
    return classify(error, 'warmup');
  }
  if (guardBudget()) { record.status = 'skipped'; record.errorCode = 'BUDGET_EXHAUSTED'; return finish(); }
  began = now();
  let raw;
  beginPhase('decide');
  try {
    ({ raw } = await adapter.decide({ playerId: PLAYER_ID, sessionId, message: spot.message, timeoutMs: options.timeoutMs }));
    record.decideMs = now() - began;
    endPhase('decide');
  } catch (error) {
    record.decideMs = now() - began;
    endPhase('decide');
    return classify(error, 'decide');
  }
  const verdict = classifyDecision(raw, { decisionId: spot.decisionId, message: spot.message });
  if (verdict.ok) {
    record.status = 'ok';
    record.legal = true;
    record.action = verdict.action.action;
    record.amount = verdict.action.amount ?? null;
    record.reason = verdict.action.reason ?? null;
  } else {
    record.status = 'invalid';
    record.errorCode = verdict.rejection.code;
    record.rejectionDetail = verdict.rejection.detail;
  }
  return finish();
}

async function disposeAll(runs, tmp) {
  const outcome = { disposed: true, removed: false, tmp: null, errors: [] };
  const attempt = async () => {
    // 각 dispose를 promise 안에서 부른다 — 하나가 동기적으로 던져도 나머지 어댑터의 dispose는 전부 시도되고,
    // 그 실패는 보고서의 cleanup.errors로 간다(보고서 없이 거부되지 않는다).
    const results = await Promise.allSettled(runs.map((run) => Promise.resolve().then(() => run.adapter.dispose())));
    return results.flatMap((result, i) => (result.status === 'rejected'
      ? [{ variant: runs[i].variant.id, code: result.reason?.code ?? 'ERROR' }] : []));
  };
  let errors = await attempt();
  if (errors.length > 0) {
    await sleep(500);
    errors = await attempt();
  }
  outcome.errors = errors;
  outcome.disposed = errors.length === 0;
  if (outcome.disposed) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      outcome.removed = true;
    } catch {
      outcome.tmp = tmp;
    }
  } else {
    // 자식 종료를 확인하지 못했으면 그 cwd를 쓰고 있을 수 있다 — 지우지 않고 위치를 알린다.
    outcome.tmp = tmp;
  }
  return outcome;
}

// ── 출력 ─────────────────────────────────────────────────────────────────────

const failureText = ({ gate, variant, code, detail }) => `${gate} ${variant ?? '-'} ${code}${detail === undefined || detail === null ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`;

function verdictLine(report) {
  const gates = `executionOk=${report.executionOk} · complete=${report.complete} · allDecisionsLegal=${report.allDecisionsLegal}`;
  return report.ok ? `판정: 완전·전부 합법(ok) — ${gates}` : `판정: 불합격(ok=false) — ${gates}`;
}

export function formatReport(report) {
  const lines = [];
  lines.push(`codex 플레이어 비교 — 표본 ${report.options.samples}, 호출별 상한 ${report.options.timeoutMs}ms, 소요 ${report.elapsedMs}ms`);
  for (const variant of report.variants) {
    const s = variant.summary;
    lines.push('');
    const probeText = s.probeOk
      ? `통과(argv ${variant.probe.observedCalls}회 확인)`
      : `미통과(${variant.probe.unverified ?? '?'}${variant.probe.notice ? `: ${variant.probe.notice}` : ''})`;
    lines.push(`[${variant.id}] 요청 ${variant.requested.model}/${variant.requested.effort} · 어댑터 해석 ${variant.adapterModel} · probe ${probeText}`);
    lines.push(`  합법 ${s.legal}/${s.attempted} · 형식/합법성 거부 ${s.invalid} · 타임아웃 ${s.timeout} · 실패 ${s.failed} · 종료 미확인 ${s.terminationUnconfirmed} · 미관측 ${s.unobserved} · 건너뜀 ${s.skipped} · 모델 불일치 ${s.modelMismatches}`);
    lines.push(`  결정 지연 ms: ${s.decideMs.observations.length ? s.decideMs.observations.join(', ') : '없음'} (중앙 ${s.decideMs.median ?? '-'}, 최대 ${s.decideMs.max ?? '-'}, 25초 초과 ${s.decideMs.overSoft25s})`);
    for (const sample of variant.samples) {
      const decision = sample.legal ? `${sample.action}${sample.amount === null ? '' : ` ${sample.amount}`}` : `${sample.status}${sample.errorCode ? `(${sample.errorCode})` : ''}`;
      lines.push(`    ${sample.spotId}: ${decision}${sample.reason ? ` — ${sample.reason}` : ''}`);
    }
  }
  lines.push('');
  lines.push(`같은 행동 ${report.agreement.sameAction}/${report.agreement.comparedSpots} (둘 다 합법 응답을 낸 스팟만)`);
  if (report.mismatches.length) lines.push(`모델/effort 불일치 ${report.mismatches.length}건: ${JSON.stringify(report.mismatches)}`);
  if (report.aborted) lines.push(`중단: ${JSON.stringify(report.aborted)}`);
  lines.push(`정리: dispose ${report.cleanup.disposed ? '확인' : `실패 ${JSON.stringify(report.cleanup.errors)}`} · 임시 디렉터리 ${report.cleanup.removed ? '삭제' : `보존 ${report.cleanup.tmp}`}`);
  lines.push('');
  lines.push(verdictLine(report));
  for (const failure of report.failures) lines.push(`  - ${failureText(failure)}`);
  lines.push('');
  for (const caveat of report.caveats) lines.push(`주의: ${caveat}`);
  return lines.join('\n');
}

const USAGE = `사용법: node tools/compare-codex-players.js [--live] [--samples N] [--timeout-ms N] [--budget-ms N] [--json]
  --live  없이 실행하면 계획만 출력하고 codex를 부르지 않는다. 실제 호출은 --live가 있을 때만이다.
  종료 코드: 0 = 완전하고 전부 합법(ok) · 3 = 실행했지만 불완전·무효·불가(ok=false) · 2 = 인자 오류 · 1 = 실행 오류
  기본 ${COMPARISON_LIMITS.defaultSamples}표본, 호출별 ${COMPARISON_LIMITS.defaultTimeoutMs}ms, 전체 ${COMPARISON_LIMITS.defaultBudgetMs}ms
  상한: 표본 ${COMPARISON_LIMITS.maxSamples}, 호출별 ${COMPARISON_LIMITS.maxTimeoutMs}ms, 전체 ${COMPARISON_LIMITS.maxBudgetMs}ms`;

export function parseCliArgs(argv) {
  const parsed = { live: false, json: false, options: {} };
  const numeric = { '--samples': 'samples', '--timeout-ms': 'timeoutMs', '--budget-ms': 'budgetMs' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') parsed.live = true;
    else if (arg === '--json') parsed.json = true;
    else if (Object.hasOwn(numeric, arg)) {
      const text = argv[i + 1];
      if (typeof text !== 'string' || !/^\d{1,9}$/.test(text)) throw comparisonError('BAD_ARGS', `BAD_ARGS: ${arg}에는 정수가 필요합니다.`);
      parsed.options[numeric[arg]] = Number(text);
      i += 1;
    } else throw comparisonError('BAD_ARGS', `BAD_ARGS: 알 수 없는 인자 ${String(arg).slice(0, 40)}`);
  }
  validateComparisonOptions(parsed.options);
  return parsed;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (!parsed.live) {
    const plan = comparisonPlan(parsed.options);
    stdout.write(parsed.json ? `${JSON.stringify({ executed: false, plan }, null, 2)}\n`
      : `실행하지 않음(--live 없음). 계획: ${JSON.stringify(plan)}\n`);
    return 0;
  }
  const report = await runComparison(parsed.options, deps);
  stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
  if (report.ok) return 0;
  // JSON 모드에서도 stdout은 순수 JSON으로 두고, 합격하지 못한 이유는 stderr로 알린다.
  stderr.write(`비교 불합격(ok=false): ${report.failures.map(failureText).join(' | ')}\n`);
  return 3;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
