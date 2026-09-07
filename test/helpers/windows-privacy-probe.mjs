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
    // A hosted runner's PowerShell occasionally stalls past the 15s per-call
    // cap once, in a job that otherwise proves in under a second per call. One
    // stall is not a verdict on the platform, and it must not cost the 75
    // minutes behind this gate. Try once more on a fresh directory; both
    // attempts stay in the log, and a second stall fails the step.
    let target = path.join(root, 'private');
    for (let attempt = 1; ; attempt += 1) {
      try {
        createPrivateDirectory(target);
        if (!isPrivatePath(target)) throw Object.assign(new Error('PRIVATE_PROBE_FAILED'), { code: 'PRIVATE_PROBE_FAILED' });
        break;
      } catch (error) {
        console.log(JSON.stringify({ privateDirectoryAttempt: attempt, failed: error?.code ?? error?.message }));
        if (attempt >= 2 || !['PRIVATE_PATH_UNVERIFIED', 'PRIVATE_PROBE_FAILED'].includes(error?.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        target = path.join(root, `private-${attempt + 1}`);
      }
    }
    console.log(JSON.stringify({ privateDirectoryVerified: true, target: path.basename(target) }));
    const { acquireOwnedLock, releaseOwnedLock } = await import('../../engine/state.js');
    const owner = acquireOwnedLock(target, 'loop.lock.d');
    try {
      for (const [label, file] of [['root', target], ['loop-lock', owner.dir], ['loop-pid', path.join(owner.dir, 'pid')]]) {
        console.log(JSON.stringify({ aclTarget: label }));
        const verified = isPrivatePath(file, { privateMode: false });
        console.log(JSON.stringify({ aclTarget: label, verified }));
        if (!verified) throw new Error(`OWNED_LOCK_ACL_UNVERIFIED:${label}`);
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
