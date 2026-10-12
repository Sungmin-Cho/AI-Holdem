// #274 security: the refusal audit (`.publish-rejections.jsonl`) is the only evidence that lets
// a refused explanation leave the queue. Writing it must never follow a planted link out of the
// game directory, reading it must never mistake a failure for an empty log, it must be durable
// before the attempt it accounts for is removed, and a retirement must settle exactly the body
// that was sent. The publisher and relay are real; failures are injected through the audit
// module's fs seam, never by weakening a production path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../server/server.js';
import { serverProcessStartTime } from '../engine/state.js';
import {
  MAX_PUBLISH_BODY_BYTES,
  MAX_PUBLISH_ID,
  TRAINING_CHUNK_SLACK_BYTES,
  annotationBodyByteLength,
  gameEpochOf,
  isRetirableAnnotationRejection,
  recheckRejectionTupleOf,
  rejectionTupleOf,
  projectTrainingAnnotation,
  publicProofId,
  sha256Hex,
} from '../publish-contract.js';
import {
  REJECTION_LINE_MAX_BYTES,
  REJECTION_LOG,
  REJECTION_LOG_MAX_BYTES,
  RETIREMENT_EVIDENCE,
  RETIREMENT_EVIDENCE_MAX_BYTES,
  appendRejectionRecord,
  installAttemptDurably,
  readRejectionRecords,
  rejectionRecordByteLength,
  removeDurably,
} from '../tools/rejection-audit.js';
import { PUBLIC_CODES, projectDiagnosticCode, projectPublicCode } from '../tools/diagnostic-codes.js';
import { createTrainingControl } from '../tools/training-control.js';
import { syncDirectory } from '../tools/training-store.js';
import * as pipeline from '../tools/training-pipeline.js';
import { writeSecurityFixtures } from './helpers/security-fixtures.js';
import { q3Evaluation, readJson, tmpQ3, writeJson } from './helpers/q3-fixtures.js';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/publish.js');
const TOKEN = 'tok';
const EPOCH = gameEpochOf(TOKEN);
const OWNER = 'owner-274-audit';
const LEAKING_TEXT = 'BTN에서 7c를 든 상대 앞에서 AJo는 레이즈가 주력입니다.';
const SENTINEL = 'OUTSIDE-SENTINEL-must-never-change\n';
const attemptFile = (dir) => path.join(dir, '.publish-attempt.json');
const logFile = (dir) => path.join(dir, REJECTION_LOG);
const authorityFile = (dir) => path.join(dir, 'training', '.training-authority.json');
const RECORD = { schemaVersion: 1, publishId: 7, bodySha256: 'ab'.repeat(32), httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL', items: [] };
// New-game defaults (shared/game-setup.js): archived hands are public in replay, so only the
// hand in progress can keep a card private. Stated explicitly so the fixtures below mean what
// a real session means — the archived hand 1 fixture also holds p1's 7c, and without this it
// would stay private after the live hand released it.
const OWNED_CONFIG = { replayReveal: 'all', showdownPolicy: 'open' };

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An outside file an attacker would like the publisher to overwrite.
function outsideSentinel(t) {
  const dir = scratch(t, 'holdem-274-outside-');
  const file = path.join(dir, 'sentinel.txt');
  fs.writeFileSync(file, SENTINEL);
  return file;
}

function runPublisher(dir, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [TOOL, ...args, '--game-dir', dir], { encoding: 'utf8', timeout: 20_000 }, (error, stdout) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok !== true) {
        reject(Object.assign(new Error(envelope?.message ?? 'publisher failed'), {
          code: envelope?.code ?? error?.code ?? 'CHILD_FAILED', envelope,
        }));
        return;
      }
      resolve(envelope);
    });
  });
}

function relayBinding(dir) {
  const lock = readJson(path.join(dir, 'lock.json'));
  return { pid: lock.serverPid, startTime: serverProcessStartTime(lock.serverPid), port: lock.port, sessionToken: lock.sessionToken };
}

function retireArgs(record, binding) {
  return ['--retire-rejected',
    '--expect-attempt-sha256', sha256Hex(JSON.stringify(record.body)),
    '--expect-game-epoch', record.expectedGameEpoch,
    '--relay-pid', String(binding.pid), '--relay-start-time', binding.startTime,
    '--relay-port', String(binding.port)];
}

// A real relay holding a machine row, and a refused explanation left as the recorded attempt.
// `others`: further evaluations accepted and machine-published together with the refused one,
// BEFORE anything is sealed or refused — once A's attempt is pending, no machine row can be
// published past it without a retirement, so a fixture that needs B must seed it here.
async function refusedAttempt(t, { others = [] } = {}) {
  const dir = tmpQ3('holdem-274-audit-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSecurityFixtures(dir, { config: OWNED_CONFIG, handInProgress: { handNo: 2, holes: { p1: ['7c', '2d'] } } });
  const relay = await startServer({ gameDir: dir, port: 0, token: TOKEN });
  t.after(() => relay.close());
  const tc = createTrainingControl();
  const evaluation = q3Evaluation(EPOCH);
  const execute = (args) => runPublisher(dir, args);
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [evaluation, ...others] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: execute, trainingControl: tc });
  // The authority as it was before the seal: what a permitted crash rollback could restore.
  const preSealAuthority = fs.readFileSync(authorityFile(dir), 'utf8');
  assert.equal((await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: execute, trainingControl: tc })
    .then(() => assert.fail('the explanation must be refused'), (error) => assert.equal(error.code, 'PUBLISH_REJECTED'));
  const record = readJson(attemptFile(dir));
  const envelope = path.join(dir, 'retire.json');
  writeJson(envelope, { trainingAnnotations: record.body.trainingAnnotations, annotationAuthority: record.annotationAuthority });
  return { dir, relay, tc, evaluation, others, record, envelope, execute, preSealAuthority, attemptBytes: fs.readFileSync(attemptFile(dir), 'utf8') };
}

// fs with selected calls replaced; everything else is the real module.
function fsWith(overrides) {
  return new Proxy(fs, { get: (target, key) => (key in overrides ? overrides[key] : target[key]) });
}

const TMP_RE = new RegExp(`^${REJECTION_LOG.replaceAll('.', '\\.')}\\..+\\.tmp$`);
const evidenceFile = (dir) => path.join(dir, RETIREMENT_EVIDENCE);

test('audit writer: a symlink, hard link, directory or oversized final target is refused and the outside file is untouched', (t) => {
  const sentinel = outsideSentinel(t);
  for (const [label, plant] of [
    ['symlink', (dir) => fs.symlinkSync(sentinel, logFile(dir))],
    ['hard link', (dir) => fs.linkSync(sentinel, logFile(dir))],
    ['directory', (dir) => fs.mkdirSync(logFile(dir))],
    ['oversized', (dir) => fs.writeFileSync(logFile(dir), 'x'.repeat(600 * 1024))],
  ]) {
    const dir = scratch(t, 'holdem-274-final-');
    plant(dir);
    assert.throws(() => appendRejectionRecord(dir, RECORD), { code: 'REJECTION_AUDIT_UNSAFE' }, label);
    assert.throws(() => readRejectionRecords(dir), { code: 'REJECTION_AUDIT_UNSAFE' }, `${label} read`);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), SENTINEL, `${label}: the outside file changed`);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => TMP_RE.test(name)), [], `${label}: a temporary file was left behind`);
  }
});

test('audit writer: a symlink or hard link planted at the temporary name is never written through', (t) => {
  const sentinel = outsideSentinel(t);
  for (const [label, plant] of [
    ['symlink', (target) => fs.symlinkSync(sentinel, target)],
    ['hard link', (target) => fs.linkSync(sentinel, target)],
  ]) {
    const dir = scratch(t, 'holdem-274-tmp-');
    fs.writeFileSync(logFile(dir), `${JSON.stringify({ earlier: true })}\n`);
    const before = fs.readFileSync(logFile(dir), 'utf8');
    const planted = [];
    // The attacker wins every race: just before the writer creates its temporary file, a link
    // to the outside file appears at exactly that name.
    const fsImpl = fsWith({
      openSync(file, flags, mode) {
        if (TMP_RE.test(path.basename(String(file)))) { plant(file); planted.push(file); }
        return fs.openSync(file, flags, mode);
      },
    });
    assert.throws(() => appendRejectionRecord(dir, RECORD, { fsImpl }), { code: 'REJECTION_AUDIT_UNAVAILABLE' }, label);
    assert.equal(planted.length, 1, label);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), SENTINEL, `${label}: the outside file changed`);
    assert.equal(fs.readFileSync(logFile(dir), 'utf8'), before, `${label}: the log changed`);
    assert.equal(fs.lstatSync(planted[0]).isSymbolicLink() || fs.lstatSync(planted[0]).nlink > 1, true, `${label}: the planted link must not be replaced`);
  }
  // And the name is not predictable from the pid, as the old `${file}.${pid}.tmp` was.
  const dir = scratch(t, 'holdem-274-tmpname-');
  const names = [];
  appendRejectionRecord(dir, RECORD, { onStep: (step) => { if (step === 'tmp-synced') names.push(...fs.readdirSync(dir).filter((n) => TMP_RE.test(n))); } });
  assert.equal(names.length, 1);
  assert.equal(names[0].includes(`.${process.pid}.tmp`), false);
});

test('audit reads: only a missing log is empty — every other failure throws and the log is kept', (t) => {
  const dir = scratch(t, 'holdem-274-read-');
  assert.deepEqual(readRejectionRecords(dir), [], 'ENOENT is the one empty case');
  fs.writeFileSync(logFile(dir), `${JSON.stringify({ earlier: 1 })}\n`);
  const before = fs.readFileSync(logFile(dir), 'utf8');
  const eio = Object.assign(new Error('io'), { code: 'EIO' });
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  for (const [label, fsImpl] of [
    ['read EIO', fsWith({ readSync() { throw eio; } })],
    ['lstat EACCES', fsWith({ lstatSync(file) { if (String(file).endsWith(REJECTION_LOG)) throw eacces; return fs.lstatSync(file); } })],
    ['open EACCES', fsWith({ openSync(file, ...rest) { if (String(file).endsWith(REJECTION_LOG)) throw eacces; return fs.openSync(file, ...rest); } })],
    ['short read', fsWith({ readSync() { return 0; } })],
  ]) {
    assert.throws(() => readRejectionRecords(dir, { fsImpl }), { code: 'REJECTION_AUDIT_UNAVAILABLE' }, label);
    assert.throws(() => appendRejectionRecord(dir, RECORD, { fsImpl }), { code: 'REJECTION_AUDIT_UNAVAILABLE' }, `${label} append`);
    assert.equal(fs.readFileSync(logFile(dir), 'utf8'), before, `${label}: earlier evidence must survive`);
  }
  // A write or fsync failure leaves the log exactly as it was and no temporary file behind.
  for (const [label, fsImpl] of [
    ['write ENOSPC', fsWith({ writeFileSync(fd, data) { if (typeof fd === 'number') throw Object.assign(new Error('full'), { code: 'ENOSPC' }); return fs.writeFileSync(fd, data); } })],
    ['fsync EIO', fsWith({ fsyncSync() { throw eio; } })],
    ['rename EXDEV', fsWith({ renameSync() { throw Object.assign(new Error('xdev'), { code: 'EXDEV' }); } })],
  ]) {
    assert.throws(() => appendRejectionRecord(dir, RECORD, { fsImpl }), { code: 'REJECTION_AUDIT_UNAVAILABLE' }, label);
    assert.equal(fs.readFileSync(logFile(dir), 'utf8'), before, label);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => TMP_RE.test(name)), [], `${label}: temporary file left behind`);
  }
});

test('audit writer: a concurrent change to the log aborts the install instead of losing a line', (t) => {
  const dir = scratch(t, 'holdem-274-race-');
  fs.writeFileSync(logFile(dir), `${JSON.stringify({ first: 1 })}\n`);
  const other = `${JSON.stringify({ first: 1 })}\n${JSON.stringify({ concurrent: 2 })}\n`;
  assert.throws(() => appendRejectionRecord(dir, RECORD, {
    onStep: (step) => { if (step === 'tmp-synced') fs.writeFileSync(logFile(dir), other); },
  }), { code: 'REJECTION_AUDIT_CHANGED' });
  assert.equal(fs.readFileSync(logFile(dir), 'utf8'), other, 'the concurrent line survives');
  // A log that appears where none was read is a change too.
  const fresh = scratch(t, 'holdem-274-race2-');
  assert.throws(() => appendRejectionRecord(fresh, RECORD, {
    onStep: (step) => { if (step === 'tmp-synced') fs.writeFileSync(logFile(fresh), other); },
  }), { code: 'REJECTION_AUDIT_CHANGED' });
  assert.equal(fs.readFileSync(logFile(fresh), 'utf8'), other);
});

// Real POSIX directory durability through the real filesystem: on Windows a directory cannot be
// opened for fsync from Node (the documented limitation), so this check is POSIX-only; the
// Windows path is exercised on every platform by the test after the syncDirectory one.
test('audit durability: file fsync, then install, then directory fsync; removal is unlink then directory fsync', { skip: process.platform === 'win32' ? 'real POSIX directory fsync' : false }, (t) => {
  const dir = scratch(t, 'holdem-274-order-');
  const calls = [];
  const fds = new Map();
  const fsImpl = fsWith({
    openSync(file, ...rest) { const fd = fs.openSync(file, ...rest); fds.set(fd, String(file)); return fd; },
    fsyncSync(fd) { const f = fds.get(fd); calls.push(`fsync:${f === dir ? 'dir' : (TMP_RE.test(path.basename(f)) ? 'tmp' : f)}`); return fs.fsyncSync(fd); },
    renameSync(from, to) { calls.push(`rename:${path.basename(to)}`); return fs.renameSync(from, to); },
    unlinkSync(file) { calls.push(`unlink:${path.basename(String(file))}`); return fs.unlinkSync(file); },
  });
  appendRejectionRecord(dir, RECORD, { fsImpl, platform: 'darwin' });
  assert.deepEqual(calls, ['fsync:tmp', `rename:${REJECTION_LOG}`, 'fsync:dir']);
  assert.deepEqual(readRejectionRecords(dir), [RECORD]);

  calls.length = 0;
  fs.writeFileSync(path.join(dir, '.publish-attempt.json'), '{}');
  removeDurably(dir, '.publish-attempt.json', { fsImpl, platform: 'darwin' });
  assert.deepEqual(calls, ['unlink:.publish-attempt.json', 'fsync:dir']);

  // Windows cannot fsync a directory from Node: the install still happens, without that step.
  calls.length = 0;
  appendRejectionRecord(dir, { ...RECORD, publishId: 8 }, { fsImpl, platform: 'win32' });
  assert.deepEqual(calls, ['fsync:tmp', `rename:${REJECTION_LOG}`]);
  // A directory fsync failure on POSIX is a failure, not a shrug.
  assert.throws(() => removeDurably(dir, 'absent', {
    fsImpl: fsWith({ fsyncSync() { throw Object.assign(new Error('io'), { code: 'EIO' }); } }), platform: 'linux',
  }), { code: 'REJECTION_AUDIT_UNAVAILABLE' });
});

test('syncDirectory: fsyncs the directory itself on POSIX, reports the Windows limitation instead of claiming a sync, and refuses a link', { skip: process.platform === 'win32' ? 'real POSIX directory fsync' : false }, (t) => {
  const dir = scratch(t, 'holdem-274-syncdir-');
  const calls = [];
  const fsImpl = fsWith({
    openSync(file, ...rest) { calls.push(`open:${String(file) === dir ? 'dir' : 'other'}`); return fs.openSync(file, ...rest); },
    fsyncSync(fd) { calls.push('fsync'); return fs.fsyncSync(fd); },
  });
  assert.deepEqual(syncDirectory(dir, { fsImpl, platform: 'linux' }), { synced: true });
  assert.deepEqual(calls, ['open:dir', 'fsync']);
  calls.length = 0;
  assert.deepEqual(syncDirectory(dir, { fsImpl, platform: 'win32' }), { synced: false, reason: 'win32' });
  assert.deepEqual(calls, [], 'Windows: no directory handle, and no claim of durability');
  assert.throws(() => syncDirectory(dir, {
    fsImpl: fsWith({ fsyncSync() { throw Object.assign(new Error('io'), { code: 'EIO' }); } }), platform: 'linux',
  }), { code: 'EIO' });
  const link = path.join(scratch(t, 'holdem-274-synclink-'), 'link');
  fs.symlinkSync(dir, link);
  assert.throws(() => syncDirectory(link, { platform: 'linux' }), { code: 'UNSAFE_PATH' });
  assert.throws(() => syncDirectory(path.join(dir, 'absent'), { platform: 'linux' }), { code: 'ENOENT' });
});

