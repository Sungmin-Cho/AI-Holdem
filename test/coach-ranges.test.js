// The coaching-only range estimate (training/ranges/coach-estimate.js): it must react
// to visible pressure and checks on the board each action was made on, keep weak
// support, and fall back to "no conditioned range" on missing, malformed or future
// evidence. All fixtures are in-memory snapshots; nothing touches a store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { COACH_RANGE_CONSTANTS, coachEquityRanges, estimateCoachRanges } from '../training/ranges/coach-estimate.js';
import { estimateOpponentRanges } from '../training/ranges/estimate-v3.js';
import { chipFacts, equityFacts, factsLineKo } from '../shared/decision-facts.js';
import { HAND_CLASSES, categoryOfScore, combosOfClass, scoreCards } from '../shared/poker-eval.js';
import { decisionFacts, decisionFactsLines } from '../tools/review-facts.js';
import { fixedDeck } from './helpers/fixtures.js';

const FLOP = ['Kc', '7s', '2d'];
const TURN = [...FLOP, '9h'];
const RIVER = [...TURN, '3c'];
const ALL = { flop: FLOP, turn: TURN, river: RIVER };

// Heads-up, 100bb deep, blinds 50/100. 'user' opened from the button/small blind and
// 'p1' (big blind) called, so p1's preflop range is the recorded v3 call chart.
function seat(playerId, position, over = {}) {
  return { playerId, position, stack: 9000, bet: 0, contribution: 500, folded: false, allIn: false, out: false, ...over };
}
const PREFLOP = [
  { playerId: 'user', action: 'raise', street: 'preflop', amount: 250, potTotal: 150, callAmount: 50, minRaiseTo: 200, maxRaiseTo: 10000, board: [], currentBet: 100 },
  { playerId: 'p1', action: 'call', street: 'preflop', amount: 150, potTotal: 400, callAmount: 150, minRaiseTo: 400, maxRaiseTo: 10000, board: [], currentBet: 250 },
];
const act = (playerId, street, action, extra = {}) => ({
  playerId, street, action, amount: 0, potTotal: 500, callAmount: 0, minRaiseTo: 100, maxRaiseTo: 9000, board: ALL[street], currentBet: 0, ...extra,
});
const bet = (street, amount = 400, pot = 500) => act('p1', street, 'raise', { amount, potTotal: pot });
const check = (street) => act('p1', street, 'check');

function spot({ street = 'river', actions = [], hole = ['Qh', 'Jd'], toCall = 0, seats = null, over = {} } = {}) {
  return {
    decisionId: `d-1-${street}-9`, actorId: 'user', handNo: 1, street, position: 'BTN/SB',
    holeCards: hole, board: ALL[street], blinds: [50, 100],
    potBefore: 500, currentBet: toCall, actorBet: 0, toCall, minRaiseTo: 100, maxRaiseTo: 9000,
    publicSeats: seats ?? [seat('user', 'BTN/SB'), seat('p1', 'BB')],
    priorActions: [...PREFLOP, ...actions], ...over,
  };
}

// Independent oracle: share of the range's weight on made pair-or-better holdings on
// `board`, counted combo by combo with the shared evaluator.
function pairOrBetterShare(range, board, blocked = []) {
  const bad = new Set([...board, ...blocked].map(cardIndex));
  let hit = 0;
  let total = 0;
  for (const [cls, weight] of Object.entries(range)) {
    for (const [a, b] of combosOfClass(cls)) {
      if (bad.has(a) || bad.has(b)) continue;
      total += weight;
      if (categoryOfScore(scoreCards([a, b, ...board.map(cardIndex)])) >= 1) hit += weight;
    }
  }
  return hit / total;
}
const cardIndex = (card) => (typeof card === 'number' ? card : 'shdc'.indexOf(card[1]) + 4 * '23456789TJQKA'.indexOf(card[0]));

const rangeOf = (snapshot, pid = 'p1') => estimateCoachRanges(snapshot).players[pid].range;

test('an unreadable decision omits only its own facts in a mixed evaluator hand', () => {
  const good = spot({ street: 'flop', actions: [check('flop')] });
  const broken = { ...good, decisionId: 'd-1-flop-8', holeCards: undefined };
  const expected = decisionFactsLines({ decisions: [good] });
  assert.equal(expected.length, 1, 'the valid decision has real facts');
  assert.equal(decisionFacts(broken), null);
  assert.equal(decisionFacts(null), null);
  assert.deepEqual(decisionFactsLines({ decisions: [broken, good] }), expected);
});

test('pressure on every street and a check-through give different ranges on the identical river board', () => {
  const pressure = spot({ toCall: 400, actions: [bet('flop'), bet('turn', 600, 1300), bet('river', 1500, 2500)] });
  const passive = spot({ actions: [check('flop'), check('turn'), check('river')] });
  const pressureEstimate = estimateCoachRanges(pressure);
  const passiveEstimate = estimateCoachRanges(passive);
  assert.equal(pressureEstimate.status, 'full');
  assert.equal(passiveEstimate.status, 'full');
  assert.deepEqual(pressure.board, passive.board);
  const hot = pairOrBetterShare(pressureEstimate.players.p1.range, RIVER, pressure.holeCards);
  const cold = pairOrBetterShare(passiveEstimate.players.p1.range, RIVER, passive.holeCards);
  const preflopOnly = pairOrBetterShare(rangeOf(spot({ street: 'flop' })), FLOP, pressure.holeCards);
  assert.ok(hot > cold + 0.2, `pressure ${hot} vs check-through ${cold}`);
  assert.ok(hot > preflopOnly, 'a triple-barrel is stronger than the unconditioned call range');
  assert.ok(cold < preflopOnly + 0.05, 'checks do not make the range stronger');
});

test('a check changes the weights, but strong hands and weak hands both keep support', () => {
  const base = rangeOf(spot({ street: 'flop' }));
  const checked = rangeOf(spot({ street: 'flop', actions: [check('flop')] }));
  assert.notDeepEqual(base, checked);
  assert.ok(pairOrBetterShare(checked, FLOP, ['Qh', 'Jd']) < pairOrBetterShare(base, FLOP, ['Qh', 'Jd']));
  // The best holding on this board keeps a meaningful share of its pre-check weight
  // relative to the rest of the range: a check is not proof of weakness.
  const dead = new Set([...FLOP, 'Qh', 'Jd'].map(cardIndex));
  const best = Object.keys(checked).map((cls) => [cls, Math.max(...combosOfClass(cls)
    .filter(([x, y]) => !dead.has(x) && !dead.has(y)).map(([x, y]) => scoreCards([x, y, ...FLOP.map(cardIndex)])), -1)])
    .sort((x, y) => y[1] - x[1])[0][0];
  assert.ok(checked[best] / base[best] >= 0.2, `${best} retains ${checked[best] / base[best]} of its relative weight`);
  assert.ok(checked[best] / base[best] < 0.9, 'but the check does move weight away from it');
  // Every class that existed still exists.
  for (const cls of Object.keys(base)) assert.ok(checked[cls] > 0, cls);
});

