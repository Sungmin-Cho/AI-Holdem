import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {createSessionManager} from '../tools/session-manager.js';
import {prepareGameSession} from '../tools/game-loop.js';
import {JEV_CONFIG,JEV_CONFIG_LEGACY} from '../shared/opponent-runtime.js';
import {JEV_ROLL_FORWARD_NOTICE} from '../tools/game-loop.js';
import {boundJevDiagnostics} from '../tools/jev-diagnostics.js';
const read=f=>JSON.parse(fs.readFileSync(f));
const resolver=async()=>({player:null,upper:null,notices:[]});
async function wait(fn){const deadline=Date.now()+(process.platform==='win32'?120000:15000);while(Date.now()<deadline){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw new Error('wait timeout');}
function payload(m,kind,extra={}){const s=m.snapshot();return {requestId:randomUUID(),expectedInstanceId:s.instanceId,expectedAppRevision:s.appRevision,expectedGameId:s.gameId,expectedSelectionVersion:s.selectionVersion,kind,...extra};}
async function command(m,kind,extra){const row=m.command(payload(m,kind,extra));return wait(()=>{const r=m.receipt(row.requestId);return r.status!=='accepted'?r:null;});}
test('app journals pinned JEV, pauses, ends without key and restarts with same descriptor', {timeout:process.platform==='win32'?180000:30000},async t=>{
 const oldKey=process.env.TYPESAFE_API_KEY,oldFetch=globalThis.fetch;process.env.TYPESAFE_API_KEY='synthetic';
 globalThis.fetch=async(url,opts)=>{
  if(String(url).startsWith('https://api.typesafe.ai/')){const body=JSON.parse(opts.body);const keys=Object.keys(body.questions.action.criteria),choice=keys.includes('check')?'check':'call';return new Response(JSON.stringify({model:JEV_CONFIG.model,answers:{action:{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,Number(k===choice)]))}}}),{headers:{'content-type':'application/json'}});}return oldFetch(url,opts);
 };
 const root=createOwnedTempDir('jev-session'),m=createSessionManager({storeDir:root,resolver});
 t.after(async()=>{await m.close();globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=oldKey;});await m.initialize();
 const started=await command(m,'start',{setup:{opponentRuntime:'jev',aiCount:1,hands:2,pace:'instant'}});assert.equal(started.status,'succeeded');assert.deepEqual(started.jevConfig,JEV_CONFIG);
 const first=m.current.gameId;assert.deepEqual(read(path.join(m.current.sessionDir,'state.json')).config.jev,JEV_CONFIG);
 assert.equal((await command(m,'pause')).status,'succeeded');delete process.env.TYPESAFE_API_KEY;
 assert.equal((await command(m,'end')).status,'succeeded');process.env.TYPESAFE_API_KEY='synthetic';
 const restarted=await command(m,'restart');assert.equal(restarted.status,'succeeded');assert.deepEqual(restarted.jevConfig,JEV_CONFIG);assert.notEqual(m.current.gameId,first);
 assert.deepEqual(read(path.join(m.current.sessionDir,'state.json')).config.jev,JEV_CONFIG);
});
test('AI-zero JEV preparation never runs provider preflight',async t=>{
 const root=createOwnedTempDir('jev-zero');let calls=0;
 const result=await prepareGameSession({storeDir:root,opponentRuntime:'jev',ai:0,participants:[{playerId:'h1',participantId:'part-1',name:'Guest'}],mode:'cash-training',port:0},
 {resolver,loopOptions:{controlProtocolVersion:1,jevPreflight:()=>{calls++;throw new Error('must not run');}}});
 t.after(()=>result.loop.requestStop());assert.equal(calls,0);
});
test('engine rejects unsupported descriptor, oversize and symlink before existing state mutation',()=>{
 const root=createOwnedTempDir('jev-config');const cli=(...args)=>execFileSync(process.execPath,['engine/cli.js',...args,'--game-dir',root],{stdio:['ignore','pipe','pipe']});
 cli('init','--ai','1');const before=fs.readFileSync(path.join(root,'state.json'));
 const file=path.join(root,'config.json');for(const value of [{...JEV_CONFIG,model:'latest'},{...JEV_CONFIG,extra:true}]){
  fs.writeFileSync(file,JSON.stringify(value));assert.throws(()=>cli('init','--ai','1','--opponent-runtime','jev','--jev-config-file',file));assert.deepEqual(fs.readFileSync(path.join(root,'state.json')),before);
 }
 fs.writeFileSync(file,' '.repeat(4097));assert.throws(()=>cli('init','--ai','1','--opponent-runtime','jev','--jev-config-file',file));
 fs.writeFileSync(file,JSON.stringify(JEV_CONFIG));assert.throws(()=>cli('init','--ai','1','--opponent-runtime','policy','--jev-config-file',file));
 if(process.platform!=='win32'){const link=path.join(root,'link.json');fs.symlinkSync(file,link);assert.throws(()=>cli('init','--ai','1','--opponent-runtime','jev','--jev-config-file',link));}
 assert.deepEqual(fs.readFileSync(path.join(root,'state.json')),before);
});
test('private diagnostics count/bytes never exceed app reader budget; dropped is cumulative',()=>{
 const entries=Array.from({length:6000},(_,i)=>({decisionId:`d-${i}`,probabilities:{check:0.57,raise_to_150:0.43},model:JEV_CONFIG.model,confidence:0.1}));
 const state={metrics:'x'.repeat(1850000),jevDiagnostics:{schemaVersion:1,entries,dropped:9}};boundJevDiagnostics(state);
 assert.ok(state.jevDiagnostics.entries.length<5000);assert.equal(state.jevDiagnostics.entries.length+state.jevDiagnostics.dropped,6009);
 assert.ok(Buffer.byteLength(JSON.stringify(state))<2*1024*1024-60000);assert.equal(state.jevDiagnostics.entries.at(-1).decisionId,'d-5999');
});
test('unsupported JEV version preserves records and still permits explicit app End', {timeout:process.platform==='win32'?300000:30000},async t=>{
 const oldKey=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='synthetic';
 const root=createOwnedTempDir('jev-invalid-resume');let m=createSessionManager({storeDir:root,resolver});
 t.after(async()=>{await m.close();if(oldKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=oldKey;});
 await m.initialize();assert.equal((await command(m,'start',{setup:{opponentRuntime:'jev',aiCount:1,pace:'slow'}})).status,'succeeded');
 await m.close();const file=path.join(m.current.sessionDir,'state.json'),engine=read(file);engine.config.jev.model='unsupported-model';fs.writeFileSync(file,JSON.stringify(engine));
 const unsupportedBytes=fs.readFileSync(file);
 m=createSessionManager({storeDir:root,resolver});await m.initialize();
 assert.equal((await command(m,'resume')).status,'failed');assert.deepEqual(fs.readFileSync(file),unsupportedBytes);assert.equal(m.snapshot().error,'JEV_CONFIG_UNSUPPORTED');assert.ok(m.snapshot().allowedCommands.includes('end'));
 assert.equal((await command(m,'end')).status,'succeeded');assert.equal(read(file).config.jev.model,'unsupported-model');assert.equal(read(file).result,'abort');
});
const V1=JEV_CONFIG_LEGACY[0];
const loopLog=dir=>fs.existsSync(path.join(dir,'loop.log'))?fs.readFileSync(path.join(dir,'loop.log'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const rolledLogs=dir=>loopLog(dir).filter(r=>r.event==='jev-config-rolled-forward');
function oneHotFetch(){
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{
  if(String(url).startsWith('https://api.typesafe.ai/')){const body=JSON.parse(opts.body);const keys=Object.keys(body.questions.action.criteria),choice=keys.includes('check')?'check':'call';return new Response(JSON.stringify({model:JEV_CONFIG.model,answers:{action:{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,Number(k===choice)]))}}}),{headers:{'content-type':'application/json'}});}return oldFetch(url,opts);
 };
 return ()=>{globalThis.fetch=oldFetch;};
}
async function jevApp(t,label,setup={}){
 const oldKey=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='synthetic';const restoreFetch=oneHotFetch();
 const root=createOwnedTempDir(label);const box={m:createSessionManager({storeDir:root,resolver})};
 t.after(async()=>{await box.m.close();restoreFetch();if(oldKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=oldKey;});
 await box.m.initialize();assert.equal((await command(box.m,'start',{setup:{opponentRuntime:'jev',aiCount:1,pace:'slow',...setup}})).status,'succeeded');
 box.dir=box.m.current.sessionDir;
 box.reopen=async()=>{await box.m.close();box.m=createSessionManager({storeDir:root,resolver});await box.m.initialize();return box.m;};
 return box;
}
// Rewrites a freshly started v2 store as if v1 code had created it.
function downgradeToV1(dir,entries){
 const engine=read(path.join(dir,'state.json'));engine.config.jev={...V1};fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(engine));
 const loop=read(path.join(dir,'loop-state.json'));loop.jev={...V1};loop.jevDiagnostics={schemaVersion:1,entries,dropped:0};
 delete loop.jevRolledForward;fs.writeFileSync(path.join(dir,'loop-state.json'),JSON.stringify(loop));
}
const v1Entry={decisionId:'d-0-preflop-0',generation:1,actor:'seat_1',model:'jev-1.13.0',confidence:1,probabilitySum:1,probabilities:{fold:0,call:1},usage:null,
 questionVersion:'poker-choice-v1',candidateVersion:'legal-menu-v1',projectionVersion:1};
