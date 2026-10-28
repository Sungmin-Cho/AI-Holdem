// #312: CLI 자식 한 번의 구간 시각. 단위(합성 이벤트)와 실제 spawnCli·어댑터 경로(fake CLI) 둘 다 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhaseTiming, ERROR_CLASS_NAMES, errorClassOf, SIGNAL_NAMES, withTiming } from '../tools/cli-phase-timing.js';
import { createPlayerRuntime, spawnCli } from '../tools/player-runtime.js';

const FAKE_CLI = fileURLToPath(new URL('./helpers/fake-cli.js', import.meta.url));
const line = (event) => `${JSON.stringify(event)}\n`;

function clock(start = 1000) {
  let value = start;
  return { now: () => value, set: (ms) => { value = start + ms; } };
}

test('milestones are the first thread/turn events, read across chunk boundaries', () => {
  const c = clock();
  const timing = createPhaseTiming(c.now);
  c.set(200);
  const started = line({ type: 'thread.started', thread_id: 'th-secret' });
  timing.observe({ type: 'stdout', chunk: started.slice(0, 10) });
  c.set(220);
  timing.observe({ type: 'stdout', chunk: started.slice(10) + line({ type: 'turn.started' }) });
  c.set(3000);
  timing.observe({ type: 'stdout', chunk: line({ type: 'item.completed', item: { type: 'agent_message', text: '"turn.completed"' } }) });
  c.set(3100);
  timing.observe({ type: 'stdout', chunk: line({ type: 'turn.completed' }) + line({ type: 'thread.started' }) });
  c.set(3400);
  timing.observe({ type: 'exit', code: 0, signal: null });
  c.set(3410);
  timing.observe({ type: 'close', code: 0, signal: null });
  const view = timing.view();
  assert.deepEqual(view, {
    bootMs: 220, turnStartMs: 220, firstProgressMs: 3000, turnEndMs: 3100, signalMs: null, exitMs: 3400, closeMs: 3410,
    turnMs: 2880, censored: false, exitToCloseMs: 10,
    turnEnd: 'completed', turnError: null, errorEvents: {}, exitCode: 0, exitSignal: null,
  });
  assert.doesNotMatch(JSON.stringify(view), /th-secret|agent_message/);
});

test('a turn cut by a signal is censored; the first signal time is kept', () => {
  const c = clock();
  const timing = createPhaseTiming(c.now);
  c.set(100);
  timing.observe({ type: 'stdout', chunk: line({ type: 'thread.started' }) + line({ type: 'turn.started' }) });
  c.set(120_000);
  timing.markSignal();
  c.set(120_500);
  timing.markSignal();
  timing.observe({ type: 'exit', code: null, signal: 'SIGKILL' });
  c.set(120_510);
  timing.observe({ type: 'close', code: null, signal: 'SIGKILL' });
  const view = timing.view();
  assert.equal(view.signalMs, 120_000);
  assert.equal(view.turnEndMs, null);
  assert.equal(view.turnMs, null);
  assert.equal(view.censored, true);
  assert.equal(view.exitToCloseMs, 10);
  assert.equal(view.turnEnd, null);
  assert.equal(view.exitCode, null);
  assert.equal(view.exitSignal, 'SIGKILL');
});

// #312 L5 1회차의 실패 turn(codex 0.163.0 `exec --json`의 실제 모양: error → turn.failed(error.message) → exit 1).
test('a failed turn records how it ended, closed error classes and the exit code, never the message', () => {
  const c = clock();
  const timing = createPhaseTiming(c.now);
  const capacity = 'SECRET-7c1 Selected model is at capacity. Please try a different model.';
  c.set(270);
  timing.observe({ type: 'stdout', chunk: line({ type: 'thread.started', thread_id: 'th-secret' })
    + line({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'SECRET-a9 code mode is not available' } })
    + line({ type: 'item.started', item: { id: 'item_1', type: 'error', message: 'SECRET-b4 started, not counted' } }) });
  c.set(480);
  timing.observe({ type: 'stdout', chunk: line({ type: 'turn.started' }) });
  c.set(7300);
  timing.observe({ type: 'stdout', chunk: line({ type: 'error', message: capacity }) + line({ type: 'turn.failed', error: { message: capacity } }) });
  c.set(7303);
  timing.observe({ type: 'stdout', chunk: line({ type: 'error', message: 'SECRET-d2 trailing note' }) });
  c.set(7477);
  timing.observe({ type: 'exit', code: 1, signal: null });
  timing.observe({ type: 'close', code: 1, signal: null });
  const view = timing.view();
  assert.equal(view.turnEndMs, 7300);
  assert.equal(view.turnMs, 6820);
  assert.equal(view.censored, false);
  assert.equal(view.turnEnd, 'failed');
  assert.equal(view.turnError, 'capacity');
  assert.deepEqual(view.errorEvents, { code_mode_unavailable: 1, capacity: 1, other: 1 });
  assert.equal(view.exitCode, 1);
  assert.equal(view.exitSignal, null);
  assert.doesNotMatch(JSON.stringify(view), /SECRET|th-secret|capacity\.|Please|item_/);
});