test('every class of the preflop range keeps positive support after heavy pressure', () => {
  const base = rangeOf(spot({ street: 'flop' }));
  const pressure = rangeOf(spot({ toCall: 400, actions: [bet('flop'), bet('turn', 600, 1300), bet('river', 1500, 2500)] }));
  const dead = new Set([...RIVER, 'Qh', 'Jd'].map(cardIndex));
  let compared = 0;
  for (const cls of Object.keys(base)) {
    if (combosOfClass(cls).every(([a, b]) => dead.has(a) || dead.has(b))) { assert.equal(pressure[cls], undefined); continue; }
    compared += 1;
    assert.ok(pressure[cls] > 0 && pressure[cls] <= 1 && Number.isFinite(pressure[cls]), `${cls} ${pressure[cls]}`);
    // Three actions can shrink a class by at most the per-action floor each time.
    assert.ok(pressure[cls] >= base[cls] * COACH_RANGE_CONSTANTS.floorShare ** 3 / 1);
  }
  assert.ok(compared > 10);
  assert.equal(Math.max(...Object.values(pressure)), 1);
});

test('one bet or raise never removes more than a bounded share: bluff and weak support persist', () => {
  const base = rangeOf(spot({ street: 'flop' }));
  for (const [label, action] of [['bet', bet('flop')], ['raise', act('p1', 'flop', 'raise', { amount: 1200, potTotal: 900, callAmount: 400 })]]) {
    const after = rangeOf(spot({ street: 'flop', toCall: 400, actions: [action] }));
    const ratios = Object.keys(after).map((cls) => after[cls] / base[cls]);
    const spread = Math.min(...ratios) / Math.max(...ratios);
    assert.ok(spread >= 0.04, `${label}: weakest/strongest likelihood ratio ${spread}`);
    assert.ok(spread < 0.9, `${label}: the action must still discriminate`);
  }
});

test('support is finite and reproducible', () => {
  const snapshot = spot({ toCall: 400, actions: [bet('flop'), check('turn'), bet('river', 1500, 2500)] });
  const first = estimateCoachRanges(snapshot);
  const second = estimateCoachRanges(structuredClone(snapshot));
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  for (const weight of Object.values(first.players.p1.range)) assert.ok(Number.isFinite(weight) && weight > 0 && weight <= 1);
  assert.equal(first.method.calibrated, false);
  assert.ok(first.limitations.some((line) => /보정/.test(line)));
});

test('an action is judged on the board it was made on, never on a later one', () => {
  // p1 bet the flop and has not acted on the turn yet: the turn card cannot matter.
  const a = spot({ street: 'turn', actions: [bet('flop')] });
  const b = structuredClone(a);
  b.board = [...FLOP, '2c'];
  assert.deepEqual(rangeOf(a), rangeOf(b));
  // But the same bet on a different flop is a different range.
  const wet = structuredClone(a);
  wet.board = ['Jh', 'Th', '9h', '4c'];
  wet.priorActions = [...PREFLOP, { ...bet('flop'), board: ['Jh', 'Th', '9h'] }];
  assert.notDeepEqual(rangeOf(a), rangeOf(wet));
});

test('hidden information and future material in the snapshot cannot change the estimate', () => {
  const clean = spot({ toCall: 400, actions: [bet('flop'), bet('turn', 600, 1300), bet('river', 1500, 2500)] });
  const noisy = structuredClone(clean);
  noisy.publicSeats[1].holeCards = ['Ac', 'Ad'];
  noisy.publicSeats[1].persona = 'maniac';
  noisy.opponentHoles = { p1: ['2c', '3d'] };
  noisy.futureBoard = ['As', 'Ah'];
  noisy.record = { showdown: { reveals: [{ playerId: 'p1', cards: ['Ac', 'Ad'] }] } };
  noisy.priorActions.forEach((action) => { action.note = 'private'; action.reason = 'trap'; action.holeCards = ['Ac', 'Ad']; });
  assert.deepEqual(estimateCoachRanges(noisy), estimateCoachRanges(clean));
  assert.doesNotMatch(JSON.stringify(estimateCoachRanges(noisy)), /"[2-9TJQKA][shdc]"/, 'no card strings in the estimate');
});

test('future streets and boards that are not the decision history are rejected', () => {
  const futureAction = spot({ street: 'flop', actions: [bet('flop'), bet('turn', 600, 1300)] });
  const future = estimateCoachRanges(futureAction);
  assert.equal(future.players.p1.status, 'unavailable');
  assert.equal(future.players.p1.range, null);
  assert.deepEqual(future.players.p1.reasons, ['future-street']);
  assert.equal(future.status, 'unavailable');

  const wrongBoard = spot({ street: 'turn', actions: [{ ...bet('flop'), board: ['Ah', 'Ad', '5c'] }] });
  assert.deepEqual(estimateCoachRanges(wrongBoard).players.p1.reasons, ['board-not-history']);
  const wrongSize = spot({ street: 'turn', actions: [{ ...bet('flop'), board: TURN }] });
  assert.deepEqual(estimateCoachRanges(wrongSize).players.p1.reasons, ['board-street-mismatch']);
  const bad = spot({ street: 'turn', actions: [{ ...bet('flop'), board: ['Kc', 'zz', '2d'] }] });
  assert.deepEqual(estimateCoachRanges(bad).players.p1.reasons, ['bad-board']);
  const noBoard = spot({ street: 'turn', actions: [{ ...bet('flop'), board: undefined }] });
  assert.deepEqual(estimateCoachRanges(noBoard).players.p1.reasons, ['bad-board']);
  const unknown = spot({ street: 'turn', actions: [{ ...bet('flop'), action: 'shrug' }] });
  assert.deepEqual(estimateCoachRanges(unknown).players.p1.reasons, ['unknown-action']);
  const sizing = spot({ street: 'turn', actions: [{ ...bet('flop'), amount: 'lots' }] });
  assert.deepEqual(estimateCoachRanges(sizing).players.p1.reasons, ['bad-sizing']);
});

test('an invalid decision board makes every opponent unavailable', () => {
  const duplicate = spot({ street: 'flop', over: { board: ['Kc', 'Kc', '2d'] } });
  const e = estimateCoachRanges(duplicate);
  assert.equal(e.status, 'unavailable');
  assert.deepEqual(e.players.p1.reasons, ['bad-board-evidence']);
  const short = spot({ street: 'turn', over: { board: FLOP } });
  assert.equal(estimateCoachRanges(short).players.p1.status, 'unavailable');
  const heroOnBoard = spot({ street: 'flop', hole: ['Kc', 'Jd'] });
  assert.equal(estimateCoachRanges(heroOnBoard).status, 'unavailable');
  assert.doesNotThrow(() => estimateCoachRanges({}));
  assert.doesNotThrow(() => estimateCoachRanges(null));
});

