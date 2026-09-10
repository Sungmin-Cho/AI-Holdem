import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {completeProofRows,summarizeStudyRows,evaluatePairedRecords,BENCHMARK_BASELINE,medianDelta} from './helpers/study-benchmark-evidence.mjs';
test('benchmark evidence tolerates only an incomplete final diagnostic row',()=>{
  const proof={pid:1,kind:'acl',ms:1,status:0,timedOut:false,phase:null};
  assert.deepEqual(completeProofRows(JSON.stringify(proof)+'\n{"ms":'),[proof]);
  assert.throws(()=>completeProofRows('{bad}\n'));
  assert.throws(()=>completeProofRows('{"ms":1}\n'),{code:'BENCHMARK_DIAGNOSTICS_INVALID'});
});

test('paired evidence refuses missing, mismatched or empty Windows proof data',()=>{
  const records=['baseline','candidate'].flatMap(label=>Array.from({length:3},(_,rep)=>({
    label:label+'-'+rep,sha:label==='baseline'?BENCHMARK_BASELINE:'a'.repeat(40),complete:true,passed:true,
    node:'v22',platform:'win32',release:'win',image:'runner1',powershell:'5.1',
    rows:['cold-ensure','bad-token','stop','warm-ensure','inspect','http-summary'].flatMap(operation=>
      Array.from({length:['warm-ensure','inspect','http-summary'].includes(operation)?10:1},()=>({
        operation,ok:true,ms:1,proofs:[{side:'client',ms:1}]})))})));
  assert.equal(evaluatePairedRecords(records).passed,true);
  assert.equal(evaluatePairedRecords(records.slice(1)).passed,false);
  assert.equal(evaluatePairedRecords([...records.slice(1),null]).passed,false);
  for(const change of [r=>{r[0].node='v20';},r=>{r[0].image='other';},r=>{r[0].sha='b'.repeat(40);},
    r=>{for(const row of r) row.platform='darwin';},r=>{for(const row of r)row.sha=BENCHMARK_BASELINE;},
    r=>{for(const row of r)for(const op of row.rows)op.proofs=[];}]) {
    const copy=structuredClone(records);change(copy);assert.equal(evaluatePairedRecords(copy).passed,false);
  }
  assert.equal(evaluatePairedRecords(records,{expectedCandidate:'b'.repeat(40)}).passed,false);
  assert.equal(medianDelta({medianMs:null},{medianMs:null}),null);
  assert.equal(medianDelta({medianMs:10},{medianMs:8}),-2);
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

test('report CLI preserves fail-closed output for truncated evidence instead of false zero delta',()=>{
  const root=createOwnedTempDir('holdem-benchmark-report');
  fs.writeFileSync(path.join(root,'baseline-0.json'),'{"complete":');
  const env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.GITHUB_STEP_SUMMARY;
  const result=spawnSync(process.execPath,['test/helpers/report-study-benchmark.mjs',root],{encoding:'utf8',env,timeout:5000});
  assert.equal(result.status,1);
  assert.match(result.stdout,/FAIL \/ incomplete/);assert.match(result.stdout,/unavailable/);
  assert.equal(result.stderr,'');assert.equal(result.stdout.includes(root),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'paired-summary.json'))).passed,false);
});
