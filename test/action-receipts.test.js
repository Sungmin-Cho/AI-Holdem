import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/server.js';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';
import { skipOnWin32 } from './helpers/platform.js';
test('REQ-007: authenticated action status is available', async () => {
  const gameDir = createOwnedTempDir('holdem-action-status');
  const relay = await startServer({ gameDir, port: 0, token: 'receipt-test-token' });
  registerOwnedServer(relay.server, 'action-status-red');
  try {
    const response = await fetch(`http://127.0.0.1:${relay.port}/api/action-status?token=receipt-test-token`);
    await response.text();
    assert.equal(response.status, 200, 'action status must be an authenticated protocol endpoint');
  } finally {
    await relay.close();
  }
});

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gameEpochOf } from '../publish-contract.js';

const TOKEN = 'receipt-test-token';
const D1 = 'd-1-preflop-0';
const D2 = 'd-1-preflop-1';
const view = (decisionId = D1) => ({ handNo: 1, toAct: 'user', legal: { decisionId } });
const request = (requestId = 'request-1', overrides = {}) => ({ decisionId: D1, requestId, action: 'call', ...overrides });

async function fixture(t, opts = {}) {
  const dir = createOwnedTempDir('holdem-receipts');
  let relay;
  const start = async (extra = {}) => {
    relay = await startServer({ gameDir: dir, port: 0, token: TOKEN, ...extra });
    registerOwnedServer(relay.server, 'receipts');
  };
  await start(opts);
  t.after(async () => { if (relay.server.listening) await relay.close(); });
  const http = async (endpoint, body, token = TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${relay.port}/api/${endpoint}?token=${token}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const f = {
    dir, http,
    url: () => `http://127.0.0.1:${relay.port}`,
    action: (body = request()) => http('action', body),
    publish: (publishId, rest = {}) => http('publish', { publishId, view: view(), ...rest }),
    status: () => http('action-status'),
    receipt: () => JSON.parse(fs.readFileSync(path.join(dir, 'ui-action-receipt.json'), 'utf8')),
    snapshot: () => JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8')),
    restart: async (extra = {}) => { if (relay.server.listening) await relay.close(); await start(extra); },
  };
  f.wait = async (decisionId = D1) => {
    const response = await fetch(`http://127.0.0.1:${relay.port}/api/wait-action?token=${TOKEN}&expectDecisionId=${decisionId}&timeoutMs=10`);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await f.publish(1)).status, 200);
  return f;
}

function ack(receipt, phase = 'rejected', reason = 'ILLEGAL_ACTION') {
  const { gameEpoch, decisionId, requestId, digest } = receipt;
  return { gameEpoch, decisionId, requestId, digest, phase, reason };
}

test('wrong tokens reject status and POST bodies before new I/O', async (t) => {
  const f = await fixture(t);
  const before = fs.readdirSync(f.dir);
  fs.writeFileSync(path.join(f.dir, 'ui-action-receipt.json'), '{corrupt');
  const open = fs.openSync;
  const opened = [];
  fs.openSync = (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(f.dir)) opened.push(file);
    return open(file, ...args);
  };
  try {
    assert.equal((await f.http('action-status', undefined, 'wrong')).status, 401);
    for (const endpoint of ['action', 'publish']) {
      const response = await fetch(`${f.url()}/api/${endpoint}?token=wrong`, { method: 'POST', body: '{malformed' });
      await response.text();
      assert.equal(response.status, 401, 'query credentials must be checked before JSON parsing');
    }
    assert.deepEqual(opened, []);
  } finally { fs.openSync = open; }
  assert.deepEqual(fs.readdirSync(f.dir), [...before, 'ui-action-receipt.json'].sort());
  assert.equal(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'), 'utf8'), '{corrupt');
});

test('authenticated health advertises the receipt and study-link protocol', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.http('health')).body, {
    ok: true, protocolVersion: 2, capabilities: { actionReceipts: true, studyLink: true, preActionHints: 1, preActionHintsReady: false },
  });
  assert.equal((await f.http('health', undefined, 'wrong')).status, 401);
});

test('accept is durable, exact duplicate is idempotent, and status has no action payload', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.action()).status, 200);
  const receipt = f.receipt();
  assert.deepEqual(receipt, {
    schemaVersion: 1, gameEpoch: gameEpochOf(TOKEN), decisionId: D1, requestId: 'request-1',
    action: 'call', amount: null,
    digest: createHash('sha256').update(JSON.stringify({ action: 'call', amount: null })).digest('hex'),
    phase: 'accepted', rejections: [],
  });
  const before = fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'));
  assert.equal((await f.action()).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json')), before);
  assert.deepEqual((await f.status()).body, { ok: true, decisionId: D1, requestId: 'request-1', phase: 'accepted' });
  const publicState = (await f.http('snapshot')).body;
  assert.equal(JSON.stringify(publicState).includes('request-1'), false);
});

test('active conflict cannot overwrite accepted or delivered action', async (t) => {
  const f = await fixture(t);
  await f.action();
  for (const conflicting of [request('request-2'), request('request-1', { action: 'fold' })]) {
    const response = await f.action(conflicting);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'ACTION_ALREADY_RECEIVED');
  }
  const delivered = await f.wait();
  assert.equal(delivered.body.requestId, 'request-1');
  assert.equal(f.receipt().phase, 'delivered');
  assert.equal((await f.action(request('request-2'))).status, 409);
  assert.deepEqual((await f.wait()).body, delivered.body);
});

