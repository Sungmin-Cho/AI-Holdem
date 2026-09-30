import { platformTimeout, windowsPowerShellEnvironment, recordProofEvent } from '../shared/platform-files.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

// `ps` 한 번의 상한. 만료하면 identity를 "확인 불가"로 보고 fail-closed라서,
// 프로세스가 많거나 느린 기기에서는 짧은 상한이 곧 기동·재개 실패다.
const IDENTITY_TIMEOUT_MS = process.platform === 'win32' ? 15_000 : 10_000;
// #257: the relay server's owned reader (engine/state.js `serverProcessStartTime`) waits for
// `ps` exactly as long as the legacy one, so moving the server to the owned form never turns a
// slow read into a new null.
export function identityTimeoutMs() {
  return platformTimeout(IDENTITY_TIMEOUT_MS);
}
const IDENTITY_MAX_BUFFER = 256;
export const WIN32_START_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

function asPid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

// Validate calendar fields without rounding away the Windows 100 ns identity.
export function validWin32StartTime(value) {
  if (typeof value !== 'string' || !WIN32_START_TIME.test(value)) return false;
  const day = value.slice(0, 10);
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)
    && date.toISOString().slice(0, 10) === day;
}

export function canonicalizeWin32StartTime(stdout, stderr) {
  if (stripBom(stderr).trim() !== '') return null;
  const body = stripBom(stdout);
  if (/[\r\n]/.test(body.replace(/\n$/, '').replace(/\r$/, ''))) return null;
  const trimmed = body.replace(/\r?\n$/, '').trim();
  if (!validWin32StartTime(trimmed)) return null;
  return trimmed;
}

