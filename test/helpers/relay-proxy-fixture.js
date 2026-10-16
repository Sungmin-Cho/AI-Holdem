// #270 fixtures: a recording fake relay listener, a session store, a loop stand-in that wraps
// the production `createRelayAccess` factory with deterministic OS seams, and an app server
// around them. The listener's raw `connections`/`requests` counters are the leak boundary:
// a denied request must leave both at zero, whatever status the app answers with.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createOwnedTempDir, registerOwnedServer } from './owned-fixtures.mjs';
import { startAppServer } from '../../tools/app-server.js';
import { createRoomManager } from '../../tools/room-manager.js';

export const HOST_TOKEN = 'host-secret-token';
export const SESSION_TOKEN = 'b'.repeat(64);
export const OWNED_START = 'utc-v1:Thu Jan  1 00:00:00 2026';
export const OTHER_START = 'utc-v1:Fri Jan  2 00:00:00 2026';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Baseline-only fallback: on a commit without tools/relay-access.js the stand-in loop keeps the
// legacy `{serverPid}` shape, which is exactly what the vulnerable app trusts. The production
// code has no such fallback; a loop without `captureRelayAccess` is refused there.
const relayAccessModule = await import('../../tools/relay-access.js').catch(() => null);

export async function fakeRelay() {
  const seen = { connections: 0, requests: [], redirectTo: null };
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://relay.invalid');
      seen.requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
      });
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: hello\n\n');
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (seen.redirectTo) {
        res.writeHead(302, { location: seen.redirectTo });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, view: { viewer: req.headers['x-seat'] } }));
    });
  });
  server.on('connection', () => { seen.connections += 1; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    seen,
    port: server.address().port,
    openStreams: () => streams.size,
    push: (text) => { for (const res of streams) res.write(text); },
    // Abruptly closes every open event stream's socket (a relay crash seen from the proxy).
    drop: () => { for (const res of streams) res.destroy(); },
    untouched: () => seen.connections === 0 && seen.requests.length === 0,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

export function replaceJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function makeSession(root, port, { lock = {}, sessionToken = SESSION_TOKEN } = {}) {
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const lockPath = path.join(sessionDir, 'lock.json');
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(lockPath, JSON.stringify({
    serverPid: process.pid, port, sessionToken, controlProtocolVersion: 1,
    serverStartTime: OWNED_START, startedAt: new Date().toISOString(), ...lock,
  }));
  fs.writeFileSync(statePath, JSON.stringify({ sessionToken, seats: [] }));
  return {
    sessionDir, lockPath, statePath, sessionToken, port, gameEpoch: sha256(sessionToken),
    readLock: () => JSON.parse(fs.readFileSync(lockPath, 'utf8')),
    rewriteLock: (patch) => replaceJson(lockPath, { ...JSON.parse(fs.readFileSync(lockPath, 'utf8')), ...patch }),
    rewriteState: (patch) => replaceJson(statePath, { ...JSON.parse(fs.readFileSync(statePath, 'utf8')), ...patch }),
  };
}

export function accessDeps(session, state, calls) {
  return {
    lockPath: session.lockPath,
    statePath: session.statePath,
    managed: true,
    binding: () => state.binding,
    isStopping: () => state.stopping,
    startTimeOf: (pid) => { calls.startTime += 1; return state.startTimeOf(pid); },
    listenerOwnedBy: async (pid, port, call) => { calls.listener += 1; return state.listener(pid, port, call); },
    probeMs: 50,
    maxConcurrent: state.maxConcurrent,
  };
}

export function makeState(session, patch = {}) {
  return {
    binding: { pid: process.pid, startTime: OWNED_START, port: session.port, sessionToken: session.sessionToken },
    stopping: false,
    startTimeOf: () => OWNED_START,
    listener: async () => true,
    ...patch,
  };
}

// A loop stand-in. `state` is the mutable truth the production seams read (binding object,
// stopping flag, OS answers); `calls` counts OS seam use; `captured` resolves at the first capture.
export function makeLoop(session, patch = {}) {
  const state = makeState(session, patch);
  const calls = { listener: 0, startTime: 0, captures: 0 };
  let markCaptured;
  const loop = { serverPid: process.pid, state, calls, captured: new Promise((resolve) => { markCaptured = resolve; }) };
  if (relayAccessModule) {
    const access = relayAccessModule.createRelayAccess(accessDeps(session, state, calls));
    loop.access = access;
    loop.captureRelayAccess = () => {
      calls.captures += 1;
      const capability = access.capture();
      markCaptured();
      const settled = deferred();
      loop.lastUseSettled = settled.promise;
      return Object.freeze({
        use: (...args) => capability.use(...args).finally(() => settled.resolve()),
      });
    };
  } else {
    // Baseline only: the vulnerable app reads `serverPid` before it waits for a body, so that
    // read is the closest observable "capture" point there.
    Object.defineProperty(loop, 'serverPid', { get() { markCaptured(); return process.pid; } });
  }
  return loop;
}

export async function startProxyApp(t, { loop, relay, session, state = 'playing' }) {
  const roomStore = createOwnedTempDir('relay-proxy-room');
  const room = createRoomManager({ storeDir: roomStore });
  const ctx = { gameId: randomUUID(), epoch: session.gameEpoch, state };
  const current = { gameId: ctx.gameId, sessionDir: session.sessionDir, selectionVersion: 1 };
  const manager = {
    ctx,
    snapshot: () => ({
      state: ctx.state, instanceId: 'i', appRevision: 1, gameId: ctx.gameId, gameEpoch: ctx.epoch,
      selectionVersion: 1, allowedCommands: ['pause'],
    }),
    command: () => ({ requestId: 'x', status: 'rejected' }),
    receipt: () => ({ requestId: 'x', status: 'rejected' }),
    current,
    session: { loop },
    room,
  };
  const app = await startAppServer({ manager, token: HOST_TOKEN, storeDir: roomStore, port: 0, publicPort: 0 });
  registerOwnedServer(app.server, 'app-loopback');
  t.after(() => app.close());
  const hostHeaders = (extra = {}) => ({
    authorization: `Bearer ${HOST_TOKEN}`, 'content-type': 'application/json', 'x-game-epoch': ctx.epoch, ...extra,
  });
  const hostUrl = (endpoint, query = '') => `${app.origin}/api/game/${ctx.gameId}/${endpoint}${query}`;
  const hostGet = (endpoint, query = '') => fetch(hostUrl(endpoint, query), { headers: hostHeaders() });
  const actionBody = () => JSON.stringify({ decisionId: 'd-1-preflop-0', requestId: randomUUID(), action: 'fold', note: 'secret', seat: 'user' });
  const hostPost = () => fetch(hostUrl('action'), { method: 'POST', headers: hostHeaders(), body: actionBody() });
  return { app, manager, room, ctx, relay, session, loop, hostHeaders, hostUrl, hostGet, hostPost, actionBody };
}

export async function joinGuest(h, name, expectRole) {
  if (!h.room.load()) {
    const opened = await fetch(`${h.app.origin}/api/room`, {
      method: 'POST', headers: { authorization: `Bearer ${HOST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 4, actionTimeoutSec: 60 }),
    });
    if (opened.status !== 200) throw new Error(`room open ${opened.status}`);
  }
  const joined = await fetch(`http://127.0.0.1:${h.app.publicPort}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: h.room.load().joinCode, name }),
  });
  const guest = await joined.json();
  if (joined.status !== 200) throw new Error(`join ${joined.status} ${JSON.stringify(guest)}`);
  if (expectRole && guest.roomRole !== expectRole) throw new Error(`role ${guest.roomRole}`);
  return guest;
}

export const publicUrl = (h, endpoint, query = '') => `http://127.0.0.1:${h.app.publicPort}/api/p/game/${h.ctx.gameId}/${endpoint}${query}`;
export const guestHeaders = (h, guest, extra = {}) => ({
  authorization: `Bearer ${guest.participantToken}`, 'content-type': 'application/json', 'x-game-epoch': h.ctx.epoch, ...extra,
});

// POST whose body arrives in two parts. `afterFirst` runs once the first part is on the wire;
// callers await `loop.captured` there, so the app is provably past its capture and still
// waiting for the body when they change the world.
export function postSplit(url, headers, first, second, afterFirst) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'POST', agent: false,
      headers: { ...headers, 'content-length': Buffer.byteLength(first) + Buffer.byteLength(second) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.write(first);
    Promise.resolve().then(afterFirst).then(() => request.end(second), reject);
  });
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
