import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const IDENTITY_TIMEOUT_MS = 3_000;
const IDENTITY_MAX_BUFFER = 256;
export const WIN32_START_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

function asPid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

export function canonicalizeWin32StartTime(stdout, stderr) {
  if (stripBom(stderr).trim() !== '') return null;
  const body = stripBom(stdout);
  if (/[\r\n]/.test(body.replace(/\n$/, '').replace(/\r$/, ''))) return null;
  const trimmed = body.replace(/\r?\n$/, '').trim();
  if (!WIN32_START_TIME.test(trimmed)) return null;
  return trimmed;
}

export function posixProcessStartTime(pid, { exec = execFileSync } = {}) {
  const id = asPid(pid);
  if (id === null) return null;
  try {
    const out = exec('ps', ['-p', String(id), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: IDENTITY_TIMEOUT_MS,
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
    const result = spawn(powershellExe(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: IDENTITY_TIMEOUT_MS,
      maxBuffer: IDENTITY_MAX_BUFFER,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    return canonicalizeWin32StartTime(result.stdout, result.stderr);
  } catch {
    return null;
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

export const processStartTime = createProcessStartTime();
