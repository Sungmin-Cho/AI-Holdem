import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRE_RUN, NAMED, repoRootFrom } from './ci-shards.mjs';

// CI-only Linux split. Each Linux Node job runs one of two complete partitions
// so that neither exceeds the 40-minute job cap. The inventory is what plain
// `node --test` auto-discovery executed under test/: every .js/.mjs/.cjs module,
// recursively, not only top-level *.test.js. That keeps helper, browser and
// fixture module executions that the old `npm run test:ci` performed (the real
// browser journeys still run in their own job). PRE_RUN is excluded from both
// partitions because the workflow runs those tests before each partition.
export const LINUX_PARTITION_NAMES = ['services', 'rest'];
export const LINUX_FILE_TIMEOUT_MS = 900_000;
const MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// Relative POSIX paths of every module node --test would auto-discover under
// testDir. Symlinks are never followed and node_modules is skipped.
export function testInventory(testDir) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile() && MODULE_EXTENSIONS.has(path.extname(entry.name))) found.push(relative);
    }
  };
  walk(testDir, '');
  return found.sort();
}

export function linuxPartition(files, name) {
  if (!LINUX_PARTITION_NAMES.includes(name)) throw new Error(`unknown linux partition: ${name}`);
  const inventory = new Set(files);
  const services = Object.values(NAMED).flat();
  if (name === 'rest') {
    const named = new Set(services);
    return files.filter((file) => !PRE_RUN.includes(file) && !named.has(file)).sort();
  }
  const missing = services.filter((file) => !inventory.has(file));
  if (missing.length) throw new Error(`named test file missing: ${missing.join(', ')}`);
  return services;
}

export function linuxFiles(testDir, name) {
  const list = linuxPartition(testInventory(testDir), name);
  // An empty file list would make node --test fall back to its default glob.
  if (!list.length) throw new Error(`linux partition is empty: ${name}`);
  return list.map((file) => path.join(testDir, ...file.split('/')));
}

export function linuxRunArgv(name, {
  testDir,
  timeoutMs = LINUX_FILE_TIMEOUT_MS,
  execPath = process.execPath,
} = {}) {
  const files = linuxFiles(testDir, name);
  return [execPath, '--test', '--test-concurrency=1', `--test-timeout=${timeoutMs}`, ...files];
}

export async function main(argv = process.argv.slice(2), {
  cwd = process.cwd(),
  root = repoRootFrom(),
  spawnFn = spawn,
  stderr = process.stderr,
} = {}) {
  const fail = (message) => {
    stderr.write(`${message}\n`);
    return 2;
  };
  if (path.resolve(cwd) !== path.resolve(root)) return fail(`must run from repo root (${root})`);
  const [command, name, ...rest] = argv;
  if (command !== 'run' || !LINUX_PARTITION_NAMES.includes(name) || rest.length) {
    return fail(`usage: ci-linux-partitions.mjs run <${LINUX_PARTITION_NAMES.join('|')}>`);
  }
  let argvRun;
  try {
    argvRun = linuxRunArgv(name, { testDir: path.join(root, 'test') });
  } catch (error) {
    return fail(error.message);
  }
  const child = spawnFn(argvRun[0], argvRun.slice(1), { stdio: 'inherit', cwd: root });
  return await new Promise((resolve) => {
    child.on('error', (error) => {
      stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !process.env.NODE_TEST_CONTEXT) process.exit(await main());
