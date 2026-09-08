// Reference contexts, not engine rules. Never infer membership from a regex alone.
export const PREFLOP_ORDERS = Object.freeze(Object.fromEntries(Object.entries({
  6: ['UTG','HJ','CO','BTN','SB','BB'],
  8: ['UTG','UTG1','LJ','HJ','CO','BTN','SB','BB'],
  9: ['UTG','UTG1','UTG2','LJ','HJ','CO','BTN','SB','BB'],
}).map(([n,order])=>[n,Object.freeze(order)])));

export function trainingPositionV2(label, seated) {
  const order = PREFLOP_ORDERS[seated];
  if (!order || typeof label !== 'string') return null;
  if (['BTN','SB','BB','CO','UTG'].includes(label)) return label;
  const offset = /^UTG\+(\d+)$/.exec(label);
  if (offset) {
    const index = Number(offset[1]);
    return index > 0 && index < order.length-4 ? order[index] : null;
  }
  return order.includes(label) ? label : null;
}

export function preflopKeys() {
  const keys=[];
  for (const [seated,order] of Object.entries(PREFLOP_ORDERS)) {
    for (const position of order.slice(0,-1)) keys.push(`${seated}max-100bb-${position.toLowerCase()}-rfi-v2`);
    order.forEach((hero,i)=>order.slice(0,i).forEach(opener=>keys.push(`${seated}max-100bb-${hero.toLowerCase()}-vs-${opener.toLowerCase()}-open25-v2`)));
  }
  return keys;
}
const V2_KEYS = new Set(preflopKeys());
export function parsePreflopKey(key) {
  if (typeof key !== 'string' || key.length>100) return null;
  const legacy=/^6max-100bb-(utg|hj|co|btn|sb|bb)-(rfi-unopened|vs-single-raise)$/.exec(key);
  if (legacy) return {version:1,seated:6,stackBb:100,position:legacy[1].toUpperCase(),openerPosition:null,context:legacy[2]};
  if (!V2_KEYS.has(key)) return null;
  const parts=key.split('-');
  return {version:2,seated:Number(parts[0].slice(0,-3)),stackBb:100,position:parts[2].toUpperCase(),
    openerPosition:parts[3]==='vs'?parts[4].toUpperCase():null,
    context:parts[3]==='vs'?'vs-single-raise':'rfi-unopened'};
}
