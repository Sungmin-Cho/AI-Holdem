import { projectAssistance } from '../shared/assistance.js';
import {dealSelectionFields} from '../shared/deal-selection.js';
import { assertSnapshot, coded, evaluationIdOf } from './contracts.js';
import { handClassOf } from './cards.js';
import { lookup } from './providers/preflop-json.js';
import { PREFLOP_ORDERS, trainingPositionV2 } from '../shared/preflop-key.js';
import { referenceQuality, referenceSizeMatches } from '../shared/reference.js';

const MINTED = new WeakMap();
export const COVERAGE_REASONS = Object.freeze(['MODE_UNSUPPORTED','SEAT_COUNT_UNSUPPORTED','POSITION_INVALID',
  'STACK_OUT_OF_RANGE','UNSUPPORTED_STACK_CONFIGURATION','LIMP_OR_CALLER','FOUR_BET_PLUS',
  'FACING_SIZE_OUT_OF_RANGE','CHOICE_SIZE_OUT_OF_RANGE','DATASET_SPOT_MISSING','REFERENCE_ACTION_ILLEGAL',
  'STACK_PROJECTED','FACING_SIZE_PROJECTED','CHOICE_SIZE_PROJECTED']);
const chips = n => Number.isSafeInteger(n) && n >= 0;
const id = s => typeof s === 'string' && s.length > 0 && s.length <= 200;
const freeze = o => { if(o && typeof o==='object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
const bad = field => { throw coded('SNAPSHOT_INVALID', field); };
const sortedReasons = reasons => COVERAGE_REASONS.filter(r=>reasons.includes(r));

// Explicit observation projection: chosenAction, outcomes and hidden opponent data
// are intentionally never read, including when establishing comparison identity.
function observation(s) {
  assertSnapshot(s);
  if(s.schemaVersion!==2 || !id(s.actorId) || !id(s.decisionId) || typeof s.gameMode!=='string'
    || typeof s.street!=='string' || typeof s.forced!=='boolean') bad('schema2 identity');
  if(!handClassOf(s.holeCards) || s.holeCards[0].toLowerCase()===s.holeCards[1].toLowerCase()) bad('hole cards');
  if(!Array.isArray(s.blinds) || s.blinds.length!==2 || !s.blinds.every(chips) || !s.blinds[1]) bad('blinds');
  for(const k of ['handNo','potBefore','currentBet','actorBet','toCall','minRaiseTo','maxRaiseTo','effectiveStack']) if(!chips(s[k])) bad(k);
  if(!Array.isArray(s.publicSeats) || s.publicSeats.length>10 || !Array.isArray(s.priorActions) || s.priorActions.length>1000) bad('public context');
  const seats=s.publicSeats.map(p=>{
    if(!p || !id(p.playerId) || !['stack','bet','contribution'].every(k=>chips(p[k]))
      || !['out','folded','allIn'].every(k=>typeof p[k]==='boolean')
      || (!p.out && typeof p.position!=='string') || !chips(p.stack+p.contribution)) bad('public seat');
    return Object.fromEntries(['playerId','position','stack','bet','contribution','folded','allIn','out'].map(k=>[k,p[k]]));
  });
  if(new Set(seats.map(p=>p.playerId)).size!==seats.length) bad('duplicate seat');
  const priors=s.priorActions.map(a=>{
    if(!a || !id(a.playerId) || !id(a.decisionId) || !['fold','check','call','raise','bet'].includes(a.action)
      || !chips(a.amount) || typeof a.street!=='string' || !seats.some(p=>p.playerId===a.playerId)) bad('prior action');
    return {playerId:a.playerId,decisionId:a.decisionId,action:a.action,amount:a.amount,street:a.street};
  });
  return {schemaVersion:2,decisionId:s.decisionId,gameMode:s.gameMode,handNo:s.handNo,actorId:s.actorId,
    street:s.street,position:s.position,holeCards:[...s.holeCards],blinds:[...s.blinds],potBefore:s.potBefore,
    currentBet:s.currentBet,actorBet:s.actorBet,toCall:s.toCall,minRaiseTo:s.minRaiseTo,maxRaiseTo:s.maxRaiseTo,
    effectiveStack:s.effectiveStack,forced:s.forced,publicSeats:seats,priorActions:priors,
    legal:{decisionId:s.legal.decisionId,canCheck:s.legal.canCheck,canRaise:s.legal.canRaise,
      callAmount:s.legal.callAmount,minRaiseTo:s.legal.minRaiseTo,maxRaiseTo:s.legal.maxRaiseTo}};
}

export function resolvePreflopReference(snapshot, dataset) {
  const s=observation(snapshot);
  // lookup authenticates the parser's object identity even on unsupported input.
  const source=lookup(dataset,{spotKey:'',handClass:''}).source;
  if(dataset.data.schemaVersion!==2) throw coded('DATASET_INVALID','v2 reference API requires v2 data');
  if(referenceQuality(source).quality!=='heuristic-reference')throw coded('SOURCE_UNAVAILABLE','v2 reference source is not registered');
  const reasons=[];
  const fail=(code,coverage=null)=>{
    if(coverage)coverage.reasonCodes=sortedReasons([...coverage.reasonCodes.filter(r=>!r.endsWith('_PROJECTED')),code]);
    return finish({status:'unsupported',decisionId:s.decisionId,spot:null,actions:[],source,code,reason:code,coverage});
  };
  const finish=r=>{freeze(r);MINTED.set(r,JSON.stringify(s));return r;};
  if(s.street!=='preflop')return fail('UNSUPPORTED_SPOT');
  const live=s.publicSeats.filter(p=>!p.out),order=PREFLOP_ORDERS[live.length];
  if(s.gameMode!=='cash-training')reasons.push('MODE_UNSUPPORTED');
  if(!order)reasons.push('SEAT_COUNT_UNSUPPORTED');
  if(reasons.length)return fail(reasons[0]);
  const positions=live.map(p=>trainingPositionV2(p.position,live.length));
  const hero=live.find(p=>p.playerId===s.actorId);
  if(!hero || hero.folded || hero.allIn || positions.some(p=>!p) || new Set(positions).size!==order.length
    || hero.position!==s.position || hero.bet!==s.actorBet)bad('actor/topology');
  const position=trainingPositionV2(s.position,live.length),heroIndex=order.indexOf(position);
  const priors=s.priorActions;
  const raises=priors.filter(a=>a.action==='raise');
  if(priors.some(a=>a.action==='call'))reasons.push('LIMP_OR_CALLER');
  if(raises.length>1)reasons.push('FOUR_BET_PLUS');
  const opener=raises.length===1?live.find(p=>p.playerId===raises[0].playerId):null;
  const openerPosition=opener?trainingPositionV2(opener.position,live.length):null;
  // The supported tree is the first orbit, with every earlier actor represented.
  if(priors.length!==heroIndex || priors.some((a,i)=>a.street!=='preflop'
    || trainingPositionV2(live.find(p=>p.playerId===a.playerId)?.position,live.length)!==order[i]
    || !['fold','raise'].includes(a.action)) || (opener && order.indexOf(openerPosition)>=heroIndex)) {
    if(!reasons.includes('LIMP_OR_CALLER')&&!reasons.includes('FOUR_BET_PLUS')) reasons.push('POSITION_INVALID');
  }
  if(!raises.length && position==='BB')reasons.push('DATASET_SPOT_MISSING');
  if(raises.length===1 && (!opener || opener.folded))bad('opener');
  const bb=s.blinds[1],total=p=>p.stack+p.contribution;
  const opponents=live.filter(p=>p.playerId!==s.actorId&&!p.folded);
  const rawExpected=opponents.length?Math.max(...opponents.map(p=>Math.min(total(hero),total(p)))):total(hero);
  const computed=opener?Math.min(total(hero),total(opener)):rawExpected;
  if(rawExpected!==s.effectiveStack)bad('effective stack');
  if(opponents.some(p=>total(p)!==total(hero)))reasons.push('UNSUPPORTED_STACK_CONFIGURATION');
  const stackBb=computed/bb;
  if(stackBb<80||stackBb>120)reasons.push('STACK_OUT_OF_RANGE');
  else if(stackBb!==100)reasons.push('STACK_PROJECTED');
  const facing=opener?raises[0].amount:null;
  if(facing!==null && !referenceSizeMatches(facing/bb,2.5)) {
    reasons.push(facing/bb>=2&&facing/bb<=3?'FACING_SIZE_PROJECTED':'FACING_SIZE_OUT_OF_RANGE');
  }
  const input={bbChips:bb,seated:live.length,position,openerPosition,rawEffectiveStackChips:s.effectiveStack,
    computedEffectiveStackChips:computed,heroTotalChips:total(hero),openerTotalChips:opener?total(opener):null,
    opponentTotals:opponents.map(p=>({playerId:p.playerId,totalChips:total(p)})).sort((a,b)=>a.playerId<b.playerId?-1:1),
    effectiveStackBb:stackBb,facingRaiseToChips:facing,facingRaiseToBb:facing===null?null:facing/bb,
    chosenRaiseToChips:null,chosenRaiseToBb:null,legal:{canCheck:s.legal.canCheck,canRaise:s.legal.canRaise,
      actorBetChips:s.actorBet,callAmountChips:s.toCall,minRaiseToChips:s.minRaiseTo,maxRaiseToChips:s.maxRaiseTo}};
  const coverage={schemaVersion:1,referenceMatch:'unsupported',choiceMatch:'not-observed',metricEligible:false,
    reasonCodes:sortedReasons(reasons),input,reference:null,policyVersion:'preflop-projection-v1'};
  const blockers=reasons.filter(r=>!r.endsWith('_PROJECTED'));
  if(blockers.length)return fail(sortedReasons(blockers)[0],coverage);
  if(s.decisionId!==`d-${s.handNo}-preflop-${priors.length}`
    ||priors.some((a,i)=>a.decisionId!==`d-${s.handNo}-preflop-${i}`))bad('decision chronology');
  const expectedBet=opener?facing:bb;
  if(s.currentBet!==expectedBet||s.toCall!==expectedBet-hero.bet||s.maxRaiseTo!==hero.stack+hero.bet
    ||s.potBefore!==live.reduce((n,p)=>n+p.contribution,0))bad('public chip accounting');
  for(const p of live){
    const prior=priors.find(a=>a.playerId===p.playerId),pos=trainingPositionV2(p.position,live.length);
    const expected=prior?.action==='raise'?prior.amount:pos==='SB'?s.blinds[0]:pos==='BB'?bb:0;
    if(p.bet!==expected||p.contribution!==expected||p.folded!==(prior?.action==='fold')
      ||(prior?.action==='fold'&&prior.amount!==0))bad('prior/seat accounting');
  }
  const key=opener?`${live.length}max-100bb-${position.toLowerCase()}-vs-${openerPosition.toLowerCase()}-open25-v2`
    :`${live.length}max-100bb-${position.toLowerCase()}-rfi-v2`;
  const strategy=lookup(dataset,{spotKey:key,handClass:handClassOf(s.holeCards)});
  if(strategy.status!=='supported')return fail('DATASET_SPOT_MISSING',coverage);
  let sizing=null;
  for(const a of strategy.actions) {
    let legal=true;
    if(a.action==='raise') {
      const amount=Math.round(a.sizeBb*bb);
      legal=s.legal.canRaise && amount>=s.minRaiseTo && amount<=s.maxRaiseTo && referenceSizeMatches(amount/bb,a.sizeBb);
      sizing={action:'raise',intendedSizeBb:a.sizeBb,raiseToChips:amount,representedSizeBb:amount/bb};
    } else if(a.action==='call') legal=!s.legal.canCheck && s.toCall>0 && s.toCall<hero.stack;
    else if(a.action==='fold') legal=!s.legal.canCheck;
    else legal=false;
    if(!legal){coverage.reasonCodes=sortedReasons([...reasons,'REFERENCE_ACTION_ILLEGAL']);return fail('REFERENCE_ACTION_ILLEGAL',coverage);}
  }
  coverage.referenceMatch=reasons.some(r=>r.endsWith('_PROJECTED'))?'projected':'exact';
  coverage.reference={seated:live.length,stackBb:100,openRaiseToBb:2.5,threeBetRaiseToBb:8.5,sizing};
  return finish({status:'supported',decisionId:s.decisionId,
    spot:{spotKey:key,position,openerPosition,context:opener?'vs-single-raise':'rfi-unopened'},
    actions:strategy.actions,source,coverage});
}

export function comparePreflopChoice(snapshot, reference) {
  if(!MINTED.has(reference)||MINTED.get(reference)!==JSON.stringify(observation(snapshot))) {
    throw coded('REFERENCE_CONTEXT_MISMATCH','Reference was not resolved for this observation');
  }
  const a=snapshot.chosenAction;
  if(!a || !['fold','check','call','raise'].includes(a.action) || !chips(a.amount)
    ||(['fold','check'].includes(a.action)&&a.amount!==0))bad('chosen action');
  const coverage=reference.coverage?structuredClone(reference.coverage):null;
  const chosen={action:a.action,...(a.action==='raise'?{sizeBb:a.amount/snapshot.blinds[1]}:{}),frequency:null,evBb:null};
  if(coverage && a.action==='raise') {
    coverage.input.chosenRaiseToChips=a.amount;coverage.input.chosenRaiseToBb=chosen.sizeBb;
  }
  if(!coverage || reference.status!=='supported')return {chosen,grade:null,coverage};
  const l=coverage.input.legal;
  const choiceLegal=a.action==='raise'?l.canRaise&&a.amount>=l.minRaiseToChips&&a.amount<=l.maxRaiseToChips
    :a.action==='check'?l.canCheck:a.action==='call'?!l.canCheck&&l.callAmountChips>0:!l.canCheck;
  if(!choiceLegal)bad('illegal chosen action');
  coverage.choiceMatch='exact';
  if(a.action==='raise') {
    coverage.input.chosenRaiseToChips=a.amount;coverage.input.chosenRaiseToBb=chosen.sizeBb;
    const native=reference.spot.openerPosition?8.5:2.5;
    if(!referenceSizeMatches(chosen.sizeBb,native)) {
      const [lo,hi]=native===2.5?[2,3]:[6.5,10.5];
      coverage.choiceMatch=chosen.sizeBb>=lo&&chosen.sizeBb<=hi?'projected':'unavailable';
      coverage.reasonCodes=sortedReasons([...coverage.reasonCodes,
        coverage.choiceMatch==='projected'?'CHOICE_SIZE_PROJECTED':'CHOICE_SIZE_OUT_OF_RANGE']);
    }
  }
  coverage.metricEligible=coverage.referenceMatch==='exact'&&coverage.choiceMatch==='exact'&&!snapshot.forced;
  let grade=null;
  if(coverage.metricEligible) {
    const frequency=reference.actions.find(r=>r.action===a.action)?.frequency??0;
    chosen.frequency=frequency;
    const max=Math.max(...reference.actions.map(r=>r.frequency));
    grade=frequency===0?'off-policy':frequency===max||frequency>=.5?'preferred':frequency>=.1?'mixed':'low-frequency';
  }
  return {chosen,grade,coverage};
}

export function evaluatePreflopReference(snapshot,dataset,{gameEpoch}={}) {
  const ref=resolvePreflopReference(snapshot,dataset),comparison=comparePreflopChoice(snapshot,ref);
  return {schemaVersion:1,evaluationId:evaluationIdOf({gameEpoch:gameEpoch??'unknown-epoch',decisionId:snapshot.decisionId,
    providerId:ref.source.id,providerVersion:ref.source.version}),decisionId:snapshot.decisionId,status:ref.status,
    street:snapshot.street,spotKey:ref.spot?.spotKey??null,handClass:handClassOf(snapshot.holeCards),
    recommended:[...ref.actions].sort((a,b)=>b.frequency-a.frequency||a.action.localeCompare(b.action)),
    chosen:comparison.chosen,bestEvBb:null,evLossBb:null,grade:comparison.grade,forced:snapshot.forced,
    ...(ref.code?{code:ref.code,reason:ref.reason}:{}),source:ref.source,coverage:comparison.coverage,
    ...(snapshot.assistance !== undefined ? {assistance:projectAssistance(snapshot.assistance)} : {}),...dealSelectionFields(snapshot)};
}
