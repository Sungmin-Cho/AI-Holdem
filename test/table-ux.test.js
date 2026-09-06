import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

test('REQ-007: pot preset includes the call in pot size', async () => {
  const module = new URL('../server/public/table-controls.js', import.meta.url);
  let potRaiseTo;
  if (existsSync(module)) ({ potRaiseTo } = await import(module));
  else {
    const { runInNewContext } = await import('node:vm');
    const src = readFileSync(new URL('../server/public/app.js', import.meta.url), 'utf8');
    potRaiseTo = runInNewContext(`${src.slice(src.indexOf('function clampRaiseTo('), src.indexOf('function myBetOf('))}; potRaiseTo`);
  }
  assert.equal(potRaiseTo({ potTotal: 150, callAmount: 50, minRaiseTo: 100, maxRaiseTo: 1000 }, 0, 1), 250, 'pot-sized raise must include the call in its base');
});

import { clampRaiseTo, potRaiseTo, bbRaiseTo, studyLink } from '../server/public/table-controls.js';
import * as tableControls from '../server/public/table-controls.js';
import { createActionController } from '../server/public/action-controller.js';
import './helpers/owned-fixtures.mjs';

const legal = { decisionId: 'd-1-preflop-1', potTotal: 150, callAmount: 50, minRaiseTo: 100, maxRaiseTo: 1000, canRaise: true };
test('half pot includes call and prior street contribution', () => {
  assert.equal(potRaiseTo(legal, 0, 0.5), 150);
  assert.equal(potRaiseTo(legal, 25, 1), 275);
});
test('short all-in returns only reachable maximum', () => {
  const short = { ...legal, minRaiseTo: 400, maxRaiseTo: 175 };
  assert.equal(clampRaiseTo(400, short), 175);
  assert.equal(potRaiseTo(short, 0, 1), 175);
  assert.equal(clampRaiseTo('bad', short), 175);
});
test('typed raise-to clamps invalid, below minimum, above maximum and fractions', () => {
  assert.equal(clampRaiseTo('bad', legal), 100);
  assert.equal(clampRaiseTo(-1, legal), 100);
  assert.equal(clampRaiseTo(1001, legal), 1000);
  assert.equal(clampRaiseTo(124.7, legal), 125);
});
test('reference BB presets appear only at exact legal sizes', () => {
  assert.equal(bbRaiseTo(legal, 100, 2.5), 250);
  assert.equal(bbRaiseTo(legal, 100, 8.5), 850);
  assert.equal(bbRaiseTo({ ...legal, minRaiseTo: 900 }, 100, 8.5), null);
  assert.equal(bbRaiseTo({ ...legal, canRaise: false }, 100, 2.5), null);
});
test('study navigation accepts only loopback capability fragments', () => {
  const url = `http://127.0.0.1:1234/#token=${'a'.repeat(64)}`;
  assert.equal(studyLink(url, { mode: 'free', handClass: 'AJo' }), `http://127.0.0.1:1234/?mode=free&handClass=AJo#token=${'a'.repeat(64)}`);
  for (const value of ['javascript:alert(1)', url.replace('127.0.0.1', 'evil.test'), url.replace('#token', '?token'), `${url}&control=x`, url.replace('/#', '/private#')]) assert.equal(studyLink(value), null);
});
test('review publications preserve explicit dismissal until the user reopens', () => {
  assert.equal(typeof tableControls.reviewDismissalAfterUpdate, 'function');
  assert.equal(tableControls.reviewDismissalAfterUpdate(false, undefined, 'first review'), false);
  assert.equal(tableControls.reviewDismissalAfterUpdate(true, undefined, 'replayed review'), true);
  assert.equal(tableControls.reviewDismissalAfterUpdate(true, 'same review', 'same review'), true);
  assert.equal(tableControls.reviewDismissalAfterUpdate(true, 'old review', 'updated review'), true);
  assert.equal(tableControls.reviewDismissalAfterUpdate(true, 'review', undefined), true);
});

