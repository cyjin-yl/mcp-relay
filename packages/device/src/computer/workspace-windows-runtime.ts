import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { createConnection } from "node:net";
import { ComputerError, type NativeContext } from "./types.js";
import { nativeEnvironment, runNative } from "./native.js";
import { WINDOWS_WORKSPACE_NOTICES, WINDOWS_WORKSPACE_NOTICES_SHA256 } from "./workspace-windows-notices.js";

export const ANODE_SOURCE_COMMIT = "cbed84ff7465c0bd0310a3eec20c68046322fb53";
export const ANODE_RUNTIME_VERSION = "10.0.14";
// Filled only from the independently built, immutable runtime receipt.
export const ANODE_EXECUTABLE_SHA256 = "cccc59e3b86b0fdfcbe30b3dab8eea7266b104aa92ae29c79fc6d7fd9a3d978a";
export const ANODE_EXECUTABLE_BYTES = 76715503;
export const ANODE_RUNTIME_URL = "https://relay.cyjin.dev/updates/computer/windows/anode/" + ANODE_SOURCE_COMMIT + "/anode.exe";
export const ANODE_LICENSE = "MIT License\n\nCopyright (c) 2026 skulitom\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n";
export function windowsWorkspaceRoot(): string {
  return join(homedir(), ".mcp-relay", "computer", "windows");
}
export function anodeRuntimePath(): string {
  return join(windowsWorkspaceRoot(), "anode-" + ANODE_SOURCE_COMMIT, "anode.exe");
}
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
}
export async function verifyAnodeRuntime(path = anodeRuntimePath()): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(ANODE_EXECUTABLE_SHA256) || ANODE_EXECUTABLE_BYTES < 1) {
    throw new ComputerError("WORKSPACE_RUNTIME_UNFROZEN", "The Windows workspace runtime has not been frozen for this build.");
  }
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size !== ANODE_EXECUTABLE_BYTES
      || await sha256File(path) !== ANODE_EXECUTABLE_SHA256) {
    throw new ComputerError("WORKSPACE_SETUP_REQUIRED", "Run computer_setup to install the pinned Windows workspace runtime.");
  }
}
export function windowsPowerShell(): string {
  const key = Object.keys(process.env).find(k => k.toUpperCase() === "SYSTEMROOT");
  return win32.join(key ? process.env[key]! : "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
const NATIVE_CLASS = String.raw`
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.IO.Pipes;
public static class RelayWorkspaceNative {
 [DllImport("wtsapi32.dll",SetLastError=true)] public static extern bool WTSIsChildSessionsEnabled(out bool enabled);
 [DllImport("wtsapi32.dll",SetLastError=true)] public static extern bool WTSEnableChildSessions(bool enabled);
 [DllImport("wtsapi32.dll",SetLastError=true)] public static extern bool WTSGetChildSessionId(out uint id);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr state);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int capacity);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h,int cmd);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int hgt,uint flags);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT rect);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out POINT point);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 delegate bool EnumProc(IntPtr h,IntPtr state);
 public static string[] Arguments(string command) {
  int count;IntPtr p=CommandLineToArgvW(command,out count);if(p==IntPtr.Zero)throw new Exception("Cannot parse process command line.");
  try {var a=new string[count];for(int i=0;i<count;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;}finally{LocalFree(p);}
 }
 public static string Quote(string s) {
  var b=new StringBuilder("\"");int slashes=0;
  foreach(char c in s){if(c=='\\'){slashes++;continue;}if(c=='"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}
  b.Append('\\',slashes*2);return b.Append('"').ToString();
 }
 public static string Request(string pipeName,string request,int timeout) {
  using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous)){
   pipe.Connect(timeout);
   using(var w=new StreamWriter(pipe,new UTF8Encoding(false),4096,true))
   using(var r=new StreamReader(pipe,new UTF8Encoding(false),false,4096,true)){
    w.WriteLine(request);w.Flush();var task=r.ReadLineAsync();
    if(!task.Wait(timeout))throw new TimeoutException("Anode control request timed out.");
    string line=task.Result;if(line==null||line.Length>1024*1024)throw new IOException("Invalid control reply.");return line;
   }
  }
 }
 public static long ShowViewer(uint pid,string title,int x,int y,int w,int h) {
  IntPtr found=IntPtr.Zero;
  EnumWindows(delegate(IntPtr window,IntPtr state){
   uint owner;GetWindowThreadProcessId(window,out owner);if(owner!=pid)return true;
   var text=new StringBuilder(512);GetWindowText(window,text,text.Capacity);
   if(text.ToString()==title){found=window;return false;}return true;
  },IntPtr.Zero);
  if(found==IntPtr.Zero)return 0;
  // Showing the retained viewer must not steal the user's foreground focus.
  ShowWindowAsync(found,4);
  SetWindowPos(found,IntPtr.Zero,x,y,w,h,0x0010|0x0004|0x0040);
  return IsWindowVisible(found)?found.ToInt64():0;
 }
}
`;
const PS_PREFIX = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
` + NATIVE_CLASS + String.raw`
'@
function Get-OwnedViewer($c,[bool]$allowMissing=$false) {
 $matches=@()
 foreach($p in @(Get-CimInstance Win32_Process -Filter "Name='anode.exe'" -ErrorAction Stop)) {
  if([int]$p.SessionId -ne [int]$c.parentSession -or [string]$p.ExecutablePath -ine [string]$c.runtimeExe){continue}
  $a=[RelayWorkspaceNative]::Arguments([string]$p.CommandLine)
  if($a.Length -ge 4 -and $a[1] -ceq '--channel' -and $a[2] -ceq [string]$c.channel -and $a[3] -ceq 'up' -and $a -ccontains '--keep'){$matches+= $p}
 }
 if($matches.Count -eq 0 -and $allowMissing){return $null}
 if($matches.Count -ne 1){throw 'The owned Anode viewer process is absent or ambiguous.'}
 $receipt=[string]$c.stateFile+'.owner.json'
 if([IO.File]::Exists($receipt)) {
  $identity=[IO.File]::ReadAllText($receipt,[Text.Encoding]::UTF8)|ConvertFrom-Json
  $process=[Diagnostics.Process]::GetProcessById([int]$matches[0].ProcessId)
  if($process.Id -ne [int]$identity.pid -or $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -cne [string]$identity.started){throw 'The owned viewer process identity changed.'}
 }
 return $matches[0]
}
function Show-OwnedViewer($c) {
 $p=Get-OwnedViewer $c
 Add-Type -AssemblyName System.Windows.Forms
 $primary=[Windows.Forms.Screen]::PrimaryScreen
 if($null -eq $primary){throw 'No physical parent-session screen is available for handoff.'}
 $r=$primary.WorkingArea
 $w=[Math]::Min(1200,[Math]::Max(100,$r.Width-48));$h=[Math]::Min(800,[Math]::Max(100,$r.Height-48))
 $handle=[RelayWorkspaceNative]::ShowViewer([uint32]$p.ProcessId,('Anode seat ('+[string]$c.channel+')'),$r.Left+24,$r.Top+24,$w,$h)
 if($handle -eq 0){throw 'The retained child-session viewer could not be shown.'}
 return @{viewerPid=[int]$p.ProcessId;viewerHandle=$handle.ToString();viewerVisible=$true;monitor=$primary.DeviceName}
}
function Start-SessionTask([string]$taskName,[string]$exe,[string[]]$arguments,[int]$session) {
 $service=New-Object -ComObject Schedule.Service;$service.Connect()
 $root=$service.GetFolder('\');$task=$service.NewTask(0)
 $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
 $task.RegistrationInfo.Author='mcp-relay'
 $task.RegistrationInfo.Description='mcp-relay owned isolated workspace runtime'
 $task.Principal.UserId=$account;$task.Principal.LogonType=3;$task.Principal.RunLevel=0
 $task.Settings.Enabled=$true;$task.Settings.Hidden=$true;$task.Settings.AllowDemandStart=$true
 $task.Settings.DisallowStartIfOnBatteries=$false;$task.Settings.StopIfGoingOnBatteries=$false
 $task.Settings.ExecutionTimeLimit='PT0S';$task.Settings.MultipleInstances=2
 $action=$task.Actions.Create(0);$action.Path=$exe
 $action.Arguments=(@($arguments|ForEach-Object{[RelayWorkspaceNative]::Quote([string]$_)}) -join ' ')
 $action.WorkingDirectory=[IO.Path]::GetDirectoryName($exe)
 $registered=$root.RegisterTaskDefinition($taskName,$task,2,$account,$null,3,$null)
 try {
  $running=$registered.RunEx($null,4,$session,$null)
  if($null -eq $running){throw 'The workspace scheduled task did not start.'}
 } finally {$root.DeleteTask($taskName,0)}
}

function Write-PrivateArtifact([string]$path,$value) {
 $temp=$path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 [IO.File]::WriteAllText($temp,($value|ConvertTo-Json -Depth 12 -Compress),(New-Object Text.UTF8Encoding($false)))
 if([IO.File]::Exists($path)){[IO.File]::Replace($temp,$path,[NullString]::Value)}else{[IO.File]::Move($temp,$path)}
}
function Get-ChildSession {
 [uint32]$child=0
 if(-not [RelayWorkspaceNative]::WTSGetChildSessionId([ref]$child)) {
  $childError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if($childError -ne 1168 -or $child -ne [uint32]::MaxValue){throw ('Cannot inspect the child session: '+$childError)}
 }
 if($child -eq [uint32]::MaxValue){return $null}
 return [int]$child
}
function Read-WorkspaceState([string]$path) {
 $c=[IO.File]::ReadAllText($path,[Text.Encoding]::UTF8)|ConvertFrom-Json
 if([string]$c.stateFile -cne $path -or [string]$c.channel -notmatch '^mcp-relay-[a-f0-9]{16}$' -or [int]$c.parentSession -le 0 -or -not [IO.Path]::IsPathRooted([string]$c.revocationPath)){throw 'Invalid workspace ownership state.'}
 return $c
}
function Test-WorkspaceRevoked($c) {
 return ([IO.File]::Exists([string]$c.revocationPath) -or [IO.File]::Exists(([string]$c.stateFile+'.revoked.json')))
}
function Set-WorkspaceRevoked($c,[string]$reason) {
 $path=[string]$c.stateFile+'.revoked.json'
 $stream=$null
 try {
  $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $bytes=[Text.Encoding]::UTF8.GetBytes((@{schema=1;leaseId=$c.leaseId;instanceId=$c.instanceId;reason=$reason;revokedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
  $stream.Write($bytes,0,$bytes.Length);$stream.Flush()
 } catch [IO.IOException] {if(-not [IO.File]::Exists($path)){throw}}
 finally {if($null -ne $stream){$stream.Dispose()}}
}
function Enter-WorkspaceGate($c) {
 $clock=[Diagnostics.Stopwatch]::StartNew()
 while($clock.ElapsedMilliseconds -lt 5000) {
  try {return [IO.File]::Open(([string]$c.stateFile+'.gate'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
  catch [IO.IOException] {Start-Sleep -Milliseconds 25}
 }
 throw 'The workspace creation/recovery gate is busy.'
}
function Assert-Creating($c) {
 if(Test-WorkspaceRevoked $c){throw 'Workspace creation has been permanently revoked.'}
 if([string]$c.phase -cne 'preparing'){throw 'Workspace is no longer preparing.'}
 $wall=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 if($wall -ge [Math]::Min([double]$c.expiresAt,[double]$c.hardExpiresAt)){throw 'Workspace creation authorization expired.'}
 $broker=[Diagnostics.Process]::GetProcessById([int]$c.brokerPid)
 if($broker.HasExited -or $broker.SessionId -ne [int]$c.parentSession -or $broker.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -cne [string]$c.brokerStarted){throw 'The workspace broker identity is no longer alive.'}
}
function Call-Anode($c,$q) {
 $q.timeoutMs=1500
 $reply=[RelayWorkspaceNative]::Request(('anode-control-'+[string]$c.channel),($q|ConvertTo-Json -Depth 8 -Compress),1800)|ConvertFrom-Json
 if(-not $reply.ok){throw [string]$reply.error}
 return $reply.result
}
function Invoke-WorkspaceRecovery($c,[string]$reason) {
 # A permanent marker plus the same OS file lock as the owner prevents late creation
 # after no-resources is reported. Neither marker is removed by a renewed heartbeat.
 Set-WorkspaceRevoked $c $reason
 $gate=Enter-WorkspaceGate $c
 try {
  $owner=Get-OwnedViewer $c $true
  $child=Get-ChildSession
  if($null -eq $owner) {
   if($null -eq $child){return @{complete=$true;inputRevoked=$true;ownedDisplayRemoved=$true;outcome='no-resources';reason=$reason}}
   throw 'The viewer is absent while a child session remains; applications are preserved.'
  }
  $status=Call-Anode $c @{op='status';agentId=[string]$c.agentId}
  if([int]$status.parentSession -ne [int]$c.parentSession -or [string]$status.channel -cne [string]$c.channel){throw 'Owned channel identity changed.'}
  if($c.childSession -and [int]$status.session -ne [int]$c.childSession){throw 'Owned child session changed.'}
  if($null -eq $child -and $null -eq $status.session -and -not $status.agentReady -and $null -eq $status.seat -and -not $c.childSession) {
   # Only a verified, failed startup with no child/host can be dismissed.
   # --keep is validated by Get-OwnedViewer; quit cannot log off a late child.
   $process=[Diagnostics.Process]::GetProcessById([int]$owner.ProcessId)
   Call-Anode $c @{op='quit'}|Out-Null
   if(-not $process.WaitForExit(2500)){throw 'The empty owned viewer is still closing.'}
   if($null -ne (Get-ChildSession)){throw 'A late child session remains; applications are preserved.'}
   return @{complete=$true;inputRevoked=$true;ownedDisplayRemoved=$true;outcome='no-resources';reason=$reason;failedStartupDismissed=$true;nativeError=$status.lastError}
  }
  $token=[string]$c.leaseToken
  $receipt=[string]$c.stateFile+'.lease.json'
  if(-not $token -and [IO.File]::Exists($receipt)) {
   $lease=[IO.File]::ReadAllText($receipt,[Text.Encoding]::UTF8)|ConvertFrom-Json
   if([string]$lease.ownerAgentId -cne [string]$c.agentId){throw 'The native lease receipt identity changed.'}
   $token=[string]$lease.leaseToken
  }
  if($token) {
   try {Call-Anode $c @{op='lease';action='release';agentId=[string]$c.agentId;leaseToken=$token;cancelJobs=$false}|Out-Null}catch{}
  }
  Call-Anode $c @{op='seat.control';viewOnly=$true}|Out-Null
  $status=Call-Anode $c @{op='status';agentId=[string]$c.agentId}
  $hasLease=($null -ne $status.lease -and $null -ne $status.lease.PSObject.Properties['ownerAgentId'])
  $revoked=($hasLease -and [string]$status.lease.ownerAgentId -cne [string]$c.agentId)
  $view=Show-OwnedViewer $c
  $complete=($revoked -and $status.viewOnly -eq $true -and $view.viewerVisible -eq $true)
  return @{complete=$complete;inputRevoked=$revoked;ownedDisplayRemoved=$false;outcome=if($complete){'handoff-viewer'}else{'cleanup-pending'};reason=$reason;viewer=$view;childSession=$status.session;appsPreserved=$true;windowsMovedBetweenSessions=$false}
 } finally {$gate.Dispose()}
}
`;
export async function windowsWorkspaceNative(request: Record<string, unknown>, context: NativeContext): Promise<Record<string, unknown>> {
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const code = PS_PREFIX + String.raw`
try {
 $q=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('` + payload + String.raw`'))|ConvertFrom-Json
 switch([string]$q.op) {
  'inspect' {
   $enabled=$false;if(-not [RelayWorkspaceNative]::WTSIsChildSessionsEnabled([ref]$enabled)){throw 'Cannot inspect child-session support.'}
   $self=[Diagnostics.Process]::GetCurrentProcess()
   $child=if($self.SessionId -gt 0){Get-ChildSession}else{$null}
   $broker=[Diagnostics.Process]::GetProcessById([int]$q.brokerPid)
   $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
   $result=@{enabled=$enabled;childSession=$child;childSessionKnown=($self.SessionId -gt 0);scriptHostAvailable=[IO.File]::Exists([IO.Path]::Combine($env:WINDIR,'System32','wscript.exe'));
    parentSession=$self.SessionId;interactive=[Environment]::UserInteractive;brokerSession=$broker.SessionId;
    brokerStarted=$broker.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);
    elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
    sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
  }
  'protect' {
   $directory=[string]$q.directory
   [IO.Directory]::CreateDirectory($directory)|Out-Null
   $security=New-Object Security.AccessControl.DirectorySecurity
   $security.SetAccessRuleProtection($true,$false)
   $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
   foreach($identity in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $security.AddAccessRule($rule)
   }
   [IO.Directory]::SetAccessControl($directory,$security)
   $result=@{protected=$true}
  }
  'launch' {
   if([Diagnostics.Process]::GetCurrentProcess().SessionId -ne [int]$q.parentSession -or [int]$q.parentSession -le 0){throw 'Workspace creation must run inside its interactive parent session.'}
   Start-SessionTask ([string]$q.taskName) ([string]$q.executable) ([string[]]$q.arguments) ([int]$q.parentSession)
   $result=@{started=$true}
  }
  'handoff' {$result=Show-OwnedViewer $q}
  'guardian-check' {
   $c=Read-WorkspaceState ([string]$q.stateFile)
   $ready=[IO.File]::ReadAllText(([string]$c.stateFile+'.guardian-ready.json'),[Text.Encoding]::UTF8)|ConvertFrom-Json
   $guardian=[Diagnostics.Process]::GetProcessById([int]$ready.pid)
   if($guardian.HasExited -or $guardian.SessionId -ne [int]$c.parentSession -or [string]$ready.instanceId -cne [string]$c.instanceId -or $guardian.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -cne [string]$ready.started){throw 'The independent guardian did not remain alive.'}
   $result=@{ready=$true;guardianPid=$guardian.Id}
  }
  'lease-acquire' {
   $c=Read-WorkspaceState ([string]$q.stateFile);$gate=Enter-WorkspaceGate $c
   try {
    Assert-Creating $c
    Get-OwnedViewer $c|Out-Null
    $lease=Call-Anode $c @{op='lease';action='acquire';agentId=[string]$c.agentId;agentName='mcp-relay workspace';ttlSeconds=10;waitSeconds=0;startSeat=$false;clientPid=[int]$c.brokerPid;clientStarted=[long]$c.brokerStarted}
    if([string]$lease.ownerAgentId -cne [string]$c.agentId -or -not $lease.leaseToken){throw 'The native runtime refused the owned lease.'}
    Write-PrivateArtifact ([string]$c.stateFile+'.lease.json') $lease
    $result=$lease
   } finally {$gate.Dispose()}
  }
  'recover' {
   $c=Read-WorkspaceState ([string]$q.stateFile)
   if([Diagnostics.Process]::GetCurrentProcess().SessionId -ne [int]$c.parentSession){throw 'Recovery must run in the owned parent session.'}
   $result=Invoke-WorkspaceRecovery $c ([string]$q.reason)
   Write-PrivateArtifact ([string]$c.stateFile+'.recovery.json') $result
  }
  default {throw 'Unsupported workspace native operation.'}
 }
 @{ok=$true;result=$result}|ConvertTo-Json -Depth 8 -Compress
} catch {
 @{ok=$false;error=$_.Exception.GetBaseException().Message}|ConvertTo-Json -Depth 4 -Compress
 exit 1
}
`;
  const loader = "$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);" +
    "Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop;" +
    "& ([scriptblock]::Create([Console]::In.ReadToEnd()))";
  const result = await runNative({ command: windowsPowerShell(), args: ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-EncodedCommand", Buffer.from(loader, "utf16le").toString("base64")], input: code, env: nativeEnvironment(),
    maxOutputBytes: 256 * 1024 }, context);
  let response: { ok?: boolean; result?: Record<string, unknown>; error?: string };
  try { response = JSON.parse(result.stdout.toString("utf8").replace(/^\uFEFF/, "").trim()); }
  catch { throw new ComputerError("WORKSPACE_NATIVE_ERROR", "The Windows workspace helper returned invalid output.", { exitCode: result.exitCode }); }
  if (!response.ok || result.exitCode !== 0 || !response.result) throw new ComputerError("WORKSPACE_NATIVE_ERROR",
    response.error ?? "The Windows workspace helper failed.");
  return response.result;
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
/** FILETIME is a 64-bit integer, outside JavaScript's exact Number range. */
export function serializeAnodeRequest(request: Record<string, unknown>): string {
  if (request.clientStarted !== undefined && (typeof request.clientStarted !== "string"
      || !/^[1-9][0-9]{14,18}$/.test(request.clientStarted)
      || BigInt(request.clientStarted) > 9223372036854775807n)) {
    throw new ComputerError("WORKSPACE_IDENTITY_INVALID", "Invalid native client process creation time.");
  }
  return JSON.stringify(request).replace(/"clientStarted":"([0-9]+)"/, '"clientStarted":$1') + "\n";
}
export async function anodeRequest(channel: string, request: Record<string, unknown>, context: NativeContext): Promise<Record<string, unknown>> {
  if (!/^mcp-relay-[a-f0-9]{16}$/.test(channel)) throw new ComputerError("WORKSPACE_IDENTITY_INVALID", "Invalid owned Anode channel.");
  if (context.signal?.aborted) throw new ComputerError("cancelled", "The workspace request was cancelled.", { mayHaveApplied: false });
  const timeout = Math.max(1, Math.min(120000, context.timeoutMs));
  const payload = serializeAnodeRequest({ ...request, timeoutMs: Math.max(1, timeout - 100) });
  return new Promise((resolve, reject) => {
    let done = false, bytes = 0, sent = false, data = "";
    const socket = createConnection("\\\\.\\pipe\\anode-control-" + channel);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (done) return; done = true; clearTimeout(timer); context.signal?.removeEventListener("abort", abort);
      socket.destroy(); error ? reject(error) : resolve(value ?? {});
    };
    const abort = () => finish(new ComputerError("cancelled", "The isolated workspace request was cancelled.", { mayHaveApplied: sent }));
    const timer = setTimeout(() => finish(new ComputerError("WORKSPACE_TIMEOUT", "The isolated workspace request timed out; do not replay uncertain input.",
      { mayHaveApplied: sent })), timeout);
    socket.setEncoding("utf8");
    socket.once("connect", () => { sent = true; socket.write(payload); });
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 24 * 1024 * 1024) { finish(new ComputerError("WORKSPACE_OUTPUT_LIMIT", "The isolated desktop response exceeded its size limit.")); return; }
      data += chunk; const end = data.indexOf("\n"); if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end)) as { ok?: boolean; result?: Record<string, unknown>; error?: string; errorCode?: string; started?: boolean };
        if (response.ok !== true) finish(new ComputerError(response.errorCode ?? "WORKSPACE_NATIVE_ERROR",
          response.error ?? "Anode rejected the isolated desktop operation.", { mayHaveApplied: response.started === true }));
        else finish(undefined, response.result ?? {});
      } catch { finish(new ComputerError("WORKSPACE_PROTOCOL_ERROR", "The isolated desktop returned invalid JSON.")); }
    });
    socket.once("error", () => finish(new ComputerError("WORKSPACE_UNAVAILABLE", "The owned isolated desktop control channel is unavailable.", { mayHaveApplied: sent })));
    socket.once("end", () => { if (!done) finish(new ComputerError("WORKSPACE_PROTOCOL_ERROR", "The isolated desktop closed without a complete response.", { mayHaveApplied: sent })); });
    context.signal?.addEventListener("abort", abort, { once: true });
  });
}
export async function installAnodeRuntime(context: NativeContext): Promise<Record<string, unknown>> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new ComputerError("WORKSPACE_UNSUPPORTED", "This runtime requires Windows x64.");
  let alreadyInstalled = false;
  try { await verifyAnodeRuntime(); alreadyInstalled = true; }
  catch (error) { if (!(error instanceof ComputerError) || error.code !== "WORKSPACE_SETUP_REQUIRED") throw error; }
  const directory = win32.dirname(anodeRuntimePath());
  if (alreadyInstalled) {
    await writeFile(win32.join(directory, "LICENSE.Anode.txt"), ANODE_LICENSE, { mode: 0o600 });
    await writeFile(win32.join(directory, "THIRD-PARTY-NOTICES.txt"), WINDOWS_WORKSPACE_NOTICES, { mode: 0o600 });
    return { installed: true, changed: false, runtime: "Anode 0.11.5", sourceCommit: ANODE_SOURCE_COMMIT, noticesSha256: WINDOWS_WORKSPACE_NOTICES_SHA256 };
  }
  await windowsWorkspaceNative({ op: "protect", directory }, context);
  const signal = AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(Math.max(1, Math.min(context.timeoutMs, 120000)))]);
  const response = await fetch(ANODE_RUNTIME_URL, { signal, redirect: "error" });
  if (!response.ok || !response.body) throw new ComputerError("WORKSPACE_DOWNLOAD_FAILED", "The pinned Windows workspace runtime could not be downloaded.");
  const advertised = response.headers.get("content-length");
  if (advertised && Number(advertised) !== ANODE_EXECUTABLE_BYTES) throw new ComputerError("WORKSPACE_RUNTIME_INTEGRITY", "The runtime size did not match the frozen receipt.");
  const chunks: Buffer[] = []; let count = 0;
  for await (const bytes of response.body) {
    count += bytes.length;
    if (count > ANODE_EXECUTABLE_BYTES) throw new ComputerError("WORKSPACE_RUNTIME_INTEGRITY", "The runtime exceeded its frozen size.");
    chunks.push(Buffer.from(bytes));
  }
  const executable = Buffer.concat(chunks, count);
  if (count !== ANODE_EXECUTABLE_BYTES || createHash("sha256").update(executable).digest("hex") !== ANODE_EXECUTABLE_SHA256)
    throw new ComputerError("WORKSPACE_RUNTIME_INTEGRITY", "The runtime did not match its frozen SHA-256.");
  const temporary = anodeRuntimePath() + "." + randomUUID() + ".tmp";
  await writeFile(temporary, executable, { flag: "wx", mode: 0o700 });
  await rename(temporary, anodeRuntimePath());
  await writeFile(join(directory, "LICENSE.Anode.txt"), ANODE_LICENSE, { mode: 0o600 });
  await writeFile(join(directory, "THIRD-PARTY-NOTICES.txt"), WINDOWS_WORKSPACE_NOTICES, { mode: 0o600 });
  await writePrivateJson(join(directory, "runtime.json"), { schema: 1, version: "0.11.5", sourceCommit: ANODE_SOURCE_COMMIT,
    dotnetRuntime: ANODE_RUNTIME_VERSION, sha256: ANODE_EXECUTABLE_SHA256, bytes: ANODE_EXECUTABLE_BYTES,
    noticesSha256: WINDOWS_WORKSPACE_NOTICES_SHA256 });
  return { installed: true, changed: true, runtime: "Anode 0.11.5", sourceCommit: ANODE_SOURCE_COMMIT,
    childSessionsRequireExplicitAdministratorSetup: true, configurationChanged: false };
}
export const WINDOWS_WORKSPACE_OWNER = String.raw`param([Parameter(Mandatory=$true)][string]$StatePath)
` + PS_PREFIX + String.raw`
$c=Read-WorkspaceState $StatePath
if([Diagnostics.Process]::GetCurrentProcess().SessionId -ne [int]$c.parentSession){exit 2}
$gate=Enter-WorkspaceGate $c
try {
 # Re-read inside the gate: the scheduled task may have started after close/recovery.
 $c=Read-WorkspaceState $StatePath
 Assert-Creating $c
 $guardian=[IO.File]::ReadAllText(($StatePath+'.guardian-ready.json'),[Text.Encoding]::UTF8)|ConvertFrom-Json
 $g=[Diagnostics.Process]::GetProcessById([int]$guardian.pid)
 if($g.HasExited -or $g.SessionId -ne [int]$c.parentSession -or [string]$guardian.instanceId -cne [string]$c.instanceId -or $g.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -cne [string]$guardian.started){throw 'The independent workspace guardian is not alive.'}
 if($null -ne (Get-ChildSession)){throw 'An existing child session will not be replaced.'}
 if($null -ne (Get-OwnedViewer $c $true)){throw 'An owned viewer already exists.'}
 $arguments=@('--channel',[string]$c.channel,'up','--keep','--no-background-rendering','--width',[string]$c.width,'--height',[string]$c.height,'--scale','100','--state-dir',[IO.Path]::GetDirectoryName($StatePath))
 if($c.interactiveSignIn -eq $true){$arguments+= '--sign-in'}else{$arguments+= '--hidden'}
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=[string]$c.runtimeExe
 $start.Arguments=(@($arguments|ForEach-Object{[RelayWorkspaceNative]::Quote([string]$_)}) -join ' ')
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.WindowStyle=if($c.interactiveSignIn -eq $true){[Diagnostics.ProcessWindowStyle]::Normal}else{[Diagnostics.ProcessWindowStyle]::Hidden}
 $start.WorkingDirectory=[IO.Path]::GetDirectoryName([string]$c.runtimeExe)
 Assert-Creating (Read-WorkspaceState $StatePath)
 $process=[Diagnostics.Process]::Start($start)
 if($null -eq $process){throw 'The owned runtime did not start.'}
 Write-PrivateArtifact ($StatePath+'.owner.json') @{pid=$process.Id;started=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);instanceId=$c.instanceId;channel=$c.channel;parentSession=$c.parentSession}
} catch {
 Write-PrivateArtifact ($StatePath+'.owner-error.json') @{error=$_.Exception.GetBaseException().Message;instanceId=$c.instanceId}
 exit 1
} finally {$gate.Dispose()}
`;
export const WINDOWS_WORKSPACE_GUARDIAN = String.raw`param([Parameter(Mandatory=$true)][string]$StatePath)
` + PS_PREFIX + String.raw`
$c=Read-WorkspaceState $StatePath
if([Diagnostics.Process]::GetCurrentProcess().SessionId -ne [int]$c.parentSession){exit 2}
$self=[Diagnostics.Process]::GetCurrentProcess()
$clock=[Diagnostics.Stopwatch]::StartNew();$sequence=-1;$heartbeatDeadline=0
$wall=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$hardDeadline=[Math]::Max(0,[double]$c.hardExpiresAt-$wall)
$expiry=[double]$c.expiresAt;$expiryDeadline=[Math]::Max(0,[Math]::Min($hardDeadline,$expiry-$wall))
Write-PrivateArtifact ($StatePath+'.guardian-ready.json') @{pid=$self.Id;started=$self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);instanceId=$c.instanceId;parentSession=$c.parentSession}
$reason='lease_expired'
while($true) {
 try {
  $next=Read-WorkspaceState $StatePath
  if([string]$next.instanceId -cne [string]$c.instanceId -or [string]$next.channel -cne [string]$c.channel){$reason='identity_changed';break}
  if([long]$next.sequence -gt $sequence) {
   $c=$next;$sequence=[long]$c.sequence
   $heartbeatDeadline=$clock.ElapsedMilliseconds+10000
   if([double]$c.expiresAt -ne $expiry) {
    $expiry=[double]$c.expiresAt
    $expiryDeadline=[Math]::Min($hardDeadline,$clock.ElapsedMilliseconds+[Math]::Max(0,$expiry-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))
   }
  }
  if(Test-WorkspaceRevoked $c){$reason='revoked';break}
  $broker=[Diagnostics.Process]::GetProcessById([int]$c.brokerPid)
  if($broker.HasExited -or $broker.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -cne [string]$c.brokerStarted){$reason='owner_lost';break}
  if([string]$c.phase -ceq 'handoff'){$reason=[string]$c.closeReason;break}
  if($clock.ElapsedMilliseconds -ge [Math]::Min($heartbeatDeadline,[Math]::Min($expiryDeadline,$hardDeadline))){break}
 } catch {$reason='owner_lost';break}
 Start-Sleep -Milliseconds 250
}
# This independent guardian has no input action route and never logs off a child.
Set-WorkspaceRevoked $c $reason
$tries=0
while($true) {
 $tries++
 try {
  $result=Invoke-WorkspaceRecovery $c $reason
  Write-PrivateArtifact ($StatePath+'.recovery.json') $result
  if($result.complete){exit 0}
 } catch {
  Write-PrivateArtifact ($StatePath+'.recovery.json') @{complete=$false;inputRevoked=$false;ownedDisplayRemoved=$false;outcome='cleanup-pending';reason=$reason;error=$_.Exception.GetBaseException().Message;attempts=$tries}
 }
 Start-Sleep -Seconds 1
}
`;
export const WINDOWS_HIDDEN_LAUNCHER = String.raw`Option Explicit
Dim shell, command, i, code
If WScript.Arguments.Count < 1 Then WScript.Quit 2
Function Quote(value)
 Dim result, slashes, position, ch
 result = Chr(34): slashes = 0
 For position = 1 To Len(value)
  ch = Mid(value, position, 1)
  If ch = "\" Then
   slashes = slashes + 1
  ElseIf ch = Chr(34) Then
   result = result & String(slashes * 2 + 1, "\") & Chr(34): slashes = 0
  Else
   result = result & String(slashes, "\") & ch: slashes = 0
  End If
 Next
 Quote = result & String(slashes * 2, "\") & Chr(34)
End Function
command = Quote(WScript.Arguments(0))
For i = 1 To WScript.Arguments.Count - 1
 command = command & " " & Quote(WScript.Arguments(i))
Next
On Error Resume Next
Set shell = CreateObject("WScript.Shell")
code = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 1
WScript.Quit code
`;

export function windowsScriptHost(): string {
  return win32.resolve(windowsPowerShell(), "..", "..", "..", "wscript.exe");
}
export function hiddenPowerShellArguments(scriptPath: string, statePath: string): string[] {
  const encodedPath = (path: string) => "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(path, "utf8").toString("base64") + "'))";
  // This uses the same reviewed scriptblock execution as runNative; no machine
  // execution policy, credentials, profile or console is changed.
  const loader = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
    "& ([scriptblock]::Create([IO.File]::ReadAllText(" + encodedPath(scriptPath) + ",[Text.Encoding]::UTF8))) -StatePath (" + encodedPath(statePath) + ")";
  return [windowsPowerShell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
    "-EncodedCommand", Buffer.from(loader, "utf16le").toString("base64")];
}
export async function writeWindowsWorkspaceHelpers(directory: string): Promise<void> {
  await writeFile(join(directory, "guardian.ps1"), WINDOWS_WORKSPACE_GUARDIAN, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "owner.ps1"), WINDOWS_WORKSPACE_OWNER, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "hidden-launcher.vbs"), WINDOWS_HIDDEN_LAUNCHER, { mode: 0o600, flag: "wx" });
}
export async function writeWindowsWorkspaceRevocation(path: string, reason: string): Promise<void> {
  try { await writeFile(path, JSON.stringify({ schema: 1, reason, revokedAt: Date.now() }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
