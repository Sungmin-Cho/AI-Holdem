// Play report: what the host's completed hands show across games, as frequencies
// and deterministic checks rather than per-spot grades. Pure: the caller reads
// the files and hands over, per hand, the host-safe replay projection
// (shared/hand-replay.js replayRecord: the host's own cards, AI cards the reveal
// policy opens, showdown reveals) and the host's own validated decision
// snapshots (training/process-review.js). A participant's hidden hole cards are
// in neither, so no number here can depend on them.
//
// Nothing here is a score: it does not feed the profile, the practice goal,
// spaced repetition or the learning-effect protocol. Reference comparisons use
// the v3 heuristic chart as a yardstick, including projected stacks and sizes.
import { closureOf, handFacts } from '../shared/decision-facts.js';
import { cardInt, scoreCards, seedFrom, xorshift32 } from '../shared/poker-eval.js';
import { evaluatePreflopReferenceV3 } from './preflop-reference-v3.js';

export const PLAY_REPORT_SCHEMA = 1;
const HERO = 'user';
export const SHORT_STACK_BB = 10;
export const WINDOW_HERO_HANDS = 600;
export const SESSION_ROWS = 12;
export const ALLIN_SAMPLES = 3000;
/** Hands before a per-100 figure is shown for comparable fixed-policy cash play. */
export const YARDSTICK_MIN_HANDS = 200;
const STREETS = ['flop', 'turn', 'river'];
const TABLES = ['2', '3-4', '5-6', '7-9'];
const GROUPS = Object.freeze({ 'rfi-unopened': 'rfi', 'vs-single-raise': 'vs-open', 'vs-3bet': 'vs-3bet', push: 'push', 'vs-shove': 'vs-shove' });
const GROUP_IDS = ['rfi', 'vs-open', 'vs-3bet', 'push', 'vs-shove'];

// Reference ranges for a full-ring/6-max cash game; tournaments run tighter late.
// Three- and four-handed play has no stated range.
export function vpipBand(seated) {
  if (seated <= 2) return { vpip: [55, 85], pfr: [45, 80] };
  if (seated <= 6) return { vpip: [20, 30], pfr: [15, 24] };
  return { vpip: [15, 24], pfr: [11, 19] };
}

const tableOf = (seated) => (seated <= 2 ? '2' : seated <= 4 ? '3-4' : seated <= 6 ? '5-6' : '7-9');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const kn = () => ({ k: 0, n: 0 });
const facing = () => ({ n: 0, fold: 0, call: 0, raise: 0 });
const dist = () => ({ raise: 0, call: 0, fold: 0 });

function emptyGroup() {
  return { n: 0, exact: 0, projected: 0, expected: dist(), actual: dist(), offRange: 0, missed: 0, classes: {} };
}

export function emptyGameSummary(meta = {}) {
  return {
    schemaVersion: PLAY_REPORT_SCHEMA,
    gameId: typeof meta.gameId === 'string' ? meta.gameId : null,
    savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : null,
    mode: meta.mode === 'cash-training' ? 'cash-training' : 'tournament',
    opponent: ['policy', 'llm', 'jev'].includes(meta.opponent) ? meta.opponent : 'unknown',
    // What makes results comparable from game to game: no other human at the table,
    // a known opponent policy identity, the table size and the starting depth.
    solo: meta.solo === true,
    policy: typeof meta.policy === 'string' && meta.policy.length <= 200 ? meta.policy : null,
    seats: Number.isSafeInteger(meta.seats) ? meta.seats : null,
    stackBb: Number.isFinite(meta.stackBb) ? meta.stackBb : null,
    hands: 0,
    heroHands: 0,
    // Hands dealt with the favourable-deal option are left out of every figure.
    biasedHands: 0,
    table: Object.fromEntries(TABLES.map((key) => [key, { hands: 0, vpip: 0, pfr: 0 }])),
    preflop: { unopened: { n: 0, raise: 0, limp: 0, fold: 0 }, vsRaise: facing(), shoveCalls: 0 },
    postflop: { cbet: kn(), facing: Object.fromEntries(STREETS.map((street) => [street, facing()])),
      bets: 0, raises: 0, calls: 0, wtsd: kn(), wsd: kn() },
    reference: { snapshots: 0, groups: Object.fromEntries(GROUP_IDS.map((id) => [id, emptyGroup()])), unsupported: {} },
    checks: { decisions: 0, shortEntries: 0, shortNonAllIn: [], unopenedDeep: 0, openLimp: [], foldWhenCheck: [],
      raises: 0, minRaises: 0, weakStackOff: [], closed: 0, closedCalls: 0, compared: 0, callBelowPrice: [], foldAbovePrice: [] },
    results: { hands: 0, netBb: 0, adjBb: 0, adjSqBb: 0, allIns: 0, luckBb: 0, unrevealed: 0 },
  };
}

// ---- reference comparison ---------------------------------------------------

function addReference(summary, decision, dataset) {
  if (decision.street !== 'preflop' || decision.forced) return;
  const ref = summary.reference;
  ref.snapshots += 1;
  let evaluation;
  try { evaluation = evaluatePreflopReferenceV3(decision, dataset); } catch { evaluation = null; }
  const group = evaluation?.status === 'supported' ? GROUPS[evaluation.coverage?.derived?.context] : null;
  const chosen = decision.chosenAction.action === 'bet' ? 'raise' : decision.chosenAction.action;
  if (!group || !['raise', 'call', 'fold'].includes(chosen)) {
    const code = typeof evaluation?.code === 'string' && /^[A-Z_]{1,40}$/.test(evaluation.code) ? evaluation.code : 'UNSUPPORTED_SPOT';
    ref.unsupported[code] = (ref.unsupported[code] ?? 0) + 1;
    return;
  }
  const row = ref.groups[group];
  row.n += 1;
  row[evaluation.coverage.referenceMatch === 'exact' ? 'exact' : 'projected'] += 1;
  // What the chart does with the hand hero actually held here: summed over
  // decisions it is the action mix a chart-follower would show with these hands.
  for (const action of evaluation.recommended) if (action.action in row.expected) row.expected[action.action] += action.frequency;
  row.actual[chosen] += 1;
  const foldFrequency = evaluation.recommended.find((action) => action.action === 'fold')?.frequency ?? 0;
  if (chosen !== 'fold' && foldFrequency === 1) {
    row.offRange += 1;
    if (typeof evaluation.handClass === 'string') row.classes[evaluation.handClass] = (row.classes[evaluation.handClass] ?? 0) + 1;
  }
  if (chosen === 'fold' && foldFrequency === 0) row.missed += 1;
}

