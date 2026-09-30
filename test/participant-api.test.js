import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { startAppServer } from '../tools/app-server.js';
import { createSessionManager } from '../tools/session-manager.js';
import { createRoomManager } from '../tools/room-manager.js';
import { resolveCurrentSession } from '../engine/session-catalog.js';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';

const TOKEN = 'a'.repeat(64);
const resolver = async () => ({ player: null, upper: null, notices: [] });
const TIMEOUT = process.platform === 'win32' ? 300000 : 30000;

function auth(token = TOKEN) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function jsonOf(res) {
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

const settle = async (manager, id) => {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const row = manager.receipt(id);
    if (row.status !== 'accepted') return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('receipt timeout');
};

const waitPlaying = async (manager) => {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const snap = manager.snapshot();
    if (snap.state === 'error') throw new Error(snap.error ?? 'error');
    if (snap.state === 'playing' && manager.session && manager.current) {
      try {
        const loop = JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir, 'loop-state.json'), 'utf8'));
        if (loop.lastPublishId && !loop.stopping) {
          await new Promise((r) => setTimeout(r, 50));
          if (manager.snapshot().state === 'playing') return;
        }
      } catch {
        /* loop-state may not exist yet */
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`not playing: ${manager.snapshot().state} ${manager.snapshot().error}`);
};

function cas(manager, kind = 'start') {
  const s = manager.snapshot();
  return {
    requestId: randomUUID(),
    expectedInstanceId: s.instanceId,
    expectedAppRevision: s.appRevision,
    expectedGameId: s.gameId,
    expectedSelectionVersion: s.selectionVersion,
    kind,
  };
}

async function boot(t, { publicPort = 0, tlsCert, tlsKey, resolver: resolve = resolver, onChange } = {}) {
  const storeDir = createOwnedTempDir('holdem-public');
  const manager = createSessionManager({ storeDir, resolver: resolve, ...(onChange ? { onChange } : {}) });
  t.after(() => manager.close());
  await manager.initialize();
  const app = await startAppServer({
    manager, token: TOKEN, storeDir, port: 0, publicPort, tlsCert, tlsKey,
  });
  registerOwnedServer(app.server, 'app-loopback');
  t.after(() => app.close());
  return { storeDir, manager, app };
}

test('seat request reauthenticates a partial body after token reissue', {timeout:TIMEOUT}, async t=>{
  const {manager,app}=await boot(t);
  const room=manager.room;
  room.open({totalSeats:3});room.lockForStart({requestId:'start'});room.bind('game-a',[]);
  const observer=room.join({code:room.load().joinCode,name:'Observer',addr:'1',game:{state:'playing',gameId:'game-a'}});
  room.release('game-a');
  let resolveAuthenticated;
  const authenticated=new Promise(resolve=>{resolveAuthenticated=resolve;});
  const originalAuth=room.authenticate;
  room.authenticate=token=>{const me=originalAuth(token);resolveAuthenticated();return me;};
  t.after(()=>{room.authenticate=originalAuth;});
  let request;
  const response=new Promise((resolve,reject)=>{
    request=http.request({hostname:'127.0.0.1',port:app.publicPort,path:'/api/p/seat-request',method:'POST',headers:auth(observer.participantToken)},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });
    request.on('error',reject);request.write('{');
  });
  t.after(()=>request.destroy());
  await authenticated;
  room.reissue(observer.participantId);
  const before=structuredClone(room.load());
  request.end(JSON.stringify({expectedRoomId:before.roomId,expectedRevision:before.revision}).slice(1));
  assert.equal((await response).status,401);
  assert.deepEqual(room.load(),before);
  assert.equal(room.hostView().participants.length,0);
  assert.equal(room.hostView().spectators.length,1);
});

test('public listener 404s host APIs and serves join', async () => {
  const storeDir = createOwnedTempDir('holdem-public');
  const manager = {
    snapshot: () => ({ state: 'lobby', instanceId: 'i', appRevision: 0, gameId: null, selectionVersion: 0, allowedCommands: ['start'] }),
    command: () => ({ requestId: 'x', status: 'rejected' }),
    receipt: () => ({ requestId: 'x', status: 'rejected' }),
    current: null,
    session: null,
  };
  const app = await startAppServer({
    manager,
    token: TOKEN,
    storeDir,
    port: 0,
    publicPort: 0,
  });
  registerOwnedServer(app.server, 'app-loopback');
  try {
    const publicOrigin = `http://127.0.0.1:${app.publicPort}`;
    for (const pathName of ['/api/app', '/api/commands', '/api/stop', '/api/room', '/api/prefill', '/api/study', '/.app/descriptor.json']) {
      for (const method of ['GET', 'POST', 'PUT']) {
        const res = await fetch(`${publicOrigin}${pathName}`, {
          method,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 404, `${method} ${pathName}`);
      }
    }
    const join = await fetch(`${publicOrigin}/join`);
    assert.equal(join.status, 200);
    for (const pathName of ['/api/join', '/api/p/state']) {
      const res = await fetch(`${app.origin}${pathName}`, { headers: auth() });
      assert.equal(res.status, 404, pathName);
    }
    const opened = await fetch(`${app.origin}/api/room`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 4, actionTimeoutSec: 60 }),
    });
    const openedBody = await opened.json();
    assert.equal(opened.status, 200, JSON.stringify(openedBody));
    const room = openedBody;
    const joined = await fetch(`${publicOrigin}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: room.joinCode, name: '민준' }),
    });
    const joinedBody = await joined.json();
    assert.equal(joined.status, 200, JSON.stringify(joinedBody));
  } finally {
    await app.close();
  }
});

test('public listener serves the whole table module graph that app.js imports', async (t) => {
  const { app } = await boot(t);
  const publicOrigin = `http://127.0.0.1:${app.publicPort}`;
  const specifiers = (source) => [
    ...source.matchAll(/(?:^|\n)\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  for (const origin of [publicOrigin, app.origin]) {
    const table = await fetch(`${origin}/table`);
    assert.equal(table.status, 200, `${origin}/table`);
    const html = await table.text();
    const entries = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)]
      .map((m) => new URL(m[1], `${origin}/table`).href);
    assert.ok(entries.length > 0, `${origin}/table has a module entry`);
    const seen = new Set();
    const queue = [...entries];
    while (queue.length) {
      const href = queue.shift();
      if (seen.has(href)) continue;
      seen.add(href);
      const res = await fetch(href);
      assert.equal(res.status, 200, `${href} (reached from ${origin}/table)`);
      assert.match(res.headers.get('content-type') ?? '', /javascript/, href);
      const source = await res.text();
      for (const spec of specifiers(source)) {
        if (/^[a-z]+:/i.test(spec)) continue;
        queue.push(new URL(spec, href).href);
      }
    }
    assert.ok([...seen].some((href) => href.includes('/shared/')), `shared modules reached from ${origin}`);
  }
  assert.equal((await fetch(`${publicOrigin}/shared/platform-files.js`)).status, 404);
  assert.equal((await fetch(`${publicOrigin}/`)).status, 404);
});