test('real relay: an unsafe audit target keeps the exact attempt and queue, reports only the original refusal, and touches nothing outside', async (t) => {
  for (const [label, plant] of [
    ['final symlink', (dir, sentinel) => fs.symlinkSync(sentinel, logFile(dir))],
    ['final hard link', (dir, sentinel) => fs.linkSync(sentinel, logFile(dir))],
    ['legacy predictable temporary names', (dir, sentinel) => {
      // The pre-fix writer used `${log}.${pid}.tmp`; plant links at a band of such names.
      for (let pid = process.pid; pid < process.pid + 64; pid += 1) fs.symlinkSync(sentinel, `${logFile(dir)}.${pid}.tmp`);
      fs.symlinkSync(sentinel, logFile(dir));
    }],
  ]) {
    const sentinel = outsideSentinel(t);
    const f = await refusedAttempt(t);
    plant(f.dir, sentinel);
    const error = await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))]).then(() => null, (e) => e);
    assert.equal(error?.code, 'REJECTION_AUDIT_FAILED', label);
    assert.deepEqual([error.envelope.httpStatus, error.envelope.serverCode, error.envelope.auditCode], [400, 'FORBIDDEN_LITERAL', 'REJECTION_AUDIT_UNSAFE'], label);
    assert.deepEqual(Object.keys(error.envelope).sort(), ['auditCode', 'code', 'httpStatus', 'message', 'ok', 'serverCode'], label);
    assert.equal(JSON.stringify(error.envelope).includes('7c'), false, `${label}: no annotation text`);
    assert.equal(JSON.stringify(error.envelope).includes(f.dir), false, `${label}: no path`);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), SENTINEL, `${label}: the outside file changed`);
    assert.equal(fs.readFileSync(attemptFile(f.dir), 'utf8'), f.attemptBytes, `${label}: the attempt must be exactly preserved`);
    assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation, `${label}: the queue must be preserved`);
    // Through the caller too: nothing is settled, the original refusal stays visible.
    await assert.rejects(pipeline.retireRejectedAnnotationAttempt(f.dir, {
      executePublish: f.execute, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir),
    }), (e) => e.code === 'REJECTION_AUDIT_FAILED' && e.envelope.serverCode === 'FORBIDDEN_LITERAL', label);
    assert.equal(fs.readFileSync(attemptFile(f.dir), 'utf8'), f.attemptBytes, label);
    assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation, label);
  }
});

test('training control: an unreadable or unsafe audit is never read as "no evidence yet" and settles nothing', async (t) => {
  const f = await refusedAttempt(t);
  const out = await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))]);
  assert.equal(out.retired, true);
  const genuine = fs.readFileSync(logFile(f.dir), 'utf8');
  const sentinel = outsideSentinel(t);
  for (const [label, plant] of [
    ['symlink', () => { fs.rmSync(logFile(f.dir), { force: true }); fs.writeFileSync(sentinel, genuine); fs.symlinkSync(sentinel, logFile(f.dir)); }],
    ['hard link', () => { fs.rmSync(logFile(f.dir), { force: true }); fs.writeFileSync(sentinel, genuine); fs.linkSync(sentinel, logFile(f.dir)); }],
    ['directory', () => { fs.rmSync(logFile(f.dir), { force: true }); fs.mkdirSync(logFile(f.dir)); }],
  ]) {
    plant();
    await assert.rejects(f.tc.retireRejectedAnnotations(f.dir, out.rejection), { code: 'REJECTION_EVIDENCE_UNAVAILABLE' }, label);
    assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation, `${label}: queue kept`);
    fs.rmSync(logFile(f.dir), { recursive: true, force: true });
  }
  // Restored as a regular file, the same evidence settles it.
  fs.writeFileSync(logFile(f.dir), genuine);
  assert.deepEqual(await f.tc.retireRejectedAnnotations(f.dir, out.rejection), { retired: 1, isolated: 0, skipped: 0 });
});

test('crash boundaries: audit durable but attempt kept, and attempt removed but queue unsettled, both recover without loss', async (t) => {
  const f = await refusedAttempt(t);
  const first = await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))]);
  assert.equal(first.retired, true);
  assert.equal(fs.existsSync(attemptFile(f.dir)), false);
  // Boundary 2 (removed, queue not yet settled): the queue still holds the entry; a later
  // process settles it from the private evidence (see the production recovery test below),
  // never from the digest-only line alone.
  assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation);
  assert.equal(fs.existsSync(evidenceFile(f.dir)), true);

  // Boundary 1 (evidence and line durable, attempt not yet removed): put the identical attempt
  // back. While it is recorded the evidence is not applied; the next retirement resends it,
  // replaces the same-body evidence, adds a second line, and settles it once.

  fs.writeFileSync(attemptFile(f.dir), f.attemptBytes);
  assert.deepEqual(await f.tc.reconcileRetiredAnnotations(f.dir), {
    pending: true, publishId: f.record.body.publishId, bodySha256: sha256Hex(JSON.stringify(f.record.body)),
  }, 'a still-recorded attempt means the retirement is unfinished: nothing is applied');
  assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation);
  const settled = await pipeline.retireRejectedAnnotationAttempt(f.dir, {
    executePublish: f.execute, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir),
  });
  assert.equal(settled.retired, true);
  assert.equal(settled.dropped, 1);
  const lines = fs.readFileSync(logFile(f.dir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].bodySha256, lines[1].bodySha256);
  // Replaying the first report is idempotent.
  assert.deepEqual(await f.tc.retireRejectedAnnotations(f.dir, first.rejection), { retired: 0, isolated: 0, skipped: 1 });
});

test('concurrent retirement: two helpers on one attempt retire it once; a replaced attempt is left intact and unsent', async (t) => {
  const f = await refusedAttempt(t);
  // Two helpers in one process, each with its own training control (a loop and a flush do not
  // share one): both enter the retirement settlement at once. The first holds the training
  // mutex while the second must not spin on it (the mutex waits synchronously and would starve
  // the first helper's release, timing out as LOCKED): they are queued per session instead.
  const options = { executePublish: f.execute, relayBinding: () => relayBinding(f.dir) };
  const results = await Promise.all([
    pipeline.retireRejectedAnnotationAttempt(f.dir, { ...options, trainingControl: f.tc }),
    pipeline.retireRejectedAnnotationAttempt(f.dir, { ...options, trainingControl: createTrainingControl() }),
  ]);
  assert.equal(results.filter((r) => r.retired === true).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.settledElsewhere === true).length, 1, JSON.stringify(results));
  assert.equal(fs.readFileSync(logFile(f.dir), 'utf8').trim().split('\n').length, 1);
  assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId], undefined);
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'the one retirement consumed its evidence');

  // The same contention one level down, across distinct control instances on unsettled
  // evidence (the interrupted-retirement shape): both reconcile at once, exactly one settles
  // it, the other finds nothing left, neither times out and nothing is settled twice.
  const h = await refusedAttempt(t);
  assert.equal((await runPublisher(h.dir, ['--from', h.envelope, ...retireArgs(h.record, relayBinding(h.dir))])).retired, true);
  assert.equal(fs.existsSync(evidenceFile(h.dir)), true);
  const reconciled = await Promise.all([
    createTrainingControl().reconcileRetiredAnnotations(h.dir),
    createTrainingControl().reconcileRetiredAnnotations(h.dir),
    createTrainingControl().reconcileRetiredAnnotations(h.dir),
  ]);
  const settledOnce = reconciled.filter((r) => r && r.pending === false && r.retired === 1);
  assert.equal(settledOnce.length, 1, JSON.stringify(reconciled));
  assert.deepEqual(reconciled.filter((r) => r === null).length, 2, JSON.stringify(reconciled));
  assert.equal(settledOnce[0].publishId, h.record.body.publishId);
  assert.equal(fs.existsSync(evidenceFile(h.dir)), false);
  const hAuth = h.tc.loadAuthority(h.dir);
  assert.equal(hAuth.annotationQueue[h.evaluation.evaluationId], undefined);
  assert.equal(hAuth.items[h.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(auditLines(h.dir).length, 1, 'no line was added by the settlement');

  // Helper reads A; before its publisher runs, the attempt becomes B (same annotations, the
  // next id). The publisher refuses to send B on A's behalf and leaves B exactly as it is.
  const g = await refusedAttempt(t);
  const replaced = { ...g.record, body: { ...g.record.body, publishId: g.record.body.publishId + 1 } };
  const replacedBytes = JSON.stringify(replaced);
  const snapshotBefore = fs.readFileSync(path.join(g.dir, 'ui-snapshot.json'), 'utf8');
  await assert.rejects(pipeline.retireRejectedAnnotationAttempt(g.dir, {
    executePublish: (args) => { fs.writeFileSync(attemptFile(g.dir), replacedBytes); return g.execute(args); },
    trainingControl: g.tc, relayBinding: () => relayBinding(g.dir),
  }), { code: 'ATTEMPT_CHANGED' });
  assert.equal(fs.readFileSync(attemptFile(g.dir), 'utf8'), replacedBytes);
  assert.equal(fs.existsSync(logFile(g.dir)), false);
  assert.equal(fs.readFileSync(path.join(g.dir, 'ui-snapshot.json'), 'utf8'), snapshotBefore, 'nothing was sent');
  assert.ok(g.tc.loadAuthority(g.dir).annotationQueue[g.evaluation.evaluationId]?.explanation);

  // A publisher result that names a body other than the one this helper read — accepted or
  // retired — settles nothing.
  fs.writeFileSync(attemptFile(g.dir), g.attemptBytes);
  for (const out of [
    { ok: true, applied: true, publishId: g.record.body.publishId, bodySha256: 'cd'.repeat(32) },
    { ok: true, applied: true, publishId: g.record.body.publishId + 1, bodySha256: sha256Hex(JSON.stringify(g.record.body)) },
    { ok: true, retired: true, applied: false, rejection: { publishId: g.record.body.publishId, expectedGameEpoch: EPOCH, bodySha256: 'cd'.repeat(32), httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' } },
  ]) {
    await assert.rejects(pipeline.retireRejectedAnnotationAttempt(g.dir, {
      executePublish: async () => out, trainingControl: g.tc, relayBinding: () => relayBinding(g.dir),
    }), { code: 'RETIRE_RESULT_UNBOUND' });
    const queued = g.tc.loadAuthority(g.dir).annotationQueue[g.evaluation.evaluationId]?.explanation;
    assert.ok(queued && !queued.published, 'the annotation must not be marked published');
  }
  // And no helper may call the publisher without a verified binding.
  let called = false;
  await assert.rejects(pipeline.retireRejectedAnnotationAttempt(g.dir, {
    executePublish: async () => { called = true; return {}; }, trainingControl: g.tc,
  }), { code: 'RELAY_BINDING_UNVERIFIED' });
  await assert.rejects(pipeline.retireRejectedAnnotationAttempt(g.dir, {
    executePublish: async () => { called = true; return {}; }, trainingControl: g.tc,
    relayBinding: () => ({ ...relayBinding(g.dir), sessionToken: 'another-game' }),
  }), { code: 'RELAY_BINDING_UNVERIFIED' });
  assert.equal(called, false);
});

test('run/cleanup diagnostics use a closed vocabulary: identifier-shaped secrets become UNLISTED', () => {
  assert.equal(projectDiagnosticCode('CHILD_CLOSE_UNCONFIRMED'), 'CHILD_CLOSE_UNCONFIRMED');
  assert.equal(projectDiagnosticCode('PUBLISH_REJECTED'), 'PUBLISH_REJECTED');
  for (const secret of ['SECRET_As_Kh_tok123', 'tok', 'X_SIGNAL_7c2d', 'A'.repeat(40), 'ERROR ', '__proto__', 'constructor']) {
    assert.equal(projectDiagnosticCode(secret), 'UNLISTED', secret);
  }
  assert.equal(projectDiagnosticCode({ code: 'ERROR' }), 'UNLISTED');
  assert.equal(projectDiagnosticCode(undefined), null);
});

// #274 recovery boundary. The interruption the digest-only line cannot repair: the publisher
// retired the refused body (private evidence, audit line, attempt removed) and the process
// stopped before anything settled the queue. Nothing restores the attempt here; recovery runs
// through the production flush (what a resumed loop runs) with a fresh training control.
const SAFE_TEXT = 'AJo는 버튼에서 레이즈가 주력입니다.';

function recordingPublisher(dir) {
  const calls = [];
  const execute = async (args) => {
    const from = args.indexOf('--from');
    const body = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    calls.push({ flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (body?.trainingAnnotations ?? []).map((note) => note.evaluationId) });
    return runPublisher(dir, args);
  };
  return { calls, execute };
}

// The private-literal context changes: the hand being played no longer holds the card the
// refused explanation names, so a fresh publication of that text would now be accepted.
function releaseLeakedCard(dir) {
  const statePath = path.join(dir, 'state.json');
  const state = readJson(statePath);
  state.hand.holes.p1 = ['8c', '2d'];
  writeJson(statePath, state);
}

const auditLines = (dir) => fs.readFileSync(logFile(dir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('production recovery: an interrupted retirement (attempt gone, queue unsettled) is settled from private evidence before any annotation is built — never resent, even after the private-literal context changes', async (t) => {
  const f = await refusedAttempt(t);
  const binding = relayBinding(f.dir);
  const out = await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, binding)]);
  assert.equal(out.retired, true);
  // The interruption: the attempt is gone and the queue still holds the refused entry.
  assert.equal(fs.existsSync(attemptFile(f.dir)), false);
  assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation);

  // The private evidence holds the exact retired body, its authority and the verified relay
  // (never the token); it is a regular, single-link, owner-only file.
  const st = fs.lstatSync(evidenceFile(f.dir));
  assert.equal(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, true);
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
  const evidenceBytes = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  const evidence = JSON.parse(evidenceBytes);
  assert.deepEqual(evidence.body, f.record.body, 'the exact retired body');
  assert.deepEqual(evidence.annotationAuthority, f.record.annotationAuthority, 'the exact annotation authority and proof binding');
  assert.equal(evidence.bodySha256, sha256Hex(JSON.stringify(f.record.body)));
  assert.equal(evidence.expectedGameEpoch, EPOCH);
  assert.deepEqual(evidence.relayBinding, { pid: binding.pid, startTime: binding.startTime, port: binding.port });
  assert.deepEqual([evidence.httpStatus, evidence.serverCode, evidence.publishId], [400, 'FORBIDDEN_LITERAL', f.record.body.publishId]);
  assert.equal(evidenceBytes.includes('sessionToken'), false);
  assert.equal(evidenceBytes.includes(`"${TOKEN}"`), false, 'no relay token in the private evidence');
  // The public line and the publisher's reply stay value-free: digests and closed fields only.
  const [line] = auditLines(f.dir);
  assert.deepEqual(Object.keys(line).sort(), ['at', 'bodySha256', 'expectedGameEpoch', 'httpStatus', 'items', 'publishId', 'schemaVersion', 'serverCode']);
  assert.deepEqual(Object.keys(line.items[0]).sort(), ['evaluationId', 'field', 'valueSha256']);
  for (const text of [JSON.stringify(line), JSON.stringify(out)]) {
    assert.equal(text.includes(LEAKING_TEXT), false);
    assert.equal(text.includes('sessionToken') || text.includes(`"${TOKEN}"`), false);
    assert.equal(text.includes(f.dir), false);
  }

  releaseLeakedCard(f.dir);
  const restartTc = createTrainingControl();
  const publisher = recordingPublisher(f.dir);
  // A restarted loop first retries the recorded attempt (there is none) and then flushes.
  await pipeline.retryUnresolvedTrainingAttempt(f.dir, { executePublish: publisher.execute });
  await pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: restartTc });

  assert.deepEqual(publisher.calls, [], 'the retired explanation is settled, not resent');
  const auth = restartTc.loadAuthority(f.dir);
  assert.equal(auth.annotationQueue[f.evaluation.evaluationId], undefined);
  const kept = auth.items[f.evaluation.evaluationId].annotations.explanation;
  assert.equal(kept.publishFailed, 'rejected');
  assert.equal(kept.published, false);
  assert.deepEqual([kept.rejection.publishId, kept.rejection.httpStatus, kept.rejection.serverCode], [f.record.body.publishId, 400, 'FORBIDDEN_LITERAL']);
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'the evidence is consumed once the authority is durable');
  assert.equal(auditLines(f.dir).length, 1);
  assert.equal(Object.hasOwn(readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {}, f.evaluation.evaluationId), false);

  // Authority durable, evidence removal lost: the replay changes nothing and consumes it again.
  const authorityBytes = fs.readFileSync(authorityFile(f.dir), 'utf8');
  fs.writeFileSync(evidenceFile(f.dir), evidenceBytes, { mode: 0o600 });
  const replay = await restartTc.reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([replay.pending, replay.retired, replay.isolated, replay.skipped], [false, 0, 0, 1]);
  assert.equal(fs.readFileSync(authorityFile(f.dir), 'utf8'), authorityBytes, 'an idempotent replay does not rewrite the authority');
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false);
  assert.equal(await restartTc.reconcileRetiredAnnotations(f.dir), null, 'nothing left to settle');
  await pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: restartTc });
  assert.deepEqual(publisher.calls, []);

  // The changed context is real: a new explanation naming the same card is accepted now, and
  // it is the only annotation that reaches the relay.
  const later = q3Evaluation(EPOCH, 'd-1-preflop-1');
  await restartTc.acceptEvaluations(f.dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [later] });
  await pipeline.flushMachinePublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: restartTc });
  assert.equal((await restartTc.sealAnnotation(f.dir, later.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: restartTc });
  assert.deepEqual(publisher.calls.flatMap((call) => call.ids), [later.evaluationId]);
  const relayed = readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {};
  assert.equal(Object.hasOwn(relayed, later.evaluationId), true);
  assert.equal(Object.hasOwn(relayed, f.evaluation.evaluationId), false, 'the retired one never reached the relay');
});

