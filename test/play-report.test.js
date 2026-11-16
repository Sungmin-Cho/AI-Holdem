import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, legalFor } from '../engine/hand.js';
import { replayRecord } from '../shared/hand-replay.js';
import { CANONICAL_REFERENCE_SOURCE, coachingClaimAllowed, referenceClaimAllowed, sanitizeCoachingText } from '../shared/reference.js';
import { loadReferenceDataset } from '../tools/preflop-dataset.js';
import { decisionFacts } from '../tools/review-facts.js';
import {
  SHORT_STACK_BB, WINDOW_HERO_HANDS, YARDSTICK_MIN_HANDS, addGameSummary, allInExpectation, buildPlayReport, emptyGameSummary, focusLinesKo,
  gameCheckLinesKo, playReportView, summarizeGame, vpipBand, yardstickKey,
} from '../training/play-report.js';
import { toProcessReview } from '../training/process-review.js';
import { lookup } from '../training/providers/preflop-json.js';
import { handClassOf } from '../training/cards.js';
import { setup3 } from './helpers/fixtures.js';

const dataset = loadReferenceDataset(CANONICAL_REFERENCE_SOURCE);
const options = { dataset, factsOf: decisionFacts };

// Plays one hand from a started state. `user(legal, state)` returns [action, amount];
// the other seats check or fold unless `others` says otherwise.
function play(state, user, others = (legal) => (legal.canCheck ? ['check'] : ['fold'])) {
  let current = state;
  while (!legalFor(current).handOver) {
    const legal = legalFor(current);
    const [action, amount] = legal.toAct === 'user' ? user(legal, current) : others(legal, current);
    current = applyAction(current, legal.toAct, action, amount).state;
  }
  return current.lastHand;
}
const handOf = (record, reveal = 'all') => ({ replay: replayRecord(record, { reveal }), decisions: toProcessReview(record).decisions });
const meta = (over = {}) => ({ gameId: '11111111-1111-4111-8111-111111111111', savedAt: '2026-11-01T00:00:00.000Z', mode: 'tournament', opponent: 'llm', ...over });
const checkOrCall = (legal) => (legal.canCheck ? ['check'] : ['call']);

test('an open limp on the button is a limp, a voluntary entry and an open-limp check', () => {
  // 3-handed, 100BB, user on the button acts first.
  const record = play(setup3(5000, 5000, 5000), checkOrCall, checkOrCall);
  const summary = summarizeGame(meta(), [handOf(record)], options);
  assert.equal(summary.heroHands, 1);
  assert.deepEqual(summary.table['3-4'], { hands: 1, vpip: 1, pfr: 0 });
  assert.deepEqual(summary.preflop.unopened, { n: 1, raise: 0, limp: 1, fold: 0 });
  assert.equal(summary.checks.unopenedDeep, 1);
  assert.deepEqual(summary.checks.openLimp, [1]);
  assert.equal(summary.checks.shortEntries, 0);
  assert.deepEqual(summary.postflop.wtsd, { k: 1, n: 1 });
  // The chart has no limp: the entry is compared as a call the reference never makes.
  const rfi = summary.reference.groups.rfi;
  assert.equal(rfi.n, 1);
  assert.equal(rfi.actual.call, 1);
  assert.equal(rfi.expected.call, 0);
  assert.ok(Math.abs(rfi.expected.raise + rfi.expected.fold - 1) < 1e-9);
});

