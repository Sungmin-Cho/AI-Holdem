// Preflop all-in equity between hand classes, decoded from the generated table.
// Pure: the data module is plain JS, so policies and generators can import it.
import { PREFLOP_EQUITY_V1 } from '../data/preflop-equity-v1.js';
import { HAND_CLASSES, HAND_CLASS_INDEX, comboCount } from '../../shared/poker-eval.js';
import { EQUITY_UNITS } from './equity-build.js';

export { EQUITY_UNITS };

const N = HAND_CLASSES.length;

// Upper triangle (i <= j) in row-major order, base36, three characters per entry.
export function decodeEquityTable(encoded) {
  if (typeof encoded !== 'string' || encoded.length !== (N * (N + 1) / 2) * 3) throw new Error('equity table has the wrong size');
  const table = new Float64Array(N * N);
  let at = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = i; j < N; j += 1) {
      const units = Number.parseInt(encoded.slice(at, at + 3), 36);
      at += 3;
      if (!Number.isInteger(units) || units < 0 || units > EQUITY_UNITS) throw new Error('equity table entry out of range');
      table[i * N + j] = units / EQUITY_UNITS;
      table[j * N + i] = (EQUITY_UNITS - units) / EQUITY_UNITS;
    }
  }
  return table;
}

let decoded = null;
function table() {
  decoded ??= decodeEquityTable(PREFLOP_EQUITY_V1.encoded);
  return decoded;
}

export function classEquity(hero, villain) {
  return table()[HAND_CLASS_INDEX[hero] * N + HAND_CLASS_INDEX[villain]];
}

// Combo-weighted equity of `hero` against a {class: frequency} range.
export function equityVsRange(hero, range) {
  const t = table();
  const row = HAND_CLASS_INDEX[hero] * N;
  let num = 0;
  let den = 0;
  for (let j = 0; j < N; j += 1) {
    const freq = range[HAND_CLASSES[j]];
    if (!freq) continue;
    const weight = comboCount(HAND_CLASSES[j]) * freq;
    num += weight * t[row + j];
    den += weight;
  }
  return den ? num / den : 0.5;
}
