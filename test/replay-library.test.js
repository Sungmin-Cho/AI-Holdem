import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReplayLibrary } from '../tools/replay-library.js';
import { ensureSessionStore, prepareSession, commitSession } from '../engine/session-catalog.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { saveState, writeHandArchive } from '../engine/state.js';
import { replayRecord } from '../shared/hand-replay.js';
import { buildReplaySteps } from '../server/public/replay-model.js';
import { openContained } from '../tools/training-store.js';
import { mulberry32 } from './helpers/fixtures.js';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';

const POSIX = process.platform !== 'win32';
const hardLinksWork = () => {
  const probe = createOwnedTempDir('replay-lib-link');
  fs.writeFileSync(path.join(probe, 'a'), 'x');
  try { fs.linkSync(path.join(probe, 'a'), path.join(probe, 'b')); return true; } catch { return false; }
};
const HARDLINKS = hardLinksWork();
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const STATE_FILE = 'state.json';

// ---------------------------------------------------------------- fixtures
// Every game below is produced by the real engine (createGame/startHand/applyAction)
// and persisted with the engine's own saveState/writeHandArchive into a session
// directory made by the real session catalog. Hand-edited bytes are used only where
// a test needs a damaged or hostile file, and each says so.

const makeStore = () => createOwnedTempDir('replay-lib');

// commitSession proves its transaction lock with a process-identity probe (`ps`); where that
// probe is denied (a sandboxed shell) the same same-parent rename is done directly. The
// reader never looks at the selector, so the layout it sees is identical.
function newSession(store) {
  ensureSessionStore(store);
  const prepared = prepareSession(store);
  try {
    commitSession(store, prepared);
  } catch (error) {
    if (error.code !== 'IDENTITY_UNAVAILABLE') throw error;
    fs.renameSync(prepared.stagingDir, prepared.sessionDir);
  }
  return { gameId: prepared.gameId, dir: prepared.sessionDir };
}

function playHand(state, rand) {
  let cur = startHand(state, { rng: rand }).state;
  for (let step = 0; !legalFor(cur).handOver; step += 1) {
    assert.ok(step < 300, 'fixture hand did not terminate');
    const legal = legalFor(cur);
    const pid = legal.toAct;
    const roll = rand();
    let action;
    let amount;
    if (legal.canRaise && roll < 0.2) { action = 'raise'; amount = Math.min(legal.minRaiseTo, legal.maxRaiseTo); }
    else if (legal.canCheck) action = 'check';
    else if (roll > 0.85) action = 'fold';
    else action = 'call';
    const meta = pid === 'user' ? { note: `my-note-${step}` } : { reason: `reason-${pid}-${step}` };
    cur = applyAction(cur, pid, action, amount, { meta }).state;
  }
  return cur;
}

// Hands are archived and then the state is saved, as the engine loop does.
function buildGame(store, {
  hands = 3, seed = 1, cash = true, aiCount = 2, ...config
} = {}) {
  const session = newSession(store);
  const rand = mulberry32(seed);
  let state = createGame({
    aiCount, startStack: 1000, ...(cash ? { mode: 'cash-training', levelEvery: null } : {}), ...config,
  });
  saveState(session.dir, state);
  const records = [];
  for (let n = 0; n < hands && !state.gameOver; n += 1) {
    state = playHand(state, rand);
    records.push(JSON.parse(JSON.stringify(state.lastHand)));
    writeHandArchive(session.dir, state.lastHand);
    saveState(session.dir, state);
  }
  return { ...session, state, records };
}

const multi = { aiCount: 1, participants: [{ playerId: 'h1', participantId: 'pt-1', name: 'Guest' }], hostName: 'Host' };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const handPath = (dir, n) => path.join(dir, 'hands', `hand-${String(n).padStart(4, '0')}.json`);
const statePath = (dir) => path.join(dir, STATE_FILE);
function editState(dir, fn) { const state = readJson(statePath(dir)); fn(state); writeJson(statePath(dir), state); }
function editHand(dir, n, fn) { const record = readJson(handPath(dir, n)); fn(record); writeJson(handPath(dir, n), record); }
const touch = (dir, seconds) => { const when = new Date(seconds * 1000); fs.utimesSync(statePath(dir), when, when); };

function library(store, options = {}) {
  const opened = [];
  const lib = createReplayLibrary(store, {
    ...options,
    openFile: (root, segments, limits) => { opened.push(segments.join('/')); return (options.openFile ?? openContained)(root, segments, limits); },
  });
  return { lib, opened };
}

const codeOf = (code) => ({ code });
async function rejectCode(promise, code) {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code); assert.ok(!/[\\/]/.test(error.message), 'message leaks a path'); return true; });
}

// ------------------------------------------------- closed output schema oracle
const leaf = Symbol('leaf');
const GAME_KEYS = ['gameId', 'savedAt', 'mode', 'status', 'seatCount', 'completedHandCount', 'unavailableCode'];
const REPLAY_SCHEMA = {
  schemaVersion: leaf, reveal: leaf, handNo: leaf, level: leaf, button: leaf, blinds: leaf, board: leaf, folded: leaf, allIn: leaf,
  startStacks: leaf, endStacks: leaf, uncalledReturns: leaf, holes: leaf, positions: leaf, rulesVersion: leaf,
  posts: [{ playerId: leaf, amount: leaf, allIn: leaf }],
  showdown: { reveals: [{ playerId: leaf, cards: leaf, handName: leaf }], mucks: leaf },
  pots: [{ potIndex: leaf, amount: leaf, eligible: leaf, winners: [{ playerId: leaf, share: leaf }] }],
  actions: [{
    decisionId: leaf, playerId: leaf, action: leaf, amount: leaf, street: leaf, potTotal: leaf, callAmount: leaf, minRaiseTo: leaf,
    maxRaiseTo: leaf, currentBet: leaf, board: leaf, forced: leaf, reasonKind: leaf, reason: leaf, note: leaf,
  }],
  decisions: [{ decisionId: leaf, potBefore: leaf, toCall: leaf }],
};
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const primitive = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

function assertClosed(value, schema, at = '$') {
  if (schema === leaf) {
    const ok = primitive(value) || (Array.isArray(value) && value.every(primitive))
      || (isPlain(value) && Object.values(value).every((v) => primitive(v) || (Array.isArray(v) && v.every(primitive))));
    assert.ok(ok, `${at} is not a flat leaf`);
    return;
  }
  if (value === null) return;
  if (Array.isArray(schema)) {
    assert.ok(Array.isArray(value), `${at} must be an array`);
    value.forEach((item, index) => assertClosed(item, schema[0], `${at}[${index}]`));
    return;
  }
  assert.ok(isPlain(value), `${at} must be an object`);
  for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema, key), `${at}.${key} is outside the allowlist`);
  for (const [key, child] of Object.entries(schema)) if (Object.hasOwn(value, key)) assertClosed(value[key], child, `${at}.${key}`);
}

function assertGame(game, extra = []) {
  assert.deepEqual(Object.keys(game).sort(), [...GAME_KEYS, ...extra].sort());
}

function assertDetail(detail) {
  assert.equal(detail.ok, true);
  assert.equal(detail.schemaVersion, 1);
  assert.deepEqual(Object.keys(detail).sort(), ['game', 'handNo', 'ok', 'replay', 'revision', 'schemaVersion']);
  assertGame(detail.game, ['seats', 'viewerId']);
  assert.equal(detail.game.viewerId, 'user');
  assert.match(detail.revision, /^[0-9a-f]{64}$/);
  assertClosed(detail.replay, REPLAY_SCHEMA);
  const seatIds = new Set(detail.game.seats.map((seat) => seat.playerId));
  for (const seat of detail.game.seats) assert.deepEqual(Object.keys(seat).sort(), ['kind', 'name', 'playerId']);
  for (const map of [detail.replay.startStacks, detail.replay.endStacks, detail.replay.holes, detail.replay.uncalledReturns]) {
    for (const pid of Object.keys(map)) assert.ok(seatIds.has(pid), `unknown seat ${pid}`);
  }
}

const HAND_ROW_KEYS = ['available', 'blinds', 'handNo', 'heroDealt', 'heroPosition', 'unavailableCode'];

function treeSnapshot(root) {
  const rows = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) { rows.push([path.relative(root, full), 'dir', stat.mtimeMs]); walk(full); continue; }
      rows.push([path.relative(root, full), 'file', stat.size, stat.mtimeMs, stat.ino,
        createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  };
  walk(root);
  return rows;
}

// -------------------------------------------------------------------- tests

test('two stored games each return their own hand 1, byte-for-byte what the engine archived', async () => {
  const store = makeStore();
  const a = buildGame(store, { hands: 3, seed: 11, replayReveal: 'all' });
  const b = buildGame(store, { hands: 3, seed: 29, replayReveal: 'showdown' });
  const { lib } = library(store);
  const [da, db] = [await lib.readHand(a.gameId, 1), await lib.readHand(b.gameId, 1)];
  assertDetail(da);
  assertDetail(db);
  assert.deepEqual(da.replay.startStacks,a.records[0].startStacks);
  assert.deepEqual(db.replay.startStacks,b.records[0].startStacks);
  assert.notEqual(da.revision, db.revision);
  assert.equal(da.replay.reveal, 'all');
  assert.equal(db.replay.reveal, 'showdown');
  assert.equal(da.game.gameId, a.gameId);
  assert.equal(db.game.gameId, b.gameId);
  // The engine's pure projector with the saved policy is the oracle for the public fields.
  for (const [game, detail] of [[a, da], [b, db]]) {
    const oracle = replayRecord(game.records[0], { reveal: game.state.config.replayReveal, humanIds: ['user'] });
    for (const key of ['handNo', 'level', 'button', 'blinds', 'board', 'folded', 'allIn', 'startStacks', 'endStacks', 'posts',
      'uncalledReturns', 'holes', 'showdown', 'pots', 'positions', 'rulesVersion']) {
      assert.deepEqual(detail.replay[key], oracle[key], key);
    }
    assert.deepEqual(detail.replay.actions.map((row) => [row.playerId, row.action, row.amount, row.street, row.decisionId]),
      oracle.actions.map((row) => [row.playerId, row.action, row.amount, row.street, row.decisionId]));
    assert.equal(detail.replay.decisions.length, oracle.decisions.length);
  }
});

