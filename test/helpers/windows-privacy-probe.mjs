import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows privacy probe requires Windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-windows-privacy-'));
  const identity = fs.lstatSync(root);
  const original = cp.spawnSync;
  cp.spawnSync = (...args) => {
    const result = original(...args);
    const script = args[1]?.at(-1) ?? '';
    console.log(JSON.stringify({ kind: String(script).includes('PrivateDirectoryNative') ? 'private-create' : 'private-read',
      status: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
      stdout: String(result.stdout ?? '').slice(0, 8192), stderr: String(result.stderr ?? '').slice(0, 8192) }));
    return result;
  };
  syncBuiltinESMExports();
  try {
    const { createPrivateDirectory, isPrivatePath } = await import('../../shared/platform-files.js');
    const target = path.join(root, 'private');
    createPrivateDirectory(target);
    if (!isPrivatePath(target)) throw new Error('PRIVATE_PROBE_FAILED');
    console.log(JSON.stringify({ privateDirectoryVerified: true }));
    const { acquireOwnedLock, releaseOwnedLock } = await import('../../engine/state.js');
    const owner = acquireOwnedLock(target, 'loop.lock.d');
    try {
      for (const [label, file] of [['root', target], ['loop-lock', owner.dir], ['loop-pid', path.join(owner.dir, 'pid')]]) {
        console.log(JSON.stringify({ aclTarget: label }));
        console.log(JSON.stringify({ aclTarget: label, verified: isPrivatePath(file, { privateMode: false }) }));
      }
    } finally { releaseOwnedLock(owner); }
  } finally {
    cp.spawnSync = original;
    syncBuiltinESMExports();
    const now = fs.lstatSync(root);
    if (now.dev !== identity.dev || now.ino !== identity.ino || now.isSymbolicLink()) throw new Error('PRIVACY_PROBE_ROOT_REPLACED');
    fs.rmSync(root, { recursive: true });
    console.log(JSON.stringify({ ownedProbeRootRemoved: !fs.existsSync(root) }));
  }
}
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !process.env.NODE_TEST_CONTEXT) await main();