// #274 crash durability. The authority is replaced by rename into training/; that entry is
// durable only once the directory is synced. The evidence that could redo the retirement must
// not be consumed before then — otherwise a power loss keeps the deletion and loses the
// disposition, and the refused explanation returns to the queue with nothing to stop a resend.
test('retirement durability: the training directory is synced after the disposition is written and before the evidence is consumed; a sync failure keeps the evidence, and the unchanged replay syncs again', async (t) => {
  const f = await refusedAttempt(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const id = f.evaluation.evaluationId;
  const evidenceBytes = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  const queuedBytes = fs.readFileSync(authorityFile(f.dir), 'utf8');
  assert.ok(JSON.parse(queuedBytes).annotationQueue[id]?.explanation, 'interrupted: the queue still holds the refused entry');
  const observed = [];
  let failSync = true;
  let callsThisSettlement = 0;
  const io = {
    // Records what is on disk at the moment a directory is synced. One verified settlement
    // syncs three times, in order: training/annotations and training BEFORE the disposition
    // (canonical names), then training again AFTER the disposition is written and before the
    // evidence is removed — the authority boundary this test injects the failure at (the
    // third sync of a settlement). The restoration regression covers the earlier boundary.
    syncDirectory(dir) {
      callsThisSettlement += 1;
      const auth = readJson(authorityFile(f.dir));
      observed.push({
        dir: path.basename(dir),
        queued: Boolean(auth.annotationQueue[id]?.explanation),
        retired: auth.items[id].annotations.explanation.publishFailed === 'rejected',
        evidence: fs.existsSync(evidenceFile(f.dir)),
      });
      if (failSync && callsThisSettlement === 3) throw Object.assign(new Error('io'), { code: 'EIO' });
      return syncDirectory(dir);
    },
  };
  const tc = createTrainingControl({ io });
  const publisher = recordingPublisher(f.dir);
  const beforeDisposition = { queued: true, retired: false, evidence: true };
  const afterDisposition = { queued: false, retired: true, evidence: true };
  const names = (state) => [{ dir: 'annotations', ...state }, { dir: 'training', ...state }];
  const authority = { dir: 'training', ...afterDisposition };

  // 1. The production flush path: the canonical names are synced, the disposition is written,
  // the authority sync fails, and recovery fails closed — evidence kept, nothing built, nothing
  // sent, the cause named by errno only.
  await assert.rejects(
    pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: tc }),
    (error) => error.code === 'REJECTION_EVIDENCE_UNAVAILABLE' && error.causeCode === 'EIO',
  );
  assert.deepEqual(observed, [...names(beforeDisposition), authority], 'names synced before the disposition; the authority synced after it was written, while the evidence still exists');
  assert.deepEqual(publisher.calls, [], 'nothing is built or sent while the disposition is not durable');
  assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), evidenceBytes, 'the evidence survives the failed sync');
  const settledBytes = fs.readFileSync(authorityFile(f.dir), 'utf8');
  assert.notEqual(settledBytes, queuedBytes, 'the disposition itself was written before the authority sync was attempted');
  assert.equal(JSON.parse(settledBytes).annotationQueue[id], undefined);

  // 2. A replay that finds the authority already settled (nothing to write) still syncs the
  // names and then the authority before it may consume — the process that wrote it may have
  // died between its rename and its sync.
  callsThisSettlement = 0;
  await assert.rejects(tc.reconcileRetiredAnnotations(f.dir), (error) => error.code === 'REJECTION_EVIDENCE_UNAVAILABLE' && error.causeCode === 'EIO');
  assert.deepEqual(observed.slice(3), [...names(afterDisposition), authority], 'the unchanged replay syncs the same three, in the same order');
  assert.equal(fs.readFileSync(authorityFile(f.dir), 'utf8'), settledBytes, 'the unchanged replay does not rewrite the authority');
  assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), evidenceBytes);

  // 3. The sync succeeds: the unchanged replay syncs all three once more and only then consumes.
  failSync = false;
  callsThisSettlement = 0;
  const settled = await tc.reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([settled.pending, settled.retired, settled.isolated, settled.skipped], [false, 0, 0, 1]);
  assert.deepEqual(observed.slice(6), [...names(afterDisposition), authority]);
  assert.equal(observed.every((row) => row.evidence === true), true, 'every sync happened while the evidence was still on disk');
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'consumed after the sync');
  assert.equal(fs.readFileSync(authorityFile(f.dir), 'utf8'), settledBytes);
  assert.equal(await tc.reconcileRetiredAnnotations(f.dir), null);
  assert.equal(observed.length, 9, 'no evidence, no sync');

  // Settled for good: a fresh control with the real sync builds nothing for the retired
  // explanation, and the digest-only audit is unchanged.
  await pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: createTrainingControl() });
  assert.deepEqual(publisher.calls, []);
  assert.equal(auditLines(f.dir).length, 1);
  assert.equal(f.tc.loadAuthority(f.dir).items[id].annotations.explanation.publishFailed, 'rejected');
});

test('production recovery: an interrupted retirement of a shared body isolates each entry once, then the flush sends them alone', async (t) => {
  const dir = tmpQ3('holdem-274-pair-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSecurityFixtures(dir, { config: OWNED_CONFIG, handInProgress: { handNo: 2, holes: { p1: ['7c', '2d'] } } });
  const relay = await startServer({ gameDir: dir, port: 0, token: TOKEN });
  t.after(() => relay.close());
  const tc = createTrainingControl();
  const leaking = q3Evaluation(EPOCH);
  const safe = q3Evaluation(EPOCH, 'd-1-preflop-1');
  const execute = (args) => runPublisher(dir, args);
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [leaking, safe] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: execute, trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, leaking.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  assert.equal((await tc.sealAnnotation(dir, safe.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: execute, trainingControl: tc })
    .then(() => assert.fail('the shared body must be refused'), (error) => assert.equal(error.code, 'PUBLISH_REJECTED'));
  const record = readJson(attemptFile(dir));
  assert.equal(record.body.trainingAnnotations.length, 2);
  const envelope = path.join(dir, 'retire.json');
  writeJson(envelope, { trainingAnnotations: record.body.trainingAnnotations, annotationAuthority: record.annotationAuthority });
  assert.equal((await runPublisher(dir, ['--from', envelope, ...retireArgs(record, relayBinding(dir))])).retired, true);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  const evidenceBytes = fs.readFileSync(evidenceFile(dir), 'utf8');
  const sharedSha = sha256Hex(JSON.stringify(record.body));

  // Settled from the evidence, twice (the second as if the evidence removal had been lost):
  // each entry is isolated by that body exactly once.
  const first = await createTrainingControl().reconcileRetiredAnnotations(dir);
  assert.deepEqual([first.retired, first.isolated, first.skipped], [0, 2, 0]);
  fs.writeFileSync(evidenceFile(dir), evidenceBytes, { mode: 0o600 });
  const again = await createTrainingControl().reconcileRetiredAnnotations(dir);
  assert.deepEqual([again.retired, again.isolated, again.skipped], [0, 2, 0]);
  for (const id of [leaking.evaluationId, safe.evaluationId]) {
    const queued = tc.loadAuthority(dir).annotationQueue[id].explanation;
    assert.deepEqual([queued.solo, queued.isolatedBy, queued.rejections], [true, sharedSha, 1], `${id} isolated once`);
  }
  assert.equal(fs.existsSync(evidenceFile(dir)), false);

  // The restarted flush never rebuilds the shared body: one annotation per body, the refused one
  // retired alone, the innocent one published.
  const publisher = recordingPublisher(dir);
  const retirePending = async () => {
    const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
      executePublish: publisher.execute, trainingControl: tc, relayBinding: () => relayBinding(dir),
    });
    return settled.retired === true || settled.published === true;
  };
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: tc, retirePending });
  assert.equal(publisher.calls.every((call) => call.ids.length <= 1), true, JSON.stringify(publisher.calls));
  const after = tc.loadAuthority(dir);
  assert.equal(after.items[leaking.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(after.items[safe.evaluationId].annotations.explanation.published, true);
  assert.deepEqual(after.annotationQueue, {});
  assert.deepEqual(auditLines(dir).map((row) => row.items.length), [2, 1], 'the pair, then the refused one alone');
});

test('production recovery: unsafe, foreign or mismatched private evidence settles nothing, keeps the queue and fails closed', async (t) => {
  const f = await refusedAttempt(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const genuineBytes = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  const genuine = JSON.parse(genuineBytes);
  const genuineAudit = fs.readFileSync(logFile(f.dir), 'utf8');
  const sentinel = outsideSentinel(t);
  const rewrite = (mutate) => {
    const copy = JSON.parse(genuineBytes);
    mutate(copy);
    fs.writeFileSync(evidenceFile(f.dir), JSON.stringify(copy), { mode: 0o600 });
  };
  for (const [label, plant, code] of [
    ['symlink', () => { fs.writeFileSync(sentinel, genuineBytes); fs.symlinkSync(sentinel, evidenceFile(f.dir)); }, 'REJECTION_EVIDENCE_UNAVAILABLE'],
    ['hard link', () => { fs.writeFileSync(sentinel, genuineBytes); fs.linkSync(sentinel, evidenceFile(f.dir)); }, 'REJECTION_EVIDENCE_UNAVAILABLE'],
    ['directory', () => fs.mkdirSync(evidenceFile(f.dir)), 'REJECTION_EVIDENCE_UNAVAILABLE'],
    ['oversized', () => fs.writeFileSync(evidenceFile(f.dir), ' '.repeat(256 * 1024 + 1)), 'REJECTION_EVIDENCE_UNAVAILABLE'],
    ['not JSON', () => fs.writeFileSync(evidenceFile(f.dir), '{'), 'REJECTION_EVIDENCE_UNAVAILABLE'],
    ['changed value, same digest', () => rewrite((e) => { e.body.trainingAnnotations[0].value = SAFE_TEXT; }), 'REJECTION_EVIDENCE_INVALID'],
    ['changed proof', () => rewrite((e) => { e.body.trainingAnnotations[0].annotationProof.id = 'x'; e.bodySha256 = sha256Hex(JSON.stringify(e.body)); }), 'REJECTION_EVIDENCE_INVALID'],
    ['another game', () => rewrite((e) => { e.expectedGameEpoch = 'ff'.repeat(32); }), 'REJECTION_EVIDENCE_INVALID'],
    ['no relay binding', () => rewrite((e) => { delete e.relayBinding; }), 'REJECTION_EVIDENCE_INVALID'],
    ['not retirable', () => rewrite((e) => { e.httpStatus = 409; e.serverCode = 'ANNOTATION_ORPHAN'; }), 'REJECTION_EVIDENCE_INVALID'],
    ['no matching audit line', () => { fs.writeFileSync(evidenceFile(f.dir), genuineBytes, { mode: 0o600 }); fs.rmSync(logFile(f.dir)); }, 'REJECTION_EVIDENCE_MISSING'],
  ]) {
    fs.rmSync(evidenceFile(f.dir), { recursive: true, force: true });
    plant();
    const publisher = recordingPublisher(f.dir);
    await assert.rejects(
      pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: f.tc }),
      { code }, label,
    );
    assert.deepEqual(publisher.calls, [], `${label}: nothing was built or sent`);
    assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation, `${label}: queue kept`);
    assert.doesNotThrow(() => fs.lstatSync(evidenceFile(f.dir)), `${label}: the evidence is not consumed`);
    if (label === 'symlink' || label === 'hard link') assert.equal(fs.readFileSync(sentinel, 'utf8'), genuineBytes, `${label}: the outside file is untouched`);
    fs.rmSync(evidenceFile(f.dir), { recursive: true, force: true });
    fs.writeFileSync(logFile(f.dir), genuineAudit);
  }
  // Restored exactly, the same evidence settles it.
  fs.writeFileSync(evidenceFile(f.dir), genuineBytes, { mode: 0o600 });
  const settled = await f.tc.reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([settled.retired, settled.publishId], [1, genuine.publishId]);
  assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId], undefined);
});

test('one retirement at a time: unsettled evidence of another body refuses a new retirement before it is sent', async (t) => {
  const f = await refusedAttempt(t);
  const foreign = { schemaVersion: 1, bodySha256: 'cd'.repeat(32), publishId: 1 };
  fs.writeFileSync(evidenceFile(f.dir), JSON.stringify(foreign), { mode: 0o600 });
  const error = await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))]).then(() => null, (e) => e);
  assert.equal(error?.code, 'REJECTION_EVIDENCE_PENDING');
  assert.equal(fs.readFileSync(attemptFile(f.dir), 'utf8'), f.attemptBytes, 'the attempt is kept exactly');
  assert.equal(fs.existsSync(logFile(f.dir)), false, 'nothing was retired');
  assert.deepEqual(JSON.parse(fs.readFileSync(evidenceFile(f.dir), 'utf8')), foreign, 'the unsettled evidence is not overwritten');
});

test('public app codes: a static closed vocabulary keeps repository codes and errno names, and hides everything else', () => {
  for (const code of ['CHILD_CLOSE_UNCONFIRMED', 'SESSION_RECOVERABLE', 'APP_INIT_FAILED', 'COMMAND_PERSISTENCE_FAILED',
    'REQUEST_ID_CONFLICT', 'ROOM_UNBOUND', 'RETRY_NOT_APPLIED', 'JEV_ENGINE_APPLY_UNCONFIRMED', 'STUDY_SERVICE_INCOMPATIBLE',
    'BAD_LOOP_STATE', 'PENDING_ANNOTATION_BLOCKED', 'REJECTION_EVIDENCE_PENDING', 'LOCKED', 'ERROR', 'EACCES', 'ENOENT', 'EPERM']) {
    assert.equal(projectPublicCode(code), code, code);
  }
  for (const secret of ['PRIVATE_As_Kh_tok_SIGNAL_FAILED', 'SECRET_As_Kh_tok123', 'tok', LEAKING_TEXT, 'A'.repeat(40), 'ERROR ',
    '__proto__', 'constructor', 'toString', 'GROK_AUTH_PATH', 'FINALIZE_RESOLVER_CUT']) {
    assert.equal(projectPublicCode(secret), 'UNLISTED', secret);
  }
  assert.equal(projectPublicCode({ code: 'ERROR' }), 'UNLISTED');
  assert.equal(projectPublicCode(null), null);
  assert.equal(Object.isFrozen(PUBLIC_CODES), true);
  assert.equal(PUBLIC_CODES.every((code) => /^[A-Z][A-Z0-9_]{1,63}$/.test(code)), true);
  // Static: projecting reads no file (the vocabulary is built at import, from literals).
  const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/diagnostic-codes.js'), 'utf8');
  assert.equal(/\bimport\b[^;]*node:fs|readFileSync|readdirSync/.test(source), false);
});

// #274 lifetime contract (1): every operation on the training mutex — retirement, ordinary
// mutation, accept, a consumer suspended on an await while it holds the lock — is admitted
// per session inside one process, across control instances and path aliases, before the
// cross-process mutex. Without that, an in-process waiter spins synchronously on the mutex and
// starves the holder's release until it times out as LOCKED (the root reproduction).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('training lock admission: retirement, ordinary mutation, accept and a suspended consumer queue in order across control instances and path aliases — never LOCKED within one process', async (t) => {
  // The root reproduction: an empty session, a reconcile and an ordinary lock at once.
  const empty = scratch(t, 'holdem-274-admit-');
  const emptyStarted = Date.now();
  assert.deepEqual(await Promise.all([
    createTrainingControl().reconcileRetiredAnnotations(empty),
    createTrainingControl().withLock(empty, () => 'ordinary'),
  ]), [null, 'ordinary']);
  assert.ok(Date.now() - emptyStarted < 1500, `no mutex timeout was waited out: ${Date.now() - emptyStarted}ms`);

  // Real evidence to settle, overlapping every other kind of holder.
  const f = await refusedAttempt(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  assert.equal(fs.existsSync(evidenceFile(f.dir)), true);
  const alias = path.join(scratch(t, 'holdem-274-alias-'), 'session-link');
  fs.symlinkSync(f.dir, alias);
  const storeDir = scratch(t, 'holdem-274-store-');
  const later = q3Evaluation(EPOCH, 'd-1-preflop-1');
  const order = [];
  const started = Date.now();
  const results = await Promise.all([
    // What consumeTrainingItems does: holds the mutex across an await of its consumers.
    f.tc.withLock(f.dir, async () => { await sleep(300); order.push('consumer'); return 'consumer'; }),
    createTrainingControl().reconcileRetiredAnnotations(f.dir).then((r) => { order.push('reconcile'); return r; }),
    createTrainingControl().acceptEvaluations(f.dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [later] })
      .then((r) => { order.push('accept'); return r; }),
    createTrainingControl().withLock(`${f.dir}${path.sep}`, () => { order.push('alias-slash'); return 'alias-slash'; }),
    createTrainingControl().withLock(alias, () => { order.push('alias-symlink'); return 'alias-symlink'; }),
    createTrainingControl().consumeTrainingItems(f.dir, { storeDir }).then((r) => { order.push('consume'); return r; }),
    // An ordinary mark of a digest the item does not carry: refused by its own gate, never LOCKED.
    createTrainingControl().markPublished(f.dir, later.evaluationId, 'ab'.repeat(32))
      .then(() => { order.push('mark'); return 'marked'; }, (error) => { order.push('mark'); return error.code; }),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `queued behind the holder, not timed out: ${elapsed}ms`);
  assert.equal(results[0], 'consumer');
  assert.deepEqual([results[1].pending, results[1].retired], [false, 1], 'the retirement settled behind the suspended consumer');
  assert.equal(results[2].accepted.length, 1);
  assert.deepEqual(results.slice(3, 5), ['alias-slash', 'alias-symlink']);
  assert.equal(typeof results[5].profiled, 'number', 'the real consumer ran under the lock');
  assert.notEqual(results[6], 'LOCKED', 'an ordinary mark never meets a same-process LOCKED');
  assert.equal(order[0], 'consumer', 'admission is in order: the holder finishes first');
  assert.deepEqual([...order].sort(), ['accept', 'alias-slash', 'alias-symlink', 'consume', 'consumer', 'mark', 'reconcile']);
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'the evidence was consumed exactly once');
  const auth = f.tc.loadAuthority(f.dir);
  assert.equal(auth.annotationQueue[f.evaluation.evaluationId], undefined);
  assert.equal(auth.items[f.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.ok(auth.items[later.evaluationId], 'the concurrent accept landed');
  assert.equal(fs.existsSync(path.join(f.dir, 'training.lock.d')), false, 'the mutex is released');
  // The mutex semantics are untouched: a lock held outside this queue by a live pid (this
  // process's own, standing in for another live holder) still answers LOCKED after its timeout.
  fs.mkdirSync(path.join(f.dir, 'training.lock.d'));
  fs.writeFileSync(path.join(f.dir, 'training.lock.d', 'pid'), String(process.pid));
  try {
    await assert.rejects(createTrainingControl().withLock(f.dir, () => assert.fail('entered a foreign lock')), { code: 'LOCKED' });
  } finally {
    fs.rmSync(path.join(f.dir, 'training.lock.d'), { recursive: true, force: true });
  }
});

