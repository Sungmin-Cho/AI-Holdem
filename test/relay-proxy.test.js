import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { SPECTATOR_ID } from '../shared/viewer-access.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import {
  fakeRelay, makeSession, makeLoop, startProxyApp, joinGuest, publicUrl, guestHeaders, postSplit, deferred,
  OWNED_START, OTHER_START, SESSION_TOKEN, HOST_TOKEN, sha256,
} from './helpers/relay-proxy-fixture.js';

const TIMEOUT = process.platform === 'win32' ? 300000 : 30000;

async function boot(t, { loopPatch = {}, lockPatch = {} } = {}) {
  const relay = await fakeRelay();
  t.after(() => relay.close());
  const session = makeSession(createOwnedTempDir('relay-proxy'), relay.port, { lock: lockPatch });
  const loop = makeLoop(session, loopPatch);
  return startProxyApp(t, { loop, relay, session });
}

// The leak boundary is the listener's own counters, checked before any status.
function assertUntouched(h, label = '') {
  assert.deepEqual(
    { connections: h.relay.seen.connections, requests: h.relay.seen.requests.length },
    { connections: 0, requests: 0 },
    `${label}: the relay listener was contacted`,
  );
}

const readJson = async (response) => ({ status: response.status, body: await response.json() });

const DENIALS = [
  ['loop without a relay capability', (h) => { delete h.loop.captureRelayAccess; }, 503, 'RELAY_UNAVAILABLE'],
  ['no verified binding', (h) => { h.loop.state.binding = null; }, 503, 'RELAY_UNAVAILABLE'],
  ['loop is stopping', (h) => { h.loop.state.stopping = true; }, 503, 'RELAY_UNAVAILABLE'],
  ['lock missing (retryable)', (h) => fs.rmSync(h.session.lockPath), 503, 'RELAY_UNAVAILABLE'],
  ['lock pid is another process', (h) => h.session.rewriteLock({ serverPid: process.pid + 1 }), 503, 'RELAY_UNAVAILABLE'],
  ['lock token is another game', (h) => h.session.rewriteLock({ sessionToken: 'c'.repeat(64) }), 503, 'RELAY_UNAVAILABLE'],
  ['lock protocol differs', (h) => h.session.rewriteLock({ controlProtocolVersion: 2 }), 503, 'RELAY_UNAVAILABLE'],
  ['lock start time is another process', (h) => h.session.rewriteLock({ serverStartTime: OTHER_START }), 503, 'RELAY_UNAVAILABLE'],
  ['lock start time is a legacy raw stamp', (h) => h.session.rewriteLock({ serverStartTime: 'Thu Jan  1 00:00:00 2026' }), 503, 'RELAY_UNAVAILABLE'],
  ['engine token is another game', (h) => h.session.rewriteState({ sessionToken: 'd'.repeat(64) }), 503, 'RELAY_UNAVAILABLE'],
  ['listener is not the relay pid', (h) => { h.loop.state.listener = async () => false; }, 503, 'RELAY_UNAVAILABLE'],
  ['listener check fails', (h) => { h.loop.state.listener = async () => { throw new Error('lsof'); }; }, 503, 'RELAY_UNAVAILABLE'],
  ['process start time is another process', (h) => { h.loop.state.startTimeOf = () => OTHER_START; }, 503, 'RELAY_UNAVAILABLE'],
  ['process start time is unreadable', (h) => { h.loop.state.startTimeOf = () => null; }, 503, 'RELAY_UNAVAILABLE'],
];

for (const [name, mutate, status, code] of DENIALS) {
  test(`#270 denied without contacting the relay: ${name}`, { timeout: TIMEOUT }, async (t) => {
    const h = await boot(t);
    mutate(h);
    const snapshot = await h.hostGet('snapshot');
    assertUntouched(h, 'GET snapshot');
    assert.deepEqual(await readJson(snapshot), { status, body: { code } });
    const action = await h.hostPost();
    assertUntouched(h, 'POST action');
    assert.deepEqual(await readJson(action), { status, body: { code } });
    const events = await h.hostGet('events');
    assertUntouched(h, 'GET events');
    assert.equal(events.status, status);
    await events.arrayBuffer();
  });
}

