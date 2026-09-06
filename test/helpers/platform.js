import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime as realProcessStartTime } from '../../engine/process-identity.js';

export function prependPath(dir, env = process.env) {
  const current = env.PATH ?? env.Path ?? '';
  return { ...env, PATH: `${dir}${path.delimiter}${current}` };
}

export function skipOnWin32(t, reason) {
  if (process.platform !== 'win32') return false;
  t.skip(reason);
  return true;
}

export function createStartTimeProbe(real = realProcessStartTime) {
  let impl = real;
  const probe = (pid) => impl(pid);
  probe.set = (next) => { impl = next; };
  probe.reset = () => { impl = real; };
  probe.nullExcept = (...keep) => {
    const allowed = new Set(keep);
    impl = (pid) => (allowed.has(pid) ? real(pid) : null);
  };
  probe.mismatchWhen = (predicate, fake = 'Mon Jan  1 00:00:00 2001') => {
    impl = (pid) => (predicate(pid) ? fake : real(pid));
  };
  return probe;
}

export function spawnSleeper(ms = 5_000) {
  return spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Number(ms)})`], {
    stdio: 'ignore',
  });
}

export function writeFakePlayerJs(dir, source) {
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'fake-player.js');
  fs.writeFileSync(scriptPath, source);
  return { command: process.execPath, scriptPath };
}

export function childTerminated(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

// Only use with a child spawned detached by the calling fixture. Windows has
// no POSIX process groups: taskkill traverses that owned child's process tree.
export function stopOwnedProcessTree(child, { platform = process.platform, exec = execFileSync, kill = process.kill } = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) return;
  if (platform !== 'win32') {
    try { kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  if (child.ownedWindowsJob) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    return; // Closing the launcher closes its non-inherited Job handle.
  }
  // Never target a potentially reused PID after the tracked child has exited.
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000, stdio: 'pipe', windowsHide: true });
  } catch (error) {
    try { kill(child.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') return; throw probe; }
    throw error;
  }
}

export { quoteWindowsArgument, windowsOwnedPayload, windowsOwnedSpawnOptions, spawnOwnedCommand } from '../../shared/windows-owned-process.js';
