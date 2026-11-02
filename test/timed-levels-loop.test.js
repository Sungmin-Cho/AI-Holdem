import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {createGameLoop, parseGameLoopArgs} from '../tools/game-loop.js';
import {cliModeDefaults} from '../shared/game-setup.js';
import {blindsForLevel} from '../engine/hand.js';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';

const MINUTE = 60_000;
const readJson = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
// For waits that may start before the loop wrote the file.
const peekJson = (root, name) => { try { return readJson(root, name); } catch { return null; } };
const handLevels = (root) => fs.readdirSync(path.join(root, 'hands')).filter((name) => /^hand-\d+\.json$/.test(name)).sort()
  .map((name) => readJson(path.join(root, 'hands'), name)).map((record) => ({handNo: record.handNo, level: record.level}));
const parseClock = (value) => {
  const [levelMs, remainingMs, at, running, blinds] = value.split('|');
  return {levelMs: Number(levelMs), remainingMs: Number(remainingMs), at, running, blinds};
};
const argAfter = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
// The body field publish.js builds from a --level-clock value.
const publishedClock = (value) => {
  const [levelMs, remainingMs, at, running, blinds] = value.split('|');
  return {levelMs: Number(levelMs), remainingMs: Number(remainingMs), at, running: running === '1', nextBlinds: blinds.split('/').map(Number)};
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A resend carries the recorded body only, never a fresh clock.
function assertResendsCarryNoFreshClock(publishes) {
  const retries = publishes.filter((args) => args.includes('--retry'));
  assert.ok(retries.every((args) => !args.includes('--level-clock')));
}

const PUBLISH_CLI = fileURLToPath(new URL('../tools/publish.js', import.meta.url));

// #319: one real transport failure. Armed, the next publish runs the real publisher against a
// relay port that accepts the connection and drops it at once: it records its attempt, its POST
// fails (PUBLISH_FAILED with the record's identity) and the live lock is restored before the
// shim exits. Every other invocation is the real publisher. The shim, its plan and its report
// live in their own owned directory, never inside the game directory.
async function transportFailingPublisher(t) {
  const dir = createOwnedTempDir('holdem-timed-shim');
  const plan = path.join(dir, 'plan.json');
  const report = path.join(dir, 'report.json');
  const shim = path.join(dir, 'publish-shim.cjs');
  const drop = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => drop.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => drop.close(resolve)));
  fs.writeFileSync(shim, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawnSync } = require('node:child_process');",
    `const REAL = ${JSON.stringify(PUBLISH_CLI)};`,
    `const PLAN = ${JSON.stringify(plan)};`,
    `const REPORT = ${JSON.stringify(report)};`,
    'const args = process.argv.slice(2);',
    "let armed = null; try { armed = JSON.parse(fs.readFileSync(PLAN, 'utf8')); } catch {}",
    'if (armed) {',
    '  fs.unlinkSync(PLAN);',
    "  const gameDir = args[args.indexOf('--game-dir') + 1];",
    "  const lockPath = path.join(gameDir, 'lock.json');",
    "  const live = fs.readFileSync(lockPath, 'utf8');",
    '  fs.writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(live), port: armed.port }));',
    '  let run;',
    "  try { run = spawnSync(process.execPath, [REAL, ...args], { encoding: 'utf8' }); } finally { fs.writeFileSync(lockPath, live); }",
    "  let attempt = null; try { attempt = JSON.parse(fs.readFileSync(path.join(gameDir, '.publish-attempt.json'), 'utf8')); } catch {}",
    "  const lines = (run.stdout ?? '').trim().split('\\n');",
    '  let reply = null; try { reply = JSON.parse(lines.at(-1)); } catch {}',
    '  fs.writeFileSync(REPORT, JSON.stringify({ status: run.status, reply, attemptBody: attempt?.body ?? null }));',
    "  process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    '  process.exitCode = run.status ?? 1;',
    '} else {',
    "  const run = spawnSync(process.execPath, [REAL, ...args], { stdio: 'inherit' });",
    '  process.exitCode = run.status ?? 1;',
    '}',
    '',
  ].join('\n'));
  return {
    shim,
    armed: false, failedIndex: null, resendIndex: null, shownAfterResend: undefined,
    arm(index) {
      fs.writeFileSync(plan, JSON.stringify({port: drop.address().port}));
      this.armed = true;
      this.failedIndex = index;
    },
    report: () => JSON.parse(fs.readFileSync(report, 'utf8')),
  };
}