test('an open raise is compared with the chart average and the hand itself', () => {
  const record = play(setup3(5000, 5000, 5000), (legal) => (legal.canCheck ? ['check'] : legal.callAmount === 50 ? ['raise', 125] : ['fold']));
  const hand = handOf(record);
  const summary = summarizeGame(meta(), [hand], options);
  assert.deepEqual(summary.table['3-4'], { hands: 1, vpip: 1, pfr: 1 });
  assert.deepEqual(summary.preflop.unopened, { n: 1, raise: 1, limp: 0, fold: 0 });
  const rfi = summary.reference.groups.rfi;
  assert.equal(rfi.n, 1);
  assert.equal(rfi.exact, 1);
  assert.equal(rfi.actual.raise, 1);
  // The expectation is what the chart does with the hand hero actually held.
  const rows = lookup(dataset, { spotKey: '3max-100bb-btn-rfi-v3', handClass: handClassOf(record.holes.user) }).actions;
  const frequency = (action) => rows.find((row) => row.action === action)?.frequency ?? 0;
  assert.equal(rfi.expected.raise, frequency('raise'));
  assert.equal(rfi.expected.fold, frequency('fold'));
  assert.equal(rfi.offRange, frequency('fold') === 1 ? 1 : 0);
});

test('at ten big blinds or less a small raise is an entry that is not all-in; a shove is not', () => {
  const small = play(setup3(400, 5000, 5000), (legal) => (legal.canCheck ? ['check'] : legal.canRaise && legal.callAmount === 50 ? ['raise', legal.minRaiseTo] : ['fold']));
  const first = summarizeGame(meta(), [handOf(small)], options);
  assert.equal(first.checks.shortEntries, 1);
  assert.deepEqual(first.checks.shortNonAllIn, [1]);
  assert.deepEqual(first.checks.openLimp, []);
  const shove = play(setup3(400, 5000, 5000), (legal) => ['raise', legal.maxRaiseTo]);
  const second = summarizeGame(meta(), [handOf(shove)], options);
  assert.equal(second.checks.shortEntries, 1);
  assert.deepEqual(second.checks.shortNonAllIn, []);
  const fold = play(setup3(400, 5000, 5000), () => ['fold']);
  assert.equal(summarizeGame(meta(), [handOf(fold)], options).checks.shortEntries, 0);
  // A call for the whole stack is all-in, not a limp: build the decision by hand.
  const hand = handOf(small);
  const entry = hand.decisions[0];
  const allInCall = { ...entry, toCall: 400, chosenAction: { action: 'call', amount: 400 },
    publicSeats: entry.publicSeats.map((row) => (row.playerId === 'user' ? { ...row, stack: 400, contribution: 0 } : row)) };
  const third = summarizeGame(meta(), [{ ...hand, decisions: [allInCall] }], options);
  assert.equal(third.checks.shortEntries, 1);
  assert.deepEqual(third.checks.shortNonAllIn, []);
  assert.equal(SHORT_STACK_BB, 10);
});

test('a raise that covers every opponent is all-in in effect, whatever the host keeps behind', () => {
  // The host has 100BB on the button; the blinds have 8BB and 6BB. Opening to 8BB covers both.
  const record = play(setup3(5000, 300, 400), (legal) => (legal.canCheck ? ['check'] : legal.callAmount === 50 ? ['raise', 400] : ['fold']));
  const covering = summarizeGame(meta(), [handOf(record)], options);
  assert.equal(covering.checks.shortEntries, 1);
  assert.deepEqual(covering.checks.shortNonAllIn, []);
  const small = play(setup3(5000, 300, 400), (legal) => (legal.canCheck ? ['check'] : legal.callAmount === 50 ? ['raise', 125] : ['fold']));
  assert.deepEqual(summarizeGame(meta(), [handOf(small)], options).checks.shortNonAllIn, [1]);
});

test('a watchdog fold before the flop is not a flop the host saw', () => {
  // The host is folded by the clock; the two others see a flop and a showdown.
  const record = play(setup3(5000, 5000, 5000), () => ['fold'], checkOrCall);
  assert.ok(record.board.length >= 3, 'fixture: the others reached the flop');
  const forcedFold = (rec) => ({ ...rec, actions: rec.actions.map((action) => (action.playerId === 'user' ? { ...action, forced: true } : action)) });
  const hand = handOf(forcedFold(record));
  assert.equal(hand.replay.actions.find((action) => action.playerId === 'user').forced, true);
  const summary = summarizeGame(meta(), [hand], options);
  assert.deepEqual(summary.postflop.wtsd, { k: 0, n: 0 });
  assert.deepEqual(summary.table['3-4'], { hands: 0, vpip: 0, pfr: 0 }, 'a forced action is not an entry decision');
  // The deliberate fold gives the same answer.
  assert.deepEqual(summarizeGame(meta(), [handOf(record)], options).postflop.wtsd, { k: 0, n: 0 });
});

