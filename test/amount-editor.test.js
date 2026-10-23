import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAmountEditor,parseBbInput,formatBbInput} from '../server/public/amount-editor.js';
import {snapRaiseTo,stepRaiseTo} from '../server/public/table-controls.js';

const legal={decisionId:'d1',minRaiseTo:100,maxRaiseTo:1000};
const bbEditor=()=>{const editor=createAmountEditor();editor.setUnit('bb',50,legal);editor.adopt(legal,125);return editor;};

test('big blinds with up to two decimals convert to whole chips, half up',()=>{
  assert.equal(parseBbInput('2.5',50),125);
  assert.equal(parseBbInput(' 12 ',50),600);
  assert.equal(parseBbInput('.5',50),25);
  assert.equal(parseBbInput('1,250.75',50),62538);
  assert.equal(parseBbInput('2.33',50),117);
  assert.equal(parseBbInput('0',50),0);
  for(const text of ['','.','5.','-1','+1','1e3','1,2','2.555','１２','2.5bb','1,25','12,345,6'])assert.equal(parseBbInput(text,50),null,text);
  for(const bb of [0,-50,2.5,null,undefined])assert.equal(parseBbInput('2',bb),null);
  assert.equal(parseBbInput(String(Number.MAX_SAFE_INTEGER),50),null);
});

test('editor text in big blinds drops trailing zeros and never shows a tilde',()=>{
  assert.equal(formatBbInput(125,50),'2.5');
  assert.equal(formatBbInput(100,50),'2');
  assert.equal(formatBbInput(317,50),'6.34');
  assert.equal(formatBbInput(1267,200),'6.34');
  assert.equal(formatBbInput(62538,50),'1250.76');
});

test('a big-blind editor submits the chips it shows and keeps preset chips exact',()=>{
  const editor=bbEditor();
  assert.equal(editor.state.text,'2.5');assert.equal(editor.state.unit,'bb');
  assert.equal(editor.submit(legal),125);
  // A pot-sized preset is not a whole number of big blinds: its text is rounded,
  // the chips sent are not.
  editor.choose(317,legal);assert.equal(editor.state.text,'6.34');
  editor.commit(legal);assert.equal(editor.state.value,317);assert.equal(editor.submit(legal),317);
});

test('typed big blinds are parsed in the shown unit and re-shown from the chips',()=>{
  const editor=bbEditor();
  editor.edit('2.33',legal);assert.equal(editor.state.invalid,false);assert.equal(editor.state.value,117);
  editor.commit(legal);assert.equal(editor.state.text,'2.34');assert.equal(editor.state.pendingCorrection,false);
  assert.equal(editor.submit(legal),117);
  editor.edit('20',legal);assert.equal(editor.state.value,1000);assert.equal(editor.submit(legal),1000);
});

test('malformed big blinds are never sanitized into legal actions',()=>{
  const editor=bbEditor();
  for(const text of ['-5','1e3','1,2','','１２３','5.','2.555']){
    editor.edit(text,legal);editor.adopt(legal);editor.commit(legal);
    assert.equal(editor.state.text,text);assert.equal(editor.state.invalid,true);assert.equal(editor.submit(legal),null);
  }
});

test('out-of-range big blinds clamp and wait for a second press',()=>{
  const editor=bbEditor();
  editor.edit('100',legal);assert.equal(editor.state.invalid,true);
  editor.commit(legal);assert.equal(editor.state.value,1000);assert.equal(editor.state.text,'20');
  assert.equal(editor.state.pendingCorrection,true);
  assert.equal(editor.submit(legal),null);assert.equal(editor.submit(legal),1000);
  editor.edit('1',legal);editor.commit(legal);assert.equal(editor.state.value,100);
  assert.equal(editor.submit(legal),null);assert.equal(editor.submit(legal),100);
});

