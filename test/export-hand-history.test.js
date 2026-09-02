import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, createGame, startHand } from '../engine/hand.js';
import { writeHandArchive } from '../engine/state.js';
import { vacateLive } from '../engine/game-archive.js';
import { commitSession, ensureSessionStore, prepareSession } from '../engine/session-catalog.js';
import { normalizeHand } from '../export/hand-normalizer.js';
import { buildCanonical, buildText } from '../export/manifest.js';
import { renderPokerStars } from '../export/pokerstars.js';
import { assertNoSecrets } from '../export/hand-normalizer.js';
import { HANDS } from './fixtures/hand-history/hands.js';
import { fixedDeck } from './helpers/fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine/cli.js');
const EXPORT = path.join(ROOT, 'tools/export-hh.js');
const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/hand-history');
const RENDER_OPTS = { gameId: '1', exportedAt: '2026/09/01 0:00:00 ET' };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-hh-'));
}

function run(bin, args) {
  return JSON.parse(execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' }).trim());
}

function runFail(bin, args) {
  try {
    execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    assert.fail('expected CLI failure');
  } catch (error) {
    const raw = String(error.stdout ?? '');
    try {
      return JSON.parse(raw.trim().split('\n').at(-1));
    } catch {
      return { ok: false, message: raw || String(error.message) };
    }
  }
}

function chipTotal(st) {
  return st.seats.reduce((sum, seat) => sum + seat.stack, 0)
    + Object.values(st.hand?.contribs ?? {}).reduce((sum, chips) => sum + chips, 0);
}

function setup3(userStack, p1Stack, p2Stack) {
  const st = createGame({ aiCount: 2 });
  st.button = 2;
  st.seats[0].stack = userStack;
  st.seats[1].stack = p1Stack;
  st.seats[2].stack = p2Stack;
  return startHand(st, { deck: fixedDeck() }).state;
}

function playRaiseFold() {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'raise', 200).state;
  st = applyAction(st, 'p1', 'fold').state;
  return applyAction(st, 'p2', 'fold').state;
}

test('10 authored hand-history fixtures match the PokerStars renderer', () => {
  assert.equal(HANDS.length, 10);
  const txtFiles = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.txt')).sort();
  assert.deepEqual(txtFiles, HANDS.map((entry) => entry.file).sort());
  for (const { file, record } of HANDS) {
    const canonical = normalizeHand(record);
    const { text, warnings } = renderPokerStars({ hands: [canonical] }, RENDER_OPTS);
    assert.equal(warnings.length, 0, file);
    const expected = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
    assert.equal(text, expected, file);
  }
});

test('archive → normalizer → PokerStars full path emits posts, raise-to, uncalled, collected', () => {
  const dir = tmp();
  const st = playRaiseFold();
  fs.mkdirSync(path.join(dir, 'hands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    lastHand: st.lastHand,
    config: st.config,
    gameEpoch: null,
    seats: st.seats,
  }));
  writeHandArchive(dir, st.lastHand);

  const canonical = buildCanonical(dir, { exportedAt: '2026/09/01 0:00:00 ET' });
  assert.equal(canonical.hands.length, 1);
  const hand = canonical.hands[0];
  assert.ok(Array.isArray(hand.posts) && hand.posts.length === 2);
  assert.equal(hand.uncalledReturns.user, 150);
  assert.equal(hand.actions[0].currentBet, 50);
  assert.equal(hand.actions[0].amount, 200);

  const { text } = buildText(canonical, RENDER_OPTS);
  assert.match(text, /p1: posts small blind 25/);
  assert.match(text, /p2: posts big blind 50/);
  assert.match(text, /user: raises 150 to 200/);
  assert.match(text, /Uncalled bet \(150\) returned to user/);
  assert.match(text, /user collected 125 from pot/);
  assert.equal(text.includes('raises to 200'), false);
  assert.equal(text.includes('raises by'), false);
});

test('folded-raise 100 live / 80 folded / 50 live returns Uncalled 20, shrinks pots, conserves chips', () => {
  let st = setup3(5000, 5000, 5000);
  const before = chipTotal(st);
  assert.equal(before, 15000);

  st.hand.contribs = { user: 50, p1: 80, p2: 50 };
  st.hand.folded = ['p1'];
  st.hand.allIn = ['p2'];
  st.hand.bets = { user: 50, p1: 80, p2: 50 };
  st.hand.currentBet = 100;
  st.hand.acted = ['p1', 'p2'];
  st.hand.toActIdx = 0;
  st.seats[0].stack = 4950;
  st.seats[1].stack = 4920;
  st.seats[2].stack = 4950;
  assert.equal(chipTotal(st), before);

  const finished = applyAction(st, 'user', 'call');
  const rec = finished.state.lastHand;
  assert.equal(chipTotal(finished.state), before);
  assert.equal(rec.uncalledReturns?.user, 20);
  assert.equal(Object.keys(rec.uncalledReturns ?? {}).length, 1);
  const potSum = rec.pots.reduce((sum, pot) => sum + pot.amount, 0);
  assert.equal(potSum, 210);
  assert.equal(rec.pots.length, 2);
  assert.equal(rec.pots.some((pot) => pot.amount === 20 && pot.eligible?.length === 1), false);

  const { text } = renderPokerStars({ hands: [normalizeHand(rec)] }, RENDER_OPTS);
  assert.match(text, /Uncalled bet \(20\) returned to user/);
});

