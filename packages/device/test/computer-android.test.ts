import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANDROID_INPUT_METHOD, createAndroidBackend, parseAndroidGeometry, parseAndroidApp, parseAndroidLock, androidKeyCode, parseAndroidInstallFailure
} from "../src/computer/android.js";
import { ComputerError, type NativeCommand, type NativeContext, type NativeResult } from "../src/computer/types.js";

const artifact = Buffer.alloc(1400, 90);
const bridge = { version: "0.1.0", versionCode: 1, sha256: createHash("sha256").update(artifact).digest("hex"), base64: artifact.toString("base64") };
const context: NativeContext = { timeoutMs: 30000 };
const display = { id: "0", x: 0, y: 0, width: 1200, height: 2000, scaleX: 1, scaleY: 1, rotation: 0 };
const ok = (stdout = "", exitCode = 0): NativeResult => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode });

function probe(installed = true, combo = true, real = "1200 x 2000", rotation = 0, selected = "org.example.keyboard/.Ime", policy = "KeyguardServiceDelegate\n  showing=false\n  inputRestricted=false", power = "mWakefulness=Awake") {
  const fields: Record<string, string> = {
    uid: "0", sdk: "34", user: "0", timeout: "yes", input: "yes", capture: "yes",
    input_help: "tap swipe motionevent keyevent" + (combo ? " keycombination" : ""),
    display: 'mDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, real ' + real + ", rotation " + rotation + ", type BUILT_IN}",
    window: "mCurrentFocus=Window{11 u0 dev.cyjin.mcprelay.input/.ProbeActivity}",
    policy, power, size: "Physical size: 1200x2000", ime_selected: selected, ime_enabled: "org.example.keyboard/.Ime",
    bridge_sha: installed ? bridge.sha256 + " /data/app/bridge/base.apk" : ""
  };
  return Object.entries(fields).map(([key, value]) => "__RELAY_ANDROID_" + key + "__\n" + value).join("\n") + "\n";
}
function png(): Buffer {
  const value = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value);
  value.writeUInt32BE(13, 8); value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(1200, 16); value.writeUInt32BE(2000, 20);
  return value;
}
function requestId(spec: NativeCommand): string {
  const match = /__RELAY_IME_RESTORED__([a-f0-9]{32})/.exec(String(spec.input));
  if (!match) throw new Error("request marker absent");
  return match[1]!;
}
function fixture(options: {
  installed?: boolean; combo?: boolean; real?: string; rotation?: number; policy?: string; power?: string;
  act?: (spec: NativeCommand, index: number) => Promise<NativeResult> | NativeResult;
  probe?: (spec: NativeCommand, index: number) => Promise<NativeResult> | NativeResult;
  install?: (spec: NativeCommand) => Promise<NativeResult> | NativeResult;
} = {}) {
  const calls: NativeCommand[] = [];
  let installed = options.installed ?? true, clock = 0, actionIndex = 0, probeIndex = 0;
  const waits: number[] = [];
  const backend = createAndroidBackend({
    find: () => "/system/xbin/su", bridge, now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; },
    run: async spec => {
      calls.push(spec);
      if (typeof spec.input === "string" && spec.input.includes("__RELAY_ANDROID_uid__")) {
        if (options.probe) return options.probe(spec, probeIndex++);
        return ok(probe(installed, options.combo, options.real, options.rotation, undefined, options.policy, options.power));
      }
      if (spec.args[1]?.includes("/system/bin/screencap -p")) return { stdout: png(), stderr: Buffer.alloc(0), exitCode: 0 };
      if (Buffer.isBuffer(spec.input)) {
        expect(spec.input.equals(artifact)).toBe(true);
        if (options.install) return options.install(spec);
        installed = true;
        return ok("Success\n");
      }
      if (options.act) return options.act(spec, actionIndex++);
      if (String(spec.input).includes("__RELAY_IME_RESTORED__")) {
        const request = requestId(spec);
        return ok('Broadcast completed: result=-1, data="relay-input:' + request + ':ok"\n__RELAY_IME_RESTORED__' + request + ":1\n");
      }
      return ok();
    }
  });
  return { backend, calls, waits };
}

