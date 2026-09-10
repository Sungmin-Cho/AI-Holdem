import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { preserveReviewFailure, sanitizeReviewDiagnostic, REVIEW_DIAGNOSTIC_MAX_BYTES } from '../tools/review-diagnostics.js';

test('review diagnostics redact credentials before bounded UTF-8 truncation', () => {
  const text = sanitizeReviewDiagnostic('session-token-value token=abc password="with spaces" Bearer xyz https://local/?token=hidden sk-secret\n' + '한'.repeat(20000), ['session-token-value']);
  assert.doesNotMatch(text, /session-token-value|abc|with spaces|xyz|hidden|sk-secret/);
  assert.ok(Buffer.byteLength(text) <= REVIEW_DIAGNOSTIC_MAX_BYTES);
  assert.ok(text.endsWith('[truncated]'));
  assert.doesNotMatch(text, /\ufffd/);
  assert.equal(sanitizeReviewDiagnostic('x'.repeat(1024 * 1024 + 1)), '[oversized diagnostic omitted]');
  assert.equal(sanitizeReviewDiagnostic('ses\u200bsion-token-value', ['session-token-value']), '[REDACTED]');
  assert.equal(sanitizeReviewDiagnostic('ses\u0001sion-token-value', ['session-token-value']), '[REDACTED]');
  assert.ok(Buffer.byteLength(sanitizeReviewDiagnostic('한'.repeat(500), [], 512)) <= 512);
  for (const cap of [0, 1, 5, 11]) assert.ok(Buffer.byteLength(sanitizeReviewDiagnostic('한'.repeat(100), [], cap)) <= cap);
});

test('review diagnostics retain four private latest-attempt slots including empty output', () => {
  const root = createOwnedTempDir('review-diagnostics');
  for (const stage of ['evaluator', 'synthesizer']) for (const attempt of [1, 2]) {
    assert.equal(preserveReviewFailure(root, { stage, attempt, raw: 'first' }).outputStatus, 'saved');
    const result = preserveReviewFailure(root, { stage, attempt, raw: '' });
    assert.equal(result.outputStatus, 'saved');
    assert.equal(fs.readFileSync(path.join(root, result.outputPath), 'utf8'), '');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, result.outputPath)).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(path.join(root, '.review-diagnostics')).length, 4);
  const scratch = path.join(root, '.review-diagnostics', '.pending.tmp');
  fs.writeFileSync(scratch, 'interrupted rejected output', { mode: 0o600 });
  assert.equal(preserveReviewFailure(root, { stage: 'evaluator', attempt: 1, raw: 'recovered' }).outputStatus, 'saved');
  assert.equal(fs.readdirSync(path.join(root, '.review-diagnostics')).length, 4);
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(preserveReviewFailure(root, { stage: 'evaluator', attempt: 1 }).outputStatus, 'unavailable');
});

test('review diagnostic unsafe slots do not overwrite or follow another file', () => {
  const root = createOwnedTempDir('review-diagnostics');
  const result = preserveReviewFailure(root, { stage: 'evaluator', attempt: 1, raw: 'first' });
  const target = path.join(root, result.outputPath);
  const linked = path.join(root, 'linked');
  fs.linkSync(target, linked);
  assert.equal(preserveReviewFailure(root, { stage: 'evaluator', attempt: 1, raw: 'overwrite' }).outputStatus, 'not_saved');
  assert.equal(fs.readFileSync(linked, 'utf8'), 'first');
});

test('review diagnostics omit content for an insecure directory', { skip: process.platform === 'win32' }, () => {
  const root = createOwnedTempDir('review-diagnostics');
  const directory = path.join(root, '.review-diagnostics');
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  assert.equal(preserveReviewFailure(root, { stage: 'evaluator', attempt: 1, raw: 'private' }).outputStatus, 'not_saved');
  assert.deepEqual(fs.readdirSync(directory), []);
});
