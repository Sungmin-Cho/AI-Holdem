import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
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

// A resend carries the recorded body only, never a fresh clock (#319). The drain after
// ATTEMPT_PENDING names no body, so it carries no clock at all. The automatic resend after a
// failed POST (#274) is spawned right after the invocation that failed, repeats its arguments
// and is bound to the record that invocation left: publish.js sends that record and builds
// nothing from the body flags. So the record on disk when the resend runs must be the bound one
// and must carry the very clock its arguments name.
const RESEND_ONLY = new Set(['--expect-attempt-sha256', '--expect-game-epoch', '--deadline-monotonic-ns']);
const withoutResendFlags = (args) => args.filter((arg, i) => arg !== '--retry' && !RESEND_ONLY.has(arg) && !RESEND_ONLY.has(args[i - 1]));
function assertResendsCarryNoFreshClock({publishes, attempts, recovery}) {
  publishes.forEach((args, index) => {
    if (!args.includes('--retry') || !args.includes('--level-clock')) return;
    // Which recovery ran: a refusal logs publish-refused before the relay check; a transport
    // failure logs only the relay check (server-recovery-verified or server-recovered).
    const detail = () => JSON.stringify({index, flags: args.filter((arg) => arg.startsWith('--')), recovery});
    const bound = argAfter(args, '--expect-attempt-sha256');
    assert.ok(bound, `a clock-carrying resend is bound to the record it resends: ${detail()}`);
    const failed = publishes[index - 1];
    assert.ok(failed && !failed.includes('--retry') && isDeepStrictEqual(withoutResendFlags(failed), withoutResendFlags(args)),
      `a clock-carrying resend repeats the invocation that failed just before it: ${detail()}`);
    const record = attempts[index];
    assert.equal(record ? sha256(JSON.stringify(record.body)) : null, bound, `the bound record is the one on disk when the resend ran: ${detail()}`);
    assert.deepEqual(record.body.levelClock, publishedClock(argAfter(args, '--level-clock')), `the record it sends carries that same clock: ${detail()}`);
  });
}
const RECOVERY_EVENTS = new Set(['publish-refused', 'publish-recovery', 'server-recovery-verified', 'server-recovered']);
const RECOVERY_FIELDS = ['event', 'code', 'mode', 'httpStatus', 'serverCode', 'retry', 'bound', 'retire'];

const PUBLISH_CLI = fileURLToPath(new URL('../tools/publish.js', import.meta.url));

// #319: one real transport failure. Armed, the next publish runs the real publisher against a
// relay port that reads the whole request and drops the connection without an answer: it
// records its attempt, its POST fails (PUBLISH_FAILED with the record's identity) and the live
// lock is restored before the shim exits. Every other invocation is the real publisher. The
// shim, its plan and its report live in their own owned directory, never inside the game
// directory. By default the drop waits for the whole request; one dropped mid-body fails as
// EPIPE or ECONNRESET instead. `beforeRequest` (#339) answers the connection with FIN before
// reading anything, half-open so the request written next is taken without a reset: on Node 20
// (and on Node 22 on Windows) fetch then never settles, and the publisher must still end its
// POST at the budget with the same PUBLISH_FAILED.
async function transportFailingPublisher(t, {beforeRequest = false} = {}) {
  const dir = createOwnedTempDir('holdem-timed-shim');
  const plan = path.join(dir, 'plan.json');
  const report = path.join(dir, 'report.json');
  const shim = path.join(dir, 'publish-shim.cjs');
  const sockets = new Set();
  const drop = beforeRequest
    ? net.createServer({allowHalfOpen: true}, (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.end();
    })
    : http.createServer((req) => { req.resume(); req.on('end', () => req.socket.destroy()); });
  await new Promise((resolve) => drop.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    if (beforeRequest) for (const socket of sockets) socket.destroy();
    else drop.closeAllConnections();
    drop.close(() => resolve());
  }));
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

