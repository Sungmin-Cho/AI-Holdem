import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contracts from '../export/contracts.js';
import { normalizeHand } from '../export/hand-normalizer.js';
import { buildCanonical, buildText, mergeWarnings } from '../export/manifest.js';
import { renderPokerStars } from '../export/pokerstars.js';
import {
  GENERATED_DIR, SCENARIOS, readGeneratedRecord,
} from './helpers/gen-hh-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/hand-history');
const EXPORT = path.join(ROOT, 'tools/export-hh.js');
const RENDER_OPTS = { gameId: '1', exportedAt: '2026/09/01 0:00:00 ET' };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-q5-'));
}

function clone(value) {
  return structuredClone(value);
}

function writeArchive(record) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'hands'));
  fs.writeFileSync(path.join(dir, 'hands', 'hand-0001.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    config: { mode: 'tournament', blinds0: record.blinds },
    gameEpoch: 'q5',
    seats: Object.entries(record.startStacks ?? {}).map(([playerId, stack]) => ({ playerId, stack })),
  }));
  return dir;
}

function runExport(args) {
  return JSON.parse(execFileSync(process.execPath, [EXPORT, ...args], { encoding: 'utf8' }).trim());
}

test('engine-produced uncalled record is ok and renders complete betting facts', () => {
  const hand = normalizeHand(readGeneratedRecord('uncalled'));
  assert.deepEqual(contracts.validateCanonicalHand(hand), { exportStatus: 'ok' });
  const { text } = renderPokerStars({ hands: [hand] }, RENDER_OPTS);
  assert.match(text, /posts small blind 25/);
  assert.match(text, /posts big blind 50/);
  assert.match(text, /raises 150 to 200/);
  assert.match(text, /Uncalled bet \(150\) returned to user/);
  assert.equal(text.includes('user: raises to 200'), false);
});

for (const [name, mutate, reason] of [
  ['missing posts', (row) => { delete row.posts; }, 'legacy archive: missing posts'],
  ['missing uncalledReturns', (row) => { delete row.uncalledReturns; }, 'legacy archive: missing uncalledReturns'],
  ['raise without currentBet', (row) => { delete row.actions[0].currentBet; }, 'legacy archive: raise without currentBet'],
]) {
  test(`legacy ${name} is unsupported, recorded, and excluded from text`, () => {
    const record = clone(readGeneratedRecord('uncalled'));
    mutate(record);
    const canonical = buildCanonical(writeArchive(record), { exportedAt: RENDER_OPTS.exportedAt });
    assert.equal(canonical.hands.length, 0);
    assert.deepEqual(canonical.warnings, [{
      handNo: 1,
      exportStatus: 'unsupported',
      reason,
    }]);
    assert.equal(buildText(canonical, RENDER_OPTS).text.includes('Hand #AIH1-1'), false);
  });
}

for (const [field, value, reason] of [
  ['uncalledReturns', null, 'legacy archive: missing uncalledReturns'],
  ['uncalledReturns', [], 'legacy archive: missing uncalledReturns'],
  ['uncalledReturns', 'x', 'legacy archive: missing uncalledReturns'],
  ['posts', {}, 'legacy archive: missing posts'],
  ['posts', 'x', 'legacy archive: missing posts'],
]) {
  test(`invalid-present ${field} ${JSON.stringify(value)} stays invalid and yields zero ok hands`, () => {
    const record = clone(readGeneratedRecord('uncalled'));
    record[field] = value;
    const normalized = normalizeHand(record);
    assert.deepEqual(contracts.validateCanonicalHand(normalized), {
      exportStatus: 'unsupported',
      reason,
    });
    const canonical = buildCanonical(writeArchive(record), { exportedAt: RENDER_OPTS.exportedAt });
    assert.equal(canonical.hands.length, 0);
  });
}

test('chip conservation mismatch is a warning and the hand remains in text', () => {
  const record = clone(readGeneratedRecord('uncalled'));
  record.endStacks.user += 1;
  const canonical = buildCanonical(writeArchive(record), { exportedAt: RENDER_OPTS.exportedAt });
  assert.equal(canonical.hands.length, 1);
  assert.deepEqual(canonical.warnings, [{
    handNo: 1,
    exportStatus: 'warning',
    reason: 'chip conservation mismatch',
  }]);
  assert.match(buildText(canonical, RENDER_OPTS).text, /Hand #AIH1-1/);
});

test('warningsFor exposes the warning grade without weakening canonical validity', () => {
  const hand = normalizeHand(readGeneratedRecord('uncalled'));
  hand.endStacks.user += 1;
  assert.equal(typeof contracts.warningsFor, 'function');
  assert.deepEqual(contracts.warningsFor(hand), {
    exportStatus: 'warning',
    reason: 'chip conservation mismatch',
  });
});

test('mergeWarnings deduplicates mixed grades while preserving first-seen order', () => {
  const unsupported = { handNo: 1, exportStatus: 'unsupported', reason: 'legacy archive: missing posts' };
  const warning = { handNo: 2, exportStatus: 'warning', reason: 'chip conservation mismatch' };
  assert.deepEqual(mergeWarnings([unsupported, warning], [unsupported, warning]), [unsupported, warning]);
});

test('renderer rejects a raise without currentBet instead of emitting a lossy fallback', () => {
  const hand = normalizeHand(readGeneratedRecord('uncalled'));
  delete hand.actions[0].currentBet;
  assert.throws(
    () => renderPokerStars({ hands: [hand] }, RENDER_OPTS),
    { code: 'EXPORT_CONTRACT_VIOLATION' },
  );
});

test('export CLI reports excluded unsupported hands', () => {
  const record = clone(readGeneratedRecord('uncalled'));
  delete record.posts;
  const dir = writeArchive(record);
  const result = runExport([
    '--game-dir', dir,
    '--format', 'canonical-json',
    '--out', path.join(dir, 'export.json'),
    '--exported-at', '2026-09-01T00:00:00.000Z',
  ]);
  assert.equal(result.excluded, 1);
  assert.equal(result.hands, 0);
});

test('generated records are committed outputs of the reproducible helper', () => {
  for (const { name } of SCENARIOS) {
    const file = path.join(GENERATED_DIR, `${name}.json`);
    assert.equal(fs.existsSync(file), true, file);
    assert.equal(readGeneratedRecord(name).handNo, 1);
  }
});

for (const scenario of SCENARIOS) {
  test(`engine-produced ${scenario.name} archive converges with authored ${scenario.fixture}`, () => {
    const canonical = buildCanonical(writeArchive(readGeneratedRecord(scenario.name)), {
      exportedAt: RENDER_OPTS.exportedAt,
    });
    assert.equal(canonical.hands.length, 1);
    const actual = buildText(canonical, RENDER_OPTS).text;
    const expected = fs.readFileSync(path.join(FIXTURE_DIR, scenario.fixture), 'utf8');
    assert.equal(actual, expected);
  });
}

test('fixture README identifies the ten legacy records as authored', () => {
  const readme = fs.readFileSync(path.join(FIXTURE_DIR, 'README.md'), 'utf8');
  assert.match(readme, /10.*authored|authored.*10/i);
});
