import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGameLoop, parseGameLoopArgs} from '../tools/game-loop.js';
import {cliModeDefaults} from '../shared/game-setup.js';
import {blindsForLevel} from '../engine/hand.js';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';

const MINUTE = 60_000;
const readJson = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const handLevels = (root) => fs.readdirSync(path.join(root, 'hands')).filter((name) => /^hand-\d+\.json$/.test(name)).sort()
  .map((name) => readJson(path.join(root, 'hands'), name)).map((record) => ({handNo: record.handNo, level: record.level}));
const parseClock = (value) => {
  const [levelMs, remainingMs, at, running, blinds] = value.split('|');
  return {levelMs: Number(levelMs), remainingMs: Number(remainingMs), at, running, blinds};
};

// A timed tournament against one policy AI. Each publish moves the play clock
// by `stepMs` (fractional on purpose: outside values must stay whole ms).
async function timedFixture(t, {managed = false, stepMs = 20_000.6, stopAtHand = 6, failOnce = null} = {}) {
  const root = createOwnedTempDir('holdem-timed-loop');
  const clock = {play: 1000.25};
  const control = {holdUser: false};
  const publishes = [];
  const loop = createGameLoop({gameDir: root, resolver: async () => ({player: null, upper: null, notices: []}), opts: {
    port: 0, waitMs: 0, opponentRuntime: 'policy', pace: 'instant', resultHoldSec: 0,
    ...(managed ? {controlProtocolVersion: 1, playClockCheckpointMs: 10} : {}),
    playClockNow: () => clock.play,
    onPublishInvoke: (args) => {
      publishes.push([...args]);
      clock.play += stepMs;
      // One injected publisher failure on a clock-carrying publish makes the loop resend.
      if (failOnce && args.includes('--level-clock') && readJson(root, 'state.json').handNo >= 2) {
        const code = failOnce;
        failOnce = null;
        throw Object.assign(new Error('injected publish failure'), {code});
      }
    },
  }});
  await loop.bootstrap({ai: 1, mode: 'tournament', stack: 20000, levelMinutes: 1, opponentRuntime: 'policy'});
  let posting = false;
  const sent = new Set();
  let stopping = false;
  const timer = setInterval(async () => {
    if (posting) return;
    posting = true;
    try {
      const snap = readJson(root, 'ui-snapshot.json');
      if (!stopping && snap.view?.handNo >= stopAtHand) { stopping = true; await loop.requestStop(); return; }
      const legal = snap.view?.legal;
      if (snap.view?.toAct === 'user' && legal?.decisionId && !sent.has(legal.decisionId) && loop.playState !== 'paused' && !control.holdUser) {
        const lock = readJson(root, 'lock.json');
        const response = await fetch(`http://127.0.0.1:${lock.port}/api/action`, {method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({token: lock.sessionToken, decisionId: legal.decisionId, requestId: randomUUID(), action: legal.canCheck ? 'check' : 'fold'})});
        if (response.ok) sent.add(legal.decisionId);
      }
    } catch { /* the relay may be between states */ } finally { posting = false; }
  }, 20);
  t.after(() => clearInterval(timer));
  return {root, loop, clock, control, publishes, stop: () => { clearInterval(timer); return loop.requestStop(); }};
}

test('CLI and setup carry the level minutes to a tournament', () => {
  assert.equal(parseGameLoopArgs(['--level-minutes', '2']).levelMinutes, 2);
  assert.equal(Object.hasOwn(parseGameLoopArgs([]), 'levelMinutes'), false);
  for (const bad of ['0', '61', '1.5']) assert.throws(() => parseGameLoopArgs(['--level-minutes', bad]), {code: 'USAGE'});
  assert.throws(() => parseGameLoopArgs(['--level-minutes', '2', '--level-every', '8']), {code: 'USAGE'});
  // A fresh store request with only the minutes is a tournament, not cash training.
  assert.equal(cliModeDefaults({storeDir: '/s', levelMinutes: 2}).mode, undefined);
});

