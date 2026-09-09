import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GATE, NAMED, DEFAULT_FILE_TIMEOUT_MS, partition, shardFiles, runArgv, repoRootFrom,
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
