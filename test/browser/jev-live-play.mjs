// Explicit opt-in real provider play. Never run as part of offline CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startAppService} from '../../tools/app-service.js';
import {inspectStudyService,stopStudyService} from '../../tools/study-service.js';
import {createBrowserWorkspace,runOwnedCommand,hashTree} from '../helpers/learning-browser-fixture.mjs';
export const DEFAULT_LIVE_OPTIONS=Object.freeze({hands:2,ai:2,mode:'cash-training',maxRequests:null,waitMs:90000,humanPolicy:'check-call',keepStore:false});
// With an explicit request budget the journey stops at a hand boundary before the cap;
// the reserve covers the AI decisions of the hand still in progress.
const HAND_RESERVE=40;
// The loop keeps at most 256 KiB of private diagnostics and drops the oldest entries past it
// (tools/jev-diagnostics.js). The journey copies each entry the moment it appears, so the gate
// can restore a truncated run: it accepts the mirror only when the loop's kept entries equal
// its tail and it holds exactly kept + dropped entries.
export function newMirrorEntries(loopState,seen){
 const entries=loopState?.jevDiagnostics?.entries;if(!Array.isArray(entries))return [];
 const fresh=[];
 for(const entry of entries){const key=`${entry?.decisionId}#${entry?.generation}`;if(seen.has(key))continue;seen.add(key);fresh.push(entry);}
 return fresh;
}
// Gate evidence holds hole cards and private probabilities: owner-only permissions.
export function privateTree(dir){
 if(!fs.existsSync(dir))return;fs.chmodSync(dir,0o700);
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())privateTree(p);else fs.chmodSync(p,0o600);}
}
export function parseLiveArgs(argv){
 const value=name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1];};
 const int=(name,fallback)=>{const raw=value(name);if(raw===undefined)return fallback;const n=Number(raw);if(!Number.isSafeInteger(n)||n<1)throw new Error(`${name} must be a positive integer`);return n;};
 const options={...DEFAULT_LIVE_OPTIONS,hands:int('--hands',DEFAULT_LIVE_OPTIONS.hands),ai:int('--ai',DEFAULT_LIVE_OPTIONS.ai),
  mode:value('--mode')??DEFAULT_LIVE_OPTIONS.mode,maxRequests:int('--max-requests',null),waitMs:int('--wait-ms',DEFAULT_LIVE_OPTIONS.waitMs),
  humanPolicy:value('--human-policy')??DEFAULT_LIVE_OPTIONS.humanPolicy,keepStore:argv.includes('--keep-store')};
 if(!['cash-training','tournament'].includes(options.mode))throw new Error('--mode must be cash-training or tournament');
 if(!['check-call','check-fold'].includes(options.humanPolicy))throw new Error('--human-policy must be check-call or check-fold');
 if(options.mode==='tournament'&&argv.includes('--hands'))throw new Error('--hands does not apply to tournament');
 return options;
}
export async function runJevLiveJourney(outDir,input={}) {
 const options={...DEFAULT_LIVE_OPTIONS,...input},cap=options.maxRequests??40,softCap=options.maxRequests===null?Infinity:Math.max(1,cap-HAND_RESERVE);
 const workspace=createBrowserWorkspace(),root=workspace.root,userStore=path.resolve('game'),before=hashTree(userStore);
 const session=`jev-${randomUUID()}`,originalFetch=globalThis.fetch,requests=[];let app,failure,summary=null,stoppedBy=null,sessionDir=null;
 // Owner-only from the first byte: files this process and its browser children create are 0600/0700.
 const umask=process.umask(0o077);
 fs.mkdirSync(outDir,{recursive:true,mode:0o700});fs.chmodSync(outDir,0o700);
 const mirrorFile=path.join(outDir,'diagnostics-mirror.jsonl'),mirrored=new Set();let mirrorTimer=null;
 const mirrorOnce=()=>{
  if(!sessionDir)return;
  let loopState;try{loopState=JSON.parse(fs.readFileSync(path.join(sessionDir,'loop-state.json'),'utf8'));}catch{return;}
  const fresh=newMirrorEntries(loopState,mirrored);
  if(fresh.length)fs.appendFileSync(mirrorFile,fresh.map(e=>JSON.stringify(e)+'\n').join(''),{mode:0o600});
 };
 const shot=async name=>{const file=path.join(outDir,name);await browser(['screenshot',file]);fs.chmodSync(file,0o600);};
 const browser=async args=>{const r=await runOwnedCommand('npx',['--yes','--prefer-offline','agent-browser@0.36.0','--session',session,'--json',...args],{timeoutMs:45000});
 assert.equal(r.exitCode,0,`browser ${args[0]} failed`);const data=JSON.parse(r.stdout);assert.notEqual(data.success,false);return data.data;};
 const evaluate=async expr=>{const data=await browser(['eval',expr]);return data?.result??data;};
 const wait=async(fn,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw new Error('JEV live journey timeout');};
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.typesafe.ai/')){
   assert.ok(requests.length<cap,`real-play request cap ${cap} reached`);const started=Date.now();const row={};requests.push(row);
   try{const response=await originalFetch(url,options);row.status=response.status;row.ms=Date.now()-started;const body=await response.clone().json();const a=body.answers?.action;row.answerCheck={model:body.model,type:a?.type,choice:a?.choice,confidence:a?.confidence,probabilities:a?.probabilities,sum:Object.values(a?.probabilities??{}).reduce((a,b)=>a+b,0),usage:body.usage};return response;}catch(e){row.failed=true;row.ms=Date.now()-started;throw e;}
  }return originalFetch(url,options);
 };
 const command=async kind=>{
  const s=app.manager.snapshot(),row=app.manager.command({requestId:randomUUID(),expectedInstanceId:s.instanceId,expectedAppRevision:s.appRevision,expectedGameId:s.gameId,expectedSelectionVersion:s.selectionVersion,kind});
  let receipt;await wait(()=>{receipt=app.manager.receipt(row.requestId);return receipt.status!=='accepted';});
  assert.equal(receipt.status,'succeeded',`${kind}: ${receipt.error}`);
 };
 try {
  app=await startAppService(root,{resolver:async()=>({player:null,upper:null,notices:['JEV live test: upper LLM disabled; factual feedback only']})});
  app.manager.setPrefill({pace:'instant',aiCount:options.ai,...(options.mode==='tournament'?{mode:'tournament'}:{hands:options.hands})});
  await browser(['open',app.url]);await browser(['set','viewport','1280','900']);await browser(['snapshot','-i']);
  await wait(()=>evaluate("document.querySelector('#status')?.textContent==='로비'"));
  await evaluate("document.querySelector('details').open=true");await browser(['snapshot','-i']);
  await browser(['select','[name=opponentRuntime]','jev']);await shot('jev-lobby.png');
  await browser(['click','#start']);
  await wait(()=>app.manager.snapshot().state==='playing');await browser(['snapshot','-i']);
  sessionDir=app.manager.current.sessionDir;mirrorTimer=setInterval(mirrorOnce,100);
  const buttons=JSON.stringify(options.humanPolicy==='check-fold'?['btn-check','btn-fold']:['btn-check','btn-call','btn-fold']);
  await evaluate(`window.__jevDriver=setInterval(()=>{const doc=document.querySelector('#table')?.contentDocument;for(const id of ${buttons}){const b=doc?.getElementById(id);if(b&&!b.disabled&&!b.hidden&&b.getClientRects().length){b.click();break;}}const skip=document.querySelector('#skip-result');if(skip&&!skip.hidden&&!skip.disabled)skip.click();},120)`);
  const loopHand=()=>JSON.parse(fs.readFileSync(path.join(sessionDir,'loop-state.json'))).handNo;
  let flaggedHand=null;
  await wait(async()=>{
   const s=app.manager.snapshot();if(s.state==='error'||s.pendingDecision?.status==='recovery_required')throw new Error(s.error??s.pendingDecision.code);
   if(s.state==='completed')return true;
   const reason=requests.length>=softCap?'max-requests':null;
   if(reason&&s.state==='playing'){
    flaggedHand??=loopHand();
    // Stop at the next hand boundary so every archived hand is complete.
    if(loopHand()>flaggedHand){stoppedBy=reason;await command('pause');await command('end');return true;}
   }
   return false;
  },options.waitMs);
  await evaluate('clearInterval(window.__jevDriver)');await browser(['snapshot','-i']);await shot('jev-completed.png');
  const engine=JSON.parse(fs.readFileSync(path.join(sessionDir,'state.json'))),loop=JSON.parse(fs.readFileSync(path.join(sessionDir,'loop-state.json')));
  assert.equal(engine.config.opponentRuntime,'jev');assert.ok(requests.length>0);assert.ok(loop.metrics.some(m=>m.runtime==='jev'));
  if(stoppedBy===null){
   assert.equal(loop.phase,'done');
   if(options.mode==='tournament')assert.equal(engine.gameOver,true);else assert.equal(engine.handNo,options.hands);
  }
  assert.equal(fs.existsSync(path.join(sessionDir,'.player-sessions.json')),false);
  for(const key of ['probabilities','classMass','selectedKey','apiChoice','commitKeys','"guard"'])assert.equal(JSON.stringify(app.manager.snapshot()).includes(key),false,key);
  const diagnostics=loop.jevDiagnostics.entries;
  summary={node:process.version,browser:'agent-browser@0.36.0',mode:options.mode,hands:engine.handNo,aiCount:engine.config.aiCount,humanPolicy:options.humanPolicy,
   upper:'disabled; factual feedback',models:[...new Set(diagnostics.map(d=>d.model))],actors:[...new Set(diagnostics.map(d=>d.actor))],decisions:diagnostics.length,
   usage:diagnostics.reduce((a,d)=>({input_tokens:a.input_tokens+(d.usage?.input_tokens??0),output_tokens:a.output_tokens+(d.usage?.output_tokens??0)}),{input_tokens:0,output_tokens:0})};
 }catch(error){failure=error;try{await shot('failure.png');}catch{}}
 finally{
  clearInterval(mirrorTimer);
  // Each step runs even when an earlier one fails; the first failure is reported.
  const step=async fn=>{try{await fn();}catch(error){failure??=error;}};
  await step(()=>browser(['close']));await step(()=>app?.close());
  // After the app closed, so the last entries are mirrored before the workspace is removed.
  await step(mirrorOnce);
  await step(()=>{if(options.keepStore&&sessionDir&&fs.existsSync(sessionDir))fs.cpSync(sessionDir,path.join(outDir,'session'),{recursive:true});});
  await step(async()=>{const study=await inspectStudyService(root);if(study.status==='running')await stopStudyService(root,{expectedInstanceId:study.instanceId});});
  await step(()=>{assert.equal(hashTree(userStore),before);workspace.close();});
  globalThis.fetch=originalFetch;
  // Written after the app service is closed so late requests are counted.
  await step(()=>fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify(failure
   ?{pass:false,code:failure.code??null,message:failure.message,stoppedBy,maxRequests:cap,requests}
   :{pass:true,...summary,stoppedBy,maxRequests:cap,...(options.keepStore?{sessionDir:path.join(outDir,'session')}:{}),requests},null,2),{mode:0o600}));
  // Independent of every step above: evidence is owner-only however the run ended.
  await step(()=>privateTree(outDir));
  process.umask(umask);
 }
 if(failure)throw failure;
}
if(!process.env.NODE_TEST_CONTEXT&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv.includes('--live'))throw new Error('--live required');
 const i=process.argv.indexOf('--out-dir');if(i<0)throw new Error('--out-dir required');
 await runJevLiveJourney(path.resolve(process.argv[i+1]),parseLiveArgs(process.argv));console.log('JEV real API browser play PASS');
}
