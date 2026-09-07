// study-service.test.js에서 실측 분 기준으로 나눈 소유권 회복·repair 절반(설계 D2)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import { skipOnWin32 } from './helpers/platform.js';
import { acquireOwnedLock, releaseOwnedLock, ownedProcessStartTime as processStartTime } from '../engine/state.js';
import { CLIENT_WAIT_MS } from '../tools/study-service.js';
import {
  descriptorPath,
  lockPath,
  service,
  launch,
  until,
  readDescriptor,
  request,
  REQUEST_MS,
} from './helpers/study-service-fixtures.mjs';

test('REQ-010: separate Node ensure clients converge on one owned listener', async (t) => {
  const storeDir = createOwnedTempDir('holdem-study-multi-client');
  const href = new URL('../tools/study-service.js', import.meta.url).href;
  const clients = Array.from({ length: 4 }, () => registerOwnedProcess(spawn(process.execPath, [
    '--input-type=module', '-e', `import { ensureStudyService } from ${JSON.stringify(href)};
      const handle=await ensureStudyService(process.argv[1],{testOptions:{idleTimeoutMs:${process.platform === 'win32' ? 120000 : 3000},checkpointMs:50}});
      process.stdout.write(JSON.stringify(handle));`, storeDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }), 'independent ensure client'));
  const handles = await Promise.all(clients.map((child) => new Promise((resolve, reject) => {
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`ensure client ${code}: ${error}`)));
  })));
  const api = await service();
  t.after(() => api.stopStudyService(storeDir, { expectedInstanceId: handles[0].instanceId }));
  assert.equal(new Set(handles.map((handle) => handle.pid)).size, 1);
  assert.equal(new Set(handles.map((handle) => handle.studyUrl)).size, 1);
});

test('REQ-010: replaced loop lock invalidates a still-running registered parent', async (t) => {
  if (skipOnWin32(t, 'sub-second idle and checkpoint cadence is below the per-checkpoint proof cost on win32')) return;
  const storeDir = createOwnedTempDir('holdem-study-parent-replace');
  const original = acquireOwnedLock(storeDir, 'loop.lock.d');
  const launched = await launch(t, { parentIdentity: { pid: original.pid, startTime: original.startTime },
    testOptions: { idleTimeoutMs: 250, checkpointMs: 50 } }, storeDir);
  // Keep the original directory allocated while replacing the pathname. An
  // unlink/recreate may reuse its inode immediately on Linux filesystems.
  const retiredDir = path.join(storeDir, 'retired-loop.lock.d');
  fs.renameSync(original.dir, retiredDir);
  t.after(() => releaseOwnedLock({ ...original, dir: retiredDir }));
  const replacement = acquireOwnedLock(storeDir, 'loop.lock.d');
  assert.equal(fs.statSync(retiredDir, { bigint: true }).ino, original.ino);
  t.after(() => releaseOwnedLock(replacement));
  assert.equal(original.pid, replacement.pid);
  assert.notEqual(original.ino, replacement.ino);
  await until(() => !fs.existsSync(descriptorPath(storeDir)) && !fs.existsSync(lockPath(storeDir)));
  assert.equal(processStartTime(process.pid), original.startTime);
  assert.equal(fs.existsSync(path.join(storeDir, 'loop.lock.d')), true);
  assert.equal((await launched.api.inspectStudyService(storeDir)).status, 'stopped');
});

