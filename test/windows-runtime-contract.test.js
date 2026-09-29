import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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

// #249: the proof child's fixed start-up cost came from the Get-Acl and ConvertTo-Json
// cmdlets; the script now calls .NET directly and writes the same JSON itself.
test('#249 the ACL proof script calls .NET only, never a cmdlet', () => {
  const script = files.aclProofScript(['C:\\store\\.training', "C:\\it's"]);
  assert.doesNotMatch(script, /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/, 'no Verb-Noun cmdlet');
  assert.match(script, /\[System\.IO\.Directory\]::GetAccessControl\(\$p\)/);
  assert.match(script, /\[System\.IO\.File\]::GetAccessControl\(\$p\)/);
  assert.match(script, /GetAccessRules\(\$true,\$true,\$sid\)/, 'explicit and inherited rules, as SIDs');
  assert.match(script, /ToString\(\$inv\)/, 'rights are written in the invariant culture');
  assert.ok(script.includes("@('C:\\store\\.training','C:\\it''s')"), 'paths stay single-quoted literals');
  // As in the Get-Acl script, the reparse bit is read after the ACL and its rules.
  const after = script.indexOf('$after=[System.IO.File]::GetAttributes($p)');
  assert.ok(after > script.indexOf('GetAccessRules(') && after > script.indexOf('GetOwner('),
    'attributes are read again last, after the rules and the owner');
  assert.match(script, /\(\$attr -bor \$after\) -band \[System\.IO\.FileAttributes\]::ReparsePoint/);
});

