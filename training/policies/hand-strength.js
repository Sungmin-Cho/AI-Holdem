import { createHash } from 'node:crypto';
import { compareScore, evaluate7 } from '../../engine/evaluator.js';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const DECK = Object.freeze([...RANKS].flatMap((rank) => [...SUITS].map((suit) => `${rank}${suit}`)));
const POSITION_BONUS = Object.freeze({ UTG: 0, 'UTG+1': 0.015, HJ: 0.025, CO: 0.05, BTN: 0.075, 'BTN/SB': 0.075, SB: 0.025, BB: 0.015 });

function clamp(value, low = 0, high = 1) {
  return Math.min(high, Math.max(low, value));
}

function normalizeCard(card) {
  if (typeof card !== 'string' || card.length !== 2) return null;
  const rank = card[0].toUpperCase();
  const suit = card[1].toLowerCase();
  return RANKS.includes(rank) && SUITS.includes(suit) ? `${rank}${suit}` : null;
}

function publicCards(snapshot) {
  const holeCards = (snapshot?.holeCards ?? []).map(normalizeCard);
  const board = (snapshot?.board ?? []).map(normalizeCard);
  const all = [...holeCards, ...board];
  if (
    holeCards.length !== 2
    || board.length > 5
    || all.some((card) => card == null)
    || new Set(all).size !== all.length
  ) {
    const error = new Error('public cards are invalid');
    error.code = 'POLICY_PUBLIC_CARDS_INVALID';
    throw error;
  }
  return { holeCards, board };
}

function preflopStrength(holeCards, position) {
  const values = holeCards.map((card) => RANKS.indexOf(card[0]) + 2).sort((a, b) => b - a);
  const [high, low] = values;
  const pair = high === low;
  const suited = holeCards[0][1] === holeCards[1][1];
  const gap = high - low;
  let score = (high + low - 4) / 24;
  if (pair) score += 0.26 + (high - 2) / 60;
  if (suited) score += 0.055;
  if (!pair && gap <= 1) score += 0.055;
  else if (!pair && gap === 2) score += 0.025;
  else if (gap >= 5) score -= 0.06;
  if (high >= 11 && low >= 10) score += 0.055;
  score += POSITION_BONUS[position] ?? 0;
  return clamp(score);
}

function uint32(seed, sample, draw) {
  const digest = createHash('sha256').update(`${seed}|${sample}|${draw}`).digest();
  return digest.readUInt32BE(0);
}

function sampleRunout(remaining, seed, sample, count) {
  const pool = [...remaining];
  const selected = [];
  for (let draw = 0; draw < count; draw += 1) {
    const index = uint32(seed, sample, draw) % pool.length;
    selected.push(pool[index]);
    pool.splice(index, 1);
  }
  return selected;
}

export function estimatePublicStrength(snapshot, { samples } = {}) {
  const { holeCards, board } = publicCards(snapshot);
  if (snapshot?.street === 'preflop' || board.length === 0) {
    return preflopStrength(holeCards, snapshot?.position);
  }
  const raw = samples ?? snapshot?.strengthSamples ?? 64;
  const sampleCount = Math.min(128, Math.max(16, Math.trunc(raw) || 64));
  const known = new Set([...holeCards, ...board]);
  const remaining = DECK.filter((card) => !known.has(card));
  const missingBoard = 5 - board.length;
  const seed = JSON.stringify({
    street: snapshot?.street ?? null,
    holeCards,
    board,
    position: snapshot?.position ?? null,
  });
  let equity = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const drawn = sampleRunout(remaining, seed, sample, 2 + missingBoard);
    const opponent = drawn.slice(0, 2);
    const completedBoard = [...board, ...drawn.slice(2)];
    const hero = evaluate7([...holeCards, ...completedBoard]).score;
    const villain = evaluate7([...opponent, ...completedBoard]).score;
    const comparison = compareScore(hero, villain);
    equity += comparison > 0 ? 1 : comparison === 0 ? 0.5 : 0;
  }
  return clamp(equity / sampleCount);
}