test('a flop the host had a turn on counts, whether the host then folds or is all-in', () => {
  // Calls before the flop, folds to a bet on the flop: a flop seen, no showdown.
  const foldsFlop = play(setup3(5000, 5000, 5000),
    (legal, state) => (legal.canCheck ? ['check'] : state.hand.street === 'preflop' ? ['call'] : ['fold']),
    (legal, state) => (state.hand.street === 'flop' && legal.toAct === 'p1' && legal.canRaise ? ['raise', legal.minRaiseTo] : legal.canCheck ? ['check'] : ['call']));
  assert.ok(foldsFlop.folded.includes('user') && foldsFlop.board.length >= 3, 'fixture: the host folded after the flop');
  assert.deepEqual(summarizeGame(meta(), [handOf(foldsFlop)], options).postflop.wtsd, { k: 0, n: 1 });
  // All-in on the flop and called: a flop seen and a showdown.
  const jamsFlop = play(setup3(1500, 5000, 5000),
    (legal, state) => (state.hand.street === 'preflop' ? (legal.canCheck ? ['check'] : ['call']) : legal.canRaise ? ['raise', legal.maxRaiseTo] : ['call']),
    checkOrCall);
  assert.ok(jamsFlop.allIn.includes('user') && jamsFlop.showdown, 'fixture: the host was all-in after the flop and shown down');
  assert.deepEqual(summarizeGame(meta(), [handOf(jamsFlop)], options).postflop.wtsd, { k: 1, n: 1 });
});

test('a game reduced hand by hand adds up to the game reduced at once; checks-only skips the rest', () => {
  const hands = [
    handOf(play(setup3(5000, 5000, 5000), checkOrCall, checkOrCall)),
    handOf(play(setup3(400, 5000, 5000), (legal) => (legal.canCheck ? ['check'] : legal.canRaise && legal.callAmount === 50 ? ['raise', legal.minRaiseTo] : ['fold']))),
    handOf(play(setup3(5000, 600, 5000),
      (legal) => (legal.canCheck ? ['check'] : legal.callAmount === 50 ? ['raise', 125] : ['call']),
      (legal) => (legal.toAct === 'p1' && legal.canRaise ? ['raise', legal.maxRaiseTo] : legal.canCheck ? ['check'] : ['fold']))),
  ];
  const whole = summarizeGame(meta(), hands, options);
  const added = emptyGameSummary(meta());
  for (const hand of hands) addGameSummary(added, summarizeGame(meta(), [hand], options));
  assert.deepEqual(added, whole);
  assert.equal(whole.results.allIns, 1);
  const checks = summarizeGame(meta(), hands, { ...options, checksOnly: true });
  assert.deepEqual(checks.checks, whole.checks);
  assert.deepEqual(checks.results, emptyGameSummary().results, 'no all-in simulation');
  assert.equal(checks.reference.snapshots, 0);
  assert.deepEqual(checks.table, emptyGameSummary().table);
});

