// #235: a pause refusal records a durable per-request cancellation so the client
// may release the request after resume and choose a different action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../server/server.js';
import { gameEpochOf } from '../publish-contract.js';
import { createSessionControl, withActionGate } from '../tools/session-control.js';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';
import { acquireOwnedLock, releaseOwnedLock } from '../engine/state.js';
import { relayHealthCompatible } from '../tools/game-loop.js';
import { createActionReceiptStore, createRelayRootOwner } from '../server/action-receipts.js';

const TOKEN = 'cancel-test-token';
const EPOCH = gameEpochOf(TOKEN);
const D1 = 'd-1-preflop-0';
const D2 = 'd-1-preflop-1';
const LEDGER = 'ui-action-cancellations.json';
const view = (decisionId = D1) => ({ handNo: 1, toAct: 'user', legal: { decisionId } });
const request = (requestId = 'request-1', overrides = {}) => ({ decisionId: D1, requestId, action: 'call', ...overrides });
const digestOf = (action, amount = null) => createHash('sha256').update(JSON.stringify({ action, amount })).digest('hex');

async function fixture(t) {
  const dir = createOwnedTempDir('holdem-cancellations');
  const control = createSessionControl(dir, EPOCH);
  let relay;
  const start = async () => {
    relay = await startServer({ gameDir: dir, port: 0, token: TOKEN, controlProtocolVersion: 1 });
    registerOwnedServer(relay.server, 'cancellations');
  };
  await start();
  t.after(async () => { if (relay.server.listening) await relay.close(); });
  const http = async (endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:${relay.port}/api/${endpoint}?token=${TOKEN}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const f = {
    dir, control, http,
    action: (body = request()) => http('action', body),
    publish: (publishId, rest = {}) => http('publish', { publishId, view: view(), ...rest }),
    status: () => http('action-status'),
    ledgerPath: () => path.join(dir, LEDGER),
    ledger: () => JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8')),
    pause: (state = 'paused') => control.set(state, { pauseIntent: true }),
    resume: () => control.set('playing', { pauseIntent: false, closedDecisionId: null }),
    restart: async () => { if (relay.server.listening) await relay.close(); await start(); },
    wait: async (decisionId = D1) => {
      const response = await fetch(`http://127.0.0.1:${relay.port}/api/wait-action?token=${TOKEN}&expectDecisionId=${decisionId}&timeoutMs=10`);
      return { status: response.status, body: await response.json() };
    },
  };
  assert.equal((await f.publish(1)).status, 200);
  return f;
}

test('a pause refusal records durable proof and the same request can never be accepted later', async (t) => {
  const f = await fixture(t);
  for (const state of ['pausing', 'paused']) {
    f.pause(state);
    const refused = await f.action(request(`request-${state}`));
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { ok: false, code: 'GAME_PAUSED', cancelled: { decisionId: D1, requestId: `request-${state}` } });
  }
  const revision = f.control.read().controlRevision;
  assert.deepEqual(f.ledger(), {
    schemaVersion: 1, gameEpoch: EPOCH, decisionId: D1,
    entries: [
      { requestId: 'request-pausing', digest: digestOf('call'), controlRevision: revision - 1 },
      { requestId: 'request-paused', digest: digestOf('call'), controlRevision: revision },
    ],
  });
  assert.deepEqual((await f.status()).body, {
    ok: true, decisionId: D1, requestId: null, phase: 'unreceived',
    cancelled: ['request-pausing', 'request-paused'], paused: true,
  });
  f.resume();
  assert.equal((await f.status()).body.paused, false);
  for (const requestId of ['request-pausing', 'request-paused']) {
    const late = await f.action(request(requestId));
    assert.equal(late.status, 409);
    assert.deepEqual(late.body, { ok: false, code: 'ACTION_CANCELLED' });
  }
  assert.equal(fs.existsSync(path.join(f.dir, 'ui-action-receipt.json')), false, 'a cancelled request writes no receipt');
  assert.equal((await f.action(request('request-new', { action: 'fold' }))).status, 200, 'a new request is admitted after resume');
  assert.equal((await f.status()).body.requestId, 'request-new');
});

test('the cancellation ledger survives a relay restart', async (t) => {
  const f = await fixture(t);
  f.pause();
  assert.deepEqual((await f.action()).body.cancelled, { decisionId: D1, requestId: 'request-1' });
  await f.restart();
  f.resume();
  assert.equal((await f.action()).body.code, 'ACTION_CANCELLED');
  assert.deepEqual((await f.status()).body.cancelled, ['request-1']);
});

test('a repeated refusal is idempotent and a changed action under the same id gets no proof', async (t) => {
  const f = await fixture(t);
  f.pause();
  assert.equal((await f.action()).body.cancelled.requestId, 'request-1');
  const before = fs.readFileSync(f.ledgerPath());
  assert.deepEqual((await f.action()).body.cancelled, { decisionId: D1, requestId: 'request-1' });
  const changed = await f.action(request('request-1', { action: 'fold' }));
  assert.deepEqual(changed.body, { ok: false, code: 'GAME_PAUSED' });
  assert.deepEqual(fs.readFileSync(f.ledgerPath()), before);
  f.resume();
  assert.equal((await f.action(request('request-1', { action: 'fold' }))).body.code, 'ACTION_ALREADY_RECEIVED');
});

