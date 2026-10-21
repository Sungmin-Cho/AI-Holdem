import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { isRunning, skipOnWin32, waitExited } from './helpers/platform.js';
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
  const killAt = [];
  return {
    dir,
    tmpRoot,
    calls,
    deps: {
      tmpRoot,
      runtimeOpts: { env: { FAKE_CLI_SCRIPT: scriptPath, FAKE_CLI_LOG: logPath }, terminateKillWaitMs: 300 },
      exec: (spec) => {
        const child = spawnCli({ ...spec, command: process.execPath, args: [FAKE_CLI, ...spec.args] });
        return { ...child, kill: (signal) => { killAt.push(Date.now()); return child.kill(signal); } };
      },
      ...deps,
    },
    killAt,
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
        if (scenario.decideThrows) throw Object.assign(new Error('scripted'), { code: scenario.decideThrows });
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
  assert.deepEqual(validateComparisonOptions({}), {
    samples: 6, rounds: 1, timeoutMs: 60_000, warmupTimeoutMs: 60_000, decideTimeoutMs: 60_000, budgetMs: 900_000,
  });
  assert.equal(COMPARISON_LIMITS.maxTimeoutMs, 300_000, '운영 hard 예산을 넘지 않는다');
  const bad = [
    { samples: 0 }, { samples: 9 }, { samples: 1.5 }, { samples: '6' }, { timeoutMs: 100 }, { timeoutMs: 300_001 },
    { budgetMs: 3_600_001 }, { budgetMs: -1 }, { samples: NaN }, { extra: 1 }, [], null,
    { rounds: 0 }, { rounds: 9 }, { rounds: 1.5 }, { warmupTimeoutMs: 100 }, { decideTimeoutMs: 300_001 }, { warmupTimeoutMs: '1000' },
  ];
  for (const options of bad) {
    assert.throws(() => validateComparisonOptions(options), { code: 'BAD_COMPARISON_OPTIONS' }, JSON.stringify(options));
  }
  assert.deepEqual(validateComparisonOptions({ samples: 8, timeoutMs: 250, budgetMs: 250 }), {
    samples: 8, rounds: 1, timeoutMs: 250, warmupTimeoutMs: 250, decideTimeoutMs: 250, budgetMs: 250,
  });
  // phase별 상한은 timeoutMs를 기본값으로 따르되 따로 정할 수 있다(운영 상한 재현·짧은 상한 강제).
  assert.deepEqual(validateComparisonOptions({ rounds: 8, timeoutMs: 120_000, warmupTimeoutMs: 3_000, decideTimeoutMs: 300_000 }), {
    samples: 6, rounds: 8, timeoutMs: 120_000, warmupTimeoutMs: 3_000, decideTimeoutMs: 300_000, budgetMs: 900_000,
  });
});

