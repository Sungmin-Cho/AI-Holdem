import {referenceQuality, referenceSizeMatches, sameReferenceSource} from './reference.js';
const REASONS=['MODE_UNSUPPORTED','SEAT_COUNT_UNSUPPORTED','POSITION_INVALID','STACK_OUT_OF_RANGE',
 'UNSUPPORTED_STACK_CONFIGURATION','LIMP_OR_CALLER','FOUR_BET_PLUS','FACING_SIZE_OUT_OF_RANGE',
 'CHOICE_SIZE_OUT_OF_RANGE','DATASET_SPOT_MISSING','REFERENCE_ACTION_ILLEGAL',
 'STACK_PROJECTED','FACING_SIZE_PROJECTED','CHOICE_SIZE_PROJECTED'];
const keys=(o,list)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===list.length&&list.every(k=>Object.hasOwn(o,k));
const chips=n=>Number.isSafeInteger(n)&&n>=0;
const ratio=(n,d,value)=>Number.isFinite(value)&&Math.abs(n/d-value)<=Number.EPSILON*Math.max(1,Math.abs(n/d))*8;
function invalid(){const e=new Error('Invalid reference coverage');e.code='REFERENCE_COVERAGE_INVALID';throw e;}
/** Closed, deterministic public projection. Authority must additionally bind this
 * observation to the completed engine decision; this validator is not that proof. */