test('requests without an explicit id, or already received, are never cancelled', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.action(request('accepted-before'))).status, 200);
  f.pause('pausing');
  assert.deepEqual((await f.action(request('accepted-before'))).body, { ok: false, code: 'GAME_PAUSED' });
  const legacy = { decisionId: D1, action: 'call' };
  assert.deepEqual((await f.action(legacy)).body, { ok: false, code: 'GAME_PAUSED' });
  assert.deepEqual((await f.action(request('legacy-explicit'))).body, { ok: false, code: 'GAME_PAUSED' });
  assert.equal(fs.existsSync(f.ledgerPath()), false);
  assert.equal((await f.status()).body.phase, 'accepted');
});

test('stopping and aborted gates refuse without proof', async (t) => {
  const f = await fixture(t);
  for (const state of ['stopping', 'aborted']) {
    f.control.set(state);
    assert.deepEqual((await f.action()).body, { ok: false, code: 'GAME_PAUSED' });
  }
  assert.equal(fs.existsSync(f.ledgerPath()), false);
  assert.equal((await f.status()).body.paused, false);
});

test('a full ledger falls back to a plain refusal without evicting earlier proof', async (t) => {
  const f = await fixture(t);
  f.pause();
  for (let i = 0; i < 16; i += 1) {
    assert.equal((await f.action(request(`r-${i}`))).body.cancelled.requestId, `r-${i}`);
  }
  const before = fs.readFileSync(f.ledgerPath());
  assert.deepEqual((await f.action(request('r-16'))).body, { ok: false, code: 'GAME_PAUSED' });
  assert.deepEqual(fs.readFileSync(f.ledgerPath()), before);
  f.resume();
  assert.equal((await f.action(request('r-0'))).body.code, 'ACTION_CANCELLED');
  assert.equal((await f.action(request('r-16'))).status, 200, 'the unproven request stays admissible, exactly as before #235');
});

test('a new decision replaces the ledger and older proof stays fenced by STALE_DECISION', async (t) => {
  const f = await fixture(t);
  f.pause();
  await f.action();
  f.resume();
  assert.equal((await f.publish(2, { view: view(D2) })).status, 200);
  assert.equal((await f.status()).body.cancelled, undefined);
  f.pause();
  assert.deepEqual((await f.action(request('request-2', { decisionId: D2 }))).body.cancelled, { decisionId: D2, requestId: 'request-2' });
  assert.equal(f.ledger().decisionId, D2);
  assert.deepEqual(f.ledger().entries.map((entry) => entry.requestId), ['request-2']);
  f.resume();
  assert.equal((await f.action()).body.code, 'STALE_DECISION');
});

test('a corrupt or vanished ledger fails closed', async (t) => {
  const f = await fixture(t);
  f.pause();
  await f.action();
  f.resume();
  fs.rmSync(f.ledgerPath());
  assert.equal((await f.action(request('other'))).status, 500, 'an observed ledger that vanished is corruption');
  assert.equal((await f.status()).status, 503);
  fs.writeFileSync(f.ledgerPath(), JSON.stringify({ schemaVersion: 1, gameEpoch: EPOCH, decisionId: D1, entries: [], extra: 1 }));
  await assert.rejects(f.restart(), /ACTION_RECEIPT_CORRUPT/);
});

test('the action gate calls onClosed under the lock only while pausing or paused', () => {
  const dir = createOwnedTempDir('holdem-gate-onclosed');
  const control = createSessionControl(dir, EPOCH);
  const seen = [];
  const onClosed = (value) => {
    assert.throws(() => acquireOwnedLock(dir, 'session-control.lock.d'), { code: 'LOCKED' }, 'callback runs inside the control lock');
    seen.push(value.playState);
    return { decisionId: D1, requestId: 'q' };
  };
  assert.equal(withActionGate(dir, EPOCH, () => 'ok', { onClosed }), 'ok');
  for (const state of ['pausing', 'paused']) {
    control.set(state);
    assert.throws(() => withActionGate(dir, EPOCH, () => 'ok', { onClosed }),
      (error) => error.code === 'GAME_PAUSED' && error.cancelled?.requestId === 'q');
  }
  for (const state of ['stopping', 'aborted']) {
    control.set(state);
    assert.throws(() => withActionGate(dir, EPOCH, () => 'ok', { onClosed }),
      (error) => error.code === 'GAME_PAUSED' && !('cancelled' in error));
  }
  assert.deepEqual(seen, ['pausing', 'paused']);
  control.set('paused');
  assert.throws(() => withActionGate(dir, EPOCH, () => 'ok', { onClosed: () => { throw new Error('disk full'); } }),
    (error) => error.code === 'GAME_PAUSED' && !('cancelled' in error));
  const lock = acquireOwnedLock(dir, 'session-control.lock.d');
  try {
    assert.throws(() => withActionGate(dir, EPOCH, () => 'ok', { onClosed }), { code: 'CONTROL_BUSY' });
  } finally { releaseOwnedLock(lock); }
  assert.deepEqual(seen, ['pausing', 'paused'], 'a busy control lock records nothing');
});

