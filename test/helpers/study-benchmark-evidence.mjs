export function completeProofRows(bytes) {
  const rows=bytes.slice(0,bytes.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(JSON.parse);
  for(const row of rows) if(!Number.isSafeInteger(row.pid)||row.pid<=0||!Number.isFinite(row.ms)||row.ms<0
    ||!['acl','identity','create','listener'].includes(row.kind)||typeof row.timedOut!=='boolean'
    ||!(row.status===null||Number.isInteger(row.status))||!(row.phase===null||typeof row.phase==='string')) {
    throw Object.assign(new Error('invalid proof schema'),{code:'BENCHMARK_DIAGNOSTICS_INVALID'});
  }
  return rows;
}

export const BENCHMARK_BASELINE='477728fcc5b5341a8faa7f29499c7f4e19d0e737';
export function evaluatePairedRecords(records,{expectedCandidate}={}) {
  let passed=records.length===6&&records.every(row=>row?.complete===true&&row.passed===true&&row.platform==='win32');
  const valid=records.filter(row=>row&&Array.isArray(row.rows)&&typeof row.label==='string');
  for(const key of ['node','platform','release','image','powershell']) if(new Set(valid.map(row=>row[key])).size!==1) passed=false;
  const sides={};
  for(const label of ['baseline','candidate']) {
    const runs=valid.filter(row=>row.label.startsWith(label+'-'));
    const summary=summarizeStudyRows(runs.flatMap(row=>row.rows));
    if(runs.length!==3||new Set(runs.map(row=>row.sha)).size!==1
      ||new Set(runs.map(row=>row.label)).size!==3||!runs.every(row=>/^[a-f0-9]{40}$/.test(row.sha))) passed=false;
    for(const op of ['cold-ensure','bad-token','stop']) if(summary[op]?.successes!==3) passed=false;
    for(const op of ['warm-ensure','inspect','http-summary']) if(summary[op]?.successes!==30) passed=false;
    for(const op of ['cold-ensure','warm-ensure','inspect','stop']) if(!(summary[op]?.sideTotals.client.calls>0)) passed=false;
    sides[label]={sha:runs[0]?.sha??null,summary};
  }
  if(sides.baseline.sha!==BENCHMARK_BASELINE||sides.baseline.sha===sides.candidate.sha
    ||(expectedCandidate&&sides.candidate.sha!==expectedCandidate)) passed=false;
  return {schemaVersion:1,passed,...sides};
}
export function medianDelta(b,c) {
  return Number.isFinite(b?.medianMs)&&Number.isFinite(c?.medianMs)?c.medianMs-b.medianMs:null;
}
export function summarizeStudyRows(rows) {
  const quantile=(values,q)=>values.sort((a,b)=>a-b)[Math.ceil(values.length*q)-1]??null;
  return Object.fromEntries([...new Set(rows.map(row=>row.operation))].map(operation=>{
    const group=rows.filter(row=>row.operation===operation),ok=group.filter(row=>row.ok);
    const sideTotals=Object.fromEntries(['client','service'].map(side=>{
      const events=group.flatMap(row=>row.proofs).filter(p=>p.side===side);
      return [side,{calls:events.length,cumulativeMs:events.reduce((s,p)=>s+p.ms,0)}];
    }));
    return [operation,{n:group.length,successes:ok.length,failures:group.length-ok.length,
      medianMs:quantile(ok.map(row=>row.ms),0.5),p95Ms:quantile(ok.map(row=>row.ms),0.95),
      maxObservedMs:Math.max(...group.map(row=>row.ms)),sideTotals,
      okProofCalls:ok.reduce((s,row)=>s+row.proofs.length,0),
      proofCalls:group.reduce((s,row)=>s+row.proofs.length,0),
      cumulativeProofMs:group.reduce((s,row)=>s+row.proofs.reduce((n,p)=>n+p.ms,0),0)}];
  }));
}