test('a line the v3 charts do not cover, or a missing street action, never yields a full estimate', () => {
  // A limp is outside the charts: no preflop range, so no conditioned range.
  const limp = spot({ street: 'flop', toCall: 400, actions: [bet('flop')] });
  limp.priorActions[0] = { ...limp.priorActions[0], action: 'call', amount: 50 };
  const limped = estimateCoachRanges(limp);
  assert.deepEqual(limped.players.p1.reasons, ['no-preflop-range']);
  assert.equal(limped.status, 'unavailable');
  assert.equal(coachEquityRanges(limped).ranges, null);
  assert.equal(coachEquityRanges(limped).reason, 'range-evidence-missing');

  // On the turn with no recorded flop action: evidence is missing, not zero.
  const gap = estimateCoachRanges(spot({ street: 'turn', actions: [bet('turn', 600, 1300)] }));
  assert.equal(gap.players.p1.status, 'partial');
  assert.deepEqual(gap.players.p1.reasons, ['missing-street-action']);
  assert.equal(gap.status, 'partial');
  assert.equal(coachEquityRanges(gap).ranges, null);
  // All-in earlier: no later action is expected.
  const shoved = spot({ street: 'turn', actions: [bet('flop', 8000, 500)], seats: [seat('user', 'BTN/SB'), seat('p1', 'BB', { allIn: true, stack: 0 })] });
  assert.equal(estimateCoachRanges(shoved).players.p1.status, 'conditioned');
});

test('a turn shove cannot excuse missing flop evidence; an earlier proven shove can excuse later streets', () => {
  const seats = [seat('user', 'BTN/SB'), seat('p1', 'BB', { allIn: true, stack: 0 })];
  const late = estimateCoachRanges(spot({ street: 'turn', seats,
    actions: [bet('turn', 9000, 1300)] }));
  assert.equal(late.players.p1.status, 'partial');
  assert.ok(late.players.p1.reasons.includes('missing-street-action'));
  assert.equal(coachEquityRanges(late).ranges, null);

  const early = spot({ street: 'river', seats, actions: [bet('flop', 9000)] });
  const proven = estimateCoachRanges(early);
  assert.equal(proven.players.p1.status, 'conditioned');
  assert.ok(coachEquityRanges(proven).ranges);
  delete early.priorActions.at(-1).maxRaiseTo;
  assert.equal(estimateCoachRanges(early).players.p1.status, 'partial', 'a current flag alone is not historical proof');
});

test('three-handed: any live opponent without range evidence omits range equity, whether or not it has acted', () => {
  // user = button opens, p1 = small blind calls (a charted line), p2 = big blind calls
  // after a caller (outside the charts, so no preflop range).
  const preflop = [
    { playerId: 'user', action: 'raise', street: 'preflop', amount: 250, potTotal: 150, callAmount: 50, minRaiseTo: 200, maxRaiseTo: 10000, board: [], currentBet: 100 },
    { playerId: 'p1', action: 'call', street: 'preflop', amount: 200, potTotal: 400, callAmount: 200, minRaiseTo: 400, maxRaiseTo: 10000, board: [], currentBet: 250 },
    { playerId: 'p2', action: 'call', street: 'preflop', amount: 150, potTotal: 600, callAmount: 150, minRaiseTo: 400, maxRaiseTo: 10000, board: [], currentBet: 250 },
  ];
  const seats = [seat('user', 'BTN'), seat('p1', 'SB', { bet: 400, contribution: 650 }), seat('p2', 'BB')];
  const open = spot({ street: 'flop', toCall: 400, actions: [], seats, over: { currentBet: 400 } });
  open.priorActions = [...preflop, act('p1', 'flop', 'raise', { amount: 400, potTotal: 750 })];
  const estimate = estimateCoachRanges(open);
  assert.equal(estimate.players.p1.status, 'conditioned');
  assert.deepEqual(estimate.players.p2.reasons, ['no-preflop-range']);
  assert.deepEqual(estimate.acted, ['p1']);
  assert.deepEqual(estimate.unacted, ['p2']);
  assert.equal(estimate.status, 'partial');

  // p2 has not acted yet but is still live, and nothing is known about its range: the
  // equity against the bettor alone would hide a player who may still call. No range
  // equity, even though the bettor itself is fully conditioned.
  assert.deepEqual(coachEquityRanges(estimate).ranges, null);
  assert.equal(coachEquityRanges(estimate).reason, 'range-evidence-missing');
  const facts = decisionFacts(open);
  assert.deepEqual(facts.rangeEstimate.unacted, ['p2']);
  assert.equal(facts.equityRange, null);
  assert.equal(facts.rangeEstimate.equityOmitted, 'range-evidence-missing');
  assert.match(facts.line, /레인지 에퀴티 생략/);
  assert.doesNotMatch(facts.line, /추정 레인지 대비 에퀴티/);
  assert.doesNotMatch(facts.line, /행동한 \d명 대상/, 'no subset claim when no equity was computed');
  assert.equal(typeof facts.equityRandom, 'number');

  // Once p2 acts without any range evidence, still no range equity.
  const called = structuredClone(open);
  called.priorActions.push(act('p2', 'flop', 'call', { callAmount: 400, potTotal: 1150 }));
  const omitted = decisionFacts(called);
  assert.equal(omitted.equityRange, null);
  assert.equal(omitted.rangeEstimate.equityOmitted, 'range-evidence-missing');
  assert.match(omitted.line, /레인지 에퀴티 생략/);
  assert.doesNotMatch(omitted.line, /추정 레인지 대비 에퀴티/);
  assert.equal(typeof omitted.equityRandom, 'number');

  // A folded opponent is simply not part of the estimate, so the remaining evidence is complete.
  const folded = structuredClone(open);
  folded.publicSeats[2].folded = true;
  assert.deepEqual(Object.keys(estimateCoachRanges(folded).players), ['p1']);
  assert.equal(typeof decisionFacts(folded).equityRange, 'number');
});

test('with nobody acted yet there is no range equity, only the random-hand number', () => {
  const first = decisionFacts(spot({ street: 'flop' }));
  assert.equal(first.equityRange, null);
  assert.equal(first.rangeEstimate.equityOmitted, 'no-acted-opponent');
  assert.equal(typeof first.equityRandom, 'number');
  assert.match(first.line, /무작위 1명 대비 에퀴티/);
});

test('decision facts carry method, limitations, Korean labels and the not-an-EV caveat', () => {
  const snapshot = spot({ toCall: 400, actions: [bet('flop'), bet('turn', 600, 1300), bet('river', 1500, 2500)] });
  const facts = decisionFacts(snapshot);
  assert.equal(facts.rangeEstimate.method.id, 'coach-public-action-heuristic');
  assert.equal(facts.rangeEstimate.method.calibrated, false);
  assert.equal(facts.rangeEstimate.status, 'full');
  assert.equal(facts.rangeEstimate.players.p1.status, 'conditioned');
  assert.equal(facts.rangeEstimate.players.p1.appliedActions, 3);
  assert.equal('range' in facts.rangeEstimate.players.p1, false, 'weights are not exposed in facts');
  assert.ok(facts.rangeEstimate.limitations.length >= 4);
  assert.equal(typeof facts.equityRange, 'number');
  assert.match(facts.line, /추정 레인지 대비 에퀴티 [\d.]+%/);
  assert.match(facts.line, /공개 행동 기반 휴리스틱·미보정/);
  assert.match(facts.line, /행동 EV가 아님/);
  assert.match(facts.line, /가격 비교만으로 판정 불가/);
  // Pressure makes the villain look stronger than the unconditioned call range.
  const preflopOnly = decisionFacts(spot({ street: 'river', actions: [] , toCall: 0 }));
  assert.equal(preflopOnly.equityRange, null);
});

