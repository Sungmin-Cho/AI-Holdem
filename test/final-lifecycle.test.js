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

// #273: the lobby shows why a retained game cannot resume, and why a resume just failed.
test('#273 the result panel names the cleanup failure and the failure that started it, as closed codes only', () => {
 const {dom,context}=lobbyWithMessages();
 const panel=(detail,error='CHILD_CLOSE_UNCONFIRMED')=>{
  context.snapshot={state:'error',gameId:'one',gameEpoch:'epoch',error,errorDetail:detail,allowedCommands:['resume']};
  context.render();return dom.$('result-message').textContent;
 };
 const both=panel({run:'PUBLISH_REJECTED',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:{httpStatus:400,serverCode:'FORBIDDEN_LITERAL'}});
 assert.match(both,/종료를 확인하지 못해/);
 assert.match(both,/불러오기/);
 assert.match(both,/처음 멈춘 이유: 서버가 게임 기록 게시를 거부했습니다/);
 assert.match(both,/서버 응답 400 FORBIDDEN_LITERAL/);
 // A code the lobby has no words for is described in safe words that name no code — never raw
 // text from the snapshot — and the projected sanitized answers, when there are any, still show.
 const unknown=panel({run:'<script>alert(1)</script>',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:null});
 assert.doesNotMatch(unknown,/script|alert|<|>/);
 assert.match(unknown,/처음 멈춘 이유: 게임이 먼저 다른 이유로 멈췄고 그 기록은 보존되어 있습니다\. 불러오기로 이어서 확인해 주세요\./);
 assert.doesNotMatch(unknown,/서버 응답/);
 const unknownWithAnswer=panel({run:'SOME_FUTURE_CODE',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:{httpStatus:503,serverCode:'RELAY_SHUTTING_DOWN'}});
 assert.doesNotMatch(unknownWithAnswer,/SOME_FUTURE_CODE/);
 assert.match(unknownWithAnswer,/처음 멈춘 이유: 게임이 먼저 다른 이유로 멈췄고 그 기록은 보존되어 있습니다\. 불러오기로 이어서 확인해 주세요\. \(서버 응답 503 RELAY_SHUTTING_DOWN\)/);
 // The same code twice is one sentence, and no detail is no extra line.
 assert.doesNotMatch(panel({run:'CHILD_CLOSE_UNCONFIRMED',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:null}),/처음 멈춘 이유/);
 assert.doesNotMatch(panel(null),/처음 멈춘 이유/);
 // A failed 불러오기 explains itself instead of showing the generic line.
 context.snapshot={state:'error',gameId:'one',gameEpoch:'epoch',error:'CHILD_CLOSE_UNCONFIRMED',allowedCommands:['resume']};
 const generic=/요청을 완료하지 못했습니다/;
 for(const code of ['CHILD_CLOSE_UNCONFIRMED','CHILD_SIGNAL_FAILED','SERVER_STOP_UNCONFIRMED','SESSION_STOPPED','RESUME_NOT_APPLIED','PUBLISH_REJECTED','PENDING_ANNOTATION_BLOCKED','LOOP_LOCK_LOST','REJECTION_AUDIT_FAILED','ATTEMPT_SYNC_FAILED','SERVER_LISTENER_UNAVAILABLE',
  'RELAY_BINDING_CHANGED','RELAY_BINDING_UNVERIFIED','ATTEMPT_CHANGED','RETRY_BINDING_REQUIRED','RETIRE_RESULT_UNBOUND','ATTEMPT_NOT_RETIRABLE','ANNOTATION_RETIRED',
  'REJECTION_EVIDENCE_PENDING','REJECTION_EVIDENCE_UNAVAILABLE','REJECTION_EVIDENCE_INVALID','REJECTION_EVIDENCE_MISSING','STALE_ANNOTATION_AUTHORITY','FINALIZATION_DEADLINE_EXCEEDED']){
  context.showError(new Error(code));
  assert.doesNotMatch(dom.$('error').textContent,generic,code);
  assert.ok(dom.$('error').textContent.length>10,code);
 }
});

