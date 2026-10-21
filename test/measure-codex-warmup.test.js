// #312: 게임 시작처럼 warmup N개를 동시에 띄울 때와 하나씩 띄울 때를 같은 실제 경로로 재는 도구.
// 모든 테스트는 가짜 CLI(`test/helpers/fake-cli.js`) 또는 자식을 띄우지 않는 각본 어댑터만 쓴다 — 실제 codex는 부르지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODES,
  WARMUP_CONCURRENCY_CRITERIA,
  judgeWarmups,
  main,
  measurementPersonas,
  runWarmupConcurrency,
  summarizeVariant,
  validateWarmupOptions,
  warmupPlan,
  warmupSchedule,
} from '../tools/measure-codex-warmup.js';
import { COMPARISON_VARIANTS } from '../tools/compare-codex-players.js';
import { spawnCli } from '../tools/player-runtime.js';

const FAKE_CLI = fileURLToPath(new URL('./helpers/fake-cli.js', import.meta.url));
const LUNA = 'gpt-6-luna';
const SOL = 'gpt-6.1-sol';
const jsonl = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const ready = jsonl(
  { type: 'thread.started', thread_id: 'th-warm-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'ready' } },
  { type: 'turn.completed' },
);

function fixture(t, script = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-warmup-test-'));
  const scriptPath = path.join(dir, 'script.json');
  const logPath = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(scriptPath, JSON.stringify({ default: { reply: ready }, ...script }));
  const tmpRoot = path.join(dir, 'tmp');
  fs.mkdirSync(tmpRoot);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.argv);
  return {
    tmpRoot,
    calls,
    deps: {
      tmpRoot,
      runtimeOpts: { env: { FAKE_CLI_SCRIPT: scriptPath, FAKE_CLI_LOG: logPath }, terminateKillWaitMs: 300 },
      exec: (spec) => spawnCli({ ...spec, command: process.execPath, args: [FAKE_CLI, ...spec.args] }),
      loadavg: () => [1, 1, 1],
    },
  };
}

// 자식을 띄우지 않는 각본 어댑터. 실제 어댑터처럼 단계마다 `opts.exec`에 argv를 넘긴다(도구의 래퍼가 관측한다).
function scriptedRuntime(behavior = () => ({})) {
  const log = { warmups: [], disposed: 0 };
  const createRuntime = (kind, opts) => {
    const pin = opts.benchmarkPin;
    const argv = (model = pin.model) => [...(pin.effort === 'model-default' ? [] : ['-c', `model_reasoning_effort="${pin.effort}"`]), 'exec', '-m', model];
    return {
      models: { player: pin.model },
      async probe() { opts.exec({ command: 'codex', args: argv(), input: '' }); return { ok: true, containment: true }; },
      async warmup({ playerId }) {
        const scene = behavior({ model: pin.model, playerId, n: log.warmups.length }) ?? {};
        log.warmups.push({ model: pin.model, playerId });
        if (!scene.silent) opts.exec({ command: 'codex', args: argv(scene.model), input: '' });
        if (scene.delayMs) await new Promise((resolve) => setTimeout(resolve, scene.delayMs));
        if (scene.throws) throw Object.assign(new Error('scripted'), { code: scene.throws });
        return { sessionId: `s-${playerId}` };
      },
      async dispose() { log.disposed += 1; },
    };
  };
  const exec = () => ({ pid: 4242, kill: () => true, done: Promise.resolve({ code: 0 }) });
  return { log, deps: { createRuntime, exec, loadavg: () => [0, 0, 0] } };
}

test('options: defaults follow the operating warmup cap and the default AI count; bounds are enforced', () => {
  assert.deepEqual(validateWarmupOptions({}), { batchSize: 5, rounds: 4, timeoutMs: 120_000, warmupTimeoutMs: 120_000, budgetMs: 1_800_000 });
  for (const bad of [{ batchSize: 0 }, { batchSize: 9 }, { rounds: 9 }, { timeoutMs: 100 }, { budgetMs: 3_600_001 }, { samples: 1 }, { batchSize: '5' }, null, []]) {
    assert.throws(() => validateWarmupOptions(bad), { code: 'BAD_OPTIONS' }, JSON.stringify(bad));
  }
  const plan = warmupPlan({ batchSize: 5, rounds: 4 });
  assert.equal(plan.warmupsPerVariant, 40);
  assert.equal(plan.maxModelCalls, 82);
  assert.deepEqual(plan.criteria, { over60sMs: 60_000, parallelRatio: 1.5, parallelDiffMs: 2_000 });
});