function fixture(options = {}) {
  const values = options.values ?? new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  let snapshot = { gameEpoch: 'game-a', view: { legal, gameOver: false } };
  // Match the production action-status contract. Explicit null cases below retain
  // compatibility coverage for a response from an older relay.
  let status = { ok: true, decisionId: legal.decisionId, requestId: null, phase: 'unreceived' };
  const sent = [];
  let serial = 0;
  const controller = createActionController({
    gameEpoch: 'game-a', storage, uuid: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
    timeoutMs: 15,
    postAction: async (body) => { sent.push(body); return options.post ? options.post(body) : { ok: true }; },
    getSnapshot: async () => snapshot,
    getStatus: async () => { if (status instanceof Error) throw status; return status; },
  });
  return { controller, values, sent, snapshot, setSnapshot: (value) => { snapshot = value; }, setStatus: (value) => { status = value; } };
}

test('accepted input blocks duplicates and same-decision view-only refresh', async () => {
  const f = fixture(); await f.controller.connect(f.snapshot);
  const result = await f.controller.send('call');
  assert.equal(result.phase, 'accepted');
  await f.controller.send('fold');
  f.controller.observe(f.snapshot.view);
  assert.equal(f.controller.state.disabled, true);
  assert.equal(f.sent.length, 1);
});
test('lost HTTP response reconciles delivered receipt without retransmission', async () => {
  const f = fixture({ post: () => { throw new Error('response lost'); } }); await f.controller.connect(f.snapshot);
  f.setStatus({ ok: true, decisionId: legal.decisionId, requestId: '00000000-0000-4000-8000-000000000001', phase: 'delivered' });
  await f.controller.send('call');
  assert.equal(f.controller.state.phase, 'delivered');
  assert.equal(f.controller.state.disabled, true);
  assert.equal(f.sent.length, 1);
});
test('timeout reconciles accepted state without waiting indefinitely', async () => {
  const f = fixture({ post: () => new Promise(() => {}) }); await f.controller.connect(f.snapshot);
  f.setStatus({ ok: true, decisionId: legal.decisionId, requestId: '00000000-0000-4000-8000-000000000001', phase: 'accepted' });
  await f.controller.send('call');
  assert.equal(f.controller.state.phase, 'accepted');
  assert.equal(f.sent.length, 1);
});
test('refresh keeps request identity and secrets out of session storage', async () => {
  const f = fixture(); await f.controller.connect(f.snapshot); await f.controller.send('call');
  const requestId = f.sent[0].requestId;
  const restored = fixture({ values: f.values });
  restored.setStatus({ ok: true, decisionId: legal.decisionId, requestId, phase: 'accepted' });
  await restored.controller.connect(restored.snapshot);
  assert.equal(restored.controller.state.requestId, requestId);
  assert.equal(restored.controller.state.disabled, true);
  assert.equal(restored.sent.length, 0);
  assert.doesNotMatch([...f.values.values()].join(''), /token|credential/);
});
test('engine rejection permits a corrected request with a new identity', async () => {
  const f = fixture(); await f.controller.connect(f.snapshot); await f.controller.send('raise', 900);
  f.setStatus({ ok: true, decisionId: legal.decisionId, requestId: f.sent[0].requestId, phase: 'rejected' });
  await f.controller.reconcile();
  assert.equal(f.controller.state.disabled, false);
  await f.controller.send('call');
  assert.notEqual(f.sent[1].requestId, f.sent[0].requestId);
});
test('unreceived status keeps correction locked while allowing exact retry with original identity', async () => {
  const f = fixture({ post: () => { throw new Error('offline'); } }); await f.controller.connect(f.snapshot);
  await f.controller.send('call');
  assert.equal(f.controller.state.disabled, true);
  await f.controller.send('call');
  assert.equal(f.sent[1].requestId, f.sent[0].requestId);
});
test('unavailable or mismatched receipt evidence never enables controls', async () => {
  const f = fixture({ post: () => { throw new Error('offline'); } }); await f.controller.connect(f.snapshot);
  f.setStatus(new Error('relay unavailable'));
  await f.controller.send('call');
  assert.equal(f.controller.state.phase, 'unknown');
  assert.equal(f.controller.state.disabled, true);
  f.setStatus({ ok: true, decisionId: 'd-2-preflop-1', phase: null, requestId: null });
  await f.controller.reconcile();
  assert.equal(f.controller.state.disabled, true);
});
test('new authoritative decision clears prior waiting after reconciliation', async () => {
  const f = fixture(); await f.controller.connect(f.snapshot); await f.controller.send('call');
  const nextLegal = { ...legal, decisionId: 'd-2-preflop-1' };
  f.setSnapshot({ gameEpoch: 'game-a', view: { legal: nextLegal } });
  f.setStatus({ ok: true, decisionId: nextLegal.decisionId, requestId: null, phase: null });
  await f.controller.reconcile();
  assert.equal(f.controller.state.disabled, false);
  await f.controller.send('fold');
  assert.equal(f.sent[1].decisionId, nextLegal.decisionId);
  assert.notEqual(f.sent[1].requestId, f.sent[0].requestId);
});
test('a consumed receipt on the same decision remains disabled', async () => {
  const f = fixture(); f.setStatus({ ok: true, decisionId: legal.decisionId, requestId: 'prior', phase: 'consumed' });
  await f.controller.connect(f.snapshot);
  assert.equal(f.controller.state.disabled, true);
});
test('storage failure prevents sending an unresumable action', async () => {
  let sent = false;
  const c = createActionController({ gameEpoch: 'a', storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } }, uuid: () => 'id', postAction: async () => { sent = true; }, getSnapshot: async () => ({ gameEpoch: 'a', view: { legal } }), getStatus: async () => ({ ok: true, decisionId: legal.decisionId, requestId: null, phase: null }) });
  await c.connect({ gameEpoch: 'a', view: { legal } }); await c.send('call');
  assert.equal(sent, false); assert.equal(c.state.disabled, true);
});

