import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipOnWin32 } from './helpers/platform.js';
import {
  COMPARISON_CAVEATS,
  COMPARISON_LIMITS,
  COMPARISON_VARIANTS,
  buildComparisonSpots,
  comparisonPlan,
  formatReport,
  main,
  parseCliArgs,
  runComparison,
  validateComparisonOptions,
} from '../tools/compare-codex-players.js';
import { legalFromMessage } from '../tools/player-decision.js';
import { createPlayerRuntime, spawnCli } from '../tools/player-runtime.js';

// 모든 테스트는 가짜 CLI(`test/helpers/fake-cli.js`)만 띄운다 — 실제 codex·네트워크·store는 쓰지 않는다.
const FAKE_CLI = fileURLToPath(new URL('./helpers/fake-cli.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LUNA = 'gpt-6-luna';
const SOL = 'gpt-6.1-sol';

const jsonl = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const reply = (text) => jsonl(
  { type: 'thread.started', thread_id: 'th-compare-1' },
  { type: 'item.completed', item: { type: 'agent_message', text } },
);
const decision = (spot, body) => reply(JSON.stringify({ decisionId: spot.decisionId, ...body }));
const legalOf = (spot) => legalFromMessage(spot.message);
const safeAction = (spot) => (legalOf(spot).canCheck ? 'check' : 'call');

function fixture(t, { script = {}, deps = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-compare-test-'));
  const scriptPath = path.join(dir, 'script.json');
  const logPath = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(scriptPath, JSON.stringify({ default: { reply: reply('ready') }, ...script }));
  const tmpRoot = path.join(dir, 'tmp');
  fs.mkdirSync(tmpRoot);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.argv);
  return {
    dir,
    tmpRoot,
    calls,
    deps: {
      tmpRoot,
      runtimeOpts: { env: { FAKE_CLI_SCRIPT: scriptPath, FAKE_CLI_LOG: logPath }, terminateKillWaitMs: 300 },
      exec: (spec) => spawnCli({ ...spec, command: process.execPath, args: [FAKE_CLI, ...spec.args] }),
      ...deps,
    },
  };
}

// 세 게이트와 ok의 관계는 모든 시나리오에서 같아야 한다 — ok는 셋의 논리곱이다.
function assertGates(report, expected, message = '') {
  const actual = { executionOk: report.executionOk, complete: report.complete, allDecisionsLegal: report.allDecisionsLegal };
  assert.deepEqual(actual, expected, `${message} ${JSON.stringify(report.failures)}`);
  assert.equal(report.ok, expected.executionOk && expected.complete && expected.allDecisionsLegal, `ok는 세 게이트의 논리곱이다 ${message}`);
  assert.equal(report.ok === true, report.failures.length === 0, 'ok이면 불합격 사유가 없고, 아니면 사유가 있다');
  for (const failure of report.failures) assert.ok(['executionOk', 'complete', 'allDecisionsLegal'].includes(failure.gate), JSON.stringify(failure));
}

async function runCli(argv, deps) {
  const out = [];
  const err = [];
  const code = await main(argv, { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) }, deps });
  return { code, out: out.join(''), err: err.join('') };
}

const modelOf = (argv) => argv[argv.indexOf('-m') + 1];
const efforts = (argv) => argv.filter((arg) => arg.startsWith('model_reasoning_effort='));
const decideCalls = (calls) => calls.filter((call) => call.argv.includes('resume'));

// 자식을 하나도 띄우지 않는 각본 어댑터. 실제 어댑터처럼 단계마다 `opts.exec`에 argv를 넘기므로(도구의 exec 래퍼가
// 그 argv를 관측한다) "어느 단계가 어떤 argv로 자식을 띄웠다고 말하는가"를 시나리오별로 정확히 통제할 수 있다.
// 기본 각본은 정직하다: probe·warmup·decide가 각각 핀의 모델/effort로 argv 한 번씩을 낸다. `silent`에 든 단계는
// argv를 내지 않고도 성공을 주장하고, `probeOverride`는 probe argv의 모델/effort만 바꾼다.
function scriptedRuntime(spots, scenarioFor = () => ({})) {
  const log = { warmups: [], decides: [], disposed: [] };
  const createRuntime = (kind, opts) => {
    const pin = opts.benchmarkPin;
    const scenario = scenarioFor(pin.model);
    const silent = new Set(scenario.silent ?? []);
    const argvFor = (purpose, { model = pin.model, effort = pin.effort } = {}) => [
      ...(effort === 'model-default' ? [] : ['-c', `model_reasoning_effort="${effort}"`]),
      ...(purpose === 'resume' ? ['exec', 'resume', '-m', model, 'sess-1'] : ['exec', '--sandbox', 'read-only', '-m', model]),
    ];
    const emit = (phase, purpose, override) => {
      if (silent.has(phase)) return;
      const args = argvFor(purpose, override);
      try { opts.exec({ command: 'codex', args: scenario.transformArgs?.(phase, args) ?? args, cwd: opts.cwdRoot, input: '' }); }
      catch (error) { if (!scenario.swallowExecError) throw error; }
    };
    return {
      models: { player: scenario.adapterModel ?? pin.model },
      async probe() { emit('probe', 'exec', scenario.probeOverride); return { ok: true, containment: true, elapsedMs: 1 }; },
      async warmup({ prompt }) { log.warmups.push(pin.model); emit('warmup', 'exec'); assert.ok(prompt.length > 0); return { sessionId: 'sess-1' }; },
      async decide({ message }) {
        log.decides.push(pin.model);
        emit('decide', 'resume');
        const spot = spots.find((candidate) => candidate.message === message);
        return { raw: JSON.stringify({ decisionId: spot.decisionId, action: safeAction(spot), reason: '각본 사유' }) };
      },
      async dispose() { log.disposed.push(pin.model); },
    };
  };
  // exec 스텁: 자식을 띄우지 않는다. 도구의 래퍼가 argv를 기록한 뒤 여기로 넘긴다.
  const exec = () => { log.spawned = (log.spawned ?? 0) + 1; return { pid: 12345, kill: () => true, done: Promise.resolve({ code: 0 }) }; };
  return { log, deps: { createRuntime, exec } };
}

test('실행: 동기 spawn 실패를 삼킨 어댑터도 실제 자식 관측으로 세지 않는다', async (t) => {
  const f = fixture(t);
  for (const exec of [() => { throw new Error('spawn failed'); }, () => ({ pid: null }), () => ({ pid: 0 })]) {
    const scripted = scriptedRuntime(buildComparisonSpots(1), () => ({ swallowExecError: true }));
    const report = await runComparison({ samples: 1 }, { tmpRoot: f.tmpRoot, ...scripted.deps, exec });
    assert.equal(report.executionOk, false);
    assert.equal(report.ok, false);
    for (const variant of report.variants) {
      assert.equal(variant.probe.observedCalls, 0);
      assert.equal(variant.probe.unverified, 'NO_CHILD_OBSERVED');
    }
  }
});

test('실행: probe·warmup·decide의 중복 모델 인자는 두 순서 모두 거부하고 모든 값을 남긴다', async (t) => {
  const f = fixture(t);
  for (const phase of ['probe', 'warmup', 'decide']) for (const first of [false, true]) {
    const scripted = scriptedRuntime(buildComparisonSpots(1), (model) => model === LUNA ? {
      transformArgs: (current, args) => current !== phase ? args : first ? ['-m', SOL, ...args] : [...args, '--model', SOL],
    } : {});
    const report = await runComparison({ samples: 1 }, { tmpRoot: f.tmpRoot, ...scripted.deps });
    assert.equal(report.executionOk, false, `${phase} ${first}`);
    assert.equal(report.ok, false);
    const mismatch = report.mismatches.find((row) => row.variant === 'luna-default');
    assert.ok(mismatch, `${phase} ${first}`);
    assert.deepEqual([...new Set(mismatch.modelOccurrences)].sort(), [SOL, LUNA].sort());
  }
});

