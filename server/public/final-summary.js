/** Shared public result calculations. Missing totals remain unknown. */
export function finalScreen({view,sessionEnded=false,terminal=false,review=null}) {
  return {open:!!(view?.gameOver||sessionEnded||terminal),review:review?'ready':sessionEnded||terminal?'absent':'pending'};
}
export function rankPlayers({summary,view}) {
  const complete=summary?.complete===true;
  const rows=complete?summary.players:(view?.seats??[]).map(seat=>({
    playerId:seat.playerId,name:seat.name,kind:seat.kind,finalStack:seat.stack,out:seat.out===true,
    net:view?.mode==='cash-training'&&Number.isSafeInteger(view.sessionNet?.[seat.playerId])?view.sessionNet[seat.playerId]:null,
  }));
  const withNet=rows.length>0&&rows.every(row=>Number.isSafeInteger(row.net));
  const ordered=rows.map(row=>({playerId:row.playerId,name:row.name,finalStack:row.finalStack,out:row.out===true,...(withNet?{net:row.net}:{})}));
  const score=row=>withNet?row.net:row.finalStack??0;
  ordered.sort((a,b)=>(!withNet?Number(a.out)-Number(b.out):0)||score(b)-score(a)||a.playerId.localeCompare(b.playerId));
  let rank=0,previous=null;
  return ordered.map((row,index)=>{const key=[!withNet&&row.out,score(row)].join(':');if(key!==previous)rank=index+1;previous=key;return {...row,rank};});
}
export function summarizeHands(summary,viewer) {
  if(summary?.complete!==true)return null;
  const hands=summary.hands??[],mine=viewer?hands.filter(hand=>Number.isSafeInteger(hand.net?.[viewer])):[];
  let total=0;
  const series=mine.map(hand=>({handNo:hand.handNo,value:total+=hand.net[viewer]}));
  const positive=mine.filter(hand=>hand.net[viewer]>0).sort((a,b)=>b.net[viewer]-a.net[viewer]||a.handNo-b.handNo);
  const negative=mine.filter(hand=>hand.net[viewer]<0).sort((a,b)=>a.net[viewer]-b.net[viewer]||a.handNo-b.handNo);
  return {series,best:positive[0]??null,worst:negative[0]??null,topPots:[...hands].sort((a,b)=>b.potTotal-a.potTotal||a.handNo-b.handNo).slice(0,3)};
}
export function graphPoints(series,{width=320,height=100,padding=8}={}) {
  if(!series?.length)return [];
  const values=series.map(row=>row.value),lo=Math.min(0,...values),hi=Math.max(0,...values),span=hi-lo||1;
  return series.map((row,index)=>({x:series.length===1?width/2:padding+index/(series.length-1)*(width-2*padding),y:height-padding-(row.value-lo)/span*(height-2*padding)}));
}