test('legacy action identity is stable across response loss and restart', async (t) => {
  const f = await fixture(t);
  const legacy = { decisionId: D1, action: 'call' };
  await f.action(legacy);
  const id = f.receipt().requestId;
  assert.match(id, /^legacy-[0-9a-f]{64}$/);
  await f.restart();
  assert.equal((await f.action(legacy)).status, 200);
  assert.equal((await f.wait()).body.requestId, id);
});

test('malformed action shapes are rejected before persistence', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { requestId: '' }, { requestId: '../escape' }, { action: '--force-default' },
    { action: 'raise', amount: 1.5 }, { action: 'raise', amount: 0 },
    { action: 'raise', amount: '50' }, { action: 'fold', amount: 50 },
  ]) {
    assert.equal((await f.action(request('request-1', patch))).status, 400);
    assert.equal(fs.existsSync(path.join(f.dir, 'ui-action-receipt.json')), false);
  }
});

test('accepted before response loss restores and delivers the exact normalized action', async (t) => {
  let crash = true;
  const f = await fixture(t, { receiptCheckpoint: (phase) => {
    if (phase === 'accepted' && crash) { crash = false; throw new Error('accept response lost'); }
  } });
  assert.equal((await f.action(request('raise-1', { action: 'raise', amount: 100 }))).status, 500);
  assert.equal(f.receipt().phase, 'accepted');
  await f.restart();
  const received = (await f.wait()).body;
  assert.equal(received.requestId, 'raise-1');
  assert.equal(received.amount, 100);
  assert.equal(received.digest, f.receipt().digest);
});

test('delivered before response loss restores without a new acceptance', async (t) => {
  const f = await fixture(t, { receiptCheckpoint: (phase) => {
    if (phase === 'delivered') throw new Error('wait response lost');
  } });
  await f.action();
  assert.equal((await f.wait()).status, 500);
  assert.equal(f.receipt().phase, 'delivered');
  await f.restart();
  assert.equal((await f.wait()).body.requestId, 'request-1');
  assert.equal(f.receipt().phase, 'delivered');
});

test('same-decision publications retain pending actions and newer views consume them', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.wait();
  await f.publish(2, { viewOnly: true });
  await f.publish(3);
  assert.equal(f.receipt().phase, 'delivered');
  assert.equal((await f.wait()).body.requestId, 'request-1');
  await f.publish(4, { view: view(D2), viewOnly: true });
  assert.equal(f.receipt().phase, 'consumed');
  assert.equal((await f.action()).body.code, 'STALE_DECISION', 'idempotency is limited to the current decision');
  await f.restart();
  assert.equal((await f.wait()).body.timeout, true);
});

test('mismatched and view-only action acknowledgements cannot change disk or memory', async (t) => {
  const f = await fixture(t);
  await f.action();
  const before = f.snapshot();
  for (const patch of [
    { requestId: 'other' }, { digest: 'a'.repeat(64) }, { gameEpoch: 'b'.repeat(64) },
    { decisionId: D2 }, { phase: 'accepted' }, { reason: 'unbounded text with spaces' },
  ]) {
    assert.equal((await f.publish(2, { actionAck: { ...ack(f.receipt()), ...patch } })).status, 400);
  }
  assert.equal((await f.publish(2, { actionAck: ack(f.receipt()), viewOnly: true })).status, 400);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.receipt().phase, 'accepted');
});

test('rejected tombstone survives restart, rejects exact retry, and admits only a new correction', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.wait();
  const actionAck = ack(f.receipt());
  assert.equal((await f.publish(2, { actionAck })).status, 200);
  await f.restart();
  assert.equal((await f.wait()).body.timeout, true);
  assert.deepEqual((await f.status()).body, { ok: true, decisionId: D1, requestId: 'request-1', phase: 'rejected' });
  assert.equal((await f.action()).body.code, 'ACTION_REJECTED');
  assert.equal((await f.action(request('request-1', { action: 'fold' }))).status, 409);
  assert.equal((await f.action(request('request-2', { action: 'fold' }))).status, 200);
  await f.restart();
  assert.equal((await f.wait()).body.requestId, 'request-2');
});

for (const [point, expectedUi, expectedPhase] of [
  ['before-ui-commit', false, 'delivered'],
  ['after-ui-commit', true, 'delivered'],
  ['after-receipt-commit', true, 'rejected'],
]) {
  test(`publish crash at ${point} leaves the declared durable commit window`, async (t) => {
    let armed = false;
    const f = await fixture(t, { publishCheckpoint: (phase) => {
      if (armed && phase === point) throw new Error('simulated relay crash');
    } });
    await f.action();
    await f.wait();
    const actionAck = ack(f.receipt());
    armed = true;
    assert.equal((await f.publish(2, { actionAck })).status, 500);
    assert.equal(f.snapshot().publishId === 2, expectedUi);
    assert.equal(f.receipt().phase, expectedPhase);
    assert.equal((await f.status()).status, 503, 'unknown commit state must not be called unreceived');
    await f.restart();
    assert.equal(f.receipt().phase, expectedUi ? 'rejected' : 'delivered');
    if (expectedUi) {
      assert.equal((await f.wait()).body.timeout, true);
      assert.equal((await f.publish(2, { actionAck })).status, 200);
    } else assert.equal((await f.wait()).body.requestId, 'request-1');
  });
}

