$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RelayWorkspaceHostObservation {
 [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
 public static string ForegroundKeyboardLayout() {uint pid;return GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(),out pid)).ToInt64().ToString("x");}
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int show);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct POINT {public int X,Y;}
 delegate bool EnumProc(IntPtr h,IntPtr state);
 public static long PlaceHiddenViewer(uint pid,string title,int x,int y) {
  IntPtr found=IntPtr.Zero;
  EnumWindows(delegate(IntPtr window,IntPtr data){uint owner;GetWindowThreadProcessId(window,out owner);
   if(owner!=pid)return true;var text=new StringBuilder(512);GetWindowText(window,text,text.Capacity);
   if(text.ToString()==title){found=window;return false;}return true;},IntPtr.Zero);
  if(found==IntPtr.Zero)throw new Exception("Owned viewer not found.");
  ShowWindow(found,0);
  // Move the invisible owned rectangle under the *stationary* physical pointer.
  // No global cursor, input or focus function is called.
  if(!SetWindowPos(found,IntPtr.Zero,x-200,y-200,1280,720,0x0010|0x0004|0x0080))throw new Exception("Cannot position hidden viewer.");
  if(IsWindowVisible(found))throw new Exception("Owned viewer unexpectedly visible.");
  return found.ToInt64();
 }
}
'@
$q=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__REQUEST__'))|ConvertFrom-Json
$point=New-Object RelayWorkspaceHostObservation+POINT
[RelayWorkspaceHostObservation]::GetPhysicalCursorPos([ref]$point)|Out-Null
$handle=$null
if([string]$q.op -eq 'place-hidden-viewer') {
 $d=$q.data
 if([string]$d.channel -notmatch '^mcp-relay-[a-f0-9]{16}$' -or [Diagnostics.Process]::GetCurrentProcess().SessionId -ne [int]$d.parentSession){throw 'Invalid owned parent session.'}
 $receipt=[IO.File]::ReadAllText(([string]$d.stateFile+'.owner.json'),[Text.Encoding]::UTF8)|ConvertFrom-Json
 $owner=[Diagnostics.Process]::GetProcessById([int]$receipt.pid)
 if($owner.HasExited -or $owner.SessionId -ne [int]$d.parentSession -or $owner.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne [string]$receipt.started){throw 'Owned viewer PID was reused.'}
 $cim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owner.Id)
 if([string]$cim.ExecutablePath -ine [string]$d.runtimeExe -or [string]$cim.CommandLine -notlike ('*'+[string]$d.channel+'*')){throw 'Owned viewer executable changed.'}
 $handle=[RelayWorkspaceHostObservation]::PlaceHiddenViewer([uint32]$owner.Id,('Anode seat ('+[string]$d.channel+')'),$point.X,$point.Y).ToString()
} elseif([string]$q.op -ne 'sample') {throw 'Unknown observation operation.'}
$console=[RelayWorkspaceHostObservation]::GetConsoleWindow()
@{foreground=[RelayWorkspaceHostObservation]::GetForegroundWindow().ToInt64().ToString();cursorX=$point.X;cursorY=$point.Y;
 clipboardSequence=[RelayWorkspaceHostObservation]::GetClipboardSequenceNumber();keyboardLayout=[RelayWorkspaceHostObservation]::ForegroundKeyboardLayout();consoleVisible=[RelayWorkspaceHostObservation]::IsWindowVisible($console);
 screens=@([Windows.Forms.Screen]::AllScreens|ForEach-Object{$_.DeviceName});hiddenViewerHandle=$handle}|ConvertTo-Json -Depth 5 -Compress