// #319: plays the user's turns (check, else fold) and stops the loop only on the user's own open
// turn — a decision the driver has not answered — where the loop waits on the user. A stop that
// lands inside a loop step (a policy decision's engine call, a new hand) ends run() with STOPPING
// by design, and these tests await run() as a clean end. `stop()` ends the driver first, so the
// loop comes to that turn and waits there (a game that ended has none); without it within
// `waitMs` the loop is still stopped, for cleanup, and the stop fails as not clean.
function userTurnDriver(root, loop, {stopAtHand = Infinity, control = {holdUser: false}} = {}) {
  const sent = new Set();
  const openUserTurn = (snap) => snap?.view?.toAct === 'user' && Boolean(snap.view.legal?.decisionId)
    && !sent.has(snap.view.legal.decisionId);
  let posting = false;
  let stopping = false;
  const timer = setInterval(async () => {
    if (posting || stopping) return;
    posting = true;
    try {
      const snap = readJson(root, 'ui-snapshot.json');
      if (snap.view?.handNo >= stopAtHand && openUserTurn(snap)) { stopping = true; await loop.requestStop(); return; }
      const legal = snap.view?.legal;
      if (openUserTurn(snap) && loop.playState !== 'paused' && !control.holdUser) {
        const lock = readJson(root, 'lock.json');
        const response = await fetch(`http://127.0.0.1:${lock.port}/api/action`, {method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({token: lock.sessionToken, decisionId: legal.decisionId, requestId: randomUUID(), action: legal.canCheck ? 'check' : 'fold'})});
        if (response.ok) sent.add(legal.decisionId);
      }
    } catch { /* the relay may be between states */ } finally { posting = false; }
  }, 20);
  const clear = () => clearInterval(timer);
  const stop = async ({waitMs = 5_000} = {}) => {
    clear();
    stopping = true;
    const ready = () => {
      const snap = peekJson(root, 'ui-snapshot.json');
      return openUserTurn(snap) || snap?.view?.gameOver === true;
    };
    const deadline = Date.now() + waitMs;
    while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (ready()) return loop.requestStop();
    await loop.requestStop().catch(() => {});
    throw new Error(`the loop reached no open user turn to stop at within ${waitMs}ms`);
  };
  return {clear, stop};
}