test('corrupt, unknown-schema, wrong-epoch and noncanonical receipts are preserved and fail startup', async (t) => {
  const f = await fixture(t);
  await f.action();
  const valid = f.receipt();
  for (const raw of [
    '{broken',
    ...[{ schemaVersion: 2 }, { phase: 'future' }, { gameEpoch: '0'.repeat(64) },
      { digest: '1'.repeat(64) }, { amount: 25 }, { extra: true }]
      .map((patch) => JSON.stringify({ ...valid, ...patch })),
  ]) {
    fs.writeFileSync(path.join(f.dir, 'ui-action-receipt.json'), raw);
    await assert.rejects(f.restart(), (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
    assert.equal(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'), 'utf8'), raw);
  }
});

test('receipt symlinks and hardlinks are rejected without touching the external target', async (t) => {
  const f = await fixture(t);
  const outside = createOwnedTempDir('holdem-receipt-outside');
  const target = path.join(outside, 'sentinel');
  fs.writeFileSync(target, 'untouched');
  const file = path.join(f.dir, 'ui-action-receipt.json');
  for (const link of [fs.symlinkSync, fs.linkSync]) {
    link(target, file);
    assert.equal((await f.action()).status, 500);
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    fs.unlinkSync(file);
  }
});

test('a receipt removed during relay operation fails closed instead of becoming unreceived', async (t) => {
  const f = await fixture(t);
  await f.action();
  fs.unlinkSync(path.join(f.dir, 'ui-action-receipt.json'));
  assert.equal((await f.status()).status, 503);
  assert.equal((await f.action(request('replacement'))).status, 500);
  assert.equal(fs.existsSync(path.join(f.dir, 'ui-action-receipt.json')), false);
});

test('a mismatched durable lastActionAck fails recovery without changing the receipt', async (t) => {
  const f = await fixture(t);
  await f.action();
  const receipt = f.receipt();
  const snapshot = f.snapshot();
  snapshot.lastActionAck = { ...ack(receipt), digest: 'e'.repeat(64), publishId: snapshot.publishId };
  fs.writeFileSync(path.join(f.dir, 'ui-snapshot.json'), JSON.stringify(snapshot));
  await assert.rejects(f.restart(), (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
  assert.deepEqual(f.receipt(), receipt);
});

test('the server fsyncs UI file and directory before receipt file and directory', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.wait();
  const actionAck = ack(f.receipt());
  const events = [];
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  fs.fsyncSync = (fd) => {
    events.push(fs.fstatSync(fd).isDirectory() ? 'directory-sync' : 'file-sync');
    return sync(fd);
  };
  fs.renameSync = (from, to) => { events.push(`rename-${path.basename(to)}`); return rename(from, to); };
  try { assert.equal((await f.publish(2, { actionAck })).status, 200); }
  finally { fs.fsyncSync = sync; fs.renameSync = rename; }
  // Node cannot open or fsync a directory on Windows, so the writer flushes the
  // file, renames, and stops there by design. The order that remains — each
  // file flushed before its rename, UI before receipt — still holds.
  const directorySync = process.platform === 'win32' ? [] : ['directory-sync'];
  assert.deepEqual(events, [
    'file-sync', 'rename-ui-snapshot.json', ...directorySync,
    'file-sync', 'rename-ui-action-receipt.json', ...directorySync,
  ]);
});

test('SSE reconnect and same-decision resync retain the received action without exposing its identity', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.wait();
  for (let publishId = 2; publishId <= 3; publishId += 1) {
    await f.publish(publishId, { viewOnly: true });
    const controller = new AbortController();
    const response = await fetch(`${f.url()}/api/events?token=${TOKEN}&after=0`, { signal: controller.signal });
    const reader = response.body.getReader();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      let text = '';
      while (!/data:[\s\S]*\n\n/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString();
      }
      assert.match(text, /data:/);
      assert.equal(text.includes('request-1'), false);
      assert.equal(text.includes(f.receipt().digest), false);
    } finally { clearTimeout(timer); await reader.cancel(); controller.abort(); }
    assert.equal((await f.status()).body.phase, 'delivered');
    assert.equal((await f.wait()).body.requestId, 'request-1');
  }
});

test('action status binds a receipt only to its matching current decision', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.publish(2, { view: view(D2) });
  assert.deepEqual((await f.status()).body, { ok: true, decisionId: D2, requestId: null, phase: 'unreceived' });
  assert.equal(f.receipt().phase, 'consumed');
  assert.equal((await f.action()).body.code, 'STALE_DECISION', 'old decisions are fenced before request lookup');
  assert.equal((await f.action(request('new-decision', { decisionId: D2 }))).status, 200);
  assert.equal((await f.status()).body.requestId, 'new-decision');
});

test('a stale publish ID cannot falsely acknowledge a newly accepted action', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.wait();
  assert.equal((await f.publish(1, { actionAck: ack(f.receipt()) })).status, 400);
  assert.equal(f.receipt().phase, 'delivered');
  assert.equal(f.snapshot().lastActionAck, undefined);
});

test('terminal ack repeats preserve the original durable anchor and reject changed reasons', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.wait();
  const actionAck = ack(f.receipt());
  await f.publish(2, { actionAck });
  assert.equal((await f.publish(3, { actionAck })).status, 200);
  assert.equal(f.snapshot().lastActionAck.publishId, 2);
  assert.equal(f.receipt().publishId, 2);
  assert.equal((await f.publish(4, { actionAck: { ...actionAck, reason: 'DIFFERENT_REASON' } })).status, 400);
  await f.restart();
  assert.equal((await f.publish(3, { actionAck })).status, 200);
  assert.equal(f.snapshot().publishId, 3);
});