test('계획은 호출 수 상한을 알려 주고 변형은 Luna/model-default와 Sol/low 둘뿐이다', () => {
  assert.deepEqual(COMPARISON_VARIANTS.map(({ id, model, effort }) => [id, model, effort]), [
    ['luna-default', LUNA, 'model-default'], ['sol-low', SOL, 'low'],
  ]);
  const plan = comparisonPlan({ samples: 4, timeoutMs: 1000, budgetMs: 600_000 });
  assert.equal(plan.maxModelCalls, 2 * (1 + 2 * 4));
  assert.equal(plan.worstCaseCallMs, plan.maxModelCalls * 1000);
  assert.equal(plan.spots.length, 4);
  // 라운드는 스팟 목록을 되풀이한다: 표본 = 스팟 × 라운드, 상한은 phase별 상한의 합으로 잡는다.
  const repeated = comparisonPlan({ samples: 8, rounds: 6, timeoutMs: 120_000, warmupTimeoutMs: 120_000, decideTimeoutMs: 300_000, budgetMs: 3_600_000 });
  assert.equal(repeated.samplesPerVariant, 48);
  assert.equal(repeated.maxModelCalls, 2 * (1 + 2 * 48));
  assert.equal(repeated.worstCaseCallMs, 3_600_000, '호출이 쓸 수 있는 시간은 예산으로 잘린다(종료 확인·정리는 별도)');
  const small = comparisonPlan({ samples: 2, rounds: 3, timeoutMs: 1000, warmupTimeoutMs: 2000, decideTimeoutMs: 3000, budgetMs: 3_600_000 });
  assert.equal(small.worstCaseCallMs, 2 * (1000 + 6 * (2000 + 3000)));
  assert.equal(small.spots.length, 2, '계획의 스팟 목록은 라운드로 늘지 않는다');
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
  const liveCwds = [];
  const tmpRootReal = fs.realpathSync.native(f.tmpRoot);
  const repoRootReal = fs.realpathSync.native(REPO_ROOT);
  const report = await runComparison({ samples: 3, timeoutMs: 20_000, budgetMs: 120_000 }, {
    ...f.deps,
    exec: (spec) => {
      const index = f.calls().length;
      const child = f.deps.exec(spec);
      return { ...child, done: child.done.then((result) => {
        // The child's own reported cwd is resolved while it still exists, before
        // completion reaches the adapter and cleanup can remove the directory.
        const call = f.calls()[index];
        assert.equal(call?.pid, child.pid);
        const realCwd = fs.realpathSync.native(call.cwd);
        liveCwds.push({ pid: child.pid, reportedCwd: call.cwd, realCwd,
          wasDirectory: fs.statSync(realCwd).isDirectory() });
        return result;
      }) };
    },
  });
  assert.equal(report.schema, 'codex-player-comparison/4');
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
  assert.equal(liveCwds.length, calls.length, 'every actual child cwd was observed before cleanup');
  for (const [index, call] of calls.entries()) {
    const captured = liveCwds[index];
    assert.equal(captured.pid, call.pid);
    assert.equal(captured.reportedCwd, call.cwd);
    assert.equal(captured.wasDirectory, true);
    const rel = path.relative(repoRootReal, captured.realCwd);
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `cwd가 레포 안이다: ${call.cwd}`);
    const tempRel = path.relative(tmpRootReal, captured.realCwd);
    assert.ok(tempRel && tempRel !== '..' && !tempRel.startsWith(`..${path.sep}`) && !path.isAbsolute(tempRel), 'cwd was inside the owned temporary root');
    assert.equal(fs.existsSync(call.cwd), false, '임시 cwd가 남았다');
    assert.equal(fs.existsSync(captured.realCwd), false, '정규화된 임시 cwd가 남았다');
  }
  const { attempts, ...cleanup } = report.cleanup;
  assert.deepEqual(cleanup, { disposed: true, removed: true, tmp: null, errors: [] });
  assert.deepEqual(attempts.map(({ openChildren, errors }) => [openChildren, errors]), [[0, []]], '모든 자식이 정리 전에 닫혔다');
  assert.deepEqual(fs.readdirSync(f.tmpRoot), [], '임시 디렉터리가 남았다');

  // #297 타임라인: 실제 자식마다 한 줄, 단계 이름이 맞고, 신호 없이 exit·close가 관측됐다. 이벤트는 이름뿐이다.
  for (const variant of report.variants) {
    assert.deepEqual(variant.probe.timelines.map((timeline) => timeline.phase), ['probe'], variant.id);
    for (const sample of variant.samples) {
      assert.deepEqual([sample.timelines.warmup.length, sample.timelines.decide.length], [1, 1], `${variant.id} ${sample.spotId}`);
      for (const [phase, [timeline]] of Object.entries(sample.timelines)) {
        assert.equal(timeline.phase, phase);
        assert.deepEqual(timeline.kills, [], '정상 응답에는 신호가 없다');
        assert.equal(timeline.closed, true);
        assert.ok(timeline.exitMs <= timeline.closeMs, 'exit가 close보다 늦을 수 없다');
        assert.deepEqual(timeline.events.map(({ name }) => name), ['thread.started', 'item.completed:agent_message']);
        assert.equal(timeline.derived.bootMs, timeline.events[0].ms);
        assert.equal(timeline.derived.signalToCloseMs, null);
      }
    }
    assert.deepEqual(variant.samples.map((sample) => sample.warmupIndex), [0, 1, 2], '변형마다 첫 create가 0번이다');
    assert.equal(variant.summary.warmupMs.cold, variant.samples[0].warmupMs);
  }
  const timelineText = JSON.stringify(report.variants.map((variant) => [variant.probe.timelines, variant.samples.map((sample) => sample.timelines)]));
  for (const raw of ['사유', 'decisionId', 'ready', 'th-compare-1', 'SENTINEL']) {
    assert.equal(timelineText.includes(raw), false, `타임라인에 원문 조각이 있다: ${raw}`);
  }

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

test('#297 실행: rounds는 스팟 목록을 되풀이하고 표본 순번으로 순서를 번갈아 돌며, 분모는 스팟 × 라운드다', async (t) => {
  const spots = buildComparisonSpots(2);
  const f = fixture(t);
  const scripted = scriptedRuntime(spots);
  const report = await runComparison({ samples: 2, rounds: 3, timeoutMs: 20_000 }, { tmpRoot: f.tmpRoot, ...scripted.deps });
  assertGates(report, { executionOk: true, complete: true, allDecisionsLegal: true });
  assert.equal(scripted.log.spawned, 2 * (1 + 2 * 6), 'probe 1 + (warmup+decide)×(2스팟×3라운드)');
  for (const variant of report.variants) {
    assert.deepEqual(variant.samples.map((sample) => [sample.round, sample.spotId, sample.sampleIndex, sample.warmupIndex]),
      [0, 0, 1, 1, 2, 2].map((round, i) => [round, spots[i % 2].id, i, i]));
    assert.equal(variant.summary.samples, 6);
    assert.equal(variant.summary.legal, 6);
    assert.equal(variant.summary.warmupMs.observations.length, 6);
  }
  // 표본 순번 짝수는 luna 먼저, 홀수는 sol 먼저다 — 라운드가 바뀌어도 순번 기준으로 이어진다.
  assert.deepEqual(scripted.log.decides, [LUNA, SOL, SOL, LUNA, LUNA, SOL, SOL, LUNA, LUNA, SOL, SOL, LUNA]);
  assert.deepEqual(report.agreement.detail.map(({ spot, round }) => [round, spot]), [0, 0, 1, 1, 2, 2].map((round, i) => [round, spots[i % 2].id]));

  // 예산 가드는 그 단계의 상한으로 판단한다: decide 상한이 남은 예산보다 크면 warmup만 돌고 decide는 건너뛴다.
  const g = fixture(t);
  const guarded = scriptedRuntime(spots);
  const short = await runComparison({ samples: 1, timeoutMs: 250, warmupTimeoutMs: 250, decideTimeoutMs: 300_000, budgetMs: 10_000 },
    { tmpRoot: g.tmpRoot, ...guarded.deps });
  for (const variant of short.variants) {
    const [sample] = variant.samples;
    assert.deepEqual([sample.status, sample.errorCode, sample.observedCalls], ['skipped', 'BUDGET_EXHAUSTED', { warmup: 1, decide: null }]);
    assert.equal(variant.summary.skipped, 1, '건너뛴 표본도 분모에 남는다');
  }
  assert.deepEqual(guarded.log.decides, []);
  assert.equal(short.complete, false);
});

test('#297 CLI: --live 중 SIGINT는 새 호출을 멈추고 진행 중 호출을 중단·종료 확인한 뒤 불완전 보고서를 내며 종료 코드 3이다', async (t) => {
  const spots = buildComparisonSpots(2);
  const slowSolDecide = { includes: `decisionId: ${spots[0].decisionId}`, argvIncludes: SOL, delayMs: 30_000, reply: decision(spots[0], { action: 'fold' }) };
  const f = fixture(t, { script: { matchers: [slowSolDecide, ...decisionMatchers(spots)] } });
  const signals = new EventEmitter();
  const pending = runCli(['--live', '--json', '--samples', '2', '--timeout-ms', '20000'], { ...f.deps, signalSource: signals });
  const deadline = Date.now() + 10_000;
  while (!f.calls().some((call) => call.argv.includes('resume') && modelOf(call.argv) === SOL)) {
    assert.ok(Date.now() < deadline, 'Sol decide가 시작되지 않았다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(signals.listenerCount('SIGINT'), 1);
  signals.emit('SIGINT');
  const { code, out, err } = await pending;
  assert.equal(code, 3);
  assert.match(err, /SIGINT 수신/);
  assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0, '신호 처리기는 실행 뒤 남지 않는다');
  const report = JSON.parse(out);
  // 진행 중이던 표본은 중단으로 끝나고, 멈춤은 그 표본이 끝난 경계에서 기록된다.
  assert.deepEqual(report.aborted, { code: 'STOPPED', variant: null, phase: 'sample', spot: spots[0].id, round: 0, signal: 'SIGINT' });
  const sol = report.variants[1];
  assert.deepEqual([sol.samples[0].status, sol.samples[0].errorCode, sol.samples[0].errorPhase], ['interrupted', 'INTERRUPTED', 'decide']);
  const [timeline] = sol.samples[0].timelines.decide;
  assert.equal(timeline.closed, true, '중단한 호출도 close를 확인했다');
  assert.deepEqual(timeline.kills.map(({ signal }) => signal), ['SIGKILL']);
  for (const variant of report.variants) assert.deepEqual(variant.samples.slice(1).map((sample) => sample.errorCode), ['ABORTED']);
  // 사람이 멈춘 실행은 하네스 사고가 아니라 불완전한 측정이다.
  assert.deepEqual([report.executionOk, report.complete, report.ok], [true, false, false]);
  assert.ok(report.failures.some(({ gate, code: failure }) => gate === 'complete' && failure === 'STOPPED'));
  assert.ok(report.failures.some(({ gate, variant, code: failure }) => gate === 'complete' && variant === 'sol-low' && failure === 'INTERRUPTED'));
  assert.equal(report.cleanup.removed, true);
  assert.deepEqual(fs.readdirSync(f.tmpRoot), []);
});

test('#297 타임라인: 이벤트 64개 상한·긴 줄·모르는 이름은 bounded로 세고, 오류 메시지·type·본문 원문은 진단 필드와 출력에 남지 않는다', async (t) => {
  const spots = buildComparisonSpots(1);
  const noisy = [
    { type: 'thread.started', thread_id: 'th-noisy' },
    { type: 'turn.started' },
    { type: 'error', message: 'SECRET-ERR-7f3 stream disconnected; reconnecting 1/5' },
    { type: 'turn.failed', error: { message: 'SECRET-FAIL-91 Too Many Requests' } },
    { type: 'SECRET-TYPE-a1' },
    { type: 'item.completed', item: { type: 'SECRET-ITEM-b2', text: 'SECRET-TEXT-c3' } },
    ...Array.from({ length: 70 }, (_, i) => ({ type: 'item.updated', item: { type: 'reasoning', text: `SECRET-REASON-${i}` } })),
    { type: 'item.completed', item: { type: 'agent_message', text: `SECRET-LONG-${'x'.repeat(70 * 1024)}` } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'ready' } },
  ];
  const lunaNoisyWarmup = { includes: '비교용', argvIncludes: LUNA, reply: jsonl(...noisy) };
  const f = fixture(t, { script: { matchers: [lunaNoisyWarmup, ...decisionMatchers(spots)] } });
  const { code, out, err } = await runCli(['--live', '--json', '--samples', '1', '--timeout-ms', '20000'], f.deps);
  const report = JSON.parse(out);
  const [timeline] = report.variants[0].samples[0].timelines.warmup;
  const names = timeline.events.map(({ name }) => name);
  assert.equal(names.length, 64, '이벤트 목록은 64개에서 멈춘다');
  assert.equal(timeline.eventsDropped, noisy.length - 1 - 64, '긴 줄을 뺀 나머지는 버린 수로 센다');
  assert.equal(timeline.oversizeLines, 1, '64KiB를 넘는 줄은 이름을 뽑지 않고 센다');
  assert.deepEqual(names.slice(0, 6), [
    'thread.started', 'turn.started', 'error[reconnect]', 'turn.failed[rate_limit]', 'other', 'item.completed:other',
  ]);
  assert.ok(names.slice(6).every((name) => name === 'item.updated:reasoning'));
  assert.equal(timeline.closed, true, '종료 관측은 이벤트 상한과 별도로 남는다');
  // turn.failed가 관측됐으므로 그 turn은 잘리지 않았다.
  assert.equal(timeline.derived.censored, false);
  assert.equal(Number.isInteger(timeline.derived.turnMs), true);
  // 시끄러운 스트림이어도 마지막 완료 항목이 ready면 세션은 정상이다 — 계측이 판정을 바꾸지 않는다.
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  const diagnostics = JSON.stringify(report.variants.map((variant) => [
    variant.probe.timelines, variant.samples.map((sample) => [sample.timelines, sample.errorDetails]),
  ])) + JSON.stringify(report.cleanup) + err;
  for (const raw of ['SECRET-ERR', 'SECRET-FAIL', 'SECRET-TYPE', 'SECRET-ITEM', 'SECRET-TEXT', 'SECRET-REASON', 'SECRET-LONG', 'th-noisy']) {
    assert.equal(diagnostics.includes(raw), false, `진단 필드·stderr에 원문 조각이 있다: ${raw}`);
  }
});

// 실제 어댑터 아래에 OS 프로세스 없는 각본 자식을 물린다. 청크 경계·신호 뒤 출력·종료 시각을 정확히 통제하려는 것이다.
// plan(spec)은 { chunks, hold, afterKill, exitAfterMs, closeAfterMs }를 돌려준다: chunks를 그대로 observe에 넣고, hold면
// 신호가 올 때까지 끝나지 않으며, 신호를 받으면 5ms 뒤 afterKill 청크를 더 낸 다음 exit·close한다. hold가 아니면
// exitAfterMs 뒤에 exit하고, exit와 close 사이에는 closeAfterMs를 둔다(기본 0 — 같은 콜백).
function scriptedChildren(plan) {
  let nextPid = 910_000;
  const exec = (spec) => {
    const script = plan(spec);
    const observe = spec.observe ?? (() => {});
    let stdout = '';
    let finished = false;
    let settle;
    let markClosed;
    const done = new Promise((resolve) => { settle = resolve; });
    const closed = new Promise((resolve) => { markClosed = resolve; });
    const emit = (chunk) => { stdout += chunk; observe({ type: 'stdout', chunk }); };
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      observe({ type: 'exit', code, signal });
      const close = () => {
        observe({ type: 'close', code, signal });
        settle({ code, signal, stdout, stderr: '' });
        markClosed();
      };
      if (script.closeAfterMs) setTimeout(close, script.closeAfterMs); else close();
    };
    setImmediate(() => {
      for (const chunk of script.chunks) emit(chunk);
      if (!script.hold) {
        if (script.exitAfterMs) setTimeout(() => finish(0, null), script.exitAfterMs); else finish(0, null);
      }
    });
    const kill = (signal) => {
      setTimeout(() => { for (const chunk of script.afterKill ?? []) emit(chunk); finish(null, signal); }, 5);
      return true;
    };
    return { pid: nextPid++, kill, done, closed };
  };
  return { exec };
}

