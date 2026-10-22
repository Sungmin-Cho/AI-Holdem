import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GATE, RELAY_GATE, PRE_RUN, NAMED, SPREAD, SHARD_NAMES, SHARD_WARN_MINUTES, DEFAULT_FILE_TIMEOUT_MS, partition, shardFiles, runArgv, repoRootFrom, unnamedFiles, spreadShard, main,
} from './helpers/ci-shards.mjs';
import { linuxPartition, testInventory } from './helpers/ci-linux-partitions.mjs';

const ROOT = repoRootFrom();
const TEST_DIR = path.join(ROOT, 'test');
const HELPER = fileURLToPath(new URL('./helpers/ci-shards.mjs', import.meta.url));

function cliEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('partition covers every test file exactly once and keeps PRE_RUN out of shards', () => {
  const files = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js')).sort();
  const parts = partition(files);
  const shards = Object.values(parts).flat();
  assert.deepEqual([...shards, ...PRE_RUN].sort(), files);
  const seen = new Set();
  for (const name of shards) {
    assert.equal(seen.has(name), false, name);
    seen.add(name);
  }
  for (const name of PRE_RUN) assert.equal(shards.includes(name), false, name);
});

test('every NAMED shard file exists', () => {
  for (const [shard, list] of Object.entries(NAMED)) {
    for (const name of list) {
      assert.equal(fs.existsSync(path.join(TEST_DIR, name)), true, `${shard}:${name}`);
    }
  }
});

test('list rest stdout matches partition().rest', () => {
  const listed = spawnSync(process.execPath, [HELPER, 'list', 'rest'], {
    cwd: ROOT, encoding: 'utf8', env: cliEnv(),
  });
  assert.equal(listed.status, 0, listed.stderr);
  const files = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js')).sort();
  assert.deepEqual(listed.stdout.split('\n').filter(Boolean), partition(files).rest);
});

test('run rejects an unknown shard and a non-root cwd', () => {
  const nope = spawnSync(process.execPath, [HELPER, 'run', 'nope'], {
    cwd: ROOT, encoding: 'utf8', env: cliEnv(),
  });
  assert.equal(nope.status, 2);
  const outside = spawnSync(process.execPath, [HELPER, 'run', 'rest'], {
    cwd: os.tmpdir(), encoding: 'utf8', env: cliEnv(),
  });
  assert.equal(outside.status, 2);
});

test('run argv includes concurrency 1 and the 45-minute file timeout', () => {
  const argv = runArgv('study-a', { testDir: TEST_DIR });
  assert.equal(argv.includes('--test-concurrency=1'), true);
  assert.equal(argv.includes(`--test-timeout=${DEFAULT_FILE_TIMEOUT_MS}`), true);
  assert.equal(DEFAULT_FILE_TIMEOUT_MS, 2_700_000);
});


test('#206 named partitions reserve headroom for Windows recovery', () => {
  assert.deepEqual(new Set(Object.keys(NAMED)), new Set(['study-a', 'study-b', 'learning-a', 'learning-b', 'loop', 'loop-b', 'recovery']));
  assert.deepEqual(NAMED.loop, ['game-loop.test.js']);
  assert.deepEqual(NAMED['loop-b'], ['game-loop-multiplayer.test.js', 'pace-loop.test.js', 'jev-loop.test.js', 'jev-session.test.js', 'game-loop-finalize.test.js']);
  assert.deepEqual(NAMED.recovery, ['app-recovery-exit.test.js', 'release-verifier.test.js', 'server-security-gates.test.js', 'relay-seat-scoping.test.js']);
  assert.deepEqual(NAMED['study-a'], ['study-service.test.js', 'app-command-store.test.js', 'policy-loop.test.js', 'participant-api.test.js']);
  assert.deepEqual(NAMED['study-b'], ['study-service-recovery.test.js', 'room-manager.test.js', 'session-summary.test.js', 'session-summary-api.test.js', 'final-summary.test.js', 'owned-release-delete-pending.test.js']);
  assert.deepEqual(NAMED['learning-a'], ['learning-integration.test.js', 'mistake-bank.test.js', 'publish.test.js', 'multi-human-engine.test.js']);
  assert.deepEqual(NAMED['learning-b'], ['learning-integration-session.test.js', 'action-receipts.test.js', 'drill-generator.test.js', 'drill-cli.test.js', 'coach-prospective-input.test.js', 'upper-background-resolve.test.js']);
});

test('#206 Windows workflow matrix includes every shard exactly once', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const block = workflow.match(/^\s+shard:\r?\n((?:[ \t]+- [a-z-]+\r?\n)+)/m);
  assert.ok(block, 'Windows matrix.shard block missing');
  const names = [...block[1].matchAll(/- ([a-z-]+)/g)].map((match) => match[1]);
  assert.deepEqual(new Set(names), new Set(SHARD_NAMES));
  assert.equal(names.length, SHARD_NAMES.length);
});


