import {clampRaiseTo} from './table-controls.js';

export function parseChipInput(text) {
  if(typeof text!=='string') return null;
  const normalized=text.trim();
  if(!/^(?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(normalized)) return null;
  const amount=Number(normalized.replaceAll(',',''));
  return Number.isSafeInteger(amount) ? amount : null;
}
export function createAmountEditor() {
  let state={decisionId:null,text:'',value:0,invalid:false,pendingCorrection:false,confirmedCorrection:false};
  const choose=(value,legal)=>{
    state={...state,value:clampRaiseTo(value,legal),invalid:false,pendingCorrection:false,confirmedCorrection:false};
    state.text=state.value.toLocaleString('ko-KR');return {...state};
  };
  return {
    get state(){return {...state};},
    adopt(legal){if(state.decisionId!==legal.decisionId){state.decisionId=legal.decisionId;choose(legal.minRaiseTo,legal);}return {...state};},
    choose,
    edit(text,legal){
      const n=parseChipInput(text);
      state={...state,text,invalid:n===null || clampRaiseTo(n,legal)!==n,pendingCorrection:false,confirmedCorrection:false};
      if(!state.invalid)state.value=n;
      return {...state};
    },
    commit(legal){
      const n=parseChipInput(state.text);
      if(n===null){state.invalid=true;return {...state};}
      const value=clampRaiseTo(n,legal);
      state={...state,value,text:value.toLocaleString('ko-KR'),invalid:false,pendingCorrection:state.pendingCorrection || value!==n};
      return {...state};
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
