import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {selectJevAction,PRUNE_FLOOR} from '../tools/jev-player.js';
import {deriveUnit} from '../training/policies/rng.js';

const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/jev-distributions-2026-09-22.json',import.meta.url),'utf8'));
const candidatesOf=probabilities=>Object.keys(probabilities).map(key=>key.startsWith('raise_to_')
 ?{key,action:'raise',amount:Number(key.slice('raise_to_'.length))}:{key,action:key});
const argmaxKey=probabilities=>Object.entries(probabilities).reduce((best,e)=>e[1]>best[1]?e:best)[0];
const select=(probabilities,unit,apiChoice=argmaxKey(probabilities))=>selectJevAction({probabilities,candidates:candidatesOf(probabilities),unit,apiChoice});
const SELECTION_KEYS=['rule','unit','classMass','pruned','sampled','sizeRule','selectedKey','apiChoice'];
const classOf=key=>key.startsWith('raise_to_')?'raise':key;
// Independent weighted-median reference: integer hundredths, doubled comparison, no floats.
function referenceMedian(probabilities){
 const raises=Object.entries(probabilities).filter(([k])=>k.startsWith('raise_to_'))
  .map(([k,p])=>({key:k,amount:Number(k.slice(9)),h:Math.round(p*100)})).sort((a,b)=>a.amount-b.amount);
 const total=raises.reduce((s,r)=>s+r.h,0);let acc=0;
 for(const r of raises){acc+=r.h;if(2*acc>=total)return r.key;}
 return raises.at(-1).key;
}