test('#270 a lock naming a foreign listener contacts neither listener', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const foreign = await fakeRelay();
  t.after(() => foreign.close());
  h.session.rewriteLock({ port: foreign.port });
  for (const request of [() => h.hostGet('snapshot'), () => h.hostPost(), () => h.hostGet('events')]) {
    const response = await request();
    assertUntouched(h, 'verified binding listener');
    assertUntouched({ relay: foreign }, 'foreign lock.port listener');
    assert.deepEqual(await readJson(response), { status: 503, body: { code: 'RELAY_UNAVAILABLE' } });
  }
});

test('#270 a current request epoch with an older relay binding remains retryable', { timeout: TIMEOUT }, async t => {
  const h = await boot(t);
  const token = 'e'.repeat(64);
  h.session.rewriteState({ sessionToken: token });
  h.ctx.epoch = sha256(token);
  const response = await h.hostGet('snapshot');
  assertUntouched(h, 'binding is behind the current game epoch');
  assert.deepEqual(await readJson(response), { status: 503, body: { code: 'RELAY_UNAVAILABLE' } });
});

test('#270 a stale pre-body world is refused for participants and spectators too', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const guest = await joinGuest(h, '민준', 'seated');
  h.room.bind(h.ctx.gameId, [{ participantId: guest.participantId, playerId: 'h1' }]);
  const watcher = await joinGuest(h, '관전', 'spectator');
  h.loop.state.binding = null;
  for (const who of [guest, watcher]) {
    const response = await fetch(publicUrl(h, 'snapshot'), { headers: guestHeaders(h, who) });
    assertUntouched(h, 'participant snapshot');
    assert.deepEqual(await readJson(response), { status: 503, body: { code: 'RELAY_UNAVAILABLE' } });
  }
  const action = await fetch(publicUrl(h, 'action'), { method: 'POST', headers: guestHeaders(h, guest), body: h.actionBody() });
  assertUntouched(h, 'participant action');
  assert.equal(action.status, 503);
  const spectatorAction = await fetch(publicUrl(h, 'action'), { method: 'POST', headers: guestHeaders(h, watcher), body: h.actionBody() });
  assertUntouched(h, 'spectator action');
  assert.equal(spectatorAction.status, 403);
});

const BODY_WAIT_CHANGES = [
  ['same-valued binding object (ABA)', (h) => { h.loop.state.binding = { ...h.loop.state.binding }; }, 503],
  ['lock replaced', (h) => h.session.rewriteLock({ startedAt: 'later' }), 503],
  ['engine token replaced', (h) => h.session.rewriteState({ sessionToken: 'e'.repeat(64) }), 503],
  ['stopping', (h) => { h.loop.state.stopping = true; }, 503],
  ['session replaced by a new loop', (h) => { h.manager.session = { loop: makeLoop(h.session) }; }, 503],
  ['same game current object replaced', (h) => { h.manager.current = { ...h.manager.current }; }, 503],
  ['game epoch changed', (h) => { h.ctx.epoch = 'f'.repeat(64); }, 409],
  ['game replaced', (h) => { h.manager.current = { ...h.manager.current, gameId: '00000000-0000-4000-8000-000000000009' }; }, 409],
  ['game paused', (h) => { h.ctx.state = 'ended'; }, 409],
];

for (const [name, change, status] of BODY_WAIT_CHANGES) {
  test(`#270 a POST whose body is still arriving is re-proved: ${name}`, { timeout: TIMEOUT }, async (t) => {
    const h = await boot(t);
    const body = h.actionBody();
    const response = await postSplit(h.hostUrl('action'), h.hostHeaders(), body.slice(0, 8), body.slice(8), async () => {
      await h.loop.captured;
      assert.deepEqual([h.loop.calls.listener, h.loop.calls.startTime], [0, 0], 'no OS probe may run while the body is pending');
      change(h);
    });
    assertUntouched(h, name);
    assert.deepEqual([h.loop.calls.listener, h.loop.calls.startTime], [0, 0]);
    assert.equal(response.status, status, response.text);
    assert.equal(JSON.parse(response.text).code, status === 409 ? (name === 'game paused' ? 'GAME_PAUSED' : 'STALE_GAME') : 'RELAY_UNAVAILABLE');
  });
}