test('실행: 중복 effort·config model 인자도 단계마다 생략 없이 대조한다', async (t) => {
  const f = fixture(t);
  for (const phase of ['probe', 'warmup', 'decide']) for (const option of [
    ['--config', 'model_reasoning_effort="medium"'], ['--model=gpt-6-luna'], ['-c', 'model="gpt-6-luna"'],
    ['-mgpt-6-luna'], ['-cmodel_reasoning_effort="medium"'],
  ]) {
    const scripted = scriptedRuntime(buildComparisonSpots(1), (model) => model === SOL ? {
      transformArgs: (current, args) => current === phase ? [...args, ...option] : args,
    } : {});
    const report = await runComparison({ samples: 1 }, { tmpRoot: f.tmpRoot, ...scripted.deps });
    assert.equal(report.executionOk, false, `${phase} ${option}`);
    assert.equal(report.ok, false);
    const mismatch = report.mismatches.find((row) => row.variant === 'sol-low');
    assert.ok(mismatch);
    assert.ok(option.join(' ').includes('effort') ? mismatch.effortOccurrences.includes('medium') : mismatch.modelOccurrences.includes(LUNA));
  }
});

// 변형·스팟별 결정 응답: luna는 항상 fold(체크 가능하면 check), sol은 check/call. 한 스팟은 luna가 범위 밖 레이즈를 낸다.
function decisionMatchers(spots, { invalidSpot = null } = {}) {
  return spots.flatMap((spot) => [
    {
      includes: `decisionId: ${spot.decisionId}`, argvIncludes: LUNA,
      reply: spot.id === invalidSpot
        ? decision(spot, { action: 'raise', amount: 1, reason: '범위 밖' })
        : decision(spot, { action: legalOf(spot).canCheck ? 'check' : 'fold', reason: '루나 사유' }),
    },
    { includes: `decisionId: ${spot.decisionId}`, argvIncludes: SOL, reply: decision(spot, { action: safeAction(spot), reason: '솔 사유' }) },
  ]);
}

test('옵션 검증: 기본값은 작고, 표본·타임아웃·예산은 상한 안의 정수만 받는다', () => {
  assert.deepEqual(validateComparisonOptions({}), { samples: 6, timeoutMs: 60_000, budgetMs: 900_000 });
  assert.equal(COMPARISON_LIMITS.maxTimeoutMs, 300_000, '운영 hard 예산을 넘지 않는다');
  const bad = [
    { samples: 0 }, { samples: 9 }, { samples: 1.5 }, { samples: '6' }, { timeoutMs: 100 }, { timeoutMs: 300_001 },
    { budgetMs: 3_600_001 }, { budgetMs: -1 }, { samples: NaN }, { extra: 1 }, [], null,
  ];
  for (const options of bad) {
    assert.throws(() => validateComparisonOptions(options), { code: 'BAD_COMPARISON_OPTIONS' }, JSON.stringify(options));
  }
  assert.deepEqual(validateComparisonOptions({ samples: 8, timeoutMs: 250, budgetMs: 250 }), { samples: 8, timeoutMs: 250, budgetMs: 250 });
});

test('계획은 호출 수 상한을 알려 주고 변형은 Luna/model-default와 Sol/low 둘뿐이다', () => {
  assert.deepEqual(COMPARISON_VARIANTS.map(({ id, model, effort }) => [id, model, effort]), [
    ['luna-default', LUNA, 'model-default'], ['sol-low', SOL, 'low'],
  ]);
  const plan = comparisonPlan({ samples: 4, timeoutMs: 1000, budgetMs: 600_000 });
  assert.equal(plan.maxModelCalls, 2 * (1 + 2 * 4));
  assert.equal(plan.worstCaseWallMs, plan.maxModelCalls * 1000);
  assert.equal(plan.spots.length, 4);
});

test('공개 스냅샷: 스팟은 다양하고 엔진이 만든 합법 요약이며, 행동자의 카드만 싣는다', () => {
  const spots = buildComparisonSpots(8);
  assert.equal(buildComparisonSpots().length, 6, '기본은 6개');
  assert.equal(new Set(spots.map((spot) => spot.id)).size, 8);
  assert.ok(new Set(spots.map((spot) => spot.street)).size === 4, '프리플랍·플랍·턴·리버를 모두 포함한다');
  const hands = spots.map((spot) => /홀카드: (\S+ \S+)/.exec(spot.message)[1]);
  for (const spot of spots) {
    const legal = legalOf(spot);
    assert.ok(legal, spot.id);
    assert.ok(spot.message.includes(spot.decisionId), spot.id);
    assert.ok(legal.canCheck || legal.callAmount > 0, spot.id);
    assert.ok(legal.canRaise, `${spot.id}: 레이즈도 합법 선택지다`);
    const board = /보드: ([^\n]+)/.exec(spot.message)[1];
    const expected = { preflop: 0, flop: 3, turn: 4, river: 5 }[spot.street];
    assert.equal(board === '없음' ? 0 : board.split(' ').length, expected, spot.id);
  }
  assert.ok(new Set(hands).size >= 7, '행동자 핸드가 스팟마다 다르다');
  // 상대 카드(스팟 정의의 p1/p2/user 중 행동자가 아닌 쪽)는 요약에 없다.
  const others = {
    'preflop-open-btn': ['7c', '2d', 'Th', '3s'], 'river-facing-overbet-bb': ['8c', '7c', 'Kh', 'Th'],
    'turn-facing-bet-btn': ['Jd', 'Tc', 'Kd', '8s'],
  };
  for (const [id, cards] of Object.entries(others)) {
    const spot = spots.find((candidate) => candidate.id === id);
    for (const card of cards) assert.equal(spot.message.includes(card), false, `${id}에 상대 카드 ${card}가 있다`);
  }
  assert.match(spots.find((spot) => spot.id === 'preflop-short-stack-12bb').message, /내 스택 12\.0BB/);
  assert.throws(() => buildComparisonSpots(0), { code: 'BAD_COMPARISON_OPTIONS' });
  assert.throws(() => buildComparisonSpots(9), { code: 'BAD_COMPARISON_OPTIONS' });
});

