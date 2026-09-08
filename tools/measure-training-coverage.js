#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openContained} from './training-store.js';
import {materializeLearningEvaluation} from './training-control.js';
import {referenceAssessmentEligibility,projectReferenceCoverage} from '../shared/reference-coverage.js';
import {V2_REFERENCE_SOURCE} from '../shared/reference.js';
import {loadReferenceDataset} from './preflop-dataset.js';
import {resolvePreflopReference} from '../training/preflop-reference.js';
function fail(message){const e=new Error(message);e.code='COVERAGE_EVIDENCE_INVALID';throw e;}
const read=(root,parts,maxBytes=16*1024*1024)=>JSON.parse(openContained(root,parts,{maxBytes}).toString('utf8'));
/** Offline diagnosis: no locks, migrations, evaluation or profile writes. */
export function measureTrainingCoverage(sessionDir) {
 if(!path.isAbsolute(sessionDir))fail('Absolute session path required');
 const auth=read(sessionDir,['training','.training-authority.json']);
 const journal=openContained(sessionDir,['training','evaluations.jsonl'],{maxBytes:64*1024*1024}).toString('utf8')
  .split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const journalIds=new Set();
 for(const row of journal){if(journalIds.has(row.evaluationId))fail('Duplicate evaluation journal row');journalIds.add(row.evaluationId);
  if(auth.items?.[row.evaluationId]?.payloadSha256!==row.payloadSha256)fail('Journal authority conflict');}
 const snapshots=new Map();
 for(const name of fs.readdirSync(path.join(sessionDir,'hands')).filter(n=>/^hand-\d+\.json$/.test(n)).sort()){
  const record=read(sessionDir,['hands',name]);
  for(const s of record.decisions??[]){if(s.actorId!=='user')continue;
   if(snapshots.has(s.decisionId))fail('Duplicate canonical decision');snapshots.set(s.decisionId,s);}
 }
 const dataset=loadReferenceDataset(V2_REFERENCE_SOURCE);
 const rows=[],seen=new Set();
 for(const item of Object.values(auth.items??{})){
  const e=materializeLearningEvaluation(sessionDir,item),s=snapshots.get(e.decisionId);
  if(!journalIds.has(e.evaluationId)||!s||seen.has(e.decisionId))fail('Missing or conflicting decision/evaluation binding');
  seen.add(e.decisionId);
  const eligible=referenceAssessmentEligibility(e);
  if(!eligible.verified&&e.status==='supported')fail('Source or coverage unavailable');
  if(e.coverage)projectReferenceCoverage(e.coverage);
  const diagnosis=resolvePreflopReference(s,dataset);
  rows.push({decisionId:e.decisionId,street:s.street,forced:s.forced,status:e.status,source:e.source,
   referenceAvailable:eligible.referenceAvailable,exactComparable:eligible.metricEligible,
   primaryReason:diagnosis.code??null,blockers:(diagnosis.coverage?.reasonCodes??[diagnosis.code]).filter(r=>r&&!r.endsWith('_PROJECTED'))});
 }
 const missing=[...snapshots.keys()].filter(id=>!seen.has(id));
 return {schemaVersion:1,complete:missing.length===0,decisions:snapshots.size,evaluated:rows.length,
  preflop:rows.filter(r=>r.street==='preflop').length,postflop:rows.filter(r=>r.street!=='preflop').length,
  supported:rows.filter(r=>r.status==='supported').length,referenceAvailable:rows.filter(r=>r.referenceAvailable).length,
  exactComparable:rows.filter(r=>r.exactComparable).length,forced:rows.filter(r=>r.forced).length,
  missing,blockers:rows.reduce((totals,row)=>{for(const r of row.blockers)totals[r]=(totals[r]??0)+1;return totals;},{}),rows};
}
function main(argv){
 const opts={};for(let i=0;i<argv.length;i+=2){if(!['--session-dir','--out'].includes(argv[i])||!argv[i+1])fail('Use --session-dir ABS --out ABS');opts[argv[i]]=argv[i+1];}
 const session=opts['--session-dir'],out=opts['--out'];
 if(!session||!out||!path.isAbsolute(out))fail('Explicit absolute input and output required');
 const real=fs.realpathSync(session),parent=fs.realpathSync(path.dirname(out));
 if(parent===real||parent.startsWith(real+path.sep))fail('Output must be outside source session');
 const report=measureTrainingCoverage(real);
 fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({complete:report.complete,decisions:report.decisions,evaluated:report.evaluated})+'\n');
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))try{main(process.argv.slice(2));}catch(e){process.stderr.write(`${e.code??'COVERAGE_EVIDENCE_INVALID'}: ${e.message}\n`);process.exitCode=1;}
