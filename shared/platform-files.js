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

// pwsh 7 exports its module search path to children. Windows PowerShell 5.1
// cannot load those Core modules. Use the system modules of the executable's
// root, never a custom payload environment's SystemRoot or inherited PSHOME.
const PINNED_POWERSHELL = new Set(['psmodulepath', 'psmoduleanalysiscachepath']);
export function windowsPowerShellEnvironment(env = process.env, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !PINNED_POWERSHELL.has(key.toLowerCase())));
  clean.PSModulePath = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  // With no usable cache location PowerShell re-analyses every module on that
  // path at every start. A detached child inherits neither a caller's cache path
  // nor LOCALAPPDATA, so it pays that cost on every proof and overruns a 15s cap.
  // Pin the cache to the per-user temp directory PowerShell would have chosen for
  // itself, and never inherit the location: this file decides how commands
  // resolve, so a caller must not be able to aim it.
  clean.PSModuleAnalysisCachePath = path.win32.join(
    env.TEMP || env.TMP || path.win32.join(systemRoot, 'Temp'), 'ai-holdem-psmodule-analysis.cache');
  return clean;
}

const denied = () => Object.assign(new Error('PRIVATE_PATH_UNVERIFIED'), { code: 'PRIVATE_PATH_UNVERIFIED' });
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;
function powershell(script, spawn = spawnSync) {
  return spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: windowsPowerShellEnvironment(), encoding: 'utf8', timeout: platformTimeout(15_000), maxBuffer: 64 * 1024, windowsHide: true });
}

// Windows mode bits do not describe a DACL. Read the actual ACL without changing
// existing files. SYSTEM and Administrators are the platform's trusted authority.
export function isPrivatePath(file, { platform = process.platform, spawn = spawnSync, privateMode = true, onUnproven } = {}) {
  if (platform !== 'win32') {
    try {
      const st = fs.lstatSync(file);
      const allowed = !st.isSymbolicLink() && (typeof process.getuid !== 'function' || st.uid === process.getuid())
        && (privateMode ? (st.mode & 0o777) === (st.isDirectory() ? 0o700 : 0o600) : (st.mode & 0o022) === 0);
      if (!allowed) onUnproven?.(`mode:${file} ${(st.mode & 0o7777).toString(8)}`);
      return allowed;
    } catch (error) { onUnproven?.(`stat:${file} ${error?.code ?? 'unknown'}`); return false; }
  }
  return arePrivatePaths([{ file, privateMode }], { platform, spawn, onUnproven });
}

// A path that cannot be proved is not the same claim as a path proved public,
// and callers that are told only "false" cannot tell the two apart. The verdict
// stays conservative either way; onUnproven carries the reason for the verdict.
export function arePrivatePaths(entries, { platform = process.platform, spawn = spawnSync, onUnproven } = {}) {
  const unproven = (reason) => { onUnproven?.(reason); return false; };
  if (platform !== 'win32') return entries.every(({ file, privateMode }) => isPrivatePath(file, { platform, privateMode, onUnproven }));
  try {
    const shape = entries.find(({ file }) => { const st = fs.lstatSync(file); return st.isSymbolicLink() || !(st.isFile() || st.isDirectory()); });
    if (shape) return unproven(`shape:${shape.file}`);
    const paths = entries.map(({ file }) => quote(file)).join(',');
    const script = `$ErrorActionPreference='Stop'; $id=[System.Security.Principal.WindowsIdentity]::GetCurrent(); $me=$id.User.Value; $tokenOwner=$id.Owner.Value; $proofs=@(); foreach($p in @(${paths})) { $a=Get-Acl -LiteralPath $p; $rules=@(); foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { $rules+=@{sid=$r.IdentityReference.Value;type=$r.AccessControlType.ToString();rights=[long]$r.FileSystemRights} }; $proofs+=@{user=$me;tokenOwner=$tokenOwner;owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;reparse=(([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0);rules=$rules} }; ConvertTo-Json -InputObject @($proofs) -Depth 5 -Compress`;
    const result = powershell(script, spawn);
    if (result.status !== 0 || String(result.stderr ?? '').trim()) {
      return unproven(`powershell:status=${result.status} error=${result.error?.code ?? 'none'} stderr=${String(result.stderr ?? '').trim().slice(0, 300)}`);
    }
    const proofs = JSON.parse(String(result.stdout ?? '').replace(/^\uFEFF/, ''));
    if (!Array.isArray(proofs) || proofs.length !== entries.length) return unproven(`proofs:${Array.isArray(proofs) ? proofs.length : typeof proofs}/${entries.length}`);
    const rejected = entries.findIndex((entry, i) => !privateAclAllowed(proofs[i], entry.privateMode ?? true));
    if (rejected !== -1) return unproven(`acl:${entries[rejected].file} ${JSON.stringify(proofs[rejected]).slice(0, 400)}`);
    return true;
  } catch (error) {
    // An exhausted deadline says nothing about the path. Reporting it as "not
    // private" turns a budget shortfall into a false privacy verdict.
    if (error?.code === 'STUDY_DESCRIPTOR_CORRUPT') throw error;
    return unproven(`error:${error?.code ?? error?.name ?? 'unknown'}`);
  }
}

const AUTHORITY = new Set(['S-1-5-18', 'S-1-5-32-544']);

// An elevated token creates objects owned by its default owner, not by the user
// SID: on an administrator account every plain mkdir/write lands on
// BUILTIN\Administrators. That owner counts as ours only when the token itself
// reports it as its own creation owner, and only for the platform authorities
// the DACL already trusts. Any other owner is a stranger's path.
export function ownedAclOwner({ owner, user, tokenOwner }) {
  if (typeof owner !== 'string' || !/^S-1-/.test(owner)) return false;
  if (owner === user) return true;
  return typeof tokenOwner === 'string' && tokenOwner === owner && AUTHORITY.has(owner);
}

// FileSystemRights: ReadData|ReadExtendedAttributes|ExecuteFile|ReadAttributes|
// ReadPermissions|Synchronize. Unknown and GENERIC_* bits are never read proof.
export function privateAclAllowed(proof, privateMode = true) {
  if (!proof || proof.reparse !== false || typeof proof.user !== 'string'
    || !/^S-1-/.test(proof.user) || !ownedAclOwner(proof) || !Array.isArray(proof.rules)) return false;
  const trusted = new Set([proof.user, ...AUTHORITY]);
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
