import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregatePot,showPotBreakdown,logBlindContexts} from '../server/public/table-presentation.js';
import {createAmountEditor,parseChipInput} from '../server/public/amount-editor.js';
test('pot layers are totals live and breakdown only after settlement',()=>{
  const view={handNo:1,handInProgress:true,pots:[{amount:50},{amount:25}],legal:{potTotal:75}};
  assert.equal(aggregatePot(view).total,75);assert.equal(showPotBreakdown(view),false);
  assert.equal(showPotBreakdown({...view,handInProgress:false}),true);
  assert.equal(aggregatePot({...view,pots:[]}).kind,'unavailable');
  assert.equal(aggregatePot({...view,legal:{potTotal:100}}).kind,'mismatch');
  assert.equal(showPotBreakdown({...view,handInProgress:undefined}),false);
});
test('historical log contexts never substitute current blinds',()=>{
  assert.deepEqual(logBlindContexts([{type:'hand_start',handNo:1,blinds:[25,50]},{type:'action'},{type:'level_up'},{type:'hand_start',handNo:2,blinds:[50,100]},{type:'action'}]),[50,50,50,100,100]);
  assert.deepEqual(logBlindContexts([{type:'hand_start',handNo:1,blinds:[25,50]}],{1:{blinds:[50,100]}}),[null]);
});
test('amount editor never sanitizes malformed amounts into legal actions',()=>{
  const legal={decisionId:'d1',minRaiseTo:100,maxRaiseTo:1000};const editor=createAmountEditor();editor.adopt(legal);
  for(const text of ['2.5','-5','1e3','1,2','','１２３']){
    editor.edit(text,legal);editor.adopt(legal);editor.commit(legal);
    assert.equal(editor.state.text,text);assert.equal(editor.submit(legal),null);
  }
  assert.equal(parseChipInput('1,250'),1250);assert.equal(parseChipInput('007'),7);
  editor.choose(200,legal);assert.equal(editor.submit(legal),200);
});
test('clamp confirmation survives blur and same-decision repaint and locked receipts',()=>{
  const legal={decisionId:'d1',minRaiseTo:100,maxRaiseTo:1000};const editor=createAmountEditor();editor.adopt(legal);
  editor.edit('5000',legal);editor.commit(legal);editor.adopt(legal);
  assert.equal(editor.state.pendingCorrection,true);
  assert.equal(editor.submit(legal,{locked:true}),null);assert.equal(editor.state.pendingCorrection,true);
  assert.equal(editor.submit(legal),null);assert.equal(editor.submit(legal),1000);
  editor.edit('5000',legal);editor.commit(legal);editor.choose(500,legal);assert.equal(editor.submit(legal),500);
});