test('valid engine hands of every shape rebuild in the table model with the same steps as the raw projection', async () => {
  const store = makeStore();
  const games = [
    buildGame(store, { hands: 8, seed: 3, replayReveal: 'all' }),
    buildGame(store, { hands: 8, seed: 5, cash: false, aiCount: 4 }),
    buildGame(store, { hands: 6, seed: 9, aiCount: 8, replayReveal: 'all' }),
    buildGame(store, { hands: 6, seed: 13, ...multi, replayReveal: 'all' }),
    buildGame(store, { hands: 6, seed: 17, aiCount: 1 }),
  ];
  const { lib } = library(store);
  let hands = 0;
  let showdowns = 0;
  let folds = 0;
  for (const game of games) {
    const humanIds = game.state.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.playerId);
    for (const record of game.records) {
      const detail = await lib.readHand(game.gameId, record.handNo);
      assertDetail(detail);
      const rebuilt = buildReplaySteps(detail.replay);
      assert.equal(rebuilt.ok, true, `${game.gameId} #${record.handNo}: ${rebuilt.reason}`);
      const oracle = buildReplaySteps(replayRecord(record, { reveal: game.state.config.replayReveal, humanIds }));
      assert.deepEqual(rebuilt, oracle);
      assert.equal(detail.replay.decisions.length, record.decisions.filter((d) => d.actorId === 'user').length);
      hands += 1;
      if (record.showdown) showdowns += 1; else folds += 1;
    }
  }
  assert.ok(hands >= 20 && showdowns > 0 && folds > 0, `fixture variety: ${hands}/${showdowns}/${folds}`);
});

test('game list: newest save first, gameId ascending on ties, pages of 25/50, closed rows with ISO savedAt', async () => {
  const store = makeStore();
  const [a, b, c] = [1, 2, 3].map((seed) => buildGame(store, { hands: 1, seed }));
  touch(a.dir, 1_000_000_000); touch(b.dir, 1_900_000_000); touch(c.dir, 1_800_000_000);
  const { lib } = library(store);
  const full = await lib.listGames();
  assert.deepEqual([full.ok, full.schemaVersion, full.nextOffset, full.legacyPresent], [true, 1, null, false]);
  assert.deepEqual(Object.keys(full).sort(), ['games', 'legacyPresent', 'nextOffset', 'ok', 'schemaVersion']);
  assert.deepEqual(full.games.map((g) => g.gameId), [b.gameId, c.gameId, a.gameId]);
  for (const game of full.games) assertGame(game);
  assert.equal(full.games[0].savedAt, new Date(1_900_000_000_000).toISOString());
  assert.deepEqual([full.games[0].mode, full.games[0].status, full.games[0].seatCount, full.games[0].completedHandCount, full.games[0].unavailableCode],
    ['cash-training', 'unfinished', 3, 1, null]);
  const first = await lib.listGames({ limit: 2 });
  assert.deepEqual([first.games.length, first.nextOffset], [2, 2]);
  const second = await lib.listGames({ offset: 2, limit: 2 });
  assert.deepEqual([second.games.map((g) => g.gameId), second.nextOffset], [[a.gameId], null]);
  assert.deepEqual((await lib.listGames({ offset: 50 })).games, []);
  touch(a.dir, 1_900_000_000);
  const tied = [b.gameId, a.gameId].sort();
  assert.deepEqual((await lib.listGames()).games.slice(0, 2).map((g) => g.gameId), tied);
});

test('game list page sizes: default 25, at most 50, and 50 rows really fit', async () => {
  const store = makeStore();
  const seed = buildGame(store, { hands: 1, seed: 4 });
  const state = readJson(statePath(seed.dir));
  for (let i = 0; i < 59; i += 1) {
    const session = newSession(store);
    saveState(session.dir, state);
  }
  const { lib } = library(store);
  const defaults = await lib.listGames();
  assert.equal(defaults.games.length, 25);
  assert.equal(defaults.nextOffset, 25);
  const wide = await lib.listGames({ limit: 50 });
  assert.equal(wide.games.length, 50);
  assert.equal(wide.nextOffset, 50);
  assert.equal((await lib.listGames({ offset: 50, limit: 50 })).games.length, 10);
  await rejectCode(lib.listGames({ limit: 51 }), 'REPLAY_BAD_REQUEST');
});

test('hand list: page 50 default / 100 max, rows carry exactly the five public keys', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 1, seed: 8, replayReveal: 'all' });
  // Real archives for 130 hand numbers: the same engine record re-numbered and rewritten with the engine writer.
  const seed = readJson(handPath(game.dir, 1));
  for (let n = 2; n <= 130; n += 1) writeHandArchive(game.dir, { ...seed, handNo: n });
  editState(game.dir, (state) => { state.handNo = 130; state.lastHand = { ...seed, handNo: 130 }; });
  const { lib } = library(store);
  const page = await lib.listHands(game.gameId);
  assert.deepEqual(Object.keys(page).sort(), ['game', 'hands', 'nextOffset', 'ok', 'schemaVersion']);
  assert.equal(page.hands.length, 50);
  assert.equal(page.nextOffset, 50);
  assert.deepEqual(page.hands.map((h) => h.handNo).slice(0, 3), [1, 2, 3]);
  for (const row of page.hands) {
    assert.deepEqual(Object.keys(row).sort(), HAND_ROW_KEYS);
    assert.equal(row.available, true);
    assert.equal(row.unavailableCode, null);
    assert.equal(row.blinds.length, 2);
  }
  assertGame(page.game);
  assert.equal(page.game.completedHandCount, 130);
  const wide = await lib.listHands(game.gameId, { limit: 100 });
  assert.equal(wide.hands.length, 100);
  assert.equal(wide.nextOffset, 100);
  const tail = await lib.listHands(game.gameId, { offset: 100, limit: 100 });
  assert.deepEqual([tail.hands.length, tail.nextOffset, tail.hands.at(-1).handNo], [30, null, 130]);
  await rejectCode(lib.listHands(game.gameId, { limit: 101 }), 'REPLAY_BAD_REQUEST');
});

test('a missing catalog is a safe empty list and never creates anything; legacy-only layouts are flagged, not read', async () => {
  const empty = makeStore();
  const { lib } = library(empty);
  assert.deepEqual(await lib.listGames(), { ok: true, schemaVersion: 1, games: [], nextOffset: null, legacyPresent: false });
  assert.deepEqual(fs.readdirSync(empty), []);
  const legacy = makeStore();
  fs.writeFileSync(path.join(legacy, 'state.json'), JSON.stringify({ canary: 'LEGACY-CANARY' }));
  fs.mkdirSync(path.join(legacy, 'archive'));
  fs.writeFileSync(path.join(legacy, 'archive', 'hand-0001.json'), '{"canary":"LEGACY-CANARY"}');
  const legacyLib = library(legacy);
  const listed = await legacyLib.lib.listGames();
  assert.deepEqual([listed.games, listed.legacyPresent], [[], true]);
  assert.deepEqual(legacyLib.opened, []);
  assert.ok(!JSON.stringify(listed).includes('LEGACY-CANARY'));
  const mixed = makeStore();
  buildGame(mixed, { hands: 1 });
  fs.writeFileSync(path.join(mixed, 'state.json'), '{}');
  assert.equal((await library(mixed).lib.listGames()).legacyPresent, true);
  const gone = createReplayLibrary(path.join(empty, 'does-not-exist'));
  assert.equal((await gone.listGames()).games.length, 0);
  await rejectCode(gone.listHands(randomUUID()), 'REPLAY_NOT_FOUND');
});

test('sessions stay listed without the current selector and without ever touching it', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 2 });
  fs.rmSync(path.join(store, '.session-store', 'current.json'), { force: true });
  fs.mkdirSync(path.join(store, '.session-store', 'sessions', `.${randomUUID()}.creating`));
  const before = treeSnapshot(store);
  const { lib } = library(store);
  const listed = await lib.listGames();
  assert.deepEqual(listed.games.map((g) => g.gameId), [game.gameId]);
  assert.equal(listed.games[0].completedHandCount, 2);
  assert.equal((await lib.readHand(game.gameId, 2)).handNo, 2);
  assert.deepEqual(treeSnapshot(store), before);
  assert.equal(fs.existsSync(path.join(store, '.session-store', 'current.json')), false);
});

test('an unfinished game exposes only completed hands: lastHand survives startHand, the live hand is never published', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 6, replayReveal: 'all' });
  const live = startHand(game.state, { rng: mulberry32(99) }).state;
  assert.equal(live.lastHand.handNo, 2);
  assert.equal(live.handNo, 3);
  saveState(game.dir, live);
  // A premature archive of the in-progress hand (e.g. a crash after the write) must stay hidden.
  writeHandArchive(game.dir, { ...game.records[1], handNo: 3, canary: 'LIVE-CANARY' });
  const { lib } = library(store);
  const listed = (await lib.listGames()).games[0];
  assert.deepEqual([listed.status, listed.completedHandCount], ['unfinished', 2]);
  const hands = await lib.listHands(game.gameId);
  assert.deepEqual(hands.hands.map((h) => h.handNo), [1, 2]);
  assert.equal(hands.nextOffset, null);
  assert.equal((await lib.readHand(game.gameId, 2)).handNo, 2);
  await rejectCode(lib.readHand(game.gameId, 3), 'REPLAY_NOT_COMPLETED');
  await rejectCode(lib.readHand(game.gameId, 4), 'REPLAY_NOT_FOUND');
  assert.ok(!JSON.stringify(await lib.listHands(game.gameId, { offset: 2 })).includes('LIVE-CANARY'));
});

test('hand 0, first hand in progress, and a finished hand count are bounded by the state, never guessed', async () => {
  const store = makeStore();
  const fresh = newSession(store);
  const created = createGame({ aiCount: 2, startStack: 1000 });
  saveState(fresh.dir, created);
  const { lib } = library(store);
  const row = (await lib.listGames()).games[0];
  assert.deepEqual([row.status, row.completedHandCount, row.mode], ['unfinished', 0, 'tournament']);
  assert.deepEqual((await lib.listHands(fresh.gameId)).hands, []);
  await rejectCode(lib.readHand(fresh.gameId, 1), 'REPLAY_NOT_FOUND');
  const first = startHand(created, { rng: mulberry32(5) }).state;
  saveState(fresh.dir, first);
  assert.equal((await lib.listGames()).games[0].completedHandCount, 0);
  await rejectCode(lib.readHand(fresh.gameId, 1), 'REPLAY_NOT_COMPLETED');
  for (const [label, edit] of [
    ['no lastHand but handNo 5', (s) => { s.handNo = 5; s.lastHand = null; }],
    ['lastHand far behind handNo', (s) => { s.handNo = 9; s.lastHand = { handNo: 3 }; }],
    ['lastHand ahead of handNo', (s) => { s.handNo = 1; s.lastHand = { handNo: 3 }; }],
    ['negative handNo', (s) => { s.handNo = -1; }],
    ['lastHand without a number', (s) => { s.lastHand = {}; }],
  ]) {
    editState(fresh.dir, edit);
    const verdict = (await lib.listGames()).games[0];
    assert.deepEqual([verdict.status, verdict.unavailableCode, verdict.completedHandCount], ['unavailable', 'REPLAY_UNAVAILABLE', null], label);
    await rejectCode(lib.listHands(fresh.gameId), 'REPLAY_UNAVAILABLE');
    writeJson(statePath(fresh.dir), first);
  }
});