// #274 lifetime contract (2): the recorded attempt a retirement's evidence points at must have
// its bytes on disk before that evidence is installed. The ordinary publish path writes the
// attempt by rename without fsync; the retirement path keeps and fsyncs the exact record, or
// replaces it durably, and refuses anything unsafe without changing it.
test('attempt durability: a retirement keeps and fsyncs the exact recorded attempt or replaces it durably in order; a sync failure or an unsafe record changes nothing', { skip: process.platform === 'win32' ? 'real POSIX directory fsync' : false }, (t) => {
  const dir = scratch(t, 'holdem-274-attempt-');
  const name = '.publish-attempt.json';
  const target = path.join(dir, name);
  const text = JSON.stringify({ body: { publishId: 7, trainingAnnotations: [] }, expectedGameEpoch: 'ab'.repeat(32) });
  const other = JSON.stringify({ body: { publishId: 8, trainingAnnotations: [] }, expectedGameEpoch: 'ab'.repeat(32) });
  const calls = [];
  const fds = new Map();
  const tracking = {
    openSync(file, ...rest) { const fd = fs.openSync(file, ...rest); fds.set(fd, String(file)); return fd; },
    fsyncSync(fd) {
      const f = fds.get(fd);
      calls.push(`fsync:${f === dir ? 'dir' : (/\.tmp$/.test(f) ? 'tmp' : path.basename(f))}`);
      return fs.fsyncSync(fd);
    },
    renameSync(from, to) { calls.push(`rename:${path.basename(to)}`); return fs.renameSync(from, to); },
  };
  const fsImpl = fsWith(tracking);
  // No record yet: the canonical bytes are installed through the pinned path.
  assert.deepEqual(installAttemptDurably(dir, name, text, { fsImpl, platform: 'darwin' }), { replaced: true });
  assert.deepEqual(calls, ['fsync:tmp', `rename:${name}`, 'fsync:dir']);
  assert.equal(fs.readFileSync(target, 'utf8'), text);
  const ino = fs.statSync(target).ino;
  // The same bytes already recorded (an unchanged retirement retry): kept, fsynced in place,
  // then its directory entry — the file is the same file afterwards.
  calls.length = 0;
  assert.deepEqual(installAttemptDurably(dir, name, text, { fsImpl, platform: 'darwin' }), { replaced: false });
  assert.deepEqual(calls, [`fsync:${name}`, 'fsync:dir']);
  assert.equal(fs.statSync(target).ino, ino);
  assert.equal(fs.readFileSync(target, 'utf8'), text);
  // Different bytes: replaced durably, in order.
  calls.length = 0;
  assert.deepEqual(installAttemptDurably(dir, name, other, { fsImpl, platform: 'darwin' }), { replaced: true });
  assert.deepEqual(calls, ['fsync:tmp', `rename:${name}`, 'fsync:dir']);
  assert.equal(fs.readFileSync(target, 'utf8'), other);
  // Windows: the file is synced, no directory handle is opened, nothing claims more.
  calls.length = 0;
  assert.deepEqual(installAttemptDurably(dir, name, other, { fsImpl, platform: 'win32' }), { replaced: false });
  assert.deepEqual(calls, [`fsync:${name}`]);
  // Windows flushes a handle with FlushFileBuffers, which needs write access: a seam that
  // refuses to flush a handle opened read-only (as libuv on Windows would) must still let the
  // production helper flush the unchanged record — it opens the record for writing without
  // writing — and the replacement's temporary file.
  const access = new Map();
  const windowsLike = fsWith({
    openSync(file, flags, mode) {
      const fd = fs.openSync(file, flags, mode);
      access.set(fd, (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 ? 'write' : 'read');
      fds.set(fd, String(file));
      return fd;
    },
    fsyncSync(fd) {
      if (access.get(fd) !== 'write') throw Object.assign(new Error('FlushFileBuffers needs GENERIC_WRITE'), { code: 'EBADF' });
      calls.push(`fsync:${access.get(fd)}:${/\.tmp$/.test(fds.get(fd)) ? 'tmp' : path.basename(fds.get(fd))}`);
      return fs.fsyncSync(fd);
    },
  });
  const readOnly = windowsLike.openSync(target, fs.constants.O_RDONLY);
  try { assert.throws(() => windowsLike.fsyncSync(readOnly), { code: 'EBADF' }, 'the seam refuses a read-only handle'); } finally { fs.closeSync(readOnly); }
  calls.length = 0;
  assert.deepEqual(installAttemptDurably(dir, name, other, { fsImpl: windowsLike, platform: 'win32' }), { replaced: false });
  assert.deepEqual(calls, [`fsync:write:${name}`], 'the unchanged record is flushed through a writable handle');
  assert.equal(fs.readFileSync(target, 'utf8'), other, 'and its bytes are untouched');
  calls.length = 0;
  assert.deepEqual(installAttemptDurably(dir, name, text, { fsImpl: windowsLike, platform: 'win32' }), { replaced: true });
  assert.deepEqual(calls, ['fsync:write:tmp'], 'the replacement is flushed through its writable temporary handle');
  assert.equal(fs.readFileSync(target, 'utf8'), text);
  assert.deepEqual(installAttemptDurably(dir, name, other, { fsImpl, platform: 'darwin' }), { replaced: true }); // back to `other` for what follows
  calls.length = 0;
  // Failure injection. The file fsync fails: the record is untouched and the cause is closed.
  const eio = Object.assign(new Error('io'), { code: 'EIO' });
  assert.throws(() => installAttemptDurably(dir, name, other, { fsImpl: fsWith({ fsyncSync() { throw eio; } }), platform: 'linux' }),
    (error) => error.code === 'REJECTION_AUDIT_UNAVAILABLE' && error.causeCode === 'EIO');
  assert.equal(fs.readFileSync(target, 'utf8'), other);
  // On the replacement path the temporary file is removed and the record kept.
  assert.throws(() => installAttemptDurably(dir, name, text, { fsImpl: fsWith({ fsyncSync() { throw eio; } }), platform: 'linux' }), { code: 'REJECTION_AUDIT_UNAVAILABLE' });
  assert.equal(fs.readFileSync(target, 'utf8'), other);
  assert.deepEqual(fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp')), [], 'no temporary file left behind');
  // The directory fsync after the file sync fails: still a failure on POSIX, the record intact.
  calls.length = 0;
  assert.throws(() => installAttemptDurably(dir, name, other, {
    fsImpl: fsWith({ ...tracking, fsyncSync(fd) { if (fds.get(fd) === dir) throw eio; return tracking.fsyncSync(fd); } }), platform: 'linux',
  }), { code: 'REJECTION_AUDIT_UNAVAILABLE' });
  assert.deepEqual(calls, [`fsync:${name}`]);
  assert.equal(fs.readFileSync(target, 'utf8'), other);
  // Unsafe records are refused untouched: a hard link or a symlink to an outside file, a directory.
  const sentinel = outsideSentinel(t);
  for (const [label, plant] of [
    ['hard link', () => { fs.writeFileSync(sentinel, other); fs.linkSync(sentinel, target); }],
    ['symlink', () => { fs.writeFileSync(sentinel, other); fs.symlinkSync(sentinel, target); }],
    ['directory', () => fs.mkdirSync(target)],
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
    plant();
    assert.throws(() => installAttemptDurably(dir, name, other), { code: 'REJECTION_AUDIT_UNSAFE' }, label);
    assert.throws(() => installAttemptDurably(dir, name, text), { code: 'REJECTION_AUDIT_UNSAFE' }, `${label}, different bytes`);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), other, `${label}: the outside file is untouched`);
    assert.deepEqual(fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp')), [], `${label}: no temporary file`);
  }
  // Over the bound: refused before anything is read or written.
  fs.rmSync(target, { recursive: true, force: true });
  assert.throws(() => installAttemptDurably(dir, name, 'x'.repeat(1_000_001)), { code: 'REJECTION_AUDIT_UNSAFE' });
  assert.equal(fs.existsSync(target), false);
});

test('real relay: a retirement whose recorded attempt cannot be made durable sends nothing, keeps the attempt exactly, and reports the first refusal beside its own code', async (t) => {
  const f = await refusedAttempt(t);
  // The record is a multi-link file: the publisher must neither sync it in place nor replace it.
  const sentinel = outsideSentinel(t);
  fs.writeFileSync(sentinel, f.attemptBytes);
  fs.rmSync(attemptFile(f.dir));
  fs.linkSync(sentinel, attemptFile(f.dir));
  const snapshotBefore = fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8');
  const error = await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))]).then(() => null, (e) => e);
  assert.equal(error?.code, 'ATTEMPT_SYNC_FAILED');
  assert.equal(error.envelope.auditCode, 'REJECTION_AUDIT_UNSAFE');
  assert.deepEqual(Object.keys(error.envelope).sort(), ['auditCode', 'code', 'message', 'ok']);
  assert.equal(JSON.stringify(error.envelope).includes('7c'), false, 'no annotation text');
  assert.equal(JSON.stringify(error.envelope).includes(f.dir), false, 'no path');
  assert.equal(fs.readFileSync(attemptFile(f.dir), 'utf8'), f.attemptBytes, 'the attempt is kept exactly');
  assert.equal(fs.lstatSync(attemptFile(f.dir)).nlink, 2, 'the planted link is not replaced');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), f.attemptBytes, 'the outside file is untouched');
  assert.equal(fs.existsSync(logFile(f.dir)), false, 'nothing was retired');
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'no evidence was installed');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8'), snapshotBefore, 'nothing was sent');
  assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation, 'the queue is kept');
  // Through the retirement helper: the flush first meets an ACTUAL refusal of the owned, regular
  // record (the real publisher: the pending record drains with --retry and the relay refuses it
  // 400 again); only then is the same hard link planted, before the helper's first read. The
  // helper's bounded reader refuses the entry in doubt with a closed code that carries that real
  // first refusal beside it, and nothing is sent, disposed, audited or replaced after that.
  fs.rmSync(attemptFile(f.dir));
  fs.writeFileSync(attemptFile(f.dir), f.attemptBytes);
  assert.equal(fs.lstatSync(attemptFile(f.dir)).nlink, 1, 'an owned regular record again');
  const invocations = [];
  const executePublish = async (args) => {
    invocations.push(args.filter((arg) => arg.startsWith('--')).join(' '));
    return runPublisher(f.dir, args);
  };
  let observed = null;
  const failure = await pipeline.flushAnnotationPublish(f.dir, {
    gameEpoch: EPOCH,
    executePublish,
    trainingControl: f.tc,
    retirePending: async (error) => {
      // Only an own retirable refusal is the helper's business; anything else is left alone.
      if (error?.code !== 'PUBLISH_REJECTED'
        || !isRetirableAnnotationRejection(error.envelope?.httpStatus, error.envelope?.serverCode)) return false;
      observed = error;
      assert.deepEqual(rejectionTupleOf(error), { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }, 'the actual refusal the relay gave the drained record');
      assert.equal(error.envelope?.attempt?.bodySha256, sha256Hex(JSON.stringify(f.record.body)), 'the refusal names the recorded body');
      // Now, before the helper's first read: the record becomes a multi-link file again.
      fs.rmSync(attemptFile(f.dir));
      fs.linkSync(sentinel, attemptFile(f.dir));
      const settled = await pipeline.retireRejectedAnnotationAttempt(f.dir, {
        executePublish, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir), expectedAttempt: error.envelope?.attempt ?? null,
      });
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  }).then(() => null, (e) => e);
  assert.ok(observed, 'the flush met the actual refusal before anything was planted');
  assert.deepEqual(invocations, ['--from', '--from --retry'], 'the fresh send met the pending record, the drain was refused; nothing was sent after the entry became unsafe');
  assert.equal(failure?.code, 'REJECTION_EVIDENCE_UNAVAILABLE', `the entry in doubt is a closed failure: ${failure?.code}`);
  assert.equal(failure.settlementFailure, true);
  assert.deepEqual(rejectionTupleOf(failure), { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }, 'the actual first refusal travels with the helper\'s failure');
  assert.equal(recheckRejectionTupleOf(failure), null);
  assert.equal(JSON.stringify({ code: failure.code, message: failure.message, rejection: failure.rejection, causeCode: failure.causeCode ?? null }).includes('7c'), false, 'no annotation text');
  assert.equal(JSON.stringify({ code: failure.code, message: failure.message, rejection: failure.rejection }).includes(f.dir), false, 'no path');
  assert.equal(fs.readFileSync(attemptFile(f.dir), 'utf8'), f.attemptBytes, 'still the exact attempt');
  assert.equal(fs.lstatSync(attemptFile(f.dir)).nlink, 2, 'the planted link is not replaced');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), f.attemptBytes, 'the outside file is untouched');
  assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation, 'the queue is kept');
  assert.equal(fs.existsSync(logFile(f.dir)), false, 'nothing was audited');
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'no evidence was installed');
});

// #274 lifetime contract (4): the audit line of a refusal names every item of the refused
// body, so its cap is the body cap; a batch is eligible only if both fit. A valid batch at the
// body budget needs an audit line well past the old 16 KiB cap; it is retired on bounded
// evidence and isolated entry by entry, nothing split or discarded.
test('audit capacity: a line as large as the body budget is accepted and read back, larger is refused, and the log stays bounded', (t) => {
  const dir = scratch(t, 'holdem-274-linecap-');
  const item = (i) => ({ evaluationId: `${'a'.repeat(64)}:d-1-preflop-${i}:local-preflop-baseline@1.0.0`, field: 'explanation', valueSha256: 'b'.repeat(64) });
  const items = [];
  while (rejectionRecordByteLength([...items, item(items.length)]) <= REJECTION_LINE_MAX_BYTES - TRAINING_CHUNK_SLACK_BYTES) items.push(item(items.length));
  assert.ok(items.length > 75, `${items.length} items fit the budget`);
  assert.equal(REJECTION_LINE_MAX_BYTES, MAX_PUBLISH_BODY_BYTES, 'the audit line cap is the body cap');
  const record = { ...RECORD, at: '2026-10-09T00:00:00.000Z', expectedGameEpoch: EPOCH, items };
  assert.ok(Buffer.byteLength(JSON.stringify(record), 'utf8') > 16 * 1024, 'past the old cap');
  appendRejectionRecord(dir, record);
  assert.deepEqual(readRejectionRecords(dir), [record]);
  const tooMany = { ...record, items: Array.from({ length: items.length * 2 }, (_, i) => item(i)) };
  assert.ok(Buffer.byteLength(JSON.stringify(tooMany), 'utf8') > REJECTION_LINE_MAX_BYTES);
  assert.throws(() => appendRejectionRecord(dir, tooMany), { code: 'REJECTION_AUDIT_UNSAFE' });
  assert.deepEqual(readRejectionRecords(dir), [record], 'the log is unchanged by a refused line');
  for (let n = 0; n < 12; n += 1) appendRejectionRecord(dir, { ...record, publishId: 100 + n });
  assert.ok(fs.statSync(logFile(dir)).size <= REJECTION_LOG_MAX_BYTES, 'bounded by bytes, newest kept');
  const kept = readRejectionRecords(dir);
  assert.ok(kept.length >= 8 && kept.length < 13, `${kept.length} lines kept`);
  assert.equal(kept.at(-1).publishId, 111);
});

