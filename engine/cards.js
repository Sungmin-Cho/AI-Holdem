import { randomInt } from 'node:crypto';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['s', 'h', 'd', 'c'];

export function newDeck() {
  return RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}`));
}

export function shuffle(deck, rng) {
  const result = [...deck];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = rng ? Math.floor(rng() * (i + 1)) : randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}