test('range equity falls when a villain bets every street versus checks every street', () => {
  const pressure = decisionFacts(spot({ toCall: 400, actions: [bet('flop'), bet('turn', 600, 1300), bet('river', 1500, 2500)] }));
  const passive = decisionFacts(spot({ actions: [check('flop'), check('turn'), check('river')] }));
  assert.ok(pressure.equityRange < passive.equityRange, `${pressure.equityRange} vs ${passive.equityRange}`);
});

test('price arithmetic and side pots are unaffected by the range estimate', () => {
  const priced = spot({ street: 'flop', toCall: 500, actions: [bet('flop', 500)], over: { potBefore: 1000, currentBet: 500 } });
  priced.publicSeats = [seat('user', 'BTN/SB', { contribution: 250 }), seat('p1', 'BB', { bet: 500, contribution: 750, stack: 8500 })];
  const facts = decisionFacts(priced);
  assert.deepEqual(facts.chips, chipFacts(priced));
  assert.equal(facts.chips.requiredEquity, 33.3);
  assert.equal(facts.chips.potOdds, '2:1');
  assert.match(facts.line, /필요 승률 33\.3%/);
  assert.match(facts.line, /팟 오즈 2:1/);
  // The estimate-free line (replay cards) is the same price text without the label.
  assert.ok(facts.line.startsWith(factsLineKo(priced).replace(/, 에퀴티는 쇼다운.*/, '').split(', 무작위')[0]));

  const multi = spot({ street: 'flop', toCall: 300, over: { potBefore: 400, currentBet: 300, maxRaiseTo: 2000 },
    seats: [seat('user', 'BB', { stack: 2000, contribution: 0 }), seat('p1', 'BTN', { stack: 0, bet: 100, contribution: 100, allIn: true }), seat('p2', 'SB', { stack: 1700, bet: 300, contribution: 300 })] });
  const multiFacts = decisionFacts(multi);
  assert.equal(multiFacts.chips.multiPot, true);
  assert.equal(multiFacts.chips.requiredEquity, null);
  assert.match(multiFacts.line, /단일 필요 승률 없음/);
});

test('the recorded v3 estimator is untouched and shares no state with the coaching estimate', () => {
  const snapshot = spot({ street: 'flop', actions: [check('flop')] });
  const before = estimateOpponentRanges(snapshot);
  const coach = estimateCoachRanges(snapshot);
  for (const key of Object.keys(coach.players.p1.range)) coach.players.p1.range[key] = 0;
  assert.deepEqual(estimateOpponentRanges(snapshot), before);
  // v3 frequencies are the recorded chart values, not the reweighted ones.
  assert.ok(Object.values(before.p1).every((v) => v > 0 && v <= 1));
  assert.notDeepEqual(rangeOf(snapshot), before.p1);
});

test('real engine decisions produce usable evidence and lines, deterministically', () => {
  const game = createGame({ aiCount: 2, startStack: 3000, levelEvery: 50 });
  game.button = 1;
  let state = startHand(game, { deck: fixedDeck() }).state;
  let turn = 0;
  while (!legalFor(state).handOver) {
    const legal = legalFor(state);
    const aggressive = legal.toAct === 'p1' && legal.canRaise && turn % 4 === 1;
    const [action, amount] = aggressive ? ['raise', legal.minRaiseTo] : legal.canCheck ? ['check'] : ['call'];
    turn += 1;
    state = applyAction(state, legal.toAct, action, amount).state;
  }
  const record = state.lastHand;
  const decisions = record.decisions.filter((d) => d.actorId === 'user');
  assert.ok(decisions.length >= 2);
  for (const snap of decisions) {
    const estimate = estimateCoachRanges(snap);
    assert.deepEqual(estimate, estimateCoachRanges(structuredClone(snap)));
    assert.ok(!estimate.issues.includes('bad-board-evidence'), snap.decisionId);
    for (const row of Object.values(estimate.players)) {
      assert.ok(row.range === null || Object.values(row.range).every((w) => w > 0 && w <= 1));
      assert.ok(!['bad-board', 'board-not-history', 'board-street-mismatch', 'future-street'].some((r) => row.reasons.includes(r)), snap.decisionId);
    }
  }
  assert.deepEqual(decisionFactsLines(record), decisionFactsLines(structuredClone(record)));
});

// ---- evidence completeness: every live opponent (R1), every consumed field (R2) -----

const without = (object, key) => { const copy = { ...object }; delete copy[key]; return copy; };
// `undefined` stands for "field missing". None of these is a valid chip count, card, id or flag.
const JUNK = [undefined, null, NaN, Infinity, -1, 'x', {}, []];
const withField = (object, key, value) => (value === undefined ? without(object, key) : { ...object, [key]: value });
const label = (value) => (value === undefined ? 'missing' : JSON.stringify(value) ?? String(value));

// Three-handed, 100bb: p1 (BTN) opened, p2 (SB) called and the hero (BB) called, so both
// opponents sit on charted preflop lines. p2 acts first on every postflop street.
const TRIPLE_PREFLOP = [
  { playerId: 'p1', action: 'raise', street: 'preflop', amount: 250, potTotal: 150, callAmount: 100, minRaiseTo: 200, maxRaiseTo: 10000, board: [], currentBet: 100 },
  { playerId: 'p2', action: 'call', street: 'preflop', amount: 225, potTotal: 400, callAmount: 225, minRaiseTo: 400, maxRaiseTo: 10000, board: [], currentBet: 250 },
  { playerId: 'user', action: 'call', street: 'preflop', amount: 150, potTotal: 625, callAmount: 150, minRaiseTo: 400, maxRaiseTo: 10000, board: [], currentBet: 250 },
];
// The hero (BB) faces p2's bet; p1 (BTN) still has to act behind the hero.
function triple({ street = 'flop', actions = [], toCall = 400, seats = null, over = {} } = {}) {
  return spot({
    street, toCall,
    seats: seats ?? [seat('user', 'BB', { contribution: 250 }), seat('p1', 'BTN', { contribution: 250 }),
      seat('p2', 'SB', { contribution: 250 + toCall, bet: toCall, stack: 9750 - toCall })],
    over: { potBefore: 750 + toCall, currentBet: toCall, priorActions: [...TRIPLE_PREFLOP, ...actions], ...over },
  });
}
const p2Bet = (street = 'flop', amount = 400, pot = 750) => act('p2', street, 'raise', { amount, potTotal: pot });

test('with every live opponent conditioned, range equity covers the acted subset and labels the unacted one', () => {
  const snapshot = triple({ actions: [p2Bet()] });
  const estimate = estimateCoachRanges(snapshot);
  assert.equal(estimate.status, 'full');
  assert.deepEqual(estimate.acted, ['p2']);
  assert.deepEqual(estimate.unacted, ['p1']);
  assert.equal(estimate.players.p1.status, 'conditioned');
  const equity = coachEquityRanges(estimate);
  assert.equal(equity.reason, null);
  assert.deepEqual(equity.ranges, [estimate.players.p2.range]);
  assert.equal(equity.excluded, 1);
  const facts = decisionFacts(snapshot);
  assert.equal(facts.equityRange, equityFacts(snapshot, { ranges: [estimate.players.p2.range] }));
  assert.equal(facts.rangeEstimate.equityOmitted, null);
  assert.match(facts.line, /행동한 1명 대상, 아직 행동 전 1명 제외/);
});

