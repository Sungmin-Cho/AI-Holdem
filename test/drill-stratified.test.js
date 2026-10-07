import test from 'node:test';
import assert from 'node:assert/strict';
import { generateQueue } from '../training/drill-generator.js';
import { strataForSpot, neighbourClasses, STRATA_WEIGHTS } from '../training/drill-strata.js';
import { loadReferenceDataset } from '../tools/preflop-dataset.js';
import { lookup } from '../training/providers/preflop-json.js';
import { V3_REFERENCE_SOURCE } from '../shared/reference.js';

const dataset = loadReferenceDataset(V3_REFERENCE_SOURCE);
const source = { id: dataset.data.id, version: dataset.data.version, contentSha256: dataset.contentSha256 };
const admits = (spotKey, handClass) => lookup(dataset, { spotKey, handClass }).status === 'supported';
const frequencies = (spotKey) => (cls) => {
  const found = lookup(dataset, { spotKey, handClass: cls });
  const f = { fold: found.status === 'supported' ? 0 : 1, call: 0, raise: 0 };
  for (const row of found.actions ?? []) f[row.action] += row.frequency;
  return f;
};
const cache = new Map();
const weightOf = (spotKey, handClass) => {
  if (!cache.has(spotKey)) cache.set(spotKey, strataForSpot(frequencies(spotKey)));
  return cache.get(spotKey).get(handClass).weight;
};
const foldAllowed = (q) => (lookup(dataset, q.prompt).actions ?? []).some((row) => row.action === 'fold' && row.frequency > 0);

test('G3: a stratified v3 assessment is not passed by always folding', { timeout: 120_000 }, () => {
  const questions = [];
  for (let seed = 0; seed < 40; seed += 1) {
    questions.push(...generateQueue({ mode: 'assessment', source, seed: `g3-${seed}`, limit: 10, admits, weightOf, history: { seenPairs: [] } }));
  }
  const share = questions.filter(foldAllowed).length / questions.length;
  assert.ok(share <= 0.65, `always-fold allowed share ${share.toFixed(3)}`);
  const uniform = [];
  for (let seed = 0; seed < 40; seed += 1) uniform.push(...generateQueue({ mode: 'assessment', source, seed: `g3-${seed}`, limit: 10, admits, history: { seenPairs: [] } }));
  assert.ok(uniform.filter(foldAllowed).length / uniform.length > share, 'stratification lowers the fold baseline');
});

test('strata classify the grid and neighbours stay on the grid', () => {
  const strata = strataForSpot(frequencies('6max-100bb-btn-rfi-v3'));
  assert.equal(strata.size, 169);
  assert.equal(strata.get('AA').stratum, 'pure');
  assert.equal(strata.get('72o').weight, STRATA_WEIGHTS.pure);
  assert.ok([...strata.values()].some((row) => row.stratum === 'boundary'));
  assert.deepEqual(neighbourClasses('AA').sort(), ['AKo', 'AKs'].sort());
  assert.equal(neighbourClasses('T9s').length, 4);
});

test('transfer asks the unanswered neighbours of missed hands on the same spot', () => {
  const spotKey = '6max-100bb-btn-rfi-v3';
  const mistakes = [{ schemaVersion: 2, mistakeId: 'm1', spotKey, handClass: 'K9o', sourceIdentity: source, lastSeenAt: '2026-10-07T00:00:00.000Z' }];
  const history = { seenPairs: [{ sourceIdentity: source, spotKey, handClass: 'K8o' }] };
  const queue = generateQueue({ mode: 'transfer', source, mistakes, history, limit: 10, admits });
  assert.deepEqual(queue.map((q) => q.prompt.handClass).sort(), neighbourClasses('K9o').filter((cls) => cls !== 'K8o').sort());
  assert.ok(queue.every((q) => q.prompt.spotKey === spotKey && q.mode === 'transfer'));
  assert.deepEqual(generateQueue({ mode: 'transfer', source, mistakes: [], history, limit: 10, admits }), []);
});
