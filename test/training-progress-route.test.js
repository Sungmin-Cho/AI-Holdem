// Issue #351: the lobby reads the play report's comparable-hand progress through a host-only route
// on the loopback listener (tools/app-server.js GET /api/training-progress).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDeck } from '../engine/cards.js';
import { ensureSessionStore } from '../engine/session-catalog.js';
import { remoteRouteOf, startAppServer } from '../tools/app-server.js';
import { setHostPassword } from '../tools/app-service.js';
import { createPlayReportReader } from '../tools/play-report-store.js';
import { buildPlayReport, emptyGameSummary, playReportView } from '../training/play-report.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { createReplayGame } from './helpers/replay-library-fixture.mjs';

const ROUTE = '/api/training-progress';
const ZERO = { hands: 0, target: 200, line: '비교 가능한 핸드 0 / 200 (6인 · 100BB · 정책 v3)' };
const FIXTURES = fileURLToPath(new URL('./fixtures/remote-host-tls/', import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function presetReport(hands) {
  const game = emptyGameSummary({ gameId: 'g', savedAt: '2026-11-16T00:00:00.000Z', mode: 'cash-training', opponent: 'policy', solo: true,
    policy: '3.0.0', seats: 6, stackBb: 100 });
  game.hands = hands; game.heroHands = hands;
  game.results = { hands, netBb: 0, adjBb: 0, adjSqBb: 0, allIns: 0, luckBb: 0, unrevealed: 0 };
  return buildPlayReport([game]);
}
// A reader whose scans finish when the test says so; every read and its signal are recorded.
function heldReader() {
  const scans = [];
  return {
    scans,
    read(options = {}) {
      const scan = { options };
      scan.promise = new Promise((resolve, reject) => {
        scan.finish = (hands) => resolve({ report: presetReport(hands), view: null });
        scan.fail = () => reject(new Error('broken'));
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('REPLAY_ABORTED'), { code: 'REPLAY_ABORTED' })), { once: true });
      });
      scans.push(scan);
      return scan.promise;
    },
  };
}
async function server(t, { reader = null, snapshot = { gameId: null, state: 'lobby' }, ...options } = {}) {
  const store = createOwnedTempDir('training-progress');
  ensureSessionStore(store);
  const view = { ...snapshot };
  // Each request reads the snapshot once for its key: the count tells a test the request has arrived.
  let snapshots = 0;
  const manager = { current: null, snapshot: () => { snapshots += 1; return view; } };
  const app = await startAppServer({ manager, token: 'host', storeDir: store, publicPort: 0, ...(reader ? { playReport: reader } : {}), ...options });
  t.after(() => app.close());
  const get = async (headers = {}) => {
    const response = await fetch(app.origin + ROUTE, { headers: { authorization: 'Bearer host', connection: 'close', ...headers } });
    return { status: response.status, body: await response.json() };
  };
  return { app, store, view, get, snapshots: () => snapshots };
}
const settle = () => new Promise((resolve) => { setImmediate(resolve); });
const until = async (predicate) => {
  for (let waited = 0; !predicate(); waited += 5) {
    assert.ok(waited < 5000, 'condition not reached');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
};

test('the progress route belongs to the loopback host: no token, foreign origin, other method, public or remote listener', async (t) => {
  const store = createOwnedTempDir('training-progress-remote');
  ensureSessionStore(store);
  await setHostPassword(store, 'remote host password');
  const reads = [];
  const reader = { read(options) { reads.push(options); return Promise.resolve({ report: buildPlayReport([]), view: null }); } };
  const manager = { current: null, snapshot: () => ({ gameId: null, state: 'lobby' }) };
  const app = await startAppServer({ manager, token: 'host', storeDir: store, publicPort: 0, playReport: reader,
    remoteHost: { port: 0, listen: '127.0.0.1', names: ['localhost'], tlsCert: path.join(FIXTURES, 'a.crt'), tlsKey: path.join(FIXTURES, 'a.key'),
      authOptions: { failureDelayMs: 0 } } });
  t.after(() => app.close());
  const url = app.origin + ROUTE;
  assert.equal((await fetch(url, { headers: { connection: 'close' } })).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer wrong', connection: 'close' } })).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer host', origin: 'https://evil.test', connection: 'close' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer host', connection: 'close' }, body: '{}' })).status, 405);
  // The participant listener has no host route, whatever credential is shown.
  for (const headers of [{}, { authorization: 'Bearer host' }]) {
    assert.equal((await fetch(app.publicOrigin + ROUTE, { headers: { ...headers, connection: 'close' } })).status, 404);
  }
  // The remote host listener: classified as not found before authentication, and still 404 with a session.
  assert.equal(remoteRouteOf(ROUTE), 'not-found');
  const remote = (method, target, headers = {}, body) => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: app.remoteHostPort, method, path: target, servername: 'localhost',
      ca: fs.readFileSync(path.join(FIXTURES, 'a.crt')), agent: false,
      headers: { host: `localhost:${app.remoteHostPort}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const login = await remote('POST', '/api/host/login', {}, { password: 'remote host password' });
  assert.equal(login.status, 200);
  const session = { authorization: `Bearer ${login.json.token}` };
  assert.equal((await remote('GET', '/api/app', session)).status, 200, 'fixture: the session works on a listed route');
  assert.equal((await remote('GET', ROUTE, session)).status, 404);
  assert.equal((await remote('GET', ROUTE)).status, 404);
  assert.equal(reads.length, 0, 'neither the participant nor the remote listener reached the reader');
  // The loopback host gets the closed DTO.
  const response = await fetch(url, { headers: { authorization: 'Bearer host', connection: 'close' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, progress: ZERO });
  assert.equal(reads.length, 1);
});

test('past the deadline the answer is pending, and the scan that finishes later reaches the next request', async (t) => {
  const reader = heldReader();
  const { get } = await server(t, { reader, progressWaitMs: 40 });
  // Concurrent requests share one scan.
  const answers = await Promise.all([get(), get(), get()]);
  for (const answer of answers) assert.deepEqual(answer, { status: 200, body: { ok: true, progress: null, pending: true } });
  assert.equal(reader.scans.length, 1);
  assert.ok(reader.scans[0].options.signal, 'the route gives its scan a lifetime of its own');
  // The scan ends between requests: the next request is answered from it, without a new scan.
  reader.scans[0].finish(80);
  await settle();
  const next = await get();
  assert.deepEqual(next, { status: 200, body: { ok: true, progress: { hands: 80, target: 200, line: '비교 가능한 핸드 80 / 200 (6인 · 100BB · 정책 v3)' } } });
  assert.equal(reader.scans.length, 1);
  // Within the deadline the request is answered by the scan itself.
  const quick = heldReader();
  const fast = await server(t, { reader: quick, progressWaitMs: 2000 });
  const pending = fast.get();
  await until(() => quick.scans.length === 1);
  quick.scans[0].finish(5);
  assert.equal((await pending).body.progress.hands, 5);
});

test('a finished result is reused only briefly and only for the same game state; a slow rescan shows the last one as pending', async (t) => {
  const reader = heldReader();
  const { get, view } = await server(t, { reader, progressWaitMs: 30, progressFreshMs: 60_000 });
  await get();
  reader.scans[0].finish(80);
  await settle();
  assert.equal((await get()).body.progress.hands, 80);
  assert.equal((await get()).body.progress.hands, 80);
  assert.equal(reader.scans.length, 1, 'the same game state within the reuse window: no new scan');
  // A game finished meanwhile: the state changed, so the hands it added are read.
  Object.assign(view, { gameId: '00000000-0000-4000-8000-000000000001', state: 'completed' });
  assert.deepEqual((await get()).body, { ok: true, progress: { hands: 80, target: 200, line: '비교 가능한 핸드 80 / 200 (6인 · 100BB · 정책 v3)' }, pending: true });
  assert.equal(reader.scans.length, 2);
  reader.scans[1].finish(130);
  await settle();
  assert.equal((await get()).body.progress.hands, 130);
  // Past the reuse window the same state is read again.
  const short = heldReader();
  const brief = await server(t, { reader: short, progressWaitMs: 30, progressFreshMs: 1 });
  await brief.get();
  short.scans[0].finish(10);
  await settle();
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  await brief.get();
  assert.equal(short.scans.length, 2);
});

test('a scan started under another game state answers as pending, so the current state is read next', async (t) => {
  const reader = heldReader();
  const { get, view, snapshots } = await server(t, { reader, progressWaitMs: 5000 });
  const before = get();
  await until(() => reader.scans.length === 1);
  // The game finishes while the scan is still reading: a request now joins the running scan.
  Object.assign(view, { gameId: '00000000-0000-4000-8000-000000000002', state: 'completed' });
  const seen = snapshots();
  const after = get();
  await until(() => snapshots() > seen);
  assert.equal(reader.scans.length, 1, 'the second request joined the running scan: no overlapping scan');
  reader.scans[0].finish(80);
  const line = '비교 가능한 핸드 80 / 200 (6인 · 100BB · 정책 v3)';
  assert.deepEqual((await before).body, { ok: true, progress: { hands: 80, target: 200, line } }, 'the request it was started for');
  assert.deepEqual((await after).body, { ok: true, progress: { hands: 80, target: 200, line }, pending: true }, 'read under the old state');
  assert.equal(reader.scans.length, 1, 'answered from the joined scan, not from a scan of its own');
  // The lobby asks again: that request reads the current state.
  const again = get();
  await until(() => reader.scans.length === 2);
  reader.scans[1].finish(130);
  assert.equal((await again).body.progress.hands, 130);
  assert.equal((await again).body.pending, undefined);
});

test('closing the server drops the route\'s share of a running scan', async (t) => {
  const reader = heldReader();
  const { app, get } = await server(t, { reader, progressWaitMs: 20 });
  assert.equal((await get()).body.pending, true);
  // Another consumer of the same reader (the game loop) reads without the route's signal.
  const other = reader.read();
  other.catch(() => {});
  await app.close();
  assert.equal(reader.scans[0].options.signal.aborted, true);
  assert.equal(reader.scans[1].options.signal, undefined, 'the other consumer is not cut off');
});

test('the route gives up its scan at the end of its lifetime, and a failed scan is an error the lobby hides', async (t) => {
  const reader = heldReader();
  const { get } = await server(t, { reader, progressWaitMs: 20, progressWorkMs: 60 });
  assert.equal((await get()).body.pending, true);
  await until(() => reader.scans[0].options.signal.aborted);
  await settle();
  // The given-up scan is gone: the next request starts another.
  assert.equal((await get()).body.pending, true);
  assert.equal(reader.scans.length, 2);
  reader.scans[1].fail();
  await settle();
  const failing = heldReader();
  const broken = await server(t, { reader: failing, progressWaitMs: 2000 });
  const answer = broken.get();
  await until(() => failing.scans.length === 1);
  failing.scans[0].fail();
  assert.deepEqual(await answer, { status: 503, body: { code: 'PROGRESS_UNAVAILABLE' } });
  // A reader whose report has no progress (a malformed result) is an error too.
  const odd = await server(t, { reader: { read: async () => ({ report: { schemaVersion: 99 } }) } });
  assert.deepEqual(await odd.get(), { status: 503, body: { code: 'PROGRESS_UNAVAILABLE' } });
});

// Real engine records, read by the store's reader: a six-handed cash game at 100BB whose AI actions
// carry the policy version a v3 game records.
function presetGame(store, hands) {
  const game = createReplayGame(store, { aiCount: 5, hands });
  const state = readJson(path.join(game.sessionDir, 'state.json'));
  state.config.opponentRuntime = 'policy';
  writeJson(path.join(game.sessionDir, 'state.json'), state);
  for (let handNo = 1; handNo <= hands; handNo += 1) {
    const record = readJson(game.handPath(handNo));
    for (const action of record.actions) if (action.playerId !== 'user') Object.assign(action, { policyId: 'tag-v3', policyVersion: '3.0.0' });
    writeJson(game.handPath(handNo), record);
  }
  return game;
}

test('recorded games are counted as the play report counts them, and a participant\'s hidden cards change nothing', async (t) => {
  const build = async () => {
    // The scan of a real store is not what is timed here: the request may wait for it.
    const { store, get } = await server(t, { progressWaitMs: 60_000 });
    presetGame(store, 3);
    // Left out: another human at the table (and with hidden cards), an older policy version.
    const guest = createReplayGame(store, { aiCount: 1, hands: 2, mode: 'tournament', participants: [{ playerId: 'h1', participantId: 'pt-1', name: 'Guest' }], foldFirst: true });
    const older = presetGame(store, 2);
    for (let handNo = 1; handNo <= 2; handNo += 1) {
      const record = readJson(older.handPath(handNo));
      for (const action of record.actions) if (action.playerId !== 'user') action.policyVersion = '2.2.0';
      writeJson(older.handPath(handNo), record);
    }
    return { get, guest };
  };
  const a = await build();
  const b = await build();
  const record = readJson(b.guest.handPath(1));
  assert.ok(record.folded.includes('h1'), 'fixture: the guest folded');
  assert.ok(!(record.showdown?.reveals ?? []).some((row) => row.playerId === 'h1'), 'fixture: the guest showed nothing');
  const used = new Set([...Object.values(record.holes).flat(), ...record.board]);
  const other = newDeck().filter((card) => !used.has(card)).slice(0, 2);
  record.holes.h1 = other;
  for (const decision of record.decisions ?? []) if (decision.actorId === 'h1') decision.holeCards = other;
  writeJson(b.guest.handPath(1), record);
  const answerA = await a.get();
  const answerB = await b.get();
  assert.deepEqual(answerA, { status: 200, body: { ok: true, progress: { hands: 3, target: 200, line: '비교 가능한 핸드 3 / 200 (6인 · 100BB · 정책 v3)' } } });
  assert.deepEqual(answerB, answerA);
  // The same count is what the study room's report shows.
  assert.equal(playReportView(presetReport(3)).progress, answerA.body.progress.line);
});

// The store's own reader, with a scan another consumer (the game loop's boot) started and holds at a
// gate after its first hand: games added after it listed the store are not in it.
function gatedReader(store) {
  let release;
  let arrived;
  const entered = new Promise((resolve) => { arrived = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let reduced = 0;
  const reader = createPlayReportReader(store, { yieldTurn: async () => { reduced += 1; if (reduced === 1) { arrived(); await gate; } } });
  return { reader, entered, release };
}

test('a scan the game loop started is joined but not trusted: the next request reads the store again', async (t) => {
  const store = createOwnedTempDir('training-progress-joined');
  ensureSessionStore(store);
  presetGame(store, 3);
  const held = gatedReader(store);
  t.after(() => held.release());
  const boot = held.reader.read();                     // the loop's read, without a signal
  await held.entered;
  presetGame(store, 2);                                // hands finished after that scan listed the store
  let snapshots = 0;
  const app = await startAppServer({ manager: { current: null, snapshot: () => { snapshots += 1; return { gameId: null, state: 'lobby' }; } },
    token: 'host', storeDir: store, publicPort: 0, playReport: held.reader, progressWaitMs: 60_000 });
  t.after(() => app.close());
  const ask = async () => (await fetch(app.origin + ROUTE, { headers: { authorization: 'Bearer host', connection: 'close' } })).json();
  assert.equal(held.reader.scanning(), true);
  const seen = snapshots;
  const joined = ask();
  // The route reads its key and joins the reader in one turn: once the key is read, it has joined.
  await until(() => snapshots > seen);
  held.release();
  assert.deepEqual(await joined, { ok: true, progress: { hands: 3, target: 200, line: '비교 가능한 핸드 3 / 200 (6인 · 100BB · 정책 v3)' }, pending: true },
    'the joined scan had not seen the newer game');
  assert.equal((await boot).report.scope.heroHands, 3);
  // The lobby asks again: the route reads for itself and finds both games.
  assert.deepEqual(await ask(), { ok: true, progress: { hands: 5, target: 200, line: '비교 가능한 핸드 5 / 200 (6인 · 100BB · 정책 v3)' } });
});

test('closing the server while it waits on the loop\'s scan leaves that scan to the loop', async (t) => {
  const store = createOwnedTempDir('training-progress-close');
  ensureSessionStore(store);
  presetGame(store, 3);
  const held = gatedReader(store);
  t.after(() => held.release());
  const boot = held.reader.read();
  await held.entered;
  const app = await startAppServer({ manager: { current: null, snapshot: () => ({ gameId: null, state: 'lobby' }) }, token: 'host',
    storeDir: store, publicPort: 0, playReport: held.reader, progressWaitMs: 20 });
  const answer = await (await fetch(app.origin + ROUTE, { headers: { authorization: 'Bearer host', connection: 'close' } })).json();
  assert.deepEqual(answer, { ok: true, progress: null, pending: true });
  await app.close();
  held.release();
  assert.equal((await boot).report.scope.heroHands, 3, 'the loop still gets its whole report');
});