// ---- checks from the host's decision snapshots -----------------------------

function effectiveBb(decision) {
  const seats = decision.publicSeats;
  const hero = seats.find((seat) => seat.playerId === decision.actorId);
  const others = seats.filter((seat) => seat.playerId !== decision.actorId && !seat.folded && !seat.out);
  if (!hero || !others.length) return null;
  const total = (seat) => seat.stack + seat.contribution;
  return Math.min(total(hero), Math.max(...others.map(total))) / decision.blinds[1];
}

/** What one decision snapshot shows, read at decision time only. `verdict` is
 * the closed-decision price comparison for it, when one was made. Patterns are
 * things to look at, never established mistakes. */
function inspectDecision(decision, verdict = null) {
  const { action, amount } = decision.chosenAction;
  const raise = action === 'raise' || action === 'bet';
  const hero = decision.publicSeats.find((seat) => seat.playerId === decision.actorId);
  const out = { patterns: [], raise, minRaise: raise && amount === decision.minRaiseTo && decision.minRaiseTo < decision.maxRaiseTo,
    shortEntry: false, unopenedDeep: false };
  if (action === 'fold' && decision.legal.canCheck) out.patterns.push('fold-when-check');
  if (decision.street === 'preflop') {
    const seated = decision.publicSeats.filter((seat) => !seat.out).length;
    const unopened = !decision.priorActions.some((prior) => prior.street === 'preflop' && (prior.action === 'raise' || prior.action === 'call'));
    const eff = effectiveBb(decision);
    // A stack of a big blind or less has no choice to look at.
    if (unopened && seated >= 3 && decision.position !== 'BB' && decision.toCall > 0 && eff !== null && eff > 1 && hero) {
      if (eff <= SHORT_STACK_BB) {
        if (action !== 'fold') {
          out.shortEntry = true;
          // A call for the whole stack is all-in, not a limp; a raise that covers every
          // opponent's stack puts all of theirs at risk, whatever hero keeps behind.
          const cover = Math.max(...decision.publicSeats
            .filter((seat) => seat.playerId !== decision.actorId && !seat.folded && !seat.out).map((seat) => seat.stack + seat.bet));
          if ((action === 'call' && decision.toCall < hero.stack) || (raise && amount < Math.min(decision.maxRaiseTo, cover))) out.patterns.push('short-non-all-in');
        }
      } else if (decision.position !== 'SB') {
        out.unopenedDeep = true;
        if (action === 'call') out.patterns.push('open-limp');
      }
    }
  } else if (hero && ((action === 'call' && decision.toCall > 0 && decision.toCall >= hero.stack) || (raise && amount >= decision.maxRaiseTo))) {
    // Putting the rest of the stack in after the flop with less than top pair and no strong draw.
    const hand = handFacts(decision);
    const strong = hand && (hand.madeCategory >= 2 || ['탑페어', '오버페어'].includes(hand.madeDetail));
    if (hand && !strong && (hand.outs ?? 0) < 8) out.patterns.push('weak-stack-off');
  }
  if (verdict === 'call-below-price' || verdict === 'fold-above-price') out.patterns.push(verdict);
  return out;
}

/** Pattern ids of one validated, deliberate decision (see inspectDecision). */
export function decisionPatterns(decision, verdict = null) {
  if (!decision || decision.processStatus !== 'available' || decision.forced) return [];
  return inspectDecision(decision, verdict).patterns;
}

const PATTERN_KO = Object.freeze({
  'short-non-all-in': `유효 스택 ${SHORT_STACK_BB}BB 이하에서 올인이 아닌 진입`,
  'open-limp': '아무도 들어오지 않은 팟에 콜로 진입',
  'fold-when-check': '체크할 수 있는데 폴드',
  'weak-stack-off': '탑페어 미만·강한 드로 없이 남은 스택 투입',
  'call-below-price': '콜하면 베팅이 끝나는 결정에서 추정 승률이 필요 승률에 못 미친 콜(추정 레인지는 보정되지 않은 참고값)',
  'fold-above-price': '콜하면 베팅이 끝나는 결정에서 추정 승률이 필요 승률을 넘겼던 폴드(추정 레인지는 보정되지 않은 참고값)',
});
/** Korean names of pattern ids, for the coach prompt. */
export function patternLinesKo(ids) {
  return (Array.isArray(ids) ? ids : []).map((id) => PATTERN_KO[id]).filter(Boolean).map((text) => `- ${text}`);
}

function addChecks(summary, decision, factsOf) {
  if (decision.forced) return;
  const checks = summary.checks;
  const handNo = decision.handNo;
  const { action } = decision.chosenAction;
  let verdict = null;
  if (closureOf(decision) && (action === 'call' || action === 'fold')) {
    checks.closed += 1;
    if (action === 'call') checks.closedCalls += 1;
    try { verdict = factsOf(decision)?.priceVerdict?.verdict ?? null; } catch { verdict = null; }
    if (verdict) checks.compared += 1;
  }
  const seen = inspectDecision(decision, verdict);
  checks.decisions += 1;
  if (seen.raise) checks.raises += 1;
  if (seen.minRaise) checks.minRaises += 1;
  if (seen.shortEntry) checks.shortEntries += 1;
  if (seen.unopenedDeep) checks.unopenedDeep += 1;
  const lists = { 'fold-when-check': 'foldWhenCheck', 'short-non-all-in': 'shortNonAllIn', 'open-limp': 'openLimp',
    'weak-stack-off': 'weakStackOff', 'call-below-price': 'callBelowPrice', 'fold-above-price': 'foldAbovePrice' };
  for (const id of seen.patterns) checks[lists[id]].push(handNo);
}

// ---- frequencies from public actions ---------------------------------------

