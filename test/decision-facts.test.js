import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { chipFacts, equityFacts, factsLineKo, handFacts } from '../shared/decision-facts.js';
import { estimateOpponentRanges } from '../training/ranges/estimate-v3.js';
import { fixedDeck } from './helpers/fixtures.js';
import { positionsOf } from '../engine/positions.js';

function snapshot(over = {}) {
  return {
    decisionId: 'd-1-flop-5', actorId: 'user', handNo: 1, street: 'flop', position: 'BB',
    holeCards: ['Ah', 'Kd'], board: ['Kc', '7s', '2d'], blinds: [50, 100],
    potBefore: 1000, currentBet: 500, actorBet: 0, toCall: 500, minRaiseTo: 1000, maxRaiseTo: 9000,
    publicSeats: [
      { playerId: 'user', position: 'BB', stack: 9000, bet: 0, contribution: 250, folded: false, allIn: false, out: false },
      { playerId: 'p1', position: 'BTN', stack: 8500, bet: 500, contribution: 750, folded: false, allIn: false, out: false },
    ],
    priorActions: [], ...over,
  };
}

test('price facts: pot odds, required equity, SPR and chosen size', () => {
  const facts = chipFacts(snapshot({ chosenAction: { action: 'raise', amount: 1500 } }));
  assert.equal(facts.potBb, 10);
  assert.equal(facts.toCallBb, 5);
  assert.equal(facts.requiredEquity, 33.3);            // 500 / (1000 + 500)
  assert.equal(facts.potOdds, '2:1');
  assert.equal(facts.effectiveBb, 85);                  // min(9000, 8500)
  assert.equal(facts.spr, 8.5);
  assert.equal(facts.chosenPutBb, 15);
  assert.equal(facts.chosenPctOfPot, 150);
});

test('a partial all-in call prices only the pot hero can win', () => {
  // Pot 10bb, villain bets 100bb, hero has 10bb behind.
  const facts = chipFacts(snapshot({
    potBefore: 11000, currentBet: 10000, toCall: 1000, maxRaiseTo: 1000,
    publicSeats: [
      { playerId: 'user', position: 'BB', stack: 1000, bet: 0, contribution: 500, folded: false, allIn: false, out: false },
      { playerId: 'p1', position: 'BTN', stack: 0, bet: 10000, contribution: 10500, folded: false, allIn: true, out: false },
    ],
  }));
  assert.equal(facts.partialCall, true);
  assert.equal(facts.requiredEquity, 33.3);             // 1000 / (1500 + 1500), not 1000 / 12000
});

test('hand facts name the made hand and the draws', () => {
  assert.equal(handFacts(snapshot()).made, '원페어 · 탑페어');
  const draw = handFacts(snapshot({ holeCards: ['Ah', '5h'], board: ['Kh', '9h', '2c'] }));
  assert.equal(draw.flushDraw, true);
  assert.equal(draw.outs, 9);
});

test('equity facts are reproducible and the Korean line carries the numbers', () => {
  const a = equityFacts(snapshot());
  assert.equal(a, equityFacts(snapshot()));
  assert.ok(a > 80 && a < 95, String(a));
  const line = factsLineKo(snapshot(), { equityRandom: a });
  assert.match(line, /필요 승률 33.3%/);
  assert.match(line, /SPR 8.5/);
  assert.match(line, /메이드 원페어 · 탑페어/);
});

test('estimated ranges follow the opener and caller charts', () => {
  const g = createGame({ aiCount: 5 });
  // The button is random; fix it so the user is the big blind and acts last.
  g.button = 3;
  let st = startHand(g, { deck: fixedDeck() }).state;
  // Play until the user acts, letting the first AI open and the others fold.
  let opened = false;
  while (legalFor(st).toAct !== 'user') {
    const legal = legalFor(st);
    if (!opened) { st = applyAction(st, legal.toAct, 'raise', 250).state; opened = true; }
    else st = applyAction(st, legal.toAct, 'fold').state;
  }
  const snap = {
    actorId: 'user', blinds: [25, 50],
    publicSeats: st.seats.map((seat) => ({ playerId: seat.playerId, position: null, stack: seat.stack, folded: st.hand.folded.includes(seat.playerId), out: false })),
    priorActions: st.hand.actions,
  };
  // Positions from the engine labels of the live table.
  const labels = positionsOf(st);
  snap.publicSeats.forEach((seat) => { seat.position = labels[seat.playerId]; });
  const ranges = estimateOpponentRanges(snap);
  const opener = st.hand.actions.find((a) => a.action === 'raise').playerId;
  assert.ok(ranges[opener] && ranges[opener].AA === 1 && !ranges[opener]['72o']);
});

