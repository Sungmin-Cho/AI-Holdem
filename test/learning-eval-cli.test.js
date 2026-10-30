// #298: 학습 효과 평가 CLI — 동의·봉인 일정의 등록, 철회, 읽기 전용 보고와 여러 파일 snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { startDrill } from '../tools/drill-cli.js';
import { ENROLLMENT_FILE, buildReport, enroll, main, readEnrollmentView, readEnrollments, readSnapshot, withdraw } from '../tools/learning-eval.js';
import { appendLedgerRows, readLedger } from '../tools/learning-ledgers.js';
import { openContained } from '../tools/training-store.js';
import { randomUUID } from 'node:crypto';
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
  // 원장도 같은 읽기의 바이트로 판독한다: 첫 읽기 뒤 시작 행이 생기면 다시 읽은 snapshot에 그 행이 있다.
  const runLog = path.join(training(storeDir), 'study-run-log.json');
  const consistent = readSnapshot(storeDir, { afterRead: (attempt) => {
    if (attempt !== 1) return;
    const ledger = JSON.parse(fs.readFileSync(runLog, 'utf8'));
    ledger.rows.push({ type: 'start', startId: '33333333-3333-4333-8333-333333333333', runId: null, mode: 'assessment', total: 0,
      startedAt: '2026-10-01T01:00:00.000Z', sourceIdentity: V3_REFERENCE_SOURCE });
    fs.writeFileSync(runLog, JSON.stringify(ledger));
    fs.utimesSync(runLog, new Date(), new Date(Date.now() + 5000));
  } });
  assert.equal(consistent.attempts, 2);
  assert.equal(consistent.runLog.ledger.rows.length, 1);
  assert.equal(consistent.inputs['study-run-log.json'].length, 64);
  assert.equal(once.enrollments.length, 1);
  assert.equal(fs.existsSync(path.join(training(storeDir), ENROLLMENT_FILE)), true);
});

test('withdrawal is possible after the observation window closes, and by id among several enrollments', async () => {
  const storeDir = createOwnedTempDir('eval-withdraw-late');
  const first = await enroll(storeDir, { consent: true, now: clock('2026-09-01T00:00:00.000Z') });
  const second = await enroll(storeDir, { consent: true, now: clock('2026-10-01T00:00:00.000Z') });
  // 첫 등록의 관측 기간(2026-09-15 마감)이 끝난 뒤에도 id로 철회한다.
  const late = await withdraw(storeDir, { id: first.id, now: clock('2026-10-02T00:00:00.000Z') });
  assert.equal(late.id, first.id);
  await assert.rejects(withdraw(storeDir, { id: first.id, now: clock('2026-10-03T00:00:00.000Z') }), { code: 'NOT_ENROLLED' });
  assert.equal(buildReport(storeDir, { id: first.id, now: '2026-10-03T00:00:00.000Z' }).status, 'WITHDRAWN');
  const result = await run(['withdraw', '--store', storeDir, '--id', second.id], clock('2026-12-01T00:00:00.000Z'));
  assert.equal(result.code, 0, result.err);
  assert.ok(readEnrollments(training(storeDir)).enrollments.every((row) => row.withdrawnAt));
});

test('the snapshot is evaluated from the bytes it checked, not from a re-read', async () => {
  const storeDir = createOwnedTempDir('eval-snapshot-bytes');
  await enroll(storeDir, { consent: true, now: clock('2026-10-01T00:00:00.000Z') });
  const file = path.join(training(storeDir), 'learning-evaluation.json');
  const original = fs.readFileSync(file);
  // 복원이 정확하도록 mtime을 정수 초로 맞춰 둔다.
  const whole = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(file, whole, whole);
  const stat = { atime: whole, mtime: whole };
  // 읽은 뒤 같은 크기·같은 mtime으로 내용만 바꾼다(교체 검사로는 보이지 않는 경우).
  const snapshot = readSnapshot(storeDir, { afterRead: (attempt) => {
    if (attempt !== 1) return;
    const changed = Buffer.from(original.toString('utf8').replace('"withdrawnAt":null', '"withdrawnAt":nul0'));
    fs.writeFileSync(file, changed);
    fs.utimesSync(file, stat.atime, stat.mtime);
  } });
  assert.equal(snapshot.attempts, 1);
  assert.equal(snapshot.enrollments[0].withdrawnAt, null, 'parsed from the checked bytes');
  const { createHash } = await import('node:crypto');
  assert.equal(snapshot.inputs['learning-evaluation.json'], createHash('sha256').update(original).digest('hex'));
});