test('calling a shove with nobody left to act is a closed decision', () => {
  // p1 (small blind) shoves over the user's limp-free fold line: here the user is on
  // the button, folds; replay the same seats with the user calling the shove instead.
  const record = play(setup3(5000, 600, 5000),
    (legal) => (legal.canCheck ? ['check'] : legal.callAmount === 50 ? ['raise', 125] : ['call']),
    (legal) => (legal.toAct === 'p1' && legal.canRaise ? ['raise', legal.maxRaiseTo] : legal.canCheck ? ['check'] : ['fold']));
  const summary = summarizeGame(meta(), [handOf(record)], options);
  assert.equal(summary.checks.closed, 1);
  assert.equal(summary.checks.closedCalls, 1);
  assert.equal(summary.preflop.shoveCalls, 1);
  // The board only ran out: the host covered the all-in and never had a turn after the flop.
  assert.deepEqual(summary.postflop.wtsd, { k: 0, n: 0 });
  assert.equal(summary.results.hands, 1);
  // Both hands were shown at the all-in showdown, so the result is adjusted.
  assert.equal(summary.results.allIns, 1);
  assert.ok(Math.abs(summary.results.netBb - summary.results.luckBb - summary.results.adjBb) < 1e-9);
});

const replayOf = (over = {}) => ({
  handNo: 3, blinds: [50, 100], board: ['Ks', '7c', '2d', '3h', '9s'], folded: [], allIn: ['user', 'p1'],
  startStacks: { user: 1000, p1: 1000 }, endStacks: { user: 0, p1: 2000 },
  holes: { user: ['Ah', 'Ad'], p1: ['Kh', 'Kd'] }, showdown: { reveals: [], mucks: [] },
  pots: [{ potIndex: 0, amount: 2000, eligible: ['user', 'p1'], winners: [{ playerId: 'p1', share: 2000 }] }],
  actions: [{ playerId: 'p1', action: 'raise', amount: 900, street: 'turn', board: ['Ks', '7c', '2d', '3h'] },
    { playerId: 'user', action: 'call', amount: 900, street: 'turn', board: ['Ks', '7c', '2d', '3h'] }],
  ...over,
});

test('the all-in expectation enumerates the cards to come', () => {
  // Aces against a set of kings on the turn: two aces of 44 unseen cards.
  const turn = allInExpectation(replayOf());
  assert.equal(turn.revealed, true);
  assert.ok(Math.abs(turn.expected - 2000 * (2 / 44)) < 1e-9, String(turn.expected));
  assert.equal(turn.won, 0);
  // A folded hand the host can see holds the other two aces: they cannot come.
  const dead = allInExpectation(replayOf({ folded: ['p2'], holes: { user: ['Ah', 'Ad'], p1: ['Kh', 'Kd'], p2: ['As', 'Ac'] } }));
  assert.equal(dead.expected, 0);
  // The same fold with the cards not shown (a participant's) leaves them in the deck.
  const unseen = allInExpectation(replayOf({ folded: ['p2'], holes: { user: ['Ah', 'Ad'], p1: ['Kh', 'Kd'] } }));
  assert.ok(Math.abs(unseen.expected - 2000 * (2 / 44)) < 1e-9);
  // Betting that ended on the river, a fold, or no showdown has nothing to adjust.
  assert.equal(allInExpectation(replayOf({ actions: [{ playerId: 'user', action: 'call', amount: 900, street: 'river', board: ['Ks', '7c', '2d', '3h', '9s'] }] })), null);
  assert.equal(allInExpectation(replayOf({ folded: ['user'] })), null);
  assert.equal(allInExpectation(replayOf({ showdown: null })), null);
});

test('a contender whose cards are not in the projection leaves the hand unadjusted', () => {
  const hidden = allInExpectation(replayOf({ holes: { user: ['Ah', 'Ad'] } }));
  assert.deepEqual(hidden, { revealed: false });
  const summary = summarizeGame(meta(), [{ replay: replayOf({ holes: { user: ['Ah', 'Ad'] } }), decisions: [] }], options);
  assert.equal(summary.results.unrevealed, 1);
  assert.equal(summary.results.allIns, 0);
  assert.equal(summary.results.luckBb, 0);
  assert.equal(summary.results.netBb, -10);
  assert.equal(summary.results.adjBb, -10);
});

