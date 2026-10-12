import {bestFiveOf, describeTiebreak} from '../../shared/poker-eval.js';

/** Public hand events only. The result carries no cards except the public
 * board and the showdown reveals of that hand; never hole cards, mucks,
 * private actions, or opaque records. */
function handStartAt(rows, handNo) {
  return rows.findLastIndex(event => event.type === 'hand_start' && event.handNo === handNo);
}
function handEvents(log, handNo) {
  const rows = Array.isArray(log) ? log : [];
  const index = handStartAt(rows, handNo);
  if (index < 0) return [];
  const end = rows.findIndex((event, at) => at > index && event.type === 'hand_start');
  return rows.slice(index + 1, end < 0 ? rows.length : end);
}
function handTail(log, handNo) {
  const rows = Array.isArray(log) ? log : [];
  return rows.findLast(event => event.type === 'hand_start')?.handNo === handNo ? handEvents(rows, handNo) : [];
}

const STREETS = ['flop', 'turn', 'river'];
const validCards = cards => Array.isArray(cards) && cards.every(code => typeof code === 'string' && code.length === 2);
function bestFiveSafe(cards) {
  try { return bestFiveOf(cards); } catch { return null; }
}

/** One finished hand from its public events: awards, reveals, board by street. */
export function summarizeHand(log, handNo, {pots: potFacts = null} = {}) {
  const tail = handEvents(log, handNo);
  const awards = tail.filter(event => event.type === 'pot_award');
  if (!awards.length) return null;
  // The hand's own blinds: a later level must not rescale this hand's amounts.
  const start = log[handStartAt(log, handNo)];
  const blinds = Array.isArray(start?.blinds) && start.blinds.length === 2 && start.blinds.every(Number.isSafeInteger)
    ? [...start.blinds] : null;
  const showdown = tail.findLast(event => event.type === 'showdown');
  const streets = tail.filter(event => event.type === 'street');
  const finalBoard = validCards(streets.at(-1)?.board) ? streets.at(-1).board.slice(0, 5) : [];
  const board = {flop: finalBoard.slice(0, 3), turn: finalBoard.slice(3, 4), river: finalBoard.slice(4, 5)};
  const lastAction = tail.findLastIndex(event => event.type === 'action');
  const runout = showdown ? STREETS.filter(name => tail.findIndex(event => event.type === 'street' && event.street === name) > lastAction) : [];
  const reveals = new Map();
  for (const row of showdown?.reveals ?? []) {
    if (typeof row?.playerId !== 'string' || !validCards(row.cards) || row.cards.length !== 2) continue;
    const best = finalBoard.length === 5 ? bestFiveSafe([...row.cards, ...finalBoard]) : null;
    // A client evaluation that disagrees with the engine's hand name is dropped.
    reveals.set(row.playerId, {handName: typeof row.handName === 'string' ? row.handName : null,
      best: best && best.name === row.handName ? best : null});
  }
  const mucks = new Set(Array.isArray(showdown?.mucks) ? showdown.mucks.filter(id => typeof id === 'string') : []);
  const pots = [];
  const totals = new Map();
  for (const award of awards) {
    if (!Number.isSafeInteger(award.potIndex) || !Number.isSafeInteger(award.amount)
      || !Array.isArray(award.winners)) return null;
    const winners = [];
    for (const row of award.winners) {
      if (typeof row.playerId !== 'string' || !Number.isSafeInteger(row.share)) return null;
      winners.push({playerId:row.playerId, share:row.share});
      totals.set(row.playerId, (totals.get(row.playerId) ?? 0) + row.share);
    }
    pots.push({potIndex:award.potIndex, amount:award.amount, winners, note:null, versus:null});
  }
  if (showdown) {
    // Who could win each pot: the hand-end view's pots, or, with one pot, every
    // showdown player. Otherwise (a rebuilt side pot) the reason is unknown.
    const eligibleOf = pot => {
      const fact = potFacts?.find(row => row?.potIndex === pot.potIndex);
      if (Array.isArray(fact?.eligible)) return fact.eligible;
      return pots.length === 1 ? [...reveals.keys(), ...mucks] : null;
    };
    for (const pot of pots) {
      // Shared winners at a showdown held equal hands, whoever else mucked.
      if (pot.winners.length > 1) { pot.note = '같은 족보로 분할'; continue; }
      const eligible = eligibleOf(pot);
      const others = eligible?.filter(id => id !== pot.winners[0]?.playerId);
      // Only a pot whose every contender is tabled can name what decided it.
      if (!others?.length || eligible.some(id => !reveals.get(id)?.best)) continue;
      const best = id => reveals.get(id).best;
      const versus = others.reduce((top, id) => (best(id).score > best(top).score ? id : top));
      const text = describeTiebreak(best(pot.winners[0].playerId), best(versus))?.text;
      if (text) { pot.note = text; pot.versus = versus; }
    }
  }
  return {
    handNo,
    kind:showdown ? 'showdown' : 'uncontested',
    pots,
    winners:[...totals].map(([playerId,total]) => ({playerId,total,
      handName:reveals.get(playerId)?.handName ?? null, cards:reveals.get(playerId)?.best?.cards ?? null})),
    board,
    runout,
    blinds,
    myNet:null,
  };
}

