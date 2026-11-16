import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newDeck } from '../engine/cards.js';
import { ensureSessionStore } from '../engine/session-catalog.js';
import { applyAction, legalFor } from '../engine/hand.js';
import { startDrillServer } from '../tools/drill-server.js';
import { gameChecksOf, reportFromRecords } from '../tools/host-insights.js';
import { PLAY_REPORT_ABORTED, createPlayReportReader } from '../tools/play-report-store.js';
import { createReplayLibrary } from '../tools/replay-library.js';
import { openContained } from '../tools/training-store.js';
import { setup3 } from './helpers/fixtures.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { createReplayGame } from './helpers/replay-library-fixture.mjs';

function makeStore() {
  const store = createOwnedTempDir('play-report-store');
  ensureSessionStore(store);
  return store;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function playScripted(state, user) {
  let current = state;
  while (!legalFor(current).handOver) {
    const legal = legalFor(current);
    const [action, amount] = legal.toAct === 'user' ? user(legal) : (legal.canCheck ? ['check'] : ['fold']);
    current = applyAction(current, legal.toAct, action, amount).state;
  }
  return current.lastHand;
}
const guest = [{ playerId: 'h1', participantId: 'pt-1', name: 'Guest' }];

// A reader whose library records every file it opens.
function tracked(store, options = {}) {
  const opened = [];
  const library = createReplayLibrary(store, { ...options,
    openFile: (root, segments, limits) => { opened.push(segments.at(-1)); return openContained(root, segments, limits); } });
  return { reader: createPlayReportReader(store, { library, now: () => '2026-11-16T00:00:00.000Z' }), opened };
}

test('the report covers every game in the store and reuses finished games', async () => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 3 });
  createReplayGame(store, { aiCount: 2, hands: 2, mode: 'tournament' });
  const { reader, opened } = tracked(store);
  const first = await reader.read();
  assert.equal(first.report.scope.totalGames, 2);
  assert.equal(first.report.scope.heroHands, 5);
  assert.equal(first.report.generatedAt, '2026-11-16T00:00:00.000Z');
  assert.deepEqual(first.report.scope.unreadableGames, 0);
  assert.ok(first.view.sections.some((section) => section.id === 'tendency'));
  // The cash game ran to its hand limit; the tournament is still open.
  assert.equal(reader.cachedGames(), 1);
  assert.equal(opened.filter((name) => name.startsWith('hand-')).length, 5);
  opened.length = 0;
  const second = await reader.read();
  assert.deepEqual(second.report, first.report);
  assert.equal(opened.filter((name) => name.startsWith('hand-')).length, 2, 'a finished game is not read again');
  // Concurrent callers share one scan.
  const [a, b] = await Promise.all([reader.read(), reader.read()]);
  assert.equal(a, b);
});

test('a game still being played is read again, and a new game appears', async () => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 2, ongoing: true });
  const { reader, opened } = tracked(store);
  assert.equal((await reader.read()).report.scope.heroHands, 2);
  assert.equal(reader.cachedGames(), 0);
  opened.length = 0;
  await reader.read();
  assert.equal(opened.filter((name) => name.startsWith('hand-')).length, 2);
  createReplayGame(store, { aiCount: 2, hands: 1 });
  assert.equal((await reader.read()).report.scope.totalGames, 2);
});

test('the scan gives the event loop back after every hand and stops when its only caller gives up', async () => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 3 });
  createReplayGame(store, { aiCount: 2, hands: 2 });
  let yields = 0;
  const reader = createPlayReportReader(store, { yieldTurn: async () => { yields += 1; } });
  await reader.read();
  assert.equal(yields, 5, 'one yield per hand reduced');
  assert.equal(reader.cachedGames(), 2);
  // A caller that gives up: it is rejected at once and the scan ends at the next hand.
  const stop = new AbortController();
  let reduced = 0;
  const fresh = createPlayReportReader(store, { yieldTurn: async () => { reduced += 1; if (reduced === 4) stop.abort(); } });
  await assert.rejects(fresh.read({ signal: stop.signal }), { code: PLAY_REPORT_ABORTED });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(reduced, 4, 'no hand was reduced after the stop');
  assert.equal(fresh.cachedGames(), 1, 'the game finished before the stop is kept');
  assert.equal((await fresh.read()).report.scope.heroHands, 5, 'a later read completes');
  // A signal that is already aborted never starts reading hands.
  const dead = new AbortController();
  dead.abort();
  const { reader: idle, opened } = tracked(store);
  await assert.rejects(idle.read({ signal: dead.signal }), { code: PLAY_REPORT_ABORTED });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(opened.filter((name) => name.startsWith('hand-')), []);
});

