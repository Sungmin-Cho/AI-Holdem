import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finalScreen,rankPlayers,summarizeHands,graphPoints} from '../server/public/final-summary.js';
test('final screen opens before review and distinguishes final review absence',()=>{
 assert.deepEqual(finalScreen({view:{gameOver:true}}),{open:true,review:'pending'});
 assert.deepEqual(finalScreen({sessionEnded:true}),{open:true,review:'absent'});
 assert.deepEqual(finalScreen({terminal:true,review:'ok'}),{open:true,review:'ready'});
 assert.equal(finalScreen({view:{}}).open,false);
});
test('rank uses complete totals, preserves ties, and omits unknown tournament totals',()=>{
 const seats=[{playerId:'a',name:'A',stack:100,out:false},{playerId:'b',name:'B',stack:120,out:true},{playerId:'c',name:'C',stack:90}];
 const view={seats,mode:'tournament'};
 const fallback=rankPlayers({view,summary:{complete:false,players:[]}});
 assert.deepEqual(fallback.map(row=>row.playerId),['a','c','b']);assert.ok(fallback.every(row=>!Object.hasOwn(row,'net')));
 const cash=rankPlayers({view:{...view,mode:'cash-training',sessionNet:{a:-20,b:10,c:10}}});
 assert.deepEqual(cash.map(row=>[row.playerId,row.rank]),[['b',1],['c',1],['a',3]]);
 const complete=rankPlayers({view,summary:{complete:true,players:seats.map(row=>({...row,net:row.playerId==='a'?30:-15,finalStack:row.stack}))}});
 assert.equal(complete[0].playerId,'a');assert.equal(complete[0].net,30);
});
test('personal best and worst exclude zero hands; top pots and graph handle sparse input',()=>{
 const summary={complete:true,hands:[{handNo:1,potTotal:5,net:{u:0}},{handNo:2,potTotal:30,net:{u:-10}}]};
 const data=summarizeHands(summary,'u');assert.equal(data.best,null);assert.equal(data.worst.handNo,2);assert.equal(data.topPots.length,2);assert.deepEqual(data.series.map(row=>row.value),[0,-10]);
 assert.equal(summarizeHands({complete:false},'u'),null);assert.deepEqual(summarizeHands(summary,null).series,[]);
 assert.deepEqual(graphPoints([]),[]);assert.equal(graphPoints([{value:-10}])[0].x,160);
 for(const point of graphPoints(data.series))assert.ok(Number.isFinite(point.x)&&point.y>=8&&point.y<=92);
});

test('final panel renders safe text, bounded graph labels and only authorized replay controls',async()=>{
 const {paintFinalPanel}=await import('../server/public/final-panel.js');
 const make=tag=>({tag,children:[],attrs:{},textContent:'',classList:{add(){}},
  append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];},
  setAttribute(key,value){this.attrs[key]=value;},addEventListener(type,callback){this[type]=callback;}});
 const prior=globalThis.document;globalThis.document={createElement:make,createElementNS:(_ns,tag)=>make(tag)};
 try {
  const container=make('div'),view={mode:'tournament',seats:[{playerId:'u',name:'<img onerror=alert(1)>',stack:100}]};
  const flatten=node=>[node,...node.children.flatMap(flatten)];
  paintFinalPanel(container,{summary:null,view});
  assert.ok(!flatten(container).some(node=>node.textContent.includes('읽지 못해')));
  assert.ok(flatten(container).some(node=>node.tag==='td'&&node.textContent==='<img onerror=alert(1)>'));
  let replayed;
  const summary={complete:true,players:[{playerId:'u',name:'U',net:5,finalStack:105}],hands:[
    {handNo:1,potTotal:30,net:{u:10}},{handNo:2,potTotal:20,net:{u:-5}}]};
  paintFinalPanel(container,{summary,view,viewer:'u',onReplay:hand=>{replayed=hand;},canReplay:hand=>hand===1});
  let nodes=flatten(container);assert.equal(nodes.filter(node=>node.tag==='svg').length,1);
  assert.match(nodes.find(node=>node.tag==='svg').attrs['aria-label'],/완료 2핸드.*최종 \+5/);
  const buttons=nodes.filter(node=>node.tag==='button');assert.equal(buttons.length,2);buttons[0].click();assert.equal(replayed,1);
  paintFinalPanel(container,{summary,view,viewer:null,onReplay:null});
  nodes=flatten(container);assert.ok(!nodes.some(node=>node.tag==='svg'||node.tag==='button'||node.textContent==='내 요약'));
  paintFinalPanel(container,{summary:{complete:false},view});assert.ok(flatten(container).some(node=>node.textContent.includes('읽지 못해')));
 } finally {if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
});

test('cash results read in the fixed big blind without a meaningless final stack, and every hand point is named', async () => {
 const {paintFinalPanel}=await import('../server/public/final-panel.js');
 const make=tag=>({tag,children:[],attrs:{},textContent:'',className:'',classList:{add(){}},
  append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];},
  setAttribute(key,value){this.attrs[key]=value;},addEventListener(){}});
 const prior=globalThis.document;globalThis.document={createElement:make,createElementNS:(_ns,tag)=>make(tag)};
 try {
  const container=make('div'),flatten=node=>[node,...node.children.flatMap(flatten)];
  const view={mode:'cash-training',blinds:[25,50],seats:[{playerId:'u',name:'나',stack:5000},{playerId:'a',name:'A',stack:5000}],sessionNet:{u:-75,a:75}};
  const summary={complete:true,players:[{playerId:'u',name:'나',net:-75,finalStack:5000},{playerId:'a',name:'A',net:75,finalStack:5000}],hands:[
   {handNo:1,potTotal:150,net:{u:50,a:-50}},{handNo:2,potTotal:300,net:{u:-125,a:125}}]};
  paintFinalPanel(container,{summary,view,viewer:'u',onReplay:()=>{},canReplay:()=>true});
  const nodes=flatten(container);
  assert.deepEqual(nodes.filter(node=>node.tag==='th').map(node=>node.textContent),['순위','이름','증감']);
  const cells=nodes.filter(node=>node.tag==='td').map(node=>node.textContent);
  assert.ok(cells.includes('+1.5 BB')&&cells.includes('−1.5 BB'),JSON.stringify(cells));
  const dots=nodes.filter(node=>node.tag==='circle');
  assert.deepEqual(dots.map(node=>[node.attrs.tabindex,node.attrs['aria-label']]),[['0','핸드 1 누적 +1 BB'],['0','핸드 2 누적 −1.5 BB']]);
  assert.equal(nodes.filter(node=>node.tag==='line'&&node.attrs.class==='final-chart-zero').length,1);
  assert.ok(nodes.some(node=>node.textContent==='핸드 1 · 팟 3 BB'),'pot sizes are formatted, never raw chips');
 } finally {if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
});