describe("Android display and input metadata", () => {
  it("takes explicitly identified current default display information", () => {
    const text = 'mDisplayInfo=DisplayInfo{"External", displayId 2, real 900 x 600, rotation 0}\n'
      + 'mDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 2000 x 1200, rotation 1}';
    expect(parseAndroidGeometry(text, "", "")).toEqual({ width: 2000, height: 1200, rotation: 1, source: "display-info" });
  });
  it("uses the observed landscape override and default frames instead of the natural base", () => {
    const base = 'mBaseDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 1840 x 2944, rotation 0}';
    const override = 'mOverrideDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 2944 x 1840, rotation 1}';
    const window = "Display: mDisplayId=0\n  DisplayFrames w=2944 h=1840 r=1\n  mRotation=1";
    expect(parseAndroidGeometry(base + "\n" + override, window, "Physical size: 1840x2944"))
      .toEqual({ width: 2944, height: 1840, rotation: 1, source: "display-frames" });
    expect(parseAndroidGeometry(base + "\n" + override + "\n" + override, "", ""))
      .toEqual({ width: 2944, height: 1840, rotation: 1, source: "display-info" });
  });
  it("ignores embedded Configuration rotations in a sanitized real default-display dump", () => {
    const captured: { display: string; window: string; size: string } =
      JSON.parse(readFileSync(new URL("./fixtures/android-default-display-config-rotation.json", import.meta.url), "utf8"));
    expect(parseAndroidGeometry(captured.display, captured.window, captured.size))
      .toEqual({ width: 2944, height: 1840, rotation: 1, source: "display-frames" });
    // A malformed or conflicting standalone runtime field must still fail closed.
    expect(parseAndroidGeometry(captured.display, captured.window.replace("    mRotation=1 #", "    mRotation=undefined #"), captured.size)).toBeUndefined();
    expect(parseAndroidGeometry(captured.display, captured.window.replace("    mRotation=1 #", "    mRotation=0 #"), captured.size)).toBeUndefined();
    expect(parseAndroidGeometry("", "Display: mDisplayId=0\n  configuration={mRotation=ROTATION_90}", "Physical size: 1840x2944")).toBeUndefined();
  });
  it("keeps frames and rotation inside the explicit default window block", () => {
    const external = "Display: mDisplayId=2\n  DisplayFrames w=900 h=600 r=0\n  mRotation=0";
    const primary = "Display: mDisplayId=0\n  DisplayFrames w=2944 h=1840 r=1\n  mRotation=1";
    expect(parseAndroidGeometry("", external + "\n" + primary + "\nWINDOW MANAGER WINDOWS\n  DisplayFrames w=7 h=8 r=2", ""))
      .toEqual({ width: 2944, height: 1840, rotation: 1, source: "display-frames" });
    expect(parseAndroidGeometry("", "Display: mDisplayId=0\n  noCurrentGeometry\n" + external, "Physical size: 1840x2944"))
      .toBeUndefined();
  });
  it.each([
    ['unscoped info', 'mDisplayInfo=DisplayInfo{"Unknown", real 2944 x 1840, rotation 1}', ""],
    ['unscoped frames', "", "DisplayFrames w=2944 h=1840 r=1\nmRotation=1"],
    ['external only', 'mDisplayInfo=DisplayInfo{"External", displayId 2, real 900 x 600, rotation 0}', "Display: mDisplayId=2\n  mRotation=1"]
  ])("refuses %s rather than assuming the first display is default", (_name, info, window) => {
    expect(parseAndroidGeometry(info!, window!, "Physical size: 1840x2944")).toBeUndefined();
  });
  it("refuses conflicting or invalid effective default information", () => {
    const current = 'mDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 2944 x 1840, rotation 1}';
    const conflicting = 'mOverrideDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 1840 x 2944, rotation 0}';
    expect(parseAndroidGeometry(current + "\n" + conflicting, "", "")).toBeUndefined();
    expect(parseAndroidGeometry(current, "Display: mDisplayId=0\n  DisplayFrames w=1840 h=2944 r=0", "")).toBeUndefined();
    expect(parseAndroidGeometry(current, "Display: mDisplayId=0\n  DisplayFrames w=0 h=0 r=1", "")).toBeUndefined();
    expect(parseAndroidGeometry('mOverrideDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 0 x 0, rotation 1}',
      "Display: mDisplayId=0\n  DisplayFrames w=2944 h=1840 r=1", "")).toBeUndefined();
    expect(parseAndroidGeometry('mBaseDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 1840 x 2944, rotation 0}\n'
      + 'mOverrideDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 0 x 0, rotation 1}', "", "")).toBeUndefined();
  });
  it("uses base-only geometry only when its explicit default override is null", () => {
    const base = 'mBaseDisplayInfo=DisplayInfo{"Built-in", displayId 0, real 1840 x 2944, rotation 0}';
    expect(parseAndroidGeometry(base, "", "")).toBeUndefined();
    const logical = "Logical Displays:\n  Display 0:\n    mDisplayId=0\n    " + base + "\n    mOverrideDisplayInfo=null\n"
      + '  Display 2:\n    mDisplayId=2\n    mOverrideDisplayInfo=DisplayInfo{"External", displayId 2, real 900 x 600, rotation 0}';
    expect(parseAndroidGeometry(logical, "", "")).toEqual({ width: 1840, height: 2944, rotation: 0, source: "display-info" });
    expect(parseAndroidGeometry(logical.replace("    mOverrideDisplayInfo=null\n", ""), "", "")).toBeUndefined();
  });
  it("uses wm override dimensions only with an observed default-display rotation", () => {
    expect(parseAndroidGeometry("", "Display: mDisplayId=0\n  mRotation=ROTATION_90", "Physical size: 1200x2000\nOverride size: 600x1000"))
      .toEqual({ width: 1000, height: 600, rotation: 1, source: "wm-size" });
    expect(parseAndroidGeometry("", "", "Physical size: 1200x2000")).toBeUndefined();
    expect(parseAndroidGeometry("", "mRotation=ROTATION_90", "Physical size: 1200x2000")).toBeUndefined();
    expect(parseAndroidGeometry("", "Display: mDisplayId=0\n  mRotation=0\n  mRotation=1", "Physical size: 1200x2000")).toBeUndefined();
    expect(parseAndroidGeometry("", "Display: mDisplayId=0\n  mRotation=4", "Physical size: 1200x2000")).toBeUndefined();
  });
  it("extracts only the focused component rather than window text", () => {
    expect(parseAndroidApp("mCurrentFocus=Window{abc u0 com.example/.Editor}")).toEqual({ id: "com.example/.Editor", title: "com.example" });
    expect(parseAndroidApp("mCurrentFocus=null")).toBeUndefined();
  });
  it("maps explicit key aliases and refuses arbitrary native arguments", () => {
    expect(androidKeyCode("Control")).toBe("KEYCODE_CTRL_LEFT");
    expect(androidKeyCode("ArrowLeft")).toBe("KEYCODE_DPAD_LEFT");
    expect(() => androidKeyCode("A; reboot")).toThrow(ComputerError);
  });
});

