import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createJevRuntime} from '../tools/jev-runtime.js';
const candidates=[{key:'fold',action:'fold'},{key:'call',action:'call'}];
const response={model:'jev-1.13.0',answers:{action:{type:'choice',choice:'call',confidence:1,probabilities:{fold:0,call:1}}},usage:{input_tokens:1,output_tokens:1}};
test('real installed SDK uses official URL, explicit model, no retry, safe logging and redirect policy',async()=>{
 let calls=0;
 const rt=createJevRuntime({env:{TYPESAFE_API_KEY:'  synthetic  ',TYPESAFE_BASE_URL:'https://invalid.example',TYPESAFE_LOG_LEVEL:'debug'},fetch:async(url,options)=>{
 calls++; assert.equal(String(url),'https://api.typesafe.ai/v1/systemone');assert.equal(options.redirect,'error');
 assert.equal(new Headers(options.headers).get('authorization'),'Bearer synthetic');
 const body=JSON.parse(options.body);assert.equal(body.model,'jev-1.13.0');assert.equal(body.questions.action.type,'choice');
 return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});
 }});
 assert.equal(calls,0);assert.equal((await rt.decide({state:{},candidates,timeoutMs:1000})).action.action,'call');assert.equal(calls,1);await rt.dispose();await rt.dispose();
 await assert.rejects(rt.decide({state:{},candidates,timeoutMs:1000}),{code:'JEV_RUNTIME_UNAVAILABLE'});
});
test('SDK error never exposes body/message and never retries',async()=>{
 let calls=0;const rt=createJevRuntime({env:{TYPESAFE_API_KEY:'synthetic'},fetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:'SECRET'}}),{status:429});}});
 await assert.rejects(rt.decide({state:{},candidates,timeoutMs:1000}),e=>e.code==='JEV_RATE_LIMITED'&&!JSON.stringify(e).includes('SECRET'));
 assert.equal(calls,1);await rt.dispose();
});
test('actual SDK abort settles; concurrent call rejected',async()=>{
 const controller=new AbortController();let fetched;
 const ready=new Promise(r=>{fetched=r;});
 const rt=createJevRuntime({env:{TYPESAFE_API_KEY:'synthetic'},fetch:async(url,{signal})=>{fetched();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('SECRET','AbortError')),{once:true}));}});
 const decision=rt.decide({state:{},candidates,signal:controller.signal,timeoutMs:1000});await ready;
 await assert.rejects(rt.decide({state:{},candidates,timeoutMs:1000}),{code:'JEV_RUNTIME_UNAVAILABLE'});controller.abort();
 await assert.rejects(decision,e=>e.code==='INTERRUPTED'&&e.closeConfirmed===true);assert.equal(rt.phase,'idle');await rt.dispose();
});
test('nonsettling request revokes application, bounded disposal, late settlement observer',async()=>{
 let resolve,late=0;const controller=new AbortController();
 const rt=createJevRuntime({client:{systemOne:()=>new Promise(r=>{resolve=r;})},graceMs:20,onLateSettlement:()=>{late++;}});
 const pending=rt.decide({state:{},candidates,signal:controller.signal,timeoutMs:1000});controller.abort();
 await assert.rejects(pending,{code:'JEV_REQUEST_CLOSE_UNCONFIRMED',closeConfirmed:false});
 await assert.rejects(rt.dispose(),{code:'JEV_REQUEST_CLOSE_UNCONFIRMED'});resolve(response);await new Promise(r=>setTimeout(r,0));
 assert.equal(late,1);assert.equal(rt.phase,'disposed');
});
