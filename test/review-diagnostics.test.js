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