test('an unreadable recent-view file at enrollment does not let the exposure ledger claim the previous week', async () => {
  const storeDir = createOwnedTempDir('eval-seed-corrupt');
  fs.mkdirSync(training(storeDir), { recursive: true });
  fs.writeFileSync(path.join(training(storeDir), 'grid-exposures.json'), '{ not json');
  await enroll(storeDir, { consent: true, now: clock('2026-10-01T00:00:00.000Z') });
  const { ledger } = readLedger(training(storeDir), 'exposure');
  assert.equal(ledger.seed, 'unavailable');
  assert.equal(ledger.coverageFrom, '2026-10-01T00:00:00.000Z');
});

test('a --id without a value is an argument error and changes nothing', async () => {
  const storeDir = createOwnedTempDir('eval-id-missing');
  await enroll(storeDir, { consent: true, now: clock('2026-10-01T00:00:00.000Z') });
  const before = fs.readFileSync(path.join(training(storeDir), ENROLLMENT_FILE));
  assert.equal((await run(['withdraw', '--store', storeDir, '--id'])).code, 2);
  assert.equal((await run(['report', '--store', storeDir, '--id'])).code, 2);
  assert.deepEqual(fs.readFileSync(path.join(training(storeDir), ENROLLMENT_FILE)), before);
});

