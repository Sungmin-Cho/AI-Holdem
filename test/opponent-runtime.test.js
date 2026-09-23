import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JEV_CONFIG,JEV_CONFIG_LEGACY,rollForwardJevConfig,jevRollForwardOf,resolveOpponentRuntime,validateJevConfig} from '../shared/opponent-runtime.js';

const OLD={schemaVersion:1,model:'jev-1.13.0',questionVersion:'poker-choice-v0',candidateVersion:'legal-menu-v0',projectionVersion:0};
const unsupported={code:'JEV_CONFIG_UNSUPPORTED'};

test('current descriptor rolls forward to a fresh unfrozen copy without a marker',()=>{
 const r=rollForwardJevConfig(JEV_CONFIG);
 assert.deepEqual(r,{config:{...JEV_CONFIG},rolledForward:false});
 assert.notEqual(r.config,JEV_CONFIG);assert.equal(Object.isFrozen(r.config),false);
 assert.equal(Object.isFrozen(JEV_CONFIG_LEGACY),true);
 for(const legacy of JEV_CONFIG_LEGACY){
  const rolled=rollForwardJevConfig(legacy);
  assert.deepEqual(rolled,{config:{...JEV_CONFIG},rolledForward:true,from:{...legacy}});
  assert.notEqual(rolled.from,legacy);
 }
});
test('legacy branch rolls a known descriptor forward and records a copy of its origin',()=>{
 const legacy=[Object.freeze({...OLD})];
 const r=rollForwardJevConfig({...OLD},{legacy});
 assert.deepEqual(r,{config:{...JEV_CONFIG},rolledForward:true,from:OLD});
 assert.notEqual(r.from,legacy[0]);assert.equal(Object.isFrozen(r.from),false);
 assert.throws(()=>rollForwardJevConfig({...OLD,projectionVersion:9},{legacy}),unsupported);
 assert.throws(()=>rollForwardJevConfig({...OLD,extra:1},{legacy}),unsupported);
});
test('unknown, damaged or non-object descriptors stay unsupported',()=>{
 for(const value of [{...JEV_CONFIG,model:'x'},{...JEV_CONFIG,extra:1},null,undefined,[],'jev',Object.assign([],JEV_CONFIG)]){
  assert.throws(()=>rollForwardJevConfig(value),unsupported);
 }
 const missing={...JEV_CONFIG};delete missing.projectionVersion;assert.throws(()=>rollForwardJevConfig(missing),unsupported);
});
test('jevRollForwardOf judges by the loop descriptor and rejects unsupported engine or loop copies',()=>{
 const engine={config:{opponentRuntime:'jev',jev:{...JEV_CONFIG}}};
 assert.deepEqual(jevRollForwardOf(engine,{jev:{...JEV_CONFIG}}),{config:{...JEV_CONFIG},rolledForward:false});
 assert.deepEqual(jevRollForwardOf(engine,undefined),{config:{...JEV_CONFIG},rolledForward:false});
 assert.deepEqual(jevRollForwardOf(engine,{}),{config:{...JEV_CONFIG},rolledForward:false});
 assert.throws(()=>jevRollForwardOf({config:{jev:{...JEV_CONFIG,model:'x'}}},{jev:{...JEV_CONFIG}}),unsupported);
 assert.throws(()=>jevRollForwardOf(engine,{jev:{...JEV_CONFIG,model:'x'}}),unsupported);
 assert.throws(()=>jevRollForwardOf({config:{}},undefined),unsupported);
 // Injected legacy: loop legacy rolls forward even when the engine is current.
 const legacy=[Object.freeze({...OLD})];
 assert.deepEqual(jevRollForwardOf(engine,{jev:{...OLD}},{legacy}),{config:{...JEV_CONFIG},rolledForward:true,from:OLD});
 assert.deepEqual(jevRollForwardOf({config:{jev:{...OLD}}},undefined,{legacy}),{config:{...JEV_CONFIG},rolledForward:true,from:OLD});
 assert.deepEqual(jevRollForwardOf({config:{jev:{...OLD}}},{jev:{...JEV_CONFIG}},{legacy}),{config:{...JEV_CONFIG},rolledForward:false});
});
test('resolveOpponentRuntime keeps evidence mismatch and unsupported descriptor rejection',()=>{
 const engine={config:{opponentRuntime:'jev',jev:{...JEV_CONFIG}}};
 assert.equal(resolveOpponentRuntime(engine,{loop:{opponentRuntime:'jev',jev:{...JEV_CONFIG}}}),'jev');
 assert.throws(()=>resolveOpponentRuntime(engine,{loop:{opponentRuntime:'llm'}}),{code:'OPPONENT_RUNTIME_MISMATCH'});
 assert.throws(()=>resolveOpponentRuntime(engine,{setup:{opponentRuntime:'policy'}}),{code:'OPPONENT_RUNTIME_MISMATCH'});
 assert.throws(()=>resolveOpponentRuntime(engine,{explicit:'llm'}),{code:'OPPONENT_RUNTIME_MISMATCH'});
 assert.throws(()=>resolveOpponentRuntime({config:{opponentRuntime:'jev',jev:{...JEV_CONFIG,model:'x'}}}),unsupported);
 assert.throws(()=>resolveOpponentRuntime(engine,{loop:{jev:{...JEV_CONFIG,extra:1}}}),unsupported);
 assert.throws(()=>resolveOpponentRuntime({config:{opponentRuntime:'policy',jev:{...JEV_CONFIG}}}),unsupported);
 assert.deepEqual(validateJevConfig(JEV_CONFIG),{...JEV_CONFIG});
});
const V1={schemaVersion:1,model:'jev-1.13.0',questionVersion:'poker-choice-v1',candidateVersion:'legal-menu-v1',projectionVersion:1};
const V2={schemaVersion:1,model:'jev-1.13.0',questionVersion:'poker-choice-v2',candidateVersion:'legal-menu-v2',projectionVersion:2,selectionVersion:'class-sample-v1'};
test('descriptor v2 is current and the only legacy entry is the exact v1 descriptor',()=>{
 assert.deepEqual(JEV_CONFIG,V2);assert.deepEqual(JEV_CONFIG_LEGACY,[V1]);
 assert.throws(()=>validateJevConfig(V1),unsupported);assert.deepEqual(validateJevConfig(V2),V2);
 assert.deepEqual(rollForwardJevConfig(V1),{config:V2,rolledForward:true,from:V1});
 assert.deepEqual(rollForwardJevConfig({...V1}).from,V1);
 assert.throws(()=>rollForwardJevConfig({...V1,model:'jev-1.12.0'}),unsupported);
});
test('roll-forward is judged by the loop copy with the real legacy list',()=>{
 const engineV1={config:{opponentRuntime:'jev',jev:{...V1}}},engineV2={config:{opponentRuntime:'jev',jev:{...V2}}};
 assert.deepEqual(jevRollForwardOf(engineV1,{jev:{...V1}}),{config:V2,rolledForward:true,from:V1});
 assert.deepEqual(jevRollForwardOf(engineV1,{jev:{...V2}}),{config:V2,rolledForward:false});
 assert.deepEqual(jevRollForwardOf(engineV1,undefined),{config:V2,rolledForward:true,from:V1});
 assert.deepEqual(jevRollForwardOf(engineV2,undefined),{config:V2,rolledForward:false});
 assert.deepEqual(jevRollForwardOf(engineV2,{jev:{...V2}}),{config:V2,rolledForward:false});
 assert.equal(resolveOpponentRuntime(engineV1),'jev');
 assert.equal(resolveOpponentRuntime(engineV1,{loop:{opponentRuntime:'jev',jev:{...V2}}}),'jev');
 assert.equal(resolveOpponentRuntime(engineV1,{loop:{opponentRuntime:'jev',jev:{...V1}}}),'jev');
 assert.throws(()=>resolveOpponentRuntime(engineV1,{loop:{opponentRuntime:'llm',jev:{...V1}}}),{code:'OPPONENT_RUNTIME_MISMATCH'});
 assert.throws(()=>resolveOpponentRuntime({config:{jev:{...V1}}}),unsupported);
});