test('unmatched all-in: unique max contributor survives, Uncalled 20, fewer pots', () => {
  let st = setup3(100, 80, 50);
  const before = chipTotal(st);
  assert.equal(before, 230);
  st = applyAction(st, 'user', 'raise', 100).state;
  const finished = applyAction(st, 'p1', 'call');
  const rec = finished.state.lastHand;
  assert.equal(chipTotal(finished.state), before);
  assert.equal(rec.uncalledReturns?.user, 20);
  const potSum = rec.pots.reduce((sum, pot) => sum + pot.amount, 0);
  assert.equal(potSum, 210);
  assert.equal(rec.pots.length, 2);
  assert.equal(rec.pots.some((pot) => pot.eligible?.length === 1 && pot.amount === 20), false);

  const { text } = renderPokerStars({ hands: [normalizeHand(rec)] }, RENDER_OPTS);
  assert.match(text, /Uncalled bet \(20\) returned to user/);
});

test('split pot repeats collected lines; side pot uses side pot-N', () => {
  const split = HANDS.find((entry) => entry.file === '09-showdown-muck-split.txt');
  const side = HANDS.find((entry) => entry.file === '10-side-pot.txt');
  const splitText = renderPokerStars({ hands: [normalizeHand(split.record)] }, RENDER_OPTS).text;
  assert.match(splitText, /p1 collected 75 from pot/);
  assert.match(splitText, /user collected 75 from pot/);
  const sideText = renderPokerStars({ hands: [normalizeHand(side.record)] }, RENDER_OPTS).text;
  assert.match(sideText, /p2 collected 300 from pot/);
  assert.match(sideText, /p2 collected 400 from side pot-1/);
});