test('schedule alternates the variant order by round and the mode order by round and variant', () => {
  const schedule = warmupSchedule({ rounds: 4 });
  assert.equal(schedule.length, 16);
  assert.deepEqual(schedule.slice(0, 4).map(({ variantIndex, mode }) => [variantIndex, mode]),
    [[0, 'parallel'], [0, 'sequential'], [1, 'sequential'], [1, 'parallel']]);
  assert.deepEqual(schedule.slice(4, 8).map(({ variantIndex, mode }) => [variantIndex, mode]),
    [[1, 'parallel'], [1, 'sequential'], [0, 'sequential'], [0, 'parallel']]);
  for (const variantIndex of [0, 1]) {
    const firsts = [0, 1, 2, 3].map((round) => schedule.find((entry) => entry.round === round && entry.variantIndex === variantIndex).mode);
    assert.equal(firsts.filter((mode) => mode === 'parallel').length, 2, 'each variant starts with each mode equally often');
  }
});

test('personas use the operating persona text in a fixed order with distinct names', () => {
  const personas = measurementPersonas(8);
  assert.equal(new Set(personas.map((persona) => persona.name)).size, 8);
  assert.deepEqual(personas.slice(0, 6).map((persona) => persona.archetype), ['TAG', 'LAG', 'Nit', 'CallingStation', 'Maniac', 'Trickster']);
  assert.ok(personas.every((persona) => persona.speech && persona.personality));
  assert.deepEqual(measurementPersonas(3), personas.slice(0, 3));
});

test('fake CLI: parallel batches really overlap, sequential ones do not, and every warmup is its own observed child', { timeout: 60_000 }, async (t) => {
  const f = fixture(t, { default: { reply: ready, delayMs: 250 } });
  const report = await runWarmupConcurrency({ batchSize: 3, rounds: 2, timeoutMs: 10_000 }, f.deps);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.untaggedChildren, 0);
  assert.equal(report.batches.length, 8);
  for (const variant of report.variants) {
    assert.equal(variant.probe.verified, true);
    for (const mode of MODES) {
      const s = variant.summary[mode];
      assert.equal(s.planned, 6);
      assert.equal(s.answered, 6);
      assert.equal(s.maxInFlight, mode === 'parallel' ? 3 : 1);
      assert.equal(s.phases.bootMs.observations.length, 6, 'every answered warmup has its own timeline');
    }
  }
  for (const batch of report.batches) {
    const spans = batch.calls.map((call) => {
      assert.equal(call.timelines.length, 1);
      const [timeline] = call.timelines;
      return [timeline.spawnAtMs, timeline.spawnAtMs + timeline.closeMs];
    });
    const overlap = Math.max(...spans.map(([start]) => start)) < Math.min(...spans.map(([, end]) => end));
    assert.equal(overlap, batch.mode === 'parallel', `${batch.mode} overlap`);
  }
  // 운영처럼 서로 다른 페르소나 프롬프트가 같은 어댑터로 간다.
  const creates = f.calls().filter((call) => call.argv.includes('--json') && !call.argv.includes('resume'));
  const names = measurementPersonas(3).map((persona) => persona.name);
  for (const name of names) assert.ok(creates.some((call) => call.stdin.includes(name)), name);
  assert.equal(report.cleanup.removed, true);
  assert.doesNotMatch(JSON.stringify(report), /th-warm-1|SENTINEL|ready"/, 'no raw output, session id or canary in the report');
});

