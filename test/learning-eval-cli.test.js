// #298: 학습 효과 평가 CLI — 동의·봉인 일정의 등록, 철회, 읽기 전용 보고와 여러 파일 snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { startDrill } from '../tools/drill-cli.js';
import { ENROLLMENT_FILE, buildReport, enroll, main, readEnrollments, readSnapshot, withdraw } from '../tools/learning-eval.js';
import { readLedger } from '../tools/learning-ledgers.js';
import { PROTOCOL_SHA256 } from '../training/learning-effect.js';
import { V3_REFERENCE_SOURCE } from '../shared/reference.js';

const training = (storeDir) => path.join(storeDir, '.training');
const clock = (iso) => () => iso;

function tree(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      const rel = path.relative(dir, file);
      if (stat.isDirectory()) { out[rel] = { dir: true, mode: stat.mode, mtimeMs: stat.mtimeMs }; walk(file); }
      else out[rel] = { mode: stat.mode, mtimeMs: stat.mtimeMs, size: stat.size, bytes: fs.readFileSync(file).toString('base64') };
    }
  };
  walk(dir);
  return out;
}

async function run(argv, now) {
  const out = [];
  const err = [];
  const code = await main(argv, { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) }, ...(now ? { now } : {}) });
  return { code, out: out.join(''), err: err.join('') };
}

test('enroll needs explicit consent, seals the schedule, creates both ledgers and refuses a second open enrollment', async () => {
  const storeDir = createOwnedTempDir('eval-enroll');
  assert.equal((await run(['enroll', '--store', storeDir])).code, 1);
  await assert.rejects(enroll(storeDir, { consent: false }), { code: 'CONSENT_REQUIRED' });
  const result = await run(['enroll', '--store', storeDir, '--consent', '--baseline-runs', '2', '--intervention-days', '3'], clock('2026-10-21T00:00:00.000Z'));
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /동의|참여/);
  const [enrollment] = readEnrollments(training(storeDir)).enrollments;
  assert.deepEqual(enrollment.plan, { baselineRuns: 2, interventionDays: 3, postDays: 7 });
  assert.equal(enrollment.protocolSha256, PROTOCOL_SHA256);
  assert.equal(enrollment.postOpensAt, '2026-10-24T00:00:00.000Z');
  assert.equal(enrollment.postClosesAt, '2026-10-31T00:00:00.000Z');
  assert.deepEqual(enrollment.source, { ...V3_REFERENCE_SOURCE });
  assert.equal(readLedger(training(storeDir), 'run').ledger.coverageFrom, '2026-10-21T00:00:00.000Z');
  assert.equal(readLedger(training(storeDir), 'exposure').ledger.coverageFrom, '2026-10-14T00:00:00.000Z');
  await assert.rejects(enroll(storeDir, { consent: true, now: clock('2026-10-22T00:00:00.000Z') }), { code: 'ENROLLMENT_OPEN' });
  assert.equal((await run(['enroll', '--store', storeDir, '--consent', '--baseline-runs', '9'], clock('2026-11-01T00:00:00.000Z'))).code, 2);
});

test('withdraw closes the open enrollment once; a later enrollment is a new record and the old one is unchanged', async () => {
  const storeDir = createOwnedTempDir('eval-withdraw');
  await assert.rejects(withdraw(storeDir), { code: 'NOT_ENROLLED' });
  const first = await enroll(storeDir, { consent: true, now: clock('2026-10-01T00:00:00.000Z') });
  const withdrawn = await withdraw(storeDir, { now: clock('2026-10-02T00:00:00.000Z') });
  assert.equal(withdrawn.withdrawnAt, '2026-10-02T00:00:00.000Z');
  assert.equal(buildReport(storeDir, { now: '2026-10-03T00:00:00.000Z' }).status, 'WITHDRAWN');
  await assert.rejects(withdraw(storeDir, { now: clock('2026-10-03T00:00:00.000Z') }), { code: 'NOT_ENROLLED' });
  const second = await enroll(storeDir, { consent: true, now: clock('2026-10-04T00:00:00.000Z') });
  const rows = readEnrollments(training(storeDir)).enrollments;
  assert.deepEqual(rows.map((row) => row.id), [first.id, second.id]);
  assert.deepEqual({ ...rows[0], withdrawnAt: null }, first, 'only withdrawnAt changed on the first record');
});

test('report and status are strictly read-only: a store made unwritable reports the same, and nothing changes', { timeout: 120_000 }, async (t) => {
  const storeDir = createOwnedTempDir('eval-readonly');
  await enroll(storeDir, { consent: true, now: clock(new Date(Date.now() - 86_400_000).toISOString()) });
  await startDrill(storeDir, { mode: 'assessment', source: V3_REFERENCE_SOURCE, seed: 'ro' });
  const before = tree(storeDir);
  const restore = [];
  for (const [rel, entry] of Object.entries(before)) {
    const file = path.join(storeDir, rel);
    restore.push([file, entry.mode]);
    fs.chmodSync(file, entry.dir ? 0o555 : 0o444);
  }
  fs.chmodSync(storeDir, 0o555);
  t.after(() => { fs.chmodSync(storeDir, 0o755); for (const [file, mode] of restore.reverse()) fs.chmodSync(file, mode & 0o7777); });
  const locked = tree(storeDir);
  const report = await run(['report', '--store', storeDir, '--json']);
  assert.equal(report.code, 0, report.err);
  const parsed = JSON.parse(report.out);
  assert.equal(parsed.status, 'INTERIM');
  assert.equal(parsed.runs.baseline.started, 1);
  assert.equal(typeof parsed.inputs['profile-events.jsonl'] === 'string' || parsed.inputs['profile-events.jsonl'] === null, true);
  assert.equal((await run(['status', '--store', storeDir])).code, 0);
  assert.deepEqual(tree(storeDir), locked, 'no write, lock, chmod, mkdir or temp file');
});

test('a store without enrollment reports NOT_ENROLLED; bad arguments exit 2', async () => {
  const storeDir = createOwnedTempDir('eval-none');
  const result = await run(['report', '--store', storeDir, '--json']);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).status, 'NOT_ENROLLED');
  for (const argv of [[], ['report'], ['report', '--store', 'relative/path'], ['report', '--store', storeDir, '--consent'],
    ['enroll', '--store', storeDir, '--json'], ['report', '--store', storeDir, '--id', 'nope'], ['bogus', '--store', storeDir]]) {
    assert.equal((await run(argv)).code, 2, JSON.stringify(argv));
  }
});

test('a snapshot that keeps changing while it is read is refused; one quiet re-read is enough', async () => {
  const storeDir = createOwnedTempDir('eval-snapshot');
  await enroll(storeDir, { consent: true, now: clock('2026-10-01T00:00:00.000Z') });
  const events = path.join(training(storeDir), 'profile-events.jsonl');
  let writes = 0;
  const churn = () => { writes += 1; fs.appendFileSync(events, ''); fs.utimesSync(events, new Date(), new Date(Date.now() + writes * 1000)); };
  fs.writeFileSync(events, '');
  assert.throws(() => readSnapshot(storeDir, { afterRead: churn }), { code: 'SNAPSHOT_UNSTABLE' });
  assert.equal(writes, 3);
  const once = readSnapshot(storeDir, { afterRead: (attempt) => { if (attempt === 1) churn(); } });
  assert.equal(once.attempts, 2);
  assert.equal(once.enrollments.length, 1);
  assert.equal(fs.existsSync(path.join(training(storeDir), ENROLLMENT_FILE)), true);
});
