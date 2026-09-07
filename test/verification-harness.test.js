import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createOwnedTempDir,
  inspectOwnedTempDir,
  registerOwnedProcess,
  registerOwnedServer,
} from './helpers/owned-fixtures.mjs';
import { assertTapResult, parseCliArgs } from './helpers/assert-tap.mjs';

test('verification harness requires a real successful TAP result and hashed cleanup evidence', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = createOwnedTempDir('tap-harness');
  const receipts = [1, 2].map((pid) => {
    const file = path.join(dir, `cleanup-${pid}.json`);
    const body = {
      schemaVersion: 1,
      marker: 'OWNED_FIXTURE_CLEANUP',
      pid,
      evidence: [{ kind: 'directory', identitySha256: String(pid).repeat(64), removed: true }],
    };
    const receiptSha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    fs.writeFileSync(file, JSON.stringify({ ...body, receiptSha256 }));
    return { file, receiptSha256 };
  });
  const stdout = [
    'TAP version 13',
    'ok 1 - REQ-003: positive-frequency choices stay allowed',
    `    # OWNED_FIXTURE_CLEANUP receipt=${receipts[0].file} sha256=${receipts[0].receiptSha256}`,
    `# OWNED_FIXTURE_CLEANUP receipt=${receipts[1].file} sha256=${receipts[1].receiptSha256}`,
    '1..1',
    '# tests 16',
    '# suites 0',
    '# pass 16',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 10',
    '',
  ].join('\n');
  const result = { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false };

  assert.deepEqual(assertTapResult(result, {
    testName: 'REQ-003: positive-frequency choices stay allowed',
    minTests: 16,
  }), { tests: 16, cleanupReceipts: receipts.map((row) => row.file) });
});

test('verification harness rejects failed, skipped, empty, timed-out and cleanup-free results', async () => {
  const cleanSummary = [
    'TAP version 13',
    'ok 1 - target',
    '1..1',
    '# tests 1',
    '# pass 1',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '',
  ].join('\n');
  const base = { stdout: cleanSummary, stderr: '', exitCode: 0, signal: null, timedOut: false };
  assert.throws(() => assertTapResult(base, { testName: 'target' }), /cleanup marker/);
  assert.throws(() => assertTapResult({ ...base, exitCode: 1 }, { testName: 'target' }), /exit 0/);
  assert.throws(() => assertTapResult({ ...base, timedOut: true }, { testName: 'target' }), /timed out/);
  assert.throws(() => assertTapResult({ ...base, outputLimited: true }, { testName: 'target' }), /truncated/);
  assert.throws(() => assertTapResult({ ...base, spawnError: { code: 'ENOENT' } }, { testName: 'target' }), /spawn cleanly/);
  assert.throws(() => assertTapResult({ ...base, stdout: cleanSummary.replace('# skipped 0', '# skipped 1') }, { testName: 'target' }), /skips/);
  assert.throws(() => assertTapResult({ ...base, stdout: cleanSummary.replace('# tests 1', '# tests 0') }, { testName: 'target' }), /count/);
});

test('verification harness rejects any malformed marker or bad receipt in multi-file TAP', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = createOwnedTempDir('tap-negative-markers');
  const body = {
    schemaVersion: 1,
    marker: 'OWNED_FIXTURE_CLEANUP',
    pid: 1,
    evidence: [{ kind: 'server', label: 'server', closed: true }],
  };
  const receiptSha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const good = path.join(dir, 'good.json');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(good, JSON.stringify({ ...body, receiptSha256 }));
  fs.writeFileSync(bad, JSON.stringify({ ...body, receiptSha256: '00'.repeat(32) }));
  const summary = [
    'TAP version 13',
    'ok 1 - target',
    '1..1',
    '# tests 1',
    '# pass 1',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ];
  const captured = (markers) => ({
    stdout: [...summary.slice(0, 2), ...markers, ...summary.slice(2), ''].join('\n'),
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
  });
  const goodMarker = `# OWNED_FIXTURE_CLEANUP receipt=${good} sha256=${receiptSha256}`;

  assert.throws(
    () => assertTapResult(captured([goodMarker, '# OWNED_FIXTURE_CLEANUP malformed']), { testName: 'target' }),
    /marker is malformed/,
  );
  assert.throws(
    () => assertTapResult(captured([
      goodMarker,
      `# OWNED_FIXTURE_CLEANUP receipt=${bad} sha256=${'00'.repeat(32)}`,
    ]), { testName: 'target' }),
    /cleanup receipt hash is invalid/,
  );
});

test('verification harness parses declared flags and rejects incomplete or unknown CLI forms', async () => {
  assert.deepEqual(parseCliArgs([
    '--result', '/tmp/result.json',
    '--name', 'REQ-003: positive-frequency choices stay allowed',
    '--min-tests', '16',
  ]), {
    resultFile: '/tmp/result.json',
    testName: 'REQ-003: positive-frequency choices stay allowed',
    minTests: 16,
  });
  assert.deepEqual(parseCliArgs(['/tmp/result.json', 'target', '12']), {
    resultFile: '/tmp/result.json', testName: 'target', minTests: 12,
  });
  assert.throws(() => parseCliArgs(['--result', '/tmp/result.json', '--name', 'target']), /usage/);
  assert.throws(() => parseCliArgs(['--result', '/tmp/result.json', '--bogus', 'x', '--min-tests', '1']), /usage/);
  assert.throws(() => parseCliArgs(['--result', '/tmp/result.json', '--name', 'target', '--min-tests', '0']), /usage/);
});

test('owned temp cleanup accepts routine removal but detects replacement inodes without deleting them', async () => {
  const fs = await import('node:fs');
  const original = createOwnedTempDir('owned-original');
  const replacement = createOwnedTempDir('owned-replacement');
  assert.equal(inspectOwnedTempDir(original), 'owned');
  fs.rmSync(original, { recursive: true });
  assert.equal(inspectOwnedTempDir(original), 'absent');
  fs.symlinkSync(replacement, original);
  assert.equal(inspectOwnedTempDir(original), 'replacement');
  assert.equal(fs.existsSync(replacement), true);
  fs.unlinkSync(original);
  fs.rmSync(replacement, { recursive: true });
  assert.equal(inspectOwnedTempDir(original), 'absent');
  assert.equal(inspectOwnedTempDir(replacement), 'absent');
});

test('owned fixture cleanup registers real directories, servers and child processes', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const dir = createOwnedTempDir('owned-resources');
  const server = registerOwnedServer(http.createServer((_request, response) => response.end('ok')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const child = registerOwnedProcess(spawn(process.execPath, [
    '--input-type=module',
    '-e',
    'setInterval(() => {}, 1000)',
  ], { stdio: 'ignore' }));

  assert.equal(server.listening, true);
  assert.equal(Number.isInteger(child.pid), true);
  assert.equal((await import('node:fs')).existsSync(dir), true);
});
