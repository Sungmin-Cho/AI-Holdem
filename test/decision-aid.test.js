import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionAid, decisionAidText } from '../server/public/decision-aid.js';
import { createGame, startHand, applyAction, legalFor } from '../engine/hand.js';
import { snapshotDecision } from '../engine/decision.js';
import { viewFor } from '../engine/views.js';
import { chipFacts } from '../shared/decision-facts.js';

const seat = (playerId, stack, bet = 0, extra = {}) => ({ playerId, stack, bet, folded: false, out: false, allIn: false, ...extra });

test('the decision aid prices a call from the public view only', () => {
  const view = {
    street: 'flop', blinds: [50, 100], viewer: 'user',
    board: ['Ah', '7h', '2c'], myCards: ['Kh', 'Qh'],
    seats: [seat('user', 9_400), seat('p1', 9_100, 300)],
    pots: [{ potIndex: 0, amount: 600 }],
    legal: { callAmount: 300, potTotal: 900, canCheck: false },
  };
  const aid = decisionAid(view, 'user');
  const byKey = Object.fromEntries(aid.items.map((item) => [item.key, item.value]));
  assert.equal(byKey.pot, '9BB');
  assert.equal(byKey.call, '3BB');
  assert.equal(byKey.odds, '3:1');
  assert.equal(byKey.need, '25%');
  assert.equal(byKey.eff, '94BB');
  assert.equal(byKey.spr, '10.4');
  assert.equal(byKey.made, '하이 카드');
  assert.match(byKey.draw, /플러시 드로 · 완성 카드 9장/);
  assert.equal(aid.sidePots, false);
  assert.match(decisionAidText(aid), /^필요 승률 25% · 콜 3BB · 팟 오즈 3:1 · 팟 9BB · SPR 10.4/);
  // No advice words: arithmetic and hand facts only.
  assert.doesNotMatch(decisionAidText(aid), /추천|콜하세요|폴드하세요|정답|GTO/);
});

test('a free check shows no price; a partial all-in call is flagged', () => {
  const check = decisionAid({
    street: 'turn', blinds: [50, 100], viewer: 'user', board: ['2c', '3d', '9s', 'Jh'], myCards: ['As', 'Ad'],
    seats: [seat('user', 5_000), seat('p1', 5_000)], legal: { callAmount: 0, potTotal: 1_000, canCheck: true },
  }, 'user');
  assert.equal(check.items.some((item) => item.key === 'need'), false);
  const short = decisionAid({
    street: 'river', blinds: [50, 100], viewer: 'user', board: [], myCards: [],
    seats: [seat('user', 200, 0), seat('p1', 0, 1_000, { allIn: true })], legal: { callAmount: 200, potTotal: 1_500, canCheck: false },
  }, 'user');
  assert.equal(short.partial, true);
  // 1,500 in the middle, 800 of the 1,000 bet cannot be won by a 200 call: 200 / (700 + 200).
  assert.equal(short.items.find((item) => item.key === 'need').value, '22.2%(이길 수 있는 팟 기준)');
  assert.equal(decisionAid({ legal: null }, 'user'), null);
  assert.equal(decisionAidText(null), '');
});

test('the aid states the same required equity as the engine fact card, or none when the pots split', () => {
  const play = (stacks, script) => {
    const game = createGame({ aiCount: 2, levelEvery: 50 });
    game.button = 0; // p1 is the button and acts first, p2 the small blind, the user the big blind
    game.seats.forEach((seat, i) => { seat.stack = stacks[i]; });
    let state = startHand(game).state;
    const queue = [...script];
    while (legalFor(state).toAct !== 'user') {
      const legal = legalFor(state);
      const [action, amount] = queue.shift() ?? [legal.canCheck ? 'check' : 'call'];
      state = applyAction(state, legal.toAct, action, amount === 'max' ? legal.maxRaiseTo : amount).state;
    }
    const legal = legalFor(state);
    const facts = chipFacts(snapshotDecision(state, 'user', null, { legal, blinds: state.config.blinds0 }));
    const aid = decisionAid(viewFor(state, 'user'), 'user');
    return { facts, need: aid.items.find((item) => item.key === 'need')?.value ?? null };
  };
  // The user covers 200 against a 1,000 shove: a partial call into the winnable pot.
  const partial = play([200, 1000, 1000], [['raise', 'max'], ['fold']]);
  assert.equal(partial.facts.partialCall, true);
  assert.equal(partial.facts.multiPot, false);
  assert.equal(Number.parseFloat(partial.need), partial.facts.requiredEquity);
  assert.match(partial.need, /이길 수 있는 팟 기준/);
  // A short all-in and a bigger bet: the engine states no single price; neither does the aid.
  const split = play([1000, 300, 1000], [['raise', 'max'], ['raise', 'max']]);
  assert.equal(split.facts.multiPot, true);
  assert.match(split.need, /팟이 나뉨/);
  // An ordinary price: the same number as the engine.
  const plain = play([1000, 1000, 1000], [['raise', 150], ['fold']]);
  assert.equal(Number.parseFloat(plain.need), plain.facts.requiredEquity);
});
