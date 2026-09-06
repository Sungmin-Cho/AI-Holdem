import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const budgets = new AsyncLocalStorage();
export const platformNow = () => (budgets.getStore()?.now ?? (() => performance.now()))();
export function withPlatformDeadline(deadline, fn, { now = budgets.getStore()?.now ?? (() => performance.now()) } = {}) {
  return budgets.run({ deadline, now }, fn);
}
export function platformTimeout(maximum) {
  const budget = budgets.getStore();
  if (!budget) return maximum;
  const remaining = Math.floor(budget.deadline - budget.now());
  if (remaining <= 0) throw Object.assign(new Error('STUDY_DESCRIPTOR_CORRUPT'), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  return Math.min(maximum, remaining);
}
export function extendPlatformDeadline(deadline) {
  const budget = budgets.getStore();
  if (budget) budget.deadline = deadline;
}

import path from 'node:path';
import { spawnSync } from 'node:child_process';

const denied = () => Object.assign(new Error('PRIVATE_PATH_UNVERIFIED'), { code: 'PRIVATE_PATH_UNVERIFIED' });
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;
function powershell(script, spawn = spawnSync) {
  return spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: platformTimeout(15_000), maxBuffer: 64 * 1024, windowsHide: true });
}

// Windows mode bits do not describe a DACL. Read the actual ACL without changing
// existing files. SYSTEM and Administrators are the platform's trusted authority.
export function isPrivatePath(file, { platform = process.platform, spawn = spawnSync, privateMode = true } = {}) {
  if (platform !== 'win32') {
    try {
      const st = fs.lstatSync(file);
      return !st.isSymbolicLink() && (typeof process.getuid !== 'function' || st.uid === process.getuid())
        && (privateMode ? (st.mode & 0o777) === (st.isDirectory() ? 0o700 : 0o600) : (st.mode & 0o022) === 0);
    } catch { return false; }
  }
  return arePrivatePaths([{ file, privateMode }], { platform, spawn });
}

export function arePrivatePaths(entries, { platform = process.platform, spawn = spawnSync } = {}) {
  if (platform !== 'win32') return entries.every(({ file, privateMode }) => isPrivatePath(file, { platform, privateMode }));
  try {
    if (!entries.every(({ file }) => { const st = fs.lstatSync(file); return !st.isSymbolicLink() && (st.isFile() || st.isDirectory()); })) return false;
    const paths = entries.map(({ file }) => quote(file)).join(',');
    const script = `$ErrorActionPreference='Stop'; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $proofs=@(); foreach($p in @(${paths})) { $a=Get-Acl -LiteralPath $p; $rules=@(); foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { $rules+=@{sid=$r.IdentityReference.Value;type=$r.AccessControlType.ToString();rights=[long]$r.FileSystemRights} }; $proofs+=@{user=$me;owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;reparse=(([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0);rules=$rules} }; ConvertTo-Json -InputObject @($proofs) -Depth 5 -Compress`;
    const result = powershell(script, spawn);
    if (result.status !== 0 || String(result.stderr ?? '').trim()) return false;
    const proofs = JSON.parse(String(result.stdout ?? '').replace(/^\uFEFF/, ''));
    return Array.isArray(proofs) && proofs.length === entries.length
      && proofs.every((proof, i) => privateAclAllowed(proof, entries[i].privateMode ?? true));
  } catch { return false; }
}

// FileSystemRights: ReadData|ReadExtendedAttributes|ExecuteFile|ReadAttributes|
// ReadPermissions|Synchronize. Unknown and GENERIC_* bits are never read proof.
export function privateAclAllowed(proof, privateMode = true) {
  if (!proof || proof.reparse !== false || typeof proof.user !== 'string'
    || !/^S-1-/.test(proof.user) || proof.owner !== proof.user || !Array.isArray(proof.rules)) return false;
  const trusted = new Set([proof.user, 'S-1-5-18', 'S-1-5-32-544']);
  let own = false;
  for (const rule of proof.rules) {
    if (!rule || typeof rule.sid !== 'string' || !['Allow', 'Deny'].includes(rule.type)
      || !Number.isSafeInteger(rule.rights)) return false;
    if (rule.type !== 'Allow') continue;
    if (rule.sid === proof.user) own = true;
    if (!trusted.has(rule.sid) && (privateMode || (BigInt(rule.rights) & ~1179817n) !== 0n)) return false;
  }
  return own;
}

// Only create missing paths. Native CreateDirectoryW supplies the DACL in the
// creation call, and ERROR_ALREADY_EXISTS never applies it to somebody else's path.
export function createPrivateDirectory(file) {
  if (process.platform !== 'win32') { fs.mkdirSync(file, { mode: 0o700 }); return; }
  const script = `$ErrorActionPreference='Stop';
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class PrivateDirectoryNative {
[StructLayout(LayoutKind.Sequential)] public struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool CreateDirectory(string path, ref SA attrs);
}
'@;
$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object System.Security.AccessControl.DirectorySecurity;
$acl.SetOwner($me); $acl.SetAccessRuleProtection($true,$false);
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule);
$bytes=$acl.GetSecurityDescriptorBinaryForm(); $ptr=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length);
try { [Runtime.InteropServices.Marshal]::Copy($bytes,0,$ptr,$bytes.Length); $sa=New-Object PrivateDirectoryNative+SA; $sa.length=[Runtime.InteropServices.Marshal]::SizeOf($sa); $sa.descriptor=$ptr; if (![PrivateDirectoryNative]::CreateDirectory(${quote(file)},[ref]$sa)) { $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); if($e -eq 183){exit 2}; exit 1 } } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }`;
  const result = powershell(script);
  if (result.status === 2) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
  if (result.status !== 0 || !isPrivatePath(file)) throw denied();
}
