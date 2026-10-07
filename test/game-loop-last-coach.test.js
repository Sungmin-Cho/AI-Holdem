import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGameLoop } from '../tools/game-loop.js';
import {
  HU_BUST_DECK, cliJson, coachInvocations, decisionIdOfMessage, makeAdapter, makeCoachAdapter, postUserAction,
  putUserOnTheButton, readJson, resolverForCoach, startRun, tmpGame, waitForUserSnapshot, writeLoopStateFixture,
} from './helpers/game-loop-fixtures.mjs';

// Design D10/G8: the last hand's coach starts before the result-wait cutoff and
// gets a bounded wait. A generation inside the wait is published before the
// cutoff; a longer one is neither cancelled by the wait nor re-reserved — the
// existing cutoff path takes it from there.
async function lastHand(t, { gateMs, waitMs }) {
  const gameDir = tmpGame();
  const init = await cliJson(gameDir, ['init', '--ai', '1', '--stack', '100']);
  putUserOnTheButton(gameDir);
  const started = await cliJson(gameDir, ['step', '--new-hand', '--deck', HU_BUST_DECK]);
  assert.equal(started.next.toAct, 'user');
  writeLoopStateFixture(gameDir, init.sessionToken, { phase: 'playing', handNo: 1 });
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const upper = makeCoachAdapter({
    rounds: [{ gate, raw: JSON.stringify({ handNo: 1, text: '마지막 핸드 결정을 평가했습니다.' }) }],
  });
  const player = makeAdapter({ onDecide: (input) => ({ raw: JSON.stringify({ decisionId: decisionIdOfMessage(input.message), action: 'call' }) }) });
  const calls = [];
  const loop = createGameLoop({
    gameDir,
    resolver: resolverForCoach(player, upper),
    opts: {
      port: 0, waitMs: 40, lastHandCoachWaitMs: waitMs,
      // The result-wait clock starts when the bounded wait ends.
      onFinalizationDeadline: () => { events.push({ at: Date.now(), what: 'clock', terminations: upper.terminations.length }); },
      onCoachInvoke: (args) => {
        calls.push({ kind: 'coach', args });
        if (args[0] === 'finalize-cutoff') events.push({ at: Date.now(), what: 'cutoff', terminations: upper.terminations.length });
      },
    },
  });
  t.after(() => { release(); return loop.requestStop().catch(() => {}); });
  await loop.resume();
  const running = startRun(loop);
  const { lock, snapshot } = await waitForUserSnapshot(gameDir);
  const startedAt = Date.now();
  setTimeout(() => { events.push({ at: Date.now(), what: 'coach-done' }); release(); }, gateMs);
  await postUserAction(lock, { decisionId: snapshot.view.legal.decisionId, action: 'raise', amount: snapshot.view.legal.maxRaiseTo });
  assert.equal((await running).phase, 'done');
  return { gameDir, upper, calls, events, startedAt };
}

test('a last-hand coach that finishes inside the wait is published before the cutoff', { timeout: 60_000 }, async (t) => {
  const { gameDir, calls, events, upper } = await lastHand(t, { gateMs: 300, waitMs: 5_000 });
  const done = events.find((row) => row.what === 'coach-done');
  const clock = events.find((row) => row.what === 'clock');
  assert.ok(done && clock && done.at <= clock.at, `the clock started after the coach finished: ${JSON.stringify(events)}`);
  const note = readJson(path.join(gameDir, 'ui-snapshot.json')).coach.find((row) => row.handNo === 1);
  assert.equal(note.unavailable, undefined);
  assert.equal(note.text, '마지막 핸드 결정을 평가했습니다.');
  assert.equal(upper.starts.length, 1);
  assert.equal(coachInvocations(calls, 'reserve').length, 1);
});

test('a longer last-hand coach is not cancelled by the wait and not reserved again', { timeout: 60_000 }, async (t) => {
  const { calls, events, upper, startedAt } = await lastHand(t, { gateMs: 4_000, waitMs: 400 });
  const clock = events.find((row) => row.what === 'clock');
  assert.ok(clock, JSON.stringify(events));
  assert.ok(clock.at - startedAt >= 400, 'the clock started only after the bounded wait');
  const done = events.find((row) => row.what === 'coach-done');
  assert.ok(!done || clock.at < done.at, 'the bounded wait did not wait for the slow generation');
  assert.equal(clock.terminations, 0, 'the wait itself cancelled nothing');
  assert.equal(upper.starts.length, 1, 'one generation for the last hand');
  assert.equal(coachInvocations(calls, 'reserve').length, 1);
});
