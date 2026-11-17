// #347 C: the relay turns pre-action hints off for its whole life only on an explicit verdict or
// evidence that the reference source changed. A read that misses its deadline, or any other
// transient failure, drops only that publication's hint; an initialization that failed that way is
// tried again from a later hint publication, a bounded number of times and never sooner than an
// interval after the previous try. The first source descriptor the relay reads is pinned, so a
// retry can never adopt a different one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { hintFixture } from './helpers/hint-fixture.mjs';
import * as hintProof from '../tools/hint-proof.js';

const { verifyHintPublication } = hintProof;
// The policy this change sets (tools/hint-proof.js): three retries after the first try, each at
// least five seconds after the previous one ended. Written out here so the tests pin it.
const RETRY_LIMIT = 3;
const RETRY_INTERVAL_MS = 5000;
// The publisher's POST budget (tools/publish.js PUBLISH_TIMEOUT_MS): no hint wait may outlast it.
const PUBLISH_BUDGET_MS = 10_000;
// Longer than the relay's 1-second bound on one hint read (tools/hint-proof.js readBounded).
const HOLD_MS = 1500;

// Holds the relay's async stat of `name` — the first step of every bounded hint read — past the
// read deadline. Calls after the first `skip` are held, `count` of them. A held stat fails once
// HOLD_MS has passed (so an abandoned read never opens the file), or never settles (`never`: a
// stuck disk). `seen` counts every stat of `name` while the hold is installed.
function holdHintStat(t, name, { skip = 0, count = 1, never = false } = {}) {
  const original = fs.promises.lstat;
  let seen = 0, held = 0;
  const mock = t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    if (path.basename(String(file)) === name) {
      seen += 1;
      if (seen > skip && held < count) {
        held += 1;
        if (never) return new Promise(() => {});
        return new Promise((_, reject) => setTimeout(
          () => reject(Object.assign(new Error('held past the hint read deadline'), { code: 'EBUSY' })), HOLD_MS));
      }
    }
    return original.call(this, file, ...rest);
  });
  return { seen: () => seen, held: () => held, restore: () => mock.mock.restore() };
}

// The descriptor's bytes stay; the file is a new one (a new inode), as a replacement would be.
function replaceDescriptor(dir) {
  const file = path.join(dir, 'reference-source.json');
  fs.renameSync(file, `${file}.old`);
  fs.copyFileSync(`${file}.old`, file);
}

// The host's SSE stream: every data frame, by revision.
async function hostEvents(t, f) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${f.url()}/api/events?token=${f.token}&after=0`, { signal: abort.signal });
  const reader = response.body.getReader();
  const frames = [];
  let buffer = '';
  const waiters = [];
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const id = /^id: (\d+)$/m.exec(frame);
          const data = /^data: (.*)$/m.exec(frame);
          if (id && data) frames.push({ revision: Number(id[1]), payload: JSON.parse(data[1]) });
          for (const waiter of [...waiters]) waiter();
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  return {
    frames,
    async revision(revision) {
      const found = () => frames.find((frame) => frame.revision === revision);
      if (found()) return found().payload;
      let timer;
      try {
        await Promise.race([
          new Promise((resolve) => waiters.push(() => { if (found()) resolve(); })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no SSE frame for revision ${revision}`)), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
      return found().payload;
    },
  };
}

const ready = async (f) => (await f.request('health')).body.capabilities?.preActionHintsReady;

test('#347 C: the hint retry policy is three retries at least five seconds apart', () => {
  assert.equal(hintProof.HINT_INIT_RETRY_LIMIT, RETRY_LIMIT);
  assert.equal(hintProof.HINT_INIT_RETRY_INTERVAL_MS, RETRY_INTERVAL_MS);
});

test('#347 C: an initialization whose read missed its deadline is retried by a later hint publication', async (t) => {
  let clock = 0;
  const f = await hintFixture(t, { serverOptions: { hintInitClock: { now: () => clock } } });
  // The fixture's first relay has finished its own initialization before the read is held.
  assert.equal(await ready(f), true);
  const hold = holdHintStat(t, 'state.json');
  await f.restart();
  assert.equal(await ready(f), false);
  assert.equal(hold.held(), 1, 'the first initialization met the held read');
  hold.restore();
  const first = await f.prepare();
  assert.equal(first.hint?.code, 'HINT_RELAY_UNAVAILABLE');
  clock += RETRY_INTERVAL_MS;
  const retried = await f.request('publish', { publishId: 1, view: first.view, hint: first.hint });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.hintDisposition, undefined, 'the retried initialization verified this publication');
  assert.deepEqual((await f.request('snapshot')).body.hint, first.hint, 'the unavailable notice is shown, not erased');
  assert.equal(await ready(f), true);
  const next = await f.prepare();
  assert.equal(next.hint?.status, 'supported', JSON.stringify({ code: next.hint?.code ?? null, logged: f.logged }));
  const published = await f.request('publish', { publishId: 2, view: next.view, hint: next.hint });
  assert.equal(published.status, 200);
  assert.equal(published.body.hintDisposition, undefined);
  assert.deepEqual((await f.request('snapshot')).body.hint, next.hint);
});

