import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PROOF = {
  user: 'S-1-5-21-1',
  tokenOwner: 'S-1-5-21-1',
  owner: 'S-1-5-21-1',
  reparse: false,
  rules: [{ sid: 'S-1-5-21-1', type: 'Allow', rights: 2032127 }],
};
const CHILD_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_TIME', 'TZ'];

function diagDir() {
  return createOwnedTempDir('holdem-proof-diag');
}

function aclSpawn(result) {
  return () => result;
}

function okAclResult() {
  return { status: 0, stdout: JSON.stringify([PROOF]), stderr: '', error: undefined };
}

async function withDiagnostics(dir, fn) {
  const prev = process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS;
  if (dir === undefined) delete process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS;
  else process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS;
    else process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS = prev;
  }
}

function readLines(dir) {
  const file = path.join(dir, 'proofs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function cliEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('unset diagnostics env does not create a proofs.jsonl and omits the child env key', async () => {
  const dir = diagDir();
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'x', { mode: 0o600 });
  await withDiagnostics(undefined, async () => {
    const files = await import('../shared/platform-files.js');
    const study = await import('../tools/study-service.js');
    assert.equal(typeof files.setProofPhase, 'function');
    assert.equal(typeof study.childEnvironment, 'function');
    const verdict = files.arePrivatePaths([{ file: target }], {
      platform: 'win32',
      spawn: aclSpawn(okAclResult()),
    });
    assert.equal(verdict, true);
    assert.equal(fs.existsSync(path.join(dir, 'proofs.jsonl')), false);
    const env = study.childEnvironment({
      PATH: '/bin',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      TEMP: '/tmp',
      TMP: '/tmp',
      LANG: 'C',
      LC_ALL: 'C',
      LC_TIME: 'C',
      TZ: 'UTC',
      SECRET: 'no',
    });
    assert.equal('AI_HOLDEM_PLATFORM_DIAGNOSTICS' in env, false);
    assert.deepEqual(Object.keys(env).sort(), CHILD_KEYS.sort());
  });
});

test('diagnostics env records one acl line and one identity line with the set phase', async () => {
  const dir = diagDir();
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'x', { mode: 0o600 });
  await withDiagnostics(dir, async () => {
    const files = await import('../shared/platform-files.js');
    const identity = await import('../engine/process-identity.js');
    files.setProofPhase('acl-test');
    try {
      assert.equal(files.arePrivatePaths([{ file: target }], {
        platform: 'win32',
        spawn: aclSpawn(okAclResult()),
      }), true);
    } finally {
      files.setProofPhase(null);
    }
    files.setProofPhase('identity-test');
    try {
      identity.win32ProcessStartTime(1, {
        spawn: () => ({ status: 0, stdout: '2026-09-07T00:00:00.0000000Z', stderr: '' }),
      });
    } finally {
      files.setProofPhase(null);
    }
    const lines = readLines(dir);
    assert.equal(lines.length, 1 + 1);
    const acl = lines.find((row) => row.kind === 'acl');
    const id = lines.find((row) => row.kind === 'identity');
    assert.ok(acl);
    assert.equal(typeof acl.t, 'number');
    assert.equal(acl.pid, process.pid);
    assert.equal(acl.kind, 'acl');
    assert.equal(typeof acl.paths, 'number');
    assert.equal(acl.phase, 'acl-test');
    assert.equal(acl.timedOut, false);
    assert.equal(typeof acl.ms, 'number');
    assert.ok('status' in acl);
    assert.ok(id);
    assert.equal(id.kind, 'identity');
    assert.equal(id.phase, 'identity-test');
    assert.equal(id.timedOut, false);
    if (process.platform === 'win32') {
      files.setProofPhase('create-test');
      try { files.createPrivateDirectory(path.join(dir, 'created')); }
      catch { /* probe may fail under a fake environment; the jsonl kind is the contract */ }
      finally { files.setProofPhase(null); }
    }
  });
});

test('ETIMEDOUT spawn records timedOut true and does not change the unproven verdict', async () => {
  const dir = diagDir();
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'x', { mode: 0o600 });
  const timedOut = { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } };
  const files = await import('../shared/platform-files.js');
  const without = await withDiagnostics(undefined, () => files.arePrivatePaths([{ file: target }], {
    platform: 'win32',
    spawn: aclSpawn(timedOut),
  }));
  const withDiag = await withDiagnostics(dir, () => files.arePrivatePaths([{ file: target }], {
    platform: 'win32',
    spawn: aclSpawn(timedOut),
  }));
  assert.equal(without, false);
  assert.equal(withDiag, false);
  const lines = readLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].timedOut, true);
  assert.equal(lines[0].kind, 'acl');
});