test('fake CLI: a warmup over its cap is a confirmed timeout counted against completeness, not execution', { timeout: 60_000 }, async (t) => {
  const slowName = measurementPersonas(2)[1].name;
  const f = fixture(t, {
    matchers: [{ includes: slowName, reply: ready, delayMs: 30_000 }],
    default: { reply: ready },
  });
  const report = await runWarmupConcurrency({ batchSize: 2, rounds: 1, timeoutMs: 10_000, warmupTimeoutMs: 4_000 }, f.deps);
  assert.equal(report.executionOk, true, JSON.stringify(report.failures));
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  for (const row of report.findings.c1Timeouts) assert.deepEqual([row.parallel, row.sequential], [1, 1]);
  assert.ok(report.findings.c3ParallelEffect.every((row) => row.observed === null), 'no C3 conclusion without ok');
  const timedOut = report.batches.flatMap((batch) => batch.calls).filter((call) => call.status === 'timeout');
  assert.equal(timedOut.length, 4);
  for (const call of timedOut) assert.ok(call.timelines[0].kills.length > 0 && call.timelines[0].closed, 'killed and close confirmed');
});

test('scripted: a warmup that answers without its own child is unobserved and fails execution', async () => {
  const scripted = scriptedRuntime(({ playerId }) => (playerId === 'p2' ? { silent: true } : {}));
  const report = await runWarmupConcurrency({ batchSize: 2, rounds: 1, timeoutMs: 1_000 }, { ...scripted.deps, tmpRoot: os.tmpdir() });
  assert.equal(report.executionOk, false);
  assert.ok(report.failures.some((failure) => failure.code === 'NO_CHILD_OBSERVED'));
  assert.equal(report.variants[0].summary.parallel.unobserved, 1);
});

test('scripted: a warmup spawned with another model is a model mismatch', async () => {
  const scripted = scriptedRuntime(({ model, playerId }) => (model === SOL && playerId === 'p1' ? { model: LUNA } : {}));
  const report = await runWarmupConcurrency({ batchSize: 2, rounds: 1, timeoutMs: 1_000 }, { ...scripted.deps, tmpRoot: os.tmpdir() });
  assert.equal(report.executionOk, false);
  assert.ok(report.failures.some((failure) => failure.code === 'MODEL_MISMATCH' && failure.variant === 'sol-low'));
});

test('scripted: an unconfirmed termination stops every later batch and fails execution', async () => {
  const scripted = scriptedRuntime(({ n }) => (n === 1 ? { throws: 'CHILD_CLOSE_UNCONFIRMED' } : {}));
  const report = await runWarmupConcurrency({ batchSize: 2, rounds: 2, timeoutMs: 1_000 }, { ...scripted.deps, tmpRoot: os.tmpdir() });
  assert.equal(report.executionOk, false);
  assert.equal(report.aborted.code, 'TERMINATION_UNCONFIRMED');
  assert.equal(scripted.log.warmups.length, 2, 'no warmup starts after the unconfirmed one');
  assert.ok(report.batches.slice(1).every((batch) => batch.calls.every((call) => call.status === 'skipped')));
  assert.equal(scripted.log.disposed, 2);
});

test('scripted: an exhausted budget skips work instead of starting calls it cannot finish', async () => {
  let clock = 0;
  const scripted = scriptedRuntime(() => { clock += 400; return {}; });
  const report = await runWarmupConcurrency({ batchSize: 2, rounds: 2, timeoutMs: 300, budgetMs: 1_000 },
    { ...scripted.deps, tmpRoot: os.tmpdir(), now: () => clock });
  assert.equal(report.complete, false);
  assert.ok(report.batches.some((batch) => batch.calls.some((call) => call.errorCode === 'BUDGET_EXHAUSTED')));
  assert.ok(report.failures.some((failure) => failure.code === 'WARMUPS_MISSING'));
});

test('scripted: a stop request ends the run with an incomplete report and no new calls', async () => {
  const controller = new AbortController();
  const scripted = scriptedRuntime(({ n }) => { if (n === 0) controller.abort({ signal: 'SIGINT' }); return {}; });
  const report = await runWarmupConcurrency({ batchSize: 2, rounds: 2, timeoutMs: 1_000 },
    { ...scripted.deps, tmpRoot: os.tmpdir(), stopSignal: controller.signal });
  assert.equal(report.aborted.code, 'STOPPED');
  assert.equal(report.complete, false);
  assert.equal(report.executionOk, true);
  assert.ok(scripted.log.warmups.length <= 2);
});