function addFrequencies(summary, replay) {
  const actions = replay.actions;
  const mine = actions.filter((row) => row.playerId === HERO && row.forced !== true);
  const preflop = mine.filter((row) => row.street === 'preflop');
  const seated = Object.keys(replay.startStacks).length;
  if (preflop.length) {
    const table = summary.table[tableOf(seated)];
    table.hands += 1;
    if (preflop.some((row) => row.action === 'call' || row.action === 'raise')) table.vpip += 1;
    if (preflop.some((row) => row.action === 'raise')) table.pfr += 1;
    const first = preflop[0];
    const before = actions.slice(0, actions.indexOf(first)).filter((row) => row.street === 'preflop');
    const raises = before.filter((row) => row.action === 'raise');
    const calls = before.filter((row) => row.action === 'call').length;
    if (!raises.length && !calls && (first.callAmount ?? 0) > 0) {
      const row = summary.preflop.unopened;
      row.n += 1;
      row[first.action === 'raise' ? 'raise' : first.action === 'call' ? 'limp' : 'fold'] += 1;
    }
    if (raises.length === 1 && ['fold', 'call', 'raise'].includes(first.action)) {
      summary.preflop.vsRaise.n += 1;
      summary.preflop.vsRaise[first.action] += 1;
    }
    for (const row of preflop) {
      if (row.action !== 'call') continue;
      const last = actions.slice(0, actions.indexOf(row)).filter((prior) => prior.street === 'preflop' && prior.action === 'raise').at(-1);
      if (last && Number.isSafeInteger(last.maxRaiseTo) && last.amount === last.maxRaiseTo) summary.preflop.shoveCalls += 1;
    }
  }
  const post = summary.postflop;
  const lastPreflopRaiser = actions.filter((row) => row.street === 'preflop' && row.action === 'raise').at(-1)?.playerId;
  let flopSeen = false;
  for (const row of mine) {
    if (!STREETS.includes(row.street)) continue;
    const price = (row.callAmount ?? 0) > 0;
    if (price && ['fold', 'call', 'raise'].includes(row.action)) {
      post.facing[row.street].n += 1;
      post.facing[row.street][row.action] += 1;
    }
    if (row.action === 'call') post.calls += 1;
    if (row.action === 'raise') post[(row.currentBet ?? 0) === 0 ? 'bets' : 'raises'] += 1;
    if (row.street === 'flop' && !flopSeen) {
      flopSeen = true;
      if (lastPreflopRaiser === HERO && (row.currentBet ?? 0) === 0) {
        post.cbet.n += 1;
        if (row.action === 'raise') post.cbet.k += 1;
      }
    }
  }
  // A flop hero saw is one hero had a turn on, the clock's actions included. A hand
  // whose betting ended before the flop (hero all-in, or hero covering an all-in)
  // only runs out: it is not a hand hero "went to showdown" with.
  const sawFlop = replay.board.length >= 3 && actions.some((row) => row.playerId === HERO && STREETS.includes(row.street));
  if (sawFlop) {
    post.wtsd.n += 1;
    const shown = replay.showdown !== null && !replay.folded.includes(HERO);
    if (shown) {
      post.wtsd.k += 1;
      post.wsd.n += 1;
      if (replay.pots.some((pot) => pot.eligible.length >= 2 && pot.winners.some((winner) => winner.playerId === HERO && winner.share > 0))) post.wsd.k += 1;
    }
  }
}

// ---- result and all-in luck -------------------------------------------------

function boardLengthAtLastAction(replay) {
  const last = replay.actions.at(-1);
  if (!last) return 0;
  if (Array.isArray(last.board)) return last.board.length;
  return { preflop: 0, flop: 3, turn: 4, river: 5 }[last.street] ?? 5;
}

// Hero's expected share of each pot once the betting has ended, or null when a
// contender's cards are not in the projection. Remaining cards are enumerated
// (one or two to come) or sampled with a fixed seed (five to come).
export function allInExpectation(replay, { seed = 1, samples = ALLIN_SAMPLES } = {}) {
  if (replay.showdown === null || replay.folded.includes(HERO) || replay.board.length !== 5) return null;
  const known = boardLengthAtLastAction(replay);
  if (known >= 5) return null;
  const pots = replay.pots.map((pot) => ({ amount: pot.amount,
    contenders: pot.eligible.filter((pid) => !replay.folded.includes(pid)),
    won: pot.winners.find((winner) => winner.playerId === HERO)?.share ?? 0 }))
    .filter((pot) => pot.contenders.includes(HERO));
  if (!pots.some((pot) => pot.contenders.length >= 2)) return null;
  const ids = [...new Set(pots.flatMap((pot) => pot.contenders))];
  const hands = {};
  for (const pid of ids) {
    const cards = replay.holes[pid];
    if (!Array.isArray(cards) || cards.length !== 2) return { revealed: false };
    hands[pid] = cards.map(cardInt);
  }
  const board = replay.board.slice(0, known).map(cardInt);
  const used = new Uint8Array(52);
  for (const card of [...board, ...Object.values(hands).flat()]) {
    if (card < 0 || used[card]) return { revealed: false };
    used[card] = 1;
  }
  const deck = [];
  for (let card = 0; card < 52; card += 1) if (!used[card]) deck.push(card);
  const shares = pots.map(() => 0);
  let runs = 0;
  const settle = (extra) => {
    const full = [...board, ...extra];
    const score = {};
    for (const pid of ids) score[pid] = scoreCards([...hands[pid], ...full]);
    pots.forEach((pot, at) => {
      const best = Math.max(...pot.contenders.map((pid) => score[pid]));
      if (score[HERO] === best) shares[at] += 1 / pot.contenders.filter((pid) => score[pid] === best).length;
    });
    runs += 1;
  };
  const missing = 5 - known;
  if (missing === 1) for (const a of deck) settle([a]);
  else if (missing === 2) {
    for (let i = 0; i < deck.length; i += 1) for (let j = i + 1; j < deck.length; j += 1) settle([deck[i], deck[j]]);
  } else {
    const next = xorshift32(seed);
    for (let n = 0; n < samples; n += 1) {
      const pool = [...deck];
      const extra = [];
      for (let k = 0; k < missing; k += 1) {
        const at = Math.floor((next() / 0x100000000) * pool.length) % pool.length;
        extra.push(pool[at]);
        pool[at] = pool[pool.length - 1];
        pool.pop();
      }
      settle(extra);
    }
  }
  const expected = pots.reduce((sum, pot, at) => sum + (pot.amount * shares[at]) / runs, 0);
  const won = pots.reduce((sum, pot) => sum + pot.won, 0);
  return { revealed: true, expected, won };
}

