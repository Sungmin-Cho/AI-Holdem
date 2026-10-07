import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate7, compareScore } from '../engine/evaluator.js';
import {
  HAND_CLASSES, cardInt, cardStr, categoryOfScore, classOfCards, comboCount, combosOfClass,
  describeMadeHand, drawsOf, equityVs, scoreCards, seedFrom, toCardInts, xorshift32,
} from '../shared/poker-eval.js';

const score = cards => scoreCards(toCardInts(cards));

test('scoreCards orders random 7-card hands exactly like the engine evaluator', () => {
  const next = xorshift32(seedFrom('poker-eval-cross-check'));
  for (let n = 0; n < 50_000; n += 1) {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = 0; i < 9; i += 1) {
      const j = i + (next() % (52 - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const board = deck.slice(4, 9);
    const left = [deck[0], deck[1], ...board];
    const right = [deck[2], deck[3], ...board];
    const ours = Math.sign(scoreCards(left) - scoreCards(right));
    const engine = Math.sign(compareScore(evaluate7(left.map(cardStr)).score, evaluate7(right.map(cardStr)).score));
    assert.equal(ours, engine, `${left.map(cardStr)} vs ${right.map(cardStr)}`);
  }
});

test('category edge cases', () => {
  assert.equal(categoryOfScore(score(['As', '2d', '3h', '4c', '5s', 'Kd', 'Qh'])), 4);
  assert.ok(score(['6s', '2d', '3h', '4c', '5s', 'Kd', 'Qh']) > score(['As', '2d', '3h', '4c', '5s', 'Kd', 'Qh']));
  assert.equal(categoryOfScore(score(['As', '2s', '3s', '4s', '5s', 'Kd', 'Qh'])), 8);
  assert.equal(categoryOfScore(score(['Qs', 'Ks', 'As', '2s', '3s', '9h', '8c'])), 5);
  assert.equal(categoryOfScore(score(['Qd', 'Ks', 'As', '2s', '3d', '9h', '8c'])), 0);
  assert.ok(score(['Qs', 'Ks', 'As', '2s', '3s', '9h', '8c']) > score(['9s', 'Ts', 'Js', 'Qd', 'Kh', '2c', '3c']));
  assert.equal(categoryOfScore(score(['9s', '9d', '9h', '4c', '4s', '4d', 'Qh'])), 6);
  assert.ok(score(['9s', '9d', '9h', '4c', '4s', '4d', 'Qh']) > score(['8s', '8d', '8h', 'Ac', 'As', '4d', 'Qh']));
  // Three pairs: best two pairs play, the third pair's rank can be the kicker.
  assert.equal(score(['As', 'Ad', 'Ks', 'Kd', 'Qs', 'Qd', '2c']), score(['Ah', 'Ac', 'Kh', 'Kc', 'Qh', '3d', '2s']));
  assert.ok(score(['7s', '7d', '7h', '7c', 'As', '2d', '3h']) > score(['7s', '7d', '7h', '7c', 'Ks', '2d', '3h']));
});

test('hand classes and combos cover the deck exactly once', () => {
  assert.equal(HAND_CLASSES.length, 169);
  const seen = new Set();
  let total = 0;
  for (const cls of HAND_CLASSES) {
    const combos = combosOfClass(cls);
    assert.equal(combos.length, comboCount(cls));
    for (const [a, b] of combos) {
      const key = [a, b].sort((x, y) => x - y).join('-');
      assert.ok(!seen.has(key));
      seen.add(key);
      assert.equal(classOfCards([cardStr(a), cardStr(b)]), cls);
    }
    total += combos.length;
  }
  assert.equal(total, 1326);
  assert.equal(cardInt('Ts'), 8 * 4);
  assert.equal(cardInt('xx'), -1);
  assert.throws(() => toCardInts(['As', 'As']), /duplicate/);
});

test('describeMadeHand names what the hole cards contribute', () => {
  assert.equal(describeMadeHand(['Ah', 'Kd'], ['Kc', '7s', '2d']).detail, '탑페어');
  assert.equal(describeMadeHand(['Ah', '7d'], ['Kc', '7s', '2d']).detail, '세컨드페어');
  assert.equal(describeMadeHand(['Qh', 'Qd'], ['Jc', '7s', '2d']).detail, '오버페어');
  assert.equal(describeMadeHand(['4h', '4d'], ['Jc', '7s', '6d']).detail, '언더페어');
  assert.equal(describeMadeHand(['Ah', 'Kd'], ['7c', '7s', '2d']).detail, '보드 페어');
  assert.equal(describeMadeHand(['7h', '7d'], ['7c', 'Ks', '2d']).detail, '셋');
  assert.equal(describeMadeHand(['Ah', '7d'], ['7c', '7s', '2d']).detail, '트립스');
  const board = describeMadeHand(['2h', '3d'], ['As', 'Ks', 'Qs', 'Js', 'Ts']);
  assert.equal(board.playsBoard, true);
  assert.match(board.label, /보드 플레이/);
});

test('drawsOf counts flush and straight outs on the flop and turn only', () => {
  const flush = drawsOf(['Ah', '5h'], ['Kh', '9h', '2c']);
  assert.equal(flush.flushDraw, true);
  assert.equal(flush.outs, 9);
  assert.equal(drawsOf(['9c', '8d'], ['7h', '6s', '2c']).straightDraw, 'open-ended');
  assert.equal(drawsOf(['9c', '8d'], ['7h', '6s', '2c']).outs, 8);
  assert.equal(drawsOf(['9c', '8d'], ['Jh', '7s', '2c']).straightDraw, 'gutshot');
  assert.equal(drawsOf(['9h', '8h'], ['7h', '6h', '2c']).outs, 15);
  assert.equal(drawsOf(['9h', '8h'], ['7h', '6h', '2c', 'Kd', '3s']).outs, 0);
  assert.equal(drawsOf(['9h', '8d'], ['Th', 'Js', 'Qc']).outs, 0);
});

test('equityVs is reproducible and matches known preflop values', () => {
  const aa = equityVs({ holeCards: ['As', 'Ad'], samples: 6000, seed: 7 });
  assert.equal(aa, equityVs({ holeCards: ['As', 'Ad'], samples: 6000, seed: 7 }));
  assert.ok(aa > 0.83 && aa < 0.87, String(aa));
  const twoWay = equityVs({ holeCards: ['As', 'Ad'], ranges: [null, null], samples: 6000, seed: 7 });
  assert.ok(twoWay > 0.70 && twoWay < 0.76, String(twoWay));
  const vsKings = equityVs({ holeCards: ['As', 'Ad'], ranges: [{ KK: 1 }], samples: 6000, seed: 9 });
  assert.ok(vsKings > 0.79 && vsKings < 0.85, String(vsKings));
  const madeFlush = equityVs({ holeCards: ['Ah', '5h'], boardCards: ['Kh', '9h', '2h'], samples: 2000, seed: 3 });
  assert.ok(madeFlush > 0.9, String(madeFlush));
});

test('equityVs removes cards per combo and never replaces an impossible deal', () => {
  // Holding Ah, only three AA combos remain against twelve 72o combos: the range
  // weighs them 3:12, so the equity is that mix of the two parts.
  const vs = (range) => equityVs({ holeCards: ['Ah', 'Kh'], ranges: [range], samples: 20000, seed: 7 });
  const mixed = vs({ AA: 1, '72o': 1 });
  const expected = (3 * vs({ AA: 1 }) + 12 * vs({ '72o': 1 })) / 15;
  assert.ok(Math.abs(mixed - expected) < 0.02, `${mixed} vs ${expected}`);
  // No AA combo survives As Ad Ah: the range is impossible, not "random".
  assert.throws(() => equityVs({ holeCards: ['As', 'Kc'], boardCards: ['Ad', 'Ah', '2c'], ranges: [{ AA: 1 }], samples: 10 }), RangeError);
  // Two villains on AA with As and Ad out: only one AA exists, so no deal is possible.
  assert.throws(() => equityVs({ holeCards: ['As', 'Kc'], boardCards: ['Ad', '7h', '2c'], ranges: [{ AA: 1 }, { AA: 1 }], samples: 10 }), RangeError);
});

test('drawsOf keeps a straight draw and flush outs apart in a combo draw', () => {
  // 9h8h on 7h 6h 2c: open-ended straight draw plus flush draw, 15 distinct cards.
  const combo = drawsOf(['9h', '8h'], ['7h', '6h', '2c']);
  assert.equal(combo.straightDraw, 'open-ended');
  assert.equal(combo.flushDraw, true);
  // A gutshot with a flush draw stays a gutshot (the flush outs do not inflate it).
  const gut = drawsOf(['9h', '5h'], ['7h', '6c', 'Kh']);
  assert.equal(gut.straightDraw, 'gutshot');
  assert.equal(gut.flushDraw, true);
  assert.equal(gut.outs, 9 + 3);
});

test('multiway range equity does not depend on the opponents\' order (joint sampling)', () => {
  // Hero As Kh on Ad Qc Jh 2s 3d against {AA, KK, TT} and {QQ, TT}: exactly 40%
  // over the 60 compatible combo pairs (enumerated below).
  const hero = ['As', 'Kh'];
  const board = ['Ad', 'Qc', 'Jh', '2s', '3d'];
  const first = { AA: 1, KK: 1, TT: 1 };
  const second = { QQ: 1, TT: 1 };
  const forward = equityVs({ holeCards: hero, boardCards: board, ranges: [first, second], samples: 60000, seed: 11 });
  const reverse = equityVs({ holeCards: hero, boardCards: board, ranges: [second, first], samples: 60000, seed: 11 });
  assert.ok(Math.abs(forward - 0.4) < 0.012, `forward ${forward}`);
  assert.ok(Math.abs(reverse - 0.4) < 0.012, `reverse ${reverse}`);
});

test('drawsOf keeps a flush redraw on a made straight and tells a double gutshot from an open-ender', () => {
  const redraw = drawsOf(['9h', '8h'], ['7h', '6h', '5c']);
  assert.equal(redraw.flushDraw, true);
  assert.equal(redraw.straightDraw, null);
  assert.equal(redraw.outs, 9);
  assert.equal(drawsOf(['Js', 'Th'], ['Ac', 'Qd', '8c']).straightDraw, 'double-gutshot');
  assert.equal(drawsOf(['9c', '8d'], ['7h', '6s', '2c']).straightDraw, 'open-ended');
  assert.equal(drawsOf(['5c', '4d'], ['3h', '2s', 'Kc']).straightDraw, 'open-ended', 'the wheel ace completes below');
  assert.equal(drawsOf(['Ac', '2d'], ['3h', '4s', 'Kc']).straightDraw, 'gutshot');
  assert.equal(drawsOf(['Ah', 'Kh'], ['Qh', 'Jh', '2h']).outs, 0, 'a made flush draws nothing');
});

test('the river nuts exclude a split with the board but keep a rare tie', async () => {
  const { isSoleRiverNuts } = await import('../shared/poker-eval.js');
  assert.equal(isSoleRiverNuts(['2c', '4s'], ['As', 'Ks', 'Qs', 'Js', 'Ts']), false, 'the board plays: everyone splits');
  assert.equal(isSoleRiverNuts(['Ah', '3h'], ['Kh', '9h', '4h', '2c', '7d']), true, 'the nut flush');
  assert.equal(isSoleRiverNuts(['Jc', 'Th'], ['9c', '8d', '7h', '2s', 'Kd']), true, 'the nut straight ties only another J-T');
  assert.equal(isSoleRiverNuts(['Qc', 'Jh'], ['9c', '8d', '7h', '2s', 'Kd']), false, 'J-T beats it');
});
