import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { retryControlWrite } from '../tools/session-control.js';

const busy = () => Object.assign(new Error('CONTROL_BUSY'), { code: 'CONTROL_BUSY' });

// Logical time: an attempt costs what the test says, the pause between attempts
// costs what the retry asks for. Nothing depends on how fast the runner is.
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    spend: (ms) => { t += ms; },
  };
}

test('#251: an attempt that outlasts the window is still followed by another', async () => {
  const c = clock();
  let calls = 0;
  const result = await retryControlWrite(() => {
    calls += 1;
    if (calls === 1) { c.spend(600); throw busy(); } // a PowerShell identity read
    return 'accepted';
  }, { timeoutMs: 250, now: c.now, sleep: c.sleep });
  assert.equal(result, 'accepted');
  assert.equal(calls, 2);
});

test('#251: past the window, a holder that stays busy gets exactly the minimum attempts', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    c.spend(400);
    throw busy();
  }, { timeoutMs: 250, now: c.now, sleep: c.sleep }), { code: 'CONTROL_BUSY' });
  assert.equal(calls, 3);
});

test('#251: an explicit minimum is honoured', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    c.spend(400);
    throw busy();
  }, { timeoutMs: 250, minAttempts: 5, now: c.now, sleep: c.sleep }), { code: 'CONTROL_BUSY' });
  assert.equal(calls, 5);
});

test('#251: no attempt starts at or after the total bound, even below the minimum', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    c.spend(3000);
    throw busy();
  }, { timeoutMs: 250, now: c.now, sleep: c.sleep }), { code: 'CONTROL_BUSY' });
  assert.equal(calls, 2, 'the default bound is 5 s: attempts start at 0 and 3.02 s, not at 6.04 s');
});

test('#251: a bound reached during the pause stops the next attempt', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    c.spend(15);
    throw busy();
  }, { timeoutMs: 0, maxMs: 30, now: c.now, sleep: c.sleep }), { code: 'CONTROL_BUSY' });
  assert.equal(calls, 1, 'the pause ends at 35 ms, past the 30 ms bound');
});

test('#251: an explicit bound below the window wins over the window', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    throw busy();
  }, { timeoutMs: 1000, maxMs: 100, now: c.now, sleep: c.sleep }), { code: 'CONTROL_BUSY' });
  assert.equal(calls, 5, 'attempts start at 0, 20, 40, 60 and 80 ms');
});

test('a window longer than the default bound raises the bound with it', async () => {
  const c = clock();
  let calls = 0;
  const result = await retryControlWrite(() => {
    calls += 1;
    c.spend(1000);
    if (c.now() < 9000) throw busy();
    return 'accepted';
  }, { timeoutMs: 10_000, now: c.now, sleep: c.sleep });
  assert.equal(result, 'accepted');
  assert.equal(calls, 9);
});

test('fast attempts keep retrying for the whole window', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(retryControlWrite(() => {
    calls += 1;
    c.spend(1);
    throw busy();
  }, { timeoutMs: 250, now: c.now, sleep: c.sleep }), { code: 'CONTROL_BUSY' });
  assert.equal(calls, 12, 'an attempt starts every 21 ms until 250 ms have passed');
  assert.ok(c.now() >= 250);
});

test('a lock released inside the window is taken by a later attempt', async () => {
  const c = clock();
  let calls = 0;
  const result = await retryControlWrite(() => {
    calls += 1;
    if (c.now() < 60) throw busy();
    return 'accepted';
  }, { timeoutMs: 250, now: c.now, sleep: c.sleep });
  assert.equal(result, 'accepted');
  assert.equal(calls, 4);
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

test('#251: with the real clock, a slow synchronous attempt is still retried', async () => {
  let calls = 0;
  const result = await retryControlWrite(() => {
    calls += 1;
    if (calls === 1) {
      const end = performance.now() + 60;
      while (performance.now() < end) { /* synchronous, like spawnSync */ }
      throw busy();
    }
    return 'accepted';
  }, { timeoutMs: 30 });
  assert.equal(result, 'accepted');
  assert.equal(calls, 2);
});

test('onBusy observes every busy attempt, including the one that ends the retries', async () => {
  const c = clock();
  const seen = [];
  await assert.rejects(retryControlWrite(() => {
    c.spend(400);
    throw busy();
  }, { timeoutMs: 250, now: c.now, sleep: c.sleep, onBusy: (attempt) => seen.push(attempt) }), { code: 'CONTROL_BUSY' });
  assert.deepEqual(seen, [1, 2, 3]);
  const other = [];
  await assert.rejects(retryControlWrite(() => {
    throw Object.assign(new Error('GAME_PAUSED'), { code: 'GAME_PAUSED' });
  }, { onBusy: (attempt) => other.push(attempt) }), { code: 'GAME_PAUSED' });
  assert.deepEqual(other, [], 'only CONTROL_BUSY is reported');
});
