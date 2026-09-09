import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GATE = 'platform-learning-runtime.test.js';
export const NAMED = {
  'study-a': ['study-service.test.js'],
  'study-b': ['study-service-recovery.test.js'],
  'learning-a': ['learning-integration.test.js', 'mistake-bank.test.js', 'publish.test.js'],
  'learning-b': ['learning-integration-session.test.js', 'action-receipts.test.js', 'drill-generator.test.js', 'drill-cli.test.js'],
  loop: ['game-loop.test.js', 'release-verifier.test.js', 'server-security-gates.test.js'],
};
export const DEFAULT_FILE_TIMEOUT_MS = 2_700_000;
export const SHARD_NAMES = [...Object.keys(NAMED), 'rest'];

export function repoRootFrom(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export function partition(files) {
  const named = new Set(Object.values(NAMED).flat());
  const rest = files.filter((name) => name.endsWith('.test.js') && name !== GATE && !named.has(name)).sort();
  return { ...Object.fromEntries(Object.entries(NAMED).map(([key, list]) => [key, [...list]])), rest };
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
    const child = spawnFn(argvRun[0], argvRun.slice(1), { stdio: 'inherit', cwd: root });
    return await new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1)));
  }
  fail('usage: ci-shards.mjs list|run <shard> [--test-timeout=<ms>]');
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !process.env.NODE_TEST_CONTEXT) process.exit(await main());
