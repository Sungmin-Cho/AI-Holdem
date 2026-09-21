import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../server/public/app-transport.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(request) {
  let now=0,id=0;const timers=new Map();
  const schedule=(fn,ms)=>{timers.set(++id,{at:now+ms,fn});return id;};
  const cancel=id=>timers.delete(id);
  const context={URLSearchParams,Headers,AbortController,DOMException,TextDecoderStream,Promise,Math,location:{search:''},sessionStorage:{getItem:()=>''},fetch:request,setTimeout:schedule,clearTimeout:cancel};
  vm.runInNewContext(source.replace(/^export /gm,'')+'\nthis.start=eventStream;this.recover=typeof recoverFinalSnapshot===\'function\'?recoverFinalSnapshot:null;',context);
  return {context,timers,start:()=>context.start('events',{request,schedule,cancel,random:()=>.5}),
    async advance(ms){const end=now+ms;for(;;){await flush();const rows=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at);if(!rows.length)break;const [key,t]=rows[0];now=t.at;timers.delete(key);t.fn();}now=end;await flush();}};
}
const failed=(status,code)=>({ok:false,status,json:async()=>code?{code}:{}});

test('SSE retries transient 404 and 503, but only terminal response codes stop it',async()=>{
  const calls=[];const f=fixture(async()=>{calls.push(1);return calls.length===1?failed(404):calls.length===2?failed(503,'SESSION_UNAVAILABLE'):failed(409,'SESSION_INACTIVE');});
  const stream=f.start();let fatal;stream.onfatal=code=>{fatal=code;};
  await flush();assert.equal(calls.length,1);
  await f.advance(1500);assert.equal(calls.length,2);
  await f.advance(3000);assert.equal(calls.length,3);assert.equal(fatal,'SESSION_INACTIVE');
  await f.advance(60000);assert.equal(calls.length,3);stream.close();
});
test('429 waits at least five seconds; exponential retries cap at fifteen seconds',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return failed(429);});const stream=f.start();await flush();
  await f.advance(4999);assert.equal(calls,1);await f.advance(1);assert.equal(calls,2);
  await f.advance(5000);assert.equal(calls,3);await f.advance(6000);assert.equal(calls,4);
  await f.advance(12000);assert.equal(calls,5);await f.advance(15000);assert.equal(calls,6);stream.close();
});
test('watchdog aborts the current attempt and its stalled onopen before reconnect',async()=>{
  let active=0,max=0,calls=0;const signals=[];
  const f=fixture(async(_url,{signal})=>{calls++;active++;max=Math.max(max,active);signal.addEventListener('abort',()=>active--,{once:true});return {ok:true,body:new ReadableStream({start(){}})};});
  const stream=f.start();stream.onopen=({signal})=>{signals.push(signal);return new Promise(()=>{});};
  await flush();assert.equal(calls,1);await f.advance(35000);assert.equal(signals[0].aborted,true);assert.equal(active,0);
  await f.advance(1500);assert.equal(calls,2);assert.equal(max,1);stream.close();await flush();assert.equal(active,0);
});
test('heartbeat bytes reset watchdog, and gameOver data does not terminate SSE',async()=>{
  let body,calls=0;const f=fixture(async()=>{calls++;return {ok:true,body:new ReadableStream({start(controller){body=controller;}})};});
  const stream=f.start();const messages=[];stream.onmessage=e=>messages.push(JSON.parse(e.data));await flush();
  await f.advance(30000);body.enqueue(new TextEncoder().encode(':heartbeat\n\n'));await flush();
  await f.advance(30000);assert.equal(calls,1);body.enqueue(new TextEncoder().encode('data: {"view":{"gameOver":true}}\n\n'));await flush();assert.equal(messages.length,1);
  body.close();await flush();await f.advance(1500);assert.equal(calls,2);stream.close();
});
test('terminal snapshot recovery is bounded even when fetch ignores abort',async()=>{
  const f=fixture(()=>{});assert.equal(typeof f.context.recover,'function');let attempts=0;
  const work=f.context.recover({getSnapshot:()=>{attempts++;return new Promise(()=>{});},schedule:f.context.setTimeout,cancel:f.context.clearTimeout});
  await flush();await f.advance(60000);assert.equal(await work,null);assert.equal(attempts,5);
});

test('actual table onopen ignores a late snapshot from an aborted connection attempt',async()=>{
  const app=fs.readFileSync(new URL('../server/public/app.js',import.meta.url),'utf8');
  const block=app.slice(app.indexOf('  es.onopen = async'),app.indexOf('  const poll = setInterval'));
  assert.ok(block.includes('openingAttempt'));
  const pending=[],rendered=[];
  const context={es:{},openingAttempt:0,ui:{sessionEnded:false},revision:0,booted:false,buffer:[],actionController:null,
    getSnapshot:()=>new Promise(resolve=>pending.push(resolve)),isSpectating:()=>true,renderSnapshot:s=>rendered.push(s.revision),
    setConn:()=>{},applyMessage:()=>{},appGameId:'test'};
  vm.runInNewContext(block,context);
  const first=new AbortController(),second=new AbortController();
  const stale=context.es.onopen({signal:first.signal});first.abort();
  const fresh=context.es.onopen({signal:second.signal});pending[1]({revision:2,view:{viewer:null}});await fresh;
  pending[0]({revision:100,view:{viewer:null}});await stale;
  assert.deepEqual(rendered,[2]);assert.equal(context.revision,2);assert.equal(context.booted,true);
});
test('actual table terminal transition retrieves final snapshot before ending, without reopening SSE',async()=>{
  const app=fs.readFileSync(new URL('../server/public/app.js',import.meta.url),'utf8');
  const block=app.slice(app.indexOf('  es.onopen = async'),app.indexOf('  const poll = setInterval'));
  for(const snapshot of [{revision:5,view:{gameOver:true},review:'final review'},null,'render-failure']) {
    const calls=[];const context={es:{},openingAttempt:0,ui:{sessionEnded:false},revision:1,booted:true,poll:1,
      actionController:{disconnect:()=>calls.push('disconnect')},clearInterval:()=>{},getSnapshot:()=>{},
      recoverFinalSnapshot:async()=>{calls.push('recover');return snapshot==='render-failure'?{revision:5}:snapshot;},renderSnapshot:()=>{calls.push('render');if(snapshot==='render-failure')throw Error('UI_RENDER_FAILED');},paint:()=>calls.push('paint'),paintEndedControls:()=>calls.push('ended-controls'),
      setConn:(_on,text)=>calls.push(text),appGameId:'test'};
    vm.runInNewContext(block,context);await context.es.onfatal('SESSION_INACTIVE',{signal:new AbortController().signal});
    assert.equal(context.ui.sessionEnded,true);assert.equal(calls.at(-1),'게임 종료');assert.ok(calls.includes('ended-controls'));
    assert.equal(calls.includes('render'),!!snapshot);assert.ok(calls.indexOf('recover')<calls.indexOf('paint'));
  }
});
