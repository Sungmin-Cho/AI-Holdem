import fs from 'node:fs';
import path from 'node:path';
import {summarizeStudyRows} from './study-benchmark-evidence.mjs';
const dir=path.resolve(process.argv[2]??'evidence');
const files=fs.readdirSync(dir).filter(name=>/^(baseline|candidate)-[0-2]\.json$/.test(name));
const records=files.map(name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
let passed=files.length===6&&records.every(row=>row.complete===true&&row.passed===true);
for(const key of ['node','platform','release','image','powershell']) if(new Set(records.map(row=>row[key])).size!==1) passed=false;
const sides={};
for(const label of ['baseline','candidate']) {
  const runs=records.filter(row=>row.label.startsWith(label+'-'));
  const summary=summarizeStudyRows(runs.flatMap(row=>row.rows));
  if(runs.length!==3||new Set(runs.map(row=>row.sha)).size!==1) passed=false;
  for(const op of ['cold-ensure','bad-token','stop']) if(summary[op]?.successes!==3) passed=false;
  for(const op of ['warm-ensure','inspect','http-summary']) if(summary[op]?.successes!==30) passed=false;
  sides[label]={sha:runs[0]?.sha??null,summary};
}
const lines=['## Paired Windows study lifecycle', '',`Complete measurement: ${passed?'PASS':'FAIL / incomplete'}`,'',
  `Baseline: ${sides.baseline.sha}; candidate: ${sides.candidate.sha}`,'',
  '| Operation | Baseline median / p95 ms | Candidate median / p95 ms | Median delta ms | Client proof calls B / C |',
  '|---|---:|---:|---:|---:|'];
const fmt=n=>Number.isFinite(n)?n.toFixed(1):'unavailable';
for(const op of ['cold-ensure','warm-ensure','inspect','http-summary','stop']) {
  const b=sides.baseline.summary[op],c=sides.candidate.summary[op];
  lines.push(`| ${op} | ${fmt(b?.medianMs)} / ${fmt(b?.p95Ms)} | ${fmt(c?.medianMs)} / ${fmt(c?.p95Ms)} | ${fmt(b&&c?c.medianMs-b.medianMs:null)} | ${b?.sideTotals.client.calls??'?'} / ${c?.sideTotals.client.calls??'?'} |`);
}
lines.push('','Success-only percentiles; failures and max observed latency remain in raw evidence. Proof counts include censored rows. Fresh canonical stores, diagnostics enabled, same runner; no cold-OS or user-experience proof. PASS validates measurement completeness, not performance improvement.');
const markdown=lines.join('\n')+'\n';
process.stdout.write(markdown);
if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdown);
fs.writeFileSync(path.join(dir,'paired-summary.json'),JSON.stringify({schemaVersion:1,passed,...sides},null,2));
process.exitCode=passed?0:1;
