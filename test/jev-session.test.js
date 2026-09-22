import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {createSessionManager} from '../tools/session-manager.js';
import {prepareGameSession} from '../tools/game-loop.js';
import {JEV_CONFIG} from '../shared/opponent-runtime.js';
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
 m=createSessionManager({storeDir:root,resolver});await m.initialize();
 assert.equal((await command(m,'resume')).status,'failed');assert.equal(m.snapshot().error,'JEV_CONFIG_UNSUPPORTED');assert.ok(m.snapshot().allowedCommands.includes('end'));
 assert.equal((await command(m,'end')).status,'succeeded');assert.equal(read(file).config.jev.model,'unsupported-model');assert.equal(read(file).result,'abort');
});