test('an unacted opponent whose evidence is partial or unavailable also omits range equity', () => {
  // Turn: p2 bet the flop and the turn. p1 has no recorded flop action although it was not all-in
  // (partial), so a call from it later on cannot be ranged: no subset equity against p2.
  const gap = triple({ street: 'turn', toCall: 600, actions: [p2Bet('flop'), p2Bet('turn', 600, 1300)] });
  const estimate = estimateCoachRanges(gap);
  assert.equal(estimate.players.p1.status, 'partial');
  assert.deepEqual(estimate.players.p1.reasons, ['missing-street-action']);
  assert.deepEqual(estimate.unacted, ['p1']);
  assert.equal(estimate.players.p2.status, 'conditioned');
  assert.equal(coachEquityRanges(estimate).ranges, null);
  assert.equal(coachEquityRanges(estimate).reason, 'range-evidence-missing');
  const facts = decisionFacts(gap);
  assert.equal(facts.equityRange, null);
  assert.equal(facts.rangeEstimate.equityOmitted, 'range-evidence-missing');

  // The same spot with p1's flop call recorded is complete, and the subset equity returns.
  const complete = triple({ street: 'turn', toCall: 600, actions: [p2Bet('flop'),
    act('user', 'flop', 'call', { callAmount: 400, potTotal: 1150 }), act('p1', 'flop', 'call', { callAmount: 400, potTotal: 1550 }),
    p2Bet('turn', 600, 1950)] });
  const full = estimateCoachRanges(complete);
  assert.equal(full.status, 'full');
  assert.deepEqual(full.unacted, ['p1']);
  assert.equal(typeof decisionFacts(complete).equityRange, 'number');

  // A malformed unacted opponent (its own preflop price is unusable) blocks it as well.
  const broken = triple({ actions: [p2Bet()] });
  broken.priorActions[0] = without(broken.priorActions[0], 'maxRaiseTo');
  const bad = estimateCoachRanges(broken);
  assert.equal(bad.players.p1.status, 'unavailable');
  assert.deepEqual(bad.unacted, ['p1']);
  assert.equal(coachEquityRanges(bad).ranges, null);
  assert.equal(decisionFacts(broken).equityRange, null);
});

test('coachEquityRanges refuses incomplete or inconsistent estimates instead of throwing', () => {
  assert.equal(coachEquityRanges(null).reason, 'no-estimate');
  assert.equal(coachEquityRanges({}).reason, 'no-estimate');
  assert.equal(coachEquityRanges({ players: {} }).reason, 'no-estimate');
  const good = estimateCoachRanges(triple({ actions: [p2Bet()] }));
  assert.ok(coachEquityRanges(good).ranges);
  // Hand-edited: a live opponent listed in neither group, or an issue recorded for the estimate.
  assert.equal(coachEquityRanges({ ...good, unacted: [] }).ranges, null);
  assert.equal(coachEquityRanges({ ...good, issues: ['bad-actions'] }).ranges, null);
  assert.equal(coachEquityRanges({ ...good, players: { ...good.players, p1: { ...good.players.p1, range: null } } }).ranges, null);
});

test('a postflop raise without a valid price is unavailable, never a bet-weighted range', () => {
  const raise = act('p1', 'flop', 'raise', { amount: 1200, potTotal: 900, callAmount: 400 });
  const good = spot({ street: 'flop', toCall: 400, actions: [raise] });
  assert.equal(estimateCoachRanges(good).players.p1.status, 'conditioned');
  // A missing price used to read as zero and turn the raise into a bet, which weights the range differently.
  const asBet = rangeOf(spot({ street: 'flop', toCall: 400, actions: [{ ...raise, callAmount: 0 }] }));
  assert.notDeepEqual(asBet, rangeOf(good));
  for (const junk of JUNK) {
    const broken = spot({ street: 'flop', toCall: 400, actions: [withField(raise, 'callAmount', junk)] });
    const estimate = estimateCoachRanges(broken);
    assert.equal(estimate.players.p1.status, 'unavailable', label(junk));
    assert.equal(estimate.players.p1.range, null, label(junk));
    assert.deepEqual(estimate.players.p1.reasons, ['bad-sizing'], label(junk));
    assert.equal(estimate.status, 'unavailable');
    assert.equal(coachEquityRanges(estimate).ranges, null);
    const facts = decisionFacts(broken);
    assert.equal(facts.equityRange, null, label(junk));
    assert.equal(facts.rangeEstimate.equityOmitted, 'range-evidence-missing');
    assert.match(facts.line, /레인지 에퀴티 생략/);
  }
});

test('every field the likelihoods read must be present: bet, raise and call prices', () => {
  const required = [
    ['bet', act('p1', 'flop', 'raise', { amount: 400, potTotal: 500, callAmount: 0 }), ['amount', 'potTotal', 'callAmount']],
    ['raise', act('p1', 'flop', 'raise', { amount: 1200, potTotal: 900, callAmount: 400 }), ['amount', 'potTotal', 'callAmount']],
    ['call', act('p1', 'flop', 'call', { amount: 400, potTotal: 900, callAmount: 400 }), ['potTotal', 'callAmount']],
  ];
  for (const [kind, action, fields] of required) {
    const baseline = estimateCoachRanges(spot({ street: 'flop', toCall: 400, actions: [action] }));
    assert.equal(baseline.players.p1.status, 'conditioned', kind);
    for (const field of fields) {
      for (const junk of JUNK) {
        const estimate = estimateCoachRanges(spot({ street: 'flop', toCall: 400, actions: [withField(action, field, junk)] }));
        assert.deepEqual([estimate.players.p1.status, estimate.players.p1.range, estimate.players.p1.reasons],
          ['unavailable', null, ['bad-sizing']], `${kind}.${field}=${label(junk)}`);
      }
    }
  }
  // A raise/bet needs a positive size; a zero callAmount is a valid bet price.
  const zeroSize = estimateCoachRanges(spot({ street: 'flop', actions: [act('p1', 'flop', 'raise', { amount: 0, potTotal: 500 })] }));
  assert.deepEqual(zeroSize.players.p1.reasons, ['bad-sizing']);
  // Checks and folds carry no price the estimate reads, so their price fields may be absent.
  const checked = estimateCoachRanges(spot({ street: 'turn', actions: [check('flop')] }));
  for (const field of ['amount', 'potTotal', 'callAmount', 'minRaiseTo', 'maxRaiseTo', 'currentBet']) {
    const stripped = spot({ street: 'turn', actions: [without(check('flop'), field)] });
    assert.deepEqual(estimateCoachRanges(stripped), checked, field);
  }
});