export function projectReferenceCoverage(c) {
 if(c===null)return null;
 if(!keys(c,['schemaVersion','referenceMatch','choiceMatch','metricEligible','reasonCodes','input','reference','policyVersion'])
  ||c.schemaVersion!==1||c.policyVersion!=='preflop-projection-v1'
  ||!['exact','projected','unsupported'].includes(c.referenceMatch)
  ||!['exact','projected','unavailable','not-observed'].includes(c.choiceMatch)||typeof c.metricEligible!=='boolean'
  ||!Array.isArray(c.reasonCodes)||JSON.stringify(c.reasonCodes)!==JSON.stringify(REASONS.filter(r=>c.reasonCodes.includes(r))))invalid();
 const i=c.input;
 if(!keys(i,['bbChips','seated','position','openerPosition','rawEffectiveStackChips','computedEffectiveStackChips',
 'heroTotalChips','openerTotalChips','opponentTotals','effectiveStackBb','facingRaiseToChips','facingRaiseToBb',
 'chosenRaiseToChips','chosenRaiseToBb','legal'])||!chips(i.bbChips)||!i.bbChips||![6,8,9].includes(i.seated)
 ||typeof i.position!=='string'||!(i.openerPosition===null||typeof i.openerPosition==='string'))invalid();
 for(const k of ['rawEffectiveStackChips','computedEffectiveStackChips','heroTotalChips'])if(!chips(i[k]))invalid();
 if(!ratio(i.computedEffectiveStackChips,i.bbChips,i.effectiveStackBb))invalid();
 for(const [chip,bb] of [['facingRaiseToChips','facingRaiseToBb'],['chosenRaiseToChips','chosenRaiseToBb']]) {
  if(i[chip]===null?i[bb]!==null:!chips(i[chip])||!ratio(i[chip],i.bbChips,i[bb]))invalid();
 }
 if(i.openerPosition===null?i.openerTotalChips!==null||i.facingRaiseToChips!==null
   :!chips(i.openerTotalChips)||i.facingRaiseToChips===null)invalid();
 if(!Array.isArray(i.opponentTotals)||i.opponentTotals.length>8)invalid();
 let prev='';for(const p of i.opponentTotals){
  if(!keys(p,['playerId','totalChips'])||typeof p.playerId!=='string'||!p.playerId||p.playerId.length>200||p.playerId<=prev||!chips(p.totalChips))invalid();prev=p.playerId;
 }
 const l=i.legal;
 if(!keys(l,['canCheck','canRaise','actorBetChips','callAmountChips','minRaiseToChips','maxRaiseToChips'])
  ||typeof l.canCheck!=='boolean'||typeof l.canRaise!=='boolean'
  ||!['actorBetChips','callAmountChips','minRaiseToChips','maxRaiseToChips'].every(k=>chips(l[k]))
  ||l.canCheck!==(l.callAmountChips===0))invalid();
 if(c.referenceMatch==='unsupported') {if(c.reference!==null||c.metricEligible)invalid();}
 else {
  const r=c.reference;
  if(!keys(r,['seated','stackBb','openRaiseToBb','threeBetRaiseToBb','sizing'])||r.seated!==i.seated
   ||r.stackBb!==100||r.openRaiseToBb!==2.5||r.threeBetRaiseToBb!==8.5)invalid();
  if(i.effectiveStackBb<80||i.effectiveStackBb>120||i.opponentTotals.some(p=>p.totalChips!==i.heroTotalChips)
   ||i.computedEffectiveStackChips!==i.heroTotalChips||i.rawEffectiveStackChips!==i.heroTotalChips)invalid();
  if(i.facingRaiseToBb!==null && !(referenceSizeMatches(i.facingRaiseToBb,2.5)||(i.facingRaiseToBb>=2&&i.facingRaiseToBb<=3)))invalid();
  const projected=i.effectiveStackBb!==100||(i.facingRaiseToBb!==null&&!referenceSizeMatches(i.facingRaiseToBb,2.5));
  if(c.referenceMatch!==(projected?'projected':'exact'))invalid();
  if(r.sizing!==null) {
   const z=r.sizing,target=i.openerPosition===null?2.5:8.5;
   if(!keys(z,['action','intendedSizeBb','raiseToChips','representedSizeBb'])||z.action!=='raise'||z.intendedSizeBb!==target
    ||!chips(z.raiseToChips)||z.raiseToChips!==Math.round(target*i.bbChips)||!ratio(z.raiseToChips,i.bbChips,z.representedSizeBb)
    ||!referenceSizeMatches(z.representedSizeBb,target)||!l.canRaise||z.raiseToChips<l.minRaiseToChips||z.raiseToChips>l.maxRaiseToChips)invalid();
  }
  if(c.choiceMatch!=='not-observed') {
   let expected='exact';
   if(i.chosenRaiseToBb!==null&&!referenceSizeMatches(i.chosenRaiseToBb,i.openerPosition===null?2.5:8.5)) {
    const [lo,hi]=i.openerPosition===null?[2,3]:[6.5,10.5];expected=i.chosenRaiseToBb>=lo&&i.chosenRaiseToBb<=hi?'projected':'unavailable';
   }
   if(c.choiceMatch!==expected)invalid();
  }else if(i.chosenRaiseToChips!==null)invalid();
  const expectedReasons=[];
  if(i.effectiveStackBb!==100)expectedReasons.push('STACK_PROJECTED');
  if(i.facingRaiseToBb!==null&&!referenceSizeMatches(i.facingRaiseToBb,2.5))expectedReasons.push('FACING_SIZE_PROJECTED');
  if(c.choiceMatch==='projected')expectedReasons.push('CHOICE_SIZE_PROJECTED');
  if(c.choiceMatch==='unavailable')expectedReasons.push('CHOICE_SIZE_OUT_OF_RANGE');
  if(JSON.stringify(c.reasonCodes)!==JSON.stringify(REASONS.filter(r=>expectedReasons.includes(r))))invalid();
 }
 if(c.metricEligible&&(c.referenceMatch!=='exact'||c.choiceMatch!=='exact'))invalid();
 // Stable field order; a JSON clone also detaches the publication from callers.
 return {schemaVersion:1,referenceMatch:c.referenceMatch,choiceMatch:c.choiceMatch,metricEligible:c.metricEligible,
 reasonCodes:[...c.reasonCodes],input:{bbChips:i.bbChips,seated:i.seated,position:i.position,openerPosition:i.openerPosition,
 rawEffectiveStackChips:i.rawEffectiveStackChips,computedEffectiveStackChips:i.computedEffectiveStackChips,
 heroTotalChips:i.heroTotalChips,openerTotalChips:i.openerTotalChips,opponentTotals:i.opponentTotals.map(p=>({...p})),
 effectiveStackBb:i.effectiveStackBb,facingRaiseToChips:i.facingRaiseToChips,facingRaiseToBb:i.facingRaiseToBb,
 chosenRaiseToChips:i.chosenRaiseToChips,chosenRaiseToBb:i.chosenRaiseToBb,legal:{...l}},
 reference:c.reference===null?null:{...c.reference,sizing:c.reference.sizing===null?null:{...c.reference.sizing}},policyVersion:c.policyVersion};
}
export function referenceAssessmentEligibility(e) {
 const source=e?.source??e?.sourceIdentity??e?.mixObservation?.sourceIdentity;
 if(referenceQuality(source).quality!=='heuristic-reference')return {verified:false,referenceAvailable:false,metricEligible:false,reason:'SOURCE_IDENTITY_UNVERIFIED'};
 if(source.version==='1.0.0')return {verified:true,referenceAvailable:e.status==='supported'&&!e.forced,metricEligible:e.status==='supported'&&!e.forced,reason:null};
 try {
  if(!Object.hasOwn(e,'coverage'))invalid();
  const c=projectReferenceCoverage(e.coverage);
  if(e.status==='supported' && (!c||c.referenceMatch==='unsupported'))invalid();
  const available=e.status==='supported'&&!e.forced;
  const eligible=available&&c?.referenceMatch==='exact'&&c?.choiceMatch==='exact';
  if(c&&c.metricEligible!==eligible)invalid();
  if(c&&e.chosen){
   if(e.chosen.action==='raise'?e.chosen.sizeBb!==c.input.chosenRaiseToBb:c.input.chosenRaiseToChips!==null)invalid();
   if(!eligible&&(e.grade!=null||e.chosen.frequency!=null))invalid();
  }
  const actions=e.recommended??e.mixObservation?.referenceActions;
  const choice=e.chosen??e.mixObservation?.chosenAction;
  if(e.mixObservation&&!sameReferenceSource(e.mixObservation.sourceIdentity,source))invalid();
  if(eligible){
   if(!Array.isArray(actions)||!actions.length||actions.length>3||!choice)invalid();
   const seen=new Set();let sum=0;
   for(const a of actions){
    if(!['fold','call','raise'].includes(a.action)||seen.has(a.action)||!Number.isFinite(a.frequency)||a.frequency<=0||a.frequency>1||a.evBb!=null)invalid();
    seen.add(a.action);sum+=a.frequency;
    if(a.action==='raise' ? a.sizeBb!==(c.input.openerPosition===null?2.5:8.5)||!c.reference.sizing
      :a.sizeBb!==undefined)invalid();
    if(a.action==='call'&&(c.input.openerPosition===null||c.input.legal.canCheck))invalid();
   }
   if(Math.abs(sum-1)>1e-9||!['fold','call','raise'].includes(choice.action))invalid();
   if(choice.action==='raise'&&!referenceSizeMatches(choice.sizeBb,c.input.openerPosition===null?2.5:8.5))invalid();
   const f=actions.find(a=>a.action===choice.action)?.frequency??0;
   const max=Math.max(...actions.map(a=>a.frequency));
   const grade=f===0?'off-policy':f===max||f>=.5?'preferred':f>=.1?'mixed':'low-frequency';
   if(e.grade!==grade||(choice.frequency!==undefined&&choice.frequency!==f))invalid();
  }
  return {verified:true,referenceAvailable:available,metricEligible:eligible,reason:null};
 }catch{return {verified:false,referenceAvailable:false,metricEligible:false,reason:'REFERENCE_COVERAGE_INVALID'};}
}
