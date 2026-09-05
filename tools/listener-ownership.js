import { execFile, spawnSync } from 'node:child_process';
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
    const state = String(row.State ?? row.state ?? '');
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

export function win32ListenerOwnedBy(pid, port, {
  spawn = spawnSync,
  timeoutMs = 1_000,
} = {}) {
  const id = asPid(pid);
  const listenPort = asPort(port);
  if (id === null || listenPort === null) throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${listenPort} -State Listen -ErrorAction SilentlyContinue |`,
    'Select-Object OwningProcess,LocalAddress,LocalPort,State | ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const result = spawn(powershellExe(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    if (result.status === 0) {
      const rows = parseListenRows(String(result.stdout ?? '').replace(/^\uFEFF/, '').trim());
      if (rows.some((row) => rowOwnedBy(row, id, listenPort))) return true;
      if (rows.length === 0) {
        return netstatFallback(id, listenPort, { spawn, timeoutMs });
      }
      return false;
    }
  } catch {
    /* fall through to netstat */
  }
  return netstatFallback(id, listenPort, { spawn, timeoutMs });
}

function netstatFallback(pid, port, { spawn, timeoutMs }) {
  let result;
  try {
    result = spawn(netstatExe(), ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.', error);
  }
  if (result.status !== 0) throw unavailable('pid↔port OS 검증을 완료할 수 없습니다.');
  return parseNetstatListening(result.stdout, pid, port);
}

export function createListenerOwnedBy(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const lsofPath = opts.lsofPath
    ?? ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate))
    ?? null;
  const timeoutMs = opts.timeoutMs ?? 1_000;
  if (typeof opts.listenerOwnedBy === 'function') return opts.listenerOwnedBy;
  return async (pid, port) => {
    if (platform === 'win32') return win32ListenerOwnedBy(pid, port, { spawn: opts.spawn, timeoutMs });
    return posixListenerOwnedBy(pid, port, {
      lsofPath: opts.lsofPath ?? lsofPath,
      timeoutMs,
      execFileFn: opts.execFileFn,
      onChild: opts.onChild,
    });
  };
}