test('a preflop all-in is sampled with a fixed seed; side pots count only the pots hero is in', () => {
  const preflop = replayOf({ actions: [{ playerId: 'user', action: 'call', amount: 900, street: 'preflop', board: [] }] });
  const a = allInExpectation(preflop, { seed: 7 });
  assert.deepEqual(a, allInExpectation(preflop, { seed: 7 }));
  // Aces over kings is about 82%.
  assert.ok(a.expected / 2000 > 0.78 && a.expected / 2000 < 0.86, String(a.expected / 2000));
  const side = replayOf({
    startStacks: { user: 500, p1: 1000, p2: 1000 }, endStacks: { user: 0, p1: 2500, p2: 0 },
    holes: { user: ['Ah', 'Ad'], p1: ['Kh', 'Kd'], p2: ['Qh', 'Qd'] },
    pots: [{ potIndex: 0, amount: 1500, eligible: ['user', 'p1', 'p2'], winners: [{ playerId: 'p1', share: 1500 }] },
      { potIndex: 1, amount: 1000, eligible: ['p1', 'p2'], winners: [{ playerId: 'p1', share: 1000 }] }],
  });
  const three = allInExpectation(side);
  // One card to come, 42 unseen: hero wins the main pot with either remaining ace.
  assert.ok(Math.abs(three.expected - 1500 * (2 / 42)) < 1e-9, String(three.expected));
});

function gameWith(over, mutate = () => {}) {
  const summary = emptyGameSummary(meta(over));
  summary.hands = over.heroHands ?? 40;
  summary.heroHands = over.heroHands ?? 40;
  summary.table['7-9'] = { hands: summary.heroHands, vpip: Math.round(summary.heroHands * 0.3), pfr: Math.round(summary.heroHands * 0.15) };
  mutate(summary);
  return summary;
}

test('the pattern window is the newest games up to the hand limit; results cover every game', () => {
  const games = Array.from({ length: 20 }, (_, at) => gameWith({ gameId: `game-${String(at).padStart(2, '0')}`,
    savedAt: `2026-10-${String(at + 1).padStart(2, '0')}T00:00:00.000Z`, heroHands: 100 }, (summary) => {
    summary.results = { hands: 100, netBb: -5, adjBb: -3, adjSqBb: 900, allIns: 1, luckBb: -2, unrevealed: 0 };
  }));
  const report = buildPlayReport(games, { now: '2026-11-16T00:00:00.000Z' });
  assert.equal(report.scope.games, Math.ceil(WINDOW_HERO_HANDS / 100));
  assert.equal(report.scope.totalGames, 20);
  assert.equal(report.scope.to, '2026-10-20T00:00:00.000Z');
  assert.equal(report.sessions[0].gameId, 'game-19');
  assert.equal(report.tendency.tables.find((row) => row.table === '7-9').hands, 600);
  assert.equal(report.results.segments.length, 1);
  assert.equal(report.results.segments[0].hands, 2000);
  assert.equal(report.results.segments[0].per100, null, 'no per-100 figure for a tournament');
  assert.deepEqual(Object.keys(report.results.segments[0]).sort(), ['allIns', 'games', 'hands', 'luckBb', 'mode', 'opponent', 'per100', 'unrevealed', 'yardstick'],
    'net results leave only as the per-100 figure of a comparable population');
  // A single game is always in the window, whatever its size.
  assert.equal(buildPlayReport([games[0]]).scope.games, 1);
  assert.equal(buildPlayReport([]).scope.heroHands, 0);
  assert.equal(buildPlayReport([games[0]], { truncated: true, unreadable: { games: 2, hands: 3 } }).scope.truncated, true);
});

const cashMeta = { mode: 'cash-training', opponent: 'policy', solo: true, policy: 'strategy-v3@3.0.0', seats: 6, stackBb: 100 };