test('#347 C: a proof read that misses its deadline drops only that publication\'s hint, from every answer', async (t) => {
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported', JSON.stringify({ code: prepared.hint?.code ?? null, logged: f.logged }));
  const events = await hostEvents(t, f);
  const hold = holdHintStat(t, 'state.json');
  const dropped = await f.request('publish', { publishId: 1, view: prepared.view, hint: prepared.hint });
  assert.equal(hold.held(), 1, 'the publication\'s proof met the held read');
  hold.restore();
  assert.equal(dropped.status, 200);
  assert.equal(dropped.body.hintDisposition, 'unverifiable');
  // The dropped hint is in no answer: not the publish response, not the host snapshot, not the SSE frame.
  const exposure = prepared.hint.exposureId;
  assert.equal(JSON.stringify(dropped.body).includes(exposure), false);
  const snapshot = (await f.request('snapshot')).body;
  assert.equal(snapshot.hint, null);
  assert.equal(JSON.stringify(snapshot).includes(exposure), false);
  assert.equal((await events.revision(dropped.body.revision)).hint, null);
  assert.equal(JSON.stringify(events.frames).includes(exposure), false);
  // The relay is still ready: the next publication is proved again and its hint goes out.
  assert.equal(await ready(f), true);
  const next = await f.prepare();
  assert.equal(next.hint?.status, 'supported', JSON.stringify({ code: next.hint?.code ?? null, logged: f.logged }));
  const published = await f.request('publish', { publishId: 2, view: next.view, hint: next.hint });
  assert.equal(published.status, 200);
  assert.equal(published.body.hintDisposition, undefined);
  assert.deepEqual((await f.request('snapshot')).body.hint, next.hint);
  assert.deepEqual((await events.revision(published.body.revision)).hint, next.hint);
});

test('#347 C: transient failures of an initialization are retried; the retry proves the next hint', async (t) => {
  for (const [label, hold] of [
    ['state.json read past its deadline', (tt) => holdHintStat(tt, 'state.json')],
    ['second descriptor read past its deadline', (tt) => holdHintStat(tt, 'reference-source.json', { skip: 2 })],
    ['state.json stat refused at once (EBUSY)', (tt) => {
      const original = fs.promises.lstat;
      let held = 0;
      const mock = tt.mock.method(fs.promises, 'lstat', function (file, ...rest) {
        if (path.basename(String(file)) === 'state.json' && held === 0) {
          held += 1;
          return Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'lstat' }));
        }
        return original.call(this, file, ...rest);
      });
      return { held: () => held, restore: () => mock.mock.restore() };
    }],
  ]) {
    await t.test(label, async (tt) => {
      let clock = 0;
      const f = await hintFixture(tt);
      const prepared = await f.prepare();
      assert.equal(prepared.hint?.status, 'supported');
      const context = {};
      const failure = hold(tt);
      assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
      assert.equal(failure.held(), 1);
      failure.restore();
      const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
      clock += RETRY_INTERVAL_MS - 1;
      assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' }, 'not before the interval');
      clock += 1;
      assert.deepEqual(await publish(), { hint: prepared.hint, disposition: null });
      assert.equal(context.ready, true);
    });
  }
});

test('#347 C: a changed source stays off: no later publication initializes again', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  assert.deepEqual(await publish(), { hint: prepared.hint, disposition: null });
  replaceDescriptor(f.dir);
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  const reads = holdHintStat(t, 'reference-source.json', { count: 0 });
  for (let i = 0; i <= RETRY_LIMIT; i += 1) {
    clock += RETRY_INTERVAL_MS;
    assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  }
  assert.equal(reads.seen(), 0, 'nothing was initialized again');
  assert.equal(context.ready, false);
});

test('#347 C: a retry never adopts a source other than the one the relay first read', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  // The first try reads the descriptor whole (two stats: before and after reading it), then misses
  // the deadline on its second read of it.
  const hold = holdHintStat(t, 'reference-source.json', { skip: 2 });
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  assert.equal(hold.held(), 1);
  hold.restore();
  // Same bytes, another file: only the pinned identity tells them apart.
  replaceDescriptor(f.dir);
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  for (let i = 0; i <= RETRY_LIMIT; i += 1) {
    clock += RETRY_INTERVAL_MS;
    assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  }
  assert.equal(context.ready, false);
});

test('#347 C: a descriptor replaced during a proof read turns hints off; a replaced state.json does not', async (t) => {
  // The second stat of one bounded read is the identity check after reading; answering it with
  // another file's identity is a replacement in the middle of the read.
  const swapAfterStat = (tt, name) => {
    const original = fs.promises.lstat;
    let seen = 0, swapped = 0;
    const mock = tt.mock.method(fs.promises, 'lstat', function (file, ...rest) {
      if (path.basename(String(file)) === name && ++seen === 2) {
        swapped += 1;
        const other = name === 'state.json' ? 'reference-source.json' : 'state.json';
        return original.call(this, path.join(path.dirname(String(file)), other), ...rest);
      }
      return original.call(this, file, ...rest);
    });
    return { swapped: () => swapped, restore: () => mock.mock.restore() };
  };
  for (const [name, off] of [['reference-source.json', true], ['state.json', false]]) {
    await t.test(name, async (tt) => {
      let clock = 0;
      const f = await hintFixture(tt);
      const prepared = await f.prepare();
      assert.equal(prepared.hint?.status, 'supported');
      const context = {};
      assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
      const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
      const swap = swapAfterStat(tt, name);
      assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
      assert.equal(swap.swapped(), 1);
      swap.restore();
      clock += RETRY_INTERVAL_MS;
      assert.deepEqual(await publish(), off ? { hint: null, disposition: 'unverifiable' } : { hint: prepared.hint, disposition: null });
      assert.equal(context.ready, !off);
    });
  }
});

