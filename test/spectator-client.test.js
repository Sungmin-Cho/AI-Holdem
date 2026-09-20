import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual SSE reset adapter, rather than a duplicate implementation.
const source=fs.readFileSync(new URL('../server/public/app.js',import.meta.url),'utf8');
const adapter=source.slice(source.indexOf('function applyMessage(m) {'),source.indexOf("if (!token) showBootError"));

test('seat-scoped recovery snapshot updates action authority as well as the screen',()=>{
  const calls=[];
  const context={revision:1,booted:true,renderSnapshot:snap=>calls.push(['render',snap.view]),
    actionController:{observe:(view,meta)=>calls.push(['observe',view,meta.revision])},setConn:()=>{},render:()=>{throw Error('not a delta');}};
  vm.runInNewContext(adapter+'\nthis.deliver=applyMessage;',context);
  const view={viewer:'h1',legal:{decisionId:'new-turn'}};
  context.deliver({revision:2,snapshot:{revision:2,view}});
  assert.deepEqual(calls,[['render',view],['observe',view,2]]);
  assert.equal(context.revision,2);
  context.deliver({revision:1,snapshot:{view:{viewer:'h1'}}});
  assert.equal(calls.length,2);
});

test('spectator reset does not restore a disconnected action controller',()=>{
  const context={revision:1,booted:true,actionController:{observe:()=>{throw Error('observer cannot act');}},setConn:()=>{},render:()=>{}};
  context.renderSnapshot=()=>{context.actionController=null;};
  vm.runInNewContext(adapter+'\nthis.deliver=applyMessage;',context);
  context.deliver({revision:2,snapshot:{revision:2,view:{viewer:null,holeCardsByPlayerId:{}}}});
  assert.equal(context.actionController,null);
  assert.equal(context.revision,2);
});
