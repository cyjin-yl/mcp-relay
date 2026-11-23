import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findExecutable } from "../../src/computer/native.js";

export type FixtureState = {
  title: string; foreground: boolean; text: string; clickCount: number; dragCount: number; scrollCount: number; moveCount: number; dragging?: boolean; pointer?: { x: number; y: number };
  regions: Record<"text" | "click" | "dragStart" | "dragEnd" | "scroll", { x: number; y: number }>;
};

const WINDOWS_FIXTURE = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$settings=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__FIXTURE__'))|ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RelaySmokeWindow {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int state);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
 public static bool OwnsPoint(IntPtr form,int x,int y) {
  var point=new POINT();point.x=x;point.y=y;
  return GetAncestor(WindowFromPoint(point),2)==form;
 }
}
'@
[RelaySmokeWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))|Out-Null
$form=New-Object Windows.Forms.Form
$form.Text=$settings.title
$form.AutoScaleMode=[Windows.Forms.AutoScaleMode]::None
$form.ClientSize=New-Object Drawing.Size(640,420)
$form.StartPosition=[Windows.Forms.FormStartPosition]::Manual
$working=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location=New-Object Drawing.Point(($working.X+[Math]::Max(0,($working.Width-660)/2)),($working.Y+[Math]::Max(0,($working.Height-460)/2)))
$form.TopMost=$true
$text=New-Object Windows.Forms.TextBox
$text.Multiline=$true
$text.SetBounds(20,20,600,90)
$text.Font=New-Object Drawing.Font('Segoe UI',16)
$button=New-Object Windows.Forms.Button
$button.Text='Benign smoke click'
$button.SetBounds(20,125,220,45)
$canvas=New-Object Windows.Forms.RichTextBox
$canvas.ReadOnly=$true
$canvas.SetBounds(20,190,600,200)
$canvas.Text=(1..100|ForEach-Object{'Synthetic scroll line '+$_}) -join [Environment]::NewLine
$canvas.BackColor=[Drawing.Color]::FromArgb(30,130,180)
$canvas.ForeColor=[Drawing.Color]::White
$form.Controls.AddRange([Windows.Forms.Control[]]@($text,$button,$canvas))
$script:clicks=0;$script:drags=0;$script:scrolls=0;$script:moves=0;$script:dragging=$false;$script:moved=$false
$button.Add_Click({$script:clicks++})
$canvas.Add_MouseDown({$script:dragging=$true;$script:moved=$false})
$canvas.Add_MouseMove({$script:moves++;if($script:dragging){$script:moved=$true}})
$canvas.Add_MouseUp({if($script:dragging -and $script:moved){$script:drags++};$script:dragging=$false})
$canvas.Add_MouseWheel({$script:scrolls++})
function Center($control,[int]$dx,[int]$dy){
 $p=$control.PointToScreen((New-Object Drawing.Point($dx,$dy)))
 return @{x=$p.X;y=$p.Y}
}
$started=[DateTime]::UtcNow
$timer=New-Object Windows.Forms.Timer
$timer.Interval=60
$timer.Add_Tick({
 if((Test-Path -LiteralPath $settings.stop) -or ([DateTime]::UtcNow-$started).TotalSeconds -gt 240){$form.Close();return}
 $regions=@{text=(Center $text 100 40);click=(Center $button 100 22);dragStart=(Center $canvas 80 60);dragEnd=(Center $canvas 180 100);scroll=(Center $canvas 240 100)}
 $owned=$true
 foreach($region in $regions.Values){if(-not [RelaySmokeWindow]::OwnsPoint($form.Handle,[int]$region.x,[int]$region.y)){$owned=$false}}
 $visible=[RelaySmokeWindow]::IsWindowVisible($form.Handle)
 $minimized=[RelaySmokeWindow]::IsIconic($form.Handle)
 $foregroundMatches=([RelaySmokeWindow]::GetForegroundWindow() -eq $form.Handle)
 $record=@{title=$form.Text;foreground=($visible -and (-not $minimized) -and $owned -and $foregroundMatches);visible=$visible;minimized=$minimized;foregroundHandleMatches=$foregroundMatches;targetsOwned=$owned;
 pointer=@{x=[Windows.Forms.Cursor]::Position.X;y=[Windows.Forms.Cursor]::Position.Y};text=$text.Text;clickCount=$script:clicks;dragCount=$script:drags;scrollCount=$script:scrolls;moveCount=$script:moves;dragging=$script:dragging;
 regions=$regions}
 [IO.File]::WriteAllText($settings.state,($record|ConvertTo-Json -Depth 8 -Compress),(New-Object Text.UTF8Encoding($false)))
})
$form.Add_Shown({
 [RelaySmokeWindow]::ShowWindow($form.Handle,5)|Out-Null
 $form.BringToFront()
 [RelaySmokeWindow]::SetForegroundWindow($form.Handle)|Out-Null
 $form.Activate();$form.Refresh();$text.Focus()|Out-Null;$timer.Start()
})
try{[Windows.Forms.Application]::Run($form)}finally{$timer.Stop();$timer.Dispose();$form.Dispose()}
`;

const MACOS_FIXTURE = String.raw`ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
var data=$.NSData.alloc.initWithBase64EncodedStringOptions('__FIXTURE__',0);
var config=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)));
var clicks=0,drags=0,scrolls=0,moves=0,held=false,moved=false;
ObjC.registerSubclass({name:'RelaySmokeTarget',superclass:'NSObject',methods:{
 'clicked:':{types:['void',['id']],implementation:function(sender){clicks++;}}
}});
// Inherit the actual AppKit method encodings (BOOL differs by architecture).
// JXA permits omitted types for overrides; custom selectors still declare them.
ObjC.registerSubclass({name:'RelaySmokeCanvas',superclass:'NSView',methods:{
 'acceptsFirstResponder':function(){return true;},
 'mouseDown:':function(event){held=true;moved=false;this.window.makeFirstResponder(this);},
 'mouseDragged:':function(event){moves++;moved=true;},
 'mouseUp:':function(event){if(held&&moved)drags++;held=false;},
 'scrollWheel:':function(event){scrolls++;},
 'drawRect:':function(rect){$.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.12,0.51,0.70,1).set;$.NSRectFill(rect);}
}});
var app=$.NSApplication.sharedApplication;
app.setActivationPolicy(0);
var main=$.NSScreen.screens.objectAtIndex(0).frame;
var window=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(main.origin.x+80,main.origin.y+80,640,440),15,2,false);
window.title=config.title;
window.level=3;
window.setReleasedWhenClosed(false);
var text=$.NSTextView.alloc.initWithFrame($.NSMakeRect(20,300,600,100));
text.font=$.NSFont.systemFontOfSize(18);
text.richText=false;
var button=$.NSButton.alloc.initWithFrame($.NSMakeRect(20,230,220,45));
button.title='Benign smoke click';
button.bezelStyle=1;
var target=$.RelaySmokeTarget.alloc.init;
button.target=target;button.action='clicked:';
var canvas=$.RelaySmokeCanvas.alloc.initWithFrame($.NSMakeRect(20,20,600,190));
window.contentView.addSubview(text);window.contentView.addSubview(button);window.contentView.addSubview(canvas);
app.finishLaunching;
window.makeKeyAndOrderFront(null);app.activateIgnoringOtherApps(true);window.makeFirstResponder(text);
function center(view,x,y){
 var inWindow=view.convertRectToView($.NSMakeRect(x,y,1,1),null);
 var onScreen=window.convertRectToScreen(inWindow);
 var height=$.CGDisplayBounds($.CGMainDisplayID()).size.height;
 return{x:onScreen.origin.x,y:height-onScreen.origin.y};
}
var deadline=Date.now()+240000;
while(Date.now()<deadline&&!$.NSFileManager.defaultManager.fileExistsAtPath(config.stop)&&window.isVisible){
 var event=app.nextEventMatchingMaskUntilDateInModeDequeue(0xffffffff,$.NSDate.dateWithTimeIntervalSinceNow(0.06),$.NSDefaultRunLoopMode,true);
 if(!event.isNil())app.sendEvent(event);
 app.updateWindows;
 var cursor=$.NSEvent.mouseLocation;
 var record={title:config.title,foreground:!!app.isActive,pointer:{x:cursor.x,y:$.CGDisplayBounds($.CGMainDisplayID()).size.height-cursor.y},text:ObjC.unwrap(text.string),clickCount:clicks,dragCount:drags,scrollCount:scrolls,moveCount:moves,dragging:held,
 regions:{text:center(text,100,50),click:center(button,100,22),dragStart:center(canvas,80,70),dragEnd:center(canvas,180,110),scroll:center(canvas,240,100)}};
 $(JSON.stringify(record)).writeToFileAtomicallyEncodingError(config.state,true,$.NSUTF8StringEncoding,null);
}
window.close;
`;

export function startNativeFixture(platform: NodeJS.Platform, directory: string): {
  child: ChildProcess; statePath: string; title: string; stop(): Promise<void>;
} {
  const title = "MCP Relay Native Smoke - " + process.pid;
  const statePath = join(directory, "fixture-state.json"), stopPath = join(directory, "fixture-stop");
  const payload = Buffer.from(JSON.stringify({ title, state: statePath, stop: stopPath })).toString("base64");
  const log = openSync(join(directory, "fixture.log"), "a", 0o600);
  let command: string | undefined, args: string[], input: string;
  if (platform === "win32") {
    command = findExecutable(["pwsh.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe"]);
    const loader = "[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);& ([scriptblock]::Create([Console]::In.ReadToEnd()))";
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(loader, "utf16le").toString("base64")];
    input = WINDOWS_FIXTURE.replace("__FIXTURE__", payload);
  } else {
    command = findExecutable(["/usr/bin/osascript"]); args = ["-l", "JavaScript", "-"];
    input = MACOS_FIXTURE.replace("__FIXTURE__", payload);
  }
  if (!command) { closeSync(log); throw new Error("The fixture's native runtime is unavailable."); }
  // The owned fixture must create a visible GUI. Production native helpers stay hidden.
  const child = spawn(command, args, { windowsHide: false, stdio: ["pipe", log, log] });
  closeSync(log);
  child.stdin!.end(input);
  return { child, statePath, title, async stop() {
    writeFileSync(stopPath, "stop\n");
    const deadline = Date.now() + 8000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); // only this fixture process
  } };
}