test('only the first turn end counts, an exit is read once, and odd exit values become closed tokens', () => {
  const timing = createPhaseTiming(() => 0);
  timing.observe({ type: 'stdout', chunk: line({ type: 'turn.started' }) + line({ type: 'turn.completed' })
    + line({ type: 'turn.failed', error: { message: 'rate limit' } }) });
  timing.observe({ type: 'exit', code: 1.5, signal: 'not-a-signal' });
  timing.observe({ type: 'exit', code: 0, signal: null });
  const view = timing.view();
  assert.equal(view.turnEnd, 'completed');
  assert.equal(view.turnError, null);
  assert.equal(view.exitCode, null, 'a non-integer code is not a code');
  assert.equal(view.exitSignal, 'other', 'an unexpected signal value is not copied');
  for (const odd of ['SIGSECRET', 'SIGKILL\n', 'sigkill', 42]) {
    const one = createPhaseTiming(() => 0);
    one.observe({ type: 'exit', code: null, signal: odd });
    assert.equal(one.view().exitSignal, 'other', `${JSON.stringify(odd)} is not a signal name`);
  }
  const fresh = createPhaseTiming(() => 0).view();
  assert.deepEqual([fresh.turnEnd, fresh.turnError, fresh.errorEvents, fresh.exitCode, fresh.exitSignal], [null, null, {}, null, null]);
  assert.notEqual(timing.view().errorEvents, timing.view().errorEvents, 'each view gets its own copy');
});

test('the signal list is closed and holds every signal name of the running platform', () => {
  for (const name of Object.keys(os.constants.signals)) assert.ok(SIGNAL_NAMES.includes(name), `${name} is missing`);
  assert.equal(new Set(SIGNAL_NAMES).size, SIGNAL_NAMES.length);
  assert.ok(SIGNAL_NAMES.every((name) => /^SIG[A-Z0-9]+$/.test(name)));
});

test('error classes are a closed list where the first match wins; capacity is last so older classes stay the same', () => {
  assert.deepEqual(ERROR_CLASS_NAMES, ['reconnect', 'rate_limit', 'code_mode_unavailable', 'timeout', 'capacity', 'other']);
  const cases = [
    [{ message: 'stream disconnected before completion; retrying 1/5' }, 'reconnect'],
    [{ error: { message: '429 Too Many Requests' } }, 'rate_limit'],
    [{ item: { type: 'error', message: 'code mode unavailable' } }, 'code_mode_unavailable'],
    [{ message: 'request timed out' }, 'timeout'],
    [{ error: { message: 'Selected model is at capacity. Please try a different model.' } }, 'capacity'],
    [{ message: 'server overloaded' }, 'capacity'],
    [{ message: 'Reconnecting... model is at capacity' }, 'reconnect'],
    [{ message: 'model not supported' }, 'other'],
    [{}, 'other'],
    [null, 'other'],
  ];
  for (const [event, expected] of cases) assert.equal(errorClassOf(event), expected, JSON.stringify(event));
});

test('an oversize line (and its remainder) is not read; later lines and an unterminated last line are', () => {
  const c = clock();
  const timing = createPhaseTiming(c.now);
  const huge = JSON.stringify({ type: 'thread.started', pad: 'x'.repeat(70 * 1024) });
  c.set(50);
  timing.observe({ type: 'stdout', chunk: huge.slice(0, 66 * 1024) });
  timing.observe({ type: 'stdout', chunk: huge.slice(66 * 1024) });
  c.set(60);
  timing.observe({ type: 'stdout', chunk: `\n${line({ type: 'turn.started' })}` });
  c.set(900);
  timing.observe({ type: 'stdout', chunk: JSON.stringify({ type: 'turn.completed' }) });
  c.set(950);
  timing.observe({ type: 'close', code: 0, signal: null });
  const view = timing.view();
  assert.equal(view.bootMs, null, 'the oversize thread.started line must not be read');
  assert.equal(view.turnStartMs, 60);
  assert.equal(view.turnEndMs, 950, 'an unterminated last line is read at close');
  assert.equal(view.exitMs, null);
  assert.equal(view.exitToCloseMs, null);
  assert.deepEqual([view.exitCode, view.exitSignal], [null, null], 'a close without an exit event leaves both unknown');
});