test('class mass sums raise sizes, prunes below the floor and samples the class with a fixed order',()=>{
 const probabilities={fold:.03,call:.89,raise_to_100:.03,raise_to_150:.04,raise_to_200:.01,raise_to_5000:0};
 const low=select(probabilities,0.5,'call');
 assert.deepEqual(low.selection.classMass,{fold:.03,call:.89,raise:.08});
 assert.deepEqual(low.selection.pruned,['fold']);
 assert.equal(low.selection.sampled,'call');assert.deepEqual(low.action,{action:'call'});
 const high=select(probabilities,0.95,'call');
 assert.equal(high.selection.sampled,'raise');assert.equal(high.selection.selectedKey,'raise_to_150');
 assert.deepEqual(high.action,{action:'raise',amount:150});
 assert.equal(PRUNE_FLOOR,0.05);
});
test('AA split-vote regression picks the weighted median size, never the all-in argmax',()=>{
 const probabilities={fold:.02,call:.08,raise_to_350:.05,raise_to_600:.22,raise_to_800:.22,raise_to_5000:.41};
 const raised=select(probabilities,0.99,'raise_to_5000');
 assert.equal(raised.selection.sampled,'raise');assert.equal(raised.selection.selectedKey,'raise_to_800');
 assert.deepEqual(raised.action,{action:'raise',amount:800});
 assert.equal(select(probabilities,.08/.98-1e-9,'raise_to_5000').selection.sampled,'call');
 assert.equal(select(probabilities,.08/.98+1e-9,'raise_to_5000').selection.sampled,'raise');
});
test('tie keeps the API label only as evidence and samples by unit',()=>{
 const probabilities={fold:.5,call:.5};
 assert.equal(select(probabilities,.49,'call').selection.sampled,'fold');
 const tied=select(probabilities,.5,'call');assert.equal(tied.selection.sampled,'call');assert.equal(tied.selection.apiChoice,'call');
 assert.equal(select(probabilities,.49,'fold').selection.apiChoice,'fold');
 assert.equal(select(probabilities,0,'call').selection.sampled,'fold');
 assert.equal(select(probabilities,1-Number.EPSILON,'call').selection.sampled,'call');
});
test('check plus raises samples raise and takes the median size',()=>{
 const r=select({check:.54,raise_to_50:.12,raise_to_1500:.23,raise_to_2250:.11},.6,'check');
 assert.equal(r.selection.selectedKey,'raise_to_1500');assert.deepEqual(r.action,{action:'raise',amount:1500});
});
test('no pruning keeps the fixed [fold, check, call, raise] cumulative order',()=>{
 const probabilities={fold:.2,call:.3,raise_to_100:.25,raise_to_200:.25};
 assert.deepEqual(select(probabilities,.19).selection.sampled,'fold');
 assert.deepEqual(select(probabilities,.21).selection.sampled,'call');
 assert.deepEqual(select(probabilities,.49).selection.sampled,'call');
 assert.deepEqual(select(probabilities,.51).selection.sampled,'raise');
 assert.deepEqual(select({check:.3,raise_to_100:.7},.29).selection.sampled,'check');
 assert.deepEqual(select({check:.3,raise_to_100:.7},.3).selection.sampled,'raise');
});
test('exact boundaries: renormalized 0.99 sum, floor edges, exact half median and zero candidates',()=>{
 const boundary=.20/.99;
 assert.equal(select({fold:.20,call:.79},boundary-1e-12,'call').selection.sampled,'fold');
 assert.equal(select({fold:.20,call:.79},boundary,'call').selection.sampled,'call');
 assert.equal(select({fold:.20,call:.79},boundary+1e-12,'call').selection.sampled,'call');
 assert.deepEqual(select({fold:.049,call:.951},.01,'call').selection.pruned,['fold']);
 assert.deepEqual(select({fold:.05,call:.95},.01,'call').selection.pruned,[]);
 assert.equal(select({fold:.05,call:.95},.01,'call').selection.sampled,'fold');
 assert.deepEqual(select({fold:.051,call:.949},.01,'call').selection.pruned,[]);
 const half=select({call:.5,raise_to_100:.25,raise_to_300:.25},.99,'call');
 assert.equal(half.selection.selectedKey,'raise_to_100');
 const zeros=select({call:.3,raise_to_100:0,raise_to_200:.7,raise_to_300:0},.99,'raise_to_200');
 assert.equal(zeros.selection.selectedKey,'raise_to_200');
 const leadingZero=select({call:.2,raise_to_100:0,raise_to_300:.4,raise_to_500:.4},.99,'raise_to_300');
 assert.equal(leadingZero.selection.selectedKey,'raise_to_300');
 // A zero-probability size is still a candidate and still a legal key in classMass input.
 assert.equal(select({call:.9,raise_to_100:0,raise_to_200:.1},.99,'call').selection.selectedKey,'raise_to_200');
});
test('recorded 230 distributions: grid frequencies, floor, median, regression cases and output shape',()=>{
 assert.equal(fixture.entries.length,230);
 for(const entry of fixture.entries){
  const p=entry.probabilities;const mass={};
  for(const [k,v] of Object.entries(p))mass[classOf(k)]=(mass[classOf(k)]??0)+v;
  const kept=Object.entries(mass).filter(([,v])=>v>=PRUNE_FLOOR-1e-9);const keptTotal=kept.reduce((s,[,v])=>s+v,0);
  const counts={};
  for(let i=0;i<100;i++){
   const out=select(p,(i+.5)/100);const s=out.selection;
   assert.deepEqual(Object.keys(s),SELECTION_KEYS);
   assert.equal(s.rule,'class-sample-v1');assert.equal(s.sizeRule,'weighted-median');
   assert.ok(Object.hasOwn(p,s.selectedKey));assert.equal(classOf(s.selectedKey),s.sampled);
   assert.ok(mass[s.sampled]>=PRUNE_FLOOR-1e-9,`${entry.decisionId} sampled a pruned class`);
   if(s.sampled==='raise')assert.equal(s.selectedKey,referenceMedian(p),entry.decisionId);
   counts[s.sampled]=(counts[s.sampled]??0)+1;
  }
  for(const [cls,v] of kept)assert.ok(Math.abs((counts[cls]??0)/100-v/keptTotal)<=0.01+1e-9,`${entry.decisionId} ${cls}`);
 }
 const find=(id,archetype)=>{const rows=fixture.entries.filter(e=>e.decisionId===id&&e.archetype===archetype);assert.equal(rows.length,1);return rows[0];};
 const aa=find('d-2-preflop-5','Trickster');assert.equal(select(aa.probabilities,.99).selection.selectedKey,'raise_to_800');
 const turn=find('d-19-turn-6','TAG');const m=select(turn.probabilities,.5).selection.classMass;
 assert.ok(m.raise>m.check);assert.equal(m.raise,.57);assert.equal(m.check,.43);
});
test('input defence rejects mismatched keys, bad unit, empty candidates and a non-candidate API label',()=>{
 const probabilities={fold:.2,call:.8},candidates=candidatesOf(probabilities);
 const bad=args=>assert.throws(()=>selectJevAction({probabilities,candidates,unit:.5,apiChoice:'call',...args}),{code:'JEV_INPUT_INVALID'});
 bad({probabilities:{fold:.2,call:.7,extra:.1}});bad({probabilities:{call:1}});bad({unit:1});bad({unit:-0.1});bad({unit:NaN});bad({unit:'0.5'});
 bad({candidates:[],probabilities:{}});bad({apiChoice:'raise_to_100'});bad({apiChoice:undefined});
 bad({probabilities:{fold:-0.1,call:1.1}});
});
test('selection unit is derived per generation and keeps the existing rng contract',()=>{
 const one=deriveUnit('jev-selection-v1','epoch','d-1-preflop-0','1');
 assert.equal(one,deriveUnit('jev-selection-v1','epoch','d-1-preflop-0','1'));
 assert.notEqual(one,deriveUnit('jev-selection-v1','epoch','d-1-preflop-0','2'));
 assert.ok(one>=0&&one<1);
 assert.throws(()=>deriveUnit('jev-selection-v1','','d-1-preflop-0','1'),{code:'POLICY_RNG_INVALID'});
});