test('a terminal receipt from an uncommitted future publish fails startup', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.wait();
  await f.publish(2, { actionAck: ack(f.receipt()) });
  const future = { ...f.receipt(), publishId: 20 };
  fs.writeFileSync(path.join(f.dir, 'ui-action-receipt.json'), JSON.stringify(future));
  await assert.rejects(f.restart(), (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
  assert.deepEqual(f.receipt(), future);
});

test('simultaneous conflicting submissions persist and deliver exactly one request', async (t) => {
  const f = await fixture(t);
  const inputs = [request('concurrent-1'), request('concurrent-2', { action: 'fold' })];
  const responses = await Promise.all(inputs.map((input) => f.action(input)));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = inputs[responses.findIndex((response) => response.status === 200)];
  assert.equal(f.receipt().requestId, winner.requestId);
  assert.equal((await f.wait()).body.requestId, winner.requestId);
  await f.restart();
  assert.equal((await f.wait()).body.requestId, winner.requestId);
});

test('S4 repair: replacing the live game root cannot receive a UI write', async (t) => {
  const f = await fixture(t);
  await f.action();
  const displacedParent = createOwnedTempDir('holdem-displaced-root');
  const displaced = path.join(displacedParent, 'original');
  fs.renameSync(f.dir, displaced);
  fs.mkdirSync(f.dir);
  fs.writeFileSync(path.join(f.dir, 'sentinel'), 'replacement');
  try {
    assert.equal((await f.publish(2, { view: view(D2) })).status, 500);
    assert.deepEqual(fs.readdirSync(f.dir), ['sentinel'], 'replacement root must remain untouched');
    assert.equal(JSON.parse(fs.readFileSync(path.join(displaced, 'ui-snapshot.json'))).publishId, 1);
  } finally {
    fs.rmSync(f.dir, { recursive: true });
    fs.renameSync(displaced, f.dir);
  }
});

test('S4 repair: earlier rejected requests survive multiple corrections and restart', async (t) => {
  const f = await fixture(t);
  const r1 = request('rejected-1');
  const r2 = request('rejected-2', { action: 'fold' });
  for (const [index, input] of [r1, r2].entries()) {
    assert.equal((await f.action(input)).status, 200);
    await f.wait();
    assert.equal((await f.publish(index + 2, { actionAck: ack(f.receipt()) })).status, 200);
  }
  await f.restart();
  assert.equal((await f.action(r1)).status, 409, 'earlier rejected request must not be accepted again');
  assert.equal((await f.action(r1)).body.code, 'ACTION_REJECTED');
  assert.equal((await f.wait()).body.timeout, true);
});

async function liveSse(f, t, after = 1) {
  const controller = new AbortController();
  const response = await fetch(`${f.url()}/api/events?token=${TOKEN}&after=${after}`, { signal: controller.signal });
  const reader = response.body.getReader();
  const revisions = [];
  let buffer = '';
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += Buffer.from(value).toString();
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const id = /^id: (\d+)$/m.exec(frame);
        if (id) revisions.push(Number(id[1]));
      }
    }
  })();
  reading.catch(() => {});
  t.after(async () => { await reader.cancel(); controller.abort(); await reading; });
  return {
    revisions,
    async receives(revision) {
      const deadline = Date.now() + 1000;
      while (!revisions.includes(revision) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return revisions.includes(revision);
    },
  };
}