test('#347 C: retries stop at their limit, never come sooner than the interval, and a stuck disk bounds each wait', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const stuck = holdHintStat(t, 'state.json', { count: Infinity, never: true });
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  assert.equal(stuck.seen(), 1);
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  clock += RETRY_INTERVAL_MS - 1;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(stuck.seen(), 1, 'no retry before the interval');
  for (let retry = 1; retry <= RETRY_LIMIT; retry += 1) {
    clock += RETRY_INTERVAL_MS;
    const started = performance.now();
    assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < PUBLISH_BUDGET_MS, `retry ${retry} waited ${Math.round(elapsed)} ms`);
    assert.equal(stuck.seen(), 1 + retry, `retry ${retry} read again`);
  }
  for (let i = 0; i < 3; i += 1) {
    clock += 10 * RETRY_INTERVAL_MS;
    assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  }
  assert.equal(stuck.seen(), 1 + RETRY_LIMIT, 'no retry past the limit, so no read at all');
});

test('#347 C: descriptor evidence is not hidden behind a transient failure of the state read', async (t) => {
  for (const order of ['state fails first', 'state fails last']) {
    await t.test(order, async (tt) => {
      let clock = 0;
      const f = await hintFixture(tt);
      const prepared = await f.prepare();
      assert.equal(prepared.hint?.status, 'supported');
      const context = {};
      assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
      const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
      // Another file at the descriptor's path; the pinned one is kept aside to be put back.
      const file = path.join(f.dir, 'reference-source.json');
      fs.renameSync(file, `${file}.old`);
      fs.copyFileSync(`${file}.old`, file);
      const original = fs.promises.lstat;
      let failed = 0;
      const mock = tt.mock.method(fs.promises, 'lstat', function (target, ...rest) {
        if (path.basename(String(target)) === 'state.json') {
          failed += 1;
          const busy = () => Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'lstat' });
          return order === 'state fails first' ? Promise.reject(busy())
            : new Promise((_, reject) => setTimeout(() => reject(busy()), 100));
        }
        return original.call(this, target, ...rest);
      });
      assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
      assert.equal(failed, 1, 'the state read failed');
      mock.mock.restore();
      // The pinned file is back at its path: only what this proof saw can keep hints off.
      fs.renameSync(`${file}.old`, file);
      clock += RETRY_INTERVAL_MS;
      assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
      assert.equal(context.ready, false);
    });
  }
});

test('#347 C: a proof that another one disabled while it waited never returns its hint', async (t) => {
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true }), { ready: true });
  const verify = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view });
  // The first proof is held at its last state read: the third stat of state.json (the probe's read
  // stats it before and after reading).
  const original = fs.promises.lstat;
  let seen = 0, release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  t.mock.method(fs.promises, 'lstat', function (target, ...rest) {
    if (path.basename(String(target)) === 'state.json' && ++seen === 3) {
      entered(performance.now());
      return gate.then(() => original.call(this, target, ...rest));
    }
    return original.call(this, target, ...rest);
  });
  const first = verify();
  const heldAt = await reached;
  replaceDescriptor(f.dir);
  assert.deepEqual(await verify(), { hint: null, disposition: 'unverifiable' }, 'the second proof sees the replacement');
  assert.equal(context.ready, false);
  // Released well inside the held read's 1-second bound, so the first proof finishes its read.
  const waited = performance.now() - heldAt;
  assert.ok(waited < 800, `released ${Math.round(waited)} ms after holding`);
  release();
  assert.deepEqual(await first, { hint: null, disposition: 'unverifiable' });
});

test('#347 C: while a retry runs, health stays false, snapshots carry no hint and a later publication waits; one retry runs', async (t) => {
  let clock = 0;
  const f = await hintFixture(t, { serverOptions: { hintInitClock: { now: () => clock } } });
  assert.equal(await ready(f), true);
  const failFirst = holdHintStat(t, 'state.json');
  await f.restart();
  assert.equal(await ready(f), false);
  failFirst.restore();
  const first = await f.prepare();
  assert.equal(first.hint?.code, 'HINT_RELAY_UNAVAILABLE');
  // Every initialization starts with one realpath of the session directory.
  const realpath = fs.promises.realpath;
  let attempts = 0;
  t.mock.method(fs.promises, 'realpath', function (target, ...rest) {
    attempts += 1;
    return realpath.call(this, target, ...rest);
  });
  const original = fs.promises.lstat;
  let held = false, release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  t.mock.method(fs.promises, 'lstat', function (target, ...rest) {
    if (!held && path.basename(String(target)) === 'state.json') {
      held = true;
      entered(performance.now());
      return gate.then(() => original.call(this, target, ...rest));
    }
    return original.call(this, target, ...rest);
  });
  clock += RETRY_INTERVAL_MS;
  const retrying = f.request('publish', { publishId: 1, view: first.view, hint: first.hint });
  const heldAt = await reached;
  assert.equal(await ready(f), false, 'health answers at once, without waiting for the retry');
  assert.equal((await f.request('snapshot')).body.hint, null);
  const queued = f.request('publish', { publishId: 2, view: first.view, hint: first.hint });
  const waited = performance.now() - heldAt;
  assert.ok(waited < 800, `released ${Math.round(waited)} ms after holding`);
  release();
  const [retried, after] = await Promise.all([retrying, queued]);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.hintDisposition, undefined);
  assert.equal(after.status, 200);
  assert.equal(after.body.hintDisposition, undefined);
  assert.equal(attempts, 1, 'one retry');
  assert.equal(await ready(f), true);
});

