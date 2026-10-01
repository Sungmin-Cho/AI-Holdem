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
 const context={...dom,sessionStorage:{getItem:()=> 'fixture'},fetch:async()=>({ok:true,json:async()=>state}),polling:false,fails:0,latest:null,tableIdentity:null,summaryIdentity:null,finalSummary:null,finalPanelKey:null,tableGame:null,paintFinal(){},loadSummary(){},paintProvider(){},paintWaiting(){},bindBridge(){}};
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
 context.snapshot=snap('pausing',{pausing:{since:new Date(Date.now()-7000).toISOString(),waitingFor:{coach:1,training:2}}});context.render();
 assert.equal(dom.$('table').inert,true);assert.equal(dom.$('table-lock-detail').textContent,'마무리 중: 학습 분석 2건 · 코치 노트 1건');
 assert.match(dom.$('table-lock-elapsed').textContent,/[67]초째/,'elapsed seconds sit outside the live region');
 context.snapshot=snap('pausing',{pausing:{waitingFor:{training:2,explain:1,solve:1,resolver:true}}});context.render();
 assert.equal(dom.$('table-lock-detail').textContent,'마무리 중: 학습 설명 1건 · 솔버 분석 1건 · AI 코치 연결 확인','running children are named by kind');
 assert.equal(dom.$('pause-progress').hidden,false);
 context.pauseLock={gameId:'one',gameEpoch:'epoch'};context.snapshot=snap('paused');context.render();
 assert.deepEqual(context.pauseLock,{gameId:'one',gameEpoch:'epoch'},'a paused snapshot alone (maybe a late answer) keeps the lock');
 for(const [state,extra] of [['finalizing',{}],['playing',{gameId:'two'}],['playing',{gameEpoch:'next'}],['error',{}]]){
  context.pauseLock={gameId:'one',gameEpoch:'epoch'};context.snapshot=snap(state,extra);context.render();
  assert.equal(context.pauseLock,null,`${state} ${JSON.stringify(extra)} releases the lock`);
 }
 context.snapshot=snap('finalizing');context.render();assert.equal(dom.$('table').inert,false,'a last-hand pause that lands as finalizing frees the result table');
 assert.equal(dom.$('table-lock').hidden,true);
});

test('R3: a refused pause unlocks the table, an unanswered one stays locked, a settled one unlocks', async () => {
 const source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{id,hidden:false,disabled:false,open:false,textContent:'',dataset:{},focus(){}});return nodes.get(id);};
 let stored=null,send;
 const lock=()=>({gameId:'g',gameEpoch:'e'});
 const context={$,busy:false,viewingRecord:false,preparing:null,selecting:false,pauseLock:lock(),refreshSeq:0,
  snapshot:{instanceId:'i',appRevision:1,gameId:'g',gameEpoch:'e',selectionVersion:1,state:'playing',setup:null},
  commands:{get pending(){return !!stored;},get pendingCommand(){return stored;},send:payload=>send(payload)},uuid:()=>'r1',render(){},refresh:async()=>{},showError(){},openPauseMenu(){}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function storedPause('),source.indexOf('function confirm(fn)')),context);
 send=async()=>{throw Object.assign(new Error('INVALID_TRANSITION'),{status:409});};
 await context.command('pause');assert.equal(context.pauseLock,null,'a refusal with a status code is final');
 context.pauseLock=lock();send=async(payload)=>{stored={requestId:payload.requestId,kind:payload.kind};throw new TypeError('fetch failed');};
 await context.command('pause');assert.deepEqual({...context.pauseLock},{...lock(),requestId:'r1'},'an unanswered pause (command still stored) stays locked');
 context.pauseLock=lock();stored={requestId:'older',kind:'resume'};send=async()=>{throw new Error('COMMAND_PENDING');};
 await context.command('pause');assert.equal(context.pauseLock,null,'a pause never stored because another command is pending unlocks');
 stored=null;send=async()=>({status:'succeeded'});context.pauseLock=lock();context.refreshSeq=4;
 await context.command('pause');assert.deepEqual({...context.pauseLock},{...lock(),requestId:'r1',settledSeq:4},'a settled pause waits for a snapshot requested after it');
 context.pauseLock=lock();context.refresh=async()=>{throw new Error('offline');};
 await context.command('pause');assert.equal(context.pauseLock.settledSeq,4,'a failed follow-up refresh leaves the settled lock for the next poll');
});