test('join errors, origin, and rate limit', async (t) => {
  const { app } = await boot(t);
  const publicOrigin = `http://127.0.0.1:${app.publicPort}`;
  const opened = await fetch(`${app.origin}/api/room`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 2, actionTimeoutSec: 60 }),
  });
  const room = await opened.json();
  assert.equal(opened.status, 200, JSON.stringify(room));
  const okOrigin = await fetch(`${publicOrigin}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: publicOrigin },
    body: JSON.stringify({ code: room.joinCode, name: '민준' }),
  });
  assert.equal(okOrigin.status, 200, await okOrigin.text());
  const badOrigin = await fetch(`${publicOrigin}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.test' },
    body: JSON.stringify({ code: room.joinCode, name: '서연' }),
  });
  assert.equal(badOrigin.status, 403);
  const started = Date.now();
  const badCode = await fetch(`${publicOrigin}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'ZZZZZZZZ', name: '서연' }),
  });
  assert.equal(badCode.status, 401);
  assert.equal((await badCode.json()).code, 'BAD_CODE');
  assert.ok(Date.now() - started >= 250);
  const full = await fetch(`${publicOrigin}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: room.joinCode, name: '서연' }),
  });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, 'ROOM_FULL');
});

test('x-seat is overwritten and note is stripped on the public game proxy', async (t) => {
  const storeDir = createOwnedTempDir('holdem-proxy');
  const captured = [];
  const relay = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.push({
      url: req.url,
      seat: req.headers['x-seat'],
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, view: { myCards: ['Ah', 'Kd'], viewer: 'h1' } }));
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => relay.close(resolve)));
  const gameId = randomUUID();
  const sessionDir = path.join(storeDir, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionToken = 'b'.repeat(64);
  const gameEpoch = createHash('sha256').update(sessionToken).digest('hex');
  fs.writeFileSync(path.join(sessionDir, 'lock.json'), JSON.stringify({
    serverPid: process.pid, port: relay.address().port, sessionToken, controlProtocolVersion: 1, startedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ sessionToken, seats: [] }));
  const roomStore = createOwnedTempDir('holdem-proxy-room');
  const roomMgr = createRoomManager({ storeDir: roomStore });
  const manager = {
    snapshot: () => ({
      state: 'playing', instanceId: 'i', appRevision: 1, gameId, gameEpoch,
      selectionVersion: 1, allowedCommands: ['pause'],
    }),
    command: () => ({ requestId: 'x', status: 'rejected' }),
    receipt: () => ({ requestId: 'x', status: 'rejected' }),
    current: { gameId, sessionDir, selectionVersion: 1 },
    session: { loop: { serverPid: process.pid } },
    room: roomMgr,
  };
  const app = await startAppServer({ manager, token: TOKEN, storeDir: roomStore, port: 0, publicPort: 0 });
  registerOwnedServer(app.server, 'app-loopback');
  t.after(() => app.close());
  const opened = await fetch(`${app.origin}/api/room`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 4, actionTimeoutSec: 60 }),
  });
  const room = await opened.json();
  const joined = await fetch(`http://127.0.0.1:${app.publicPort}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: room.joinCode, name: '민준' }),
  });
  const guest = await joined.json();
  assert.equal(joined.status, 200, JSON.stringify(guest));
  roomMgr.bind(gameId, [{ participantId: guest.participantId, playerId: 'h1' }]);

  const action = await fetch(`http://127.0.0.1:${app.publicPort}/api/p/game/${gameId}/action`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${guest.participantToken}`,
      'content-type': 'application/json',
      'x-game-epoch': gameEpoch,
      'x-seat': 'user',
    },
    body: JSON.stringify({ decisionId: 'd-1-preflop-0', requestId: randomUUID(), action: 'fold', note: 'secret', seat: 'user' }),
  });
  assert.equal(action.status, 200, await action.text());
  assert.equal(captured.at(-1).seat, 'h1');
  assert.equal('note' in captured.at(-1).body, false);
  const hostAction = await fetch(`${app.origin}/api/game/${gameId}/action`, {
    method: 'POST',
    headers: { ...auth(), 'x-game-epoch': gameEpoch, 'x-seat': 'h1' },
    body: JSON.stringify({ decisionId: 'd-1-preflop-0', requestId: randomUUID(), action: 'check' }),
  });
  assert.equal(hostAction.status, 200, await hostAction.text());
  assert.equal(captured.at(-1).seat, 'user');
  const cross = await fetch(`${app.origin}/api/game/${gameId}/snapshot`, {
    headers: { authorization: `Bearer ${guest.participantToken}`, 'x-game-epoch': gameEpoch },
  });
  assert.equal(cross.status, 401);
  const lobbyOnPublic = await fetch(`http://127.0.0.1:${app.publicPort}/api/p/state`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(lobbyOnPublic.status, 401);
});