test('실행: 두 설정이 같은 스냅샷·같은 컨테인먼트 argv로 돌고, 모델/effort는 설정마다 정확히 하나씩 실린다', async (t) => {
  const spots = buildComparisonSpots(3);
  const f = fixture(t, { script: { matchers: decisionMatchers(spots, { invalidSpot: spots[1].id }) } });
  const report = await runComparison({ samples: 3, timeoutMs: 20_000, budgetMs: 120_000 }, f.deps);
  assert.equal(report.schema, 'codex-player-comparison/3');
  // 불법 응답이 하나 있어도 관측은 끝까지 모았다(complete) — 하지만 합격(ok)은 아니다.
  assertGates(report, { executionOk: true, complete: true, allDecisionsLegal: false });
  assert.equal(report.ok, false, '범위 밖 레이즈가 있는 비교는 합격이 아니다');
  assert.deepEqual(report.failures.map(({ gate, variant, code }) => [gate, variant, code]), [['allDecisionsLegal', 'luna-default', 'ILLEGAL_DECISION']]);
  assert.deepEqual(report.variants.map((variant) => variant.id), ['luna-default', 'sol-low']);

  const [luna, sol] = report.variants;
  assert.deepEqual(luna.requested, { model: LUNA, effort: 'model-default' });
  assert.deepEqual(sol.requested, { model: SOL, effort: 'low' });
  assert.equal(luna.adapterModel, LUNA);
  assert.equal(sol.adapterModel, SOL);
  for (const variant of report.variants) {
    assert.deepEqual([variant.probe.ok, variant.probe.containment], [true, true], variant.id);
    // probe도 실제 자식 argv로 검증한다: 한 번 관측됐고 요청한 모델/effort였다.
    assert.deepEqual([variant.probe.attempted, variant.probe.observedCalls, variant.probe.verified, variant.probe.unverified], [true, 1, true, null], variant.id);
    assert.deepEqual([variant.probe.argvModel, variant.probe.argvEffort, variant.probe.mismatch], [variant.requested.model, variant.requested.effort, null], variant.id);
    assert.equal(variant.summary.unobserved, 0);
    // 표본마다 warmup·decide 각 1회의 실제 자식 argv를 관측했다.
    for (const sample of variant.samples) {
      assert.deepEqual(sample.observedCalls, { warmup: 1, decide: 1 }, `${variant.id} ${sample.spotId}`);
      assert.deepEqual(sample.unobservedPhases, []);
    }
  }

  // 결과: 합법성·행동·금액·사유, 범위 밖 레이즈는 invalid로 합법이 아니다.
  assert.deepEqual(luna.samples.map((sample) => [sample.spotId, sample.status, sample.legal]), [
    [spots[0].id, 'ok', true], [spots[1].id, 'invalid', false], [spots[2].id, 'ok', true],
  ]);
  assert.equal(luna.samples[1].rejectionDetail, 'amount_out_of_range');
  assert.equal(luna.samples[1].action, null);
  assert.equal(luna.samples[0].action, legalOf(spots[0]).canCheck ? 'check' : 'fold');
  assert.equal(luna.samples[0].reason, '루나 사유');
  assert.deepEqual(sol.samples.map((sample) => [sample.status, sample.action, sample.reason]), spots.map((spot) => ['ok', safeAction(spot), '솔 사유']));
  assert.ok(sol.samples.every((sample) => Number.isInteger(sample.decideMs) && sample.decideMs >= 0 && Number.isInteger(sample.warmupMs)));
  assert.equal(luna.summary.legal, 2);
  assert.equal(luna.summary.invalid, 1);
  assert.deepEqual(luna.gates, { complete: true, allDecisionsLegal: false });
  assert.deepEqual(sol.gates, { complete: true, allDecisionsLegal: true });
  assert.equal(sol.summary.legal, 3);
  assert.deepEqual(sol.summary.decideMs.observations, sol.samples.map((sample) => sample.decideMs));
  assert.equal(sol.summary.decideMs.overSoft25s, 0);

  // 실제 argv: probe 1 + (warmup+decide)×3 = 7회씩, 카탈로그 호출 없음.
  const calls = f.calls();
  assert.equal(calls.length, 2 * 7);
  assert.equal(calls.some((call) => call.argv.includes('debug')), false, '카탈로그를 읽지 않는다');
  const lunaCalls = calls.filter((call) => modelOf(call.argv) === LUNA);
  const solCalls = calls.filter((call) => modelOf(call.argv) === SOL);
  assert.equal(lunaCalls.length, 7);
  assert.equal(solCalls.length, 7);
  for (const call of lunaCalls) assert.deepEqual(efforts(call.argv), [], 'luna는 모델 기본값(effort 인자 없음)');
  for (const call of solCalls) assert.deepEqual(efforts(call.argv), ['model_reasoning_effort="low"']);
  // 모델·effort 인자를 빼면 두 설정의 argv가 같다 — 같은 no-tool 컨테인먼트다.
  const strip = (argv) => argv.filter((arg, i) => !(arg === modelOf(argv) && argv[i - 1] === '-m')
    && !(arg.startsWith('model_reasoning_effort=')) && !(arg === '-c' && (argv[i + 1] ?? '').startsWith('model_reasoning_effort=')));
  const shapes = (list) => list.map((call) => strip(call.argv).join(' '));
  assert.deepEqual(shapes(lunaCalls), shapes(solCalls));
  for (const call of calls) {
    assert.ok(call.argv.includes('shell_tool') && call.argv.includes('mcp_servers={}'), '컨테인먼트 argv');
    assert.equal(call.argv[call.argv.indexOf('--sandbox') + 1], 'read-only');
  }
  assert.ok(luna.samples.every((sample) => sample.argvModel === LUNA && sample.argvEffort === 'model-default' && sample.mismatch === null));
  assert.ok(sol.samples.every((sample) => sample.argvModel === SOL && sample.argvEffort === 'low' && sample.mismatch === null));

  // 같은 스팟의 decide 입력은 두 설정이 바이트 단위로 같다. 스팟 순서는 번갈아 돈다.
  const decides = decideCalls(calls);
  assert.equal(decides.length, 6);
  for (const spot of spots) {
    const stdins = decides.filter((call) => call.stdin.includes(`decisionId: ${spot.decisionId}`));
    assert.equal(stdins.length, 2, spot.id);
    assert.equal(stdins[0].stdin, spot.message);
    assert.equal(stdins[0].stdin, stdins[1].stdin);
  }
  assert.deepEqual(decides.map((call) => modelOf(call.argv)), [LUNA, SOL, SOL, LUNA, LUNA, SOL]);

  // 임시 cwd/카나리는 레포 밖이었고 끝나면 사라진다.
  for (const call of calls) {
    const rel = path.relative(REPO_ROOT, fs.realpathSync(call.cwd.startsWith(os.tmpdir()) ? call.cwd : os.tmpdir()));
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `cwd가 레포 안이다: ${call.cwd}`);
    assert.equal(fs.existsSync(call.cwd), false, '임시 cwd가 남았다');
  }
  assert.deepEqual(report.cleanup, { disposed: true, removed: true, tmp: null, errors: [] });
  assert.deepEqual(fs.readdirSync(f.tmpRoot), [], '임시 디렉터리가 남았다');

  // 해석 보고: 우열 추론이 없고 주의가 붙는다. 원문 프롬프트·센티널은 없다.
  assert.deepEqual(report.caveats, [...COMPARISON_CAVEATS]);
  assert.match(report.caveats.join('\n'), /승률·EV·GTO 정답·전략 우열을 추론하지 않는다/);
  const text = JSON.stringify(report);
  assert.equal(text.includes('SENTINEL'), false);
  assert.equal(text.includes('페르소나 카드'), false, '프롬프트 원문이 보고서에 없다');
  assert.equal(text.includes('홀카드:'), false, '스냅샷 원문이 보고서에 없다');
  assert.equal(report.agreement.comparedSpots, 2);
  assert.match(formatReport(report), /주의: 표본이 작아/);
});