// A timed tournament against one policy AI. Each publish moves the play clock
// by `stepMs` (fractional on purpose: outside values must stay whole ms).
// `engineHook(args, root)` sees every engine CLI call first (a promise holds it); `userOnButton`
// deals hand 1 with the user on the button.
async function timedFixture(t, {managed = false, stepMs = 20_000.6, stopAtHand = 6, failOnce = null, transportFailOnce = false,
  engineHook = null, userOnButton = false} = {}) {
  const root = createOwnedTempDir('holdem-timed-loop');
  const clock = {play: 1000.25};
  const control = {holdUser: false};
  const publishes = [];
  const attempts = []; // by invocation: the recorded attempt a --retry found on disk, else null
  const injected = {index: null};
  const recovery = [];
  const transport = transportFailOnce
    ? await transportFailingPublisher(t, {beforeRequest: transportFailOnce === 'before-request'}) : null;
  const loop = createGameLoop({gameDir: root, resolver: async () => ({player: null, upper: null, notices: []}), opts: {
    port: 0, waitMs: 0, opponentRuntime: 'policy', pace: 'instant', resultHoldSec: 0,
    ...(managed ? {controlProtocolVersion: 1, playClockCheckpointMs: 10} : {}),
    ...(transport ? {publishCliPath: transport.shim} : {}),
    ...(engineHook ? {onEngineInvoke: (args) => engineHook(args, root)} : {}),
    // Closed fields of the publish recovery records only, for failure messages.
    log: (record) => {
      if (RECOVERY_EVENTS.has(record.event)) recovery.push(Object.fromEntries(RECOVERY_FIELDS.filter((key) => key in record).map((key) => [key, record[key]])));
    },
    playClockNow: () => clock.play,
    onPublishInvoke: (args) => {
      publishes.push([...args]);
      // The publisher is spawned right after this: a resend will send the record on disk now.
      attempts.push(args.includes('--retry') ? peekJson(root, '.publish-attempt.json') : null);
      clock.play += stepMs;
      // One injected publisher failure on a clock-carrying publish makes the loop resend.
      if (failOnce && args.includes('--level-clock') && readJson(root, 'state.json').handNo >= 2) {
        const code = failOnce;
        failOnce = null;
        injected.index = publishes.length - 1;
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
  if (userOnButton) {
    // The next deal moves the button one seat on: put it on the seat before the user's.
    const state = readJson(root, 'state.json');
    const userIdx = state.seats.findIndex((seat) => seat.playerId === 'user');
    state.button = (userIdx + state.seats.length - 1) % state.seats.length;
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state));
  }
  const driver = userTurnDriver(root, loop, {stopAtHand, control});
  t.after(async () => { driver.clear(); await loop.requestStop().catch(() => {}); });
  const stop = () => driver.stop();
  return {root, loop, clock, control, publishes, attempts, injected, recovery, transport, stop};
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
  // The injected ATTEMPT_PENDING is drained next, without a clock and without a binding.
  assert.ok(Number.isInteger(f.injected.index), 'the injected failure happened');
  const drain = f.publishes[f.injected.index + 1];
  assert.ok(drain?.includes('--retry'), 'the injected failure made the loop drain the recorded attempt');
  assert.equal(drain.includes('--level-clock') || drain.includes('--expect-attempt-sha256'), false, JSON.stringify(drain));
  assertResendsCarryNoFreshClock(f);
  const snap = readJson(f.root, 'ui-snapshot.json');
  if (snap.view && !snap.view.gameOver) {
    assert.deepEqual(snap.levelClock.nextBlinds, blindsForLevel(engine.level + 1, engine.config.blinds0));
  }
});

// #319: a stop inside an AI step ends run() with STOPPING by design, so the fixture must never
// stop there. Heads-up, the button acts first preflop: with the user on the button in hand 1 the
// AI opens hand 6, the stop hand, and every policy decision of that hand is held 500 ms in its
// engine call. The fixture must let that decision through and stop on the user's turn after it.
// A driver that stopped on the hand number alone stopped either before the AI's decision (no
// hold seen) or inside the hold (run() rejected with STOPPING).
test('#319 the fixture stops on the user\'s open turn, never inside an AI step of the stop hand', {timeout: 120000}, async (t) => {
  const held = [];
  const f = await timedFixture(t, {userOnButton: true, engineHook: (args, root) => {
    if (args[0] !== 'decision-peek') return undefined;
    const handNo = peekJson(root, 'state.json')?.handNo;
    if (!(handNo >= 6)) return undefined;
    held.push(handNo);
    return new Promise((resolve) => setTimeout(resolve, 500));
  }});
  await f.loop.run();
  assert.ok(held.includes(6), `the fixture stopped before the AI's decision in the stop hand: held ${JSON.stringify(held)}`);
  assert.ok(handLevels(f.root).length >= 5, JSON.stringify(handLevels(f.root)));
});

// #319: a real transport failure on a clock-carrying publish sends the loop down its automatic
// resend (#274), which repeats the failed invocation's arguments, bound to the record that
// invocation left. The publisher sends that record, so the relay shows the original clock.
function assertBoundResendAfterTransportFailure(f) {
  const {failedIndex, resendIndex, shownAfterResend} = f.transport;
  assert.ok(Number.isInteger(failedIndex), 'a clock-carrying publish met the dropped connection');
  const failed = f.transport.report();
  assert.equal(failed.status, 1, `the publisher replied instead of exiting unsettled: ${JSON.stringify(failed)}`);
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
  // The diagnostics tell a transport failure from a refusal: the relay check, no refusal.
  assert.ok(f.recovery.some((row) => row.event === 'server-recovery-verified' || row.event === 'server-recovered'), JSON.stringify(f.recovery));
  assert.equal(f.recovery.some((row) => row.event === 'publish-refused'), false, JSON.stringify(f.recovery));
  assertResendsCarryNoFreshClock(f);
}

test('a resend after a failed POST shows the recorded clock, never a fresh one', {timeout: 120000}, async (t) => {
  const f = await timedFixture(t, {transportFailOnce: true});
  await f.loop.run();
  assertBoundResendAfterTransportFailure(f);
});

// #339: the same recovery when the relay drops the connection before it reads the request.
test('a POST dropped before the relay reads it still fails as PUBLISH_FAILED and is resent bound to its record', {timeout: 120000}, async (t) => {
  const f = await timedFixture(t, {transportFailOnce: 'before-request'});
  await f.loop.run();
  assertBoundResendAfterTransportFailure(f);
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
  const driver = userTurnDriver(f.root, resumed, {stopAtHand: 5});
  t.after(() => driver.clear());
  await resumed.run();
  const after = readJson(f.root, 'state.json').levelClock;
  assert.ok(after.playMs >= saved, JSON.stringify({saved, after}));
  assert.ok(after.levelStartedMs >= savedEngine.levelStartedMs);
});
