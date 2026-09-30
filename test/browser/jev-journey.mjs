import {finishJourney,selfTestJourney,cleanupJourney} from './journey-exit.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startAppService} from '../../tools/app-service.js';
import {inspectStudyService,stopStudyService} from '../../tools/study-service.js';
import {createBrowserWorkspace,runOwnedCommand,hashTree} from '../helpers/learning-browser-fixture.mjs';
export const requiredJourneyChecks=['jev-selection','soft-cancel','retry-no-fresh-session','end-without-key','private-diagnostics','user-store-unchanged','owned-cleanup'];
export async function runJevJourney(outDir){
 const workspace=createBrowserWorkspace(),root=workspace.root,userStore=path.resolve('game'),before=hashTree(userStore),checks=[];
 const session=`jev-recovery-${randomUUID()}`,originalFetch=globalThis.fetch,originalKey=process.env.TYPESAFE_API_KEY;let app,failure,calls=0;
 fs.mkdirSync(outDir,{recursive:true});
 const browser=async args=>{const r=await runOwnedCommand('npx',['--yes','--prefer-offline','agent-browser@0.36.0','--session',session,'--json',...args],{timeoutMs:45000});assert.equal(r.exitCode,0,`browser ${args[0]} failed`);const d=JSON.parse(r.stdout);assert.notEqual(d.success,false);return d.data;};
 const evaluate=async expr=>{const d=await browser(['eval',expr]);return d?.result??d;};
 const wait=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw new Error('JEV recovery browser timeout');};
 process.env.TYPESAFE_API_KEY='synthetic-browser-test';
 globalThis.fetch=async(url,options)=>{
  if(!String(url).startsWith('https://api.typesafe.ai/'))return originalFetch(url,options);
  calls++;
  if(calls===1)return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('synthetic abort','AbortError')),{once:true});});
  const request=JSON.parse(options.body),keys=Object.keys(request.questions.action.criteria),choice=keys.includes('check')?'check':keys.includes('call')?'call':keys[0];
  return new Response(JSON.stringify({model:'jev-1.13.0',answers:{action:{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,Number(k===choice)]))}}}),{headers:{'content-type':'application/json'}});
 };
 try {
  app=await startAppService(root,{resolver:async()=>({player:null,upper:null,notices:[]})});app.manager.setPrefill({aiCount:2,hands:2,pace:'instant',playerSoftMs:100,playerHardMs:15000});
  await browser(['open',app.url]);await browser(['snapshot','-i']);await wait(()=>evaluate("document.querySelector('#status').textContent==='로비'"));
  await evaluate("document.querySelector('details').open=true");await browser(['snapshot','-i']);await browser(['select','[name=opponentRuntime]','jev']);await browser(['click','#start']);
  await wait(()=>app.manager.snapshot().state==='playing');checks.push('jev-selection');await browser(['snapshot','-i']);
  await evaluate("window.__jevDriver=setInterval(()=>{const d=document.querySelector('#table')?.contentDocument;const b=d?.getElementById('btn-call');const c=d?.getElementById('btn-check');for(const x of [c,b])if(x&&!x.disabled&&!x.hidden&&x.getClientRects().length){x.click();break;}},100)");
  await wait(()=>app.manager.snapshot().pendingDecision?.softWait&&calls===1);await evaluate('clearInterval(window.__jevDriver)');await browser(['snapshot','-i']);await browser(['click','#interrupt-decision']);
  await wait(()=>app.manager.snapshot().state==='paused');assert.equal(app.manager.snapshot().pendingDecision.code,'INTERRUPTED');checks.push('soft-cancel');await wait(()=>evaluate("document.querySelector('#status').textContent.includes('일시정지')"));await browser(['snapshot','-i']);await browser(['click','#menu']);
  assert.equal(await evaluate("document.querySelector('#retry-fresh-session').hidden"),true);await browser(['screenshot',path.join(outDir,'jev-recovery.png')]);
  await browser(['snapshot','-i']);await browser(['click','#retry-decision']);await wait(()=>calls>=2);await browser(['click','#menu']);await wait(()=>app.manager.snapshot().state==='paused');checks.push('retry-no-fresh-session');
  assert.equal(JSON.stringify(app.manager.snapshot()).includes('probabilities'),false);assert.equal(JSON.stringify(app.manager.snapshot()).includes('synthetic-browser-test'),false);checks.push('private-diagnostics');
  delete process.env.TYPESAFE_API_KEY;await browser(['snapshot','-i']);await browser(['click','#end']);await browser(['snapshot','-i']);
  // The existing end dialog uses a separate confirmation button.
  await browser(['click','#confirm-yes']);await wait(()=>app.manager.snapshot().state==='ended');checks.push('end-without-key');
 }catch(error){failure=error;try{await browser(['screenshot',path.join(outDir,'failure.png')]);}catch{}}
 finally{
  const cleanup=await cleanupJourney({failure,steps:[()=>browser(['close']),()=>app?.close(),async()=>{const study=await inspectStudyService(root);if(study.status==='running')await stopStudyService(root,{expectedInstanceId:study.instanceId});},()=>{assert.equal(hashTree(userStore),before);checks.push('user-store-unchanged');},()=>workspace.close()]});
  failure=cleanup.failure;if(!cleanup.errors.length)checks.push('owned-cleanup');globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=originalKey;
  fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:!failure&&requiredJourneyChecks.every(c=>checks.includes(c)),checks,calls,error:failure?.message},null,2));
  }
  finishJourney({ required: requiredJourneyChecks, recorded: checks, failure });
}
if(!process.env.NODE_TEST_CONTEXT&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!selfTestJourney(requiredJourneyChecks)){const i=process.argv.indexOf('--out-dir');if(i<0)throw new Error('--out-dir required');await runJevJourney(path.resolve(process.argv[i+1]));console.log('JEV recovery browser PASS');}
}