test('an action that cannot be placed in the timeline makes every opponent unavailable', () => {
  const base = spot({ street: 'turn', actions: [bet('flop')] });
  const cases = {
    'no street (v3 would read it as preflop)': (a) => withField(a, 'street', undefined),
    'unknown street': (a) => ({ ...a, street: 'turnish' }),
    'no player': (a) => withField(a, 'playerId', undefined),
    'numeric player': (a) => ({ ...a, playerId: 7 }),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const snapshot = structuredClone(base);
    snapshot.priorActions[2] = mutate(snapshot.priorActions[2]);
    const estimate = estimateCoachRanges(snapshot);
    assert.equal(estimate.players.p1.status, 'unavailable', name);
    assert.equal(estimate.players.p1.range, null, name);
    assert.ok(estimate.issues.length > 0, name);
    assert.equal(coachEquityRanges(estimate).ranges, null, name);
  }
  for (const entry of [null, 5, 'bet', []]) {
    const snapshot = structuredClone(base);
    snapshot.priorActions.splice(1, 0, entry);
    const estimate = estimateCoachRanges(snapshot);
    assert.equal(estimate.players.p1.range, null, label(entry));
    assert.deepEqual(estimate.issues, ['malformed-action']);
  }
  for (const priorActions of [undefined, null, {}, 'x']) {
    const snapshot = withField(base, 'priorActions', priorActions);
    const estimate = estimateCoachRanges(snapshot);
    assert.equal(estimate.players.p1.range, null, label(priorActions));
    assert.deepEqual(estimate.issues, ['bad-actions']);
  }
});

test('preflop evidence: the opener price, the actions before the caller and the first action itself must be valid', () => {
  // HU 100bb, blinds 50/100: p1 (BTN/SB) opens, the hero (BB) calls. p1's open is the RFI chart.
  const open = { playerId: 'p1', action: 'raise', street: 'preflop', amount: 250, potTotal: 150, callAmount: 50, minRaiseTo: 200, maxRaiseTo: 10000, board: [], currentBet: 100 };
  const heroCall = { playerId: 'user', action: 'call', street: 'preflop', amount: 150, potTotal: 400, callAmount: 150, minRaiseTo: 400, maxRaiseTo: 10000, board: [], currentBet: 250 };
  const hu = (priorActions) => ({ ...spot({ street: 'flop' }), priorActions,
    publicSeats: [seat('user', 'BB'), seat('p1', 'BTN/SB')] });
  const baseline = estimateCoachRanges(hu([open, heroCall]));
  assert.equal(baseline.players.p1.status, 'conditioned');
  assert.deepEqual(baseline.players.p1.range, (() => {
    const v3 = estimateOpponentRanges(hu([open, heroCall])).p1;
    const top = Math.max(...Object.values(v3));
    return Object.fromEntries(Object.entries(v3).map(([cls, w]) => [cls, w / top]));
  })(), 'with no postflop action the coaching range is the normalised v3 chart');

  // The opener's own raise: without a raise-to cap the shove test silently turns false.
  for (const field of ['amount', 'maxRaiseTo']) {
    for (const junk of JUNK) {
      const estimate = estimateCoachRanges(hu([withField(open, field, junk), heroCall]));
      assert.deepEqual([estimate.players.p1.status, estimate.players.p1.range, estimate.players.p1.reasons],
        ['unavailable', null, ['bad-sizing']], `own ${field}=${label(junk)}`);
    }
  }
  assert.deepEqual(estimateCoachRanges(hu([{ ...open, maxRaiseTo: 200 }, heroCall])).players.p1.reasons, ['bad-sizing'], 'raise-to above the cap');
  assert.deepEqual(estimateCoachRanges(hu([{ ...open, action: 'raize' }, heroCall])).players.p1.reasons, ['unknown-action']);
  assert.deepEqual(estimateCoachRanges(hu([withField(open, 'action', undefined), heroCall])).players.p1.reasons, ['unknown-action']);

  // Three-handed: p2's call depends on p1's open and on the actions before it. The hero's and p1's
  // malformed preflop actions both make p2 unavailable, with the reason that names the earlier evidence.
  const triplePre = (index, edit) => {
    const snapshot = triple({ actions: [p2Bet()] });
    snapshot.priorActions[index] = edit(snapshot.priorActions[index]);
    return estimateCoachRanges(snapshot);
  };
  for (const junk of JUNK) {
    const e = triplePre(0, (a) => withField(a, 'maxRaiseTo', junk));
    assert.deepEqual([e.players.p1.status, e.players.p2.status], ['unavailable', 'unavailable'], label(junk));
    assert.deepEqual(e.players.p2.reasons, ['earlier-preflop-evidence'], label(junk));
    assert.equal(e.players.p2.range, null);
  }
  const unknownOpen = triplePre(0, (a) => ({ ...a, action: 'shrug' }));
  assert.deepEqual(unknownOpen.players.p2.reasons, ['earlier-preflop-evidence']);
  // Later actions are not read: a malformed hero call after both opponents acted changes nothing.
  const lateHero = triplePre(2, (a) => ({ ...a, action: 'shrug', amount: 'x', maxRaiseTo: null }));
  const clean = estimateCoachRanges(triple({ actions: [p2Bet()] }));
  assert.deepEqual(lateHero, clean);
  // Another player's postflop action is not part of p1's evidence either.
  const p2Junk = estimateCoachRanges(triple({ actions: [{ ...p2Bet(), action: 'shrug' }] }));
  assert.equal(p2Junk.players.p1.status, 'conditioned');
  assert.deepEqual(p2Junk.players.p2.reasons, ['unknown-action']);
  assert.equal(coachEquityRanges(p2Junk).ranges, null);

  // A real short-stack shove stays supported: the cap equals the raise-to and the stack is <= 15bb.
  const shove = { ...open, amount: 1000, maxRaiseTo: 1000 };
  const shoved = { ...hu([shove, { ...heroCall, amount: 900, callAmount: 900, maxRaiseTo: 1000 }]),
    publicSeats: [seat('user', 'BB', { stack: 0, allIn: true }), seat('p1', 'BTN/SB', { stack: 0, allIn: true })] };
  assert.equal(estimateCoachRanges(shoved).players.p1.status, 'conditioned');
  assert.ok(Object.keys(estimateCoachRanges(shoved).players.p1.range).length < Object.keys(baseline.players.p1.range).length,
    'the push chart is narrower than the 100bb RFI chart');
});