// #274: the combined failure of the incident — the applied action's publication met a refused
// explanation whose retirement could not record its audit (REJECTION_AUDIT_FAILED), then the
// cleanup could not be confirmed — gets guidance a host can act on, with the sanitized first
// server answer (and a differing recheck) beside it; the same words after a failed 불러오기,
// and when the audit failure is the primary error. Closed codes and status/code pairs only.
test('#274 the result panel explains REJECTION_AUDIT_FAILED with recovery guidance and the sanitized first refusal, in the combined state, after a failed resume, and as the primary error', () => {
 const {dom,context}=lobbyWithMessages();
 const panel=(detail,error='CHILD_CLOSE_UNCONFIRMED')=>{
  context.snapshot={state:'error',gameId:'one',gameEpoch:'epoch',error,errorDetail:detail,allowedCommands:['resume']};
  context.render();return dom.$('result-message').textContent;
 };
 const combined=panel({run:'REJECTION_AUDIT_FAILED',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:{httpStatus:400,serverCode:'ANNOTATION_PROOF_MISMATCH'}});
 assert.match(combined,/종료를 확인하지 못해/,'the cleanup that still blocks the game');
 assert.match(combined,/불러오기를 누르면 정리를 다시 확인/,'what to do');
 assert.match(combined,/처음 멈춘 이유: 서버가 거부한 학습 설명의 폐기 기록을 안전하게 남기지 못해/,'the failure that started it, in words');
 assert.match(combined,/폐기 감사 파일 자리가 다른 파일이나 폴더로 막혀 있지 않은지 확인/,'actionable recovery guidance');
 assert.match(combined,/\(서버 응답 400 ANNOTATION_PROOF_MISMATCH\)/,'the sanitized first refusal');
 assert.doesNotMatch(combined,/재확인/);
 // A recheck that answered differently is shown beside the first answer, never instead of it.
 const rechecked=panel({run:'SERVER_LISTENER_UNAVAILABLE',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:{httpStatus:500,serverCode:'FORBIDDEN_LITERAL_UNAVAILABLE'},recheckRejection:{httpStatus:400,serverCode:'FORBIDDEN_LITERAL'}});
 assert.match(rechecked,/처음 멈춘 이유: 게임 서버의 소유를 확인하지 못해/);
 assert.match(rechecked,/\(서버 응답 500 FORBIDDEN_LITERAL_UNAVAILABLE · 재확인 400 FORBIDDEN_LITERAL\)/);
 // The audit failure as the primary error (the cleanup succeeded): its own guidance plus the answer, once.
 const primary=panel({run:'REJECTION_AUDIT_FAILED',cleanup:null,rejection:{httpStatus:400,serverCode:'FORBIDDEN_LITERAL'}},'REJECTION_AUDIT_FAILED');
 assert.match(primary,/^서버가 거부한 학습 설명의 폐기 기록을 안전하게 남기지 못해/);
 assert.match(primary,/\(서버 응답 400 FORBIDDEN_LITERAL\)/);
 assert.doesNotMatch(primary,/처음 멈춘 이유/);
 // Only closed pairs are rendered: an unlisted-shaped answer, a message or any other text is not.
 const odd=panel({run:'REJECTION_AUDIT_FAILED',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:{httpStatus:400,serverCode:'<b>As Kh tok</b>'},recheckRejection:{httpStatus:'500',serverCode:'FORBIDDEN_LITERAL'}});
 assert.doesNotMatch(odd,/서버 응답|As Kh|tok|<b>/);
 assert.match(odd,/처음 멈춘 이유: 서버가 거부한 학습 설명/);
 // After a failed 불러오기 the panel keeps the same explanation and the notice is not generic.
 context.snapshot={state:'error',gameId:'one',gameEpoch:'epoch',error:'CHILD_CLOSE_UNCONFIRMED',errorDetail:{run:'REJECTION_AUDIT_FAILED',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:{httpStatus:400,serverCode:'ANNOTATION_PROOF_MISMATCH'}},allowedCommands:['resume']};
 context.render();
 assert.equal(dom.$('result-message').textContent,combined,'a failed resume that changed nothing shows the same explanation');
 context.showError(new Error('CHILD_CLOSE_UNCONFIRMED'));
 assert.doesNotMatch(dom.$('error').textContent,/요청을 완료하지 못했습니다/);
 assert.match(dom.$('error').textContent,/불러오기/);
});
// #274: every recovery outcome a run can stop with is explained in words with what to do next,
// and the sanitized first/recheck answers are shown whenever the snapshot projects them — in
// the combined cleanup state, as the primary error, and after a failed 불러오기. A raw code is
// never shown, with or without a message for it.
test('#274 the result panel explains the recovery outcomes (binding, attempt sync, evidence, changed result) with guidance and the projected answers, combined, primary and after a failed resume', () => {
 const {dom,context}=lobbyWithMessages();
 const panel=(detail,error='CHILD_CLOSE_UNCONFIRMED')=>{
  context.snapshot={state:'error',gameId:'one',gameEpoch:'epoch',error,errorDetail:detail,allowedCommands:['resume']};
  context.render();return dom.$('result-message').textContent;
 };
 const first={httpStatus:500,serverCode:'FORBIDDEN_LITERAL_UNAVAILABLE'};
 const cases=[
  {run:'ATTEMPT_CHANGED',words:/다시 보내려던 게시 기록이 그사이 다른 기록으로 바뀌어 보내지 않았습니다/,guide:/불러오기를 누르면 현재 기록부터 다시 확인/},
  {run:'RELAY_BINDING_CHANGED',words:/게임 서버가 바뀐 것으로 확인되어 보내지 않고 멈췄습니다/,guide:/불러오기를 누르면 서버를 다시 확인/},
  {run:'RELAY_BINDING_UNVERIFIED',words:/게임 서버를 확인하지 못해 보내지 않고 멈췄습니다/,guide:/불러오기로 다시 확인/},
  {run:'REJECTION_EVIDENCE_UNAVAILABLE',words:/정리 기록을 읽거나 보존하지 못해 멈췄습니다/,guide:/게임 폴더를 읽고 쓸 수 있는지 확인한 뒤 불러오기/},
  {run:'REJECTION_EVIDENCE_PENDING',words:/정리가 아직 끝나지 않아 새 게시를 보류했습니다/,guide:/정리를 먼저 끝내고 이어서 시작/},
  {run:'RETIRE_RESULT_UNBOUND',words:/보내려던 게시와 일치하지 않아 아무것도 게시된 것으로 표시하지 않았습니다/,guide:/불러오기를 누르면 다시 확인/},
  {run:'RETRY_BINDING_REQUIRED',words:/어느 기록을 보냈는지 확인되지 않아 자동으로 다시 보내지 않았습니다/,guide:/불러오기를 누르면 기록을 다시 확인/},
  {run:'ANNOTATION_RETIRED',words:/이미 정리된 학습 설명을 게시된 것으로 표시하려 해 멈췄습니다/,guide:/불러오기를 누르면 다시 확인/},
  {run:'FINALIZATION_DEADLINE_EXCEEDED',words:/마무리 제한 시간을 넘겨 게시를 멈췄습니다/,guide:/불러오기를 누르면 이어서 처리/},
 ];
 for(const c of cases){
  // Combined: the cleanup that still blocks, then the run failure in words, its guidance, and both answers.
  const combined=panel({run:c.run,cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:first,recheckRejection:{httpStatus:409,serverCode:'ANNOTATION_CONFLICT'}});
  assert.match(combined,/종료를 확인하지 못해/,c.run);
  assert.match(combined,/불러오기를 누르면 정리를 다시 확인/,c.run);
  assert.match(combined,/처음 멈춘 이유: /,c.run);
  assert.match(combined,c.words,c.run);
  assert.ok(combined.indexOf('처음 멈춘 이유: ')<combined.search(c.words),'the run failure is explained after the cleanup that still blocks: '+c.run);
  assert.match(combined,c.guide,c.run);
  assert.match(combined,/\(서버 응답 500 FORBIDDEN_LITERAL_UNAVAILABLE · 재확인 409 ANNOTATION_CONFLICT\)/,c.run);
  assert.doesNotMatch(combined,new RegExp(c.run),'the raw code is not shown: '+c.run);
  // Primary (the cleanup succeeded): its own words and guidance plus the first answer, once.
  const primary=panel({run:c.run,cleanup:null,rejection:first},c.run);
  assert.match(primary,c.words,c.run);
  assert.match(primary,c.guide,c.run);
  assert.match(primary,/\(서버 응답 500 FORBIDDEN_LITERAL_UNAVAILABLE\)/,c.run);
  assert.doesNotMatch(primary,/처음 멈춘 이유|재확인/,c.run);
  assert.doesNotMatch(primary,new RegExp(c.run),'the raw code is not shown: '+c.run);
  // After a failed 불러오기 that changed nothing, the same explanation; the notice is not generic.
  context.snapshot={state:'error',gameId:'one',gameEpoch:'epoch',error:'CHILD_CLOSE_UNCONFIRMED',errorDetail:{run:c.run,cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:first,recheckRejection:{httpStatus:409,serverCode:'ANNOTATION_CONFLICT'}},allowedCommands:['resume']};
  context.render();
  assert.equal(dom.$('result-message').textContent,combined,'a failed resume keeps the explanation: '+c.run);
  context.showError(new Error(c.run));
  assert.doesNotMatch(dom.$('error').textContent,/요청을 완료하지 못했습니다/,c.run);
  assert.match(dom.$('error').textContent,/불러오기/,c.run);
 }
 // A closed run code without a message: the projected answers are still shown, in words that
 // name no code; nothing raw from the detail reaches the panel.
 const unlisted=panel({run:'SOME_FUTURE_CODE',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:{httpStatus:503,serverCode:'RELAY_SHUTTING_DOWN'},recheckRejection:{httpStatus:400,serverCode:'FORBIDDEN_LITERAL'}});
 assert.match(unlisted,/종료를 확인하지 못해/);
 assert.match(unlisted,/처음 멈춘 이유: 게임이 먼저 다른 이유로 멈췄고 그 기록은 보존되어 있습니다\. 불러오기로 이어서 확인해 주세요\./);
 assert.match(unlisted,/\(서버 응답 503 RELAY_SHUTTING_DOWN · 재확인 400 FORBIDDEN_LITERAL\)/);
 assert.doesNotMatch(unlisted,/SOME_FUTURE_CODE/);
 const unlistedPrimary=panel({run:'SOME_FUTURE_CODE',cleanup:null,rejection:{httpStatus:503,serverCode:'RELAY_SHUTTING_DOWN'}},'SOME_FUTURE_CODE');
 assert.match(unlistedPrimary,/^현재 게임 상태를 확인해 주세요\. \(서버 응답 503 RELAY_SHUTTING_DOWN\)$/);
 // Only closed pairs are rendered, whatever the code: a message-shaped answer is not.
 const odd=panel({run:'ATTEMPT_CHANGED',cleanup:'CHILD_CLOSE_UNCONFIRMED',rejection:{httpStatus:500,serverCode:'<b>As Kh tok</b> /tmp/x'},recheckRejection:{httpStatus:409,serverCode:'ANNOTATION_CONFLICT'}});
 assert.doesNotMatch(odd,/서버 응답|As Kh|tok|<b>|\/tmp/);
 assert.match(odd,/처음 멈춘 이유: 다시 보내려던 게시 기록/);
});