function addResult(summary, replay, seed) {
  const bb = replay.blinds[1];
  const start = replay.startStacks[HERO];
  const end = replay.endStacks[HERO];
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !(bb > 0)) return;
  const results = summary.results;
  const net = (end - start) / bb;
  let luck = 0;
  const allIn = allInExpectation(replay, { seed });
  if (allIn && !allIn.revealed) results.unrevealed += 1;
  if (allIn?.revealed) {
    results.allIns += 1;
    luck = (allIn.won - allIn.expected) / bb;
  }
  results.hands += 1;
  results.netBb += net;
  results.luckBb += luck;
  results.adjBb += net - luck;
  results.adjSqBb += (net - luck) ** 2;
}

// ---- one game ---------------------------------------------------------------

/** hands: [{ replay, decisions }] in hand order; replay is the host-safe
 * projection and decisions the host's validated snapshots (or absent). */
export function summarizeGame(meta, hands, { dataset, factsOf, checksOnly = false } = {}) {
  const summary = emptyGameSummary(meta);
  for (const hand of Array.isArray(hands) ? hands : []) {
    const replay = hand?.replay;
    if (!isObject(replay) || !Array.isArray(replay.actions) || !isObject(replay.startStacks) || !isObject(replay.endStacks)
      || !Array.isArray(replay.board) || !Array.isArray(replay.folded) || !Array.isArray(replay.allIn)
      || !Array.isArray(replay.pots) || !isObject(replay.holes) || !Array.isArray(replay.blinds)) continue;
    summary.hands += 1;
    if (!Object.hasOwn(replay.startStacks, HERO)) continue;
    if (hand.biased === true || (replay.dealSelection !== undefined && replay.dealSelection?.mode !== 'off')) { summary.biasedHands += 1; continue; }
    summary.heroHands += 1;
    // `checksOnly` is for the in-game host report: the pattern lines need neither the
    // frequencies nor the all-in simulations.
    if (!checksOnly) {
      addFrequencies(summary, replay);
      addResult(summary, replay, seedFrom(`${summary.gameId}:${replay.handNo}`));
    }
    for (const decision of Array.isArray(hand.decisions) ? hand.decisions : []) {
      if (decision?.processStatus !== 'available' || decision.actorId !== HERO) continue;
      if (dataset && !checksOnly) addReference(summary, decision, dataset);
      addChecks(summary, decision, typeof factsOf === 'function' ? factsOf : () => null);
    }
  }
  return summary;
}

// ---- many games -------------------------------------------------------------

function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') target[key] = (target[key] ?? 0) + value;
    else if (Array.isArray(value)) target[key] = [...(target[key] ?? []), ...value];
    else if (isObject(value)) target[key] = mergeInto(isObject(target[key]) ? target[key] : {}, value);
  }
  return target;
}

/** Adds one summary of the same game into another (every count, the results
 * included): a game can be reduced hand by hand, yielding in between. */
export function addGameSummary(target, source) {
  for (const key of ['hands', 'heroHands', 'biasedHands']) target[key] += source[key];
  for (const key of ['table', 'preflop', 'postflop', 'reference', 'checks', 'results']) mergeInto(target[key], source[key]);
  return target;
}

/** The pattern sections of several summaries added together (not the results). */
export function mergeGameSummaries(games) {
  const merged = emptyGameSummary();
  for (const summary of games) {
    for (const key of ['table', 'preflop', 'postflop', 'reference', 'checks']) mergeInto(merged[key], summary[key]);
  }
  return merged;
}

const rate = (k, n) => (n > 0 ? k / n : null);
const refsOf = (summary, hands) => hands.map((handNo) => ({ gameId: summary.gameId, day: typeof summary.savedAt === 'string' ? summary.savedAt.slice(5, 10) : null, handNo }));

function sessionRow(summary) {
  const hands = TABLES.reduce((sum, key) => sum + summary.table[key].hands, 0);
  const vpip = TABLES.reduce((sum, key) => sum + summary.table[key].vpip, 0);
  const pfr = TABLES.reduce((sum, key) => sum + summary.table[key].pfr, 0);
  return { gameId: summary.gameId, savedAt: summary.savedAt, mode: summary.mode, opponent: summary.opponent,
    heroHands: summary.heroHands, vpip: rate(vpip, hands), pfr: rate(pfr, hands),
    limps: summary.preflop.unopened.limp, shortEntries: summary.checks.shortEntries,
    shortNonAllIn: summary.checks.shortNonAllIn.length,
    closedCalls: summary.checks.closedCalls, callBelowPrice: summary.checks.callBelowPrice.length,
    luckBb: summary.results.allIns ? summary.results.luckBb : null };
}

/** The identity under which games are comparable, or null: cash play alone
 * against a known fixed policy at one table size and starting depth. */
export function yardstickKey(summary) {
  if (summary.mode !== 'cash-training' || summary.opponent !== 'policy' || !summary.solo || !summary.policy
    || !Number.isSafeInteger(summary.seats) || !Number.isFinite(summary.stackBb) || summary.biasedHands > 0) return null;
  return `${summary.seats}:${summary.stackBb}:${summary.policy}`;
}