test('capacity: a valid annotation batch at the body budget is refused whole, retired on bounded evidence past the old audit cap, isolated entry by entry and then sent one at a time with its exact identity', async (t) => {
  const dir = tmpQ3('holdem-274-capacity-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSecurityFixtures(dir, { config: OWNED_CONFIG, handInProgress: { handNo: 2, holes: { p1: ['7c', '2d'] } } });
  const relay = await startServer({ gameDir: dir, port: 0, token: TOKEN });
  t.after(() => relay.close());
  const tc = createTrainingControl();
  const count = 100;
  const evaluations = Array.from({ length: count }, (_, i) => q3Evaluation(EPOCH, `d-1-preflop-${i}`));
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations });
  const evidenceSizes = [];
  const calls = [];
  const execute = async (args) => {
    const from = args.indexOf('--from');
    const body = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = { flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (body?.trainingAnnotations ?? []).map((note) => note.evaluationId) };
    calls.push(row);
    const out = await runPublisher(dir, args);
    if (out.retired === true) evidenceSizes.push(fs.statSync(evidenceFile(dir)).size);
    return out;
  };
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: execute, trainingControl: tc });
  assert.equal(readJson(path.join(dir, 'ui-snapshot.json')).training.length, count, 'every machine row is on the relay');
  // The leaking explanation is sealed first, so the first full batch is refused as a whole.
  const SHORT_SAFE_TEXT = 'BTN open raise is standard here.';
  assert.equal((await tc.sealAnnotation(dir, evaluations[0].evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  for (const evaluation of evaluations.slice(1)) {
    assert.equal((await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', SHORT_SAFE_TEXT)).ok, true);
  }
  const envelope = pipeline.annotationEnvelope(dir, { gameEpoch: EPOCH });
  const batch = envelope.trainingAnnotations.length;
  assert.ok(batch >= 70 && batch < count, `the batch is bounded by the body budget: ${batch} of ${count}`);
  const bodyBytes = annotationBodyByteLength({ publishId: MAX_PUBLISH_ID, trainingAnnotations: envelope.trainingAnnotations, annotationAuthority: envelope.annotationAuthority });
  assert.ok(bodyBytes <= MAX_PUBLISH_BODY_BYTES - TRAINING_CHUNK_SLACK_BYTES, `a valid body: ${bodyBytes} bytes`);
  const auditBytes = rejectionRecordByteLength(envelope.annotationAuthority.items);
  assert.ok(auditBytes > 16 * 1024, `the audit line of this valid batch needs ${auditBytes} bytes, past the old 16 KiB cap`);
  assert.ok(auditBytes <= REJECTION_LINE_MAX_BYTES - TRAINING_CHUNK_SLACK_BYTES);

  const retirements = [];
  const retirePending = async (error) => {
    const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
      executePublish: execute, trainingControl: tc, relayBinding: () => relayBinding(dir),
      onRetired: (info) => retirements.push(info),
    });
    return settled.retired === true || settled.published === true;
  };
  const publishedCount = () => Object.values(tc.loadAuthority(dir).items).filter((item) => item.annotations.explanation?.published === true).length;
  // After the refused batch is isolated, the entries that were not in it still go together
  // first; then the isolated ones go one at a time. Three of those is enough to show it.
  const remainder = count - batch;
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: execute, trainingControl: tc, retirePending,
    shouldStop: () => publishedCount() >= remainder + 3,
  });

  // The whole batch was refused and retired once (isolated, nothing dropped), then the
  // refused one alone; the evidence and the audit stayed within their bounds.
  assert.deepEqual(retirements.map((row) => [row.httpStatus, row.serverCode, row.dropped, row.isolated, row.skipped]),
    [[400, 'FORBIDDEN_LITERAL', 0, batch, 0], [400, 'FORBIDDEN_LITERAL', 1, 0, 0]]);
  const lines = auditLines(dir);
  const rawLines = fs.readFileSync(logFile(dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].items.length, batch);
  assert.ok(Buffer.byteLength(rawLines[0], 'utf8') > 16 * 1024, 'the audit line is past the old cap');
  assert.ok(Buffer.byteLength(rawLines[0], 'utf8') <= REJECTION_LINE_MAX_BYTES);
  assert.deepEqual(lines[1].items.map((row) => row.evaluationId), [evaluations[0].evaluationId]);
  assert.equal(evidenceSizes.length, 2);
  assert.ok(evidenceSizes[0] > MAX_PUBLISH_BODY_BYTES && evidenceSizes[0] <= RETIREMENT_EVIDENCE_MAX_BYTES, `evidence ${evidenceSizes[0]} bytes: the exact body and authority, bounded`);
  assert.ok(fs.statSync(logFile(dir)).size <= REJECTION_LOG_MAX_BYTES);
  assert.equal(fs.existsSync(evidenceFile(dir)), false);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  // Exact identity: every entry of the refused body is isolated by that body's digest, which
  // is the digest the audit named; after the retirement no body carried more than one entry.
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.items[evaluations[0].evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(auth.annotationQueue[evaluations[0].evaluationId], undefined);
  const published = evaluations.filter((e) => auth.items[e.evaluationId].annotations.explanation.published === true);
  assert.ok(published.length >= remainder + 3, `${published.length} innocent explanations reached the relay`);
  const stillQueued = Object.entries(auth.annotationQueue).map(([id, fields]) => [id, fields.explanation]);
  assert.equal(stillQueued.length + published.length + 1, count, 'nothing was split away or discarded');
  const isolated = stillQueued.filter(([, queued]) => queued.solo === true && queued.isolatedBy === lines[0].bodySha256);
  assert.equal(isolated.length, stillQueued.length, 'everything still queued is an entry of the refused body, waiting alone');
  assert.equal(isolated.length, batch - 1 - (published.length - remainder), 'the rest of the refused body waits, each alone');
  const after = calls.findIndex((call) => call.flags.includes('--retire-rejected'));
  assert.ok(after >= 1);
  const afterwards = calls.slice(after + 1);
  assert.equal(afterwards[0].ids.length, remainder, 'the entries outside the refused body still travel together, first');
  assert.equal(afterwards.slice(1).every((call) => call.ids.length <= 1), true, JSON.stringify(afterwards.map((c) => c.ids.length)));
  assert.equal(afterwards.slice(1).filter((call) => call.flags === '--from').length >= 4, true, 'the refused one alone, then innocent ones one at a time');
  const relayed = readJson(path.join(dir, 'ui-snapshot.json')).trainingAnnotations ?? {};
  assert.equal(Object.hasOwn(relayed, evaluations[0].evaluationId), false, 'the refused explanation never reached the relay');
  assert.equal(published.every((e) => Object.hasOwn(relayed, e.evaluationId)), true);
});

// #274 lifetime contract: ordinary publication must not bypass outstanding retirement evidence.
// A is retired on durable evidence while its queue settlement waits behind an ordinary holder
// of the training lock; another flush has already built A+B; and the hand changes so that A's
// text would now be accepted. The publisher refuses to judge any annotation body while that
// evidence is outstanding; the flush settles it, rebuilds, and publishes B alone. The retired
// explanation never reaches the relay.
test('race with a changed context: outstanding retirement evidence blocks the already-built A+B at the publish lock, the flush settles it and publishes B alone, and retired A never reaches the relay', { timeout: 30_000 }, async (t) => {
  // B's machine row is seeded beside A's before A is sealed and refused (see refusedAttempt).
  const f = await refusedAttempt(t, { others: [q3Evaluation(EPOCH, 'd-1-preflop-1')] });
  const [other] = f.others;
  assert.equal((await f.tc.sealAnnotation(f.dir, other.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const until = async (probe, label) => {
    for (let n = 0; n < 600; n += 1) { if (probe()) return; await sleep(10); }
    throw new Error(`gate timeout: ${label}`);
  };
  let allowA; let allowB; let releaseHold;
  const gateA = new Promise((resolve) => { allowA = resolve; });
  const gateB = new Promise((resolve) => { allowB = resolve; });
  const holdGate = new Promise((resolve) => { releaseHold = resolve; });
  t.after(() => { allowA(); allowB(); releaseHold(); });
  let aReady = false; let bReady = false; let holdReady = false; let firstSend = true;
  const posts = [];
  const record = async (args) => {
    const from = args.indexOf('--from');
    const envelope = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = { flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (envelope?.trainingAnnotations ?? []).map((note) => note.evaluationId) };
    try {
      const out = await f.execute(args);
      row.result = out.retired ? 'retired' : `published:${out.publishId}`;
      return out;
    } catch (error) {
      row.result = error.code;
      throw error;
    } finally {
      posts.push(row);
    }
  };
  const options = { executePublish: record, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir) };
  const a = pipeline.retireRejectedAnnotationAttempt(f.dir, { ...options, verifyRelay: async () => { aReady = true; await gateA; } });
  const b = pipeline.flushAnnotationPublish(f.dir, {
    gameEpoch: EPOCH, trainingControl: f.tc,
    executePublish: async (args) => {
      if (firstSend) { firstSend = false; bReady = true; await gateB; }
      return record(args);
    },
    retirePending: async () => {
      const settled = await pipeline.retireRejectedAnnotationAttempt(f.dir, options);
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  });
  a.catch(() => {}); b.catch(() => {});
  await until(() => aReady && bReady, 'both in flight');
  const holder = f.tc.withLock(f.dir, async () => { holdReady = true; await holdGate; });
  await until(() => holdReady, 'holder');
  allowA();
  await until(() => fs.existsSync(evidenceFile(f.dir)) && !fs.existsSync(attemptFile(f.dir)), 'A retired on evidence');
  // The context changes: the card A's text names is no longer private (archived hands are
  // public under the new-game defaults; the live hand released it). A fresh judgement of A
  // would now be an acceptance.
  releaseLeakedCard(f.dir);
  allowB();
  await until(() => posts.some((row) => row.flags === '--from' && row.result === 'REJECTION_EVIDENCE_PENDING'), 'A+B refused at the publish lock');
  releaseHold();
  await holder;
  const [ra, rb] = await Promise.allSettled([a, b]);

  assert.equal(ra.status, 'fulfilled', JSON.stringify(ra));
  assert.deepEqual([ra.value.retired, ra.value.dropped], [true, 1]);
  assert.equal(rb.status, 'fulfilled', JSON.stringify(rb));
  const snapshot = readJson(path.join(f.dir, 'ui-snapshot.json'));
  assert.deepEqual(posts.map((row) => [row.flags, row.ids.length, row.result]), [
    ['--from --retire-rejected --expect-attempt-sha256 --expect-game-epoch --relay-pid --relay-start-time --relay-port', 1, 'retired'],
    ['--from', 2, 'REJECTION_EVIDENCE_PENDING'],
    ['--from', 1, `published:${snapshot.publishId}`],
  ], 'A retired; A+B refused unsent while the evidence was outstanding; B alone after the settlement');
  assert.deepEqual(posts[2].ids, [other.evaluationId]);
  assert.equal(Object.hasOwn(snapshot.trainingAnnotations ?? {}, f.evaluation.evaluationId), false, 'retired A never reached the relay');
  assert.equal(Object.hasOwn(snapshot.trainingAnnotations ?? {}, other.evaluationId), true);
  const auth = f.tc.loadAuthority(f.dir);
  assert.deepEqual(auth.annotationQueue, {});
  assert.equal(auth.items[f.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(auth.items[other.evaluationId].annotations.explanation.published, true);
  assert.equal(fs.existsSync(attemptFile(f.dir)), false);
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false);
  assert.equal(auditLines(f.dir).length, 1);
  // The changed context is real: the same text on a new evaluation is accepted now.
  const later = q3Evaluation(EPOCH, 'd-1-preflop-2');
  await f.tc.acceptEvaluations(f.dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [later] });
  await pipeline.flushMachinePublish(f.dir, { gameEpoch: EPOCH, executePublish: f.execute, trainingControl: f.tc });
  assert.equal((await f.tc.sealAnnotation(f.dir, later.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: f.execute, trainingControl: f.tc });
  assert.equal(Object.hasOwn(readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {}, later.evaluationId), true);
  assert.equal(Object.hasOwn(readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {}, f.evaluation.evaluationId), false);
});

// The ordering half of the same contract: the publisher snapshots outstanding evidence BEFORE it
// captures the authorities, under the publish lock. A publisher that captured the old queue
// (A still queued) and is then preempted while the training control settles A (authority
// written, then the evidence consumed) must still refuse the old A+B — the evidence it saw
// first decides — never validate the stale authority against an absence seen later. The
// child is held at a named checkpoint through the env seam (AI_HOLDEM_PUBLISH_CHECKPOINT_DIR).
function runPublisherPaused(dir, args, checkpointDir) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [TOOL, ...args, '--game-dir', dir], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, AI_HOLDEM_PUBLISH_CHECKPOINT_DIR: checkpointDir },
    }, (error, stdout) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok !== true) {
        reject(Object.assign(new Error(envelope?.message ?? 'publisher failed'), { code: envelope?.code ?? error?.code ?? 'CHILD_FAILED', envelope }));
        return;
      }
      resolve(envelope);
    });
  });
}

test('ordering: a publisher preempted after capturing the old authority, while the retirement it did not see settles, still refuses the old A+B — the evidence it snapshotted first decides, and retired A never reaches the relay', { timeout: 40_000 }, async (t) => {
  // B's machine row is seeded beside A's before A is sealed and refused (see refusedAttempt).
  const f = await refusedAttempt(t, { others: [q3Evaluation(EPOCH, 'd-1-preflop-1')] });
  const [other] = f.others;
  assert.equal((await f.tc.sealAnnotation(f.dir, other.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const checkpoints = scratch(t, 'holdem-274-checkpoint-');
  const reached = path.join(checkpoints, 'authority-captured.reached');
  const release = path.join(checkpoints, 'authority-captured.release');
  t.after(() => { try { fs.writeFileSync(release, 'go'); } catch { /* released already */ } });
  const until = async (probe, label) => {
    for (let n = 0; n < 800; n += 1) { if (probe()) return; await sleep(10); }
    throw new Error(`gate timeout: ${label}`);
  };
  let allowA; let allowB; let releaseHold;
  const gateA = new Promise((resolve) => { allowA = resolve; });
  const gateB = new Promise((resolve) => { allowB = resolve; });
  const holdGate = new Promise((resolve) => { releaseHold = resolve; });
  t.after(() => { allowA(); allowB(); releaseHold(); });
  let aReady = false; let bReady = false; let holdReady = false; let firstSend = true;
  const posts = [];
  const record = async (args, run = f.execute) => {
    const from = args.indexOf('--from');
    const envelope = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = { flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (envelope?.trainingAnnotations ?? []).map((note) => note.evaluationId) };
    try {
      const out = await run(args);
      row.result = out.retired ? 'retired' : `published:${out.publishId}`;
      return out;
    } catch (error) {
      row.result = error.code;
      throw error;
    } finally {
      posts.push(row);
    }
  };
  const options = { executePublish: record, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir) };
  const a = pipeline.retireRejectedAnnotationAttempt(f.dir, { ...options, verifyRelay: async () => { aReady = true; await gateA; } });
  const b = pipeline.flushAnnotationPublish(f.dir, {
    gameEpoch: EPOCH, trainingControl: f.tc,
    executePublish: async (args) => {
      if (firstSend) {
        firstSend = false;
        bReady = true;
        await gateB;
        // The first send runs with the checkpoint seam: it will capture the authorities and wait.
        return record(args, (inner) => runPublisherPaused(f.dir, inner, checkpoints));
      }
      return record(args);
    },
    retirePending: async () => {
      const settled = await pipeline.retireRejectedAnnotationAttempt(f.dir, options);
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  });
  a.catch(() => {}); b.catch(() => {});
  await until(() => aReady && bReady, 'both in flight');
  const holder = f.tc.withLock(f.dir, async () => { holdReady = true; await holdGate; });
  await until(() => holdReady, 'holder');
  allowA();
  await until(() => fs.existsSync(evidenceFile(f.dir)) && !fs.existsSync(attemptFile(f.dir)), 'A retired on evidence, settlement waiting behind the holder');
  releaseLeakedCard(f.dir); // the hand changes: a fresh judgement of A would now be an acceptance
  allowB();
  await until(() => fs.existsSync(reached), 'the preempted publisher captured the authorities (A still queued) with the evidence outstanding');
  // While it is held: the settlement it did not see completes — authority written, evidence consumed.
  releaseHold();
  await holder;
  const ra = await a;
  assert.deepEqual([ra.retired, ra.dropped], [true, 1]);
  await until(() => !fs.existsSync(evidenceFile(f.dir)), 'evidence consumed');
  assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId], undefined, 'A is out of the queue before the publisher resumes');
  fs.writeFileSync(release, 'go');
  const rb = await b.then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error.code }));

  assert.deepEqual(rb, { ok: true, value: undefined }, 'the flush completes');
  const snapshot = readJson(path.join(f.dir, 'ui-snapshot.json'));
  assert.equal(Object.hasOwn(snapshot.trainingAnnotations ?? {}, f.evaluation.evaluationId), false, 'retired A never reaches the relay');
  assert.deepEqual(posts.map((row) => [row.flags, row.ids.length, row.result]), [
    ['--from --retire-rejected --expect-attempt-sha256 --expect-game-epoch --relay-pid --relay-start-time --relay-port', 1, 'retired'],
    ['--from', 2, 'REJECTION_EVIDENCE_PENDING'],
    ['--from', 1, `published:${snapshot.publishId}`],
  ], 'the preempted A+B is refused on the evidence it snapshotted first; B is rebuilt and published alone');
  assert.deepEqual(posts[2].ids, [other.evaluationId]);
  const auth = f.tc.loadAuthority(f.dir);
  assert.deepEqual(auth.annotationQueue, {});
  assert.equal(auth.items[f.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(auth.items[other.evaluationId].annotations.explanation.published, true);
  assert.equal(fs.existsSync(attemptFile(f.dir)), false);
  assert.equal(auditLines(f.dir).length, 1);
});

// #274: existing evidence that is not a JSON object is not "no evidence". Only ENOENT is
// absence; null, false, 0, an empty string or an array on disk fail every settlement and every
// annotation publication closed — the publisher before any POST, the training control before
// any disposition — and are never consumed, until the genuine evidence is back.
test('existing evidence that is not a JSON object is invalid, not absent: settlement and every annotation publication fail closed before any POST, and the file is never consumed', async (t) => {
  const f = await refusedAttempt(t, { others: [q3Evaluation(EPOCH, 'd-1-preflop-1')] });
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const genuine = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  releaseLeakedCard(f.dir); // a fresh judgement of A would now be an acceptance
  const envelope = pipeline.annotationEnvelope(f.dir, { gameEpoch: EPOCH });
  assert.deepEqual(envelope.trainingAnnotations.map((row) => row.evaluationId), [f.evaluation.evaluationId], 'A is still queued, unsettled');
  const file = pipeline.writeTrainingEnvelope(f.dir, envelope, { kind: 'annotation' });
  const snapshotBefore = fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8');
  for (const [label, content] of [['null', 'null'], ['false', 'false'], ['zero', '0'], ['empty string', '""'], ['array', '[]']]) {
    fs.writeFileSync(evidenceFile(f.dir), content, { mode: 0o600 });
    await assert.rejects(createTrainingControl().reconcileRetiredAnnotations(f.dir), { code: 'REJECTION_EVIDENCE_UNAVAILABLE' }, label);
    const publisher = recordingPublisher(f.dir);
    await assert.rejects(pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: f.tc }),
      { code: 'REJECTION_EVIDENCE_UNAVAILABLE' }, label);
    assert.deepEqual(publisher.calls, [], `${label}: the flush built and sent nothing`);
    const direct = await runPublisher(f.dir, ['--from', file]).then(() => null, (e) => e);
    assert.equal(direct?.code, 'REJECTION_EVIDENCE_UNAVAILABLE', `${label}: the publisher itself refuses the annotation body before any POST`);
    assert.equal(fs.existsSync(attemptFile(f.dir)), false, `${label}: no attempt was recorded`);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8'), snapshotBefore, `${label}: nothing reached the relay`);
    assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), content, `${label}: the file is left as found, never consumed`);
    assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation, `${label}: queue kept`);
  }
  fs.writeFileSync(evidenceFile(f.dir), genuine, { mode: 0o600 });
  const settled = await f.tc.reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([settled.pending, settled.retired], [false, 1]);
  assert.equal(Object.hasOwn(readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {}, f.evaluation.evaluationId), false, 'retired A never reached the relay');
});