const VERIFY_CHANGES = [
  ['same-valued binding object (ABA)', (h) => { h.loop.state.binding = { ...h.loop.state.binding }; }, 503],
  ['lock replaced', (h) => h.session.rewriteLock({ startedAt: 'later' }), 503],
  ['engine token replaced', (h) => h.session.rewriteState({ sessionToken: 'e'.repeat(64) }), 503],
  ['stopping', (h) => { h.loop.state.stopping = true; }, 503],
  ['binding cleared', (h) => { h.loop.state.binding = null; }, 503],
  ['session replaced', (h) => { h.manager.session = { loop: makeLoop(h.session) }; }, 503],
  ['same game current object replaced', (h) => { h.manager.current = { ...h.manager.current }; }, 503],
  ['game epoch changed', (h) => { h.ctx.epoch = 'f'.repeat(64); }, 409],
];

for (const [name, change, status] of VERIFY_CHANGES) {
  test(`#270 a request whose OS verification is in flight is re-proved: ${name}`, { timeout: TIMEOUT }, async (t) => {
    const h = await boot(t);
    const entered = deferred();
    const gate = deferred();
    h.loop.state.listener = async () => { entered.resolve(); await gate.promise; return true; };
    const response = fetch(h.hostUrl('snapshot'), { headers: h.hostHeaders() });
    // On a build without the capability the request completes instead of reaching the gate.
    await Promise.race([entered.promise, response.then(() => {}, () => {})]);
    change(h);
    gate.resolve();
    const answered = await response;
    assertUntouched(h, name);
    assert.equal(answered.status, status);
    await answered.arrayBuffer();
  });
}

// Holds the OS probe of the next request open until `gate` resolves; `entered` resolves when
// the probe has started (on a build without the capability the request completes instead).
function holdProbe(h) {
  const entered = deferred();
  const gate = deferred();
  h.loop.state.listener = async () => { entered.resolve(); await gate.promise; return true; };
  return { entered, gate };
}
const outcomeOf = (promise) => promise.then((r) => r.status, () => 'closed');

// Room policy allows removing a spectator while the room is locked (spectators are not part of
// the bound roster), so this is a real mid-game revocation.
test('#270 a spectator revoked while verification is in flight is not served', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const guest = await joinGuest(h, '민준', 'seated');
  h.room.bind(h.ctx.gameId, [{ participantId: guest.participantId, playerId: 'h1' }]);
  const watcher = await joinGuest(h, '관전', 'spectator');
  const { entered, gate } = holdProbe(h);
  const pending = outcomeOf(fetch(publicUrl(h, 'snapshot'), { headers: guestHeaders(h, watcher) }));
  await Promise.race([entered.promise, pending]);
  h.room.remove(watcher.participantId);
  gate.resolve();
  const outcome = await pending;
  assertUntouched(h, 'removed spectator');
  assert.ok(outcome === 'closed' || outcome === 409, `unexpected ${outcome}`);
});

// A seated participant can only be removed once the room is released (unbound); the host does
// exactly that when a game is torn down, so the two steps together are the real lifecycle.
test('#270 a seated participant revoked after the room is released while verification is in flight is not served', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const guest = await joinGuest(h, '민준', 'seated');
  h.room.bind(h.ctx.gameId, [{ participantId: guest.participantId, playerId: 'h1' }]);
  const { entered, gate } = holdProbe(h);
  const pending = outcomeOf(fetch(publicUrl(h, 'snapshot'), { headers: guestHeaders(h, guest) }));
  await Promise.race([entered.promise, pending]);
  h.room.release(h.ctx.gameId);
  h.room.remove(guest.participantId);
  gate.resolve();
  const outcome = await pending;
  assertUntouched(h, 'removed participant');
  assert.ok(outcome === 'closed' || outcome === 409, `unexpected ${outcome}`);
});

