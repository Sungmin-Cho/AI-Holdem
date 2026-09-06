import { after } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ownedDirs = [];
const ownedServers = [];
const ownedProcesses = [];
const receiptPath = path.join(
  os.tmpdir(),
  `ai-holdem-owned-cleanup-${process.pid}-${randomBytes(8).toString('hex')}.json`,
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function processIdentity(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function closeServer(server, timeoutMs = 2_000) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned server close timed out')), timeoutMs);
    timer.unref?.();
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

function directoryState(entry) {
  let stat;
  try {
    stat = fs.lstatSync(entry.dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
  if (!stat.isDirectory() || stat.dev !== entry.dev || stat.ino !== entry.ino) {
    return { state: 'replacement', stat };
  }
  return { state: 'owned', stat };
}

export function createOwnedTempDir(prefix = 'ai-holdem-test-') {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/i.test(prefix)) {
    throw new TypeError('owned fixture prefix must be a short safe token');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const real = fs.realpathSync(dir);
  const stat = fs.lstatSync(dir);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !stat.isDirectory()) {
    throw new Error('owned fixture was not created directly under the temp root');
  }
  ownedDirs.push({ dir, real, dev: stat.dev, ino: stat.ino });
  return dir;
}

export function inspectOwnedTempDir(dir) {
  const entry = ownedDirs.find((row) => row.dir === dir);
  if (!entry) throw new Error('directory is not registered as an owned fixture');
  return directoryState(entry).state;
}

export function registerOwnedServer(server, label = 'server') {
  if (!server || typeof server.close !== 'function') {
    throw new TypeError('owned server must expose close()');
  }
  ownedServers.push({ server, label: String(label) });
  return server;
}

export function registerOwnedProcess(child, label = 'process') {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || typeof child.kill !== 'function') {
    throw new TypeError('owned process must be a spawned child with a pid');
  }
  ownedProcesses.push({
    child,
    pid: child.pid,
    identity: processIdentity(child.pid),
    label: String(label),
  });
  return child;
}

export function ownedCleanupReceiptPath() {
  return receiptPath;
}

after(async () => {
  const evidence = [];
  const failures = [];
  for (const entry of ownedServers.reverse()) {
    try {
      await closeServer(entry.server);
      if (entry.server.listening) throw new Error(`owned server remained open: ${entry.label}`);
      evidence.push({ kind: 'server', label: entry.label, closed: true });
    } catch (error) {
      failures.push(error);
      evidence.push({ kind: 'server', label: entry.label, closed: false, error: error.message });
    }
  }
  for (const entry of ownedProcesses.reverse()) {
    try {
      const childRunning = entry.child.exitCode === null && entry.child.signalCode === null;
      if (childRunning) {
        const currentIdentity = processIdentity(entry.pid);
        if (entry.identity !== null && currentIdentity !== null && currentIdentity !== entry.identity) {
          throw new Error(`owned process identity changed: ${entry.label}`);
        }
        entry.child.kill('SIGTERM');
        if (!await waitForExit(entry.child)) {
          entry.child.kill('SIGKILL');
          await waitForExit(entry.child);
        }
      }
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        throw new Error(`owned process remained alive: ${entry.label}`);
      }
      if (processAlive(entry.pid)) {
        const currentIdentity = processIdentity(entry.pid);
        if (entry.identity === null || currentIdentity === null || currentIdentity === entry.identity) {
          throw new Error(`owned process death cannot be proven: ${entry.label}`);
        }
      }
      evidence.push({ kind: 'process', label: entry.label, pid: entry.pid, dead: true });
    } catch (error) {
      failures.push(error);
      evidence.push({ kind: 'process', label: entry.label, pid: entry.pid, dead: false, error: error.message });
    }
  }
  for (const entry of ownedDirs.reverse()) {
    try {
      const current = directoryState(entry);
      if (current.state === 'replacement') {
        throw new Error('owned fixture inode changed before cleanup');
      }
      if (current.state === 'owned') {
        fs.rmSync(entry.dir, { recursive: true, force: false });
      }
      if (fs.existsSync(entry.dir)) throw new Error('owned fixture directory remained after cleanup');
      evidence.push({
        kind: 'directory',
        identitySha256: sha256(`${entry.real}:${entry.dev}:${entry.ino}`),
        removed: true,
        alreadyAbsent: current.state === 'absent',
      });
    } catch (error) {
      failures.push(error);
      evidence.push({
        kind: 'directory',
        identitySha256: sha256(`${entry.real}:${entry.dev}:${entry.ino}`),
        removed: false,
        error: error.message,
      });
    }
  }
  const body = {
    schemaVersion: 1,
    marker: 'OWNED_FIXTURE_CLEANUP',
    pid: process.pid,
    evidence,
  };
  body.receiptSha256 = sha256(JSON.stringify(body));
  fs.writeFileSync(receiptPath, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`OWNED_FIXTURE_CLEANUP receipt=${receiptPath} sha256=${body.receiptSha256}`);
  if (failures.length > 0) throw new AggregateError(failures, 'owned fixture cleanup failed');
});