test('#347 C: a slow retry and its proof still finish inside the publisher\'s budget', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  const failFirst = holdHintStat(t, 'state.json');
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  failFirst.restore();
  // Every hint read step is slow but inside its own bound: a stat (two per read) or the realpath.
  const SLOW_MS = 200;
  const lstat = fs.promises.lstat, realpath = fs.promises.realpath;
  let slowed = 0;
  const slow = (fn) => function (target, ...rest) {
    if (['state.json', 'reference-source.json'].includes(path.basename(String(target))) || path.resolve(String(target)) === path.resolve(f.dir)) {
      slowed += 1;
      return new Promise((resolve) => setTimeout(resolve, SLOW_MS)).then(() => fn.call(this, target, ...rest));
    }
    return fn.call(this, target, ...rest);
  };
  t.mock.method(fs.promises, 'lstat', slow(lstat));
  t.mock.method(fs.promises, 'realpath', slow(realpath));
  clock += RETRY_INTERVAL_MS;
  const started = performance.now();
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
    { hint: prepared.hint, disposition: null });
  const elapsed = performance.now() - started;
  assert.ok(slowed >= 11, `every step was slowed: ${slowed}`);
  assert.ok(elapsed < PUBLISH_BUDGET_MS, `waited ${Math.round(elapsed)} ms`);
});