test('status lists earlier rejected requests of the current decision as terminal', async (t) => {
  const f = await fixture(t);
  const rejectedAck = (requestId, publishId) => f.publish(publishId, {
    actionAck: { gameEpoch: EPOCH, decisionId: D1, requestId, digest: digestOf('call'), phase: 'rejected', reason: 'ILLEGAL_ACTION' },
  });
  assert.equal((await f.action(request('q1'))).status, 200);
  assert.equal((await f.wait()).status, 200);
  assert.equal((await rejectedAck('q1', 2)).status, 200);
  assert.equal((await f.action(request('q2'))).status, 200);
  assert.equal((await f.wait()).status, 200);
  assert.equal((await rejectedAck('q2', 3)).status, 200);
  const status = (await f.status()).body;
  assert.equal(status.requestId, 'q2');
  assert.deepEqual(status.rejected, ['q1']);
  f.pause();
  assert.deepEqual((await f.action(request('q1'))).body, { ok: false, code: 'GAME_PAUSED' }, 'a rejected request needs no cancellation');
});

test('a managed relay advertises the cancellation protocol so a stale relay is replaced on adoption', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.http('health')).body.capabilities.actionCancellations, 1);
});

test('a linked, foreign-epoch or oversized ledger fails closed and the linked target is untouched', async (t) => {
  for (const damage of ['symlink', 'epoch', 'oversize']) {
    if (damage === 'symlink' && process.platform === 'win32') continue;
    const f = await fixture(t);
    f.pause();
    await f.action();
    f.resume();
    const outside = path.join(createOwnedTempDir('holdem-ledger-outside'), 'target.json');
    if (damage === 'symlink') {
      fs.writeFileSync(outside, fs.readFileSync(f.ledgerPath()));
      fs.rmSync(f.ledgerPath());
      fs.symlinkSync(outside, f.ledgerPath());
    } else if (damage === 'epoch') {
      fs.writeFileSync(f.ledgerPath(), JSON.stringify({ ...f.ledger(), gameEpoch: 'ab'.repeat(32) }));
    } else {
      const ledger = f.ledger();
      fs.writeFileSync(f.ledgerPath(), JSON.stringify({ ...ledger, entries: [{ ...ledger.entries[0], requestId: 'x'.repeat(128) }] }) + ' '.repeat(4096));
    }
    const before = damage === 'symlink' ? fs.readFileSync(outside) : null;
    assert.equal((await f.action(request('other'))).status, 500, `${damage}: acceptance fails closed`);
    assert.equal((await f.status()).status, 503, `${damage}: status fails closed`);
    if (before) assert.deepEqual(fs.readFileSync(outside), before);
  }
});

test('a real ledger write failure gives no proof, creates no ledger, and the request stays admissible', () => {
  const dir = createOwnedTempDir('holdem-ledger-write-fail');
  const store = createActionReceiptStore(dir, EPOCH, { owner: createRelayRootOwner(dir) });
  const original = fs.openSync;
  let injected = 0;
  fs.openSync = (target, ...rest) => {
    if (String(target).includes('.ui-action-cancellations.json.')) {
      injected += 1;
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    }
    return original(target, ...rest);
  };
  try {
    assert.equal(store.cancel(request(), D1, 1), null);
  } finally { fs.openSync = original; }
  assert.equal(injected, 1, 'the writer itself was reached');
  assert.equal(fs.existsSync(path.join(dir, LEDGER)), false);
  assert.equal(store.accept(request(), D1).requestId, 'request-1', 'without proof the request is admissible, as before #235');
});

test('adoption keeps a relay only when it has every capability this loop relies on', () => {
  const health = (capabilities) => ({ ok: true, protocolVersion: 2, capabilities: { actionReceipts: true, studyLink: true, preActionHints: 1, ...capabilities } });
  const study = { studyUrl: 'http://127.0.0.1:1/#token=x' };
  const base = { responseOk: true, snapshotStudyUrl: study.studyUrl, hints: 'on' };
  assert.equal(relayHealthCompatible(health({}), { ...base, managed: true, study }), false, 'managed relay without the ledger is replaced');
  assert.equal(relayHealthCompatible(health({}), { ...base, managed: true, study: null }), false, 'also without a study service');
  assert.equal(relayHealthCompatible(health({ actionCancellations: 1 }), { ...base, managed: true, study }), true);
  assert.equal(relayHealthCompatible(health({ actionCancellations: 1 }), { ...base, managed: true, study: null }), true);
  assert.equal(relayHealthCompatible(health({}), { ...base, managed: false, study }), true, 'legacy relays do not need the ledger');
  assert.equal(relayHealthCompatible(health({ actionCancellations: 1 }), { ...base, managed: true, study, snapshotStudyUrl: 'other' }), false);
  assert.equal(relayHealthCompatible(health({ actionCancellations: 1 }), { ...base, managed: true, study, responseOk: false }), false);
});
