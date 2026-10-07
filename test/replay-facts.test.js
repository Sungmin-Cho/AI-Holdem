import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startHand, applyAction, legalFor } from '../engine/hand.js';
import { replayRecord } from '../shared/hand-replay.js';
import { buildReplaySteps } from '../server/public/replay-model.js';
import { replayDecisionSnapshot, replayFactsLine } from '../server/public/replay-facts.js';
import { chipFacts, equityFacts, handFacts } from '../shared/decision-facts.js';

function play(game, pick) {
  let state = startHand(game).state;
  let turn = 0;
  while (!legalFor(state).handOver) {
    const legal = legalFor(state);
    const [action, amount] = pick(legal, turn, state);
    turn += 1;
    state = applyAction(state, legal.toAct, action, amount).state;
  }
  return state.lastHand;
}

// The user raises; p1 sometimes bets into the user, so the user also faces
// prices (and, with the short stack, a partial all-in).
const pick = (legal, turn) => {
  if (legal.toAct === 'user' && legal.canRaise && turn % 2 === 0) return ['raise', Math.min(legal.maxRaiseTo, legal.minRaiseTo + 100)];
  if (legal.toAct === 'p1' && legal.canRaise && turn % 3 === 0) return ['raise', Math.min(legal.maxRaiseTo, legal.minRaiseTo + 200)];
  return legal.canCheck ? ['check'] : ['call'];
};

test('replay fact cards match the engine decision snapshots for every user decision', () => {
  let priced = 0;
  for (let seed = 0; seed < 6; seed += 1) {
    const game = createGame({ aiCount: 2, startStack: 3000, levelEvery: 50 });
    game.button = seed % 3;
    if (seed % 2) game.seats[1].stack = 700;
    const record = play(game, pick);
    const replay = replayRecord(record, { reveal: 'all' });
    const model = buildReplaySteps(replay);
    assert.equal(model.ok, true);
    const engine = record.decisions.filter((decision) => decision.actorId === 'user');
    const rebuilt = model.steps
      .filter((step) => step.kind === 'action' && step.actor === 'user')
      .map((step) => replayDecisionSnapshot(model, replay, 'user', step.index));
    assert.equal(rebuilt.length, engine.length);
    priced += engine.filter((decision) => decision.toCall > 0 && decision.street !== 'preflop').length;
    rebuilt.forEach((snapshot, at) => {
      assert.deepEqual(chipFacts(snapshot), chipFacts(engine[at]), `seed ${seed} decision ${at}`);
      assert.deepEqual(handFacts(snapshot), handFacts(engine[at]));
      assert.equal(snapshot.decisionId, engine[at].decisionId);
      if (seed < 2) assert.equal(equityFacts(snapshot), equityFacts(engine[at]), 'the same simulation as the coach');
    });
  }
  assert.ok(priced > 0, 'some postflop decisions faced a bet');
});

test('only the viewer\'s own action steps with known cards get a fact line', () => {
  const game = createGame({ aiCount: 2, startStack: 3000, levelEvery: 50 });
  const record = play(game, pick);
  const replay = replayRecord(record, { reveal: 'all' });
  const model = buildReplaySteps(replay);
  const userStep = model.steps.find((step) => step.kind === 'action' && step.actor === 'user');
  const otherStep = model.steps.find((step) => step.kind === 'action' && step.actor !== 'user');
  assert.match(replayFactsLine(model, replay, 'user', userStep.index), /^팟 [\d.]+BB, .*유효 스택 [\d.]+BB/);
  assert.match(replayFactsLine(model, replay, 'user', userStep.index), /무작위 \d명 대비 에퀴티 [\d.]+%/);
  assert.equal(replayFactsLine(model, replay, 'user', otherStep.index), null);
  assert.equal(replayFactsLine(model, replay, 'user', 0), null);
  const hidden = { ...replay, holes: { ...replay.holes, user: null } };
  assert.equal(replayFactsLine(model, hidden, 'user', userStep.index), null);
});

test('a short big blind (rules v2) keeps the engine\'s price in the replay fact card', () => {
  // Four seats; the big blind holds 30 of a 50 blind and is all-in from the post.
  const game = createGame({ aiCount: 3, levelEvery: 50 });
  game.button = 0; // p1 button, p2 small blind, p3 big blind, the user first to act
  game.seats[3].stack = 30;
  const record = play(game, (legal) => (legal.canCheck ? ['check'] : ['call']));
  const replay = replayRecord(record, { reveal: 'all' });
  const model = buildReplaySteps(replay);
  assert.equal(model.ok, true);
  const engine = record.decisions.filter((decision) => decision.actorId === 'user');
  const rebuilt = model.steps.filter((step) => step.kind === 'action' && step.actor === 'user')
    .map((step) => replayDecisionSnapshot(model, replay, 'user', step.index));
  assert.ok(engine.length >= 1);
  rebuilt.forEach((snapshot, at) => assert.deepEqual(chipFacts(snapshot), chipFacts(engine[at]), `decision ${at}`));
});
