import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boundedNetworkCall, MAX_NETWORK_BUDGET_MS } from '../tools/bounded-network-call.js';
import { registerOwnedProcess } from './helpers/owned-fixtures.mjs';

const MODULE_URL = new URL('../tools/bounded-network-call.js', import.meta.url).href;
const msSince = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const isTimeout = (error) => error instanceof DOMException && error.name === 'TimeoutError'
  && error.message === 'The operation was aborted due to timeout';

const execFilePromise = promisify(execFile);
// A one-shot process: nothing but `source` keeps its event loop alive. It reports when it ended
// from its own clock, synchronously at exit — the parent observes the exit late while it
// registers the child (a synchronous identity probe, up to 15s on Windows). The exit code is the
// one the parent observes: on Node 20 the 'exit' event of an unsettled top-level await carries 0
// although the process exits 13.
async function runOneShot(source) {
  const preamble = [
    "import fs from 'node:fs';",
    `import { boundedNetworkCall } from ${JSON.stringify(MODULE_URL)};`,
    'const started = process.hrtime.bigint();',
    "process.on('exit', () => { fs.writeSync(1, JSON.stringify({ ms: Number(process.hrtime.bigint() - started) / 1e6 }) + '\\n'); });",
  ].join('\n');
  const pending = execFilePromise(process.execPath, ['--input-type=module', '-e', `${preamble}\n${source}`], {
    encoding: 'utf8',
    timeout: 60000,
  });
  queueMicrotask(() => registerOwnedProcess(pending.child, 'bounded-call-one-shot'));
  let code;
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await pending);
    code = 0;
  } catch (error) {
    ({ code, stdout = '', stderr = '' } = error);
  }
  const reported = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).at(-1);
  return { code, stderr, reported };
}

// A timer cuts a delay past 2^31-1 to 1ms with only a warning, so such a budget is refused.
test('boundedNetworkCall accepts a whole-millisecond budget a timer can hold, and nothing else', () => {
  assert.equal(MAX_NETWORK_BUDGET_MS, 2 ** 31 - 1);
  for (const budget of [1.5, -1, 2 ** 31, 2 ** 32, Number.NaN, Infinity, '10', null, undefined]) {
    assert.throws(() => boundedNetworkCall(budget), RangeError, `budget ${String(budget)}`);
  }
  for (const budget of [0, 1, MAX_NETWORK_BUDGET_MS]) {
    const call = boundedNetworkCall(budget);
    call.release();
    assert.equal(call.signal.aborted, false);
  }
});

test('boundedNetworkCall ends a call that never settles at its budget, aborting its signal with the same TimeoutError', async () => {
  const call = boundedNetworkCall(200);
  const started = process.hrtime.bigint();
  let abortedMs = null;
  call.signal.addEventListener('abort', () => { abortedMs = msSince(started); }, { once: true });
  try {
    await assert.rejects(call.settle(new Promise(() => {})), (error) => {
      assert.ok(isTimeout(error), `rejected with ${error?.name}: ${error?.message}`);
      assert.equal(error, call.signal.reason, 'the signal aborts with the reason the caller sees');
      return true;
    });
  } finally {
    call.release();
  }
  const settledMs = msSince(started);
  assert.ok(settledMs >= 190 && settledMs <= 2000, `settled ${settledMs}ms into a 200ms budget`);
  assert.ok(abortedMs !== null && abortedMs <= settledMs, `aborted at ${abortedMs}ms`);
  // Later waits on the same call end at once: the budget is spent.
  await assert.rejects(call.settle(new Promise(() => {})), isTimeout);
});

test('boundedNetworkCall passes through what settles inside its budget, and release disarms it', async () => {
  const call = boundedNetworkCall(100);
  try {
    assert.equal(await call.settle(Promise.resolve('answer')), 'answer');
    const refused = new Error('refused');
    await assert.rejects(call.settle(Promise.reject(refused)), (error) => error === refused);
  } finally {
    call.release();
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(call.signal.aborted, false, 'a released call never aborts');
});

// The failure this module exists for (#339, #343): a one-shot process whose only pending work is
// a call bounded by an unref'd AbortSignal.timeout timer empties its event loop and exits 13 with
// the top-level await unsettled. This control shows the harness tells that apart.
test('control: a one-shot process waiting only on AbortSignal.timeout exits 13, unsettled', async () => {
  const { code, reported } = await runOneShot([
    'const signal = AbortSignal.timeout(300);',
    "await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); });",
  ].join('\n'));
  assert.equal(code, 13);
  assert.ok(reported, 'the process recorded its exit');
});

test('boundedNetworkCall keeps a one-shot process alive to its budget and ends it with the TimeoutError, never exit 13', async () => {
  const { code, stderr, reported } = await runOneShot([
    'const call = boundedNetworkCall(300);',
    'try { await call.settle(new Promise(() => {})); } finally { call.release(); }',
  ].join('\n'));
  assert.equal(code, 1, stderr);
  assert.match(stderr, /TimeoutError/);
  assert.ok(reported, 'the process recorded its exit');
  assert.ok(reported.ms >= 290 && reported.ms <= 3000, `ended ${reported.ms}ms into a 300ms budget`);
});

test('boundedNetworkCall release lets a one-shot process exit at once, long before its budget', async () => {
  const { code, stderr, reported } = await runOneShot([
    'const call = boundedNetworkCall(60000);',
    "try { await call.settle(Promise.resolve('done')); } finally { call.release(); }",
  ].join('\n'));
  assert.equal(code, 0, stderr);
  assert.ok(reported, 'the process recorded its exit');
  assert.ok(reported.ms <= 3000, `held ${reported.ms}ms after release`);
});
