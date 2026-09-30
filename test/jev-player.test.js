import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildJevCandidates,projectJevState,validateJevAnswer,effectiveRemaining,JEV_INSTRUCTIONS,JEV_STYLES,jevGuardContext,fullRaisesThisStreet} from '../tools/jev-player.js';
import {createGame,startHand,applyAction,legalFor,blindsForLevel} from '../engine/hand.js';
import {snapshotDecision} from '../engine/decision.js';
import {ARCHETYPES} from '../engine/personas.js';
import {JEV_CONFIG,resolveOpponentRuntime,validateJevConfig} from '../shared/opponent-runtime.js';
export function fixture() {
 const legal={toAct:'private-user-id',decisionId:'d-1-preflop-0',canCheck:false,canRaise:true,callAmount:50,minRaiseTo:100,maxRaiseTo:5000};
 const snapshot={actorId:legal.toAct,decisionId:legal.decisionId,gameMode:'cash-training',street:'preflop',position:'BB',handNo:1,
 holeCards:['As','Ah'],board:[],blinds:[25,50],potBefore:75,currentBet:50,actorBet:0,effectiveStack:5000,
 publicSeats:[{playerId:legal.toAct,position:'BB',stack:5000,bet:0,contribution:0,folded:false,allIn:false,out:false},
 {playerId:'secret-other-id',position:'BTN/SB',stack:4950,bet:50,contribution:50,folded:false,allIn:false,out:false}],priorActions:[]};
 return {legal,snapshot};
}
test('closed JEV projection retains own cards and public board, drops secrets and aliases IDs',()=>{
 const {snapshot,legal}=fixture();Object.assign(snapshot,{deck:'CANARY',policySeed:'CANARY',assistance:'CANARY',notes:'CANARY',name:'CANARY',dealSelection:'CANARY'});
 snapshot.publicSeats[1].holeCards=['Ks','Kh']; snapshot.publicSeats[1].name='CANARY';snapshot.board=['2h','3c','4s'];
 snapshot.priorActions=Array.from({length:65},()=>({playerId:'secret-other-id',action:'call',amount:50,street:'preflop',reason:'CANARY'}));
 const state=projectJevState(snapshot,legal,'TAG');const serialized=JSON.stringify(state);
 for(const secret of ['CANARY','private-user-id','secret-other-id','Ks','Kh']) assert.ok(!serialized.includes(secret));
 assert.deepEqual(state.holeCards,['As','Ah']);assert.deepEqual(state.board,snapshot.board);assert.equal(state.historyTruncated,true);assert.equal(state.priorActions.length,64);assert.equal(state.actor,'seat_0');
 assert.equal(state.priorActions[0].player,'seat_1');
});
test('legal menu handles raises, short all-in, disabled raise, check, current blinds and overflow',()=>{
 const {snapshot:s,legal:l}=fixture();assert.deepEqual(buildJevCandidates(s,l).map(c=>c.key),['fold','call','raise_to_100','raise_to_125','raise_to_150','raise_to_200']);
 assert.deepEqual(buildJevCandidates(s,{...l,minRaiseTo:100,maxRaiseTo:80}).at(-1),{key:'raise_to_80',action:'raise',amount:80});
 assert.deepEqual(buildJevCandidates(s,{...l,canCheck:true,canRaise:false,callAmount:0}),[{key:'check',action:'check'}]);
 assert.throws(()=>buildJevCandidates(s,{...l,canCheck:true}),{code:'JEV_INPUT_INVALID'});
 assert.deepEqual(buildJevCandidates(s,{...l,canRaise:false}).map(c=>c.key),['fold','call']);
 assert.deepEqual(buildJevCandidates({...s,street:'flop',potBefore:100,actorBet:25},{...l,callAmount:25,minRaiseTo:100}).map(c=>c.key),['fold','call','raise_to_100','raise_to_133','raise_to_175']);
 assert.throws(()=>buildJevCandidates({...s,potBefore:Number.MAX_SAFE_INTEGER},l),{code:'JEV_INPUT_INVALID'});
});
test('strict JEV response, diagnostics and pinned persisted model',()=>{
 const candidates=[{key:'fold',action:'fold'},{key:'call',action:'call'}];
 const response={model:JEV_CONFIG.model,answers:{action:{type:'choice',choice:'call',confidence:0.8,probabilities:{fold:0.2,call:0.8}}},usage:{input_tokens:5,output_tokens:1}};
 assert.deepEqual(validateJevAnswer(response,candidates).action,{action:'call'});
 assert.equal(validateJevAnswer(response,candidates).diagnostics.apiChoice,'call');
 const tie={...response,answers:{action:{...response.answers.action,choice:'fold',confidence:0,probabilities:{fold:0.5,call:0.5}}}};
 assert.equal(validateJevAnswer(tie,candidates).diagnostics.apiChoice,'fold');
 assert.equal(validateJevAnswer({...tie,answers:{action:{...tie.answers.action,choice:'call'}}},candidates).diagnostics.apiChoice,'call');
 assert.deepEqual(Object.keys(validateJevAnswer(response,candidates).diagnostics),['model','confidence','probabilitySum','probabilities','usage','apiChoice']);
 for(const patch of [{probabilities:{fold:0.3,call:0.8}},{probabilities:{fold:0.2,call:0.8,extra:0}},{confidence:NaN},{choice:'fold'},{choice:'raise'}]) assert.throws(()=>validateJevAnswer({...response,answers:{action:{...response.answers.action,...patch}}},candidates),{code:'JEV_INVALID_RESPONSE'});
 const rounded={...response,answers:{action:{...response.answers.action,probabilities:{fold:0.2,call:0.79}}}};
 assert.equal(validateJevAnswer(rounded,candidates).diagnostics.probabilitySum,0.99);
 assert.throws(()=>validateJevAnswer({...rounded,answers:{action:{...rounded.answers.action,probabilities:{fold:0.201,call:0.79}}}},candidates));
 assert.throws(()=>validateJevAnswer({...response,model:'jev-latest'},candidates),{code:'JEV_MODEL_MISMATCH'});
 // Observed live: rounded hundredths may put the returned choice one hundredth below the maximum.
 const six=['fold','call','raise_to_250','raise_to_375','raise_to_450','raise_to_600'].map(key=>key.startsWith('raise')?{key,action:'raise',amount:Number(key.slice(9))}:{key,action:key});
 const live={model:JEV_CONFIG.model,answers:{action:{type:'choice',choice:'fold',confidence:0.13,probabilities:{raise_to_375:0.12,raise_to_250:0.09,raise_to_600:0.06,raise_to_450:0.28,call:0.18,fold:0.27}}}};
 assert.equal(validateJevAnswer(live,six).diagnostics.apiChoice,'fold');
 assert.throws(()=>validateJevAnswer({...live,answers:{action:{...live.answers.action,probabilities:{...live.answers.action.probabilities,fold:0.26,call:0.19}}}},six),{code:'JEV_INVALID_RESPONSE'});
 assert.throws(()=>validateJevAnswer({...response,answers:{action:{...response.answers.action,choice:'fold',probabilities:{fold:0.4975,call:0.5025}}}},candidates),{code:'JEV_INVALID_RESPONSE'});
 assert.throws(()=>validateJevConfig({...JEV_CONFIG,extra:1}));
 assert.equal(resolveOpponentRuntime({config:{opponentRuntime:'jev',jev:JEV_CONFIG}}),'jev');
 assert.equal(resolveOpponentRuntime({config:{mode:'tournament'}}),'llm');
 assert.equal(resolveOpponentRuntime({config:{},policySeed:'seed'}),'policy');
 assert.throws(()=>resolveOpponentRuntime({config:{jev:JEV_CONFIG}}));
 assert.throws(()=>resolveOpponentRuntime({config:{opponentRuntime:'jev',jev:JEV_CONFIG}},{loop:{opponentRuntime:'llm'}}));
});
test('hundredth rounding envelope is bounded at each supported candidate count',()=>{
 for(let count=2;count<=7;count++){
  const candidates=Array.from({length:count},(_,i)=>({key:`k${i}`,action:i?'raise':'check',...(i?{amount:i*10}:{})}));
  const probabilities=Object.fromEntries(candidates.map((c,i)=>[c.key,i?0.01:Math.round((1-(count-1)*0.01-0.01)*100)/100]));
  const response={model:JEV_CONFIG.model,answers:{action:{type:'choice',choice:'k0',confidence:0.5,probabilities}}};
  assert.equal(validateJevAnswer(response,candidates).action.action,'check');
  const bad={...response,answers:{action:{...response.answers.action,probabilities:{...probabilities,k0:probabilities.k0-0.10}}}};
  assert.throws(()=>validateJevAnswer(bad,candidates),{code:'JEV_INVALID_RESPONSE'});
 }
});
const keys=(s,l)=>buildJevCandidates(s,l).map(c=>c.key);
const seat=(playerId,extra={})=>({playerId,position:null,stack:5000,bet:0,contribution:0,folded:false,allIn:false,out:false,...extra});
const raise=(amount,playerId='secret-other-id')=>({playerId,action:'raise',amount,street:'preflop'});
test('legal menu v3: full-raise ladder, all-in only when short, near a pot raise, forced or a five-bet',()=>{
 const {snapshot:s,legal:l}=fixture();
 assert.equal(keys(s,l).includes('raise_to_5000'),false);
 // Facing an open (one full raise): 3x / 3.4x / 4x the open.
 assert.deepEqual(keys({...s,currentBet:200,actorBet:50,priorActions:[raise(200)],publicSeats:[{...s.publicSeats[0],stack:4950,bet:50},s.publicSeats[1]]},{...l,callAmount:150,minRaiseTo:350,maxRaiseTo:4950}),
  ['fold','call','raise_to_350','raise_to_600','raise_to_680','raise_to_800']);
 // Facing a three-bet: 2.2x / 2.3x / 2.5x, rounded to whole chips before clamping (425 -> 935/978/1063).
 const threeBet={...s,currentBet:425,actorBet:150,priorActions:[raise(150,'private-user-id'),raise(425)],
  publicSeats:[{...s.publicSeats[0],stack:4850,bet:150},{...s.publicSeats[1],stack:4575,bet:425}]};
 assert.deepEqual(keys(threeBet,{...l,callAmount:275,minRaiseTo:700,maxRaiseTo:5000}),['fold','call','raise_to_700','raise_to_935','raise_to_978','raise_to_1063']);
 // Facing a four-bet: the five-bet is all-in only.
 assert.deepEqual(keys({...s,currentBet:1800,actorBet:450,priorActions:[raise(150),raise(450,'private-user-id'),raise(1800)],
  publicSeats:[{...s.publicSeats[0],stack:4550,bet:450},{...s.publicSeats[1],stack:3200,bet:1800}]},{...l,callAmount:1350,minRaiseTo:3150,maxRaiseTo:5000}),
  ['fold','call','raise_to_5000']);
 // Short all-in raises do not reopen the ladder: 100 (full), 110 and 120 (short) is still one full raise.
 const shorts={...s,currentBet:120,priorActions:[raise(100,'a'),raise(110,'b'),raise(120,'c')]};
 assert.equal(fullRaisesThisStreet(shorts,50),1);
 assert.deepEqual(keys(shorts,{...l,callAmount:120,minRaiseTo:170,maxRaiseTo:5000}),['fold','call','raise_to_170','raise_to_360','raise_to_408','raise_to_480']);
 // A standard size within 5% of all-in is all-in.
 assert.deepEqual(keys({...s,currentBet:200,priorActions:[raise(200)],publicSeats:[{...s.publicSeats[0],stack:830},s.publicSeats[1]]},{...l,callAmount:200,minRaiseTo:350,maxRaiseTo:830}),
  ['fold','call','raise_to_350','raise_to_600','raise_to_680','raise_to_830']);
 // Short actor: standard sizes plus all-in.
 assert.deepEqual(keys({...s,publicSeats:[{...s.publicSeats[0],stack:900},s.publicSeats[1]]},{...l,maxRaiseTo:900}),
  ['fold','call','raise_to_100','raise_to_125','raise_to_150','raise_to_200','raise_to_900']);
 // Deep actor, every live opponent short.
 assert.equal(keys({...s,publicSeats:[s.publicSeats[0],{...s.publicSeats[1],stack:850}]},l).at(-1),'raise_to_5000');
 // Short live opponent, the deep stack folded: short by (b).
 assert.equal(keys({...s,publicSeats:[s.publicSeats[0],seat('short',{stack:700}),seat('deep',{folded:true})]},l).at(-1),'raise_to_5000');
 // Deep live opponent, only a short stack folded: no all-in.
 assert.equal(keys({...s,publicSeats:[s.publicSeats[0],seat('deep'),seat('short',{stack:700,folded:true})]},l).includes('raise_to_5000'),false);
 // An eliminated deep seat does not cover the actor.
 assert.equal(keys({...s,publicSeats:[s.publicSeats[0],seat('short',{stack:700}),seat('gone',{out:true})]},l).at(-1),'raise_to_5000');
 // Low SPR postflop: pot raise 5000 >= 5500/1.5, seven candidates.
 const spr=buildJevCandidates({...s,street:'flop',potBefore:3000,currentBet:1000,actorBet:0,publicSeats:[{...s.publicSeats[0],stack:5500},{...s.publicSeats[1],stack:9000,bet:1000}]},
  {...l,callAmount:1000,minRaiseTo:2000,maxRaiseTo:5500});
 assert.deepEqual(spr.map(c=>c.key),['fold','call','raise_to_2000','raise_to_2333','raise_to_3667','raise_to_5000','raise_to_5500']);
 // Clamp reaching max keeps a single all-in key.
 assert.deepEqual(keys(s,{...l,maxRaiseTo:180}),['fold','call','raise_to_100','raise_to_125','raise_to_150','raise_to_180']);
 // Limped pot and heads-up blind use the open table; tournament level uses the current big blind.
 assert.deepEqual(keys({...s,priorActions:[{playerId:'secret-other-id',action:'call',amount:50,street:'preflop'}]},l),['fold','call','raise_to_100','raise_to_125','raise_to_150','raise_to_200']);
 assert.deepEqual(keys({...s,position:'BTN/SB',actorBet:25,publicSeats:[{...s.publicSeats[0],position:'BTN/SB',stack:4975,bet:25},{...s.publicSeats[1],position:'BB',stack:4950,bet:50}]},{...l,callAmount:25,maxRaiseTo:5000}),
  ['fold','call','raise_to_100','raise_to_125','raise_to_150','raise_to_200']);
 assert.deepEqual(keys({...s,blinds:[50,100],currentBet:100,publicSeats:[s.publicSeats[0],{...s.publicSeats[1],stack:4900,bet:100}]},{...l,callAmount:100,minRaiseTo:200}),
  ['fold','call','raise_to_200','raise_to_250','raise_to_300','raise_to_400']);
 assert.deepEqual(buildJevCandidates(s,{...l,minRaiseTo:100,maxRaiseTo:80}).slice(2),[{key:'raise_to_80',action:'raise',amount:80}]);
 assert.throws(()=>buildJevCandidates({...s,publicSeats:[s.publicSeats[1]]},l),{code:'JEV_INPUT_INVALID'});
 for(let n=0;n<40;n++){const count=keys({...s,street:'flop',potBefore:300*n,publicSeats:[{...s.publicSeats[0],stack:1000+250*n},s.publicSeats[1]]},{...l,maxRaiseTo:1000+250*n}).length;assert.ok(count>=2&&count<=7);}
});
test('effective remaining stack counts all-in bets, excludes folded seats and floors at zero',()=>{
 const {snapshot:s}=fixture();const actor=s.publicSeats[0];
 assert.equal(effectiveRemaining({...s,publicSeats:[actor,seat('shove',{stack:0,bet:5000,allIn:true})]}),5000);
 assert.equal(effectiveRemaining({...s,publicSeats:[actor,seat('short',{stack:750})]}),750);
 assert.equal(effectiveRemaining({...s,publicSeats:[actor,seat('short',{stack:750}),seat('deep',{folded:true})]}),750);
 assert.equal(effectiveRemaining({...s,publicSeats:[{...actor,stack:4000,bet:1000},seat('both',{stack:4000,bet:1000})]}),4000);
 assert.equal(effectiveRemaining({...s,publicSeats:[{...actor,stack:100,bet:300},seat('shove',{stack:0,bet:200,allIn:true})]}),0);
 assert.equal(effectiveRemaining({...s,publicSeats:[{...actor,stack:8000},seat('mid',{stack:4000,bet:1000})]}),5000);
});
function projected(snapshot,legal,archetype='TAG'){return projectJevState(snapshot,legal,archetype);}
test('projection v2 adds only derived numbers: bb units, effective remaining and winnable pot odds',()=>{
 const {snapshot:s,legal:l}=fixture();const base=projected(s,l);
 assert.equal(base.bigBlind,50);assert.equal(base.actorStackBB,100);assert.equal(base.effectiveRemainingBB,100);
 assert.deepEqual(base.seats.map(x=>x.stackBB),[100,99]);assert.equal(base.effectiveStack,5000);
 for(const k of ['bigBlind','actorStackBB','effectiveRemainingBB','potOdds'])assert.equal(typeof base[k],'number');
 // Three seats with consistent blinds: T=50, winnable 50+25+50.
 const three={...s,position:'UTG',potBefore:75,publicSeats:[seat(s.actorId,{position:'UTG'}),seat('sb',{position:'SB',stack:4975,bet:25,contribution:25}),seat('bb',{position:'BB',stack:4950,bet:50,contribution:50})]};
 assert.equal(projected(three,l).potOdds,0.4);
 // Side pot: only min(contribution, T) of each opponent is winnable.
 const side={...s,street:'flop',potBefore:5000,currentBet:2500,publicSeats:[seat(s.actorId,{stack:500}),seat('a',{stack:0,bet:2500,contribution:2500,allIn:true}),seat('b',{stack:2500,bet:2500,contribution:2500})]};
 const sideState=projected(side,{...l,callAmount:500,canRaise:false});
 assert.equal(sideState.potOdds,0.33);assert.equal(sideState.effectiveRemainingBB,10);
 // Partial all-in call: callAmount is capped by the stack.
 const partial={...s,street:'turn',potBefore:2200,currentBet:1000,publicSeats:[seat(s.actorId,{stack:300,bet:200,contribution:200}),seat('a',{bet:1000,contribution:1000}),seat('b',{bet:1000,contribution:1000})]};
 assert.equal(projected(partial,{...l,callAmount:300,canRaise:false}).potOdds,0.2);
 assert.equal(projected({...s,currentBet:0,publicSeats:[s.publicSeats[0],{...s.publicSeats[1],bet:0}]},{...l,canCheck:true,callAmount:0}).potOdds,0);
 const zero={...s,publicSeats:[seat(s.actorId,{stack:100,bet:300,contribution:300}),seat('shove',{stack:0,bet:200,contribution:200,allIn:true})]};
 assert.equal(projected(zero,{...l,callAmount:0,canCheck:true}).effectiveRemainingBB,0);
 const both={...s,publicSeats:[seat(s.actorId,{stack:4000,bet:1000,contribution:1000}),seat('b',{stack:4000,bet:1000,contribution:1000})]};
 assert.equal(projected(both,{...l,callAmount:0,canCheck:true}).effectiveRemainingBB,80);
 assert.equal(projected({...s,publicSeats:[s.publicSeats[0],seat('short',{stack:750})]},l).effectiveRemainingBB,15);
});
test('projection v2 matches real engine states and stays under 24 KiB at the largest valid input',()=>{
 let st=createGame({aiCount:2,startStack:5000,levelEvery:100});st.button=0;st.seats[1].stack=700;st=startHand(st).state;
 const peek=()=>{const legal=legalFor(st);return {legal,snapshot:snapshotDecision(st,legal.toAct,null,{blinds:blindsForLevel(st.level,st.config.blinds0),legal})};};
 let {snapshot,legal}=peek();let state=projected(snapshot,legal);
 assert.equal(snapshot.actorId,'p1');assert.equal(state.potOdds,0.4);assert.equal(state.effectiveRemainingBB,14);
 assert.equal(buildJevCandidates(snapshot,legal).at(-1).key,'raise_to_700');
 st=applyAction(st,'p1','call').state;st=applyAction(st,legalFor(st).toAct,'raise',2500).state;st=applyAction(st,legalFor(st).toAct,'call').state;
 ({snapshot,legal}=peek());state=projected(snapshot,legal);
 assert.equal(legal.toAct,'p1');assert.equal(legal.callAmount,650);
 // T = 50 + 650 = 700; winnable = 700 + 700 + 700.
 assert.equal(state.potOdds,Math.round(650/2100*100)/100);assert.equal(state.effectiveRemainingBB,13);
 // Widest chip values whose derived sums stay safe integers (16 digits each).
 const big=Math.floor(Number.MAX_SAFE_INTEGER/16);const {snapshot:s,legal:l}=fixture();
 const seats=Array.from({length:9},(_,i)=>seat(i?`opp-${i}`:s.actorId,{position:'UTG+5',stack:big,bet:big,contribution:big}));
 const longest=Object.entries(JEV_STYLES).sort((a,b)=>b[1].length-a[1].length)[0][0];
 const huge={...s,handNo:big,blinds:[big,big],potBefore:big,currentBet:big,actorBet:big,effectiveStack:big,holeCards:['As','Ah'],board:['2h','3c','4s','5d','6c'],
  publicSeats:seats,priorActions:Array.from({length:64},(_,i)=>({playerId:seats[i%9].playerId,action:'raise',amount:big,street:'preflop'}))};
 const size=Buffer.byteLength(JSON.stringify(projected(huge,{...l,callAmount:big,canCheck:false},longest)));
 assert.ok(size<24*1024,`${size}`);
});
test('instructions and styles are the approved v3 text for exactly the engine archetypes',()=>{
 for(const phrase of ['never the ranking of hands','effectiveRemainingBB','potOdds','prefer a standard raise size over all-in','weak aces and weak offsuit hands fold'])assert.ok(JEV_INSTRUCTIONS.includes(phrase),phrase);
 assert.deepEqual(Object.keys(JEV_STYLES).sort(),[...ARCHETYPES].sort());
 assert.deepEqual(JEV_STYLES,{
  TAG:'Tight-aggressive: folds most hands before the flop and enters only with strong hands, opening and three-betting them with standard sizes; four-bets only premium hands; folds marginal hands to pressure.',
  LAG:'Loose-aggressive: opens and three-bets a wide range and applies frequent pressure, but still folds hopeless hands and does not stack off deep without a strong hand or a strong draw.',
  Nit:'Very tight: plays few hands and raises only premium hands (big pairs, ace-king), never folding them to a single raise; with other playable hands prefers calling or folding; with a short stack, shoves premiums rather than limping or checking.',
  CallingStation:'Loose-passive: calls often with draws and weak pairs but almost never raises, even with good hands; never bluffs, folds hopeless hands to large bets, and never calls off or moves all-in with a deep stack without a strong made hand.',
  Maniac:'Hyper-aggressive: raises and bluffs far more often than normal, including all-in pressure when the stack is short or the pot is large, but not with hopeless hands deep.',
  Trickster:"Deceptive but disciplined: hand selection is as tight and sound as a solid regular's; the deception comes from how strong hands are played (occasional slow-plays, varied sizes), not from playing more hands."});
 for(const text of Object.values(JEV_STYLES)){assert.ok(text.length<=320);assert.match(text,/^[\x20-\x7e]+$/);}
 assert.equal(projected(fixture().snapshot,fixture().legal,'Nit').style,JEV_STYLES.Nit);
});