test('an aborted game keeps its completed hands; the hand that was cut off is not complete', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 12 });
  const live = startHand(game.state, { rng: mulberry32(3) }).state;
  const aborted = structuredClone(live);
  aborted.gameOver = true; aborted.result = 'abort'; aborted.phase = 'idle'; aborted.hand = null;
  saveState(game.dir, aborted);
  fs.writeFileSync(path.join(game.dir, '.aborted-hand.json'), JSON.stringify({ hand: live.hand, canary: 'ABORT-CANARY' }));
  const { lib } = library(store);
  const row = (await lib.listGames()).games[0];
  assert.deepEqual([row.status, row.completedHandCount], ['aborted', 2]);
  assert.deepEqual((await lib.listHands(game.gameId)).hands.map((h) => h.handNo), [1, 2]);
  await rejectCode(lib.readHand(game.gameId, 3), 'REPLAY_NOT_COMPLETED');
  const early = newSession(store);
  const created = createGame({ aiCount: 2 });
  const started = startHand(created, { rng: mulberry32(8) }).state;
  started.gameOver = true; started.result = 'abort'; started.phase = 'idle'; started.hand = null;
  saveState(early.dir, started);
  const earlyRow = (await lib.listGames()).games.find((g) => g.gameId === early.gameId);
  assert.deepEqual([earlyRow.status, earlyRow.completedHandCount], ['aborted', 0]);
});

test('gameOver/result combinations map exactly onto status, contradictions are unavailable', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 1, seed: 1 });
  const base = readJson(statePath(game.dir));
  const cases = [
    [false, null, 'unfinished'], [false, undefined, 'unfinished'],
    [true, 'win', 'completed'], [true, 'lose', 'completed'], [true, 'completed', 'completed'], [true, 'abort', 'aborted'],
    [false, 'win', 'unavailable'], [false, 'abort', 'unavailable'], [true, null, 'unavailable'], [true, 'bogus', 'unavailable'],
  ];
  const { lib } = library(store);
  for (const [gameOver, result, expected] of cases) {
    const state = { ...base, gameOver };
    if (result === undefined) delete state.result; else state.result = result;
    writeJson(statePath(game.dir), state);
    const row = (await lib.listGames()).games[0];
    assert.equal(row.status, expected, `${gameOver}/${result}`);
    assert.equal(row.unavailableCode, expected === 'unavailable' ? 'REPLAY_UNAVAILABLE' : null);
    assert.equal(row.completedHandCount, expected === 'unavailable' ? null : 1);
  }
});

test('known schema versions pass, unknown ones are unsupported rows; missing mode/replayReveal take the engine defaults', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 1, seed: 1, cash: false });
  const base = readJson(statePath(game.dir));
  const { lib } = library(store);
  writeJson(statePath(game.dir), { ...base, schemaVersion: 2 });
  assert.equal((await lib.listGames()).games[0].status, 'unfinished');
  const unsupported = [{ schemaVersion: 3 }, { schemaVersion: '1' }, { config: { ...base.config, mode: 'league' } },
    { config: { ...base.config, replayReveal: 'everyone' } }];
  for (const patch of unsupported) {
    writeJson(statePath(game.dir), { ...base, ...patch });
    const row = (await lib.listGames()).games[0];
    assert.deepEqual([row.status, row.unavailableCode, row.mode, row.seatCount, row.completedHandCount], ['unavailable', 'REPLAY_UNSUPPORTED', null, null, null]);
    await rejectCode(lib.readHand(game.gameId, 1), 'REPLAY_UNSUPPORTED');
    await rejectCode(lib.listHands(game.gameId), 'REPLAY_UNSUPPORTED');
  }
  const { schemaVersion, ...noVersion } = base;
  writeJson(statePath(game.dir), noVersion);
  assert.equal((await lib.listGames()).games[0].unavailableCode, 'REPLAY_UNAVAILABLE');
  const { mode, ...configNoMode } = base.config;
  writeJson(statePath(game.dir), { ...base, config: { ...configNoMode, replayReveal: undefined } });
  const row = (await lib.listGames()).games[0];
  assert.equal(row.mode, 'tournament');
  assert.equal((await lib.readHand(game.gameId, 1)).replay.reveal, 'showdown');
});

test('unknown record versions are unsupported, an old record without rules/positions still reads', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 4, seed: 14, replayReveal: 'all' });
  const { lib } = library(store);
  editHand(game.dir, 1, (r) => { r.rulesVersion = 3; });
  editHand(game.dir, 2, (r) => { r.hintContractVersion = 2; });
  editHand(game.dir, 3, (r) => { r.dealSelectionContractVersion = 2; r.dealSelection = { schemaVersion: 1, algorithmVersion: 'weighted-holes-v1', mode: 'light' }; });
  editHand(game.dir, 4, (r) => { delete r.rulesVersion; delete r.positions; delete r.tableSeats; });
  const page = await lib.listHands(game.gameId);
  assert.deepEqual(page.hands.map((h) => [h.available, h.unavailableCode]), [
    [false, 'REPLAY_UNSUPPORTED'], [false, 'REPLAY_UNSUPPORTED'], [false, 'REPLAY_UNSUPPORTED'], [true, null],
  ]);
  for (const n of [1, 2, 3]) await rejectCode(lib.readHand(game.gameId, n), 'REPLAY_UNSUPPORTED');
  const legacy = await lib.readHand(game.gameId, 4);
  assertDetail(legacy);
  assert.equal('rulesVersion' in legacy.replay, false);
  assert.equal('positions' in legacy.replay, false);
  assert.equal(page.hands[3].heroPosition, null);
  assert.equal(page.hands[3].heroDealt, true);
});

test('latest hand falls back to state.lastHand only on a true ENOENT; nothing else is hidden by it', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 3, seed: 21, replayReveal: 'all' });
  const { lib } = library(store);
  const archived = await lib.readHand(game.gameId, 3);
  fs.rmSync(handPath(game.dir, 3));
  const fallback = await lib.readHand(game.gameId, 3);
  assert.deepEqual(fallback, archived);
  assert.equal((await lib.listHands(game.gameId)).hands[2].available, true);
  fs.rmSync(path.join(game.dir, 'hands'), { recursive: true });
  const noDirectory = await lib.listHands(game.gameId);
  assert.deepEqual(noDirectory.hands.map((h) => [h.handNo, h.available, h.unavailableCode]), [
    [1, false, 'REPLAY_UNAVAILABLE'], [2, false, 'REPLAY_UNAVAILABLE'], [3, true, null],
  ]);
  await rejectCode(lib.readHand(game.gameId, 1), 'REPLAY_UNAVAILABLE');
  writeHandArchive(game.dir, game.records[0]);
  writeHandArchive(game.dir, game.records[1]);
  fs.writeFileSync(handPath(game.dir, 3), '{"handNo":3,');
  await rejectCode(lib.readHand(game.gameId, 3), 'REPLAY_UNAVAILABLE');
  const damaged = await lib.listHands(game.gameId);
  assert.deepEqual(damaged.hands.map((h) => [h.available, h.unavailableCode]), [[true, null], [true, null], [false, 'REPLAY_UNAVAILABLE']]);
  fs.writeFileSync(handPath(game.dir, 3), JSON.stringify({ ...game.records[2], rulesVersion: 9 }));
  await rejectCode(lib.readHand(game.gameId, 3), 'REPLAY_UNSUPPORTED');
  writeJson(handPath(game.dir, 3), { ...game.records[2], handNo: 2 });
  await rejectCode(lib.readHand(game.gameId, 3), 'REPLAY_UNAVAILABLE');
});

test('unreadable archives stay unavailable even for the latest hand (no fallback on permission errors)', { skip: !POSIX || ROOT_USER }, async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 22 });
  fs.chmodSync(handPath(game.dir, 2), 0);
  const { lib } = library(store);
  try {
    await rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE');
    assert.equal((await lib.listHands(game.gameId)).hands[1].available, false);
  } finally { fs.chmodSync(handPath(game.dir, 2), 0o600); }
});

test('one damaged hand never blocks the rest, and a damaged state only costs its own row', async () => {
  const store = makeStore();
  const good = buildGame(store, { hands: 3, seed: 31 });
  const bad = buildGame(store, { hands: 1, seed: 32 });
  fs.writeFileSync(statePath(bad.dir), '{"schemaVersion":1,');
  const { lib } = library(store);
  const games = (await lib.listGames()).games;
  assert.equal(games.length, 2);
  const byId = Object.fromEntries(games.map((g) => [g.gameId, g]));
  assert.equal(byId[good.gameId].status, 'unfinished');
  assert.deepEqual([byId[bad.gameId].status, byId[bad.gameId].unavailableCode, byId[bad.gameId].mode], ['unavailable', 'REPLAY_UNAVAILABLE', null]);
  await rejectCode(lib.listHands(bad.gameId), 'REPLAY_UNAVAILABLE');
  editHand(good.dir, 2, (r) => { r.board = ['As']; });
  const page = await lib.listHands(good.gameId);
  assert.deepEqual(page.hands.map((h) => h.available), [true, false, true]);
  assert.deepEqual(page.hands[1], { handNo: 2, blinds: null, heroPosition: null, heroDealt: null, available: false, unavailableCode: 'REPLAY_UNAVAILABLE' });
  const sessionless = newSession(store);
  const rows = (await lib.listGames()).games;
  assert.equal(rows.find((g) => g.gameId === sessionless.gameId).savedAt, null);
});

