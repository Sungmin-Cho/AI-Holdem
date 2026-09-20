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

async function boot(t, { publicPort = 0, tlsCert, tlsKey } = {}) {
  const storeDir = createOwnedTempDir('holdem-public');
  const manager = createSessionManager({ storeDir, resolver });
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
