import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privacyProbeTimeout } from './helpers/windows-privacy-probe.mjs';

test('normal privacy probes retain the caller timeout without a cold allowance', () => {
  for (const timeout of [1, 149, 15000]) {
    assert.equal(privacyProbeTimeout(timeout, { deadline: 0, now: 10 }), timeout);
  }
});

test('cold preparation caps each child and consumes one original total deadline', () => {
  const options = { coldStart: true, deadline: 120000 };
  assert.equal(privacyProbeTimeout(15000, { ...options, now: 0 }), 60000);
  assert.equal(privacyProbeTimeout(15000, { ...options, now: 60000 }), 60000);
  assert.equal(privacyProbeTimeout(15000, { ...options, now: 90000.25 }), 29999);
  assert.equal(privacyProbeTimeout(15000, { ...options, now: 119999 }), 1);
  for (const now of [119999.5, 120000, 120001, NaN]) {
    assert.throws(() => privacyProbeTimeout(15000, { ...options, now }), {
      code: 'WINDOWS_PRIVACY_COLD_START_TIMEOUT',
    });
  }
});

test('CI keeps the ordinary privacy gate after bounded cold preparation', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  for (const job of ['windows-publisher', 'windows']) {
    const body = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0];
    assert.ok(body, `missing ${job}`);
    const cold = body.indexOf('run: node test/helpers/windows-privacy-probe.mjs --cold-start');
    const normal = body.indexOf('run: node test/helpers/windows-privacy-probe.mjs\n');
    const verify = body.indexOf(job === 'windows-publisher'
      ? 'run: node --test --test-name-pattern="publish shutdown:"'
      : 'run: node test/helpers/windows-child-environment-probe.mjs');
    assert.ok(cold > 0 && normal > cold && verify > normal, `${job} must prepare, prove, then test`);
    assert.match(body.slice(0, cold), /timeout-minutes: 3/);
  }
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test('unknown privacy probe flags fail instead of silently enabling a cold budget', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  assert.throws(() => execFileSync(process.execPath, [
    fileURLToPath(new URL('./helpers/windows-privacy-probe.mjs', import.meta.url)),
    '--ignore-timeouts',
  ], { env, encoding: 'utf8', stdio: 'pipe', timeout: 10000 }), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /usage: windows-privacy-probe/);
    return true;
  });
});
