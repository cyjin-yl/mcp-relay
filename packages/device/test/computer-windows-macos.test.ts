import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { createWindowsBackend, windowsKeyCodes } from "../src/computer/windows.js";
import { createMacosBackend, macosKeyChord } from "../src/computer/macos.js";
import { runNative } from "../src/computer/native.js";
import { ComputerError, type ComputerDisplay } from "../src/computer/types.js";

vi.mock("../src/computer/native.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/computer/native.js")>();
  return { ...original, findExecutable: vi.fn(() => "native-helper"), runNative: vi.fn() };
});
const run = vi.mocked(runNative);
const screen: ComputerDisplay = { id: "primary", x: -1440, y: 20, width: 2880, height: 1800, scaleX: 2, scaleY: 2, primary: true };
const ctx = { timeoutMs: 5000 };
const reply = (result: Record<string, unknown>) => ({ stdout: Buffer.from(JSON.stringify({ ok: true, result })), stderr: Buffer.alloc(0), exitCode: 0 });
const denied = (code: string) => ({ stdout: Buffer.from(JSON.stringify({ ok: false, code, message: code })), stderr: Buffer.alloc(0), exitCode: 1 });
function request(command: Parameters<typeof runNative>[0]): Record<string, unknown> {
  const input = String(command.input);
  const encoded = input.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1]
    ?? input.match(/initWithBase64EncodedStringOptions\('([A-Za-z0-9+/=]+)'/)?.[1];
  if (!encoded) throw new Error("Missing data-only native payload");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
}
beforeEach(() => { run.mockReset(); });