test('REQ-010: parent death cannot keep a study service alive through stale lock metadata', async (t) => {
  if (skipOnWin32(t, 'sub-second idle and checkpoint cadence is below the per-checkpoint proof cost on win32')) return;
  const storeDir = createOwnedTempDir('holdem-study-parent-death');
  const href = new URL('../engine/state.js', import.meta.url).href;
  const child = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireOwnedLock } from ${JSON.stringify(href)};
     const lock=acquireOwnedLock(process.argv[1],'loop.lock.d');
     process.stdout.write(JSON.stringify({pid:lock.pid,startTime:lock.startTime})+'\\n');setInterval(()=>{},1000);`, storeDir,
  ], { stdio: ['ignore','pipe','pipe'] }), 'owned loop identity fixture');
  const parentIdentity = await new Promise((resolve, reject) => {
    let line = ''; child.stdout.on('data', (chunk) => { line += chunk; if (line.includes('\n')) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  await launch(t, { parentIdentity, testOptions: { idleTimeoutMs: 250, checkpointMs: 50 } }, storeDir);
  child.kill('SIGTERM');
  await until(() => child.signalCode !== null);
  await until(() => !fs.existsSync(descriptorPath(storeDir)) && !fs.existsSync(lockPath(storeDir)));
  assert.equal(fs.existsSync(path.join(storeDir, 'loop.lock.d', 'pid')), true);
});

test('REQ-010: killed owned child can rebootstrap with new identity and capabilities', async (t) => {
  const first = await launch(t);
  first.children[0].kill('SIGKILL');
  await until(() => first.children[0].signalCode !== null);
  const second = await launch(t, {}, first.storeDir);
  assert.notEqual(second.handle.instanceId, first.handle.instanceId);
  assert.notEqual(second.token, first.token);
  assert.equal((await request(second.handle.port, first.token, '/api/health')).status, 401);
});

test('REQ-010: oversized safe regular descriptors are repaired without unbounded reads', async (t) => {
  const { storeDir, handle, api } = await launch(t);
  fs.writeFileSync(descriptorPath(storeDir), 'x'.repeat(10_000));
  assert.deepEqual(await api.ensureStudyService(storeDir), handle);
  assert.ok(fs.statSync(descriptorPath(storeDir)).size < 4096);
});

test('REQ-010: descriptor is the sole persisted capability sink during authenticated study activity', async (t) => {
  const { storeDir, handle, token } = await launch(t);
  const descriptor = readDescriptor(storeDir);
  await request(handle.port, token, '/api/start', { body: { mode: 'free', idempotencyKey: 'private-cap-scan' } });
  await request(handle.port, token, '/api/summary');
  const sinks = [];
  function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) scan(file);
      else if (item.isFile()) {
        const bytes = fs.readFileSync(file, 'utf8');
        if ([descriptor.drillToken, descriptor.controlToken, handle.studyUrl].some((secret) => bytes.includes(secret))) sinks.push(file);
      }
    }
  }
  scan(storeDir);
  assert.deepEqual(sinks, [descriptorPath(storeDir)]);
});

test('REQ-010: unrepaired live-owned metadata fails within five seconds without client lock removal or spawn', async () => {
  const storeDir = createOwnedTempDir('holdem-study-unrepaired');
  const training = path.join(storeDir, '.training'); fs.mkdirSync(training, { mode: 0o700 });
  const own = acquireOwnedLock(training, 'study.lock.d');
  const before = fs.readFileSync(path.join(lockPath(storeDir), 'pid'));
  const api = await service(); let spawns = 0;
  const started = Date.now();
  try {
    await assert.rejects(api.ensureStudyService(storeDir, { onChild() { spawns += 1; } }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
    assert.ok(Date.now() - started < CLIENT_WAIT_MS + 500, 'refusal must stay within the client budget');
    assert.equal(spawns, 0);
    assert.deepEqual(fs.readFileSync(path.join(lockPath(storeDir), 'pid')), before);
    assert.equal(processStartTime(process.pid), own.startTime);
  } finally { releaseOwnedLock(own); }
});

test('REQ-010: stopped helper confirms a dead owned instance without deleting its recovery metadata', async (t) => {
  const { storeDir, handle, children, api } = await launch(t);
  const before = fs.readFileSync(descriptorPath(storeDir));
  children[0].kill('SIGKILL');
  await until(() => children[0].signalCode !== null);
  assert.deepEqual(await api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId }), { stopped: true, alreadyStopped: true });
  assert.deepEqual(fs.readFileSync(descriptorPath(storeDir)), before);
  assert.equal(fs.existsSync(lockPath(storeDir)), true);
});

test('REQ-010: detached startup refuses a replacement training directory before acquiring its lock', async () => {
  const storeDir = createOwnedTempDir('holdem-study-startup-replace');
  const api = await service(); let child;
  await assert.rejects(api.ensureStudyService(storeDir, { onChild(spawned) {
    spawned.ref();
    child = registerOwnedProcess(spawned, 'replaced startup context');
    fs.renameSync(path.join(storeDir, '.training'), path.join(storeDir, 'original-training'));
    fs.mkdirSync(path.join(storeDir, '.training'), { mode: 0o700 });
  } }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  await until(() => child.exitCode !== null || child.signalCode !== null);
  assert.deepEqual(fs.readdirSync(path.join(storeDir, '.training')), []);
});

test('S7 repair: child startup is private under caller umask002 without changing caller or existing modes', { skip: process.platform === 'win32' ? 'POSIX umask/mode contract; Windows privacy is checked via DACL in the detached service test' : false }, async () => {
  const storeDir = createOwnedTempDir('holdem-study-umask');
  const href = new URL('../tools/study-service.js', import.meta.url).href;
  fs.mkdirSync(path.join(storeDir,'.training'),{mode:0o700});
  fs.writeFileSync(path.join(storeDir,'user-file'),'preserve',{mode:0o640});
  const child = registerOwnedProcess(spawn(process.execPath,['--input-type=module','-e',
    `import fs from 'node:fs';import {ensureStudyService,stopStudyService} from ${JSON.stringify(href)};
     process.umask(0o002);let service,handle;const store=process.argv[1];
     try {
       handle=await ensureStudyService(store,{onChild(child){service=child;child.ref();}});
       const modes={caller:process.umask(),root:fs.statSync(store).mode&0o777,
         training:fs.statSync(store+'/.training').mode&0o777,user:fs.statSync(store+'/user-file').mode&0o777,
         lock:fs.statSync(store+'/.training/study.lock.d').mode&0o777,
         pid:fs.statSync(store+'/.training/study.lock.d/pid').mode&0o777,
         descriptor:fs.statSync(store+'/.training/study-service.json').mode&0o777};
       await stopStudyService(store,{expectedInstanceId:handle.instanceId});process.stdout.write(JSON.stringify(modes));
     } catch(error){process.stdout.write(JSON.stringify({code:error.code}));process.exitCode=1;}
     finally{if(service&&service.exitCode===null&&service.signalCode===null){service.kill('SIGTERM');await new Promise(resolve=>service.once('exit',resolve));}}`,storeDir],
    {stdio:['ignore','pipe','pipe']}),'umask002 client');
  const observed = await new Promise(resolve=>{let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.on('close',code=>resolve({code,output}));});
  assert.equal(observed.code,0,'umask002 must not make the owned child lock unsafe');
  assert.deepEqual(JSON.parse(observed.output),{caller:0o002,root:0o700,training:0o700,user:0o640,lock:0o700,pid:0o600,descriptor:0o600});
});

for (const operation of ['inspect','stop']) for (const damage of ['missing','corrupt']) {
  test(`S7 repair: ${operation} waits for live owner ${damage} descriptor repair`,async(t)=>{
    const {storeDir,handle,api}=await launch(t);
    const original=readDescriptor(storeDir);
    if(damage==='missing')fs.unlinkSync(descriptorPath(storeDir));
    else fs.writeFileSync(descriptorPath(storeDir),'{');
    const started=Date.now();
    if(operation==='inspect'){
      const result=await api.inspectStudyService(storeDir);
      assert.equal(result.status,'running');assert.equal(result.instanceId,handle.instanceId);
      assert.equal(readDescriptor(storeDir).controlToken===original.controlToken,true);
    }else{
      const result=await api.stopStudyService(storeDir,{expectedInstanceId:handle.instanceId});
      assert.equal(result.stopped,true);assert.equal(fs.existsSync(descriptorPath(storeDir)),false);
    }
    assert.ok(Date.now()-started<CLIENT_WAIT_MS+500,'repair must stay within the client budget');
  });
}

test('S7 repair: stop retains expected instance through a missing-descriptor wait',async(t)=>{
  const {storeDir,handle,api,token}=await launch(t);
  fs.unlinkSync(descriptorPath(storeDir));
  await assert.rejects(api.stopStudyService(storeDir,{expectedInstanceId:randomUUID()}),{code:'STUDY_IDENTITY_MISMATCH'});
  assert.equal((await request(handle.port,token,'/api/health')).status,200);
});

for(const operation of ['inspect','stop']) {
  test(`S7 repair: ${operation} times out without changing a live owner's unrepaired metadata`,async()=>{
    const storeDir=createOwnedTempDir('holdem-study-repair-timeout');
    const training=path.join(storeDir,'.training');fs.mkdirSync(training,{mode:0o700});
    const owner=acquireOwnedLock(training,'study.lock.d');
    const raw='{';fs.writeFileSync(descriptorPath(storeDir),raw,{mode:0o600});
    const lockStat=fs.statSync(lockPath(storeDir));
    const pidBytes=fs.readFileSync(path.join(lockPath(storeDir),'pid'));
    const api=await service();const signals=[];const kill=process.kill;
    process.kill=(pid,signal)=>{if(signal!==0)signals.push({pid,signal});return kill(pid,signal);};
    const started=Date.now();
    try {
      const call=operation==='inspect' ? api.inspectStudyService(storeDir)
        : api.stopStudyService(storeDir,{expectedInstanceId:randomUUID()});
      await assert.rejects(call,{code:'STUDY_DESCRIPTOR_CORRUPT'});
      const elapsed=Date.now()-started;
      assert.ok(elapsed>=CLIENT_WAIT_MS-500&&elapsed<CLIENT_WAIT_MS+500,`repair deadline was ${elapsed}ms against a ${CLIENT_WAIT_MS}ms budget`);
      assert.deepEqual(signals,[]);
      assert.equal(fs.readFileSync(descriptorPath(storeDir),'utf8'),raw);
      assert.deepEqual(fs.readFileSync(path.join(lockPath(storeDir),'pid')),pidBytes);
      assert.equal(fs.statSync(lockPath(storeDir)).ino,lockStat.ino);
    } finally {process.kill=kill;releaseOwnedLock(owner);}
  });
}

