import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {abortModeFor} from '../tools/recovery-exit.js';

// Observed with actual ddcabe2 modules in a detached, isolated checkout. This
// fixture is historical evidence, not an invocation of an old model service.
const captured=JSON.parse(fs.readFileSync(new URL('./fixtures/recovery-compatibility-ddcabe2.json',import.meta.url)));
test('#197 pinned old-runtime evidence distinguishes unsafe legacy continuation from managed parking',()=>{
  assert.equal(captured.baselineCommit,'ddcabe22f82b2fb5fc6d9a2d423b754f33b627ff');
  assert.match(captured.captureLogSha256,/^[a-f0-9]{64}$/);
  assert.match(captured.captureScriptSha256,/^[a-f0-9]{64}$/);
  assert.equal(captured.cases.length,10);
  const get=(entrypoint,name)=>captured.cases.find(c=>c.entrypoint===entrypoint&&c.case===name);
  const legacy=get('legacy-loop-api','checkpoint-playing');
  assert.equal(legacy.actions,1);assert.equal(legacy.abortingRetained,true);
  assert.equal(get('legacy-loop-api','fresh-authorization').freshAuthorizationRetained,true);
  assert.equal(get('legacy-loop-api','snapshot-only').actions,0);
  const managed=get('managed-initialize','checkpoint-playing');
  assert.equal(managed.state,'paused');assert.equal(managed.actions,0);
  // The current implementation offers explicit abort instead of following that
  // historical legacy continuation; lifecycle execution is tested separately.
  assert.equal(abortModeFor({gameOver:false},{phase:legacy.phase}),'abort');
  for(const name of ['aborted-no-row','aborted-end'])assert.equal(get('managed-initialize',name).state,'ended');
  for(const name of ['aborted-restart','restart-reservation','restart-staging','restart-committed']){
    const row=get('managed-initialize',name);
    assert.equal(row.state,'paused');assert.equal(row.newGame,true);
    assert.equal(row.actions,0);assert.equal(row.receiptStatus,'succeeded');
  }
});
