import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startAppService} from '../../tools/app-service.js';
import {inspectStudyService,stopStudyService} from '../../tools/study-service.js';
import {createBrowserWorkspace,runOwnedCommand,hashTree} from '../helpers/learning-browser-fixture.mjs';

export async function runFreshSessionJourney(outDir) {
  fs.mkdirSync(outDir,{recursive:true});
  const workspace=createBrowserWorkspace(), root=workspace.root;
  const userStore=path.resolve('game'),before=hashTree(userStore),session=`fresh-${randomUUID()}`;
  const calls=[],warmups=[];
  const adapter={kind:'fake',async warmup(input) {warmups.push(input);return {sessionId:`session-${input.playerId}-${warmups.length}`,raw:'ready'};},
    async decide(input) {calls.push(input);return {raw:'invalid'};},async dispose(){}};
  let app,failure;
  const checks=[];
  const browser=async args=>{
    const r=await runOwnedCommand('npx',['--yes','agent-browser@0.36.0','--session',session,'--json',...args],{timeoutMs:45000});
    assert.equal(r.exitCode,0,`${args[0]} browser command failed`);
    const result=JSON.parse(r.stdout);assert.notEqual(result.success,false);return result.data;
  };
  const evaluate=async expr=>{const r=await browser(['eval',expr]);return r?.result??r;};
  const wait=async predicate=>{for(let i=0;i<150;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('fresh journey state timeout');};
  const click=selector=>browser(['click',selector]);
  try {
    app=await startAppService(root,{resolver:async()=>({player:adapter,upper:null,notices:[]})});
    app.manager.setPrefill({aiCount:5,opponentRuntime:'llm',playerSoftMs:100,playerHardMs:1000});
    await browser(['open',app.url]);
    await wait(()=>evaluate("!document.querySelector('#start').disabled"));
    await click('#start');
    await wait(async()=>{
      if(app.manager.snapshot().state==='paused')return true;
      await evaluate("(()=>{const d=document.querySelector('#table').contentDocument;const b=d?.querySelector('#btn-fold');if(b&&!b.disabled)b.click();})()");
      return false;
    });
    await wait(()=>evaluate("document.querySelector('#menu').textContent==='일시정지 메뉴'"));
    await click('#menu');
    await wait(()=>evaluate("!document.querySelector('#retry-fresh-session').hidden&&!document.querySelector('#retry-fresh-session').disabled"));
    const count=warmups.length;
    await click('#retry-fresh-session');
    assert.equal(await evaluate("document.querySelector('#fresh-session-dialog').open"),true);
    assert.match(await evaluate("document.querySelector('#fresh-session-dialog').textContent"),/대화 기억.*사라집니다/s);
    await browser(['screenshot',path.join(outDir,'fresh-confirmation.png')]);
    await click('#fresh-session-no');
    assert.equal(warmups.length,count);checks.push('cancel-does-not-recreate');
    await click('#retry-fresh-session');await click('#fresh-session-yes');
    await wait(()=>warmups.length===count+1&&calls.length===4&&app.manager.snapshot().state==='paused'&&!app.manager.snapshot().pendingRequestId);
    assert.deepEqual(calls.map(x=>(x.message.match(/\[교정\]/g)||[]).length),[0,1,0,1]);
    checks.push('confirmed-fresh-session','correction-context-reset');
    await wait(()=>evaluate("!document.querySelector('#retry-fresh-session').disabled"));
    if(!await evaluate("document.querySelector('#pause-dialog').open"))await click('#menu');
    await browser(['screenshot',path.join(outDir,'fresh-reparked.png')]);
    await click('#end');await click('#confirm-yes');
    await wait(()=>app.manager.snapshot().state==='ended');checks.push('end-after-fresh-retry');
  } catch(error) {failure=error;}
  finally {
    await browser(['close']).catch(()=>{});await app?.close();
    const study=await inspectStudyService(root);
    if(study.status==='running')await stopStudyService(root,{expectedInstanceId:study.instanceId});
    assert.equal(hashTree(userStore),before);workspace.close();checks.push('owned-cleanup','real-user-store-unchanged');
    fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:!failure,checks,error:failure?.message},null,2));
  }
  if(failure)throw failure;
}
if(!process.env.NODE_TEST_CONTEXT&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const i=process.argv.indexOf('--out-dir');if(i<0)throw new Error('--out-dir required');
  await runFreshSessionJourney(path.resolve(process.argv[i+1]));console.log('Fresh session browser journey PASS');
}
