import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startHand, applyAction, legalFor } from '../engine/hand.js';
import { replayRecord } from '../shared/hand-replay.js';
import { buildReplaySteps, replaySeatOrder, streetStarts } from '../server/public/replay-model.js';
import { formatReplay } from '../server/public/replay-format.js';
import { handRecordFixture } from './helpers/security-fixtures.js';

// Only records the engine itself settled are expected to verify (design §10.1).
function play(game, pick, deck) {
  let state = startHand(game, deck ? { deck } : {}).state;
  let turn = 0;
  while (!legalFor(state).handOver) {
    const legal = legalFor(state);
    const [action, amount] = pick(legal, turn, state);
    turn += 1;
    state = applyAction(state, legal.toAct, action, amount).state;
  }
  return state.lastHand;
}
const passive = (legal) => (legal.canCheck ? ['check'] : ['call']);
const shove = (legal) => (legal.canRaise ? ['raise', legal.maxRaiseTo] : legal.canCheck ? ['check'] : ['call']);
const last = (result) => result.steps.at(-1);

function verified(record, options) {
  const replay = replayRecord(record, { reveal: 'all' });
  const result = buildReplaySteps(replay, options);
  assert.equal(result.ok, true, `${result.reason} at ${result.at}`);
  // The rebuilt end state is the engine's own end state.
  for (const playerId of Object.keys(record.startStacks)) assert.equal(last(result).stacks[playerId], record.endStacks[playerId]);
  return { replay, result };
}

test('side pots and an all-in runout rebuild to the engine settlement', () => {
  const game = createGame({ aiCount: 2, startStack: 1000, levelEvery: 10 });
  game.seats[1].stack = 300; game.seats[2].stack = 600;
  const record = play(game, shove);
  const { result } = verified(record);
  assert.ok(record.pots.length >= 2, 'the fixture has a side pot');
  const kinds = result.steps.map((step) => step.kind);
  assert.equal(kinds[0], 'deal');
  assert.deepEqual(result.steps.filter((step) => step.kind === 'runout').map((step) => step.board.length), [3, 4, 5]);
  assert.equal(last(result).kind, 'result');
  assert.equal(last(result).pots.length, record.pots.length);
  assert.equal(last(result).total, record.pots.reduce((total, pot) => total + pot.amount, 0));
  // Bets sit in front of the players until the street ends.
  const deal = result.steps[0];
  assert.equal(deal.pot, 0);
  assert.equal(Object.values(deal.bets).reduce((a, b) => a + b, 0), record.posts.reduce((a, post) => a + post.amount, 0));
});

test('an uncalled raise is returned before the pot is awarded', () => {
  const record = play(createGame({ aiCount: 2, startStack: 1000, levelEvery: 10 }), (legal, turn) => (turn === 0 ? ['raise', 400] : ['fold']));
  assert.ok(Object.values(record.uncalledReturns).some((amount) => amount > 0));
  const { result } = verified(record);
  assert.ok(last(result).returned.length > 0);
  assert.equal(result.steps.some((step) => step.kind === 'showdown'), false, 'an uncontested hand has no showdown step');
});

test('streets with actions get a deal step and bets reset per street; a first wager reads as a bet', () => {
  const record = play(createGame({ aiCount: 1, startStack: 1000, levelEvery: 10 }),
    (legal) => (legal.canCheck ? (legal.street === 'turn' && legal.canRaise ? ['raise', 100] : ['check']) : ['call']));
  const { result } = verified(record);
  assert.deepEqual(result.steps.filter((step) => step.kind === 'street').map((step) => [step.street, step.board.length]), [['flop', 3], ['turn', 4], ['river', 5]]);
  const turnBet = result.steps.find((step) => step.kind === 'action' && step.street === 'turn' && step.put > 0);
  assert.equal(turnBet.verb, 'bet');
  const river = result.steps.find((step) => step.kind === 'street' && step.street === 'river');
  assert.ok(Object.values(river.bets).every((bet) => bet === 0));
  assert.deepEqual(streetStarts(result.steps).map((row) => row.key), ['preflop', 'flop', 'turn', 'river', 'result']);
});

test('heads-up and a full nine-handed table follow the button order', () => {
  const headsUp = verified(play(createGame({ aiCount: 1, startStack: 1000, levelEvery: 10 }), passive));
  assert.equal(headsUp.result.seats.length, 2);
  assert.equal(headsUp.replay.positions[headsUp.result.seats[0]], 'BTN/SB');
  const full = verified(play(createGame({ aiCount: 8, startStack: 2000, levelEvery: 10 }), (legal, turn) => (turn % 3 === 0 ? ['fold'] : passive(legal))));
  assert.equal(full.result.seats.length, 9);
  assert.deepEqual(full.result.seats.map((playerId) => full.replay.positions[playerId]).slice(0, 4), ['BTN', 'SB', 'BB', 'UTG']);
  assert.equal(full.replay.positions[full.result.seats.at(-1)], 'CO');
});

