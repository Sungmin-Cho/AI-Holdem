// The study service child gets an environment allowlist, so it inherits none of
// the variables PowerShell leans on — including the pre-warmed module analysis
// cache its parent holds. Measuring the settings, rather than guessing at them,
// showed the cost is analysing the system module directory: over 15s without an
// inherited cache, unaffected by disabling the cache, and not fixed by building
// one (25s cold, and the rebuild came back). An empty module path answers in
// 0.9s. Scripts that need no module now get none, so the allowlist is enough.
// Gate on that, and report the measurements whenever it stops being true.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const REPO = path.resolve(HERE, '..', '..', '..');
const PROOF = pathToFileURL(path.join(REPO, 'shared', 'platform-files.js')).href;
const STATE = pathToFileURL(path.join(REPO, 'engine', 'state.js')).href;
// A working proof answers in well under a second, so a variant still running at
// this point is the stall itself. Keeping the cutoff tight bounds the whole scan.
const BUDGET_MS = 6000;

// The allowlist the study client hands its detached child today.
const CLIENT = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_TIME', 'TZ'];
const pick = (keys) => Object.fromEntries(keys
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));

// Privacy is not the only proof a child must make: the owned lock is worthless
// unless the child can also read its own process identity, and both run
// PowerShell under the same environment.
const SCRIPT = `const started = Date.now();
Promise.all([import(process.argv[1]), import(process.argv[3])]).then(([files, state]) => {
  let reason = null;
  const ok = files.isPrivatePath(process.argv[2], { privateMode: true, onUnproven: (r) => { reason = r; } });
  const identity = state.ownedProcessStartTime(process.pid);
  console.log(JSON.stringify({ ok: ok && identity !== null, privacy: ok, identity, reason, elapsedMs: Date.now() - started }));
}).catch((error) => {
  console.log(JSON.stringify({ error: String(error && (error.code || error.message)), elapsedMs: Date.now() - started }));
  process.exitCode = 1;
});`;

function proves(env, target, { report } = {}) {
  const started = Date.now();
  const child = cp.spawnSync(process.execPath, ['-e', SCRIPT, PROOF, target, STATE], {
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
const ACL_SCRIPT = "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:TEMP).Owner.ToString()";

// Time PowerShell itself under one cache setting, on the allowlist the child
// gets. The script uses only built-in cmdlets, exactly like the ACL proof.
function timePowerShell(label, cachePath, budgetMs, modulePath = SYSTEM_MODULES, script = ACL_SCRIPT) {
  const env = pick(CLIENT);
  env.PSModulePath = modulePath;
  if (cachePath !== undefined) env.PSModuleAnalysisCachePath = cachePath;
  const started = Date.now();
  const result = cp.spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script],
    { env, encoding: 'utf8', timeout: budgetMs, windowsHide: true });
  console.log(JSON.stringify({ cacheVariant: label, cachePath: cachePath ?? null,
    modulePath: modulePath === '' ? '(empty)' : 'system', status: result.status,
    spawnError: result.error?.code ?? null, wallMs: Date.now() - started,
    stdout: String(result.stdout ?? '').trim().slice(0, 120),
    stderr: String(result.stderr ?? '').trim().slice(0, 200) }));
  return result.status === 0;
}

// Which setting lets a child that inherits nothing start PowerShell promptly?
// win32ProcessStartTime rejects a probe that writes anything to stderr, so the
// raw streams decide whether a setting is usable, not just the exit status.
const IDENTITY_SCRIPT = '$ErrorActionPreference = "Stop"; '
  + 'try { $p = [System.Diagnostics.Process]::GetProcessById($PID) } catch { exit 1 }; '
  + "if ($null -eq $p -or $p.HasExited) { exit 1 }; $p.StartTime.ToUniversalTime().ToString('o')";

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
    // What production actually hands these calls: no module path, no cache. Print
    // the raw streams, because any stderr at all voids the identity probe.
    timePowerShell('identity probe as production runs it', 'NUL', 20_000, '', IDENTITY_SCRIPT);
    // Twice: a proof that only works once is a cache being warmed, not a fix.
    if (proves(pick(CLIENT), target, { report: 'client-allowlist first' })
      && proves(pick(CLIENT), target, { report: 'client-allowlist again' })) {
      console.log(JSON.stringify({ childEnvironmentSufficient: true }));
      return;
    }
    // The allowlist stopped being enough. Say what the environment now costs
    // rather than leaving the next reader to rediscover it.
    proves(pick(Object.keys(process.env)), target, { report: 'full-env control' });
    measureCacheSettings(root);
    throw new Error('CHILD_ENVIRONMENT_INSUFFICIENT: the allowlist can no longer prove a private path');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === HERE;
if (direct && !process.env.NODE_TEST_CONTEXT) await main();
