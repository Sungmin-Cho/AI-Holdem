import { finishJourney, selfTestJourney } from './journey-exit.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureStudyService, inspectStudyService, stopStudyService } from '../../tools/study-service.js';
import { startDrillServer } from '../../tools/drill-server.js';
import { createBrowserWorkspace, runOwnedCommand } from '../helpers/learning-browser-fixture.mjs';
import { createReplayGame, sourceSnapshot } from '../helpers/replay-library-fixture.mjs';

export const requiredJourneyChecks = ['independent-study','study-entry','own-view-privacy','forward-error-focus','future-prefix-dom','decision-navigation','keyboard','late-response','multiplayer-host-privacy','heartbeat-idle-pagehide','explicit-reveal','hand-reset','game-reset','mobile-nine-seats','host-absent','legacy-participation','partial-corruption','reload-token','mixed-version','no-uncaught-errors','source-immutable','owned-cleanup'];
export const browserCliEnabled = (env=process.env) => !env.NODE_TEST_CONTEXT;
export async function runReplayJourney(outDir) {
  fs.mkdirSync(outDir,{recursive:true});
  const workspace=createBrowserWorkspace(), storeDir=path.join(workspace.root,'store'), session='replay-'+randomUUID();
  const checks=[], commands=[]; let failure, study, old, heartbeatStudy, heartbeatStore, started=false;
  // Every protected source belongs to the owned fixture. A running user's store
  // may change independently, so this journey does not hash an unrelated writer.
  const secrets=new Set();
  const sanitize=text=>{let value=String(text);for(const secret of secrets)value=value.replaceAll(secret,'[redacted]');return value;};
  async function browser(args) {
    const r=await runOwnedCommand('npx',['--yes','agent-browser@0.36.0','--session',session,'--json',...args],{timeoutMs:45000});
    commands.push({operation:args[0],exitCode:r.exitCode,stderr:sanitize(r.stderr)});
    assert.equal(r.exitCode,0,sanitize(r.stdout+r.stderr).slice(0,1500));
    const result=JSON.parse(r.stdout);assert.notEqual(result.success,false,sanitize(r.stdout));return result.data;
  }
  const evaluate=async expression=>{const result=await browser(['eval',expression]);return result?.result??result;};
  const click=async selector=>{await browser(['snapshot','-i']);await browser(['click',selector]);};
  const wait=selector=>browser(['wait',selector]);
  const selectGame=async game=>{await click('[data-game-id="'+game.gameId+'"]');await wait('[data-hand-no="1"]');assert.equal(await evaluate("!!document.activeElement.closest('#library-content')"),true);};
  const selectHand=async number=>{await click('[data-hand-no="'+number+'"]');await wait('.replayer');};
  async function assertOwn() {
    const result=await evaluate("({text:document.querySelector('#library-player').textContent,holes:[...document.querySelectorAll('.replayer-seat:not([data-player-id=user]) .card')].map(n=>n.outerHTML),faceCount:document.querySelectorAll('.replayer-seat:not([data-player-id=user]) .card[role=img]').length,last:!!document.querySelector('.replayer-last'),rows:document.querySelectorAll('.replayer-item').length})");
    assert.equal(result.last,false);assert.equal(result.rows,1);assert.equal(result.faceCount,0);
    assert.doesNotMatch(result.text,/코치 피드백 대기|정책 결정|승자|사후 설명/);
    assert.ok(result.holes.every(html=>!/data-card=|에이스|킹|퀸|잭/.test(html)));
  }
  try {
    const two=createReplayGame(storeDir,{hands:2});
    const short=createReplayGame(storeDir,{hands:1,foldFirst:true});
    const nine=createReplayGame(storeDir,{aiCount:8,hands:2});
    const current=createReplayGame(storeDir,{hands:2,ongoing:true});
    fs.writeFileSync(current.handPath(2),'{invalid');
    const absent=createReplayGame(storeDir,{mode:'tournament',aiCount:1,hands:1,hostAbsent:true,participants:[{playerId:'h1',participantId:'fixture-human',name:'참가자'}]});
    const privateGame=createReplayGame(storeDir,{aiCount:1,hands:1,mode:'tournament',foldFirst:true,showdownPolicy:'standard',participants:[{playerId:'h1',participantId:'private-human',name:'비공개 참가자'}]});
    const legacy=createReplayGame(storeDir,{hands:1});const legacyRecord=JSON.parse(fs.readFileSync(legacy.handPath(1),'utf8'));delete legacyRecord.positions;fs.writeFileSync(legacy.handPath(1),JSON.stringify(legacyRecord));
    const damaged=createReplayGame(storeDir,{hands:1});fs.writeFileSync(path.join(damaged.sessionDir,'state.json'),'{damaged');
    const before=sourceSnapshot(storeDir);
    study=await ensureStudyService(storeDir);const url=new URL(study.studyUrl);const token=new URLSearchParams(url.hash.slice(1)).get('token') ?? url.searchParams.get('token');secrets.add(token);
    assert.ok(token);const origin=url.origin;
    assert.equal((await inspectStudyService(storeDir)).status,'running');checks.push('independent-study');
    started=true;await browser(['set','viewport','1280','900']);await browser(['open',study.studyUrl]);await wait('#replay-entry-link:not([hidden])');await click('#replay-entry-link');await wait('[data-game-id]');checks.push('study-entry');assert.match(await evaluate("document.querySelector('[data-game-id=\""+damaged.gameId+"\"]').textContent"),/종류 확인 불가/);
    await selectGame(two);
    const saved=fs.readFileSync(two.handPath(1));fs.writeFileSync(two.handPath(1),'{damaged');
    await click('[data-hand-no="1"]');await browser(['wait','--fn',"document.querySelector('#library-status').textContent.includes('확인할 수 없습니다')"]);await wait('#library-status:focus');
    assert.match(await evaluate("document.querySelector('#library-status').textContent"),/확인할 수 없습니다/);
    fs.writeFileSync(two.handPath(1),saved);
    await browser(['press','Tab']); // loading/error guidance is a real keyboard focus target
    await click('#library-nav button:last-child');await wait('.replayer');
    await assertOwn();checks.push('forward-error-focus');checks.push('own-view-privacy');
    const fullPrefix=await evaluate("document.querySelector('#library-player').innerHTML");
    await click('#library-nav button:first-child');await wait('[data-game-id]');await selectGame(short);await selectHand(1);
    assert.equal(await evaluate("document.querySelector('#library-player').innerHTML"),fullPrefix);
    checks.push('future-prefix-dom');
    await click('#library-nav button:first-child');await wait('[data-game-id]');await selectGame(two);await selectHand(1);
    const decision=await evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent.includes('다음 내 결정'))?.outerHTML");assert.ok(decision);
    const decisionBefore=await evaluate("document.querySelector('.replayer-progress').textContent");
    await click('.replayer-next-decision');
    assert.notEqual(await evaluate("document.querySelector('.replayer-progress').textContent"),decisionBefore);checks.push('decision-navigation');
    await evaluate("document.querySelector('.replayer-first').click();document.querySelector('.replayer-next').focus()");
    const progressBefore=await evaluate("document.querySelector('.replayer-progress').textContent");
    await browser(['press','Enter']);
    assert.notEqual(await evaluate("document.querySelector('.replayer-progress').textContent"),progressBefore);checks.push('keyboard');
    await click('.replay-player-full');await wait('.replayer-last');
    assert.equal(await evaluate("document.querySelectorAll('.replayer-seat[data-player-id=p1] .card[role=img]').length"),2);
    await click('.replayer-last');assert.match(await evaluate("document.querySelector('#library-player').textContent"),/결과/);
    assert.equal(await evaluate("document.querySelector('.replayer-play').disabled"),false,'full replay can restart at its end');
    await click('.replayer-play');await click('.replayer-play');checks.push('explicit-reveal');
    await click('#library-nav button:nth-child(2)');await wait('[data-hand-no="2"]');await selectHand(2);await assertOwn();checks.push('hand-reset');
    await click('#library-nav button:first-child');await wait('[data-game-id]');await selectGame(nine);await selectHand(1);await assertOwn();checks.push('game-reset');
    await browser(['set','viewport','390','844']);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true);
    assert.equal(await evaluate("document.querySelectorAll('.replayer-seat').length"),9);
    await browser(['screenshot',path.resolve(outDir,'replay-mobile-nine.png')]);checks.push('mobile-nine-seats');
    await browser(['reload']);await wait('[data-game-id]');assert.equal(await evaluate("new URL(location.href).searchParams.has('token')"),false);checks.push('reload-token');
    await selectGame(legacy);assert.match(await evaluate("document.querySelector('[data-hand-no]').textContent"),/위치 정보 없음/);assert.doesNotMatch(await evaluate("document.querySelector('[data-hand-no]').textContent"),/참여 안 함/);await selectHand(1);assert.equal(await evaluate("document.querySelectorAll('.replayer-seat[data-player-id=user]').length"),1);checks.push('legacy-participation');await click('#library-nav button:first-child');await wait('[data-game-id]');
    await selectGame(absent);assert.match(await evaluate("document.querySelector('[data-hand-no=\"2\"]').textContent"),/참여 안 함/);await selectHand(2);
    assert.equal(await evaluate("document.querySelectorAll('.replayer-seat[data-player-id=user]').length"),0);
    assert.match(await evaluate("document.querySelector('#library-player').textContent"),/참여하지|참여 안 함/);checks.push('host-absent');
    await click('#library-nav button:first-child');await wait('[data-game-id]');await selectGame(current);
    assert.equal(await evaluate("document.querySelector('[data-hand-no=\"2\"]').disabled"),true);
    assert.equal(await evaluate("document.querySelectorAll('[data-hand-no]').length"),2);checks.push('partial-corruption');
    await click('#library-nav button:first-child');await wait('[data-game-id]');await selectGame(privateGame);await selectHand(1);
    await click('.replay-player-full');
    assert.equal(await evaluate("document.querySelectorAll('.replayer-seat[data-player-id=h1] .card[role=img]').length"),0);
    assert.equal(await evaluate("document.querySelectorAll('.replayer-seat[data-player-id=p1] .card[role=img]').length"),2);
    const privateDto=await (await fetch(origin+'/api/replays/games/'+privateGame.gameId+'/hands/1',{headers:{'x-drill-token':token}})).json();
    assert.equal(privateDto.replay.holes.h1,undefined);checks.push('multiplayer-host-privacy');

    await click('#library-nav button:first-child');await wait('[data-game-id]');await selectGame(two);
    await evaluate("window.__realReplayJson=Response.prototype.json;window.__delayedReplay=false;Response.prototype.json=async function(){const value=await window.__realReplayJson.call(this);if(this.url.endsWith('/hands/1')){window.__delayedReplay=true;await new Promise(resolve=>setTimeout(resolve,5000));}return value;}");
    await click('[data-hand-no="1"]');
    for(let tries=0;!await evaluate('window.__delayedReplay');tries++){assert.ok(tries<15);await browser(['wait','100']);}
    await click('#library-nav button:first-child');await wait('[data-game-id]');await selectGame(nine);await selectHand(2);
    const title=await evaluate("document.querySelector('.replay-player-title').textContent");
    await browser(['wait','5100']);
    assert.equal(await evaluate("document.querySelector('.replay-player-title').textContent"),title);
    assert.match(title,/2/);
    await evaluate("Response.prototype.json=window.__realReplayJson");checks.push('late-response');
    old=await startDrillServer({storeDir,token:'old-service-token',replayEnabled:false});secrets.add('old-service-token');
    await browser(['open','http://127.0.0.1:'+old.port+'/drill.html#token=old-service-token']);
    await wait('#replay-entry-retry:not([hidden])');
    assert.equal(await evaluate("document.querySelector('#replay-entry-link').hidden"),true);
    assert.match(await evaluate("document.querySelector('#replay-entry-status').textContent"),/종료한 뒤 다시/);
    assert.equal((await fetch('http://127.0.0.1:'+old.port+'/replay.html')).status,404);checks.push('mixed-version');
    const mixedErrors=await browser(['errors']);assert.deepEqual(mixedErrors?.errors??[],[]);
    heartbeatStore=path.join(workspace.root,'heartbeat-store');createReplayGame(heartbeatStore,{hands:1});
    heartbeatStudy=await ensureStudyService(heartbeatStore,{testOptions:{idleTimeoutMs:4000,checkpointMs:50}});
    const hbUrl=new URL(heartbeatStudy.studyUrl),hbToken=new URLSearchParams(hbUrl.hash.slice(1)).get('token');secrets.add(hbToken);
    await browser(['open',hbUrl.origin+'/replay.html#token='+hbToken]);await wait('[data-game-id]');
    await evaluate("(async()=>{const page=await import('/replay.js'),state=await import('/replay-library-state.js');window.__heartbeatTicks=0;window.__heartbeatPage=await page.mountReplayLibrary({heartbeatFactory:options=>state.startReplayHeartbeat({...options,setInterval:(fn,ms)=>{if(ms!==30000)throw Error('bad heartbeat cadence');return window.setInterval(()=>{window.__heartbeatTicks++;void fn();},100);}})});})()");
    await browser(['wait','4500']);assert.equal((await inspectStudyService(heartbeatStore)).status,'running');
    assert.ok(await evaluate('window.__heartbeatTicks')>5);
    await evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'})");
    await browser(['wait','4500']);assert.equal((await inspectStudyService(heartbeatStore)).status,'stopped');
    await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))");
    const ticks=await evaluate('window.__heartbeatTicks');await browser(['wait','300']);assert.equal(await evaluate('window.__heartbeatTicks'),ticks);
    checks.push('heartbeat-idle-pagehide');
    const errors=await browser(['errors']);assert.deepEqual(errors?.errors??[],[]);checks.push('no-uncaught-errors');
    assert.deepEqual(sourceSnapshot(storeDir),before);checks.push('source-immutable');
  } catch(error) { failure=error; }
  finally {
    const cleanups=[];
    if(started)cleanups.push(()=>browser(['close']));
    if(old)cleanups.push(()=>old.close());
    if(heartbeatStudy)cleanups.push(async()=>{if((await inspectStudyService(heartbeatStore)).status==='running')await stopStudyService(heartbeatStore,{expectedInstanceId:heartbeatStudy.instanceId});});
    if(study)cleanups.push(()=>stopStudyService(storeDir,{expectedInstanceId:study.instanceId}));
    cleanups.push(()=>workspace.close());
    let cleanupFailed=false;
    for(const cleanup of cleanups)try{await cleanup();}catch(error){cleanupFailed=true;failure??=error;}
    if(!cleanupFailed)checks.push('owned-cleanup');
    fs.writeFileSync(path.join(outDir,'replay-journey.json'),JSON.stringify({pass:!failure,checks,pending:requiredJourneyChecks.filter(name=>!checks.includes(name)),commands,error:failure?sanitize(failure.stack):null},null,2)+'\n');
  }
  finishJourney({ required: requiredJourneyChecks, recorded: checks, failure });
}
const direct=process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct && !browserCliEnabled()) console.log('BROWSER_CLI_DISABLED_UNDER_NODE_TEST_CONTEXT');
else if(direct && !selfTestJourney(requiredJourneyChecks)) {
  const i=process.argv.indexOf('--out-dir');await runReplayJourney(i>=0?process.argv[i+1]:'output/playwright/ui-journey/replay-library');
  console.log('REPLAY_LIBRARY_JOURNEY_PASS');
}
