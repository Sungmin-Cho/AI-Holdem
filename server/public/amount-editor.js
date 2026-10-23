import {clampRaiseTo} from './table-controls.js';

export function parseChipInput(text) {
  if(typeof text!=='string') return null;
  const normalized=text.trim();
  if(!/^(?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(normalized)) return null;
  const amount=Number(normalized.replaceAll(',',''));
  return Number.isSafeInteger(amount) ? amount : null;
}
const validBb=(bb)=>Number.isSafeInteger(bb) && bb>0;
/** Big blinds with at most two decimals ("2.5", ".5", "1,250.75") to whole
 * chips, half up, in integer arithmetic. Anything else is null, never a guess. */
export function parseBbInput(text,bb) {
  if(typeof text!=='string' || !validBb(bb)) return null;
  const match=/^((?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)?)(?:\.([0-9]{1,2}))?$/.exec(text.trim());
  if(!match || (!match[1] && match[2]===undefined)) return null;
  const hundredths=BigInt(match[1].replaceAll(',','') || '0')*100n+BigInt((match[2] ?? '').padEnd(2,'0'));
  const chips=(hundredths*BigInt(bb)*2n+100n)/200n;
  return chips<=BigInt(Number.MAX_SAFE_INTEGER) ? Number(chips) : null;
}
/** Editor text for chips in big blinds: two decimals at most, trailing zeros
 * dropped, no grouping and no "≈" — the field holds a number to edit. */
export function formatBbInput(chips,bb) {
  const hundredths=(BigInt(chips)*200n+BigInt(bb))/(2n*BigInt(bb));
  const decimals=String(hundredths%100n).padStart(2,'0').replace(/0+$/,'');
  return `${hundredths/100n}${decimals ? `.${decimals}` : ''}`;
}
/** The raise-to field. Amounts are always chips (`value`); the text is in the
 * display unit. Text the editor wrote itself (`dirty` false) is never parsed
 * back, so a preset that is not a whole number of big blinds keeps its chips. */
export function createAmountEditor() {
  let unit={kind:'chips',bb:null};
  let state={decisionId:null,text:'',value:0,invalid:false,dirty:false,pendingCorrection:false,confirmedCorrection:false};
  const render=(value)=>unit.kind==='bb' ? formatBbInput(value,unit.bb) : value.toLocaleString('ko-KR');
  const parse=(text)=>unit.kind==='bb' ? parseBbInput(text,unit.bb) : parseChipInput(text);
  const snapshot=()=>({...state,unit:unit.kind});
  const choose=(value,legal)=>{
    state={...state,value:clampRaiseTo(value,legal),invalid:false,dirty:false,pendingCorrection:false,confirmedCorrection:false};
    state.text=render(state.value);return snapshot();
  };
  const edit=(text,legal)=>{
    const n=parse(text);
    state={...state,text,dirty:true,invalid:n===null || clampRaiseTo(n,legal)!==n,pendingCorrection:false,confirmedCorrection:false};
    if(!state.invalid)state.value=n;
    return snapshot();
  };
  return {
    get state(){return snapshot();},
    /** Follows the display unit; big blinds need this decision's big blind. */
    setUnit(preference,bb,legal){
      const next=preference==='bb' && validBb(bb) ? {kind:'bb',bb} : {kind:'chips',bb:null};
      if(next.kind===unit.kind && next.bb===unit.bb) return snapshot();
      unit=next;
      if(state.decisionId===null) return snapshot();
      if(!state.invalid) state={...state,text:render(state.value),dirty:false};
      else if(legal) {
        const {pendingCorrection,confirmedCorrection}=state;
        edit(state.text,legal);
        state={...state,pendingCorrection,confirmedCorrection};
      }
      return snapshot();
    },
    adopt(legal,preferred){if(state.decisionId!==legal.decisionId){state.decisionId=legal.decisionId;choose(Number.isSafeInteger(preferred)?preferred:legal.minRaiseTo,legal);}return snapshot();},
    choose,
    edit,
    /** Chips for what the field shows: the exact amount for the editor's own text. */
    read(text){return text===state.text && !state.invalid ? state.value : parse(text);},
    commit(legal){
      const n=state.dirty ? parse(state.text) : state.value;
      if(n===null){state.invalid=true;return snapshot();}
      const value=clampRaiseTo(n,legal);
      state={...state,value,text:render(value),invalid:false,dirty:false,pendingCorrection:state.pendingCorrection || value!==n};
      return snapshot();
    },
    submit(legal,{locked=false}={}){
      if(locked)return null;
      this.commit(legal);
      if(state.invalid)return null;
      if(state.pendingCorrection){state.pendingCorrection=false;state.confirmedCorrection=true;return null;}
      state.confirmedCorrection=false;
      return state.value;
    },
  };
}