for (const [field, value] of [['playerId', 'h2'], ['roomRole', 'spectator'], ['boundGameId', 'another-game'], ['participantId', 'another-participant']]) {
  test(`#270 a participant row changed in place during verification is refused: ${field}`, { timeout: TIMEOUT }, async (t) => {
    const h = await boot(t);
    const guest = await joinGuest(h, '민준', 'seated');
    h.room.bind(h.ctx.gameId, [{ participantId: guest.participantId, playerId: 'h1' }]);
    const { entered, gate } = holdProbe(h);
    const pending = fetch(publicUrl(h, 'snapshot'), { headers: guestHeaders(h, guest) });
    await entered.promise;
    // requireRoom/authenticate return clones; mutate the actual current cached room after
    // touch has saved its own clone, so the second authentication observes the change.
    const row = h.room.load().participants.find(entry => entry.participantId === guest.participantId);
    row[field] = value;
    gate.resolve();
    const response = await pending;
    assertUntouched(h, `in-place ${field}`);
    assert.equal(response.status, 409);
    await response.arrayBuffer();
  });
}

test('#270 a client gone while verification is in flight is not served', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  // The host route on a dedicated connection, so the server-side socket close is the
  // deterministic signal that the app has observed the disconnect.
  const sockets = [];
  h.app.server.on('connection', (socket) => sockets.push(socket));
  const { entered, gate } = holdProbe(h);
  // The identity read is the last OS evidence; `send` would run in the same synchronous step.
  const identityRead = deferred();
  h.loop.state.startTimeOf = () => { identityRead.resolve(); return OWNED_START; };
  const request = http.request(h.hostUrl('snapshot'), { headers: h.hostHeaders(), agent: false });
  const gone = new Promise((resolve) => {
    request.on('response', () => resolve('answered'));
    request.on('error', () => resolve('aborted'));
    request.on('close', () => resolve('aborted'));
  });
  request.end();
  await Promise.race([entered.promise, gone]);
  assert.equal(sockets.length, 1, 'the probe is held for the dedicated connection');
  const closing = once(sockets[0], 'close');
  request.destroy();
  await closing;
  gate.resolve();
  assert.equal(await gone, 'aborted');
  await identityRead.promise;
  // A leaked send resolves use only after the listener has received it; a refusal also
  // settles use. Wait for this causal boundary instead of a wall-clock settling delay.
  await h.loop.lastUseSettled;
  assertUntouched(h, 'disconnected client');
  assert.deepEqual([h.loop.calls.listener, h.loop.calls.startTime], [1, 1], 'the held request completed its checks without a send');
});

test('#270 an upstream relay that drops an SSE stream ends the proxied stream and leaves the app serving', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const response = await fetch(h.hostUrl('events'), { headers: h.hostHeaders() });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /hello/);
  assert.equal(h.relay.openStreams(), 1);
  // The relay's socket goes away under the proxied stream (a relay crash), after headers.
  h.relay.drop();
  for (;;) {
    const next = await reader.read().then((r) => r, () => ({ done: true }));
    if (next.done) break;
  }
  const ok = await h.hostGet('snapshot');
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
  assert.deepEqual([h.relay.seen.connections, h.loop.calls.listener], [2, 2], 'the next request is a fresh verified connection');
});

