/** Rebuilds a finished hand step by step from the replay record the server
 * already sends (shared/hand-replay.js). Pure: no DOM. The engine's own
 * numbers are the check — every action's potTotal / currentBet / maxRaiseTo /
 * callAmount must match the rebuilt state, and at the end
 * start − posted − put + uncalled returns + pot shares must equal endStacks.
 * Any disagreement means the record cannot be drawn faithfully, so the caller
 * falls back to the text list (design §10.1). */
import { actionVerbs } from './replay-format.js';

const STREET_BOARD = Object.freeze({ preflop: 0, flop: 3, turn: 4, river: 5 });
const STREET_OF_LENGTH = Object.freeze({ 3: 'flop', 4: 'turn', 5: 'river' });
const NEXT_STREET = Object.freeze({ preflop: 'flop', flop: 'turn', turn: 'river' });

function positionRank(label) {
  if (label === 'BTN' || label === 'BTN/SB') return 0;
  if (label === 'SB') return 1;
  if (label === 'BB') return 2;
  if (label === 'UTG') return 3;
  const utg = /^UTG\+(\d+)$/.exec(label ?? '');
  if (utg) return 3 + Number(utg[1]);
  if (label === 'CO') return 99;
  return null;
}

/** Seating order starting at the button (the order positions go round the
 * table). Without positions (legacy records) the live table's seat order is
 * used for the players who were dealt in. */
export function replaySeatOrder(replay, fallbackOrder = []) {
  const players = Object.keys(replay?.startStacks ?? {});
  const known = new Set(players);
  const ranked = players
    .map((playerId) => ({ playerId, rank: positionRank(replay?.positions?.[playerId]) }))
    .filter((row) => row.rank !== null);
  if (ranked.length === players.length && players.length) {
    return ranked.sort((a, b) => a.rank - b.rank).map((row) => row.playerId);
  }
  const ordered = fallbackOrder.filter((playerId) => known.has(playerId));
  for (const playerId of players) if (!ordered.includes(playerId)) ordered.push(playerId);
  return ordered;
}

const isAmount = (value) => Number.isSafeInteger(value) && value >= 0;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const fail = (reason, at = null) => ({ ok: false, reason, at });

