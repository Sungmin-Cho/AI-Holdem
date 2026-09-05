import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function prependPath(dir, env = process.env) {
  const current = env.PATH ?? env.Path ?? '';
  return { ...env, PATH: `${dir}${path.delimiter}${current}` };
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
