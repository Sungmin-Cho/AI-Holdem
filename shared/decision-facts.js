// Deterministic decision facts from a public decision snapshot (engine
// decision.js shape): prices, stack depth, made hand, draws and Monte Carlo
// equity. Pure and browser-safe; every number here is arithmetic or a seeded
// simulation, never a strategy verdict.
import { describeMadeHand, drawsOf, equityVs, seedFrom } from './poker-eval.js';

const round = (value, digits = 1) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

function seatOf(snapshot, playerId) {
  return (snapshot.publicSeats ?? []).find((seat) => seat.playerId === playerId) ?? null;
}

// Pot structure if hero calls: every contribution is capped at hero's total, so
// the unmatched part of a larger bet is excluded. When an opponent still in the
// hand is all-in for less than hero's total, hero contests several pots (main
// and side) whose odds differ, so no single required equity is stated.
function potStructure(snapshot, heroTotal) {
  const seats = snapshot.publicSeats ?? [];
  const contribution = (seat) => (seat.playerId === snapshot.actorId ? heroTotal : seat.contribution);
  const winnable = seats.reduce((sum, seat) => sum + Math.min(contribution(seat), heroTotal), 0);
  const live = seats.filter((seat) => !seat.folded && !seat.out && seat.playerId !== snapshot.actorId);
  const heroLevels = new Set(live.map((seat) => Math.min(seat.contribution, heroTotal)).filter((c) => c > 0 && c < heroTotal));
  const multiPot = live.some((seat) => seat.allIn && seat.contribution < heroTotal) && heroLevels.size > 0;
  // Pots above hero's cap need two or more players reaching them; one player's
  // excess alone is returned to that player.
  const above = [...new Set(live.map((seat) => seat.contribution).filter((c) => c > heroTotal))].sort((a, b) => a - b);
  let otherSidePots = 0;
  for (const level of above) if (live.filter((seat) => seat.contribution >= level).length >= 2) otherSidePots += 1;
  return { winnable, multiPot, otherSidePots };
}

/** The pot hero contests by calling: every contribution capped at hero's total
 * after the call (the unmatched part of a larger bet is returned). Null without
 * a hero seat. With side pots it is the sum of every pot hero can win. */
export function winnablePotAfterCall(snapshot) {
  const hero = seatOf(snapshot, snapshot.actorId);
  if (!hero) return null;
  return potStructure(snapshot, hero.contribution + (snapshot.toCall ?? 0)).winnable;
}

export function chipFacts(snapshot) {
  const bb = snapshot.blinds?.[1];
  const hero = seatOf(snapshot, snapshot.actorId);
  if (!hero || !(bb > 0)) return null;
  const toCall = snapshot.toCall ?? 0;
  const owed = Math.max(0, (snapshot.currentBet ?? 0) - (snapshot.actorBet ?? 0));
  const partialCall = toCall > 0 && toCall < owed;
  const pots = potStructure(snapshot, hero.contribution + toCall);
  const potAfterCall = toCall > 0 ? pots.winnable : snapshot.potBefore;
  const opponents = (snapshot.publicSeats ?? []).filter((seat) => seat.playerId !== snapshot.actorId && !seat.folded && !seat.out);
  // Remaining stack that can still be bet against hero after this decision.
  const effectiveBehind = Math.min(hero.stack, Math.max(0, ...opponents.map((seat) => seat.stack)));
  const pot = snapshot.potBefore;
  const single = toCall > 0 && !pots.multiPot;
  const facts = {
    bb,
    potBb: round(pot / bb),
    toCallBb: round(toCall / bb),
    requiredEquity: single ? round((100 * toCall) / potAfterCall) : toCall > 0 ? null : 0,
    potOdds: single ? `${round((potAfterCall - toCall) / toCall)}:1` : null,
    partialCall,
    multiPot: toCall > 0 && pots.multiPot,
    otherSidePots: pots.otherSidePots,
    effectiveBb: round(effectiveBehind / bb),
    spr: pot > 0 ? round(effectiveBehind / pot) : null,
    opponents: opponents.length,
  };
  const chosen = snapshot.chosenAction;
  if (chosen && (chosen.action === 'raise' || chosen.action === 'bet') && pot > 0) {
    const put = chosen.amount - (snapshot.actorBet ?? 0);
    facts.chosenPutBb = round(put / bb);
    facts.chosenPctOfPot = round((100 * put) / pot, 0);
    facts.chosenAllIn = chosen.amount >= (snapshot.maxRaiseTo ?? Infinity);
  }
  return facts;
}

export function handFacts(snapshot) {
  const board = snapshot.board ?? [];
  if (!Array.isArray(snapshot.holeCards) || snapshot.holeCards.length !== 2) return null;
  const made = describeMadeHand(snapshot.holeCards, board);
  const draws = drawsOf(snapshot.holeCards, board);
  return {
    made: board.length >= 3 ? made.label : null,
    madeCategory: made.category,
    madeDetail: made.detail,
    flushDraw: draws.flushDraw,
    straightDraw: draws.straightDraw,
    outs: draws.outs,
  };
}

// Equity against `opponents` hands. `ranges` (one per opponent, null = any two
// cards) lets a caller supply estimated ranges; the default is random hands.
export function equityFacts(snapshot, { ranges = null, samples = 1500 } = {}) {
  const chips = chipFacts(snapshot);
  if (!chips || chips.opponents < 1) return null;
  const count = Math.min(chips.opponents, 8);
  const opponentRanges = ranges ?? Array(count).fill(null);
  const equity = equityVs({ holeCards: snapshot.holeCards, boardCards: snapshot.board ?? [],
    ranges: opponentRanges, samples, seed: seedFrom(`${snapshot.decisionId}:${count}:${ranges ? 'ranges' : 'random'}`) });
  return round(100 * equity);
}

// Korean one-line summary used by coach/review prompts and the machine review.
export function factsLineKo(snapshot, { equityRandom = null, equityRange = null } = {}) {
  const chips = chipFacts(snapshot);
  if (!chips) return null;
  const hand = handFacts(snapshot);
  const parts = [`팟 ${chips.potBb}BB`];
  if (chips.toCallBb > 0) {
    parts.push(`콜 ${chips.toCallBb}BB`);
    if (chips.multiPot) parts.push('메인·사이드팟이 나뉘어 단일 필요 승률 없음(팟별 판단)');
    else parts.push(`팟 오즈 ${chips.potOdds}`, `필요 승률 ${chips.requiredEquity}%`);
    if (chips.partialCall) parts.push('부분 올인 콜(이길 수 있는 팟 기준)');
    if (chips.otherSidePots) parts.push(`이길 수 없는 사이드팟 ${chips.otherSidePots}개 별도`);
  }
  parts.push(`유효 스택 ${chips.effectiveBb}BB`);
  if (chips.spr !== null) parts.push(`SPR ${chips.spr}`);
  if (hand?.made) parts.push(`메이드 ${hand.made}`);
  if (hand?.outs) parts.push(`드로 아웃 ${hand.outs}장`);
  if (equityRandom !== null) parts.push(`무작위 ${chips.opponents}명 대비 에퀴티 ${equityRandom}%${chips.multiPot ? '(전원 상대, 참고)' : ''}`);
  if (equityRange !== null) parts.push(`추정 레인지 대비 에퀴티 ${equityRange}%`);
  if (chips.chosenPctOfPot !== undefined) parts.push(`선택 크기 ${chips.chosenPutBb}BB(팟의 ${chips.chosenPctOfPot}%)${chips.chosenAllIn ? ' 올인' : ''}`);
  return parts.join(', ');
}
