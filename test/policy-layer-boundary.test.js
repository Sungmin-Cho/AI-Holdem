import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanModule } from './helpers/module-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function importsOf(relative) {
  return scanModule(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

test('hand strength has exactly the approved read-only engine evaluator edge', () => {
  const scan = importsOf('training/policies/hand-strength.js');
  assert.deepEqual(scan.unresolved, []);
  assert.deepEqual(
    scan.imports.filter((entry) => entry.specifier.includes('/engine/')),
    [{
      specifier: '../../engine/evaluator.js',
      bindings: ['compareScore', 'evaluate7'],
      dynamic: false,
    }],
  );
});

test('policy v2 has no filesystem hidden-hole deck or hand-transition module edge', () => {
  const forbidden = /(?:^|\/)(?:fs|cards|hand|state|decision|views|game-archive|session-catalog)(?:\.js)?$/;
  const offenders = [
    'training/policies/hand-strength.js',
    'training/policies/strategy-v2.js',
    'training/policies/strategy-mirror.js',
  ]
    .flatMap((relative) => importsOf(relative).imports.map((entry) => ({ relative, ...entry })))
    .filter((entry) => forbidden.test(entry.specifier))
    .map((entry) => `${entry.relative} -> ${entry.specifier}`);
  assert.deepEqual(offenders, []);
});

test('v2 strategy depends only on policy-layer modules', () => {
  const scan = importsOf('training/policies/strategy-v2.js');
  assert.deepEqual(scan.unresolved, []);
  assert.deepEqual(
    scan.imports.map((entry) => entry.specifier).sort(),
    ['./contracts.js', './hand-strength.js', './sizing.js'],
  );
});

test('the heuristic strength estimate is consumed only by opponent policy strategy', () => {
  const consumers = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.js$/.test(entry.name)) {
        for (const edge of scanModule(fs.readFileSync(full, 'utf8')).imports) {
          if (edge.specifier.endsWith('/hand-strength.js') || edge.specifier === './hand-strength.js') {
            consumers.push(path.relative(ROOT, full).split(path.sep).join('/'));
          }
        }
      }
    }
  };
  walk(path.join(ROOT, 'training'));
  walk(path.join(ROOT, 'tools'));
  assert.deepEqual(consumers.sort(), [
    'training/policies/strategy-mirror.js',
    'training/policies/strategy-v2.js',
    'training/tendency/extract.js',
  ]);
});

test('strategy-mirror.js imports exactly the six approved specifiers', () => {
  const scan = importsOf('training/policies/strategy-mirror.js');
  assert.deepEqual(scan.unresolved, []);
  assert.deepEqual(
    scan.imports.map((entry) => entry.specifier).sort(),
    [
      '../tendency/contracts.js',
      '../tendency/traits.js',
      './contracts.js',
      './hand-strength.js',
      './sizing.js',
      './strategy-v2.js',
    ],
  );
});

test('tendency contracts do not import policies modules', () => {
  const scan = importsOf('training/tendency/contracts.js');
  assert.equal(
    scan.imports.some((entry) => entry.specifier.includes('policies')),
    false,
  );
});