test('structural corruption of any archived field is refused, table-driven', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 1, seed: 41, ...multi, replayReveal: 'all' });
  const pristine = game.records[0];
  const mutations = {
    'handNo of another hand': (r) => { r.handNo = 2; },
    'unknown seat in startStacks': (r) => { r.startStacks.p9 = 100; },
    'only-in-record seat in holes': (r) => { r.holes.p7 = ['As', 'Ah']; },
    'startStacks float': (r) => { r.startStacks.user = 10.5; },
    'startStacks negative': (r) => { r.startStacks.user = -1; },
    'one dealt seat': (r) => { r.startStacks = { user: 100 }; },
    'endStacks missing a dealt seat': (r) => { delete r.endStacks.user; },
    'endStacks unknown seat': (r) => { r.endStacks.zz = 1; },
    'hole with one card': (r) => { r.holes.user = ['As']; },
    'bad card code': (r) => { r.holes.user = ['1s', 'Ah']; },
    'duplicate card across hole and board': (r) => { r.holes.user = [r.board[0] ?? 'As', r.holes.user[1]]; r.board = r.board.length ? r.board : ['As', 'Kd', 'Qc']; },
    'board of two cards': (r) => { r.board = ['As', 'Kd']; },
    'board not an array': (r) => { r.board = 'AsKdQc'; },
    'blinds not a pair': (r) => { r.blinds = [10]; },
    'blind zero': (r) => { r.blinds = [0, 10]; },
    'button outside the table': (r) => { r.button = 'p9'; },
    'folded duplicate': (r) => { r.folded = ['p1', 'p1']; },
    'allIn unknown': (r) => { r.allIn = ['x']; },
    'post bad amount': (r) => { r.posts[0].amount = '10'; },
    'post unknown player': (r) => { r.posts[0].playerId = 'p9'; },
    'actions not an array': (r) => { r.actions = {}; },
    'action by a stranger': (r) => { r.actions[0].playerId = 'p9'; },
    'action verb bet': (r) => { r.actions[0].action = 'bet'; },
    'action street river-ish': (r) => { r.actions[0].street = 'showdown'; },
    'action amount string': (r) => { r.actions[0].amount = '5'; },
    'action potTotal negative': (r) => { r.actions[0].potTotal = -3; },
    'action board of five lies': (r) => { r.actions[0].board = ['As']; },
    'action is null': (r) => { r.actions[0] = null; },
    'pots not an array': (r) => { r.pots = null; },
    'pot winner share float': (r) => { r.pots[0].winners[0].share = 0.5; },
    'pot eligible unknown': (r) => { r.pots[0].eligible = ['nobody']; },
    'uncalledReturns array': (r) => { r.uncalledReturns = []; },
    'uncalledReturns unknown seat': (r) => { r.uncalledReturns = { p9: 5 }; },
    'positions label too long': (r) => { r.positions.user = 'X'.repeat(17); },
    'positions unknown seat': (r) => { r.positions.p9 = 'BTN'; },
    'positions false': r => { r.positions = false; },
    'positions number': r => { r.positions = 0; },
    'positions empty string': r => { r.positions = ''; },
    'decision primitive': r => { r.decisions[0] = 1; },
    'decision array': r => { r.decisions[0] = []; },
    'decisions not an array': (r) => { r.decisions = {}; },
    'decision is null': (r) => { r.decisions[0] = null; },
    'level float': (r) => { r.level = 0.5; },
  };
  const names = Object.keys(mutations);
  const { lib } = library(store);
  // The pristine hand reads, the table-driven ones each fail on a fresh copy.
  assertDetail(await lib.readHand(game.gameId, 1));
  for (const name of names) {
    const record = structuredClone(pristine);
    mutations[name](record);
    writeJson(handPath(game.dir, 1), record);
    const row = (await lib.listHands(game.gameId)).hands[0];
    if (name === 'action board of five lies' && record.actions[0].board === undefined) continue;
    assert.equal(row.available, false, name);
    assert.ok(['REPLAY_UNAVAILABLE', 'REPLAY_UNSUPPORTED'].includes(row.unavailableCode), name);
    await assert.rejects(lib.readHand(game.gameId, 1), (error) => ['REPLAY_UNAVAILABLE', 'REPLAY_UNSUPPORTED'].includes(error.code), name);
  }
  writeJson(handPath(game.dir, 1), pristine);
  assertDetail(await lib.readHand(game.gameId, 1));
});

test('seat identities are validated strictly: hN must be human, pN ai, no duplicates, user required', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 1, seed: 51, ...multi });
  const base = readJson(statePath(game.dir));
  const seatIndex = (id) => base.seats.findIndex((seat) => seat.playerId === id);
  const edits = {
    'hN without kind': (s) => { delete s.seats[seatIndex('h1')].kind; },
    'hN marked ai': (s) => { s.seats[seatIndex('h1')].kind = 'ai'; },
    'pN marked human': (s) => { s.seats[seatIndex('p1')].kind = 'human'; },
    'user marked ai': (s) => { s.seats[seatIndex('user')].kind = 'ai'; },
    'user without kind in a participant game': (s) => { delete s.seats[seatIndex('user')].kind; },
    'duplicate seat': (s) => { s.seats[seatIndex('p1')].playerId = 'h1'; },
    'unknown seat id': (s) => { s.seats[seatIndex('p1')].playerId = 'bot'; },
    'no user': (s) => { s.seats = s.seats.filter((seat) => seat.playerId !== 'user'); },
    'nameless seat': (s) => { delete s.seats[seatIndex('p1')].name; },
    'seats not an array': (s) => { s.seats = {}; },
    'one seat only': (s) => { s.seats = s.seats.slice(0, 1); },
  };
  const { lib } = library(store);
  for (const [name, edit] of Object.entries(edits)) {
    const state = structuredClone(base);
    edit(state);
    writeJson(statePath(game.dir), state);
    assert.equal((await lib.listGames()).games[0].status, 'unavailable', name);
    await rejectCode(lib.readHand(game.gameId, 1), 'REPLAY_UNAVAILABLE');
  }
  const solo = buildGame(store, { hands: 1, seed: 52 });
  editState(solo.dir, (s) => { for (const seat of s.seats) delete seat.kind; });
  const verdict = (await lib.listGames()).games.find((g) => g.gameId === solo.gameId);
  assert.equal(verdict.status, 'unfinished');
  const detail = await lib.readHand(solo.gameId, 1);
  assert.deepEqual(detail.game.seats.map((seat) => seat.kind), ['human', 'ai', 'ai']);
});

test('private canaries: another human\'s cards and notes, session secrets and every extra key at any depth never leave', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 4, seed: 61, ...multi, replayReveal: 'all', hints: 'off' });
  const secrets = new Set();
  editState(game.dir, (state) => {
    state.canary = 'CANARY-STATE'; state.config.canary = 'CANARY-CONFIG';
    for (const seat of state.seats) seat.canary = `CANARY-SEAT-${seat.playerId}`;
    secrets.add(state.sessionToken);
  });
  for (let n = 1; n <= 4; n += 1) {
    editHand(game.dir, n, (record) => {
      record.canary = 'CANARY-RECORD'; record.sessionToken = 'CANARY-TOKEN'; record.deck = ['CANARY-DECK']; record.seed = 'CANARY-SEED';
      record.jev = { probabilities: 'CANARY-JEV' };
      for (const [index, action] of record.actions.entries()) {
        action.canary = 'CANARY-ACTION'; action.sampledProbability = 0.123456;
        if (index % 3 === 0) action.policyId = 'CANARY-POLICY';
        if (action.playerId === 'h1') { action.note = 'CANARY-H1-NOTE'; action.reason = 'CANARY-H1-REASON'; }
      }
      for (const pot of record.pots) { pot.canary = 'CANARY-POT'; for (const w of pot.winners) w.canary = 'CANARY-WINNER'; }
      for (const post of record.posts) post.canary = 'CANARY-POST';
      if (record.showdown) {
        record.showdown.canary = 'CANARY-SHOWDOWN';
        for (const reveal of record.showdown.reveals) reveal.canary = 'CANARY-REVEAL';
      }
      for (const decision of record.decisions) {
        decision.canary = 'CANARY-DECISION'; decision.chosenAction = { ...decision.chosenAction, canary: 'CANARY-CHOSEN' };
        decision.assistance = { canary: 'CANARY-ASSIST' };
      }
    });
  }
  const { lib } = library(store);
  const everything = [JSON.stringify(await lib.listGames()), JSON.stringify(await lib.listHands(game.gameId))];
  let sawAiHole = false;
  let sawModelReason = false;
  for (let n = 1; n <= 4; n += 1) {
    const detail = await lib.readHand(game.gameId, n);
    assertDetail(detail);
    everything.push(JSON.stringify(detail));
    const record = game.records[n - 1];
    const shownAtShowdown = new Set((record.showdown?.reveals ?? []).map((r) => r.playerId));
    if (!shownAtShowdown.has('h1')) assert.equal('h1' in detail.replay.holes, false, 'h1 hole cards leaked');
    assert.deepEqual(detail.replay.holes.user, record.holes.user);
    if (record.holes.p1) { assert.deepEqual(detail.replay.holes.p1, record.holes.p1); sawAiHole = true; }
    for (const action of detail.replay.actions) {
      if (action.playerId === 'h1') {
        assert.equal(action.reasonKind, 'human');
        assert.ok(!('reason' in action) && !('note' in action));
      }
      if (action.reasonKind === 'model') { assert.match(action.reason, /^reason-p1-/); sawModelReason = true; }
    }
    for (const decision of detail.replay.decisions) assert.deepEqual(Object.keys(decision).sort(), ['decisionId', 'potBefore', 'toCall']);
  }
  assert.ok(sawAiHole && sawModelReason, 'positive controls: AI holes and model reasons are public under replayReveal=all');
  const joined = everything.join('\n');
  assert.ok(!joined.includes('CANARY'), joined.match(/CANARY[-A-Z0-9]*/)?.[0]);
  for (const secret of secrets) assert.ok(!joined.includes(secret));
  assert.ok(!/sampledProbability|policyId|sessionToken|hintExposures|tableSeats|holeCards|chosenAction|assistance|deck|seed/.test(joined));
});

test('showdown policy: AI cards and reasons stay hidden until the hand shows them down', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 8, seed: 71, replayReveal: 'showdown' });
  const { lib } = library(store);
  let hiddenHoles = 0;
  let revealed = 0;
  for (const record of game.records) {
    const detail = await lib.readHand(game.gameId, record.handNo);
    const shown = new Set(['user', ...(record.showdown?.reveals ?? []).map((r) => r.playerId)]);
    assert.deepEqual(Object.keys(detail.replay.holes).sort(), [...shown].filter((pid) => record.holes[pid]).sort());
    for (const pid of Object.keys(record.holes)) if (!shown.has(pid)) { hiddenHoles += 1; }
    for (const action of detail.replay.actions) {
      if (action.playerId === 'user') continue;
      if (shown.has(action.playerId)) revealed += 1;
      else { assert.equal(action.reasonKind, 'hidden'); assert.ok(!('reason' in action)); }
    }
  }
  assert.ok(hiddenHoles > 0 && revealed > 0, 'fixture must exercise both hidden and shown AI seats');
});