test('only comparable fixed-policy cash play gets a per-100 figure, and only with enough hands', () => {
  const cash = (over = {}, hands = 400) => gameWith({ ...cashMeta, heroHands: hands, ...over }, (summary) => {
    summary.results = { hands, netBb: hands / 2, adjBb: hands / 5, adjSqBb: hands * 25.04, allIns: 2, luckBb: hands * 0.3, unrevealed: 1 };
  });
  assert.equal(yardstickKey(cash()), '6:100:strategy-v3@3.0.0');
  const row = buildPlayReport([cash()]).results.segments[0];
  assert.deepEqual(row.yardstick, { seats: 6, stackBb: 100, policy: 'strategy-v3@3.0.0' });
  assert.equal(row.per100.net, 50);
  assert.equal(row.per100.adjusted, 20);
  // mean 0.2, variance 25.04 - 0.04 = 25, sd 5, se 0.25 per hand over 400 hands.
  assert.ok(Math.abs(row.per100.high - (20 + 1.96 * 25)) < 1e-6, String(row.per100.high));
  assert.ok(Math.abs(row.per100.low - (20 - 1.96 * 25)) < 1e-6);
  assert.deepEqual(Object.keys(row).sort(), ['allIns', 'games', 'hands', 'luckBb', 'mode', 'opponent', 'per100', 'unrevealed', 'yardstick']);
  // Too few hands: the segment is still a yardstick but states no figure.
  const few = buildPlayReport([cash({}, YARDSTICK_MIN_HANDS - 1)]).results.segments[0];
  assert.ok(few.yardstick);
  assert.equal(few.per100, null);
  assert.deepEqual(Object.keys(few).sort(), ['allIns', 'games', 'hands', 'luckBb', 'mode', 'opponent', 'per100', 'unrevealed', 'yardstick']);
  // Another human, an unknown policy, a favourable deal or a different table is not the same population.
  for (const over of [{ solo: false }, { policy: null }, { opponent: 'llm' }, { mode: 'tournament' }]) {
    assert.equal(yardstickKey(cash(over)), null, JSON.stringify(over));
    assert.equal(buildPlayReport([cash(over)]).results.segments[0].per100, null);
  }
  const biased = cash();
  biased.biasedHands = 1;
  assert.equal(yardstickKey(biased), null);
  const segments = buildPlayReport([cash(), cash({ gameId: 'nine', seats: 9 })]).results.segments;
  assert.equal(segments.length, 2, 'six- and nine-handed play are separate populations');
});

test('focus items need a count and a share, and compare the newest game with the rest', () => {
  assert.deepEqual(buildPlayReport([gameWith({ heroHands: 100 })]).focus, [], 'a cash VPIP band is not a tournament focus');
  const short = gameWith({ heroHands: 40 }, (summary) => { summary.checks.shortEntries = 6; summary.checks.shortNonAllIn = [3, 9]; });
  assert.deepEqual(buildPlayReport([short]).focus.map((item) => item.id), ['short-non-all-in']);
  const few = gameWith({ heroHands: 40 }, (summary) => { summary.checks.shortEntries = 6; summary.checks.shortNonAllIn = [3]; });
  assert.deepEqual(buildPlayReport([few]).focus, []);
  // Three calls below the price out of twenty closed calls is a small share.
  const diluted = gameWith({ heroHands: 40 }, (summary) => { summary.checks.closed = 30; summary.checks.closedCalls = 20; summary.checks.callBelowPrice = [1, 2, 3]; });
  assert.deepEqual(buildPlayReport([diluted]).focus, []);
  const calls = gameWith({ heroHands: 40 }, (summary) => {
    summary.checks.closed = 9; summary.checks.closedCalls = 6; summary.checks.callBelowPrice = [1, 2, 3];
    const open = summary.reference.groups['vs-open'];
    open.n = 40; open.expected = { raise: 4, call: 6, fold: 30 }; open.actual = { raise: 2, call: 14, fold: 24 };
  });
  const older = gameWith({ gameId: 'older', savedAt: '2026-10-01T00:00:00.000Z', heroHands: 40 }, (summary) => {
    summary.checks.closed = 5; summary.checks.closedCalls = 4; summary.checks.callBelowPrice = [8];
  });
  const report = buildPlayReport([older, calls]);
  assert.deepEqual(report.focus.map((item) => item.id), ['call-below-price', 'reference-call-heavy']);
  assert.deepEqual(report.focus[0], { id: 'call-below-price', value: 4, sample: 10, latest: { value: 3, sample: 6 }, earlier: { value: 1, sample: 4 } });
  assert.equal(report.focus[1].reference, 6 / 40);
  assert.equal(report.focus[1].earlier, null, 'the older game had no such decision');
  // At most three, in the fixed order.
  const many = gameWith({ heroHands: 100 }, (summary) => {
    summary.checks.shortEntries = 5; summary.checks.shortNonAllIn = [1, 2];
    summary.checks.closed = 4; summary.checks.closedCalls = 4; summary.checks.callBelowPrice = [1, 2, 3];
    summary.checks.unopenedDeep = 30; summary.checks.openLimp = [4, 5, 6];
    summary.checks.foldWhenCheck = [7, 8];
  });
  assert.deepEqual(buildPlayReport([many]).focus.map((item) => item.id), ['short-non-all-in', 'call-below-price', 'open-limp']);
});

