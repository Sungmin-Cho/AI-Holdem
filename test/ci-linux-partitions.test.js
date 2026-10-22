import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GATE, PRE_RUN, NAMED, unnamedFiles, repoRootFrom } from './helpers/ci-shards.mjs';
import {
  LINUX_FILE_TIMEOUT_MS, LINUX_PARTITION_NAMES, linuxFiles, linuxPartition, linuxRunArgv, main, testInventory,
} from './helpers/ci-linux-partitions.mjs';

const ROOT = repoRootFrom();
const TEST_DIR = path.join(ROOT, 'test');
const HELPER = fileURLToPath(new URL('./helpers/ci-linux-partitions.mjs', import.meta.url));
const NAMED_FILES = Object.values(NAMED).flat();

// Independent of the helper: every .js/.mjs/.cjs under test/, recursively, as
// node --test auto-discovery sees it (no symlinks, no node_modules).
function realInventory() {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) found.push(relative);
    }
  };
  walk(TEST_DIR, '');
  return found.sort();
}

function tempDirWith(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-partitions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '');
  }
  return dir;
}

function cliEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Records spawn calls and emits one scripted child outcome per call.
function fakeSpawn(outcome = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    setImmediate(() => {
      if (outcome.error) child.emit('error', outcome.error);
      else child.emit('exit', outcome.code ?? null, outcome.signal ?? null);
    });
    return child;
  };
  return { calls, spawnFn };
}

function quietStderr() {
  const chunks = [];
  return { chunks, write: (text) => chunks.push(text) };
}

function linuxJob() {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const body = workflow.split('\n  test:\n')[1]?.split(/\n  [a-z-]+:\n/)[0];
  assert.ok(body, 'Linux test job missing');
  return body;
}

test('linux partitions cover the full recursive inventory exactly once with PRE_RUN outside them', () => {
  const files = realInventory();
  const services = linuxPartition(files, 'services');
  const rest = linuxPartition(files, 'rest');
  assert.equal(new Set([...services, ...rest]).size, services.length + rest.length, 'duplicate across partitions');
  assert.deepEqual([...services, ...rest, ...PRE_RUN].sort(), files);
  assert.equal(PRE_RUN.some((name) => services.includes(name) || rest.includes(name)), false);
  assert.deepEqual(testInventory(TEST_DIR), files);
});

test('the inventory keeps helper, browser and fixture modules that auto-discovery executed', () => {
  const files = realInventory();
  const rest = linuxPartition(files, 'rest');
  const nonTop = files.filter((name) => name.includes('/'));
  assert.ok(nonTop.length > 0, 'expected nested modules under test/');
  assert.ok(nonTop.some((name) => name.startsWith('browser/')), 'browser modules present');
  assert.ok(nonTop.some((name) => name.startsWith('helpers/')), 'helper modules present');
  for (const name of nonTop) assert.ok(rest.includes(name), name);
  const topNonTests = files.filter((name) => !name.includes('/') && !name.endsWith('.test.js'));
  for (const name of topNonTests) assert.ok(rest.includes(name), name);
});

test('services is every NAMED group in order and rest is everything else except PRE_RUN', () => {
  const files = realInventory();
  assert.deepEqual(linuxPartition(files, 'services'), NAMED_FILES);
  const expectedRest = files.filter((name) => !PRE_RUN.includes(name) && !NAMED_FILES.includes(name));
  assert.deepEqual(linuxPartition(files, 'rest'), expectedRest);
  // The files Windows spreads over its shards are exactly Linux rest's top-level *.test.js.
  assert.deepEqual(unnamedFiles(files.filter((name) => !name.includes('/'))),
    linuxPartition(files, 'rest').filter((name) => !name.includes('/') && name.endsWith('.test.js')));
  for (const name of NAMED_FILES) assert.equal(linuxPartition(files, 'rest').includes(name), false, name);
});

test('future, unknown and nested modules are assigned to rest', () => {
  const files = [
    ...realInventory(), 'future-area.test.js', 'zz-unknown-new.test.js', 'newdir/deep/thing.test.js',
    'helpers/new-helper.mjs', 'fixtures/new-fixture.cjs', 'helpers/study-service.test.js',
  ].sort();
  const services = linuxPartition(files, 'services');
  const rest = linuxPartition(files, 'rest');
  for (const name of ['future-area.test.js', 'zz-unknown-new.test.js', 'newdir/deep/thing.test.js',
    'helpers/new-helper.mjs', 'fixtures/new-fixture.cjs', 'helpers/study-service.test.js']) {
    assert.ok(rest.includes(name), name);
    assert.equal(services.includes(name), false, name);
  }
  assert.deepEqual(services, NAMED_FILES);
  assert.deepEqual([...services, ...rest, ...PRE_RUN].sort(), files);
});

