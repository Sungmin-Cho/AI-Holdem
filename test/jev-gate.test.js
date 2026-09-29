import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {gateSessions,hopeless,chen,isPremium,effectiveRemainingAt,runCap,mayRerun,loadGateRun,MIN_DECISIONS,guardFromArchive,menuFromArchive,GATE_BUDGET} from './helpers/jev-gate.mjs';
import {JEV_CONFIG} from '../shared/opponent-runtime.js';
import {deriveUnit} from '../training/policies/rng.js';
import {selectJevAction,validateJevAnswer} from '../tools/jev-player.js';

const players=[{playerId:'user'},{playerId:'p1',archetype:'TAG'},{playerId:'p2',archetype:'Nit'}];
const cards=text=>text.split(' ');
// An archived action record as the engine writes it (the legal range, pot and stacks before the action).
function action(playerId,act,{street='preflop',amount=0,callAmount=50,currentBet=50,minRaiseTo=100,maxRaiseTo=5000,potTotal=75,stacks={user:5000,p1:5000,p2:5000},board=[],decisionId}){
 return {decisionId,playerId,action:act,amount,street,potTotal,callAmount,minRaiseTo,maxRaiseTo,currentBet,board,stacks};
}
function hand(handNo,actions,{holes={user:cards('2c 3d'),p1:cards('9c 8d'),p2:cards('7c 2d')},endStacks={user:5000,p1:5000,p2:5000},posts=[]}={}){
 return {handNo,blinds:[25,50],holes,posts,actions,endStacks,startStacks:{user:5000,p1:5000,p2:5000}};
}
const TOKEN='gate-session-token';
const candidatesOf=probabilities=>Object.keys(probabilities).map(key=>key.startsWith('raise_to_')?{key,action:'raise',amount:Number(key.slice(9))}:{key,action:key});
// One recorded v3 decision exactly as the loop makes it: unit from the secret seed, guard
// inputs from the same public state the archive keeps.
function decide(decisionId,probabilities,apiChoice,archivedHand,generation=1){
 const unit=deriveUnit('jev-selection-v1',TOKEN,decisionId,String(generation));
 const guard=guardFromArchive(archivedHand,archivedHand.actions.findIndex(a=>a.decisionId===decisionId),Object.keys(probabilities));
 return selectJevAction({probabilities,candidates:candidatesOf(probabilities),unit,apiChoice,rule:'class-sample-v2',guard});
}
const VERSIONS={questionVersion:JEV_CONFIG.questionVersion,candidateVersion:JEV_CONFIG.candidateVersion,projectionVersion:JEV_CONFIG.projectionVersion,selectionVersion:JEV_CONFIG.selectionVersion};
const entryOf=(decisionId,probabilities,apiChoice,selected,generation=1)=>({decisionId,generation,probabilities,apiChoice,...VERSIONS,
 selection:selected.selection,usage:{input_tokens:10,output_tokens:1}});