// #274: notes and authority items must be one-to-one. A body naming A twice against an
// authority of A and B would, on a retirable refusal, produce an audit line and a disposition
// naming B — which the relay never judged. The publisher refuses such a body before anything
// is sent; the training control refuses crafted evidence of that shape and keeps it.
test('one-to-one membership: a body naming A twice against an authority of A and B is refused before anything is sent, and crafted evidence of that shape settles nothing and is kept', async (t) => {
  const other = q3Evaluation(EPOCH, 'd-1-preflop-1');
  const f = await refusedAttempt(t, { others: [other] });
  assert.equal((await f.tc.sealAnnotation(f.dir, other.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const authority = pipeline.annotationEnvelope(f.dir, { gameEpoch: EPOCH }).annotationAuthority;
  assert.deepEqual(authority.items.map((row) => row.evaluationId), [f.evaluation.evaluationId, other.evaluationId]);
  const noteA = f.record.body.trainingAnnotations[0];
  const crafted = { ...f.record, body: { ...f.record.body, trainingAnnotations: [noteA, noteA] }, annotationAuthority: authority };
  fs.writeFileSync(attemptFile(f.dir), JSON.stringify(crafted));
  const craftedBytes = fs.readFileSync(attemptFile(f.dir), 'utf8');
  const envelope = path.join(f.dir, 'retire-duplicate.json');
  writeJson(envelope, { trainingAnnotations: crafted.body.trainingAnnotations, annotationAuthority: authority });
  const snapshotBefore = fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8');
  const refused = await runPublisher(f.dir, ['--from', envelope, ...retireArgs(crafted, relayBinding(f.dir))]).then(() => null, (e) => e);
  assert.equal(refused?.code, 'ATTEMPT_NOT_RETIRABLE');
  assert.equal(fs.readFileSync(attemptFile(f.dir), 'utf8'), craftedBytes, 'the attempt is kept exactly');
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'no evidence');
  assert.equal(fs.existsSync(logFile(f.dir)), false, 'no audit line');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8'), snapshotBefore, 'nothing was sent');
  assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[other.evaluationId].explanation.solo, undefined, 'B was not isolated');
  // The genuine attempt retires normally; crafted evidence of the duplicate shape, with an audit
  // row that matches it, is refused by the verifier and left on disk.
  fs.writeFileSync(attemptFile(f.dir), f.attemptBytes);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const genuine = JSON.parse(fs.readFileSync(evidenceFile(f.dir), 'utf8'));
  const forged = structuredClone(genuine);
  forged.body.trainingAnnotations = [genuine.body.trainingAnnotations[0], genuine.body.trainingAnnotations[0]];
  forged.annotationAuthority = { ...genuine.annotationAuthority, items: authority.items };
  forged.bodySha256 = sha256Hex(JSON.stringify(forged.body));
  appendRejectionRecord(f.dir, {
    schemaVersion: 1, at: genuine.at, publishId: forged.publishId, expectedGameEpoch: EPOCH, bodySha256: forged.bodySha256,
    httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL',
    items: authority.items.map(({ evaluationId, field, valueSha256 }) => ({ evaluationId, field, valueSha256 })),
  });
  const forgedBytes = JSON.stringify(forged);
  fs.writeFileSync(evidenceFile(f.dir), forgedBytes, { mode: 0o600 });
  await assert.rejects(createTrainingControl().reconcileRetiredAnnotations(f.dir), { code: 'REJECTION_EVIDENCE_INVALID' });
  assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), forgedBytes, 'the evidence is kept, not consumed');
  const unsettled = f.tc.loadAuthority(f.dir);
  assert.ok(unsettled.annotationQueue[f.evaluation.evaluationId]?.explanation, 'A still queued');
  assert.equal(unsettled.annotationQueue[other.evaluationId].explanation.solo, undefined, 'B untouched');
  // Restored, the genuine evidence settles A alone.
  fs.writeFileSync(evidenceFile(f.dir), JSON.stringify(genuine), { mode: 0o600 });
  const settled = await f.tc.reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([settled.retired, settled.isolated, settled.skipped], [1, 0, 0]);
  assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[other.evaluationId].explanation.solo, undefined);
});

// Two explanations sealed and refused together as one body: the batch retirement's shape.
async function refusedBatch(t) {
  const dir = tmpQ3('holdem-274-batch-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSecurityFixtures(dir, { config: OWNED_CONFIG, handInProgress: { handNo: 2, holes: { p1: ['7c', '2d'] } } });
  const relay = await startServer({ gameDir: dir, port: 0, token: TOKEN });
  t.after(() => relay.close());
  const tc = createTrainingControl();
  const leaking = q3Evaluation(EPOCH);
  const safe = q3Evaluation(EPOCH, 'd-1-preflop-1');
  const execute = (args) => runPublisher(dir, args);
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [leaking, safe] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: execute, trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, leaking.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  assert.equal((await tc.sealAnnotation(dir, safe.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: execute, trainingControl: tc })
    .then(() => assert.fail('the shared body must be refused'), (error) => assert.equal(error.code, 'PUBLISH_REJECTED'));
  const record = readJson(attemptFile(dir));
  assert.equal(record.body.trainingAnnotations.length, 2);
  const envelope = path.join(dir, 'retire.json');
  writeJson(envelope, { trainingAnnotations: record.body.trainingAnnotations, annotationAuthority: record.annotationAuthority });
  const exactOf = (evaluation) => path.join(dir, 'training', 'annotations', `${tc.loadAuthority(dir).items[evaluation.evaluationId].detailRef}.explanation.json`);
  return { dir, tc, leaking, safe, record, envelope, execute, exactOf };
}

// #274: a retired batch's entries are resent alone later, from their canonical files. A crash
// may lose a canonical file's directory entry while the authority, the evidence and the audit
// survive; consuming the evidence then would drop the innocent entry as exact-file-missing and
// lose its only remaining copy. The verified evidence restores the file first.
test('a retired batch whose innocent canonical file lost its directory entry: the value is restored from the verified evidence before the evidence is consumed, and the innocent explanation is isolated and published, not dropped', async (t) => {
  const f = await refusedBatch(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const exact = f.exactOf(f.safe);
  const exactBytes = fs.readFileSync(exact, 'utf8');
  fs.unlinkSync(exact); // the crash: the name is gone; authority, evidence and audit remain
  const settled = await createTrainingControl().reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([settled.pending, settled.retired, settled.isolated, settled.skipped], [false, 0, 2, 0]);
  assert.equal(fs.readFileSync(exact, 'utf8'), exactBytes, 'restored byte for byte from the evidence note, against the authority digest');
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'consumed only after the restoration');
  const reconciled = await f.tc.reconcileAnnotationQueue(f.dir);
  assert.equal(reconciled.dropped, 0, 'nothing is exact-file-missing');
  assert.deepEqual(reconciled.notices, []);
  const auth = f.tc.loadAuthority(f.dir);
  assert.equal(auth.annotationQueue[f.safe.evaluationId].explanation.solo, true, 'the innocent entry waits, alone');
  assert.equal(auth.items[f.safe.evaluationId].annotations.explanation.publishFailed, undefined);
  const publisher = recordingPublisher(f.dir);
  await pipeline.flushAnnotationPublish(f.dir, {
    gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: f.tc,
    retirePending: async () => {
      const outcome = await pipeline.retireRejectedAnnotationAttempt(f.dir, { executePublish: publisher.execute, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir) });
      return outcome.retired === true || outcome.published === true || outcome.settledElsewhere === true;
    },
  });
  const after = f.tc.loadAuthority(f.dir);
  assert.equal(after.items[f.safe.evaluationId].annotations.explanation.published, true, 'the innocent explanation reached the relay');
  assert.equal(after.items[f.leaking.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.deepEqual(after.annotationQueue, {});
  assert.deepEqual(auditLines(f.dir).map((row) => row.items.length), [2, 1]);
  const relayed = readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {};
  assert.equal(Object.hasOwn(relayed, f.safe.evaluationId), true);
  assert.equal(Object.hasOwn(relayed, f.leaking.evaluationId), false);
});

test('a lost canonical file whose value the evidence cannot reproduce against the authority digest keeps the evidence on disk and settles nothing', async (t) => {
  const f = await refusedBatch(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const exact = f.exactOf(f.safe);
  fs.unlinkSync(exact);
  const genuine = JSON.parse(fs.readFileSync(evidenceFile(f.dir), 'utf8'));
  const forged = structuredClone(genuine);
  forged.body.trainingAnnotations[1].value = '다른 값으로 바뀐 설명입니다.';
  forged.bodySha256 = sha256Hex(JSON.stringify(forged.body));
  appendRejectionRecord(f.dir, {
    schemaVersion: 1, at: genuine.at, publishId: forged.publishId, expectedGameEpoch: EPOCH, bodySha256: forged.bodySha256,
    httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL',
    items: genuine.annotationAuthority.items.map(({ evaluationId, field, valueSha256 }) => ({ evaluationId, field, valueSha256 })),
  });
  const forgedBytes = JSON.stringify(forged);
  fs.writeFileSync(evidenceFile(f.dir), forgedBytes, { mode: 0o600 });
  await assert.rejects(createTrainingControl().reconcileRetiredAnnotations(f.dir), { code: 'REJECTION_EVIDENCE_INVALID' });
  assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), forgedBytes, 'the evidence is kept');
  assert.equal(fs.existsSync(exact), false, 'nothing unverifiable was written');
  const auth = f.tc.loadAuthority(f.dir);
  for (const evaluation of [f.leaking, f.safe]) {
    assert.ok(auth.annotationQueue[evaluation.evaluationId]?.explanation, 'still queued');
    assert.equal(auth.annotationQueue[evaluation.evaluationId].explanation.solo, undefined);
    assert.equal(auth.items[evaluation.evaluationId].annotations.explanation.publishFailed, undefined);
  }
});

// #274 restoration replay durability: a restored canonical file can be installed and then its
// directory sync fail. The next settlement finds the file already there and restores nothing —
// but it must still make the names durable (training/annotations, then training) BEFORE the
// evidence is consumed, or a later crash could lose the name after the only copy of its value
// is gone. The failure keeps the evidence; the replay syncs, then consumes.
test('restoration replay: a directory sync failure right after the restored file was installed keeps the evidence; the replay restores nothing yet syncs the canonical directories before consuming', async (t) => {
  const f = await refusedBatch(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const exact = f.exactOf(f.safe);
  const exactBytes = fs.readFileSync(exact, 'utf8');
  fs.unlinkSync(exact);
  const evidenceBytes = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  const authorityBefore = fs.readFileSync(authorityFile(f.dir), 'utf8');
  // First settlement: the file is installed, then the annotations directory sync fails.
  const eio = Object.assign(new Error('io'), { code: 'EIO' });
  const failing = [];
  const first = createTrainingControl({
    io: {
      syncDirectory(dir) {
        failing.push({ dir: path.basename(dir), fileInstalled: fs.existsSync(exact) });
        if (path.basename(dir) === 'annotations') throw eio;
        return syncDirectory(dir);
      },
    },
  });
  await assert.rejects(first.reconcileRetiredAnnotations(f.dir), (error) => error.code === 'REJECTION_EVIDENCE_UNAVAILABLE' && error.causeCode === 'EIO');
  assert.deepEqual(failing, [{ dir: 'annotations', fileInstalled: true }], 'the sync that failed came right after the install');
  assert.equal(fs.readFileSync(exact, 'utf8'), exactBytes, 'the restored file is installed');
  assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), evidenceBytes, 'the evidence is kept');
  assert.equal(fs.readFileSync(authorityFile(f.dir), 'utf8'), authorityBefore, 'no disposition was recorded');
  // The replay: nothing to restore, and still every canonical directory is synced while the
  // evidence is on disk; only then is it consumed.
  const synced = [];
  const replay = createTrainingControl({
    io: {
      syncDirectory(dir) {
        synced.push({ dir: path.basename(dir), evidencePresent: fs.existsSync(evidenceFile(f.dir)) });
        return syncDirectory(dir);
      },
    },
  });
  const settled = await replay.reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([settled.pending, settled.retired, settled.isolated, settled.skipped], [false, 0, 2, 0]);
  assert.deepEqual(synced.slice(0, 2), [{ dir: 'annotations', evidencePresent: true }, { dir: 'training', evidencePresent: true }], 'canonical directories synced before consumption, with no file created in this replay');
  assert.equal(synced.every((row) => row.evidencePresent), true, 'every sync preceded the removal of the evidence');
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false);
  assert.equal(fs.readFileSync(exact, 'utf8'), exactBytes);
  const auth = f.tc.loadAuthority(f.dir);
  assert.equal(auth.annotationQueue[f.safe.evaluationId].explanation.solo, true);
  assert.equal(auth.items[f.safe.evaluationId].annotations.explanation.publishFailed, undefined);
  // The innocent explanation then reaches the relay alone.
  const publisher = recordingPublisher(f.dir);
  await pipeline.flushAnnotationPublish(f.dir, {
    gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: f.tc,
    retirePending: async () => {
      const outcome = await pipeline.retireRejectedAnnotationAttempt(f.dir, { executePublish: publisher.execute, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir) });
      return outcome.retired === true || outcome.published === true || outcome.settledElsewhere === true;
    },
  });
  assert.equal(f.tc.loadAuthority(f.dir).items[f.safe.evaluationId].annotations.explanation.published, true);
  assert.equal(Object.hasOwn(readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {}, f.leaking.evaluationId), false);
});

// #274: a retirable refusal is a present, allowlisted code with its integer status — never a
// missing pair that happens to "equal" an absent map entry. Evidence, audit rows and reported
// refusals without both fields settle nothing, consume nothing and change no queue.
test('a refusal is retirable only with a present allowlisted code and its integer status: missing, null, mistyped, unknown or inherited-name fields authorize nothing anywhere', async (t) => {
  for (const [label, status, code] of [
    ['both missing', undefined, undefined], ['status missing', undefined, 'FORBIDDEN_LITERAL'], ['code missing', 400, undefined],
    ['both null', null, null], ['string status', '400', 'FORBIDDEN_LITERAL'], ['float status', 400.5, 'FORBIDDEN_LITERAL'],
    ['wrong status', 409, 'FORBIDDEN_LITERAL'], ['unknown code', 400, 'BAD_VIEWS'], ['inherited name', 400, 'toString'],
    ['prototype key', 400, '__proto__'], ['constructor', 400, 'constructor'], ['hasOwnProperty', 400, 'hasOwnProperty'],
    ['object code', 400, { toString: () => 'FORBIDDEN_LITERAL' }],
  ]) {
    assert.equal(isRetirableAnnotationRejection(status, code), false, label);
  }
  assert.equal(isRetirableAnnotationRejection(400, 'FORBIDDEN_LITERAL'), true);
  assert.equal(isRetirableAnnotationRejection(409, 'ANNOTATION_CONFLICT'), true);

  const f = await refusedAttempt(t);
  const id = f.evaluation.evaluationId;
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const genuine = JSON.parse(fs.readFileSync(evidenceFile(f.dir), 'utf8'));
  const auditBefore = fs.readFileSync(logFile(f.dir), 'utf8');
  for (const [label, mutate] of [
    ['status missing', (e) => { delete e.httpStatus; }],
    ['code missing', (e) => { delete e.serverCode; }],
    ['both missing', (e) => { delete e.httpStatus; delete e.serverCode; }],
    ['both null', (e) => { e.httpStatus = null; e.serverCode = null; }],
    ['string status', (e) => { e.httpStatus = '400'; }],
    ['unknown code', (e) => { e.serverCode = 'BAD_VIEWS'; }],
    ['inherited name', (e) => { e.serverCode = 'toString'; }],
    ['prototype key', (e) => { e.serverCode = '__proto__'; }],
  ]) {
    const forged = structuredClone(genuine);
    mutate(forged);
    // An "otherwise exact" audit row with the same malformed fields, so only the refusal shape fails.
    fs.writeFileSync(logFile(f.dir), auditBefore);
    appendRejectionRecord(f.dir, {
      schemaVersion: 1, at: genuine.at, publishId: forged.publishId, expectedGameEpoch: EPOCH, bodySha256: forged.bodySha256,
      httpStatus: forged.httpStatus, serverCode: forged.serverCode,
      items: genuine.annotationAuthority.items.map(({ evaluationId, field, valueSha256 }) => ({ evaluationId, field, valueSha256 })),
    });
    const forgedBytes = JSON.stringify(forged);
    fs.writeFileSync(evidenceFile(f.dir), forgedBytes, { mode: 0o600 });
    await assert.rejects(createTrainingControl().reconcileRetiredAnnotations(f.dir), { code: 'REJECTION_EVIDENCE_INVALID' }, label);
    await assert.rejects(f.tc.retireRejectedAnnotations(f.dir, {
      publishId: forged.publishId, expectedGameEpoch: EPOCH, bodySha256: forged.bodySha256, httpStatus: forged.httpStatus, serverCode: forged.serverCode,
    }), { code: 'REJECTION_EVIDENCE_INVALID' }, `${label}: reported`);
    assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), forgedBytes, `${label}: not consumed`);
    const auth = f.tc.loadAuthority(f.dir);
    assert.ok(auth.annotationQueue[id]?.explanation, `${label}: queue unchanged`);
    assert.equal(auth.items[id].annotations.explanation.publishFailed, undefined, `${label}: no disposition`);
  }
  fs.writeFileSync(logFile(f.dir), auditBefore);
  fs.writeFileSync(evidenceFile(f.dir), JSON.stringify(genuine), { mode: 0o600 });
  const settled = await f.tc.reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([settled.retired, settled.httpStatus, settled.serverCode], [1, 400, 'FORBIDDEN_LITERAL']);
});

