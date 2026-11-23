import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, pngDimensions, runNative } from "./native.js";
import { ComputerError, nativePoint, type ComputerAction, type ComputerBackend, type ComputerDisplay,
  type ComputerState, type NativeContext } from "./types.js";

// Only Apple's installed tools/frameworks are used; never request/reset TCC grants.
// https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()
// https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted
// https://developer.apple.com/documentation/coregraphics/cgdisplaybounds(_:)
// https://developer.apple.com/documentation/coregraphics/cgevent/init(keyboardeventsource:virtualkey:keydown:)
// https://developer.apple.com/documentation/coregraphics/kcgsessiononconsolekey
// https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary()
// https://developer.apple.com/documentation/appkit/nsscreen/devicedescription
// https://developer.apple.com/documentation/appkit/nsscreen/backingscalefactor
// https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/Articles/OSX10-10.html

const MACOS_NATIVE = String.raw`ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
function bind(name, result, args) { try { ObjC.bindFunction(name, [result, args]); return true; } catch (_) { return false; } }
var hasCaptureCheck=bind('CGPreflightScreenCaptureAccess','bool',[]);
var hasPostCheck=bind('CGPreflightPostEventAccess','bool',[]);
// NSData.bytes is void*. Bind the identical C ABI without an incompatible UniChar* bridge Ref.
var hasUnicode=bind('CGEventKeyboardSetUnicodeString','void',['void *','unsigned long','void *']);
bind('CGSessionCopyCurrentDictionary','id',[]);
function fail(code,message) { var e=new Error(message);e.relayCode=code;throw e; }
function displays() {
 // NSScreenNumber is Apple's documented CGDirectDisplayID mapping. No void*
 // NSData buffer is passed to a typed uint32* API through JXA.
 var screens=$.NSScreen.screens,result=[];
 for(var i=0;i<Number(screens.count);i++){
  var screen=screens.objectAtIndex(i);
  var id=Number(ObjC.unwrap(screen.deviceDescription.objectForKey('NSScreenNumber')));
  if(!isFinite(id)||id<=0)fail('DISPLAY_ENUMERATION_FAILED','AppKit did not provide a valid CoreGraphics display ID.');
  var rect=$.CGDisplayBounds(id),scale=Number(screen.backingScaleFactor);
  var width=Math.round(rect.size.width*scale),height=Math.round(rect.size.height*scale);
  if(rect.size.width<=0||rect.size.height<=0||width<=0||height<=0)continue;
  result.push({id:String(id),name:'Display '+String(id),x:rect.origin.x,y:rect.origin.y,
   width:width,height:height,scaleX:scale,scaleY:scale,
   rotation:Number($.CGDisplayRotation(id)),primary:!!$.CGDisplayIsMain(id),captureIndex:i+1,
   nativeWidth:rect.size.width,nativeHeight:rect.size.height});
 }
 return result;
}
function nativeBoolean(value,label) {
 if(value===true||value===1)return true;if(value===false||value===0)return false;
 fail('SESSION_QUERY_FAILED','macOS returned an unrecognized '+label+' value.');
}
function sessionState() {
 var session;try{session=ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary());}catch(error){fail('SESSION_QUERY_FAILED','macOS session inspection failed: '+String(error.message||error));}
 // Apple documents a null dictionary as no Quartz GUI session. A missing or
 // unrecognized key in a real dictionary is a helper failure, not OS denial.
 if(session===null||session===undefined)return{present:false,onConsole:false,locked:false,consoleKey:null,consoleValueType:'null'};
 if(typeof session!=='object'||Array.isArray(session))fail('SESSION_QUERY_FAILED','macOS did not return a session dictionary.');
 var keys=[],constant;
 try{constant=ObjC.unwrap($.kCGSessionOnConsoleKey);if(typeof constant==='string'&&constant.length)keys.push(constant);}catch(_){}
 // kCGSessionOnConsoleKey is a CFSTR macro on some SDKs and is not exported
 // through JXA there. The first literal is its actual WindowServer key.
 keys=keys.concat(['kCGSSessionOnConsoleKey','kCGSessionOnConsoleKey','CGSSessionOnConsoleKey']);
 var key=null;
 for(var i=0;i<keys.length;i++){if(Object.prototype.hasOwnProperty.call(session,keys[i])){key=keys[i];break;}}
 if(key===null)fail('SESSION_QUERY_FAILED','macOS session dictionary has no recognized console-state key.');
 var onConsole=nativeBoolean(session[key],'console-state'),locked=false;
 var lockKeys=['CGSSessionScreenIsLocked','kCGSSessionScreenIsLocked'];
 for(var j=0;j<lockKeys.length;j++){if(Object.prototype.hasOwnProperty.call(session,lockKeys[j])){locked=nativeBoolean(session[lockKeys[j]],'screen-lock');break;}}
 return{present:true,onConsole:onConsole,locked:locked,consoleKey:key,consoleValueType:typeof session[key]};
}
function inspect() {
 var session=sessionState(),onConsole=session.onConsole,locked=session.locked;
 var front=$.NSWorkspace.sharedWorkspace.frontmostApplication,app=null;
 if(!front.isNil())app={id:ObjC.unwrap(front.bundleIdentifier)||String(front.processIdentifier),title:ObjC.unwrap(front.localizedName)||''};
 if(app&&app.id==='com.apple.loginwindow')locked=true;
 session.locked=locked;
 var screens=displays(),available=!!onConsole&&!locked&&screens.length>0;
 var trusted=!!$.AXIsProcessTrusted();
 var posting=hasPostCheck?!!$.CGPreflightPostEventAccess():null;
 var capture=hasCaptureCheck?!!$.CGPreflightScreenCaptureAccess():null;
 return {available:available,displays:screens,app:app,accessibility:trusted,inputAllowed:trusted&&posting!==false,unicodeText:hasUnicode,
  screenCapture:capture,postEventAccess:posting,locked:locked,onConsole:onConsole,session:session,
  reason:available?null:'No unlocked foreground WindowServer user session is available.'};
}
function requireInput(ignoreHeld) {
 var state=inspect();
 if(!state.available)fail('INTERACTIVE_SESSION_REQUIRED',state.reason);
 if(!state.inputAllowed)fail('ACCESSIBILITY_REQUIRED','macOS Accessibility permission is required for the relay responsible application. Grant it in System Settings; this backend never requests or bypasses authorization.');
 if(!ignoreHeld) {
  var flags=Number($.CGEventSourceFlagsState(0));
  if((flags&(0x20000|0x40000|0x80000|0x100000))!==0 || Number($.NSEvent.pressedMouseButtons)!==0)
   fail('INPUT_BUSY','A modifier or mouse button is already held. Release it before computer input.');
 }
 return state;
}
// Explicit CFRelease through JXA crashes inside the bridge on supported macOS
// runtimes (native no-post probes: SIGSEGV/SIGBUS at the release call). Do not
// assume a GC/ownership cause. Retain these finite objects until this invocation's
// dedicated osascript exits; runNative waits for that real exit before releasing
// the operation lane. The bounded actions allocate at most 1,334 CGEvents here.
// This memory lifetime is separate from the mandatory key-up/button-up events.
var helperEvents=[];
function retainUntilHelperExit(event) { if(event)helperEvents.push(event); }
function post(event) { if(!event)fail('INPUT_EVENT_FAILED','CoreGraphics could not create an input event.');$.CGEventPost(0,event); }
function mouse(type,x,y,button,count) {
 var event=$.CGEventCreateMouseEvent(null,type,{x:x,y:y},button);
 try {if(count!==undefined)$.CGEventSetIntegerValueField(event,1,count);post(event);}finally{retainUntilHelperExit(event);}
}
function location() {
 var event=$.CGEventCreate(null);try{return $.CGEventGetLocation(event);}finally{retainUntilHelperExit(event);}
}
function move(x,y,dragged) {
 mouse(dragged?6:5,x,y,0);
 for(var i=0;i<10;i++){var p=location();if(Math.abs(p.x-x)<=1&&Math.abs(p.y-y)<=1)return;$.NSThread.sleepForTimeInterval(0.01);}
 fail('POINTER_RESTRICTED','The pointer did not reach the requested global display coordinate.');
}
function buttonInfo(name) {
 if(name==='left')return{number:0,down:1,up:2};if(name==='right')return{number:1,down:3,up:4};
 if(name==='middle')return{number:2,down:25,up:26};fail('INVALID_BUTTON','Unsupported mouse button.');
}
// Track the modifier keys actually belonging to this chord. Left/right variants
// share a mask, so releasing one must preserve the other variant's flag.
function keyFlags(keys) {
 var flags=0;
 for(var i=0;i<keys.length;i++){
  var code=keys[i];
  if(code===54||code===55)flags|=0x100000;
  else if(code===56||code===60)flags|=0x20000;
  else if(code===58||code===61)flags|=0x80000;
  else if(code===59||code===62)flags|=0x40000;
 }
 return flags;
}
function releaseKeys(pressed) {
 var failure=null;
 while(pressed.length){
  var code=pressed.pop();
  try{keyboard(code,false,keyFlags(pressed));}catch(error){if(!failure)failure=error;}
 }
 if(failure)throw failure;
}
function keyboard(code,down,flags) {
 var event=$.CGEventCreateKeyboardEvent(null,code,down);
 try {if([54,55,56,58,59,60,61,62].indexOf(code)>=0)$.CGEventSetType(event,12);$.CGEventSetFlags(event,flags||0);post(event);}finally{retainUntilHelperExit(event);}
}
function unicode(text) {
 if(!hasUnicode)fail('UNICODE_TEXT_UNAVAILABLE','The native Unicode keyboard bridge is unavailable on this macOS runtime.');
 // An explicit little-endian UTF-16 NSData buffer preserves surrogate pairs.
 for(var start=0;start<text.length;){
  var end=Math.min(start+16,text.length);
  if(end<text.length&&text.charCodeAt(end-1)>=0xD800&&text.charCodeAt(end-1)<=0xDBFF)end--;
  var piece=text.slice(start,end),data=$(piece).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
  var down=$.CGEventCreateKeyboardEvent(null,0,true),up=$.CGEventCreateKeyboardEvent(null,0,false);
  try {
   $.CGEventSetFlags(down,0);$.CGEventSetFlags(up,0);
   $.CGEventKeyboardSetUnicodeString(down,piece.length,data.bytes);
   $.CGEventKeyboardSetUnicodeString(up,piece.length,data.bytes);
   post(down);post(up);
  }finally{retainUntilHelperExit(down);retainUntilHelperExit(up);}
  start=end;
 }
}
function action(request) {
 requireInput(request.op==='release');
 if(request.op==='move'){move(request.x,request.y,false);}
 else if(request.op==='click'){
  var b=buttonInfo(request.button);if(request.clicks<1||request.clicks>3)fail('INVALID_ACTION','Click count must be one through three.');
  move(request.x,request.y,false);
  for(var c=1;c<=request.clicks;c++){mouse(b.down,request.x,request.y,b.number,c);mouse(b.up,request.x,request.y,b.number,c);if(c<request.clicks)$.NSThread.sleepForTimeInterval(0.06);}
 }else if(request.op==='drag'){
  if(request.durationMs<0||request.durationMs>5000)fail('INVALID_ACTION','Drag duration exceeds the bounded limit.');
  move(request.x,request.y,false);var held=false;
  try {
   mouse(1,request.x,request.y,0,1);held=true;
   var steps=Math.max(1,Math.min(100,Math.floor(request.durationMs/16)));
   for(var i=1;i<=steps;i++){$.NSThread.sleepForTimeInterval(request.durationMs/steps/1000);move(request.x+(request.toX-request.x)*i/steps,request.y+(request.toY-request.y)*i/steps,true);}
  }finally{if(held){var end=location();mouse(2,end.x,end.y,0,1);}}
 }else if(request.op==='scroll'){
  if(request.amount<1||request.amount>100)fail('INVALID_ACTION','Scroll amount must be one through 100 lines.');
  if(request.point)move(request.x,request.y,false);
  var vertical=request.direction==='up'||request.direction==='down',sign=(request.direction==='up'||request.direction==='left')?1:-1;
  if(!vertical&&request.direction!=='left'&&request.direction!=='right')fail('INVALID_ACTION','Unsupported scroll direction.');
  for(var left=request.amount;left>0;left-=10){
   var amount=Math.min(left,10)*sign,event=$.CGEventCreateScrollWheelEvent(null,1,2,vertical?amount:0,vertical?0:amount);
   try{post(event);}finally{retainUntilHelperExit(event);}
  }
 }else if(request.op==='key'){
  var pressed=[];
  // Apple's keyboard-event contract requires real modifier down/up events,
  // not only modifier bits on ordinary key events.
  try {for(var k=0;k<request.keys.length;k++){pressed.push(request.keys[k]);keyboard(request.keys[k],true,keyFlags(pressed));}}
  finally {releaseKeys(pressed);}
 }else if(request.op==='text'){
  if(request.text.length>10000)fail('INVALID_ACTION','Text is limited to 10000 UTF-16 code units.');unicode(request.text);
 }else if(request.op==='release'){
  if(request.button){var b=buttonInfo(request.button),p=location();mouse(b.up,p.x,p.y,b.number,1);}
  releaseKeys(request.keys.slice());
 }else fail('INVALID_ACTION','Unknown native input operation.');
 return {dispatched:true,performed:request.op};
}
function run() {
 try {
  var data=$.NSData.alloc.initWithBase64EncodedStringOptions('__RELAY_PAYLOAD__',0);
  var request=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)));
  var result=request.op==='inspect'?inspect():action(request);
  return JSON.stringify({ok:true,result:result});
 }catch(error){return JSON.stringify({ok:false,code:error.relayCode||'MACOS_NATIVE_ERROR',message:String(error.message||error)});}
}`;

