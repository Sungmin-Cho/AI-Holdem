import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function verifyCleanupReceipt(file, expectedSha256) {
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(receipt.marker, 'OWNED_FIXTURE_CLEANUP', 'cleanup receipt marker is absent');
  assert.ok(Array.isArray(receipt.evidence), 'cleanup receipt evidence is absent');
  assert.ok(receipt.evidence.every((row) => row.removed === true || row.closed === true || row.dead === true),
    'cleanup receipt contains an unfinished resource');
  const { receiptSha256, ...body } = receipt;
  assert.equal(receiptSha256, digest(JSON.stringify(body)), 'cleanup receipt hash is invalid');
  if (expectedSha256 !== undefined) {
    assert.equal(receiptSha256, expectedSha256, 'cleanup marker hash does not match its receipt');
  }
  return receipt;
}

function summaryCount(stdout, label) {
  const matches = [...stdout.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
  assert.ok(matches.length > 0, `TAP summary is missing # ${label}`);
  return Number(matches.at(-1)[1]);
}

export function assertTapResult(result, { testName, minTests = 1 } = {}) {
  assert.ok(result && typeof result === 'object', 'captured terminal result is required');
  assert.equal(typeof result.stdout, 'string', 'captured stdout is required');
  assert.ok(Object.hasOwn(result, 'exitCode'), 'captured exitCode is required');
  assert.ok(Object.hasOwn(result, 'signal'), 'captured signal is required');
  assert.ok(Object.hasOwn(result, 'timedOut'), 'captured timeout state is required');
  if (Object.hasOwn(result, 'outputLimited')) {
    assert.equal(result.outputLimited, false, 'captured test output was truncated');
  }
  if (Object.hasOwn(result, 'spawnError')) {
    assert.equal(result.spawnError, null, 'captured test process did not spawn cleanly');
  }
  assert.equal(result.exitCode, 0, 'captured test process did not exit 0');
  assert.equal(result.signal, null, 'captured test process exited by signal');
  assert.equal(result.timedOut, false, 'captured test process timed out');
  assert.match(result.stdout, /^TAP version 13$/m, 'captured output is not TAP');
  if (testName) {
    const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(result.stdout, new RegExp(`^ok \\d+ - ${escaped}$`, 'm'), 'named target did not pass');
  }
  assert.ok(summaryCount(result.stdout, 'tests') >= minTests, 'captured TAP test count is too small');
  assert.equal(summaryCount(result.stdout, 'fail'), 0, 'captured TAP contains failures');
  assert.equal(summaryCount(result.stdout, 'skipped'), 0, 'captured TAP contains skips');
  assert.equal(summaryCount(result.stdout, 'cancelled'), 0, 'captured TAP contains cancellations');
  assert.equal(summaryCount(result.stdout, 'todo'), 0, 'captured TAP contains todo tests');
  const markerLines = result.stdout.split('\n').filter((line) => line.includes('OWNED_FIXTURE_CLEANUP'));
  assert.ok(markerLines.length > 0, 'captured TAP cleanup marker is absent');
  const cleanupReceipts = markerLines.map((line) => {
    const marker = line.match(/^\s*#?\s*OWNED_FIXTURE_CLEANUP receipt=(\S+) sha256=([0-9a-f]{64})\s*$/);
    assert.ok(marker, `captured TAP cleanup marker is malformed: ${line.trim()}`);
    verifyCleanupReceipt(marker[1], marker[2]);
    return marker[1];
  });
  return { tests: summaryCount(result.stdout, 'tests'), cleanupReceipts };
}

export function parseCliArgs(argv) {
  if (argv[0]?.startsWith('--')) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (!['--result', '--name', '--min-tests'].includes(flag) || value === undefined || values[flag] !== undefined) {
        throw new Error('usage: assert-tap.mjs --result FILE --name EXACT --min-tests N');
      }
      values[flag] = value;
    }
    const minTests = Number(values['--min-tests']);
    if (!values['--result'] || !values['--name'] || !Number.isInteger(minTests) || minTests < 1) {
      throw new Error('usage: assert-tap.mjs --result FILE --name EXACT --min-tests N');
    }
    return { resultFile: values['--result'], testName: values['--name'], minTests };
  }
  const [resultFile, testName, rawMinTests = '1', ...extra] = argv;
  const minTests = Number(rawMinTests);
  if (!resultFile || !testName || extra.length > 0 || !Number.isInteger(minTests) || minTests < 1) {
    throw new Error('usage: assert-tap.mjs --result FILE --name EXACT --min-tests N');
  }
  return { resultFile, testName, minTests };
}

function main() {
  const { resultFile, testName, minTests } = parseCliArgs(process.argv.slice(2));
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assertTapResult(result, { testName, minTests });
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect && !process.env.NODE_TEST_CONTEXT) main();