// #235: while pausing/paused the relay's gate decides, so its refusal body (with
// per-request cancellation proof) reaches the participant unchanged. Other
// non-playing states keep the proxy's own unproven refusal.
test('paused action POSTs reach the relay gate and its cancellation proof passes through', async (t) => {
  const storeDir = createOwnedTempDir('holdem-proxy-paused');
  const captured = [];
  const relay = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    captured.push({ url: req.url, seat: req.headers['x-seat'], body });
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'GAME_PAUSED', cancelled: { decisionId: body.decisionId, requestId: body.requestId } }));
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => relay.close(resolve)));
  const gameId = randomUUID();
  const sessionDir = path.join(storeDir, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionToken = 'c'.repeat(64);
  const gameEpoch = createHash('sha256').update(sessionToken).digest('hex');
  fs.writeFileSync(path.join(sessionDir, 'lock.json'), JSON.stringify({
    serverPid: process.pid, port: relay.address().port, sessionToken, controlProtocolVersion: 1, startedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ sessionToken, seats: [] }));
  const roomStore = createOwnedTempDir('holdem-proxy-paused-room');
  const roomMgr = createRoomManager({ storeDir: roomStore });
  let state = 'pausing';
  const manager = {
    snapshot: () => ({ state, instanceId: 'i', appRevision: 1, gameId, gameEpoch, selectionVersion: 1, allowedCommands: [] }),
    command: () => ({ requestId: 'x', status: 'rejected' }),
    receipt: () => ({ requestId: 'x', status: 'rejected' }),
    current: { gameId, sessionDir, selectionVersion: 1 },
    session: { loop: { serverPid: process.pid } },
    room: roomMgr,
  };
  const app = await startAppServer({ manager, token: TOKEN, storeDir: roomStore, port: 0, publicPort: 0 });
  registerOwnedServer(app.server, 'app-paused');
  t.after(() => app.close());
  const opened = await fetch(`${app.origin}/api/room`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 4, actionTimeoutSec: 60 }),
  });
  const room = await opened.json();
  const joined = await fetch(`http://127.0.0.1:${app.publicPort}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: room.joinCode, name: '민준' }),
  });
  const guest = await joined.json();
  roomMgr.bind(gameId, [{ participantId: guest.participantId, playerId: 'h1' }]);
  const post = (requestId) => fetch(`http://127.0.0.1:${app.publicPort}/api/p/game/${gameId}/action`, {
    method: 'POST',
    headers: { authorization: `Bearer ${guest.participantToken}`, 'content-type': 'application/json', 'x-game-epoch': gameEpoch },
    body: JSON.stringify({ decisionId: 'd-1-preflop-0', requestId, action: 'fold' }),
  });
  for (const next of ['pausing', 'paused']) {
    state = next;
    const response = await post(`q-${next}`);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, code: 'GAME_PAUSED', cancelled: { decisionId: 'd-1-preflop-0', requestId: `q-${next}` } });
    assert.equal(captured.at(-1).seat, 'h1');
  }
  const forwarded = captured.length;
  for (const next of ['starting', 'stopping', 'finalizing', 'error']) {
    state = next;
    const response = await post(`q-${next}`);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: 'GAME_PAUSED' });
  }
  assert.equal(captured.length, forwarded, 'non-pause states never reach the relay');
});