test('#347 C: a retry that resolves the session path to another directory stays off', async (t) => {
  if (process.platform === 'win32') { t.skip('directory symlinks need a privilege on Windows; realpath is the same on every platform'); return; }
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const links = fs.mkdtempSync(path.join(path.dirname(f.dir), 'hint-links-'));
  t.after(() => fs.rmSync(links, { recursive: true, force: true }));
  const copy = path.join(links, 'copy');
  fs.cpSync(f.dir, copy, { recursive: true });
  const session = path.join(links, 'session');
  fs.symlinkSync(f.dir, session, 'dir');
  const context = {};
  // The first try pins the descriptor read through the link, then misses its second read of it.
  const hold = holdHintStat(t, 'reference-source.json', { skip: 2 });
  assert.deepEqual(await verifyHintPublication({ sessionDir: session, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  assert.equal(hold.held(), 1);
  hold.restore();
  // The same path now resolves to a copy: the same bytes, other files.
  const next = path.join(links, 'next');
  fs.symlinkSync(copy, next, 'dir');
  fs.renameSync(next, session);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await verifyHintPublication({ sessionDir: session, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
    { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

// ABA at the relay's capture (as in test/hint-publish.test.js): the descriptor is swapped for another
// source as the capture opens it, and the original inode is put back right after.
async function abaDescriptorAtCapture(file, run) {
  const { LEGACY_REFERENCE_SOURCE } = await import('../shared/reference.js');
  const held = `${file}.original-inode`;
  const original = fs.readFileSync(file), open = fs.promises.open;
  let swapped = false, restored = false;
  fs.promises.open = async function (name, ...args) {
    const target = path.basename(String(name)) === 'reference-source.json' && !swapped;
    if (target) { fs.renameSync(file, held); fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, source: LEGACY_REFERENCE_SOURCE })); swapped = true; }
    const handle = await open.call(this, name, ...args);
    if (target) { fs.renameSync(held, file); restored = true; }
    return handle;
  };
  try { await run(); assert.equal(swapped, true, 'the swap must occur at the capture'); }
  finally {
    fs.promises.open = open;
    if (!restored && fs.existsSync(held)) { fs.renameSync(held, file); restored = true; }
  }
  assert.deepEqual(fs.readFileSync(file), original);
}

test('#347 C: a replacement detected during initialization stays off after the original file is back', async (t) => {
  if (process.platform === 'win32') { t.skip('renaming over a file another handle has open differs on Windows before libuv 1.49'); return; }
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  await abaDescriptorAtCapture(path.join(f.dir, 'reference-source.json'), async () => {
    assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  });
  for (let i = 0; i <= RETRY_LIMIT; i += 1) {
    clock += RETRY_INTERVAL_MS;
    assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
      { hint: null, disposition: 'unverifiable' });
  }
  assert.equal(context.ready, false);
});

test('#347 C: a replacement a proof read detects stays detected when the read outlives its deadline', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  // The descriptor read finds another file after reading it (its second stat answers with
  // state.json's identity), and its close then takes longer than the read's whole bound.
  const open = fs.promises.open, lstat = fs.promises.lstat;
  let descriptorStats = 0, slowCloses = 0;
  const openMock = t.mock.method(fs.promises, 'open', async function (file, ...rest) {
    const handle = await open.call(this, file, ...rest);
    if (path.basename(String(file)) !== 'reference-source.json') return handle;
    const close = handle.close.bind(handle);
    handle.close = () => { slowCloses += 1; return new Promise((resolve) => setTimeout(resolve, HOLD_MS)).then(close); };
    return handle;
  });
  const lstatMock = t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    if (path.basename(String(file)) === 'reference-source.json' && ++descriptorStats === 2) {
      return lstat.call(this, path.join(path.dirname(String(file)), 'state.json'), ...rest);
    }
    return lstat.call(this, file, ...rest);
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(slowCloses, 1);
  assert.equal(context.ready, false, 'off as soon as the replacement was seen');
  openMock.mock.restore();
  lstatMock.mock.restore();
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
});

test('#347 C: a descriptor path that turned into a symlink while it was read stays off after the file is back', async (t) => {
  if (process.platform === 'win32') { t.skip('O_NOFOLLOW does not exist on Windows (a replacement there is caught by the identity check)'); return; }
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  const file = path.join(f.dir, 'reference-source.json'), held = `${file}.held`;
  const lstat = fs.promises.lstat;
  let swapped = false;
  const mock = t.mock.method(fs.promises, 'lstat', async function (target, ...rest) {
    const result = await lstat.call(this, target, ...rest);
    if (!swapped && path.basename(String(target)) === 'reference-source.json') {
      // Between the read's first stat and its open: the path is now a link to the same file.
      swapped = true;
      fs.renameSync(file, held);
      fs.symlinkSync(held, file);
    }
    return result;
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(swapped, true);
  mock.mock.restore();
  fs.unlinkSync(file);
  fs.renameSync(held, file);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: a training detail file missing for a while is retried; a detail of another source is a verdict', async (t) => {
  const { V2_REFERENCE_SOURCE, V3_REFERENCE_SOURCE } = await import('../shared/reference.js');
  for (const [label, written, recovers] of [['missing, then written', V3_REFERENCE_SOURCE, true], ['of another source', V2_REFERENCE_SOURCE, false]]) {
    await t.test(label, async (tt) => {
      let clock = 0;
      const f = await hintFixture(tt);
      const prepared = await f.prepare();
      assert.equal(prepared.hint?.status, 'supported');
      // An authority entry of this session's source that names a detail record.
      const training = path.join(f.dir, 'training'), ref = 'a'.repeat(64);
      fs.mkdirSync(path.join(training, 'details'), { recursive: true });
      fs.writeFileSync(path.join(training, '.training-authority.json'), JSON.stringify({ items: { one: { summary: { source: V3_REFERENCE_SOURCE }, detailRef: ref } } }));
      const detail = path.join(training, 'details', `${ref}.json`);
      if (!recovers) fs.writeFileSync(detail, JSON.stringify({ source: written }));
      const context = {};
      assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
      if (recovers) fs.writeFileSync(detail, JSON.stringify({ source: written }));
      clock += RETRY_INTERVAL_MS;
      assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
        recovers ? { hint: prepared.hint, disposition: null } : { hint: null, disposition: 'unverifiable' });
      assert.equal(context.ready, recovers);
    });
  }
});

// Wraps every handle opened on the descriptor so that its close is slow (`delay`) or fails (`reject`).
function descriptorCloses(t, { delay = 0, reject = false } = {}) {
  const open = fs.promises.open;
  let closes = 0;
  const mock = t.mock.method(fs.promises, 'open', async function (file, ...rest) {
    const handle = await open.call(this, file, ...rest);
    if (path.basename(String(file)) !== 'reference-source.json') return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      closes += 1;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await close();
      if (reject) throw Object.assign(new Error('close failed'), { code: 'EIO' });
    };
    return handle;
  });
  return { closes: () => closes, restore: () => mock.mock.restore() };
}

test('#347 C: a whole read of another descriptor counts even when its close outlives the deadline', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  // Another file at the path, consistent for the whole read; the pinned one kept aside.
  const file = path.join(f.dir, 'reference-source.json');
  fs.renameSync(file, `${file}.old`);
  fs.copyFileSync(`${file}.old`, file);
  const slow = descriptorCloses(t, { delay: HOLD_MS });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(slow.closes(), 1);
  assert.equal(context.ready, false, 'off once the other file was read');
  slow.restore();
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  fs.renameSync(`${file}.old`, file);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
});

test('#347 C: the first whole descriptor read pins the source even when its close outlives the deadline', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  const slow = descriptorCloses(t, { delay: HOLD_MS });
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  assert.equal(slow.closes(), 1, 'the first descriptor read ended at its deadline, in its close');
  slow.restore();
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  // Same bytes, another file: a retry that had not pinned the first read would adopt it.
  replaceDescriptor(f.dir);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
    { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: a replacement a read sees only after its deadline still turns hints off', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  // The descriptor read's stat after reading answers late, with another file's identity.
  const lstat = fs.promises.lstat;
  let seen = 0, late = false;
  const mock = t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    if (path.basename(String(file)) === 'reference-source.json' && ++seen === 2) {
      return new Promise((resolve) => setTimeout(resolve, HOLD_MS)).then(() => { late = true; return lstat.call(this, path.join(path.dirname(String(file)), 'state.json'), ...rest); });
    }
    return lstat.call(this, file, ...rest);
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(late, false, 'the publication ended at the deadline, before the late answer');
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  assert.equal(late, true);
  assert.equal(context.ready, false, 'off when the late answer came');
  mock.mock.restore();
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
});

test('#347 C: a replacement detected before a failing close is not lost to the close error', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  const failing = descriptorCloses(t, { reject: true });
  const lstat = fs.promises.lstat;
  let seen = 0;
  const mock = t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    if (path.basename(String(file)) === 'reference-source.json' && ++seen === 2) return lstat.call(this, path.join(path.dirname(String(file)), 'state.json'), ...rest);
    return lstat.call(this, file, ...rest);
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(failing.closes(), 1);
  failing.restore();
  mock.mock.restore();
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: a descriptor that vanishes during a proof read is a change; one missing before the first read is not', async (t) => {
  const file = (f) => path.join(f.dir, 'reference-source.json');
  // Moves the descriptor away at the given stat of it (`at`: before the call, or right after it).
  const vanishAt = (tt, f, nth, after) => {
    const lstat = fs.promises.lstat;
    let seen = 0;
    return tt.mock.method(fs.promises, 'lstat', async function (target, ...rest) {
      const mine = path.basename(String(target)) === 'reference-source.json' && ++seen === nth;
      if (mine && !after) fs.renameSync(file(f), `${file(f)}.away`);
      const result = await lstat.call(this, target, ...rest);
      if (mine && after) fs.renameSync(file(f), `${file(f)}.away`);
      return result;
    });
  };
  for (const [label, nth, after] of [['at open', 1, true], ['at the stat after reading', 2, false], ['at the first stat, once pinned', 1, false]]) {
    await t.test(label, async (tt) => {
      let clock = 0;
      const f = await hintFixture(tt);
      const prepared = await f.prepare();
      assert.equal(prepared.hint?.status, 'supported');
      const context = {};
      assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
      const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
      const mock = vanishAt(tt, f, nth, after);
      assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
      mock.mock.restore();
      fs.renameSync(`${file(f)}.away`, file(f));
      clock += RETRY_INTERVAL_MS;
      assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' }, 'the pinned file back changes nothing');
      assert.equal(context.ready, false);
    });
  }
  await t.test('missing before the first read: retried', async (tt) => {
    let clock = 0;
    const f = await hintFixture(tt);
    const prepared = await f.prepare();
    assert.equal(prepared.hint?.status, 'supported');
    const context = {};
    fs.renameSync(file(f), `${file(f)}.away`);
    assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
    fs.renameSync(`${file(f)}.away`, file(f));
    clock += RETRY_INTERVAL_MS;
    assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
      { hint: prepared.hint, disposition: null });
  });
});