test('switching the display unit rewrites a valid amount and re-reads a malformed one',()=>{
  const editor=bbEditor();
  editor.edit('3',legal);
  editor.setUnit('chips',50,legal);assert.equal(editor.state.text,'150');assert.equal(editor.state.value,150);
  editor.setUnit('bb',50,legal);assert.equal(editor.state.text,'3');
  // Invalid in chips, valid in big blinds: the raw text is kept and judged in the new unit.
  editor.setUnit('chips',50,legal);editor.edit('2.5',legal);assert.equal(editor.state.invalid,true);
  editor.setUnit('bb',50,legal);assert.equal(editor.state.text,'2.5');assert.equal(editor.state.invalid,false);
  assert.equal(editor.state.value,125);assert.equal(editor.submit(legal),125);
  // No big blind to convert with: chips.
  editor.setUnit('bb',null,legal);assert.equal(editor.state.unit,'chips');assert.equal(editor.state.text,'125');
});

test('an amount that does not survive a round trip through big blinds is still sent exact',()=>{
  const wide={decisionId:'d2',minRaiseTo:300,maxRaiseTo:30000};
  const editor=createAmountEditor();editor.setUnit('bb',300,wide);editor.adopt(wide,317);
  // 317 / 300 = 1.0567 BB: shown as 1.06, which would parse back to 318.
  assert.equal(editor.state.text,'1.06');assert.equal(parseBbInput('1.06',300),318);
  editor.commit(wide);editor.adopt(wide);assert.equal(editor.submit(wide),317);
  editor.setUnit('chips',300,wide);editor.setUnit('bb',300,wide);assert.equal(editor.submit(wide),317);
  // Typing the shown text is an edit: it is read in big blinds.
  editor.edit('1.06',wide);assert.equal(editor.submit(wide),318);
});

test('switching the unit keeps a pending or confirmed clamp',()=>{
  const editor=bbEditor();
  editor.edit('100',legal);editor.commit(legal);assert.equal(editor.state.pendingCorrection,true);
  editor.setUnit('chips',50,legal);assert.equal(editor.state.pendingCorrection,true);assert.equal(editor.state.text,'1,000');
  assert.equal(editor.submit(legal),null);assert.equal(editor.state.confirmedCorrection,true);
  editor.setUnit('bb',50,legal);assert.equal(editor.state.confirmedCorrection,true);assert.equal(editor.state.text,'20');
  assert.equal(editor.submit(legal),1000);
});

test('reading the field returns the exact chips for the editor text and parses anything else',()=>{
  const editor=bbEditor();
  editor.choose(317,legal);
  assert.equal(editor.read('6.34'),317);
  assert.equal(editor.read('6.5'),325);
  assert.equal(editor.read('abc'),null);
});

test('slider values snap to half big blinds between exact legal ends',()=>{
  const wide={minRaiseTo:100,maxRaiseTo:4987};
  assert.equal(snapRaiseTo(130,wide,50),125);
  assert.equal(snapRaiseTo(4980,wide,50),4975);
  assert.equal(snapRaiseTo(4987,wide,50),4987);
  assert.equal(snapRaiseTo(9999,wide,50),4987);
  assert.equal(snapRaiseTo(90,wide,50),100);
  assert.equal(snapRaiseTo(110,wide,50),100);
  assert.equal(snapRaiseTo(40,{minRaiseTo:30,maxRaiseTo:500},25),38);
  assert.equal(snapRaiseTo('x',wide,50),100);
});

test('slider keys move one half big blind at a time and reach the exact ends',()=>{
  const wide={minRaiseTo:100,maxRaiseTo:4987};
  assert.equal(stepRaiseTo(125,wide,50,1),150);
  assert.equal(stepRaiseTo(125,wide,50,-1),100);
  assert.equal(stepRaiseTo(130,wide,50,1),150);
  assert.equal(stepRaiseTo(130,wide,50,-1),125);
  assert.equal(stepRaiseTo(4975,wide,50,1),4987);
  assert.equal(stepRaiseTo(4987,wide,50,-1),4975);
  assert.equal(stepRaiseTo(4987,wide,50,1),4987);
  assert.equal(stepRaiseTo(100,wide,50,-1),100);
  // Odd big blind: half steps round to chips and always move.
  const odd={minRaiseTo:30,maxRaiseTo:500};
  assert.equal(stepRaiseTo(38,odd,25,-1),30);
  assert.equal(stepRaiseTo(38,odd,25,1),50);
  assert.equal(stepRaiseTo(37,odd,25,1),38);
  let at=30,seen=[];for(let i=0;i<5;i++){at=stepRaiseTo(at,odd,25,1);seen.push(at);}
  assert.deepEqual(seen,[38,50,63,75,88]);
});
