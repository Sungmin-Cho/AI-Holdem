/** Public hand events only. Never return cards, private actions, or opaque records. */
function handTail(log, handNo) {
  const rows = Array.isArray(log) ? log : [];
  const index = rows.findLastIndex(event => event.type === 'hand_start');
  if (index < 0 || rows[index].handNo !== handNo) return [];
  return rows.slice(index + 1);
}

export function buildHandResult({log, view, viewer, prior}) {
  if (!view || view.handInProgress !== false || view.gameOver) return null;
  const tail = handTail(log, view.handNo);
  const awards = tail.filter(event => event.type === 'pot_award');
  if (!awards.length) return null;
  const pots = [];
  const totals = new Map();
  const showdown = tail.findLast(event => event.type === 'showdown');
  const names = new Map((showdown?.reveals ?? []).map(row => [row.playerId, row.handName]));
  for (const award of awards) {
    if (!Number.isSafeInteger(award.potIndex) || !Number.isSafeInteger(award.amount)
      || !Array.isArray(award.winners)) return null;
    const winners = [];
    for (const row of award.winners) {
      if (typeof row.playerId !== 'string' || !Number.isSafeInteger(row.share)) return null;
      winners.push({playerId:row.playerId, share:row.share});
      totals.set(row.playerId, (totals.get(row.playerId) ?? 0) + row.share);
    }
    pots.push({potIndex:award.potIndex, amount:award.amount, winners});
  }
  let myNet = null;
  const seat = view.seats?.find(row => row.playerId === viewer);
  if (typeof viewer === 'string' && view.viewer !== null && seat && seat.kind !== 'ai' && prior?.handNo === view.handNo) {
    const end = view.mode === 'cash-training' ? view.sessionNet?.[viewer] : seat.stack;
    const start = view.mode === 'cash-training' ? prior.sessionNet?.[viewer] : prior.handStartStack;
    if (Number.isSafeInteger(end) && Number.isSafeInteger(start)) myNet = end - start;
  }
  return {
    handNo:view.handNo,
    kind:showdown ? 'showdown' : 'uncontested',
    pots,
    winners:[...totals].map(([playerId,total]) => ({playerId,total,handName:typeof names.get(playerId)==='string'?names.get(playerId):null})),
    myNet,
  };
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