const ACTIONS = ["move", "click", "drag", "scroll", "key", "text"] as const;
const MAC_KEYS: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14,
  r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25,
  "7": 26, "8": 28, "0": 29, o: 31, u: 32, i: 34, p: 35, enter: 36, return: 36, l: 37,
  j: 38, k: 40, n: 45, m: 46, tab: 48, space: 49, backspace: 51, escape: 53, esc: 53,
  home: 115, end: 119, pageup: 116, pagedown: 121, delete: 117,
  left: 123, arrowleft: 123, right: 124, arrowright: 124, down: 125, arrowdown: 125, up: 126, arrowup: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};
const MODIFIERS: Record<string, { code: number; flag: number }> = {
  shift: { code: 56, flag: 0x20000 }, shiftl: { code: 56, flag: 0x20000 }, shiftr: { code: 60, flag: 0x20000 },
  ctrl: { code: 59, flag: 0x40000 }, control: { code: 59, flag: 0x40000 }, controll: { code: 59, flag: 0x40000 }, controlr: { code: 62, flag: 0x40000 },
  alt: { code: 58, flag: 0x80000 }, option: { code: 58, flag: 0x80000 }, altl: { code: 58, flag: 0x80000 }, altr: { code: 61, flag: 0x80000 },
  meta: { code: 55, flag: 0x100000 }, super: { code: 55, flag: 0x100000 }, command: { code: 55, flag: 0x100000 },
  cmd: { code: 55, flag: 0x100000 }, superl: { code: 55, flag: 0x100000 }, superr: { code: 54, flag: 0x100000 },
};
export function macosKeyChord(keys: string[]): { keys: number[]; flags: number; modifiersOnly: boolean } {
  if (!keys.length || keys.length > 8) throw new ComputerError("INVALID_KEY", "Use a chord of one through eight keys.");
  const normal: number[] = [], modifiers: number[] = [];
  let flags = 0;
  for (const key of keys) {
    const name = key.replace(/[_\s-]/g, "").toLowerCase();
    const modifier = MODIFIERS[name];
    if (modifier) { flags |= modifier.flag; modifiers.push(modifier.code); continue; }
    const code = MAC_KEYS[name];
    if (code === undefined) throw new ComputerError("UNSUPPORTED_KEY", "Unsupported native macOS key: " + key + ". Use text for characters.");
    normal.push(code);
  }
  return { keys: [...new Set([...modifiers, ...normal])], flags, modifiersOnly: normal.length === 0 };
}
type NativeDisplay = ComputerDisplay & { captureIndex: number; nativeWidth: number; nativeHeight: number };
type MacInfo = { available: boolean; displays: NativeDisplay[]; accessibility: boolean; inputAllowed: boolean; unicodeText: boolean;
  screenCapture: boolean | null; postEventAccess: boolean | null; locked: boolean; onConsole: boolean;
  session?: { present: boolean; onConsole: boolean; locked: boolean; consoleKey: string | null; consoleValueType: string };
  app?: { id?: string; title?: string }; reason?: string };
