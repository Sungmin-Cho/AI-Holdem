import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_MARGIN, chipFacts, closureOf, drawOdds, equityFacts, factsLineKo, handFacts, priceVerdict,
} from '../shared/decision-facts.js';
import { coachingClaimAllowed, referenceClaimAllowed } from '../shared/reference.js';
import { decisionFacts } from '../tools/review-facts.js';

const seat = (playerId, over = {}) => ({ playerId, position: 'BTN', stack: 8000, bet: 0, contribution: 500,
  folded: false, allIn: false, out: false, ...over });

// River, heads-up: the opponent bet 500 into 1000 and hero is last to act.
function river(over = {}) {
  return {
    decisionId: 'd-1-river-7', actorId: 'user', handNo: 1, street: 'river', position: 'BB',
    holeCards: ['Ah', 'Kd'], board: ['Kc', '7s', '2d', '9h', '3c'], blinds: [50, 100],
    potBefore: 1500, currentBet: 500, actorBet: 0, toCall: 500, minRaiseTo: 1000, maxRaiseTo: 8000,
    publicSeats: [seat('user', { position: 'BB' }), seat('p1', { bet: 500, contribution: 1000, stack: 7500 })],
    priorActions: [], chosenAction: { action: 'call', amount: 500 }, ...over,
  };
}

test('a river call that ends the betting is a closed decision', () => {
  assert.deepEqual(closureOf(river()), { kind: 'river' });
});

test('no closure without a price, with a player still to act, or in a limped pot', () => {
  assert.equal(closureOf(river({ toCall: 0, currentBet: 0 })), null);
  // A third player with chips has not matched the bet: the call can be raised behind.
  const multiway = river({ publicSeats: [seat('user'), seat('p1', { bet: 500, contribution: 1000 }), seat('p2', { bet: 0 })] });
  assert.equal(closureOf(multiway), null);
  // ... but a folded or busted seat does not keep the action open.
  const folded = river({ publicSeats: [seat('user'), seat('p1', { bet: 500, contribution: 1000 }), seat('p2', { folded: true })] });
  assert.deepEqual(closureOf(folded), { kind: 'river' });
  // Preflop, a call of the big blind leaves the blind's option open.
  const limp = river({ street: 'preflop', board: [], currentBet: 100, toCall: 100,
    publicSeats: [seat('user', { position: 'BTN' }), seat('p1', { position: 'BB', bet: 100, contribution: 100 })] });
  assert.equal(closureOf(limp), null);
});

test('before the river a call is closed only when at most one player keeps chips', () => {
  const flop = { street: 'flop', board: ['Kc', '7s', '2d'], decisionId: 'd-1-flop-4' };
  assert.equal(closureOf(river(flop)), null);
  // Heads-up, the call is all-in: the opponent has nobody left to bet against.
  const heroAllIn = river({ ...flop, toCall: 500, maxRaiseTo: 500,
    publicSeats: [seat('user', { stack: 500 }), seat('p1', { bet: 500, contribution: 1000 })] });
  assert.deepEqual(closureOf(heroAllIn), { kind: 'hero-all-in' });
  // Two opponents with chips can still bet each other out of hero's pot.
  const twoDeep = river({ ...flop, toCall: 500, maxRaiseTo: 500, potBefore: 2500,
    publicSeats: [seat('user', { stack: 500 }), seat('p1', { bet: 500, contribution: 1000 }), seat('p2', { bet: 500, contribution: 1000 })] });
  assert.equal(closureOf(twoDeep), null);
  // ... on the river the same call goes straight to showdown.
  assert.deepEqual(closureOf({ ...twoDeep, street: 'river', board: ['Kc', '7s', '2d', '9h', '3c'] }), { kind: 'river' });
  const villainAllIn = river({ ...flop,
    publicSeats: [seat('user'), seat('p1', { bet: 500, contribution: 1000, stack: 0, allIn: true })] });
  assert.deepEqual(closureOf(villainAllIn), { kind: 'opponents-all-in' });
  // One opponent all-in and another with chips who has matched: hero keeps chips too.
  const mixed = river({ ...flop, potBefore: 2500,
    publicSeats: [seat('user'), seat('p1', { bet: 500, contribution: 1000, stack: 0, allIn: true }), seat('p2', { bet: 500, contribution: 1000 })] });
  assert.equal(closureOf(mixed), null);
  // Preflop: calling a shove with nobody left to act.
  const shove = river({ street: 'preflop', board: [], decisionId: 'd-1-preflop-2', currentBet: 1200, toCall: 1100, potBefore: 1350,
    publicSeats: [seat('user', { position: 'BB', bet: 100, contribution: 100 }),
      seat('p1', { position: 'SB', bet: 1200, contribution: 1200, stack: 0, allIn: true })] });
  assert.deepEqual(closureOf(shove), { kind: 'opponents-all-in' });
  // A big blind that is all-in for the blind has no option left to raise.
  const shortBlind = river({ street: 'preflop', board: [], decisionId: 'd-1-preflop-1', currentBet: 100, toCall: 50, potBefore: 150,
    publicSeats: [seat('user', { position: 'SB', bet: 50, contribution: 50 }),
      seat('p1', { position: 'BB', bet: 100, contribution: 100, stack: 0, allIn: true })] });
  assert.deepEqual(closureOf(shortBlind), { kind: 'opponents-all-in' });
});