test('non-JSON and malformed lines are ignored without throwing', () => {
  const timing = createPhaseTiming(() => 0);
  timing.observe({ type: 'stdout', chunk: 'plain text\n{"type":"turn.started"\nnot json "turn.started"\n' });
  timing.observe({ type: 'stdout', chunk: undefined });
  timing.observe(null);
  assert.equal(timing.view().turnStartMs, null);
});

test('withTiming attaches once and never throws on unusual errors', () => {
  const error = Object.assign(new Error('x'), { code: 'TIMEOUT', details: { purpose: 'create' } });
  assert.equal(withTiming(error, { a: 1 }), error, 'the same error object is passed on');
  assert.equal(error.code, 'TIMEOUT');
  assert.deepEqual(error.details, { purpose: 'create' });
  withTiming(error, { a: 2 });
  assert.deepEqual(error.timing, { a: 1 });
  const frozen = Object.freeze(new Error('y'));
  assert.equal(withTiming(frozen, { a: 3 }), frozen);
  assert.equal(frozen.timing, undefined);
  assert.equal(withTiming(null, { a: 4 }), null);
});

// ── 진행 신호(#333) ───────────────────────────────────────────────────────────

// 이벤트 열을 시각과 함께 먹이고 첫 진행 신호·기동 시각을 돌려준다.
function progressOf(...steps) {
  const c = clock();
  const timing = createPhaseTiming(c.now);
  for (const [ms, ...events] of steps) {
    c.set(ms);
    timing.observe({ type: 'stdout', chunk: events.map((event) => (typeof event === 'string' ? `${event}\n` : line(event))).join('') });
  }
  const view = timing.view();
  return { progress: view.firstProgressMs, boot: view.bootMs, view };
}

test('claude progress: the first assistant/user/result/stream_event line; system init is the boot mark, not progress', () => {
  const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [], plugins: [] };
  const { progress, boot, view } = progressOf([150, init], [1700, { type: 'assistant', message: { content: [] } }], [2300, { type: 'result', result: 'ok' }]);
  assert.equal(boot, 150, 'claude system/init is the first session event');
  assert.equal(progress, 1700, 'the first assistant line is the first progress signal');
  assert.equal(view.turnStartMs, null, 'claude has no turn.started');
  for (const type of ['assistant', 'user', 'result', 'stream_event']) {
    assert.equal(progressOf([40, { type }]).progress, 40, `${type} is progress`);
  }
});

test('claude non-progress lines: any system subtype, rate_limit_event and unknown types', () => {
  const quiet = progressOf(
    [10, { type: 'system', subtype: 'init' }],
    [20, { type: 'system', subtype: 'api_retry', attempt: 1 }],
    [30, { type: 'system', subtype: 'hook_started' }],
    [40, { type: 'rate_limit_event', rate_limit_info: {} }],
    [50, { type: 'something_new' }],
    [60, 'plain text, not json "assistant"'],
  );
  assert.equal(quiet.progress, null);
  assert.equal(quiet.boot, 10);
  // 뒤에 오는 진짜 응답이 그 시각을 가진다. rate_limit_event가 assistant 뒤에 와도 첫 시각은 바뀌지 않는다.
  const later = progressOf([10, { type: 'system', subtype: 'init' }], [20, { type: 'rate_limit_event' }], [900, { type: 'assistant' }], [950, { type: 'rate_limit_event' }]);
  assert.equal(later.progress, 900);
});