// n clean decisions: each AI action is exactly what the recorded selection chose.
function cleanRun(name,n=MIN_DECISIONS,{mode='cash-training',hands:handsOut=[],entries:entriesOut=[],metrics:metricsOut=[],probabilities:base={fold:0.5,call:0.5}}={}){
 const hands=[],entries=[],metrics=[];
 for(let i=1;i<=n;i++){
  const decisionId=`d-${i}-preflop-0`,probabilities={...base};
  const probe=hand(i,[action('p1','fold',{decisionId})]);
  const selected=decide(decisionId,probabilities,'fold',probe);
  hands.push(hand(i,[action('p1',selected.action.action,{decisionId,amount:selected.action.action==='call'?50:0})]));
  entries.push(entryOf(decisionId,probabilities,'fold',selected));
  metrics.push({runtime:'jev',decisionId,outcome:'jev_accepted',modelMs:200+i});
 }
 return {name,mode,players,hands:[...hands,...handsOut],loopState:{sessionToken:TOKEN,jevDiagnostics:{schemaVersion:1,entries:[...entries,...entriesOut],dropped:0},metrics:[...metrics,...metricsOut]}};
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
 // Generation 1 left an entry that was never applied; generation 2 (its own seeded unit) is the applied one.
 const first=base.loopState.jevDiagnostics.entries[0],id=first.decisionId;
 const again=decide(id,first.probabilities,'fold',base.hands[0],2);
 base.hands[0].actions[0]={...base.hands[0].actions[0],action:again.action.action,amount:again.action.action==='call'?50:0};
 base.loopState.jevDiagnostics.entries[0]=entryOf(id,first.probabilities,'fold',again,2);
 base.loopState.jevDiagnostics.entries.unshift({...first,selection:{...first.selection,selectedKey:first.selection.selectedKey==='fold'?'call':'fold'}});
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
 const v1=cleanRun('V');v1.unfinishedHand=null;v1.loopState.jevDiagnostics.entries.push({decisionId:'d-0-preflop-0',generation:1,probabilities:{fold:0,call:1}});
 const gate=gateSessions([failed,truncated,dropped,small,v1]),[f,t,d,s,v]=gate.perRun;
 for(const run of [f,s,v])assert.equal(run.one.pass,false,run.name);
 // Truncated diagnostics without a matching mirror are unjudgeable: INCONCLUSIVE, never FAIL.
 for(const run of [t,d]){assert.equal(run.one.judged,false,run.name);assert.equal(run.pass,true,run.name);assert.ok(run.inconclusive.some(r=>r.startsWith('진단 절단')),run.name);}
 assert.ok(v.one.reasons.includes('v1 — ① 미적용'));assert.ok(v.one.reasons.some(r=>r.startsWith('아카이브 없는 완료 핸드')));
});
test('an entry of an unfinished hand is reported as incomplete and left out of the count',()=>{
 const run=cleanRun('I',MIN_DECISIONS,{entries:[{decisionId:'d-101-flop-3',generation:1,probabilities:{check:1},apiChoice:'check',selection:{rule:'class-sample-v1',unit:0.5,classMass:{check:1},pruned:[],sampled:'check',sizeRule:'weighted-median',selectedKey:'check',apiChoice:'check'}}],
  metrics:[{runtime:'jev',decisionId:'d-101-flop-3',outcome:'jev_accepted'}]});
 run.unfinishedHand=101;
 const [r]=gateSessions([run]).perRun;assert.equal(r.one.pass,true,JSON.stringify(r.one.reasons));assert.equal(r.one.incomplete,1);
 // Without the engine reporting an unfinished hand, the same entry is a missing record.
 delete run.unfinishedHand;assert.equal(gateSessions([run]).perRun[0].one.pass,false);
 const broken=cleanRun('B');broken.hands[0].actions[0].action=broken.hands[0].actions[0].action==='fold'?'call':'fold';
 assert.equal(gateSessions([broken]).perRun[0].one.pass,false,'an applied action that differs from the selection');
});
test('deep hopeless all-ins, premium folds and early tournament busts fail their checks',()=>{
 const shove=cleanRun('C',MIN_DECISIONS,{mode:'tournament',hands:[hand(200,[
  action('p1','raise',{street:'flop',decisionId:'d-200-flop-0',amount:2600,maxRaiseTo:2600,board:cards('2s Kc 9s'),stacks:{user:2600,p1:2600,p2:5000}})],
  {holes:{user:cards('2c 3d'),p1:cards('Ac 5c'),p2:cards('7c 2d')}})]});
 // 52bb shove with Ac5c on 2s Kc 9s: deep (52bb > 40bb) and hopeless.
 const shoveGate=gateSessions([shove]);const [c]=shoveGate.perRun;assert.deepEqual(c.two.violations,['d-200-flop-0']);assert.ok(c.two.opportunities>=1);
 assert.equal(shoveGate.pooled.desperation.pass,false,'one violation in a handful of opportunities is far above 1%');assert.equal(shoveGate.pooled.desperation.zeroRule,'미달');
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
 assert.equal(result.pooled.vpip.LAG.judged,false);assert.equal(result.pooled.vpip.LAG.note,'표본 부족');assert.equal(result.pooled.vpip.LAG.pass,false,'an unjudged style never passes');
 assert.equal(result.verdict,'FAIL','a judged style out of band fails');
});
test('request budget: per-run cap never exceeds the approved total; rerun only with a typical run left',()=>{
 assert.equal(runCap(0),300);assert.equal(runCap(950),250);assert.equal(runCap(1200),0);assert.equal(runCap(1300),0);
 assert.equal(mayRerun(950),true);assert.equal(mayRerun(960),false);
});
test('live journey options keep the default opt-in contract and validate gate flags',async()=>{
 const {parseLiveArgs,DEFAULT_LIVE_OPTIONS}=await import('./browser/jev-live-play.mjs');
 assert.deepEqual(parseLiveArgs(['--live','--out-dir','x']),{...DEFAULT_LIVE_OPTIONS});
 assert.deepEqual(DEFAULT_LIVE_OPTIONS,{hands:2,ai:2,mode:'cash-training',maxRequests:null,waitMs:90000,humanPolicy:'check-call',keepStore:false});
 assert.deepEqual(parseLiveArgs(['--mode','tournament','--ai','6','--human-policy','check-fold','--max-requests','400','--wait-ms','1800000','--keep-store']),
  {hands:2,ai:6,mode:'tournament',maxRequests:400,waitMs:1800000,humanPolicy:'check-fold',keepStore:true});
 for(const argv of [['--mode','heads-up'],['--human-policy','raise'],['--max-requests','0'],['--mode','tournament','--hands','5']])assert.throws(()=>parseLiveArgs(argv));
});
test('missing archives and unrecorded archived decisions fail ①; single-legal skips do not',()=>{
 const gap=cleanRun('G');gap.hands.splice(40,1);
 const [g]=gateSessions([gap]).perRun;assert.equal(g.one.pass,false);assert.ok(g.one.reasons.some(r=>r.startsWith('아카이브 없는 완료 핸드')),JSON.stringify(g.one.reasons));
 // Missing archives at the end: only the engine-reported unfinished hand may lack an archive.
 const tail=cleanRun('Z',MIN_DECISIONS+2);tail.hands.splice(-2,2);tail.unfinishedHand=MIN_DECISIONS+2;
 const [z]=gateSessions([tail]).perRun;assert.equal(z.one.incomplete,1);assert.equal(z.one.pass,false);assert.ok(z.one.reasons.some(r=>r.startsWith('아카이브 없는 완료 핸드')));
 const silent=cleanRun('M',MIN_DECISIONS+1);const id=silent.hands[40].actions[0].decisionId;
 silent.loopState.jevDiagnostics.entries=silent.loopState.jevDiagnostics.entries.filter(e=>e.decisionId!==id);
 silent.loopState.metrics=silent.loopState.metrics.filter(m=>m.decisionId!==id);
 const [m]=gateSessions([silent]).perRun;assert.equal(m.one.pass,false);assert.ok(m.one.reasons.some(r=>r.startsWith('entry·single-legal 없는')),JSON.stringify(m.one.reasons));
 silent.loopState.metrics.push({runtime:'jev',decisionId:id,outcome:'jev_single_legal'});
 assert.equal(gateSessions([silent]).perRun[0].one.pass,true);
 // An accepted metric whose entry and archive are both gone is a missing record too.
 const orphan=cleanRun('O');orphan.loopState.metrics.push({runtime:'jev',decisionId:'d-101-turn-7',outcome:'jev_accepted'});
 assert.equal(gateSessions([orphan]).perRun[0].one.pass,false);
 orphan.unfinishedHand=101;assert.equal(gateSessions([orphan]).perRun[0].one.pass,true,'the interrupted hand may hold an accepted metric without archive');
 assert.equal(gateSessions([silent]).perRun[0].one.pass,true);
});
test('loadGateRun excuses only a hand the engine reports as interrupted',()=>{
 const write=(dir,name,value)=>{fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),JSON.stringify(value));};
 const store=({handNo,live=null,audit})=>{const dir=createOwnedTempDir('jev-gate-load');
  write(dir,'state.json',{handNo,hand:live,config:{mode:'cash-training'}});write(dir,'loop-state.json',{metrics:[],jevDiagnostics:{schemaVersion:1,entries:[],dropped:0}});
  write(dir,'players.json',players);write(dir,'hands/hand-0001.json',hand(1,[]));if(audit!==undefined)write(dir,'.aborted-hand.json',audit);return dir;};
 assert.equal(loadGateRun(store({handNo:2,audit:{schemaVersion:1,hand:{street:'flop'},completedHands:1}})).unfinishedHand,2,'ended mid-hand');
 assert.equal(loadGateRun(store({handNo:1,audit:{schemaVersion:1,hand:null,completedHands:1}})).unfinishedHand,null,'ended between hands');
 assert.equal(loadGateRun(store({handNo:2,live:{street:'turn'}})).unfinishedHand,2,'live hand');
 assert.equal(loadGateRun(store({handNo:1})).unfinishedHand,null,'completed');
});