test('#347 C: a malformed hint is still refused with 400 by a relay whose hints are off or not ready', async (t) => {
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const malformed = { ...prepared.hint, actions: 'not a list' };
  // Not ready: the first initialization missed its deadline.
  assert.equal(await ready(f), true);
  const hold = holdHintStat(t, 'state.json');
  await f.restart();
  assert.equal(await ready(f), false);
  hold.restore();
  const refused = await f.request('publish', { publishId: 1, view: prepared.view, hint: malformed });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'HINT_PROOF_MISMATCH');
  // Off: the descriptor was replaced.
  await f.restart();
  assert.equal(await ready(f), true);
  replaceDescriptor(f.dir);
  const dropped = await f.request('publish', { publishId: 1, view: prepared.view, hint: prepared.hint });
  assert.equal(dropped.body.hintDisposition, 'unverifiable');
  const again = await f.request('publish', { publishId: 2, view: prepared.view, hint: malformed });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, 'HINT_PROOF_MISMATCH');
});

test('#347 C: the first descriptor content the relay reads binds later tries even when that read ended late', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  // The first try's descriptor read gets its bytes only after its deadline (the read itself is slow).
  const open = fs.promises.open;
  let delayed = 0, late = false;
  const mock = t.mock.method(fs.promises, 'open', async function (name, ...rest) {
    const handle = await open.call(this, name, ...rest);
    if (path.basename(String(name)) !== 'reference-source.json' || delayed > 0) return handle;
    delayed += 1;
    // Only the first read call is slow; the read loop's later calls answer at once.
    const read = handle.read.bind(handle);
    let first = true;
    handle.read = (...args) => {
      if (!first) return read(...args);
      first = false;
      return new Promise((resolve) => setTimeout(resolve, HOLD_MS)).then(() => { late = true; return read(...args); });
    };
    return handle;
  });
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  assert.equal(late, false, 'the try ended at its deadline, before its bytes came');
  // The abandoned read finishes on its own: wait until it has handed over its content.
  for (const until = performance.now() + 10 * HOLD_MS; context.pinnedRaw === undefined && performance.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(late, true);
  assert.notEqual(context.pinnedRaw, undefined, 'the late read pinned its content');
  await new Promise((resolve) => setTimeout(resolve, 50));
  mock.mock.restore();
  // The same file, the same length, one byte different: only the late content tells.
  const file = path.join(f.dir, 'reference-source.json');
  const other = fs.readFileSync(file);
  const at = other.indexOf(Buffer.from('"schemaVersion"'));
  other[at + 1] = other[at + 1] === 0x73 ? 0x53 : 0x73;
  fs.writeFileSync(file, other);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
    { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: an identity seen of another descriptor counts even when the read then fails', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  const file = path.join(f.dir, 'reference-source.json');
  fs.renameSync(file, `${file}.old`);
  fs.copyFileSync(`${file}.old`, file);
  // The read's first stat sees the other file; its open then fails for a passing reason.
  const open = fs.promises.open;
  let refused = 0;
  const mock = t.mock.method(fs.promises, 'open', function (name, ...rest) {
    if (path.basename(String(name)) === 'reference-source.json') { refused += 1; return Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM', syscall: 'open' })); }
    return open.call(this, name, ...rest);
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(refused, 1);
  mock.mock.restore();
  fs.renameSync(`${file}.old`, file);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: a late anomaly that lands while a retry runs keeps that retry from turning hints on', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  // The first try's first stat of the descriptor answers after its deadline, and what it answers is
  // not a regular file (the session directory's own stat). The retry's second capture is held until
  // that answer has come.
  const lstat = fs.promises.lstat;
  let seen = 0, retrySeen = 0, retrying = false, lateAnswer;
  const answered = new Promise((resolve) => { lateAnswer = resolve; });
  t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    if (path.basename(String(file)) === 'reference-source.json') {
      seen += 1;
      if (seen === 1) {
        return new Promise((resolve) => setTimeout(resolve, HOLD_MS))
          .then(() => lstat.call(this, path.dirname(String(file)), ...rest))
          .finally(() => setTimeout(lateAnswer, 10));
      }
      // The retry's stats of the descriptor: its first capture (two), then its second capture's first.
      if (retrying && ++retrySeen === 3) return answered.then(() => lstat.call(this, file, ...rest));
    }
    return lstat.call(this, file, ...rest);
  });
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  clock += RETRY_INTERVAL_MS;
  retrying = true;
  const started = performance.now();
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
    { hint: null, disposition: 'unverifiable' });
  assert.ok(retrySeen >= 3, `the retry reached its second capture: ${retrySeen}`);
  assert.ok(performance.now() - started < 1000, 'the held capture finished inside its bound');
  assert.equal(context.ready, false);
});

test('#347 C: a forged hint keeps its verdict: unverifiable before the relay is ready, mismatch after a late turn-off', async (t) => {
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  // Well-formed (it passes the hint contract) but not the exposure the engine recorded.
  const forged = { ...prepared.hint, exposureId: `${prepared.hint.exposureId[0] === 'f' ? 'e' : 'f'}${prepared.hint.exposureId.slice(1)}` };
  // Not ready: the existing contract — the hint is dropped, the publication stands.
  assert.equal(await ready(f), true);
  const hold = holdHintStat(t, 'state.json');
  await f.restart();
  assert.equal(await ready(f), false);
  hold.restore();
  const early = await f.request('publish', { publishId: 1, view: prepared.view, hint: forged });
  assert.equal(early.status, 200);
  assert.equal(early.body.hintDisposition, 'unverifiable');
  // Ready, and another read's late anomaly turns hints off while this proof waits for its reads:
  // the forgery is still judged a mismatch.
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true }), { ready: true });
  const lstat = fs.promises.lstat;
  let seen = 0, lateAnswer, stateSeen = 0;
  const answered = new Promise((resolve) => { lateAnswer = resolve; });
  t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    const name = path.basename(String(file));
    if (name === 'reference-source.json' && ++seen === 1) {
      return new Promise((resolve) => setTimeout(resolve, HOLD_MS))
        .then(() => lstat.call(this, path.dirname(String(file)), ...rest))
        .finally(() => setTimeout(lateAnswer, 10));
    }
    if (name === 'state.json' && seen >= 1 && ++stateSeen === 3) return answered.then(() => lstat.call(this, file, ...rest));
    return lstat.call(this, file, ...rest);
  });
  // The first proof's descriptor read is abandoned at its deadline; its late answer turns hints off.
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view }),
    { hint: null, disposition: 'unverifiable' });
  const judged = await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: forged, view: prepared.view });
  assert.equal(context.ready, false, 'turned off while the forged proof waited');
  assert.deepEqual(judged, { hint: null, disposition: 'mismatch' });
});

