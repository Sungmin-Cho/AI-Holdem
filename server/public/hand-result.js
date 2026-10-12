import {bestFiveOf, describeTiebreak} from '../../shared/poker-eval.js';

/** Public hand events only. The result carries no cards except the public
 * board and the showdown reveals of that hand; never hole cards, mucks,
 * private actions, or opaque records. */
// Events that belong to a hand's play. After a hand's awards none may follow
// before the next hand_start; if one does, that hand_start is missing and the
// two hands' public cards must not be mixed.
const HAND_BODY = new Set(['action', 'street', 'showdown', 'blinds_posted']);

/** The events of the hand starting at rows[start], up to the next hand_start;
 * null when its awards are followed by more play (a missing boundary). */
function handSegment(rows, start) {
  const out = [];
  let awarded = false;
  for (let at = start + 1; at < rows.length; at += 1) {
    const event = rows[at];
    if (event?.type === 'hand_start') break;
    if (event?.type === 'pot_award') awarded = true;
    else if (awarded && HAND_BODY.has(event?.type)) return null;
    out.push(event);
  }
  return out;
}
const lastStartOf = (rows, handNo) => rows.findLastIndex(event => event?.type === 'hand_start' && event.handNo === handNo);
function handTail(log, handNo) {
  const rows = Array.isArray(log) ? log : [];
  const start = rows.findLastIndex(event => event?.type === 'hand_start');
  return start >= 0 && rows[start].handNo === handNo ? handSegment(rows, start) ?? [] : [];
}

// A compact identity for a hand's events (two FNV-1a passes), so a result
// object never carries the event text itself.
function fingerprint(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}:${text.length}`;
}

const STREETS = ['flop', 'turn', 'river'];
const validCards = cards => Array.isArray(cards) && cards.every(code => typeof code === 'string' && code.length === 2);
function bestFiveSafe(cards) {
  try { return bestFiveOf(cards); } catch { return null; }
}

/** One finished hand, the one starting at rows[start], from its public events:
 * awards, reveals, board by street. */
function summarizeAt(rows, start, {pots: potFacts = null, viewer = null} = {}) {
  const tail = start >= 0 ? handSegment(rows, start) : null;
  const awards = tail?.filter(event => event.type === 'pot_award') ?? [];
  if (!awards.length) return null;
  const handNo = rows[start].handNo;
  // The hand's own blinds: a later level must not rescale this hand's amounts.
  const blinds = Array.isArray(rows[start].blinds) && rows[start].blinds.length === 2 && rows[start].blinds.every(Number.isSafeInteger)
    ? [...rows[start].blinds] : null;
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
    // The hand's start and every public event through its awards: two hands
    // share this identity only if everything a result shows is the same.
    key:fingerprint(JSON.stringify([rows[start], tail.slice(0, tail.findLastIndex(event => event.type === 'pot_award') + 1)])),
    viewer,
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

/** The last hand numbered `handNo`, when it has finished. */
export function summarizeHand(log, handNo, options = {}) {
  const rows = Array.isArray(log) ? log : [];
  return summarizeAt(rows, lastStartOf(rows, handNo), options);
}

export function buildHandResult({log, view, viewer, prior}) {
  if (!view || view.handInProgress !== false || view.gameOver) return null;
  const result = summarizeHand(log, view.handNo, {pots:view.pots, viewer:typeof viewer === 'string' && view.viewer !== null ? viewer : null});
  if (!result) return null;
  const seat = view.seats?.find(row => row.playerId === viewer);
  if (typeof viewer === 'string' && view.viewer !== null && seat && seat.kind !== 'ai' && prior?.handNo === view.handNo) {
    const end = view.mode === 'cash-training' ? view.sessionNet?.[viewer] : seat.stack;
    const start = view.mode === 'cash-training' ? prior.sessionNet?.[viewer] : prior.handStartStack;
    if (Number.isSafeInteger(end) && Number.isSafeInteger(start)) result.myNet = end - start;
  }
  return result;
}

// Where the latest finished hand starts: the hand_start before the last award.
function latestFinishedStart(rows) {
  const award = rows.findLastIndex(event => event?.type === 'pot_award');
  return award < 0 ? -1 : rows.findLastIndex((event, index) => index < award && event?.type === 'hand_start');
}

/** The latest finished hand in the log (reconnect / next hand), without the viewer's net. */
export function latestFinishedHand(log) {
  const rows = Array.isArray(log) ? log : [];
  return summarizeAt(rows, latestFinishedStart(rows));
}

/** "직전 결과": the latest finished hand, kept through the next hand and rebuilt
 * whenever the log has moved past it (missed frames, reconnect, game over) or
 * the viewer changed. Built from that hand's end view when it is the current
 * view, so it keeps the viewer's net and the pots' contenders; otherwise from
 * the log alone. */
export function trackLatestResult(previous, {log, view, viewer, prior}) {
  const rows = Array.isArray(log) ? log : [];
  const start = latestFinishedStart(rows);
  const latest = summarizeAt(rows, start);
  if (!latest) return null;
  const who = typeof viewer === 'string' && view?.viewer !== null ? viewer : null;
  const atEnd = start === rows.findLastIndex(event => event?.type === 'hand_start')
    && view?.handNo === latest.handNo && view.handInProgress === false;
  if (previous?.key === latest.key && previous.viewer === who && (previous.fromView || !atEnd)) return previous;
  const built = atEnd ? buildHandResult({log:rows, view:{...view, gameOver:false}, viewer, prior}) : null;
  if (built?.key === latest.key) return {...built, fromView:true};
  return {...latest, viewer:who};
}

export function updateHandResult(previous, input) {
  const view = input.view;
  if (!view || view.handInProgress !== false || view.gameOver) return null;
  const viewer = typeof input.viewer === 'string' && view.viewer !== null ? input.viewer : null;
  const fresh = buildHandResult(input);
  // Side frames of the same finished hand keep the same object (and its DOM);
  // another hand under a reused number, or another viewer, does not.
  if (previous?.handNo === view.handNo && previous.viewer === viewer && (!fresh || fresh.key === previous.key)) return previous;
  return fresh;
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
