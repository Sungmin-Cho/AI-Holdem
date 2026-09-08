import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allHandClasses } from '../training/cards.js';
import { rfiMix, vsRaiseMix } from '../training/data/legacy-preflop-recipe.js';
import { PREFLOP_ORDERS, preflopKeys, parsePreflopKey } from '../shared/preflop-key.js';

const METHOD = 'Original frequency-only sketch from public general-principle ranges. Not copied from a commercial solver dump.';
const FACTORS = {UTG:.60,UTG1:.65,UTG2:.70,LJ:.75,HJ:.85,CO:.95,BTN:1.10,SB:1.20};
function unitsMix(raise, call, sizeBb) {
  const total=raise+call;
  if(total>1){raise/=total;call/=total;}
  const rows=[{action:'raise',sizeBb,value:raise},{action:'call',value:call},{action:'fold',value:Math.max(0,1-raise-call)}];
  for(const row of rows){row.units=Math.floor(row.value*10000);row.remainder=row.value*10000-row.units;}
  const ranked=rows.map((row,i)=>({row,i})).sort((a,b)=>b.row.remainder-a.row.remainder||a.i-b.i);
  const remaining=10000-rows.reduce((sum,row)=>sum+row.units,0);
  for(let i=0;i<remaining;i++)ranked[i%ranked.length].row.units++;
  return rows.filter(r=>r.units>0).map(r=>({action:r.action,...(r.sizeBb!==undefined?{sizeBb:r.sizeBb}:{}),frequency:r.units/10000,evBb:null}));
}
function v2Mix(spot,hand) {
  if(spot.context==='rfi-unopened') {
    const p=spot.position.toLowerCase();
    const early=spot.seated===8?{utg:.65,utg1:.80,lj:1}:spot.seated===9?{utg:.50,utg1:.65,utg2:.80,lj:1}:{};
    const base=rfiMix(Object.hasOwn(early,p)?'utg':p,hand);
    let raise=(base.find(a=>a.action==='raise')?.frequency??0)*(early[p]??1);
    if(Object.hasOwn(early,p)&&['AA','KK','QQ','AKs','AKo'].includes(hand))raise=1;
    return unitsMix(raise,0,2.5);
  }
  if(['AA','KK','QQ'].includes(hand))return unitsMix(1,0,8.5);
  const base=vsRaiseMix(hand);const factor=FACTORS[spot.openerPosition];
  const order=['SB','BB',...PREFLOP_ORDERS[spot.seated].filter(p=>!['SB','BB'].includes(p))];
  const oop=order.indexOf(spot.position)<order.indexOf(spot.openerPosition);
  return unitsMix((base.find(a=>a.action==='raise')?.frequency??0)*factor,
    (base.find(a=>a.action==='call')?.frequency??0)*factor*(oop?.85:1),8.5);
}
export function buildBaseline(version=2) {
  if(![1,2].includes(version))throw new Error('unsupported baseline version');
  const classes=allHandClasses();const spots={};
  if(version===1){
    for(const pos of ['utg','hj','co','btn','sb'])spots[`6max-100bb-${pos}-rfi-unopened`]=Object.fromEntries(classes.map(hand=>[hand,rfiMix(pos,hand)]));
    for(const pos of ['bb','sb','btn'])spots[`6max-100bb-${pos}-vs-single-raise`]=Object.fromEntries(classes.map(hand=>[hand,vsRaiseMix(hand)]));
  }else for(const key of preflopKeys())spots[key]=Object.fromEntries(classes.map(hand=>[hand,v2Mix(parsePreflopKey(key),hand)]));
  return {schemaVersion:version,id:'local-preflop-baseline',version:`${version}.0.0`,license:'Apache-2.0',
    tree:{rfiBb:2.5,threeBetBb:8.5},methodology:METHOD,
    ...(version===2?{recipeVersion:'original-v2.0.0',capabilities:{mode:'cash-training',seated:[6,8,9],stackBb:100,projectedStackBb:[80,120],projectedOpenBb:[2,3],projectedThreeBetBb:[6.5,10.5]}}:{}),spots};
}
function main(argv){
  let version=2,dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../training/data'),check=false;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--version')version=Number(argv[++i]);
    else if(argv[i]==='--out-dir'){dir=argv[++i];if(!path.isAbsolute(dir??''))throw new Error('--out-dir requires an absolute directory');}
    else if(argv[i]==='--check')check=true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const body=`${JSON.stringify(buildBaseline(version))}\n`;
  const digest=createHash('sha256').update(body).digest('hex');
  const out=path.join(dir,`preflop-baseline-v${version}.json`),pin=out.replace(/\.json$/,'.sha256');
  if(check){
    if(fs.readFileSync(out,'utf8')!==body||fs.readFileSync(pin,'utf8').trim()!==digest)throw new Error('baseline bytes or digest differ');
  }else{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(out,body);fs.writeFileSync(pin,`${digest}\n`);}
  process.stdout.write(`${JSON.stringify({version,digest,check})}\n`);
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2));
