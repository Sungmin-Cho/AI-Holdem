import { finishJourney, selfTestJourney, cleanupJourney } from './journey-exit.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startAppService} from '../../tools/app-service.js';
import {inspectStudyService,stopStudyService} from '../../tools/study-service.js';
import {legalFor} from '../../engine/hand.js';
import {createBrowserWorkspace,hashTree} from '../helpers/learning-browser-fixture.mjs';
import {makeBrowser} from './multiplayer-journey.mjs';

// Real production app, independent browser sessions, and actual UI actions.
// Seeded engine shuffle; no state writes, synthetic snapshots, or direct action API.
export const requiredJourneyChecks = ["late-entry-all-cards", "player-cards-private", "spectator-no-actions", "spectator-reconnect", "folded-cards-visible", "automatic-elimination", "spectator-results", "eliminated-leave-host-rejoin", "next-game-spectator-retained", "host-seat-removal", "explicit-seat-request", "new-game-card-reset", "real-user-store-unchanged", "owned-cleanup"];

export async function runSpectatorJourney(outDir) {
  fs.mkdirSync(outDir,{recursive:true});
  const workspace=createBrowserWorkspace();
  const before=hashTree(path.resolve('game'));
  const browsers=Object.fromEntries(['user','h1','h2','observer'].map(id=>[id,makeBrowser(`spectator-${id}-${randomUUID()}`)]));
  const checks=[];let app,failure;
  const priorNodeOptions = process.env.NODE_OPTIONS;
  const preload = new URL('../helpers/spectator-seeded-engine.mjs', import.meta.url).href;
  process.env.NODE_OPTIONS = `${priorNodeOptions || ''} --import=${JSON.stringify(preload)}`;
  const evaluate=async(id,expr)=>{const data=await browsers[id](['eval',expr]);return data?.result??data;};
  const table=async(id,expr)=>evaluate(id,`(()=>{const doc=document.querySelector('#table')?.contentDocument;return doc?(${expr}):null;})()`);
  const wait=async(predicate,label)=>{
    const until=Date.now()+60_000;
    while(Date.now()<until){
      if(app?.manager.snapshot().state==='error')throw Error(`app error during ${label}: ${app.manager.snapshot().error}`);
      if(await predicate())return;await new Promise(r=>setTimeout(r,100));
    }
    throw Error(`spectator journey timeout: ${label}`);
  };
  const click=async(id,selector)=>{await browsers[id](['snapshot','-i']);await browsers[id](['click',selector]);};
  const engine=()=>JSON.parse(fs.readFileSync(path.join(app.manager.current.sessionDir,'state.json'),'utf8'));
  const watching=id=>table(id,"doc.body.classList.contains('spectator-mode') && !doc.querySelector('#spectator-banner').hidden");
  const join=async(id,name,href)=>{
    await browsers[id](['open',href]);await browsers[id](['snapshot','-i']);
    await browsers[id](['fill','#join-name',name]);await click(id,'#join-submit');
  };
  const pause=async()=>{await click('user','#menu');await wait(()=>app.manager.snapshot().state==='paused','pause');};
  const resume=async()=>{await click('user','#resume');await wait(()=>app.manager.snapshot().state==='playing','resume');};
  const end=async()=>{await pause();await click('user','#end');await click('user','#confirm-yes');await wait(()=>['ended','completed'].includes(app.manager.snapshot().state),'end');};
  try {
    app=await startAppService(workspace.root,{resolver:async()=>({player:null,upper:null,notices:[]}),publicPort:0});
    await browsers.user(['open',app.url]);await browsers.user(['set','viewport','1280','1000']);
    await wait(()=>evaluate('user',"document.querySelector('#status')?.textContent==='로비'"),'lobby');
    await browsers.user(['snapshot','-i']);
    await browsers.user(['select','#total-seats','3']);await browsers.user(['select','#action-timeout','120']);
    await click('user','input[value="tournament"]');await click('user','summary');
    await browsers.user(['fill','input[name="stack"]','500']);
    await click('user','#room-open');
    const href=`http://127.0.0.1:${app.publicPort}/join?code=${app.manager.room.load().joinCode}`;
    await join('h1','민준',href);await join('h2','서연',href);
    await click('user','#start');
    await wait(()=>app.manager.snapshot().state==='playing'&&!app.manager.snapshot().pendingRequestId,'start');
    await pause();
    const seeded = engine();
    assert.equal(seeded.handNo, 1);
    assert.equal(seeded.button, 0);
    assert.deepEqual(seeded.hand.holes, {h1:['3d','9c'],h2:['2d','7s'],user:['Qs','Kc']});
    await join('observer','관전자',href);
    await wait(()=>watching('observer'),'late spectator');
    assert.equal(await table('observer',"doc.querySelectorAll('.seat-cards .card[aria-label]').length"),6);
    assert.equal(await table('h1',"doc.body.classList.contains('spectator-mode')"),false);
    assert.equal(await table('h1',"doc.querySelectorAll('.seat-cards .card[aria-label]').length"),2);
    assert.equal(await table('observer',"doc.querySelector('#action-bar').hidden"),true);
    checks.push('late-entry-all-cards','player-cards-private','spectator-no-actions');
    await browsers.observer(['screenshot',path.join(outDir,'late-spectator.png')]);
    await browsers.observer(['reload']);await wait(()=>watching('observer'),'reload role');
    checks.push('spectator-reconnect');await resume();
    let eliminated;
    for(let i=0;i<24;i++) {
      const state=engine();eliminated=state.seats.find(s=>s.out);
      if(eliminated)break;
      const actor=legalFor(state)?.toAct;
      if(!actor){await new Promise(r=>setTimeout(r,150));continue;}
      await browsers[actor](['snapshot','-i']);
      const acted=await table(actor,`(()=>{
        const visible=b=>b&&!b.disabled&&!b.hidden;
        const fold=doc.querySelector('#btn-fold'),raise=doc.querySelector('#btn-raise');
        const allin=doc.querySelector('#btn-allin-only'),call=doc.querySelector('#btn-call'),check=doc.querySelector('#btn-check');
        if(${JSON.stringify(actor)}==='h2'&&visible(fold)){fold.click();return 'fold';}
        if(${JSON.stringify(state.hand?.street)}==='preflop') {
          if(visible(call)){call.click();return 'call';}
          if(visible(check)){check.click();return 'check';}
        }
        if(visible(allin)){allin.click();return 'allin';}
        const preset=doc.querySelector('[data-preset="allin"]');
        if(visible(raise)&&visible(preset)){preset.click();raise.click();return 'raise';}
        if(visible(call)){call.click();return 'call';}
        return false;
      })()`);
      if(acted==='fold') {
        await wait(()=>table('observer',"doc.querySelector('.seat.is-folded .card[aria-label]')!==null"),'fold cards');
        checks.push('folded-cards-visible');
      }
      if(acted)await new Promise(r=>setTimeout(r,300));
    }
    await wait(()=>engine().seats.some(s=>s.out),'settled elimination');
    eliminated=engine().seats.find(s=>s.out);
    assert.equal(eliminated.playerId,'h1','seeded scenario must eliminate a guest');
    assert.equal(engine().gameOver,false);
    await wait(()=>watching(eliminated.playerId),'automatic elimination spectator');
    assert.equal(await table(eliminated.playerId,"[...doc.querySelectorAll('.log-name')].some(node=>node.textContent==='나')"),false);
    checks.push('automatic-elimination');
    await pause();
    await browsers[eliminated.playerId](['screenshot',path.join(outDir,'eliminated-spectator.png')]);
    const departed=eliminated.playerId;
    {
      await click(departed,'#leave');
      await wait(()=>evaluate(departed,"!document.querySelector('#join-form').hidden"),'eliminated guest leaves');
    }
    await browsers.observer(['set','viewport','390','844']);
    await browsers.observer(['screenshot',path.join(outDir,'spectator-mobile.png')]);
    await resume();await end();
    await wait(()=>evaluate('observer',"document.querySelector('#final').hidden===false"),'observer results');
    checks.push('spectator-results');
    {
      const participant=app.manager.room.load().participants.find(row=>row.playerId===departed);
      await wait(()=>evaluate('user',"!document.querySelector('#seat-management').hidden"),'host seat management');
      await click('user',`[data-participant-id="${participant.participantId}"] [data-action="reissue"]`);
      await wait(()=>evaluate('user',"!document.querySelector('#rejoin-link').hidden"),'rejoin link');
      const rejoinLink=await evaluate('user',"document.querySelector('#rejoin-link').value");
      await browsers[departed](['open',rejoinLink]);
      await wait(()=>evaluate(departed,"document.querySelector('#join-form').hidden"),'guest rejoined with host link');
      checks.push('eliminated-leave-host-rejoin');
    }
    // The observer must not be silently seated in a subsequent game.
    await click('user','#result-restart');
    await wait(()=>app.manager.snapshot().state==='playing','second game');
    await wait(()=>watching('observer'),'spectator retained in next game');
    checks.push('next-game-spectator-retained');await end();
    // Release an original seat only after the tournament ends, then opt in.
    const oldSeat=app.manager.room.load().participants.find(row=>row.playerId==='h2');
    await wait(()=>evaluate('user',"!document.querySelector('#seat-management').hidden"),'seat removal enabled');
    await click('user',`[data-participant-id="${oldSeat.participantId}"] [data-action="remove"]`);
    checks.push('host-seat-removal');
    await wait(()=>evaluate('observer',"!document.querySelector('#seat-request').disabled"),'seat available');
    await click('observer','#seat-request');
    await wait(()=>evaluate('observer',"document.querySelector('#seat-request').hidden"),'promoted');
    await click('user','#result-restart');
    await wait(()=>app.manager.snapshot().state==='playing','third game');
    await pause();
    await wait(()=>table('observer',"doc.querySelectorAll('.seat-cards .card[aria-label]').length===2 && !doc.body.classList.contains('spectator-mode')"),'promoted private view');
    checks.push('explicit-seat-request','new-game-card-reset');
    await browsers.observer(['screenshot',path.join(outDir,'promoted-player.png')]);
    await resume();await end();
  } catch(error) {
    failure=error;
    if(app?.manager.current?.sessionDir) {
      const loop=JSON.parse(fs.readFileSync(path.join(app.manager.current.sessionDir,'loop-state.json'),'utf8'));
      fs.writeFileSync(path.join(outDir,'failure-state.json'),JSON.stringify({appError:app.manager.snapshot().error,phase:loop.phase,halt:loop.halt,notices:loop.notices},null,2));
    }
    await browsers.user(['screenshot',path.join(outDir,'failure-host.png')]).catch(()=>{});
    await browsers.observer(['screenshot',path.join(outDir,'failure-observer.png')]).catch(()=>{});
  } finally {
    const cleanup = await cleanupJourney({ failure, steps: [
      ...Object.values(browsers).map(browser => () => browser(['close'])),
      () => app?.close(),
      async () => { const study = await inspectStudyService(workspace.root);
        if (study.status === 'running') await stopStudyService(workspace.root, { expectedInstanceId: study.instanceId }); },
      () => { assert.equal(hashTree(path.resolve('game')), before); checks.push('real-user-store-unchanged'); },
      () => workspace.close(),
    ] });
    if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = priorNodeOptions;
    failure = cleanup.failure;
    if (!cleanup.errors.length) checks.push('owned-cleanup');
    try { finishJourney({ required: requiredJourneyChecks, recorded: checks, failure }); }
    catch (error) { failure = error; }
    fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:!failure,checks,cleanupErrors:cleanup.errors.map(error=>error.message),error:failure?.stack},null,2));
  }
  finishJourney({ required: requiredJourneyChecks, recorded: checks, failure });
}
if(!process.env.NODE_TEST_CONTEXT&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (!selfTestJourney(requiredJourneyChecks)) {
    const i=process.argv.lastIndexOf('--out-dir');if(i<0)throw Error('--out-dir required');
    await runSpectatorJourney(path.resolve(process.argv[i+1]));console.log('Spectator browser journey PASS');
  }
}
