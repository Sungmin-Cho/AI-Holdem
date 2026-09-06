import { windowsPowerShellEnvironment } from './platform-files.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const owned = new WeakSet();
export const isOwnedWindowsChild = child => owned.has(child);

export async function terminateOwnedWindowsChild(child) {
  if (!owned.has(child)) return { confirmed: false, reason: 'termination_unconfirmed' };
  // A clean launcher close follows checked Job active-process accounting.
  if (child.exitCode !== null && child.exitCode !== 125 && child.signalCode === null) return { confirmed: true };
  if (child.exitCode !== null || child.signalCode !== null) return { confirmed: false, reason: 'termination_unconfirmed' };
  // The tracked ChildProcess uses its OS handle, never a fresh numeric PID lookup.
  child.kill('SIGKILL');
  return { confirmed: false, reason: 'termination_unconfirmed' };
}

export function spawnOwnedCommand(command, args, options = {}) {
  const { ownedTimeoutMs, ...spawnOptions } = options;
  options = spawnOptions;
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
  if (ownedTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(ownedTimeoutMs) || ownedTimeoutMs < 1 || ownedTimeoutMs > 2147483647) throw windowsInvalid();
    argv.push('-TimeoutMs', String(ownedTimeoutMs));
  }
  if ([powershell, ...argv].map(quoteWindowsArgument).join(' ').length + 1 > 32767)
    throw windowsInvalid('WINDOWS_OWNED_WRAPPER_TOO_LARGE');
  const child = spawn(powershell, argv, windowsOwnedSpawnOptions({ ...options, env: windowsPowerShellEnvironment(options.env ?? process.env) }));
  child.ownedWindowsJob = true;
  owned.add(child);
  return child;
}
