import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { mulberry32 } from './helpers/fixtures.js';

function randomLegal(la, rng) {
  const options = [
    { weight: 0.2, pick: () => ['fold'] },
    { weight: 0.5, pick: () => [la.canCheck ? 'check' : 'call'] },
  ];
  if (la.canRaise) {
    options.push({
      weight: 0.3,
      pick: () => {
        const amount = la.minRaiseTo > la.maxRaiseTo
          ? la.maxRaiseTo
          : la.minRaiseTo + Math.floor(rng() * (la.maxRaiseTo - la.minRaiseTo + 1));
        return ['raise', amount];
      },
    });
  }
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = rng() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return option.pick();
  }
  return options.at(-1).pick();
}

function simulate(seed, aiCount) {
  const rng = mulberry32(seed * 1000 + aiCount);
  let st = createGame({ aiCount, levelEvery: 4 });
  const totalChips = (aiCount + 1) * 5000;
  let hands = 0;
  while (!st.gameOver && hands < 500) {
    st = startHand(st, { rng }).state;
    hands += 1;
    let acts = 0;
    while (!legalFor(st).handOver) {
      acts += 1;
      assert.ok(acts <= 10_000, `hand ${hands} did not close`);
      const la = legalFor(st);
      st = applyAction(st, la.toAct, ...randomLegal(la, rng)).state;
    }
    assert.equal(st.seats.reduce((a, s) => a + s.stack, 0), totalChips, '칩 보존');
    for (const s of st.seats) assert.ok(s.stack >= 0, '음수 스택 금지');
  }
  return { st, hands, totalChips };
}

test('시뮬레이션 불변식', () => {
  for (const seed of [1, 2, 3]) {
    for (const cfg of [{ ai: 3 }, { ai: 8 }, { ai: 1 }]) {
      const { st, hands } = simulate(seed, cfg.ai);
      assert.ok(st.gameOver, `${hands}핸드 내 종료(블라인드 상승 강제)`);
      assert.ok(['win', 'lose'].includes(st.result));
    }
  }
});

test('시뮬레이션 후 stats 정합', () => {
  for (const seed of [1, 2, 3]) {
    for (const cfg of [{ ai: 3 }, { ai: 8 }, { ai: 1 }]) {
      const { st } = simulate(seed, cfg.ai);
      let netSum = 0;
      for (const s of Object.values(st.stats)) {
        assert.ok(s.hands === 0 || s.vpip / s.hands <= 1, 'vpip ≤ 1');
        assert.ok(s.showdownWins <= s.showdowns, 'showdownWins ≤ showdowns');
        netSum += s.net;
      }
      assert.equal(netSum, 0, 'net 총합 0');
    }
  }
});
