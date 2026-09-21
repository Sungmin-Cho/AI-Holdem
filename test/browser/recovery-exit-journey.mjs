import { finishJourney, selfTestJourney, cleanupJourney } from './journey-exit.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startAppService} from '../../tools/app-service.js';
import {inspectStudyService,stopStudyService} from '../../tools/study-service.js';
import {createBrowserWorkspace,runOwnedCommand,hashTree} from '../helpers/learning-browser-fixture.mjs';

// The adapter exercises the full app/relay/browser protocol without paid models.
export const requiredJourneyChecks = ["page-loaded-no-overlay-or-uncaught-errors", "end-cancel-preserves-engine", "end-confirmed", "restart-cancel-preserves-engine", "restart-confirmed", "raw-bytes-and-old-engine-preserved-end", "raw-bytes-and-old-engine-preserved-restart", "owned-cleanup", "real-user-store-unchanged"];

export async function runRecoveryExitJourney(outDir) {
  fs.mkdirSync(outDir,{recursive:true});
  const workspace=createBrowserWorkspace(),root=workspace.root;
  const userStore=path.resolve('game'),before=hashTree(userStore),session=`recovery-${randomUUID()}`;
  let app,failure;
  const checks=[],decisions=[],warmups=[];
  const resolver=async()=>({player:{kind:'fake',async warmup(input){warmups.push(input);return {sessionId:`seat-${warmups.length}`,raw:'ready'};},
    async decide(input){decisions.push(input);return {raw:'invalid'};},async dispose(){}},upper:null,notices:[]});
  const browser=async args=>{
    const r=await runOwnedCommand('npx',['--yes','agent-browser@0.36.0','--session',session,'--json',...args],{timeoutMs:45000});
    assert.equal(r.exitCode,0,`${args[0]} browser command failed: ${r.stderr?.slice(-2000) ?? ''}`);
    const result=JSON.parse(r.stdout);assert.notEqual(result.success,false);return result.data;
  };
  const evaluate=async expr=>{const r=await browser(['eval',expr]);return r?.result??r;};
  const wait=async predicate=>{for(let i=0;i<150;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('recovery journey state timeout');};
  const click=selector=>browser(['click',selector]);
  const read=file=>JSON.parse(fs.readFileSync(file));
  let pageNo=0;
  const openAndVerify=async()=>{
    await browser(['open',app.url]);
    assert.equal(await evaluate("document.body.innerText.trim().length>0"),true);
    assert.equal(await evaluate("!!document.querySelector('[data-nextjs-dialog],.vite-error-overlay,#webpack-dev-server-client-overlay')"),false);
    const tree=await browser(['snapshot','-i']);
    assert.match(JSON.stringify(tree),/button/);
    const errors=await browser(['errors']);assert.deepEqual(errors.errors,[]);
    await browser(['screenshot',path.join(outDir,`page-${++pageNo}.png`)]);
    checks.push('page-loaded-no-overlay-or-uncaught-errors');
  };
  try {
    for(const kind of ['restart','end']) {
      app=await startAppService(root,{resolver});
      if(kind==='restart') {
        app.manager.setPrefill({aiCount:5,opponentRuntime:'llm',playerSoftMs:1000,playerHardMs:10000});
        await openAndVerify();
        await wait(()=>evaluate("!document.querySelector('#start').disabled"));await click('#start');
      } else {
        await openAndVerify();
        await wait(()=>evaluate("!document.querySelector('#recover').hidden"));await click('#recover');
        // Managed resume parks only while restoring, then resumes on its own
        // unless a pending decision exists. The common loop below waits for
        // that durable pending boundary instead of clicking through a transient pause.
      }
      await wait(async()=>{
        if(app.manager.snapshot().state==='paused'&&app.manager.snapshot().pendingDecision)return true;
        await evaluate("(()=>{const d=document.querySelector('#table').contentDocument;const b=d?.querySelector('#btn-fold');if(b&&!b.disabled)b.click();})()");return false;
      });
      const old=app.manager.current,engineFile=path.join(old.sessionDir,'state.json'),loopFile=path.join(old.sessionDir,'loop-state.json');
      await app.close();app=null;
      const parsed=read(loopFile);
      const raw=Buffer.from(JSON.stringify({...parsed,pendingDecision:{...parsed.pendingDecision,generation:'RAW_INFINITY',
        freshAuthorization:{source:'app',requestId:'unconsumed-fixture'}}}).replace('"RAW_INFINITY"','1e400'));
      fs.writeFileSync(loopFile,raw);
      const engineBefore=read(engineFile),decisionCount=decisions.length;
      app=await startAppService(root,{resolver});await openAndVerify();
      await wait(()=>evaluate("!document.querySelector('#recover').hidden"));await click('#recover');
      await wait(()=>app.manager.snapshot().error==='BAD_PLAYER_RECOVERY');
      await wait(()=>evaluate("!document.querySelector('#result-end').hidden&&!document.querySelector('#result-end').disabled"));
      assert.equal(decisions.length,decisionCount);
      assert.deepEqual(fs.readFileSync(path.join(old.sessionDir,'loop-state.unverified.json')),raw);
      assert.match(await evaluate("document.querySelector('#result-message').textContent"),/검증할 수 없어/);
      await browser(['screenshot',path.join(outDir,`${kind}-unverifiable.png`)]);
      const selector=kind==='end'?'#result-end':'#result-restart';
      await click(selector);assert.equal(await evaluate("document.querySelector('#confirm-dialog').open"),true);
      await click('#confirm-no');assert.deepEqual(read(engineFile),engineBefore);checks.push(`${kind}-cancel-preserves-engine`);
      await click(selector);await click('#confirm-yes');
      await wait(()=>kind==='end'?app.manager.snapshot().state==='ended':app.manager.snapshot().gameId!==old.gameId&&!app.manager.snapshot().pendingRequestId);
      const engineAfter=read(engineFile),state=read(loopFile);
      assert.equal(engineAfter.result,'abort');
      for(const key of ['seats','lastHand','config','sessionToken','policySeed'])assert.deepEqual(engineAfter[key],engineBefore[key],key);
      assert.deepEqual(fs.readFileSync(path.join(old.sessionDir,state.abandonedPendingDecision.sidecar)),raw);
      assert.equal(state.aborting,undefined);assert.equal(state.pendingDecision,undefined);
      if(kind==='end')assert.equal(decisions.length,decisionCount);
      else assert.notEqual(app.manager.snapshot().gameId,old.gameId);
      checks.push(`${kind}-confirmed`,`raw-bytes-and-old-engine-preserved-${kind}`);
      await browser(['screenshot',path.join(outDir,`${kind}-finished.png`)]);
      await app.close();app=null;
    }
  } catch(error){failure=error;await browser(['screenshot',path.join(outDir,'error.png')]).catch(()=>{});}
  finally {
    const cleanup = await cleanupJourney({ failure, steps: [
      () => browser(['close']),
      () => app?.close(),
      async () => { const study = await inspectStudyService(root);
        if (study.status === 'running') await stopStudyService(root, { expectedInstanceId: study.instanceId }); },
      () => { assert.equal(hashTree(userStore), before); checks.push('real-user-store-unchanged'); },
      () => workspace.close(),
    ] });
    failure = cleanup.failure;
    if (!cleanup.errors.length) checks.push('owned-cleanup');
    try { finishJourney({ required: requiredJourneyChecks, recorded: checks, failure }); }
    catch (error) { failure = error; }
    fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:!failure,checks,cleanupErrors:cleanup.errors.map(error=>error.message),error:failure?.message},null,2));
  }
  finishJourney({ required: requiredJourneyChecks, recorded: checks, failure });
}
if(!process.env.NODE_TEST_CONTEXT&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (!selfTestJourney(requiredJourneyChecks)) {
    const i=process.argv.lastIndexOf('--out-dir');if(i<0)throw new Error('--out-dir required');
    await runRecoveryExitJourney(path.resolve(process.argv[i+1]));console.log('Recovery exit browser journey PASS');
  }
}
