import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import {
  CAPTURE_INPUTS, PRODUCER_COMMIT, RECOVER_AT, REPO_ROOT, RUNNER, loadFixture, semanticFailures, sha256, verifyRecovery,
} from './helpers/srs-v1-recovery.mjs';

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
  // Detected means the comparison reported the failure the mutation was built to cause.
  assert.equal(manifest.negativeControls.unmodified.mismatches, 0);
  assert.deepEqual(manifest.negativeControls.mutations.map((row) => row.id), [
    'v1-patch-rederived-as-v2', 'srs-target-marked-v2', 'srs-attempt-counted-twice', 'profile-event-duplicated',
    'bank-evidence-duplicated', 'profile-consumer-reapplied', 'session-rewritten-without-pending',
  ]);
  for (const row of manifest.negativeControls.mutations) assert.ok(row.detected && row.matched > 0, row.id);
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

// The bank, profile and SRS writers refuse most of these before they reach a
// file, so the negative controls cannot exercise every semantic check; this
// does, on the producer's own recovered bytes.
test('each semantic check names its own failure on the producer\'s recovered bytes', () => {
  const tx = manifest.transactions.find((row) => row.id === 'a-v2-off-policy');
  const before = fixture.filesOf(tx.checkpoints[0].files);
  const after = fixture.filesOf(tx.checkpoints[0].expected.files);
  assert.deepEqual(semanticFailures(tx, before, after), []);
  const json = (rel) => JSON.parse(after[rel]);
  const lines = after['profile-events.jsonl'].toString('utf8').split('\n').filter(Boolean);
  const own = lines.find((line) => JSON.parse(line).evaluationId === tx.evaluationId);
  const variants = [
    ['bank evidence banked twice on its item', 'mistakes.json', () => {
      const bank = json('mistakes.json');
      bank.items.find((item) => item.evidenceIds.includes(tx.evaluationId)).evidenceIds.push(tx.evaluationId);
      return bank;
    }, /2 bank evidence rows for the off-policy answer/],
    ['review stamped as SR v2', 'mistakes.json', () => {
      const bank = json('mistakes.json');
      bank.reviewState[tx.srsPatch.mistakeId].srsVersion = 2;
      return bank;
    }, /gained SR v2 fields/],
    ['review attempt counted twice', 'mistakes.json', () => {
      const bank = json('mistakes.json');
      bank.reviewState[tx.srsPatch.mistakeId].attempts += 1;
      return bank;
    }, /the SR v1 target is not the captured one/],
    ['event appended twice', 'profile-events.jsonl', () => `${lines.join('\n')}\n${own}\n`, /2 learning events for the transaction/],
    ['earlier event rewritten', 'profile-events.jsonl', () => `${lines.slice(1).join('\n')}\n`, /earlier learning events were rewritten/],
    ['pending left in place', 'drill-session.json', () => ({ ...json('drill-session.json'), pending: {} }), /pending was not cleared/],
    ['session index moved past the answer', 'drill-session.json', () => {
      const session = json('drill-session.json');
      session.index += 1;
      return session;
    }, /index \d+, expected \d+/],
    ['answer recorded with another grade', 'drill-session.json', () => {
      const session = json('drill-session.json');
      session.answers[tx.attemptNo].grade = 'preferred';
      return session;
    }, /the answer was not committed to its question/],
    ['another review gained graduatedAt', 'mistakes.json', () => {
      const bank = json('mistakes.json');
      const other = Object.keys(bank.reviewState).find((id) => id !== tx.srsPatch.mistakeId);
      bank.reviewState[other].graduatedAt = null;
      return bank;
    }, /gained SR v2 fields/],
  ];
  for (const [label, rel, make, expected] of variants) {
    const value = make();
    const changed = { ...after, [rel]: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) };
    assert.ok(semanticFailures(tx, before, changed).some((line) => expected.test(line)), label);
  }
});

test('the recovery runner refuses a call that names no store', () => {
  const run = spawnSync(process.execPath, [RUNNER, REPO_ROOT, RECOVER_AT], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage/);
});