test('start injects room participants into the engine session', { timeout: TIMEOUT }, async (t) => {
  const { storeDir, manager, app } = await boot(t);
  const opened = await fetch(`${app.origin}/api/room`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 6, actionTimeoutSec: 60 }),
  });
  const room = await opened.json();
  assert.equal(opened.status, 200, JSON.stringify(room));
  const publicOrigin = `http://127.0.0.1:${app.publicPort}`;
  const a = await (await fetch(`${publicOrigin}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: room.joinCode, name: '민준' }),
  })).json();
  const b = await (await fetch(`${publicOrigin}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: room.joinCode, name: '서연' }),
  })).json();
  assert.ok(a.participantToken);
  assert.ok(b.participantToken);
  const taken = await fetch(`${publicOrigin}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: room.joinCode, name: '호스트' }),
  });
  assert.equal((await taken.json()).code, 'NAME_TAKEN');
  const start = { ...cas(manager), setup: { mode: 'cash-training', totalSeats: 6, opponentRuntime: 'policy', hints: 'off', dealBias: 'off' } };
  const accepted = manager.command(start);
  assert.equal(accepted.status, 'accepted');
  const done = await settle(manager, start.requestId);
  assert.equal(done.status, 'succeeded', `${done.error} ${JSON.stringify({ error: done.error, state: manager.snapshot().state, snapError: manager.snapshot().error })}`);
  await waitPlaying(manager);
  const players = JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir, 'players.json'), 'utf8'));
  const humans = players.filter((row) => row.kind === 'human');
  const ais = players.filter((row) => row.kind === 'ai');
  assert.equal(humans.length, 3);
  assert.equal(ais.length, 3);
  const engine = JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir, 'state.json'), 'utf8'));
  assert.equal(engine.schemaVersion, 2);
  const setup = JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir, '.app-setup.json'), 'utf8'));
  assert.equal(setup.aiCount, 3);
  assert.equal(setup.actionTimeoutSec, 60);
  assert.equal(setup.participants.length, 2);
  const stateA = await (await fetch(`${publicOrigin}/api/p/state`, {
    headers: { authorization: `Bearer ${a.participantToken}` },
  })).json();
  assert.equal(stateA.me.playerId, 'h1');
  assert.ok(['playing', 'starting', 'pausing', 'paused'].includes(stateA.game.state), stateA.game.state);
  assert.equal(manager.room.load().status, 'locked');
  const pause = cas(manager, 'pause');
  manager.command(pause);
  const paused = await settle(manager, pause.requestId);
  assert.equal(paused.status, 'succeeded', `${paused.error} state=${manager.snapshot().state} err=${manager.snapshot().error}`);
  const end = cas(manager, 'end');
  manager.command(end);
  assert.equal((await settle(manager, end.requestId)).status, 'succeeded');
  assert.equal(manager.room.load().status, 'open');
  const final = await (await fetch(`${publicOrigin}/api/p/state`, {
    headers: { authorization: `Bearer ${a.participantToken}` },
  })).json();
  assert.ok(final.game.final?.stacks?.length >= 3);
  assert.equal('coach' in (final.game.final ?? {}), false);
});

test('zero-participant room start stays schema 1 and unlocks on invalid lock', { timeout: TIMEOUT }, async (t) => {
  const { manager, app } = await boot(t);
  await fetch(`${app.origin}/api/room`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 6, actionTimeoutSec: 60 }),
  });
  const start = { ...cas(manager), setup: { mode: 'cash-training', totalSeats: 6, opponentRuntime: 'policy' } };
  manager.command(start);
  const done = await settle(manager, start.requestId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  const engine = JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir, 'state.json'), 'utf8'));
  assert.equal(engine.schemaVersion, 1);
  const setup = JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir, '.app-setup.json'), 'utf8'));
  assert.equal(setup.actionTimeoutSec, 0);
  assert.equal(setup.participants, undefined);
  assert.equal(fs.existsSync(path.join(manager.current.sessionDir, '.participants.json')), false);
  assert.equal(manager.room.load().status, 'locked');

  const other = await boot(t);
  await fetch(`${other.app.origin}/api/room`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 6, actionTimeoutSec: 60 }),
  });
  const publicOrigin = `http://127.0.0.1:${other.app.publicPort}`;
  await fetch(`${publicOrigin}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: other.manager.room.load().joinCode, name: '민준' }),
  });
  const bad = { ...cas(other.manager), setup: { mode: 'cash-training', totalSeats: 6, opponentRuntime: 'policy', hints: 'on', dealBias: 'off' } };
  assert.throws(() => other.manager.command(bad), { code: 'INVALID_SETUP' });
  assert.equal(other.manager.room.load().status, 'open');
  assert.equal(fs.existsSync(path.join(other.storeDir, '.app', 'commands', `${bad.requestId}.json`)), false);
});

test('closed multi room resume becomes ROOM_UNBOUND and abort-unrecoverable end records the reason', { timeout: TIMEOUT }, async (t) => {
  const { storeDir, manager, app } = await boot(t);
  await fetch(`${app.origin}/api/room`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 4, actionTimeoutSec: 60 }),
  });
  const publicOrigin = `http://127.0.0.1:${app.publicPort}`;
  await fetch(`${publicOrigin}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: manager.room.load().joinCode, name: '민준' }),
  });
  const start = { ...cas(manager), setup: { mode: 'cash-training', totalSeats: 4, opponentRuntime: 'policy', hints: 'off', dealBias: 'off' } };
  manager.command(start);
  const started = await settle(manager, start.requestId);
  assert.equal(started.status, 'succeeded', `${started.error} ${JSON.stringify({ error: started.error, state: manager.snapshot().state })}`);
  await waitPlaying(manager);
  const pause = cas(manager, 'pause');
  manager.command(pause);
  const pausedRow = await settle(manager, pause.requestId);
  assert.equal(pausedRow.status, 'succeeded', `${pausedRow.error} ${manager.snapshot().state} ${manager.snapshot().error}`);
  const gameDir = manager.current.sessionDir;
  await manager.close();
  const roomFile = path.join(storeDir, '.app', 'room.json');
  const room = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
  room.status = 'closed';
  fs.writeFileSync(roomFile, JSON.stringify(room));
  const restored = createSessionManager({ storeDir, resolver });
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.snapshot().error, 'SESSION_RECOVERABLE');
  const resume = cas(restored, 'resume');
  assert.throws(() => restored.command(resume), { code: 'ROOM_UNBOUND' });
  assert.equal(restored.snapshot().error, 'ROOM_UNBOUND');
  assert.ok(restored.snapshot().allowedCommands.includes('end'));
  assert.ok(restored.snapshot().recoveryExit?.mode);
  const end = cas(restored, 'end');
  restored.command(end);
  const finished = await settle(restored, end.requestId);
  assert.equal(finished.status, 'succeeded', JSON.stringify(finished));
  const sidecar = fs.readdirSync(gameDir).find((name) => name.startsWith('loop-state.abandoned.'));
  assert.ok(sidecar, fs.readdirSync(gameDir).join(','));
  const audit = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json'), 'utf8'));
  assert.equal(audit.abandonedPendingDecision?.reason, 'ROOM_UNBOUND');
});

// #260: an LLM game blocks on the runtime probe after the new session is
// committed (policy games probe in the background), so one failing probe is a
// failure after the commit. Later probes return a working fake player.
function probeFailingOnce() {
  const player = { kind: 'fake',
    async warmup({ playerId }) { return { sessionId: `session-${playerId}`, raw: 'ready' }; },
    async decide() { return { raw: 'invalid' }; }, async dispose() {} };
  const control = { failNext: false, alwaysFail: false, gate: null, entered: null };
  control.resolver = async ({ need } = {}) => {
    if (need === 'player+upper' && control.gate) {
      control.entered?.();
      await control.gate;
    }
    if (need === 'player+upper' && (control.failNext || control.alwaysFail)) {
      control.failNext = false;
      throw Object.assign(new Error('probe failure'), { code: 'NO_PLAYER_RUNTIME' });
    }
    return { player: need === 'player+upper' ? player : null, upper: null, notices: [] };
  };
  return control;
}
const LLM_ROOM = { mode: 'cash-training', totalSeats: 3, opponentRuntime: 'llm', hints: 'off', dealBias: 'off' };
const POLICY_ROOM = { ...LLM_ROOM, opponentRuntime: 'policy' };
async function openRoomWithGuest(app, manager) {
  manager.room.open({ hostName: '호스트', totalSeats: 3, actionTimeoutSec: 60 });
  const joined = await jsonOf(await fetch(`http://127.0.0.1:${app.publicPort}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: manager.room.load().joinCode, name: '민준' }),
  }));
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return joined.body;
}
function assertRoomBoundTo(manager, gameId, guest) {
  const room = manager.room.load();
  assert.equal(room.status, 'locked');
  assert.equal(room.lock.boundGameId, gameId);
  const seat = room.participants.find((row) => row.participantId === guest.participantId);
  assert.equal(seat.boundGameId, gameId);
  assert.equal(seat.playerId, 'h1');
}
async function resumeSucceeds(manager, gameId) {
  const resume = cas(manager, 'resume');
  manager.command(resume);
  const done = await settle(manager, resume.requestId);
  assert.equal(done.status, 'succeeded', `${done.error} ${manager.snapshot().error}`);
  assert.ok(['playing', 'paused'].includes(manager.snapshot().state), manager.snapshot().state);
  assert.equal(manager.snapshot().gameId, gameId);
}
async function pauseWhenPlaying(manager) {
  const deadline = Date.now() + TIMEOUT;
  while (!['playing', 'paused'].includes(manager.snapshot().state)) {
    if (Date.now() > deadline) throw new Error(`state ${manager.snapshot().state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  if (manager.snapshot().state === 'paused') return;
  const pause = cas(manager, 'pause');
  manager.command(pause);
  assert.equal((await settle(manager, pause.requestId)).status, 'succeeded');
}
// Rewrites a finished start row as the unfinished row a crash would leave, with
// the room locked for it as `lockForStart` left it.
function crashBeforeFinishing(storeDir, row, previous = { status: 'open', boundGameId: null, requestId: null }) {
  const unfinished = { ...row, status: 'accepted' };
  for (const key of ['error', 'completedAt', 'result']) delete unfinished[key];
  fs.writeFileSync(path.join(storeDir, '.app', 'commands', `${row.requestId}.json`), JSON.stringify(unfinished));
  const roomFile = path.join(storeDir, '.app', 'room.json');
  const room = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
  room.status = 'locked';
  room.lock = { requestId: row.requestId, boundGameId: previous.boundGameId, previous };
  fs.writeFileSync(roomFile, JSON.stringify(room));
}

test('#260 a start that fails after its commit keeps the room bound, and the game resumes', { timeout: TIMEOUT }, async (t) => {
  const probe = probeFailingOnce();
  let observed = null;
  let roomAtFirstError;
  const { storeDir, manager, app } = await boot(t, { resolver: probe.resolver, onChange: (snap) => {
    if (snap.state === 'error' && roomAtFirstError === undefined) roomAtFirstError = structuredClone(observed?.room.load() ?? null);
  } });
  observed = manager;
  const guest = await openRoomWithGuest(app, manager);
  probe.failNext = true;
  const start = { ...cas(manager), setup: LLM_ROOM };
  manager.command(start);
  const failed = await settle(manager, start.requestId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'NO_PLAYER_RUNTIME');
  const committed = resolveCurrentSession(storeDir);
  assert.equal(committed.gameId, failed.reservation.gameId);
  assert.equal(manager.snapshot().state, 'error');
  assert.equal(manager.snapshot().gameId, committed.gameId);
  assertRoomBoundTo(manager, committed.gameId, guest);
  // The room is settled before the failure is published, not after.
  assert.equal(roomAtFirstError?.status, 'locked');
  assert.equal(roomAtFirstError?.lock.boundGameId, committed.gameId);
  const seen = await jsonOf(await fetch(`http://127.0.0.1:${app.publicPort}/api/p/state`, {
    headers: { authorization: `Bearer ${guest.participantToken}` } }));
  assert.equal(seen.body.me.playerId, 'h1');
  assert.equal(seen.body.game.gameId, committed.gameId);
  await resumeSucceeds(manager, committed.gameId);
  assertRoomBoundTo(manager, committed.gameId, guest);
  const view = await fetch(`http://127.0.0.1:${app.publicPort}/api/p/game/${committed.gameId}/snapshot`, {
    headers: { authorization: `Bearer ${guest.participantToken}`, 'x-game-epoch': manager.snapshot().gameEpoch } });
  assert.equal(view.status, 200, await view.text());
  await endGame(manager);
  assert.equal(manager.room.load().status, 'open');
  assert.equal(manager.room.load().lock.boundGameId, null);
});