test('codex progress: only an item after turn.started that is not an error, or the turn end', () => {
  // 실측(codex 0.164): turn.started 앞에 type "error" item.completed가 온다.
  const beforeTurn = progressOf(
    [200, { type: 'thread.started', thread_id: 'th-1' }],
    [210, { type: 'item.completed', item: { type: 'error', message: 'x' } }],
    [220, { type: 'item.completed', item: { type: 'agent_message', text: 'too early' } }],
  );
  assert.equal(beforeTurn.progress, null, 'items before turn.started are not progress, error or not');
  const quiet = progressOf(
    [200, { type: 'thread.started' }],
    [800, { type: 'turn.started' }],
    [810, { type: 'item.completed', item: { type: 'error', message: 'x' } }],
    [820, { type: 'item.started', item: { type: 'error' } }],
    [830, { type: 'error', message: 'warn' }],
  );
  assert.equal(quiet.progress, null, 'thread.started, turn.started, error events and error items are not progress');
  assert.equal(quiet.boot, 200);
  const item = progressOf([200, { type: 'thread.started' }], [800, { type: 'turn.started' }], [810, { type: 'item.completed', item: { type: 'error' } }], [5400, { type: 'item.started', item: { type: 'agent_message' } }]);
  assert.equal(item.progress, 5400);
  assert.equal(progressOf([1, { type: 'turn.started' }], [90, { type: 'turn.completed' }]).progress, 90);
  const failed = progressOf([1, { type: 'turn.started' }], [70, { type: 'turn.failed', error: { message: 'x' } }]);
  assert.equal(failed.progress, 70);
  assert.equal(failed.view.turnEndMs, 70);
});

test('the progress mark is the first one only and a fresh view has none', () => {
  assert.equal(createPhaseTiming(() => 0).view().firstProgressMs, null);
  assert.equal(progressOf([5, { type: 'assistant' }], [9, { type: 'result' }]).progress, 5);
  const c = clock();
  const timing = createPhaseTiming(c.now);
  timing.observe({ type: 'stdout', chunk: '{"type":"assis' });
  c.set(300);
  timing.observe({ type: 'stdout', chunk: 'tant"}\n' });
  assert.equal(timing.view().firstProgressMs, 300, 'a line split across chunks is read when it completes');
});

// ── 어댑터 경로(fake CLI, 실제 spawnCli) ──────────────────────────────────────

function fakeRuntime(kind, script, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-timing-'));
  const scriptPath = path.join(dir, 'script.json');
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  const handles = [];
  const kills = [];
  const rt = createPlayerRuntime(kind, {
    env: { FAKE_CLI_SCRIPT: scriptPath, FAKE_CLI_LOG: path.join(dir, 'calls.jsonl') },
    exec: (spec) => {
      const handle = spawnCli({ ...spec, command: process.execPath, args: [FAKE_CLI, ...spec.args] });
      handles.push(handle);
      return { ...handle, kill: (signal) => { kills.push(signal); return handle.kill(signal); } };
    },
    ...opts,
  });
  return {
    rt,
    kills,
    cleanup: async () => {
      for (const handle of handles) { try { handle.kill('SIGKILL'); } catch { /* 이미 종료 */ } }
      await rt.dispose?.().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const codexReply = (text) => [
  { type: 'thread.started', thread_id: 'th-timing-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage: {} },
].map((event) => JSON.stringify(event)).join('\n') + '\n';

function assertOrdered(timing) {
  for (const key of ['bootMs', 'turnStartMs', 'turnEndMs', 'closeMs']) assert.ok(Number.isInteger(timing[key]), `${key} must be observed`);
  assert.ok(timing.bootMs <= timing.turnStartMs && timing.turnStartMs <= timing.turnEndMs && timing.turnEndMs <= timing.closeMs);
  assert.equal(timing.censored, false);
  assert.equal(timing.signalMs, null);
}

test('codex warmup and decide return the observed timing of their own child', async () => {
  const f = fakeRuntime('codex', {
    matchers: [{ argvIncludes: 'resume', reply: codexReply('{"decisionId":"d1","action":"call"}') }],
    default: { reply: codexReply('ready') },
  });
  try {
    const warm = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 10_000 });
    assert.equal(warm.sessionId, 'th-timing-1');
    assertOrdered(warm.timing);
    const decided = await f.rt.decide({ playerId: 'p1', sessionId: warm.sessionId, message: 'm', timeoutMs: 10_000 });
    assertOrdered(decided.timing);
    assert.doesNotMatch(JSON.stringify([warm.timing, decided.timing]), /th-timing|ready|decisionId/);
  } finally {
    await f.cleanup();
  }
});

test('a codex warmup that is not ready still reports the timing of that call', async () => {
  const f = fakeRuntime('codex', { default: { reply: codexReply('not ready') } });
  try {
    await assert.rejects(
      f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 10_000 }),
      (error) => error.code === 'NOT_READY' && Number.isInteger(error.timing?.turnEndMs),
    );
  } finally {
    await f.cleanup();
  }
});

