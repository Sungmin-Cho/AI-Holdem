import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiniDocument } from './helpers/mini-dom.js';
import { renderHandResultCard } from '../server/public/hand-result-view.js';

const names = { user: '나', p2: '민준', p4: '지수', p5: '하린' };
const render = (result, options = {}) => {
  const doc = createMiniDocument();
  const box = doc.createElement('div');
  renderHandResultCard(box, result, { doc, playerName: id => names[id] ?? id, ...options });
  return box;
};
const texts = (box, selector) => [...box.querySelectorAll(selector)].map(node => node.textContent);
const sidePots = {
  handNo: 61, kind: 'showdown', blinds: [25, 50], runout: ['flop', 'turn', 'river'], myNet: 100,
  board: { flop: ['Ah', '9d', '7c'], turn: ['4s'], river: ['2h'] },
  winners: [
    { playerId: 'p2', total: 975, handName: '트리플', cards: ['9h', '9c', '9d', 'Ah', '7c'] },
    { playerId: 'user', total: 400, handName: '원페어', cards: ['As', 'Ah', 'Kd', '9d', '7c'] },
    { playerId: 'p5', total: 400, handName: '원페어', cards: ['Ac', 'Ad', 'Kh', '9d', '7c'] },
  ],
  pots: [
    { potIndex: 0, amount: 975, winners: [{ playerId: 'p2', share: 975 }], note: null, versus: null },
    { potIndex: 1, amount: 800, winners: [{ playerId: 'user', share: 400 }, { playerId: 'p5', share: 400 }], note: '같은 족보로 분할', versus: null },
  ],
};

test('every winner and pot is listed with collected amounts, hand, five cards and the board by street', () => {
  const box = render(sidePots);
  assert.deepEqual(texts(box, '.hand-result-title'), ['핸드 61 결과']);
  assert.deepEqual(texts(box, '.hand-result-reason'), ['쇼다운']);
  assert.deepEqual(texts(box, '.hand-result-won'), ['팟 19.5 BB 획득', '팟 8 BB 획득', '팟 8 BB 획득']);
  assert.deepEqual(texts(box, '.hand-result-hand'), ['트리플', '원페어', '원페어']);
  assert.deepEqual([...box.querySelectorAll('.hand-result-cards')].map(row => row.querySelectorAll('.mini-card').length), [5, 5, 5]);
  assert.deepEqual(texts(box, '.hand-result-pot'), ['메인 팟 19.5 BB · 민준 19.5 BB', '사이드 팟 1 16 BB · 나 8 BB, 하린 8 BB · 같은 족보로 분할']);
  assert.deepEqual(texts(box, '.hand-result-street-label'), ['플랍', '턴', '리버']);
  assert.deepEqual(texts(box, '.hand-result-runout'), ['올인 런아웃 · 플랍·턴·리버']);
  assert.deepEqual(texts(box, '.hand-result-net'), ['내 순손익 +2 BB']);
  assert.equal(box.querySelectorAll('.hand-result-note').length, 0, 'multi-pot reasons sit on their pot lines');
});

test('a single pot shows its deciding rank; a fold win shows only the dealt board; amounts use the hand’s own blinds', () => {
  const kicker = render({ ...sidePots, myNet: null, runout: [], winners: [sidePots.winners[1]],
    pots: [{ potIndex: 0, amount: 600, winners: [{ playerId: 'user', share: 600 }], note: '키커 K > Q', versus: 'p4' }] });
  assert.deepEqual(texts(kicker, '.hand-result-note'), ['판별 · 키커 K > Q (지수 대비)']);
  assert.equal(kicker.querySelectorAll('.hand-result-net').length, 0);
  assert.equal(kicker.querySelectorAll('.hand-result-pots').length, 0);
  const folded = render({ handNo: 7, kind: 'uncontested', blinds: [100, 200], runout: [], myNet: -200,
    board: { flop: ['Ks', '7d', '2c'], turn: [], river: [] },
    winners: [{ playerId: 'p4', total: 700, handName: null, cards: null }],
    pots: [{ potIndex: 0, amount: 700, winners: [{ playerId: 'p4', share: 700 }], note: null, versus: null }] });
  assert.deepEqual(texts(folded, '.hand-result-reason'), ['상대 전원 폴드']);
  assert.deepEqual(texts(folded, '.hand-result-won'), ['팟 3.5 BB 획득'], 'the hand’s 200 big blind, not a later level');
  assert.deepEqual(texts(folded, '.hand-result-street-label'), ['플랍']);
  assert.deepEqual(texts(folded, '.hand-result-board-none'), ['턴·리버 공개 안 됨']);
  assert.deepEqual(texts(folded, '.hand-result-net'), ['내 순손익 −1 BB']);
  assert.equal(folded.querySelectorAll('.hand-result-cards').length, 0);
  const preflop = render({ handNo: 8, kind: 'uncontested', blinds: null, runout: [], myNet: null,
    board: { flop: [], turn: [], river: [] }, winners: [{ playerId: 'p2', total: 150, handName: null, cards: null }],
    pots: [{ potIndex: 0, amount: 150, winners: [{ playerId: 'p2', share: 150 }], note: null, versus: null }] });
  assert.deepEqual(texts(preflop, '.hand-result-board-none'), ['프리플랍에서 종료 · 보드 없음']);
  assert.deepEqual(texts(preflop, '.hand-result-won'), ['팟 150 칩 획득'], 'no recorded blinds: chips, never the current BB');
  assert.deepEqual(texts(render(sidePots, { unit: 'chips' }), '.hand-result-won')[0], '팟 975 칩 획득');
});