test('#260 the binding survives an app restart after a failure after the commit', { timeout: TIMEOUT }, async (t) => {
  const probe = probeFailingOnce();
  const { storeDir, manager, app } = await boot(t, { resolver: probe.resolver });
  const guest = await openRoomWithGuest(app, manager);
  probe.failNext = true;
  const start = { ...cas(manager), setup: LLM_ROOM };
  manager.command(start);
  assert.equal((await settle(manager, start.requestId)).status, 'failed');
  const committed = resolveCurrentSession(storeDir);
  await manager.close();
  const restored = restartApp(t, storeDir, probe.resolver);
  await restored.initialize();
  assert.equal(restored.snapshot().error, 'SESSION_RECOVERABLE');
  assertRoomBoundTo(restored, committed.gameId, guest);
  await resumeSucceeds(restored, committed.gameId);
});

for (const kind of ['replace-current', 'restart']) {
  test(`#260 ${kind} that fails after its commit binds the room to the new game, not the previous one`, { timeout: TIMEOUT }, async (t) => {
    const probe = probeFailingOnce();
    const { storeDir, manager, app } = await boot(t, { resolver: probe.resolver });
    const guest = await openRoomWithGuest(app, manager);
    // restart keeps the stored setup, so only an LLM previous game fails on the probe again.
    const first = { ...cas(manager), setup: kind === 'restart' ? LLM_ROOM : POLICY_ROOM };
    manager.command(first);
    assert.equal((await settle(manager, first.requestId)).status, 'succeeded');
    const previous = manager.snapshot().gameId;
    await pauseWhenPlaying(manager);
    assertRoomBoundTo(manager, previous, guest);
    probe.failNext = true;
    const next = { ...cas(manager, kind), ...(kind === 'replace-current' ? { setup: LLM_ROOM } : {}) };
    manager.command(next);
    const failed = await settle(manager, next.requestId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'NO_PLAYER_RUNTIME');
    const committed = resolveCurrentSession(storeDir);
    assert.equal(committed.gameId, failed.reservation.gameId);
    assert.notEqual(committed.gameId, previous);
    assertRoomBoundTo(manager, committed.gameId, guest);
    await resumeSucceeds(manager, committed.gameId);
  });
}