test('실행: 모델/effort 불일치(핀이 무시된 어댑터)는 설정·스팟별로 보고하고 종료 코드를 실패로 만든다', async (t) => {
  const spots = buildComparisonSpots(2);
  const f = fixture(t, { script: { matchers: decisionMatchers(spots) } });
  // 어댑터가 요청한 핀을 무시하고 항상 Sol/low로 도는 상황을 흉내 낸다.
  const ignoresPin = (kind, opts) => createPlayerRuntime(kind, { ...opts, benchmarkPin: undefined });
  const report = await runComparison({ samples: 2, timeoutMs: 20_000 }, { ...f.deps, createRuntime: ignoresPin });
  const [luna, sol] = report.variants;
  // 응답은 전부 합법이고 빠짐없이 받았지만 요청과 다른 모델로 나갔다 — 실행 건전성이 실패하고,
  // probe 자식도 다른 모델로 돌았으므로 probe 검증(complete)도 통과가 아니다. 핀이 없는 어댑터는 probe 단계에
  // 카탈로그 자식(`debug models`, `-m` 없음)도 띄우므로 Sol/low 요청조차 probe argv 대조를 통과하지 못한다 —
  // 요청하지 않은 자식이 probe 단계에 돌았다는 사실 그대로를 불일치로 남긴다.
  assertGates(report, { executionOk: false, complete: false, allDecisionsLegal: true });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map(({ gate, variant, code }) => [gate, variant, code]), [
    ['executionOk', 'luna-default', 'MODEL_MISMATCH'], ['executionOk', 'sol-low', 'MODEL_MISMATCH'],
    ['complete', 'luna-default', 'PROBE_NOT_PASSED'], ['complete', 'sol-low', 'PROBE_NOT_PASSED'],
  ]);
  assert.deepEqual([luna.probe.ok, luna.probe.containment, luna.probe.verified, luna.probe.unverified], [true, true, false, 'MODEL_MISMATCH']);
  assert.deepEqual([luna.probe.argvModel, luna.probe.mismatch.argvModels, luna.probe.mismatch.requestedModel], [SOL, [null, SOL], LUNA]);
  assert.equal(luna.probe.observedCalls, 2, '카탈로그 자식 + probe 자식');
  assert.ok(f.calls().some((call) => call.argv.includes('debug')), '핀이 없으면 카탈로그 자식이 실제로 돈다');
  assert.ok(luna.samples.every((sample) => sample.mismatch !== null), 'luna 요청이 다른 모델로 나갔다');
  assert.deepEqual(luna.samples[0].mismatch.requestedModel, LUNA);
  assert.deepEqual(luna.samples[0].mismatch.adapterModel, SOL);
  assert.deepEqual(luna.samples[0].mismatch.argvModels, [SOL]);
  assert.ok(luna.samples[0].mismatch.argvEfforts.includes('low') || luna.samples[0].mismatch.argvEfforts.includes('medium') || luna.samples[0].mismatch.argvEfforts.includes('model-default'));
  assert.equal(luna.summary.modelMismatches, 2);
  // luna: probe 1 + 표본 2 = 불일치 3건이며 단계가 표시된다.
  const lunaMismatches = report.mismatches.filter((entry) => entry.variant === 'luna-default');
  assert.deepEqual(lunaMismatches.map((entry) => entry.phase), ['probe', 'sample', 'sample']);
  assert.equal(report.failures.find((failure) => failure.code === 'MODEL_MISMATCH' && failure.variant === 'luna-default').detail, 3);
  // 운영 기본 어댑터의 플레이어 effort도 low이므로 Sol/low 요청의 표본 호출은 실제로 일치한다 — probe 단계의 카탈로그 자식만 걸린다.
  assert.ok(sol.samples.every((sample) => sample.mismatch === null));
  assert.deepEqual([sol.probe.verified, sol.probe.unverified, sol.probe.mismatch.argvModels, sol.probe.mismatch.argvEfforts], [false, 'MODEL_MISMATCH', [null, SOL], ['model-default', 'low']]);
  assert.deepEqual(report.mismatches.filter((entry) => entry.variant === 'sol-low').map((entry) => entry.phase), ['probe']);
  assert.match(formatReport(report), /모델\/effort 불일치 4건/);

  const out = [];
  const code = await main(['--live', '--samples', '2', '--timeout-ms', '20000', '--json'], {
    stdout: { write: (text) => out.push(text) }, stderr: { write: () => {} },
    deps: { ...f.deps, createRuntime: ignoresPin },
  });
  assert.equal(code, 3);
  assert.equal(JSON.parse(out.join('')).ok, false);
});

test('실행: 타임아웃은 자식 종료를 확인한 뒤에만 기록되고 나머지 표본은 계속 돈다 — 하지만 불완전한 비교는 합격이 아니다', async (t) => {
  const spots = buildComparisonSpots(2);
  const slowSol = {
    includes: `decisionId: ${spots[0].decisionId}`, argvIncludes: SOL, delayMs: 30_000, reply: decision(spots[0], { action: 'fold' }),
  };
  const f = fixture(t, { script: { matchers: [slowSol, ...decisionMatchers(spots)] } });
  const report = await runComparison({ samples: 2, timeoutMs: 400, budgetMs: 60_000 }, f.deps);
  const sol = report.variants[1];
  assert.deepEqual(sol.samples.map((sample) => sample.status), ['timeout', 'ok']);
  assert.equal(sol.samples[0].errorCode, 'TIMEOUT');
  assert.equal(sol.samples[0].errorPhase, 'decide');
  assert.equal(sol.samples[0].legal, false);
  assert.ok(sol.samples[0].decideMs >= 300, `타임아웃 지연이 기록된다: ${sol.samples[0].decideMs}`);
  assert.equal(sol.summary.timeout, 1);
  assert.equal(report.variants[0].summary.legal, 2, '다른 설정은 영향받지 않는다');
  // 타임아웃은 쓸 만한 관측이고 하네스 사고도 아니다(executionOk) — 하지만 요청한 측정을 다 얻지 못했다(complete).
  assertGates(report, { executionOk: true, complete: false, allDecisionsLegal: true });
  assert.equal(report.ok, false, '타임아웃이 있는 비교는 합격이 아니다');
  assert.deepEqual(report.failures.map(({ gate, variant, code }) => [gate, variant, code]), [['complete', 'sol-low', 'TIMEOUT']]);
  assert.deepEqual(report.variants[1].gates, { complete: false, allDecisionsLegal: true });
  assert.equal(report.aborted, null);
  // 느린 자식은 정리 시점에 이미 죽어 있다.
  const slowPid = f.calls().find((call) => call.argv.includes('resume') && modelOf(call.argv) === SOL).pid;
  assert.throws(() => process.kill(slowPid, 0), { code: 'ESRCH' }, '타임아웃된 자식이 살아 있다');
  assert.equal(report.cleanup.removed, true);
  assert.deepEqual(fs.readdirSync(f.tmpRoot), []);
});

test('실행: 자식 종료를 확인하지 못하면 즉시 중단하고 임시 디렉터리를 남기며 모든 어댑터를 dispose한다', async (t) => {
  const spots = buildComparisonSpots(3);
  const f = fixture(t, { script: { matchers: decisionMatchers(spots) } });
  const disposed = [];
  let resumes = 0;
  const hangingExec = (spec) => {
    // 첫 결정(resume) 자식만 응답도 close도 없고 kill도 전달되지 않는다. 나머지는 가짜 CLI다.
    if (spec.args.includes('resume') && (resumes += 1) === 1) return { pid: 999_999, kill: () => false, done: new Promise(() => {}) };
    return f.deps.exec(spec);
  };
  const createRuntime = (kind, opts) => {
    const adapter = createPlayerRuntime(kind, opts);
    const original = adapter.dispose.bind(adapter);
    adapter.dispose = (...args) => { disposed.push(opts.benchmarkPin.model); return original(...args); };
    return adapter;
  };
  const report = await runComparison({ samples: 3, timeoutMs: 400, budgetMs: 60_000 }, { ...f.deps, exec: hangingExec, createRuntime });
  assert.equal(report.ok, false);
  assert.equal(report.executionOk, false, '자식 종료 미확인은 실행 건전성 실패다');
  assert.equal(report.complete, false);
  assert.equal(report.aborted.code, 'TERMINATION_UNCONFIRMED');
  assert.equal(report.aborted.variant, 'luna-default', '스팟 0은 luna가 먼저 돈다');
  assert.equal(report.aborted.phase, 'sample');
  const [luna, sol] = report.variants;
  assert.equal(luna.samples[0].status, 'termination_unconfirmed');
  assert.match(luna.samples[0].errorCode, /^CHILD_/);
  assert.equal(luna.summary.terminationUnconfirmed, 1);
  for (const sample of [...luna.samples.slice(1), ...sol.samples]) {
    assert.equal(sample.status, 'skipped', '중단 뒤에는 새 자식을 띄우지 않는다');
    assert.equal(sample.errorCode, 'ABORTED');
  }
  assert.equal(f.calls().filter((call) => call.argv.includes('resume')).length, 0, '중단 뒤 가짜 CLI도 더 불리지 않는다');
  assert.deepEqual([...new Set(disposed)].sort(), [LUNA, SOL].sort(), '두 어댑터 모두 dispose를 시도한다');
  assert.ok(disposed.length >= 3, '확인하지 못한 어댑터는 한 번 더 확인한다');
  assert.equal(report.cleanup.disposed, false);
  assert.equal(report.cleanup.removed, false);
  assert.ok(report.cleanup.errors.length >= 1);
  assert.equal(fs.existsSync(report.cleanup.tmp), true, '종료를 확인하지 못한 cwd는 지우지 않는다');
  assert.match(formatReport(report), /임시 디렉터리 보존/);
  fs.rmSync(report.cleanup.tmp, { recursive: true, force: true });
});