test('testInventory walks recursively, skips symlinks and node_modules, and keeps only js/mjs/cjs', (t) => {
  const dir = tempDirWith(t, [
    'a.test.js', 'helper.mjs', 'legacy.cjs', 'notes.md', 'data.json',
    'nested/b.test.js', 'nested/deeper/c.mjs', 'node_modules/pkg/index.js',
  ]);
  const outside = tempDirWith(t, ['linked.js']);
  try {
    fs.symlinkSync(outside, path.join(dir, 'linkdir'), 'dir');
    fs.symlinkSync(path.join(outside, 'linked.js'), path.join(dir, 'link.js'));
  } catch {
    // Symlinks unavailable on this platform; the remaining assertions still apply.
  }
  assert.deepEqual(testInventory(dir), [
    'a.test.js', 'helper.mjs', 'legacy.cjs', 'nested/b.test.js', 'nested/deeper/c.mjs',
  ]);
});

test('partition rejects unknown names and a named file missing from the inventory', () => {
  const files = realInventory();
  assert.throws(() => linuxPartition(files, 'shard'), /unknown linux partition/);
  assert.throws(() => linuxPartition(files, undefined), /unknown linux partition/);
  const withoutNamed = files.filter((name) => name !== NAMED.loop[0]);
  assert.throws(() => linuxPartition(withoutNamed, 'services'), /named test file missing/);
});

test('an empty partition throws instead of letting node --test run its default glob', (t) => {
  const testDir = tempDirWith(t, [...NAMED_FILES, GATE]);
  assert.throws(() => linuxFiles(testDir, 'rest'), /linux partition is empty: rest/);
  assert.throws(() => linuxRunArgv('rest', { testDir }), /linux partition is empty: rest/);
});

test('rest argv lists nested modules as absolute paths without the gate', () => {
  const argv = linuxRunArgv('rest', { testDir: TEST_DIR, execPath: '/usr/bin/node' });
  const files = argv.slice(4);
  assert.deepEqual(files, linuxPartition(realInventory(), 'rest').map((name) => path.join(TEST_DIR, ...name.split('/'))));
  assert.ok(files.every((file) => fs.statSync(file).isFile()));
  assert.ok(files.some((file) => file.includes(`${path.sep}browser${path.sep}`)));
  assert.equal(files.some((file) => file.endsWith(GATE)), false);
});

test('linux run argv gives an explicit file list with concurrency 1 and the 15-minute file timeout', () => {
  const argv = linuxRunArgv('services', { testDir: TEST_DIR, execPath: '/usr/bin/node' });
  assert.equal(argv[0], '/usr/bin/node');
  assert.deepEqual(argv.slice(1, 4), ['--test', '--test-concurrency=1', `--test-timeout=${LINUX_FILE_TIMEOUT_MS}`]);
  assert.deepEqual(argv.slice(4), NAMED_FILES.map((name) => path.join(TEST_DIR, name)));
  assert.equal(argv.some((arg) => arg.endsWith(GATE)), false);
  assert.equal(LINUX_FILE_TIMEOUT_MS, 900_000);
});

test('linux per-file timeout matches the existing test:ci budget', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:ci'].includes(`--test-timeout=${LINUX_FILE_TIMEOUT_MS}`));
});

test('linux partition names are exactly services and rest', () => {
  assert.deepEqual(LINUX_PARTITION_NAMES, ['services', 'rest']);
});

test('main spawns the partition once with inherited stdio, the repo cwd, and no shell', async () => {
  const { calls, spawnFn } = fakeSpawn({ code: 0 });
  const code = await main(['run', 'services'], { cwd: ROOT, root: ROOT, spawnFn, stderr: quietStderr() });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, linuxRunArgv('services', { testDir: TEST_DIR }).slice(1));
  assert.deepEqual(call.options, { stdio: 'inherit', cwd: ROOT });
  assert.equal('shell' in call.options, false);
});

test('main propagates a nonzero exit code, a signal as failure, and a spawn error as failure', async () => {
  const nonzero = await main(['run', 'rest'], {
    cwd: ROOT, root: ROOT, spawnFn: fakeSpawn({ code: 7 }).spawnFn, stderr: quietStderr(),
  });
  assert.equal(nonzero, 7);
  const signalled = await main(['run', 'rest'], {
    cwd: ROOT, root: ROOT, spawnFn: fakeSpawn({ code: null, signal: 'SIGKILL' }).spawnFn, stderr: quietStderr(),
  });
  assert.equal(signalled, 1);
  const stderr = quietStderr();
  const errored = await main(['run', 'rest'], {
    cwd: ROOT, root: ROOT, spawnFn: fakeSpawn({ error: new Error('spawn ENOENT') }).spawnFn, stderr,
  });
  assert.equal(errored, 1);
  assert.match(stderr.chunks.join(''), /spawn ENOENT/);
});