test('#347 C: the identity pin alone: an identity seen by a read that never got the content binds later tries', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  // The first try's descriptor read sees the file (its first stat) and then cannot open it.
  const open = fs.promises.open;
  let refused = 0;
  const mock = t.mock.method(fs.promises, 'open', function (name, ...rest) {
    if (path.basename(String(name)) === 'reference-source.json') { refused += 1; return Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM', syscall: 'open' })); }
    return open.call(this, name, ...rest);
  });
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  assert.equal(refused, 1);
  mock.mock.restore();
  // Same bytes, another file: only the identity seen above tells them apart.
  replaceDescriptor(f.dir);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
    { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: the content pin alone: another valid descriptor written into the same file is a change', async (t) => {
  const { V2_REFERENCE_SOURCE } = await import('../shared/reference.js');
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  // The first try reads the descriptor whole, then misses the deadline on its second read of it.
  const hold = holdHintStat(t, 'reference-source.json', { skip: 2 });
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  assert.equal(hold.held(), 1);
  hold.restore();
  // Same file (dev and ino), another valid coverage source: only the content pin tells.
  const file = path.join(f.dir, 'reference-source.json');
  const identity = fs.lstatSync(file, { bigint: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, source: V2_REFERENCE_SOURCE }));
  const after = fs.lstatSync(file, { bigint: true });
  assert.equal(after.ino, identity.ino);
  assert.equal(after.dev, identity.dev);
  assert.equal(after.size, identity.size, 'the same length, so the identity pin (dev, ino, size) cannot tell');
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true }),
    { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: every proof sharing a read that saw another descriptor gets no hint', async (t) => {
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true }), { ready: true });
  replaceDescriptor(f.dir);
  const reads = holdHintStat(t, 'reference-source.json', { count: 0 });
  const verify = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view });
  const both = await Promise.all([verify(), verify()]);
  assert.deepEqual(both, [{ hint: null, disposition: 'unverifiable' }, { hint: null, disposition: 'unverifiable' }]);
  assert.equal(reads.seen(), 2, 'one shared read (its two stats)');
  assert.equal(context.ready, false);
});

test('#347 C: content changed in place and put back stays off', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  const file = path.join(f.dir, 'reference-source.json');
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify(JSON.parse(original.toString('utf8')), null, 1));
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  fs.writeFileSync(file, original);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: a first descriptor stat that answers ENOENT only after a retry pinned the file turns hints off', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  // The first try's first descriptor stat is held past its deadline and answered later, by hand.
  const lstat = fs.promises.lstat;
  let seen = 0, answer;
  const held = new Promise((_, reject) => { answer = reject; });
  held.catch(() => {});
  const mock = t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    if (path.basename(String(file)) === 'reference-source.json' && ++seen === 1) return held;
    return lstat.call(this, file, ...rest);
  });
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  clock += RETRY_INTERVAL_MS;
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  assert.deepEqual(await publish(), { hint: prepared.hint, disposition: null }, 'the retry pinned the file and proved the hint');
  assert.equal(context.ready, true);
  // Now the abandoned stat answers: the file it was asked about was gone.
  answer(Object.assign(new Error('gone'), { code: 'ENOENT', syscall: 'lstat' }));
  await new Promise((resolve) => setImmediate(resolve));
  mock.mock.restore();
  assert.equal(context.ready, false, 'a pinned descriptor seen missing, late, is a change');
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
});