for (const point of ['after-ui-commit', 'after-receipt-commit']) {
  test(`S4 repair: same-server recovery catches up live SSE after ${point}`, async (t) => {
    let armed = false;
    const f = await fixture(t, { publishCheckpoint: (phase) => {
      if (armed && phase === point) { armed = false; throw new Error('simulated commit response loss'); }
    } });
    const stream = await liveSse(f, t);
    await f.action();
    await f.wait();
    const actionAck = ack(f.receipt());
    armed = true;
    assert.equal((await f.publish(2, { actionAck })).status, 500);
    assert.equal((await f.publish(2, { actionAck })).status, 200);
    assert.equal(await stream.receives(2), true, 'committed revision must reach the existing SSE client');
    assert.equal((await f.publish(2, { actionAck })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(stream.revisions, [2]);
    assert.equal(f.snapshot().revision, 2);
    assert.equal(f.receipt().phase, 'rejected');
  });
}

test('S4 ledger: older rejected ID with a changed action conflicts without changing bytes', async (t) => {
  const f = await fixture(t);
  for (const [index, id] of ['old-r1', 'old-r2'].entries()) {
    await f.action(request(id));
    await f.wait();
    await f.publish(index + 2, { actionAck: ack(f.receipt()) });
  }
  const bytes = fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'));
  assert.equal((await f.action(request('old-r1', { action: 'fold' }))).body.code, 'ACTION_ALREADY_RECEIVED');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json')), bytes);
  assert.equal((await f.action(request('new-r3'))).status, 200);
  assert.equal((await f.action(request('old-r1'))).body.code, 'ACTION_REJECTED');
  assert.equal((await f.action(request('old-r2'))).body.code, 'ACTION_REJECTED');
  assert.equal((await f.wait()).body.requestId, 'new-r3');
});

test('S4 ledger: malformed, duplicate, foreign and missing-ledger records are preserved and rejected', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.wait();
  await f.publish(2, { actionAck: ack(f.receipt()) });
  const valid = f.receipt();
  const entry = valid.rejections[0];
  const { rejections: ignored, ...incompleteCandidate } = valid;
  const variants = [
    incompleteCandidate,
    { ...valid, rejections: null },
    { ...valid, rejections: [] },
    { ...valid, rejections: [entry, entry] },
    { ...valid, rejections: [{ ...entry, digest: 'broken' }] },
    { ...valid, rejections: [{ ...entry, reason: null }] },
    { ...valid, rejections: [{ ...entry, gameEpoch: 'f'.repeat(64) }] },
    { ...valid, rejections: [{ ...entry, decisionId: D2 }] },
    { ...valid, rejections: Array.from({ length: 17 }, (_, index) => ({ ...entry, requestId: `entry-${index}` })) },
  ];
  for (const variant of variants) {
    const bytes = JSON.stringify(variant);
    fs.writeFileSync(path.join(f.dir, 'ui-action-receipt.json'), bytes);
    await assert.rejects(f.restart(), (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
    assert.equal(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'), 'utf8'), bytes);
  }
});

test('S4 ledger: capacity cannot evict history or write before rejecting a correction', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 16; index += 1) {
    assert.equal((await f.action(request(`cap-${index}`))).status, 200);
    await f.wait();
    assert.equal((await f.publish(index + 2, { actionAck: ack(f.receipt()) })).status, 200);
  }
  const receipt = fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'));
  const snapshot = fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'));
  const write = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = (...args) => { writes += 1; return write(...args); };
  try {
    const refused = await f.action(request('capacity-overflow'));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'ACTION_RECEIPT_CAPACITY');
    assert.equal(writes, 0);
  } finally { fs.writeFileSync = write; }
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json')), receipt);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json')), snapshot);
  assert.equal((await f.action(request('cap-0'))).body.code, 'ACTION_REJECTED');
  await f.publish(18, { viewOnly: true });
  assert.equal(f.receipt().rejections.length, 16, 'same decision cannot clear capacity');
  await f.publish(19, { view: view(D2) });
  assert.deepEqual(f.receipt().rejections, []);
  assert.equal(f.receipt().retiredAtPublishId, 19);
  await f.restart();
  assert.equal((await f.action(request('new-decision', { decisionId: D2 }))).status, 200);
});

test('S4 ledger: the encoded bound reserves maximum ack headroom before acceptance', async (t) => {
  const f = await fixture(t);
  let rejectedAt = null;
  for (let index = 0; index < 16; index += 1) {
    const receiptFile = path.join(f.dir, 'ui-action-receipt.json');
    const before = fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile) : null;
    const snapshot = fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'));
    const response = await f.action(request(`long-${index}-`.padEnd(128, 'x')));
    if (response.status === 409) {
      assert.equal(response.body.code, 'ACTION_RECEIPT_CAPACITY');
      assert.deepEqual(fs.readFileSync(receiptFile), before);
      assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json')), snapshot);
      rejectedAt = index;
      break;
    }
    assert.equal(response.status, 200);
    await f.wait();
    assert.equal((await f.publish(index + 2, { actionAck: ack(f.receipt(), 'rejected', 'R'.repeat(64)) })).status, 200,
      'a durably accepted action must fit its largest legitimate terminal ack');
    assert.ok(fs.statSync(receiptFile).size <= 4096);
    await f.restart();
  }
  assert.ok(rejectedAt > 0 && rejectedAt < 16, 'byte capacity must be tested independently of the entry limit');
});

for (const point of ['after-ui-commit', 'after-receipt-commit']) {
  test(`S4 ledger: authoritative advance clears history durably across ${point}`, async (t) => {
    let armed = false;
    const f = await fixture(t, { publishCheckpoint: (phase) => {
      if (armed && phase === point) { armed = false; throw new Error('advance response lost'); }
    } });
    for (const [index, id] of ['advance-r1', 'advance-r2'].entries()) {
      await f.action(request(id));
      await f.wait();
      await f.publish(index + 2, { actionAck: ack(f.receipt()) });
    }
    armed = true;
    assert.equal((await f.publish(4, { view: view(D2) })).status, 500);
    assert.equal(f.receipt().rejections.length, point === 'after-ui-commit' ? 2 : 0);
    await f.restart();
    assert.deepEqual(f.receipt().rejections, []);
    assert.equal(f.receipt().phase, 'rejected', 'a rejected receipt must not change terminal phase');
    assert.equal(f.receipt().retiredAtPublishId, 4);
    assert.equal((await f.action(request('advance-r1', { decisionId: D2 }))).status, 200);
    assert.equal((await f.wait(D2)).body.requestId, 'advance-r1');
  });
}

