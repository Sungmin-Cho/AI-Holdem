// The study service child proves the same paths its parent just proved, with the
// same PowerShell, and times out where the parent takes under a second. Only two
// things differ: the child's environment is an allowlist, and it is detached.
// Cross those two axes so one run says which of them stalls PowerShell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const REPO = path.resolve(HERE, '..', '..', '..');
const PROOF = pathToFileURL(path.join(REPO, 'shared', 'platform-files.js')).href;
const BUDGET_MS = 45_000;

// The allowlist the study client hands its detached child today.
const CLIENT = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_TIME', 'TZ'];
// The variables a Windows process is normally entitled to assume exist. None of
// them carry game or provider secrets, so an allowlist may hold all of them.
const WINDOWS = [...CLIENT, 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ALLUSERSPROFILE', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'PUBLIC', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
  'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS'];

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

function run(label, env, detached, target) {
  const started = Date.now();
  const child = cp.spawnSync(process.execPath, ['-e', SCRIPT, PROOF, target], {
    env, detached, cwd: path.join(REPO, 'tools'),
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: BUDGET_MS, windowsHide: true,
  });
  console.log(JSON.stringify({ variant: label, detached, envKeys: Object.keys(env).length,
    status: child.status, spawnError: child.error?.code ?? null, wallMs: Date.now() - started,
    stdout: String(child.stdout ?? '').trim().slice(0, 400),
    stderr: String(child.stderr ?? '').trim().slice(0, 400) }));
  return child.status === 0 && String(child.stdout ?? '').includes('"ok":true');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows child environment probe requires Windows');
  const { createPrivateDirectory } = await import('../../shared/platform-files.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-child-env-'));
  const target = path.join(root, 'private');
  createPrivateDirectory(target);
  try {
    const results = {
      fullAttached: run('full-env attached', { ...process.env }, false, target),
      fullDetached: run('full-env detached', { ...process.env }, true, target),
      clientAttached: run('client-allowlist attached', pick(CLIENT), false, target),
      clientDetached: run('client-allowlist detached', pick(CLIENT), true, target),
      windowsDetached: run('windows-allowlist detached', pick(WINDOWS), true, target),
    };
    console.log(JSON.stringify(results));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === HERE;
if (direct && !process.env.NODE_TEST_CONTEXT) await main();