test('a timed tournament rises one level per hand after each level\'s play time', {timeout: 120000}, async (t) => {
  const f = await timedFixture(t, {failOnce: 'ATTEMPT_PENDING'});
  await f.loop.run();
  const engine = readJson(f.root, 'state.json');
  assert.equal(engine.config.levelMinutes, 1);
  assert.equal(engine.config.levelEvery, null);
  const levels = handLevels(f.root);
  assert.ok(levels.length >= 5, JSON.stringify(levels));
  for (let i = 1; i < levels.length; i++) {
    const step = levels[i].level - levels[i - 1].level;
    assert.ok(step === 0 || step === 1, JSON.stringify(levels));
  }
  assert.ok(levels.at(-1).level >= 1, JSON.stringify(levels));
  // Whole milliseconds everywhere the clock leaves the loop.
  assert.ok(Number.isSafeInteger(engine.levelClock.playMs) && Number.isSafeInteger(engine.levelClock.levelStartedMs));
  const loopState = readJson(f.root, 'loop-state.json');
  assert.ok(Number.isSafeInteger(loopState.playClockMs));
  assert.ok(loopState.playClockMs >= engine.levelClock.playMs);
  // Every live hand view carries the level clock; it never runs past the level.
  const clocks = f.publishes.filter((args) => args.includes('--level-clock')).map((args) => parseClock(args[args.indexOf('--level-clock') + 1]));
  assert.ok(clocks.length > 0);
  for (const clock of clocks) {
    assert.equal(clock.levelMs, MINUTE);
    assert.ok(Number.isSafeInteger(clock.remainingMs) && clock.remainingMs >= 0 && clock.remainingMs <= MINUTE);
    assert.equal(clock.running, '1');
    assert.ok(Number.isFinite(Date.parse(clock.at)));
  }
  // A resend carries the recorded body only, never a fresh clock.
  const retries = f.publishes.filter((args) => args.includes('--retry'));
  assert.ok(retries.length >= 1, 'the injected failure made the loop resend');
  assert.ok(retries.every((args) => !args.includes('--level-clock')));
  const snap = readJson(f.root, 'ui-snapshot.json');
  if (snap.view && !snap.view.gameOver) {
    assert.deepEqual(snap.levelClock.nextBlinds, blindsForLevel(engine.level + 1, engine.config.blinds0));
  }
});