test('main rejects bad commands, names, and extra args before spawning', async () => {
  const bad = [
    [],
    ['list', 'rest'],
    ['run'],
    ['run', 'shard'],
    ['run', 'services', '--test-timeout=1'],
    ['run', 'rest', 'extra.test.js'],
  ];
  for (const argv of bad) {
    const { calls, spawnFn } = fakeSpawn({ code: 0 });
    const stderr = quietStderr();
    const code = await main(argv, { cwd: ROOT, root: ROOT, spawnFn, stderr });
    assert.equal(code, 2, JSON.stringify(argv));
    assert.equal(calls.length, 0, JSON.stringify(argv));
    assert.match(stderr.chunks.join(''), /usage: ci-linux-partitions/);
  }
});

test('main refuses to run from a cwd other than the repo root', async () => {
  const { calls, spawnFn } = fakeSpawn({ code: 0 });
  const stderr = quietStderr();
  const code = await main(['run', 'rest'], { cwd: os.tmpdir(), root: ROOT, spawnFn, stderr });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(stderr.chunks.join(''), /must run from repo root/);
});

test('importing the helper runs nothing', () => {
  const url = pathToFileURL(HELPER).href;
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
    cwd: ROOT, encoding: 'utf8', env: cliEnv(),
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
});

test('the CLI rejects bad input and a foreign cwd without running any test', () => {
  const badName = spawnSync(process.execPath, [HELPER, 'run', 'shard'], { cwd: ROOT, encoding: 'utf8', env: cliEnv() });
  assert.equal(badName.status, 2);
  const outside = spawnSync(process.execPath, [HELPER, 'run', 'rest'], { cwd: os.tmpdir(), encoding: 'utf8', env: cliEnv() });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /must run from repo root/);
});

test('linux workflow job has two partitions, unchanged Node versions, and the 40 minute cap', () => {
  const job = linuxJob();
  assert.match(job, /^    timeout-minutes: 40$/m);
  const partitions = [...job.match(/^\s+partition:\r?\n((?:[ \t]+- [a-z-]+\r?\n)+)/m)[1].matchAll(/- ([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual(partitions, LINUX_PARTITION_NAMES);
  assert.doesNotMatch(job, /^\s+shard:/m);
  const nodes = [...job.match(/^\s+node-version:\r?\n((?:[ \t]+- [0-9.x]+\r?\n)+)/m)[1].matchAll(/- ([0-9.x]+)/g)].map((m) => m[1]);
  assert.deepEqual(nodes, ['20.x', '22.x']);
});

test('linux workflow runs the platform gate before the partition run', () => {
  const job = linuxJob();
  const gate = job.indexOf(`run: node --test --test-concurrency=1 test/${GATE}`);
  const run = job.indexOf('run: node test/helpers/ci-linux-partitions.mjs run ${{ matrix.partition }}');
  assert.ok(gate > 0 && run > gate, 'gate must precede partition run');
  assert.equal(job.match(/ci-linux-partitions\.mjs run/g).length, 1);
});

test('Linux aggregate preserves both required check names and fails unless every partition succeeds', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const body = workflow.split('\n  linux-suite:\n')[1]?.split(/\n  [a-z-]+:\n/)[0];
  assert.ok(body, 'Linux required-check aggregate missing');
  assert.match(body, /^    name: Node \$\{\{ matrix.node-version \}\} \(ubuntu-latest\)$/m);
  assert.match(body, /^    needs: test$/m);
  assert.match(body, /^    if: always\(\)$/m);
  assert.match(body, /^          - 20\.x$/m);
  assert.match(body, /^          - 22\.x$/m);
  assert.match(body, /PARTITION_RESULT: \$\{\{ needs.test.result \}\}/);
  assert.match(body, /run: test "\$PARTITION_RESULT" = "success"/);
  // The aggregate itself runs on Ubuntu; Windows still checks its workflow
  // contract above without requiring a POSIX shell in the Windows test shard.
  if (process.platform === 'win32') return;
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const check = spawnSync('sh', ['-c', 'test "$PARTITION_RESULT" = "success"'], {
      env: { ...process.env, PARTITION_RESULT: result },
    });
    assert.equal(check.status === 0, result === 'success', `aggregate accepted ${result}`);
  }
});