// #274: the outstanding-evidence fence covers every annotation-bearing body, with or without
// the private authority wrapper (which the relay never sees). While retired A's settlement is
// pending — or the evidence is unreadable — no note of A or of anyone else is judged; after the
// settlement the legacy no-authority publication contract is as it was.
test('no-authority annotation bodies are fenced too: A, B and A+B notes without annotationAuthority are refused unsent while evidence is outstanding or unreadable; after the settlement the legacy publication proceeds', async (t) => {
  const other = q3Evaluation(EPOCH, 'd-1-preflop-1');
  const f = await refusedAttempt(t, { others: [other] });
  assert.equal((await f.tc.sealAnnotation(f.dir, other.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const notes = pipeline.annotationEnvelope(f.dir, { gameEpoch: EPOCH }).trainingAnnotations;
  const noteA = notes.find((note) => note.evaluationId === f.evaluation.evaluationId);
  const noteB = notes.find((note) => note.evaluationId === other.evaluationId);
  assert.ok(noteA?.annotationProof && noteB?.annotationProof);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const genuine = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  releaseLeakedCard(f.dir); // a fresh judgement of A would now be an acceptance
  const snapshotBefore = fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8');
  const raw = (name, trainingAnnotations) => { const file = path.join(f.dir, name); writeJson(file, { trainingAnnotations }); return file; };
  for (const [label, trainingAnnotations] of [['A alone', [noteA]], ['B alone', [noteB]], ['A and B', [noteA, noteB]]]) {
    const error = await runPublisher(f.dir, ['--from', raw(`raw-${label.replace(/\s/g, '-')}.json`, trainingAnnotations)]).then(() => null, (e) => e);
    assert.equal(error?.code, 'REJECTION_EVIDENCE_PENDING', label);
    assert.equal(fs.existsSync(attemptFile(f.dir)), false, `${label}: no attempt recorded`);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8'), snapshotBefore, `${label}: nothing sent`);
    assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), genuine, `${label}: evidence unchanged`);
  }
  fs.writeFileSync(evidenceFile(f.dir), 'null', { mode: 0o600 });
  const unreadable = await runPublisher(f.dir, ['--from', raw('raw-b-unreadable.json', [noteB])]).then(() => null, (e) => e);
  assert.equal(unreadable?.code, 'REJECTION_EVIDENCE_UNAVAILABLE');
  assert.equal(fs.existsSync(attemptFile(f.dir)), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ui-snapshot.json'), 'utf8'), snapshotBefore);
  // Settled, the legacy no-authority publication of B's note is what it always was.
  fs.writeFileSync(evidenceFile(f.dir), genuine, { mode: 0o600 });
  assert.equal((await f.tc.reconcileRetiredAnnotations(f.dir)).retired, 1);
  const legacy = await runPublisher(f.dir, ['--from', raw('raw-b-legacy.json', [noteB])]);
  assert.equal(legacy.ok, true);
  const relayed = readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {};
  assert.equal(Object.hasOwn(relayed, other.evaluationId), true, 'B reached the relay by the legacy contract');
  assert.equal(Object.hasOwn(relayed, f.evaluation.evaluationId), false, 'retired A never did');
});

// #274 ordering: the settlement establishes the recorded attempt's state BEFORE it reads the
// evidence. An accepted ordinary retry withdraws the evidence and then the attempt; a reconciler
// that read the evidence first and found the attempt absent afterwards would apply a refusal the
// relay no longer stands by. The seam schedules that withdrawal exactly between the two reads.
test('ordering: evidence withdrawn by an accepted retry between the attempt check and the evidence read authorizes nothing — the accepted annotation is then marked published, never also rejected', async (t) => {
  const f = await refusedAttempt(t);
  const id = f.evaluation.evaluationId;
  const valueSha256 = f.record.annotationAuthority.items[0].valueSha256;
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  fs.writeFileSync(attemptFile(f.dir), f.attemptBytes); // the interrupted retirement: attempt and evidence both present
  const sequence = [];
  const tc = createTrainingControl({
    io: {
      settlementCheckpoint(name) {
        sequence.push(name);
        if (name === 'attempt-checked') {
          // What the publisher does when the relay accepts the resend: the evidence goes, then the attempt.
          fs.rmSync(evidenceFile(f.dir));
          fs.rmSync(attemptFile(f.dir));
        }
      },
    },
  });
  const settled = await tc.reconcileRetiredAnnotations(f.dir);
  assert.equal(settled, null, 'withdrawn evidence authorizes no retirement');
  assert.deepEqual(sequence, ['attempt-checked'], 'the attempt was checked before the evidence was read');
  const auth = f.tc.loadAuthority(f.dir);
  assert.ok(auth.annotationQueue[id]?.explanation, 'still queued for the accepting caller to mark');
  assert.equal(auth.items[id].annotations.explanation.publishFailed, undefined);
  await f.tc.markAnnotationPublished(f.dir, id, 'explanation', valueSha256);
  const kept = f.tc.loadAuthority(f.dir).items[id].annotations.explanation;
  assert.deepEqual([kept.published, kept.publishFailed], [true, undefined], 'published, and never also rejected');
  assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[id], undefined);
  assert.equal(auditLines(f.dir).length, 1, 'the earlier audit line alone proves nothing without its evidence');
});

// #274 lifetime contract: a permitted POSIX rollback restores the authority from before the
// seal (the seal was a rename into training/ not yet synced) while the exact annotation file,
// the retirement evidence and the audit survive. Consuming the evidence on "queue absent"
// alone would let the hand pipeline seal and send the refused value again. The disposition is
// recorded for the proven digest before the evidence is consumed; nothing canonical changes.
test('pre-seal rollback: evidence of a proven refusal is settled into a durable disposition even when the queue entry is gone, so the surviving exact file is never resealed or resent; published or re-digested annotations are left untouched', async (t) => {
  const f = await refusedAttempt(t);
  const id = f.evaluation.evaluationId;
  const valueSha256 = f.record.annotationAuthority.items[0].valueSha256;
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const evidenceBytes = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  const detailRef = f.tc.loadAuthority(f.dir).items[id].detailRef;
  const exactFile = path.join(f.dir, 'training', 'annotations', `${detailRef}.explanation.json`);
  const exactBytes = fs.readFileSync(exactFile, 'utf8');
  // The rollback: no queue entry, no annotation on the item; exact file, evidence, audit kept.
  fs.writeFileSync(authorityFile(f.dir), f.preSealAuthority);
  const rolledBack = f.tc.loadAuthority(f.dir);
  assert.equal(rolledBack.annotationQueue[id], undefined);
  assert.equal(rolledBack.items[id].annotations.explanation, undefined);

  const settled = await createTrainingControl().reconcileRetiredAnnotations(f.dir);
  assert.deepEqual([settled.pending, settled.retired, settled.isolated, settled.skipped], [false, 1, 0, 0], 'a disposition, not a skip');
  const auth = f.tc.loadAuthority(f.dir);
  const kept = auth.items[id].annotations.explanation;
  assert.deepEqual({ ...kept, rejection: { ...kept.rejection, at: undefined } }, {
    status: 'ready', valueSha256, published: false, publishFailed: 'rejected',
    rejection: { publishId: f.record.body.publishId, httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL', at: undefined },
  });
  assert.equal(auth.annotationQueue[id], undefined);
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'consumed only after the disposition was persisted');
  assert.equal(fs.readFileSync(exactFile, 'utf8'), exactBytes, 'the canonical value on disk is untouched');
  // The surviving exact value cannot come back: sealing it again is a no-op, nothing is queued, nothing is sent.
  assert.deepEqual(await f.tc.sealAnnotation(f.dir, id, 'explanation', LEAKING_TEXT), { ok: true, noop: true });
  assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[id], undefined);
  const publisher = recordingPublisher(f.dir);
  await pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: publisher.execute, trainingControl: f.tc });
  assert.deepEqual(publisher.calls, []);
  assert.equal(Object.hasOwn(readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {}, id), false);
  assert.equal(auditLines(f.dir).length, 1);
  // The replay of the same evidence against an annotation that is already published, or that
  // carries another digest, changes neither: skipped, and the evidence is consumed.
  for (const [label, mutate] of [
    ['published', (annotation) => { annotation.published = true; }],
    ['another digest', (annotation) => { annotation.valueSha256 = 'cd'.repeat(32); }],
  ]) {
    const variant = JSON.parse(f.preSealAuthority);
    variant.items[id].annotations.explanation = { status: 'ready', valueSha256, published: false };
    mutate(variant.items[id].annotations.explanation);
    fs.writeFileSync(authorityFile(f.dir), JSON.stringify(variant));
    fs.writeFileSync(evidenceFile(f.dir), evidenceBytes, { mode: 0o600 });
    const replay = await createTrainingControl().reconcileRetiredAnnotations(f.dir);
    assert.deepEqual([replay.retired, replay.isolated, replay.skipped], [0, 0, 1], label);
    assert.deepEqual(f.tc.loadAuthority(f.dir).items[id].annotations.explanation, variant.items[id].annotations.explanation, `${label}: untouched`);
    assert.equal(fs.existsSync(evidenceFile(f.dir)), false, label);
  }
});

// R11 review (Sol): the same forged value with the canonical file PRESENT. Verification recomputes
// the projection from the note's actual field, status and value against the authority's payload
// digest — an existing canonical file is no substitute for that check — and refuses the evidence:
// nothing is disposed, the evidence is kept, the canonical file is untouched, and no raw value
// reaches the diagnostic.
test('forged evidence whose note value disagrees with its unchanged digest and proof is refused even when the canonical file exists: nothing is disposed, the evidence is kept, the file is untouched', async (t) => {
  const f = await refusedBatch(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const exact = f.exactOf(f.safe);
  const exactBytes = fs.readFileSync(exact);
  const genuine = JSON.parse(fs.readFileSync(evidenceFile(f.dir), 'utf8'));
  const forged = structuredClone(genuine);
  const FORGED_VALUE = '다른 값으로 바뀐 설명입니다.';
  forged.body.trainingAnnotations[1].value = FORGED_VALUE;
  forged.bodySha256 = sha256Hex(JSON.stringify(forged.body));
  appendRejectionRecord(f.dir, {
    schemaVersion: 1, at: genuine.at, publishId: forged.publishId, expectedGameEpoch: EPOCH, bodySha256: forged.bodySha256,
    httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL',
    items: genuine.annotationAuthority.items.map(({ evaluationId, field, valueSha256 }) => ({ evaluationId, field, valueSha256 })),
  });
  const forgedBytes = JSON.stringify(forged);
  fs.writeFileSync(evidenceFile(f.dir), forgedBytes, { mode: 0o600 });
  const error = await createTrainingControl().reconcileRetiredAnnotations(f.dir).then(() => null, (e) => e);
  assert.equal(error?.code, 'REJECTION_EVIDENCE_INVALID');
  assert.equal(String(error?.message ?? '').includes(FORGED_VALUE), false, 'no raw value in the diagnostic');
  assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), forgedBytes, 'the evidence is kept');
  assert.deepEqual(fs.readFileSync(exact), exactBytes, 'the canonical file is untouched');
  const auth = f.tc.loadAuthority(f.dir);
  for (const evaluation of [f.leaking, f.safe]) {
    assert.ok(auth.annotationQueue[evaluation.evaluationId]?.explanation, 'still queued');
    assert.equal(auth.annotationQueue[evaluation.evaluationId].explanation.solo, undefined);
    assert.equal(auth.items[evaluation.evaluationId].annotations.explanation.publishFailed, undefined);
  }
});

// R12 review (Astra F1): an unsafe entry at the attempt's name must never block this process.
// A FIFO with no writer would block a plain open forever; the bounded, preinspected,
// non-blocking reader refuses it without opening it that way. Exercised in an isolated owned
// child process (so a regression blocks the child, not the suite) with a bounded observer:
// reconciliation and the retirement helper both fail promptly with a closed code, send nothing,
// dispose nothing, and leave the unsafe entry exactly where it is.
test('POSIX: a FIFO without a writer at the attempt\'s name never blocks: reconciliation and the retirement helper fail promptly with a closed code, send nothing, dispose nothing, and leave the entry', { skip: process.platform === 'win32' ? 'POSIX FIFO' : false, timeout: 30_000 }, async (t) => {
  const dir = tmpQ3('holdem-274-fifo-');
  writeSecurityFixtures(dir, { config: OWNED_CONFIG, handInProgress: { handNo: 2, holes: { p1: ['7c', '2d'] } } });
  const relay = await startServer({ gameDir: dir, port: 0, token: TOKEN });
  t.after(() => relay.close());
  const tc = createTrainingControl();
  const evaluation = q3Evaluation(EPOCH);
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [evaluation] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: (args) => runPublisher(dir, args), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  const authorityFile = path.join(dir, 'training', '.training-authority.json');
  const authorityBefore = fs.readFileSync(authorityFile);
  const fifo = path.join(dir, '.publish-attempt.json');
  execFileSync('mkfifo', [fifo]);
  assert.equal(fs.lstatSync(fifo).isFIFO(), true);
  const probeDir = tmpQ3('holdem-274-fifo-probe-');
  const probe = path.join(probeDir, 'probe.mjs');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  fs.writeFileSync(probe, [
    `import { createTrainingControl } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'tools/training-control.js')).href)};`,
    `import * as pipeline from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'tools/training-pipeline.js')).href)};`,
    'const dir = process.argv[2];',
    'const out = {};',
    "try { await createTrainingControl().reconcileRetiredAnnotations(dir); out.reconcile = 'ok'; } catch (error) { out.reconcile = error.code; }",
    'try {',
    '  const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {',
    "    executePublish: async () => { out.posted = true; throw new Error('must not send'); },",
    '    trainingControl: createTrainingControl(), relayBinding: () => ({}),',
    '  });',
    '  out.helper = JSON.stringify(settled);',
    '} catch (error) { out.helper = error.code; }',
    "process.stdout.write(JSON.stringify(out) + '\\n');",
    '',
  ].join('\n'));
  const started = Date.now();
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [probe, dir], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }, (error, out, err) => {
      if (error) reject(Object.assign(new Error(`probe did not finish promptly: ${error.code ?? error.signal} ${String(err).trim()}`), { cause: error }));
      else resolve(out);
    });
  });
  const elapsedMs = Date.now() - started;
  const out = JSON.parse(stdout.trim());
  assert.equal(out.reconcile, 'REJECTION_EVIDENCE_UNAVAILABLE', 'reconciliation refused the entry with a closed code');
  assert.equal(out.helper, 'REJECTION_EVIDENCE_UNAVAILABLE', 'the retirement helper refused the entry with a closed code');
  assert.equal(out.posted, undefined, 'nothing was sent');
  assert.ok(elapsedMs < 10_000, `prompt: ${elapsedMs}ms`);
  assert.equal(fs.lstatSync(fifo).isFIFO(), true, 'the unsafe entry is left in place');
  assert.deepEqual(fs.readFileSync(authorityFile), authorityBefore, 'the queue is untouched');
  assert.ok(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId]?.explanation, 'still queued');
  assert.equal(fs.existsSync(path.join(dir, RETIREMENT_EVIDENCE)), false);
  assert.equal(fs.existsSync(path.join(dir, REJECTION_LOG)), false);
});

// R13 review (Astra F1, local artifact integrity): evidence and an audit row naming an evaluation
// that is NOT an own registered item — a key that resolves through the prototype chain, such as
// __proto__ or constructor — with every digest and proof computed to match. Verification must
// require an own, registered, plain item before any projection, restoration or disposition:
// the evidence is refused, prototypes and the authority stay untouched, no canonical file is
// created, the evidence is kept and nothing is sent. Run in an isolated child so that a
// regression could only poison that process, never this runner.
test('forged evidence naming __proto__ / constructor without an own registered evaluation is refused in an isolated process: prototypes, authority and files untouched, evidence kept', { timeout: 60_000 }, async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const probeDir = tmpQ3('holdem-274-proto-probe-');
  const probe = path.join(probeDir, 'probe.mjs');
  fs.writeFileSync(probe, [
    `import { createTrainingControl } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'tools/training-control.js')).href)};`,
    'const dir = process.argv[2];',
    'const out = {};',
    "try { out.result = JSON.stringify(await createTrainingControl().reconcileRetiredAnnotations(dir)); } catch (error) { out.code = error.code; out.message = String(error.message ?? ''); }",
    "out.protoClean = !Object.getOwnPropertyNames(Object.prototype).includes('annotations') && ({}).annotations === undefined;",
    "out.ctorClean = !Object.getOwnPropertyNames(Object).includes('annotations') && !Object.getOwnPropertyNames(Function.prototype).includes('annotations');",
    "process.stdout.write(JSON.stringify(out) + '\\n');",
    '',
  ].join('\n'));
  for (const key of ['__proto__', 'constructor']) {
    const f = await refusedAttempt(t);
    assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
    const genuine = JSON.parse(fs.readFileSync(evidenceFile(f.dir), 'utf8'));
    const genuineItem = f.tc.loadAuthority(f.dir).items[f.evaluation.evaluationId];
    const value = SAFE_TEXT;
    let valueSha256;
    try {
      valueSha256 = projectTrainingAnnotation({ evaluationId: key, payloadSha256: genuineItem.payloadSha256, field: 'explanation', status: 'ready', value }).valueSha256;
    } catch {
      valueSha256 = sha256Hex(value);
    }
    const note = { ...genuine.body.trainingAnnotations[0], evaluationId: key, status: 'ready', value, valueSha256, annotationProof: { id: publicProofId(`${key}:explanation`), valueSha256 } };
    const body = { ...genuine.body, trainingAnnotations: [note] };
    const forged = {
      ...genuine, body, bodySha256: sha256Hex(JSON.stringify(body)),
      annotationAuthority: { ...genuine.annotationAuthority, items: [{ ...genuine.annotationAuthority.items[0], evaluationId: key, valueSha256 }] },
    };
    appendRejectionRecord(f.dir, {
      schemaVersion: 1, at: genuine.at, publishId: forged.publishId, expectedGameEpoch: EPOCH, bodySha256: forged.bodySha256,
      httpStatus: genuine.httpStatus, serverCode: genuine.serverCode,
      items: forged.annotationAuthority.items.map(({ evaluationId, field, valueSha256: digest }) => ({ evaluationId, field, valueSha256: digest })),
    });
    const forgedBytes = JSON.stringify(forged);
    fs.writeFileSync(evidenceFile(f.dir), forgedBytes, { mode: 0o600 });
    const authorityFile = path.join(f.dir, 'training', '.training-authority.json');
    const authorityBefore = fs.readFileSync(authorityFile);
    const annotationsDir = path.join(f.dir, 'training', 'annotations');
    const listing = () => (fs.existsSync(annotationsDir) ? fs.readdirSync(annotationsDir).sort() : []);
    const filesBefore = listing();
    const auditBefore = fs.readFileSync(logFile(f.dir), 'utf8');
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, [probe, f.dir], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' }, (error, out, err) => {
        if (error) reject(Object.assign(new Error(`probe failed for ${key}: ${error.code ?? error.signal} ${String(err).trim()}`), { cause: error }));
        else resolve(out);
      });
    });
    const out = JSON.parse(stdout.trim());
    assert.equal(out.code, 'REJECTION_EVIDENCE_INVALID', `${key}: ${out.code ?? out.result}`);
    assert.equal(out.message.includes(value), false, `${key}: no raw value in the diagnostic`);
    assert.equal(out.protoClean, true, `${key}: Object.prototype untouched`);
    assert.equal(out.ctorClean, true, `${key}: constructor untouched`);
    assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), forgedBytes, `${key}: the evidence is kept`);
    assert.deepEqual(fs.readFileSync(authorityFile), authorityBefore, `${key}: the authority bytes are unchanged`);
    assert.deepEqual(listing(), filesBefore, `${key}: no canonical file was created`);
    assert.equal(fs.readFileSync(logFile(f.dir), 'utf8'), auditBefore, `${key}: the audit is unchanged`);
    assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId]?.explanation, `${key}: the real queue entry is untouched`);
    assert.equal(fs.existsSync(path.join(f.dir, 'training', 'annotations', 'undefined.explanation.json')), false);
  }
});