test('S4 root: a receipt store cannot borrow another relay root owner', async () => {
  const { createActionReceiptStore, createRelayRootOwner } = await import('../server/action-receipts.js');
  const root = createOwnedTempDir('holdem-owner-root');
  const other = createOwnedTempDir('holdem-owner-foreign');
  assert.throws(() => createActionReceiptStore(root, gameEpochOf(TOKEN), { owner: createRelayRootOwner(other) }),
    (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(fs.readdirSync(other), []);
});

for (const writer of ['ui', 'receipt']) {
  for (const stage of ['after-temp-open', 'after-file-write', 'after-file-fsync', 'after-rename', 'after-directory-open', 'after-directory-fsync']) {
    test(`S4 root: ${writer} writer preserves replacement at ${stage}`, async (t) => {
      // The fixture displaces the live root by renaming it while a file inside
      // is open; Windows refuses that rename, and its writer never opens the
      // directory, so two of the stages do not exist there at all.
      if (skipOnWin32(t, 'renaming a directory with an open handle is EPERM on win32; directory stages do not exist there')) return;
      const f = await fixture(t);
      const holder = createOwnedTempDir('holdem-owner-stages');
      const displaced = path.join(holder, 'original');
      const prefix = writer === 'ui' ? '.ui-snapshot.json.' : '.ui-action-receipt.json.';
      const original = { open: fs.openSync, write: fs.writeFileSync, sync: fs.fsyncSync, rename: fs.renameSync };
      let fileFd;
      let moved = false;
      const replace = (point) => {
        if (moved || point !== stage) return;
        moved = true;
        original.rename(f.dir, displaced);
        fs.mkdirSync(f.dir);
        original.write(path.join(f.dir, 'sentinel'), 'foreign-root');
      };
      fs.openSync = (file, ...args) => {
        const fd = original.open(file, ...args);
        if (typeof file === 'string' && path.basename(file).startsWith(prefix)) {
          fileFd = fd;
          replace('after-temp-open');
        } else if (file === f.dir) replace('after-directory-open');
        return fd;
      };
      fs.writeFileSync = (file, ...args) => {
        const result = original.write(file, ...args);
        if (file === fileFd) replace('after-file-write');
        return result;
      };
      fs.fsyncSync = (fd) => {
        const directory = fs.fstatSync(fd).isDirectory();
        const result = original.sync(fd);
        if (directory) replace('after-directory-fsync');
        else if (fd === fileFd) replace('after-file-fsync');
        return result;
      };
      fs.renameSync = (from, to) => {
        const result = original.rename(from, to);
        if (path.basename(from).startsWith(prefix)) replace('after-rename');
        return result;
      };
      try {
        const response = writer === 'ui' ? await f.publish(2) : await f.action();
        assert.equal(response.status, 500);
        assert.equal(moved, true);
        assert.deepEqual(fs.readdirSync(f.dir), ['sentinel']);
        assert.equal(fs.readFileSync(path.join(f.dir, 'sentinel'), 'utf8'), 'foreign-root');
      } finally {
        fs.openSync = original.open;
        fs.writeFileSync = original.write;
        fs.fsyncSync = original.sync;
        fs.renameSync = original.rename;
        if (moved) {
          fs.rmSync(f.dir, { recursive: true });
          fs.renameSync(displaced, f.dir);
        }
      }
    });
  }
}

for (const phase of ['consumed', 'rejected']) {
  for (const nextDecision of [D2, null]) {
    test(`S4 R3: stale ${phase} request is fenced before ID lookup at ${nextDecision}`, async (t) => {
      const f = await fixture(t);
      await f.action();
      await f.wait();
      let publishId = 2;
      if (phase === 'rejected') await f.publish(publishId++, { actionAck: ack(f.receipt()) });
      await f.publish(publishId, { view: nextDecision === null ? { handNo: 1, legal: null } : view(nextDecision) });
      assert.equal(f.receipt().phase, phase);
      const before = fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'));
      assert.deepEqual(await f.action(), { status: 409, body: { ok: false, code: 'STALE_DECISION' } });
      assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json')), before);
    });
  }
}

for (const writer of ['ui', 'receipt']) {
  for (const replacement of ['file', 'symlink', 'hardlink']) {
    test(`S4 R3: ${writer} cannot rename a ${replacement} substituted for its temporary`, async (t) => {
      const f = await fixture(t);
      const holder = createOwnedTempDir('holdem-temp-identity');
      const foreign = path.join(holder, 'foreign');
      fs.writeFileSync(foreign, '{"foreign":true}');
      const target = path.join(f.dir, writer === 'ui' ? 'ui-snapshot.json' : 'ui-action-receipt.json');
      const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
      const open = fs.openSync;
      const write = fs.writeFileSync;
      let temporary;
      let temporaryFd;
      let swapped = false;
      fs.openSync = (file, ...args) => {
        const fd = open(file, ...args);
        if (typeof file === 'string' && path.dirname(file) === f.dir
          && path.basename(file).startsWith(`.${path.basename(target)}.`)) {
          temporary = file;
          temporaryFd = fd;
        }
        return fd;
      };
      fs.writeFileSync = (file, ...args) => {
        const out = write(file, ...args);
        if (file === temporaryFd && !swapped) {
          swapped = true;
          fs.renameSync(temporary, path.join(holder, 'opened-temporary'));
          if (replacement === 'file') write(temporary, fs.readFileSync(foreign));
          else if (replacement === 'symlink') fs.symlinkSync(foreign, temporary);
          else fs.linkSync(foreign, temporary);
        }
        return out;
      };
      try {
        const response = writer === 'ui' ? await f.publish(2) : await f.action();
        assert.equal(swapped, true);
        assert.equal(response.status, 500, 'a substituted temporary must not commit or acknowledge');
        if (before) assert.deepEqual(fs.readFileSync(target), before);
        else assert.equal(fs.existsSync(target), false);
        assert.equal(fs.readFileSync(temporary, 'utf8'), '{"foreign":true}');
        assert.equal(fs.readFileSync(foreign, 'utf8'), '{"foreign":true}');
      } finally { fs.openSync = open; fs.writeFileSync = write; }
    });
  }
}

for (const [field, value] of [
  ['requestId', 'unknown-rejection'], ['digest', '9'.repeat(64)],
  ['reason', 'WRONG_REASON'], ['publishId', 1], ['phase', 'consumed'],
]) {
  test(`S4 R3: historical acknowledgement with forged ${field} fails restart before mutation`, async (t) => {
    const f = await fixture(t);
    await f.action(request('history-r1'));
    await f.wait();
    await f.publish(2, { actionAck: ack(f.receipt()) });
    await f.action(request('history-r2', { action: 'fold' }));
    const snapshot = { ...f.snapshot(), lastActionAck: { ...f.snapshot().lastActionAck, [field]: value } };
    const bytes = fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'));
    fs.writeFileSync(path.join(f.dir, 'ui-snapshot.json'), JSON.stringify(snapshot));
    await assert.rejects(f.restart(), (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json')), bytes);
    assert.deepEqual(f.snapshot(), snapshot);
  });
}

test('S4 R3: a valid historical anchor retains its original publication through correction restart', async (t) => {
  const f = await fixture(t);
  await f.action(request('provenance-r1'));
  await f.wait();
  const rejected = f.receipt();
  await f.publish(2, { actionAck: ack(rejected) });
  await f.action(request('provenance-r2', { action: 'fold' }));
  assert.deepEqual(f.receipt().rejections, [{ requestId: rejected.requestId, digest: rejected.digest, reason: 'ILLEGAL_ACTION', publishId: 2 }]);
  await f.restart();
  assert.equal((await f.status()).body.requestId, 'provenance-r2');
  assert.equal((await f.action(request('provenance-r1'))).body.code, 'ACTION_REJECTED');
  assert.equal((await f.wait()).body.requestId, 'provenance-r2');
  await f.publish(3, { viewOnly: true });
  assert.equal(f.snapshot().lastActionAck.requestId, 'provenance-r1');
  assert.equal(f.snapshot().lastActionAck.publishId, 2);
  assert.equal(f.receipt().rejections[0].publishId, 2);
});

for (const field of ['missing', 'wrong', 'future']) {
  test(`S4 R3: ${field} ledger publication provenance is not inferred on restart`, async (t) => {
    const f = await fixture(t);
    await f.action(request('unproven-r1'));
    await f.wait();
    await f.publish(2, { actionAck: ack(f.receipt()) });
    await f.action(request('unproven-r2'));
    const receipt = f.receipt();
    if (field === 'missing') delete receipt.rejections[0].publishId;
    else receipt.rejections[0].publishId = field === 'wrong' ? 1 : 99;
    const bytes = JSON.stringify(receipt);
    fs.writeFileSync(path.join(f.dir, 'ui-action-receipt.json'), bytes);
    await assert.rejects(f.restart(), (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
    assert.equal(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'), 'utf8'), bytes);
  });
}

test('S4 R3: authoritative advance cannot clear an invalid historical anchor to hide corruption', async (t) => {
  const f = await fixture(t);
  await f.action(request('clear-r1'));
  await f.wait();
  await f.publish(2, { actionAck: ack(f.receipt()) });
  await f.action(request('clear-r2'));
  const receipt = f.receipt();
  receipt.rejections[0].publishId = 1;
  const bytes = JSON.stringify(receipt);
  const snapshot = fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'));
  fs.writeFileSync(path.join(f.dir, 'ui-action-receipt.json'), bytes);
  assert.equal((await f.publish(3, { view: view(D2) })).status, 500);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json')), snapshot);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'), 'utf8'), bytes);
});

for (const point of ['after-ui-commit', 'after-receipt-commit']) {
  test(`S4 R3: obsolete historical anchor leaves atomically on advance across ${point}`, async (t) => {
    let armed = false;
    const f = await fixture(t, { publishCheckpoint: (phase) => {
      if (armed && phase === point) { armed = false; throw new Error('advance interrupted'); }
    } });
    await f.action(request('retire-r1'));
    await f.wait();
    await f.publish(2, { actionAck: ack(f.receipt()) });
    await f.action(request('retire-r2'));
    await f.wait();
    armed = true;
    assert.equal((await f.publish(3, { view: view(D2), viewOnly: true })).status, 500);
    assert.equal(f.snapshot().lastActionAck, undefined);
    assert.equal(f.receipt().phase, point === 'after-ui-commit' ? 'delivered' : 'consumed');
    await f.restart();
    assert.equal(f.receipt().phase, 'consumed');
    assert.equal(f.receipt().retiredAtPublishId, 3);
    assert.deepEqual(f.receipt().rejections, []);
    assert.equal((await f.action(request('retire-r2'))).body.code, 'STALE_DECISION');
  });
}

test('S4 R3: the current/null decision fence precedes malformed receipt access', async (t) => {
  const f = await fixture(t);
  await f.action();
  await f.publish(2, { view: { handNo: 1, legal: null } });
  fs.writeFileSync(path.join(f.dir, 'ui-action-receipt.json'), '{corrupt');
  assert.deepEqual(await f.action(), { status: 409, body: { ok: false, code: 'STALE_DECISION' } });
  assert.equal(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'), 'utf8'), '{corrupt');
});

async function threeRequestCorrection(t, opts = {}) {
  const f = await fixture(t, opts);
  const anchors = [];
  for (const [index, id] of ['latest-r1', 'latest-r2'].entries()) {
    await f.action(request(id));
    await f.wait();
    await f.publish(index + 2, { actionAck: ack(f.receipt()) });
    anchors.push(f.snapshot().lastActionAck);
  }
  await f.action(request('latest-r3'));
  assert.deepEqual(f.receipt().rejections.map((entry) => entry.publishId), [2, 3]);
  return { f, anchors };
}

test('S4 R4: restart rejects an older valid ledger anchor and preserves both files', async (t) => {
  const { f, anchors } = await threeRequestCorrection(t);
  const snapshot = JSON.stringify({ ...f.snapshot(), lastActionAck: anchors[0] });
  const receipt = fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'));
  fs.writeFileSync(path.join(f.dir, 'ui-snapshot.json'), snapshot);
  await assert.rejects(f.restart(), (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8'), snapshot);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json')), receipt);
});

test('S4 R4: recovery cannot advance past an older valid ledger anchor or change either file', async (t) => {
  let armed = false;
  const { f, anchors } = await threeRequestCorrection(t, { publishCheckpoint: (point) => {
    if (armed && point === 'before-ui-commit') { armed = false; throw new Error('force same-server recovery'); }
  } });
  armed = true;
  assert.equal((await f.publish(4, { view: view(D2) })).status, 500);
  const snapshot = JSON.stringify({ ...f.snapshot(), lastActionAck: anchors[0] });
  const receipt = fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json'));
  fs.writeFileSync(path.join(f.dir, 'ui-snapshot.json'), snapshot);
  assert.equal((await f.publish(4, { view: view(D2) })).status, 503,
    'an obsolete acknowledgement cannot authorize recovery or decision advancement');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8'), snapshot);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ui-action-receipt.json')), receipt);
});

test('S4 R4: the latest historical anchor restores and permits authoritative advancement', async (t) => {
  const { f, anchors } = await threeRequestCorrection(t);
  await f.restart();
  assert.deepEqual(f.snapshot().lastActionAck, anchors[1]);
  assert.equal((await f.status()).body.requestId, 'latest-r3');
  assert.equal((await f.publish(4, { view: view(D2) })).status, 200);
  assert.equal(f.snapshot().lastActionAck, undefined);
  assert.equal(f.receipt().phase, 'consumed');
  assert.equal(f.receipt().retiredAtPublishId, 4);
  await f.restart();
  assert.deepEqual((await f.status()).body, { ok: true, decisionId: D2, requestId: null, phase: 'unreceived' });
});

test('S4 R4: a current acknowledgement still repairs the UI-before-receipt crash window', async (t) => {
  let armed = false;
  const { f } = await threeRequestCorrection(t, { publishCheckpoint: (point) => {
    if (armed && point === 'after-ui-commit') { armed = false; throw new Error('receipt commit interrupted'); }
  } });
  await f.wait();
  const actionAck = ack(f.receipt());
  armed = true;
  assert.equal((await f.publish(4, { actionAck })).status, 500);
  assert.equal(f.snapshot().lastActionAck.requestId, 'latest-r3');
  assert.equal(f.receipt().rejections.at(-1).requestId, 'latest-r2');
  await f.restart();
  assert.equal(f.receipt().phase, 'rejected');
  assert.equal(f.receipt().rejections.at(-1).requestId, 'latest-r3');
  assert.equal(f.receipt().rejections.at(-1).publishId, 4);
  assert.equal((await f.publish(4, { actionAck })).status, 200);
  assert.equal(f.snapshot().revision, 4);
  assert.equal(f.receipt().rejections.length, 3);
});

test('receipt rows allow a bounded note and reject over-limit notes as corrupt', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.action(request('note-1', { note: 'short memo' }))).status, 200);
  assert.equal(f.receipt().note, 'short memo');
  assert.equal((await f.wait()).body.note, 'short memo');

  const valid = f.receipt();
  for (const note of ['한'.repeat(161), 'n'.repeat(511)]) {
    fs.writeFileSync(path.join(f.dir, 'ui-action-receipt.json'), JSON.stringify({ ...valid, note }));
    await assert.rejects(f.restart(), (error) => error.code === 'ACTION_RECEIPT_CORRUPT');
  }
});

test('512-byte note plus max requestId still admits at least 8 rejections before CAPACITY', async (t) => {
  const f = await fixture(t);
  const note = `${'😀'.repeat(127)}xy`;
  assert.ok([...note].length <= 160);
  assert.equal(Buffer.byteLength(JSON.stringify(note)), 512);
  let rejectedAt = null;
  for (let index = 0; index < 16; index += 1) {
    const response = await f.action(request(`long-${index}-`.padEnd(128, 'x'), { note }));
    if (response.status === 409) {
      assert.equal(response.body.code, 'ACTION_RECEIPT_CAPACITY');
      rejectedAt = index;
      break;
    }
    assert.equal(response.status, 200);
    assert.equal(f.receipt().note, note);
    await f.wait();
    assert.equal(
      (await f.publish(index + 2, { actionAck: ack(f.receipt(), 'rejected', 'R'.repeat(64)) })).status,
      200,
    );
  }
  assert.ok(rejectedAt >= 8, `ACTION_RECEIPT_CAPACITY must not land before 8 (hit at ${rejectedAt})`);
});