test('a timed-out call carries the signal and the confirmed close in its timing', { timeout: 15_000 }, async () => {
  const f = fakeRuntime('codex', { default: { reply: codexReply('ready'), delayMs: 30_000 } });
  try {
    await assert.rejects(
      f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 300 }),
      (error) => {
        assert.equal(error.code, 'TIMEOUT');
        assert.ok(Number.isInteger(error.timing.signalMs) && error.timing.signalMs >= 250);
        assert.ok(Number.isInteger(error.timing.closeMs) && error.timing.closeMs >= error.timing.signalMs);
        assert.equal(error.timing.bootMs, null);
        assert.equal(error.timing.censored, false);
        return true;
      },
    );
    assert.deepEqual(f.kills, ['SIGKILL'], 'timing adds no signal');
  } finally {
    await f.cleanup();
  }
});

test('a codex decide that fails its turn and exits 1 reports a failed turn, its class and the exit code', async () => {
  const failed = [
    { type: 'thread.started', thread_id: 'th-timing-1' },
    { type: 'turn.started' },
    { type: 'error', message: 'Selected model is at capacity. Please try a different model.' },
    { type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';
  const f = fakeRuntime('codex', {
    matchers: [{ argvIncludes: 'resume', reply: failed, exitCode: 1 }],
    default: { reply: codexReply('ready') },
  });
  try {
    const warm = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 10_000 });
    assert.equal(warm.timing.turnEnd, 'completed');
    assert.equal(warm.timing.exitCode, 0);
    await assert.rejects(
      f.rt.decide({ playerId: 'p1', sessionId: warm.sessionId, message: 'm', timeoutMs: 10_000 }),
      (error) => {
        assert.equal(error.code, 'CLI_FAILED');
        assert.equal(error.timing.turnEnd, 'failed');
        assert.equal(error.timing.turnError, 'capacity');
        assert.deepEqual(error.timing.errorEvents, { capacity: 1 });
        assert.equal(error.timing.exitCode, 1);
        assert.doesNotMatch(JSON.stringify(error.timing), /Selected|th-timing/);
        return true;
      },
    );
  } finally {
    await f.cleanup();
  }
});

test('a codex decide whose completed turn has no answer exits 0 — the timing tells it apart from a failed exit', async () => {
  const empty = [
    { type: 'thread.started', thread_id: 'th-timing-1' },
    { type: 'turn.started' },
    { type: 'turn.completed', usage: {} },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';
  const f = fakeRuntime('codex', {
    matchers: [{ argvIncludes: 'resume', reply: empty }],
    default: { reply: codexReply('ready') },
  });
  try {
    const warm = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 10_000 });
    await assert.rejects(
      f.rt.decide({ playerId: 'p1', sessionId: warm.sessionId, message: 'm', timeoutMs: 10_000 }),
      (error) => error.code === 'CLI_FAILED' && error.timing.turnEnd === 'completed' && error.timing.exitCode === 0
        && error.timing.turnError === null,
    );
  } finally {
    await f.cleanup();
  }
});

test('a CLI that cannot be spawned reports no exit code or signal', async () => {
  const rt = createPlayerRuntime('codex', { exec: (spec) => spawnCli({ ...spec, command: path.join(os.tmpdir(), 'holdem-no-such-cli', 'codex') }) });
  try {
    await assert.rejects(rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 10_000 }), (error) => {
      assert.equal(error.code, 'ENOENT');
      assert.deepEqual([error.timing.exitCode, error.timing.exitSignal, error.timing.turnEnd], [null, null, null]);
      return true;
    });
  } finally {
    await rt.dispose?.().catch(() => {});
  }
});

test('a claude call has no stream milestones but still reports exit and close', async () => {
  const f = fakeRuntime('claude', { default: { reply: JSON.stringify({ type: 'result', result: 'ready', session_id: 'abc' }) } });
  try {
    const result = await f.rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 10_000 }).catch((error) => error);
    const timing = result.timing;
    assert.ok(timing, 'timing is attached to the result or the error');
    assert.equal(timing.bootMs, null);
    assert.equal(timing.turnStartMs, null);
    assert.ok(Number.isInteger(timing.closeMs));
    assert.equal(timing.turnEnd, null);
    assert.equal(timing.exitCode, 0);
  } finally {
    await f.cleanup();
  }
});