test('paused time does not count toward the level and the clock resumes after the park', {timeout: 120000}, async (t) => {
  let pauseAt = null;
  const f = await timedFixture(t, {managed: true, stepMs: 1000, stopAtHand: 99});
  const running = f.loop.run();
  running.catch(() => {});
  // Wait for hand 2, then pause and spend ten minutes parked.
  for (let i = 0; i < 400 && !(readJson(f.root, 'state.json').handNo >= 2); i++) await new Promise((r) => setTimeout(r, 25));
  // While the clock runs, checkpoints follow it without any publish: hold the
  // user's turn so the loop only waits, then move the clock.
  f.control.holdUser = true;
  for (let i = 0; i < 400 && readJson(f.root, 'ui-snapshot.json').view?.toAct !== 'user'; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  const quietPublishes = f.publishes.length;
  const beforeTick = readJson(f.root, 'loop-state.json').playClockMs;
  f.clock.play += 7_000;
  for (let i = 0; i < 200 && !(readJson(f.root, 'loop-state.json').playClockMs >= beforeTick + 7_000); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.publishes.length, quietPublishes, 'no publish happened while the user held the turn');
  assert.ok(readJson(f.root, 'loop-state.json').playClockMs >= beforeTick + 7_000, 'the running clock is checkpointed by its timer');
  const paused = await f.loop.pause();
  assert.equal(paused.state, 'paused');
  pauseAt = readJson(f.root, 'loop-state.json').playClockMs;
  assert.ok(Number.isSafeInteger(pauseAt));
  const level = readJson(f.root, 'state.json').level;
  f.clock.play += 10 * MINUTE;
  // Many checkpoint intervals pass while parked: the timer is gone with the clock.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(readJson(f.root, 'loop-state.json').playClockMs, pauseAt, 'a parked loop writes no play time');
  const handBefore = readJson(f.root, 'state.json').handNo;
  f.control.holdUser = false;
  await f.loop.resumePlay();
  for (let i = 0; i < 400 && !(readJson(f.root, 'state.json').handNo > handBefore); i++) await new Promise((r) => setTimeout(r, 25));
  const engine = readJson(f.root, 'state.json');
  assert.ok(engine.handNo > handBefore);
  // Only the publishes since the park (1 s each) count: far less than a level.
  assert.equal(engine.level, level);
  assert.ok(engine.levelClock.playMs - pauseAt < MINUTE, JSON.stringify({pauseAt, clock: engine.levelClock}));
  const snap = readJson(f.root, 'ui-snapshot.json');
  assert.equal(snap.levelClock.running, true);
  await f.stop();
  await running;
  // A stop records the clock it reached.
  assert.ok(readJson(f.root, 'loop-state.json').playClockMs >= engine.levelClock.playMs);
});

test('a resumed timed game restores its play time and never runs the clock back', {timeout: 120000}, async (t) => {
  const f = await timedFixture(t, {stopAtHand: 3});
  await f.loop.run();
  // run() returns on the stop request; the lock is released when the stop completes.
  await f.loop.requestStop();
  const recorded = readJson(f.root, 'loop-state.json').playClockMs;
  const savedEngine = readJson(f.root, 'state.json').levelClock;
  assert.ok(recorded >= savedEngine.playMs);
  // A checkpoint that got ahead of the engine's last hand start.
  const saved = recorded + 50_000;
  fs.writeFileSync(path.join(f.root, 'loop-state.json'), JSON.stringify({...readJson(f.root, 'loop-state.json'), playClockMs: saved}));
  // A loop that stops before it restores the clock writes no play time.
  const early = createGameLoop({gameDir: f.root, resolver: async () => ({player: null, upper: null, notices: []}), opts: {
    port: 0, waitMs: 0, opponentRuntime: 'policy', pace: 'instant', resultHoldSec: 0, playClockNow: () => 0}});
  await early.resume();
  await early.requestStop();
  assert.equal(readJson(f.root, 'loop-state.json').playClockMs, saved);
  // A new loop over the same game, its own clock starting from zero.
  const playStart = {now: 0};
  const resumed = createGameLoop({gameDir: f.root, resolver: async () => ({player: null, upper: null, notices: []}), opts: {
    port: 0, waitMs: 0, opponentRuntime: 'policy', pace: 'instant', resultHoldSec: 0, playClockNow: () => playStart.now,
    onPublishInvoke: () => { playStart.now += 500; },
  }});
  await resumed.resume();
  let posting = false;
  const sent = new Set();
  const timer = setInterval(async () => {
    if (posting) return;
    posting = true;
    try {
      const snap = readJson(f.root, 'ui-snapshot.json');
      if (snap.view?.handNo >= 5) { clearInterval(timer); await resumed.requestStop(); return; }
      const legal = snap.view?.legal;
      if (snap.view?.toAct === 'user' && legal?.decisionId && !sent.has(legal.decisionId)) {
        const lock = readJson(f.root, 'lock.json');
        const response = await fetch(`http://127.0.0.1:${lock.port}/api/action`, {method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({token: lock.sessionToken, decisionId: legal.decisionId, requestId: randomUUID(), action: legal.canCheck ? 'check' : 'fold'})});
        if (response.ok) sent.add(legal.decisionId);
      }
    } catch { /* between states */ } finally { posting = false; }
  }, 20);
  t.after(() => clearInterval(timer));
  await resumed.run();
  const after = readJson(f.root, 'state.json').levelClock;
  assert.ok(after.playMs >= saved, JSON.stringify({saved, after}));
  assert.ok(after.levelStartedMs >= savedEngine.levelStartedMs);
});
