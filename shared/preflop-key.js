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

// ---- reference v3 (local-preflop-baseline@3.0.0) -------------------------
// Seat orders for 2..9 live players. A chart depends on how many players act
// after the hero, so 9-handed LJ and 6-handed UTG share one RFI chart.
export const PREFLOP_ORDERS_V3 = Object.freeze(Object.fromEntries(Object.entries({
  2: ['SB','BB'],
  3: ['BTN','SB','BB'],
  4: ['CO','BTN','SB','BB'],
  5: ['HJ','CO','BTN','SB','BB'],
  6: ['UTG','HJ','CO','BTN','SB','BB'],
  7: ['UTG','LJ','HJ','CO','BTN','SB','BB'],
  8: ['UTG','UTG1','LJ','HJ','CO','BTN','SB','BB'],
  9: ['UTG','UTG1','UTG2','LJ','HJ','CO','BTN','SB','BB'],
}).map(([n,order])=>[n,Object.freeze(order)])));
export const PUSHFOLD_STACKS_BB = Object.freeze([3,4,5,6,7,8,10,12,15]);
export const V3_CONTEXTS = Object.freeze(['rfi-unopened','vs-single-raise','vs-3bet','push','vs-shove']);

// Engine labels (BTN, SB, BB, CO, UTG, UTG+n, and BTN/SB heads-up) to v3 names.
export function trainingPositionV3(label, seated) {
  const order = PREFLOP_ORDERS_V3[seated];
  if (!order || typeof label !== 'string') return null;
  if (seated === 2) return label === 'BTN/SB' ? 'SB' : label === 'BB' ? 'BB' : null;
  if (['BTN','SB','BB'].includes(label)) return label;
  if (seated === 4) return label === 'UTG' ? 'CO' : null;
  if (label === 'CO') return seated >= 5 ? 'CO' : null;
  const early = seated >= 5 ? order.slice(0, seated - 4) : [];
  if (label === 'UTG') return early[0] ?? null;
  const offset = /^UTG\+(\d+)$/.exec(label);
  return offset ? early[Number(offset[1])] ?? null : null;
}

export function playersBehind(seated, position) {
  const order = PREFLOP_ORDERS_V3[seated];
  const index = order ? order.indexOf(position) : -1;
  return index < 0 ? null : order.length - 1 - index;
}

const lower = p => p.toLowerCase();
export function preflopKeysV3() {
  const keys = [];
  for (const [n, order] of Object.entries(PREFLOP_ORDERS_V3)) {
    const openers = order.slice(0, -1);
    for (const p of openers) keys.push(`${n}max-100bb-${lower(p)}-rfi-v3`);
    order.forEach((hero, i) => order.slice(0, i).forEach(v => keys.push(`${n}max-100bb-${lower(hero)}-vs-${lower(v)}-open-v3`)));
    order.forEach((hero, i) => order.slice(i + 1).forEach(v => {
      if (hero !== 'BB') keys.push(`${n}max-100bb-${lower(hero)}-vs-${lower(v)}-3bet-v3`);
    }));
    for (const s of PUSHFOLD_STACKS_BB) {
      for (const p of openers) keys.push(`${n}max-${s}bb-${lower(p)}-push-v3`);
      order.forEach((hero, i) => order.slice(0, i).forEach(v => keys.push(`${n}max-${s}bb-${lower(hero)}-vs-${lower(v)}-shove-v3`)));
    }
  }
  return keys;
}
const V3_KEYS = new Set(preflopKeysV3());
const V3_KEY_RE = /^([2-9])max-(\d+)bb-([a-z0-9]+)-(?:(rfi|push)|vs-([a-z0-9]+)-(open|3bet|shove))-v3$/;
const CONTEXT_OF = { rfi: 'rfi-unopened', push: 'push', open: 'vs-single-raise', '3bet': 'vs-3bet', shove: 'vs-shove' };
export function parsePreflopKeyV3(key) {
  if (typeof key !== 'string' || key.length > 100 || !V3_KEYS.has(key)) return null;
  const [, n, stack, hero, solo, villain, kind] = V3_KEY_RE.exec(key);
  const context = CONTEXT_OF[solo ?? kind];
  return { version: 3, seated: Number(n), stackBb: Number(stack), position: hero.toUpperCase(),
    openerPosition: villain ? villain.toUpperCase() : null, context };
}