// #286: the actual refresh, render, chooseMode and back handler, run together, so
// the landing decision is checked on the snapshots a page load really applies.
function lobbyLanding(){
 const dom=elements(),source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
 const answers=[];let opened=0,focused=null;
 const context={...dom,URLSearchParams,snapshot:null,selecting:false,viewingRecord:false,frameId:null,busy:false,interruptBusy:false,pauseLock:null,rejoinFor:null,labels:{},errorMessages:{},appliedDefaults:true,form:{},
  api:async()=>{const next=answers.shift();if(next instanceof Error)throw next;return next;}};
 vm.createContext(context);
 const between=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to));
 vm.runInContext(between('function render()','const BOOT_ORDER')+between('function chooseMode()',"$('interrupt-decision').onclick")+between('$("back").onclick','form.onchange = () =>'),context);
 dom.$('pause-dialog').showModal=()=>{opened+=1;};
 dom.$('review').focus=()=>{focused='review';};
 dom.$('ai-count').focus=()=>{};
 const poll=async(state,extra={})=>{answers.push({state,gameId:'one',gameEpoch:'epoch',allowedCommands:['start','restart'],...extra});await context.refresh();};
 const view=()=>({setup:!dom.$('setup').hidden,result:!dom.$('result').hidden,game:!dom.$('game').hidden,back:!dom.$('back').hidden,src:dom.$('table').getAttribute('src')});
 return {dom,context,answers,poll,view,opened:()=>opened,focused:()=>focused};
}
test('#286 a page opened on a finished game lands on the lobby with the record detached', async () => {
 for(const state of ['completed','ended']){
  const {dom,context,poll,view}=lobbyLanding();
  await poll(state);
  assert.equal(context.selecting,true,state);
  assert.deepEqual(view(),{setup:true,result:false,game:false,back:true,src:null},state);
  assert.equal(dom.$('back').textContent,'직전 게임 결과 보기',state);
  assert.equal(dom.classes.has('has-game'),false,state);
 }
 // A failed first refresh decides nothing: the next applied snapshot does.
 const {context,answers,poll,view}=lobbyLanding();
 answers.push(new Error('offline'));await assert.rejects(context.refresh(),/offline/);
 assert.equal(context.selecting,false);
 await poll('completed');assert.equal(context.selecting,true);assert.equal(view().setup,true);
});
test('#286 a game that finishes while the page is open still shows its result and keeps the table', async () => {
 for(const states of [['finalizing','completed'],['stopping','ended']]){
  const {dom,context,poll,view}=lobbyLanding();
  await poll('playing');const src=dom.$('table').src;assert.ok(src);
  for(const state of states){await poll(state);assert.equal(context.selecting,false,state);assert.equal(dom.$('table').src,src,state);}
  assert.deepEqual(view(),{setup:false,result:true,game:true,back:false,src},states.join());
 }
});
test('#286 a first snapshot in error, external, paused or lobby opens as before, and later endings do not land', async () => {
 const expected={
  error:{setup:false,result:true,game:false,back:false,src:null},
  external:{setup:false,result:true,game:false,back:false,src:null},
  paused:{setup:false,result:false,game:true,back:false},
  lobby:{setup:true,result:false,game:false,back:false,src:null},
 };
 for(const [state,shown] of Object.entries(expected)){
  const {dom,context,poll,view}=lobbyLanding();
  await poll(state,state==='lobby'?{gameId:null,allowedCommands:['start']}:{});
  assert.equal(context.selecting,false,state);
  const {src,...rest}=view();
  assert.deepEqual(state==='paused'?rest:{...rest,src},shown,state);
  if(state==='paused')assert.match(src,/appGame=one/);
  // The decision is spent on this first snapshot: a game that ends later shows its result.
  await poll('completed');
  assert.equal(context.selecting,false,`${state} then completed`);
  assert.deepEqual({result:view().result,setup:view().setup},{result:true,setup:false},`${state} then completed`);
  assert.equal(dom.$('back').hidden,true,`${state} then completed`);
 }
});
test('#286 "직전 게임 결과 보기" returns to the result card and the record, and the next poll keeps it there', async () => {
 const {dom,context,poll,view,opened,focused}=lobbyLanding();
 await poll('completed');
 dom.$('back').onclick();
 assert.equal(context.selecting,false);
 const back=view();
 assert.deepEqual({...back,src:undefined},{setup:false,result:true,game:true,back:false,src:undefined});
 assert.match(back.src,/appGame=one/);assert.match(back.src,/terminal=1/);
 assert.equal(dom.classes.has('has-game'),true);
 assert.equal(opened(),0,'a finished game opens no pause menu');
 assert.equal(focused(),'review','focus moves to the result card, not to a hidden button');
 // One decision per page load: the next poll still reads completed and stays on the result.
 await poll('completed');assert.equal(context.selecting,false);assert.deepEqual(view(),back);
 // 모드 선택 from the result offers the same way back.
 context.chooseMode();
 assert.deepEqual(view(),{setup:true,result:false,game:false,back:true,src:null});
 assert.equal(dom.$('back').textContent,'직전 게임 결과 보기');
 dom.$('back').onclick();
 assert.equal(view().result,true);assert.match(view().src,/terminal=1/);
});
test('#286 a paused game keeps its "back" wording and returns to the pause menu', async () => {
 const {dom,context,poll,view,opened,focused}=lobbyLanding();
 await poll('paused');
 context.chooseMode();
 assert.equal(view().setup,true);assert.equal(view().back,true);
 assert.equal(dom.$('back').textContent,'일시정지 메뉴로 돌아가기');
 dom.$('back').onclick();
 assert.equal(context.selecting,false);assert.equal(opened(),1);assert.equal(focused(),null);
 assert.deepEqual({setup:view().setup,game:view().game,result:view().result},{setup:false,game:true,result:false});
});
