import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startServer} from '../../server/server.js';
import {createGame,startHand,applyAction,legalFor} from '../../engine/hand.js';
import {newDeck} from '../../engine/cards.js';
import {userView} from '../../engine/views.js';
import {fixedDeck} from '../helpers/fixtures.js';
import {handRecordFixture,writeSecurityFixtures} from '../helpers/security-fixtures.js';
import {createBrowserWorkspace,runOwnedCommand,hashTree} from '../helpers/learning-browser-fixture.mjs';

export const requiredJourneyChecks=['assets','bb-toggle','historical-bb','replay-arrival-focus','real-settlement','cash-reset','pot-recovery','invalid-input','clamp-confirmation','chip-payload','elimination','pot-total','keyboard-dialog','reading','responsive','short-viewport','large-values','reload','owned-cleanup'];
export const browserCliEnabled=(env=process.env)=>!env.NODE_TEST_CONTEXT;
export async function runUiJourney(outDir,{ci=false}={}) {
  fs.mkdirSync(outDir,{recursive:true});
  const workspace=createBrowserWorkspace(),session=`ui-${randomUUID()}`,token=randomUUID();
  const checks=[],measurements=[];let relay,failure,publishId=0,view;
  const protectedStore=path.resolve('game'),before=hashTree(protectedStore);
  const browser=async(args)=>{
    const r=await runOwnedCommand('npx',['--yes','agent-browser@0.36.0','--session',session,'--json',...args],{timeoutMs:45000});
    assert.equal(r.exitCode,0,`${args[0]} failed: ${r.stderr}`);
    const result=JSON.parse(r.stdout);assert.notEqual(result.success,false,`${args[0]}: ${JSON.stringify(result).replaceAll(token,'[fixture]')}`);return result.data;
  };
  const evaluate=async(expr)=>{const value=await browser(['eval',expr]);return value?.result??value;};
  const publish=async(events=[],extra={})=>{
    const response=await fetch(`http://127.0.0.1:${relay.port}/api/publish`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,publishId:++publishId,view,events,...extra})});
    const result=await response.json();
    assert.equal(response.status,200,`publish ${publishId}: ${result.code??response.status}`);return result;
  };
  const ready=async()=>{
    for(let i=0;i<25;i++){if(await evaluate("document.querySelector('#btn-raise')?.disabled===false"))return;await new Promise(r=>setTimeout(r,100));}
    throw Error('action readiness unavailable');
  };
  const click=async(selector)=>{await browser(['snapshot','-i']);await browser(['click',selector]);};
  try {
    const historical=handRecordFixture(1,{actions:[{playerId:'user',street:'preflop',action:'raise',amount:125}]});historical.blinds=[25,50];
    writeSecurityFixtures(workspace.root,{hands:[historical,handRecordFixture(2)],config:{replayReveal:'all'},state:{sessionToken:token}});
    relay=await startServer({gameDir:workspace.root,port:0,token});
    const origin=`http://127.0.0.1:${relay.port}`;
    for(const asset of ['design-tokens.css','table-design.css','chip-format.js','seat-format.js','amount-editor.js','dialog-controller.js'])assert.equal((await fetch(`${origin}/${asset}`)).status,200);
    checks.push('assets');
    for(const count of ci?[6,9]:[2,6,8,9]) {
      let state=createGame({aiCount:count-1});state.button=count===2?1:count-4;
      const dealt=startHand(state,{deck:fixedDeck()});state=dealt.state;view=userView(state);
      assert.ok(view.legal);
      await publish(dealt.events);
      await browser(['open',`${origin}/?token=${token}`]);await ready();
      for(const width of ci?[390,1440]:[360,390,768,1024,1440]) {
        await browser(['set','viewport',String(width),'900']);await browser(['snapshot','-i']);
        const metrics=await evaluate(`(()=>{const plates=[...document.querySelectorAll('.plate')].map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,size:parseFloat(getComputedStyle(n.querySelector('.amount-primary')).fontSize)}});const overlaps=[];for(let i=0;i<plates.length;i++)for(let j=i+1;j<plates.length;j++){const a=plates[i],b=plates[j];if(a.x<b.x+b.w-1&&a.x+a.w>b.x+1&&a.y<b.y+b.h-1&&a.y+a.h>b.y+1)overlaps.push([i,j]);}return {width:innerWidth,scroll:document.documentElement.scrollWidth,plates,overlaps};})()`);
        measurements.push({count,...metrics});
        await browser(['screenshot',path.join(outDir,`table-${count}-${width}.png`)]);
        assert.ok(metrics.scroll<=width,`horizontal overflow ${count}/${width}: ${metrics.scroll}`);
        assert.equal(metrics.plates.length,count);assert.deepEqual(metrics.overlaps,[],`seat overlap ${count}/${width}`);
        assert.ok(metrics.plates.every(p=>p.size>=12),`stack font ${count}/${width}`);
        if(count>2) assert.ok(metrics.plates[1].x<metrics.plates.at(-1).x,`seat order ${count}/${width}`);
      }
    }
    checks.push('responsive');
    await browser(['set','viewport','390','667']);await browser(['snapshot','-i']);
    await evaluate("window.actionBodies=[];window.originalFetch=window.fetch;window.fetch=(url,options)=>{if(url==='/api/action'&&options?.body)window.actionBodies.push(JSON.parse(options.body));return window.originalFetch(url,options);}");
    assert.match(await evaluate("document.querySelector('#pots').textContent"),/1.5 BB/);checks.push('pot-total');
    await browser(['fill','#intent-note','fixture intention']);
    await browser(['fill','#raise-amount',String(view.legal.minRaiseTo)]);
    await browser(['fill','#raise-amount','9999999']);await browser(['press','ArrowUp']);
    assert.equal(Number((await evaluate("document.querySelector('#raise-amount').value")).replaceAll(',','')),Math.min(view.legal.minRaiseTo+view.blinds[1],view.legal.maxRaiseTo));
    for(const invalid of ['-5','1e3','1,2','','１２３']) {
      await browser(['fill','#raise-amount',invalid]);await browser(['press','Enter']);await publish();
      assert.equal(await evaluate("document.querySelector('#raise-amount').value"),invalid);
      assert.equal(await evaluate('window.actionBodies.length'),0);
    }
    await browser(['fill','#raise-amount','2.5']);await browser(['press','Tab']);await publish();
    await browser(['select','#display-unit','chips']);
    assert.equal(await evaluate("document.querySelector('#raise-amount').value"),'2.5');
    assert.equal(await evaluate("document.querySelector('#intent-note').value"),'fixture intention');
    await click('#btn-raise');
    const receipt=await fetch(`${origin}/api/action-status?token=${token}`).then(r=>r.json());
    assert.notEqual(receipt.phase,'accepted');assert.notEqual(receipt.phase,'delivered');
    assert.equal(await evaluate('window.actionBodies.length'),0);
    checks.push('invalid-input','bb-toggle');
    await browser(['fill','#raise-amount','9999999']);await browser(['press','Tab']);await click('#btn-raise');
    const first=await fetch(`${origin}/api/action-status?token=${token}`).then(r=>r.json());assert.notEqual(first.phase,'accepted');
    assert.equal(Number((await evaluate("document.querySelector('#raise-amount').value")).replaceAll(',','')),view.legal.maxRaiseTo);
    assert.equal(await evaluate('window.actionBodies.length'),0);
    checks.push('clamp-confirmation');
    assert.match(await evaluate("document.querySelector('#amount-error').textContent"),/다시 눌러 제출/);
    await publish();assert.match(await evaluate("document.querySelector('#amount-error').textContent"),/다시 눌러 제출/);
    const shortMetrics=await evaluate("(()=>{const a=document.querySelector('#action-bar'),h=document.querySelector('.seat.is-hero');a.scrollIntoView({block:'end'});const ar=a.getBoundingClientRect(),hr=h.getBoundingClientRect();return {overlap:ar.top<hr.bottom&&ar.bottom>hr.top,summary:a.querySelector('#action-summary').textContent,controls:[...a.querySelectorAll('button')].filter(n=>n.getClientRects().length).every(n=>n.getBoundingClientRect().height>=44)}})()");
    assert.equal(shortMetrics.overlap,false);assert.match(shortMetrics.summary,/내 스택.*팟.*내 카드/);assert.equal(shortMetrics.controls,true);checks.push('short-viewport');
    view={...view,seats:view.seats.map((s,i)=>i===1?{...s,out:true,stack:0}:s)};await publish();
    assert.equal(await evaluate("document.querySelector('[data-player-id=p1]').classList.contains('is-out')"),true);
    assert.equal(await evaluate("document.querySelectorAll('[data-player-id=p1] .card--back').length"),0);checks.push('elimination');
    await click('[data-player-id=p1] .plate');
    assert.equal(await evaluate("document.querySelector('#seat-overlay').hidden"),false);
    assert.equal(await evaluate("document.querySelector('main').inert"),true);
    await browser(['press','Tab']);assert.equal(await evaluate('document.activeElement.id'),'seat-close');
    await browser(['press','Shift+Tab']);assert.equal(await evaluate('document.activeElement.id'),'seat-close');
    await browser(['press','Escape']);assert.equal(await evaluate("document.activeElement.closest('[data-player-id]')?.dataset.playerId"),'p1');
    assert.equal(await evaluate("document.querySelector('main').inert"),false);
    await publish();assert.equal(await evaluate("document.activeElement.closest('[data-player-id]')?.dataset.playerId"),'p1');
    checks.push('keyboard-dialog');
    await click('#tab-log');
    await publish(Array.from({length:40},(_,i)=>({type:'narration',text:`Reading fixture ${i}`})));
    await evaluate("document.querySelector('#log-list').scrollTop=0");await publish([{type:'narration',text:'New event'}]);
    assert.equal(await evaluate("document.querySelector('#log-list').scrollTop"),0);
    assert.equal(await evaluate("document.querySelector('#log-new').hidden"),false);checks.push('reading');
    await publish([{type:'narration',text:'Second new event'}]);
    assert.match(await evaluate("document.querySelector('#log-new').textContent"),/2개/);
    await browser(['select','#display-unit','bb']);
    assert.equal(await evaluate("document.querySelector('#log-list').scrollTop"),0);
    await browser(['reload']);await ready();
    assert.equal(await evaluate("document.querySelector('[data-player-id=p1]').classList.contains('is-out')"),true);checks.push('reload');
    await evaluate("window.actionBodies=[];window.originalFetch=window.fetch;window.fetch=(url,options)=>{if(url==='/api/action'&&options?.body)window.actionBodies.push(JSON.parse(options.body));return window.originalFetch(url,options);}");
    await browser(['fill','#raise-amount','9999999']);await browser(['press','Tab']);await click('#btn-raise');
    assert.equal(await evaluate('window.actionBodies.length'),0);
    await click('#btn-raise');
    const action=await evaluate('window.actionBodies.map(({action,amount})=>({action,amount}))');
    assert.deepEqual(action,[{action:'raise',amount:view.legal.maxRaiseTo}]);checks.push('chip-payload');
    view={...view,blinds:[50,100]};
    await publish([{type:'hand_start',handNo:1,blinds:[25,50]},{type:'action',playerId:'user',action:'raise',amount:125,street:'preflop'},{type:'hand_start',handNo:2,blinds:[50,100]},{type:'action',playerId:'user',action:'raise',amount:125,street:'preflop'}],{handReplay:{handNos:[1]}});
    await click('#tab-log');
    await evaluate("[...document.querySelectorAll('#log-list .replay-open')].at(-2).focus();window.focusedReplay=document.activeElement");
    await publish([],{handReplay:{handNos:[2]}});
    assert.equal(await evaluate('document.activeElement===window.focusedReplay'),true);checks.push('replay-arrival-focus');
    await browser(['press','Enter']);
    assert.match(await evaluate("document.querySelector('#replay-body .replay-amount').textContent"),/2.5 BB/);
    await browser(['press','Escape']);
    const historyAmounts=await evaluate("[...document.querySelectorAll('#log-list .log-amount')].slice(-2).map(n=>n.textContent)");
    assert.match(historyAmounts[0],/2.5 BB/);assert.match(historyAmounts[1],/1.25 BB/);checks.push('historical-bb');
    view={...view,seats:view.seats.map(s=>({...s,name:'매우 긴 플레이어 이름 접근성 확인',stack:9007199254740991}))};await publish();
    for(const unit of ['chips','bb']) {
      await browser(['select','#display-unit',unit]);
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    }
    await evaluate("document.body.style.zoom='2'");
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await browser(['screenshot',path.join(outDir,'large-values-zoom.png')]);
    await evaluate("document.body.style.zoom='1'");checks.push('large-values');
    let settlement=createGame({aiCount:2,startStack:100});settlement.button=2;settlement.handNo=50;
    const prefix=['7s','2c','As','8s','3d','Ah','Ks','Kd','Kh','9c','6d'];
    const deal=startHand(settlement,{deck:[...prefix,...newDeck().filter(c=>!prefix.includes(c))]});settlement=deal.state;
    view=userView(settlement);await publish(deal.events);
    const allIn=applyAction(settlement,'user','raise',100);settlement=allIn.state;view=userView(settlement);await publish(allIn.events);
    assert.equal(await evaluate("document.querySelector('.seat.is-hero').classList.contains('is-out')"),false);
    assert.match(await evaluate("document.querySelector('.seat.is-hero .plate-tag').textContent"),/올인/);
    while(!legalFor(settlement).handOver){const legal=legalFor(settlement);const step=applyAction(settlement,legal.toAct,legal.canCheck?'check':'call');settlement=step.state;view=userView(settlement);await publish(step.events);}
    const eliminated=view.seats.filter(s=>s.out).length;assert.equal(eliminated,2);
    assert.equal(await evaluate("document.querySelectorAll('.seat.is-out').length"),eliminated);
    assert.equal(await evaluate("document.querySelectorAll('.seat.is-out .card--back,.seat.is-out .dealer-btn,.seat.is-out.is-to-act').length"),0);
    assert.match(await evaluate("document.querySelector('#seat-announcement').textContent"),/탈락/);
    await browser(['reload']);await browser(['wait','.seat.is-out']);
    assert.equal(await evaluate("document.querySelectorAll('.seat.is-out').length"),eliminated);
    assert.equal(await evaluate("document.querySelector('#seat-announcement').textContent"),'');checks.push('real-settlement');
    assert.equal(await evaluate("document.querySelector('#session-net').closest('.meta-seg').hidden"),true);
    const settledView=view;view={...view,pots:[]};await publish();assert.match(await evaluate("document.querySelector('#pots').textContent"),/팟 정보 없음/);
    view={...settledView,legal:{potTotal:1}};await publish();assert.match(await evaluate("document.querySelector('#pots').textContent"),/팟 정보 확인 중/);
    view=settledView;await publish();assert.match(await evaluate("document.querySelector('#pots').textContent"),/팟 합계/);checks.push('pot-recovery');
    view={...settledView,pots:[{amount:100},{amount:200}],legal:{potTotal:300}};await publish();
    await click('#pots summary');await publish();
    assert.equal(await evaluate("document.querySelector('#pots details').open && document.activeElement.matches('#pots summary')"),true);
    await evaluate("document.querySelector('#display-unit').value='chips';document.querySelector('#display-unit').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("document.querySelector('#pots details').open && document.activeElement.matches('#pots summary')"),true);
    view={...view,handNo:view.handNo+1};await publish();
    assert.equal(await evaluate("document.querySelector('#pots details').open"),false);
    await publish([],{review:'UI review fixture'});
    assert.equal(await evaluate("document.querySelector('#review-overlay').hidden"),false);
    await publish([],{review:null});
    assert.equal(await evaluate("document.querySelector('#review-overlay').hidden && !document.querySelector('main').inert"),true);
    // This synthetic scenario shares a relay; never reuse a retired decision ID.
    let cash=createGame({mode:'cash-training',aiCount:2,startStack:5000,levelEvery:null,handLimit:102});cash.handNo=100;
    const cashDeal=startHand(cash,{deck:fixedDeck()});cash=cashDeal.state;view=userView(cash);await publish(cashDeal.events);
    while(!legalFor(cash).handOver){const legal=legalFor(cash);const step=applyAction(cash,legal.toAct,'fold');cash=step.state;view=userView(cash);await publish(step.events);}
    assert.equal(await evaluate("document.querySelector('#cash-reset-note').hidden"),false);
    assert.match(await evaluate("document.querySelector('#participants-summary').textContent"),/^참가자 3명$/);
    assert.equal(await evaluate("document.querySelectorAll('.seat.is-out,.seat .dealer-btn,.seat .is-allin,.seat .card--back').length"),0);checks.push('cash-reset');
  } catch(error) {failure=error;try{await browser(['screenshot',path.join(outDir,'failure.png')]);}catch{}}
  finally {
    const cleanupErrors=[];
    for(const cleanup of [()=>browser(['close']),()=>relay?.close(),()=>assert.equal(hashTree(protectedStore),before),()=>workspace.close()]) {
      try{await cleanup();}catch(error){cleanupErrors.push(error);}
    }
    if(cleanupErrors.length) failure=new AggregateError([...(failure?[failure]:[]),...cleanupErrors],'UI journey or cleanup failed');
    else checks.push('owned-cleanup');
    const pending=requiredJourneyChecks.filter(n=>!checks.includes(n));
    fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:!failure&&!pending.length,checks,pending,measurements,error:failure?.message,errors:failure instanceof AggregateError?failure.errors.map(e=>e.message):[],browser:'agent-browser@0.36.0',scope:'Real relay/public engine views; synthetic out and events; lifecycle covered separately by lobby journey'},null,2));
    if(pending.length&&!failure)failure=Error(`Missing required checks: ${pending.join(', ')}`);
  }
  if(failure)throw failure;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!browserCliEnabled())console.log('BROWSER_CLI_DISABLED_UNDER_NODE_TEST_CONTEXT');
  else {const index=process.argv.indexOf('--out-dir');await runUiJourney(path.resolve(index<0?'output/playwright/ui-journey':process.argv[index+1]),{ci:process.argv.includes('--ci')});console.log('UI presentation journey PASS');}
}
