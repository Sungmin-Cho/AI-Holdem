import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as files from '../shared/platform-files.js';

test('Windows PowerShell environment removes all poisoned key variants without mutation', () => {
 const source={SystemRoot:'E:\\payload-root',PSModulePath:'C:\\Program Files\\PowerShell\\7\\Modules',psmodulepath:'C:\\foreign',PsMoDuLePaTh:'C:\\another',PATH:'unchanged-path',PROVIDER_SENTINEL:'unchanged-provider'};
 const before={...source};
 const result=files.windowsPowerShellEnvironment(source,'D:\\Windows',{modules:'system'});
 assert.deepEqual(source,before);
 assert.notEqual(result,source);
 assert.deepEqual(Object.keys(result).filter(key=>key.toLowerCase()==='psmodulepath'),['PSModulePath']);
 assert.equal(result.PSModulePath,'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
 assert.equal(result.PATH,source.PATH);
 assert.equal(result.PROVIDER_SENTINEL,source.PROVIDER_SENTINEL);
 // Analysing that directory runs past 15s without an inherited warm cache, and a
 // child holding an allowlist inherits none. Scripts that need no module get no
 // module path and no cache to build; only a module cmdlet asks for the system path.
 const bare=files.windowsPowerShellEnvironment(source,'D:\\Windows');
 assert.deepEqual(source,before);
 assert.equal(bare.PSModulePath,'');
 assert.deepEqual(Object.keys(bare).filter(key=>key.toLowerCase()==='psmoduleanalysiscachepath'),['PSModuleAnalysisCachePath']);
 assert.equal(bare.PSModuleAnalysisCachePath,'NUL');
 assert.equal(bare.PATH,source.PATH);
 assert.equal(bare.PROVIDER_SENTINEL,source.PROVIDER_SENTINEL);
 // A caller keeps its own cache location only where a module must be found.
 assert.equal(files.windowsPowerShellEnvironment(source,'D:\\Windows',{modules:'system'}).psmoduleanalysiscachepath,source.psmoduleanalysiscachepath);
});

test('every Windows PowerShell production spawn receives a sanitized environment', () => {
 // Execute the actual production call sites in an isolated child. Builtin spawn
 // adapters capture options; no Windows command or fixture process is launched.
 const source=String.raw`
 import assert from 'node:assert/strict';
 import cp from 'node:child_process';
 import fs from 'node:fs';
 import {syncBuiltinESMExports} from 'node:module';
 const captured=[]; const originalEnv={...process.env};
 const proof={user:'S-1-5-21-1',owner:'S-1-5-21-1',reparse:false,rules:[{sid:'S-1-5-21-1',type:'Allow',rights:2032127}]};
 cp.spawnSync=(exe,args,opts)=>{
  captured.push({exe,args,opts});
  const script=args.at(-1);
  if(script.includes('Get-Acl')) return {status:0,stdout:JSON.stringify([proof]),stderr:''};
  if(script.includes('GetProcessById')) return {status:0,stdout:'2026-09-07T00:00:00.0000000Z',stderr:''};
  if(script.includes('Get-NetTCPConnection')) return {status:0,stdout:JSON.stringify({OwningProcess:123,LocalAddress:'127.0.0.1',LocalPort:3210,State:2}),stderr:''};
  return {status:0,stdout:'',stderr:''};
 };
 cp.spawn=(exe,args,opts)=>{captured.push({exe,args,opts});return {pid:123,exitCode:null,signalCode:null};};
 cp.execFile=(exe,args,opts,callback)=>{
  captured.push({exe,args,opts});
  queueMicrotask(()=>callback(null,JSON.stringify({OwningProcess:123,LocalAddress:'127.0.0.1',LocalPort:3210,State:2}),''));
  return {pid:123};
 };
 fs.lstatSync=()=>({isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false});
 fs.statSync=()=>({isFile:()=>true});fs.realpathSync=file=>file;
 Object.defineProperty(process,'platform',{value:'win32'});
 syncBuiltinESMExports();
 const files=await import('./shared/platform-files.js');
 const identity=await import('./engine/process-identity.js');
 const listener=await import('./tools/listener-ownership.js');
 const job=await import('./shared/windows-owned-process.js');
 files.createPrivateDirectory('C:\\fixture');
 assert.equal(files.arePrivatePaths([{file:'C:\\fixture'}]),true);
 assert.equal(identity.win32ProcessStartTime(123),'2026-09-07T00:00:00.0000000Z');
 assert.equal(listener.win32ListenerOwnedBy(123,3210),true);
 assert.equal(await listener.createListenerOwnedBy({platform:'win32'})(123,3210),true);
 job.spawnOwnedCommand('C:\\node.exe',[],{cwd:'C:\\fixture',env:{...process.env,SystemRoot:'E:\\payload-root',systemroot:'F:\\other-root',PROVIDER_SENTINEL:'caller-provider'},ownedTimeoutMs:100});
 assert.equal(captured.length,7);
 for(const {exe,args,opts} of captured){
  assert.match(exe,/powershell\.exe$/);
  assert.ok(opts.env,'production spawn must explicitly sanitize inherited module paths');
  assert.deepEqual(Object.keys(opts.env).filter(key=>key.toLowerCase()==='psmodulepath'),['PSModulePath']);
  // Only Get-NetTCPConnection needs a module; every other script is given none,
  // so it never pays for analysing a module directory it does not read.
  const needsModule=String(args.at(-1)).includes('Get-NetTCPConnection');
  assert.equal(opts.env.PSModulePath,needsModule?'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules':'');
  assert.equal(opts.env.PSModuleAnalysisCachePath,needsModule?undefined:'NUL');
 }
 assert.equal(captured.at(-1).opts.env.PROVIDER_SENTINEL,'caller-provider');
 assert.equal(captured.at(-1).opts.env.SystemRoot,'E:\\payload-root');
 assert.equal(captured.at(-1).opts.env.systemroot,'F:\\other-root');
 assert.equal(captured.at(-1).opts.shell,false);
 assert.equal(captured.at(-1).opts.windowsVerbatimArguments,false);
 assert.deepEqual({...process.env},originalEnv);
 console.log(JSON.stringify({captured:captured.length,environmentUnchanged:true}));
 `;
 const output=execFileSync(process.execPath,['--input-type=module','-e',source],{
  cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000,
  env:{...process.env,SystemRoot:'C:\\Windows',PSModulePath:'C:\\Program Files\\PowerShell\\7\\Modules',psmodulepath:'C:\\foreign'},
 });
 assert.deepEqual(JSON.parse(output),{captured:7,environmentUnchanged:true});
});
