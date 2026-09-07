// The study service child proves the same paths its parent just proved, with the
// same PowerShell, and times out where the parent takes under a second. Crossing
// the two candidate axes settled the first question: a detached child on the full
// environment proves in 415ms, so console isolation is innocent and the
// environment is the whole cause. Neither the client's allowlist nor that list
// widened with the standard Windows variables can prove anything, so guessing at
// names is what keeps failing. Shrink the working environment instead: drop one
// variable at a time and keep every drop that still proves, until what remains is
// exactly what PowerShell cannot start without.
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

// Drop one variable at a time, keeping every drop the proof survives. What is
// left cannot be reduced further: removing any one of its members breaks it.
function shrink(keys, target) {
  let required = [...keys];
  for (const key of keys) {
    const candidate = required.filter((name) => name !== key);
    if (proves(pick(candidate), target)) required = candidate;
  }
  return required;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows child environment probe requires Windows');
  const { createPrivateDirectory } = await import('../../shared/platform-files.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-child-env-'));
  const target = path.join(root, 'private');
  createPrivateDirectory(target);
  try {
    const full = Object.keys(process.env).filter((key) => process.env[key] !== undefined);
    if (!proves(pick(full), target, { report: 'full-env control' })) {
      console.log(JSON.stringify({ childEnvironmentMinimized: false, reason: 'the full environment cannot prove either' }));
      return;
    }
    proves(pick(CLIENT), target, { report: 'client-allowlist control' });
    proves(pick(WINDOWS), target, { report: 'windows-allowlist control' });
    const required = shrink(full, target);
    console.log(JSON.stringify({ childEnvironmentMinimized: true, requiredKeys: required.sort(),
      missingFromClientAllowlist: required.filter((key) => !CLIENT.includes(key)).sort(),
      missingFromWindowsAllowlist: required.filter((key) => !WINDOWS.includes(key)).sort() }));
    proves(pick([...CLIENT, ...required]), target, { report: 'client-allowlist plus required' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === HERE;
if (direct && !process.env.NODE_TEST_CONTEXT) await main();