for (const viewer of ['host', 'participant', 'spectator']) {
  test(`#270 a ${viewer} disconnect during SSE backpressure closes upstream and permits a fresh request`, { timeout: TIMEOUT }, async (t) => {
    const h = await boot(t);
    let guest;
    if (viewer !== 'host') {
      const seated = await joinGuest(h, '민준', 'seated');
      h.room.bind(h.ctx.gameId, [{ participantId: seated.participantId, playerId: 'h1' }]);
      guest = viewer === 'participant' ? seated : await joinGuest(h, '관전', 'spectator');
    }
    const url = viewer === 'host' ? h.hostUrl('events') : publicUrl(h, 'events');
    const headers = viewer === 'host' ? h.hostHeaders() : guestHeaders(h, guest);
    const blocked = deferred();
    const originalWrite = http.ServerResponse.prototype.write;
    let heldResponse, restoreEmit, upstreamSocket;
    h.relay.server.once('connection', socket => { upstreamSocket = socket; });
    // A response-pressure seam holds the real proxy's write(false)/drain branch. Every
    // HTTP socket and IncomingMessage remains real; no timing or OS buffer-size assumption.
    http.ServerResponse.prototype.write = function (...args) {
      const target = [new URL(h.app.origin).port, String(h.app.publicPort)].includes(String(this.socket?.localPort))
        && /\/events(?:\?|$)/.test(this.req?.url ?? '');
      const result = originalWrite.apply(this, args);
      if (target && !heldResponse) {
        heldResponse = this;
        const originalEmit = this.emit;
        this.emit = function (event, ...values) { return event === 'drain' ? false : originalEmit.call(this, event, ...values); };
        restoreEmit = () => { this.emit = originalEmit; };
        blocked.resolve(this);
        return false;
      }
      return result;
    };
    t.after(() => { http.ServerResponse.prototype.write = originalWrite; restoreEmit?.(); });
    const request = http.get(url, { headers, agent: false });
    request.on('error', () => {});
    const clientReady = new Promise(resolve => request.once('response', response => {
      response.on('error', () => {});
      response.pause();
      resolve(response);
    }));
    const response = await blocked.promise;
    const client = await clientReady;
    assert.equal(client.statusCode, 200);
    assert.equal(response.listenerCount('drain'), 1, 'the proxy is suspended awaiting downstream drainage');
    const closed = new Promise(resolve => response.once('close', resolve));
    const upstreamClosed = new Promise(resolve => upstreamSocket.once('close', resolve));
    h.loop.state.binding = { ...h.loop.state.binding };
    client.destroy();
    await Promise.all([closed, upstreamClosed]);
    assert.equal(response.listenerCount('drain'), 0, 'disconnect removes backpressure listeners');
    assert.equal(h.relay.openStreams(), 0, 'the corresponding upstream stream was aborted');
    const nextUrl = viewer === 'host' ? h.hostUrl('snapshot') : publicUrl(h, 'snapshot');
    const next = await fetch(nextUrl, { headers });
    assert.equal(next.status, 200);
    await next.arrayBuffer();
    assert.deepEqual([h.relay.seen.requests.length, h.relay.seen.connections, h.loop.calls.listener], [2, 2, 2]);
    assert.equal(h.relay.seen.requests.at(-1).headers['x-seat'], viewer === 'host' ? 'user' : viewer === 'participant' ? 'h1' : SPECTATOR_ID);
  });
}

test('#270 host, participant and spectator success: fresh verification and a fresh connection per request', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const guest = await joinGuest(h, '민준', 'seated');
  h.room.bind(h.ctx.gameId, [{ participantId: guest.participantId, playerId: 'h1' }]);
  const watcher = await joinGuest(h, '관전', 'spectator');
  const seen = h.relay.seen;
  let expected = 0;
  const step = async (label, promise, seat) => {
    const response = await promise;
    expected += 1;
    const text = await response.text();
    assert.equal(response.status, 200, `${label}: ${text}`);
    assert.equal(seen.requests.length, expected, `${label}: exactly one relay request`);
    assert.equal(seen.connections, expected, `${label}: one fresh connection per request, never a pooled one`);
    assert.equal(h.loop.calls.listener, expected, `${label}: one listener proof per request`);
    assert.equal(h.loop.calls.startTime, expected, `${label}: one identity read per request`);
    const last = seen.requests.at(-1);
    assert.equal(last.headers['x-session-token'], SESSION_TOKEN);
    assert.equal(last.headers['x-seat'], seat);
    assert.equal(last.headers.connection, 'close');
    assert.equal('seat' in last.query, false);
    assert.equal(text.includes(SESSION_TOKEN), false, `${label}: token echoed to the client`);
    assert.equal(JSON.stringify(Object.fromEntries(response.headers)).includes(SESSION_TOKEN), false);
    return last;
  };
  for (const endpoint of ['snapshot', 'action-status', 'training-detail']) {
    const last = await step(`host ${endpoint}`, h.hostGet(endpoint, '?after=1'), 'user');
    assert.equal(last.path, `/api/${endpoint}`);
    assert.equal(last.query.after, '1');
  }
  const hostAction = await step('host action', fetch(h.hostUrl('action'), {
    method: 'POST', headers: h.hostHeaders({ 'x-seat': 'h1' }), body: h.actionBody(),
  }), 'user');
  assert.equal(hostAction.body.note, 'secret');
  assert.equal('seat' in hostAction.body, false);
  const guestAction = await step('participant action', fetch(publicUrl(h, 'action'), {
    method: 'POST', headers: guestHeaders(h, guest, { 'x-seat': 'user' }), body: h.actionBody(),
  }), 'h1');
  assert.equal('note' in guestAction.body, false);
  assert.equal('seat' in guestAction.body, false);
  await step('participant snapshot', fetch(publicUrl(h, 'snapshot'), { headers: guestHeaders(h, guest) }), 'h1');
  await step('spectator snapshot', fetch(publicUrl(h, 'snapshot'), { headers: guestHeaders(h, watcher) }), SPECTATOR_ID);
  const before = seen.requests.length;
  const cross = await fetch(h.hostUrl('snapshot'), { headers: { authorization: `Bearer ${guest.participantToken}`, 'x-game-epoch': h.ctx.epoch } });
  assert.equal(cross.status, 401);
  assert.equal(seen.requests.length, before);
});

