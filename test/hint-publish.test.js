import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {hintFixture} from './helpers/hint-fixture.mjs';
import {normalizeActionRequest} from '../publish-contract.js';
import {createHintState,hintPotPercent,formatHint} from '../server/public/hint-format.js';
import {verifyHintPublication} from '../tools/hint-proof.js';

test('marker precedes publication, cached resync does not mutate, reconnect revalidates',async t=>{
  const f=await hintFixture(t);const envelope=await f.prepare();
  assert.equal(envelope.hint?.status,'supported');
  const marker=f.state().hand.hintExposures[envelope.next.decisionId];
  assert.equal(marker.exposureId,envelope.hint.exposureId);
  const before=fs.readFileSync(path.join(f.dir,'state.json'),'utf8');
  await f.prepare();assert.equal(fs.readFileSync(path.join(f.dir,'state.json'),'utf8'),before);
  assert.equal((await f.request('publish',{publishId:1,view:envelope.view,hint:envelope.hint})).status,200);
  assert.deepEqual((await f.request('snapshot')).body.hint,envelope.hint);
  const stored=JSON.parse(fs.readFileSync(path.join(f.dir,'ui-snapshot.json')));
  assert.equal(stored.history[0].payload.hint,undefined);
  await f.restart();assert.deepEqual((await f.request('snapshot')).body.hint,envelope.hint);
  const state=f.state();delete state.hand.hintExposures[envelope.next.decisionId];
  fs.writeFileSync(path.join(f.dir,'state.json'),JSON.stringify(state));
  assert.equal((await f.request('snapshot')).body.hint,null);
});
test('forged numeric frequency rejected; stale exact publication strips only hint',async t=>{
  const f=await hintFixture(t);const envelope=await f.prepare();
  const forged=structuredClone(envelope.hint);
  forged.actions=forged.actions.length===1
    ? (forged.actions[0].action==='fold'?[{action:'raise',frequency:1,raiseToChips:forged.coverage.reference.sizing?.raiseToChips??forged.coverage.input.legal.minRaiseToChips}]:[{action:'fold',frequency:1}])
    : forged.actions.map((row,index)=>({...row,frequency:row.frequency+(index===0?.0001:index===1?-.0001:0)}));
  assert.equal((await f.request('publish',{publishId:1,view:envelope.view,hint:forged})).status,400);
  f.cli('step','user','fold','--expect-version',String(envelope.stateVersion));
  const result=await f.request('publish',{publishId:1,view:envelope.view,hint:envelope.hint,messages:[{type:'narration',text:'preserved'}]});
  assert.equal(result.status,200);assert.equal(result.body.hintDisposition,'stale-stripped');
  const snapshot=(await f.request('snapshot')).body;assert.equal(snapshot.hint,null);assert.equal(snapshot.log.at(-1).text,'preserved');
});
test('action receipt hides same-D numbers before engine applies; descriptor failure stops future marks',async t=>{
  const f=await hintFixture(t);const envelope=await f.prepare();
  await f.request('publish',{publishId:1,view:envelope.view,hint:envelope.hint});
  const action={gameEpoch:f.epoch,decisionId:envelope.next.decisionId,requestId:'hint-test-1',action:'fold'};
  action.digest=normalizeActionRequest(action).digest;
  assert.equal((await f.request('action',action)).status,200);
  assert.equal((await f.request('snapshot')).body.hint,null);
  const descriptor=path.join(f.dir,'reference-source.json');
  fs.renameSync(descriptor,`${descriptor}.old`);fs.copyFileSync(`${descriptor}.old`,descriptor);
  const publication=await f.request('publish',{publishId:2,view:envelope.view,hint:envelope.hint});
  assert.equal(publication.status,200);assert.equal(publication.body.hintDisposition,'unverifiable');
  const before=fs.readFileSync(path.join(f.dir,'state.json'),'utf8');
  const next=await f.prepare();assert.equal(next.hint.code,'HINT_RELAY_UNAVAILABLE');
  assert.equal(fs.readFileSync(path.join(f.dir,'state.json'),'utf8'),before);
});
test('query is memoized but identity remains checked across repeated GET-equivalent projections',async t=>{
  const f=await hintFixture(t);const envelope=await f.prepare();const context={};
  await verifyHintPublication({sessionDir:f.dir,token:f.token,context,initialize:true});
  for(let i=0;i<10;i++)assert.equal((await verifyHintPublication({sessionDir:f.dir,token:f.token,context,hint:envelope.hint,view:envelope.view})).hint.status,'supported');
  assert.equal(context.queryCount,1);
  f.cli('step','user','fold');
  assert.equal((await verifyHintPublication({sessionDir:f.dir,token:f.token,context,hint:envelope.hint,view:envelope.view})).hint,null);
});
test('late equal-revision snapshot cannot undo hint-clear; fresh reconciliation can restore',()=>{
  const state=createHintState(),hint={decisionId:'d-1-preflop-0'},view={legal:{decisionId:hint.decisionId,toAct:'user'}};
  const old=state.capture();assert.equal(state.accept(hint,view,{generation:old}),hint);
  state.invalidate(hint.decisionId);
  assert.equal(state.accept(hint,view,{generation:old,canRestore:true}),null);
  assert.equal(state.accept(hint,view,{generation:state.capture()}),null);
  assert.equal(state.accept(hint,view,{generation:state.capture(),canRestore:true}),hint);
});
test('off creates no marker or numeric hint; formatter defines raise-to and call-after-pot sizing',async t=>{
  const f=await hintFixture(t,{hints:'off'});const envelope=await f.prepare();
  assert.equal(envelope.hint,undefined);assert.deepEqual(f.state().hand.hintExposures,{});
  const hint={status:'supported',source:{id:'reference',version:'2.0.0'},coverage:{referenceMatch:'exact',reasonCodes:[],input:{bbChips:50,legal:{canCheck:false,canRaise:true,actorBetChips:0,callAmountChips:50,maxRaiseToChips:5000}}},actions:[{action:'raise',frequency:1,raiseToChips:250}]};
  assert.equal(hintPotPercent(hint,150),100);
  assert.match(formatHint(hint).lines[2],/총 250칩까지 \(5.00 BB\), 추가 250칩/);
});

test('overlapping authenticated SSE fanouts preserve unique increasing revisions',async t=>{
 const f=await hintFixture(t),e=await f.prepare();
 await f.request('publish',{publishId:1,view:e.view,hint:e.hint});
 const abort=new AbortController();t.after(()=>abort.abort());
 const response=await fetch(f.url()+`/api/events?token=${f.token}&after=0`,{signal:abort.signal});
 const reader=response.body.getReader();let buffer='',ids=[];
 const reading=(async()=>{try{while(ids.length<3){const {value,done}=await reader.read();if(done)break;buffer+=new TextDecoder().decode(value);let at;while((at=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,at);buffer=buffer.slice(at+2);const id=/^id: (\d+)$/m.exec(frame);if(id)ids.push(Number(id[1]));}}}catch(error){if(!abort.signal.aborted)throw error;}})();
 await Promise.all([f.request('publish',{publishId:2,view:e.view,hint:e.hint}),f.request('publish',{publishId:3,view:e.view,hint:e.hint})]);
 let timer;try{await Promise.race([reading,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SSE delivery deadline')),5000);})]);}finally{clearTimeout(timer);abort.abort();}
 assert.deepEqual(ids,[1,2,3]);
});
