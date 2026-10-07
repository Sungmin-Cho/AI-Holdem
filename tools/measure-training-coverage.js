#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openContained} from './training-store.js';
import {materializeLearningEvaluation} from './training-control.js';
import {independentAssessmentEligibility} from '../shared/assistance.js';
import {referenceAssessmentEligibility,projectCoverageFor} from '../shared/reference-coverage.js';
import {V2_REFERENCE_SOURCE,V3_REFERENCE_SOURCE,isCoverageReferenceSource,referenceQuality,sameReferenceSource} from '../shared/reference.js';
import {loadReferenceDataset} from './preflop-dataset.js';
import {resolvePreflopReference} from '../training/preflop-reference.js';
import {evaluatePreflopReferenceV3} from '../training/preflop-reference-v3.js';
import {newDeck} from '../engine/cards.js';
import {snapshotDecision} from '../engine/decision.js';
import {applyAction,blindsForLevel,createGame,legalFor,startHand} from '../engine/hand.js';
import {seedFrom,xorshift32} from '../shared/poker-eval.js';
import {distributionV3} from '../training/policies/strategy-v3.js';
import {PERSONA_ARCHETYPES_V3,personaConfigV3} from '../training/policies/personas-v3.js';
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
 const datasets=new Map();
 const datasetFor=source=>{const known=sameReferenceSource(source,V3_REFERENCE_SOURCE)?V3_REFERENCE_SOURCE:V2_REFERENCE_SOURCE;
  if(!datasets.has(known.version))datasets.set(known.version,loadReferenceDataset(known));return datasets.get(known.version);};
 const rows=[],seen=new Set();
 for(const item of Object.values(auth.items??{})){
  const e=materializeLearningEvaluation(sessionDir,item),s=snapshots.get(e.decisionId);
  if(!journalIds.has(e.evaluationId)||!s||seen.has(e.decisionId))fail('Missing or conflicting decision/evaluation binding');
  seen.add(e.decisionId);
  const eligible=referenceAssessmentEligibility(e);
  if(!eligible.verified&&e.status==='supported'&&referenceQuality(e.source).quality!=='synthetic')fail('Source or coverage unavailable');
  if(e.coverage)projectCoverageFor(isCoverageReferenceSource(e.source)?e.source:V2_REFERENCE_SOURCE,e.coverage);
  const dataset=datasetFor(e.source);
  // The diagnosis uses the session's own reference: v3 reports its coverage reasons.
  const diagnosis=dataset.data.schemaVersion===3?evaluatePreflopReferenceV3(s,dataset,{gameEpoch:'00'.repeat(32)}):resolvePreflopReference(s,dataset);
  rows.push({decisionId:e.decisionId,street:s.street,forced:s.forced,status:e.status,source:e.source,
   referenceAvailable:eligible.referenceAvailable,exactComparable:eligible.metricEligible,independentExact:independentAssessmentEligibility(e).metricEligible,
   primaryReason:diagnosis.code??null,blockers:(diagnosis.coverage?.reasonCodes??[diagnosis.code]).filter(r=>r&&!r.endsWith('_PROJECTED'))});
 }
 const missing=[...snapshots.keys()].filter(id=>!seen.has(id));
 return {schemaVersion:1,complete:missing.length===0,decisions:snapshots.size,evaluated:rows.length,
  preflop:rows.filter(r=>r.street==='preflop').length,postflop:rows.filter(r=>r.street!=='preflop').length,
  supported:rows.filter(r=>r.status==='supported').length,synthetic:rows.filter(r=>referenceQuality(r.source).quality==='synthetic').length,referenceAvailable:rows.filter(r=>r.referenceAvailable).length,
  exactComparable:rows.filter(r=>r.exactComparable).length,independentExact:rows.filter(r=>r.independentExact).length,forced:rows.filter(r=>r.forced).length,
  missing,blockers:rows.reduce((totals,row)=>{for(const r of row.blockers)totals[r]=(totals[r]??0)+1;return totals;},{}),rows};
}
/** G4: how many of a learner's decisions the v3 reference compares exactly. The
 * learner plays the TAG v3 persona against shuffled v3 personas; every user
 * decision counts, postflop included. Tournaments restart when one player is left. */
export function simulateCoverage({mode='cash-training',seats=6,hands=2000,seed='g4'}={}) {
 const dataset=loadReferenceDataset(V3_REFERENCE_SOURCE);
 const next=xorshift32(seedFrom(`coverage:${seed}`));
 const shuffled=items=>{const copy=[...items];for(let i=copy.length-1;i>0;i--){const j=next()%(i+1);[copy[i],copy[j]]=[copy[j],copy[i]];}return copy;};
 const pick=(items,unit)=>{let acc=0;for(const item of items){acc+=item.frequency;if(unit<acc)return item;}return items.at(-1);};
 const learner=personaConfigV3('TAG');
 const totals={decisions:0,preflop:0,exact:0,projected:0,reasons:{}};
 let played=0;
 while(played<hands){
  const cash=mode==='cash-training';
  let state=createGame(cash?{aiCount:seats-1,startStack:10000,blinds0:[50,100],mode,levelEvery:null,startStackBb:100,handLimit:hands-played+1}
   :{aiCount:seats-1,levelEvery:10});
  const personas=Object.fromEntries(state.seats.filter(s=>s.playerId!=='user').map((s,i)=>[s.playerId,personaConfigV3(shuffled(PERSONA_ARCHETYPES_V3)[i%6])]));
  while(played<hands&&!state.gameOver){
   const started=startHand(state,{deck:shuffled(newDeck())});state=started.state;if(state.gameOver||!state.hand)break;
   played+=1;
   while(state.hand&&!legalFor(state).handOver){
    const legal=legalFor(state),pid=legal.toAct;
    const blinds=blindsForLevel(state.level,state.config.blinds0);
    const snapshot=snapshotDecision(state,pid,null,{blinds,legal});
    const picked=pick(distributionV3(snapshot,legal,pid==='user'?learner:personas[pid]),next()/4294967296);
    if(pid==='user'){
     totals.decisions+=1;
     if(snapshot.street==='preflop'){
      totals.preflop+=1;
      const chosen={...snapshot,chosenAction:{action:picked.action,amount:picked.action==='raise'?picked.amount:picked.action==='call'?legal.callAmount:0}};
      const e=evaluatePreflopReferenceV3(chosen,dataset,{gameEpoch:'00'.repeat(32)});
      if(e.coverage?.metricEligible&&e.status==='supported')totals.exact+=1;
      else {
       if(e.coverage?.referenceMatch==='projected')totals.projected+=1;
       for(const r of e.coverage?.reasonCodes?.length?e.coverage.reasonCodes:[e.code??'UNSUPPORTED_SPOT'])totals.reasons[r]=(totals.reasons[r]??0)+1;
      }
     }
    }
    state=applyAction(state,pid,picked.action,picked.action==='raise'?picked.amount:undefined).state;
   }
  }
 }
 return {mode,seats,hands:played,...totals,exactShare:totals.decisions?totals.exact/totals.decisions:0,
  preflopExactShare:totals.preflop?totals.exact/totals.preflop:0};
}
function main(argv){
 if(argv[0]==='--simulate'){
  const out={cash6:simulateCoverage({mode:'cash-training',seats:6,hands:Number(argv[1]??2000)}),
   tournament9:simulateCoverage({mode:'tournament',seats:9,hands:Number(argv[1]??2000),seed:'g4t'})};
  process.stdout.write(JSON.stringify(out,null,2)+'\n');return;
 }
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