test('실행: dispose가 동기적으로 던져도 나머지 어댑터를 전부 dispose하고, 보고서는 임시 디렉터리 보존과 함께 fail-closed로 나온다', async (t) => {
  const spots = buildComparisonSpots(1);
  const f = fixture(t, { script: { matchers: decisionMatchers(spots) } });
  const disposed = [];
  const createRuntime = (kind, opts) => {
    const adapter = createPlayerRuntime(kind, opts);
    const original = adapter.dispose.bind(adapter);
    const model = opts.benchmarkPin.model;
    // 첫 어댑터(luna)의 dispose는 promise를 돌려주지 않고 동기적으로 던진다. 둘째(sol)는 정상이다.
    adapter.dispose = model === LUNA
      ? () => { disposed.push(model); throw Object.assign(new Error('sync boom'), { code: 'DISPOSE_SYNC_THROW' }); }
      : (...args) => { disposed.push(model); return original(...args); };
    return adapter;
  };
  // 이전에는 동기 throw가 runs.map을 뚫고 나가 보고서 없이 거부됐고 둘째 어댑터는 dispose되지 않았다.
  const report = await runComparison({ samples: 1, timeoutMs: 20_000 }, { ...f.deps, createRuntime });
  assert.ok(disposed.includes(SOL), '둘째 어댑터도 dispose를 시도한다');
  assert.ok(disposed.filter((model) => model === LUNA).length >= 2, '던진 어댑터는 한 번 더 시도한다');
  assert.equal(report.cleanup.disposed, false);
  assert.deepEqual(report.cleanup.errors, [{ variant: 'luna-default', code: 'DISPOSE_SYNC_THROW' }]);
  assert.equal(report.cleanup.removed, false);
  assert.equal(report.cleanup.tmp !== null && fs.existsSync(report.cleanup.tmp), true, 'dispose를 확인하지 못한 임시 디렉터리는 보존한다');
  // 표본 자체는 멀쩡했으므로 실행 건전성만 실패한다.
  assertGates(report, { executionOk: false, complete: true, allDecisionsLegal: true });
  assert.deepEqual(report.failures.map(({ gate, variant, code }) => [gate, variant, code]), [
    ['executionOk', null, 'DISPOSE_UNCONFIRMED'], ['executionOk', null, 'TMP_NOT_REMOVED'],
  ]);
  assert.match(formatReport(report), /dispose 실패.*DISPOSE_SYNC_THROW/);
  assert.match(formatReport(report), /임시 디렉터리 보존/);
  fs.rmSync(report.cleanup.tmp, { recursive: true, force: true });

  // CLI도 거부(종료 1)가 아니라 보고서와 종료 코드 3을 낸다.
  const cli = await runCli(['--live', '--samples', '1', '--timeout-ms', '20000', '--json'], { ...f.deps, createRuntime });
  assert.equal(cli.code, 3);
  assert.match(cli.err, /DISPOSE_UNCONFIRMED/);
  const printed = JSON.parse(cli.out);
  assert.equal(printed.cleanup.disposed, false);
  fs.rmSync(printed.cleanup.tmp, { recursive: true, force: true });
});

// ── 실제 자식 관측 요구: 어댑터의 주장(ok·models.player)이 실제 실행을 대신하지 못한다 ───────────────────

test('실행(각본 어댑터 대조군): 단계마다 정직하게 자식 argv를 낸 각본은 세 게이트 모두 true다', async (t) => {
  const spots = buildComparisonSpots(2);
  const f = fixture(t);
  const scripted = scriptedRuntime(spots);
  const report = await runComparison({ samples: 2, timeoutMs: 20_000 }, { tmpRoot: f.tmpRoot, ...scripted.deps });
  assertGates(report, { executionOk: true, complete: true, allDecisionsLegal: true });
  assert.equal(report.ok, true);
  assert.equal(scripted.log.spawned, 2 * (1 + 2 * 2), 'probe 1 + (warmup+decide)×2 = 변형당 5회의 argv');
  for (const variant of report.variants) {
    assert.deepEqual([variant.probe.verified, variant.probe.observedCalls], [true, 1]);
    for (const sample of variant.samples) assert.deepEqual([sample.status, sample.observedCalls], ['ok', { warmup: 1, decide: 1 }]);
  }
  assert.deepEqual(report.cleanup, { disposed: true, removed: true, tmp: null, errors: [] });
});

test('실행: probe 자식이 요청과 다른 모델/effort로 돌았으면 probe 통과 주장을 믿지 않고 executionOk·complete·ok가 전부 실패한다', async (t) => {
  const spots = buildComparisonSpots(2);
  const f = fixture(t);
  // luna 변형의 probe는 Sol로, sol 변형의 probe는 effort medium으로 돈다. 표본 호출은 전부 요청대로다.
  const scripted = scriptedRuntime(spots, (model) => (model === LUNA
    ? { probeOverride: { model: SOL } }
    : { probeOverride: { effort: 'medium' } }));
  const report = await runComparison({ samples: 2, timeoutMs: 20_000 }, { tmpRoot: f.tmpRoot, ...scripted.deps });
  const [luna, sol] = report.variants;
  assertGates(report, { executionOk: false, complete: false, allDecisionsLegal: true });
  assert.equal(report.ok, false);
  for (const variant of report.variants) {
    assert.deepEqual([variant.probe.ok, variant.probe.containment], [true, true], '어댑터는 통과를 주장했다');
    assert.deepEqual([variant.probe.verified, variant.probe.unverified, variant.probe.observedCalls], [false, 'MODEL_MISMATCH', 1], variant.id);
    assert.equal(variant.summary.probeOk, false);
    assert.deepEqual(variant.gates.complete, false);
    assert.ok(variant.samples.every((sample) => sample.status === 'ok' && sample.mismatch === null), '표본 호출 자체는 요청대로였다');
  }
  assert.deepEqual([luna.probe.argvModel, luna.probe.argvEffort], [SOL, 'model-default']);
  assert.deepEqual(luna.probe.mismatch, {
    requestedModel: LUNA, requestedEffort: 'model-default', adapterModel: LUNA, argvModels: [SOL], argvEfforts: ['model-default'], callsChecked: 1,
    modelOccurrences: [SOL], effortOccurrences: [],
  });
  assert.deepEqual([sol.probe.argvModel, sol.probe.argvEffort], [SOL, 'medium']);
  assert.deepEqual(sol.probe.mismatch.argvEfforts, ['medium']);
  assert.deepEqual(report.mismatches.map(({ variant, phase, spot }) => [variant, phase, spot]), [['luna-default', 'probe', null], ['sol-low', 'probe', null]]);
  assert.deepEqual(report.failures.map(({ gate, variant, code }) => [gate, variant, code]), [
    ['executionOk', 'luna-default', 'MODEL_MISMATCH'], ['executionOk', 'sol-low', 'MODEL_MISMATCH'],
    ['complete', 'luna-default', 'PROBE_NOT_PASSED'], ['complete', 'sol-low', 'PROBE_NOT_PASSED'],
  ]);
  assert.match(formatReport(report), /probe 미통과\(MODEL_MISMATCH\)/);
  assert.match(formatReport(report), /모델\/effort 불일치 2건/);
});

test('실행: probe가 자식을 하나도 띄우지 않고 통과를 주장하면 NO_CHILD_OBSERVED로 실패하고 그 변형의 표본은 돌지 않는다', async (t) => {
  const spots = buildComparisonSpots(2);
  const f = fixture(t);
  const scripted = scriptedRuntime(spots, (model) => (model === LUNA ? { silent: ['probe'] } : {}));
  const report = await runComparison({ samples: 2, timeoutMs: 20_000 }, { tmpRoot: f.tmpRoot, ...scripted.deps });
  const [luna, sol] = report.variants;
  assertGates(report, { executionOk: false, complete: false, allDecisionsLegal: false });
  assert.equal(report.ok, false);
  assert.deepEqual([luna.probe.ok, luna.probe.containment, luna.probe.attempted, luna.probe.observedCalls], [true, true, true, 0]);
  assert.deepEqual([luna.probe.verified, luna.probe.unverified, luna.probe.mismatch], [false, 'NO_CHILD_OBSERVED', null]);
  assert.equal(luna.adapterModel, LUNA, '어댑터 해석 모델은 요청과 같지만 실제 실행을 대신하지 못한다');
  // 컨테인먼트를 실제 자식으로 보여 주지 못한 변형에는 자식을 띄우지 않는다.
  assert.ok(luna.samples.every((sample) => sample.status === 'skipped' && sample.errorCode === 'PROBE_UNOBSERVED'));
  assert.deepEqual(scripted.log.warmups, [SOL, SOL], 'luna warmup은 호출되지 않는다');
  assert.ok(sol.samples.every((sample) => sample.status === 'ok'));
  assert.deepEqual(sol.gates, { complete: true, allDecisionsLegal: true });
  assert.deepEqual(report.failures.map(({ gate, variant, code, detail }) => [gate, variant, code, detail]), [
    ['executionOk', 'luna-default', 'NO_CHILD_OBSERVED', 'probe'],
    ['complete', 'luna-default', 'PROBE_NOT_PASSED', 'NO_CHILD_OBSERVED'],
    ['complete', 'luna-default', 'SKIPPED', 2],
    ['allDecisionsLegal', 'luna-default', 'NO_DECISIONS_OBSERVED', undefined],
  ]);
  assert.match(formatReport(report), /probe 미통과\(NO_CHILD_OBSERVED\)/);
});