function segmentRows(summaries) {
  const segments = new Map();
  for (const summary of summaries) {
    const yardstick = yardstickKey(summary);
    const key = yardstick ? `yardstick|${yardstick}` : `${summary.mode}|${summary.opponent}`;
    const row = segments.get(key) ?? { mode: summary.mode, opponent: summary.opponent,
      yardstick: yardstick ? { seats: summary.seats, stackBb: summary.stackBb, policy: summary.policy } : null,
      games: 0, hands: 0, netBb: 0, adjBb: 0, adjSqBb: 0, allIns: 0, luckBb: 0, unrevealed: 0 };
    row.games += summary.results.hands > 0 ? 1 : 0;
    for (const field of ['hands', 'netBb', 'adjBb', 'adjSqBb', 'allIns', 'luckBb', 'unrevealed']) row[field] += summary.results[field];
    segments.set(key, row);
  }
  return [...segments.values()].filter((row) => row.hands > 0).map(({ adjSqBb, netBb, adjBb, ...row }) => {
    // Net results leave this module only as the per-100 figure of a comparable population.
    if (!row.yardstick || row.hands < YARDSTICK_MIN_HANDS) return { ...row, per100: null };
    row = { ...row, netBb, adjBb };
    // Hands are treated as independent draws: an approximation that ignores what a
    // session has in common, so the interval is a rough width, not a guarantee.
    const mean = row.adjBb / row.hands;
    const variance = Math.max(0, adjSqBb / row.hands - mean ** 2);
    const half = 1.96 * 100 * Math.sqrt(variance / row.hands);
    const { netBb: net, adjBb: unused, ...rest } = row;
    return { ...rest, per100: { net: (100 * net) / row.hands, adjusted: 100 * mean, low: 100 * mean - half, high: 100 * mean + half } };
  }).sort((a, b) => b.hands - a.hands);
}

// Attention-routing heuristics over the window, not statistical findings: each
// needs a count and a share (a fold with a free check, which has no natural
// denominator, needs a count only). `latest` is the newest game and `earlier` the rest
// of the window, so the two never overlap; a side without opportunities is null.
function focusOf(windowed, latest, earlier) {
  const focus = [];
  const side = (summary, read) => {
    if (!summary) return null;
    const { value, sample } = read(summary);
    return sample > 0 ? { value, sample } : null;
  };
  const push = (id, read, extra = {}) => focus.push({ id, ...read(windowed), latest: side(latest, read), earlier: side(earlier, read), ...extra });
  const { checks, reference } = windowed;
  const shortEntry = (summary) => ({ value: summary.checks.shortNonAllIn.length, sample: summary.checks.shortEntries });
  if (checks.shortEntries >= 5 && checks.shortNonAllIn.length / checks.shortEntries >= 0.3) push('short-non-all-in', shortEntry);
  const belowPrice = (summary) => ({ value: summary.checks.callBelowPrice.length, sample: summary.checks.closedCalls });
  if (checks.callBelowPrice.length >= 3 && checks.callBelowPrice.length / checks.closedCalls >= 0.3) push('call-below-price', belowPrice);
  const open = reference.groups['vs-open'];
  const callShare = (summary) => ({ value: summary.reference.groups['vs-open'].actual.call, sample: summary.reference.groups['vs-open'].n });
  if (open.n >= 30 && (open.actual.call - open.expected.call) / open.n >= 0.1) push('reference-call-heavy', callShare, { reference: open.expected.call / open.n });
  const rfi = reference.groups.rfi;
  const offRange = (summary) => ({ value: summary.reference.groups.rfi.offRange, sample: summary.reference.groups.rfi.n });
  if (rfi.n >= 30 && rfi.offRange / rfi.n >= 0.15) push('reference-off-range-open', offRange);
  const limp = (summary) => ({ value: summary.checks.openLimp.length, sample: summary.checks.unopenedDeep });
  if (checks.openLimp.length >= 3 && checks.unopenedDeep >= 30 && checks.openLimp.length / checks.unopenedDeep >= 0.05) push('open-limp', limp);
  const foldCheck = (summary) => ({ value: summary.checks.foldWhenCheck.length, sample: summary.checks.decisions });
  if (checks.foldWhenCheck.length >= 2) push('fold-when-check', foldCheck);
  return focus.slice(0, 3);
}

/** summaries: game summaries in any order. The pattern window is the newest
 * games up to WINDOW_HERO_HANDS hero hands; results cover every game given. */