test('revision hashes only the public replay: hidden cards and other humans\' notes do not move it, public changes and games do', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 6, seed: 81, ...multi, replayReveal: 'showdown' });
  const { lib } = library(store);
  let target;
  for (const record of game.records) {
    const detail = await lib.readHand(game.gameId, record.handNo);
    const hidden = Object.keys(record.holes).find((pid) => !(pid in detail.replay.holes));
    if (hidden) { target = { record, hidden, detail }; break; }
  }
  assert.ok(target, 'fixture needs a hand with a hidden seat');
  const used = new Set([...target.record.board, ...Object.values(target.record.holes).flat()]);
  const spare = ['2c', '3c', '4c', '5c', '6c', '7c'].filter((card) => !used.has(card)).slice(0, 2);
  editHand(game.dir, target.record.handNo, (record) => {
    record.holes[target.hidden] = spare;
    for (const action of record.actions) if (action.playerId === 'h1') { action.note = 'another human note'; action.reason = 'x'; }
    for (const decision of record.decisions) decision.holeCards = decision.holeCards; // own cards unchanged
  });
  const after = await lib.readHand(game.gameId, target.record.handNo);
  assert.equal(after.revision, target.detail.revision);
  assert.deepEqual(after.replay, target.detail.replay);
  editHand(game.dir, target.record.handNo, (record) => { record.actions[0].amount += 1; });
  const publicChange = await lib.readHand(game.gameId, target.record.handNo);
  assert.notEqual(publicChange.revision, target.detail.revision);
  const other = buildGame(store, { hands: 1, seed: 81, ...multi, replayReveal: 'showdown' });
  assert.notEqual((await lib.readHand(other.gameId, 1)).revision, (await lib.readHand(game.gameId, 1)).revision);
  const same = await lib.readHand(game.gameId, 1);
  assert.equal(same.revision, (await lib.readHand(game.gameId, 1)).revision);
});

test('optional text and decisions: oversize text is dropped alone, bad optional fields are omitted, decision count and order stay', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 3, seed: 91, replayReveal: 'all' });
  const longNote = '가'.repeat(160);
  const { lib } = library(store);
  const record = readJson(handPath(game.dir, 1));
  const userIndexes = record.actions.flatMap((a, i) => (a.playerId === 'user' ? [i] : []));
  const modelIndex = record.actions.findIndex((a) => a.playerId !== 'user' && typeof a.reason === 'string');
  assert.ok(userIndexes.length > 0 && modelIndex >= 0);
  editHand(game.dir, 1, (r) => {
    r.actions[userIndexes[0]].note = longNote;
    if (userIndexes[1] !== undefined) r.actions[userIndexes[1]].note = '가'.repeat(1366);
    r.actions[modelIndex].reason = 'r'.repeat(4097);
    r.actions[0].decisionId = 12;
    r.decisions[0].potBefore = -1;
    r.decisions[0].toCall = '3';
    r.decisions[0].decisionId = '';
  });
  const detail = await lib.readHand(game.gameId, 1);
  assertDetail(detail);
  assert.equal(detail.replay.actions[userIndexes[0]].note, longNote);
  if (userIndexes[1] !== undefined) assert.ok(!('note' in detail.replay.actions[userIndexes[1]]));
  assert.ok(!('reason' in detail.replay.actions[modelIndex]));
  assert.equal(detail.replay.actions[modelIndex].reasonKind, 'model');
  assert.ok(!('decisionId' in detail.replay.actions[0]));
  assert.deepEqual(detail.replay.decisions[0], {});
  assert.equal(detail.replay.decisions.length, record.decisions.length);
  assert.deepEqual(detail.replay.decisions.slice(1).map((d) => d.decisionId), record.decisions.slice(1).map((d) => d.decisionId));
  editHand(game.dir, 1, (r) => { r.actions[userIndexes[0]].note = '가'.repeat(1365); });
  assert.equal((await lib.readHand(game.gameId, 1)).replay.actions[userIndexes[0]].note.length, 1365);
});

test('a host who was eliminated still labels earlier hands; a hand without them reads as not participated', async () => {
  const store = makeStore();
  const session = newSession(store);
  const rand = mulberry32(101);
  let state = createGame({ ...multi, mode: 'cash-training', levelEvery: null, startStack: 1000 });
  state = playHand(state, rand);
  writeHandArchive(session.dir, state.lastHand);
  const first = JSON.parse(JSON.stringify(state.lastHand));
  // The host busts between hands: the engine only marks the seat out and keeps it in the roster.
  state.seats[0].out = true; state.seats[0].stack = 0;
  saveState(session.dir, state);
  state = playHand(state, rand);
  const second = JSON.parse(JSON.stringify(state.lastHand));
  assert.equal('user' in second.startStacks, false);
  writeHandArchive(session.dir, state.lastHand);
  saveState(session.dir, state);
  const { lib } = library(store);
  const page = await lib.listHands(session.gameId);
  assert.equal(page.hands[0].heroPosition, first.positions.user);
  assert.deepEqual(page.hands[1], { handNo: 2, blinds: second.blinds, heroPosition: null, heroDealt: false, available: true, unavailableCode: null });
  const detail = await lib.readHand(session.gameId, 2);
  assertDetail(detail);
  assert.equal(detail.game.viewerId, 'user');
  assert.deepEqual(detail.game.seats.map((s) => [s.playerId, s.name, s.kind]), [['user', 'Host', 'human'], ['h1', 'Guest', 'human'], ['p1', 'p1', 'ai']]);
  assert.equal('user' in detail.replay.startStacks, false);
  assert.equal('user' in detail.replay.holes, false);
  assert.equal(buildReplaySteps(detail.replay).ok, true);
  const earlier = await lib.readHand(session.gameId, 1);
  assert.ok('user' in earlier.replay.holes);
  assert.deepEqual(earlier.game.seats, detail.game.seats);
});

test('hand file names match the engine for 1, 9999 and 10000; larger numbers and counts are limits, not guesses', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 1, seed: 111 });
  const seed = readJson(handPath(game.dir, 1));
  for (const n of [9999, 10000]) writeHandArchive(game.dir, { ...seed, handNo: n });
  assert.deepEqual(fs.readdirSync(path.join(game.dir, 'hands')).sort(), ['hand-0001.json', 'hand-10000.json', 'hand-9999.json']);
  editState(game.dir, (state) => { state.handNo = 10000; state.lastHand = { ...seed, handNo: 10000 }; });
  const { lib } = library(store);
  for (const n of [1, 9999, 10000]) assert.equal((await lib.readHand(game.gameId, n)).handNo, n);
  const tail = await lib.listHands(game.gameId, { offset: 9950, limit: 50 });
  assert.deepEqual([tail.hands.length, tail.hands.at(-1).handNo, tail.nextOffset], [50, 10000, null]);
  assert.equal(tail.hands.at(-1).available, true);
  assert.equal((await lib.listGames()).games[0].completedHandCount, 10000);
  await rejectCode(lib.readHand(game.gameId, 10001), 'REPLAY_LIMIT_EXCEEDED');
  editState(game.dir, (state) => { state.handNo = 10001; state.lastHand = { ...seed, handNo: 10001 }; });
  const row = (await lib.listGames()).games[0];
  assert.deepEqual([row.status, row.unavailableCode, row.completedHandCount], ['unavailable', 'REPLAY_LIMIT_EXCEEDED', null]);
  await rejectCode(lib.listHands(game.gameId), 'REPLAY_LIMIT_EXCEEDED');
  assert.equal((await lib.readHand(game.gameId, 1)).handNo, 1);
});

test('path validation is independent of auth and never reaches the filesystem', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 1, seed: 121 });
  const { lib, opened } = library(store);
  const badIds = ['../x', '..', 'abc', game.gameId.toUpperCase(), `${game.gameId}/..`, `${game.gameId}%2f..`, `${game.gameId}\0`,
    '12345678-1234-1234-8234-123456789abc', ` ${game.gameId}`, '', null, undefined, 7, {}];
  for (const id of badIds) {
    await rejectCode(lib.listHands(id), 'REPLAY_BAD_REQUEST');
    await rejectCode(lib.readHand(id, 1), 'REPLAY_BAD_REQUEST');
  }
  for (const handNo of [0, -1, 1.5, '1', NaN, Infinity, null, undefined, 2 ** 53]) {
    await rejectCode(lib.readHand(game.gameId, handNo), 'REPLAY_BAD_REQUEST');
  }
  for (const options of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: '5' }, { limit: null }, { extra: 1 }, { offset: 20_000 }, [], 'x', null]) {
    await rejectCode(lib.listGames(options), 'REPLAY_BAD_REQUEST');
    await rejectCode(lib.listHands(game.gameId, options), 'REPLAY_BAD_REQUEST');
  }
  assert.deepEqual(opened, []);
  await rejectCode(lib.readHand(randomUUID(), 1), 'REPLAY_NOT_FOUND');
  assert.deepEqual(opened, []);
});

