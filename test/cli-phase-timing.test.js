// #312: CLI 자식 한 번의 구간 시각. 단위(합성 이벤트)와 실제 spawnCli·어댑터 경로(fake CLI) 둘 다 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhaseTiming, withTiming } from '../tools/cli-phase-timing.js';
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
    bootMs: 220, turnStartMs: 220, turnEndMs: 3100, signalMs: null, exitMs: 3400, closeMs: 3410,
    turnMs: 2880, censored: false, exitToCloseMs: 10,
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
});

test('non-JSON and malformed lines are ignored without throwing', () => {
  const timing = createPhaseTiming(() => 0);
  timing.observe({ type: 'stdout', chunk: 'plain text\n{"type":"turn.started"\nnot json "turn.started"\n' });
  timing.observe({ type: 'stdout', chunk: undefined });
  timing.observe(null);
  assert.equal(timing.view().turnStartMs, null);
});

test('withTiming attaches once and never throws on unusual errors', () => {
  const error = new Error('x');
  withTiming(error, { a: 1 });
  withTiming(error, { a: 2 });
  assert.deepEqual(error.timing, { a: 1 });
  const frozen = Object.freeze(new Error('y'));
  assert.equal(withTiming(frozen, { a: 3 }), frozen);
  assert.equal(frozen.timing, undefined);
  assert.equal(withTiming(null, { a: 4 }), null);
});

// ── 어댑터 경로(fake CLI, 실제 spawnCli) ──────────────────────────────────────

function fakeRuntime(kind, script, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-timing-'));
  const scriptPath = path.join(dir, 'script.json');
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  const handles = [];
  const rt = createPlayerRuntime(kind, {
    env: { FAKE_CLI_SCRIPT: scriptPath, FAKE_CLI_LOG: path.join(dir, 'calls.jsonl') },
    exec: (spec) => {
      const handle = spawnCli({ ...spec, command: process.execPath, args: [FAKE_CLI, ...spec.args] });
      handles.push(handle);
      return handle;
    },
    ...opts,
  });
  return {
    rt,
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
  } finally {
    await f.cleanup();
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
  } finally {
    await f.cleanup();
  }
});