test('every display line is within the coaching wording contract', () => {
  const game = gameWith({ ...cashMeta, heroHands: 400 }, (summary) => {
    summary.checks = { ...summary.checks, decisions: 150, shortEntries: 6, shortNonAllIn: [3, 9], unopenedDeep: 40, openLimp: [4, 5, 6],
      foldWhenCheck: [7, 8], raises: 10, minRaises: 6, weakStackOff: [11], closed: 9, closedCalls: 6, compared: 7, callBelowPrice: [1, 2, 3], foldAbovePrice: [12] };
    summary.preflop = { unopened: { n: 50, raise: 20, limp: 5, fold: 25 }, vsRaise: { n: 40, fold: 24, call: 14, raise: 2 }, shoveCalls: 3 };
    summary.postflop.cbet = { k: 4, n: 9 };
    summary.postflop.facing.flop = { n: 10, fold: 4, call: 5, raise: 1 };
    summary.postflop.bets = 8; summary.postflop.raises = 2; summary.postflop.calls = 6;
    summary.postflop.wtsd = { k: 6, n: 20 }; summary.postflop.wsd = { k: 3, n: 6 };
    const open = summary.reference.groups['vs-open'];
    open.n = 40; open.exact = 10; open.projected = 30; open.expected = { raise: 4, call: 6, fold: 30 }; open.actual = { raise: 2, call: 14, fold: 24 };
    const rfi = summary.reference.groups.rfi;
    rfi.n = 40; rfi.exact = 40; rfi.expected = { raise: 12, call: 0, fold: 28 }; rfi.actual = { raise: 18, call: 4, fold: 18 }; rfi.offRange = 8; rfi.missed = 1; rfi.classes = { '64o': 2, K2o: 1 };
    summary.reference.unsupported = { LIMP_OR_CALLER: 12, MID_STACK_UNSUPPORTED: 5, SOMETHING_NEW: 1 };
    summary.results = { hands: 400, netBb: 200, adjBb: 80, adjSqBb: 400 * 25.04, allIns: 2, luckBb: 120, unrevealed: 1 };
  });
  const tournament = gameWith({ gameId: 'older', savedAt: '2026-10-01T00:00:00.000Z', heroHands: 30 }, (summary) => {
    summary.results = { hands: 30, netBb: -100, adjBb: -90, adjSqBb: 400, allIns: 1, luckBb: -10, unrevealed: 0 };
  });
  const report = buildPlayReport([game, tournament]);
  const view = playReportView(report);
  assert.deepEqual(view.sections.map((section) => section.id), ['tendency', 'reference', 'checks', 'results', 'sessions']);
  assert.equal(view.focus.length, 3);
  const lines = [...view.focus.flatMap((item) => [item.title, item.detail]),
    ...view.sections.flatMap((section) => [section.title, section.note, ...section.rows.flatMap((row) => [row.label, row.value])]),
    ...gameCheckLinesKo(game), ...focusLinesKo(report)];
  assert.ok(lines.length > 30);
  for (const line of lines) {
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 0 && !/undefined|NaN|null/.test(line), line);
    assert.equal(referenceClaimAllowed(line), true, line);
    assert.equal(coachingClaimAllowed(line), true, line);
  }
  // A whole rendered block survives the coaching sanitizer unchanged.
  const block = lines.join('\n');
  const cleaned = sanitizeCoachingText(block);
  assert.equal(cleaned.removed, 0);
  assert.equal(cleaned.text, block);
  assert.match(view.sections[1].rows.find((row) => row.label.startsWith('미오픈 오픈')).value, /기준표가 접는 패로 참여 8번\(64o K2o\)/);
  assert.match(view.sections[3].rows[0].value, /100핸드당 \+50\.0BB, 런아웃 운을 뺀 값 \+20\.0BB/);
  assert.doesNotMatch(view.sections[3].rows[1].value, /100핸드당/);
  assert.match(view.focus[0].detail, /게임 간 비교는 표본이 없어 생략합니다/);
  assert.equal(gameCheckLinesKo(game).length, 4);
  assert.equal(focusLinesKo(report).length, 3);
  assert.deepEqual(gameCheckLinesKo(gameWith({})), []);
  assert.deepEqual(playReportView(buildPlayReport([])), { focus: [], sections: [] });
});