type WireResponse = { ok?: boolean; code?: string; message?: string; result?: Record<string, unknown> };
async function invoke(request: Record<string, unknown>, context: NativeContext): Promise<Record<string, unknown>> {
  if (context.signal?.aborted) throw new ComputerError("cancelled", "Computer action was cancelled before execution.", { mayHaveApplied: false });
  const command = findExecutable(["/usr/bin/osascript"]);
  if (!command) throw new ComputerError("BACKEND_UNAVAILABLE", "The macOS system osascript executable is unavailable.");
  const input = MACOS_NATIVE.replace("__RELAY_PAYLOAD__", Buffer.from(JSON.stringify(request), "utf8").toString("base64"));
  const response = await runNative({ command, args: ["-l", "JavaScript", "-"], input, maxOutputBytes: 512 * 1024 }, context);
  let result: WireResponse;
  try { result = JSON.parse(response.stdout.toString("utf8").trim()) as WireResponse; }
  catch { throw new ComputerError("MACOS_NATIVE_ERROR", "The native macOS helper did not return valid JSON.",
    { exitCode: response.exitCode }); }
  if (!result.ok || response.exitCode !== 0 || !result.result) {
    throw new ComputerError(result.code ?? "MACOS_NATIVE_ERROR", result.message ?? "Native macOS desktop operation failed.");
  }
  return result.result;
}
function point(display: ComputerDisplay, x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= display.width || y >= display.height) {
    throw new ComputerError("INVALID_COORDINATES", "Point must lie inside the selected screenshot.");
  }
  return nativePoint(display, x, y);
}
function permission(value: boolean | null): "granted" | "denied" | "unknown" {
  return value === null ? "unknown" : value ? "granted" : "denied";
}
function publicDisplay(display: NativeDisplay): ComputerDisplay {
  const { captureIndex: _index, nativeWidth: _width, nativeHeight: _height, ...result } = display;
  return result;
}
export function createMacosBackend(): ComputerBackend {
  return {
    id: "macos-quartz",
    async inspect(context): Promise<ComputerState> {
      try {
        const state = await invoke({ op: "inspect" }, context) as unknown as MacInfo;
        return { platform: "darwin", backend: "macos-quartz", available: state.available, displayKind: state.displays.length ? "unknown" : "none",
          inputKind: state.available && state.inputAllowed ? "mouse_keyboard" : "none",
          displays: state.displays.map(publicDisplay), actions: state.available && state.inputAllowed ? ACTIONS.filter(action => state.unicodeText || action !== "text") : [],
          unicodeText: state.unicodeText, permissions: { interactiveSession: state.available ? "granted" : "denied",
            screenCapture: permission(state.screenCapture), accessibility: state.accessibility ? "granted" : "denied",
            input: state.inputAllowed ? "granted" : "denied", postEvents: permission(state.postEventAccess) },
          ...(state.app ? { app: state.app } : {}),
          ...(state.reason ? { reason: state.reason } : {}),
          details: { session: state.session, setup: "If permission is denied, manually enable Screen Recording and Accessibility for the relay's responsible terminal/application in System Settings, then restart that application if macOS requires it. No permission requests or resets are issued.",
            controllableDisplayIds: state.displays.filter(item => item.primary).map(item => item.id),
            secondaryDisplays: "Enumerated for diagnostics only. This system-tool backend permits capture and input only on the primary display; non-primary screencapture numbering is not assumed.",
            coordinates: "Quartz global display points; PNG pixels mapped with per-display scale",
            textMethod: "CGEventKeyboardSetUnicodeString; applications that ignore the Unicode event string may reject text." } };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        return { platform: "darwin", backend: "macos-quartz", available: false, displayKind: "none", inputKind: "none",
          displays: [], actions: [], unicodeText: true,
          permissions: { interactiveSession: "unknown", screenCapture: "unknown", accessibility: "unknown", input: "unknown" },
          reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async screenshot(displayId, context) {
      const started = Date.now();
      const state = await invoke({ op: "inspect" }, context) as unknown as MacInfo;
      if (!state.available) throw new ComputerError("INTERACTIVE_SESSION_REQUIRED", state.reason ?? "No interactive macOS display.");
      if (state.screenCapture !== true) throw new ComputerError("SCREEN_RECORDING_REQUIRED",
        "macOS Screen Recording permission is not granted to the relay responsible application. Enable it manually in System Settings.");
      const display = displayId ? state.displays.find((item) => item.id === displayId)
        : state.displays.find((item) => item.primary) ?? state.displays[0];
      if (!display) throw new ComputerError("DISPLAY_NOT_FOUND", "The requested macOS display is no longer active.");
      if (!display.primary) throw new ComputerError("DISPLAY_UNSUPPORTED", "This macOS backend currently supports capture and input only on the primary display.");
      const command = findExecutable(["/usr/sbin/screencapture"]);
      if (!command) throw new ComputerError("BACKEND_UNAVAILABLE", "The macOS system screencapture executable is unavailable.");
      const directory = await mkdtemp(join(tmpdir(), "mcp-relay-capture-"));
      const file = join(directory, "display.png");
      try {
        // Only the primary display has a documented unambiguous mapping: -D 1.
        const result = await runNative({ command, args: ["-x", "-t", "png", "-D", "1", file], maxOutputBytes: 64 * 1024 },
          { ...context, timeoutMs: Math.max(1, context.timeoutMs - (Date.now() - started)) });
        if (result.exitCode !== 0) throw new ComputerError("SCREEN_CAPTURE_FAILED", "macOS refused the screen capture; check Screen Recording permission and the active session.");
        const data = await readFile(file), dimensions = pngDimensions(data);
        const captured: ComputerDisplay = { ...publicDisplay(display), ...dimensions,
          scaleX: dimensions.width / display.nativeWidth, scaleY: dimensions.height / display.nativeHeight };
        return { data, mimeType: "image/png", display: captured, capturedAt: Date.now(), ...(state.app ? { app: state.app } : {}) };
      } finally {
        // Only this invocation's private, randomly named screenshot is removed.
        await unlink(file).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
      }
    },
    async act(action: ComputerAction, display: ComputerDisplay, context: NativeContext) {
      if (!display.primary) throw new ComputerError("DISPLAY_UNSUPPORTED", "Capture a fresh primary-display frame; input on other macOS displays is not supported by this backend.");
      let request: Record<string, unknown>, release: Record<string, unknown> | undefined;
      switch (action.type) {
        case "move": request = { op: "move", ...point(display, action.x, action.y) }; break;
        case "click":
          request = { op: "click", ...point(display, action.x, action.y), button: action.button ?? "left", clicks: action.clicks ?? 1 };
          release = { op: "release", button: action.button ?? "left", keys: [] }; break;
        case "drag": {
          const start = point(display, action.fromX, action.fromY), end = point(display, action.toX, action.toY);
          request = { op: "drag", ...start, toX: end.x, toY: end.y, durationMs: action.durationMs ?? 400 };
          release = { op: "release", button: "left", keys: [] }; break;
        }
        case "scroll":
          request = { op: "scroll", direction: action.direction, amount: action.amount ?? 3,
            point: action.x !== undefined && action.y !== undefined,
            ...(action.x !== undefined && action.y !== undefined ? point(display, action.x, action.y) : { x: 0, y: 0 }) }; break;
        case "key": {
          const chord = macosKeyChord(action.keys); request = { op: "key", ...chord };
          release = { op: "release", button: "", keys: chord.keys }; break;
        }
        case "text":
          request = { op: "text", text: action.text };
          release = { op: "release", button: "", keys: [0] }; break;
      }
      try { return { ...await invoke(request, context), submitted: true,
        verification: "Events submitted to macOS; the application outcome requires a fresh screenshot." }; }
      catch (error) {
        const beforeInput = error instanceof ComputerError && (error.details?.mayHaveApplied === false
          || (error.code === "cancelled" && error.details?.mayHaveApplied !== true) || ["INPUT_BUSY", "INTERACTIVE_SESSION_REQUIRED", "ACCESSIBILITY_REQUIRED",
          "INVALID_COORDINATES", "INVALID_ACTION", "INVALID_BUTTON", "BACKEND_UNAVAILABLE", "UNICODE_TEXT_UNAVAILABLE"].includes(error.code));
        if (release && !beforeInput) {
          try { await invoke(release, { timeoutMs: 3000 }); }
          catch (cleanup) {
            throw new ComputerError("INPUT_STATE_UNCERTAIN", "The input operation failed and macOS could not confirm releasing this action's keys/buttons.",
              { cause: error instanceof Error ? error.message : String(error),
                cleanup: cleanup instanceof Error ? cleanup.message : String(cleanup) });
          }
        }
        throw error;
      }
    },
  };
}
