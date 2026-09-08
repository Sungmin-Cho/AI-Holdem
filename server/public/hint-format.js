const LABEL={fold:'폴드',check:'체크',call:'콜',raise:'레이즈'};
export function formatHint(hint) {
  if (!hint) return null;
  if (hint.status!=='supported') return {title:hint.status==='unsupported'?'사전 힌트 미지원':'사전 힌트 일시 불가',
    lines:[hint.code==='HINT_STREET_UNSUPPORTED'?'현재 힌트는 프리플랍만 지원합니다.':'이 상황의 수치 힌트를 제공할 수 없습니다.'],source:''};
  const i=hint.coverage.input,l=i.legal;
  const legalActions=l.canCheck?['check']:['fold','call'];
  if(l.canRaise)legalActions.push('raise');
  const lines=legalActions.map(action=>hint.actions.find(row=>row.action===action)??{action,frequency:0}).map(row=>{
    let label=LABEL[row.action];
    if(row.action==='raise'&&row.raiseToChips===l.maxRaiseToChips)label='올인(레이즈)';
    let line=`${label} ${(row.frequency*100).toFixed(2)}%`;
    if(row.action==='raise' && row.frequency>0) {
      const raise=row.raiseToChips,additional=raise-l.actorBetChips;
      line+=` · 총 ${raise}칩까지 (${(raise/i.bbChips).toFixed(2)} BB), 추가 ${additional}칩`;
      // Reference coverage has no pot: builder/UI receive it from the canonical view.
    }
    return line;
  });
  if(hint.coverage.reasonCodes.includes('STACK_PROJECTED')) lines.push(`스택 투영: 실제 ${i.effectiveStackBb.toFixed(2)} BB → 기준 ${hint.coverage.reference.stackBb} BB`);
  if(hint.coverage.reasonCodes.includes('FACING_SIZE_PROJECTED')) lines.push(`오픈 크기 투영: 실제 ${i.facingRaiseToBb.toFixed(2)} BB → 기준 ${hint.coverage.reference.openRaiseToBb} BB`);
  return {title:hint.coverage.referenceMatch==='projected'?'투영 기준표 참고 · 점수 제외':'기준표 사전 힌트 · 점수 제외',
    lines,source:`${hint.source.id}@${hint.source.version} · 빈도는 승률이나 GTO 정답이 아닙니다.`};
}
export function hintPotPercent(hint,potBefore) {
  const row=hint?.actions?.find(action=>action.action==='raise');
  if(!row)return null;
  const l=hint.coverage.input.legal,denominator=potBefore+l.callAmountChips;
  return Number.isFinite(denominator)&&denominator>0?100*(row.raiseToChips-l.actorBetChips-l.callAmountChips)/denominator:null;
}
/** Local suppression has its own generation: hint-clear has no SSE revision. */
export function createHintState() {
  let generation=0,suppressed=null;
  return {
    capture:()=>generation,
    invalidate(decisionId){generation++;suppressed=decisionId??'*';},
    accept(hint,view,{generation:requestGeneration=generation,canRestore=false}={}) {
      if(requestGeneration!==generation||!hint||view?.legal?.decisionId!==hint.decisionId
        ||view?.legal?.toAct!=='user'||view?.gameOver||view?.handOver)return null;
      if(suppressed==='*'||suppressed===hint.decisionId) {
        if(!canRestore)return null;
        suppressed=null;
      } else if(suppressed) suppressed=null;
      return hint;
    },
  };
}