async function endGame(manager) {
  await pauseWhenPlaying(manager);
  const end = cas(manager, 'end');
  manager.command(end);
  assert.equal((await settle(manager, end.requestId)).status, 'succeeded');
}
function restartApp(t, storeDir, resolve) {
  const restored = createSessionManager({ storeDir, resolver: resolve });
  t.after(() => restored.close());
  return restored;
}

test('#260 app-restart recovery that fails after the commit keeps the room bound', { timeout: TIMEOUT }, async (t) => {
  const probe = probeFailingOnce();
  const { storeDir, manager, app } = await boot(t, { resolver: probe.resolver });
  const guest = await openRoomWithGuest(app, manager);
  // (a) The committed reservation is recovered again (`reservedCurrent`) and its resume fails.
  probe.failNext = true;
  const start = { ...cas(manager), setup: LLM_ROOM };
  manager.command(start);
  const failed = await settle(manager, start.requestId);
  assert.equal(failed.status, 'failed');
  const committed = resolveCurrentSession(storeDir);
  await manager.close();
  crashBeforeFinishing(storeDir, failed);
  probe.failNext = true;
  let restored = restartApp(t, storeDir, probe.resolver);
  await restored.initialize();
  assert.equal(restored.receipt(start.requestId).status, 'failed');
  assert.equal(restored.receipt(start.requestId).error, 'NO_PLAYER_RUNTIME');
  assertRoomBoundTo(restored, committed.gameId, guest);
  await resumeSucceeds(restored, committed.gameId);
  // (b) A reserved but uncommitted start row starts again on recovery and fails after its commit.
  await endGame(restored);
  assert.equal(restored.room.load().status, 'open');
  await restored.close();
  const reserved = { ...failed, requestId: randomUUID(), expectedGameId: committed.gameId,
    expectedSelectionVersion: committed.selectionVersion,
    reservation: { gameId: randomUUID(), selectionVersion: committed.selectionVersion + 1 } };
  crashBeforeFinishing(storeDir, reserved);
  probe.failNext = true;
  restored = restartApp(t, storeDir, probe.resolver);
  await restored.initialize();
  assert.equal(restored.receipt(reserved.requestId).status, 'failed');
  assert.equal(restored.receipt(reserved.requestId).error, 'NO_PLAYER_RUNTIME');
  assert.equal(resolveCurrentSession(storeDir).gameId, reserved.reservation.gameId);
  assertRoomBoundTo(restored, reserved.reservation.gameId, guest);
  await resumeSucceeds(restored, reserved.reservation.gameId);
});

test('#260 a start refused before its reservation still reopens the room', { timeout: TIMEOUT }, async (t) => {
  const { acquireOwnedLock, releaseOwnedLock } = await import('../engine/state.js');
  const { storeDir, manager, app } = await boot(t);
  await openRoomWithGuest(app, manager);
  const owner = acquireOwnedLock(storeDir, 'loop.lock.d');
  t.after(() => releaseOwnedLock(owner));
  const start = { ...cas(manager), setup: POLICY_ROOM };
  manager.command(start);
  const refused = await settle(manager, start.requestId);
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error, 'ACTIVE_GAME');
  assert.equal(refused.reservation, undefined);
  assert.equal(resolveCurrentSession(storeDir), null);
  assert.equal(manager.room.load().status, 'open');
  assert.equal(manager.room.load().lock.boundGameId, null);
});

test('#260 a recovered start whose reservation was never committed reopens the room', { timeout: TIMEOUT }, async (t) => {
  const { storeDir, manager, app } = await boot(t);
  await openRoomWithGuest(app, manager);
  const start = { ...cas(manager), setup: POLICY_ROOM };
  manager.command(start);
  const started = await settle(manager, start.requestId);
  assert.equal(started.status, 'succeeded');
  const previous = resolveCurrentSession(storeDir);
  await endGame(manager);
  assert.equal(manager.room.load().status, 'open');
  await manager.close();
  // The CAS still names the ended game, but the reservation no longer follows its
  // selection, so prepareSession refuses it after onReserve and before any commit.
  const stale = { ...started, requestId: randomUUID(), expectedGameId: previous.gameId,
    expectedSelectionVersion: previous.selectionVersion,
    reservation: { gameId: randomUUID(), selectionVersion: previous.selectionVersion } };
  crashBeforeFinishing(storeDir, stale);
  const restored = restartApp(t, storeDir, resolver);
  await restored.initialize();
  assert.equal(restored.receipt(stale.requestId).status, 'failed');
  assert.equal(restored.receipt(stale.requestId).error, 'CURRENT_CHANGED');
  assert.equal(resolveCurrentSession(storeDir).gameId, previous.gameId);
  assert.equal(restored.room.load().status, 'open');
  assert.equal(restored.room.load().lock.boundGameId, null);
  assert.equal(restored.room.load().lock.requestId, null);
});

test('#260 a recovered start whose reservation lost to another commit leaves that game unbound', { timeout: TIMEOUT }, async (t) => {
  const { prepareSession, commitSession } = await import('../engine/session-catalog.js');
  const { initializePreparedSession } = await import('../tools/game-loop.js');
  const { storeDir, manager, app } = await boot(t);
  const guest = await openRoomWithGuest(app, manager);
  const start = { ...cas(manager), setup: POLICY_ROOM };
  await manager.close();
  // While the app was down after reserving its game, a standalone launcher committed another.
  const prepared = prepareSession(storeDir);
  await initializePreparedSession(prepared.stagingDir, { ai: 2, opponentRuntime: 'policy' });
  const other = commitSession(storeDir, prepared);
  const row = { ...start, payload: 'crashed', roomLocked: true, acceptedAt: new Date().toISOString(),
    setup: { ...POLICY_ROOM, hostName: '호스트', participants: [{ playerId: 'h1', name: '민준', participantId: guest.participantId }], actionTimeoutSec: 60 },
    reservation: { gameId: randomUUID(), selectionVersion: 1 } };
  crashBeforeFinishing(storeDir, row);
  const restored = restartApp(t, storeDir, resolver);
  await restored.initialize();
  assert.equal(restored.receipt(row.requestId).error, 'CURRENT_CHANGED');
  assert.equal(resolveCurrentSession(storeDir).gameId, other.gameId);
  assert.equal(restored.room.load().status, 'open');
  assert.equal(restored.room.load().lock.boundGameId, null);
});

