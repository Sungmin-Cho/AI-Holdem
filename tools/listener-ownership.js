import { windowsPowerShellEnvironment, recordProofEvent } from '../shared/platform-files.js';
import { execFile, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

function unavailable(message, cause) {
  const error = new Error(message);
  error.code = 'SERVER_LISTENER_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

function asPid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function netstatExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'netstat.exe');
}

function parseListenRows(payload) {
  if (payload === '' || payload == null) return [];
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.', error);
  }
  if (parsed == null) return [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') {
      throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
    }
    const owningProcess = Number(row.OwningProcess ?? row.owningProcess);
    const localAddress = String(row.LocalAddress ?? row.localAddress ?? '');
    const localPort = Number(row.LocalPort ?? row.localPort);
    // MSFT_NetTCPConnection.State is uint8; PowerShell 5.1 serializes
    // Listen as numeric 2. Accept only that exact enum value, not coercible
    // strings/booleans, while retaining the explicit text form from adapters.
    const rawState = row.State ?? row.state;
    const state = rawState === 2 ? 'Listen' : (typeof rawState === 'string' ? rawState : '');
    if (!Number.isInteger(owningProcess) || owningProcess < 1) {
      throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
    }
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
    }
    return { owningProcess, localAddress, localPort, state };
  });
}

function rowOwnedBy(row, pid, port) {
  return row.owningProcess === pid
    && row.localAddress === '127.0.0.1'
    && row.localPort === port
    && /^listen$/i.test(row.state);
}

export function parseNetstatListening(stdout, pid, port) {
  // netstat always prints its headers. An empty table was not read at all, and
  // an absent listener can only be concluded from a table that was.
  if (String(stdout).trim() === '') throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
  const needle = `127.0.0.1:${port}`;
  const lines = String(stdout).split(/\r?\n/);
  let sawFormat = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[1] ?? parts[0];
    const state = parts[parts.length - 2];
    const owner = Number(parts[parts.length - 1]);
    if (local === needle) {
      sawFormat = true;
      if (state !== 'LISTENING') throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
      if (!Number.isInteger(owner) || owner < 1) throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
      return owner === pid;
    }
  }
  if (!sawFormat && /[^\x00-\x7F]/.test(String(stdout))) {
    throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
  }
  return false;
}

export async function posixListenerOwnedBy(pid, port, {
  lsofPath,
  timeoutMs = 1_000,
  execFileFn = execFile,
  onChild,
} = {}) {
  const id = asPid(pid);
  const listenPort = asPort(port);
  if (id === null || listenPort === null) throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
  if (!lsofPath) throw unavailable('pid↔port 검증 도구를 찾을 수 없습니다.');
  return new Promise((resolve, reject) => {
    const child = execFileFn(lsofPath, [
      '-nP', '-a', '-p', String(id), `-iTCP:${listenPort}`, '-sTCP:LISTEN', '-Fptn',
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      onChild?.('close', child);
      if (error) {
        if (Number(error.code) === 1 && !error.killed && !error.signal && String(stderr).trim() === '') {
          resolve(false);
          return;
        }
        reject(unavailable('pid↔port OS 검증을 완료할 수 없습니다.', error));
        return;
      }
      const lines = String(stdout).split(/\r?\n/);
      resolve(lines.includes(`p${id}`) && lines.includes(`n127.0.0.1:${listenPort}`));
    });
    onChild?.('open', child);
  });
}

