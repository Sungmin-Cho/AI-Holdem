// #312: game-loop 기록의 플레이어 호출 지연을 읽기 전용으로 집계한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateLatency, buildLatencyReport, findLoopLogs, main, readLoopRecords, REPORT_LIMITS } from '../tools/player-latency-report.js';

function store(sessions, states = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-latency-'));
  fs.mkdirSync(path.join(root, '.session-store', 'sessions'), { recursive: true });
  for (const [name, lines] of Object.entries(sessions)) {
    const dir = path.join(root, '.session-store', 'sessions', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'loop.log'), lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
    if (states[name]) fs.writeFileSync(path.join(dir, 'loop-state.json'), JSON.stringify(states[name]));
  }
  return root;
}

const at = (second) => new Date(Date.UTC(2026, 9, 21, 3, 0, second)).toISOString();
const call = (second, purpose, elapsedMs, extra = {}) => ({
  at: at(second), event: 'player-call', purpose, decisionId: purpose === 'decision' ? `d-${second}-preflop-0` : null,
  runtime: 'codex', model: 'gpt-6.1-sol', timeoutMs: purpose === 'decision' ? 300000 : 120000, elapsedMs,
  code: 'RESPONSE_RECEIVED', category: 'response', censored: false, ...extra,
});
const attempt = (second, elapsedMs, extra = {}) => ({
  at: at(second), event: 'player-attempt', callNo: 1, decisionId: `d-${second}-flop-0`, generation: 1,
  runtime: 'codex', model: 'gpt-5.6-luna', budget: { softMs: 25000, hardMs: 300000 }, elapsedMs,
  code: 'RESPONSE_RECEIVED', category: 'response', closeConfirmed: true, censored: false, ...extra,
});

function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else out[path.relative(root, file)] = { size: stat.size, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(file).toString('base64') };
    }
  };
  walk(root);
  return out;
}

test('groups calls by runtime, model, kind and warmup batch size with denominators and nearest-rank percentiles', () => {
  const batch = (index) => ({ batch: { id: 'b1', size: 3, index }, timing: { bootMs: 200 + index, turnMs: 4000, exitToCloseMs: 300, signalMs: null, closeMs: 4600, censored: false, turnStartMs: 1, raw: 'x' } });
  const root = store({
    a: [
      call(1, 'start-warmup', 4000, batch(0)),
      call(1, 'start-warmup', 5000, batch(1)),
      call(1, 'start-warmup', 61000, batch(2)),
      { at: at(2), event: 'player-warmup-batch', purpose: 'start-warmup', batchId: 'b1', size: 3, answered: 3, failed: 0, codes: {}, wallMs: 61500 },
      ...[1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 26000].map((ms, i) => call(10 + i, 'decision', ms, { callNo: 1 })),
      call(30, 'decision', 300000, { code: 'TIMEOUT', category: 'timeout', censored: true }),
      call(31, 'decision', 900, { code: 'CLI_FAILED', category: 'transport' }),
      call(32, 'decision', 900, { code: 'INTERRUPTED', category: 'interrupted' }),
      call(33, 'repair-warmup', 7000, { decisionId: 'd-9-river-0' }),
      ...[1000, 2000].map((ms, i) => attempt(40 + i, ms)),
    ],
  });
  const report = buildLatencyReport(root);
  const groups = Object.fromEntries(report.groups.map((group) => [`${group.kind}:${group.batchSize ?? '-'}`, group]));
  const start = groups['start-warmup:3'];
  assert.equal(start.calls, 3);
  assert.deepEqual(start.outcomes, { answered: 3, timeout: 0, interrupted: 0, failed: {} });
  assert.deepEqual(start.answeredMs, { n: 3, min: 4000, median: 5000, p90: 61000, p95: 61000, max: 61000 });
  assert.deepEqual(start.over, { over60s: 1 });
  assert.deepEqual(start.timing.bootMs, { n: 3, min: 200, median: 201, p90: 202, p95: 202, max: 202 });
  const decision = groups['decision:-'];
  assert.equal(decision.calls, 13, 'player-call decisions only; player-attempt is not counted twice');
  assert.deepEqual(decision.outcomes, { answered: 10, timeout: 1, interrupted: 1, failed: { transport: 1 } });
  assert.deepEqual(decision.answeredMs, { n: 10, min: 1000, median: 5000, p90: 9000, p95: 26000, max: 26000 });
  assert.deepEqual(decision.over, { overSoft25s: 1 });
  assert.equal(groups['repair-warmup:-'].calls, 1);
  assert.equal(report.outliersTotal, 3);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /d-\d+-(preflop|flop|river)|"raw"|b1/, 'no decision id, batch id or unlisted timing field');
});