async function actHost(dir){
 const lock=read(path.join(dir,'lock.json'));const res=await fetch(`http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`);const legal=(await res.json()).view?.legal;
 if(legal?.toAct==='user')await fetch(`http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decisionId:legal.decisionId,action:legal.canCheck?'check':'call'})});
}
test('known v1 store rolls forward once on resume; engine descriptor and old entries stay', {timeout:process.platform==='win32'?300000:60000},async t=>{
 const box=await jevApp(t,'jev-roll-forward');await box.reopen();downgradeToV1(box.dir,[v1Entry]);
 const engineV1=read(path.join(box.dir,'state.json'));
 let m=await box.reopen();assert.equal((await command(m,'resume')).status,'succeeded');
 const first=read(path.join(box.dir,'loop-state.json'));
 assert.deepEqual(first.jev,JEV_CONFIG);assert.deepEqual(first.jevRolledForward.from,V1);assert.ok(Number.isFinite(Date.parse(first.jevRolledForward.at)));
 assert.equal(first.notices.filter(n=>n===JEV_ROLL_FORWARD_NOTICE).length,1);
 const logs=rolledLogs(box.dir);assert.equal(logs.length,1);
 assert.deepEqual(logs[0].from,{questionVersion:'poker-choice-v1',candidateVersion:'legal-menu-v1',projectionVersion:1});
 assert.deepEqual(logs[0].to,{questionVersion:'poker-choice-v2',candidateVersion:'legal-menu-v2',projectionVersion:2,selectionVersion:'class-sample-v1'});
 const engine=read(path.join(box.dir,'state.json'));assert.deepEqual(engine.config.jev,V1);assert.equal(Object.hasOwn(engine,'jevRolledForward'),false);
 assert.equal(engine.handNo>=engineV1.handNo,true);assert.deepEqual(first.jevDiagnostics.entries[0],v1Entry);
 // The next AI decision is recorded under the v2 versions, beside the v1 entry.
 await wait(async()=>{await actHost(box.dir);return read(path.join(box.dir,'loop-state.json')).jevDiagnostics.entries.length>1;});
 const entries=read(path.join(box.dir,'loop-state.json')).jevDiagnostics.entries;
 assert.deepEqual(entries[0],v1Entry);assert.equal(entries.at(-1).questionVersion,'poker-choice-v2');assert.equal(entries.at(-1).selectionVersion,'class-sample-v1');
 assert.ok(entries.at(-1).selection);
 // A second resume keeps the marker, its time, one notice and one log line.
 assert.equal((await command(m,'pause')).status,'succeeded');m=await box.reopen();assert.equal((await command(m,'resume')).status,'succeeded');
 const second=read(path.join(box.dir,'loop-state.json'));
 assert.deepEqual(second.jevRolledForward,first.jevRolledForward);assert.equal(second.notices.filter(n=>n===JEV_ROLL_FORWARD_NOTICE).length,1);
 assert.equal(rolledLogs(box.dir).length,1);assert.deepEqual(read(path.join(box.dir,'state.json')).config.jev,V1);
 // Same-setup restart is a new game on the current descriptor, without a marker.
 assert.equal((await command(m,'pause')).status,'succeeded');assert.equal((await command(m,'end')).status,'succeeded');
 const restarted=await command(m,'restart');assert.equal(restarted.status,'succeeded');assert.deepEqual(restarted.jevConfig,JEV_CONFIG);
 assert.deepEqual(read(path.join(m.current.sessionDir,'state.json')).config.jev,JEV_CONFIG);
 assert.equal(Object.hasOwn(read(path.join(m.current.sessionDir,'loop-state.json')),'jevRolledForward'),false);
});
test('pending-free v1 store keeps a single marker across resumes; a failed marker write is redone', {timeout:process.platform==='win32'?300000:60000},async t=>{
 const box=await jevApp(t,'jev-roll-crash');await box.reopen();downgradeToV1(box.dir,[]);
 const target=path.join(box.dir,'loop-state.json'),original=fs.renameSync;let failed=0;
 fs.renameSync=function(from,to,...rest){
  if(to===target&&!failed&&JSON.parse(fs.readFileSync(from,'utf8')).jevRolledForward){failed++;throw Object.assign(new Error('injected marker write failure'),{code:'EIO'});}
  return original.call(this,from,to,...rest);
 };
 let m;
 try{m=await box.reopen();assert.equal((await command(m,'resume')).status,'failed');}finally{fs.renameSync=original;}
 assert.equal(failed,1);assert.equal(rolledLogs(box.dir).length,1);
 const crashed=read(target);assert.equal(Object.hasOwn(crashed,'jevRolledForward'),false);assert.deepEqual(crashed.jev,V1);
 m=await box.reopen();assert.equal((await command(m,'resume')).status,'succeeded');
 const first=read(target);assert.deepEqual(first.jev,JEV_CONFIG);assert.deepEqual(first.jevRolledForward.from,V1);assert.equal(rolledLogs(box.dir).length,2);
 assert.equal(first.notices.filter(n=>n===JEV_ROLL_FORWARD_NOTICE).length,1);
 assert.equal((await command(m,'pause')).status,'succeeded');m=await box.reopen();assert.equal((await command(m,'resume')).status,'succeeded');
 const second=read(target);assert.deepEqual(second.jevRolledForward,first.jevRolledForward);assert.equal(rolledLogs(box.dir).length,2);
 assert.equal(second.notices.filter(n=>n===JEV_ROLL_FORWARD_NOTICE).length,1);
});
test('v2-born JEV and non-JEV stores record no roll-forward on resume', {timeout:process.platform==='win32'?300000:60000},async t=>{
 const box=await jevApp(t,'jev-v2-resume');let m=await box.reopen();assert.equal((await command(m,'resume')).status,'succeeded');
 const ls=read(path.join(box.dir,'loop-state.json'));assert.equal(Object.hasOwn(ls,'jevRolledForward'),false);
 assert.equal(ls.notices.includes(JEV_ROLL_FORWARD_NOTICE),false);assert.equal(rolledLogs(box.dir).length,0);
 const root=createOwnedTempDir('policy-resume');let p=createSessionManager({storeDir:root,resolver});t.after(async()=>{await p.close();});await p.initialize();
 assert.equal((await command(p,'start',{setup:{opponentRuntime:'policy',aiCount:1,pace:'slow'}})).status,'succeeded');
 const dir=p.current.sessionDir;await p.close();p=createSessionManager({storeDir:root,resolver});await p.initialize();
 assert.equal((await command(p,'resume')).status,'succeeded');
 const policy=read(path.join(dir,'loop-state.json'));
 for(const key of ['jev','jevRolledForward','jevDiagnostics'])assert.equal(Object.hasOwn(policy,key),false,key);
 assert.equal((policy.notices??[]).includes(JEV_ROLL_FORWARD_NOTICE),false);assert.equal(rolledLogs(dir).length,0);
});
const CANARY=0.4321;
const FORBIDDEN=[/0\.4321/,/probabilities/,/classMass/,/selectedKey/,/"selection"\s*:/,/apiChoice/,/"unit"\s*:/];
async function readSse(url,headers){
 const ac=new AbortController();const res=await fetch(url,{headers,signal:ac.signal});assert.equal(res.status,200,url);
 const reader=res.body.getReader(),decoder=new TextDecoder();let text='';const deadline=Date.now()+10000;
 while(!/(^|\n)data:.*\n\n/.test(text)&&Date.now()<deadline){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});}
 ac.abort();assert.match(text,/(^|\n)data:/,`no SSE frame from ${url}`);return text;
}
test('private JEV values never reach host, participant, spectator, summary, export or replay channels', {timeout:process.platform==='win32'?300000:90000},async t=>{
 const {startAppServer}=await import('../tools/app-server.js');
 const TOKEN='c'.repeat(64),oldKey=process.env.TYPESAFE_API_KEY,oldFetch=globalThis.fetch;process.env.TYPESAFE_API_KEY='synthetic';
 globalThis.fetch=async(url,opts)=>{
  if(!String(url).startsWith('https://api.typesafe.ai/'))return oldFetch(url,opts);
  const keys=Object.keys(JSON.parse(opts.body).questions.action.criteria);
  const probabilities=Object.fromEntries(keys.map((k,i)=>[k,i===0?1-CANARY:i===1?CANARY:0]));
  return new Response(JSON.stringify({model:JEV_CONFIG.model,answers:{action:{type:'choice',choice:keys[0],confidence:0.1,probabilities}}}),{headers:{'content-type':'application/json'}});
 };
 const storeDir=createOwnedTempDir('jev-canary'),m=createSessionManager({storeDir,resolver});
 let app;t.after(async()=>{await app?.close();await m.close();globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=oldKey;});
 await m.initialize();app=await startAppServer({manager:m,token:TOKEN,storeDir,port:0,publicPort:0});
 const host={authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},pub=`http://127.0.0.1:${app.publicPort}`;
 const opened=await fetch(`${app.origin}/api/room`,{method:'POST',headers:host,body:JSON.stringify({op:'open',hostName:'Host',totalSeats:3,actionTimeoutSec:60})});
 const room=await opened.json();assert.equal(opened.status,200,JSON.stringify(room));
 const join=async name=>{const res=await fetch(`${pub}/api/join`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:room.joinCode,name})});const body=await res.json();assert.equal(res.status,200,JSON.stringify(body));return body.participantToken;};
 const seated=await join('Guest');
 const started=await command(m,'start',{setup:{mode:'cash-training',totalSeats:3,opponentRuntime:'jev',hints:'off',dealBias:'off',hands:2,pace:'instant'}});
 assert.equal(started.status,'succeeded',JSON.stringify(started));
 const watcher=await join('Watcher');
 const gameId=m.current.gameId,dir=m.current.sessionDir,epoch=()=>m.snapshot().gameEpoch;
 const hostGame=()=>({...host,'x-game-epoch':epoch()}),as=token=>({authorization:`Bearer ${token}`,'x-game-epoch':epoch()});
 assert.equal((await (await fetch(`${pub}/api/p/state`,{headers:as(watcher)})).json()).me.roomRole,'spectator');
 const ls=()=>read(path.join(dir,'loop-state.json'));
 const canaryStored=()=>ls().jevDiagnostics?.entries?.some(e=>Object.values(e.probabilities).includes(CANARY)&&e.selection);
 const act=async()=>{
  if(m.snapshot().state!=='playing')return;
  for(const [base,headers,seat] of [[`${app.origin}/api/game/${gameId}`,hostGame(),'user'],[`${pub}/api/p/game/${gameId}`,as(seated),'h1']]){
   const res=await fetch(`${base}/snapshot`,{headers});if(res.status!==200)continue;const legal=(await res.json()).view?.legal;
   if(legal?.toAct===seat)await fetch(`${base}/action`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({decisionId:legal.decisionId,action:legal.canCheck?'check':'call'})});
  }
 };
 // Positive first: the canary is stored privately and its decision was accepted.
 await wait(async()=>{await act();return canaryStored()&&ls().metrics.some(x=>x.outcome==='jev_accepted');});
 const live={admin:JSON.stringify(m.snapshot()),app:await (await fetch(`${app.origin}/api/app`,{headers:host})).text()};
 for(const [name,url,headers] of [['host',`${app.origin}/api/game/${gameId}`,hostGame()],['seated',`${pub}/api/p/game/${gameId}`,as(seated)],['spectator',`${pub}/api/p/game/${gameId}`,as(watcher)]]){
  const res=await fetch(`${url}/snapshot`,{headers});assert.equal(res.status,200,name);live[`${name}-snapshot`]=await res.text();
  live[`${name}-events`]=await readSse(`${url}/events`,headers);
 }
 const lock=read(path.join(dir,'lock.json'));
 live.relay=await (await fetch(`http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`)).text();
 await wait(async()=>{await act();return ['completed','ended'].includes(m.snapshot().state);});
 const done={};
 for(const [name,url,headers] of [['host',`${app.origin}/api/game/${gameId}`,hostGame()],['seated',`${pub}/api/p/game/${gameId}`,as(seated)],['spectator',`${pub}/api/p/game/${gameId}`,as(watcher)]]){
  const snap=await fetch(`${url}/snapshot`,{headers});assert.equal(snap.status,200,`${name} final snapshot`);done[`${name}-final`]=await snap.text();
  const summary=await fetch(`${url}/summary`,{headers});assert.equal(summary.status,200,`${name} summary`);done[`${name}-summary`]=await summary.text();
 }
 assert.ok(fs.readdirSync(path.join(dir,'hands')).some(n=>/^hand-.*\.json$/.test(n)));
 assert.match(done['host-final'],/handReplays|history/);
 const out=path.join(createOwnedTempDir('jev-canary-export'),'session.json');
 execFileSync(process.execPath,['tools/export-hh.js','--game-dir',dir,'--out',out]);done.export=fs.readFileSync(out,'utf8');
 execFileSync(process.execPath,['tools/export-hh.js','--game-dir',dir,'--format','pokerstars','--out',out+'.txt']);done.pokerstars=fs.readFileSync(out+'.txt','utf8');
 assert.ok(JSON.parse(done.export).hands.length>=1);
 // Positive control: every forbidden pattern does occur in the private loop-state.
 const privateText=fs.readFileSync(path.join(dir,'loop-state.json'),'utf8');for(const pattern of FORBIDDEN)assert.match(privateText,pattern);
 for(const [name,text] of Object.entries({...live,...done}))for(const pattern of FORBIDDEN)assert.doesNotMatch(text,pattern,`${name} leaks ${pattern}`);
 const log=fs.readFileSync(path.join(dir,'loop.log'),'utf8');for(const pattern of FORBIDDEN)assert.doesNotMatch(log,pattern,`loop.log leaks ${pattern}`);
});