test('실행: warmup 또는 decide가 자식 없이 응답을 돌려주면 그 표본은 unobserved이며 합법 응답으로 세지 않는다', async (t) => {
  const spots = buildComparisonSpots(2);
  const f = fixture(t);
  // luna는 warmup이, sol은 decide가 자식을 띄우지 않는다. 둘 다 어댑터 해석 모델은 요청과 같다.
  const scripted = scriptedRuntime(spots, (model) => (model === LUNA ? { silent: ['warmup'] } : { silent: ['decide'] }));
  const report = await runComparison({ samples: 2, timeoutMs: 20_000 }, { tmpRoot: f.tmpRoot, ...scripted.deps });
  const [luna, sol] = report.variants;
  assertGates(report, { executionOk: false, complete: false, allDecisionsLegal: false });
  assert.equal(report.ok, false);
  for (const variant of report.variants) {
    assert.equal(variant.probe.verified, true, 'probe는 정직했다');
    assert.equal(variant.adapterModel, variant.requested.model, '어댑터 해석 모델은 요청과 같다 — 그래도 실제 실행을 대신하지 못한다');
    assert.equal(variant.summary.unobserved, 2);
    assert.equal(variant.summary.legal, 0, '자식 없는 응답은 합법 응답이 아니다');
    assert.equal(variant.summary.attempted, 2);
    assert.deepEqual(variant.gates, { complete: false, allDecisionsLegal: false });
    for (const sample of variant.samples) {
      assert.deepEqual([sample.status, sample.legal, sample.action, sample.errorCode], ['unobserved', false, null, 'NO_CHILD_OBSERVED']);
    }
  }
  assert.ok(luna.samples.every((sample) => sample.errorPhase === 'warmup'));
  assert.deepEqual(luna.samples[0].observedCalls, { warmup: 0, decide: 1 });
  assert.deepEqual(luna.samples[0].unobservedPhases, ['warmup']);
  assert.ok(sol.samples.every((sample) => sample.errorPhase === 'decide'));
  assert.deepEqual(sol.samples[0].observedCalls, { warmup: 1, decide: 0 });
  assert.deepEqual(sol.samples[0].unobservedPhases, ['decide']);
  assert.equal(report.agreement.comparedSpots, 0);
  for (const variantId of ['luna-default', 'sol-low']) {
    const codes = report.failures.filter((failure) => failure.variant === variantId).map(({ gate, code }) => `${gate}:${code}`);
    assert.deepEqual(codes, ['executionOk:NO_CHILD_OBSERVED', 'complete:NO_CHILD_OBSERVED', 'allDecisionsLegal:NO_DECISIONS_OBSERVED'], variantId);
  }
  const text = formatReport(report);
  assert.match(text, /미관측 2/);
  assert.match(text, /unobserved\(NO_CHILD_OBSERVED\)/);
  assert.match(text, /판정: 불합격/);

  // CLI도 종료 코드 3이다.
  const cli = await runCli(['--live', '--samples', '2', '--timeout-ms', '20000', '--json'], { tmpRoot: f.tmpRoot, ...scriptedRuntime(spots, () => ({ silent: ['decide'] })).deps });
  assert.equal(cli.code, 3);
  assert.match(cli.err, /NO_CHILD_OBSERVED/);
});

test('실행: 어댑터 생성이 도중에 실패해도 만들어진 어댑터를 dispose하고 임시 디렉터리를 지운다', async (t) => {
  const f = fixture(t);
  const disposed = [];
  let made = 0;
  const createRuntime = (kind, opts) => {
    made += 1;
    if (made === 2) throw Object.assign(new Error('boom'), { code: 'BOOM' });
    const adapter = createPlayerRuntime(kind, opts);
    const original = adapter.dispose.bind(adapter);
    adapter.dispose = () => { disposed.push('first'); return original(); };
    return adapter;
  };
  await assert.rejects(runComparison({ samples: 1 }, { ...f.deps, createRuntime }), { code: 'BOOM' });
  assert.deepEqual(disposed, ['first']);
  assert.deepEqual(fs.readdirSync(f.tmpRoot), []);
  assert.equal(f.calls().length, 0);
});

test('실행: 예산이 호출 상한보다 작으면 아무 자식도 띄우지 않고 전부 건너뜀으로 보고하며 합격이 아니다', async (t) => {
  const f = fixture(t);
  let tick = 0;
  const report = await runComparison({ samples: 2, timeoutMs: 300, budgetMs: 300 }, { ...f.deps, now: () => (tick += 1) });
  assert.equal(f.calls().length, 0);
  for (const variant of report.variants) {
    assert.equal(variant.summary.skipped, 2);
    assert.ok(variant.samples.every((sample) => sample.status === 'skipped' && sample.errorCode === 'PROBE_FAILED'));
    assert.equal(variant.probe.ok, false);
    assert.deepEqual(variant.gates, { complete: false, allDecisionsLegal: false });
  }
  // 하네스는 사고 없이 끝났지만(executionOk) 측정을 하나도 얻지 못했다 — 합격일 수 없다.
  assertGates(report, { executionOk: true, complete: false, allDecisionsLegal: false });
  assert.equal(report.ok, false);
  assert.equal(report.agreement.comparedSpots, 0);
  assert.ok(report.failures.some((failure) => failure.gate === 'complete' && failure.code === 'PROBE_NOT_PASSED'));
  assert.ok(report.failures.some((failure) => failure.gate === 'complete' && failure.code === 'SKIPPED'));
  assert.equal(report.cleanup.removed, true);
});

test('실행: 실제 러너(가짜 런타임 없이 시계만 주입)가 예산 소진으로 한 표본도 못 얻으면 ok=false이고 자식을 띄우지 않는다', async (t) => {
  // 회귀: 이전에는 이 입력이 comparedSpots=0·probe 실패·전부 건너뜀인데도 ok:true였다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-compare-prod-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawned = [];
  let tick = 0;
  const report = await runComparison({ samples: 1, timeoutMs: 250, budgetMs: 250 }, {
    now: () => (tick += 1000),
    tmpRoot: dir,
    // createRuntime은 기본(실제 createPlayerRuntime)이다. 실수로 자식이 떠도 실제 codex가 아니라 여기서 걸린다.
    exec: (spec) => { spawned.push(spec.args); throw new Error('예산이 소진된 비교가 자식을 띄웠다'); },
  });
  assert.deepEqual(spawned, []);
  assert.equal(report.ok, false, '측정을 하나도 얻지 못한 비교는 합격이 아니다');
  assert.equal(report.complete, false);
  assert.equal(report.allDecisionsLegal, false);
  assert.equal(report.executionOk, true);
  assert.equal(report.agreement.comparedSpots, 0);
  for (const variant of report.variants) {
    assert.equal(variant.probe.ok, false);
    assert.equal(variant.summary.probeOk, false);
    assert.equal(variant.summary.skipped, 1);
    assert.equal(variant.summary.legal, 0);
  }
  assert.deepEqual(report.cleanup, { disposed: true, removed: true, tmp: null, errors: [] });
  assert.deepEqual(fs.readdirSync(dir), [], '임시 디렉터리가 남았다');

  // 같은 입력을 CLI로 돌리면 종료 코드는 0이 아니고 JSON에는 불합격 사유가 있다.
  tick = 0;
  const cli = await runCli(['--live', '--samples', '1', '--timeout-ms', '250', '--budget-ms', '250', '--json'], {
    now: () => (tick += 1000), tmpRoot: dir, exec: () => { throw new Error('자식을 띄우면 안 된다'); },
  });
  assert.equal(cli.code, 3);
  const printed = JSON.parse(cli.out);
  assert.deepEqual([printed.ok, printed.executionOk, printed.complete, printed.allDecisionsLegal], [false, true, false, false]);
  assert.match(cli.err, /ok=false|불합격/);
});

