import {randomInt} from 'node:crypto';
import {newDeck,rankValue,shuffle} from './cards.js';
import {DEAL_BIAS_MODES,dealSelectionError} from '../shared/deal-selection.js';

export function playableHoles([a,b]) {
  const x=rankValue(a),y=rankValue(b),suited=a[1]===b[1];
  return x===y || (suited && Math.max(x,y)===14) || Math.min(x,y)>=10
    || (suited && Math.abs(x-y)===1 && Math.min(x,y)>=5);
}
const deck=newDeck();
export const HOLE_COMBINATIONS=Object.freeze(deck.flatMap((a,i)=>deck.slice(i+1).map(b=>Object.freeze([a,b]))));
export function selectionWeights(mode) {
  if(!DEAL_BIAS_MODES.includes(mode)) throw dealSelectionError();
  const favored={off:1,light:2,strong:4}[mode];
  return HOLE_COMBINATIONS.map(holes=>playableHoles(holes)?favored:1);
}
export function selectedDeck(mode,userIndex,seatCount,rng) {
  if(mode==='off') return shuffle(newDeck(),rng); // byte/seed/RNG path unchanged
  const weights=selectionWeights(mode),total=weights.reduce((s,n)=>s+n,0);
  let ticket=rng?Math.floor(rng()*total):randomInt(total),index=0;
  if(!Number.isInteger(ticket) || ticket<0 || ticket>=total || userIndex<0 || userIndex>=seatCount) throw dealSelectionError();
  while(ticket>=weights[index]) ticket-=weights[index++]; // finite 1326 entries, no rejection sampling
  let holes=[...HOLE_COMBINATIONS[index]];
  if((rng?rng()<0.5:randomInt(2)===0)) holes.reverse();
  const remaining=shuffle(deck.filter(card=>!holes.includes(card)),rng);
  remaining.splice(userIndex,0,holes[0]);
  remaining.splice(seatCount+userIndex,0,holes[1]);
  return remaining;
}