// A reader whose scan stops at its `at`-th reduced hand until released; `entered`
// resolves when the scan is really there.
function gated(store, at) {
  let release;
  let arrived;
  const entered = new Promise((resolve) => { arrived = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let reduced = 0;
  const reader = createPlayReportReader(store, { yieldTurn: async () => { reduced += 1; if (reduced === at) { arrived(); await gate; } } });
  return { reader, entered, release, reduced: () => reduced };
}

test('callers of one scan wait on their own terms: a deadline holds, and the scan outlives it for the others', async (t) => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 3 });
  createReplayGame(store, { aiCount: 2, hands: 3 });
  const held = gated(store, 2);
  const pair = gated(store, 1);
  // A failed assertion must not leave a scan suspended at its gate.
  t.after(() => { held.release(); pair.release(); });
  const boot = held.reader.read();                              // no signal: like the loop's boot scan
  const deadline = new AbortController();
  const review = held.reader.read({ signal: deadline.signal }); // joins the same scan with a deadline
  await held.entered;
  deadline.abort();
  await assert.rejects(review, { code: PLAY_REPORT_ABORTED }, 'the joining caller is released at its own deadline');
  assert.equal(held.reduced(), 2, 'while the scan is still held');
  held.release();
  assert.equal((await boot).report.scope.heroHands, 6, 'the caller without a deadline still gets the whole report');
  // Two callers with deadlines: the scan stops only when the last one leaves.
  const a = new AbortController();
  const b = new AbortController();
  const first = pair.reader.read({ signal: a.signal });
  const other = pair.reader.read({ signal: b.signal });
  first.catch(() => {});
  await pair.entered;
  a.abort();
  await assert.rejects(first, { code: PLAY_REPORT_ABORTED });
  pair.release();
  assert.equal((await other).report.scope.heroHands, 6, 'one caller leaving does not stop the scan the other waits for');
  // Aborting after the answer arrived changes nothing.
  b.abort();
  assert.equal((await pair.reader.read()).report.scope.heroHands, 6);
});

test('a read started right after the last caller left gets its own scan, and the old scan unwinding undoes nothing', async (t) => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 3 });
  createReplayGame(store, { aiCount: 2, hands: 3 });
  const held = gated(store, 2);
  t.after(() => held.release());
  const gone = new AbortController();
  const abandoned = held.reader.read({ signal: gone.signal });
  await held.entered;
  gone.abort();
  await assert.rejects(abandoned, { code: PLAY_REPORT_ABORTED });
  // The old scan stays held at its gate while the new read runs to its end: it must not join
  // it, and a third caller joins the new one.
  const replacement = held.reader.read();
  assert.equal(held.reader.read(), replacement, 'one replacement scan for both callers');
  const out = await replacement;
  assert.equal(out.report.scope.heroHands, 6);
  assert.equal(out.report.scope.truncated, false);
  assert.equal(held.reader.cachedGames(), 2);
  // Now the old scan unwinds (it sees its abort at the next hand) with both games cached.
  held.release();
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(held.reduced(), 8, 'the old scan reduced nothing after its gate: two hands of its own, six of the new scan');
  assert.equal(held.reader.cachedGames(), 2, 'the unwinding scan did not undo what the new one cached');
  const { reader: fresh } = tracked(store);
  // What the cache holds is what a reader that never saw the old scan computes.
  const timeless = (report) => ({ ...report, generatedAt: null });
  assert.deepEqual(timeless((await held.reader.read()).report), timeless((await fresh.read()).report));
});

test('giving up while a game is being read stops the hand reads', async () => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 3 });
  const library = createReplayLibrary(store);
  const stop = new AbortController();
  let loads = 0;
  const watched = createReplayLibrary(store, { yieldTurn: async () => { loads += 1; if (loads === 3) stop.abort(); } });
  await assert.rejects(watched.readReportGame((await library.listReportGames())[0].gameId,
    { budget: { used: 0, limit: library.reportReadBytes }, signal: stop.signal }), { code: PLAY_REPORT_ABORTED, fatal: true });
  assert.ok(loads <= 4, `the read went on for ${loads} yields`);
});

test('a hand that cannot be read is counted and the game is tried again', async () => {
  const store = makeStore();
  const game = createReplayGame(store, { aiCount: 2, hands: 3 });
  const original = fs.readFileSync(game.handPath(2));
  fs.writeFileSync(game.handPath(2), '{ not json');
  const { reader } = tracked(store);
  const broken = await reader.read();
  assert.equal(broken.report.scope.unreadableHands, 1);
  assert.equal(broken.report.scope.heroHands, 2);
  assert.equal(reader.cachedGames(), 0, 'an incomplete read is not kept');
  fs.writeFileSync(game.handPath(2), original);
  const repaired = await reader.read();
  assert.equal(repaired.report.scope.unreadableHands, 0);
  assert.equal(repaired.report.scope.heroHands, 3);
  assert.equal(reader.cachedGames(), 1);
});