test('a legacy record without positions uses the live seat order', () => {
  const record = play(createGame({ aiCount: 3, startStack: 1000, levelEvery: 10 }), passive);
  delete record.positions;
  const live = ['p2', 'user', 'p3', 'p1'];
  const replay = replayRecord(record, { reveal: 'all' });
  assert.deepEqual(replaySeatOrder(replay, live), live);
  const result = buildReplaySteps(replay, { seatOrder: replaySeatOrder(replay, live) });
  assert.equal(result.ok, true, result.reason);
});

test('an eliminated seat is not dealt in and does not appear in the replay', () => {
  const game = createGame({ aiCount: 3, startStack: 1000, levelEvery: 10 });
  game.seats[3].stack = 0; game.seats[3].out = true;
  const record = play(game, passive);
  const { result } = verified(record);
  assert.equal(result.seats.includes(game.seats[3].playerId), false);
  assert.equal(result.seats.length, 3);
});

test('records the engine did not settle fall back to the text list', () => {
  // replay-format's display record has posts: [] and pots that do not add up.
  const display = {
    handNo: 1, blinds: [50, 100], board: ['Ah', '7c', '2d'], folded: ['p2'], allIn: [],
    holes: { user: ['As', 'Td'] }, positions: { user: 'BB', p1: 'BTN', p2: 'SB' },
    pots: [{ potIndex: 0, amount: 200, eligible: ['user', 'p1'], winners: [{ playerId: 'user', share: 200 }] }],
    startStacks: { user: 10_000, p1: 10_000, p2: 10_000 }, endStacks: { user: 10_200, p1: 9_800, p2: 10_000 },
    posts: [], uncalledReturns: {},
    actions: [{ playerId: 'user', action: 'raise', amount: 250, street: 'preflop', potTotal: 150 }],
  };
  assert.equal(buildReplaySteps(display).ok, false);
  const fixture = replayRecord(handRecordFixture(1, { actions: [{ playerId: 'user', street: 'preflop', action: 'raise', amount: 125 }] }), { reveal: 'all' });
  assert.equal(buildReplaySteps(fixture).ok, false);
  assert.equal(buildReplaySteps({ handNo: 3, unavailable: true, reason: 'REPLAY_NOT_COMPLETED' }).ok, false);
});

test('a record whose numbers disagree with themselves is refused', () => {
  const record = play(createGame({ aiCount: 2, startStack: 1000, levelEvery: 10 }), passive);
  const replay = replayRecord(record, { reveal: 'all' });
  const tamper = (change) => { const copy = structuredClone(replay); change(copy); return buildReplaySteps(copy); };
  const call = replay.actions.findIndex((action) => action.action === 'call');
  assert.equal(tamper((copy) => { copy.actions[call].amount += 1; }).ok, false, 'call amount');
  assert.equal(tamper((copy) => { copy.actions[call].potTotal += 5; }).ok, false, 'pot total');
  assert.equal(tamper((copy) => { copy.endStacks[copy.actions[call].playerId] += 1; }).ok, false, 'end stacks');
  assert.equal(tamper((copy) => { copy.pots[0].winners[0].share -= 1; }).ok, false, 'pot shares');
  assert.equal(tamper((copy) => { copy.posts = []; }).ok, false, 'missing posts');
});

test('public scope: hidden seats show neither cards nor reasons, and the forced flag decides nothing', () => {
  const game = createGame({ aiCount: 2, startStack: 1000, levelEvery: 10 });
  let folder = null;
  const record = play(game, (legal) => {
    if (folder === null && legal.toAct !== 'user') { folder = legal.toAct; return ['fold']; }
    return passive(legal);
  });
  const folded = record.actions.find((action) => action.playerId === folder && action.action === 'fold');
  folded.forced = true;
  folded.reason = 'secret reasoning';
  const replay = replayRecord(record, { reveal: 'showdown' });
  const revealed = new Set(['user', ...(record.showdown?.reveals ?? []).map((row) => row.playerId)]);
  for (const playerId of Object.keys(record.holes)) assert.equal(Boolean(replay.holes[playerId]), revealed.has(playerId));
  const rows = formatReplay(replay).streets.flatMap((street) => street.rows);
  const row = rows.find((candidate) => candidate.playerId === folder);
  assert.equal(row.reasonKind, 'hidden');
  assert.equal(row.cards, null);
  assert.doesNotMatch(row.reasonText, /워치독|secret/);
  assert.equal(buildReplaySteps(replay).ok, true, 'hiding cards does not change the arithmetic');
});

test('checks and folds carry no amount in the replay rows', () => {
  const record = play(createGame({ aiCount: 1, startStack: 1000, levelEvery: 10 }), passive);
  const rows = formatReplay(replayRecord(record, { reveal: 'all' })).streets.flatMap((street) => street.rows);
  assert.ok(rows.some((row) => row.verb === 'check'));
  for (const row of rows) assert.equal(row.amount === null, row.verb === 'check' || row.verb === 'fold', JSON.stringify(row));
});