test('#347 C: a descriptor read shorter than its stat is a change even when the stat after it fails', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  // The handle reads one byte less than the file's size (it was truncated meanwhile), and the stat
  // after reading then fails for a passing reason.
  const open = fs.promises.open, lstat = fs.promises.lstat;
  let shortened = 0, seen = 0;
  const openMock = t.mock.method(fs.promises, 'open', async function (name, ...rest) {
    const handle = await open.call(this, name, ...rest);
    if (path.basename(String(name)) !== 'reference-source.json') return handle;
    const read = handle.read.bind(handle);
    let first = true;
    handle.read = async (buffer, offset, length, position) => {
      if (!first) return { bytesRead: 0, buffer };
      first = false;
      const size = (await handle.stat()).size;
      shortened += 1;
      return read(buffer, offset, Math.min(length, size - 1), position);
    };
    return handle;
  });
  const lstatMock = t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    if (path.basename(String(file)) === 'reference-source.json' && ++seen === 2) return Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'lstat' }));
    return lstat.call(this, file, ...rest);
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(shortened, 1);
  openMock.mock.restore();
  lstatMock.mock.restore();
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: the retry interval counts from the end of the previous try', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  // The first try fails on its state read, which takes a whole interval on the injected clock.
  const lstat = fs.promises.lstat;
  let failed = 0;
  const mock = t.mock.method(fs.promises, 'lstat', function (file, ...rest) {
    if (path.basename(String(file)) === 'state.json' && failed === 0) {
      failed += 1;
      clock += RETRY_INTERVAL_MS;
      return Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'lstat' }));
    }
    return lstat.call(this, file, ...rest);
  });
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: false });
  mock.mock.restore();
  const realpath = fs.promises.realpath;
  let attempts = 0;
  t.mock.method(fs.promises, 'realpath', function (target, ...rest) { attempts += 1; return realpath.call(this, target, ...rest); });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(attempts, 0, 'a whole interval after the try began, but none after it ended');
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: prepared.hint, disposition: null });
  assert.equal(attempts, 1);
});

test('#347 C: a descriptor whose size changes between its first stat and the open read is a change', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  // The first stat sees the file truncated; its bytes are back (same file) before the open.
  const file = path.join(f.dir, 'reference-source.json');
  const original = fs.readFileSync(file);
  const lstat = fs.promises.lstat;
  let seen = 0;
  const mock = t.mock.method(fs.promises, 'lstat', async function (target, ...rest) {
    if (path.basename(String(target)) !== 'reference-source.json' || ++seen !== 1) return lstat.call(this, target, ...rest);
    fs.writeFileSync(file, original.subarray(0, original.length - 1));
    try { return await lstat.call(this, target, ...rest); }
    finally { fs.writeFileSync(file, original); }
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  mock.mock.restore();
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: other content read whole is a change even when the stat after reading fails', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  // Same file, same length, one byte different; the stat after reading it fails for a passing reason.
  const file = path.join(f.dir, 'reference-source.json');
  const original = fs.readFileSync(file);
  const other = Buffer.from(original);
  const at = other.indexOf(Buffer.from('"schemaVersion"'));
  other[at + 1] = other[at + 1] === 0x73 ? 0x53 : 0x73;
  fs.writeFileSync(file, other);
  const lstat = fs.promises.lstat;
  let seen = 0;
  const mock = t.mock.method(fs.promises, 'lstat', function (target, ...rest) {
    if (path.basename(String(target)) === 'reference-source.json' && ++seen === 2) return Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'lstat' }));
    return lstat.call(this, target, ...rest);
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(seen, 2, 'the stat after reading failed');
  mock.mock.restore();
  fs.writeFileSync(file, original);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});

test('#347 C: a size seen at the first stat counts even when the open then fails', async (t) => {
  let clock = 0;
  const f = await hintFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.hint?.status, 'supported');
  const context = {};
  assert.deepEqual(await verifyHintPublication({ sessionDir: f.dir, token: f.token, context, initialize: true, now: () => clock }), { ready: true });
  const publish = () => verifyHintPublication({ sessionDir: f.dir, token: f.token, context, hint: prepared.hint, view: prepared.view, retry: true });
  // The same file shortened by a byte; the read sees that at its first stat and then cannot open it.
  const file = path.join(f.dir, 'reference-source.json');
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, original.subarray(0, original.length - 1));
  const open = fs.promises.open;
  let refused = 0;
  const mock = t.mock.method(fs.promises, 'open', function (name, ...rest) {
    if (path.basename(String(name)) === 'reference-source.json') { refused += 1; return Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'open' })); }
    return open.call(this, name, ...rest);
  });
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(refused, 1);
  mock.mock.restore();
  fs.writeFileSync(file, original);
  clock += RETRY_INTERVAL_MS;
  assert.deepEqual(await publish(), { hint: null, disposition: 'unverifiable' });
  assert.equal(context.ready, false);
});