test('hostile layouts are refused without following or reading them', { skip: !POSIX }, async () => {
  const outside = makeStore();
  fs.writeFileSync(path.join(outside, 'secret.json'), JSON.stringify({ canary: 'OUTSIDE-CANARY' }));
  const readsOf = async (lib) => JSON.stringify([await lib.listGames(), ...await Promise.all([])]);
  const store = makeStore();
  const game = buildGame(store, { hands: 3, seed: 131 });
  const other = buildGame(store, { hands: 1, seed: 132 });
  const { lib } = library(store);
  // symlinked hand file and FIFO hand file; hand 2 stays an ordinary archive
  fs.rmSync(handPath(game.dir, 1));
  fs.symlinkSync(path.join(outside, 'secret.json'), handPath(game.dir, 1));
  fs.rmSync(handPath(game.dir, 3));
  execFileSync('mkfifo', [handPath(game.dir, 3)]);
  const rows = (await lib.listHands(game.gameId)).hands;
  assert.deepEqual(rows.map((h) => [h.available, h.unavailableCode]), [[false, 'REPLAY_UNAVAILABLE'], [true, null], [false, 'REPLAY_UNAVAILABLE']]);
  for (const n of [1, 3]) await rejectCode(lib.readHand(game.gameId, n), 'REPLAY_UNAVAILABLE');
  // symlinked hands directory and symlinked session directory and state file
  const moved = path.join(outside, 'hands-copy');
  fs.renameSync(path.join(other.dir, 'hands'), moved);
  fs.symlinkSync(moved, path.join(other.dir, 'hands'));
  assert.equal((await lib.listHands(other.gameId)).hands[0].available, false);
  await rejectCode(lib.readHand(other.gameId, 1), 'REPLAY_UNAVAILABLE');
  const linkedSession = randomUUID();
  fs.symlinkSync(other.dir, path.join(store, '.session-store', 'sessions', linkedSession));
  const row = (await lib.listGames()).games.find((g) => g.gameId === linkedSession);
  assert.deepEqual([row.status, row.unavailableCode, row.seatCount], ['unavailable', 'REPLAY_UNAVAILABLE', null]);
  await rejectCode(lib.readHand(linkedSession, 1), 'REPLAY_UNAVAILABLE');
  fs.rmSync(statePath(game.dir));
  fs.symlinkSync(path.join(outside, 'secret.json'), statePath(game.dir));
  await rejectCode(lib.listHands(game.gameId), 'REPLAY_UNAVAILABLE');
  assert.equal((await lib.listGames()).games.find((g) => g.gameId === game.gameId).status, 'unavailable');
  assert.ok(!(await readsOf(lib)).includes('OUTSIDE-CANARY'));
  // the whole request is refused when the catalog itself is a link
  const hijack = makeStore();
  fs.symlinkSync(path.join(store, '.session-store'), path.join(hijack, '.session-store'));
  await rejectCode(library(hijack).lib.listGames(), 'REPLAY_UNAVAILABLE');
  const sessionsLink = makeStore();
  fs.mkdirSync(path.join(sessionsLink, '.session-store'));
  fs.symlinkSync(path.join(store, '.session-store', 'sessions'), path.join(sessionsLink, '.session-store', 'sessions'));
  await rejectCode(library(sessionsLink).lib.listGames(), 'REPLAY_UNAVAILABLE');
  await rejectCode(library(sessionsLink).lib.readHand(other.gameId, 1), 'REPLAY_UNAVAILABLE');
  const filePlaced = makeStore();
  fs.writeFileSync(path.join(filePlaced, '.session-store'), 'not a directory');
  await rejectCode(library(filePlaced).lib.listGames(), 'REPLAY_UNAVAILABLE');
});

test('a hard-linked archive is refused, and so is one that gains a second link while it is read', { skip: !POSIX || !HARDLINKS }, async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 133 });
  const outside = makeStore();
  fs.linkSync(handPath(game.dir, 1), path.join(outside, 'hardlink.json'));
  const { lib } = library(store);
  assert.deepEqual((await lib.listHands(game.gameId)).hands.map((h) => h.available), [false, true]);
  await rejectCode(lib.readHand(game.gameId, 1), 'REPLAY_UNAVAILABLE');
  let linked = false;
  const racing = library(store, { openFile: (root, segments, limits) => {
    const bytes = openContained(root, segments, limits);
    if (!linked && segments.at(-1) === 'hand-0002.json') { linked = true; fs.linkSync(handPath(game.dir, 2), path.join(outside, 'late.json')); }
    return bytes;
  } }).lib;
  await rejectCode(racing.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE');
});

// A JSON document padded to exactly `total` bytes (the padding is one extra string member).
const padded = (value, total) => {
  const empty = Buffer.byteLength(JSON.stringify({ ...value, padding: '' }));
  assert.ok(total >= empty, 'fixture larger than the requested size');
  const text = JSON.stringify({ ...value, padding: 'x'.repeat(total - empty) });
  assert.equal(Buffer.byteLength(text), total);
  return text;
};

test('byte limits are exact: 256 KiB per hand and 2 MiB per state pass, one byte more is an explicit limit error', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 141 });
  const { lib } = library(store);
  const record = readJson(handPath(game.dir, 1));
  fs.writeFileSync(handPath(game.dir, 1), padded(record, 256 * 1024));
  assertDetail(await lib.readHand(game.gameId, 1));
  fs.writeFileSync(handPath(game.dir, 1), padded(record, 256 * 1024 + 1));
  await rejectCode(lib.readHand(game.gameId, 1), 'REPLAY_LIMIT_EXCEEDED');
  assert.deepEqual((await lib.listHands(game.gameId)).hands.map((h) => h.unavailableCode), ['REPLAY_LIMIT_EXCEEDED', null]);
  const base = readJson(statePath(game.dir));
  fs.writeFileSync(statePath(game.dir), padded(base, 2 * 1024 * 1024 + 1));
  const row = (await lib.listGames()).games[0];
  assert.deepEqual([row.status, row.unavailableCode, row.seatCount], ['unavailable', 'REPLAY_LIMIT_EXCEEDED', null]);
  await rejectCode(lib.readHand(game.gameId, 1), 'REPLAY_LIMIT_EXCEEDED');
  await rejectCode(lib.listHands(game.gameId), 'REPLAY_LIMIT_EXCEEDED');
  fs.writeFileSync(statePath(game.dir), padded(base, 2 * 1024 * 1024));
  assert.equal((await lib.listGames()).games[0].status, 'unfinished');
  assert.equal((await lib.listHands(game.gameId)).hands.length, 2);
});

test('a page may read at most 16 MiB of states; the request fails rather than showing a truncated list', async () => {
  const store = makeStore();
  const seed = buildGame(store, { hands: 1, seed: 151 });
  const base = readJson(statePath(seed.dir));
  writeJson(statePath(seed.dir), { ...base, padding: 'x'.repeat(1_900_000) });
  for (let i = 0; i < 8; i += 1) writeJson(statePath(newSession(store).dir), { ...base, padding: 'x'.repeat(1_900_000) });
  const { lib } = library(store);
  assert.equal((await lib.listGames({ limit: 8 })).games.length, 8);
  await rejectCode(lib.listGames({ limit: 9 }), 'REPLAY_LIMIT_EXCEEDED');
  const tight = createReplayLibrary(store, { limits: { gamesReadBytes: 1000 } });
  await rejectCode(tight.listGames({ limit: 1 }), 'REPLAY_LIMIT_EXCEEDED');
  const raised = createReplayLibrary(store, { limits: { gamesReadBytes: 10 ** 12, responseBytes: 10 ** 12 } });
  await rejectCode(raised.listGames({ limit: 9 }), 'REPLAY_LIMIT_EXCEEDED');
  const handsStore = makeStore();
  const g = buildGame(handsStore, { hands: 3, seed: 152 });
  await rejectCode(createReplayLibrary(handsStore, { limits: { handsReadBytes: 5000 } }).listHands(g.gameId), 'REPLAY_LIMIT_EXCEEDED');
  await rejectCode(createReplayLibrary(handsStore, { limits: { responseBytes: 100 } }).readHand(g.gameId, 1), 'REPLAY_LIMIT_EXCEEDED');
});

test('enumeration is bounded: 10,001 entries or 1,001 sessions fail the whole request', async () => {
  const entries = makeStore();
  const sessions = path.join(entries, '.session-store', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < 10_000; i += 1) fs.writeFileSync(path.join(sessions, `n${i}`), '');
  const { lib } = library(entries);
  assert.deepEqual((await lib.listGames()).games, []);
  fs.writeFileSync(path.join(sessions, 'one-more'), '');
  await rejectCode(lib.listGames(), 'REPLAY_LIMIT_EXCEEDED');

  const many = makeStore();
  const dir = path.join(many, '.session-store', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 1000; i += 1) fs.mkdirSync(path.join(dir, randomUUID()));
  const listed = await library(many).lib.listGames({ limit: 50 });
  assert.equal(listed.games.length, 50);
  assert.ok(listed.games.every((g) => g.status === 'unavailable' && g.unavailableCode === 'REPLAY_UNAVAILABLE'));
  assert.equal(listed.nextOffset, 50);
  fs.mkdirSync(path.join(dir, randomUUID()));
  await rejectCode(library(many).lib.listGames(), 'REPLAY_LIMIT_EXCEEDED');
});

test('reading never changes the store: hashes, mtimes and inodes of every file are identical, and nothing is created', async () => {
  const store = makeStore();
  const a = buildGame(store, { hands: 3, seed: 161, replayReveal: 'all' });
  const b = buildGame(store, { hands: 2, seed: 162, ...multi });
  const live = startHand(a.state, { rng: mulberry32(1) }).state;
  saveState(a.dir, live);
  fs.writeFileSync(path.join(store, 'loop-state.json'), '{"canary":"LOOP"}');
  fs.mkdirSync(path.join(store, '.training'));
  fs.writeFileSync(path.join(store, '.training', 'profile.json'), '{}');
  const before = treeSnapshot(store);
  const { lib } = library(store);
  await lib.listGames();
  await lib.listHands(a.gameId);
  await lib.listHands(b.gameId, { offset: 1 });
  for (const n of [1, 2, 3]) await lib.readHand(a.gameId, n);
  await lib.readHand(b.gameId, 2);
  await assert.rejects(lib.readHand(a.gameId, 4));
  assert.deepEqual(treeSnapshot(store), before);
});

test('requests share work: same-page duplicates coalesce, at most two distinct builds run, a third is busy', async () => {
  const store = makeStore();
  const [a, b, c] = [1, 2, 3].map((seed) => buildGame(store, { hands: 2, seed }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let waiting = 0;
  const { lib, opened } = library(store, { yieldTurn: async () => { waiting += 1; await held; } });
  // A request that should have been refused would sit on the held yield forever; fail fast instead.
  const promptly = (promise) => Promise.race([promise, new Promise((_, reject) => { setTimeout(() => reject(new Error('still pending: not refused')), 500).unref(); })]);
  const first = lib.listHands(a.gameId);
  const duplicate = lib.listHands(a.gameId);
  const second = lib.readHand(b.gameId, 1);
  try {
    await rejectCode(promptly(lib.listHands(c.gameId)), 'REPLAY_BUSY');
    await rejectCode(promptly(lib.listGames()), 'REPLAY_BUSY');
  } finally { release(); }
  const [one, two, three] = await Promise.all([first, duplicate, second]);
  assert.deepEqual(one, two);
  assert.notStrictEqual(one, two);
  assert.equal(three.handNo, 1);
  assert.equal(opened.filter((p) => p.includes(a.gameId) && p.endsWith('state.json')).length, 1);
  assert.equal(waiting >= 1, true);
  // Nothing sticks: once the work has finished a new request is served normally.
  assert.equal((await lib.listHands(c.gameId)).hands.length, 2);
  assert.equal((await lib.listGames()).games.length, 3);
});

test('the event loop keeps turning while a full page of states is read', async () => {
  const store = makeStore();
  const seed = buildGame(store, { hands: 1, seed: 171 });
  const state = readJson(statePath(seed.dir));
  for (let i = 0; i < 49; i += 1) saveState(newSession(store).dir, state);
  const { lib } = library(store);
  let ticks = 0;
  let running = true;
  const spin = () => { ticks += 1; if (running) setImmediate(spin); };
  setImmediate(spin);
  const page = await lib.listGames({ limit: 50 });
  running = false;
  assert.equal(page.games.length, 50);
  assert.ok(ticks >= 50, `only ${ticks} turns of the event loop`);
});

test('a state held at its yield lets other work (a health-style probe) finish first', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 181 });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { lib } = library(store, { yieldTurn: () => held });
  const pending = lib.listGames();
  let order = [];
  pending.then(() => order.push('library'));
  await new Promise((resolve) => setTimeout(resolve, 20)).then(() => order.push('health'));
  assert.deepEqual(order, ['health']);
  release();
  await pending;
  assert.deepEqual(order, ['health', 'library']);
  assert.equal(game.gameId.length, 36);
});