test('실행: probe(카나리 부정 검증)를 통과하지 못한 설정은 표본을 돌지 않는다', async (t) => {
  if (skipOnWin32(t, 'echoCanary matches a POSIX /path in stdin')) return;
  const spots = buildComparisonSpots(2);
  const leakyLuna = { includes: '다음 파일을 읽어', argvIncludes: LUNA, echoCanary: true, reply: reply('읽었습니다') };
  const f = fixture(t, { script: { matchers: [leakyLuna, ...decisionMatchers(spots)] } });
  const report = await runComparison({ samples: 2, timeoutMs: 20_000 }, f.deps);
  const [luna, sol] = report.variants;
  assert.equal(luna.probe.containment, false);
  // 에코된 센티널이 JSONL 스트림을 깨므로 fail-closed 문구가 나온다 — 어느 쪽이든 통과가 아니다.
  assert.match(luna.probe.notice, /probe 실패|컨테인먼트 실패/);
  assert.ok(luna.samples.every((sample) => sample.status === 'skipped' && sample.errorCode === 'PROBE_FAILED'));
  assert.equal(f.calls().filter((call) => modelOf(call.argv) === LUNA).length, 1, 'luna는 probe 한 번뿐이다');
  assert.ok(sol.samples.every((sample) => sample.status === 'ok'));
  assert.equal(report.agreement.comparedSpots, 0);
  // sol은 끝까지 갔지만 luna probe가 막혀 비교가 성립하지 않는다. 컨테인먼트 거부는 하네스 사고가 아니라 불가(complete)다.
  assertGates(report, { executionOk: true, complete: false, allDecisionsLegal: false });
  assert.equal(report.ok, false);
  assert.deepEqual(luna.gates, { complete: false, allDecisionsLegal: false });
  assert.deepEqual(sol.gates, { complete: true, allDecisionsLegal: true });
  assert.ok(report.failures.some((failure) => failure.variant === 'luna-default' && failure.code === 'PROBE_NOT_PASSED'));
  assert.equal(JSON.stringify(report).includes('SENTINEL'), false);
});

test('실행: 모델 호출 실패(비정상 종료·세션 없음)는 실패로 기록하고 도구는 계속 돈다', async (t) => {
  const spots = buildComparisonSpots(2);
  const failingSol = { includes: `decisionId: ${spots[0].decisionId}`, argvIncludes: SOL, reply: '', exitCode: 1 };
  const f = fixture(t, { script: { matchers: [failingSol, ...decisionMatchers(spots)] } });
  const report = await runComparison({ samples: 2, timeoutMs: 20_000 }, f.deps);
  const sol = report.variants[1];
  assert.deepEqual(sol.samples.map((sample) => sample.status), ['failed', 'ok']);
  assert.equal(sol.samples[0].errorCode, 'CLI_FAILED');
  assert.equal(sol.samples[0].mismatch, null, '실패한 호출도 argv 대조는 한다');
  assertGates(report, { executionOk: true, complete: false, allDecisionsLegal: true });
  assert.equal(report.ok, false, '호출 실패가 있는 비교는 합격이 아니다');
  assert.deepEqual(report.failures.map(({ gate, variant, code }) => [gate, variant, code]), [['complete', 'sol-low', 'CALL_FAILED']]);
  assert.match(formatReport(report), /판정: 불합격/);
});

test('CLI: --live 없이는 계획만 출력하고 어댑터·자식을 만들지 않으며, 알 수 없는 인자와 store 경로는 거부한다', async () => {
  const out = [];
  const err = [];
  const forbidden = () => { throw new Error('--live 없이 어댑터를 만들면 안 된다'); };
  const code = await main(['--samples', '3', '--json'], {
    stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) },
    deps: { createRuntime: forbidden, exec: forbidden },
  });
  assert.equal(code, 0);
  const printed = JSON.parse(out.join(''));
  assert.equal(printed.executed, false);
  assert.equal(printed.plan.samples, 3);
  assert.equal(printed.plan.maxModelCalls, 14);
  assert.deepEqual(err, []);

  for (const argv of [['--store-dir', '/tmp/x'], ['--game-dir', '/tmp/x'], ['--samples'], ['--samples', 'abc'], ['--samples', '99'], ['--timeout-ms', '10'], ['--live', '--model', 'gpt-6-luna'], ['live']]) {
    const errors = [];
    const result = await main(argv, { stdout: { write: () => {} }, stderr: { write: (text) => errors.push(text) }, deps: { createRuntime: forbidden, exec: forbidden } });
    assert.equal(result, 2, JSON.stringify(argv));
    assert.match(errors.join(''), /사용법/);
  }
  assert.deepEqual(parseCliArgs(['--live', '--samples', '2', '--timeout-ms', '5000', '--budget-ms', '60000']), {
    live: true, json: false, options: { samples: 2, timeoutMs: 5000, budgetMs: 60000 },
  });
});

test('CLI: --live는 같은 러너를 쓰고 사람이 읽는 요약을 출력하며, 완전하고 전부 합법일 때만 0을 돌려준다', async (t) => {
  const spots = buildComparisonSpots(1);
  const f = fixture(t, { script: { matchers: decisionMatchers(spots) } });
  const { code, out, err } = await runCli(['--live', '--samples', '1', '--timeout-ms', '20000'], f.deps);
  assert.equal(code, 0);
  assert.equal(err, '', '합격이면 stderr는 비어 있다');
  assert.match(out, /\[luna-default\] 요청 gpt-6-luna\/model-default/);
  assert.match(out, /\[sol-low\] 요청 gpt-6\.1-sol\/low/);
  assert.match(out, /판정: 완전·전부 합법\(ok\)/);
  assert.match(out, /승률·EV·GTO 정답·전략 우열을 추론하지 않는다/);
  assert.doesNotMatch(out, /준비 완료|운영 가능|통과했다/, '합격 문구가 준비 상태를 인증하지 않는다');
  assert.match(out, /운영 준비/, '합격이어도 준비 인증이 아니라는 주의가 붙는다');
});