// R13 review (Astra F2 / Sol F2): a legitimate interrupted retirement leaves TWO audit rows for
// the same body (audited, then retired again after the attempt was found still recorded). A
// competitor completes that retry — evidence consumed, queue disposed — before a losing caller's
// first read. The losing caller's proof is the exact identity its own refused request reported:
// repeated rows that agree on body, publishId, epoch and item membership are one consistent
// history, not an ambiguity; rows that disagree on membership prove nothing. Then the innocent
// note sealed meanwhile is published once.
test('duplicate audit history: an audited-but-still-recorded attempt retired to completion by a competitor before the losing caller\'s first read is proven from its refused identity — consistent repeated rows settle, contradictory membership does not', { timeout: 60_000 }, async (t) => {
  const f = await refusedAttempt(t, { others: [q3Evaluation(EPOCH, 'd-1-preflop-1')] });
  const [innocent] = f.others;
  // Boundary 1 of the crash regression: audited and evidenced, attempt still recorded.
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  fs.writeFileSync(attemptFile(f.dir), f.attemptBytes);
  assert.equal(auditLines(f.dir).length, 1);
  assert.equal((await f.tc.reconcileRetiredAnnotations(f.dir))?.pending, true, 'still recorded: unfinished');
  // The losing caller's own refused request: the drain of that record, refused again — its
  // identity is captured from the actual publisher failure.
  const refusal = await runPublisher(f.dir, ['--from', f.envelope, '--retry']).then(() => null, (e) => e);
  assert.equal(refusal?.code, 'PUBLISH_REJECTED');
  const identity = refusal.envelope.attempt;
  assert.equal(identity?.bodySha256, sha256Hex(JSON.stringify(f.record.body)));
  // The competitor completes the retry retirement: a second row for the same body, the
  // evidence replaced then consumed, the queue disposed.
  const competitor = await pipeline.retireRejectedAnnotationAttempt(f.dir, { executePublish: f.execute, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir) });
  assert.equal(competitor.retired, true);
  const rows = auditLines(f.dir);
  assert.equal(rows.length, 2, 'legitimate duplicate history');
  assert.equal(rows[0].bodySha256, rows[1].bodySha256);
  assert.equal(fs.existsSync(attemptFile(f.dir)), false);
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'the evidence was consumed');
  assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[f.evaluation.evaluationId], undefined);
  // The losing helper, before its first read: nothing on disk but the two rows and the disposition.
  const neverSends = async () => { throw new Error('nothing may be sent for an absent record'); };
  const settled = await pipeline.retireRejectedAnnotationAttempt(f.dir, {
    executePublish: neverSends, trainingControl: createTrainingControl(), relayBinding: () => relayBinding(f.dir), expectedAttempt: identity,
  });
  assert.deepEqual(settled, { retired: false, settledElsewhere: true, completed: true }, 'consistent repeated rows prove the completed retirement');
  const proven = await f.tc.verifyCompletedRetirement(f.dir, identity);
  assert.deepEqual(proven, { settled: true, publishId: identity.publishId, bodySha256: identity.bodySha256, items: 1 });
  // The innocent note sealed meanwhile is published once, as itself.
  assert.equal((await f.tc.sealAnnotation(f.dir, innocent.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const published = [];
  await pipeline.flushAnnotationPublish(f.dir, {
    gameEpoch: EPOCH, trainingControl: f.tc,
    executePublish: async (args) => { const out = await runPublisher(f.dir, args); if (!args.includes('--retry')) published.push(out.publishId); return out; },
    retirePending: async () => false,
  });
  assert.equal(published.length, 1, 'one fresh publication');
  const after = f.tc.loadAuthority(f.dir);
  assert.equal(after.items[innocent.evaluationId].annotations.explanation.published, true);
  assert.deepEqual(after.annotationQueue, {});
  assert.equal(auditLines(f.dir).length, 2, 'no further retirement');
  // Contradictory membership for the same identity proves nothing: not settled, nothing changes.
  const contradictory = { ...rows[1], items: [{ ...rows[1].items[0], valueSha256: 'ab'.repeat(32) }] };
  appendRejectionRecord(f.dir, contradictory);
  assert.deepEqual(await f.tc.verifyCompletedRetirement(f.dir, identity), { settled: false, reason: 'AUDIT_AMBIGUOUS' });
  assert.deepEqual(await pipeline.retireRejectedAnnotationAttempt(f.dir, {
    executePublish: neverSends, trainingControl: createTrainingControl(), relayBinding: () => relayBinding(f.dir), expectedAttempt: identity,
  }), { retired: false });
  assert.deepEqual(f.tc.loadAuthority(f.dir).annotationQueue, {});
  assert.equal(f.tc.loadAuthority(f.dir).items[f.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
});

// R14 review (Astra F1): the canonical annotation file itself. With genuine outstanding
// retirement evidence, a FIFO without a writer at a canonical note's path must not block the
// reconciliation while it holds the training lock: the shared contained reader preinspects
// the entry and refuses it unopened (and opens non-blocking against the race), so the
// settlement fails promptly with a closed code, the evidence and the queue are kept and
// nothing is disposed. Run in an owned, externally bounded child.
test('POSIX: a FIFO without a writer at a canonical annotation path never blocks the reconciliation: prompt closed failure in a bounded child, evidence kept, authority unchanged, entry left', { skip: process.platform === 'win32' ? 'POSIX FIFO' : false, timeout: 40_000 }, async (t) => {
  const f = await refusedBatch(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const evidenceBytes = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  const authorityFile = path.join(f.dir, 'training', '.training-authority.json');
  const authorityBefore = fs.readFileSync(authorityFile);
  const exact = f.exactOf(f.safe);
  fs.unlinkSync(exact);
  execFileSync('mkfifo', [exact]);
  assert.equal(fs.lstatSync(exact).isFIFO(), true);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const probe = path.join(tmpQ3('holdem-274-canonical-fifo-probe-'), 'probe.mjs');
  fs.writeFileSync(probe, [
    `import { createTrainingControl } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'tools/training-control.js')).href)};`,
    'const out = {};',
    "try { out.result = JSON.stringify(await createTrainingControl().reconcileRetiredAnnotations(process.argv[2])); } catch (error) { out.code = error.code; }",
    "process.stdout.write(JSON.stringify(out) + '\\n');",
    '',
  ].join('\n'));
  const started = Date.now();
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [probe, f.dir], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }, (error, out, err) => {
      if (error) reject(Object.assign(new Error(`probe did not finish promptly: ${error.code ?? error.signal} ${String(err).trim()}`), { cause: error }));
      else resolve(out);
    });
  });
  const out = JSON.parse(stdout.trim());
  assert.equal(out.code, 'REJECTION_EVIDENCE_UNAVAILABLE', `closed failure: ${out.code ?? out.result}`);
  assert.ok(Date.now() - started < 10_000, 'prompt');
  assert.equal(fs.lstatSync(exact).isFIFO(), true, 'the entry is left in place');
  assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), evidenceBytes, 'the evidence is kept');
  assert.deepEqual(fs.readFileSync(authorityFile), authorityBefore, 'the authority is unchanged');
  for (const evaluation of [f.leaking, f.safe]) {
    assert.ok(f.tc.loadAuthority(f.dir).annotationQueue[evaluation.evaluationId]?.explanation, 'still queued');
    assert.equal(f.tc.loadAuthority(f.dir).annotationQueue[evaluation.evaluationId].explanation.solo, undefined, 'not isolated');
  }
});

// R14 review (Astra F2): a readable canonical file that holds ANOTHER valid value (or another
// status/shape) for an entry the genuine evidence is about to settle. The verified recovery
// copy is still needed: the settlement refuses it, keeps the evidence and the queue, overwrites
// nothing and shows no raw value. Once the owned original is put back, the settlement goes
// through and the innocent note is relayed with its original value.
test('a readable canonical file with a different valid value (or status/shape) is refused before the evidence is consumed: evidence and queue kept, nothing overwritten; restored, the settlement completes and the innocent note relays its original value', { timeout: 60_000 }, async (t) => {
  const f = await refusedBatch(t);
  assert.equal((await runPublisher(f.dir, ['--from', f.envelope, ...retireArgs(f.record, relayBinding(f.dir))])).retired, true);
  const evidenceBytes = fs.readFileSync(evidenceFile(f.dir), 'utf8');
  const authorityFile = path.join(f.dir, 'training', '.training-authority.json');
  const authorityBefore = fs.readFileSync(authorityFile);
  const exact = f.exactOf(f.safe);
  const original = fs.readFileSync(exact);
  const originalNote = JSON.parse(original.toString('utf8'));
  const OTHER = '다른 값으로 바뀐 정상 설명입니다.';
  for (const [label, replacement] of [
    ['another value', { ...originalNote, value: OTHER }],
    ['another status', { ...originalNote, status: 'unavailable', value: null }],
    ['another field shape', { ...originalNote, field: 'exploit' }],
    ['not an object', [originalNote]],
  ]) {
    const bytes = JSON.stringify(replacement);
    fs.writeFileSync(exact, bytes);
    const error = await createTrainingControl().reconcileRetiredAnnotations(f.dir).then(() => null, (e) => e);
    assert.equal(error?.code, 'REJECTION_EVIDENCE_INVALID', `${label}: ${error?.code}`);
    assert.equal(String(error?.message ?? '').includes(OTHER), false, `${label}: no raw value in the diagnostic`);
    assert.equal(String(error?.message ?? '').includes(SAFE_TEXT), false, `${label}: no raw value in the diagnostic`);
    assert.equal(fs.readFileSync(exact, 'utf8'), bytes, `${label}: the unknown file is not overwritten`);
    assert.equal(fs.readFileSync(evidenceFile(f.dir), 'utf8'), evidenceBytes, `${label}: the evidence is kept`);
    assert.deepEqual(fs.readFileSync(authorityFile), authorityBefore, `${label}: the authority is unchanged`);
    for (const evaluation of [f.leaking, f.safe]) {
      const queued = f.tc.loadAuthority(f.dir).annotationQueue[evaluation.evaluationId]?.explanation;
      assert.ok(queued, `${label}: still queued`);
      assert.equal(queued.solo, undefined, `${label}: not isolated`);
      assert.equal(f.tc.loadAuthority(f.dir).items[evaluation.evaluationId].annotations.explanation.publishFailed, undefined, `${label}: not retired`);
    }
  }
  // The owned original is put back: the settlement completes from the same verified value.
  fs.writeFileSync(exact, original);
  const settled = await f.tc.reconcileRetiredAnnotations(f.dir);
  assert.equal(settled?.pending, false);
  assert.equal(settled.isolated, 2, 'the shared body isolates both');
  assert.equal(fs.existsSync(evidenceFile(f.dir)), false, 'the evidence is consumed only now');
  assert.deepEqual(fs.readFileSync(exact), original, 'the canonical value is exactly the original');
  // The next flush retires the refused note alone and relays the innocent one with that value.
  const retirePending = async () => {
    const outcome = await pipeline.retireRejectedAnnotationAttempt(f.dir, { executePublish: f.execute, trainingControl: f.tc, relayBinding: () => relayBinding(f.dir) });
    return outcome.retired === true || outcome.published === true || outcome.settledElsewhere === true;
  };
  await pipeline.flushAnnotationPublish(f.dir, { gameEpoch: EPOCH, executePublish: f.execute, trainingControl: f.tc, retirePending });
  const after = f.tc.loadAuthority(f.dir);
  assert.equal(after.items[f.safe.evaluationId].annotations.explanation.published, true, 'the innocent note reached the relay');
  assert.equal(after.items[f.safe.evaluationId].annotations.explanation.valueSha256, originalNote.valueSha256 ?? after.items[f.safe.evaluationId].annotations.explanation.valueSha256);
  assert.equal(after.items[f.leaking.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.deepEqual(after.annotationQueue, {});
  const relayed = readJson(path.join(f.dir, 'ui-snapshot.json')).trainingAnnotations ?? {};
  assert.equal(Object.hasOwn(relayed, f.safe.evaluationId), true);
  assert.equal(Object.hasOwn(relayed, f.leaking.evaluationId), false);
});

// R16 review (Astra F2): the Windows path, exercised on every platform through a tracking
// fsImpl: the file is fsynced through its own write handle and installed by rename; no
// directory handle is ever opened and no directory durability is claimed (syncDirectory reports
// the limitation instead); removal is an unlink alone. Fail-closed unsafe-entry handling is the
// same on that path: a symlinked target is refused untouched.
test('Windows path on any platform: file fsync through the write handle, install, no directory handle and no durability claim; removal alone; unsafe entries still refused', (t) => {
  const dir = scratch(t, 'holdem-274-win32-path-');
  const calls = [];
  const fds = new Map();
  const fsImpl = fsWith({
    openSync(file, ...rest) {
      if (String(file) === dir) calls.push('open:dir');
      const fd = fs.openSync(file, ...rest);
      fds.set(fd, String(file));
      return fd;
    },
    fsyncSync(fd) {
      const f = fds.get(fd);
      calls.push(`fsync:${f === dir ? 'dir' : (/\.tmp$/.test(f) ? 'tmp' : path.basename(f))}`);
      return fs.fsyncSync(fd);
    },
    renameSync(from, to) { calls.push(`rename:${path.basename(to)}`); return fs.renameSync(from, to); },
    unlinkSync(file) { calls.push(`unlink:${path.basename(String(file))}`); return fs.unlinkSync(file); },
  });
  appendRejectionRecord(dir, RECORD, { fsImpl, platform: 'win32' });
  assert.deepEqual(calls, ['fsync:tmp', `rename:${REJECTION_LOG}`], 'the file is fsynced through its write handle and installed; no directory handle');
  assert.deepEqual(readRejectionRecords(dir), [RECORD]);
  calls.length = 0;
  assert.deepEqual(syncDirectory(dir, { fsImpl, platform: 'win32' }), { synced: false, reason: 'win32' }, 'the limitation is reported, never a claimed sync');
  assert.deepEqual(calls, [], 'no directory handle is opened on the Windows path');
  const name = '.publish-attempt.json';
  const text = JSON.stringify({ body: { publishId: 7, trainingAnnotations: [] }, expectedGameEpoch: 'ab'.repeat(32) });
  assert.deepEqual(installAttemptDurably(dir, name, text, { fsImpl, platform: 'win32' }), { replaced: true });
  assert.deepEqual(calls, ['fsync:tmp', `rename:${name}`], 'install: write-handle fsync, rename, no directory step');
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), text);
  calls.length = 0;
  assert.deepEqual(installAttemptDurably(dir, name, text, { fsImpl, platform: 'win32' }), { replaced: false });
  assert.deepEqual(calls, [`fsync:${name}`], 'same bytes: fsynced in place through a writable handle, nothing replaced');
  calls.length = 0;
  removeDurably(dir, name, { fsImpl, platform: 'win32' });
  assert.deepEqual(calls, [`unlink:${name}`], 'removal is the unlink alone on the Windows path');
  assert.equal(fs.existsSync(path.join(dir, name)), false);
  // Unsafe entries fail closed on this path too: a symlinked target is refused untouched.
  const sentinel = outsideSentinel(t);
  fs.writeFileSync(sentinel, text);
  fs.symlinkSync(sentinel, path.join(dir, name));
  calls.length = 0;
  assert.throws(() => installAttemptDurably(dir, name, text, { fsImpl, platform: 'win32' }), { code: 'REJECTION_AUDIT_UNSAFE' });
  assert.deepEqual(calls, [], 'nothing was synced, renamed or unlinked');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), text, 'the outside file is untouched');
  assert.equal(fs.lstatSync(path.join(dir, name)).isSymbolicLink(), true, 'the link is left in place');
});