// A timed tournament against one policy AI. Each publish moves the play clock
// by `stepMs` (fractional on purpose: outside values must stay whole ms).
async function timedFixture(t, {managed = false, stepMs = 20_000.6, stopAtHand = 6, failOnce = null, transportFailOnce = false} = {}) {
  const root = createOwnedTempDir('holdem-timed-loop');
  const clock = {play: 1000.25};
  const control = {holdUser: false};
  const publishes = [];
  const transport = transportFailOnce ? await transportFailingPublisher(t) : null;
  const loop = createGameLoop({gameDir: root, resolver: async () => ({player: null, upper: null, notices: []}), opts: {
    port: 0, waitMs: 0, opponentRuntime: 'policy', pace: 'instant', resultHoldSec: 0,
    ...(managed ? {controlProtocolVersion: 1, playClockCheckpointMs: 10} : {}),
    ...(transport ? {publishCliPath: transport.shim} : {}),
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
      if (!transport) return;
      const index = publishes.length - 1;
      if (!transport.armed) {
        if (!args.includes('--retry') && args.includes('--level-clock') && readJson(root, 'state.json').handNo >= 2) transport.arm(index);
      } else if (transport.resendIndex === null) {
        if (args.includes('--retry')) transport.resendIndex = index;
      } else if (transport.shownAfterResend === undefined) {
        // The next publish has not run yet: the relay still shows what the resend sent.
        transport.shownAfterResend = peekJson(root, 'ui-snapshot.json')?.levelClock ?? null;
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
  t.after(async () => { clearInterval(timer); await loop.requestStop().catch(() => {}); });
  return {root, loop, clock, control, publishes, transport, stop: () => { clearInterval(timer); return loop.requestStop(); }};
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
  const retries = f.publishes.filter((args) => args.includes('--retry'));
  assert.ok(retries.length >= 1, 'the injected failure made the loop resend');
  assertResendsCarryNoFreshClock(f.publishes);
  const snap = readJson(f.root, 'ui-snapshot.json');
  if (snap.view && !snap.view.gameOver) {
    assert.deepEqual(snap.levelClock.nextBlinds, blindsForLevel(engine.level + 1, engine.config.blinds0));
  }
});

// #319: a real transport failure on a clock-carrying publish sends the loop down its automatic
// resend (#274), which repeats the failed invocation's arguments, bound to the record that
// invocation left. The publisher sends that record, so the relay shows the original clock.
test('a resend after a failed POST shows the recorded clock, never a fresh one', {timeout: 120000}, async (t) => {
  const f = await timedFixture(t, {transportFailOnce: true});
  await f.loop.run();
  const {failedIndex, resendIndex, shownAfterResend} = f.transport;
  assert.ok(Number.isInteger(failedIndex), 'a clock-carrying publish met the dropped connection');
  const failed = f.transport.report();
  assert.equal(failed.reply?.code, 'PUBLISH_FAILED', JSON.stringify(failed.reply));
  const original = f.publishes[failedIndex];
  const recorded = failed.attemptBody;
  assert.deepEqual(recorded?.levelClock, publishedClock(argAfter(original, '--level-clock')), 'the record keeps the failed invocation\'s clock');
  assert.ok(Number.isInteger(resendIndex), 'the loop resent');
  const resend = f.publishes[resendIndex];
  assert.equal(argAfter(resend, '--expect-attempt-sha256'), sha256(JSON.stringify(recorded)), 'the resend is bound to that record');
  assert.equal(argAfter(resend, '--level-clock'), argAfter(original, '--level-clock'), 'the resend repeats the failed invocation\'s arguments, clock included');
  assert.deepEqual(shownAfterResend, recorded.levelClock, 'the relay shows the recorded clock');
  assert.ok(handLevels(f.root).length >= 3, 'the game went on after the resend');
  assertResendsCarryNoFreshClock(f.publishes);
});

test('paused time does not count toward the level and the clock resumes after the park', {timeout: 120000}, async (t) => {
  let pauseAt = null;
  const f = await timedFixture(t, {managed: true, stepMs: 1000, stopAtHand: 99});
  const running = f.loop.run();
  running.catch(() => {});
  // Wait for hand 2, then pause and spend ten minutes parked.
  for (let i = 0; i < 400 && !(peekJson(f.root, 'state.json')?.handNo >= 2); i++) await new Promise((r) => setTimeout(r, 25));
  // While the clock runs, checkpoints follow it without any publish: hold the
  // user's turn so the loop only waits, then move the clock.
  f.control.holdUser = true;
  for (let i = 0; i < 400 && peekJson(f.root, 'ui-snapshot.json')?.view?.toAct !== 'user'; i++) await new Promise((r) => setTimeout(r, 10));
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

test('a loop whose lock was replaced writes no play time, by timer or by stop', {timeout: 120000}, async (t) => {
  const f = await timedFixture(t, {managed: true, stepMs: 1000, stopAtHand: 99});
  const running = f.loop.run();
  running.catch(() => {});
  // Hold the user's turn so nothing but the checkpoint timer could write.
  f.control.holdUser = true;
  for (let i = 0; i < 400 && !(peekJson(f.root, 'state.json')?.handNo >= 1 && peekJson(f.root, 'ui-snapshot.json')?.view?.toAct === 'user'); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  const before = readJson(f.root, 'loop-state.json').playClockMs;
  assert.ok(Number.isSafeInteger(before));
  // Another owner takes the game: the lock directory is replaced.
  const lockDir = path.join(f.root, 'loop.lock.d');
  fs.renameSync(lockDir, `${lockDir}.replaced`);
  fs.mkdirSync(lockDir);
  f.clock.play += 30_000;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(readJson(f.root, 'loop-state.json').playClockMs, before, 'no checkpoint after the lock was lost');
  await f.stop().catch(() => {});
  await running.catch(() => {});
  assert.equal(readJson(f.root, 'loop-state.json').playClockMs, before, 'the stop of a lock-less loop does not record it');
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