test('R3: a pause click while another command is being confirmed does not lock the table', () => {
 const source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{id});return nodes.get(id);};
 const errors=[],sent=[];let pending=true,opened=0;
 const context={$,busy:false,pauseLock:null,snapshot:{state:'playing',gameId:'g',gameEpoch:'e'},
  commands:{get pending(){return pending;}},showError:e=>errors.push(e.message),render(){},openPauseMenu(){opened+=1;},command:kind=>{sent.push(kind);}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('$("menu").onclick'),source.indexOf('$("resume").onclick')),context);
 $('menu').onclick();
 assert.equal(context.pauseLock,null);assert.deepEqual(sent,[]);assert.equal(opened,0);assert.deepEqual(errors,['COMMAND_PENDING']);
 pending=false;$('menu').onclick();
 assert.deepEqual({...context.pauseLock},{gameId:'g',gameEpoch:'e'});assert.deepEqual(sent,['pause']);assert.equal(opened,1);
});

test('R3: only a snapshot requested after the pause settled releases the lock', async () => {
 const source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 const start=source.indexOf('let refreshFailures=0;'),end=source.indexOf('const BOOT_ORDER');
 const pending=[];const context={snapshot:null,pauseLock:null,appliedDefaults:true,form:{},render(){},
  api:()=>new Promise(resolve=>pending.push(resolve))};
 vm.createContext(context);vm.runInContext(source.slice(start,end).replace('let refreshFailures=0;','var refreshFailures=0;').replace('let refreshSeq=0;','var refreshSeq=0;'),context);
 context.pauseLock={gameId:'g',gameEpoch:'e'};
 const early=context.refresh();                       // started before the pause settled
 context.pauseLock={...context.pauseLock,settledSeq:context.refreshSeq};
 const later=context.refresh();                       // started after
 pending[0]({state:'playing'});await early;
 assert.equal(context.pauseLock?.settledSeq,1,'a late answer to an earlier refresh keeps the lock');
 pending[1]({state:'paused'});await later;
 assert.equal(context.pauseLock,null,'the first snapshot requested after settling releases it');
});

test('R3: an answer older than the snapshot already shown is dropped', async () => {
 const source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 const start=source.indexOf('let refreshFailures=0;'),end=source.indexOf('const BOOT_ORDER');
 const pending=[];const context={snapshot:null,pauseLock:null,appliedDefaults:true,form:{},render(){},
  api:()=>new Promise(resolve=>pending.push(resolve))};
 vm.createContext(context);vm.runInContext(source.slice(start,end).replace('let refreshFailures=0;','var refreshFailures=0;').replace('let refreshSeq=0;','var refreshSeq=0;'),context);
 const early=context.refresh();                       // started before the pause settled
 context.pauseLock={gameId:'g',gameEpoch:'e',settledSeq:context.refreshSeq};
 const later=context.refresh();
 pending[1]({state:'paused'});await later;            // the newer answer arrives first
 assert.equal(context.pauseLock,null);assert.equal(context.snapshot.state,'paused');
 pending[0]({state:'playing'});await early;
 assert.equal(context.snapshot.state,'paused','the late, older answer does not repaint a stale playing state');
});

test('R3: recovery keeps a settled pause locked until a later snapshot and restores a stored pause after reload', async () => {
 const source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 const slice=source.slice(source.indexOf('async function recoverCommand()'),source.indexOf('async function roomOp('));
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{id,open:false,textContent:''});return nodes.get(id);};
 let stored={kind:'pause',expectedGameId:'g'},recover;
 const context={$,busy:false,selecting:false,pauseLock:null,refreshSeq:7,snapshot:{gameId:'g',gameEpoch:'e',state:'playing'},
  commands:{get pending(){return !!stored;},get pendingCommand(){return stored;},recover:()=>recover()},
  refresh:async()=>{throw new Error('offline');},render(){},showError(){},openPauseMenu(){}};
 vm.createContext(context);vm.runInContext(slice,context);
 vm.runInContext(source.slice(source.indexOf('function storedPause('),source.indexOf('async function command(')),context);
 stored={requestId:'p1',kind:'pause',expectedGameId:'g'};recover=async()=>{throw new TypeError('fetch failed');};
 await context.recoverCommand();
 assert.deepEqual({...context.pauseLock},{gameId:'g',gameEpoch:'e',requestId:'p1'},'restored after reload and kept while unanswered');
 recover=async()=>{stored=null;return {status:'succeeded'};};
 await context.recoverCommand();
 assert.deepEqual({...context.pauseLock},{gameId:'g',gameEpoch:'e',requestId:'p1',settledSeq:7},'settled, and kept while the refresh fails');
 context.pauseLock={gameId:'g',gameEpoch:'e',requestId:'p2'};stored={requestId:'r9',kind:'resume',expectedGameId:'g'};
 await context.recoverCommand();
 assert.equal(context.pauseLock,null,'a lock whose pause was never stored unlocks once the other command settles');
 context.pauseLock=null;stored={requestId:'p3',kind:'pause',expectedGameId:'g'};
 recover=async()=>{stored=null;throw new Error('INVALID_TRANSITION');};
 await context.recoverCommand();
 assert.equal(context.pauseLock,null,'a confirmed refusal unlocks');
 stored={requestId:'p4',kind:'pause',expectedGameId:'other'};recover=async()=>{throw new TypeError('fetch failed');};
 await context.recoverCommand();
 assert.equal(context.pauseLock,null,'a stored pause for another game does not lock this one');
});

