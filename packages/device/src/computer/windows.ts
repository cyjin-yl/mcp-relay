import { win32 } from "node:path";
import { findExecutable, pngDimensions, runNative } from "./native.js";
import { ComputerError, nativePoint, type ComputerAction, type ComputerBackend, type ComputerDisplay,
  type ComputerState, type NativeContext } from "./types.js";

// Win32 contracts: SendInput is subject to UIPI; input desktops and session state
// must be checked independently. No desktop switching or privilege escalation.
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-openinputdesktop

const WINDOWS_NATIVE = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$utf8=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=$utf8
$OutputEncoding=$utf8
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class RelayWinDesktop {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct MONITORINFO {
  public int cbSize; public RECT monitor,work; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device;
 }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION {
  [FieldOffset(0)] public MOUSEINPUT mouse;
  [FieldOffset(0)] public KEYBDINPUT keyboard;
 }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
 public delegate bool MonitorProc(IntPtr monitor,IntPtr hdc,ref RECT rect,IntPtr data);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll",SetLastError=true)] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorProc callback,IntPtr data);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetMonitorInfo(IntPtr monitor,ref MONITORINFO info);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int metric);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder value,uint length,out uint needed);
 [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int field,out IntPtr value,out uint length);
 [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr value);
 [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int capacity);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] events,int size);
 [DllImport("user32.dll")] static extern bool GetPhysicalCursorPos(out POINT point);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,uint size,out uint needed);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 public class Display {
  public string id,name; public int x,y,width,height; public double scaleX=1,scaleY=1; public bool primary;
 }
 static Exception Fault(string code,string message) { var e=new InvalidOperationException(message);e.Data["code"]=code;return e; }
 public static void Dpi() {
  try {
   if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero &&
      SetThreadDpiAwarenessContext(new IntPtr(-3))==IntPtr.Zero)
    throw Fault("DPI_UNAVAILABLE","Windows could not enable per-monitor physical-pixel coordinates.");
  } catch(EntryPointNotFoundException) { throw Fault("DPI_UNAVAILABLE","This backend requires Windows 10 1607 or newer for per-monitor coordinates."); }
 }
 static string ObjectName(IntPtr handle) {
  if(handle==IntPtr.Zero)return "";uint needed;var value=new StringBuilder(512);
  return GetUserObjectInformation(handle,2,value,(uint)(value.Capacity*2),out needed)?value.ToString():"";
 }
 public static string DesktopReason() {
  int session=Process.GetCurrentProcess().SessionId;
  if(session==0 || !Environment.UserInteractive)return "The relay is not in an interactive user session (Session 0/service/SSH context).";
  IntPtr state;uint size;bool active=false;
  if(WTSQuerySessionInformation(IntPtr.Zero,session,8,out state,out size)) {
   try { active=size>=4 && Marshal.ReadInt32(state)==0; } finally { WTSFreeMemory(state); }
  } else active=(uint)session==WTSGetActiveConsoleSessionId();
  if(!active)return "The Windows user session is disconnected or not active.";
  if(!String.Equals(ObjectName(GetProcessWindowStation()),"WinSta0",StringComparison.OrdinalIgnoreCase))
   return "The process is not attached to the interactive window station.";
  IntPtr desktop=OpenInputDesktop(0,false,1|128);
  if(desktop==IntPtr.Zero)return "The current input desktop is unavailable, locked, or protected by UAC.";
  try {
   string input=ObjectName(desktop),current=ObjectName(GetThreadDesktop(GetCurrentThreadId()));
   if(!String.Equals(input,"Default",StringComparison.OrdinalIgnoreCase) ||
      !String.Equals(input,current,StringComparison.OrdinalIgnoreCase))
    return "The active desktop is locked/secure or differs from this process desktop.";
  } finally { CloseDesktop(desktop); }
  return null;
 }
 public static void RequireDesktop() { Dpi();string reason=DesktopReason();if(reason!=null)throw Fault("INTERACTIVE_SESSION_REQUIRED",reason); }
 public static Display[] Displays() {
  Dpi();var displays=new List<Display>();
  MonitorProc callback=delegate(IntPtr monitor,IntPtr hdc,ref RECT rect,IntPtr data) {
   var info=new MONITORINFO();info.cbSize=Marshal.SizeOf(typeof(MONITORINFO));
   if(!GetMonitorInfo(monitor,ref info))return true;
   displays.Add(new Display{id=info.device,name=info.device,x=info.monitor.left,y=info.monitor.top,
    width=info.monitor.right-info.monitor.left,height=info.monitor.bottom-info.monitor.top,primary=(info.flags&1)!=0});
   return true;
  };
  if(!EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,callback,IntPtr.Zero))throw Fault("DISPLAY_ENUMERATION_FAILED","Windows display enumeration failed.");
  return displays.ToArray();
 }
 public static Display DisplayById(string id) {
  Display[] displays=Displays();
  foreach(Display d in displays)if(d.id==id || (String.IsNullOrEmpty(id)&&d.primary))return d;
  if(String.IsNullOrEmpty(id)&&displays.Length>0)return displays[0];
  throw Fault("DISPLAY_NOT_FOUND","The requested Windows display is no longer connected.");
 }
 public static Dictionary<string,object> App() {
  IntPtr window=GetForegroundWindow();uint pid=0;GetWindowThreadProcessId(window,out pid);
  var title=new StringBuilder(1024);GetWindowText(window,title,title.Capacity);
  return new Dictionary<string,object>{{"id",pid.ToString()},{"title",title.ToString()}};
 }
 static int Integrity(uint pid) {
  IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)return -1;IntPtr token=IntPtr.Zero,data=IntPtr.Zero;
  try {
   if(!OpenProcessToken(process,8,out token))return -1;
   uint needed=0;GetTokenInformation(token,25,IntPtr.Zero,0,out needed);if(needed==0)return -1;
   data=Marshal.AllocHGlobal((int)needed);if(!GetTokenInformation(token,25,data,needed,out needed))return -1;
   IntPtr sid=Marshal.ReadIntPtr(data);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
   return count>0?Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1))):-1;
  } finally { if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process); }
 }
 public static bool InputAllowed() {
  uint target;GetWindowThreadProcessId(GetForegroundWindow(),out target);
  if(target==0)return true;
  int self=Integrity((uint)Process.GetCurrentProcess().Id),other=Integrity(target);
  return !(self>=0&&other>self);
 }
 public static Dictionary<string,object> Inspect() {
  Dpi();string reason=DesktopReason();bool available=reason==null;bool input=available&&InputAllowed();
  return new Dictionary<string,object>{{"available",available},{"reason",reason},
   {"displays",available?Displays():new Display[0]},{"app",available?App():null},
   {"inputAllowed",input},{"sessionId",Process.GetCurrentProcess().SessionId},{"remoteSession",GetSystemMetrics(0x1000)!=0}};
 }
 static void RequireInput(bool ignoreHeld) {
  RequireDesktop();if(!InputAllowed())throw Fault("INPUT_PERMISSION_DENIED","The foreground application has a higher Windows integrity level. Run the relay in the appropriate existing user context; UAC is not bypassed.");
  if(!ignoreHeld) {
   foreach(int key in new int[]{1,2,4,16,17,18,91,92})
    if((GetAsyncKeyState(key)&0x8000)!=0)throw Fault("INPUT_BUSY","A mouse button or modifier is already held; release it before computer input.");
  }
 }
 static INPUT Mouse(uint flags,int data) {
  var value=new INPUT();value.type=0;value.data.mouse.flags=flags;value.data.mouse.mouseData=unchecked((uint)data);return value;
 }
 static INPUT Key(ushort key,bool up,bool unicode,ushort scan) {
  var value=new INPUT();value.type=1;value.data.keyboard.vk=unicode?(ushort)0:key;
  value.data.keyboard.scan=scan;value.data.keyboard.flags=(up?2u:0u)|(unicode?4u:0u);
  if(!unicode&&(key==0xA3||key==0xA5||key==0x5B||key==0x5C||(key>=0x21&&key<=0x2E)))value.data.keyboard.flags|=1;
  return value;
 }
 static void Send(INPUT[] values) {
  uint sent=SendInput((uint)values.Length,values,Marshal.SizeOf(typeof(INPUT)));
  if(sent!=values.Length)throw Fault("INPUT_BLOCKED","Windows rejected input events (possibly UIPI, a desktop change, or another input restriction).");
 }
 static void MoveInternal(int x,int y) {
  int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
  if(width<=1||height<=1||x<left||y<top||x>=left+width||y>=top+height)throw Fault("INVALID_COORDINATES","Point is outside the current Windows virtual desktop.");
  var move=Mouse(0x0001|0x8000|0x4000,0);
  move.data.mouse.dx=(int)Math.Round((x-left)*65535.0/(width-1));
  move.data.mouse.dy=(int)Math.Round((y-top)*65535.0/(height-1));Send(new INPUT[]{move});
  POINT point;bool reached=false;for(int attempt=0;attempt<10;attempt++) {
   if(GetPhysicalCursorPos(out point)&&Math.Abs(point.x-x)<=1&&Math.Abs(point.y-y)<=1){reached=true;break;}Thread.Sleep(10);
  }
  if(!reached)throw Fault("POINTER_RESTRICTED","The pointer could not reach the requested physical pixel; input may be clipped or the desktop changed.");
 }
 public static void Move(int x,int y) { RequireInput(false);MoveInternal(x,y); }
 static uint Button(string button,bool up) {
  if(button=="left")return up?4u:2u;if(button=="right")return up?16u:8u;if(button=="middle")return up?64u:32u;
  throw Fault("INVALID_BUTTON","Unsupported mouse button.");
 }
 public static void Click(int x,int y,string button,int count) {
  RequireInput(false);if(count<1||count>3)throw Fault("INVALID_ACTION","Click count must be one through three.");
  MoveInternal(x,y);for(int i=0;i<count;i++){Send(new INPUT[]{Mouse(Button(button,false),0),Mouse(Button(button,true),0)});if(i+1<count)Thread.Sleep(60);}
 }
 public static void Drag(int x,int y,int tx,int ty,int duration) {
  RequireInput(false);if(duration<0||duration>5000)throw Fault("INVALID_ACTION","Drag duration exceeds the bounded limit.");
  MoveInternal(x,y);bool held=false;
  try {
   Send(new INPUT[]{Mouse(2,0)});held=true;int steps=Math.Max(1,Math.Min(100,duration/16));
   for(int i=1;i<=steps;i++){Thread.Sleep(duration/steps);MoveInternal(x+(int)Math.Round((tx-x)*(double)i/steps),y+(int)Math.Round((ty-y)*(double)i/steps));}
  } finally {if(held)Send(new INPUT[]{Mouse(4,0)});}
 }
 public static void Scroll(string direction,int amount,bool point,int x,int y) {
  RequireInput(false);if(amount<1||amount>100)throw Fault("INVALID_ACTION","Scroll amount must be one through 100 wheel ticks.");
  if(point)MoveInternal(x,y);
  bool horizontal=direction=="left"||direction=="right";
  if(!horizontal&&direction!="up"&&direction!="down")throw Fault("INVALID_ACTION","Unknown scroll direction.");
  int delta=amount*120*((direction=="down"||direction=="left")?-1:1);Send(new INPUT[]{Mouse(horizontal?0x1000u:0x800u,delta)});
 }
 public static void Keys(ushort[] keys) {
  RequireInput(false);var events=new List<INPUT>();foreach(ushort key in keys)events.Add(Key(key,false,false,0));
  for(int i=keys.Length-1;i>=0;i--)events.Add(Key(keys[i],true,false,0));Send(events.ToArray());
 }
 public static void Text(string text) {
  RequireInput(false);if(text.Length>10000)throw Fault("INVALID_ACTION","Text is limited to 10000 UTF-16 code units.");
  // KEYEVENTF_UNICODE carries UTF-16, including the two surrogate code units of emoji.
  for(int start=0;start<text.Length;start+=128) {
   var events=new List<INPUT>();for(int i=start;i<Math.Min(start+128,text.Length);i++){
    events.Add(Key(0,false,true,text[i]));events.Add(Key(0,true,true,text[i]));
   }Send(events.ToArray());
  }
 }
 public static void ReleaseText(string text) {
  RequireInput(true);var events=new List<INPUT>();foreach(char value in text)events.Add(Key(0,true,true,value));if(events.Count>0)Send(events.ToArray());
 }
 public static void Release(string button,ushort[] keys) {
  RequireInput(true);var events=new List<INPUT>();
  if(!String.IsNullOrEmpty(button))events.Add(Mouse(Button(button,true),0));
  if(keys!=null)for(int i=keys.Length-1;i>=0;i--)events.Add(Key(keys[i],true,false,0));
  if(events.Count>0)Send(events.ToArray());
 }
}
'@ | Out-Null
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__RELAY_PAYLOAD__'))|ConvertFrom-Json
switch($request.op) {
 'inspect' {$result=[RelayWinDesktop]::Inspect()}
 'screenshot' {
  [RelayWinDesktop]::RequireDesktop()
  $display=[RelayWinDesktop]::DisplayById([string]$request.displayId)
  Add-Type -AssemblyName System.Drawing
  $bitmap=$null;$graphics=$null;$memory=$null
  try {
   $bitmap=New-Object Drawing.Bitmap($display.width,$display.height,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
   $graphics=[Drawing.Graphics]::FromImage($bitmap)
   $graphics.CopyFromScreen($display.x,$display.y,0,0,$bitmap.Size,[Drawing.CopyPixelOperation]::SourceCopy)
   $memory=New-Object IO.MemoryStream
   $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
   $result=@{display=$display;image=[Convert]::ToBase64String($memory.ToArray());app=[RelayWinDesktop]::App()}
  } finally {if($graphics){$graphics.Dispose()};if($bitmap){$bitmap.Dispose()};if($memory){$memory.Dispose()}}
 }
 'move' {[RelayWinDesktop]::Move([int]$request.x,[int]$request.y);$result=@{performed='move'}}
 'click' {[RelayWinDesktop]::Click([int]$request.x,[int]$request.y,[string]$request.button,[int]$request.clicks);$result=@{performed='click'}}
 'drag' {[RelayWinDesktop]::Drag([int]$request.x,[int]$request.y,[int]$request.toX,[int]$request.toY,[int]$request.durationMs);$result=@{performed='drag'}}
 'scroll' {[RelayWinDesktop]::Scroll([string]$request.direction,[int]$request.amount,[bool]$request.point,[int]$request.x,[int]$request.y);$result=@{performed='scroll'}}
 'key' {[RelayWinDesktop]::Keys([ushort[]]$request.keys);$result=@{performed='key'}}
 'text' {[RelayWinDesktop]::Text([string]$request.text);$result=@{performed='text'}}
 'releaseText' {[RelayWinDesktop]::ReleaseText([string]$request.text);$result=@{performed='release'}}
 'release' {[RelayWinDesktop]::Release([string]$request.button,[ushort[]]$request.keys);$result=@{performed='release'}}
 default {throw 'Unknown computer operation'}
}
@{ok=$true;result=$result}|ConvertTo-Json -Compress -Depth 12
exit 0
} catch {
 $problem=$_.Exception.GetBaseException()
 $code=if($problem.Data.Contains('code')){[string]$problem.Data['code']}else{'WINDOWS_NATIVE_ERROR'}
 @{ok=$false;code=$code;message=$problem.Message}|ConvertTo-Json -Compress -Depth 5
 exit 1
}`;

const ACTIONS = ["move", "click", "drag", "scroll", "key", "text"] as const;
const KEY_CODES: Record<string, number> = {
  ctrl: 0x11, control: 0x11, controll: 0xa2, controlr: 0xa3, shift: 0x10, shiftl: 0xa0, shiftr: 0xa1,
  alt: 0x12, altl: 0xa4, altr: 0xa5, option: 0x12, win: 0x5b, meta: 0x5b, super: 0x5b, superl: 0x5b, superr: 0x5c,
  enter: 0x0d, return: 0x0d, escape: 0x1b, esc: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08,
  delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, arrowleft: 0x25, up: 0x26, arrowup: 0x26, right: 0x27, arrowright: 0x27, down: 0x28, arrowdown: 0x28,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, printscreen: 0x2c, pause: 0x13,
};
export function windowsKeyCodes(keys: string[]): number[] {
  if (!keys.length || keys.length > 8) throw new ComputerError("INVALID_KEY", "Use a chord of one through eight keys.");
  return keys.map((key) => {
    const name = key.replace(/[_\s-]/g, "").toLowerCase();
    if (/^[a-z0-9]$/.test(name)) return name.toUpperCase().charCodeAt(0);
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) return 0x6f + Number(name.slice(1));
    const code = KEY_CODES[name];
    if (code === undefined) throw new ComputerError("UNSUPPORTED_KEY", "Unsupported Windows key: " + key + ". Use text for characters.");
    return code;
  });
}
function powershell(): string {
  const value = (name: string) => {
    const key = Object.keys(process.env).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? process.env[key] : undefined;
  };
  const programs = [value("ProgramW6432"), value("ProgramFiles")].filter((item): item is string => Boolean(item));
  const command = findExecutable([
    ...programs.map((dir) => win32.join(dir, "PowerShell", "7", "pwsh.exe")), "pwsh.exe",
    win32.join(value("SystemRoot") ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
  ]);
  if (!command) throw new ComputerError("BACKEND_UNAVAILABLE", "Native PowerShell 7 or Windows PowerShell 5.1 is required.");
  return command;
}
type WireResponse = { ok?: boolean; code?: string; message?: string; result?: Record<string, unknown> };
async function invoke(request: Record<string, unknown>, context: NativeContext): Promise<Record<string, unknown>> {
  if (context.signal?.aborted) throw new ComputerError("cancelled", "Computer action was cancelled before execution.", { mayHaveApplied: false });
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const script = WINDOWS_NATIVE.replace("__RELAY_PAYLOAD__", payload);
  // Keep argv far below Windows' command-line limit; action/text are data in the
  // encoded payload and are never interpolated into executable PowerShell.
  const loader = "[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);& ([scriptblock]::Create([Console]::In.ReadToEnd()))";
  const response = await runNative({ command: powershell(),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(loader, "utf16le").toString("base64")],
    input: script, maxOutputBytes: request.op === "screenshot" ? 32 * 1024 * 1024 : 512 * 1024,
  }, context);
  let parsed: WireResponse;
  try { parsed = JSON.parse(response.stdout.toString("utf8").replace(/^\uFEFF/, "").trim()) as WireResponse; }
  catch { throw new ComputerError("WINDOWS_NATIVE_ERROR", "Native Windows desktop helper returned invalid output.",
    { exitCode: response.exitCode }); }
  if (!parsed.ok || response.exitCode !== 0 || !parsed.result) {
    throw new ComputerError(parsed.code ?? "WINDOWS_NATIVE_ERROR", parsed.message ?? "Native Windows desktop operation failed.");
  }
  return parsed.result;
}
function validatePoint(display: ComputerDisplay, x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= display.width || y >= display.height) {
    throw new ComputerError("INVALID_COORDINATES", "Point must lie inside the selected screenshot.");
  }
  return nativePoint(display, x, y);
}
function unavailable(error: unknown): ComputerState {
  return { platform: "win32", backend: "windows-win32", available: false, displayKind: "none", inputKind: "none",
    displays: [], actions: [], unicodeText: true,
    permissions: { interactiveDesktop: error instanceof ComputerError && error.code === "INTERACTIVE_SESSION_REQUIRED" ? "denied" : "unknown", screenCapture: "unknown", input: "unknown" },
    reason: error instanceof Error ? error.message : String(error),
    details: { setup: "Start the relay in the signed-in user's interactive desktop. Unlock/reconnect that session. Do not run it as a Session 0 service or SSH-only desktop process." },
  };
}
export function createWindowsBackend(): ComputerBackend {
  return {
    id: "windows-win32",
    async inspect(context) {
      try {
        const value = await invoke({ op: "inspect" }, context);
        if (!value.available) return unavailable(new ComputerError("INTERACTIVE_SESSION_REQUIRED", String(value.reason ?? "No interactive Windows desktop is available.")));
        const input = value.inputAllowed === true;
        const displays = value.displays as ComputerDisplay[];
        return { platform: "win32", backend: "windows-win32", available: displays.length > 0,
          displayKind: value.remoteSession ? "virtual" : "unknown", inputKind: input ? "mouse_keyboard" : "none",
          displays, actions: input ? [...ACTIONS] : [], unicodeText: true,
          permissions: { interactiveDesktop: "granted", screenCapture: "unknown", input: input ? "granted" : "denied" },
          ...(value.app ? { app: value.app as { id?: string; title?: string } } : {}),
          ...(!input ? { reason: "The current foreground application has higher integrity; Windows UIPI blocks injection into it." } : {}),
          details: { sessionId: value.sessionId, coordinates: "physical pixels; per-monitor DPI aware",
            textMethod: "SendInput KEYEVENTF_UNICODE (UTF-16)", maxTextCodeUnits: 10000 },
        };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        return unavailable(error);
      }
    },
    async screenshot(displayId, context) {
      const value = await invoke({ op: "screenshot", displayId: displayId ?? "" }, context);
      const data = Buffer.from(String(value.image ?? ""), "base64");
      const size = pngDimensions(data), display = value.display as ComputerDisplay;
      if (size.width !== display.width || size.height !== display.height) {
        throw new ComputerError("DISPLAY_CHANGED", "Native screenshot size changed; capture a fresh frame before acting.");
      }
      return { data, mimeType: "image/png", display, capturedAt: Date.now(),
        ...(value.app ? { app: value.app as { id?: string; title?: string } } : {}) };
    },
    async act(action: ComputerAction, display: ComputerDisplay, context: NativeContext) {
      let request: Record<string, unknown>;
      let release: Record<string, unknown> | undefined;
      switch (action.type) {
        case "move": request = { op: "move", ...validatePoint(display, action.x, action.y) }; break;
        case "click":
          request = { op: "click", ...validatePoint(display, action.x, action.y), button: action.button ?? "left", clicks: action.clicks ?? 1 };
          release = { op: "release", button: action.button ?? "left", keys: [] }; break;
        case "drag": {
          const start = validatePoint(display, action.fromX, action.fromY), end = validatePoint(display, action.toX, action.toY);
          request = { op: "drag", ...start, toX: end.x, toY: end.y, durationMs: action.durationMs ?? 400 };
          release = { op: "release", button: "left", keys: [] }; break;
        }
        case "scroll":
          request = { op: "scroll", direction: action.direction, amount: action.amount ?? 3,
            point: action.x !== undefined && action.y !== undefined,
            ...(action.x !== undefined && action.y !== undefined ? validatePoint(display, action.x, action.y) : { x: 0, y: 0 }) }; break;
        case "key": {
          const keys = windowsKeyCodes(action.keys); request = { op: "key", keys };
          release = { op: "release", button: "", keys }; break;
        }
        case "text": request = { op: "text", text: action.text };
          release = { op: "releaseText", text: action.text }; break;
      }
      try { return { ...await invoke(request, context), submitted: true,
        verification: "Win32 accepted the input events; the application outcome requires a fresh screenshot." }; }
      catch (error) {
        // A forcibly terminated helper cannot run its native finally block.
        // Release only this action's requested buttons/keys, never global input.
        const beforeInput = error instanceof ComputerError && (error.details?.mayHaveApplied === false
          || (error.code === "cancelled" && error.details?.mayHaveApplied !== true) || ["INPUT_BUSY", "INTERACTIVE_SESSION_REQUIRED", "INPUT_PERMISSION_DENIED",
          "DPI_UNAVAILABLE", "INVALID_COORDINATES", "INVALID_ACTION", "INVALID_BUTTON", "BACKEND_UNAVAILABLE", "DISPLAY_NOT_FOUND"].includes(error.code));
        if (release && !beforeInput) {
          try { await invoke(release, { timeoutMs: 4000 }); }
          catch (cleanup) {
            throw new ComputerError("INPUT_STATE_UNCERTAIN", "The input operation failed and Windows could not confirm releasing this action's keys/buttons.",
              { cause: error instanceof Error ? error.message : String(error),
                cleanup: cleanup instanceof Error ? cleanup.message : String(cleanup) });
          }
        }
        throw error;
      }
    },
  };
}
