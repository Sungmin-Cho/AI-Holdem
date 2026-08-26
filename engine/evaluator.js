import { rankValue } from './cards.js';

// Category values are ordered from weakest to strongest.
export const HAND_NAMES = Object.freeze([
  '하이 카드',
  '원페어',
  '투페어',
  '트리플',
  '스트레이트',
  '플러시',
  '풀하우스',
  '포카드',
  '스트레이트 플러시',
]);

export function eval5(cards) {
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map((card) => card[1]);
  const flush = suits.every((suit) => suit === suits[0]);

  const uniqueValues = [...new Set(values)];
  let straightHigh = 0;
  if (uniqueValues.length === 5) {
    if (uniqueValues[0] - uniqueValues[4] === 4) {
      straightHigh = uniqueValues[0];
    } else if (
      uniqueValues[0] === 14
      && uniqueValues[1] === 5
      && uniqueValues[4] === 2
    ) {
      straightHigh = 5;
    }
  }

  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  const groups = Object.entries(counts)
    .map(([value, count]) => [count, Number(value)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const tieBreakers = groups.map((group) => group[1]);

  if (flush && straightHigh) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, ...tieBreakers];
  if (groups[0][0] === 3 && groups[1][0] === 2) {
    return [6, ...tieBreakers];
  }
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...tieBreakers];
  if (groups[0][0] === 2 && groups[1][0] === 2) {
    return [2, ...tieBreakers];
  }
  if (groups[0][0] === 2) return [1, ...tieBreakers];
  return [0, ...values];
}

export function compareScore(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

export function evaluate7(cards) {
  let bestScore = null;

  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const score = eval5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (bestScore === null || compareScore(score, bestScore) > 0) {
              bestScore = score;
            }
          }
        }
      }
    }
  }

  const name = bestScore[0] === 8 && bestScore[1] === 14
    ? '로열 스트레이트 플러시'
    : HAND_NAMES[bestScore[0]];
  return { score: bestScore, name };
}
