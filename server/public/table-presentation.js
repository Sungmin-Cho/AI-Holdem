export function aggregatePot(view) {
  if (!view || !(view.handNo > 0)) return {kind:'hidden',total:null};
  const pots=view.pots;
  if (!Array.isArray(pots) || !pots.length || pots.some(p=>!Number.isSafeInteger(p.amount)||p.amount<0)) return {kind:'unavailable',total:null};
  const total=pots.reduce((sum,p)=>sum+p.amount,0);
  if (!Number.isSafeInteger(total)) return {kind:'unavailable',total:null};
  if (view.legal?.potTotal !== undefined && view.legal.potTotal !== total) return {kind:'mismatch',total:null};
  return {kind:'ready',total};
}
export function showPotBreakdown(view) {
  return view?.handInProgress===false && view.pots?.length>1 && aggregatePot(view).kind==='ready';
}
export function logBlindContexts(log, replays={}) {
  let handNo=null, bb=null;
  return log.map(event=>{
    if(event.type==='hand_start') { handNo=event.handNo; bb=event.blinds?.[1] ?? null; }
    const fallback=replays[handNo]?.blinds?.[1];
    return bb != null && fallback != null && bb!==fallback ? null : (bb ?? fallback ?? null);
  });
}
