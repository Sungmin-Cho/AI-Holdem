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