test('old sessions without player-call fall back to player-attempt, and get the start warmup upper-bound proxy', () => {
  const root = store({
    old: [
      { at: at(0), event: 'runtime-models', player: { runtime: 'codex', model: 'gpt-6-luna' }, upper: { runtime: 'codex', model: 'gpt-6.1-sol' } },
      { at: at(1), event: 'server-spawn', pid: 1, requestedPort: 0 },
      { at: at(9), event: 'bootstrap-playing', port: 1 },
      attempt(12, 4000, { model: 'gpt-6-luna' }),
      attempt(13, 6000, { model: 'gpt-6-luna' }),
    ],
    policy: [{ at: at(1), event: 'server-spawn' }, { at: at(2), event: 'bootstrap-playing' }],
    fresh: [
      { at: at(1), event: 'server-spawn' },
      call(5, 'start-warmup', 3000, { batch: { size: 1 } }),
      { at: at(6), event: 'bootstrap-playing' },
    ],
  });
  const report = buildLatencyReport(root);
  assert.deepEqual(report.sessions, { scanned: 3, llm: 2, withPlayerCalls: 2, byRuntime: { codex: 2 } });
  const decision = report.groups.find((group) => group.kind === 'decision');
  assert.equal(decision.model, 'gpt-6-luna');
  assert.equal(decision.calls, 2);
  assert.deepEqual(report.legacyStartWarmupUpperBound, [{
    runtime: 'codex', model: 'gpt-6-luna', sessions: 1, ms: { n: 1, min: 8000, median: 8000, p90: 8000, p95: 8000, max: 8000 }, unfinishedStarts: 0,
  }], 'only the LLM session without start-warmup records gets the proxy');
});

test('decisions are matched per decision: a call wins, an attempt fills in, and a repair-warmup call hides nothing', () => {
  const decisionCall = (second, id, elapsedMs) => call(second, 'decision', elapsedMs, { decisionId: id, generation: 1, callNo: 1 });
  const decisionAttempt = (second, id, elapsedMs) => attempt(second, elapsedMs, { decisionId: id, generation: 1, model: 'gpt-6.1-sol' });
  const root = store({
    // 예전 형식: 결정은 player-attempt뿐이고, 복구 warmup만 player-call이다.
    legacy: [
      call(1, 'repair-warmup', 7000, { decisionId: 'd-1-preflop-0', generation: 1 }),
      decisionAttempt(2, 'd-1-preflop-0', 1000),
      decisionAttempt(3, 'd-2-preflop-0', 2000),
    ],
    // 버전이 섞인 재개: 앞의 결정은 attempt만, 뒤의 결정은 call과 attempt가 둘 다 있다.
    mixed: [
      decisionAttempt(1, 'd-1-preflop-0', 1000),
      decisionCall(2, 'd-2-preflop-0', 2000),
      decisionAttempt(2, 'd-2-preflop-0', 2000),
      decisionCall(3, 'd-3-preflop-0', 3000),
      decisionAttempt(3, 'd-3-preflop-0', 3000),
    ],
  });
  const report = buildLatencyReport(root);
  const decision = report.groups.find((group) => group.kind === 'decision');
  assert.equal(decision.calls, 5, '2 legacy + 3 mixed, none counted twice');
  assert.deepEqual(decision.answeredMs, { n: 5, min: 1000, median: 2000, p90: 3000, p95: 3000, max: 3000 });
  assert.equal(report.groups.find((group) => group.kind === 'repair-warmup').calls, 1);
});