const lineOfBytes = (bytes) => {
  const shell = JSON.stringify({ type: 'item.updated', item: { type: 'reasoning', text: '' } });
  return JSON.stringify({ type: 'item.updated', item: { type: 'reasoning', text: 'x'.repeat(bytes - Buffer.byteLength(shell)) } });
};

test('#297 타임라인(각본 자식): 상한 뒤 turn 완료·바이트 기준 64KiB·청크 경계·신호 뒤 출력·잘린 turn을 결정적으로 잰다', async (t) => {
  const spots = buildComparisonSpots(1);
  const f = fixture(t);
  const ev = (event) => `${JSON.stringify(event)}\n`;
  const korean = JSON.stringify({ type: 'item.updated', item: { type: 'reasoning', text: '가'.repeat(23_000) } });
  assert.ok(korean.length < 65_536 && Buffer.byteLength(korean) > 65_536, '코드 단위로는 짧고 바이트로는 긴 줄');
  const exact = lineOfBytes(65_536);
  const over = lineOfBytes(65_537);
  assert.deepEqual([Buffer.byteLength(exact), Buffer.byteLength(over)], [65_536, 65_537]);
  const third = Math.floor(korean.length / 3);
  const scripted = scriptedChildren((spec) => {
    const model = modelOf(spec.args);
    const isResume = spec.args.includes('resume');
    if (!isResume && !spec.input.includes('비교용')) {
      return { chunks: [jsonl({ type: 'thread.started', thread_id: 'th-p' }, { type: 'item.completed', item: { type: 'agent_message', text: 'UNAVAILABLE' } })] };
    }
    if (!isResume && model === LUNA) {
      // 경계 줄은 명시한 청크로 쪼개 보낸다(한글 줄은 세 조각). 그 뒤 70개 업데이트, ready, 상한 밖의 turn.completed.
      return {
        chunks: [
          ev({ type: 'thread.started', thread_id: 'th-l' }) + ev({ type: 'turn.started' }),
          korean.slice(0, third), korean.slice(third, 2 * third), `${korean.slice(2 * third)}\n`,
          `${exact}\n`, `${over.slice(0, 40_000)}`, `${over.slice(40_000)}\n`,
          Array.from({ length: 70 }, () => ev({ type: 'item.updated', item: { type: 'reasoning', text: 'r' } })).join(''),
          ev({ type: 'item.completed', item: { type: 'agent_message', text: 'ready' } }) + ev({ type: 'turn.completed' }),
        ],
      };
    }
    if (!isResume && model === SOL) {
      return {
        hold: true,
        chunks: [ev({ type: 'thread.started', thread_id: 'th-s' }) + ev({ type: 'turn.started' })],
        afterKill: [ev({ type: 'item.updated', item: { type: 'reasoning', text: 'late' } })],
      };
    }
    const spot = spots.find((candidate) => spec.input.includes(`decisionId: ${candidate.decisionId}`));
    return { chunks: [decision(spot, { action: safeAction(spot), reason: '각본 사유' })] };
  });
  const report = await runComparison({ samples: 1, timeoutMs: 20_000, warmupTimeoutMs: 300, budgetMs: 60_000 },
    { tmpRoot: f.tmpRoot, exec: scripted.exec });
  const [luna, sol] = report.variants;

  const [lunaWarm] = luna.samples[0].timelines.warmup;
  assert.equal(lunaWarm.oversizeLines, 2, '한글 줄(바이트 초과)과 65,537바이트 줄');
  assert.equal(lunaWarm.events[2].name, 'item.updated:reasoning', '정확히 65,536바이트인 줄은 이름을 남긴다');
  assert.equal(lunaWarm.events.length, 64);
  assert.ok(lunaWarm.eventsDropped > 0);
  assert.equal(lunaWarm.derived.censored, false, '목록 상한 뒤에 온 turn.completed도 turn 끝으로 본다');
  assert.equal(Number.isInteger(lunaWarm.derived.turnMs), true);
  assert.equal(lunaWarm.derived.lastEventToSignalMs, null, '신호가 없으면 null이다');

  const [solWarm] = sol.samples[0].timelines.warmup;
  assert.deepEqual([sol.samples[0].status, sol.samples[0].errorPhase], ['timeout', 'warmup']);
  const signalMs = solWarm.kills[0].ms;
  assert.equal(solWarm.derived.censored, true, '시작만 보인 turn은 잘렸다');
  assert.equal(solWarm.derived.turnObservedMs, signalMs - solWarm.events[1].ms);
  assert.equal(solWarm.derived.lastEventToSignalMs, signalMs - solWarm.events[1].ms, '신호 직전의 마지막 줄 기준이다');
  assert.ok(solWarm.derived.lastEventToSignalMs >= 0);
  assert.ok(solWarm.lastEventMs > signalMs, '신호 뒤 출력도 관측은 된다');
  assert.ok(solWarm.events.some(({ name, ms }) => name === 'item.updated:reasoning' && ms > signalMs));
  assert.equal(solWarm.closed, true);
  assert.ok(solWarm.derived.signalToCloseMs >= 0);
  assert.equal(JSON.stringify(report.variants.map((variant) => variant.samples.map((sample) => sample.timelines))).includes('가가가'), false);
});