test('#270 SSE opens a verified fresh connection and ends when the binding is replaced', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const seen = h.relay.seen;
  const open = async () => {
    const response = await fetch(h.hostUrl('events'), { headers: h.hostHeaders() });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value).toString(), /hello/);
    return reader;
  };
  const one = await open();
  assert.deepEqual([seen.connections, h.loop.calls.listener], [1, 1]);
  const two = await open();
  assert.deepEqual([seen.connections, h.loop.calls.listener], [2, 2], 'a second stream is a second verified connection');
  await one.cancel();
  // The binding is replaced mid-stream (a restart): the next relay chunk ends the proxied stream.
  h.loop.state.binding = { ...h.loop.state.binding };
  h.relay.push('data: after-restart\n\n');
  for (;;) { const next = await two.read(); if (next.done) break; }
  const connectionsBefore = seen.connections;
  h.loop.state.binding = null;
  const refused = await h.hostGet('events');
  assert.equal(refused.status, 503);
  assert.equal(seen.connections, connectionsBefore, 'no reconnect reaches the relay while there is no verified binding');
  assert.equal(h.relay.seen.requests.filter((request) => request.path === '/api/events').length, 2);
});

test('#270 a redirect from the relay is not followed with the session token', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const elsewhere = await fakeRelay();
  t.after(() => elsewhere.close());
  h.relay.seen.redirectTo = `http://127.0.0.1:${elsewhere.port}/api/snapshot?token=${SESSION_TOKEN}`;
  const response = await fetch(h.hostUrl('snapshot'), { headers: h.hostHeaders(), redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(h.relay.seen.requests.length, 1);
  assert.equal(elsewhere.untouched(), true, 'the redirect target must never be contacted');
});

test('#270 tokens never surface in the app API or in a denial body', { timeout: TIMEOUT }, async (t) => {
  const h = await boot(t);
  const guest = await joinGuest(h, '민준', 'seated');
  h.room.bind(h.ctx.gameId, [{ participantId: guest.participantId, playerId: 'h1' }]);
  const view = await fetch(`${h.app.origin}/api/app`, { headers: { authorization: `Bearer ${HOST_TOKEN}` } });
  assert.equal((await view.text()).includes(SESSION_TOKEN), false);
  const state = await fetch(`http://127.0.0.1:${h.app.publicPort}/api/p/state`, { headers: { authorization: `Bearer ${guest.participantToken}` } });
  assert.equal((await state.text()).includes(SESSION_TOKEN), false);
  assert.equal(JSON.stringify(h.manager.snapshot()).includes(SESSION_TOKEN), false);
  h.loop.state.listener = async () => false;
  const denied = await h.hostGet('snapshot');
  assert.equal(await denied.text(), '{"code":"RELAY_UNAVAILABLE"}');
});
