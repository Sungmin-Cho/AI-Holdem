import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadReferenceDataset } from '../tools/preflop-dataset.js';
import { V2_REFERENCE_SOURCE } from '../shared/reference.js';
import { buildPreActionHint } from '../training/pre-action-hint.js';
import { canonicalJson, hashCanonical, observationHash } from '../shared/decision-observation.js';
import { projectHint } from '../shared/hint-contract.js';
import { NO_HINT_ASSISTANCE, projectAssistance } from '../shared/assistance.js';
const dataset = loadReferenceDataset(V2_REFERENCE_SOURCE);
const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/reference-coverage/decisions.json',import.meta.url)));
const context = { gameEpoch: 'a'.repeat(64), stateVersion: 7 };
test('canonical primitive and observation do not depend on chosen, forced or assistance', () => {
  assert.equal(canonicalJson({b:2,a:1}), '{"a":1,"b":2}');
  assert.equal(hashCanonical({b:2,a:1}), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  const s = structuredClone(corpus[0]); const hash = observationHash(s);
  // Independently calculated with Python json.dumps(sort_keys=True,separators=(',',':'))
  // over the checked-in observation fields, not the implementation under test.
  assert.equal(hash,'0345b6fa1e7fdc7ad3fb8e08a12414c7d3a8e4ca3f4f2d65f93a1e69d6a335a5');
  s.forced = !s.forced; s.chosenAction = { action: 'fold', amount: 0 };
  s.assistance = { schemaVersion: 1, hintShown: true, exposureId: 'b'.repeat(64) };
  assert.equal(observationHash(s),hash);
  s.stateVersion = 1; assert.throws(() => observationHash(s));
  for (const invalid of [undefined, NaN, Infinity, -0, [,1]]) assert.throws(() => canonicalJson(invalid));
});
test('pure supported hint retains source, not-observed coverage and frequency mass', () => {
  const s = structuredClone(corpus[0]); const before = JSON.stringify(s);
  const hint = buildPreActionHint(s,dataset,context);
  assert.equal(hint.status,'supported'); assert.deepEqual(hint.source,V2_REFERENCE_SOURCE);
  assert.equal(hint.coverage.metricEligible,false); assert.equal(hint.coverage.choiceMatch,'not-observed');
  assert.ok(Math.abs(hint.actions.reduce((n,a) => n+a.frequency,0)-1)<1e-9);
  assert.equal(JSON.stringify(s),before);
  assert.throws(() => projectHint({...hint,handNo:hint.handNo+1}));
  assert.throws(() => projectHint({...hint,grade:'preferred'}));
  assert.throws(() => projectHint({...hint,actions:hint.actions.map(a=>({...a,frequency:.33333}))}));
});
test('projection remains non-scoring; postflop has no numeric fields', () => {
  const s = structuredClone(corpus[0]);
  for (const seat of s.publicSeats) seat.stack = 5600-seat.contribution;
  s.maxRaiseTo=s.legal.maxRaiseTo=s.effectiveStack=5600;
  const hint = buildPreActionHint(s,dataset,context);
  assert.equal(hint.coverage.referenceMatch,'projected'); assert.equal(hint.coverage.metricEligible,false);
  const post = corpus.find(row => row.street !== 'preflop');
  const unavailable = buildPreActionHint(post,dataset,context);
  assert.equal(unavailable.code,'HINT_STREET_UNSUPPORTED'); assert.equal('actions' in unavailable,false);
});
test('assistance is closed and cannot conflate absent, false, and true', () => {
  assert.deepEqual(projectAssistance(NO_HINT_ASSISTANCE),NO_HINT_ASSISTANCE);
  for (const value of [undefined, {}, {...NO_HINT_ASSISTANCE,exposureId:'a'.repeat(64)},
    {...NO_HINT_ASSISTANCE,hintShown:true}, {...NO_HINT_ASSISTANCE,note:'false'}]) assert.throws(() => projectAssistance(value));
});
