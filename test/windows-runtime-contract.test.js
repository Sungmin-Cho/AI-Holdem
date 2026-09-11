import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as files from '../shared/platform-files.js';
import { childSpawnOptions } from '../shared/child-spawn-options.js';
import { win32ProcessStartTime } from '../engine/process-identity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('childSpawnOptions forces windowsHide even when a caller tries to disable it', () => {
  assert.equal(childSpawnOptions({}).windowsHide, true);
  assert.equal(childSpawnOptions({ windowsHide: false, detached: true }).windowsHide, true);
  assert.equal(childSpawnOptions({ windowsHide: false, detached: true }).detached, true);
});

function jsFilesUnder(...dirs) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of dirs) walk(path.join(ROOT, dir));
  return out;
}

function spawnCallBodies(source) {
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];
  const bodies = [];
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let match;
    while ((match = re.exec(source))) {
      const open = match.index + match[0].length - 1;
      let depth = 0, inStr = null, esc = false;
      for (let i = open; i < source.length; i += 1) {
        const c = source[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            bodies.push(source.slice(open + 1, i));
            break;
          }
        }
      }
    }
  }
  return bodies;
}

function firstArg(body) {
  let depth = 0, inStr = null, esc = false, start = 0;
  while (start < body.length && /\s/.test(body[start])) start += 1;
  for (let i = start; i < body.length; i += 1) {
    const c = body[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) return body.slice(start, i).trim();
  }
  return body.slice(start).trim();
}

