import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gateSessions,hopeless,chen,isPremium,effectiveRemainingAt,runCap,mayRerun,MIN_DECISIONS} from './helpers/jev-gate.mjs';
import {selectJevAction} from '../tools/jev-player.js';

const players=[{playerId:'user'},{playerId:'p1',archetype:'TAG'},{playerId:'p2',archetype:'Nit'}];
const cards=text=>text.split(' ');
function action(playerId,act,{street='preflop',amount=0,callAmount=50,maxRaiseTo=5000,stacks={user:5000,p1:5000,p2:5000},board=[],decisionId}){
 return {decisionId,playerId,action:act,amount,street,callAmount,minRaiseTo:100,maxRaiseTo,currentBet:50,board,stacks};
}
function hand(handNo,actions,{holes={user:cards('2c 3d'),p1:cards('9c 8d'),p2:cards('7c 2d')},endStacks={user:5000,p1:5000,p2:5000},posts=[]}={}){
 return {handNo,blinds:[25,50],holes,posts,actions,endStacks,startStacks:{user:5000,p1:5000,p2:5000}};
}
// n clean decisions: each AI action is exactly what the recorded selection chose.
function cleanRun(name,n=MIN_DECISIONS,{mode='cash-training',hands:handsOut=[],entries:entriesOut=[],metrics:metricsOut=[]}={}){
 const hands=[],entries=[],metrics=[];
 for(let i=1;i<=n;i++){
  const decisionId=`d-${i}-preflop-0`,probabilities={fold:0.5,call:0.5},unit=(i%10)/10+0.05;
  const selected=selectJevAction({probabilities,candidates:[{key:'fold',action:'fold'},{key:'call',action:'call'}],unit,apiChoice:'fold'});
  hands.push(hand(i,[action('p1',selected.action.action,{decisionId,amount:selected.action.action==='call'?50:0})]));
  entries.push({decisionId,generation:1,probabilities,apiChoice:'fold',selection:selected.selection,usage:{input_tokens:10,output_tokens:1}});
  metrics.push({runtime:'jev',decisionId,outcome:'jev_accepted',modelMs:200+i});
 }
 return {name,mode,players,hands:[...hands,...handsOut],loopState:{jevDiagnostics:{schemaVersion:1,entries:[...entries,...entriesOut],dropped:0},metrics:[...metrics,...metricsOut]}};
}

