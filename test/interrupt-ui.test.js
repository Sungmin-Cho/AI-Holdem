import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server/public/lobby.js',import.meta.url),'utf8');
function fixture(){
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,dataset:{},attrs:{},classList:{toggle(){}},replaceChildren(){},append(){},close(){},set src(value){this.attrs.src=value;},getAttribute(key){return this.attrs[key]??null;},removeAttribute(key){delete this.attrs[key];}});return nodes.get(id);};
 const context={$ ,URLSearchParams,snapshot:{state:'playing',gameId:'game',gameEpoch:'epoch',allowedCommands:[],pendingDecision:{status:'running',softWait:true,decisionId:'d-one',generation:3}},selecting:false,viewingRecord:false,frameId:null,busy:false,interruptBusy:false,pauseLock:null,rejoinFor:null,labels:{},errorMessages:{},document:{querySelector:()=>null,body:{classList:{toggle(){}}}}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function render()'),source.includes('let refreshFailures=')?source.indexOf('let refreshFailures='):source.indexOf('async function refresh()')),context);
 return context;
}
test('actual lobby interrupt button requires running soft wait and is independent of command busy',()=>{
 const c=fixture();c.busy=true;c.render();assert.equal(c.$('interrupt-decision').hidden,false);assert.equal(c.$('interrupt-decision').disabled,false);
 for(const pending of [{status:'running',softWait:false},{status:'recovery_required',softWait:true},null]){c.snapshot.pendingDecision=pending;c.render();assert.equal(c.$('interrupt-decision').hidden,true);}
 c.snapshot.pendingDecision={status:'running',softWait:true};c.snapshot.state='pausing';c.interruptBusy=true;c.render();assert.equal(c.$('interrupt-decision').hidden,false);assert.equal(c.$('interrupt-decision').disabled,true);
});
test('actual lobby sends the captured generation and serializes duplicate interrupt clicks',async()=>{
 const c=fixture();let release,requests=[];
 c.api=async(url,options)=>{requests.push({url,...JSON.parse(options.body)});await new Promise(resolve=>{release=resolve;});return {interrupted:true};};
 c.refresh=async()=>{};c.showError=error=>{throw error;};
 vm.runInContext(source.slice(source.indexOf("$('interrupt-decision').onclick="),source.indexOf('$("menu").onclick')),c);
 const first=c.$('interrupt-decision').onclick();await c.$('interrupt-decision').onclick();assert.equal(requests.length,1);
 assert.deepEqual(requests[0],{url:'/api/app/interrupt-decision',expectedGameId:'game',gameEpoch:'epoch',decisionId:'d-one',generation:3});
 release();await first;assert.equal(c.interruptBusy,false);
});
