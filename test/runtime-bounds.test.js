import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendBoundedMetric,trimHandLog,pruneJoinAttempts} from '../shared/runtime-bounds.js';

test('metrics retain the newest 5000 records and count all discarded history',()=>{
 const state={metrics:Array.from({length:5002},(_,id)=>({id})),metricsDropped:7};
 const result=appendBoundedMetric(state,{id:5002});
 assert.equal(result.metrics.length,5000);assert.equal(result.metrics[0].id,3);assert.equal(result.metrics.at(-1).id,5002);assert.equal(result.metricsDropped,10);
 assert.equal(state.metrics.length,5002);
 assert.deepEqual(appendBoundedMetric({}, {id:0}),{metrics:[{id:0}],metricsDropped:0});
});
test('relay log trimming removes whole oldest hands and always retains the final hand',()=>{
 const log=[{type:'narration',text:'startup'},{type:'hand_start',handNo:1},{type:'narration',text:'x'.repeat(800000)},
  {type:'hand_start',handNo:2},{type:'narration',text:'y'.repeat(400000)}];
 const result=trimHandLog(log);
 assert.equal(result[0].handNo,2);assert.equal(result.length,2);assert.equal(log.length,5);
 assert.deepEqual(trimHandLog([{type:'hand_start',handNo:3},{type:'narration',text:'x'.repeat(1100000)}]).length,2);
 assert.equal(trimHandLog(log.slice(0,2)).length,2);
});
test('join attempt cleanup expires old addresses only above the size threshold',()=>{
 const attempts=new Map(Array.from({length:1025},(_,i)=>[String(i),{start:i<1000?0:59000,count:1}]));
 pruneJoinAttempts(attempts,60001);assert.equal(attempts.size,25);assert.ok(attempts.has('1024'));
 const small=new Map([['old',{start:0,count:1}]]);pruneJoinAttempts(small,90000);assert.equal(small.size,1);
});

test('oversized startup narration is dropped only before the retained current hand',()=>{
 const hand=[{type:'hand_start',handNo:1},{type:'narration',text:'current'}];
 const startup={type:'narration',text:'x'.repeat(1100000)};
 assert.deepEqual(trimHandLog([startup,...hand]),hand);
 assert.deepEqual(trimHandLog([startup]),[startup]);
});