test('실행: 모든 표본이 합법이고 빠짐없이 얻었을 때만 세 게이트가 모두 true이고 ok이다', async (t) => {
  const spots = buildComparisonSpots(3);
  const f = fixture(t, { script: { matchers: decisionMatchers(spots) } });
  const report = await runComparison({ samples: 3, timeoutMs: 20_000, budgetMs: 120_000 }, f.deps);
  assertGates(report, { executionOk: true, complete: true, allDecisionsLegal: true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.agreement.comparedSpots, 3);
  for (const variant of report.variants) {
    assert.deepEqual(variant.gates, { complete: true, allDecisionsLegal: true });
    assert.equal(variant.summary.legal, 3);
    assert.equal(variant.summary.skipped, 0);
  }
  assert.match(formatReport(report), /판정: 완전·전부 합법\(ok\)/);
});

// 불완전·무효·불가 비교는 종료 코드 3과 불합격 사유를 낸다. JSON 모드에서도 stdout은 순수 JSON이고 사유는 stderr에 간다.
const NON_OK_SCENARIOS = [
  {
    name: '범위 밖 레이즈(무효 응답)', args: ['--samples', '2', '--timeout-ms', '20000'],
    gates: { executionOk: true, complete: true, allDecisionsLegal: false }, code: 'ILLEGAL_DECISION',
    script: (spots) => ({ matchers: decisionMatchers(spots, { invalidSpot: spots[0].id }) }),
  },
  {
    name: '타임아웃(부분 비교)', args: ['--samples', '2', '--timeout-ms', '400'],
    gates: { executionOk: true, complete: false, allDecisionsLegal: true }, code: 'TIMEOUT',
    script: (spots) => ({
      matchers: [
        { includes: `decisionId: ${spots[0].decisionId}`, argvIncludes: SOL, delayMs: 30_000, reply: decision(spots[0], { action: 'fold' }) },
        ...decisionMatchers(spots),
      ],
    }),
  },
  {
    name: '모델 호출 실패(부분 비교)', args: ['--samples', '2', '--timeout-ms', '20000'],
    gates: { executionOk: true, complete: false, allDecisionsLegal: true }, code: 'CALL_FAILED',
    script: (spots) => ({
      matchers: [{ includes: `decisionId: ${spots[0].decisionId}`, argvIncludes: SOL, reply: '', exitCode: 1 }, ...decisionMatchers(spots)],
    }),
  },
];

for (const scenario of NON_OK_SCENARIOS) {
  test(`CLI: ${scenario.name}은 종료 코드 3이고 JSON ok=false, 사유는 stderr로 알린다`, async (t) => {
    const spots = buildComparisonSpots(2);
    const f = fixture(t, { script: scenario.script(spots) });
    const json = await runCli(['--live', ...scenario.args, '--json'], f.deps);
    assert.equal(json.code, 3);
    const report = JSON.parse(json.out);
    assertGates(report, scenario.gates, scenario.name);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((failure) => failure.code === scenario.code), JSON.stringify(report.failures));
    assert.match(json.err, /ok=false/);
    assert.match(json.err, new RegExp(scenario.code));

    const text = await runCli(['--live', ...scenario.args], f.deps);
    assert.equal(text.code, 3);
    assert.match(text.out, /판정: 불합격/);
    assert.match(text.out, new RegExp(scenario.code));
    assert.doesNotMatch(text.out, /판정: 완전·전부 합법/);
  });
}

test('CLI: probe 불가(컨테인먼트 거부)와 모델 불일치도 종료 코드 3이며 합격 문구를 내지 않는다', async (t) => {
  if (skipOnWin32(t, 'echoCanary matches a POSIX /path in stdin')) return;
  const spots = buildComparisonSpots(1);
  const leakyLuna = { includes: '다음 파일을 읽어', argvIncludes: LUNA, echoCanary: true, reply: reply('읽었습니다') };
  const f = fixture(t, { script: { matchers: [leakyLuna, ...decisionMatchers(spots)] } });
  const probe = await runCli(['--live', '--samples', '1', '--timeout-ms', '20000', '--json'], f.deps);
  assert.equal(probe.code, 3);
  assertGates(JSON.parse(probe.out), { executionOk: true, complete: false, allDecisionsLegal: false });
  assert.match(probe.err, /PROBE_NOT_PASSED/);

  const ignoresPin = (kind, opts) => createPlayerRuntime(kind, { ...opts, benchmarkPin: undefined });
  const g = fixture(t, { script: { matchers: decisionMatchers(spots) } });
  const mismatch = await runCli(['--live', '--samples', '1', '--timeout-ms', '20000'], { ...g.deps, createRuntime: ignoresPin });
  assert.equal(mismatch.code, 3);
  assert.match(mismatch.out, /판정: 불합격/);
  assert.match(mismatch.err, /MODEL_MISMATCH/);
});

// 라벨은 사람이 읽는 설명이지만, 실제 카드가 허용하지 않는 드로를 주장하면 비교 해석이 오염된다.
const RANKS = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
function cardFacts(spot) {
  const hole = /홀카드: (\S+) (\S+)/.exec(spot.message).slice(1);
  const boardText = /보드: ([^\n]+)/.exec(spot.message)[1];
  const board = boardText === '없음' ? [] : boardText.split(' ');
  const rankOf = (card) => RANKS[card[0]];
  const suitTally = {};
  for (const card of [...hole, ...board]) suitTally[card[1]] = (suitTally[card[1]] ?? 0) + 1;
  const heroBySuit = {};
  for (const card of hole) heroBySuit[card[1]] = (heroBySuit[card[1]] ?? 0) + 1;
  const flush = (total) => Object.entries(suitTally).some(([suit, n]) => n === total && heroBySuit[suit] === 2);
  // 5장 창(A는 1로도 센다)에서 영웅 카드를 포함해 몇 개의 서로 다른 랭크가 들어 있는지.
  const ranks = new Set([...hole, ...board].map(rankOf));
  const heroRanks = new Set(hole.map(rankOf));
  if (ranks.has(14)) ranks.add(1);
  if (heroRanks.has(14)) heroRanks.add(1);
  const windows = [];
  for (let low = 1; low <= 10; low += 1) {
    const span = [0, 1, 2, 3, 4].map((n) => low + n);
    windows.push({ n: span.filter((rank) => ranks.has(rank)).length, hero: span.some((rank) => heroRanks.has(rank)) });
  }
  const straightCards = (n) => windows.some((window) => window.n === n && window.hero);
  return {
    suited: hole[0][1] === hole[1][1],
    madeFlushDrawCards: flush(4), backdoorFlush: flush(3) && board.length === 3,
    straightDraw: straightCards(4), backdoorStraight: straightCards(3) && !straightCards(4),
  };
}

test('스팟 라벨: 실제 카드가 뒷받침하는 드로 주장만 하고, 근거 없는 드로는 말하지 않는다', () => {
  for (const spot of buildComparisonSpots(8)) {
    const facts = cardFacts(spot);
    const label = spot.label;
    const claimsFlushDraw = /(?<!백도어 )플러시 드로/.test(label);
    const claimsBackdoorFlush = /백도어[^)]*플러시/.test(label);
    const claimsStraightDraw = /(?<!백도어 )스트레이트 드로/.test(label);
    const claimsBackdoorStraight = /백도어[^)]*스트레이트/.test(label);
    if (/수딧/.test(label)) assert.ok(facts.suited, `${spot.id}: 수딧이 아닌데 수딧이라고 한다 — ${label}`);
    if (claimsFlushDraw) assert.ok(facts.madeFlushDrawCards, `${spot.id}: 4장 플러시 드로가 아닌데 플러시 드로라고 한다 — ${label}`);
    if (claimsBackdoorFlush) assert.ok(facts.backdoorFlush, `${spot.id}: 백도어 플러시 근거가 없다 — ${label}`);
    if (claimsStraightDraw) assert.ok(facts.straightDraw, `${spot.id}: 스트레이트 드로 근거가 없다 — ${label}`);
    if (claimsBackdoorStraight) assert.ok(facts.backdoorStraight, `${spot.id}: 백도어 스트레이트 근거가 없다 — ${label}`);
  }
  const byId = Object.fromEntries(buildComparisonSpots(8).map((spot) => [spot.id, spot]));
  // 알려진 두 오류의 직접 회귀: 9s8s/Ks7s2c는 플러시 드로 + 백도어 스트레이트, QdJd/7h6d2s는 백도어 플러시뿐이다.
  const flop = cardFacts(byId['flop-facing-bet-bb']);
  assert.deepEqual([flop.madeFlushDrawCards, flop.straightDraw, flop.backdoorStraight], [true, false, true]);
  assert.match(byId['flop-facing-bet-bb'].label, /플러시 드로/);
  assert.match(byId['flop-facing-bet-bb'].label, /백도어 스트레이트/);
  const checked = cardFacts(byId['flop-checked-to-bb']);
  assert.deepEqual([checked.madeFlushDrawCards, checked.backdoorFlush], [false, true]);
  assert.doesNotMatch(byId['flop-checked-to-bb'].label, /(?<!백도어 )플러시 드로/);
  assert.match(byId['flop-checked-to-bb'].label, /백도어/);
  const turn = cardFacts(byId['turn-facing-bet-btn']);
  assert.equal(turn.madeFlushDrawCards, true, '턴 AcXc는 실제로 너츠 클럽 드로다');
});
