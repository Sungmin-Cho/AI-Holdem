// Stratified question weights for a v3 spot (design D12, gate G3). On the 13×13
// hand grid a cell is mixed when no action reaches 90%, boundary-adjacent when
// it is pure but a neighbour's main action differs, and deep pure otherwise.
// Mixed and boundary cells are where a learner's choice is informative; deep
// pure cells (mostly folds) are drawn rarely so "always fold" cannot pass.
const RANKS = 'AKQJT98765432';
export const STRATA_WEIGHTS = Object.freeze({ mixed: 3, boundary: 2, pure: 0.4 });

function classAt(row, col) {
  if (row === col) return `${RANKS[row]}${RANKS[col]}`;
  return row < col ? `${RANKS[row]}${RANKS[col]}s` : `${RANKS[col]}${RANKS[row]}o`;
}

/** frequenciesOf(handClass) → { fold, call, raise } (summing to 1). Returns a
 * Map handClass → { stratum, weight }. */
export function strataForSpot(frequenciesOf) {
  const main = [];
  const pure = [];
  for (let row = 0; row < 13; row += 1) {
    main.push([]);
    pure.push([]);
    for (let col = 0; col < 13; col += 1) {
      const f = frequenciesOf(classAt(row, col));
      const entries = Object.entries(f).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      main[row].push(entries[0][0]);
      pure[row].push(entries[0][1] >= 0.9);
    }
  }
  const out = new Map();
  for (let row = 0; row < 13; row += 1) {
    for (let col = 0; col < 13; col += 1) {
      let stratum = 'mixed';
      if (pure[row][col]) {
        const neighbours = [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]]
          .filter(([r, c]) => r >= 0 && r < 13 && c >= 0 && c < 13);
        stratum = neighbours.some(([r, c]) => main[r][c] !== main[row][col]) ? 'boundary' : 'pure';
      }
      out.set(classAt(row, col), { stratum, weight: STRATA_WEIGHTS[stratum] });
    }
  }
  return out;
}

/** Grid neighbours of a hand class (transfer questions). */
export function neighbourClasses(handClass) {
  for (let row = 0; row < 13; row += 1) {
    for (let col = 0; col < 13; col += 1) {
      if (classAt(row, col) !== handClass) continue;
      return [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]]
        .filter(([r, c]) => r >= 0 && r < 13 && c >= 0 && c < 13).map(([r, c]) => classAt(r, c));
    }
  }
  return [];
}