test('the decision context must be complete before any opponent gets a range', () => {
  const base = spot({ toCall: 400, actions: [bet('flop'), bet('turn', 600, 1300), bet('river', 1500, 2500)] });
  assert.equal(estimateCoachRanges(base).status, 'full');
  const unavailable = (snapshot, issue, reason = issue) => {
    const estimate = estimateCoachRanges(snapshot);
    assert.ok(estimate.issues.includes(issue), `${issue}: ${JSON.stringify(estimate.issues)}`);
    assert.equal(estimate.status, 'unavailable');
    for (const row of Object.values(estimate.players)) assert.deepEqual([row.range, row.reasons], [null, [reason]]);
    assert.equal(coachEquityRanges(estimate).ranges, null);
    return estimate;
  };
  // The blind that sizes every preflop shove test.
  for (const blinds of [undefined, null, [50], [50, 0], [50, -100], [50, 'x'], [50, NaN], 'x', {}]) {
    unavailable(withField(base, 'blinds', blinds), 'bad-preflop-context');
  }
  // Seat flags: a missing flag used to read as "still in the hand".
  for (const key of ['out', 'folded', 'allIn']) {
    for (const junk of [undefined, null, 'x', 0, 1]) {
      const snapshot = structuredClone(base);
      snapshot.publicSeats[1] = withField(snapshot.publicSeats[1], key, junk);
      const estimate = estimateCoachRanges(snapshot);
      assert.ok(estimate.issues.includes('bad-seat-evidence'), `${key}=${label(junk)}`);
      assert.equal(coachEquityRanges(estimate).ranges, null);
    }
  }
  for (const [name, edit] of Object.entries({
    'seat position missing': (s) => { delete s.publicSeats[0].position; },
    'seat position junk': (s) => { s.publicSeats[1].position = 7; },
    'duplicate seat': (s) => { s.publicSeats[1].playerId = 'user'; },
    'seat entry not an object': (s) => { s.publicSeats[1] = null; },
    'seats not a list': (s) => { s.publicSeats = 'x'; },
    'no actor': (s) => { delete s.actorId; },
    'actor not seated': (s) => { s.actorId = 'ghost'; },
    'actor folded': (s) => { s.publicSeats[0].folded = true; },
  })) {
    const snapshot = structuredClone(base);
    edit(snapshot);
    const estimate = estimateCoachRanges(snapshot);
    assert.ok(estimate.issues.includes('bad-seat-evidence'), name);
    assert.ok(!('user' in estimate.players), `${name}: the hero must never be ranged as an opponent`);
    assert.equal(coachEquityRanges(estimate).ranges, null, name);
  }
  // Hero cards: used for blockers, so a malformed pair is not silently treated as "no blockers".
  for (const holeCards of [undefined, null, [], ['Qh'], ['Qh', 'Qh'], ['Qh', 'zz'], 'QhJd', ['Qh', 'Jd', '2c']]) {
    unavailable(withField(base, 'holeCards', holeCards), 'bad-board-evidence');
  }
  assert.doesNotThrow(() => estimateCoachRanges({ ...base, publicSeats: [null, 7, 'x'] }));
});

test('fields the estimate never reads do not change it, so legacy and stripped records stay supported', () => {
  const base = spot({ toCall: 400, actions: [bet('flop'), check('turn'), bet('river', 1500, 2500)] });
  const baseline = estimateCoachRanges(base);
  assert.equal(baseline.status, 'full');
  const unread = ['decisionId', 'stacks', 'currentBet', 'minRaiseTo', 'reason', 'note', 'forced'];
  base.priorActions.forEach((action, index) => {
    for (const key of unread) {
      const stripped = structuredClone(base);
      stripped.priorActions[index] = without(stripped.priorActions[index], key);
      assert.deepEqual(estimateCoachRanges(stripped), baseline, `priorActions[${index}].${key}`);
    }
  });
  // Preflop actions that are not a raise carry no size the estimate reads; no preflop action reads a board.
  for (const [index, keys] of [[0, ['board', 'potTotal', 'callAmount']], [1, ['board', 'potTotal', 'callAmount', 'amount', 'maxRaiseTo']]]) {
    for (const key of keys) {
      const stripped = structuredClone(base);
      stripped.priorActions[index] = without(stripped.priorActions[index], key);
      assert.deepEqual(estimateCoachRanges(stripped), baseline, `preflop[${index}].${key}`);
    }
  }
  for (const key of ['decisionId', 'handNo', 'schemaVersion', 'position', 'potBefore', 'currentBet', 'actorBet', 'toCall', 'minRaiseTo',
    'maxRaiseTo', 'effectiveStack', 'forced', 'legal', 'chosenAction', 'assistance', 'gameMode']) {
    assert.deepEqual(estimateCoachRanges(without(base, key)), baseline, key);
  }
  for (const key of ['stack', 'bet', 'contribution']) {
    const stripped = structuredClone(base);
    stripped.publicSeats = stripped.publicSeats.map((s) => without(s, key));
    assert.deepEqual(estimateCoachRanges(stripped), baseline, `seat.${key}`);
  }
});

// Every field of a good snapshot gets every kind of junk. The estimate must not throw, must stay
// serialisable, and may only admit range equity that is identical to the baseline's: a field
// the estimate reads can never be defaulted into a different range.
test('no junk in any field of the snapshot throws or silently changes the equity ranges', () => {
  const base = spot({ toCall: 400, actions: [bet('flop'), bet('turn', 600, 1300), act('p1', 'river', 'raise', { amount: 1500, potTotal: 2500, callAmount: 400 })] });
  const baseline = coachEquityRanges(estimateCoachRanges(base));
  assert.ok(baseline.ranges);
  const paths = [];
  const walk = (node, path) => {
    if (path.length) paths.push(path);
    if (Array.isArray(node)) node.forEach((value, i) => walk(value, [...path, i]));
    else if (node && typeof node === 'object') for (const key of Object.keys(node)) walk(node[key], [...path, key]);
  };
  walk(base, []);
  const at = (root, path) => path.slice(0, -1).reduce((node, key) => node[key], root);
  let admitted = 0;
  let factsChecked = 0;
  for (const path of paths) {
    for (const junk of JUNK) {
      const mutated = structuredClone(base);
      const parent = at(mutated, path);
      const key = path.at(-1);
      if (junk === undefined) { if (Array.isArray(parent)) parent[key] = undefined; else delete parent[key]; } else parent[key] = junk;
      const where = `${path.join('.')}=${label(junk)}`;
      let estimate;
      assert.doesNotThrow(() => { estimate = estimateCoachRanges(mutated); }, where);
      assert.doesNotThrow(() => JSON.stringify(estimate), where);
      for (const row of Object.values(estimate.players)) {
        assert.ok(row.range === null || Object.values(row.range).every((w) => Number.isFinite(w) && w > 0 && w <= 1), where);
      }
      const equity = coachEquityRanges(estimate);
      if (equity.ranges) {
        admitted += 1;
        assert.deepEqual(equity.ranges, baseline.ranges, `admitted a changed range: ${where}`);
      }
      if (factsChecked < 120 && path.length === 1) {
        // decisionFacts computes the random-hand equity outside any try block (tools/review-facts.js,
        // unchanged since HEAD), so a shape that chipFacts/equityFacts themselves reject (for example
        // no holeCards) throws there regardless of the range path. Those shapes are skipped here.
        let chips = null;
        try { chips = chipFacts(mutated); if (chips) equityFacts(mutated); } catch { chips = null; }
        if (chips) {
          factsChecked += 1;
          assert.doesNotThrow(() => decisionFacts(mutated), where);
          assert.equal(decisionFacts(mutated).equityRange === null, equity.ranges === null, where);
        }
      }
    }
  }
  assert.ok(admitted > 100, `unread fields must stay harmless (${admitted} admitted mutations)`);
  assert.ok(factsChecked > 20);
});