export function posixProcessStartTime(pid, { exec = execFileSync } = {}) {
  const id = asPid(pid);
  if (id === null) return null;
  try {
    const out = exec('ps', ['-p', String(id), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: platformTimeout(IDENTITY_TIMEOUT_MS),
    });
    const trimmed = String(out).trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function win32ProcessStartTime(pid, { spawn = spawnSync } = {}) {
  const id = asPid(pid);
  if (id === null) return null;
  const script = [
    '$ErrorActionPreference = "Stop"',
    `try { $p = [System.Diagnostics.Process]::GetProcessById(${id}) } catch { exit 1 }`,
    "if ($null -eq $p -or $p.HasExited) { exit 1 }",
    "$p.StartTime.ToUniversalTime().ToString('o')",
  ].join('; ');
  try {
    const started = performance.now();
    const result = spawn(powershellExe(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: platformTimeout(IDENTITY_TIMEOUT_MS),
      env: windowsPowerShellEnvironment(),
      maxBuffer: IDENTITY_MAX_BUFFER,
      windowsHide: true,
    });
    recordProofEvent({
      kind: 'identity',
      paths: 1,
      ms: Math.round(performance.now() - started),
      status: result.status ?? null,
      timedOut: result.error?.code === 'ETIMEDOUT',
      self: id === process.pid,
    });
    if (result.status !== 0) return null;
    return canonicalizeWin32StartTime(result.stdout, result.stderr);
  } catch {
    return null;
  }
}

// #255: the creation FILETIME (100 ns since 1601-01-01 UTC) a `win32-v1:` value was printed
// from — `win32ProcessStartTime` writes `.StartTime.ToUniversalTime().ToString('o')`, which
// keeps all seven fraction digits. Only the exact owned wire is accepted; anything else is
// null, so no terminate helper is ever started for it.
const WIN32_OWNED = /^win32-v1:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{7})Z$/;
const FILETIME_UNIX_EPOCH_S = 11_644_473_600n;
export function win32OwnedFileTime(value) {
  const match = typeof value === 'string' ? WIN32_OWNED.exec(value) : null;
  if (!match || !validWin32StartTime(value.slice('win32-v1:'.length))) return null;
  const ms = Date.parse(`${match[1]}Z`);
  if (!Number.isSafeInteger(ms) || ms % 1000 !== 0) return null;
  const fileTime = (BigInt(ms / 1000) + FILETIME_UNIX_EPOCH_S) * 10_000_000n + BigInt(match[2]);
  return fileTime > 0n ? fileTime : null;
}

const TERMINATE_OUTCOMES = new Set(['terminated', 'replaced', 'absent', 'failed']);
export function parseWin32TerminateOutput(result) {
  // A timeout (or any spawn error) is failed even if a token was printed before it.
  if (!result || result.error || result.status !== 0 || stripBom(result.stderr).trim() !== '') return 'failed';
  const token = stripBom(result.stdout).replace(/\r?\n$/, '');
  return TERMINATE_OUTCOMES.has(token) ? token : 'failed';
}

// #255 S2: check the recorded identity and terminate through ONE process handle. The handle
// keeps the process object — and so its pid — from being reused between the creation-time
// comparison and TerminateProcess, which a separate observation followed by
// `process.kill(pid)` cannot promise. Node's own kill is TerminateProcess (exit code 1) on
// Windows too, so only the identity check moves; the effect on the target is the same.
// Outcomes: 'terminated'; 'replaced' (the pid now names a process created at another time);
// 'absent' (no such pid, or it already exited); 'failed' (anything unproven — the caller
// sends nothing else and reports it).
export function terminateWin32ProcessStartedAt(pid, ownedStartTime, { spawn = spawnSync, timeoutMs = IDENTITY_TIMEOUT_MS } = {}) {
  const id = asPid(pid);
  const expected = win32OwnedFileTime(ownedStartTime);
  if (id === null || id === process.pid || expected === null) return 'failed';
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class RecordedProcessTerminate {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 public static string Run(uint pid,long expected) {
  // PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
  IntPtr handle=OpenProcess(0x0001|0x1000|0x00100000,false,pid);
  if(handle==IntPtr.Zero) return Marshal.GetLastWin32Error()==87?"absent":"failed";
  try {
   long creation,exit,kernel,user;
   if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user)) return "failed";
   if(creation!=expected) return "replaced";
   if(WaitForSingleObject(handle,0)==0) return "absent";
   if(TerminateProcess(handle,1)) return "terminated";
   return WaitForSingleObject(handle,0)==0?"absent":"failed";
  } finally { CloseHandle(handle); }
 }
}
'@
[Console]::Out.Write([RecordedProcessTerminate]::Run(${id}, ${expected}))`;
  try {
    const started = performance.now();
    const result = spawn(powershellExe(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: Math.max(1, Math.min(platformTimeout(IDENTITY_TIMEOUT_MS), timeoutMs)),
      env: windowsPowerShellEnvironment(),
      maxBuffer: IDENTITY_MAX_BUFFER,
      windowsHide: true,
    });
    recordProofEvent({
      kind: 'terminate',
      paths: 1,
      ms: Math.round(performance.now() - started),
      status: result.status ?? null,
      timedOut: result.error?.code === 'ETIMEDOUT',
      self: false,
    });
    return parseWin32TerminateOutput(result);
  } catch {
    return 'failed';
  }
}

export function createProcessStartTime({
  platform = process.platform,
  exec = execFileSync,
  spawn = spawnSync,
} = {}) {
  if (platform === 'win32') return (pid) => win32ProcessStartTime(pid, { spawn });
  if (platform === 'darwin' || platform === 'linux') {
    return (pid) => posixProcessStartTime(pid, { exec });
  }
  return () => null;
}

/**
 * #211: this process's own (pid, start time) is fixed for its lifetime, so it is read once
 * instead of spawning ps/PowerShell on every lock check. Other pids are always read fresh,
 * and a failed self read (null) is retried rather than remembered.
 */
export function cacheSelfStartTime(read, selfPid = process.pid) {
  let self = null;
  return (pid) => {
    if (Number(pid) !== selfPid) return read(pid);
    if (self === null) self = read(pid);
    return self;
  };
}

// Only Windows pays a PowerShell process per read. POSIX `ps` is cheap, and tests
// substitute it on PATH for their own pid, so POSIX keeps reading fresh.
export function cacheSelfOnWin32(read, platform = process.platform) {
  return platform === 'win32' ? cacheSelfStartTime(read) : read;
}

export const processStartTime = cacheSelfOnWin32(createProcessStartTime());
