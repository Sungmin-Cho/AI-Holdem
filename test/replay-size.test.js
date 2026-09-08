import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayRecord } from '../shared/hand-replay.js';

test('9인 open·all 최악 투영은 40,000바이트 이하', () => {
  const pids = ['user', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  const reason = '한'.repeat(160);
  const note = '노'.repeat(160);
  const stacks = Object.fromEntries(pids.map((pid) => [pid, 5000]));
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9'];
  const holes = Object.fromEntries(pids.map((pid, i) => [
    pid,
    [`A${'shdc'[i % 4]}`, `${ranks[i]}${'shdc'[(i + 1) % 4]}`],
  ]));
  holes.user = ['Ah', 'Kh'];
  const actions = [];
  for (const street of ['preflop', 'flop', 'turn', 'river']) {
    const board = ['Ts', 'Js', 'Qs', '9s', '2d'].slice(0, street === 'preflop' ? 0 : street === 'flop' ? 3 : street === 'turn' ? 4 : 5);
    for (let round = 0; round < 1; round += 1) {
      for (const pid of pids) {
        actions.push({
          decisionId: `d-1-${street}-${actions.length}`,
          playerId: pid,
          action: 'raise',
          amount: 100 + round * 50,
          street,
          potTotal: 2000,
          callAmount: 50,
          minRaiseTo: 100,
          maxRaiseTo: 5000,
          currentBet: 100,
          board,
          stacks,
          forced: false,
          reason: pid === 'user' ? undefined : reason,
          note: pid === 'user' ? note : undefined,
        });
      }
    }
  }
  const record = {
    handNo: 1,
    level: 0,
    blinds: [25, 50],
    button: 'user',
    holes,
    board: ['Ts', 'Js', 'Qs', '9s', '2d'],
    folded: [],
    allIn: [],
    startStacks: stacks,
    endStacks: stacks,
    posts: pids.slice(1, 3).map((playerId) => ({ playerId, amount: 25, allIn: false })),
    uncalledReturns: {},
    positions: Object.fromEntries(pids.map((pid, i) => [pid, i === 0 ? 'BTN' : `S${i}`])),
    actions,
    decisions: [{
      decisionId: 'd-1-preflop-0',
      actorId: 'user',
      street: 'preflop',
      position: 'BTN',
      holeCards: ['Ah', 'Kh'],
      potBefore: 75,
      toCall: 50,
      effectiveStack: 5000,
      forced: false,
      chosenAction: { action: 'raise', amount: 100 },
    }],
    pots: [{ potIndex: 0, amount: 150, eligible: pids, winners: [{ playerId: 'user', share: 150 }] }],
    showdown: {
      reveals: pids.filter((pid) => pid !== 'user').map((playerId) => ({
        playerId, cards: holes[playerId], handName: '하이카드',
      })),
      mucks: [],
    },
  };
  const replay = replayRecord(record, { reveal: 'all' });
  const bytes = Buffer.byteLength(JSON.stringify(replay));
  assert.ok(bytes <= 40_000, `replay bytes ${bytes}`);
});