test('#260 a start that can never succeed can still end, which reopens the room', { timeout: TIMEOUT }, async (t) => {
  const probe = probeFailingOnce();
  const { storeDir, manager, app } = await boot(t, { resolver: probe.resolver });
  const guest = await openRoomWithGuest(app, manager);
  probe.alwaysFail = true;
  const start = { ...cas(manager), setup: LLM_ROOM };
  manager.command(start);
  assert.equal((await settle(manager, start.requestId)).error, 'NO_PLAYER_RUNTIME');
  const committed = resolveCurrentSession(storeDir);
  assertRoomBoundTo(manager, committed.gameId, guest);
  assert.deepEqual(manager.snapshot().recoveryExit, { mode: 'abort' });
  assert.deepEqual(manager.snapshot().allowedCommands, ['resume', 'end', 'restart']);
  const resume = cas(manager, 'resume');
  manager.command(resume);
  assert.equal((await settle(manager, resume.requestId)).error, 'NO_PLAYER_RUNTIME');
  assertRoomBoundTo(manager, committed.gameId, guest);
  // After an app restart the error is SESSION_RECOVERABLE and the exit stays open.
  await manager.close();
  const restored = restartApp(t, storeDir, probe.resolver);
  await restored.initialize();
  assert.equal(restored.snapshot().error, 'SESSION_RECOVERABLE');
  assert.deepEqual(restored.snapshot().allowedCommands, ['resume', 'end', 'restart']);
  const end = cas(restored, 'end');
  restored.command(end);
  const ended = await settle(restored, end.requestId);
  assert.equal(ended.status, 'succeeded', JSON.stringify({ error: ended.error, snap: restored.snapshot().error }));
  assert.equal(ended.recovery.reason, 'START_FAILED');
  assert.equal(restored.snapshot().state, 'ended');
  const audit = JSON.parse(fs.readFileSync(path.join(committed.sessionDir, 'loop-state.json'), 'utf8'));
  assert.equal(audit.abandonedPendingDecision?.reason, 'START_FAILED');
  assert.equal(restored.room.load().status, 'open');
  probe.alwaysFail = false;
  const next = { ...cas(restored), setup: POLICY_ROOM };
  restored.command(next);
  assert.equal((await settle(restored, next.requestId)).status, 'succeeded');
  assertRoomBoundTo(restored, restored.snapshot().gameId, guest);
});

test('#260 a failed recovery of a reserved game that already ended does not bind the room', { timeout: TIMEOUT }, async (t) => {
  const { acquireOwnedLock, releaseOwnedLock } = await import('../engine/state.js');
  const { storeDir, manager, app } = await boot(t);
  await openRoomWithGuest(app, manager);
  const start = { ...cas(manager), setup: POLICY_ROOM };
  manager.command(start);
  const started = await settle(manager, start.requestId);
  assert.equal(started.status, 'succeeded');
  await endGame(manager);
  await manager.close();
  // The start row never finished although its game did (e.g. a crash, then a CLI end).
  crashBeforeFinishing(storeDir, started);
  const owner = acquireOwnedLock(storeDir, 'loop.lock.d');
  t.after(() => releaseOwnedLock(owner));
  const restored = restartApp(t, storeDir, resolver);
  await restored.initialize();
  assert.equal(restored.receipt(start.requestId).error, 'ACTIVE_GAME');
  assert.equal(resolveCurrentSession(storeDir).gameId, started.reservation.gameId);
  assert.equal(restored.room.load().status, 'open');
  assert.equal(restored.room.load().lock.boundGameId, null);
});

test('#260 a recovered replace-current binds the room to the game it commits', { timeout: TIMEOUT }, async (t) => {
  const probe = probeFailingOnce();
  const { storeDir, manager, app } = await boot(t, { resolver: probe.resolver });
  const guest = await openRoomWithGuest(app, manager);
  const start = { ...cas(manager), setup: POLICY_ROOM };
  manager.command(start);
  const started = await settle(manager, start.requestId);
  assert.equal(started.status, 'succeeded');
  const previous = resolveCurrentSession(storeDir);
  await pauseWhenPlaying(manager);
  await manager.close();
  // A replace-current row the app accepted and then lost before reserving its game.
  const replace = { requestId: randomUUID(), expectedInstanceId: 'crashed', expectedAppRevision: 1,
    expectedGameId: previous.gameId, expectedSelectionVersion: previous.selectionVersion, kind: 'replace-current',
    setup: { ...started.setup, opponentRuntime: 'llm' }, payload: 'crashed', roomLocked: true,
    acceptedAt: new Date().toISOString() };
  crashBeforeFinishing(storeDir, replace, { status: 'locked', boundGameId: previous.gameId, requestId: start.requestId });
  probe.failNext = true;
  const restored = restartApp(t, storeDir, probe.resolver);
  await restored.initialize();
  const failed = restored.receipt(replace.requestId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'NO_PLAYER_RUNTIME');
  const committed = resolveCurrentSession(storeDir);
  assert.equal(committed.gameId, failed.reservation.gameId);
  assert.notEqual(committed.gameId, previous.gameId);
  assertRoomBoundTo(restored, committed.gameId, guest);
  await resumeSucceeds(restored, committed.gameId);
});

