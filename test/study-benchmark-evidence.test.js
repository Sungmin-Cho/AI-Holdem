import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeProofRows,summarizeStudyRows} from './helpers/study-benchmark-evidence.mjs';
test('benchmark evidence tolerates only an incomplete final diagnostic row',()=>{
  assert.deepEqual(completeProofRows('{"ms":1}\n{"ms":'),[{ms:1}]);
  assert.throws(()=>completeProofRows('{bad}\n'));
});
test('benchmark summary retains censored denominator and separates proof sides',()=>{
  const rows=Array.from({length:10},(_,i)=>({operation:'inspect',ok:true,ms:i+1,proofs:[{side:'client',ms:2}]}));
  rows.push({operation:'inspect',ok:false,ms:60,proofs:[{side:'service',ms:5}]});
  const s=summarizeStudyRows(rows).inspect;
  assert.equal(s.n,11);assert.equal(s.successes,10);assert.equal(s.failures,1);
  assert.equal(s.medianMs,5);assert.equal(s.p95Ms,10);assert.equal(s.maxObservedMs,60);
  assert.equal(s.proofCalls,11);assert.equal(s.okProofCalls,10);
  assert.deepEqual(s.sideTotals,{client:{calls:10,cumulativeMs:20},service:{calls:1,cumulativeMs:5}});
});