// A deep decision facing all-in where the guard removed the jam (commit mass 0.3 < 0.6).
// p2 raised to 4000 before p1 acts: the v3 menu is fold, call and the forced all-in.
const facingRaise={callAmount:4000,currentBet:4000,minRaiseTo:7950,potTotal:4075};
function guardedRun(name){
 const run=cleanRun(name);
 const decisionId='d-300-preflop-3',probabilities={fold:0.5,call:0.2,raise_to_5000:0.3};
 const probe=hand(300,[action('p1','fold',{decisionId,...facingRaise})],{holes:{user:cards('2c 3d'),p1:cards('9c 7d'),p2:cards('7c 2d')}});
 assert.deepEqual(menuFromArchive(probe,0).map(m=>m.map(c=>c.key)),[['fold','call'],['fold','call','raise_to_5000']]);
 const selected=decide(decisionId,probabilities,'fold',probe);
 assert.deepEqual(selected.selection.guard,{commit:['raise_to_5000'],mass:0.3});
 run.hands.push(hand(300,[action('p1',selected.action.action,{decisionId,...facingRaise,amount:selected.action.action==='call'?4000:0})],{holes:{user:cards('2c 3d'),p1:cards('9c 7d'),p2:cards('7c 2d')}}));
 run.loopState.jevDiagnostics.entries.push(entryOf(decisionId,probabilities,'fold',selected));
 run.loopState.metrics.push({runtime:'jev',decisionId,outcome:'jev_accepted',modelMs:300});
 return {run,decisionId};
}
test('#234 ① recomputes from the seed and the archive: tampered unit, rule or guard fails even when the action stays',()=>{
 const {run}=guardedRun('G');
 assert.equal(gateSessions([run]).perRun[0].one.pass,true,JSON.stringify(gateSessions([run]).perRun[0].one.reasons));
 const tamper=[
  e=>{delete e.selection.guard;},
  e=>{e.selection.guard.mass=0.61;},
  e=>{e.selection.guard.commit=['call'];},
  e=>{e.selection.rule='class-sample-v1';},
  e=>{e.selectionVersion='class-sample-v1';},
  // r3: both rule fields rewritten together must still fail.
  e=>{e.selectionVersion='class-sample-v1';e.selection.rule='class-sample-v1';},
  e=>{e.questionVersion='poker-choice-v2';},
  e=>{e.candidateVersion='legal-menu-v2';},
  e=>{delete e.projectionVersion;},
  e=>{e.selection.unit=e.selection.unit/2;},
  // A key set that is not the v3 menu for the archived state.
  e=>{e.probabilities={fold:0.5,call:0.2,raise_to_4800:0.3};},
 ];
 for(const [i,change] of tamper.entries()){
  const {run:bad,decisionId}=guardedRun(`T${i}`);
  change(bad.loopState.jevDiagnostics.entries.find(e=>e.decisionId===decisionId));
  const [r]=gateSessions([bad]).perRun;
  assert.equal(r.one.pass,false,`tamper ${i} must fail ①`);assert.ok(r.one.reasons.some(x=>x.startsWith('재계산')),JSON.stringify(r.one.reasons));
 }
});
test('#234 ② is judged on the aggregate rate; zero opportunities, short runs and failed journeys are inconclusive',()=>{
 // No failing judged criterion, but personas unjudged, no ② opportunity and no tournament:
 // INCONCLUSIVE, never PASS. (Only TAG plays here, inside its band.)
 const quietRun=cleanRun('Q',MIN_DECISIONS,{probabilities:{fold:0.75,call:0.25}});quietRun.players=players.filter(p=>p.playerId!=='p2');
 const quiet=gateSessions([quietRun]);
 assert.equal(quiet.pooled.vpip.TAG.pass,true,JSON.stringify(quiet.pooled.vpip.TAG));
 assert.equal(quiet.verdict,'INCONCLUSIVE',JSON.stringify(quiet.inconclusive));assert.ok(quiet.inconclusive.includes('② 기회 0건'));assert.ok(quiet.inconclusive.includes('③ 토너먼트 실행 없음'));
 const short=cleanRun('S');short.handLimit=MIN_DECISIONS+5;short.stoppedBy='max-requests';
 assert.ok(gateSessions([short]).inconclusive.some(r=>r.includes('handLimit')&&r.includes('max-requests')));
 const failedJourney=cleanRun('J');failedJourney.journeyPass=false;
 assert.ok(gateSessions([failedJourney]).inconclusive.some(r=>r.includes('저니 실패')));
 const noResult=cleanRun('R');
 assert.ok(gateSessions([noResult]).inconclusive.some(r=>r.includes('저니 결과 없음')),'a run without result.json is never judged complete');
 assert.ok(gateSessions([noResult]).inconclusive.some(r=>r.includes('요청 수 기록 없음')));
 const over=cleanRun('O');over.journeyPass=true;over.requests=GATE_BUDGET.perRun+1;
 assert.ok(gateSessions([over]).inconclusive.some(r=>r.includes(`요청 ${GATE_BUDGET.perRun+1} > 실행 상한`)));
 const quarter=()=>Object.assign(cleanRun('Q4'),{journeyPass:true,requests:GATE_BUDGET.perRun});
 assert.ok(gateSessions([quarter(),quarter(),quarter(),quarter(),quarter()]).inconclusive.some(r=>r.includes('승인 예산')),'five capped runs exceed the approved total');
 assert.equal(gateSessions([quarter(),quarter(),quarter(),quarter()]).inconclusive.some(r=>r.includes('승인 예산')),false);
 const tournament=cleanRun('T',MIN_DECISIONS,{mode:'tournament'});tournament.hands=tournament.hands.filter(h=>h.handNo!==3);
 tournament.loopState.jevDiagnostics.entries=tournament.loopState.jevDiagnostics.entries.filter(e=>e.decisionId!=='d-3-preflop-0');
 tournament.loopState.metrics=tournament.loopState.metrics.filter(m=>m.decisionId!=='d-3-preflop-0');
 assert.ok(gateSessions([tournament]).inconclusive.some(r=>r.includes('첫 5핸드')));
 // r3: End (and a budget stop) also sets gameOver; the first five hands are still required.
 tournament.gameOver=true;
 assert.ok(gateSessions([tournament]).inconclusive.some(r=>r.includes('첫 5핸드')));
 // One violation among 150 aggregate opportunities is under 1%; among 50 it is not.
 const deepHand=(n,allIn)=>hand(1000+n,[action('p1',allIn?'raise':'fold',{street:'flop',decisionId:`d-${1000+n}-flop-0`,amount:allIn?2600:0,maxRaiseTo:2600,board:cards('2s Kc 9s'),stacks:{user:2600,p1:2600,p2:5000}})],
  {holes:{user:cards('2c 3d'),p1:cards('Ac 5c'),p2:cards('7c 2d')}});
 const withDeep=(count,violations)=>{const run=cleanRun('D');for(let n=0;n<count;n++){const h=deepHand(n,n<violations);run.hands.push(h);run.loopState.metrics.push({runtime:'jev',decisionId:h.actions[0].decisionId,outcome:'jev_single_legal'});}return run;};
 const low=gateSessions([withDeep(150,1)]).pooled.desperation;assert.equal(low.opportunities,150);assert.equal(low.violations,1);assert.equal(low.pass,true);assert.equal(low.zeroRule,'미달');
 const high=gateSessions([withDeep(50,1)]).pooled.desperation;assert.equal(high.pass,false);
 // A near-all-in (within 5%) counts under v3 but not under the v2 definition.
 const near=cleanRun('N');const h=deepHand(0,false);h.actions[0]={...h.actions[0],action:'raise',amount:2500};near.hands.push(h);
 near.loopState.metrics.push({runtime:'jev',decisionId:h.actions[0].decisionId,outcome:'jev_single_legal'});
 const nd=gateSessions([near]).pooled.desperation;assert.equal(nd.violations,1);assert.equal(nd.v2Violations,0);
});
// One loop decision exactly as the loop records it: the answer passes the real validator on
// the v3 menu re-derived from the archive, then the real selector runs on its output.
function loopDecision(decisionId,probabilities,archivedHand,generation=1){
 const index=archivedHand.actions.findIndex(a=>a.decisionId===decisionId);
 const candidates=menuFromArchive(archivedHand,index).find(m=>m.length===Object.keys(probabilities).length&&m.every(c=>Object.hasOwn(probabilities,c.key)));
 assert.ok(candidates,`${decisionId}: not a v3 menu`);
 const choice=Object.keys(probabilities).reduce((a,b)=>probabilities[b]>probabilities[a]?b:a);
 const {diagnostics}=validateJevAnswer({model:JEV_CONFIG.model,usage:{input_tokens:1999,output_tokens:99},
  answers:{action:{type:'choice',choice,confidence:probabilities[choice],probabilities}}},candidates);
 const selected=selectJevAction({probabilities:diagnostics.probabilities,candidates,unit:deriveUnit('jev-selection-v1',TOKEN,decisionId,String(generation)),
  apiChoice:diagnostics.apiChoice,rule:JEV_CONFIG.selectionVersion,guard:guardFromArchive(archivedHand,index,Object.keys(probabilities))});
 return {selected,entry:{...diagnostics,decisionId,generation,actor:'seat_1',...VERSIONS,selection:selected.selection}};
}
const applied=(act,base)=>act.action==='raise'?{...base,amount:act.amount}:act.action==='call'?{...base,amount:base.callAmount??50}:{...base,amount:0};
test('#234 r3: entries the loop dropped past the byte cap are restored from the journey mirror, never guessed',async()=>{
 const {boundJevDiagnostics}=await import('../tools/jev-diagnostics.js');
 const {newMirrorEntries}=await import('./browser/jev-live-play.mjs');
 const run=cleanRun('M',0);run.journeyPass=true;run.requests=MIN_DECISIONS;
 const wide={fold:0.3,call:0.2,raise_to_100:0.1,raise_to_125:0.15,raise_to_150:0.15,raise_to_200:0.1};
 const all=[];
 for(let i=1;i<=MIN_DECISIONS;i++){
  const decisionId=`d-${i}-preflop-0`,probe=hand(i,[action('p1','fold',{decisionId})]);
  const {selected,entry}=loopDecision(decisionId,wide,probe);
  run.hands.push(hand(i,[action('p1',selected.action.action,applied(selected.action,{decisionId}))]));
  all.push(entry);run.loopState.metrics.push({runtime:'jev',decisionId,outcome:'jev_accepted',modelMs:250});
 }
 // The loop's bound, replayed write by write with a small byte budget, and the journey's copy after every write.
 const pad='x'.repeat(2*1024*1024-64*1024-24*1024),seen=new Set(),mirror=[];
 let state={pad,jevDiagnostics:{schemaVersion:1,entries:[],dropped:0}};
 for(const entry of all){
  state={...state,jevDiagnostics:{...state.jevDiagnostics,entries:[...state.jevDiagnostics.entries,entry]}};
  boundJevDiagnostics(state);mirror.push(...newMirrorEntries(state,seen));
 }
 const kept=state.jevDiagnostics;assert.ok(kept.dropped>0&&kept.entries.length>0,`dropped ${kept.dropped}`);
 assert.deepEqual(mirror,all,'the mirror holds every entry once, in order');
 run.loopState.jevDiagnostics=kept;
 const cut=gateSessions([run]).perRun[0];
 assert.equal(cut.one.judged,false);assert.ok(cut.inconclusive.some(r=>r.startsWith('진단 절단')),'without a mirror a truncated run is inconclusive');
 run.mirror=mirror;
 const [restored]=gateSessions([run]).perRun;
 assert.equal(restored.one.pass,true,JSON.stringify(restored.one.reasons));assert.equal(restored.one.restoredFromMirror,kept.dropped);
 assert.equal(restored.one.recomputed,MIN_DECISIONS);assert.equal(restored.inconclusive.length,0,JSON.stringify(restored.inconclusive));
 for(const broken of [mirror.slice(1),[...mirror.slice(0,-1),{...mirror.at(-1),confidence:0.01}],[...mirror,mirror.at(-1)]]){
  run.mirror=broken;const [r]=gateSessions([run]).perRun;
  assert.equal(r.one.judged,false);assert.ok(r.inconclusive.some(x=>x.startsWith('진단 절단')));
 }
});
test('#234 r3: privateTree makes the evidence tree owner-only',{skip:process.platform==='win32'&&'POSIX permission bits'},async()=>{
 const {privateTree}=await import('./browser/jev-live-play.mjs');
 const dir=createOwnedTempDir('jev-private');fs.mkdirSync(path.join(dir,'session','hands'),{recursive:true,mode:0o755});
 fs.writeFileSync(path.join(dir,'shot.png'),'x',{mode:0o644});fs.writeFileSync(path.join(dir,'session','hands','hand-0001.json'),'{}',{mode:0o644});
 privateTree(dir);
 for(const p of [dir,path.join(dir,'session'),path.join(dir,'session','hands')])assert.equal(fs.statSync(p).mode&0o777,0o700,p);
 for(const p of [path.join(dir,'shot.png'),path.join(dir,'session','hands','hand-0001.json')])assert.equal(fs.statSync(p).mode&0o777,0o600,p);
});