test('#249 the JSON the proof script writes is judged exactly as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-proof-shape-'));
  const user = 'S-1-5-21-1-2-3-1001';
  const proof = (rules, extra = {}) => `{"user":"${user}","tokenOwner":null,"owner":"${user}","reparse":false,"rules":[${rules.join(',')}]${extra.tail ?? ''}}`;
  const rule = (sid, rights, type = 'Allow') => `{"sid":"${sid}","type":"${type}","rights":${rights}}`;
  const verdict = (stdout, privateMode = true) => {
    const reasons = [];
    let script;
    const result = files.arePrivatePaths([{ file: dir, privateMode }], {
      platform: 'win32',
      spawn: (_exe, args) => { script = args.at(-1); return { status: 0, stdout, stderr: '' }; },
      onUnproven: (reason) => reasons.push(reason),
    });
    assert.equal(script, files.aclProofScript([dir]));
    return { result, reasons };
  };
  try {
    // GENERIC_READ is a negative 32-bit value; SYSTEM holding it is still trusted.
    assert.equal(verdict(`[${proof([rule(user, 2032127), rule('S-1-5-18', -2147483648)])}]\r\n`).result, true);
    assert.equal(verdict(`\uFEFF[${proof([rule(user, 2032127)])}]`).result, true, 'a BOM is tolerated as before');
    assert.equal(verdict(`[${proof([rule(user, 2032127), rule('S-1-1-0', 1179817)])}]`).result, false, 'Everyone may not read a private path');
    assert.equal(verdict(`[${proof([rule(user, 2032127), rule('S-1-1-0', 1179817)])}]`, false).result, true, 'but may read a non-private one');
    assert.equal(verdict(`[${proof([])}]`).result, false, 'no rule for the user is no proof');
    assert.equal(verdict(`[${proof([rule(user, 2032127)]).replace('"reparse":false', '"reparse":true')}]`).result, false);
    assert.equal(verdict(`[${proof([rule(user, 2032127)]).replace(`"owner":"${user}"`, '"owner":null')}]`).result, false, 'an unknown owner is no proof');
    const broken = verdict(`[${proof([rule(user, 2032127)])},]`);
    assert.equal(broken.result, false);
    assert.match(broken.reasons.join(' '), /^error:/, 'malformed output is unproven');
    assert.match(verdict('[]').reasons.join(' '), /^proofs:0\/1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The script #249 replaced, kept only as the reference the .NET-only script is compared with.
const GET_ACL_SCRIPT = (paths) => `$ErrorActionPreference='Stop'; $id=[System.Security.Principal.WindowsIdentity]::GetCurrent(); $me=$id.User.Value; $tokenOwner=$id.Owner.Value; $proofs=@(); foreach($p in @(${paths.map((file) => `'${file.replaceAll("'", "''")}'`).join(',')})) { $a=Get-Acl -LiteralPath $p; $rules=@(); foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { $rules+=@{sid=$r.IdentityReference.Value;type=$r.AccessControlType.ToString();rights=[long]$r.FileSystemRights} }; $proofs+=@{user=$me;tokenOwner=$tokenOwner;owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;reparse=(([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0);rules=$rules} }; ConvertTo-Json -InputObject @($proofs) -Depth 5 -Compress`;

// A proof that silently drops one foreign ACE would still be valid JSON and could pass, so
// the replacement is compared with Get-Acl on real DACLs: a private directory and file, a
// directory with an explicit inheritable Everyone ACE, a file that inherits it, and a file
// with its own explicit Everyone ACE — all in one call, in order.
test('#249 on real Windows ACLs the .NET-only script reads exactly what Get-Acl read', {
  skip: process.platform === 'win32' ? false : 'real DACLs need Windows',
}, () => {
  const system = process.env.SystemRoot || 'C:\\Windows';
  const root = createOwnedTempDir('holdem-acl-diff');
  const privateFile = path.join(root, 'private.json');
  fs.writeFileSync(privateFile, '{}');
  const shared = path.join(root, "it's [shared]");
  fs.mkdirSync(shared);
  const icacls = (...args) => {
    const result = spawnSync(path.join(system, 'System32', 'icacls.exe'), args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, `icacls ${args.join(' ')}: ${result.stdout}${result.stderr}`);
  };
  icacls(shared, '/grant', '*S-1-1-0:(OI)(CI)(RX)');
  const inherited = path.join(shared, 'inherited.json');
  fs.writeFileSync(inherited, '{}');
  const explicit = path.join(root, 'explicit.json');
  fs.writeFileSync(explicit, '{}');
  icacls(explicit, '/grant', '*S-1-1-0:(R)');
  icacls(explicit, '/deny', '*S-1-5-7:(W)');
  // CREATOR OWNER, inherit-only GENERIC_READ: a negative 32-bit rights value.
  const generic = path.join(root, 'generic');
  fs.mkdirSync(generic);
  icacls(generic, '/grant', '*S-1-3-0:(OI)(CI)(IO)(GR)');
  const all = [root, privateFile, shared, inherited, explicit, generic];
  const powershell = (script) => spawnSync(path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: files.windowsPowerShellEnvironment(), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const run = (script) => {
    const result = powershell(script);
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(String(result.stderr).trim(), '');
    return JSON.parse(String(result.stdout).replace(/^\uFEFF/, ''));
  };
  const current = run(files.aclProofScript(all));
  assert.deepEqual(current, run(GET_ACL_SCRIPT(all)));
  const everyone = (proof) => proof.rules.filter((rule) => rule.sid === 'S-1-1-0');
  assert.deepEqual(current.map((proof) => everyone(proof).length > 0), [false, false, true, true, true, false],
    'the comparison covers explicit and inherited foreign ACEs');
  assert.ok(current[4].rules.some((rule) => rule.type === 'Deny' && rule.sid === 'S-1-5-7'), 'a Deny ACE is carried');
  assert.ok(current[5].rules.some((rule) => rule.sid === 'S-1-3-0' && rule.rights < 0), 'a negative rights value is carried');
  assert.deepEqual(run(files.aclProofScript([])), [], 'no paths is an empty array');
  const partial = powershell(files.aclProofScript([privateFile, path.join(root, 'missing.json')]));
  assert.notEqual(partial.status, 0, 'one unreadable path fails the whole proof');
  assert.doesNotMatch(String(partial.stdout), /\[/, 'and prints no partial proof');
  const verdict = (file, privateMode) => files.arePrivatePaths([{ file, privateMode }]);
  assert.equal(verdict(root, true), true);
  assert.equal(verdict(privateFile, true), true);
  for (const file of [shared, inherited, explicit]) {
    assert.equal(verdict(file, true), false, `Everyone may read ${path.basename(file)}, so it is not private`);
    assert.equal(verdict(file, false), true, `Everyone may only read ${path.basename(file)}`);
  }
  assert.equal(verdict(generic, false), false, 'a generic right for a stranger is never read-only proof');
});

// The attributes are read again after the ACL, and a reparse point seen by either read counts
// (#249 r1–r2). The proof child pauses at exactly that point while the test swaps the path:
// a directory for a junction, and a junction for a directory.
for (const [label, start, swap] of [
  ['a directory swapped for a junction', (victim) => fs.mkdirSync(victim), (victim, elsewhere) => {
    fs.renameSync(victim, `${victim}.moved`);
    fs.symlinkSync(elsewhere, victim, 'junction');
  }],
  ['a junction swapped for a directory', (victim, elsewhere) => fs.symlinkSync(elsewhere, victim, 'junction'), (victim) => {
    fs.rmdirSync(victim);
    fs.mkdirSync(victim);
  }],
]) {
  test(`#249 ${label} between the two attribute reads is not private`, {
    skip: process.platform === 'win32' ? false : 'junctions and DACLs need Windows',
  }, async () => {
    const system = process.env.SystemRoot || 'C:\\Windows';
    const root = createOwnedTempDir('holdem-acl-swap');
    const victim = path.join(root, 'victim');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    start(victim, elsewhere);
    const ready = path.join(root, 'ready.flag');
    const go = path.join(root, 'go.flag');
    const pause = `[System.IO.File]::WriteAllText('${ready.replaceAll("'", "''")}', 'x'); `
      + `while (-not [System.IO.File]::Exists('${go.replaceAll("'", "''")}')) { [System.Threading.Thread]::Sleep(10) }; `;
    const script = files.aclProofScript([victim]);
    const marker = '$after=[System.IO.File]::GetAttributes($p);';
    assert.ok(script.includes(marker));
    const child = spawn(path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script.replace(marker, pause + marker)],
      { env: files.windowsPowerShellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    registerOwnedProcess(child, 'acl proof child');
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const closed = new Promise((resolve) => child.once('close', resolve));
    const deadline = Date.now() + 60_000;
    try {
      while (!fs.existsSync(ready)) {
        assert.ok(Date.now() < deadline && child.exitCode === null, `the proof child did not reach the pause: ${err}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      swap(victim, elsewhere);
      fs.writeFileSync(go, 'x');
      let timer;
      const code = await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the proof child did not finish: ${err}`)), Math.max(1, deadline - Date.now()));
      })]).finally(() => clearTimeout(timer));
      assert.equal(code, 0, err);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    const [proof] = JSON.parse(out.replace(/^\uFEFF/, ''));
    assert.equal(proof.reparse, true, 'a reparse point seen by either attribute read is reported');
    assert.equal(files.privateAclAllowed(proof, false), false);
  });
}

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
