import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GATE, NAMED, SHARD_NAMES, DEFAULT_FILE_TIMEOUT_MS, partition, shardFiles, runArgv, repoRootFrom,
} from './helpers/ci-shards.mjs';

const ROOT = repoRootFrom();
const TEST_DIR = path.join(ROOT, 'test');
const HELPER = fileURLToPath(new URL('./helpers/ci-shards.mjs', import.meta.url));

function cliEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('partition covers every test file exactly once and keeps GATE out of shards', () => {
  const files = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js')).sort();
  const parts = partition(files);
  const shards = Object.values(parts).flat();
  assert.deepEqual([...shards, GATE].sort(), files);
  const seen = new Set();
  for (const name of shards) {
    assert.equal(seen.has(name), false, name);
    seen.add(name);
  }
  assert.equal(shards.includes(GATE), false);
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
  assert.deepEqual(new Set(Object.keys(NAMED)), new Set(['study-a', 'study-b', 'learning-a', 'learning-b', 'loop', 'recovery']));
  assert.deepEqual(NAMED.loop, ['game-loop.test.js']);
  assert.deepEqual(NAMED.recovery, ['app-recovery-exit.test.js', 'release-verifier.test.js', 'server-security-gates.test.js']);
  assert.deepEqual(NAMED['study-a'], ['study-service.test.js', 'app-command-store.test.js', 'policy-loop.test.js']);
  assert.deepEqual(NAMED['study-b'], ['study-service-recovery.test.js']);
  assert.deepEqual(NAMED['learning-a'], ['learning-integration.test.js', 'mistake-bank.test.js', 'publish.test.js', 'multi-human-engine.test.js']);
  assert.deepEqual(NAMED['learning-b'], ['learning-integration-session.test.js', 'action-receipts.test.js', 'drill-generator.test.js', 'drill-cli.test.js']);
});

test('#206 Windows workflow matrix includes every shard exactly once', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const block = workflow.match(/^\s+shard:\r?\n((?:[ \t]+- [a-z-]+\r?\n)+)/m);
  assert.ok(block, 'Windows matrix.shard block missing');
  const names = [...block[1].matchAll(/- ([a-z-]+)/g)].map((match) => match[1]);
  assert.deepEqual(new Set(names), new Set(SHARD_NAMES));
  assert.equal(names.length, SHARD_NAMES.length);
});