function batchOf(variant, mode, ms) {
  return { variant, mode, round: 0, wallMs: Math.max(...ms), maxInFlight: mode === 'parallel' ? ms.length : 1,
    calls: ms.map((warmupMs, index) => ({ index, status: 'answered', warmupMs, mismatch: null,
      timelines: [{ derived: { bootMs: 200, turnMs: warmupMs - 500, exitToCloseMs: 300 } }] })) };
}

test('C3 follows the pre-fixed rule: ratio ≥ 1.5 and difference ≥ 2 s, only for an ok run', () => {
  const cases = [
    { par: [9000, 9500, 10000], seq: [4000, 4500, 5000], observed: true },
    // ratio 2.0 but a 1.1 s difference: below the 2 s floor.
    { par: [2000, 2200, 2400], seq: [1000, 1100, 1200], observed: false },
    // 1.4999 rounds to 1.50 for display but is below the pre-fixed 1.5 (diff 4,999 ms ≥ 2 s).
    { par: [14999, 14999, 14999], seq: [10000, 10000, 10000], observed: false },
    // exactly 1.5 and a 5 s difference.
    { par: [15000, 15000, 15000], seq: [10000, 10000, 10000], observed: true },
    // even samples: the parallel median is 14,999.5 — below 1.5 × 10,000 without rounding.
    { par: [14999, 15000], seq: [10000, 10000], observed: false },
    { par: [5999, 6000], seq: [4000, 4000], observed: false },
    { par: [6000, 6500, 7000], seq: [5000, 5200, 5400], observed: false },
  ];
  for (const { par, seq, observed } of cases) {
    const options = validateWarmupOptions({ batchSize: par.length, rounds: 1 });
    const batches = COMPARISON_VARIANTS.flatMap(({ id }) => [batchOf(id, 'parallel', par), batchOf(id, 'sequential', seq)]);
    const variants = COMPARISON_VARIANTS.map(({ id }) => ({ id, probe: { attempted: true, observedCalls: 1, verified: true, mismatch: null },
      summary: summarizeVariant(id, batches, options) }));
    const verdict = judgeWarmups({ options, variants, batches, aborted: null, cleanup: { disposed: true, removed: true }, untagged: 0 });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
    assert.ok(verdict.findings.c3ParallelEffect.every((row) => row.observed === observed), JSON.stringify(verdict.findings.c3ParallelEffect));
  }
  const options = validateWarmupOptions({ batchSize: 3, rounds: 1 });
  const slow = COMPARISON_VARIANTS.flatMap(({ id }) => [batchOf(id, 'parallel', [61_000, 5000, 5000]), batchOf(id, 'sequential', [5000, 5000, 5000])]);
  const variants = COMPARISON_VARIANTS.map(({ id }) => ({ id, probe: { attempted: true, observedCalls: 1, verified: true, mismatch: null },
    summary: summarizeVariant(id, slow, options) }));
  const verdict = judgeWarmups({ options, variants, batches: slow, aborted: null, cleanup: { disposed: true, removed: true }, untagged: 0 });
  assert.equal(verdict.findings.c2Over60s.length, 2);
  assert.deepEqual(verdict.findings.c2Over60s[0].phases, [{ bootMs: 200, turnMs: 60_500, exitToCloseMs: 300 }]);
  assert.equal(WARMUP_CONCURRENCY_CRITERIA.over60sMs, 60_000);
});

test('CLI: without --live only the plan is printed and nothing is spawned; argument errors exit 2', async () => {
  let spawned = 0;
  const out = [];
  const err = [];
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) }, deps: { exec: () => { spawned += 1; } } };
  assert.equal(await main(['--batch-size', '5', '--rounds', '4', '--json'], io), 0);
  assert.equal(JSON.parse(out.join('')).executed, false);
  assert.equal(spawned, 0);
  assert.equal(await main(['--samples', '3'], io), 2);
  assert.equal(await main(['--batch-size', 'x'], io), 2);
  assert.equal(await main(['--batch-size', '9'], io), 2);
});