// Windows reads the native table first. netstat needs no PowerShell, no module
// and no analysis cache, and answers in well under the probe budget, whereas
// Get-NetTCPConnection must import NetTCPIP: one to three seconds with a warm
// module cache, over twenty without one, which a child holding an environment
// allowlist never has. Sharing one deadline, that import starved the native
// fallback of the time it needed — 131 game-loop failures on one runner. The
// PowerShell view now decides only where netstat cannot answer at all.
function netstatVerdict(pid, port, { spawn, timeoutMs }) {
  let result;
  try {
    result = spawn(netstatExe(), ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  } catch { return null; }
  if (!result || result.error || result.status !== 0) return null;
  try { return { owned: parseNetstatListening(result.stdout, pid, port) }; }
  catch { return null; }
}

export function win32ListenerOwnedBy(pid, port, {
  spawn = spawnSync,
  timeoutMs = 1_000,
} = {}) {
  const id = asPid(pid);
  const listenPort = asPort(port);
  if (id === null || listenPort === null) throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
  const native = netstatVerdict(id, listenPort, { spawn, timeoutMs });
  if (native) return native.owned;
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${listenPort} -State Listen -ErrorAction SilentlyContinue |`,
    'Select-Object OwningProcess,LocalAddress,LocalPort,State | ConvertTo-Json -Compress',
  ].join(' ');
  let result;
  const started = performance.now();
  try {
    result = spawn(powershellExe(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      env: windowsPowerShellEnvironment(process.env, undefined, { modules: 'system' }),
      windowsHide: true,
    });
  } catch (error) {
    recordProofEvent({
      kind: 'listener',
      paths: 1,
      ms: Math.round(performance.now() - started),
      status: null,
      timedOut: error?.code === 'ETIMEDOUT',
    });
    throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.', error);
  }
  recordProofEvent({
    kind: 'listener',
    paths: 1,
    ms: Math.round(performance.now() - started),
    status: result.status ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
  });
  if (result.status !== 0) throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
  const rows = parseListenRows(String(result.stdout ?? '').replace(/^\uFEFF/, '').trim());
  // With the native table already unable to answer, an empty PowerShell view
  // cannot tell "no listener" from "no cmdlet"; only a populated view decides.
  if (rows.length === 0) throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
  return rows.some((row) => rowOwnedBy(row, id, listenPort));
}

// Production probes are asynchronous so the supervisor can account for and
// cancel every child. Both Windows commands share one monotonic deadline; the
// native table goes first so the deadline is spent on the command that answers.
async function win32ListenerOwnedByAsync(pid, port, { execFileFn = execFile, onChild, timeoutMs }) {
  const id = asPid(pid); const listenPort = asPort(port);
  if (id === null || listenPort === null) throw unavailable('Invalid listener identity');
  const deadline = performance.now() + timeoutMs;
  const run = (exe, args, env) => new Promise((resolve, reject) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) { reject(unavailable('Listener probe deadline exhausted')); return; }
    const child = execFileFn(exe, args, { ...(env ? { env } : {}), encoding: 'utf8', timeout: remaining,
      killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      onChild?.('close', child);
      resolve({ error, stdout, stderr });
    });
    onChild?.('open', child);
  });
  const native = await run(netstatExe(), ['-ano', '-p', 'tcp']);
  if (!native.error && !String(native.stderr ?? '').trim()) {
    try { return parseNetstatListening(native.stdout, id, listenPort); }
    catch { /* The table could not be read as one; the PowerShell view decides. */ }
  }
  const script = `$ErrorActionPreference = "Stop"; Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${listenPort} -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalAddress,LocalPort,State | ConvertTo-Json -Compress`;
  const started = performance.now();
  const result = await run(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    windowsPowerShellEnvironment(process.env, undefined, { modules: 'system' }));
  recordProofEvent({
    kind: 'listener',
    paths: 1,
    ms: Math.round(performance.now() - started),
    status: result.error ? (result.error.code === 'ETIMEDOUT' ? null : 1) : 0,
    timedOut: result.error?.code === 'ETIMEDOUT',
  });
  if (result.error || String(result.stderr ?? '').trim()) throw unavailable('Listener verification failed', result.error);
  const rows = parseListenRows(String(result.stdout ?? '').replace(/^\uFEFF/, '').trim());
  if (!rows.length) throw unavailable('Listener verification failed');
  return rows.some((row) => rowOwnedBy(row, id, listenPort));
}

export function createListenerOwnedBy(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const lsofPath = opts.lsofPath
    ?? ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate))
    ?? null;
  const timeoutMs = opts.timeoutMs ?? 1_000;
  if (typeof opts.listenerOwnedBy === 'function') return opts.listenerOwnedBy;
  return async (pid, port, call = {}) => {
    const boundedMs = Math.min(timeoutMs, call.timeoutMs ?? timeoutMs);
    if (!(boundedMs > 0)) throw unavailable('Listener probe deadline exhausted');
    if (platform === 'win32') return win32ListenerOwnedByAsync(pid, port, { execFileFn: opts.execFileFn, onChild: opts.onChild, timeoutMs: boundedMs });
    return posixListenerOwnedBy(pid, port, {
      lsofPath: opts.lsofPath ?? lsofPath,
      timeoutMs: boundedMs,
      execFileFn: opts.execFileFn,
      onChild: opts.onChild,
    });
  };
}