test('a read-only diagnostics directory does not throw and leaves the verdict unchanged', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX EACCES probe; Windows ACL of the diag dir is not chmod');
    return;
  }
  const dir = diagDir();
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'x', { mode: 0o600 });
  const files = await import('../shared/platform-files.js');
  const spawn = aclSpawn(okAclResult());
  const expected = files.arePrivatePaths([{ file: target }], { platform: 'win32', spawn });
  fs.chmodSync(dir, 0o555);
  try {
    const actual = await withDiagnostics(dir, () => files.arePrivatePaths([{ file: target }], {
      platform: 'win32',
      spawn,
    }));
    assert.equal(actual, expected);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test('childEnvironment includes the diagnostics key only when set and keeps the other nine keys', async () => {
  const study = await import('../tools/study-service.js');
  const base = {
    PATH: '/bin',
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    TEMP: '/tmp',
    TMP: '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    LC_TIME: 'C',
    TZ: 'UTC',
    SECRET: 'no',
  };
  const off = study.childEnvironment(base);
  assert.deepEqual(Object.keys(off).sort(), CHILD_KEYS.sort());
  assert.equal(off.SECRET, undefined);
  const on = study.childEnvironment({ ...base, AI_HOLDEM_PLATFORM_DIAGNOSTICS: '/tmp/diag' });
  assert.equal(on.AI_HOLDEM_PLATFORM_DIAGNOSTICS, '/tmp/diag');
  assert.deepEqual(Object.keys(on).filter((key) => key !== 'AI_HOLDEM_PLATFORM_DIAGNOSTICS').sort(), CHILD_KEYS.sort());
});

test('transportDetail puts cause.code on the health-transport line', async () => {
  const study = await import('../tools/study-service.js');
  assert.equal(typeof study.transportDetail, 'function');
  const error = Object.assign(new TypeError('fetch failed'), {
    code: 'ERR_NETWORK',
    cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
  });
  const detail = study.transportDetail(error);
  assert.match(detail, /ECONNREFUSED/);
  assert.match(detail, /cause=ECONNREFUSED/);
  assert.match(detail, /fetch failed/);
  assert.equal(study.transportDetail(new Error('x')), study.transportDetail(new Error('x')));
  assert.match(study.transportDetail(new Error('x')), /cause=none/);
});

test('cleanupFailureLine formats kind, label, pid and error', async () => {
  const fixtures = await import('./helpers/owned-fixtures.mjs');
  assert.equal(typeof fixtures.cleanupFailureLine, 'function');
  const line = fixtures.cleanupFailureLine(
    { kind: 'process', label: 's8-owned-relay', pid: 4321 },
    new Error('owned process remained alive: s8-owned-relay'),
  );
  assert.match(line, /^OWNED_FIXTURE_CLEANUP_FAILED /);
  assert.match(line, /kind=process/);
  assert.match(line, /label=s8-owned-relay/);
  assert.match(line, /pid=4321/);
  assert.match(line, /error=owned process remained alive: s8-owned-relay/);
});

test('proof-profile-report aggregates five fixture lines as a table and as --json', () => {
  const dir = diagDir();
  const file = path.join(dir, 'proofs.jsonl');
  const rows = [
    { t: 1, pid: 10, kind: 'acl', paths: 2, ms: 100, status: 0, timedOut: false, phase: 'ensure' },
    { t: 2, pid: 10, kind: 'acl', paths: 1, ms: 50, status: 0, timedOut: false, phase: 'ensure' },
    { t: 3, pid: 10, kind: 'identity', paths: 1, ms: 1000, status: null, timedOut: true, phase: 'checkpoint' },
    { t: 4, pid: 11, kind: 'acl', paths: 3, ms: 20, status: 1, timedOut: false, phase: null },
    { t: 5, pid: 11, kind: 'create', paths: 1, ms: 30, status: 0, timedOut: false, phase: 'create' },
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const helper = path.join(HERE, 'helpers', 'proof-profile-report.mjs');
  const text = spawnSync(process.execPath, [helper, file], { encoding: 'utf8', env: cliEnv() });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /calls=5/);
  assert.match(text.stdout, /timedOut=1/);
  const json = spawnSync(process.execPath, [helper, file, '--json'], { encoding: 'utf8', env: cliEnv() });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.total.calls, 5);
  assert.equal(parsed.total.ms, 1200);
  assert.equal(parsed.total.timedOut, 1);
  assert.equal(parsed.total.nonzero, 2);
  assert.equal(parsed.byPid['10'].calls, 3);
  assert.equal(parsed.byPhase.ensure.calls, 2);
  assert.equal(parsed.byKind.acl.calls, 3);
});

test('reporter CLIs stay inert when node --test loads the helper modules', async () => {
  await import('./helpers/proof-profile-report.mjs');
  await import('./helpers/tap-file-timing.mjs');
});

test('tap-file-timing maps a step-6 then alphabet-restart log back onto two files', () => {
  const dir = diagDir();
  const tests = path.join(dir, 'test');
  fs.mkdirSync(tests);
  fs.writeFileSync(path.join(tests, 'alpha.test.js'), "test('alpha one', () => {});\n");
  fs.writeFileSync(path.join(tests, 'zeta.test.js'), "test('zeta one', () => {});\n");
  const log = path.join(dir, 'job.log');
  const lines = [
    'gate\t2026-09-07T10:00:00.0000000Z # Subtest: zeta one',
    'gate\t2026-09-07T10:00:05.0000000Z ok 1 - zeta one',
    'run\t2026-09-07T10:03:00.0000000Z # Subtest: alpha one',
    'run\t2026-09-07T10:03:10.0000000Z ok 1 - alpha one',
    'run\t2026-09-07T10:03:10.0000000Z # Subtest: zeta one',
    'run\t2026-09-07T10:04:10.0000000Z not ok 2 - zeta one',
  ];
  fs.writeFileSync(log, lines.join('\n') + '\n');
  const helper = path.join(HERE, 'helpers', 'tap-file-timing.mjs');
  const result = spawnSync(process.execPath, [helper, log, tests], { encoding: 'utf8', env: cliEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unmatched subtests: 0/);
  assert.match(result.stdout, /alpha\.test\.js/);
  assert.match(result.stdout, /zeta\.test\.js/);
  assert.match(result.stdout, /zeta\.test\.js[\s\S]*zeta one|zeta one/);
});