test('several pots: no single required equity, and an unmatched excess is not a side pot', () => {
  // Short all-in KK for 100, deep QQ for 300, hero (AA) to call 300 into it.
  const multi = chipFacts(snapshot({
    potBefore: 400, currentBet: 300, actorBet: 0, toCall: 300, maxRaiseTo: 2000,
    publicSeats: [
      { playerId: 'user', position: 'BB', stack: 2000, bet: 0, contribution: 0, folded: false, allIn: false, out: false },
      { playerId: 'p1', position: 'BTN', stack: 0, bet: 100, contribution: 100, folded: false, allIn: true, out: false },
      { playerId: 'p2', position: 'SB', stack: 1700, bet: 300, contribution: 300, folded: false, allIn: false, out: false },
    ],
  }));
  assert.equal(multi.multiPot, true);
  assert.equal(multi.requiredEquity, null);
  assert.match(factsLineKo(snapshot({
    potBefore: 400, currentBet: 300, actorBet: 0, toCall: 300, maxRaiseTo: 2000,
    publicSeats: [
      { playerId: 'user', position: 'BB', stack: 2000, bet: 0, contribution: 0, folded: false, allIn: false, out: false },
      { playerId: 'p1', position: 'BTN', stack: 0, bet: 100, contribution: 100, folded: false, allIn: true, out: false },
      { playerId: 'p2', position: 'SB', stack: 1700, bet: 300, contribution: 300, folded: false, allIn: false, out: false },
    ],
  })), /단일 필요 승률 없음/);
  // One opponent bets 800 against hero's 200: the 600 excess is returned, no side pot.
  const excess = chipFacts(snapshot({
    potBefore: 1000, currentBet: 800, actorBet: 0, toCall: 200, maxRaiseTo: 200,
    publicSeats: [
      { playerId: 'user', position: 'BB', stack: 200, bet: 0, contribution: 0, folded: false, allIn: false, out: false },
      { playerId: 'p1', position: 'BTN', stack: 5000, bet: 800, contribution: 800, folded: false, allIn: false, out: false },
      { playerId: 'p2', position: 'SB', stack: 0, bet: 0, contribution: 200, folded: true, allIn: false, out: false },
    ],
  }));
  assert.equal(excess.otherSidePots, 0);
  assert.equal(excess.requiredEquity, 33.3);            // 200 / (200 + 200 + 200)
});

test('a raise over a limper is not given an opening range', () => {
  const g = createGame({ aiCount: 5 });
  g.button = 3; // the user is the big blind
  let st = startHand(g, { deck: fixedDeck() }).state;
  let step = 0;
  while (legalFor(st).toAct !== 'user') {
    const legal = legalFor(st);
    // UTG limps, the next player raises over it, the rest fold.
    const action = step === 0 ? ['call'] : step === 1 ? ['raise', 300] : ['fold'];
    st = applyAction(st, legal.toAct, ...action).state;
    step += 1;
  }
  const labels = positionsOf(st);
  const snap = {
    actorId: 'user', blinds: [25, 50],
    publicSeats: st.seats.map((seat) => ({ playerId: seat.playerId, position: labels[seat.playerId], stack: seat.stack, folded: st.hand.folded.includes(seat.playerId), out: false })),
    priorActions: st.hand.actions,
  };
  const ranges = estimateOpponentRanges(snap);
  const raiser = st.hand.actions.find((a) => a.action === 'raise').playerId;
  assert.equal(ranges[raiser], null);
});