test('hopeless hands: made hands with hole cards, draws on flop/turn and two overcards are excluded',()=>{
 const h=(hole,board,street)=>hopeless(cards(hole),cards(board),street);
 assert.equal(h('Ad Kc','7s 7h 2c','flop'),false,'two overcards');
 assert.equal(h('Kh 9c','Js 7d 2s','flop'),true,'one overcard, no draw');
 assert.equal(h('Ad Kc','Qs Jh Tc','flop'),false,'made straight');
 assert.equal(h('Ah 3h','Kh 8h 2c 7d Js','river'),true,'missed flush on the river');
 assert.equal(h('Ah 3h','Kh 8h 2c 7d','turn'),false,'flush draw on the turn');
 assert.equal(h('9c 8d','Qs Jh 2c','flop'),false,'gutshot');
 assert.equal(h('9c 4d','Ks Kh 2c','flop'),true,'board pair only');
 assert.equal(h('9c 4d','Ks Kh Kc 2d 7s','river'),true,'board trips without the hole cards');
 assert.equal(h('Kd 4d','Ks 9h 2c','flop'),false,'pair made with a hole card');
 assert.equal(h('2c 2d','Ks Kh Qs Qh 8c','river'),true,'pocket pair counterfeited by the board two pair');
 assert.equal(h('Ac 5c','2s Kc 9s','flop'),true,'control pattern');
});
test('Chen boundary fixtures and the premium set',()=>{
 for(const [hole,score] of [['As Ah',20],['Ad Kc',10],['Ts Th',10],['9c 8d',6],['Qc 9d',5],['7c 2d',-1],['Ks 8s',5],['Js 6d',1],['2c 2d',5],['Ah Kh',12]])assert.equal(chen(cards(hole)),score,hole);
 assert.equal(hopeless(cards('9c 8d'),[],'preflop'),false);assert.equal(hopeless(cards('Qc 9d'),[],'preflop'),true);
 for(const hole of ['As Ad','Kc Kd','Qs Qh','Jc Jd','Ts Td','As Ks','Ad Kc'])assert.equal(isPremium(cards(hole)),true,hole);
 for(const hole of ['As Qs','9c 9d','Ah Qd'])assert.equal(isPremium(cards(hole)),false,hole);
});
test('effective remaining counts an all-in opponent bet and ignores folded seats',()=>{
 const shove=hand(1,[action('p2','raise',{decisionId:'d-1-preflop-0',amount:5000,maxRaiseTo:5000}),action('p1','call',{decisionId:'d-1-preflop-1',callAmount:5000,stacks:{user:5000,p1:5000,p2:0}})]);
 assert.equal(effectiveRemainingAt(shove,1),5000);
 const folded=hand(1,[action('p2','fold',{decisionId:'d-1-preflop-0'}),action('p1','call',{decisionId:'d-1-preflop-1',stacks:{user:750,p1:5000,p2:5000}})],{posts:[{playerId:'user',amount:50}]});
 // p2 folded; user covers 750 + 50 posted.
 assert.equal(effectiveRemainingAt(folded,1),800);
});
test('a clean run passes; count cross-check tolerates single-legal metrics and a retried generation',()=>{
 const base=cleanRun('A');
 // Generation 1 left an entry that was never applied; generation 2 is the applied one.
 const retried=base.loopState.jevDiagnostics.entries[0];retried.generation=2;
 base.loopState.jevDiagnostics.entries.unshift({...retried,generation:1,selection:{...retried.selection,selectedKey:retried.selection.selectedKey==='fold'?'call':'fold'}});
 base.loopState.metrics.push({runtime:'jev',decisionId:'d-x-single',outcome:'jev_single_legal'});
 const result=gateSessions([base]);
 assert.equal(result.perRun[0].one.pass,true,JSON.stringify(result.perRun[0].one.reasons));assert.equal(result.perRun[0].one.decisions,MIN_DECISIONS);
 assert.equal(result.perRun[0].pass,true);
});
test('failures, truncation, missing samples and v1 entries make the run unjudgeable',()=>{
 const failed=cleanRun('F');failed.loopState.metrics.push({runtime:'jev',decisionId:'d-9-flop-2',outcome:'JEV_TIMEOUT'});
 const truncated=cleanRun('T');truncated.loopState.jevDiagnostics.historyIncomplete=true;
 const dropped=cleanRun('D');dropped.loopState.jevDiagnostics.dropped=3;
 const small=cleanRun('S',MIN_DECISIONS-1);
 const v1=cleanRun('V');v1.loopState.jevDiagnostics.entries.push({decisionId:'d-0-preflop-0',generation:1,probabilities:{fold:0,call:1}});
 const [f,t,d,s,v]=gateSessions([failed,truncated,dropped,small,v1]).perRun;
 for(const run of [f,t,d,s,v])assert.equal(run.one.pass,false,run.name);
 assert.ok(v.one.reasons.includes('v1 — ① 미적용'));assert.equal(v.one.incomplete,1);
});
test('an entry of an unfinished hand is reported as incomplete and left out of the count',()=>{
 const run=cleanRun('I',MIN_DECISIONS,{entries:[{decisionId:'d-999-flop-3',generation:1,probabilities:{check:1},apiChoice:'check',selection:{rule:'class-sample-v1',unit:0.5,classMass:{check:1},pruned:[],sampled:'check',sizeRule:'weighted-median',selectedKey:'check',apiChoice:'check'}}],
  metrics:[{runtime:'jev',decisionId:'d-999-flop-3',outcome:'jev_accepted'}]});
 const [r]=gateSessions([run]).perRun;assert.equal(r.one.pass,true,JSON.stringify(r.one.reasons));assert.equal(r.one.incomplete,1);
 const broken=cleanRun('B');broken.hands[0].actions[0].action=broken.hands[0].actions[0].action==='fold'?'call':'fold';
 assert.equal(gateSessions([broken]).perRun[0].one.pass,false,'an applied action that differs from the selection');
});
test('deep hopeless all-ins, premium folds and early tournament busts fail their checks',()=>{
 const shove=cleanRun('C',MIN_DECISIONS,{mode:'tournament',hands:[hand(200,[
  action('p1','raise',{street:'flop',decisionId:'d-200-flop-0',amount:2600,maxRaiseTo:2600,board:cards('2s Kc 9s'),stacks:{user:2600,p1:2600,p2:5000}})],
  {holes:{user:cards('2c 3d'),p1:cards('Ac 5c'),p2:cards('7c 2d')}})]});
 // 52bb shove with Ac5c on 2s Kc 9s: deep (52bb > 40bb) and hopeless.
 const [c]=gateSessions([shove]).perRun;assert.equal(c.two.pass,false);assert.deepEqual(c.two.violations,['d-200-flop-0']);assert.ok(c.two.opportunities>=1);
 const aces={holes:{user:cards('2c 3d'),p1:cards('As Ah'),p2:cards('7c 2d')}};
 const premium=cleanRun('P',MIN_DECISIONS,{hands:[hand(201,[action('p1','fold',{decisionId:'d-201-preflop-0',callAmount:150})],aces),
  hand(202,[action('p1','fold',{street:'flop',decisionId:'d-202-flop-0',callAmount:150,board:cards('Ks Kh 2c')})],aces),
  hand(203,[action('p1','fold',{decisionId:'d-203-preflop-0',callAmount:1500})],aces)]});
 const [p]=gateSessions([premium]).perRun;assert.equal(p.four.pass,false);assert.deepEqual(p.four.violations,['d-201-preflop-0']);assert.equal(p.four.opportunities,1,'flop folds and large calls are not premium opportunities');
 const early=cleanRun('E',MIN_DECISIONS,{mode:'tournament'});early.hands[0].endStacks={user:5000,p1:0,p2:10000};early.hands[1].endStacks={user:5000,p1:0,p2:0};
 early.hands[7].endStacks={user:5000,p1:5000,p2:0};
 const [e]=gateSessions([early]).perRun;assert.equal(e.three.applies,true);assert.equal(e.three.bustedEarly,2);assert.equal(e.three.pass,false);
 const cash=cleanRun('K');cash.hands[0].endStacks={user:5000,p1:0,p2:10000};
 const [k]=gateSessions([cash]).perRun;assert.equal(k.three.applies,false);assert.equal(k.three.zeroStackFirst5,1);assert.equal(k.pass,true);
});
test('pooled VPIP counts each (run, seat, hand) once and holds judgement below 30 opportunities',()=>{
 const a=cleanRun('A',MIN_DECISIONS),b=cleanRun('B',MIN_DECISIONS);
 const result=gateSessions([a,b]);
 assert.equal(result.pooled.vpip.TAG.opportunities,2*MIN_DECISIONS);
 assert.equal(result.pooled.vpip.Nit.opportunities,2*MIN_DECISIONS);assert.equal(result.pooled.vpip.Nit.vpip,0);assert.equal(result.pooled.vpip.Nit.pass,false);
 assert.equal(result.pooled.vpip.LAG.judged,false);assert.equal(result.pooled.vpip.LAG.note,'표본 부족 — 보류');assert.equal(result.pooled.vpip.LAG.pass,true);
 assert.equal(result.verdict,'FAIL');
});
test('request budget: per-run cap never exceeds the approved total; rerun only with a typical run left',()=>{
 assert.equal(runCap(0),400);assert.equal(runCap(950),250);assert.equal(runCap(1200),0);assert.equal(runCap(1300),0);
 assert.equal(mayRerun(950),true);assert.equal(mayRerun(1000),false);
});
test('live journey options keep the default opt-in contract and validate gate flags',async()=>{
 const {parseLiveArgs,DEFAULT_LIVE_OPTIONS}=await import('./browser/jev-live-play.mjs');
 assert.deepEqual(parseLiveArgs(['--live','--out-dir','x']),{...DEFAULT_LIVE_OPTIONS});
 assert.deepEqual(DEFAULT_LIVE_OPTIONS,{hands:2,ai:2,mode:'cash-training',maxRequests:null,waitMs:90000,humanPolicy:'check-call',keepStore:false});
 assert.deepEqual(parseLiveArgs(['--mode','tournament','--ai','6','--human-policy','check-fold','--max-requests','400','--wait-ms','1800000','--keep-store']),
  {hands:2,ai:6,mode:'tournament',maxRequests:400,waitMs:1800000,humanPolicy:'check-fold',keepStore:true});
 for(const argv of [['--mode','heads-up'],['--human-policy','raise'],['--max-requests','0'],['--mode','tournament','--hands','5']])assert.throws(()=>parseLiveArgs(argv));
});
