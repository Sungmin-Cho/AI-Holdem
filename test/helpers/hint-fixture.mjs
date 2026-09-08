import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createOwnedTempDir } from './owned-fixtures.mjs';
import { startHand } from '../../engine/hand.js';
import { startServer } from '../../server/server.js';
import { resolveSessionReference } from '../../tools/reference-source.js';
import { createHintControl } from '../../tools/hint-control.js';
import { gameEpochOf } from '../../publish-contract.js';
export async function hintFixture(t,{hints='on'}={}) {
  const dir=createOwnedTempDir('holdem-hint');
  const cli=(...args)=>JSON.parse(execFileSync(process.execPath,[new URL('../../engine/cli.js',import.meta.url).pathname,...args,'--game-dir',dir],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  cli('init','--ai','5','--mode','cash-training','--hints',hints);
  const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));
  state.button=2;
  const started=startHand(state).state;
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(started));
  resolveSessionReference(dir,{createNew:true});
  const token=state.sessionToken,epoch=gameEpochOf(token);
  let relay=await startServer({gameDir:dir,port:0,token});
  t.after(async()=>{if(relay.server.listening)await relay.close();});
  const request=async(endpoint,body)=>{
    const response=await fetch(`http://127.0.0.1:${relay.port}/api/${endpoint}?token=${token}`,{
      ...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  };
  const control=createHintControl({sessionDir:dir,runCli:async args=>cli(...args),ready:async()=>{
    const result=await request('health');return result.body.capabilities?.preActionHintsReady===true;
  }});
  return {dir,cli,request,epoch,token,control,
    prepare:()=>control.prepare(cli('step')),
    state:()=>JSON.parse(fs.readFileSync(path.join(dir,'state.json'))),
    restart:async()=>{await relay.close();relay=await startServer({gameDir:dir,port:0,token});},
    url:()=>`http://127.0.0.1:${relay.port}`,
  };
}