test('S7 repair: inspect and stop refuse unknown ownership immediately without changing files',async()=>{
  const storeDir=createOwnedTempDir('holdem-study-unknown-owner');
  fs.mkdirSync(lockPath(storeDir),{recursive:true,mode:0o700});fs.chmodSync(path.join(storeDir,'.training'),0o700);
  fs.writeFileSync(descriptorPath(storeDir),'{',{mode:0o600});
  const api=await service();
  for(const call of [()=>api.inspectStudyService(storeDir),()=>api.stopStudyService(storeDir,{expectedInstanceId:randomUUID()})]){
    const started=Date.now();await assert.rejects(call(),{code:'STUDY_DESCRIPTOR_CORRUPT'});
    assert.ok(Date.now()-started<REQUEST_MS);
    assert.equal(fs.readFileSync(descriptorPath(storeDir),'utf8'),'{');
    assert.deepEqual(fs.readdirSync(lockPath(storeDir)),[]);
  }
});

test('S7 repair: waiting stop cannot target a replacement service instance',async(t)=>{
  const first=await launch(t);const descriptor=readDescriptor(first.storeDir);
  fs.unlinkSync(descriptorPath(first.storeDir));
  const pending=first.api.stopStudyService(first.storeDir,{expectedInstanceId:first.handle.instanceId}).then(
    value=>({value}),error=>({error}));
  await request(first.handle.port,null,'/internal/shutdown',{body:{expectedInstanceId:first.handle.instanceId},
    headers:{'x-study-control':descriptor.controlToken}});
  await until(()=>first.children[0].exitCode!==null||first.children[0].signalCode!==null);
  const second=await launch(t,{},first.storeDir);
  const result=await pending;
  assert.ok(['STUDY_DESCRIPTOR_CORRUPT','STUDY_IDENTITY_MISMATCH'].includes(result.error?.code));
  assert.equal((await request(second.handle.port,second.token,'/api/health')).status,200);
  assert.equal(readDescriptor(first.storeDir).instanceId,second.handle.instanceId);
});