test('the read budget ends the scan and the report says it is partial', async () => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 3 });
  createReplayGame(store, { aiCount: 2, hands: 3 });
  const { reader } = tracked(store, { limits: { reportReadBytes: 6000 } });
  const out = await reader.read();
  assert.equal(out.report.scope.truncated, true);
  assert.ok(out.report.scope.totalGames < 2);
});

test('a cut scan keeps what it did not reach, and a store too large to list gives a partial report', async () => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 3 });
  createReplayGame(store, { aiCount: 2, hands: 3 });
  const library = createReplayLibrary(store);
  let limit = library.reportReadBytes;
  const cut = { ...library, get reportReadBytes() { return limit; } };
  const reader = createPlayReportReader(store, { library: cut });
  await reader.read();
  assert.equal(reader.cachedGames(), 2);
  // The next scan runs out of budget at once: both finished games stay known.
  limit = 1;
  const partial = await reader.read();
  assert.equal(partial.report.scope.truncated, true);
  assert.equal(reader.cachedGames(), 2);
  limit = library.reportReadBytes;
  assert.equal((await reader.read()).report.scope.heroHands, 6);
  // The library refuses to list (more sessions than its limit): a partial, empty report, not a failure.
  const refusing = createPlayReportReader(store, { library: { ...library, listReportGames: async () => { throw Object.assign(new Error('REPLAY_LIMIT_EXCEEDED'), { code: 'REPLAY_LIMIT_EXCEEDED', fatal: true }); } } });
  const empty = await refusing.read();
  assert.equal(empty.report.scope.truncated, true);
  assert.equal(empty.report.scope.heroHands, 0);
  await assert.rejects(createPlayReportReader(store, { library: { ...library, listReportGames: async () => { throw new Error('other'); } } }).read());
});

