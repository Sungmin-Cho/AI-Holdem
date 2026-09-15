import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseGameLoopArgs,initializePreparedSession} from '../tools/game-loop.js';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
const run=promisify(execFile);
const TIMEOUT=process.platform==='win32'?120000:20000;
// Keep OS identity tools available, but exclude user/npm provider CLI folders.
const systemPath=process.platform==='win32'
  ? ['System32','System32/Wbem','System32/WindowsPowerShell/v1.0'].map(p=>path.join(process.env.SystemRoot??'C:\\Windows',p)).join(path.delimiter)
  : '/usr/bin:/bin:/usr/sbin:/sbin';
test('#197 legacy abort flag requires resume, a safe operation ID and no retry',()=>{
  assert.equal(parseGameLoopArgs(['--resume','--abort-unrecoverable','exit-1']).abortUnrecoverableId,'exit-1');
  for(const args of [['--abort-unrecoverable','exit-1'],['--resume','--abort-unrecoverable','../escape'],
    ['--resume','--retry-decision','d-1-preflop-0','--abort-unrecoverable','exit-1']]){
    assert.throws(()=>parseGameLoopArgs(args),{code:'USAGE'});
  }
});
test('#197 real legacy CLI aborts invalid recovery with no provider CLI available and no late file write',{timeout:TIMEOUT},async()=>{
  const root=createOwnedTempDir('legacy-abort-unrecoverable');
  await initializePreparedSession(root,{ai:1,mode:'cash-training',hands:20,opponentRuntime:'policy'});
  const engine=JSON.parse(fs.readFileSync(path.join(root,'state.json')));
  const raw=Buffer.from(JSON.stringify({phase:'playing',sessionToken:engine.sessionToken,
    gameEpoch:createHash('sha256').update(engine.sessionToken).digest('hex'),
    pendingDecision:{schemaVersion:1,generation:'RAW_INFINITY',gameEpoch:'foreign',status:'running'}}).replace('"RAW_INFINITY"','1e400'));
  fs.writeFileSync(path.join(root,'loop-state.json'),raw);
  const args=[path.resolve('tools/game-loop.js'),'--game-dir',root,'--resume','--abort-unrecoverable','cli-exit'];
  const result=await run(process.execPath,args,{env:{...process.env,PATH:systemPath},timeout:TIMEOUT-1000,maxBuffer:1024*1024});
  assert.equal(JSON.parse(result.stdout.trim()).code,'GAME_ENDED');
  const state=JSON.parse(fs.readFileSync(path.join(root,'loop-state.json')));
  assert.equal(state.phase,'aborted');
  assert.deepEqual(fs.readFileSync(path.join(root,state.abandonedPendingDecision.sidecar)),raw);
  assert.equal(fs.existsSync(path.join(root,'loop.lock.d')),false);
  const before=fs.readFileSync(path.join(root,'loop-state.json'));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual(fs.readFileSync(path.join(root,'loop-state.json')),before);
  const ended=fs.readFileSync(path.join(root,'state.json'));
  const again=await run(process.execPath,[path.resolve('tools/game-loop.js'),'--game-dir',root,'--resume'],{env:{...process.env,PATH:systemPath},timeout:TIMEOUT-1000});
  assert.equal(JSON.parse(again.stdout.trim()).code,'GAME_ENDED');
  assert.deepEqual(fs.readFileSync(path.join(root,'state.json')),ended);
});