test('unnamed files are stably spread by weighted basename hash', () => {
  const files = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js')).sort();
  const spread = unnamedFiles(files);
  for (const name of spread) assert.ok(SPREAD[spreadShard(name)] > 0, name);
  for (const shard of SHARD_NAMES.filter((name) => !(name in SPREAD))) assert.deepEqual(partition(files)[shard], NAMED[shard]);
  for (const shard of Object.keys(SPREAD)) {
    const expected = [...(NAMED[shard] ?? []), ...spread.filter((name) => spreadShard(name) === shard)];
    assert.deepEqual(partition(files)[shard], expected);
    assert.ok(expected.length > (NAMED[shard] ?? []).length, shard);
  }
  for (const [shard, weight] of Object.entries(SPREAD)) {
    assert.ok(SHARD_NAMES.includes(shard));
    assert.ok(Number.isInteger(weight) && weight > 0);
  }
  const before = Object.fromEntries(spread.map((name) => [name, spreadShard(name)]));
  const after = partition([...files, 'brand-new.test.js', 'heavy-new.test.js']);
  for (const [name, shard] of Object.entries(before)) assert.ok(after[shard].includes(name), name);
  for (const name of ['brand-new.test.js', 'heavy-new.test.js']) assert.ok(Object.keys(SPREAD).some((shard) => after[shard].includes(name)));
});

test('spread hash assignments stay fixed', () => {
  assert.deepEqual(['archive.test.js', 'ui-token-usage.test.js', 'policy-v2.test.js', 'retained-session-resume.test.js'].map((name) => [name, spreadShard(name)]), [
    ['archive.test.js', 'rest'], ['ui-token-usage.test.js', 'study-b'], ['policy-v2.test.js', 'rest'], ['retained-session-resume.test.js', 'learning-a'],
  ]);
});

// Runs `ci-shards.mjs run rest` against a scripted child and a clock that reports `elapsed` minutes.
async function runWithClock({ elapsed, env = { GITHUB_ACTIONS: 'true' }, outcome = { code: 0 }, thenExit = false }) {
  const writes = [];
  const child = new EventEmitter();
  const spawnFn = () => {
    setImmediate(() => {
      if (outcome.error) child.emit('error', outcome.error);
      else child.emit('exit', outcome.code ?? null, outcome.signal ?? null);
      // A late exit after error, or a late error after exit, must not change the result.
      if (thenExit) child.emit(outcome.error ? 'exit' : 'error', ...(outcome.error ? [0, null] : [new Error('late error')]));
    });
    return child;
  };
  const times = [1000, 1000 + elapsed * 60_000];
  const sink = { write: (text) => writes.push(text) };
  const code = await main(['run', 'rest'], { cwd: ROOT, root: ROOT, spawnFn, env, now: () => times.shift(), stdout: sink, stderr: sink });
  return { code, output: writes.join('') };
}

test('run warns only over 35 minutes on Actions and preserves child outcomes', async () => {
  assert.equal(SHARD_WARN_MINUTES, 35);
  for (const exit of [0, 7]) {
    const over = await runWithClock({ elapsed: 36, outcome: { code: exit } });
    assert.equal(over.code, exit);
    assert.match(over.output, /^::warning title=Windows shard test time::rest ran its tests for 36\.0 min \(over 35\);.*\n$/);
    assert.equal(over.output.split('\n').filter(Boolean).length, 1);
  }
  for (const elapsed of [34, 35]) {
    const quiet = await runWithClock({ elapsed, outcome: { code: 3 } });
    assert.equal(quiet.code, 3);
    assert.equal(quiet.output, '');
  }
  for (const env of [{}, { GITHUB_ACTIONS: 'false' }]) assert.equal((await runWithClock({ elapsed: 36, env })).output, '');
  const signal = await runWithClock({ elapsed: 36, outcome: { signal: 'SIGTERM' } });
  assert.equal(signal.code, 1);
  assert.match(signal.output, /::warning title=Windows shard test time::/);
  const error = await runWithClock({ elapsed: 36, outcome: { error: new Error('spawn ENOENT') } });
  assert.equal(error.code, 1);
  assert.doesNotMatch(error.output, /::warning/);
  assert.match(error.output, /spawn ENOENT/);
  const errorThenExit = await runWithClock({ elapsed: 36, outcome: { error: new Error('spawn ENOENT') }, thenExit: true });
  assert.equal(errorThenExit.code, 1);
  assert.doesNotMatch(errorThenExit.output, /::warning/);
  const exitThenError = await runWithClock({ elapsed: 36, outcome: { code: 0 }, thenExit: true });
  assert.equal(exitThenError.code, 0);
  assert.doesNotMatch(exitThenError.output, /late error/);
  assert.equal(exitThenError.output.split('\n').filter(Boolean).length, 1);
});