test('side pots have no single price, so no closure', () => {
  // p2 is all-in for less than hero would have in after the call.
  const snap = river({ publicSeats: [seat('user'), seat('p1', { bet: 500, contribution: 1000 }),
    seat('p2', { bet: 200, contribution: 700, stack: 0, allIn: true })] });
  assert.equal(chipFacts(snap).multiPot, true);
  assert.equal(closureOf(snap), null);
});

test('the comparison reports a gap of the margin or more, and nothing without a range', () => {
  const chips = chipFacts(river());
  const closure = closureOf(river());
  assert.equal(chips.requiredEquity, 25);
  const verdict = (action, equityRange) => priceVerdict({ chips, closure, action, equityRange })?.verdict ?? null;
  assert.equal(verdict('call', 25 - PRICE_MARGIN), 'call-below-price');
  assert.equal(verdict('call', 25 - PRICE_MARGIN + 0.1), 'near-price');
  assert.equal(verdict('call', 25 + PRICE_MARGIN), 'call-above-price');
  assert.equal(verdict('fold', 25 + PRICE_MARGIN), 'fold-above-price');
  assert.equal(verdict('fold', 25 + PRICE_MARGIN - 0.1), 'near-price');
  assert.equal(verdict('fold', 25 - PRICE_MARGIN), 'fold-below-price');
  assert.equal(verdict('raise', 5), null);
  assert.equal(verdict('call', null), null);
  assert.deepEqual(priceVerdict({ chips, closure, action: 'call', equityRange: 12.5 }),
    { closure: 'river', basis: 'range', required: 25, equity: 12.5, verdict: 'call-below-price' });
  // Equity against random hands is never a basis: a betting range can be weaker than random.
  assert.equal(priceVerdict({ chips, closure, action: 'call', equityRange: null, equityRandom: 1 }), null);
});

test('no comparison for an open decision or a missing price', () => {
  const chips = chipFacts(river());
  assert.equal(priceVerdict({ chips, closure: null, action: 'call', equityRange: 1 }), null);
  assert.equal(priceVerdict({ chips: { ...chips, requiredEquity: null }, closure: { kind: 'river' }, action: 'call', equityRange: 1 }), null);
});

test('draw odds: the chance that the draw completes, beside the price', () => {
  const flop = river({ street: 'flop', decisionId: 'd-1-flop-4', holeCards: ['Ah', '5h'], board: ['Kh', '9h', '2c'] });
  assert.deepEqual(drawOdds(flop), { outs: 9, cards: 1, hit: 19.1, required: 25 });   // 9 / 47
  const turn = drawOdds(river({ street: 'turn', decisionId: 'd-1-turn-6', holeCards: ['Ah', '5h'], board: ['Kh', '9h', '2c', 'Jd'] }));
  assert.equal(turn.hit, 19.6);                         // 9 / 46
  // The opponent is all-in on the flop: hero keeps chips but sees both cards without betting.
  const allIn = drawOdds(river({ street: 'flop', decisionId: 'd-1-flop-4', holeCards: ['Ah', '5h'], board: ['Kh', '9h', '2c'],
    publicSeats: [seat('user'), seat('p1', { bet: 500, contribution: 1000, stack: 0, allIn: true })] }));
  assert.deepEqual(allIn, { outs: 9, cards: 2, hit: 35, required: 25 });   // 1 - C(38,2)/C(47,2)
});