test('the reference bands are the review bands', () => {
  assert.deepEqual(vpipBand(2), { vpip: [55, 85], pfr: [45, 80] });
  assert.deepEqual(vpipBand(6), { vpip: [20, 30], pfr: [15, 24] });
  assert.deepEqual(vpipBand(9), { vpip: [15, 24], pfr: [11, 19] });
  const report = buildPlayReport([gameWith({}, (summary) => { summary.table['3-4'] = { hands: 5, vpip: 3, pfr: 2 }; })]);
  assert.equal(report.tendency.tables.find((row) => row.table === '3-4').band, null);
});

test('a malformed hand is skipped and forced, foreign or favourable-deal input is not counted', () => {
  const record = play(setup3(5000, 5000, 5000), checkOrCall, checkOrCall);
  const hand = handOf(record);
  const forced = { ...hand, decisions: hand.decisions.map((decision) => ({ ...decision, forced: true })) };
  const summary = summarizeGame(meta(), [null, { replay: {} }, forced], options);
  assert.equal(summary.hands, 1);
  assert.equal(summary.checks.decisions, 0);
  assert.equal(summary.reference.snapshots, 0);
  const foreign = { ...hand, decisions: hand.decisions.map((decision) => ({ ...decision, actorId: 'p1' })) };
  assert.equal(summarizeGame(meta(), [foreign], options).checks.decisions, 0);
  // Without a dataset or a facts function the frequencies and rule checks still work.
  const bare = summarizeGame(meta(), [hand]);
  assert.equal(bare.reference.snapshots, 0);
  assert.deepEqual(bare.checks.openLimp, [1]);
  // A hand dealt with the favourable-deal option is left out of every figure.
  const biased = { ...hand, replay: { ...hand.replay, dealSelectionContractVersion: 1, dealSelection: { schemaVersion: 1, algorithmVersion: 'weighted-holes-v1', mode: 'strong' } } };
  const skipped = summarizeGame(meta(), [biased, hand], options);
  assert.equal(skipped.biasedHands, 1);
  assert.equal(skipped.heroHands, 1);
  assert.equal(skipped.results.hands, 1);
  const off = { ...hand, replay: { ...hand.replay, dealSelectionContractVersion: 1, dealSelection: { schemaVersion: 1, algorithmVersion: 'weighted-holes-v1', mode: 'off' } } };
  assert.equal(summarizeGame(meta(), [off], options).biasedHands, 0);
});