test('decision calls are matched per call number inside a session; sessions are separate namespaces', () => {
  const numbered = (event, second, callNo, elapsedMs) => (event === 'call'
    ? call(second, 'decision', elapsedMs, { decisionId: 'd-1-preflop-0', generation: 1, callNo })
    : attempt(second, elapsedMs, { decisionId: 'd-1-preflop-0', generation: 1, callNo, model: 'gpt-6.1-sol' }));
  const root = store({
    // 같은 결정의 교정 재호출: callNo 1은 둘 다 있고, callNo 2는 attempt만 남았다(call 줄이 손상된 경우).
    a: [numbered('call', 1, 1, 1000), numbered('attempt', 1, 1, 1000), numbered('attempt', 2, 2, 2000)],
    // 다른 게임의 같은 결정 키는 다른 호출이다.
    b: [numbered('call', 1, 1, 3000), numbered('attempt', 1, 1, 3000)],
    // callNo가 없는 옛 행: 순번으로 대응한다(call 1개, attempt 2개 → 호출 2개).
    c: [
      call(1, 'decision', 4000, { decisionId: 'd-1-preflop-0', generation: 1 }),
      attempt(1, 4000, { decisionId: 'd-1-preflop-0', generation: 1, callNo: null, model: 'gpt-6.1-sol' }),
      attempt(2, 5000, { decisionId: 'd-1-preflop-0', generation: 1, callNo: null, model: 'gpt-6.1-sol' }),
    ],
  });
  const decision = buildLatencyReport(root).groups.find((group) => group.kind === 'decision');
  assert.equal(decision.calls, 5);
  assert.deepEqual(decision.answeredMs, { n: 5, min: 1000, median: 3000, p90: 5000, p95: 5000, max: 5000 });
});

test('an LLM session whose start never reached playing is counted apart from the proxy distribution, even with no call at all', () => {
  const root = store({
    failed: [
      { at: at(0), event: 'runtime-models', player: { runtime: 'codex', model: 'gpt-6-luna' } },
      { at: at(1), event: 'server-spawn' },
    ],
    // 정책 게임도 runtime-models를 남긴다 — loop-state가 llm이 아니면 LLM 시작으로 세지 않는다.
    policy: [
      { at: at(0), event: 'runtime-models', player: { runtime: 'codex', model: 'gpt-6-luna' } },
      { at: at(1), event: 'server-spawn' },
    ],
    started: [
      { at: at(0), event: 'runtime-models', player: { runtime: 'codex', model: 'gpt-6-luna' } },
      { at: at(1), event: 'server-spawn' },
      { at: at(5), event: 'bootstrap-playing' },
      attempt(6, 4000, { model: 'gpt-6-luna' }),
    ],
  });
  // store() 뒤에 loop-state를 넣는다.
  fs.writeFileSync(path.join(root, '.session-store', 'sessions', 'failed', 'loop-state.json'), JSON.stringify({ opponentRuntime: 'llm', secret: 'x' }));
  fs.writeFileSync(path.join(root, '.session-store', 'sessions', 'policy', 'loop-state.json'), JSON.stringify({ opponentRuntime: 'policy' }));
  const report = buildLatencyReport(root);
  assert.equal(report.unfinishedStarts, 1);
  assert.equal(report.sessions.llm, 2);
  assert.equal(report.sessions.withPlayerCalls, 1);
  assert.equal(report.legacyStartWarmupUpperBound[0].sessions, 1);
  assert.equal(report.legacyStartWarmupUpperBound[0].unfinishedStarts, 1);
  assert.equal(report.legacyStartWarmupUpperBound[0].ms.max, 4000);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
  const out = [];
  main([root], { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: () => {} } });
  assert.match(out.join(''), /playing에 이르지 못한 LLM 시작\(대리값에서 제외\): 1/);
});

test('callNo-numbered rows match by number first; only the remaining unnumbered rows match by order', () => {
  const id = { decisionId: 'd-1-preflop-0', generation: 1 };
  const root = store({ s: [
    call(1, 'decision', 2000, { ...id, callNo: 2 }),
    attempt(1, 300000, { ...id, callNo: 1, code: 'TIMEOUT', category: 'timeout', censored: true, model: 'gpt-6.1-sol' }),
    attempt(2, 2000, { ...id, callNo: 2, model: 'gpt-6.1-sol' }),
    attempt(3, 7000, { ...id, callNo: null, model: 'gpt-6.1-sol' }),
  ] });
  const decision = buildLatencyReport(root).groups.find((group) => group.kind === 'decision');
  assert.equal(decision.calls, 3, 'call #2, the timed-out attempt #1, and the unnumbered old row');
  assert.equal(decision.outcomes.timeout, 1, 'the #1 timeout is kept');
  assert.deepEqual(decision.answeredMs.max, 7000);
  assert.equal(decision.answeredMs.n, 2, '#2 is counted once');
});

