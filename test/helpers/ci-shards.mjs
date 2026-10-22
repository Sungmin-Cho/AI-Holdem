import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GATE = 'platform-learning-runtime.test.js';
// The workflow runs these in their own steps before the shard or partition run
// (Windows rest, every Linux partition), so no shard or partition lists them.
export const RELAY_GATE = ['relay-access.test.js', 'relay-proxy.test.js', 'relay-proxy-live.test.js'];
export const PRE_RUN = [GATE, ...RELAY_GATE];
// A test file no NAMED list claims goes to one of these shards, chosen by the
// SHA-256 of its basename: weight is the share of the hash range, in key order.
// A file's shard depends only on its name, so a new file never moves another.
// The weights follow each shard's free minutes under a 20-minute Windows job
// (#317: about 15, 10, 8 and 18), rounded so rest, which also runs the pre-steps
// and has grown fastest, gets no more than learning-a. Pin a heavy new file in NAMED.
export const SPREAD = { 'learning-a': 3, 'study-b': 2, 'learning-b': 2, rest: 3 };
export const NAMED = {
  'study-a': ['study-service.test.js', 'app-command-store.test.js', 'policy-loop.test.js', 'participant-api.test.js'],
  'study-b': ['study-service-recovery.test.js', 'room-manager.test.js', 'session-summary.test.js', 'session-summary-api.test.js', 'final-summary.test.js', 'owned-release-delete-pending.test.js'],
  'learning-a': ['learning-integration.test.js', 'mistake-bank.test.js', 'publish.test.js', 'multi-human-engine.test.js'],
  // upper-background-resolve: 6.4 min on Windows, the heaviest unnamed file at #317 (it put learning-a at 29.7).
  'learning-b': ['learning-integration-session.test.js', 'action-receipts.test.js', 'drill-generator.test.js', 'drill-cli.test.js', 'coach-prospective-input.test.js', 'upper-background-resolve.test.js'],
  loop: ['game-loop.test.js'],
  'loop-b': ['game-loop-multiplayer.test.js', 'pace-loop.test.js', 'jev-loop.test.js', 'jev-session.test.js', 'game-loop-finalize.test.js'],
  recovery: ['app-recovery-exit.test.js', 'release-verifier.test.js', 'server-security-gates.test.js', 'relay-seat-scoping.test.js'],
};
export const DEFAULT_FILE_TIMEOUT_MS = 2_700_000;
export const SHARD_WARN_MINUTES = 35;
export const SHARD_NAMES = [...Object.keys(NAMED), 'rest'];

export function spreadShard(name) {
  const total = Object.values(SPREAD).reduce((sum, weight) => sum + weight, 0);
  // uint32 * total stays below 2 ** 53 and the divisor is a power of two, so the slot is exact.
  let slot = Math.floor(crypto.createHash('sha256').update(name).digest().readUInt32BE(0) * total / 2 ** 32);
  for (const [shard, weight] of Object.entries(SPREAD)) {
    if (slot < weight) return shard;
    slot -= weight;
  }
  throw new Error('unreachable spread slot');
}

export function unnamedFiles(files) {
  const excluded = new Set([...PRE_RUN, ...Object.values(NAMED).flat()]);
  return files.filter((name) => name.endsWith('.test.js') && !excluded.has(name)).sort();
}

export function repoRootFrom(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export function partition(files) {
  const parts = Object.fromEntries(SHARD_NAMES.map((key) => [key, [...(NAMED[key] ?? [])]]));
  for (const name of unnamedFiles(files)) parts[spreadShard(name)].push(name);
  return parts;
}

export function shardFiles(name, testDir) {
  if (!SHARD_NAMES.includes(name)) {
    const error = new Error(`unknown shard: ${name}`);
    error.exitCode = 2;
    throw error;
  }
  const files = fs.readdirSync(testDir).filter((file) => file.endsWith('.test.js')).sort();
  return partition(files)[name].map((file) => path.join(testDir, file));
}

export function runArgv(name, {
  timeoutMs = DEFAULT_FILE_TIMEOUT_MS,
  execPath = process.execPath,
  testDir,
} = {}) {
  const files = shardFiles(name, testDir);
  return [execPath, '--test', '--test-concurrency=1', `--test-timeout=${timeoutMs}`, ...files];
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

export async function main(argv = process.argv.slice(2), {
  cwd = process.cwd(),
  root = repoRootFrom(),
  spawnFn = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  now = Date.now,
} = {}) {
  if (path.resolve(cwd) !== path.resolve(root)) fail(`must run from repo root (${root})`);
  const [command, name, ...rest] = argv;
  const timeoutFlag = rest.find((arg) => arg.startsWith('--test-timeout='));
  const timeoutMs = timeoutFlag ? Number(timeoutFlag.slice('--test-timeout='.length)) : DEFAULT_FILE_TIMEOUT_MS;
  if ((timeoutFlag && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))) fail('invalid --test-timeout');
  if (command === 'list') {
    if (!SHARD_NAMES.includes(name) || rest.length) fail('usage: ci-shards.mjs list <shard>');
    const files = shardFiles(name, path.join(root, 'test'));
    stdout.write(files.map((file) => path.basename(file)).join('\n') + (files.length ? '\n' : ''));
    return 0;
  }
  if (command === 'run') {
    if (!SHARD_NAMES.includes(name)) fail(`unknown shard: ${name}`);
    const extra = rest.filter((arg) => !arg.startsWith('--test-timeout='));
    if (extra.length) fail('usage: ci-shards.mjs run <shard> [--test-timeout=<ms>]');
    const argvRun = runArgv(name, { timeoutMs, testDir: path.join(root, 'test') });
    const started = now();
    const child = spawnFn(argvRun[0], argvRun.slice(1), { stdio: 'inherit', cwd: root });
    return await new Promise((resolve) => {
      // Only the first of error and exit decides the outcome; a late one is ignored.
      let settled = false;
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        stderr.write(`${error.message}\n`);
        resolve(1);
      });
      child.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        const minutes = (now() - started) / 60_000;
        // Test-process time only; setup and the rest pre-steps took up to about 3.6 more minutes (#317).
        if (env.GITHUB_ACTIONS === 'true' && minutes > SHARD_WARN_MINUTES) {
          stdout.write(`::warning title=Windows shard test time::${name} ran its tests for ${minutes.toFixed(1)} min (over ${SHARD_WARN_MINUTES}); re-measure and rebalance as the .github/workflows/test.yml header describes\n`);
        }
        resolve(signal ? 1 : code ?? 1);
      });
    });
  }
  fail('usage: ci-shards.mjs list|run <shard> [--test-timeout=<ms>]');
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !process.env.NODE_TEST_CONTEXT) process.exit(await main());
