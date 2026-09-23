import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildJevCandidates,projectJevState,validateJevAnswer} from '../tools/jev-player.js';
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
 const {snapshot:s,legal:l}=fixture();assert.deepEqual(buildJevCandidates(s,l).map(c=>c.key),['fold','call','raise_to_100','raise_to_150','raise_to_200','raise_to_5000']);
 assert.deepEqual(buildJevCandidates(s,{...l,minRaiseTo:100,maxRaiseTo:80}).at(-1),{key:'raise_to_80',action:'raise',amount:80});
 assert.deepEqual(buildJevCandidates(s,{...l,canCheck:true,canRaise:false,callAmount:0}),[{key:'check',action:'check'}]);
 assert.throws(()=>buildJevCandidates(s,{...l,canCheck:true}),{code:'JEV_INPUT_INVALID'});
 assert.deepEqual(buildJevCandidates(s,{...l,canRaise:false}).map(c=>c.key),['fold','call']);
 assert.deepEqual(buildJevCandidates({...s,street:'flop',potBefore:100,actorBet:25},{...l,callAmount:25,minRaiseTo:100}).map(c=>c.key),['fold','call','raise_to_100','raise_to_133','raise_to_175','raise_to_5000']);
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