test('#297 단계 집계: 두 단계가 모두 미관측이거나 미관측 뒤 실패해도 단계마다 따로·배타적으로 센다', async (t) => {
  const spots = buildComparisonSpots(1);
  const f = fixture(t);
  // luna: warmup·decide 모두 자식 없이 성공 주장. sol: warmup은 자식 없이 성공 주장, decide는 실패.
  const scripted = scriptedRuntime(spots, (model) => (model === LUNA
    ? { silent: ['warmup', 'decide'] } : { silent: ['warmup'], decideThrows: 'CLI_FAILED' }));
  const report = await runComparison({ samples: 1, timeoutMs: 20_000 }, { tmpRoot: f.tmpRoot, ...scripted.deps });
  const [luna, sol] = report.variants;
  const empty = { planned: 1, attempted: 1, answered: 0, timeout: 0, failed: 0, interrupted: 0, terminationUnconfirmed: 0, unobserved: 0, skipped: 0 };
  assert.deepEqual(luna.samples[0].phaseOutcomes, { warmup: 'unobserved', decide: 'unobserved' });
  assert.deepEqual(luna.summary.phases, { warmup: { ...empty, unobserved: 1 }, decide: { ...empty, unobserved: 1 } });
  assert.deepEqual(sol.samples[0].phaseOutcomes, { warmup: 'unobserved', decide: 'failed' });
  assert.deepEqual(sol.summary.phases, { warmup: { ...empty, unobserved: 1 }, decide: { ...empty, failed: 1 } });
  for (const variant of report.variants) {
    assert.deepEqual(variant.summary.warmupMs.observations, [], '자식이 관측되지 않은 warmup은 지연으로 싣지 않는다');
  }
});

