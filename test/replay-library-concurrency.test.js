import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReplayLibrary } from '../tools/replay-library.js';
import { startDrillServer } from '../tools/drill-server.js';
import { HTTP_WAIT_MS } from '../tools/study-service.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { createReplayGame } from './helpers/replay-library-fixture.mjs';

test('health completes while replay enumeration is suspended at a cooperative yield', async t => {
  const store=createOwnedTempDir('replay-yield-health');createReplayGame(store);
  let release, reached;
  const ready=new Promise(resolve=>reached=resolve), barrier=new Promise(resolve=>release=resolve);
  let first=true;
  const library=createReplayLibrary(store,{yieldTurn:async()=>{if(first){first=false;reached();await barrier;}else await new Promise(setImmediate);}});
  const handle=await startDrillServer({storeDir:store,token:'health-replay',replayLibrary:library});t.after(()=>handle.close());
  const origin='http://127.0.0.1:'+handle.port,headers={'x-drill-token':'health-replay'};
  const listing=fetch(origin+'/api/replays/games',{headers});
  try{
    await ready;
    const response=await fetch(origin+'/api/health',{headers,signal:AbortSignal.timeout(HTTP_WAIT_MS)});
    assert.equal(response.status,200);assert.equal((await response.json()).capabilities.replayLibrary,1);
  }finally{release();}
  assert.equal((await listing).status,200);
});
test('health stays available at the allowed state-file load', async t => {
  const store=createOwnedTempDir('replay-health-load');
  for(let n=0;n<8;n++){
    const game=createReplayGame(store,{hands:1});
    const file=path.join(game.sessionDir,'state.json'), state=JSON.parse(fs.readFileSync(file,'utf8'));
    state.padding='x'.repeat(2*1024*1024-Buffer.byteLength(JSON.stringify(state))-128);fs.writeFileSync(file,JSON.stringify(state));
  }
  const handle=await startDrillServer({storeDir:store,token:'replay-load'});t.after(()=>handle.close());
  const origin='http://127.0.0.1:'+handle.port,headers={'x-drill-token':'replay-load'};
  const listing=fetch(origin+'/api/replays/games',{headers});
  const started=Date.now();
  const health=await fetch(origin+'/api/health',{headers,signal:AbortSignal.timeout(HTTP_WAIT_MS)});
  assert.equal(health.status,200);assert.ok(Date.now()-started<HTTP_WAIT_MS);
  const result=await listing;assert.equal(result.status,200);assert.equal((await result.json()).games.length,8);
});