test('an engine save that lands while a file is being read is REPLAY_BUSY, never a mixed or refused-bytes answer, and nothing is remembered', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 191, replayReveal: 'all' });
  let swap = null;
  const hook = (root, segments, limits) => {
    const bytes = openContained(root, segments, limits);
    if (swap && segments.at(-1) === swap.file) { const action = swap.run; swap = null; action(); }
    return bytes;
  };
  const { lib } = library(store, { openFile: hook });
  const clean = await lib.readHand(game.gameId, 2);

  swap = { file: STATE_FILE, run: () => saveState(game.dir, readJson(statePath(game.dir))) };
  await rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_BUSY');
  const retried = await lib.readHand(game.gameId, 2);
  assert.deepEqual([retried.replay, retried.revision], [clean.replay, clean.revision]);

  swap = { file: 'hand-0002.json', run: () => writeHandArchive(game.dir, game.records[1]) };
  await rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_BUSY');
  swap = { file: 'hand-0001.json', run: () => writeHandArchive(game.dir, game.records[0]) };
  const racing = await lib.listHands(game.gameId);
  assert.deepEqual(racing.hands.map((h) => [h.available, h.unavailableCode]), [[false, 'REPLAY_BUSY'], [true, null]]);
  assert.deepEqual((await lib.listHands(game.gameId)).hands.map((h) => h.available), [true, true]);

  swap = { file: STATE_FILE, run: () => saveState(game.dir, readJson(statePath(game.dir))) };
  const row = (await lib.listGames()).games[0];
  assert.deepEqual([row.status, row.unavailableCode, row.mode], ['unavailable', 'REPLAY_BUSY', null]);
  assert.equal((await lib.listGames()).games[0].status, 'unfinished');
  await rejectCode((async () => { swap = { file: STATE_FILE, run: () => saveState(game.dir, readJson(statePath(game.dir))) }; return lib.listHands(game.gameId); })(), 'REPLAY_BUSY');
  assert.equal((await lib.listHands(game.gameId)).hands.length, 2);
});

test('lstat naming an already-unlinked inode (nlink 0, seen mid-rename on macOS) is a busy replace, not a refusal', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 195, replayReveal: 'all' });
  const staleOnce = (fileName, times = 1) => {
    let left = times;
    return (file) => {
      const stat = fs.lstatSync(file);
      if (left > 0 && path.basename(file) === fileName) { left -= 1; return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 0 }); }
      return stat;
    };
  };
  for (const fileName of [STATE_FILE, 'hand-0002.json']) {
    const { lib, opened } = library(store, { lstat: staleOnce(fileName) });
    await rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_BUSY');
    assert.ok(!opened.some((p) => p.endsWith(fileName)), 'no bytes may be read from an inode seen unlinked');
    assert.equal((await lib.readHand(game.gameId, 2)).handNo, 2);
  }
  // During enumeration the same signal is a busy row, and a second look that finds nothing is a refusal.
  const row = (await library(store, { lstat: staleOnce(STATE_FILE) }).lib.listGames()).games[0];
  assert.deepEqual([row.status, row.unavailableCode], ['unavailable', 'REPLAY_BUSY']);
  const vanishing = (file) => {
    const stat = fs.lstatSync(file);
    if (path.basename(file) !== 'hand-0002.json') return stat;
    fs.unlinkSync(file);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 0 });
  };
  await rejectCode(library(store, { lstat: vanishing }).lib.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE');
});

test('consecutive atomic replacements remain busy when both observations see unlinked regular inodes', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 202 });
  const requests = [
    { file: STATE_FILE, run: (lib) => rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_BUSY') },
    { file: STATE_FILE, run: (lib) => rejectCode(lib.listHands(game.gameId), 'REPLAY_BUSY') },
    { file: STATE_FILE, run: async (lib) => assert.equal((await lib.listGames()).games[0].unavailableCode, 'REPLAY_BUSY') },
    { file: 'hand-0002.json', run: (lib) => rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_BUSY') },
    { file: 'hand-0002.json', run: async (lib) => assert.equal((await lib.listHands(game.gameId)).hands[1].unavailableCode, 'REPLAY_BUSY') },
  ];
  for (const { file: fileName, run } of requests) for (const phase of ['before', 'after']) {
    let read = false;
    const lstat = (file) => {
      const stat = fs.lstatSync(file);
      if (path.basename(file) !== fileName || (phase === 'after' && !read)) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 0 });
    };
    const { lib, opened } = library(store, { lstat, openFile: (root, segments, limits) => {
      const bytes = openContained(root, segments, limits);
      if (segments.at(-1) === fileName) read = true;
      return bytes;
    } });
    await run(lib);
    if (phase === 'before') assert.ok(!opened.some((file) => file.endsWith(fileName)), 'unlinked observations must never be opened');
    else assert.ok(read, 'a post-read unlink must discard the returned bytes');
  }
});

test('a contained-open replacement refusal with unchanged outer identity is busy, while permission failure stays unavailable', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 203 });
  for (const fileName of [STATE_FILE, 'hand-0002.json']) for (const code of ['UNSAFE_PATH', 'EACCES']) {
    const { lib } = library(store, { openFile: (root, segments, limits) => {
      if (segments.at(-1) === fileName) throw Object.assign(new Error('test refusal'), { code });
      return openContained(root, segments, limits);
    } });
    await rejectCode(lib.readHand(game.gameId, 2), code === 'UNSAFE_PATH' ? 'REPLAY_BUSY' : 'REPLAY_UNAVAILABLE');
  }
  for (const [fileName, cap] of [[STATE_FILE, 2 * 1024 * 1024], ['hand-0002.json', 256 * 1024]]) {
    const otherStore = makeStore();
    const other = buildGame(otherStore, { hands: 2, seed: 205 });
    const { lib } = library(otherStore, { openFile: (root, segments, limits) => {
      if (segments.at(-1) !== fileName) return openContained(root, segments, limits);
      fs.writeFileSync(path.join(root, ...segments), Buffer.alloc(cap + 1));
      throw Object.assign(new Error('test refusal'), { code: 'UNSAFE_PATH' });
    } });
    await rejectCode(lib.readHand(other.gameId, 2), 'REPLAY_LIMIT_EXCEEDED');
  }
});

test('an ancestor swapped during replacement refusal is unavailable before and after reads for every request', async () => {
  for (const request of ['detail', 'catalog', 'hands']) for (const phase of ['before', 'after', 'failure']) {
    const store = makeStore();
    const game = buildGame(store, { hands: 2, seed: 204 });
    let swap = true;
    let read = false;
    const replace = () => {
      swap = false;
      fs.renameSync(game.dir, `${game.dir}-old`);
      fs.mkdirSync(game.dir);
      fs.copyFileSync(path.join(`${game.dir}-old`, STATE_FILE), statePath(game.dir));
    };
    const { lib, opened } = library(store, { lstat: (file) => {
      const stat = fs.lstatSync(file);
      if (!swap || path.basename(file) !== STATE_FILE || phase === 'failure' || (phase === 'after' && !read)) return stat;
      replace();
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 0 });
    }, openFile: (root, segments, limits) => {
      if (phase === 'failure' && segments.at(-1) === STATE_FILE) {
        replace();
        throw Object.assign(new Error('test refusal'), { code: 'UNSAFE_PATH' });
      }
      const bytes = openContained(root, segments, limits);
      if (segments.at(-1) === STATE_FILE) read = true;
      return bytes;
    } });
    if (request === 'detail') await rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE');
    else if (request === 'hands') await rejectCode(lib.listHands(game.gameId), 'REPLAY_UNAVAILABLE');
    else assert.equal((await lib.listGames()).games[0].unavailableCode, 'REPLAY_UNAVAILABLE');
    if (phase === 'before') assert.equal(opened.length, 0, 'ancestor replacement must be rejected before any open');
    if (phase === 'after') assert.equal(read, true, 'the second ancestor check must discard read bytes');
  }
});

test('replacement retry guards reject missing and unsafe current leaves across detail and lists', async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 206 });
  const requests = [
    { file: STATE_FILE, run: (lib) => rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE') },
    { file: STATE_FILE, run: (lib) => rejectCode(lib.listHands(game.gameId), 'REPLAY_UNAVAILABLE') },
    { file: STATE_FILE, run: async (lib) => assert.equal((await lib.listGames()).games[0].unavailableCode, 'REPLAY_UNAVAILABLE') },
    { file: 'hand-0002.json', run: (lib) => rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE') },
    { file: 'hand-0002.json', run: async (lib) => assert.equal((await lib.listHands(game.gameId)).hands[1].unavailableCode, 'REPLAY_UNAVAILABLE') },
  ];
  for (const { file, run } of requests) for (const phase of ['before', 'after', 'failure']) for (const type of ['missing', 'symlink', 'hardlink', 'special']) {
    let read = false;
    let refused = false;
    let unlinked = false;
    const { lib, opened } = library(store, { lstat: (name) => {
      const stat = fs.lstatSync(name);
      if (path.basename(name) !== file || (phase === 'after' && !read) || (phase === 'failure' && !refused)) return stat;
      if (phase !== 'failure' && !unlinked) {
        unlinked = true;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 0 });
      }
      if (type === 'missing') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      const unsafe = type === 'hardlink' ? { nlink: 2 } : { isFile: () => false, isSymbolicLink: () => type === 'symlink' };
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, unsafe);
    }, openFile: (root, segments, limits) => {
      if (segments.at(-1) === file && phase === 'failure') {
        refused = true;
        throw Object.assign(new Error('test refusal'), { code: 'UNSAFE_PATH' });
      }
      const bytes = openContained(root, segments, limits);
      if (segments.at(-1) === file) read = true;
      return bytes;
    } });
    await run(lib);
    if (phase === 'before') assert.ok(!opened.some((name) => name.endsWith(file)), 'unsafe replacement must not be opened');
    if (phase === 'after') assert.equal(read, true, 'unsafe replacement must discard read bytes');
    if (phase === 'failure') assert.equal(refused, true, 'negative control must exercise opener refusal');
  }
});