// #234: the 16 v2-gate violations (class masses only, from the v2 gate log; no cards). A = raise
// all-in (commit), C = call-off (commit). Sizes are synthesised: the whole raise mass sits on
// the all-in key. The v3 guard must remove the commit in exactly the 12 rows below 0.6.
const V2_VIOLATIONS = [
  ['A d-13-p', { fold: 0.44, call: 0.27, raise: 0.29 }, 'raise'], ['A d-19-r', { check: 0.24, raise: 0.76 }, 'raise'],
  ['A d-21-t', { check: 0.47, raise: 0.53 }, 'raise'], ['A d-26-p', { fold: 0.15, call: 0.32, raise: 0.53 }, 'raise'],
  ['A d-29-p', { fold: 0.25, call: 0.75 }, 'call'], ['A d-30-t16', { check: 0.29, raise: 0.71 }, 'raise'],
  ['A d-30-t17', { fold: 0.54, call: 0.46 }, 'call'], ['B d-3-p', { fold: 0.26, call: 0.43, raise: 0.31 }, 'raise'],
  ['B d-21-p8', { fold: 0.34, call: 0.26, raise: 0.40 }, 'raise'], ['B d-21-p11', { fold: 0.61, call: 0.39 }, 'call'],
  ['B d-22-p', { fold: 0.81, call: 0.10, raise: 0.09 }, 'raise'], ['B d-24-p8', { fold: 0.45, call: 0.37, raise: 0.18 }, 'raise'],
  ['B d-24-p9', { fold: 0.18, call: 0.82 }, 'call'], ['B d-24-p10', { fold: 0.71, call: 0.29 }, 'call'],
  ['C d-1-f', { fold: 0.50, call: 0.12, raise: 0.38 }, 'raise'], ['C d-15-f', { fold: 0.54, call: 0.46 }, 'call'],
];
function violationRow(classes, commit) {
  const probabilities = {}, candidates = [];
  for (const [cls, mass] of Object.entries(classes)) {
    const key = cls === 'raise' ? 'raise_to_5000' : cls;
    probabilities[key] = mass;
    candidates.push(cls === 'raise' ? { key, action: 'raise', amount: 5000 } : { key, action: cls });
  }
  return { probabilities, candidates, commitKey: commit === 'raise' ? 'raise_to_5000' : 'call' };
}
test('#234 class-sample-v2 removes the commit candidate in 12 of the 16 v2 violations, for every unit', () => {
  let blocked = 0;
  for (const [label, classes, commit] of V2_VIOLATIONS) {
    const { probabilities, candidates, commitKey } = violationRow(classes, commit);
    const guard = { deep: true, premium: false, commitKeys: [commitKey] };
    const removed = probabilities[commitKey] < 0.6;
    if (removed) blocked += 1;
    for (let i = 0; i < 100; i++) {
      const unit = (i + 0.5) / 100;
      const out = selectJevAction({ probabilities, candidates, unit, apiChoice: commitKey, rule: 'class-sample-v2', guard });
      assert.equal(out.selection.rule, 'class-sample-v2');
      assert.equal(Boolean(out.selection.guard), removed, label);
      if (removed) assert.notEqual(out.selection.selectedKey, commitKey, `${label} @ ${unit}`);
      assert.equal(out.selection.apiChoice, commitKey, 'the recorded API choice is kept even when removed');
    }
  }
  assert.equal(blocked, 12);
});
test('#234 the guard is deterministic and never applies to a preflop premium or a shallow stack', () => {
  const { probabilities, candidates } = violationRow({ fold: 0.44, call: 0.27, raise: 0.29 }, 'raise');
  const args = { probabilities, candidates, unit: 0.9, apiChoice: 'fold', rule: 'class-sample-v2' };
  const deep = selectJevAction({ ...args, guard: { deep: true, premium: false, commitKeys: ['raise_to_5000'] } });
  assert.deepEqual(selectJevAction({ ...args, guard: { deep: true, premium: false, commitKeys: ['raise_to_5000'] } }), deep);
  assert.deepEqual(deep.selection.guard, { commit: ['raise_to_5000'], mass: 0.29 });
  for (const guard of [{ deep: true, premium: true, commitKeys: ['raise_to_5000'] }, { deep: false, premium: false, commitKeys: ['raise_to_5000'] }, { deep: true, premium: false, commitKeys: [] }]) {
    const out = selectJevAction({ ...args, guard });
    assert.equal('guard' in out.selection, false, JSON.stringify(guard));
    assert.equal(out.selection.selectedKey, 'raise_to_5000', 'unguarded, the same unit reaches the jam');
  }
  // Exactly 0.6 is kept (the floor is strict).
  const edge = violationRow({ fold: 0.4, raise: 0.6 }, 'raise');
  assert.equal('guard' in selectJevAction({ probabilities: edge.probabilities, candidates: edge.candidates, unit: 0.99, apiChoice: 'fold', rule: 'class-sample-v2', guard: { deep: true, premium: false, commitKeys: ['raise_to_5000'] } }).selection, false);
});
test('#234 the rule is explicit: v2 requires guard inputs, v1 refuses them, commit keys must be offered raise/call keys', () => {
  const { probabilities, candidates } = violationRow({ fold: 0.44, call: 0.27, raise: 0.29 }, 'raise');
  const base = { probabilities, candidates, unit: 0.5, apiChoice: 'fold' };
  assert.throws(() => selectJevAction({ ...base, rule: 'class-sample-v2' }), { code: 'JEV_INPUT_INVALID' });
  assert.throws(() => selectJevAction({ ...base, guard: { deep: true, premium: false, commitKeys: [] } }), { code: 'JEV_INPUT_INVALID' });
  assert.throws(() => selectJevAction({ ...base, rule: 'class-sample-v3' }), { code: 'JEV_INPUT_INVALID' });
  for (const commitKeys of [['fold'], ['raise_to_9999']]) {
    assert.throws(() => selectJevAction({ ...base, rule: 'class-sample-v2', guard: { deep: true, premium: false, commitKeys } }), { code: 'JEV_INPUT_INVALID' });
  }
  assert.equal(selectJevAction(base).selection.rule, 'class-sample-v1', 'the default stays the v1 rule for v1/v2 entries');
});