// #264: the lobby's actual messages, result panel and notice.
function lobbyWithMessages(extra={}){
 const dom=elements(),source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 const context={...dom,URLSearchParams,snapshot:null,selecting:false,viewingRecord:false,frameId:null,busy:false,interruptBusy:false,pauseLock:null,rejoinFor:null,labels:{},preparing:null,refreshSeq:0,...extra};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function render()'),source.indexOf('let refreshFailures='))
  +source.slice(source.indexOf('const errorMessages = {'),source.indexOf('const commands ='))
  +source.slice(source.indexOf('async function command('),source.indexOf('function confirm(')),context);
 return {dom,context};
}
const KEPT=/게임은 저장되어 있습니다.*불러오기로 이어 가세요/;
const NOT_STARTED=/게임을 시작하지 않았습니다.*다시 시작하세요/;
test('#264 a study refusal that kept its game advises 불러오기, and 종료 only when it is allowed', () => {
 const {dom,context}=lobbyWithMessages();
 const panel=(allowedCommands)=>{context.snapshot={state:'error',gameId:'one',gameEpoch:'epoch',error:'STUDY_SERVICE_INCOMPATIBLE',allowedCommands};context.render();return dom.$('result-message').textContent;};
 const endable=panel(['resume','end','restart']);
 assert.match(endable,KEPT);assert.match(endable,/게임을 종료할 수 있습니다/);assert.doesNotMatch(endable,/시작하지 않았습니다|다시 시작/);
 const resumeOnly=panel(['resume']);
 assert.match(resumeOnly,KEPT);assert.doesNotMatch(resumeOnly,/종료/);
 context.showError(new Error('STUDY_SERVICE_INCOMPATIBLE'));
 assert.equal(dom.$('error').textContent,resumeOnly,'the notice says what the result panel says');
 // Refused before any commit, the lobby is back where it was.
 for(const state of ['lobby','ended','completed']){
  context.snapshot={state,gameId:state==='lobby'?null:'one',allowedCommands:['start','restart']};
  context.showError(new Error('STUDY_SERVICE_INCOMPATIBLE'));assert.match(dom.$('error').textContent,NOT_STARTED,state);
 }
 // An `error` state without a current game created none.
 context.snapshot={state:'error',gameId:null,allowedCommands:['resume']};
 context.showError(new Error('STUDY_SERVICE_INCOMPATIBLE'));assert.match(dom.$('error').textContent,NOT_STARTED);
 // Other codes read the same in every state.
 context.snapshot={state:'error',allowedCommands:['resume']};context.showError(new Error('NO_PLAYER_RUNTIME'));
 const runtime=dom.$('error').textContent;assert.match(runtime,/LLM 플레이어/);
 context.snapshot={state:'lobby',allowedCommands:['start']};context.showError(new Error('NO_PLAYER_RUNTIME'));
 assert.equal(dom.$('error').textContent,runtime);
});
test('#264 a failed start picks its notice again from the state the failure left', async () => {
 for(const refreshed of [true,false]){
  const {dom,context}=lobbyWithMessages({uuid:()=>'request',storedPause:()=>false,openPauseMenu(){},
   commands:{send:async()=>{throw new Error('STUDY_SERVICE_INCOMPATIBLE');}}});
  dom.$('start').focus=()=>{};
  context.snapshot={state:'lobby',gameId:null,allowedCommands:['start']};
  // The game was committed before the refusal: the next snapshot is its `error`.
  context.refresh=async()=>{if(!refreshed)throw new Error('offline');context.snapshot={state:'error',gameId:'new',gameEpoch:'epoch',error:'STUDY_SERVICE_INCOMPATIBLE',allowedCommands:['resume','end','restart']};};
  await context.command('start',{mode:'cash-training'});
  assert.match(dom.$('error').textContent,refreshed ? KEPT : NOT_STARTED,`refreshed=${refreshed}`);
 }
});