// Workflow job body and its steps, split on `      - ` step starts.
function workflowJob(name) {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const body = workflow.split(new RegExp(`\\n  ${name}:\\r?\\n`))[1]?.split(/\n  [a-z-]+:\r?\n/)[0];
  assert.ok(body, `${name} job missing`);
  return { body, steps: body.split(/\n      - /).slice(1) };
}

test('workflow runs every PRE_RUN file once per Linux partition job and once in Windows rest', () => {
  const gateRun = `run: node --test --test-concurrency=1 test/${GATE}`;
  const relayRun = `run: node --test --test-concurrency=1 ${RELAY_GATE.map((name) => `test/${name}`).join(' ')}`;
  const linux = workflowJob('test');
  const windows = workflowJob('windows');
  for (const command of [gateRun, relayRun]) {
    const linuxSteps = linux.steps.filter((step) => step.split(/\r?\n/).some((line) => line.trim() === command));
    assert.equal(linuxSteps.length, 1, `Linux: ${command}`);
    assert.doesNotMatch(linuxSteps[0], /\bif:/, `Linux pre-step must run in every partition: ${command}`);
    const windowsSteps = windows.steps.filter((step) => step.split(/\r?\n/).some((line) => line.trim() === command));
    assert.equal(windowsSteps.length, 1, `Windows: ${command}`);
    assert.match(windowsSteps[0], /^\s+if: matrix\.shard == 'rest'\r?$/m, `Windows: ${command}`);
  }
  assert.equal(SHARD_NAMES.includes('rest'), true);
  // Nothing else in either job names a PRE_RUN file, so the pre-steps are the only runs.
  for (const name of PRE_RUN) {
    assert.equal(linux.body.split(`test/${name}`).length - 1, 1, `Linux mentions ${name}`);
    assert.equal(windows.body.split(`test/${name}`).length - 1, 1, `Windows mentions ${name}`);
  }
  // The pre-step files are exactly PRE_RUN, and none of them is listed again by a shard or partition.
  assert.deepEqual(PRE_RUN, [GATE, ...RELAY_GATE]);
  const files = fs.readdirSync(TEST_DIR).filter((file) => file.endsWith('.test.js'));
  for (const name of [GATE, ...RELAY_GATE]) {
    assert.equal(Object.values(partition(files)).flat().includes(name), false, `Windows shard lists ${name}`);
    for (const partitionName of ['services', 'rest']) {
      assert.equal(linuxPartition(testInventory(TEST_DIR), partitionName).includes(name), false, `Linux ${partitionName} lists ${name}`);
    }
  }
});

test('workflow installs without audit and pins UI npm cache contract', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const ciLines = workflow.match(/^\s+run: npm ci.*$/gm) ?? [];
  assert.ok(ciLines.length > 0);
  for (const line of ciLines) assert.match(line, /npm ci --no-audit --no-fund/);
  const ui = workflow.split(/\n  ui-browser:\r?\n/)[1]?.split(/\n  [a-z-]+:\r?\n/)[0];
  assert.ok(ui);
  assert.match(ui, /timeout-minutes: 30/);
  for (const [key, value] of Object.entries({ npm_config_audit: "'false'", npm_config_fund: "'false'", npm_config_prefer_offline: "'true'" })) {
    assert.match(ui, new RegExp(`^      ${key}: ${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.match(ui, /uses: actions\/cache@caa296126883cff596d87d8935842f9db880ef25/);
  assert.match(ui, /path: ~\/\.npm/);
  assert.match(ui, /key: ui-browser-npm-\$\{\{ runner\.os \}\}-agent-browser-0\.36\.0-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/);
  assert.ok(ui.indexOf('actions/setup-node@') < ui.indexOf('actions/cache@'));
  assert.ok(ui.indexOf('actions/cache@') < ui.indexOf('run: npm ci'));
  assert.match(ui, /npx --yes agent-browser@0\.36\.0 install --with-deps/);
  // The cache key must follow the installed agent-browser version.
  const keyVersion = ui.match(/key: ui-browser-npm-\$\{\{ runner\.os \}\}-agent-browser-([0-9.]+)-/)?.[1];
  const installVersions = [...ui.matchAll(/npx --yes agent-browser@([0-9.]+) install/g)].map((match) => match[1]);
  assert.ok(keyVersion);
  assert.deepEqual(installVersions, [keyVersion]);
  assert.doesNotMatch(ui, /path: .*\.agent-browser/);
});