// A complete passing gate input: six styles, preflop junk everywhere (every AI decision is a ②
// opportunity), VPIP set per style inside its band, two cash runs and one tournament.
const STYLES=['Nit','TAG','LAG','Maniac','CallingStation','Trickster'];
const CALLS_OF_20={Nit:3,TAG:5,LAG:9,Maniac:11,CallingStation:10,Trickster:6};
const SIX=['user',...STYLES.map((_,i)=>`p${i+1}`)];
const sixStacks=Object.fromEntries(SIX.map(id=>[id,5000]));
function passingRun(name,{mode='cash-training',jam=false,strongSeats=[]}={}){
 const players=[{playerId:'user'},...STYLES.map((archetype,i)=>({playerId:`p${i+1}`,archetype}))];
 const hands=[],entries=[],metrics=[];
 for(let n=1;n<=20;n++){
  const holes=Object.fromEntries(SIX.map(id=>[id,strongSeats.includes(id)?cards('As Qd'):cards('7c 2d')]));
  const actions=[];
  STYLES.forEach((style,i)=>{
   const pid=`p${i+1}`,decisionId=`d-${n}-preflop-${i}`;
   const jamHere=jam&&style==='Maniac'&&n===1;
   const base=jamHere?{decisionId,stacks:sixStacks,...facingRaise}:{decisionId,stacks:sixStacks};
   const probabilities=jamHere?{fold:0,call:0,raise_to_5000:1}:(n%20)<CALLS_OF_20[style]?{fold:0,call:1}:{fold:1,call:0};
   const probe={handNo:n,blinds:[25,50],holes,posts:[],actions:[...actions,action(pid,'fold',base)]};
   const {selected,entry}=loopDecision(decisionId,probabilities,probe);
   actions.push(action(pid,selected.action.action,applied(selected.action,base)));
   entries.push(entry);metrics.push({runtime:'jev',decisionId,outcome:'jev_accepted',modelMs:240});
  });
  hands.push({handNo:n,blinds:[25,50],holes,posts:[],actions,endStacks:sixStacks,startStacks:sixStacks});
 }
 return {name,mode,players,hands,handLimit:mode==='tournament'?null:20,journeyPass:true,requests:entries.length,gameOver:mode==='tournament',
  loopState:{sessionToken:TOKEN,jevDiagnostics:{schemaVersion:1,entries,dropped:0},metrics}};
}
test('#234 r3: a complete gate input passes every criterion (the gate can say PASS)',()=>{
 const result=gateSessions([passingRun('A'),passingRun('B'),passingRun('T',{mode:'tournament'})]);
 assert.equal(result.verdict,'PASS',JSON.stringify({inconclusive:result.inconclusive,perRun:result.perRun.map(r=>[r.name,r.pass,r.one.reasons]),vpip:result.pooled.vpip}));
 for(const style of STYLES)assert.equal(result.pooled.vpip[style].pass,true,style);
 assert.equal(result.pooled.desperation.opportunities,360);assert.equal(result.pooled.desperation.violations,0);
});
test('#234 r3: ② is pooled across runs — 1/60 alone fails, 1/300 in aggregate passes',()=>{
 const jammer=passingRun('A',{jam:true,strongSeats:['p1','p2','p3']});
 const alone=gateSessions([jammer]).pooled.desperation;
 assert.equal(alone.violations,1);assert.equal(alone.opportunities,60);assert.equal(alone.pass,false);
 const result=gateSessions([jammer,passingRun('B'),passingRun('T',{mode:'tournament'})]);
 assert.equal(result.pooled.desperation.violations,1);assert.equal(result.pooled.desperation.opportunities,300);
 assert.equal(result.pooled.desperation.pass,true);assert.equal(result.pooled.desperation.zeroRule,'미달');
 assert.equal(result.verdict,'PASS',JSON.stringify({inconclusive:result.inconclusive,vpip:result.pooled.vpip}));
});
// The archive keeps enough of each decision to rebuild the loop's menu: every engine-played
// decision's product menu equals one of menuFromArchive's two variants for that record.
test('#234 r3: menuFromArchive reproduces the loop menu for every decision of engine-played hands',async()=>{
 const {createGame,startHand,applyAction,legalFor,blindsForLevel}=await import('../engine/hand.js');
 const {snapshotDecision}=await import('../engine/decision.js');
 const {buildJevCandidates}=await import('../tools/jev-player.js');
 let st=createGame({aiCount:4,startStack:5000,levelEvery:100}),checked=0,withRaise=0;
 for(let handNo=1;handNo<=12;handNo++){
  if(handNo===4)st.seats[2].stack=400;
  st=startHand(st).state;
  const menus=[];let raises=0,n=0;
  while(!legalFor(st).handOver){
   const legal=legalFor(st),snapshot=snapshotDecision(st,legal.toAct,null,{blinds:blindsForLevel(st.level,st.config.blinds0),legal});
   const menu=buildJevCandidates(snapshot,legal);menus.push({decisionId:legal.decisionId,menu});
   const raise=menu.filter(c=>c.action==='raise');
   const pick=raise.length&&raises<3&&(n+handNo)%3===0?raise[(n+handNo)%raise.length]:menu.find(c=>c.action==='call')??menu.find(c=>c.action==='check')??menu[0];
   if(pick.action==='raise')raises++;
   st=applyAction(st,legal.toAct,pick.action,pick.amount).state;n++;
  }
  const archived=st.lastHand;
  for(const {decisionId,menu} of menus){
   const index=archived.actions.findIndex(a=>a.decisionId===decisionId);assert.ok(index>=0,decisionId);
   const rebuilt=menuFromArchive(archived,index).map(m=>JSON.stringify(m));
   assert.ok(rebuilt.includes(JSON.stringify(menu)),`${decisionId}: ${JSON.stringify(menu)} not in ${rebuilt.join(' | ')}`);
   checked++;if(menu.some(c=>c.action==='raise'))withRaise++;
  }
  if(st.gameOver)break;
 }
 assert.ok(checked>=60&&withRaise>=30,`${checked} decisions, ${withRaise} with raise sizes`);
});
