import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function elements(){
 const nodes=new Map(),classes=new Set();
 const make=id=>({id,hidden:false,inert:false,dataset:{},attrs:{},classList:{toggle(){}},close(){},replaceChildren(){},append(){},set src(value){this.attrs.src=value;},get src(){return this.attrs.src;},getAttribute(key){return this.attrs[key]??null;},removeAttribute(key){delete this.attrs[key];},replaceWith(node){nodes.set(this.id,node);}});
 const $=id=>{if(!nodes.has(id))nodes.set(id,make(id));return nodes.get(id);};
 return {$,classes,document:{querySelector:()=>null,createElement:()=>make(''),body:{classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}}}};
}
test('actual lobby retains the terminal document then clears record layout for a new start',()=>{
 const dom=elements(),source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 const context={...dom,URLSearchParams,snapshot:null,selecting:false,viewingRecord:false,frameId:null,busy:false,interruptBusy:false,pauseLock:null,rejoinFor:null,labels:{},errorMessages:{}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function render()'),source.indexOf('let refreshFailures=')),context);
 const render=state=>{context.snapshot={state,gameId:'one',gameEpoch:'epoch',allowedCommands:[]};context.render();};
 render('playing');const src=dom.$('table').src;assert.ok(src);assert.equal(src.includes('terminal'),false);
 for(const state of ['finalizing','completed','ended']){render(state);assert.equal(dom.$('table').src,src);assert.equal(dom.$('game').hidden,false);assert.equal(dom.$('table').inert,false);}
 render('starting');assert.equal(dom.$('game').hidden,true);assert.equal(dom.classes.has('has-game'),false);
 context.frameId=null;dom.$('table').removeAttribute('src');render('ended');assert.match(dom.$('table').src,/terminal=1/);
 context.selecting=true;render('completed');assert.equal(dom.$('game').hidden,true);assert.equal(dom.$('table').getAttribute('src'),null);
});
test('actual participant poll preserves iframe identity through stopping and ending, and creates a terminal cold document',async()=>{
 const dom=elements(),source=fs.readFileSync(new URL('../server/public/join.js',import.meta.url),'utf8');let state;
 const context={...dom,sessionStorage:{getItem:()=> 'fixture'},fetch:async()=>({ok:true,json:async()=>state}),polling:false,fails:0,latest:null,tableIdentity:null,summaryIdentity:null,finalSummary:null,finalPanelKey:null,paintFinal(){},loadSummary(){}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function poll()'),source.indexOf("$('join-form').onsubmit")),context);
 const poll=async (status,playerId='h1',roomRole='seated')=>{state={me:{roomRole,playerId,viewerGeneration:1},room:{status:'locked'},game:{state:status,gameId:'one',gameEpoch:'epoch',final:['completed','ended'].includes(status)?{stacks:[]}:null}};await context.poll();assert.equal(context.fails,0);};
 await poll('playing');const frame=dom.$('table'),src=frame.src;
 for(const status of ['pausing','paused','stopping','finalizing','completed','ended']){await poll(status);assert.equal(dom.$('table'),frame);assert.equal(frame.src,src);assert.equal(dom.$('playing').hidden,false);if(['completed','ended'].includes(status))assert.equal(dom.$('final').hidden,false);}
 context.tableIdentity=null;dom.$('table').removeAttribute('src');await poll('ended');assert.match(dom.$('table').src,/terminal=1/);
 await poll('completed',null);assert.equal(dom.$('waiting').hidden,false);assert.equal(dom.$('playing').hidden,true);assert.equal(dom.$('final').hidden,true);assert.equal(dom.$('table').getAttribute('src'),null);
 await poll('completed',null,'spectator');assert.equal(dom.$('playing').hidden,false);assert.equal(dom.$('final').hidden,false);assert.ok(dom.$('table').src);
 await poll('playing','h2');assert.equal(dom.$('playing').hidden,false);assert.ok(dom.$('table').src);
});

test('a pause click locks the table until the pause settles, and closing the menu never unlocks it', () => {
 const dom=elements(),source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 let open=false;dom.document.querySelector=selector=>selector==='dialog[open]'&&open?{}:null;
 const context={...dom,URLSearchParams,snapshot:null,selecting:false,viewingRecord:false,frameId:null,busy:false,interruptBusy:false,pauseLock:null,rejoinFor:null,labels:{},errorMessages:{}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function render()'),source.indexOf('let refreshFailures=')),context);
 const snap=(state,extra={})=>({state,gameId:'one',gameEpoch:'epoch',allowedCommands:[],...extra});
 context.snapshot=snap('playing');context.render();assert.equal(dom.$('table').inert,false);
 context.pauseLock={gameId:'one',gameEpoch:'epoch'};open=true;context.render();
 assert.equal(dom.$('table').inert,true);assert.equal(dom.$('table-lock').hidden,false);
 open=false;context.syncTableInert();assert.equal(dom.$('table').inert,true,'the menu closed while the pause is pending');
 context.snapshot=snap('playing');context.syncTableInert();assert.equal(dom.$('table').inert,true,'a stale playing snapshot does not unlock');
 context.snapshot=snap('pausing',{pausing:{waitingFor:{coach:1,training:2}}});context.render();
 assert.equal(dom.$('table').inert,true);assert.match(dom.$('table-lock-detail').textContent,/코치 노트 1건 · 학습 분석 2건/);
 assert.equal(dom.$('pause-progress').hidden,false);
 for(const [state,extra] of [['finalizing',{}],['playing',{gameId:'two'}],['playing',{gameEpoch:'next'}],['error',{}]]){
  context.pauseLock={gameId:'one',gameEpoch:'epoch'};context.snapshot=snap(state,extra);context.render();
  assert.equal(context.pauseLock,null,`${state} ${JSON.stringify(extra)} releases the lock`);
 }
 context.snapshot=snap('finalizing');context.render();assert.equal(dom.$('table').inert,false,'a last-hand pause that lands as finalizing frees the result table');
 assert.equal(dom.$('table-lock').hidden,true);
});