export function buildHandResult({log, view, viewer, prior}) {
  if (!view || view.handInProgress !== false || view.gameOver) return null;
  const result = summarizeHand(log, view.handNo, {pots:view.pots});
  if (!result) return null;
  const seat = view.seats?.find(row => row.playerId === viewer);
  if (typeof viewer === 'string' && view.viewer !== null && seat && seat.kind !== 'ai' && prior?.handNo === view.handNo) {
    const end = view.mode === 'cash-training' ? view.sessionNet?.[viewer] : seat.stack;
    const start = view.mode === 'cash-training' ? prior.sessionNet?.[viewer] : prior.handStartStack;
    if (Number.isSafeInteger(end) && Number.isSafeInteger(start)) result.myNet = end - start;
  }
  return result;
}

function latestFinishedHandNo(rows) {
  const award = rows.findLastIndex(event => event.type === 'pot_award');
  if (award < 0) return null;
  return rows.findLast((event, index) => index < award && event.type === 'hand_start')?.handNo ?? null;
}

/** The latest finished hand in the log (reconnect / next hand), without the viewer's net. */
export function latestFinishedHand(log) {
  const rows = Array.isArray(log) ? log : [];
  const handNo = latestFinishedHandNo(rows);
  return handNo === null ? null : summarizeHand(rows, handNo);
}

/** "직전 결과": the latest finished hand, kept through the next hand and rebuilt
 * whenever the log has moved past it (missed frames, reconnect, game over).
 * Built from that hand's end view when it is the current view, so it keeps the
 * viewer's net and the pots' contenders; otherwise from the log alone. */
export function trackLatestResult(previous, {log, view, viewer, prior}) {
  const rows = Array.isArray(log) ? log : [];
  const handNo = latestFinishedHandNo(rows);
  if (handNo === null) return null;
  const atEnd = view?.handNo === handNo && view.handInProgress === false;
  if (previous?.handNo === handNo && (previous.fromView || !atEnd)) return previous;
  const result = atEnd ? buildHandResult({log:rows, view:{...view, gameOver:false}, viewer, prior}) : summarizeHand(rows, handNo);
  if (!result) return previous?.handNo === handNo ? previous : null;
  if (atEnd) result.fromView = true;
  return result;
}

export function updateHandResult(previous, input) {
  const view = input.view;
  if (!view || view.handInProgress !== false || view.gameOver) return null;
  if (previous?.handNo === view.handNo) return previous;
  return buildHandResult(input);
}

/** A late/reconnecting viewer sees the stage at now, rather than replaying it. */
export function handResultFrame({result, hold, log, view, now=Date.now(), reducedMotion=false}) {
  const board = Array.isArray(view?.board) ? view.board : [];
  const full = {board, visible:!!result, remainingSeconds:null};
  if (!result || hold?.handNo !== result.handNo || view?.handNo !== result.handNo) return full;
  const start = Date.parse(hold.startAt), until = Date.parse(hold.until);
  if (!Number.isFinite(start) || !Number.isFinite(until) || until <= now) return full;
  full.remainingSeconds = Math.ceil((until-now)/1000);
  if (reducedMotion || hold.runoutStreets <= 0 || hold.runoutStepMs <= 0) return full;
  const streets = handTail(log,result.handNo).filter(event=>event.type==='street');
  const count = hold.runoutStreets;
  const shown = Math.min(count,Math.max(0,Math.floor((now-start)/hold.runoutStepMs)));
  if (shown >= count) return full;
  const first = streets.length-count;
  return {
    board:streets[first+shown-1]?.board ?? [],
    visible:false,
    remainingSeconds:full.remainingSeconds,
  };
}

export function captureHandPrior(previous, {view, log, viewer}) {
  if (!view || view.handInProgress !== true || viewer == null) return previous?.handNo === view?.handNo ? previous : null;
  if (previous?.handNo === view.handNo) return previous;
  const seat = view.seats?.find(row => row.playerId === viewer);
  if (!seat) return null;
  if (view.mode === 'cash-training') return {handNo:view.handNo, sessionNet:{...view.sessionNet}};
  const tail = handTail(log,view.handNo);
  if (view.street !== 'preflop' || !tail.some(row=>row.type==='blinds_posted') || tail.some(row=>row.type==='action')) return null;
  return {handNo:view.handNo, handStartStack:seat.stack+seat.bet};
}