test('reconciliation does not roll back a newer authenticated SSE revision', async () => {
  let release;
  const firstSnapshot = { revision: 1, view: { legal } };
  let later = false;
  const f = createActionController({ gameEpoch: 'game-a', storage: { getItem: () => null, setItem() {} },
    getSnapshot: async () => later ? new Promise((resolve) => { release = resolve; }) : firstSnapshot,
    getStatus: async () => ({ ok: true, decisionId: legal.decisionId, requestId: null, phase: null }),
    postAction: async () => ({ ok: true }) });
  await f.connect(firstSnapshot); later = true;
  const reconcile = f.reconcile();
  await new Promise((resolve) => setImmediate(resolve));
  f.observe({ legal: { ...legal, decisionId: 'd-2-preflop-1' } }, { revision: 2 });
  release(firstSnapshot); await reconcile;
  assert.equal(f.state.decisionId, 'd-2-preflop-1');
  assert.equal(f.state.disabled, true);
});

test('timeout plus unreceived receipt cannot replace an unsettled action', async () => {
  let finish;
  const f = fixture({ post: () => new Promise((resolve) => { finish = resolve; }) });
  await f.controller.connect(f.snapshot);
  await f.controller.send('call');
  const first = { ...f.sent[0] };
  await f.controller.send('fold');
  assert.deepEqual(f.sent, [first], 'an unreceived read is not a cancellation fence for the outstanding POST');
  assert.equal(f.controller.state.disabled, true);
  finish({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.controller.state.phase, 'accepted', 'late acknowledgement still binds to the captured request');
});

test('unknown network outcome locks correction across refresh and retries only the captured body', async () => {
  const f = fixture({ post: () => { throw new Error('response lost'); } });
  await f.controller.connect(f.snapshot); await f.controller.send('raise', 250);
  const first = { ...f.sent[0] };
  const restored = fixture({ values: f.values }); await restored.controller.connect(restored.snapshot);
  await restored.controller.send('fold');
  assert.equal(restored.sent.length, 0, 'refresh must not turn an unknown outcome into a fresh action');
  await restored.controller.retry();
  assert.deepEqual(restored.sent, [first]);
});

test('same-decision null status cannot downgrade an observed acceptance', async () => {
  const f = fixture(); await f.controller.connect(f.snapshot); await f.controller.send('call');
  await f.controller.reconcile();
  assert.equal(f.controller.state.phase, 'accepted');
  assert.equal(f.controller.state.disabled, true);
  assert.equal(f.controller.state.canRetry, false);
});

test('reconciliation while POST is in flight keeps its immutable request', async () => {
  let finish;
  const f = fixture({ post: () => new Promise((resolve) => { finish = resolve; }) });
  await f.controller.connect(f.snapshot); const pending = f.controller.send('call');
  await new Promise((resolve) => setImmediate(resolve));
  await f.controller.reconcile(); await f.controller.send('fold');
  assert.equal(f.sent.length, 1);
  finish({ ok: true }); await pending;
  assert.equal(f.controller.state.phase, 'accepted');
});

test('late POST settlement cannot overwrite a terminal rejection or newer decision', async () => {
  let finish;
  const f = fixture({ post: () => new Promise((resolve) => { finish = resolve; }) });
  await f.controller.connect(f.snapshot); await f.controller.send('call');
  f.setStatus({ ok: true, decisionId: legal.decisionId, requestId: f.sent[0].requestId, phase: 'rejected' });
  await f.controller.reconcile();
  finish({ ok: true }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.controller.state.phase, 'rejected'); assert.equal(f.controller.state.disabled, false);
  let finishNew;
  const g = fixture({ post: () => new Promise((resolve) => { finishNew = resolve; }) });
  await g.controller.connect(g.snapshot); await g.controller.send('call');
  const next = { ...legal, decisionId: 'd-2-preflop-1' };
  g.setSnapshot({ revision: 2, view: { legal: next } });
  g.setStatus({ ok: true, decisionId: next.decisionId, requestId: null, phase: null });
  await g.controller.reconcile(); finishNew({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(g.controller.state.phase, 'idle'); assert.equal(g.controller.state.requestId, null);
});

test('HTTP validation, capacity and conflict errors cannot cancel a prior uncertain action', async () => {
  for (const code of ['BAD_ACTION', 'ACTION_ALREADY_RECEIVED', 'ACTION_RECEIPT_CAPACITY', 'ERROR']) {
    const f = fixture({ post: () => ({ ok: false, code }) });
    await f.controller.connect(f.snapshot); await f.controller.send('call');
    await f.controller.send('fold');
    assert.equal(f.sent.length, 1, code); assert.equal(f.controller.state.disabled, true);
    await f.controller.retry(); assert.deepEqual(f.sent[1], f.sent[0]);
  }
});

test('late HTTP acceptance cannot downgrade a delivered or consumed receipt', async () => {
  for (const phase of ['delivered', 'consumed']) {
    let finish;
    const f = fixture({ post: () => new Promise((resolve) => { finish = resolve; }) });
    await f.controller.connect(f.snapshot); await f.controller.send('call');
    f.setStatus({ ok: true, decisionId: legal.decisionId, requestId: f.sent[0].requestId, phase });
    await f.controller.reconcile(); finish({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.controller.state.phase, phase); assert.equal(f.controller.state.canRetry, false);
  }
});

test('failed initial storage read must recover captured intent before unreceived unlock', async () => {
  const original = { decisionId: 'd1', requestId: 'old-intent', action: 'raise', amount: 250 };
  let value = JSON.stringify(original), unavailable = true;
  const posts = [];
  const snapshot = { view: { legal: { decisionId: 'd1' } } };
  const c = createActionController({ gameEpoch: 'storage-recovery',
    storage: { getItem: () => { if (unavailable) throw new Error('STORAGE'); return value; },
      setItem: (_key, next) => { value = next; }, removeItem: () => { value = null; } },
    uuid: () => 'new-intent', getSnapshot: async () => snapshot,
    getStatus: async () => ({ ok: true, decisionId: 'd1', requestId: null, phase: 'unreceived' }),
    postAction: async (body) => { posts.push(body); return { ok: true }; },
  });
  await c.connect(snapshot); assert.equal(c.state.disabled, true);
  await c.reconcile(); assert.equal(c.state.disabled, true, 'ongoing storage failure must stay locked');
  unavailable = false; await c.reconcile();
  assert.equal(c.state.phase, 'unreceived'); assert.equal(c.state.requestId, 'old-intent');
  await c.send('fold'); assert.equal(posts.length, 0); assert.deepEqual(JSON.parse(value), original);
  await c.retry(); assert.deepEqual(posts, [original]);
});
