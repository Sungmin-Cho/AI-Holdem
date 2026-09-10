export function completeProofRows(bytes) {
  return bytes.slice(0,bytes.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(JSON.parse);
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
