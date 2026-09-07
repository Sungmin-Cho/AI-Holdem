// The study service child gets an environment allowlist, so it inherits none of
// the variables PowerShell leans on. Shrinking the working environment named the
// one that matters: PSModuleAnalysisCachePath. Where a pre-warmed cache is
// inherited PowerShell proves in 415ms; with no cache location it re-analyses
// every module and overruns the proof cap. Pinning a fresh cache file is not the
// answer either — building one overran the cap in the parent too. So measure the
// settings themselves before choosing between them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const REPO = path.resolve(HERE, '..', '..', '..');
const PROOF = pathToFileURL(path.join(REPO, 'shared', 'platform-files.js')).href;
// A working proof answers in well under a second, so a variant still running at
// this point is the stall itself. Keeping the cutoff tight bounds the whole scan.
const BUDGET_MS = 6000;

// The allowlist the study client hands its detached child today.
const CLIENT = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_TIME', 'TZ'];
const pick = (keys) => Object.fromEntries(keys
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));

const SCRIPT = `const started = Date.now();
import(process.argv[1]).then((mod) => {
  let reason = null;
  const ok = mod.isPrivatePath(process.argv[2], { privateMode: true, onUnproven: (r) => { reason = r; } });
  console.log(JSON.stringify({ ok, reason, elapsedMs: Date.now() - started }));
}).catch((error) => {
  console.log(JSON.stringify({ error: String(error && (error.code || error.message)), elapsedMs: Date.now() - started }));
  process.exitCode = 1;
});`;

function proves(env, target, { report } = {}) {
  const started = Date.now();
  const child = cp.spawnSync(process.execPath, ['-e', SCRIPT, PROOF, target], {
    env, cwd: path.join(REPO, 'tools'),
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: BUDGET_MS, windowsHide: true,
  });
  const stdout = String(child.stdout ?? '').trim();
  const ok = child.status === 0 && stdout.includes('"ok":true');
  if (report) {
    console.log(JSON.stringify({ variant: report, envKeys: Object.keys(env).length, ok,
      status: child.status, spawnError: child.error?.code ?? null, wallMs: Date.now() - started,
      stdout: stdout.slice(0, 300), stderr: String(child.stderr ?? '').trim().slice(0, 300) }));
  }
  return ok;
}

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.win32.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SYSTEM_MODULES = path.win32.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');

// Time PowerShell itself under one cache setting, on the allowlist the child
// gets. The script uses only built-in cmdlets, exactly like the ACL proof.
function timePowerShell(label, cachePath, budgetMs, modulePath = SYSTEM_MODULES) {
  const env = pick(CLIENT);
  env.PSModulePath = modulePath;
  if (cachePath !== undefined) env.PSModuleAnalysisCachePath = cachePath;
  const started = Date.now();
  const result = cp.spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:TEMP).Owner.ToString()"],
  { env, encoding: 'utf8', timeout: budgetMs, windowsHide: true });
  console.log(JSON.stringify({ cacheVariant: label, cachePath: cachePath ?? null,
    modulePath: modulePath === '' ? '(empty)' : 'system', status: result.status,
    spawnError: result.error?.code ?? null, wallMs: Date.now() - started,
    stdout: String(result.stdout ?? '').trim().slice(0, 120),
    stderr: String(result.stderr ?? '').trim().slice(0, 200) }));
  return result.status === 0;
}

// Which setting lets a child that inherits nothing start PowerShell promptly?
function measureCacheSettings(scratch) {
  const fresh = path.join(scratch, 'analysis.cache');
  timePowerShell('inherited runner cache', process.env.PSModuleAnalysisCachePath, 20_000);
  timePowerShell('no cache location', undefined, 20_000);
  timePowerShell('cache disabled by invalid path', 'NUL', 20_000);
  timePowerShell('empty module path, no cache', undefined, 20_000, '');
  timePowerShell('empty module path, cache disabled', 'NUL', 20_000, '');
  timePowerShell('fresh cache file, cold', fresh, 180_000);
  timePowerShell('fresh cache file, warm', fresh, 20_000);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows child environment probe requires Windows');
  const { createPrivateDirectory } = await import('../../shared/platform-files.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-child-env-'));
  const target = path.join(root, 'private');
  createPrivateDirectory(target);
  try {
    measureCacheSettings(root);
    const full = Object.keys(process.env).filter((key) => process.env[key] !== undefined);
    if (!proves(pick(full), target, { report: 'full-env control' })) {
      console.log(JSON.stringify({ childEnvironmentMinimized: false, reason: 'the full environment cannot prove either' }));
      return;
    }
    proves(pick(CLIENT), target, { report: 'client-allowlist control' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === HERE;
if (direct && !process.env.NODE_TEST_CONTEXT) await main();
