param([Parameter(Mandatory=$true)][string]$Payload, [int]$TimeoutMs = 2147483647)
$ErrorActionPreference = 'Stop'
try {
  if ($TimeoutMs -lt 1) { throw 'WINDOWS_OWNED_TIMEOUT_INVALID' }
  if ($Payload.Length -gt 32700) { throw 'WINDOWS_OWNED_PAYLOAD_TOO_LARGE' }
  $bytes = [Convert]::FromBase64String($Payload)
  if ($bytes.Length -gt 24576) { throw 'WINDOWS_OWNED_PAYLOAD_TOO_LARGE' }
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $spec = $utf8.GetString($bytes) | ConvertFrom-Json
  if ($null -eq $spec -or $spec -isnot [PSCustomObject]) { throw 'WINDOWS_OWNED_PAYLOAD_INVALID' }
  $keys = @($spec.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ',') -cne 'args,command,cwd') { throw 'WINDOWS_OWNED_PAYLOAD_INVALID' }
  if ($spec.command -isnot [string] -or $spec.cwd -isnot [string] -or $spec.args -isnot [Array]) { throw 'WINDOWS_OWNED_PAYLOAD_INVALID' }
  if ($spec.args.Count -gt 1024) { throw 'WINDOWS_OWNED_PAYLOAD_INVALID' }
  foreach ($value in @($spec.command, $spec.cwd) + $spec.args) {
    if ($value -isnot [string] -or $value.Length -gt 32760 -or $value.IndexOf([char]0) -ge 0) { throw 'WINDOWS_OWNED_PAYLOAD_INVALID' }
  }
  if (!$spec.command -or !$spec.cwd -or $spec.command -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or $spec.cwd -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or [IO.Path]::GetExtension($spec.command) -ine '.exe') { throw 'WINDOWS_OWNED_PAYLOAD_INVALID' }
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class OwnedJob {
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public IO io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults,total,active,terminated; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref Extended value,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,out Accounting value,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 static void Wait(IntPtr process,uint milliseconds) {
   uint result=WaitForSingleObject(process,milliseconds);
   if(result==0) return;
   if(result==258) throw new Exception("WINDOWS_JOB_TERMINATION_UNCONFIRMED");
   if(result==0xffffffff) Check(false);
   throw new Exception("WINDOWS_JOB_WAIT_INVALID");
 }
 static void Close(ref IntPtr handle) { if(handle!=IntPtr.Zero) { var owned=handle; handle=IntPtr.Zero; Check(CloseHandle(owned)); } }
 // CRT inverse, including backslashes preceding quotes/end; no shell is involved.
 static string Quote(string value) {
   var s=new StringBuilder("\""); int slash=0;
   foreach(char c in value) { if(c=='\\') { slash++; continue; } if(c=='"') { s.Append('\\',slash*2+1); s.Append(c); } else { s.Append('\\',slash); s.Append(c); } slash=0; }
   s.Append('\\',slash*2); return s.Append('"').ToString();
 }
 public static int Run(string command,string[] args,string cwd,int timeoutMs) {
   // Reject before creating any handle/process, independently of the JS caller.
   if(timeoutMs<1||String.IsNullOrEmpty(command)||String.IsNullOrEmpty(cwd)||args==null||args.Length>1024) throw new Exception("WINDOWS_OWNED_PAYLOAD_INVALID");
   foreach(var value in new string[]{command,cwd}) if(value.Length>32760||value.IndexOf('\0')>=0) throw new Exception("WINDOWS_OWNED_PAYLOAD_INVALID");
   var line=new StringBuilder(Quote(command));
   foreach(var arg in args) { if(arg==null||arg.Length>32760||arg.IndexOf('\0')>=0) throw new Exception("WINDOWS_OWNED_PAYLOAD_INVALID"); line.Append(' ').Append(Quote(arg)); }
   if(line.Length+1>32767) throw new Exception("WINDOWS_OWNED_COMMAND_TOO_LARGE");
   IntPtr job=IntPtr.Zero,attributes=IntPtr.Zero,jobList=IntPtr.Zero,handles=IntPtr.Zero; Info info=new Info(); bool initialized=false;
   try {
     job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
     var limits=new Extended(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway permission.
     Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
     var startup=new StartupEx(); startup.startup.cb=(uint)Marshal.SizeOf(typeof(StartupEx)); startup.startup.flags=0x100;
     startup.startup.input=GetStdHandle(-10); startup.startup.output=GetStdHandle(-11); startup.startup.error=GetStdHandle(-12);
     var std=new IntPtr[]{startup.startup.input,startup.startup.output,startup.startup.error};
     foreach(var handle in std) { Check(handle!=IntPtr.Zero&&handle!=new IntPtr(-1)); Check(SetHandleInformation(handle,1,1)); }
     IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
     Check(size.ToInt64()>0); attributes=Marshal.AllocHGlobal(size);
     Check(InitializeProcThreadAttributeList(attributes,2,0,ref size)); initialized=true;
     jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
     // JOB_LIST assigns atomically during process creation (Win10/Server2016+).
     // Unsupported systems fail here, before a payload process exists.
     Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
     handles=Marshal.AllocHGlobal(IntPtr.Size*3); for(int i=0;i<3;i++) Marshal.WriteIntPtr(handles,i*IntPtr.Size,std[i]);
     Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)); // HANDLE_LIST
     startup.attributes=attributes;
     Check(CreateProcess(command,line,IntPtr.Zero,IntPtr.Zero,true,0x00080004,IntPtr.Zero,cwd,ref startup,out info));
     bool inside; Check(IsProcessInJob(info.process,job,out inside)); if(!inside) throw new Exception("WINDOWS_JOB_ASSIGNMENT_UNCONFIRMED");
     Check(ResumeThread(info.thread)!=0xffffffff);
     uint waited=WaitForSingleObject(info.process,(uint)timeoutMs);
     if(waited==258) return 124;
     if(waited!=0) { if(waited==0xffffffff) Check(false); throw new Exception("WINDOWS_JOB_WAIT_INVALID"); }
     uint exit; Check(GetExitCodeProcess(info.process,out exit)); return unchecked((int)exit);
   } finally {
     try {
       if(job!=IntPtr.Zero) {
         Check(TerminateJobObject(job,125));
         if(info.process!=IntPtr.Zero) Wait(info.process,10000);
         var timer=Stopwatch.StartNew(); Accounting accounting;
         do {
           Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
           if(accounting.active==0) break;
           if(timer.ElapsedMilliseconds>=10000) throw new Exception("WINDOWS_JOB_TERMINATION_UNCONFIRMED");
           System.Threading.Thread.Sleep(10);
         } while(true);
       }
     } finally {
       try { Close(ref job); }
       finally {
         try { Close(ref info.thread); }
         finally {
           try { Close(ref info.process); }
           finally {
             if(initialized) DeleteProcThreadAttributeList(attributes);
             if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
             if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList);
             if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
           }
         }
       }
     }
   }
 }
}
'@
  $code = [OwnedJob]::Run([string]$spec.command, [string[]]$spec.args, [string]$spec.cwd, $TimeoutMs)
  exit $code
} catch {
  [Console]::Error.WriteLine('WINDOWS_OWNED_JOB_FAILED: ' + $_.Exception.Message)
  exit 125
}
