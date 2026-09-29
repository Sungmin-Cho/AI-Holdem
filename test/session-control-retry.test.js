import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { retryControlWrite } from '../tools/session-control.js';

const busy = () => Object.assign(new Error('CONTROL_BUSY'), { code: 'CONTROL_BUSY' });
// Stands in for an attempt whose owner check is slow: on Windows, judging a lock held by
// another process spawns PowerShell, and that one read can outlast the whole window (#251).
const spin = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* synchronous, like spawnSync */ }
};

test('#251: an attempt that outlasts the window is still followed by another', async () => {
  let calls = 0;
  const result = await retryControlWrite(() => {
    calls += 1;
    if (calls === 1) { spin(60); throw busy(); }
    return 'accepted';
  }, { timeoutMs: 30 });
  assert.equal(result, 'accepted');
  assert.equal(calls, 2);
});

test('#251: past the window, a holder that stays busy gets exactly the minimum attempts', async () => {
  let calls = 0;
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    spin(40);
    throw busy();
  }, { timeoutMs: 10 }), { code: 'CONTROL_BUSY' });
  assert.equal(calls, 3);
});

test('#251: the total bound starts no attempt after it, even below the minimum', async () => {
  let calls = 0;
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    spin(60);
    throw busy();
  }, { timeoutMs: 10, maxMs: 50 }), { code: 'CONTROL_BUSY' });
  assert.equal(calls, 1);
});

test('fast attempts keep retrying for the whole window', async () => {
  let calls = 0;
  const started = performance.now();
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    throw busy();
  }, { timeoutMs: 150 }), { code: 'CONTROL_BUSY' });
  assert.ok(performance.now() - started >= 150, 'the window is not cut short');
  assert.ok(calls > 3, `fast attempts are not limited to the minimum (${calls})`);
});

test('a lock released inside the window is taken by a later attempt', async () => {
  const releaseAt = performance.now() + 60;
  let calls = 0;
  const result = await retryControlWrite(() => {
    calls += 1;
    if (performance.now() < releaseAt) throw busy();
    return 'accepted';
  }, { timeoutMs: 250 });
  assert.equal(result, 'accepted');
  assert.ok(calls > 1);
});

test('errors other than CONTROL_BUSY are never retried', async () => {
  for (const code of ['GAME_PAUSED', 'DECISION_CLOSED', 'CONTROL_UNAVAILABLE', 'NOT_YOUR_TURN']) {
    let calls = 0;
    await assert.rejects(retryControlWrite(() => {
      calls += 1;
      throw Object.assign(new Error(code), { code });
    }), { code });
    assert.equal(calls, 1, code);
  }
});