test('draw odds are not stated for a made hand, on the river, or without a single price', () => {
  assert.equal(drawOdds(river()), null);
  assert.equal(drawOdds(river({ street: 'flop', decisionId: 'd-1-flop-4', board: ['Kc', '7s', '2d'] })), null); // top pair
  const draw = { street: 'flop', decisionId: 'd-1-flop-4', holeCards: ['Ah', '5h'], board: ['Kh', '9h', '2c'] };
  assert.equal(drawOdds(river({ ...draw, toCall: 0, currentBet: 0 })), null);
  assert.equal(handFacts(river(draw)).outs, 9);
  const sidePots = river({ ...draw, publicSeats: [seat('user'), seat('p1', { bet: 500, contribution: 1000 }),
    seat('p2', { bet: 200, contribution: 700, stack: 0, allIn: true })] });
  assert.equal(drawOdds(sidePots), null);
});

test('the fact line states the closure, the comparison and the draw chance in allowed wording', () => {
  const closed = factsLineKo(river(), { equityRandom: 60, equityRange: 12.5, rangeMeta: { acted: 1, excluded: 0, reason: null } });
  assert.match(closed, /닫힌 결정\(콜하면 이후 베팅 없음\)/);
  assert.match(closed, /가격 비교\(칩 기준 · 추정 레인지는 보정되지 않은 참고값\): 필요 승률 25% · 추정 승률 12\.5% — 필요 승률에 못 미친 콜/);
  // Without a range the decision is marked closed but nothing is compared.
  const random = factsLineKo(river(), { equityRandom: 5 });
  assert.match(random, /닫힌 결정/);
  assert.doesNotMatch(random, /가격 비교\(칩 기준/);
  const open = factsLineKo(river({ street: 'flop', decisionId: 'd-1-flop-4', holeCards: ['Ah', '5h'], board: ['Kh', '9h', '2c'] }),
    { equityRandom: 50, equityRange: 10 });
  assert.doesNotMatch(open, /닫힌 결정|가격 비교\(칩 기준/);
  assert.match(open, /드로 완성 확률\(승률과 다름\): 다음 카드 19\.1% · 필요 승률 25%/);
  // The added phrases are what a coach may repeat: they must pass the coaching filter.
  for (const line of [closed, open]) {
    for (const part of line.split(', ').filter((text) => /닫힌 결정|가격 비교\(칩 기준|드로 완성 확률/.test(text))) {
      assert.equal(referenceClaimAllowed(part), true, part);
      assert.equal(coachingClaimAllowed(part), true, part);
    }
  }
  // No chosen action (a pending decision): the closure is a fact, the comparison needs a choice.
  const pending = factsLineKo(river({ chosenAction: undefined }), { equityRange: 12.5 });
  assert.match(pending, /닫힌 결정/);
  assert.doesNotMatch(pending, /가격 비교\(칩 기준/);
});

test('review facts carry the closure, the comparison and the draw chance', () => {
  const facts = decisionFacts({ ...river(), schemaVersion: 2 });
  assert.deepEqual(facts.closure, { kind: 'river' });
  assert.ok('priceVerdict' in facts && 'drawOdds' in facts);
  assert.equal(facts.drawOdds, null);
});

test('a range equity built on too few compatible deals is not reported', () => {
  const snapshot = river();
  // Aces only, against a hero holding two of them and a third on the board: one combo left.
  const narrow = { AA: 1 };
  const board = { holeCards: ['Ah', 'Kd'], board: ['Ac', '7s', '2d', '9h', '3c'] };
  assert.ok(Number.isFinite(equityFacts({ ...snapshot, ...board }, { ranges: [narrow] })));
  assert.throws(() => equityFacts({ ...snapshot, ...board }, { ranges: [narrow, narrow], minDealt: 500 }), RangeError);
});