export function buildReplaySteps(replay, { seatOrder } = {}) {
  if (!replay || typeof replay !== 'object' || replay.unavailable === true) return fail('unavailable');
  const startStacks = replay.startStacks ?? {};
  const players = Object.keys(startStacks);
  if (players.length < 2 || !players.every((playerId) => isAmount(startStacks[playerId]))) return fail('start-stacks');
  const known = new Set(players);
  const seats = seatOrder ?? replaySeatOrder(replay);
  if (seats.length !== players.length || !seats.every((playerId) => known.has(playerId))) return fail('seat-order');
  const board = Array.isArray(replay.board) ? replay.board : [];
  if (board.length > 5 || (board.length > 0 && board.length < 3)) return fail('board');

  const stacks = { ...startStacks };
  const bets = Object.fromEntries(players.map((playerId) => [playerId, 0]));
  const contrib = Object.fromEntries(players.map((playerId) => [playerId, 0]));
  const folded = new Set();
  const allIn = new Set();
  let street = 'preflop';
  let shownBoard = [];
  const steps = [];
  const snapshot = (fields) => {
    const total = sum(Object.values(contrib));
    steps.push({
      index: steps.length,
      street,
      board: [...shownBoard],
      stacks: { ...stacks },
      bets: { ...bets },
      pot: total - sum(Object.values(bets)),
      total,
      folded: [...folded],
      allIn: [...allIn],
      actor: null,
      actionIndex: null,
      ...fields,
    });
  };
  const put = (playerId, chips) => {
    stacks[playerId] -= chips;
    bets[playerId] += chips;
    contrib[playerId] += chips;
    if (stacks[playerId] === 0) allIn.add(playerId);
  };
  const collect = () => { for (const playerId of players) bets[playerId] = 0; };

  const posts = Array.isArray(replay.posts) ? replay.posts : [];
  for (const post of posts) {
    if (!known.has(post?.playerId) || !isAmount(post.amount) || post.amount > stacks[post.playerId]) return fail('post');
    put(post.playerId, post.amount);
  }
  const bigBlind = Array.isArray(replay.blinds) && isAmount(replay.blinds[1]) ? replay.blinds[1] : Math.max(0, ...posts.map((post) => post.amount));
  let currentBet = bigBlind;
  // The engine's minimum raise: the last full raise's size, a big blind at each street's start.
  let lastRaiseSize = bigBlind;
  snapshot({ kind: 'deal', posts: posts.map((post) => ({ playerId: post.playerId, amount: post.amount })) });

  // Turn order, as the engine keeps it (needsAction / nextNeedingAction /
  // bettingRoundClosed / afterAction). When a round closes and whether the hand
  // is over do not depend on seating, so every record is held to them; who acts
  // next needs the real seating, which the positions give (clockwise from the
  // button) — a legacy record without them skips only that part.
  const positional = players.every((playerId) => positionRank(replay.positions?.[playerId]) !== null) ? replaySeatOrder(replay) : null;
  const acted = new Set();
  let reopenEligible = true, handOver = false, roundClosed = false, toAct = null;
  const canPut = (playerId) => !folded.has(playerId) && stacks[playerId] > 0;
  const actionable = () => players.filter(canPut);
  const stillIn = () => players.filter((playerId) => !folded.has(playerId)).length;
  const needsAction = (playerId) => {
    if (!canPut(playerId)) return false;
    const matched = bets[playerId] >= currentBet;
    if (actionable().length === 1) return !matched;
    return !(acted.has(playerId) && matched);
  };
  const nextNeeding = (from) => {
    for (let step = 1; step <= positional.length; step += 1) {
      const playerId = positional[(from + step) % positional.length];
      if (needsAction(playerId)) return playerId;
    }
    return null;
  };
  const bettingClosed = () => {
    if (stillIn() <= 1) return true;
    const open = actionable();
    if (!open.length) return true;
    if (open.length === 1) return bets[open[0]] >= currentBet;
    return open.every((playerId) => acted.has(playerId) && bets[playerId] >= currentBet);
  };
  // Preflop starts left of the big blind. If nobody needs to act (the blinds
  // are all-in), the engine finishes the hand straight from the deal.
  handOver = !players.some(needsAction);
  if (positional && !handOver) {
    const first = positional[(positional.findIndex((playerId) => replay.positions[playerId] === 'BB') + 1) % positional.length];
    toAct = needsAction(first) ? first : null;
    if (toAct === null) return fail('order');
  }

  const actions = Array.isArray(replay.actions) ? replay.actions : [];
  const verbs = actionVerbs(actions);
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const playerId = action?.playerId;
    if (!known.has(playerId) || folded.has(playerId)) return fail('actor', index);
    // Once everyone else has folded the hand is over, and a player with no
    // chips behind is all-in: neither can act.
    if (players.filter((id) => !folded.has(id)).length < 2 || stacks[playerId] === 0) return fail('actor', index);
    const actionStreet = action.street ?? 'preflop';
    if (!(actionStreet in STREET_BOARD)) return fail('street', index);
    if (handOver || (roundClosed ? actionStreet !== NEXT_STREET[street] : actionStreet !== street)) return fail('order', index);
    if (actionStreet !== street) {
      if (STREET_BOARD[actionStreet] <= STREET_BOARD[street]) return fail('street', index);
      street = actionStreet;
      const collected = sum(Object.values(bets));
      collect();
      currentBet = 0;
      lastRaiseSize = bigBlind;
      const dealt = Array.isArray(action.board) ? action.board : board.slice(0, STREET_BOARD[street]);
      // A new street only adds cards: what was already on the board stays.
      if (dealt.length !== STREET_BOARD[street] || !shownBoard.every((card, at) => dealt[at] === card)) return fail('board', index);
      shownBoard = [...dealt];
      snapshot({ kind: 'street', collected });
      // advanceStreet: bets reset, the first seat after the button that needs to act.
      acted.clear(); reopenEligible = true; roundClosed = false;
      if (positional) toAct = nextNeeding(0);
    }
    if (positional && playerId !== toAct) return fail('order', index);
    if (Array.isArray(action.board) && (action.board.length !== STREET_BOARD[street]
      || action.board.some((card, at) => card !== shownBoard[at]))) return fail('board', index);
    // The engine's own pre-action numbers must match the rebuilt state.
    if (action.potTotal !== undefined && action.potTotal !== sum(Object.values(contrib))) return fail('pot-total', index);
    if (action.currentBet !== undefined && action.currentBet !== currentBet) return fail('current-bet', index);
    if (action.maxRaiseTo !== undefined && action.maxRaiseTo !== bets[playerId] + stacks[playerId]) return fail('max-raise', index);
    if (action.minRaiseTo !== undefined && action.minRaiseTo !== currentBet + lastRaiseSize) return fail('min-raise', index);
    const owed = Math.min(Math.max(0, currentBet - bets[playerId]), stacks[playerId]);
    if (action.callAmount !== undefined && action.callAmount !== owed) return fail('call-amount', index);
    let chips = 0;
    if (action.action === 'fold') folded.add(playerId);
    else if (action.action === 'check') {
      if (owed > 0) return fail('check', index);
    } else if (action.action === 'call') {
      if (owed <= 0 || action.amount !== owed) return fail('call', index);
      chips = owed;
    } else if (action.action === 'raise') {
      if (!isAmount(action.amount) || action.amount <= currentBet) return fail('raise', index);
      // canRaise: an incomplete raise does not reopen the action, and someone must be left to answer.
      if ((acted.has(playerId) && !reopenEligible) || !actionable().some((id) => id !== playerId)) return fail('raise', index);
      chips = action.amount - bets[playerId];
      if (chips <= 0 || chips > stacks[playerId]) return fail('raise', index);
      // A short all-in is the only raise below the minimum (applyAction's rule).
      const minTo = currentBet + lastRaiseSize, maxTo = bets[playerId] + stacks[playerId];
      if (minTo > maxTo ? action.amount !== maxTo : action.amount < minTo) return fail('raise', index);
      if (action.amount >= minTo) {
        lastRaiseSize = action.amount - currentBet;
        reopenEligible = true;
        acted.clear();
      } else reopenEligible = false;
      currentBet = action.amount;
    } else return fail('action', index);
    acted.add(playerId);
    if (chips) put(playerId, chips);
    // afterAction: the hand ends, the round goes on, or the next street is due.
    if (stillIn() <= 1) handOver = true;
    else if (!bettingClosed()) { if (positional) toAct = nextNeeding(positional.indexOf(playerId)); }
    else if (actionable().length <= 1 || street === 'river') handOver = true;
    else roundClosed = true;
    snapshot({
      kind: 'action',
      actor: playerId,
      actionIndex: index,
      verb: verbs.get(action) ?? action.action,
      amount: action.action === 'call' || action.action === 'raise' ? action.amount : null,
      put: chips,
    });
  }

  // A record that stops while someone still had to act is incomplete.
  if (!handOver) return fail('order');
  // The final board extends everything shown during the actions.
  if (board.length < shownBoard.length || !shownBoard.every((card, at) => board[at] === card)) return fail('board');
  // Who folded, and whether there was a showdown, must match the record too:
  // a changed check/fold moves no chips, so the arithmetic alone cannot see it.
  const recordedFolds = new Set(Array.isArray(replay.folded) ? replay.folded : []);
  if (recordedFolds.size !== folded.size || [...folded].some((playerId) => !recordedFolds.has(playerId))) return fail('folded');
  const contested = players.filter((playerId) => !folded.has(playerId)).length >= 2;
  if (contested !== Boolean(replay.showdown) || (contested && board.length !== 5)) return fail('showdown');
  // Only a contested hand runs the board out; otherwise it ends as last shown.
  if (!contested && board.length !== shownBoard.length) return fail('board');
  // The engine never removes anyone from its all-in list.
  const recordedAllIn = new Set(Array.isArray(replay.allIn) ? replay.allIn : []);
  if (recordedAllIn.size !== allIn.size || [...allIn].some((playerId) => !recordedAllIn.has(playerId))) return fail('all-in');
  collect();
  // The engine returns an uncalled bet first (finishHand: returnUncalled →
  // runout → showdown → awards), so the runout and showdown already show it.
  // The engine's rule (returnUncalled): the single largest contributor gets
  // back what nobody matched — the gap to the second largest contribution.
  const ranked = players.map((playerId) => contrib[playerId]).sort((a, b) => b - a);
  const top = players.filter((playerId) => contrib[playerId] === ranked[0]);
  const expected = top.length === 1 && ranked[0] > ranked[1] ? { [top[0]]: ranked[0] - Math.max(0, ranked[1]) } : {};
  const returns = replay.uncalledReturns ?? {};
  const given = Object.entries(returns).filter(([, amount]) => amount !== 0);
  if (given.length !== Object.keys(expected).length || given.some(([playerId, amount]) => expected[playerId] !== amount)) return fail('uncalled');
  const returned = [];
  for (const [playerId, amount] of given) {
    if (!known.has(playerId) || !isAmount(amount) || amount > contrib[playerId]) return fail('uncalled');
    stacks[playerId] += amount;
    contrib[playerId] -= amount;
    if (stacks[playerId] > 0) allIn.delete(playerId);
    returned.push({ playerId, amount });
  }
  if (returned.length) snapshot({ kind: 'return', returned });

  // An all-in runout deals the streets nobody acted on.
  for (const length of [3, 4, 5]) {
    if (length <= shownBoard.length || length > board.length) continue;
    street = STREET_OF_LENGTH[length];
    shownBoard = board.slice(0, length);
    snapshot({ kind: 'runout' });
  }

  const reveals = (replay.showdown?.reveals ?? []).filter((row) => known.has(row?.playerId));
  // A showdown shows every pot winner and never a folded hand; everyone still
  // in either shows or mucks, exactly once.
  if ((contested && !reveals.length) || reveals.some((row) => folded.has(row.playerId))) return fail('showdown');
  if (contested) {
    const shownIds = reveals.map((row) => row.playerId);
    const mucked = Array.isArray(replay.showdown?.mucks) ? replay.showdown.mucks : [];
    const accounted = [...shownIds, ...mucked];
    const live = players.filter((playerId) => !folded.has(playerId));
    if (accounted.length !== live.length || new Set(accounted).size !== live.length || live.some((playerId) => !accounted.includes(playerId))) return fail('showdown');
    const potWinners = (Array.isArray(replay.pots) ? replay.pots : []).flatMap((pot) => (Array.isArray(pot?.winners) ? pot.winners.map((row) => row.playerId) : []));
    if (potWinners.some((playerId) => !shownIds.includes(playerId))) return fail('showdown');
  }
  if (reveals.length) {
    snapshot({ kind: 'showdown', reveals: reveals.map((row) => ({ playerId: row.playerId, handName: row.handName ?? null })) });
  }

  const pots = Array.isArray(replay.pots) ? replay.pots : [];
  if (!pots.length || sum(pots.map((pot) => (isAmount(pot?.amount) ? pot.amount : NaN))) !== sum(Object.values(contrib))) return fail('pots');
  // Each pot, rebuilt from the contributions as engine/sidepots.js buildPots
  // does (one layer per contribution level, merged while the eligible seats
  // stay the same), must be the recorded pot: same count, order, amount, seats.
  const rebuilt = [];
  let previousLevel = 0;
  for (const level of [...new Set(players.map((playerId) => contrib[playerId]).filter((value) => value > 0))].sort((a, b) => a - b)) {
    let amount = 0;
    const eligible = [];
    for (const playerId of players) {
      amount += Math.max(0, Math.min(contrib[playerId], level) - previousLevel);
      if (contrib[playerId] >= level && !folded.has(playerId)) eligible.push(playerId);
    }
    const last = rebuilt.at(-1);
    if (amount > 0) {
      if (last && last.eligible.length === eligible.length && last.eligible.every((playerId) => eligible.includes(playerId))) last.amount += amount;
      else rebuilt.push({ amount, eligible });
    }
    previousLevel = level;
  }
  if (rebuilt.length !== pots.length || rebuilt.some((pot, at) => pot.amount !== pots[at].amount
    || (Array.isArray(pots[at].eligible) && (pots[at].eligible.length !== pot.eligible.length || pot.eligible.some((playerId) => !pots[at].eligible.includes(playerId)))))) return fail('pots');
  const awards = [];
  for (const pot of pots) {
    const winners = Array.isArray(pot.winners) ? pot.winners : [];
    if (!winners.length || sum(winners.map((row) => (known.has(row?.playerId) && isAmount(row.share) ? row.share : NaN))) !== pot.amount) return fail('pot-share');
    // Only a hand still in (and eligible for this pot) can win it.
    const eligible = Array.isArray(pot.eligible) ? new Set(pot.eligible) : null;
    if (winners.some((row) => folded.has(row.playerId) || (eligible && !eligible.has(row.playerId)))) return fail('pot-winner');
    // A split pot gives each winner the floor share, the odd chips one each.
    const shares = winners.map((row) => row.share);
    if (Math.max(...shares) - Math.min(...shares) > 1) return fail('pot-share');
    for (const row of winners) {
      stacks[row.playerId] += row.share;
      awards.push({ potIndex: pot.potIndex, playerId: row.playerId, share: row.share });
    }
  }
  const endStacks = replay.endStacks ?? {};
  if (!players.every((playerId) => endStacks[playerId] === stacks[playerId])) return fail('end-stacks');
  for (const playerId of players) contrib[playerId] = 0;
  snapshot({
    kind: 'result',
    returned,
    awards,
    pots: pots.map((pot) => ({
      potIndex: pot.potIndex,
      amount: pot.amount,
      winners: pot.winners.map((row) => ({ playerId: row.playerId, share: row.share })),
    })),
  });
  // The last snapshot has no contributions left: every chip went back or out.
  steps.at(-1).pot = 0;
  steps.at(-1).total = sum(pots.map((pot) => pot.amount));
  return { ok: true, seats, steps, bigBlind, board: [...board] };
}

/** First step of each street (and of the result) for the street chips. */
export function streetStarts(steps) {
  const starts = [];
  for (const step of steps) {
    const key = step.kind === 'result' || step.kind === 'showdown' ? 'result' : step.street;
    if (!starts.some((row) => row.key === key)) starts.push({ key, index: step.index });
  }
  return starts;
}