test('damaged, partial and oversize lines are skipped and counted; --since filters by record time', () => {
  const root = store({
    s: [
      call(1, 'decision', 1000),
      'not json',
      '[1,2]',
      `{"at":"${at(2)}","event":"player-call"`,
      call(50, 'decision', 2000),
    ],
  });
  fs.appendFileSync(path.join(root, '.session-store', 'sessions', 's', 'loop.log'), `${JSON.stringify(call(51, 'decision', 3000, { pad: 'x'.repeat(REPORT_LIMITS.lineBytes) }))}\n{"at":"${at(60)}","eve`);
  const report = buildLatencyReport(root);
  assert.deepEqual(report.skipped, { oversizeFile: 0, oversizeLines: 1, unparsableLines: 4 });
  assert.equal(report.groups[0].calls, 2);
  const since = buildLatencyReport(root, { since: at(10) });
  assert.equal(since.groups[0].calls, 1);
  assert.equal(since.groups[0].answeredMs.max, 2000);
});

test('an oversize file is skipped whole and counted', () => {
  const root = store({ big: [call(1, 'decision', 1000)] });
  const file = path.join(root, '.session-store', 'sessions', 'big', 'loop.log');
  const { records, skipped } = readLoopRecords(file, { ...REPORT_LIMITS, fileBytes: 10 });
  assert.deepEqual(records, []);
  assert.equal(skipped.oversizeFile, 1);
});

test('a game dir with a single loop.log is accepted; an empty path is refused; symlinks are not followed', () => {
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-latency-game-'));
  fs.writeFileSync(path.join(gameDir, 'loop.log'), `${JSON.stringify(call(1, 'decision', 1500))}\n`);
  assert.equal(findLoopLogs(gameDir).length, 1);
  assert.equal(buildLatencyReport(gameDir).groups[0].calls, 1);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-latency-empty-'));
  assert.throws(() => findLoopLogs(empty), { code: 'NO_LOOP_LOGS' });
  const linked = store({});
  const sessions = path.join(linked, '.session-store', 'sessions');
  fs.mkdirSync(path.join(sessions, 'x'), { recursive: true });
  fs.symlinkSync(path.join(gameDir, 'loop.log'), path.join(sessions, 'x', 'loop.log'));
  assert.deepEqual(findLoopLogs(linked), []);
  // 세션 디렉터리 자체가 store 밖을 가리키는 링크여도 따라가지 않는다.
  fs.symlinkSync(gameDir, path.join(sessions, 'outside'));
  assert.deepEqual(findLoopLogs(linked), []);
});

test('the report never writes to the store', () => {
  const root = store({ a: [call(1, 'start-warmup', 4000, { batch: { size: 1 } }), call(2, 'decision', 3000)] });
  const before = snapshot(root);
  const out = [];
  assert.equal(main([root, '--json'], { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: () => {} } }), 0);
  assert.equal(JSON.parse(out.join('')).schema, 'player-latency-report/1');
  assert.equal(main([root], { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: () => {} } }), 0);
  assert.deepEqual(snapshot(root), before);
});

test('CLI argument errors exit 2; a missing store exits 1', () => {
  const err = [];
  const io = { stdout: { write: () => {} }, stderr: { write: (chunk) => err.push(chunk) } };
  assert.equal(main([], io), 2);
  assert.equal(main(['/x', '--since', 'yesterday'], io), 2);
  assert.equal(main(['/x', '--bogus'], io), 2);
  assert.equal(main([path.join(os.tmpdir(), 'holdem-latency-missing-dir')], io), 1);
  assert.throws(() => aggregateLatency([], { since: 'nope' }), { code: 'BAD_ARGS' });
});