test('#297 CLI: 모든 표본을 얻은 뒤 정리 중에 온 SIGINT도 STOPPED(cleanup)로 남고 complete=false, 종료 코드 3이다', async (t) => {
  const spots = buildComparisonSpots(1);
  const f = fixture(t, { script: { matchers: decisionMatchers(spots) } });
  const signals = new EventEmitter();
  let releaseDispose;
  const barrier = new Promise((resolve) => { releaseDispose = resolve; });
  let disposing = 0;
  const createRuntime = (kind, opts) => {
    const adapter = createPlayerRuntime(kind, opts);
    const original = adapter.dispose.bind(adapter);
    adapter.dispose = async () => { disposing += 1; await barrier; return original(); };
    return adapter;
  };
  const pending = runCli(['--live', '--json', '--samples', '1', '--timeout-ms', '20000'], { ...f.deps, createRuntime, signalSource: signals });
  const deadline = Date.now() + 15_000;
  while (disposing === 0) {
    assert.ok(Date.now() < deadline, '정리가 시작되지 않았다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  signals.emit('SIGINT');
  releaseDispose();
  const { code, out } = await pending;
  const report = JSON.parse(out);
  for (const variant of report.variants) assert.equal(variant.samples[0].status, 'ok', '측정은 다 얻었다');
  assert.deepEqual(report.aborted, { code: 'STOPPED', variant: null, phase: 'cleanup', signal: 'SIGINT' });
  assert.deepEqual([report.executionOk, report.complete, report.ok, code], [true, false, false, 3]);
  assert.equal(report.cleanup.removed, true);
});

test('#297 CLI: 진행 중인 probe는 중단 신호를 받지 않고 끝난 뒤 STOPPED(probe)로 멈춘다 — 표본은 시작하지 않는다', async (t) => {
  const spots = buildComparisonSpots(1);
  const slowProbe = { includes: '다음 파일을 읽어', delayMs: 2000, reply: reply('UNAVAILABLE') };
  const f = fixture(t, { script: { matchers: [slowProbe, ...decisionMatchers(spots)] } });
  const signals = new EventEmitter();
  const pending = runCli(['--live', '--json', '--samples', '1', '--timeout-ms', '20000'], { ...f.deps, signalSource: signals });
  const deadline = Date.now() + 10_000;
  while (f.calls().length === 0) {
    assert.ok(Date.now() < deadline, 'probe가 시작되지 않았다');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  signals.emit('SIGTERM');
  const { code, out } = await pending;
  const report = JSON.parse(out);
  assert.deepEqual(report.aborted, { code: 'STOPPED', variant: null, phase: 'probe', signal: 'SIGTERM' });
  assert.equal(report.variants[0].probe.attempted, true, '진행 중 probe는 끝까지 갔다');
  assert.equal(report.variants[0].probe.timelines[0].kills.length, 0, 'probe 자식에는 신호를 보내지 않았다');
  assert.equal(f.calls().filter((call) => call.stdin.includes('비교용') || call.argv.includes('resume')).length, 0, '표본은 시작하지 않았다');
  assert.equal(code, 3);
  assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0);
});

test('#297 타임라인(각본 자식): 일반 비JSON 줄과 개행 없이 끝난 64KiB 초과 출력도 원문 없이 센다', async (t) => {
  const spots = buildComparisonSpots(1);
  const f = fixture(t);
  const scripted = scriptedChildren((spec) => {
    const isResume = spec.args.includes('resume');
    if (!isResume && !spec.input.includes('비교용')) {
      return { chunks: [jsonl({ type: 'thread.started', thread_id: 'th-p' }, { type: 'item.completed', item: { type: 'agent_message', text: 'UNAVAILABLE' } })] };
    }
    if (!isResume && modelOf(spec.args) === LUNA) return { chunks: ['NOT-JSON-RAW-LINE\n', 'y'.repeat(40_000), 'y'.repeat(30_000)] };
    if (!isResume) return { chunks: [jsonl({ type: 'thread.started', thread_id: 'th-s' }, { type: 'item.completed', item: { type: 'agent_message', text: 'ready' } })] };
    const spot = spots.find((candidate) => spec.input.includes(`decisionId: ${candidate.decisionId}`));
    return { chunks: [decision(spot, { action: safeAction(spot), reason: '각본 사유' })] };
  });
  const report = await runComparison({ samples: 1, timeoutMs: 20_000 }, { tmpRoot: f.tmpRoot, exec: scripted.exec });
  const [timeline] = report.variants[0].samples[0].timelines.warmup;
  assert.deepEqual(timeline.events.map(({ name }) => name), ['nonjson']);
  assert.equal(timeline.oversizeLines, 1, '개행 없이 끝난 긴 출력도 한 줄로 센다');
  assert.equal(report.variants[0].samples[0].status, 'failed', '깨진 스트림은 세션이 아니다(판정은 계측과 무관)');
  const text = JSON.stringify(report.variants.map((variant) => variant.samples.map((sample) => sample.timelines)));
  assert.equal(text.includes('NOT-JSON-RAW-LINE'), false);
  assert.equal(text.includes('yyyy'), false);
});

test('#297 타임라인(각본 자식): turn 시작을 신호 뒤에야 처음 봤으면 잘린 구간 길이는 null이다', async (t) => {
  const spots = buildComparisonSpots(1);
  const f = fixture(t);
  const ev = (event) => `${JSON.stringify(event)}\n`;
  const scripted = scriptedChildren((spec) => {
    const isResume = spec.args.includes('resume');
    if (!isResume && !spec.input.includes('비교용')) {
      return { chunks: [jsonl({ type: 'thread.started', thread_id: 'th-p' }, { type: 'item.completed', item: { type: 'agent_message', text: 'UNAVAILABLE' } })] };
    }
    if (!isResume && modelOf(spec.args) === SOL) {
      return { hold: true, chunks: [ev({ type: 'thread.started', thread_id: 'th-s' })], afterKill: [ev({ type: 'turn.started' })] };
    }
    // Luna: turn이 시작된 뒤 완료 없이 스스로 exit한다 — 신호가 없으면 exit가 잘린 경계다. 시작·exit·close를 서로
    // 다른 시각에 두어 경계를 close·0으로 잘못 잡는 계산과 구별한다.
    if (!isResume) {
      return { chunks: [ev({ type: 'thread.started', thread_id: 'th-l' }) + ev({ type: 'turn.started' })], exitAfterMs: 60, closeAfterMs: 60 };
    }
    const spot = spots.find((candidate) => spec.input.includes(`decisionId: ${candidate.decisionId}`));
    return { chunks: [decision(spot, { action: safeAction(spot), reason: '각본 사유' })] };
  });
  const report = await runComparison({ samples: 1, timeoutMs: 20_000, warmupTimeoutMs: 300 }, { tmpRoot: f.tmpRoot, exec: scripted.exec });
  const sample = report.variants[1].samples[0];
  const [timeline] = sample.timelines.warmup;
  assert.equal(sample.status, 'timeout');
  assert.ok(timeline.events.find(({ name }) => name === 'turn.started').ms > timeline.kills[0].ms, '각본대로 turn 시작은 신호 뒤에 왔다');
  assert.equal(timeline.derived.censored, true);
  assert.equal(timeline.derived.turnObservedMs, null, '관측하지 못한 구간을 음수나 0으로 만들지 않는다');
  assert.equal(timeline.derived.lastEventToSignalMs, timeline.kills[0].ms - timeline.events[0].ms);

  const [exited] = report.variants[0].samples[0].timelines.warmup;
  assert.deepEqual(exited.kills, [], '신호 없이 스스로 끝났다');
  assert.equal(exited.derived.censored, true);
  assert.ok(exited.events[1].ms < exited.exitMs && exited.exitMs < exited.closeMs, '각본대로 시작 < exit < close');
  assert.equal(exited.derived.turnObservedMs, exited.exitMs - exited.events[1].ms, '신호가 없으면 exit까지가 관측 구간이다(close가 아니다)');
  assert.ok(exited.derived.turnObservedMs >= 30, `관측 구간은 exit까지의 실제 길이다: ${exited.derived.turnObservedMs}`);
});

test('#297 CLI: 중단 신호로 끝낸 호출의 close를 확인하지 못하면 STOPPED보다 TERMINATION_UNCONFIRMED가 우선하고 executionOk=false다', async (t) => {
  if (skipOnWin32(t, 'POSIX sessions and process groups')) return;
  const spots = buildComparisonSpots(1);
  const f = fixture(t);
  const release = path.join(f.dir, 'release-holder');
  const holderDecide = { includes: `decisionId: ${spots[0].decisionId}`, argvIncludes: SOL, delayMs: 30_000, orphanUntil: release, reply: decision(spots[0], { action: 'fold' }) };
  fs.writeFileSync(path.join(f.dir, 'script.json'), JSON.stringify({ default: { reply: reply('ready') }, matchers: [holderDecide, ...decisionMatchers(spots)] }));
  let disposeCalls = 0;
  const createRuntime = (kind, opts) => {
    const adapter = createPlayerRuntime(kind, opts);
    const original = adapter.dispose.bind(adapter);
    // 첫 정리 시도는 보유자가 남은 채로 실패하고, 둘째 시도 전에 보유자를 풀어 준다.
    adapter.dispose = () => { disposeCalls += 1; if (disposeCalls === 3) fs.writeFileSync(release, ''); return original(); };
    return adapter;
  };
  const signals = new EventEmitter();
  try {
    const pending = runCli(['--live', '--json', '--samples', '1', '--timeout-ms', '20000'], { ...f.deps, createRuntime, signalSource: signals });
    const deadline = Date.now() + 10_000;
    while (!f.calls().some((call) => call.argv.includes('resume') && modelOf(call.argv) === SOL)) {
      assert.ok(Date.now() < deadline, 'Sol decide가 시작되지 않았다');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 대조: 신호 전에는 decide 자식에 kill이 없고, 잠시 기다려도 watchdog(20초)이 대신 끝내지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(f.killAt.length, 0, '신호 전에 kill이 있었다');
    const emittedAt = Date.now();
    signals.emit('SIGINT');
    const { code, out } = await pending;
    // 이 결과는 watchdog이 아니라 중단 신호가 만든 것이다 — kill은 신호 직후에 한 번 갔다.
    assert.equal(f.killAt.length, 1);
    assert.ok(f.killAt[0] - emittedAt < 5_000, `kill이 신호 직후가 아니다(${f.killAt[0] - emittedAt}ms)`);
    const report = JSON.parse(out);
    assert.deepEqual([report.aborted.code, report.aborted.variant, report.aborted.phase], ['TERMINATION_UNCONFIRMED', 'sol-low', 'sample']);
    assert.equal(report.variants[1].samples[0].status, 'termination_unconfirmed');
    assert.deepEqual([report.executionOk, report.complete, report.ok, code], [false, false, false, 3]);
    assert.ok(report.failures.some(({ gate, code: failure }) => gate === 'executionOk' && failure === 'TERMINATION_UNCONFIRMED'));
    assert.equal(report.failures.some(({ code: failure }) => failure === 'STOPPED'), false, '종료 미확인이 먼저 기록되면 그쪽이 우선이다');
  } finally {
    if (!fs.existsSync(release)) fs.writeFileSync(release, '');
    const log = path.join(f.dir, 'calls.jsonl');
    const orphanPid = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).find((entry) => Number.isInteger(entry.orphanPid))?.orphanPid;
    if (orphanPid) assert.equal(await waitExited(orphanPid), true, '해제한 보유자가 끝나지 않았다');
  }
});

for (const name of ['SIGINT', 'SIGTERM']) {
  test(`#297 CLI: 마지막 표본의 decide 중 ${name}도 STOPPED로 기록되고 complete=false, 종료 코드 3이다`, async (t) => {
    const spots = buildComparisonSpots(1);
    const slowSolDecide = { includes: `decisionId: ${spots[0].decisionId}`, argvIncludes: SOL, delayMs: 30_000, reply: decision(spots[0], { action: 'fold' }) };
    const f = fixture(t, { script: { matchers: [slowSolDecide, ...decisionMatchers(spots)] } });
    const signals = new EventEmitter();
    const pending = runCli(['--live', '--json', '--samples', '1', '--timeout-ms', '20000'], { ...f.deps, signalSource: signals });
    const deadline = Date.now() + 10_000;
    while (!f.calls().some((call) => call.argv.includes('resume') && modelOf(call.argv) === SOL)) {
      assert.ok(Date.now() < deadline, 'Sol decide가 시작되지 않았다');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    signals.emit(name);
    const { code, out } = await pending;
    assert.equal(code, 3);
    const report = JSON.parse(out);
    assert.deepEqual(report.aborted, { code: 'STOPPED', variant: null, phase: 'sample', spot: spots[0].id, round: 0, signal: name });
    assert.deepEqual([report.executionOk, report.complete, report.ok], [true, false, false]);
    assert.equal(report.variants[1].samples[0].status, 'interrupted');
    assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0);
  });
}

// warmup(create) 입력만 페르소나 이름을 싣는다 — probe(카나리)·decide(스냅샷) 입력에는 없다.
const solWarmup = (extra) => ({ includes: '비교용', argvIncludes: SOL, reply: reply('ready'), ...extra });

test('#297 실행: 래퍼 CLI의 warmup 타임아웃은 그룹째 끝나 close가 확인되고, 타임라인이 신호·exit·close를 나눠 보인다', async (t) => {
  if (skipOnWin32(t, 'POSIX process groups; win32 keeps direct-child termination')) return;
  const spots = buildComparisonSpots(2);
  const f = fixture(t, { script: { wrapper: true, matchers: [solWarmup({ delayMs: 30_000 }), ...decisionMatchers(spots)] } });
  const report = await runComparison({ samples: 2, timeoutMs: 20_000, warmupTimeoutMs: 1500, budgetMs: 120_000 }, f.deps);
  const [luna, sol] = report.variants;
  // 타임아웃은 쓸 만한 관측이고 하네스 사고가 아니다 — 종료가 확인됐으니 중단도 없다.
  // Sol은 응답을 하나도 얻지 못했으므로 "전부 합법"도 공허하게 참이 되지 않는다.
  assertGates(report, { executionOk: true, complete: false, allDecisionsLegal: false });
  assert.equal(report.aborted, null);
  assert.deepEqual(report.failures.map(({ gate, variant, code }) => [gate, variant, code]), [
    ['complete', 'sol-low', 'TIMEOUT'], ['allDecisionsLegal', 'sol-low', 'NO_DECISIONS_OBSERVED'],
  ]);
  assert.deepEqual(sol.samples.map((sample) => [sample.status, sample.errorPhase]), [['timeout', 'warmup'], ['timeout', 'warmup']]);
  assert.deepEqual(sol.summary.timeoutByPhase, { warmup: 2, decide: 0 });
  assert.deepEqual(sol.summary.phases, {
    warmup: { planned: 2, attempted: 2, answered: 0, timeout: 2, failed: 0, interrupted: 0, terminationUnconfirmed: 0, unobserved: 0, skipped: 0 },
    decide: { planned: 2, attempted: 0, answered: 0, timeout: 0, failed: 0, interrupted: 0, terminationUnconfirmed: 0, unobserved: 0, skipped: 2 },
  });
  assert.deepEqual(luna.summary.phases.decide, { planned: 2, attempted: 2, answered: 2, timeout: 0, failed: 0, interrupted: 0, terminationUnconfirmed: 0, unobserved: 0, skipped: 0 });
  assert.deepEqual(sol.summary.warmupMs.observations, [], '타임아웃의 경과는 응답 지연으로 세지 않는다');
  assert.equal(sol.summary.warmupMs.cold, null);
  assert.equal(luna.summary.legal, 2);
  for (const sample of sol.samples) {
    const [timeline] = sample.timelines.warmup;
    assert.deepEqual(timeline.kills.map(({ signal, delivered }) => [signal, delivered]), [['SIGKILL', true]]);
    assert.equal(timeline.closed, true, '그룹 신호로 손자까지 끝나 close가 왔다');
    assert.ok(timeline.derived.signalToCloseMs !== null && timeline.derived.signalToCloseMs < 300,
      `close는 어댑터의 확인 대기(300ms) 안에 왔다: ${timeline.derived.signalToCloseMs}`);
    assert.ok(timeline.derived.signalToExitMs <= timeline.derived.signalToCloseMs);
    assert.equal(timeline.exitSignal, 'SIGKILL');
    assert.deepEqual(sample.timelines.decide, [], '돌리지 않은 단계에는 타임라인이 없다');
  }
  const { attempts } = report.cleanup;
  assert.deepEqual(attempts.map(({ openChildren, errors }) => [openChildren, errors]), [[0, []]]);
  assert.equal(report.cleanup.removed, true);
  // 응답을 맡았던 손자(래퍼가 띄운 프로세스)도 남지 않는다.
  const solCreates = f.calls().filter((call) => modelOf(call.argv) === SOL && call.stdin.includes('비교용'));
  assert.equal(solCreates.length, 2);
  // 신호는 손자가 준비(TERM 처리 설치·stdin 수신 뒤 기록)한 뒤에 갔어야 재현이 성립한다.
  assert.equal(f.killAt.length, 2);
  solCreates.forEach((call, i) => assert.ok(call.readyAt <= f.killAt[i], `손자 준비 전 신호(ready ${call.readyAt}, kill ${f.killAt[i]})`));
  for (const call of solCreates) assert.equal(await waitExited(call.pid), true, `손자 ${call.pid}가 실행 중이다`);
  assert.match(formatReport(report), /warmup 신호 SIGKILL → exit \d+ms · close \d+ms/);
});

test('#297 실행: 그룹을 벗어난 후손이 stdio를 쥐면 종료 미확인으로 중단하고, 후손이 끝난 뒤 dispose 재시도에서 늦은 close가 확인된다', async (t) => {
  if (skipOnWin32(t, 'POSIX sessions and process groups')) return;
  const spots = buildComparisonSpots(1);
  const f = fixture(t);
  const release = path.join(f.dir, 'release-holder');
  fs.writeFileSync(path.join(f.dir, 'script.json'), JSON.stringify({
    default: { reply: reply('ready') },
    matchers: [solWarmup({ delayMs: 30_000, orphanUntil: release }), ...decisionMatchers(spots)],
  }));
  let disposeCalls = 0;
  const createRuntime = (kind, opts) => {
    const adapter = createPlayerRuntime(kind, opts);
    const original = adapter.dispose.bind(adapter);
    // 정리 시도마다 두 어댑터를 부른다. 둘째 시도(셋째 호출)에서야 후손을 풀어 준다 — 첫 시도는 반드시 실패한다.
    adapter.dispose = () => {
      disposeCalls += 1;
      if (disposeCalls === 3) fs.writeFileSync(release, '');
      return original();
    };
    return adapter;
  };
  try {
    const report = await runComparison({ samples: 1, timeoutMs: 20_000, warmupTimeoutMs: 1500, budgetMs: 120_000 }, {
      ...f.deps, createRuntime, runtimeOpts: { ...f.deps.runtimeOpts, terminateKillWaitMs: 1000 },
    });
    assert.equal(report.ok, false);
    assert.equal(report.executionOk, false);
    assert.deepEqual(report.aborted, { code: 'TERMINATION_UNCONFIRMED', variant: 'sol-low', phase: 'sample', spot: spots[0].id, round: 0 });
    const sample = report.variants[1].samples[0];
    assert.deepEqual([sample.status, sample.errorCode, sample.errorPhase], ['termination_unconfirmed', 'CHILD_CLOSE_UNCONFIRMED', 'warmup']);
    assert.deepEqual(sample.errorDetails, { purpose: 'create', signal: 'SIGKILL', waitBudgetMs: 1000, waitedMs: sample.errorDetails.waitedMs, closeConfirmed: false });
    assert.ok(sample.errorDetails.waitedMs >= 1000);
    const solCreate = f.calls().find((call) => modelOf(call.argv) === SOL && call.stdin.includes('비교용'));
    assert.ok(solCreate.readyAt <= f.killAt[0], '보유자를 만든 뒤에 신호가 갔다');

    // 경계: 직계는 신호 직후 exit했지만 close는 확인 대기를 넘겨, 둘째 정리 시도 중에 왔다.
    const [timeline] = sample.timelines.warmup;
    assert.deepEqual(timeline.kills.map(({ signal, delivered }) => [signal, delivered]), [['SIGKILL', true]]);
    assert.ok(timeline.derived.signalToExitMs < 1000, `직계 exit: ${timeline.derived.signalToExitMs}`);
    assert.equal(timeline.closed, true);
    assert.ok(timeline.derived.signalToCloseMs > 1000, `close가 확인 대기 안에 왔다: ${timeline.derived.signalToCloseMs}`);
    const { attempts, ...cleanup } = report.cleanup;
    assert.deepEqual(attempts.map(({ openChildren, errors }) => [openChildren, errors]), [
      [1, [{ variant: 'sol-low', code: 'CHILD_CLOSE_UNCONFIRMED' }]],
      [1, []],
    ]);
    const closedAt = timeline.spawnAtMs + timeline.closeMs;
    assert.ok(closedAt >= attempts[1].startedAtMs, `close(${closedAt})는 둘째 시도(${attempts[1].startedAtMs}) 중에 왔다`);
    assert.deepEqual(cleanup, { disposed: true, removed: true, tmp: null, errors: [] });
    assert.match(formatReport(report), /dispose 시도 1: .*열린 자식 1, 오류/);
  } finally {
    // 후손은 신호가 아니라 해제 파일로 끝낸다. 테스트 디렉터리를 지우기 전에 그 후손(로그에 남은 pid)이 끝났는지 본다.
    if (!fs.existsSync(release)) fs.writeFileSync(release, '');
    const log = path.join(f.dir, 'calls.jsonl');
    const orphanPid = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).find((entry) => Number.isInteger(entry.orphanPid))?.orphanPid;
    if (orphanPid) assert.equal(await waitExited(orphanPid), true, '해제한 후손이 끝나지 않았다');
  }
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
  const { attempts, ...cleanup } = report.cleanup;
  assert.deepEqual(cleanup, { disposed: true, removed: true, tmp: null, errors: [] });
  // 각본 exec 스텁은 close를 보고하지 않는다 — 그 자식들은 dispose 시점에 "열린 자식"으로 정직하게 세진다.
  assert.deepEqual(attempts.map(({ openChildren, errors }) => [openChildren, errors]), [[10, []]]);
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
  // 단계별 분모: 미관측 단계도 결과 항목에 든다 — 시도 = 응답 + 실패 종류의 합.
  assert.deepEqual(luna.summary.phases.warmup, { planned: 2, attempted: 2, answered: 0, timeout: 0, failed: 0, interrupted: 0, terminationUnconfirmed: 0, unobserved: 2, skipped: 0 });
  assert.deepEqual(sol.summary.phases.decide, { planned: 2, attempted: 2, answered: 0, timeout: 0, failed: 0, interrupted: 0, terminationUnconfirmed: 0, unobserved: 2, skipped: 0 });
  for (const variant of report.variants) {
    for (const phase of Object.values(variant.summary.phases)) {
      assert.equal(phase.attempted, phase.answered + phase.timeout + phase.failed + phase.interrupted + phase.terminationUnconfirmed + phase.unobserved);
      assert.equal(phase.planned, phase.attempted + phase.skipped);
    }
  }
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
  const { attempts, ...cleanup } = report.cleanup;
  assert.deepEqual(cleanup, { disposed: true, removed: true, tmp: null, errors: [] });
  assert.deepEqual(attempts.map(({ openChildren, errors }) => [openChildren, errors]), [[0, []]], '자식 없이 한 번에 정리된다');
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