test('production child processes hide the Windows console', () => {
  const posixCmd = /^(?:'ps'|"ps")$/;
  const hidden = [];
  const missing = [];
  for (const file of jsFilesUnder('tools', 'engine', 'server', 'shared')) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    for (const body of spawnCallBodies(fs.readFileSync(file, 'utf8'))) {
      const cmd = firstArg(body);
      if (posixCmd.test(cmd)) continue;
      const ok = /\bwindowsHide\s*:\s*true\b/.test(body)
        || /\bchildSpawnOptions\s*\(/.test(body)
        || /\bwindowsOwnedSpawnOptions\s*\(/.test(body);
      (ok ? hidden : missing).push(`${relative} ${cmd}`);
    }
  }
  assert.ok(hidden.length >= 9, `expected production spawn sites, found ${hidden.length}`);
  assert.deepEqual(missing, []);
});

test('one monotonic deadline bounds sequential ACL and identity children', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-budget-'));
 let clock=0; const timeouts=[];
 const spawn=(_exe,_args,options)=>{timeouts.push(options.timeout); clock+=2000; return {status:1};};
 try {
  files.withPlatformDeadline(5000, () => {
   assert.equal(files.arePrivatePaths([{file:dir}],{platform:'win32',spawn}),false);
   assert.equal(win32ProcessStartTime(1,{spawn}),null);
   assert.equal(files.arePrivatePaths([{file:dir}],{platform:'win32',spawn}),false);
   assert.throws(()=>files.platformTimeout(15000),{code:'STUDY_DESCRIPTOR_CORRUPT'});
  },{now:()=>clock});
  assert.deepEqual(timeouts,[5000,3000,1000]);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('an exhausted deadline surfaces as a budget failure, never as a privacy verdict', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-budget-exhausted-'));
 let clock=0;
 const spawn=()=>{clock+=6000; return {status:0,stdout:'[]',stderr:''};};
 try {
  files.withPlatformDeadline(5000, () => {
   assert.equal(files.arePrivatePaths([{file:dir}],{platform:'win32',spawn}),false);
   assert.throws(()=>files.arePrivatePaths([{file:dir}],{platform:'win32',spawn}),{code:'STUDY_DESCRIPTOR_CORRUPT'});
   assert.throws(()=>files.isPrivatePath(dir,{platform:'win32',spawn}),{code:'STUDY_DESCRIPTOR_CORRUPT'});
  },{now:()=>clock});
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

import * as windows from '../shared/windows-owned-process.js';
import { killGroup } from '../tools/solver-runtime.js';
test('untracked Windows identity never grants numeric PID termination', async () => {
 assert.deepEqual(await killGroup(process.pid, 'valid-looking-stamp', () => 'valid-looking-stamp', {platform:'win32'}), {confirmed:false,reason:'termination_unconfirmed'});
 assert.equal(windows.isOwnedWindowsChild({pid:process.pid,ownedWindowsJob:true}),false);
});

import { inspectStudyService, stopStudyService, ensureStudyService, CLIENT_WAIT_MS, HTTP_WAIT_MS } from '../tools/study-service.js';
import { studyBudget } from './helpers/platform.js';
import { acquireOwnedLock, releaseOwnedLock } from '../engine/state.js';
import { runSolver, hasLiveSolverChild } from '../tools/solver-runtime.js';

test('client context and live-owner repair consume the original monotonic budget', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'study-client-budget-'));
 fs.chmodSync(dir,0o700); fs.mkdirSync(path.join(dir,'.training'),{mode:0o700});
 const lock=acquireOwnedLock(path.join(dir,'.training'),'study.lock.d');
 try {
  for (const client of [() => inspectStudyService(dir), () => stopStudyService(dir,{expectedInstanceId:'11111111-1111-4111-8111-111111111111'}), () => ensureStudyService(dir,{onChild(){assert.fail('live owner must not spawn');}})]) {
   let clock=0;
   await assert.rejects(files.withPlatformDeadline(5000,client,{now:()=>{clock+=250; return clock;}}),{code:'STUDY_DESCRIPTOR_CORRUPT'});
   assert.ok(clock<=5500,`client spent ${clock} virtual ms`);
  }
 } finally {releaseOwnedLock(lock);fs.rmSync(dir,{recursive:true,force:true});}
});

if (process.platform === 'win32') {
 test('Windows actual solver timeout confirms owned Job cleanup', {timeout:180000}, async () => {
  await assert.rejects(runSolver({argv:[process.execPath,'-e','setInterval(()=>{},1000)'],timeoutMs:100}),{code:'SOLVER_TIMEOUT'});
  assert.equal(hasLiveSolverChild(),false);
 });
 test('Windows actual leader exit cleans a surviving descendant', {timeout:180000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'solver-job-descendant-'));
  const marker=path.join(dir,'descendant.pid');
  const source=`const {spawn}=require('node:child_process'); const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));c.unref();`;
  try {
   await assert.rejects(runSolver({argv:[process.execPath,'-e',source],timeoutMs:10000}),{code:'SOLVER_EXIT'});
   const pid=Number(fs.readFileSync(marker,'utf8'));
   assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
   assert.equal(hasLiveSolverChild(),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
 });
} else {
 test('POSIX actual solver timeout retains process-group cleanup', async () => {
  await assert.rejects(runSolver({argv:[process.execPath,'-e','setInterval(()=>{},1000)'],timeoutMs:100}),{code:'SOLVER_TIMEOUT'});
  assert.equal(hasLiveSolverChild(),false);
 });
}

import * as study from '../tools/study-service.js';
test('HTTP timeout floors fractional remaining and intersects both deadlines', () => {
 const nativeTimeout=AbortSignal.timeout.bind(AbortSignal);
 files.withPlatformDeadline(450.8,()=>{
  const milliseconds=study.studyHttpTimeout(500.9,8000);
  assert.equal(milliseconds,450);
  assert.doesNotThrow(()=>nativeTimeout(milliseconds));
 },{now:()=>0.25});
 files.withPlatformDeadline(9000,()=>{
  assert.equal(study.studyHttpTimeout(200.9,8000),200);
  assert.throws(()=>study.studyHttpTimeout(0.75,8000),{code:'STUDY_DESCRIPTOR_CORRUPT'});
  assert.throws(()=>study.studyHttpTimeout(0.1,8000),{code:'STUDY_DESCRIPTOR_CORRUPT'});
 },{now:()=>0.25});
});

test('real study ensure inspect stop accept fractional remaining below HTTP cap', {timeout:studyBudget({ coldStarts: 1, extraMs: 60_000 })}, async (t) => {
 const dir=createOwnedTempDir('study-fractional');
 let handle;
 try {
  handle=await ensureStudyService(dir,{onChild:child=>registerOwnedProcess(child,'fractional study service')});
  const nativeTimeout=AbortSignal.timeout.bind(AbortSignal);
  const timers=[];
  t.mock.method(AbortSignal,'timeout',(milliseconds)=>{timers.push(milliseconds); if(!Number.isInteger(milliseconds)) t.diagnostic(`noninteger HTTP timer: ${milliseconds}`); return nativeTimeout(milliseconds);});
  const outer = process.platform === 'win32' ? CLIENT_WAIT_MS : 5000;
  const bounded=client=>{
   let reads=0;
   const clock=()=>++reads<=2 ? 0 : outer-(process.platform==='win32'?HTTP_WAIT_MS:400)+0.25;
   return files.withPlatformDeadline(outer,client,{now:clock});
  };
  const reused=await bounded(()=>ensureStudyService(dir));
  assert.equal(reused.instanceId,handle.instanceId);
  assert.equal((await bounded(()=>inspectStudyService(dir))).status,'running');
  assert.equal((await bounded(()=>stopStudyService(dir,{expectedInstanceId:handle.instanceId}))).stopped,true);
  assert.ok(timers.length>=7);
  assert.ok(timers.every(ms=>Number.isInteger(ms)&&ms>0&&ms<(process.platform==='win32'?HTTP_WAIT_MS:500)));
 } finally {
  t.mock.restoreAll();
  if(handle) await stopStudyService(dir,{expectedInstanceId:handle.instanceId});
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

if (process.platform === 'win32') {
 test('Windows cold directory creation can exceed five seconds before owned startup', {timeout:180000}, async (t) => {
  const dir=createOwnedTempDir('study-cold-budget');
  let handle,clock=0,created=false;
  const realStat=fs.lstatSync;
  try {
   t.mock.method(fs,'lstatSync',(...args)=>{
    const stat=realStat(...args);
    if(!created && String(args[0])===path.join(dir,'.training')) {created=true;clock=6000.25;}
    return stat;
   });
   handle=await files.withPlatformDeadline(5000,()=>ensureStudyService(dir,{onChild:child=>registerOwnedProcess(child,'cold budget study service')}),{now:()=>clock});
   assert.equal(created,true);
   assert.equal((await inspectStudyService(dir)).instanceId,handle.instanceId);
  } finally {
   t.mock.restoreAll();
   if(handle) await stopStudyService(dir,{expectedInstanceId:handle.instanceId});
   fs.rmSync(dir,{recursive:true,force:true});
  }
 });
 // Last: an intentionally unconfirmed reservation must remain until this test
 // process exits; no persisted gameDir is available to supply a second fence.
 test('Windows forced launcher stop keeps replacement blocked without gameDir', {timeout:180000}, async () => {
  await assert.rejects(runSolver({argv:[process.execPath,'-e',"setInterval(()=>process.stdout.write('x'.repeat(8192)),1)"],maxStdoutBytes:10,timeoutMs:10000}),{code:'SOLVER_TERMINATION_UNCONFIRMED'});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(hasLiveSolverChild(),true);
  await assert.rejects(runSolver(),{code:'SOLVER_BUSY'});
 });
}