test('a participant\'s hidden hole cards cannot change any number or line', async () => {
  const build = () => {
    const store = makeStore();
    // Hand 1: the guest is first to act and folds, so the guest's cards stay hidden.
    const game = createReplayGame(store, { aiCount: 1, hands: 2, mode: 'tournament', participants: guest, foldFirst: true });
    return { store, game };
  };
  const a = build();
  const b = build();
  const record = readJson(b.game.handPath(1));
  assert.ok(record.folded.includes('h1'), 'fixture: the guest folded');
  assert.ok(!(record.showdown?.reveals ?? []).some((row) => row.playerId === 'h1'), 'fixture: the guest showed nothing');
  const used = new Set([...Object.values(record.holes).flat(), ...record.board]);
  const other = newDeck().filter((card) => !used.has(card)).slice(0, 2);
  assert.notDeepEqual(record.holes.h1, other);
  record.holes.h1 = other;
  for (const decision of record.decisions ?? []) if (decision.actorId === 'h1') decision.holeCards = other;
  writeJson(b.game.handPath(1), record);
  const strip = (out) => JSON.parse(JSON.stringify({ report: out.report, view: out.view }).replaceAll(a.game.gameId, 'GAME').replaceAll(b.game.gameId, 'GAME')
    .replace(/"(savedAt|from|to)":"[^"]*"/g, '"$1":"T"').replace(/\d{4}-\d{2}-\d{2} · /g, 'DAY · '));
  const reportA = await tracked(a.store).reader.read();
  const reportB = await tracked(b.store).reader.read();
  assert.equal(reportA.report.scope.heroHands, 2);
  assert.deepEqual(strip(reportB), strip(reportA));
  // What the library hands over holds no card of the guest's for that hand.
  const library = createReplayLibrary(b.store);
  const handed = await library.readReportGame(b.game.gameId, { budget: { used: 0, limit: library.reportReadBytes } });
  const text = JSON.stringify(handed.hands[0]);
  for (const card of other) assert.ok(!text.includes(`"${card}"`), card);
  assert.equal(Object.hasOwn(handed.hands[0].replay.holes, 'h1'), false);
  assert.ok(handed.hands[0].decisions.every((decision) => decision.actorId === 'user'));
  assert.equal(handed.meta.solo, false);
});

test('the opponent identity of a policy game is proved by the policy named on each AI action', async () => {
  const store = makeStore();
  const game = createReplayGame(store, { aiCount: 2, hands: 2 });
  const statePath = path.join(game.sessionDir, 'state.json');
  const state = readJson(statePath);
  state.config.opponentRuntime = 'policy';
  writeJson(statePath, state);
  const library = createReplayLibrary(store);
  const read = async () => (await library.readReportGame(game.gameId, { budget: { used: 0, limit: library.reportReadBytes } })).meta;
  assert.equal((await read()).policy, null, 'actions without a policy record: the identity is unknown');
  const stamp = (handNo, mark) => {
    const record = readJson(game.handPath(handNo));
    for (const action of record.actions) if (action.playerId !== 'user') Object.assign(action, mark(action));
    writeJson(game.handPath(handNo), record);
  };
  const v3 = () => ({ policyId: 'tag-v3', policyVersion: '3.0.0' });
  stamp(1, v3); stamp(2, v3);
  const meta = await read();
  assert.deepEqual({ opponent: meta.opponent, policy: meta.policy, solo: meta.solo, seats: meta.seats, stackBb: meta.stackBb, mode: meta.mode },
    { opponent: 'policy', policy: '3.0.0', solo: true, seats: 3, stackBb: 100, mode: 'cash-training' });
  // A game resumed under a newer policy is not one population.
  stamp(2, () => ({ policyId: 'tag-v3', policyVersion: '3.1.0' }));
  assert.equal((await read()).policy, null, 'two versions');
  stamp(2, (action) => (action.playerId === 'p2' ? { policyId: 'self-mirror-v1', policyVersion: '3.0.0' } : v3()));
  assert.equal((await read()).policy, null, 'a seat derived from the host is not a fixed opponent');
  stamp(2, v3);
  assert.equal((await read()).policy, '3.0.0');
  // An unread hand could hide another version.
  fs.writeFileSync(game.handPath(1), '{ not json');
  assert.equal((await read()).policy, null);
  // The hands are skipped when the caller already holds this state.
  const known = (await library.readReportGame(game.gameId, { budget: { used: 0, limit: library.reportReadBytes } })).identity;
  const reused = await library.readReportGame(game.gameId, { budget: { used: 0, limit: library.reportReadBytes }, known });
  assert.equal(reused.reused, true);
  assert.equal(reused.hands, undefined);
});

test('an empty or missing store gives an empty report', async () => {
  const empty = await createPlayReportReader(makeStore()).read();
  assert.equal(empty.report.scope.heroHands, 0);
  // No hand yet: only the training preset population's progress line, at zero (#351).
  assert.deepEqual(empty.view, { focus: [], sections: [], progress: '비교 가능한 핸드 0 / 200 (6인 · 100BB · 정책 v3)' });
  const missing = await createPlayReportReader(path.join(makeStore(), 'absent')).read();
  assert.equal(missing.report.scope.totalGames, 0);
});

test('the study listener serves the report to the token holder and announces the capability', async () => {
  const store = makeStore();
  createReplayGame(store, { aiCount: 2, hands: 3 });
  const token = 'a'.repeat(64);
  const { port, close } = await startDrillServer({ storeDir: store, token, port: 0, replayEnabled: false });
  try {
    const base = `http://127.0.0.1:${port}`;
    const get = (pathname, headers = { 'x-drill-token': token }) => fetch(base + pathname, { headers: { ...headers, connection: 'close' } });
    assert.equal((await get('/api/report', {})).status, 401);
    assert.equal((await fetch(`${base}/api/report`, { method: 'POST', headers: { 'x-drill-token': token, connection: 'close' } })).status, 404);
    const response = await get('/api/report');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['ok', 'report', 'view']);
    assert.equal(body.report.scope.heroHands, 3);
    assert.ok(Array.isArray(body.view.sections) && body.view.sections.length > 0);
    const health = await (await get('/api/health')).json();
    assert.equal(health.capabilities.playReport, 1);
    assert.equal(health.capabilities.study, true);
  } finally {
    await close();
  }
});

test('the in-game host report adds the game\'s own pattern lines and keeps each finished hand', () => {
  // Three-handed, the host has eight big blinds on the button and opens small.
  const record = playScripted(setup3(400, 5000, 5000),
    (legal) => (legal.canCheck ? ['check'] : legal.canRaise && legal.callAmount === 50 ? ['raise', legal.minRaiseTo] : ['fold']));
  const context = { seats: [{ playerId: 'user' }, { playerId: 'p1' }, { playerId: 'p2' }], reveal: 'all', key: 'game-a' };
  const report = reportFromRecords([record], context);
  assert.ok(report.checks.some((line) => line.includes('10BB 이하에서 올인이 아닌 진입 1회(핸드 1)')), report.checks.join('\n'));
  assert.deepEqual(reportFromRecords([record]).checks.filter((line) => line.includes('10BB 이하')), [], 'no context, no pattern lines');
  // The finished hand is not reduced again: a changed copy under the same game key is not re-read.
  const changed = { ...record, actions: [] };
  assert.deepEqual(gameChecksOf([changed], context).checks.shortNonAllIn, [1]);
  // Another game starts from nothing.
  assert.deepEqual(gameChecksOf([changed], { ...context, key: 'game-b' }).checks.shortNonAllIn, [1], 'decisions carry the check');
  assert.deepEqual(gameChecksOf([{ ...record, decisions: [] }], { ...context, key: 'game-c' }).checks.shortNonAllIn, []);
});
