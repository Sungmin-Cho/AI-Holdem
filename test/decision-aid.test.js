import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionAid, decisionAidText } from '../server/public/decision-aid.js';

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
  assert.match(short.items.find((item) => item.key === 'need').note, /이길 수 있는 팟/);
  assert.equal(decisionAid({ legal: null }, 'user'), null);
  assert.equal(decisionAidText(null), '');
});
