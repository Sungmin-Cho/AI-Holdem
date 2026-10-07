import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDeck } from '../engine/cards.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { statsReport, turnSummary } from '../engine/views.js';
import { replayRecord } from '../shared/hand-replay.js';
import { fixedDeck } from './helpers/fixtures.js';

// Four seats [user, p1, p2, p3]; button index 0 moves to p1 at startHand, so
// p2 posts SB, p3 posts BB and the user is first to act preflop.
function start4(stacks, deck = fixedDeck()) {
  const g = createGame({ aiCount: 3 });
  g.button = 0;
  g.seats.forEach((seat, i) => { seat.stack = stacks[i]; });
  return startHand(g, { deck }).state;
}

test('TDA: two short all-ins that add up to a full raise reopen the betting', () => {
  let st = start4([5000, 130, 160, 5000]);
  assert.equal(legalFor(st).toAct, 'user');
  st = applyAction(st, 'user', 'raise', 100).state;          // full raise, next minimum 150
  st = applyAction(st, 'p1', 'raise', 130).state;            // short all-in (+30)
  st = applyAction(st, 'p2', 'raise', 160).state;            // short all-in (+30)
  st = applyAction(st, 'p3', 'call').state;                  // someone is left to answer a raise
  const legal = legalFor(st);
  assert.equal(legal.toAct, 'user');
  assert.equal(legal.callAmount, 60);
  assert.equal(legal.canRaise, true);                       // 60 since the user acted >= 50
  assert.equal(legal.minRaiseTo, 210);
});

test('TDA: a single short all-in still does not reopen the betting', () => {
  let st = start4([5000, 130, 5000, 5000]);
  st = applyAction(st, 'user', 'raise', 100).state;
  st = applyAction(st, 'p1', 'raise', 130).state;
  st = applyAction(st, 'p2', 'fold').state;
  st = applyAction(st, 'p3', 'call').state;
  const legal = legalFor(st);
  assert.equal(legal.toAct, 'user');
  assert.equal(legal.canRaise, false);
});

test('a short big blind still has to be called in full by the other players', () => {
  const st = start4([5000, 5000, 5000, 30]);
  const legal = legalFor(st);
  assert.equal(legal.toAct, 'user');
  assert.equal(legal.callAmount, 50);
});

function deckWith(ordered) {
  const used = new Set(ordered);
  return [...ordered, ...newDeck().filter((card) => !used.has(card))];
}

test('an all-in showdown tables every hand, but a losing human hand stays out of opponent prompts', () => {
  // Deal order from the small blind: p2, p3, user, p1 (two rounds), then the board.
  const holes = { p2: ['Ac', 'Ad'], p3: ['2c', '7d'], user: ['Kh', 'Qh'], p1: ['3s', '8d'] };
  const deck = deckWith([holes.p2[0], holes.p3[0], holes.user[0], holes.p1[0],
    holes.p2[1], holes.p3[1], holes.user[1], holes.p1[1], '9s', '4c', '2h', 'Jd', '5s']);
  let st = start4([5000, 5000, 1000, 5000], deck);
  st = applyAction(st, 'user', 'call').state;
  st = applyAction(st, 'p1', 'fold').state;
  st = applyAction(st, 'p2', 'raise', 1000).state;           // small blind shoves
  st = applyAction(st, 'p3', 'fold').state;
  st = applyAction(st, 'user', 'call').state;                // the user calls and loses
  const record = st.lastHand;
  assert.equal(record.rulesVersion, 2);
  assert.deepEqual(record.showdown.reveals.map(row => row.playerId).sort(), ['p2', 'user']);
  assert.deepEqual(record.allInRevealed, ['user']);           // a standard showdown would muck it
  const nextDeck = deckWith(newDeck().filter((card) => !holes.user.includes(card)));
  let next = startHand(st, { deck: nextDeck }).state;
  while (legalFor(next).toAct === 'user') next = applyAction(next, 'user', legalFor(next).canCheck ? 'check' : 'call').state;
  const summary = turnSummary(next, legalFor(next).toAct);
  assert.match(summary, /최근 완료 핸드 공개 관측/);
  assert.ok(!summary.includes('Kh Qh'), 'the losing human hand must not reach an opponent prompt');
  assert.ok(summary.includes('Ac Ad'));
  assert.equal(replayRecord(record, { reveal: 'showdown' }).rulesVersion, 2);
});

test('VPIP excludes a big-blind walk and AF counts postflop actions only', () => {
  let st = start4([5000, 5000, 5000, 5000]);
  st = applyAction(st, 'user', 'fold').state;
  st = applyAction(st, 'p1', 'fold').state;
  st = applyAction(st, 'p2', 'fold').state;                  // p3 wins a walk without acting
  const raw = st.stats.p3;
  assert.equal(raw.hands, 1);
  assert.equal(raw.vpipHands, 0);
  const report = statsReport(st).perPlayer;
  assert.equal(report.p3.sample, 1);                           // review gate keeps `hands`
  assert.equal(report.p3.decisionSample, 0);
  assert.equal(report.user.decisionSample, 1);
  assert.equal(report.user.af, 0);
});