test('a file replaced while it is read is retried, and keeps failing after three attempts', async () => {
  const storeDir = createOwnedTempDir('eval-snapshot-replaced');
  await enroll(storeDir, { consent: true, now: clock('2026-10-01T00:00:00.000Z') });
  const replaced = () => Object.assign(new Error('replaced'), { code: 'UNSAFE_PATH' });
  const { openContained } = await import('../tools/training-store.js');
  const real = (root, name, maxBytes) => { try { return openContained(root, [name], { maxBytes }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  let calls = 0;
  const once = readSnapshot(storeDir, { reader: (root, name, maxBytes) => { calls += 1; if (calls === 1) throw replaced(); return real(root, name, maxBytes); } });
  assert.equal(once.attempts, 2);
  assert.throws(() => readSnapshot(storeDir, { reader: () => { throw replaced(); } }), { code: 'SNAPSHOT_UNSTABLE' });
});

test('a recent-view file that is not an array or has any malformed row gives no week of coverage, on enrollment and on a first chart view', async () => {
  const good = { at: new Date(Date.now() - 86_400_000).toISOString(), sourceIdentity: { ...V3_REFERENCE_SOURCE }, spotKey: '6max-100bb-co-rfi-v3' };
  for (const content of [{}, [null], [good, { ...good, at: 'yesterday' }],
    [good, { ...good, sourceIdentity: { id: good.sourceIdentity.id, version: good.sourceIdentity.version } }]]) {
    const enrolled = createOwnedTempDir('eval-seed-shape');
    fs.mkdirSync(training(enrolled), { recursive: true });
    fs.writeFileSync(path.join(training(enrolled), 'grid-exposures.json'), JSON.stringify(content));
    await enroll(enrolled, { consent: true });
    const ledger = readLedger(training(enrolled), 'exposure').ledger;
    assert.equal(ledger.seed, 'unavailable', JSON.stringify(content));
    assert.equal(ledger.coverageFrom, ledger.createdAt);
    // 읽을 수 있는 양성 노출은 남긴다.
    assert.equal(ledger.rows.length, Array.isArray(content) && content[0] === good ? 1 : 0);
  }
  const { readSpotChart } = await import('../tools/drill-cli.js');
  const viewed = createOwnedTempDir('eval-seed-chart');
  fs.mkdirSync(training(viewed), { recursive: true });
  fs.writeFileSync(path.join(training(viewed), 'grid-exposures.json'), '{}');
  await readSpotChart(viewed, { spotKey: '6max-100bb-btn-rfi-v3', source: V3_REFERENCE_SOURCE });
  const chartLedger = readLedger(training(viewed), 'exposure').ledger;
  assert.equal(chartLedger.seed, 'unavailable');
  assert.equal(chartLedger.coverageFrom, chartLedger.createdAt);
});

// ── readEnrollmentView: 학습 화면의 등록 슬롯 뷰 ───────────────────────────────

const T0 = '2026-10-01T00:00:00.000Z';
// 동의 10-01, 개입 7일 → 사후 10-08 ~ 10-15, K=2.
async function enrolledStore(name) {
  const storeDir = createOwnedTempDir(name);
  await enroll(storeDir, { consent: true, plan: { baselineRuns: 2 }, now: clock(T0) });
  return storeDir;
}
const realReader = (root, name, maxBytes) => { try { return openContained(root, [name], { maxBytes }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const runStart = (runId, iso, extra = {}) => ({ type: 'start', startId: randomUUID(), runId, mode: 'assessment', total: 10, startedAt: iso, sourceIdentity: V3_REFERENCE_SOURCE, ...extra });
const replaceRow = (runId, iso) => ({ type: 'replace', startId: randomUUID(), at: iso, mode: 'free', replacedRunId: runId });

test('readEnrollmentView: no open enrollment is null and reads only the enrollment file', async () => {
  const none = createOwnedTempDir('view-none');
  const names = [];
  const counting = (root, name, max) => { names.push(name); return realReader(root, name, max); };
  assert.equal(readEnrollmentView(none, { now: T0, reader: counting }), null);
  assert.deepEqual(names, [ENROLLMENT_FILE]);

  const open = await enrolledStore('view-closed');
  names.length = 0;
  assert.equal(readEnrollmentView(open, { now: '2026-10-15T00:00:00.000Z', reader: counting }), null, 'closed at the close instant');
  assert.deepEqual(names, [ENROLLMENT_FILE]);
  assert.notEqual(readEnrollmentView(open, { now: '2026-10-14T23:59:59.999Z' }), null);

  await withdraw(open, { now: clock('2026-10-02T00:00:00.000Z') });
  names.length = 0;
  assert.equal(readEnrollmentView(open, { now: '2026-10-03T00:00:00.000Z', reader: counting }), null, 'withdrawn');
  assert.deepEqual(names, [ENROLLMENT_FILE]);
});

test('readEnrollmentView: slots before and after the post window, with the current retest run', async () => {
  const storeDir = await enrolledStore('view-slots');
  const root = training(storeDir);
  const [a, b, post1, retest] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  appendLedgerRows(root, 'run', [
    runStart(a, '2026-10-01T01:00:00.000Z'), runStart(b, '2026-10-01T02:00:00.000Z'),
    replaceRow(a, '2026-10-01T03:00:00.000Z'), replaceRow(b, '2026-10-01T03:00:00.000Z'),
    runStart(post1, '2026-10-08T01:00:00.000Z'), replaceRow(post1, '2026-10-08T02:00:00.000Z'),
    runStart(retest, '2026-10-09T01:00:00.000Z', { mode: 'retest', assessmentId: a }),
  ], { at: '2026-10-09T01:00:00.000Z' });

  const early = readEnrollmentView(storeDir, { now: '2026-10-03T00:00:00.000Z' });
  assert.deepEqual(early, {
    status: 'active', postOpen: false, consentedAt: T0, postOpensAt: '2026-10-08T00:00:00.000Z', postClosesAt: '2026-10-15T00:00:00.000Z',
    baselineRuns: 2,
    baselines: [{ slot: 1, runId: a, status: 'UNANSWERED' }, { slot: 2, runId: b, status: 'UNANSWERED' }],
    post: [],
    retention: [{ slot: 1, assessmentId: a, runId: null, status: 'NOT_STARTED', current: false },
      { slot: 2, assessmentId: b, runId: null, status: 'NOT_STARTED', current: false }],
  });

  fs.writeFileSync(path.join(root, 'drill-session.json'), JSON.stringify({ studyRun: { id: retest } }));
  const late = readEnrollmentView(storeDir, { now: '2026-10-10T00:00:00.000Z' });
  assert.equal(late.postOpen, true);
  assert.deepEqual(late.post, [{ slot: 1, runId: post1, status: 'UNANSWERED' }]);
  assert.deepEqual(late.retention, [
    { slot: 1, assessmentId: a, runId: retest, status: 'UNANSWERED', current: true },
    { slot: 2, assessmentId: b, runId: null, status: 'NOT_STARTED', current: false }]);
  // 공개 투영: 중첩 키까지 허용 목록이고 경로·오류 message가 없다.
  assert.deepEqual(Object.keys(late).sort(), ['baselineRuns', 'baselines', 'consentedAt', 'post', 'postClosesAt', 'postOpen', 'postOpensAt', 'retention', 'status']);
  assert.deepEqual(Object.keys(late.baselines[0]).sort(), ['runId', 'slot', 'status']);
  assert.deepEqual(Object.keys(late.post[0]).sort(), ['runId', 'slot', 'status']);
  assert.deepEqual(Object.keys(late.retention[0]).sort(), ['assessmentId', 'current', 'runId', 'slot', 'status']);
  assert.equal(JSON.stringify(late).includes(storeDir), false);
});

test('readEnrollmentView: failures stay inside the view as codes only', async () => {
  const corrupt = createOwnedTempDir('view-corrupt');
  fs.mkdirSync(training(corrupt), { recursive: true });
  fs.writeFileSync(path.join(training(corrupt), ENROLLMENT_FILE), '{ nope');
  assert.deepEqual(readEnrollmentView(corrupt, { now: T0 }), { status: 'unavailable', reasons: ['ENROLLMENT_INVALID'] });

  const lateLedger = await enrolledStore('view-late-ledger');
  const ledgerFile = path.join(training(lateLedger), 'study-run-log.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  ledger.coverageFrom = '2026-10-02T00:00:00.000Z';
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  assert.deepEqual(readEnrollmentView(lateLedger, { now: '2026-10-03T00:00:00.000Z' }), { status: 'unavailable', reasons: ['RUN_LOG_INCOMPLETE'] });

  const unstable = await enrolledStore('view-unstable');
  const unsafe = (root, name, max) => { if (name !== ENROLLMENT_FILE) throw Object.assign(new Error(`${unstable} replaced`), { code: 'UNSAFE_PATH' }); return realReader(root, name, max); };
  const view = readEnrollmentView(unstable, { now: '2026-10-03T00:00:00.000Z', reader: unsafe });
  assert.deepEqual(view, { status: 'unavailable', reasons: ['SNAPSHOT_UNSTABLE'] });
  assert.equal(JSON.stringify(view).includes(unstable), false);

  const odd = readEnrollmentView(unstable, { now: '2026-10-03T00:00:00.000Z', reader: () => { throw new Error('secret path /x/y'); } });
  assert.deepEqual(odd, { status: 'unavailable', reasons: ['ENROLLMENT_VIEW_FAILED'] });
});

test('readEnrollmentView: a withdrawal between the first read and the snapshot gives null', async () => {
  const storeDir = await enrolledStore('view-race');
  const withdrawn = Buffer.from(fs.readFileSync(path.join(training(storeDir), ENROLLMENT_FILE), 'utf8').replace('"withdrawnAt":null', '"withdrawnAt":"2026-10-02T00:00:00.000Z"'));
  let enrollmentReads = 0;
  const reader = (root, name, max) => {
    if (name === ENROLLMENT_FILE && (enrollmentReads += 1) > 1) return withdrawn;
    return realReader(root, name, max);
  };
  assert.equal(readEnrollmentView(storeDir, { now: '2026-10-03T00:00:00.000Z', reader }), null);
  assert.equal(enrollmentReads, 2);
});
