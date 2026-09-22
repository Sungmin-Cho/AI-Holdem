// Explicit opt-in real provider play. Never run as part of offline CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startAppService} from '../../tools/app-service.js';
import {inspectStudyService,stopStudyService} from '../../tools/study-service.js';
import {createBrowserWorkspace,runOwnedCommand,hashTree} from '../helpers/learning-browser-fixture.mjs';
export async function runJevLiveJourney(outDir) {
 const workspace=createBrowserWorkspace(),root=workspace.root,userStore=path.resolve('game'),before=hashTree(userStore);
 const session=`jev-${randomUUID()}`,originalFetch=globalThis.fetch,requests=[];let app,failure;
 fs.mkdirSync(outDir,{recursive:true});
 const browser=async args=>{const r=await runOwnedCommand('npx',['--yes','--prefer-offline','agent-browser@0.36.0','--session',session,'--json',...args],{timeoutMs:45000});
 assert.equal(r.exitCode,0,`browser ${args[0]} failed`);const data=JSON.parse(r.stdout);assert.notEqual(data.success,false);return data.data;};
 const evaluate=async expr=>{const data=await browser(['eval',expr]);return data?.result??data;};
 const wait=async fn=>{const end=Date.now()+90000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw new Error('JEV live journey timeout');};
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.typesafe.ai/')){
   assert.ok(requests.length<40,'real-play request cap 40 reached');const started=Date.now();const row={};requests.push(row);
   try{const response=await originalFetch(url,options);row.status=response.status;row.ms=Date.now()-started;const body=await response.clone().json();const a=body.answers?.action;row.answerCheck={model:body.model,type:a?.type,choice:a?.choice,confidence:a?.confidence,probabilities:a?.probabilities,sum:Object.values(a?.probabilities??{}).reduce((a,b)=>a+b,0),usage:body.usage};return response;}catch(e){row.failed=true;row.ms=Date.now()-started;throw e;}
  }return originalFetch(url,options);
 };
 try {
  app=await startAppService(root,{resolver:async()=>({player:null,upper:null,notices:['JEV live test: upper LLM disabled; factual feedback only']})});
  app.manager.setPrefill({pace:'instant',aiCount:2,hands:2});
  await browser(['open',app.url]);await browser(['set','viewport','1280','900']);await browser(['snapshot','-i']);
  await wait(()=>evaluate("document.querySelector('#status')?.textContent==='로비'"));
  await evaluate("document.querySelector('details').open=true");await browser(['snapshot','-i']);
  await browser(['select','[name=opponentRuntime]','jev']);await browser(['screenshot',path.join(outDir,'jev-lobby.png')]);
  await browser(['click','#start']);
  await wait(()=>app.manager.snapshot().state==='playing');await browser(['snapshot','-i']);
  await evaluate("window.__jevDriver=setInterval(()=>{const doc=document.querySelector('#table')?.contentDocument;for(const id of ['btn-check','btn-call','btn-fold']){const b=doc?.getElementById(id);if(b&&!b.disabled&&!b.hidden&&b.getClientRects().length){b.click();break;}}const skip=document.querySelector('#skip-result');if(skip&&!skip.hidden&&!skip.disabled)skip.click();},120)");
  await wait(()=>{const s=app.manager.snapshot();if(s.state==='error'||s.pendingDecision?.status==='recovery_required')throw new Error(s.error??s.pendingDecision.code);return s.state==='completed';});
  await evaluate('clearInterval(window.__jevDriver)');await browser(['snapshot','-i']);await browser(['screenshot',path.join(outDir,'jev-completed.png')]);
  const dir=app.manager.current.sessionDir,engine=JSON.parse(fs.readFileSync(path.join(dir,'state.json'))),loop=JSON.parse(fs.readFileSync(path.join(dir,'loop-state.json')));
  assert.equal(engine.config.opponentRuntime,'jev');assert.equal(engine.handNo,2);assert.equal(loop.phase,'done');assert.ok(requests.length>0);assert.ok(loop.metrics.some(m=>m.runtime==='jev'));
  assert.equal(fs.existsSync(path.join(dir,'.player-sessions.json')),false);assert.equal(JSON.stringify(app.manager.snapshot()).includes('probabilities'),false);
  const diagnostics=loop.jevDiagnostics.entries;
  fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:true,node:process.version,browser:'agent-browser@0.36.0',hands:engine.handNo,aiCount:engine.config.aiCount,upper:'disabled; factual feedback',requests,
   models:[...new Set(diagnostics.map(d=>d.model))],actors:[...new Set(diagnostics.map(d=>d.actor))],decisions:diagnostics.length,
   usage:diagnostics.reduce((a,d)=>({input_tokens:a.input_tokens+(d.usage?.input_tokens??0),output_tokens:a.output_tokens+(d.usage?.output_tokens??0)}),{input_tokens:0,output_tokens:0})},null,2));
 }catch(error){failure=error;fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:false,code:error.code??null,message:error.message,requests},null,2));try{await browser(['screenshot',path.join(outDir,'failure.png')]);}catch{}}
 finally{
  try{await browser(['close']);await app?.close();const study=await inspectStudyService(root);if(study.status==='running')await stopStudyService(root,{expectedInstanceId:study.instanceId});assert.equal(hashTree(userStore),before);workspace.close();}
  catch(error){failure??=error;}
  globalThis.fetch=originalFetch;
 }
 if(failure)throw failure;
}
if(!process.env.NODE_TEST_CONTEXT&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv.includes('--live'))throw new Error('--live required');
 const i=process.argv.indexOf('--out-dir');if(i<0)throw new Error('--out-dir required');
 await runJevLiveJourney(path.resolve(process.argv[i+1]));console.log('JEV real API browser play PASS');
}
