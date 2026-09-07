import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSC = path.win32.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const SOURCE = path.join(HERE, 'windows-native-proof.cs');

function meanMs(fn, n) {
  const started = Date.now();
  for (let i = 0; i < n; i += 1) fn();
  return (Date.now() - started) / n;
}

function run(exe, args, timeout = 15_000) {
  return cp.spawnSync(exe, args, { encoding: 'utf8', timeout, windowsHide: true });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows native proof probe requires Windows');
  const exists = fs.existsSync(CSC);
  let version = null;
  if (exists) {
    const ver = run(CSC, ['/help'], 10_000);
    version = String(ver.stdout || ver.stderr || '').split(/\r?\n/).find((line) => /Compiler version|Microsoft/i.test(line))
      ?? `status=${ver.status}`;
  }
  console.log(JSON.stringify({ csc: exists ? CSC : null, exists, version }));
  const { createPrivateDirectory, arePrivatePaths, isPrivatePath } = await import('../../shared/platform-files.js');
  const root = path.join(os.tmpdir(), `holdem-native-proof-${process.pid}`);
  createPrivateDirectory(root);
  try {
    const files = [];
    for (let i = 0; i < 5; i += 1) {
      const file = path.join(root, `p${i}.txt`);
      fs.writeFileSync(file, 'x', { mode: 0o600 });
      files.push(file);
    }
    const ps1 = () => arePrivatePaths(files.slice(0, 1).map((file) => ({ file })));
    const ps5 = () => arePrivatePaths(files.map((file) => ({ file })));
    if (!exists) {
      console.log(JSON.stringify({ skipped: 'csc missing', arePrivatePaths1Ms: meanMs(ps1, 100), arePrivatePaths5Ms: meanMs(ps5, 100) }));
      return;
    }
    const cs = path.join(root, 'NativeProof.cs');
    const exe = path.join(root, 'NativeProof.exe');
    fs.copyFileSync(SOURCE, cs);
    const compiledAt = Date.now();
    const compiled = run(CSC, ['/nologo', '/optimize+', `/out:${exe}`, cs], 60_000);
    console.log(JSON.stringify({
      compileMs: Date.now() - compiledAt,
      status: compiled.status,
      stdout: String(compiled.stdout ?? '').slice(0, 300),
      stderr: String(compiled.stderr ?? '').slice(0, 300),
    }));
    if (compiled.status !== 0 || !fs.existsSync(exe)) return;
    const acl1 = meanMs(() => { const r = run(exe, files.slice(0, 1)); if (r.status !== 0) throw new Error(String(r.stderr || r.stdout)); }, 100);
    const acl5 = meanMs(() => { const r = run(exe, files); if (r.status !== 0) throw new Error(String(r.stderr || r.stdout)); }, 100);
    const identity = meanMs(() => { const r = run(exe, ['id', String(process.pid)]); if (r.status !== 0) throw new Error(String(r.stderr || r.stdout)); }, 100);
    const path1 = meanMs(ps1, 100);
    const path5 = meanMs(ps5, 100);
    console.log(JSON.stringify({ nativeAcl1Ms: acl1, nativeAcl5Ms: acl5, nativeIdentityMs: identity }));
    console.log(JSON.stringify({ arePrivatePaths1Ms: path1, arePrivatePaths5Ms: path5, ratio1: path1 / acl1, ratio5: path5 / acl5 }));
    console.log(JSON.stringify({ exePrivate: isPrivatePath(exe) }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !process.env.NODE_TEST_CONTEXT) await main();
