import fs from 'node:fs';
import path from 'node:path';
import {evaluatePairedRecords,medianDelta} from './study-benchmark-evidence.mjs';
function main() {
const dir=path.resolve(process.argv[2]??'evidence');
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(name=>/^(baseline|candidate)-[0-2]\.json$/.test(name)):[];
const records=files.map(name=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch{return null;}});
let result;
try {result=evaluatePairedRecords(records,{expectedCandidate:process.env.BENCHMARK_CANDIDATE_SHA});}
catch {result={schemaVersion:1,passed:false,baseline:{sha:null,summary:{}},candidate:{sha:null,summary:{}}};}
const {passed,...sides}=result;
const lines=['## Paired Windows study lifecycle', '',`Complete measurement: ${passed?'PASS':'FAIL / incomplete'}`,'',
  `Baseline: ${sides.baseline.sha}; candidate: ${sides.candidate.sha}`,'',
  '| Operation | Baseline median / p95 ms | Candidate median / p95 ms | Median delta ms | Client proof calls B / C |',
  '|---|---:|---:|---:|---:|'];
const fmt=n=>Number.isFinite(n)?n.toFixed(1):'unavailable';
for(const op of ['cold-ensure','warm-ensure','inspect','http-summary','stop']) {
  const b=sides.baseline.summary[op],c=sides.candidate.summary[op];
  lines.push(`| ${op} | ${fmt(b?.medianMs)} / ${fmt(b?.p95Ms)} | ${fmt(c?.medianMs)} / ${fmt(c?.p95Ms)} | ${fmt(medianDelta(b,c))} | ${b?.sideTotals.client.calls??'?'} / ${c?.sideTotals.client.calls??'?'} |`);
}
lines.push('','Success-only percentiles; failures and max observed latency remain in raw evidence. Proof counts include censored rows. Fresh canonical stores, diagnostics enabled, same runner; no cold-OS or user-experience proof. PASS validates measurement completeness, not performance improvement.');
const markdown=lines.join('\n')+'\n';
process.stdout.write(markdown);
if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdown);
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'paired-summary.json'),JSON.stringify(result,null,2));
process.exitCode=passed?0:1;
}
if(!process.env.NODE_TEST_CONTEXT) main();
