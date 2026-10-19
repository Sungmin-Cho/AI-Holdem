import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import { CAPTURE_INPUTS, PRODUCER_COMMIT, REPO_ROOT, loadFixture, sha256, verifyRecovery } from './helpers/srs-v1-recovery.mjs';

// #272: SR v1 drill pending transactions exactly as main@62ea79c (the last SR v1
// producer) left them between two of its writes, recovered by the current
// nextQuestion. The expected bytes are that producer's own recovery, captured by
// scripts/capture-srs-v1-recovery.mjs; nothing here is regenerated with the
// current code. A capture input change needs a new capture (--write, then --check).
const TIMEOUT = process.platform === 'win32' ? 600_000 : 120_000;
const fixture = loadFixture();
const { manifest } = fixture;
const ISSUE_CHECKPOINTS = ['unapplied', 'profile-only', 'through-bank', 'srs-applied-pending-not-cleared', 'complete'];

test('the SR v1 recovery fixture is the pinned producer\'s capture, intact', () => {
  assert.equal(manifest.producer.commit, PRODUCER_COMMIT);
  for (const rel of CAPTURE_INPUTS) {
    assert.equal(sha256(fs.readFileSync(path.join(REPO_ROOT, rel))), manifest.capture.inputs[rel], `${rel} changed after the capture`);
  }
  // Every blob is the bytes it is named after (a checkout conversion would show
  // here), and the manifest references exactly the blobs on disk.
  const blobs = fs.readdirSync(path.join(fixture.dir, 'blobs')).sort();
  for (const name of blobs) assert.equal(sha256(fixture.blob(name)), name);
  const referenced = new Set(manifest.transactions.flatMap((tx) => tx.checkpoints.flatMap((checkpoint) => [
    ...Object.values(checkpoint.files), ...Object.values(checkpoint.expected.files), checkpoint.expected.dto,
  ])).filter(Boolean));
  assert.deepEqual(blobs, [...referenced].sort());

  // A off-policy writes the bank between the profile and SRS consumers; B and C
  // (preferred, mixed) do not, so they have one boundary fewer.
  assert.deepEqual(manifest.transactions.map((tx) => [tx.id, tx.checkpoints.length]),
    [['a-v2-off-policy', 9], ['b-v2-preferred', 8], ['c-v1-mixed', 8]]);
  for (const tx of manifest.transactions) {
    assert.deepEqual(tx.checkpoints.filter((row) => row.issueCheckpoint).map((row) => row.issueCheckpoint), ISSUE_CHECKPOINTS, tx.id);
    const pending = JSON.parse(fixture.blob(tx.checkpoints[0].files['drill-session.json'])).pending;
    assert.deepEqual(pending.applied, { srs: false, bank: false, profile: false });
    assert.equal(pending.attemptNo, tx.attemptNo);
    assert.equal(pending.questionId, tx.questionId);
    assert.equal(pending.profileEvent.evaluationId, tx.evaluationId);
    assert.equal(pending.result.grade, tx.grade);
    assert.deepEqual(pending.srsPatch, tx.srsPatch);
    assert.equal(Object.hasOwn(tx.srsPatch.patch, 'srsVersion'), false, `${tx.id} is an SR v1 capture`);
    const done = tx.checkpoints.at(-1);
    assert.equal(done.applied, null);
    assert.deepEqual(done.expected.files, done.files, 'recovering a committed answer changes nothing');
    assert.deepEqual(done.expected.rewritten, []);
  }
  assert.ok(manifest.transactions.some((tx) => tx.source.version === '1.0.0'));
  assert.ok(manifest.transactions.some((tx) => tx.source.version === '2.0.0'));

  // The capture showed this comparison rejects each deliberate regression.
  assert.equal(manifest.negativeControls.unmodified.mismatches, 0);
  assert.deepEqual(manifest.negativeControls.mutations.filter((row) => !row.detected), []);
  assert.ok(manifest.negativeControls.mutations.length >= 6);
});

test('current recovery of every SR v1 checkpoint matches the producer\'s own recovery, and only once', { timeout: TIMEOUT }, async () => {
  const report = await verifyRecovery({
    codeRoot: REPO_ROOT,
    fixture,
    makeStore: () => createOwnedTempDir('srs-v1-recovery'),
    onSpawn: (child) => registerOwnedProcess(child, 'srs v1 recovery runner'),
  });
  assert.equal(report.checkpoints, 25);
  assert.deepEqual(report.mismatches, []);
});