test('#260 closing the app during a start keeps the committed game bound', { timeout: TIMEOUT }, async (t) => {
  const probe = probeFailingOnce();
  const { storeDir, manager, app } = await boot(t, { resolver: probe.resolver });
  const guest = await openRoomWithGuest(app, manager);
  let release;
  const entering = new Promise((resolve) => { probe.entered = resolve; });
  probe.gate = new Promise((resolve) => { release = resolve; });
  const start = { ...cas(manager), setup: LLM_ROOM };
  manager.command(start);
  await entering;
  const closing = manager.close();
  setTimeout(release, 30);
  await closing;
  probe.gate = null;
  const failed = manager.receipt(start.requestId);
  assert.equal(failed.status, 'failed');
  const committed = resolveCurrentSession(storeDir);
  assert.equal(committed.gameId, failed.reservation.gameId);
  assertRoomBoundTo(manager, committed.gameId, guest);
  const restored = restartApp(t, storeDir, probe.resolver);
  await restored.initialize();
  assertRoomBoundTo(restored, committed.gameId, guest);
  await resumeSucceeds(restored, committed.gameId);
});

test('late spectator API is read-only and promotion only affects the next game', {timeout:TIMEOUT}, async t => {
  const {manager,app}=await boot(t);
  manager.room.open({hostName:'Host',totalSeats:3,actionTimeoutSec:60});
  const origin=`http://127.0.0.1:${app.publicPort}`;
  const join=async name=>(await jsonOf(await fetch(`${origin}/api/join`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:manager.room.load().joinCode,name})}))).body;
  const guest=await join('Guest');
  const start={...cas(manager),setup:{mode:'cash-training',totalSeats:3,opponentRuntime:'policy',hints:'off',dealBias:'off'}};
  manager.command(start);assert.equal((await settle(manager,start.requestId)).status,'succeeded');await waitPlaying(manager);
  const pause=cas(manager,'pause');manager.command(pause);assert.equal((await settle(manager,pause.requestId)).status,'succeeded');
  const observer=await join('Observer');assert.equal(observer.roomRole,'spectator');
  const snap=manager.snapshot();
  const read=async(pathname,who=observer,options={})=>jsonOf(await fetch(`${origin}${pathname}`,{
    ...options,headers:{authorization:`Bearer ${who.participantToken}`,'x-game-epoch':snap.gameEpoch,'content-type':'application/json',...options.headers}}));
  const prefix=`/api/p/game/${snap.gameId}`;
  const observed=await read(`${prefix}/snapshot`,observer,{headers:{'x-loop-probe':'1'}});assert.equal(observed.status,200,JSON.stringify(observed.body));
  assert.ok(Object.keys(observed.body.view.holeCardsByPlayerId).length===3);
  assert.equal(observed.body.view.viewer,null);assert.equal(observed.body.coach,undefined);
  const snapshotFile=path.join(manager.current.sessionDir,'ui-snapshot.json');
  const originalRead=fs.readFileSync;let viewReads=0;
  try {
    fs.readFileSync=(file,...args)=>{if(String(file)===snapshotFile)viewReads++;return originalRead(file,...args);};
    for(let i=0;i<4;i++)assert.equal((await read('/api/p/state')).body.me.viewerRole,'spectator');
    assert.ok(viewReads<=1,`unchanged committed view was parsed ${viewReads} times`);
  } finally {fs.readFileSync=originalRead;}
  const playing=await read(`${prefix}/snapshot`,guest,{headers:{'x-seat':'spectator','x-loop-probe':'1'}});
  assert.equal(playing.body.view.holeCardsByPlayerId,undefined);
  assert.equal(playing.body.view.viewer,'h1');
  assert.equal((await read(`${prefix}/snapshot?seat=spectator`,guest)).status,400);
  for(const endpoint of ['action','action-status']) {
    const result=await read(`${prefix}/${endpoint}`,observer,endpoint==='action'?{method:'POST',body:'{}'}:{});
    assert.equal(result.status,403);assert.equal(result.body.code,'SPECTATOR_READ_ONLY');
  }
  const before=JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir,'players.json'),'utf8'));
  assert.equal(before.length,3);assert.equal(before.some(p=>p.participantId===observer.participantId),false);
  const oldCode=manager.room.load().joinCode;manager.room.rotateCode();assert.notEqual(manager.room.load().joinCode,oldCode);
  assert.equal((await read(`${prefix}/snapshot`)).status,200);
  const end=cas(manager,'end');manager.command(end);assert.equal((await settle(manager,end.requestId)).status,'succeeded');
  const state=await read('/api/p/state');assert.equal(state.body.room.canRequestSeat,true);
  assert.equal(state.body.me.roomRole,'spectator');assert.ok(state.body.game.final);
  const requested=await read('/api/p/seat-request',observer,{method:'POST',body:JSON.stringify({expectedRoomId:state.body.room.roomId,expectedRevision:state.body.room.revision})});
  assert.equal(requested.status,200);
  const restart={...cas(manager,'start'),setup:{mode:'cash-training',totalSeats:3,opponentRuntime:'policy',hints:'off',dealBias:'off'}};
  manager.command(restart);assert.equal((await settle(manager,restart.requestId)).status,'succeeded');await waitPlaying(manager);
  const next=manager.snapshot();assert.notEqual(next.gameId,snap.gameId);
  const nextSnapshot=await read(`/api/p/game/${next.gameId}/snapshot`,observer,{headers:{'x-game-epoch':next.gameEpoch}});
  assert.equal(nextSnapshot.status,200);assert.equal(nextSnapshot.body.view.viewer,'h2');
  assert.equal(nextSnapshot.body.view.holeCardsByPlayerId,undefined);
  assert.equal((await read(`${prefix}/snapshot`)).status,409);
});

test('TLS requires both files; http when absent', async (t) => {
  await assert.rejects(
    () => startAppServer({
      manager: { snapshot: () => ({}), current: null, session: null, command() {}, receipt() {} },
      token: TOKEN, storeDir: createOwnedTempDir('tls-missing'), port: 0, publicPort: 0, tlsCert: '/tmp/missing.pem',
    }),
    { code: 'USAGE' },
  );
  const dir = createOwnedTempDir('tls-ok');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ], { encoding: 'utf8' });
  if (openssl.status !== 0) {
    t.diagnostic(`openssl unavailable: ${openssl.stderr || openssl.error}`);
    return;
  }
  const { app } = await boot(t, { publicPort: 0, tlsCert: cert, tlsKey: key });
  const status = await new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${app.publicPort}/join`, { rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 200);
});
