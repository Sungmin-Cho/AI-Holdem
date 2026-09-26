import { finishJourney, selfTestJourney } from './journey-exit.mjs';
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
import {handRecordFixture,writeSecurityFixtures,defaultPlayers} from '../helpers/security-fixtures.js';
import {createBrowserWorkspace,runOwnedCommand,hashTree} from '../helpers/learning-browser-fixture.mjs';

export const requiredJourneyChecks=['assets','bb-toggle','historical-bb','replay-arrival-focus','replay-fallback','replay-visual','replay-keyboard','replay-list-toggle','replay-mobile-sheet','replay-close-stops','replay-timeline-scroll','replay-crowded-layout','real-settlement','final-overlay-immediate','final-overlay-finalizing-reload','final-overlay-review-after-disconnect','final-overlay-terminal','hand-result-banner','hand-result-survives-side-frames','hand-result-reconnect','runout-staged','last-action-badge','cash-reset','pot-recovery','invalid-input','clamp-confirmation','chip-payload','elimination','pot-total','keyboard-dialog','reading','responsive','short-viewport','mobile-action-bar-sticky','desktop-viewport-fit','very-short-desktop','desktop-log-follow','log-hand-fold','motion-decoration','award-motion','turn-layout-stability','bet-owner-spacing','blind-and-bet-markers','large-values','reload','owned-cleanup'];
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
    const response=await fetch(`http://127.0.0.1:${relay.port}/api/publish`,{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify({token,publishId:++publishId,view,events,...extra})});
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
    // An engine-settled heads-up hand (same seats as the fixture) for the visual replayer.
    let settledState=createGame({aiCount:1,startStack:5000,levelEvery:10});settledState.handNo=2;
    settledState=startHand(settledState,{deck:fixedDeck()}).state;
    while(!legalFor(settledState).handOver){const legal=legalFor(settledState);const raise=legal.canCheck&&legal.street==='turn'&&legal.canRaise;
      settledState=applyAction(settledState,legal.toAct,raise?'raise':legal.canCheck?'check':'call',raise?legal.minRaiseTo:undefined).state;}
    const settledHand=settledState.lastHand;
    // A nine-handed engine hand for the crowded replayer layout.
    let fullState=createGame({aiCount:8,startStack:5000,levelEvery:10});fullState.handNo=3;
    fullState=startHand(fullState,{deck:fixedDeck()}).state;
    while(!legalFor(fullState).handOver){const legal=legalFor(fullState);fullState=applyAction(fullState,legal.toAct,legal.canCheck?'check':'call').state;}
    const fullHand=fullState.lastHand;
    // A six-handed hand: two seats per side on a short desktop viewport.
    let sixState=createGame({aiCount:5,startStack:5000,levelEvery:10});sixState.handNo=4;
    sixState=startHand(sixState,{deck:fixedDeck()}).state;
    while(!legalFor(sixState).handOver){const legal=legalFor(sixState);const raise=legal.canRaise&&legal.street==='flop'&&legal.canCheck;
      sixState=applyAction(sixState,legal.toAct,raise?'raise':legal.canCheck?'check':'call',raise?legal.minRaiseTo:undefined).state;}
    const sixHand=sixState.lastHand;
    const fixturePlayers=[...defaultPlayers(),...['p2','p3','p4','p5','p6','p7','p8'].map(playerId=>({...defaultPlayers()[1],playerId}))];
    writeSecurityFixtures(workspace.root,{players:fixturePlayers,hands:[historical,handRecordFixture(2),settledHand,fullHand,sixHand],config:{replayReveal:'all'},state:{sessionToken:token}});
    relay=await startServer({gameDir:workspace.root,port:0,token});
    const origin=`http://127.0.0.1:${relay.port}`;
    for(const asset of ['design-tokens.css','ui-base.css','table.css','theme-boot.js','card-render.js','shell-embed.js','motion.js','chip-format.js','seat-format.js','amount-editor.js','dialog-controller.js','hand-result.js','replay-model.js','replayer.js'])assert.equal((await fetch(`${origin}/${asset}`)).status,200);
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
        const markers=await evaluate(`(()=>{const visible=n=>!!n&&n.getClientRects().length>0&&getComputedStyle(n).display!=='none';return ${JSON.stringify(state.hand.posts)}.map(post=>{const seat=document.querySelector('.seat[data-player-id="'+post.playerId+'"]'),badge=seat.querySelector('.dealer-btn'),bet=document.querySelector('.bet-marker[data-player-id="'+post.playerId+'"]');return {role:badge?.textContent,betVisible:visible(bet)||visible(seat.querySelector('.seat-bet'))}})})()`);
        assert.equal(markers[0].role,count===2?'D/SB':'SB');
        assert.equal(markers[1].role,'BB');
        assert.ok(markers.every(m=>m.betVisible),JSON.stringify({count,width,markers}));
        measurements.push({count,...metrics});
        await browser(['screenshot',path.join(outDir,`table-${count}-${width}.png`)]);
        assert.ok(metrics.scroll<=width,`horizontal overflow ${count}/${width}: ${metrics.scroll}`);
        assert.equal(metrics.plates.length,count);assert.deepEqual(metrics.overlaps,[],`seat overlap ${count}/${width}`);
        assert.ok(metrics.plates.every(p=>p.size>=12),`stack font ${count}/${width}`);
        if(count>2) assert.ok(metrics.plates[1].x<metrics.plates.at(-1).x,`seat order ${count}/${width}`);
      }
    }
    checks.push('responsive');
    checks.push('blind-and-bet-markers');
    await browser(['set','viewport','1094','500']);await browser(['snapshot','-i']);
    const veryShort=await evaluate(`(()=>{const plates=[...document.querySelectorAll('.plate')].map(n=>n.getBoundingClientRect());return {overflow:getComputedStyle(document.body).overflowY,width:document.documentElement.scrollWidth,overlap:plates.some((a,i)=>plates.slice(i+1).some(b=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1))}})()`);
    assert.notEqual(veryShort.overflow,'hidden');
    assert.equal(veryShort.overlap,false,JSON.stringify(veryShort));
    assert.ok(veryShort.width<=1094,JSON.stringify(veryShort));
    checks.push('very-short-desktop');
    // Include the user's short desktop frame (outer lobby header already removed).
    for (const [width,height] of [[1094,559],[1440,720],[1280,640]]) {
      await browser(['set','viewport',String(width),String(height)]);
      await browser(['snapshot','-i']);
      const fit=await evaluate(`(()=>{const body=document.body,a=document.querySelector('#action-bar').getBoundingClientRect(),plates=[...document.querySelectorAll('.plate')].map(n=>n.getBoundingClientRect());return {height:innerHeight,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scroll:body.scrollHeight,bottom:a.bottom,top:a.top,plates:plates.every(r=>r.top>=0&&r.bottom<=a.top),overlap:plates.some((r,i)=>plates.slice(i+1).some(s=>r.left<s.right-1&&r.right>s.left+1&&r.top<s.bottom-1&&r.bottom>s.top+1))}})()`);
      assert.ok(fit.scroll<=height+1,JSON.stringify({width,height,fit}));
      assert.ok(fit.scrollWidth<=width+1,JSON.stringify(fit));
      assert.ok(fit.bottom<=height&&fit.top>=0,JSON.stringify(fit));
      assert.equal(fit.plates,true,JSON.stringify(fit));
      assert.equal(fit.overlap,false,JSON.stringify(fit));
      const spacing=await evaluate(`(()=>{const shapes=[...document.querySelectorAll('.seat .plate,.seat .card,.seat .dealer-btn')].filter(n=>n.getClientRects().length).map(n=>({player:n.closest('.seat').dataset.playerId,kind:n.className,...n.getBoundingClientRect().toJSON()}));let minGap=Infinity,closest=null;for(let i=0;i<shapes.length;i++)for(let j=i+1;j<shapes.length;j++){const a=shapes[i],b=shapes[j];if(a.player!==b.player){const gap=Math.hypot(Math.max(a.left-b.right,b.left-a.right,0),Math.max(a.top-b.bottom,b.top-a.bottom,0));if(gap<minGap){minGap=gap;closest=[a,b];}}}const hero=document.querySelector('.seat.is-hero'),cards=[...hero.querySelectorAll('.card--hero')].map(n=>n.getBoundingClientRect());return {minGap,closest,cardToPlate:hero.querySelector('.plate').getBoundingClientRect().top-Math.max(...cards.map(r=>r.bottom))}})()`);
      assert.ok(spacing.minGap>=8,JSON.stringify({width,height,spacing}));
      assert.ok(spacing.cardToPlate>=8,JSON.stringify({width,height,spacing}));
      await browser(['screenshot',path.join(outDir,`desktop-fit-${width}-${height}.png`)]);
    }
    const classic=await evaluate(`(()=>{const t=document.querySelector('.table').getBoundingClientRect(),cards=[...document.querySelectorAll('.card--hero')].map(n=>({width:n.offsetWidth,height:n.offsetHeight,rank:parseFloat(getComputedStyle(n.querySelector('.card-rank')).fontSize)}));return {ratio:t.width/t.height,cards}})()`);
    assert.ok(Math.abs(classic.ratio-1.83)<0.01,JSON.stringify(classic));
    assert.equal(classic.cards.length,2);
    assert.ok(classic.cards.every(c=>c.width>=56&&c.width<=64&&c.height>=80&&c.height<=90&&c.rank>=22),JSON.stringify(classic));
    checks.push('desktop-viewport-fit');
    // Desktop log scrolling must use the same element as paintLog and log-new.
    await click('#tab-log');
    await evaluate("const n=document.querySelector('#log-list');n.scrollTop=n.scrollHeight");
    await publish(Array.from({length:60},(_,i)=>({type:'narration',text:`Desktop reading fixture ${i}`})));
    const logPosition=()=>evaluate("(()=>{const n=document.querySelector('#log-list');return {top:n.scrollTop,remaining:n.scrollHeight-n.clientHeight-n.scrollTop}})()");
    assert.ok((await logPosition()).remaining<2,'desktop log should follow new events');
    await evaluate("document.querySelector('#log-list').scrollTop=0");
    await publish([{type:'narration',text:'Desktop unread event'}]);
    assert.equal((await logPosition()).top,0,'desktop reading position preserved');
    assert.equal(await evaluate("document.querySelector('#log-new').hidden"),false);
    await click('#log-new');
    assert.ok((await logPosition()).remaining<2,'latest event button scrolls the visible log');
    await publish([{type:'narration',text:'Desktop follow event'}]);
    assert.ok((await logPosition()).remaining<2,'desktop log keeps following');
    checks.push('desktop-log-follow');

    const ownView=view;
    let turnState=createGame({aiCount:8});turnState.button=5;
    turnState=startHand(turnState,{deck:fixedDeck()}).state;
    const opponentView=userView(applyAction(turnState,'user','call').state);
    const tableRect=()=>evaluate("document.querySelector('.table').getBoundingClientRect().toJSON()");
    for(const [width,height] of [[1094,559],[1280,640],[1440,720]]) {
      await browser(['set','viewport',String(width),String(height)]);
      view=ownView;await publish();await browser(['snapshot','-i']);
      const before=await tableRect();
      view=opponentView;await publish();await browser(['snapshot','-i']);
      const during=await tableRect();
      assert.equal(await evaluate("document.querySelector('#action-bar').hidden"),true);
      for(const field of ['x','y','width','height'])assert.ok(Math.abs(before[field]-during[field])<1,JSON.stringify({width,height,before,during}));
      view=ownView;await publish();await browser(['snapshot','-i']);
      const after=await tableRect();
      for(const field of ['x','y','width','height'])assert.ok(Math.abs(before[field]-after[field])<1);
    }
    checks.push('turn-layout-stability');
    // Presentation stress: every seat has committed chips at once.
    view={...ownView,seats:ownView.seats.map(seat=>({...seat,bet:125}))};await publish();
    for(const [width,height] of [[1094,559],[1440,900]]) {
      await browser(['set','viewport',String(width),String(height)]);await browser(['snapshot','-i']);
      const bets=await evaluate(`(()=>{const visible=n=>n.getClientRects().length&&getComputedStyle(n).display!=='none',targets=[...document.querySelectorAll('.plate,.seat .card,#board .card,#pots')].filter(visible),overlaps=[],gaps=[];for(const m of [...document.querySelectorAll('.bet-marker')].filter(visible)){const a=m.getBoundingClientRect(),plate=m.closest('.plate'),p=plate.getBoundingClientRect();gaps.push(Math.hypot(Math.max(a.left-p.right,p.left-a.right,0),Math.max(a.top-p.bottom,p.top-a.bottom,0)));for(const n of targets){if(n===plate)continue;const b=n.getBoundingClientRect();if(a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1)overlaps.push({player:m.dataset.playerId,target:n.className,targetPlayer:n.closest('.seat')?.dataset.playerId,marker:a.toJSON(),targetRect:b.toJSON()});}}return {gaps,overlaps}})()`);
      assert.equal(bets.gaps.length,ownView.seats.length,'every betting seat, the viewer included, shows one marker');
      assert.ok(bets.gaps.every(gap=>gap>=4&&gap<=9),JSON.stringify(bets));
      assert.deepEqual(bets.overlaps,[],JSON.stringify({width,height,bets}));
      await browser(['screenshot',path.join(outDir,`bet-spacing-${width}-${height}.png`)]);
    }
    view=ownView;await publish();checks.push('bet-owner-spacing');
    await browser(['set','viewport','390','667']);await browser(['snapshot','-i']);
    for (const position of ['top', 'bottom']) {
      await evaluate(position === 'top' ? 'scrollTo(0,0)' : "document.querySelector('#action-bar').scrollIntoView({block:'end'})");
      const sticky=await evaluate(`(()=>{const a=document.querySelector('#action-bar'),r=a.getBoundingClientRect();return {position:getComputedStyle(a).position,hidden:a.hidden,barHeight:r.height,bottom:r.bottom,top:r.top,height:innerHeight,plates:[...document.querySelectorAll('.seat .plate')].every(n=>{const p=n.getBoundingClientRect();return p.bottom<=r.top||p.top>=r.bottom;}),controls:[...a.querySelectorAll('button')].filter(n=>n.getClientRects().length).every(n=>n.getBoundingClientRect().height>=44)}})()`);
      assert.equal(sticky.hidden,false,JSON.stringify({position,sticky}));
      assert.ok(sticky.barHeight>0,JSON.stringify({position,sticky}));
      assert.equal(sticky.position,'sticky');assert.ok(sticky.bottom<=sticky.height+1,JSON.stringify({position,sticky}));
      assert.ok(sticky.top>=0,JSON.stringify({position,sticky}));assert.equal(sticky.plates,true,JSON.stringify({position,sticky}));
      assert.equal(sticky.controls,true,JSON.stringify({position,sticky}));
      await browser(['screenshot',path.join(outDir,`mobile-sticky-${position}.png`)]);
    }
    checks.push('mobile-action-bar-sticky');

    await evaluate("window.actionBodies=[];window.originalFetch=window.fetch;window.fetch=(url,options)=>{if(url==='/api/action'&&options?.body)window.actionBodies.push(JSON.parse(options.body));return window.originalFetch(url,options);}");
    assert.match(await evaluate("document.querySelector('#pots').textContent"),/1.5 BB/);checks.push('pot-total');
    await click('#action-options-toggle');
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
    assert.equal(await evaluate("document.querySelector('.seat[data-player-id=p1]').classList.contains('is-out')"),true);
    assert.equal(await evaluate("document.querySelectorAll('[data-player-id=p1] .card--back').length"),0);checks.push('elimination');
    await evaluate("document.querySelector('[data-player-id=p1] .plate').scrollIntoView({block:'center'})");
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
    assert.equal(await evaluate("document.querySelector('.seat[data-player-id=p1]').classList.contains('is-out')"),true);checks.push('reload');
    // Motion is decoration over the final DOM: the reduce setting creates nothing, a live bet
    // pops its marker, a street change flies chips to the pot, and nothing lingers after 300ms.
    const mover=view.seats.find(s=>s.playerId!=='user'&&!s.out).playerId;
    const bumped={...view,seats:view.seats.map(s=>s.playerId===mover?{...s,bet:s.bet+view.blinds[1]}:s)};
    await evaluate("window.__motion=[];window.__animate=Element.prototype.animate;Element.prototype.animate=function(...args){window.__motion.push(this.className);return window.__animate.apply(this,args);}");
    await evaluate("document.documentElement.dataset.motion='reduce'");
    await publish([],{view:bumped});
    await browser(['wait','--fn',`[...document.querySelectorAll('.bet-marker')].some(n=>n.dataset.playerId===${JSON.stringify(mover)}&&n.textContent.includes(${JSON.stringify(String((bumped.seats.find(s=>s.playerId===mover).bet)/view.blinds[1]))}))`]);
    assert.deepEqual(await evaluate('window.__motion'),[],'reduced motion creates no animation');
    await publish([],{view});
    await evaluate("delete document.documentElement.dataset.motion;window.__motion=[]");
    await publish([],{view:bumped});
    await browser(['wait','--fn','window.__motion.includes("bet-marker")']);
    await publish([],{view:{...bumped,street:'flop',seats:bumped.seats.map(s=>({...s,bet:0}))}});
    await browser(['wait','--fn','window.__motion.includes("motion-chip")']);
    await browser(['wait','400']);
    assert.deepEqual(await evaluate("({animations:document.getAnimations().filter(a=>a.effect?.target?.closest?.('#table')).length,chips:document.querySelectorAll('.motion-chip').length})"),{animations:0,chips:0});
    await evaluate("Element.prototype.animate=window.__animate");
    await publish([],{view});await ready();
    checks.push('motion-decoration');
    await evaluate("window.actionBodies=[];window.originalFetch=window.fetch;window.fetch=(url,options)=>{if(url==='/api/action'&&options?.body)window.actionBodies.push(JSON.parse(options.body));return window.originalFetch(url,options);}");
    await click('#action-options-toggle');
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
    // A display fixture (posts: []) cannot be rebuilt: an explained text list, no drawing.
    assert.equal(await evaluate("!!document.querySelector('#replay-body .replay-fallback')&&!document.querySelector('#replay-body .replayer')&&!!document.querySelector('#replay-body .replay-list .replay-row')"),true);checks.push('replay-fallback');
    await browser(['press','Escape']);
    const historyAmounts=await evaluate("[...document.querySelectorAll('#log-list .log-amount')].slice(-2).map(n=>n.textContent)");
    assert.match(historyAmounts[0],/2.5 BB/);assert.match(historyAmounts[1],/1.25 BB/);checks.push('historical-bb');
    // Hand 2 started, so hand 1 folds to its divider; the toggle reopens it.
    const folded=await evaluate("(()=>{const heads=[...document.querySelectorAll('#log-list .log-divider.is-past')];return {heads:heads.length,expanded:heads.map(n=>n.querySelector('.log-hand-toggle')?.getAttribute('aria-expanded')),summary:heads.at(-1)?.querySelector('.log-hand-summary')?.textContent,hidden:document.querySelectorAll('#log-list > .is-collapsed').length,latest:[...document.querySelectorAll('#log-list .log-divider')].at(-1).classList.contains('is-past')}})()");
    assert.ok(folded.heads>0&&folded.expanded.every(value=>value==='false')&&folded.hidden>0&&folded.latest===false,JSON.stringify(folded));
    assert.equal(folded.summary,'결과 기록 없음');
    await evaluate("[...document.querySelectorAll('#log-list .log-hand-toggle')].at(-1).click()");
    assert.equal(await evaluate("[...document.querySelectorAll('#log-list .log-hand-toggle')].at(-1).getAttribute('aria-expanded')"),'true');
    assert.ok(await evaluate("document.querySelectorAll('#log-list > .is-collapsed').length")<folded.hidden);
    checks.push('log-hand-fold');
    // The engine-settled hand draws the visual replayer (design §10.1).
    const beforeViewport=await evaluate('[innerWidth,innerHeight]');
    await publish([{type:'hand_start',handNo:3,blinds:settledHand.blinds}],{handReplay:{handNos:[3]}});
    await browser(['set','viewport','1280','800']);
    await evaluate("[...document.querySelectorAll('#log-list .replay-open')].at(-1).click()");
    await browser(['wait','#replay-body .replayer']);
    const visual=await evaluate("(()=>({steps:document.querySelectorAll('.replayer-jump').length,seats:document.querySelectorAll('.replayer-seat').length,hero:document.querySelector('.replayer-seat')?.dataset.playerId,progress:document.querySelector('.replayer-progress').textContent,amount:!!document.querySelector('.replayer-timeline .replay-amount'),fallback:!!document.querySelector('.replay-fallback'),backs:document.querySelectorAll('.replayer-seat .card--back').length}))()");
    assert.ok(visual.steps>=6&&visual.seats===2&&visual.hero==='user'&&visual.progress===`1 / ${visual.steps}`&&visual.amount&&!visual.fallback&&visual.backs===0,JSON.stringify(visual));
    await browser(['screenshot',path.join(outDir,'replayer-1280.png')]);
    checks.push('replay-visual');
    await evaluate("document.querySelector('.replayer-next').focus()");
    await browser(['press','ArrowRight']);await browser(['press','ArrowRight']);
    assert.equal(await evaluate("document.querySelector('.replayer-progress').textContent"),`3 / ${visual.steps}`);
    await browser(['press','End']);
    const ended=await evaluate("({progress:document.querySelector('.replayer-progress').textContent,title:document.querySelector('.replayer-now-title').textContent,winners:document.querySelectorAll('.replayer-seat.is-winner').length,next:document.querySelector('.replayer-next').disabled,inDialog:document.querySelector('#replay-overlay').contains(document.activeElement)})");
    assert.ok(ended.progress===`${visual.steps} / ${visual.steps}`&&ended.title==='결과'&&ended.winners>0&&ended.next&&ended.inDialog,JSON.stringify(ended));
    await browser(['press','Home']);
    assert.equal(await evaluate("document.querySelector('.replayer-progress').textContent"),`1 / ${visual.steps}`);
    await evaluate("document.querySelector('.replayer-play').click()");
    assert.equal(await evaluate("document.querySelector('.replayer-play').textContent"),'일시정지');
    assert.equal(await evaluate("document.querySelector('.replayer-now-title').getAttribute('aria-live')"),'off','autoplay does not queue announcements');
    await browser(['wait','--fn',"document.querySelector('.replayer-progress').textContent.startsWith('2 /')"]);
    await evaluate("document.querySelector('.replayer-play').click()");
    assert.equal(await evaluate("document.querySelector('.replayer-play').textContent"),'재생');
    // Space plays and pauses when no control has focus.
    await evaluate("document.activeElement.blur()");await browser(['press','Space']);
    assert.equal(await evaluate("document.querySelector('.replayer-play').textContent"),'일시정지');
    await browser(['press','Space']);
    assert.equal(await evaluate("document.querySelector('.replayer-play').textContent"),'재생');
    checks.push('replay-keyboard');
    // The timeline keeps its own scroll position when the replay is rebuilt (unit change).
    await evaluate("document.querySelector('.replayer-timeline').scrollTop=60");
    const timelineBefore=await evaluate("document.querySelector('.replayer-timeline').scrollTop");
    assert.ok(timelineBefore>0,'the timeline scrolls on its own');
    await browser(['select','#display-unit','chips']);
    assert.equal(await evaluate("document.querySelector('.replayer-timeline').scrollTop"),timelineBefore);
    await browser(['select','#display-unit','bb']);
    checks.push('replay-timeline-scroll');
    await evaluate("document.querySelector('.replayer-list-toggle').focus()");await browser(['press','Enter']);
    const listed=await evaluate("({rows:document.querySelectorAll('.replay-list .replay-row').length,expanded:document.querySelector('.replayer-list-toggle').getAttribute('aria-expanded'),focus:document.activeElement?.classList.contains('replayer-list-toggle')})");
    assert.ok(listed.rows>0&&listed.expanded==='true'&&listed.focus,JSON.stringify(listed));
    checks.push('replay-list-toggle');
    await browser(['set','viewport','390','844']);
    const sheet=await evaluate("(()=>{const r=document.querySelector('.replay-card').getBoundingClientRect();const low=[...document.querySelectorAll('.replayer-controls .btn,.replayer-speed select,.replayer-jump')].map(n=>Math.round(n.getBoundingClientRect().height)).filter(h=>h<44);return {w:Math.round(r.width),h:Math.round(r.height),fits:document.documentElement.scrollWidth<=innerWidth,low}})()");
    assert.ok(sheet.w===390&&sheet.h===844&&sheet.fits&&sheet.low.length===0,JSON.stringify(sheet));
    await browser(['screenshot',path.join(outDir,'replayer-390.png')]);
    checks.push('replay-mobile-sheet');
    // Closing while playing stops the timer; reopening starts from the first step.
    await evaluate("document.querySelector('.replayer-play').click()");
    await browser(['press','Escape']);
    await browser(['wait','1800']);
    await evaluate("[...document.querySelectorAll('#log-list .replay-open')].at(-1).click()");
    await browser(['wait','#replay-body .replayer']);
    const reopened=await evaluate("({progress:document.querySelector('.replayer-progress').textContent,play:document.querySelector('.replayer-play').textContent})");
    await browser(['wait','1600']);
    assert.ok(reopened.progress.startsWith('1 /')&&reopened.play==='재생'&&(await evaluate("document.querySelector('.replayer-progress').textContent")).startsWith('1 /'),JSON.stringify(reopened));
    await browser(['press','Escape']);
    checks.push('replay-close-stops');
    // Nine seats with long names, and six seats on a short desktop: at every
    // step (tags and bet pills included) no two seats overlap or leave the stage.
    // (Later checks publish their own views; the closed decision of the earlier
    // view is never re-opened, which the receipt store would refuse.)
    const longNames=(seats)=>seats.map(seat=>({...seat,name:'매우 긴 플레이어 이름 접근성 확인'}));
    const layoutAtEveryStep="(()=>{const measure=()=>{const r=[...document.querySelectorAll('.replayer-seat')].map(n=>n.getBoundingClientRect());let hits=0;r.forEach((a,i)=>r.slice(i+1).forEach(b=>{if(a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1)hits++;}));const stage=document.querySelector('.replayer-stage').getBoundingClientRect();return hits+100*r.filter(x=>x.left<stage.left-1||x.right>stage.right+1).length;};const steps=document.querySelectorAll('.replayer-jump').length;let worst=0,at=-1;for(let i=0;i<steps;i++){if(i)document.querySelector('.replayer-next').click();const v=measure();if(v>worst){worst=v;at=i;}}return {seats:document.querySelectorAll('.replayer-seat').length,worst,at,steps,board:Math.round(document.querySelector('.replayer-board .card').getBoundingClientRect().width),fits:document.documentElement.scrollWidth<=innerWidth};})()";
    view={...userView(fullState),seats:longNames(userView(fullState).seats)};
    await publish([{type:'hand_start',handNo:4,blinds:fullHand.blinds},{type:'hand_start',handNo:5,blinds:sixHand.blinds}],{handReplay:{handNos:[4,5]}});
    for(const [w,h,board] of [[390,844,24],[1280,800,32]]) {
      await browser(['set','viewport',String(w),String(h)]);
      await evaluate("[...document.querySelectorAll('#log-list .replay-open')].at(-2).click()");
      await browser(['wait','#replay-body .replayer.is-crowded']);
      const crowd=await evaluate(layoutAtEveryStep);
      assert.ok(crowd.seats===9&&crowd.worst===0&&crowd.board===board&&crowd.fits,`${w}x${h} ${JSON.stringify(crowd)}`);
      await browser(['screenshot',path.join(outDir,`replayer-9-${w}.png`)]);
      await browser(['press','Escape']);
    }
    view={...userView(sixState),seats:longNames(userView(sixState).seats)};await publish();
    await browser(['set','viewport','1366','640']);
    await evaluate("[...document.querySelectorAll('#log-list .replay-open')].at(-1).click()");
    await browser(['wait','#replay-body .replayer']);
    const six=await evaluate(layoutAtEveryStep);
    assert.ok(six.seats===6&&six.worst===0&&six.fits,`1366x640 ${JSON.stringify(six)}`);
    await browser(['screenshot',path.join(outDir,'replayer-6-1366x640.png')]);
    await browser(['press','Escape']);
    checks.push('replay-crowded-layout');
    await browser(['set','viewport',String(beforeViewport[0]),String(beforeViewport[1])]);
    view={...view,seats:view.seats.map(s=>({...s,name:'매우 긴 플레이어 이름 접근성 확인',stack:9007199254740991}))};await publish();
    for(const unit of ['chips','bb']) {
      await browser(['select','#display-unit',unit]);
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    }
    await evaluate("document.body.style.zoom='2'");
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await browser(['screenshot',path.join(outDir,'large-values-zoom.png')]);
    await evaluate("document.body.style.zoom='1'");checks.push('large-values');
    let settlement=createGame({aiCount:2,startStack:100});settlement.button=2;settlement.handNo=2;
    const prefix=['7s','2c','As','8s','3d','Ah','Ks','Kd','Kh','9c','6d'];
    const deal=startHand(settlement,{deck:[...prefix,...newDeck().filter(c=>!prefix.includes(c))]});settlement=deal.state;
    view=userView(settlement);await publish(deal.events);
    const allIn=applyAction(settlement,'user','raise',100);settlement=allIn.state;view=userView(settlement);await publish(allIn.events);
    assert.equal(await evaluate("document.querySelector('.seat.is-hero').classList.contains('is-out')"),false);
    assert.match(await evaluate("document.querySelector('.seat.is-hero .plate-tag').textContent"),/올인/);
    while(!legalFor(settlement).handOver){const legal=legalFor(settlement);const step=applyAction(settlement,legal.toAct,legal.canCheck?'check':'call');settlement=step.state;view=userView(settlement);await publish(step.events);}
    const eliminated=view.seats.filter(s=>s.out).length;assert.equal(eliminated,2);
    assert.equal(await evaluate("document.querySelector('#review-overlay').hidden"),false);
    assert.equal(await evaluate("document.querySelector('#final-last-hand').hidden"),false);
    checks.push('final-overlay-immediate');
    await click('#review-close');
    assert.equal(await evaluate("document.querySelectorAll('.seat.is-out').length"),eliminated);
    assert.equal(await evaluate("document.querySelectorAll('.seat.is-out .card--back,.seat.is-out .dealer-btn,.seat.is-out.is-to-act').length"),0);
    assert.match(await evaluate("document.querySelector('#seat-announcement').textContent"),/탈락/);
    await browser(['reload']);await browser(['wait','.seat.is-out']);
    assert.equal(await evaluate("document.querySelector('#review-overlay').hidden"),false);
    assert.match(await evaluate("document.querySelector('#review-body').textContent"),/종합 리뷰 생성 중/);
    checks.push('final-overlay-finalizing-reload');
    assert.equal(await evaluate("document.querySelectorAll('.seat.is-out').length"),eliminated);
    assert.equal(await evaluate("document.querySelector('#seat-announcement').textContent"),'');checks.push('real-settlement');
    await click('#review-close');
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
    // Close the real relay connection, publish the review before reconnect, and
    // require the persisted snapshot to restore the missed review frame.
    const reconnectPort=relay.port;
    await relay.close();
    relay=await startServer({gameDir:workspace.root,port:reconnectPort,token});
    await publish([],{review:'UI review fixture'});
    await browser(['wait','--fn',"document.querySelector('#review-reopen').textContent.includes(' ·')"]);
    assert.equal(await evaluate("document.querySelector('#review-overlay').hidden"),true,'late review must not reopen dismissed final result');
    await click('#review-reopen');
    assert.equal(await evaluate("document.querySelector('#review-overlay').hidden"),false);
    assert.match(await evaluate("document.querySelector('#review-body').textContent"),/UI review fixture/);
    checks.push('final-overlay-review-after-disconnect');
    await publish([],{review:null});
    assert.equal(await evaluate("document.querySelector('#review-overlay').hidden"),false);
    assert.match(await evaluate("document.querySelector('#review-body').textContent"),/종합 리뷰 생성 중/);
    await browser(['open',`${origin}/?token=${token}&terminal=1`]);await ready();
    assert.equal(await evaluate("document.querySelector('#review-overlay').hidden"),false);
    assert.match(await evaluate("document.querySelector('#review-body').textContent"),/종합 리뷰가 없습니다/);
    checks.push('final-overlay-terminal');
    await browser(['open',`${origin}/?token=${token}`]);await ready();
    await click('#review-close');
    // This synthetic scenario shares a relay; never reuse a retired decision ID.
    let cash=createGame({mode:'cash-training',aiCount:2,startStack:5000,levelEvery:null,handLimit:102});cash.handNo=100;
    const cashDeal=startHand(cash,{deck:fixedDeck()});cash=cashDeal.state;view=userView(cash);await publish(cashDeal.events);
    while(!legalFor(cash).handOver){const legal=legalFor(cash);const step=applyAction(cash,legal.toAct,'fold');cash=step.state;view=userView(cash);await publish(step.events);}
    assert.equal(await evaluate("document.querySelector('#cash-reset-note').hidden"),false);
    assert.match(await evaluate("document.querySelector('#participants-summary').textContent"),/^참가자 3명$/);
    assert.equal(await evaluate("document.querySelectorAll('.seat.is-out,.seat .dealer-btn,.seat .is-allin,.seat .card--back').length"),0);checks.push('cash-reset');
    assert.equal(await evaluate("document.querySelector('#hand-result').hidden"),false);
    assert.match(await evaluate("document.querySelector('#hand-result').textContent"),/상대 전원 폴드/);
    // On desktop the strip sits above the board and leaves the cards and settled pot visible.
    await browser(['set','viewport','1280','800']);await browser(['snapshot','-i']);
    const strip=await evaluate("(()=>{const r=document.querySelector('#hand-result').getBoundingClientRect();return {hidden:document.querySelector('#hand-result').hidden,text:document.querySelector('#hand-result').textContent,hits:[...document.querySelectorAll('#board .card, #pots, .seat .plate')].filter(n=>{const b=n.getBoundingClientRect();return b.width&&r.left<b.right-1&&r.right>b.left+1&&r.top<b.bottom-1&&r.bottom>b.top+1;}).map(n=>n.id||n.className)}})()");
    assert.equal(strip.hidden,false);assert.deepEqual(strip.hits,[],JSON.stringify(strip));
    const winnerLines=await evaluate("[...document.querySelectorAll('#hand-result .hand-result-winner')].map(n=>n.textContent)");
    assert.ok(winnerLines.length>0&&winnerLines.every(line=>/팟 .+ 획득/.test(line)&&!/\+\d/.test(line)),`a winner line is the pot collected, never a signed profit: ${JSON.stringify(winnerLines)}`);
    await browser(['screenshot',path.join(outDir,'hand-result-1280.png')]);
    await browser(['set','viewport','390','667']);await browser(['snapshot','-i']);
    checks.push('hand-result-banner');
    assert.ok(await evaluate("document.querySelectorAll('.plate-action').length>0"));
    checks.push('last-action-badge');
    await evaluate("window.__resultNode=document.querySelector('#hand-result').firstChild");
    await publish([],{view:undefined});
    assert.equal(await evaluate("window.__resultNode===document.querySelector('#hand-result').firstChild"),true);
    checks.push('hand-result-survives-side-frames');
    // A held hand without a runout plays pot → winner once; the same paint's
    // motion.play() (which ends running motion) must not cancel it, and neither
    // may the action controller's reconcile read of that same revision — heads-up
    // with the user first to act, so the user's own fold ends the hand and the
    // decision leaving the view triggers that read at once.
    await evaluate("window.__motion=[];window.__cancelled=[];window.__animate=Element.prototype.animate;Element.prototype.animate=function(...args){const a=window.__animate.apply(this,args),target=this,cancel=a.cancel.bind(a);window.__motion.push(String(target.getAttribute('class')));a.cancel=()=>{window.__cancelled.push(String(target.getAttribute('class')));cancel();};return a;}");
    let award=createGame({mode:'cash-training',aiCount:1,startStack:5000,levelEvery:null,handLimit:152});award.handNo=150;award.button=1;
    const awardDeal=startHand(award,{deck:fixedDeck()});award=awardDeal.state;view=userView(award);await publish(awardDeal.events);
    assert.equal(legalFor(award).toAct,'user');
    await browser(['wait','--fn',"document.querySelector('#btn-fold')?.disabled===false"]);
    const awardStep=applyAction(award,'user','fold');award=awardStep.state;view=userView(award);assert.equal(legalFor(award).handOver,true);
    const awardEvents=awardStep.events;
    const awardAt=Date.now();
    await publish(awardEvents,{resultHold:{handNo:view.handNo,startAt:new Date(awardAt).toISOString(),until:new Date(awardAt+4000).toISOString(),runoutStepMs:0,runoutStreets:0}});
    await browser(['wait','--fn',"window.__motion.some(name=>/\\bplate\\b/.test(name))"]);
    await browser(['wait','500']);
    assert.equal(await evaluate("window.__cancelled.some(name=>/\\bplate\\b/.test(name))"),false,'the award pulse is cancelled neither by its own paint nor by the reconcile read of the same revision');
    await evaluate("Element.prototype.animate=window.__animate");
    checks.push('award-motion');
    let runout=createGame({mode:'cash-training',aiCount:2,startStack:100,levelEvery:null,handLimit:202});runout.handNo=200;
    const runoutDeal=startHand(runout,{deck:fixedDeck()});runout=runoutDeal.state;view=userView(runout);await publish(runoutDeal.events);
    await evaluate("window.__stages=[];window.__stageTimer=setInterval(()=>{const r=document.querySelector('#hand-result');window.__stages.push({cards:document.querySelectorAll('#board .card[role=img]').length,visible:!r.hidden});},50)");
    let finalEvents;
    while(!legalFor(runout).handOver){
      const legal=legalFor(runout);const action=legal.canRaise?'raise':legal.canCheck?'check':'call';
      const step=applyAction(runout,legal.toAct,action,action==='raise'?legal.maxRaiseTo:undefined);runout=step.state;view=userView(runout);
      if(legalFor(runout).handOver)finalEvents=step.events;else await publish(step.events);
    }
    const count=finalEvents.filter(row=>row.type==='street').length;assert.equal(count,3,'preflop all-in must exercise all three streets');
    const start=Date.now()+1000;
    const hold={handNo:view.handNo,startAt:new Date(start).toISOString(),until:new Date(start+25000).toISOString(),runoutStepMs:5000,runoutStreets:count};
    await publish(finalEvents,{resultHold:hold});
    await evaluate("window.__stages=[]");
    await new Promise(resolve=>setTimeout(resolve,6500));
    const beforeReload=await evaluate("clearInterval(window.__stageTimer);({stages:window.__stages,cards:document.querySelectorAll('#board .card[role=img]').length})");
    assert.equal(beforeReload.cards,3,'flop stage before reconnect');
    await browser(['reload']);await browser(['wait','#board .card[role=img]']);
    const afterReload=await evaluate("({cards:document.querySelectorAll('#board .card[role=img]').length,hidden:document.querySelector('#hand-result').hidden})");
    assert.ok(afterReload.cards>=3 && afterReload.cards<5 && afterReload.hidden,'reconnect preserves current runout position');
    checks.push('hand-result-reconnect');
    await evaluate("window.__stages=[];window.__stageTimer=setInterval(()=>window.__stages.push({cards:document.querySelectorAll('#board .card[role=img]').length,visible:!document.querySelector('#hand-result').hidden}),50)");
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,start+count*5000+750-Date.now())));
    const stages=[...beforeReload.stages,...await evaluate("clearInterval(window.__stageTimer);window.__stages")];
    assert.ok(stages.some(row=>row.cards===3&&!row.visible),JSON.stringify(stages));
    assert.ok(stages.some(row=>row.cards===4&&!row.visible),JSON.stringify(stages));
    assert.ok(stages.some(row=>row.cards===5&&row.visible),JSON.stringify(stages));
    assert.match(await evaluate("document.querySelector('.hand-result-countdown').textContent"),/다음 핸드 [0-9]+초/);
    checks.push('runout-staged');

  } catch(error) {failure=error;try{await browser(['screenshot',path.join(outDir,'failure.png')]);}catch{}}
  finally {
    const cleanupErrors=[];
    for(const cleanup of [()=>browser(['close']),()=>relay?.close(),()=>assert.equal(hashTree(protectedStore),before),()=>workspace.close()]) {
      try{await cleanup();}catch(error){cleanupErrors.push(error);}
    }
    if(cleanupErrors.length) failure=new AggregateError([...(failure?[failure]:[]),...cleanupErrors],'UI journey or cleanup failed');
    else checks.push('owned-cleanup');
    const pending=requiredJourneyChecks.filter(n=>!checks.includes(n));
    try { finishJourney({ required: requiredJourneyChecks, recorded: checks, failure }); }
    catch (error) { failure = error; }
    fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:!failure&&!pending.length,checks,pending,measurements,error:failure?.message,errors:failure instanceof AggregateError?failure.errors.map(e=>e.message):[],browser:'agent-browser@0.36.0',scope:'Real relay/public engine views; synthetic out, bet amounts and events; lifecycle covered separately by lobby journey'},null,2));

  }
  finishJourney({ required: requiredJourneyChecks, recorded: checks, failure });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!browserCliEnabled())console.log('BROWSER_CLI_DISABLED_UNDER_NODE_TEST_CONTEXT');
  else if (!selfTestJourney(requiredJourneyChecks)) {const index=process.argv.indexOf('--out-dir');await runUiJourney(path.resolve(index<0?'output/playwright/ui-journey':process.argv[index+1]),{ci:process.argv.includes('--ci')});console.log('UI presentation journey PASS');}
}