test('guard context: deep beyond 40bb, commit keys within 5% of all-in or a 95% call, preflop premiums only',()=>{
 const {snapshot:s,legal:l}=fixture();
 const deep={...s,holeCards:['9s','7d'],currentBet:1800,actorBet:450,priorActions:[raise(150),raise(450,'private-user-id'),raise(1800)],
  publicSeats:[{...s.publicSeats[0],stack:4550,bet:450},{...s.publicSeats[1],stack:3200,bet:1800}]};
 const legal={...l,callAmount:1350,minRaiseTo:3150,maxRaiseTo:5000};
 const candidates=buildJevCandidates(deep,legal);
 assert.deepEqual(jevGuardContext(deep,legal,candidates),{deep:true,commitKeys:['raise_to_5000'],premium:false});
 // Exactly 40bb remaining is not deep; a call of 95% of the stack is a call-off.
 const edge={...s,publicSeats:[{...s.publicSeats[0],stack:2000},{...s.publicSeats[1],stack:2000}]};
 assert.equal(jevGuardContext(edge,{...l,maxRaiseTo:2000},buildJevCandidates(edge,{...l,maxRaiseTo:2000})).deep,false);
 const callOff={...deep,publicSeats:[{...deep.publicSeats[0],stack:1400},deep.publicSeats[1]]};
 assert.ok(jevGuardContext(callOff,{...legal,callAmount:1330,maxRaiseTo:1400},buildJevCandidates(callOff,{...legal,callAmount:1330,minRaiseTo:1400,maxRaiseTo:1400})).commitKeys.includes('call'));
 for(const [hole,premium] of [[['Ah','Ad'],true],[['Kc','Kd'],true],[['Qs','Qh'],true],[['As','Ks'],true],[['Ad','Kc'],true],[['Js','Jh'],false],[['Ts','Th'],false],[['As','Qs'],false]])
  assert.equal(jevGuardContext({...deep,holeCards:hole},legal,candidates).premium,premium,hole.join(''));
 assert.equal(jevGuardContext({...deep,street:'flop',board:['2h','3c','4s'],holeCards:['Ah','Ad']},legal,candidates).premium,false,'postflop has no premium exception');
});
// #234 r3: the ladder on an engine-played street, not hand-made priorActions: a full raise to
// 150, then two short all-ins (180, 200). The small blind still faces one full raise.
test('#234 consecutive short all-ins on a real engine street keep the one-raise ladder',()=>{
 const peek=st=>{const legal=legalFor(st);return {legal,snapshot:snapshotDecision(st,legal.toAct,null,{blinds:blindsForLevel(st.level,st.config.blinds0),legal})};};
 let st=createGame({aiCount:4,startStack:5000,levelEvery:100});st.button=0;
 const order=[];let dry=startHand(structuredClone(st)).state;
 for(let i=0;i<3;i++){const id=legalFor(dry).toAct;order.push(id);dry=applyAction(dry,id,'fold').state;}
 st.seats.find(s=>s.playerId===order[1]).stack=180;st.seats.find(s=>s.playerId===order[2]).stack=200;
 st=startHand(st).state;
 st=applyAction(st,order[0],'raise',150).state;st=applyAction(st,order[1],'raise',180).state;st=applyAction(st,order[2],'raise',200).state;
 const {snapshot,legal}=peek(st);
 assert.deepEqual(snapshot.priorActions.filter(a=>a.action==='raise').map(a=>a.amount),[150,180,200]);
 assert.equal(fullRaisesThisStreet(snapshot,50),1);
 assert.equal(legal.minRaiseTo,300,'the engine also keeps the last full raise (100)');
 assert.deepEqual(buildJevCandidates(snapshot,legal).map(c=>c.key),['fold','call','raise_to_300','raise_to_600','raise_to_680','raise_to_800']);
});
