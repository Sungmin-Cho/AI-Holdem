import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBaseline } from './helpers/compat-baseline.mjs';

// G7: the corpus and the expected hashes were produced with main@62ea79c (see the
// helper). Every v1/v2 evaluation, coverage projection, hint, profile projection,
// SR schedule, drill queue/answer, the native v2 spot grid (every v2 spot ×
// representative hands × tree answers), v2 policy distribution/decision and view must
// recompute byte-for-byte with the current code.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test/fixtures/compat-v2');

test('v1/v2 learning, hint, policy and view outputs are unchanged from main@62ea79c', async () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'corpus.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
  const actual = await computeBaseline(ROOT, corpus);
  const changed = Object.keys(expected.items).filter((key) => actual.items[key] !== expected.items[key]);
  const added = Object.keys(actual.items).filter((key) => !Object.hasOwn(expected.items, key));
  assert.deepEqual({ changed: changed.slice(0, 20), changedCount: changed.length, added: added.slice(0, 20) },
    { changed: [], changedCount: 0, added: [] });
  assert.ok(Object.keys(expected.items).length > 11000);
  // The native v2 grid (every v2 spot × representative hands × tree answers).
  assert.ok(Object.keys(expected.items).filter((key) => key.startsWith('grid:')).length > 6000);
});