describe("Android computer backend", () => {
  it("recognizes keyguard state without treating secure capability as a lock", () => {
    expect(parseAndroidLock("KeyguardServiceDelegate\n  showing=true\n  occluded=true", "mWakefulness=Awake").locked).toBe(true);
    expect(parseAndroidLock("mShowingLockscreen=false", "mWakefulness=Awake")).toMatchObject({ locked: false, interactive: true });
    expect(parseAndroidLock("secure=true\nvendorSpecificStatus=7", "vendorAwake=1")).toMatchObject({ locked: undefined, interactive: undefined });
  });
  it("blocks input on a known locked device and reports unavailable", async () => {
    const test = fixture({ policy: "mKeyguardShowing=true" });
    const info = await test.backend.inspect(context);
    expect(info).toMatchObject({ available: false, actions: [], details: { locked: true } });
    await expect(test.backend.act({ type: "click", x: 5, y: 5 }, display, context)).rejects.toMatchObject({ code: "android_locked", details: { mayHaveApplied: false } });
    expect(test.calls.some(call => String(call.input).includes("'tap'"))).toBe(false);
  });
  it("does not wake a sleeping device with a synthetic key", async () => {
    const test = fixture({ power: "mWakefulness=Asleep" });
    await expect(test.backend.act({ type: "key", keys: ["HOME"] }, display, context)).rejects.toMatchObject({ code: "android_not_interactive" });
    expect(test.calls.some(call => String(call.input).includes("'keyevent'"))).toBe(false);
  });
  it("reports unrecognized OEM lock state as unknown", async () => {
    const test = fixture({ policy: "OEM_POLICY_UNRECOGNIZED=1", power: "OEM_POWER_UNRECOGNIZED=1" });
    expect(await test.backend.inspect(context)).toMatchObject({ details: { locked: "unknown", interactive: "unknown" }, permissions: { unlockedSession: "unknown" } });
  });
  it("inspects and captures without installing or enabling an IME", async () => {
    const test = fixture({ installed: false });
    const info = await test.backend.inspect(context);
    expect(info.available).toBe(true);
    expect(info.unicodeText).toBe(false);
    expect(info.inputKind).toBe("touch");
    expect(info.displays[0]?.width).toBe(1200);
    expect(test.calls.every(call => !Buffer.isBuffer(call.input))).toBe(true);
    expect(test.calls.some(call => /ime (?:enable|set|disable)\b/.test(String(call.input)))).toBe(false);
  });
  it("installs the verified APK once using Android's stdin option boundary", async () => {
    let installed = false;
    // External contract: BasicShellCommandHandler.getNextOption consumes all "-" prefixes
    // until "--"; PackageManagerShellCommand accepts the stdin "-" only after that scan.
    // https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/88c7ff1cd72d6305ec59f97aadc2198cc2dc3592/android-34/com/android/modules/utils/BasicShellCommandHandler.java
    const packageInstall = (args: string[], input: Buffer): NativeResult => {
      let index = 0, replace = false, user: string | undefined, size: string | undefined;
      while (index < args.length && args[index]!.startsWith("-")) {
        const option = args[index++]!;
        if (option === "--") break;
        if (option === "-r") replace = true;
        else if (option === "--user") user = args[index++];
        else if (option === "-S") size = args[index++];
        else return { stdout: Buffer.alloc(0), stderr: Buffer.from("Error: Unknown option: " + option), exitCode: 255 };
      }
      expect(args.slice(index)).toEqual(["-"]);
      expect({ replace, user, size }).toEqual({ replace: true, user: "0", size: String(input.length) });
      expect(input.equals(artifact)).toBe(true);
      installed = true;
      return ok("Success\n");
    };
    const rejected = packageInstall(["-r", "--user", "0", "-S", String(artifact.length), "-"], artifact);
    expect(rejected.exitCode).toBe(255);
    expect(rejected.stderr.toString()).toBe("Error: Unknown option: -");
    expect(installed).toBe(false);

    const test = fixture({
      installed: false,
      probe: () => ok(probe(installed)),
      install: spec => {
        expect(Buffer.isBuffer(spec.input)).toBe(true);
        // All pm words here are fixed option names, a fixed executable, or numeric values.
        const argv = [...spec.args[1]!.matchAll(/'([^']*)'/g)].map(match => match[1]!);
        expect(argv.slice(0, 2)).toEqual(["/system/bin/pm", "install"]);
        return packageInstall(argv.slice(2), spec.input as Buffer);
      }
    });
    expect(await test.backend.setup!(context)).toMatchObject({ installed: true, changed: true, sha256: bridge.sha256, inputMethodChanged: false });
    const install = test.calls.find(call => Buffer.isBuffer(call.input))!;
    expect(install.args[1]).toContain("timeout");
    const second = await test.backend.setup!(context);
    expect(second).toMatchObject({ installed: true, changed: false });
    expect(test.calls.filter(call => Buffer.isBuffer(call.input))).toHaveLength(1);
  });
  it("refuses text until setup rather than using input text for Unicode", async () => {
    const test = fixture({ installed: false });
    await expect(test.backend.act({ type: "text", text: "中文" }, display, context)).rejects.toMatchObject({ code: "android_setup_required" });
    expect(test.calls.filter(call => String(call.input).includes("ime enable"))).toHaveLength(0);
  });
  it("sends Unicode and shell metacharacters only as base64 and restores the original IME", async () => {
    const test = fixture();
    const text = "中文🙂\n'$(touch /tmp/not-executed)%s";
    const result = await test.backend.act({ type: "text", text }, display, context);
    expect(result).toMatchObject({ applied: true, acknowledged: true, inputMethodRestored: true });
    const script = String(test.calls.find(call => String(call.input).includes("ime enable"))?.input);
    expect(script).toContain(Buffer.from(text).toString("base64"));
    expect(script).not.toContain("$(touch /tmp/not-executed)");
    expect(script).toContain("trap relay_restore_input EXIT");
    expect(script).toContain("'org.example.keyboard/.Ime'");
    expect(script).toContain("'disable' '--user' '0' '" + ANDROID_INPUT_METHOD + "'");
    expect(script).toContain("'expected_package' 'dev.cyjin.mcprelay.input'");
  });
  it("requires the exact request acknowledgement and never replays a failed text", async () => {
    const test = fixture({ act: spec => {
      const request = requestId(spec);
      return ok('Broadcast completed: result=20, data="relay-input:' + request + ':no_input_connection"\n__RELAY_IME_RESTORED__' + request + ":1\n");
    } });
    await expect(test.backend.act({ type: "text", text: "一次" }, display, context)).rejects.toMatchObject({ code: "android_text_unconfirmed", details: { mayHaveApplied: true } });
    expect(test.calls.filter(call => String(call.input).includes("'.COMMIT'"))).toHaveLength(0);
    expect(test.calls.filter(call => String(call.input).includes("ime enable"))).toHaveLength(1);
  });
  it("keeps the lane until the root deadline and cleans up after client cancellation", async () => {
    const test = fixture({ act: (spec, index) => {
      if (index === 0) throw new ComputerError("cancelled", "cancelled", { mayHaveApplied: true });
      const request = requestId(spec);
      return ok("__RELAY_IME_RESTORED__" + request + ":1\n");
    } });
    await expect(test.backend.act({ type: "text", text: "不重试" }, display, context)).rejects.toMatchObject({ code: "cancelled", details: { mayHaveApplied: true } });
    expect(test.waits.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(19000);
    expect(test.calls.filter(call => String(call.input).includes("ime enable"))).toHaveLength(1);
    expect(test.calls.filter(call => String(call.input).includes("relay_restore_input"))).toHaveLength(2);
  });
  it("does not type malformed UTF-16 or oversized text", async () => {
    const test = fixture();
    await expect(test.backend.act({ type: "text", text: "\ud800" }, display, context)).rejects.toMatchObject({ code: "invalid_text" });
    await expect(test.backend.act({ type: "text", text: "中".repeat(22000) }, display, context)).rejects.toMatchObject({ code: "text_too_large" });
    expect(test.calls.some(call => String(call.input).includes("ime enable"))).toBe(false);
  });
  it("rejects stale rotation before coordinates are injected", async () => {
    const test = fixture({ real: "2000 x 1200", rotation: 1 });
    await expect(test.backend.act({ type: "click", x: 20, y: 20 }, display, context)).rejects.toMatchObject({ code: "display_changed" });
    expect(test.calls.some(call => String(call.input).includes("'tap'"))).toBe(false);
  });
  it("converts screenshot pixels to native input coordinates", async () => {
    const test = fixture();
    await test.backend.act({ type: "click", x: 300, y: 500 }, { ...display, width: 600, height: 1000, scaleX: 0.5, scaleY: 0.5 }, context);
    expect(String(test.calls.at(-1)?.input)).toContain("'tap' '600' '1000'");
  });
  it("does not pretend separate keyevents are a key chord", async () => {
    const test = fixture({ combo: false });
    await expect(test.backend.act({ type: "key", keys: ["CTRL", "A"] }, display, context)).rejects.toMatchObject({ code: "unsupported_key_combination" });
    expect(test.calls.some(call => String(call.input).includes("'keyevent'"))).toBe(false);
  });
  it("rejects hover, secondary clicks, and overlong gestures", async () => {
    const test = fixture();
    await expect(test.backend.act({ type: "move", x: 5, y: 5 }, display, context)).rejects.toMatchObject({ code: "unsupported_action" });
    await expect(test.backend.act({ type: "click", button: "right", x: 5, y: 5 }, display, context)).rejects.toMatchObject({ code: "unsupported_button" });
    await expect(test.backend.act({ type: "drag", fromX: 1, fromY: 1, toX: 2, toY: 2, durationMs: 6000 }, display, context)).rejects.toMatchObject({ code: "invalid_duration" });
  });
});

describe("Android setup failure boundaries", () => {
  it("labels failed preflight without exposing native output or attempting install", async () => {
    const test = fixture({ installed: false, probe: () => ({
      ...ok("private-native-stdout", 255), stderr: Buffer.from("java.lang.SecurityException: private-native-stderr")
    }) });
    const error = await test.backend.setup!(context).catch(error => error);
    expect(error).toMatchObject({ code: "android_command_failed",
      details: { exitCode: 255, phase: "preflight", mayHaveApplied: false } });
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain("private-native");
    expect(error.details).not.toHaveProperty("packageManagerCategory");
    expect(test.calls).toHaveLength(1);
    expect(test.calls.some(call => Buffer.isBuffer(call.input))).toBe(false);
  });
  it("retains an explicit cancellation before the installer starts", async () => {
    const controller = new AbortController();
    const test = fixture({ installed: false, probe: () => {
      controller.abort();
      return ok(probe(false));
    } });
    await expect(test.backend.setup!({ ...context, signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled", details: { phase: "install", mayHaveApplied: false }
    });
    expect(test.calls).toHaveLength(1);
    expect(test.calls.some(call => Buffer.isBuffer(call.input))).toBe(false);
  });
  it("keeps installation uncertainty and safe package code without retrying", async () => {
    const test = fixture({ installed: false, install: () => ({
      ...ok("Failure [INSTALL_FAILED_USER_RESTRICTED: private-install-stdout]", 255),
      stderr: Buffer.from("private-install-stderr")
    }) });
    const error = await test.backend.setup!(context).catch(error => error);
    expect(error).toMatchObject({ code: "android_command_failed", details: {
      exitCode: 255, phase: "install", mayHaveApplied: true, packageManagerCode: "INSTALL_FAILED_USER_RESTRICTED"
    } });
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain("private-install");
    expect(test.calls).toHaveLength(2);
    expect(test.calls.filter(call => Buffer.isBuffer(call.input))).toHaveLength(1);
    expect(test.waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(16000);
  });
  it("keeps a successful install uncertain when its read-only verification fails", async () => {
    const test = fixture({ installed: false, probe: (_spec, index) =>
      index === 0 ? ok(probe(false)) : ok("", 255) });
    await expect(test.backend.setup!(context)).rejects.toMatchObject({ code: "android_command_failed",
      details: { exitCode: 255, phase: "verification", mayHaveApplied: true } });
    expect(test.calls).toHaveLength(3);
    expect(test.calls.filter(call => Buffer.isBuffer(call.input))).toHaveLength(1);
  });
  it("labels an installed APK hash mismatch as verification uncertainty", async () => {
    const test = fixture({ installed: false, probe: () => ok(probe(false)) });
    await expect(test.backend.setup!(context)).rejects.toMatchObject({
      code: "android_bridge_install_unconfirmed", details: { phase: "verification", mayHaveApplied: true }
    });
    expect(test.calls.filter(call => Buffer.isBuffer(call.input))).toHaveLength(1);
  });
  it("sanitizes unexpected verification errors after installation", async () => {
    const test = fixture({ installed: false, probe: (_spec, index) => {
      if (index === 0) return ok(probe(false));
      throw new Error("private-verification-input");
    } });
    const error = await test.backend.setup!(context).catch(error => error);
    expect(error).toMatchObject({ code: "android_setup_failed",
      details: { phase: "verification", mayHaveApplied: true } });
    expect(error.message).not.toContain("private-verification-input");
    expect(test.calls.filter(call => Buffer.isBuffer(call.input))).toHaveLength(1);
  });
});

describe("Android install failure diagnostics", () => {
  it.each(["INSTALL_FAILED_USER_RESTRICTED", "INSTALL_PARSE_FAILED_BAD_MANIFEST"])(
    "returns only the bounded package-manager code %s", code => {
      expect(parseAndroidInstallFailure("Failure [" + code + ": /private/app.apk]", "private user input"))
        .toEqual({ packageManagerCode: code });
    });
  it.each([
    ["java.lang.SecurityException: /private/app.apk", "package_manager_security_exception"],
    ["Error: Unknown option --private-value", "unsupported_install_option"],
    ["cmd: Can't find service: package", "package_service_unavailable"]
  ])("classifies installation failure without returning native text", (message, category) => {
    expect(parseAndroidInstallFailure("private stdout", message + "\nprivate user input"))
      .toEqual({ packageManagerCategory: category });
  });
  it("omits unknown output and overlong or malformed codes", () => {
    for (const output of [
      "Failure [/private/app.apk: private user input]",
      "INSTALL_FAILED_" + "X".repeat(81),
      "INSTALL_FAILED_secret_value"
    ]) expect(parseAndroidInstallFailure(output, "")).toEqual({});
  });
});