test('unsupported hand is recorded on the manifest and omitted from text', () => {
  const dir = tmp();
  const good = playRaiseFold();
  fs.mkdirSync(path.join(dir, 'hands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    lastHand: good.lastHand,
    config: good.config,
    seats: good.seats,
  }));
  writeHandArchive(dir, good.lastHand);
  writeHandArchive(dir, {
    handNo: 2,
    blinds: [25, 50],
    button: 'user',
    startStacks: { user: 5000 },
    holes: { user: ['Ah', 'Kd'] },
    actions: [],
    pots: [],
    board: [],
  });

  const canonical = buildCanonical(dir, { exportedAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(canonical.hands.some((hand) => hand.handNo === 2), false);
  assert.ok(canonical.warnings.some((row) => (
    row.handNo === 2 && row.exportStatus === 'unsupported'
  )));
  const { text, warnings } = buildText(canonical, RENDER_OPTS);
  assert.ok(warnings.some((row) => row.handNo === 2 && row.exportStatus === 'unsupported'));
  assert.equal(text.includes('Hand #AIH1-2'), false);
  assert.match(text, /Hand #AIH1-1/);
});

test('forbidden literals include policyId, configDigest, sampledProbability, .session-store, absolute paths', () => {
  assert.throws(() => assertNoSecrets({ x: 'policyId' }), { code: 'FORBIDDEN_EXPORT' });
  assert.throws(() => assertNoSecrets({ x: 'configDigest' }), { code: 'FORBIDDEN_EXPORT' });
  assert.throws(() => assertNoSecrets({ x: 'sampledProbability' }), { code: 'FORBIDDEN_EXPORT' });
  assert.throws(() => assertNoSecrets({ x: '.session-store' }), { code: 'FORBIDDEN_EXPORT' });
  assert.throws(() => assertNoSecrets({ path: '/Users/sungmin/secret' }), { code: 'FORBIDDEN_EXPORT' });
  assert.doesNotThrow(() => assertNoSecrets({ hands: [{ heroCards: ['Ah', 'Kd'] }] }));
});

test('export CLI refuses an existing output file with EXISTS', () => {
  const dir = tmp();
  run(ENGINE, ['init', '--ai', '2', '--game-dir', dir]);
  run(ENGINE, ['new-hand', '--game-dir', dir]);
  for (let i = 0; i < 40; i += 1) {
    const legal = run(ENGINE, ['legal', '--game-dir', dir]);
    if (legal.handOver) break;
    const action = legal.toAct === 'user'
      ? (legal.canCheck ? 'check' : 'fold')
      : (legal.canCheck ? 'check' : 'call');
    run(ENGINE, ['apply', legal.toAct, action, '--game-dir', dir]);
  }
  const out = path.join(dir, 'exports', 'session.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'keep-me');
  const failed = runFail(EXPORT, ['--game-dir', dir, '--format', 'canonical-json', '--out', out]);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'EXISTS');
  assert.equal(fs.readFileSync(out, 'utf8'), 'keep-me');
});

test('export CLI refuses ancestor-symlink output and input symlink', () => {
  const dir = tmp();
  run(ENGINE, ['init', '--ai', '2', '--game-dir', dir]);
  run(ENGINE, ['new-hand', '--game-dir', dir]);
  for (let i = 0; i < 40; i += 1) {
    const legal = run(ENGINE, ['legal', '--game-dir', dir]);
    if (legal.handOver) break;
    const action = legal.toAct === 'user'
      ? (legal.canCheck ? 'check' : 'fold')
      : (legal.canCheck ? 'check' : 'call');
    run(ENGINE, ['apply', legal.toAct, action, '--game-dir', dir]);
  }

  const real = path.join(dir, 'real-out');
  fs.mkdirSync(path.join(real, 'nested'), { recursive: true });
  const link = path.join(dir, 'link-out');
  fs.symlinkSync(real, link);
  const out = path.join(link, 'nested', 'session.txt');
  const ancestor = runFail(EXPORT, [
    '--game-dir', dir, '--format', 'pokerstars', '--out', out,
  ]);
  assert.equal(ancestor.ok, false);
  assert.equal(ancestor.code, 'UNSAFE_PATH');
  assert.equal(fs.existsSync(out), false);

  const statePath = path.join(dir, 'state.json');
  const realState = path.join(dir, 'state.real.json');
  fs.renameSync(statePath, realState);
  fs.symlinkSync(realState, statePath);
  const input = runFail(EXPORT, [
    '--game-dir', dir, '--format', 'canonical-json', '--out', path.join(dir, 'safe.json'),
  ]);
  assert.equal(input.ok, false);
  assert.equal(input.code, 'UNSAFE_PATH');
});

test('export CLI reads archive directories and --store-dir current sessions', () => {
  const gameDir = tmp();
  run(ENGINE, ['init', '--ai', '2', '--game-dir', gameDir]);
  run(ENGINE, ['new-hand', '--game-dir', gameDir]);
  for (let i = 0; i < 40; i += 1) {
    const legal = run(ENGINE, ['legal', '--game-dir', gameDir]);
    if (legal.handOver) break;
    const action = legal.toAct === 'user'
      ? (legal.canCheck ? 'check' : 'fold')
      : (legal.canCheck ? 'check' : 'call');
    run(ENGINE, ['apply', legal.toAct, action, '--game-dir', gameDir]);
  }
  const archivedTo = vacateLive(gameDir, { fs, now: () => new Date('2026-09-01T00:00:00Z') });
  const archiveDir = path.join(gameDir, archivedTo);
  const archiveOut = path.join(tmp(), 'from-archive.json');
  const fromArchive = run(EXPORT, [
    '--game-dir', archiveDir, '--format', 'canonical-json', '--out', archiveOut,
    '--exported-at', '2026-09-01T00:00:00.000Z',
  ]);
  assert.equal(fromArchive.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(archiveOut, 'utf8')).hands.length, 1);

  const storeDir = tmp();
  ensureSessionStore(storeDir);
  const prepared = prepareSession(storeDir);
  const played = playRaiseFold();
  fs.writeFileSync(path.join(prepared.stagingDir, 'state.json'), JSON.stringify({
    lastHand: played.lastHand,
    config: played.config,
    seats: played.seats,
  }));
  fs.mkdirSync(path.join(prepared.stagingDir, 'hands'));
  writeHandArchive(prepared.stagingDir, played.lastHand);
  commitSession(storeDir, prepared);
  const storeOut = path.join(tmp(), 'from-store.json');
  const fromStore = run(EXPORT, [
    '--store-dir', storeDir, '--format', 'canonical-json', '--out', storeOut,
    '--exported-at', '2026-09-01T00:00:00.000Z',
  ]);
  assert.equal(fromStore.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(storeOut, 'utf8')).hands.length, 1);
});

test('normalizeHand copies posts, uncalledReturns, and action currentBet', () => {
  const hand = normalizeHand({
    handNo: 1,
    button: 'user',
    blinds: [25, 50],
    holes: { user: ['Ah', 'Kd'] },
    posts: [{ playerId: 'p1', amount: 25, allIn: false }],
    uncalledReturns: { user: 20 },
    actions: [{ playerId: 'user', action: 'raise', amount: 100, street: 'preflop', currentBet: 50 }],
    startStacks: { user: 5000, p1: 5000 },
    pots: [],
  });
  assert.deepEqual(hand.posts, [{ playerId: 'p1', amount: 25, allIn: false }]);
  assert.deepEqual(hand.uncalledReturns, { user: 20 });
  assert.equal(hand.actions[0].currentBet, 50);
});
