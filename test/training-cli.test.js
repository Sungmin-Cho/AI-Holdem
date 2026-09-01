import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreflopJson } from '../training/providers/preflop-json.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/cli.js');
const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/data/preflop-baseline-v1.json');

test('dataset metadata fail-closed and frequency sum', () => {
  const { data } = loadPreflopJson(DATA);
  assert.equal(data.license, 'Apache-2.0');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-ds-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, id: 'x', version: '1.0.0', spots: {} }));
  assert.throws(() => loadPreflopJson(bad), { code: 'DATASET_INVALID' });
});

test('evaluate CLI returns JSON envelope for user decisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-eval-'));
  const snapshot = {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    actorId: 'user',
    street: 'preflop',
    position: 'BTN',
    holeCards: ['Ah', 'Ad'],
    blinds: [50, 100],
    effectiveStack: 10000,
    publicSeats: ['user', 'p1', 'p2', 'p3', 'p4', 'p5'].map((playerId) => ({
      playerId, out: false, folded: false, allIn: false, stack: 10000, bet: 0, contribution: 0,
    })),
    priorActions: [],
    chosenAction: { action: 'raise', amount: 250 },
    forced: false,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    sessionToken: 'tok', lastHand: { handNo: 1, decisions: [snapshot] },
  }));
  const stdout = execFileSync(process.execPath, [
    CLI, 'evaluate', '--game-dir', dir, '--hand', '1', '--dataset', DATA,
  ], { encoding: 'utf8' });
  const json = JSON.parse(stdout.trim());
  assert.equal(json.ok, true);
  assert.equal(json.evaluations.length, 1);
  assert.equal(json.evaluations[0].status, 'supported');
  assert.equal(json.evaluations[0].handClass, 'AA');
  assert.equal(json.evaluations[0].chosen.evBb, null);
  assert.equal(json.evaluations[0].grade, 'preferred');
});
