import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluationIdOf } from '../training/contracts.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/profile-cli.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-pcli-'));
}

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }).trim());
}

test('profile-cli apply/show/rebuild/reset/sweep', () => {
  const storeDir = tmp();
  const sessionDir = path.join(storeDir, '.session-store', 'sessions', '11111111-1111-4111-8111-111111111111');
  const evaluation = {
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: 'aa'.repeat(32),
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    grade: 'off-policy',
    forced: false,
    evLossBb: null,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  };
  const file = path.join(storeDir, 'eval.json');
  fs.writeFileSync(file, JSON.stringify(evaluation));
  const applied = run(['apply', '--store-dir', storeDir, '--evaluation-file', file]);
  assert.equal(applied.ok, true);
  assert.equal(applied.profile.overall.evaluatedDecisions, 1);
  const shown = run(['show', '--store-dir', storeDir]);
  assert.equal(shown.profile.leaks[0].recommendedDrill, 'preflop.rfi.BTN');
  const rebuilt = run(['rebuild', '--store-dir', storeDir]);
  assert.equal(JSON.stringify(rebuilt.profile.overall), JSON.stringify(shown.profile.overall));
  fs.mkdirSync(path.join(sessionDir, 'training'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'training', 'evaluations.jsonl'), `${JSON.stringify({
    ...evaluation,
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-9-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: 'ff'.repeat(32),
    grade: 'preferred',
  })}\n`);
  const swept = run(['sweep', '--store-dir', storeDir]);
  assert.equal(swept.applied >= 1, true);
  const reset = run(['reset', '--store-dir', storeDir]);
  assert.equal(reset.profile.overall.evaluatedDecisions, 0);
});

test('writePracticeFocus and defaultPracticeFocusFile', async () => {
  const { writePracticeFocus, defaultPracticeFocusFile } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  const file = writePracticeFocus(storeDir, {
    leaks: [{ id: 'preflop.rfi.BTN', recommendedDrill: 'preflop.rfi.BTN', severity: 1, confidence: 0.5 }],
  });
  assert.equal(defaultPracticeFocusFile(storeDir), file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(json.focus, 'preflop.rfi.BTN');
});

function writeFocusFile(storeDir, value, { symlinkTo } = {}) {
  const dir = path.join(storeDir, '.training');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'practice-focus.json');
  if (symlinkTo !== undefined) {
    fs.symlinkSync(symlinkTo, file);
    return file;
  }
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  fs.writeFileSync(file, body);
  return file;
}

test('defaultPracticeFocusFile ignores a symlink practice-focus and surfaces a notice', async () => {
  const {
    defaultPracticeFocusFile,
    loadAutoPracticeFocus,
  } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  const outside = path.join(storeDir, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({
    schemaVersion: 1,
    leaks: [],
    focus: 'pwned-via-symlink',
  }));
  writeFocusFile(storeDir, null, { symlinkTo: outside });
  assert.equal(defaultPracticeFocusFile(storeDir), null);
  assert.equal(typeof loadAutoPracticeFocus, 'function');
  const loaded = loadAutoPracticeFocus(storeDir);
  assert.equal(loaded.status, 'ignored');
  assert.equal(loaded.code, 'UNSAFE_PATH');
  assert.match(String(loaded.notice), /UNSAFE_PATH/);
});

test('defaultPracticeFocusFile rejects an oversized practice-focus', async () => {
  const { defaultPracticeFocusFile } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  writeFocusFile(storeDir, {
    schemaVersion: 1,
    leaks: [],
    focus: 'x'.repeat(5000),
  });
  assert.throws(() => defaultPracticeFocusFile(storeDir), { code: 'TOO_LARGE' });
});

test('defaultPracticeFocusFile rejects a practice-focus schema mismatch', async () => {
  const { defaultPracticeFocusFile } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  writeFocusFile(storeDir, { focus: 'x', extra: true });
  assert.throws(() => defaultPracticeFocusFile(storeDir), { code: 'BAD_PRACTICE_FOCUS' });
});
