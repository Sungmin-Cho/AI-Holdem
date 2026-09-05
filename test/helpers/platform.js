import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
