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

const fullyQualifiedWindowsPath = value => /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value);
const windowsInvalid = (code = 'WINDOWS_OWNED_PAYLOAD_INVALID') => Object.assign(new Error(code), { code });

export function quoteWindowsArgument(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

export function windowsOwnedPayload(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)
    || Object.keys(spec).sort().join(',') !== 'args,command,cwd'
    || !Array.isArray(spec.args) || spec.args.length > 1024) throw windowsInvalid();
  const values = [spec.command, spec.cwd, ...spec.args];
  if (values.some(value => typeof value !== 'string' || value.length > 32760 || value.includes('\0'))
    || !spec.command || !spec.cwd || !fullyQualifiedWindowsPath(spec.command) || !fullyQualifiedWindowsPath(spec.cwd)
    || path.win32.extname(spec.command).toLowerCase() !== '.exe') throw windowsInvalid();
  const target = [spec.command, ...spec.args].map(quoteWindowsArgument).join(' ');
  if (target.length + 1 > 32767) throw windowsInvalid('WINDOWS_OWNED_COMMAND_TOO_LARGE');
  const bytes = Buffer.from(JSON.stringify(spec));
  if (bytes.length > 24576) throw windowsInvalid('WINDOWS_OWNED_PAYLOAD_TOO_LARGE');
  return bytes.toString('base64');
}

function windowsExecutable(command, env) {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw windowsInvalid();
  const paths = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const candidates = path.win32.isAbsolute(command) ? [command]
    : /[\\/]/.test(command) ? []
      : paths.split(';').filter(Boolean).map(dir => path.win32.join(dir, /\.exe$/i.test(command) ? command : `${command}.exe`));
  for (const file of candidates) {
    if (path.win32.extname(file).toLowerCase() !== '.exe') continue;
    try { if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw windowsInvalid('WINDOWS_OWNED_EXECUTABLE_UNAVAILABLE');
}

export function windowsOwnedSpawnOptions(options = {}) {
  return { ...options, detached: false, windowsHide: true, shell: false, windowsVerbatimArguments: false };
}

export function spawnOwnedCommand(command, args, options = {}) {
  if (process.platform !== 'win32') return spawn(command, args, { ...options, detached: true });
  if (command === 'npm' || command === 'npx') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command}-cli.js`);
    if (!fs.statSync(cli).isFile()) throw new Error('Windows npm CLI is unavailable');
    args = [cli, ...args]; command = process.execPath;
  }
  command = windowsExecutable(command, options.env ?? process.env);
  const payload = windowsOwnedPayload({ command, args, cwd: options.cwd ?? process.cwd() });
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('./windows-owned-process.ps1', import.meta.url)), '-Payload', payload];
  if ([powershell, ...argv].map(quoteWindowsArgument).join(' ').length + 1 > 32767)
    throw windowsInvalid('WINDOWS_OWNED_WRAPPER_TOO_LARGE');
  const child = spawn(powershell, argv, windowsOwnedSpawnOptions(options));
  child.ownedWindowsJob = true;
  return child;
}