test('bad decisions inside a hand record reach review facts and the evaluator as omitted range equity, good ones are untouched', () => {
  const good = spot({ street: 'flop', toCall: 400, actions: [act('p1', 'flop', 'raise', { amount: 1200, potTotal: 900, callAmount: 400 })] });
  const noPrice = structuredClone(good);
  noPrice.decisionId = 'd-1-flop-11';
  noPrice.priorActions[2] = without(noPrice.priorActions[2], 'callAmount');
  const noSeatFlag = structuredClone(good);
  noSeatFlag.decisionId = 'd-1-flop-12';
  delete noSeatFlag.publicSeats[1].allIn;
  const noBlind = structuredClone(good);
  noBlind.decisionId = 'd-1-flop-15';
  noBlind.blinds = [50];
  const noOpenCap = structuredClone(good);
  noOpenCap.decisionId = 'd-1-flop-13';
  noOpenCap.priorActions[0] = without(noOpenCap.priorActions[0], 'maxRaiseTo');
  const lateGood = structuredClone(good);
  lateGood.decisionId = 'd-1-flop-14';
  // Without a big blind there is no price arithmetic at all: that decision has no line, and the
  // others still do.
  assert.equal(decisionFacts(noBlind), null);
  const record = { handNo: 1, decisions: [good, noPrice, noBlind, noSeatFlag, noOpenCap, lateGood] };
  const lines = decisionFactsLines(record);
  assert.deepEqual(lines, decisionFactsLines(structuredClone(record)), 'deterministic');
  assert.equal(lines.length, 5);
  const [first, second, third, fourth, fifth] = lines;
  assert.match(first, /추정 레인지 대비 에퀴티 [\d.]+%/);
  assert.match(fifth, /추정 레인지 대비 에퀴티 [\d.]+%/);
  for (const line of [second, third, fourth]) {
    assert.match(line, /레인지 에퀴티 생략/);
    assert.doesNotMatch(line, /추정 레인지 대비 에퀴티/);
    assert.match(line, /무작위 1명 대비 에퀴티 [\d.]+%/, 'the price arithmetic and random-hand equity are unaffected');
    assert.match(line, /필요 승률 \d+\.\d%/);
  }
  // The two good decisions read the same apart from their ids and the seeded simulation numbers.
  const shape = (line) => line.replace(/^d-1-flop-\d+/, '').replace(/에퀴티 [\d.]+%/g, '에퀴티 N%');
  assert.equal(shape(first), shape(fifth));
  for (const bad of [noPrice, noSeatFlag, noOpenCap]) {
    const facts = decisionFacts(bad);
    assert.equal(facts.equityRange, null);
    assert.equal(facts.rangeEstimate.equityOmitted, 'range-evidence-missing');
    assert.notEqual(facts.rangeEstimate.status, 'full');
  }
});

// Real engine records: run a heads-up and a three-handed hand through the engine and check that
// good snapshots are still fully supported by the stricter validation.
function playScripted({ aiCount, button }) {
  const game = createGame({ aiCount, startStack: 10000, levelEvery: 50 });
  game.button = button;
  let state = startHand(game, { deck: fixedDeck() }).state;
  while (!legalFor(state).handOver) {
    const legal = legalFor(state);
    const villain = legal.toAct !== 'user';
    let move = legal.canCheck ? ['check'] : ['call'];
    if (state.hand.street === 'preflop') {
      if (villain && legal.canRaise && !state.hand.actions.some((a) => a.action === 'raise')) move = ['raise', 250];
    } else if (villain && legal.canCheck && legal.canRaise) {
      move = ['raise', legal.minRaiseTo];
    }
    state = applyAction(state, legal.toAct, move[0], move[1]).state;
  }
  return state.lastHand;
}

test('real engine hands: good records stay fully conditioned and fully supported, bad copies do not', () => {
  const headsUp = playScripted({ aiCount: 1, button: 0 });
  const rows = headsUp.decisions.map((snap) => ({ snap, estimate: estimateCoachRanges(snap) }));
  for (const { snap, estimate } of rows) {
    assert.equal(estimate.status, 'full', snap.decisionId);
    assert.deepEqual(estimate.issues, [], snap.decisionId);
    assert.equal(estimate.players.p1.status, 'conditioned', snap.decisionId);
  }
  const facing = rows.filter(({ snap, estimate }) => snap.street !== 'preflop' && estimate.acted.includes('p1'));
  assert.ok(facing.length >= 2, 'the villain bets after the hero checks on later streets');
  for (const { snap } of facing) {
    assert.equal(typeof decisionFacts(snap).equityRange, 'number', snap.decisionId);
    assert.ok(snap.priorActions.some((a) => a.street !== 'preflop' && a.action === 'raise' && a.playerId === 'p1'));
  }
  // A villain bet is a record with callAmount 0 and a raise-to amount; a real raise price is never absent.
  for (const { snap } of facing) {
    for (const action of snap.priorActions) if (action.action === 'raise' && action.street !== 'preflop') assert.ok(Number.isInteger(action.callAmount));
  }
  // The same decisions with the price removed from the villain's postflop bet are not supported.
  const target = facing.at(-1).snap;
  const corrupted = structuredClone(target);
  const index = corrupted.priorActions.findIndex((a) => a.street !== 'preflop' && a.action === 'raise');
  delete corrupted.priorActions[index].callAmount;
  const bad = estimateCoachRanges(corrupted);
  assert.equal(bad.players.p1.status, 'unavailable');
  assert.equal(decisionFacts(corrupted).equityRange, null);
  const mixed = structuredClone(headsUp);
  mixed.decisions = mixed.decisions.map((snap) => (snap.decisionId === target.decisionId ? corrupted : snap));
  const goodLines = decisionFactsLines(headsUp);
  const mixedLines = decisionFactsLines(mixed);
  assert.equal(goodLines.length, mixedLines.length);
  goodLines.forEach((line, i) => {
    if (line.startsWith(`${target.decisionId}:`)) {
      assert.match(mixedLines[i], /레인지 에퀴티 생략/);
      assert.notEqual(mixedLines[i], line);
    } else {
      assert.equal(mixedLines[i], line, line.slice(0, 20));
    }
  });

  // Three-handed: BTN opens, SB calls, the hero (BB) calls. On the flop the SB bets, the BTN has not acted.
  const threeWay = playScripted({ aiCount: 2, button: 0 });
  const subset = threeWay.decisions.map((snap) => ({ snap, estimate: estimateCoachRanges(snap) }))
    .filter(({ snap, estimate }) => snap.street === 'flop' && estimate.unacted.length === 1 && estimate.acted.length === 1);
  assert.ok(subset.length >= 1);
  for (const { snap, estimate } of subset) {
    assert.equal(estimate.status, 'full');
    const facts = decisionFacts(snap);
    assert.equal(typeof facts.equityRange, 'number');
    assert.match(facts.line, /행동한 1명 대상, 아직 행동 전 1명 제외/);
  }
  // An unacted live opponent with a broken preflop line removes the subset equity.
  const { snap: threeSnap } = subset[0];
  const brokenOpen = structuredClone(threeSnap);
  const open = brokenOpen.priorActions.find((a) => a.street === 'preflop' && a.action === 'raise');
  delete open.maxRaiseTo;
  const brokenFacts = decisionFacts(brokenOpen);
  assert.equal(brokenFacts.equityRange, null);
  assert.equal(brokenFacts.rangeEstimate.equityOmitted, 'range-evidence-missing');
});
