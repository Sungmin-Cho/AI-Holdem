import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreflopJson } from '../training/providers/preflop-json.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/cli.js');
const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/data/preflop-baseline-v1.json');

const SHA = `${DATA.replace(/\.json$/, '.sha256')}`;

function fileSha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function pinnedLoad(file, expected) {
  return loadPreflopJson(file, { expectedSha256: expected });
}

test('dataset metadata fail-closed and frequency sum', () => {
  const expected = fileSha256(DATA);
  const { data } = pinnedLoad(DATA, expected);
  assert.equal(data.license, 'Apache-2.0');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-ds-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, id: 'x', version: '1.0.0', spots: {} }));
  assert.throws(() => pinnedLoad(bad, expected), { code: 'DATASET_INVALID' });
});

test('preflop-baseline-v1.sha256 matches the dataset bytes', () => {
  const recorded = fs.readFileSync(SHA, 'utf8').trim();
  assert.equal(recorded, fileSha256(DATA));
});

test('loadPreflopJson requires expectedSha256 and rejects mismatch', () => {
  assert.throws(() => loadPreflopJson(DATA), { code: 'DATASET_INVALID' });
  assert.throws(
    () => loadPreflopJson(DATA, { expectedSha256: '0'.repeat(64) }),
    { code: 'DATASET_INVALID' },
  );
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

function cliJson(args, dir) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: dir,
    });
    return { status: 0, json: JSON.parse(stdout.trim()) };
  } catch (error) {
    const text = String(error.stdout ?? '');
    return { status: error.status, json: JSON.parse(text.trim()) };
  }
}

test('evaluate CLI failure envelopes: usage, hand, dataset, gameEpoch', () => {
  const usage = cliJson(['evaluate'], os.tmpdir());
  assert.equal(usage.json.ok, false);
  assert.equal(usage.json.code, 'USAGE');

  const missingHand = cliJson(['evaluate', '--game-dir', os.tmpdir(), '--hand', '1'], os.tmpdir());
  assert.equal(missingHand.json.ok, false);
  assert.equal(missingHand.json.code, 'HAND_NOT_FOUND');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-eval-fail-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastHand: { handNo: 1, decisions: [] } }));
  const noEpoch = cliJson(['evaluate', '--game-dir', dir, '--hand', '1', '--dataset', DATA], dir);
  assert.equal(noEpoch.json.ok, false);
  assert.equal(noEpoch.json.code, 'EVALUATION_ID_INVALID');
});
