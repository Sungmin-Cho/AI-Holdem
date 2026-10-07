// Preflop all-in equity between hand classes, decoded from the generated table.
// Pure: the data module is plain JS, so policies and generators can import it.
import { PREFLOP_EQUITY_V1 } from '../data/preflop-equity-v1.js';
import { HAND_CLASSES, HAND_CLASS_INDEX, combosOfClass } from '../../shared/poker-eval.js';
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

// compatible(h, v): villain combos of class v that share no card with one combo
// of class h, averaged over h's combos — card removal at class level.
let compat = null;
export function compatibleCombos(hero, villain) {
  if (!compat) {
    compat = new Float64Array(N * N);
    const combos = HAND_CLASSES.map(combosOfClass);
    for (let h = 0; h < N; h += 1) {
      for (let v = 0; v < N; v += 1) {
        let count = 0;
        for (const [a, b] of combos[h]) for (const [c, d] of combos[v]) if (a !== c && a !== d && b !== c && b !== d) count += 1;
        compat[h * N + v] = count / combos[h].length;
      }
    }
  }
  return compat[HAND_CLASS_INDEX[hero] * N + HAND_CLASS_INDEX[villain]];
}

// Equity of `hero` against a {class: frequency} range, each class weighted by
// the combos left after removing hero's own cards.
export function equityVsRange(hero, range) {
  const t = table();
  const row = HAND_CLASS_INDEX[hero] * N;
  let num = 0;
  let den = 0;
  for (let j = 0; j < N; j += 1) {
    const freq = range[HAND_CLASSES[j]];
    if (!freq) continue;
    const weight = compatibleCombos(hero, HAND_CLASSES[j]) * freq;
    num += weight * t[row + j];
    den += weight;
  }
  return den ? num / den : 0.5;
}