test('a swap that is not a safe single-link regular file stays unavailable instead of busy', { skip: !POSIX }, async () => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 201 });
  const outside = makeStore();
  fs.writeFileSync(path.join(outside, 'x.json'), '{}');
  let swap = null;
  const hook = (root, segments, limits) => {
    const bytes = openContained(root, segments, limits);
    if (swap && segments.at(-1) === swap.file) { const action = swap.run; swap = null; action(); }
    return bytes;
  };
  const { lib } = library(store, { openFile: hook });
  const original = fs.readFileSync(handPath(game.dir, 2));
  swap = { file: 'hand-0002.json', run: () => { fs.rmSync(handPath(game.dir, 2)); fs.symlinkSync(path.join(outside, 'x.json'), handPath(game.dir, 2)); } };
  await rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE');
  fs.rmSync(handPath(game.dir, 2));
  fs.writeFileSync(handPath(game.dir, 2), original);
  // The replacement directory holds a perfectly safe file of the same name: only the ancestor check can refuse it.
  swap = { file: 'hand-0002.json', run: () => {
    fs.renameSync(path.join(game.dir, 'hands'), path.join(game.dir, 'hands-old'));
    fs.mkdirSync(path.join(game.dir, 'hands'));
    fs.copyFileSync(path.join(game.dir, 'hands-old', 'hand-0002.json'), handPath(game.dir, 2));
  } };
  await rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE');
  swap = { file: 'hand-0002.json', run: () => fs.rmSync(handPath(game.dir, 2), { force: true }) };
  fs.rmSync(path.join(game.dir, 'hands'), { recursive: true });
  fs.renameSync(path.join(game.dir, 'hands-old'), path.join(game.dir, 'hands'));
  await rejectCode(lib.readHand(game.gameId, 2), 'REPLAY_UNAVAILABLE');
});

test('reads overlapping a real engine writer (saveState + writeHandArchive in another process) are either a full answer or REPLAY_BUSY', async (t) => {
  const store = makeStore();
  const game = buildGame(store, { hands: 2, seed: 211, replayReveal: 'all' });
  const clean = await library(store).lib.readHand(game.gameId, 2);
  const writer = `
    import fs from 'node:fs';
    import { saveState, writeHandArchive } from ${JSON.stringify(pathToFileURL(path.resolve('engine/state.js')).href)};
    const [dir, millis] = process.argv.slice(1);
    const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
    const stop = Date.now() + Number(millis);
    let saves = 0;
    while (Date.now() < stop) {
      saveState(dir, state); writeHandArchive(dir, state.lastHand); saves += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    process.stdout.write(String(saves));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', writer, game.dir, '1500'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try { registerOwnedProcess(child, 'replay-library-writer'); } catch { /* sandbox identity probes may be denied; the owned child is still closed below */ }
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const { lib } = library(store);
  const tally = { ok: 0, busy: 0 };
  const settle = async (work) => {
    try { await work(); tally.ok += 1; } catch (error) {
      if (error.code !== 'REPLAY_BUSY') throw error;
      tally.busy += 1;
    }
  };
  let done = false;
  t.after(async () => { if (!done) { child.kill(); await exited; } });
  exited.then(() => { done = true; });
  while (!done) {
    await settle(async () => assert.deepEqual((await lib.readHand(game.gameId, 2)).replay, clean.replay));
    await settle(async () => {
      const hands = (await lib.listHands(game.gameId)).hands;
      assert.ok(hands.every((h) => h.available || h.unavailableCode === 'REPLAY_BUSY'), JSON.stringify(hands));
    });
    await settle(async () => {
      const row = (await lib.listGames()).games[0];
      assert.ok(row.status === 'unfinished' || row.unavailableCode === 'REPLAY_BUSY', JSON.stringify(row));
    });
  }
  assert.equal(await exited, 0, err);
  assert.ok(Number(out) > 50, `writer made ${out} saves`);
  assert.ok(tally.ok > 0, `no read ever succeeded: ${JSON.stringify(tally)}`);
  assert.deepEqual((await lib.readHand(game.gameId, 2)).replay, clean.replay);
  assert.equal((await lib.listGames()).games[0].status, 'unfinished');
});

test('an inaccessible session is one unavailable row, not a failed catalog', async () => {
  const store=makeStore(), good=buildGame(store,{hands:1}), denied=buildGame(store,{hands:1});
  const deniedState=path.join(fs.realpathSync(denied.dir),'state.json');
  const lib=createReplayLibrary(store,{lstat:(file,...rest)=>{
    if(String(file)===deniedState) throw Object.assign(new Error('private'),{code:'EACCES'});
    return fs.lstatSync(file,...rest);
  }});
  const listed=await lib.listGames();
  assert.equal(listed.games.find(row=>row.gameId===good.gameId).status,'unfinished');
  assert.equal(listed.games.find(row=>row.gameId===denied.gameId).unavailableCode,'REPLAY_UNAVAILABLE');
});
test('a real inaccessible POSIX session does not hide readable sessions', {skip:!POSIX || ROOT_USER}, async () => {
  const store=makeStore(), good=buildGame(store,{hands:1}), denied=buildGame(store,{hands:1});
  fs.chmodSync(denied.dir,0);
  try{
    const listed=await createReplayLibrary(store).listGames();
    assert.equal(listed.games.find(row=>row.gameId===good.gameId).status,'unfinished');
    assert.equal(listed.games.find(row=>row.gameId===denied.gameId).unavailableCode,'REPLAY_UNAVAILABLE');
  }finally{fs.chmodSync(denied.dir,0o700);}
});
test('raw required structures are rejected before projection can normalize them', async () => {
  for(const corrupt of [
    record=>{delete record.pots[0].eligible;}, record=>{record.pots[0].winners=null;},
    record=>{record.showdown=false;}, record=>{delete record.showdown;},
    record=>{record.showdown={reveals:[],mucks:null};}, record=>{delete record.holes.user;},
  ]){
    const store=makeStore(),game=buildGame(store,{hands:1});editHand(game.dir,1,corrupt);
    const lib=createReplayLibrary(store);
    assert.equal((await lib.listHands(game.gameId)).hands[0].unavailableCode,'REPLAY_UNAVAILABLE');
    await rejectCode(lib.readHand(game.gameId,1),'REPLAY_UNAVAILABLE');
  }
});

test('showdown reveal must be the exact saved pair: reversed is valid, duplicated is unavailable', async () => {
  const {createReplayGame}=await import('./helpers/replay-library-fixture.mjs');
  const store=makeStore(),game=createReplayGame(store,{hands:1});
  const file=game.handPath(1),record=readJson(file),reveal=record.showdown.reveals[0];assert.ok(reveal);
  const saved=[...record.holes[reveal.playerId]],lib=createReplayLibrary(store);
  reveal.cards=[...saved].reverse();writeJson(file,record);
  assert.deepEqual((await lib.readHand(game.gameId,1)).replay.showdown.reveals[0].cards,[...saved].reverse());
  reveal.cards=[saved[0],saved[0]];writeJson(file,record);
  await rejectCode(lib.readHand(game.gameId,1),'REPLAY_UNAVAILABLE');
  const row=(await lib.listHands(game.gameId)).hands[0];assert.equal(row.available,false);assert.equal(row.unavailableCode,'REPLAY_UNAVAILABLE');assert.equal('replay' in row,false);
});

test('aggregate byte cap binds the actual read even when states grow before open and their bytes are rejected as busy', async () => {
  const store=makeStore(),seed=buildGame(store,{hands:1}),state=readJson(statePath(seed.dir));
  const games=[seed,newSession(store),newSession(store)];
  for(const game of games)saveState(game.dir,state);
  const pristine=Buffer.from(JSON.stringify(state)),largeBytes=64*1024;
  assert.ok(pristine.length<largeBytes/2);
  const enlarged=Buffer.concat([pristine,Buffer.alloc(largeBytes-pristine.length,0x20)]);
  let swap=true,consumed=0;const caps=[];
  const lib=createReplayLibrary(store,{limits:{gamesReadBytes:largeBytes*2.5},openFile:(root,segments,options)=>{
    if(swap && segments.at(-1)==='state.json') {
      const file=path.join(root,...segments),tmp=file+'.writer';fs.writeFileSync(tmp,enlarged);fs.renameSync(tmp,file);
    }
    caps.push(options.maxBytes);
    const bytes=openContained(root,segments,options);consumed+=bytes.length;return bytes;
  }});
  await rejectCode(lib.listGames(),'REPLAY_LIMIT_EXCEEDED');
  assert.equal(consumed,largeBytes*2,'two full rejected reads count toward the total');
  assert.equal(caps.at(-1),largeBytes/2,'third read is bounded by the remaining aggregate bytes before I/O');
  assert.ok(consumed<=largeBytes*2.5);
  swap=false;for(const game of games)saveState(game.dir,state);
  assert.equal((await lib.listGames()).games.length,3,'budget is per request and never poisons a later read');
});

test('many pre-read permission failures do not spend bytes or hide a healthy session', async () => {
  const store=makeStore(),good=buildGame(store,{hands:1}),state=readJson(statePath(good.dir));
  const denied=new Set();
  for(let i=0;i<9;i++){const game=newSession(store);saveState(game.dir,state);denied.add(game.gameId);}
  const lib=createReplayLibrary(store,{openFile:(root,segments,options)=>{
    if(denied.has(segments.at(-2)))throw Object.assign(new Error('denied before read'),{code:'EACCES'});
    return openContained(root,segments,options);
  }});
  const page=await lib.listGames();assert.equal(page.games.length,10);
  assert.equal(page.games.find(row=>row.gameId===good.gameId).status,'unfinished');
  assert.equal(page.games.filter(row=>row.unavailableCode==='REPLAY_UNAVAILABLE').length,9);
});