export function buildPlayReport(summaries, { now = null, unreadable = { games: 0, hands: 0 }, truncated = false } = {}) {
  const games = (Array.isArray(summaries) ? summaries : []).filter((summary) => summary?.schemaVersion === PLAY_REPORT_SCHEMA && summary.heroHands > 0)
    .sort((a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')) || String(a.gameId).localeCompare(String(b.gameId)));
  const windowGames = [];
  let heroHands = 0;
  for (const summary of games) {
    if (windowGames.length && heroHands >= WINDOW_HERO_HANDS) break;
    windowGames.push(summary);
    heroHands += summary.heroHands;
  }
  const windowed = mergeGameSummaries(windowGames);
  const examples = { shortNonAllIn: [], openLimp: [], foldWhenCheck: [], weakStackOff: [], callBelowPrice: [], foldAbovePrice: [] };
  for (const summary of windowGames) {
    for (const key of Object.keys(examples)) examples[key].push(...refsOf(summary, summary.checks[key]));
  }
  const groups = GROUP_IDS.map((id) => {
    const row = windowed.reference.groups[id];
    const classes = Object.entries(row.classes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
      .map(([handClass, count]) => ({ handClass, count }));
    return { id, decisions: row.n, exact: row.exact, projected: row.projected,
      expected: { ...row.expected }, actual: { ...row.actual }, offRange: row.offRange, missed: row.missed, classes };
  });
  const checks = windowed.checks;
  const listed = (key) => ({ count: checks[key].length, hands: examples[key].slice(0, 8) });
  return {
    schemaVersion: PLAY_REPORT_SCHEMA,
    generatedAt: typeof now === 'string' ? now : null,
    scope: { games: windowGames.length, totalGames: games.length, heroHands,
      biasedHands: windowGames.reduce((sum, summary) => sum + summary.biasedHands, 0),
      from: windowGames.at(-1)?.savedAt ?? null, to: windowGames[0]?.savedAt ?? null,
      unreadableGames: unreadable.games ?? 0, unreadableHands: unreadable.hands ?? 0, truncated: truncated === true },
    tendency: {
      tables: TABLES.map((key) => ({ table: key, hands: windowed.table[key].hands, vpip: windowed.table[key].vpip, pfr: windowed.table[key].pfr,
        band: key === '3-4' ? null : vpipBand(key === '2' ? 2 : key === '5-6' ? 6 : 9) })),
      unopened: { ...windowed.preflop.unopened },
      vsRaise: { ...windowed.preflop.vsRaise },
      shoveCalls: windowed.preflop.shoveCalls,
      cbet: { ...windowed.postflop.cbet },
      facing: Object.fromEntries(STREETS.map((street) => [street, { ...windowed.postflop.facing[street] }])),
      aggression: { bets: windowed.postflop.bets, raises: windowed.postflop.raises, calls: windowed.postflop.calls },
      wtsd: { ...windowed.postflop.wtsd },
      wsd: { ...windowed.postflop.wsd },
    },
    reference: { decisions: windowed.reference.snapshots, groups,
      unsupported: Object.entries(windowed.reference.unsupported).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([code, count]) => ({ code, count })) },
    checks: {
      decisions: checks.decisions,
      shortStackBb: SHORT_STACK_BB,
      shortEntries: checks.shortEntries,
      shortNonAllIn: listed('shortNonAllIn'),
      unopenedDeep: checks.unopenedDeep,
      openLimp: listed('openLimp'),
      foldWhenCheck: listed('foldWhenCheck'),
      raises: checks.raises,
      minRaises: checks.minRaises,
      weakStackOff: listed('weakStackOff'),
      closed: checks.closed,
      closedCalls: checks.closedCalls,
      compared: checks.compared,
      callBelowPrice: listed('callBelowPrice'),
      foldAbovePrice: listed('foldAbovePrice'),
    },
    results: { segments: segmentRows(games) },
    sessions: windowGames.slice(0, SESSION_ROWS).map(sessionRow),
    focus: focusOf(windowed, windowGames[0] ?? null, windowGames.length > 1 ? mergeGameSummaries(windowGames.slice(1)) : null),
  };
}

// ---- Korean display rows ----------------------------------------------------

const pct = (value, digits = 0) => (value === null || !Number.isFinite(value) ? '—' : `${(100 * value).toFixed(digits)}%`);
const share = (k, n) => (n > 0 ? `${pct(k / n)} (${k}/${n})` : '기록 없음');
const bbText = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}BB`;
const TABLE_KO = { 2: '헤즈업', '3-4': '3~4인', '5-6': '5~6인', '7-9': '7~9인' };
const GROUP_KO = { rfi: '미오픈 오픈', 'vs-open': '오픈 대응', 'vs-3bet': '3벳 대응', push: '숏스택 푸시', 'vs-shove': '쇼브 대응' };
const MODE_KO = { 'cash-training': '캐시 트레이닝', tournament: '토너먼트' };
const OPPONENT_KO = { policy: '로컬 정책', llm: 'LLM', jev: 'JEV', unknown: '상대 미기록' };
const UNSUPPORTED_KO = { LIMP_OR_CALLER: '앞에 림프·콜이 있는 팟', MID_STACK_UNSUPPORTED: '15.5~25BB 스택', STACK_OUT_OF_RANGE: '스택 범위 밖',
  FOUR_BET_PLUS: '4벳 이상', FACING_ALLIN_UNMODELED: '깊은 스택 올인 직면', DATASET_SPOT_MISSING: '기준표에 없는 자리',
  SEAT_COUNT_UNSUPPORTED: '좌석 수 미지원', FACING_SIZE_OUT_OF_RANGE: '상대 레이즈 크기 범위 밖', FORCED_STACK: '1BB 이하 스택' };

// "직전 게임 2/5, 그 전 3/8" — the two sides never share a hand; a side without
// opportunities is left out, and with neither the comparison is not available.
function compareText(item, format = (side) => `${side.value}/${side.sample}`) {
  const parts = [item.latest ? `직전 게임 ${format(item.latest)}` : null, item.earlier ? `그 전 ${format(item.earlier)}` : null].filter(Boolean);
  return parts.length === 2 ? ` ${parts.join(', ')}.` : ' 게임 간 비교는 표본이 없어 생략합니다.';
}
const shareOf = (side) => `${pct(side.value / side.sample)}(${side.sample}번)`;

const FOCUS_KO = {
  'short-non-all-in': (item) => ({ title: `${SHORT_STACK_BB}BB 이하에서 올인이 아닌 진입`,
    detail: `${SHORT_STACK_BB}BB 이하로 먼저 들어간 ${item.sample}번 중 ${item.value}번이 림프나 작은 레이즈였습니다. 살펴볼 패턴입니다: 이 깊이에서는 올인과 폴드만 두고 비교해 보세요.${compareText(item)}` }),
  'call-below-price': (item) => ({ title: '필요 승률에 못 미친 콜',
    detail: `콜하면 베팅이 끝나는 콜 ${item.sample}번 중 ${item.value}번은 추정 승률이 필요 승률보다 ${PRICE_MARGIN_TEXT} 이상 낮았습니다. 추정 레인지는 보정되지 않은 참고값이라, 그 핸드들을 복기에서 직접 확인해 보세요.${compareText(item)}` }),
  'reference-call-heavy': (item) => ({ title: '레이즈를 받았을 때 콜이 많음',
    detail: `기준표가 다루는 오픈 대응 ${item.sample}번에서 콜 ${pct(item.value / item.sample)}, 같은 패로 기준표가 콜하는 비율은 ${pct(item.reference)}입니다(v3 휴리스틱 기준표 대조, 점수 아님).${compareText(item, shareOf)}` }),
  'reference-off-range-open': (item) => ({ title: '기준표가 접는 패로 먼저 참여',
    detail: `미오픈 자리 ${item.sample}번 중 ${item.value}번은 기준표가 폴드만 하는 패였습니다(v3 휴리스틱 기준표 대조, 점수 아님).${compareText(item)}` }),
  'open-limp': (item) => ({ title: '먼저 들어갈 때 림프',
    detail: `아무도 들어오지 않은 팟 ${item.sample}번 중 ${item.value}번을 콜로 들어갔습니다. 살펴볼 패턴입니다: 들어갈 패라면 레이즈로 시작하는 쪽과 비교해 보세요.${compareText(item)}` }),
  'fold-when-check': (item) => ({ title: '체크할 수 있는데 폴드',
    detail: `체크로 다음 카드를 무료로 볼 수 있던 결정에서 ${item.value}번 폴드했습니다.${compareText(item, (side) => `${side.value}번`)}` }),
};
const PRICE_MARGIN_TEXT = '10%p';

/** Display rows: { focus: [{id,title,detail}], sections: [{id,title,note,rows:[{label,value}]}] }. */
export function playReportView(report) {
  if (!isObject(report) || report.schemaVersion !== PLAY_REPORT_SCHEMA || !(report.scope.heroHands > 0)) return { focus: [], sections: [] };
  const t = report.tendency;
  const sections = [];
  const tables = t.tables.filter((row) => row.hands > 0).map((row) => ({ label: `${TABLE_KO[row.table]} · ${row.hands}핸드`,
    value: `참여 ${pct(row.vpip / row.hands)} · 레이즈 ${pct(row.pfr / row.hands)}${row.band ? ` (참고 ${row.band.vpip[0]}~${row.band.vpip[1]}% · ${row.band.pfr[0]}~${row.band.pfr[1]}%)` : ''}` }));
  const facingRows = STREETS.filter((street) => t.facing[street].n > 0).map((street) => ({ label: `${{ flop: '플랍', turn: '턴', river: '리버' }[street]} 벳 직면`,
    value: `폴드 ${share(t.facing[street].fold, t.facing[street].n)} · 콜 ${pct(t.facing[street].call / t.facing[street].n)} · 레이즈 ${pct(t.facing[street].raise / t.facing[street].n)}` }));
  sections.push({ id: 'tendency', title: '플레이 빈도',
    note: '공개된 액션에서 센 빈도입니다. 참여·레이즈는 프리플랍 결정이 있던 핸드마다 한 번 셉니다. 참고 범위는 일반적인 캐시 게임 기준이라 토너먼트에는 그대로 맞지 않고, 3~4인에는 범위를 두지 않습니다.',
    rows: [...tables,
      { label: '먼저 들어갈 기회', value: t.unopened.n ? `레이즈 ${share(t.unopened.raise, t.unopened.n)} · 림프 ${pct(t.unopened.limp / t.unopened.n)} · 폴드 ${pct(t.unopened.fold / t.unopened.n)}` : '기록 없음' },
      { label: '레이즈 한 번을 받았을 때', value: t.vsRaise.n ? `폴드 ${share(t.vsRaise.fold, t.vsRaise.n)} · 콜 ${pct(t.vsRaise.call / t.vsRaise.n)} · 3벳 ${pct(t.vsRaise.raise / t.vsRaise.n)}` : '기록 없음' },
      { label: '올인 레이즈에 콜', value: `${t.shoveCalls}번` },
      { label: '플랍 연속 베팅', value: share(t.cbet.k, t.cbet.n) },
      ...facingRows,
      { label: '포스트플랍 벳·레이즈 대 콜', value: `벳·레이즈 ${t.aggression.bets + t.aggression.raises}번 · 콜 ${t.aggression.calls}번` },
      { label: '플랍을 본 뒤 쇼다운까지', value: `${share(t.wtsd.k, t.wtsd.n)} · 그중 팟을 딴 쇼다운 ${share(t.wsd.k, t.wsd.n)}` }] });
  const referenceRows = report.reference.groups.filter((group) => group.decisions > 0).map((group) => {
    const n = group.decisions;
    const act = (action) => pct(group.actual[action] / n);
    const exp = (action) => pct(group.expected[action] / n);
    const parts = [`레이즈 ${act('raise')}(기준 ${exp('raise')})`];
    if (group.expected.call > 0 || group.actual.call > 0) parts.push(`콜 ${act('call')}(기준 ${exp('call')})`);
    parts.push(`폴드 ${act('fold')}(기준 ${exp('fold')})`);
    const extra = [group.offRange ? `기준표가 접는 패로 참여 ${group.offRange}번${group.classes.length ? `(${group.classes.map((row) => row.handClass).join(' ')})` : ''}` : null,
      group.missed ? `기준표가 접지 않는 패를 폴드 ${group.missed}번` : null].filter(Boolean);
    return { label: `${GROUP_KO[group.id]} · ${n}번 (직접 ${group.exact} · 투영 ${group.projected})`, value: [parts.join(' · '), ...extra].join(' — ') };
  });
  const uncovered = report.reference.unsupported.reduce((sum, row) => sum + row.count, 0);
  if (referenceRows.length || uncovered) {
    sections.push({ id: 'reference', title: '기준표 대조',
      note: '각 결정에서 내가 든 패로 v3 휴리스틱 기준표가 하는 행동 비율을 더한 것(기준)과 내 실제 행동의 비교입니다. 예전 게임도 지금의 v3 기준표로 다시 본 것이고, 스택·크기를 투영한 결정이 섞인 참고값이며 점수·목표·평가에 들어가지 않습니다.',
      rows: [...referenceRows,
        ...(uncovered ? [{ label: `기준표 밖 ${uncovered}번`, value: report.reference.unsupported.slice(0, 4)
          .map((row) => `${UNSUPPORTED_KO[row.code] ?? '기타'} ${row.count}`).join(' · ') }] : [])] });
  }
  const c = report.checks;
  // Hand numbers repeat from game to game, so each example names its game's day.
  const hands = (list) => (list.hands.length ? ` (예: ${list.hands.slice(0, 5).map((row) => `${row.day ? `${row.day} ` : ''}핸드 ${row.handNo}`).join(', ')})` : '');
  sections.push({ id: 'checks', title: '결정 점검',
    note: `결정 시점 기록만으로 센 살펴볼 패턴입니다. 가격 비교는 콜하면 베팅이 끝나는 결정에서만 하며, 칩 기준으로 필요 승률과 추정 승률을 견준 것입니다. 추정 레인지는 보정되지 않은 참고값이고 ${PRICE_MARGIN_TEXT} 이상 벌어진 경우만 셉니다. 점검한 결정 ${c.decisions}건.`,
    rows: [
      { label: `${c.shortStackBb}BB 이하 먼저 진입`, value: c.shortEntries ? `${c.shortEntries}번 중 올인이 아닌 진입 ${c.shortNonAllIn.count}번${hands(c.shortNonAllIn)}` : '기록 없음' },
      { label: '먼저 들어갈 때 림프', value: c.unopenedDeep ? `${c.unopenedDeep}번 중 ${c.openLimp.count}번${hands(c.openLimp)}` : '기록 없음' },
      { label: '콜하면 베팅이 끝나는 결정', value: c.closed ? `${c.closed}번(콜 ${c.closedCalls}번), 추정 레인지로 견준 ${c.compared}번 중 필요 승률에 못 미친 콜 ${c.callBelowPrice.count}번${hands(c.callBelowPrice)} · 필요 승률을 넘겼던 폴드 ${c.foldAbovePrice.count}번${hands(c.foldAbovePrice)}` : '기록 없음' },
      { label: '체크할 수 있는데 폴드', value: `${c.foldWhenCheck.count}번${hands(c.foldWhenCheck)}` },
      { label: '최소 크기 레이즈', value: c.raises ? `레이즈 ${c.raises}번 중 ${c.minRaises}번` : '기록 없음' },
      { label: '탑페어 미만으로 스택 투입', value: `${c.weakStackOff.count}번${hands(c.weakStackOff)}` }] });
  const segments = report.results.segments.map((row) => {
    const who = row.yardstick ? `${row.yardstick.seats}인 ${row.yardstick.stackBb}BB · 혼자 · ${OPPONENT_KO[row.opponent]}` : OPPONENT_KO[row.opponent];
    const head = `${MODE_KO[row.mode]} · ${who} · ${row.games}게임 ${row.hands}핸드`;
    const luck = row.allIns ? `런아웃을 조정한 올인 ${row.allIns}번의 운 ${bbText(row.luckBb)}` : '조정한 올인 없음';
    const hidden = row.unrevealed ? ` · 공개되지 않은 패가 있어 조정하지 않은 올인 ${row.unrevealed}번` : '';
    const per100 = row.per100 ? ` · 100핸드당 ${bbText(row.per100.net)}, 런아웃 운을 뺀 값 ${bbText(row.per100.adjusted)} (핸드를 독립 표본으로 본 근사 95% 구간 ${bbText(row.per100.low)} ~ ${bbText(row.per100.high)})`
      : row.yardstick ? ` · 100핸드당 수치는 ${YARDSTICK_MIN_HANDS}핸드부터 냅니다` : '';
    return { label: head, value: `${luck}${hidden}${per100}` };
  });
  if (segments.length) {
    sections.push({ id: 'results', title: '결과와 운',
      note: '마지막 베팅이 끝난 뒤 남은 카드에 대해, 그 시점의 기대 몫과 실제로 받은 몫의 차이를 운으로 셉니다(관련된 패가 모두 공개된 핸드만, 팟에 든 칩 기준). 그 전의 카드와 상대의 선택에 든 운은 들어 있지 않으므로 운 전체를 떼어 낸 값은 아닙니다. 100핸드당 수치는 혼자 같은 로컬 정책 상대와 같은 인원·스택으로 둔 캐시 트레이닝끼리만 묶어 내며, 실력이나 수익의 증명이 아닙니다.',
      rows: segments });
  }
  const sessions = report.sessions.map((row) => ({ label: `${(row.savedAt ?? '').slice(0, 10) || '날짜 없음'} · ${MODE_KO[row.mode]} · ${row.heroHands}핸드`,
    value: [`참여 ${pct(row.vpip)} · 레이즈 ${pct(row.pfr)}`, `림프 ${row.limps}`,
      row.shortEntries ? `${SHORT_STACK_BB}BB 이하 진입 ${row.shortEntries}번 중 비올인 ${row.shortNonAllIn}` : null,
      row.closedCalls ? `닫힌 콜 ${row.closedCalls}번 중 필요 승률 미달 ${row.callBelowPrice}` : null,
      row.luckBb === null ? null : `올인 운 ${bbText(row.luckBb)}`].filter(Boolean).join(' · ') }));
  if (sessions.length) sections.push({ id: 'sessions', title: '게임별 추이', note: '최근 게임부터입니다. 게임마다 인원·스택 구성이 달라 값이 그대로 비교되지는 않습니다.', rows: sessions });
  return { focus: report.focus.map((item) => ({ id: item.id, ...(FOCUS_KO[item.id]?.(item) ?? {}) })).filter((item) => item.title), sections };
}

/** Lines for one game's own checks (the host's in-game report and the machine
 * review): only what the older detectors do not already say. */
export function gameCheckLinesKo(summary) {
  const c = summary?.checks;
  if (!c) return [];
  const list = (hands) => [...new Set(hands)].slice(0, 8).join(', ');
  const lines = [];
  if (c.shortNonAllIn.length) lines.push(`- ${SHORT_STACK_BB}BB 이하에서 올인이 아닌 진입 ${c.shortNonAllIn.length}회(핸드 ${list(c.shortNonAllIn)}). 이 깊이에서는 올인과 폴드만 두고 비교해 보세요.`);
  if (c.openLimp.length) lines.push(`- 아무도 들어오지 않은 팟에 림프 ${c.openLimp.length}회(핸드 ${list(c.openLimp)}). 들어갈 패라면 레이즈로 시작하는 쪽과 비교해 보세요.`);
  if (c.callBelowPrice.length) lines.push(`- 콜하면 베팅이 끝나는 결정에서 필요 승률에 못 미친 콜 ${c.callBelowPrice.length}회(핸드 ${list(c.callBelowPrice)}). 칩 기준 비교이며 추정 레인지는 보정되지 않은 참고값입니다.`);
  if (c.foldAbovePrice.length) lines.push(`- 콜하면 베팅이 끝나는 결정에서 필요 승률을 넘겼던 폴드 ${c.foldAbovePrice.length}회(핸드 ${list(c.foldAbovePrice)}). 칩 기준 비교이며 추정 레인지는 보정되지 않은 참고값입니다.`);
  return lines;
}

/** Short lines naming the report's focus items, for the coach and the review
 * (advisory: not a score, a goal or a practice-focus file). */
export function focusLinesKo(report) {
  return playReportView(report).focus.map((item) => `- ${item.title}: ${item.detail}`);
}