describe("Windows native boundary", () => {
  it("reports a noninteractive session as unavailable without input actions", async () => {
    run.mockResolvedValue(reply({ available: false, reason: "Session 0" }));
    const info = await createWindowsBackend().inspect(ctx);
    expect(info.available).toBe(false);
    expect(info.actions).toEqual([]);
    expect(info.permissions.interactiveDesktop).toBe("denied");
  });
  it("does not disguise a native helper failure as denied OS permission", async () => {
    run.mockResolvedValue({ stdout: Buffer.from("invalid"), stderr: Buffer.from("private diagnostic"), exitCode: 1 });
    const info = await createWindowsBackend().inspect(ctx);
    expect(info.available).toBe(false);
    expect(info.permissions.interactiveDesktop).toBe("unknown");
    expect(JSON.stringify(info)).not.toContain("private diagnostic");
  });
  it("maps pixels through the supplied negative-origin display scale", async () => {
    run.mockResolvedValue(reply({ performed: "move" }));
    await createWindowsBackend().act({ type: "move", x: 200, y: 100 }, screen, ctx);
    expect(request(run.mock.calls[0][0])).toEqual({ op: "move", x: -1340, y: 70 });
  });
  it("rejects out-of-frame points and unsupported keys before spawning", async () => {
    await expect(createWindowsBackend().act({ type: "click", x: -1, y: 3 }, screen, ctx)).rejects.toMatchObject({ code: "INVALID_COORDINATES" });
    expect(() => windowsKeyCodes(["F25"])).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("never releases keys held by the user when input was refused before application", async () => {
    run.mockResolvedValue(denied("INPUT_BUSY"));
    await expect(createWindowsBackend().act({ type: "key", keys: ["Ctrl", "a"] }, screen, ctx)).rejects.toMatchObject({ code: "INPUT_BUSY" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("uses a separate bounded cleanup after an interrupted native drag", async () => {
    const controller = new AbortController();
    run.mockImplementationOnce(async () => {
      controller.abort();
      throw new ComputerError("cancelled", "cancelled", { mayHaveApplied: true });
    }).mockResolvedValueOnce(reply({ performed: "release" }));
    await expect(createWindowsBackend().act({ type: "drag", fromX: 20, fromY: 20, toX: 80, toY: 50 }, screen, { ...ctx, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(request(run.mock.calls[1][0])).toEqual({ op: "release", button: "left", keys: [] });
    expect(run.mock.calls[1][1]).toEqual({ timeoutMs: 4000 });
  });
  it("does not send cleanup for a pre-spawn cancellation", async () => {
    run.mockRejectedValue(new ComputerError("cancelled", "cancelled", { mayHaveApplied: false }));
    await expect(createWindowsBackend().act({ type: "key", keys: ["Ctrl"] }, screen, ctx)).rejects.toMatchObject({ code: "cancelled" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not release any key when the action context was already aborted", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createWindowsBackend().act({ type: "text", text: "中文🙂" }, screen, { ...ctx, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("macOS native boundary", () => {
  const native = { available: true, displays: [{ ...screen, nativeWidth: 1440, nativeHeight: 900, captureIndex: 1 }],
    accessibility: false, inputAllowed: false, screenCapture: false, postEventAccess: false, unicodeText: true, onConsole: true, locked: false };
  function nativeSession(session: unknown, constant = "kCGSSessionOnConsoleKey") {
    run.mockImplementationOnce(async command => {
      // Execute the real JXA inspection code with framework calls replaced.
      // This checks bridge-value handling without pretending to test native OS grants.
      const source = String(command.input) + "\n(function(){try{return JSON.stringify({ok:true,result:inspect()});}catch(error){return JSON.stringify({ok:false,code:error.relayCode,message:error.message});}})()";
      const output = runInNewContext(source, {
        ObjC: { import() {}, bindFunction() {}, unwrap(value: unknown) { return value; }, deepUnwrap(value: unknown) { return value; } },
        $: {
          kCGSessionOnConsoleKey: constant, CGSessionCopyCurrentDictionary: () => session,
          NSScreen: { screens: { count: 1, objectAtIndex: () => ({ deviceDescription: { objectForKey: () => 1 }, backingScaleFactor: 1 }) } },
          CGDisplayBounds: () => ({ origin: { x: 0, y: 0 }, size: { width: 1024, height: 768 } }),
          CGDisplayRotation: () => 0, CGDisplayIsMain: () => true,
          NSWorkspace: { sharedWorkspace: { frontmostApplication: { isNil: () => true } } },
          AXIsProcessTrusted: () => true, CGPreflightPostEventAccess: () => true, CGPreflightScreenCaptureAccess: () => true,
        },
      }, { timeout: 1000 }) as string;
      return { stdout: Buffer.from(output), stderr: Buffer.alloc(0), exitCode: 0 };
    });
  }
  it("recognizes the framework console key with native Boolean and NSNumber bridge values", async () => {
    for (const value of [true, 1, false, 0]) {
      nativeSession({ kCGSSessionOnConsoleKey: value });
      const info = await createMacosBackend().inspect(ctx);
      expect(info.available).toBe(value === true || value === 1);
      expect(info.permissions.interactiveSession).toBe(value === true || value === 1 ? "granted" : "denied");
    }
    nativeSession({ actualFrameworkKey: 1 }, "actualFrameworkKey");
    expect((await createMacosBackend().inspect(ctx)).available).toBe(true);
  });
  it("treats an unknown session dictionary as a helper failure rather than an OS permission denial", async () => {
    for (const session of [{}, { kCGSSessionOnConsoleKey: "1" }, { kCGSSessionOnConsoleKey: 2 }, { kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: "false" }]) {
      nativeSession(session);
      const info = await createMacosBackend().inspect(ctx);
      expect(info.available).toBe(false);
      expect(info.permissions.interactiveSession).toBe("unknown");
      expect(info.reason).toMatch(/session dictionary|unrecognized/);
    }
    nativeSession(null);
    expect((await createMacosBackend().inspect(ctx)).permissions.interactiveSession).toBe("denied");
    nativeSession({ kCGSSessionOnConsoleKey: 1, CGSSessionScreenIsLocked: 1 });
    expect((await createMacosBackend().inspect(ctx)).available).toBe(false);
  });
  it("keeps display availability distinct from TCC input and capture grants", async () => {
    run.mockResolvedValue(reply(native));
    const info = await createMacosBackend().inspect(ctx);
    expect(info.available).toBe(true);
    expect(info.permissions.screenCapture).toBe("denied");
    expect(info.permissions.accessibility).toBe("denied");
    expect(info.actions).toEqual([]);
  });
  it("does not advertise Unicode input when its native buffer binding is unavailable", async () => {
    run.mockResolvedValue(reply({ ...native, inputAllowed: true, accessibility: true, unicodeText: false }));
    const info = await createMacosBackend().inspect(ctx);
    expect(info.unicodeText).toBe(false);
    expect(info.actions).toContain("key");
    expect(info.actions).not.toContain("text");
  });
  it("does not launch screencapture or request authorization without a capture grant", async () => {
    run.mockResolvedValue(reply(native));
    await expect(createMacosBackend().screenshot(undefined, ctx)).rejects.toMatchObject({ code: "SCREEN_RECORDING_REQUIRED" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(request(run.mock.calls[0][0])).toEqual({ op: "inspect" });
  });
  it("refuses non-primary capture and input instead of guessing display numbering", async () => {
    run.mockResolvedValue(reply({ ...native, screenCapture: true, displays: [{ ...native.displays[0], primary: false }] }));
    await expect(createMacosBackend().screenshot("primary", ctx)).rejects.toMatchObject({ code: "DISPLAY_UNSUPPORTED" });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(createMacosBackend().act({ type: "click", x: 20, y: 30 }, { ...screen, primary: false }, ctx)).rejects.toMatchObject({ code: "DISPLAY_UNSUPPORTED" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("maps Retina pixels to native global points including a negative origin", async () => {
    run.mockResolvedValue(reply({ performed: "move" }));
    await createMacosBackend().act({ type: "move", x: 600, y: 400 }, screen, ctx);
    expect(request(run.mock.calls[0][0])).toEqual({ op: "move", x: -1140, y: 220 });
  });
  it("maps native shortcuts and rejects nonexistent macOS function keys", () => {
    expect(macosKeyChord(["Meta", "a"])).toEqual({ keys: [55, 0], flags: 0x100000, modifiersOnly: false });
    expect(macosKeyChord(["Meta", "Cmd", "a"])).toEqual({ keys: [55, 0], flags: 0x100000, modifiersOnly: false });
    expect(macosKeyChord(["Ctrl", "Shift"])).toEqual({ keys: [59, 56], flags: 0x60000, modifiersOnly: true });
    expect(() => macosKeyChord(["F24"])).toThrow();
  });
  type KeyEvent = { code: number; down: boolean; flags: number; type: number };
  async function nativeKeyEvents(keys: string[], failDownCode?: number) {
    run.mockResolvedValue(reply({ performed: "key" }));
    await createMacosBackend().act({ type: "key", keys }, screen, ctx);
    const command = run.mock.calls.at(-1)![0], posted: KeyEvent[] = [];
    let injected = false;
    // Execute the actual event lifecycle; native permission/session checks are
    // separately covered above and stubbed only for this deterministic unit test.
    const source = String(command.input) + "\nrequireInput=function(){};\n" +
      "(function(){try{action(" + JSON.stringify(request(command)) +
      ");return JSON.stringify({ok:true});}catch(error){return JSON.stringify({ok:false,error:error.message});}})()";
    const result = JSON.parse(runInNewContext(source, {
      ObjC: { import() {}, bindFunction() {} },
      $: {
        CGEventCreateKeyboardEvent: (_source: unknown, code: number, down: boolean) => ({ code, down, flags: 0, type: down ? 10 : 11 }),
        CGEventSetType: (event: KeyEvent, type: number) => { event.type = type; },
        CGEventSetFlags: (event: KeyEvent, flags: number) => { event.flags = flags; },
        CGEventPost: (_tap: number, event: KeyEvent) => {
          posted.push({ ...event });
          if (!injected && event.down && event.code === failDownCode) { injected = true; throw new Error("injected post failure"); }
        },
      },
    }, { timeout: 1000 }) as string) as { ok: boolean; error?: string };
    return { posted, result };
  }
  it("posts real modifier down/up around a shortcut and leaves final flags clear", async () => {
    const { posted, result } = await nativeKeyEvents(["Meta", "a"]);
    expect(result.ok).toBe(true);
    expect(posted).toEqual([
      { code: 55, down: true, flags: 0x100000, type: 12 },
      { code: 0, down: true, flags: 0x100000, type: 10 },
      { code: 0, down: false, flags: 0x100000, type: 11 },
      { code: 55, down: false, flags: 0, type: 12 },
    ]);
  });
  it("preserves a shared left/right modifier flag until both keys are released", async () => {
    const { posted, result } = await nativeKeyEvents(["ShiftL", "ShiftR", "a"]);
    expect(result.ok).toBe(true);
    expect(posted.map(event => [event.code, event.down, event.flags])).toEqual([
      [56, true, 0x20000], [60, true, 0x20000], [0, true, 0x20000],
      [0, false, 0x20000], [60, false, 0x20000], [56, false, 0],
    ]);
  });
  it("releases every owned modifier in finally after a possibly applied key failure", async () => {
    const { posted, result } = await nativeKeyEvents(["Meta", "a"], 0);
    expect(result).toEqual({ ok: false, error: "injected post failure" });
    expect(posted.slice(-2).map(event => [event.code, event.down, event.flags])).toEqual([
      [0, false, 0x100000], [55, false, 0],
    ]);
  });
  it("includes this chord's modifiers in independent timeout cleanup", async () => {
    run.mockRejectedValueOnce(new ComputerError("timeout", "timeout", { mayHaveApplied: true }))
      .mockResolvedValueOnce(reply({ performed: "release" }));
    await expect(createMacosBackend().act({ type: "key", keys: ["Meta", "a"] }, screen, ctx)).rejects.toMatchObject({ code: "timeout" });
    expect(request(run.mock.calls[1][0])).toEqual({ op: "release", button: "", keys: [55, 0] });
    expect(run.mock.calls[1][1]).toEqual({ timeoutMs: 3000 });
  });
  it("does not release user-held modifiers after permission or busy refusal", async () => {
    run.mockResolvedValue(denied("ACCESSIBILITY_REQUIRED"));
    await expect(createMacosBackend().act({ type: "key", keys: ["Meta", "a"] }, screen, ctx)).rejects.toMatchObject({ code: "ACCESSIBILITY_REQUIRED" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("uses independent cleanup after a possibly applied native timeout", async () => {
    run.mockRejectedValueOnce(new ComputerError("timeout", "timeout", { mayHaveApplied: true }))
      .mockResolvedValueOnce(reply({ performed: "release" }));
    await expect(createMacosBackend().act({ type: "drag", fromX: 20, fromY: 30, toX: 200, toY: 200 }, screen, ctx)).rejects.toMatchObject({ code: "timeout" });
    expect(request(run.mock.calls[1][0])).toEqual({ op: "release", button: "left", keys: [] });
    expect(run.mock.calls[1][1]).toEqual({ timeoutMs: 3000 });
  });
});
