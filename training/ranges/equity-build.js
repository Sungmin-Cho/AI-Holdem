// The build procedure for the preflop equity table, kept apart from the decoded
// table so the build never imports the data it is producing.
import { HAND_CLASSES, combosOfClass, scoreCards, seedFrom, xorshift32 } from '../../shared/poker-eval.js';

export const EQUITY_UNITS = 10000;
export const EQUITY_SAMPLES_PER_PAIR = 6000;

// The exact procedure the build uses for one entry; tests recompute a sample.
export function computePairEquityUnits(i, j, samples = EQUITY_SAMPLES_PER_PAIR) {
  const left = combosOfClass(HAND_CLASSES[i]);
  const right = combosOfClass(HAND_CLASSES[j]);
  const pairs = [];
  for (const a of left) for (const b of right) {
    if (a[0] !== b[0] && a[0] !== b[1] && a[1] !== b[0] && a[1] !== b[1]) pairs.push([a, b]);
  }
  const next = xorshift32(seedFrom(`preflop-equity-v1:${i}:${j}`));
  const used = new Uint8Array(52);
  let won = 0;
  for (let n = 0; n < samples; n += 1) {
    const [a, b] = pairs[n % pairs.length];
    used.fill(0);
    used[a[0]] = 1; used[a[1]] = 1; used[b[0]] = 1; used[b[1]] = 1;
    const board = [];
    while (board.length < 5) {
      const card = next() % 52;
      if (!used[card]) { used[card] = 1; board.push(card); }
    }
    const left5 = scoreCards([a[0], a[1], ...board]);
    const right5 = scoreCards([b[0], b[1], ...board]);
    won += left5 > right5 ? 2 : left5 === right5 ? 1 : 0;
  }
  return Math.round((won / (2 * samples)) * EQUITY_UNITS);
}
