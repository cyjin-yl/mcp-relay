import { createHash, randomBytes } from "node:crypto";
import { ANDROID_BRIDGE } from "./android-bridge.generated.js";
import { findExecutable, pngDimensions, runNative } from "./native.js";
import {
  ComputerError, nativePoint, type ComputerAction, type ComputerBackend, type ComputerDisplay,
  type ComputerState, type NativeCommand, type NativeContext, type NativeResult
} from "./types.js";

export const ANDROID_INPUT_PACKAGE = "dev.cyjin.mcprelay.input";
export const ANDROID_INPUT_METHOD = ANDROID_INPUT_PACKAGE + "/.RelayInputService";
const RECEIVER = ANDROID_INPUT_PACKAGE + "/.CommitReceiver";
const MAX_TEXT_BYTES = 65_536;
const MAX_GESTURE_MS = 5_000;
const SHELL = "/system/bin/sh";
const TOYBOX = "/system/bin/toybox";

export interface AndroidBridgeArtifact {
  version: string;
  versionCode: number;
  sha256: string;
  base64: string;
}
export interface AndroidBackendRuntime {
  run?: (spec: NativeCommand, context: NativeContext) => Promise<NativeResult>;
  find?: typeof findExecutable;
  env?: NodeJS.ProcessEnv;
  bridge?: AndroidBridgeArtifact;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Geometry {
  width: number;
  height: number;
  rotation?: number;
  source: "display-info" | "display-frames" | "wm-size";
}
interface Probe {
  uid: number;
  sdk: number;
  user: number;
  timeout: boolean;
  input: boolean;
  capture: boolean;
  inputHelp: string;
  geometry?: Geometry;
  app?: { id: string; title?: string };
  selectedIme?: string;
  enabledImes: string[];
  bridgeSha256?: string;
  locked?: boolean;
  interactive?: boolean;
  lockEvidence: string[];
}
function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function validDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 32768;
}
function sections(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /^__RELAY_ANDROID_([a-z_]+)__\r?$/gm;
  const markers = [...text.matchAll(pattern)];
  markers.forEach((match, index) => {
    result[match[1]!] = text.slice(match.index! + match[0].length, markers[index + 1]?.index ?? text.length).trim();
  });
  return result;
}

/** Parse only display metadata. No UI text or app document content is inspected. */
export function parseAndroidGeometry(display: string, window: string, size: string): Geometry | undefined {
  const candidates = display.split(/\r?\n/).filter(line => line.includes("DisplayInfo{"));
  for (const line of candidates) {
    if (/\bdisplayId\s+[1-9]\d*\b/.test(line)) continue;
    const real = /\breal\s+(\d+)\s*x\s*(\d+)/.exec(line);
    if (!real) continue;
    const width = Number(real[1]), height = Number(real[2]);
    if (!validDimension(width) || !validDimension(height)) continue;
    const rotation = /\brotation\s+([0-3])\b/.exec(line);
    return { width, height, rotation: rotation ? Number(rotation[1]) : undefined, source: "display-info" };
  }
  const defaultSection = /Display:\s*mDisplayId=0\b([\s\S]*?)(?=\n\s*Display:\s*mDisplayId=|\s*$)/.exec(window)?.[1] ?? window;
  const frames = /DisplayFrames[^\n]*?\bw=(\d+)\s+h=(\d+)\s+r=([0-3])\b/.exec(defaultSection);
  if (frames && validDimension(Number(frames[1])) && validDimension(Number(frames[2]))) {
    return { width: Number(frames[1]), height: Number(frames[2]), rotation: Number(frames[3]), source: "display-frames" };
  }
  const dimensions = /Override size:\s*(\d+)x(\d+)/.exec(size) ?? /Physical size:\s*(\d+)x(\d+)/.exec(size);
  const rotation = /\bmRotation=(?:ROTATION_)?(0|90|180|270|1|2|3)\b/.exec(window);
  if (!dimensions || !rotation) return undefined;
  const raw = Number(rotation[1]);
  const turn = raw > 3 ? raw / 90 : raw;
  let width = Number(dimensions[1]), height = Number(dimensions[2]);
  if (!validDimension(width) || !validDimension(height)) return undefined;
  if (turn % 2) [width, height] = [height, width];
  return { width, height, rotation: turn, source: "wm-size" };
}

export function parseAndroidApp(window: string): { id: string; title?: string } | undefined {
  const focused = /mCurrentFocus=Window\{[^\n]*?\bu\d+\s+([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)/.exec(window)
    ?? /mFocusedApp=[^\n]*?\bu\d+\s+([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)/.exec(window);
  return focused ? { id: focused[1]!, title: focused[1]!.split("/")[0] } : undefined;
}

export function parseAndroidLock(policy: string, power: string): { locked?: boolean; interactive?: boolean; evidence: string[] } {
  const evidence: string[] = [];
  const observed: boolean[] = [];
  for (const match of policy.matchAll(/\b(mShowingLockscreen|mKeyguardShowing|mKeyguardShowingAndNotOccluded|keyguardShowing)=(true|false)\b/g)) {
    observed.push(match[2] === "true");
    evidence.push(match[1] + "=" + match[2]);
  }
  // "showing" is meaningful only inside the KeyguardServiceDelegate dump.
  const lines = policy.split(/\r?\n/);
  const at = lines.findIndex(line => line.trim() === "KeyguardServiceDelegate");
  if (at >= 0) {
    const indentation = /^\s*/.exec(lines[at]!)![0].length;
    for (const line of lines.slice(at + 1, at + 35)) {
      if (line.trim() && /^\s*/.exec(line)![0].length <= indentation) break;
      const showing = /^\s*(showing|showingAndNotOccluded|inputRestricted)=(true|false)\s*$/.exec(line);
      if (showing) {
        if (showing[1] !== "inputRestricted" || showing[2] === "true") observed.push(showing[2] === "true");
        evidence.push("KeyguardServiceDelegate." + showing[1] + "=" + showing[2]);
      }
    }
  }
  const wakefulness = /\bmWakefulness=(Awake|Asleep|Dozing|Dreaming)\b/.exec(power)?.[1];
  const explicitInteractive = /\bmInteractive=(true|false)\b/.exec(power)?.[1];
  const interactive = explicitInteractive ? explicitInteractive === "true"
    : wakefulness ? wakefulness === "Awake" : undefined;
  if (wakefulness) evidence.push("mWakefulness=" + wakefulness);
  if (explicitInteractive) evidence.push("mInteractive=" + explicitInteractive);
  return { locked: observed.includes(true) ? true : observed.length ? false : undefined,
    interactive, evidence };
}

/** Return only bounded package-manager codes/static classes, never native output or paths. */
export function parseAndroidInstallFailure(stdout: string, stderr: string): Record<string, string> {
  const output = stdout + "\n" + stderr;
  const code = /\b(INSTALL_(?:FAILED|PARSE_FAILED)_[A-Z0-9_]{1,80})\b/.exec(output)?.[1];
  if (code) return { packageManagerCode: code };
  if (/\bSecurityException\b/.test(output)) return { packageManagerCategory: "package_manager_security_exception" };
  if (/\bUnknown option\b/i.test(output)) return { packageManagerCategory: "unsupported_install_option" };
  if (/Can't find service:\s*package\b|\bpackage (?:manager|service) (?:is )?unavailable\b/i.test(output)) {
    return { packageManagerCategory: "package_service_unavailable" };
  }
  return {};
}

function parseProbe(text: string): Probe {
  const part = sections(text);
  const integer = (value: string | undefined) => {
    const match = value?.match(/(?:^|\n)(\d+)\s*$/);
    return match ? Number(match[1]) : -1;
  };
  const selected = part.ime_selected?.trim();
  const hash = /\b([a-f0-9]{64})\b/.exec(part.bridge_sha ?? "")?.[1];
  const lock = parseAndroidLock((part.policy ?? "") + "\n" + (part.window ?? ""), part.power ?? "");
  return {
    uid: integer(part.uid), sdk: integer(part.sdk), user: integer(part.user),
    timeout: part.timeout === "yes", input: part.input === "yes", capture: part.capture === "yes",
    inputHelp: part.input_help ?? "",
    geometry: parseAndroidGeometry(part.display ?? "", part.window ?? "", part.size ?? ""),
    app: parseAndroidApp(part.window ?? ""),
    selectedIme: selected && /^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(selected) ? selected : undefined,
    enabledImes: (part.ime_enabled ?? "").split(/\r?\n/).map(line => line.trim())
      .filter(line => /^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(line)),
    bridgeSha256: hash, locked: lock.locked, interactive: lock.interactive, lockEvidence: lock.evidence
  };
}

function probeScript(): string {
  const marker = (name: string) => "printf '\\n__RELAY_ANDROID_" + name + "__\\n'";
  return [
    "export PATH=/system/bin:/system/xbin:/vendor/bin",
    marker("uid"), "/system/bin/id -u",
    marker("sdk"), "/system/bin/getprop ro.build.version.sdk",
    "relay_android_user=$(/system/bin/am get-current-user)",
    marker("user"), 'printf "%s\\n" "$relay_android_user"',
    marker("timeout"), "if " + TOYBOX + " timeout -s TERM -k 1 2 /system/bin/true; then printf 'yes\\n'; else printf 'no\\n'; fi",
    marker("input"), "if [ -x /system/bin/input ]; then printf 'yes\\n'; else printf 'no\\n'; fi",
    marker("capture"), "if [ -x /system/bin/screencap ]; then printf 'yes\\n'; else printf 'no\\n'; fi",
    marker("input_help"), "/system/bin/input 2>&1",
    marker("display"), "/system/bin/dumpsys display",
    marker("window"), "/system/bin/dumpsys window displays", "/system/bin/dumpsys window windows",
    marker("size"), "/system/bin/wm size",
    marker("policy"), "/system/bin/dumpsys window policy",
    marker("power"), "/system/bin/dumpsys power",
    marker("ime_selected"), '/system/bin/settings --user "$relay_android_user" get secure default_input_method',
    marker("ime_enabled"), '/system/bin/ime list -s --user "$relay_android_user"',
    marker("bridge_sha"),
    'relay_android_apk=$(/system/bin/pm path --user "$relay_android_user" ' + ANDROID_INPUT_PACKAGE + " | /system/bin/sed -n 's/^package://p' | /system/bin/head -n 1)",
    'if [ -n "$relay_android_apk" ]; then ' + TOYBOX + ' sha256sum "$relay_android_apk"; fi',
    ""
  ].join("\n");
}

const KEYS: Record<string, string> = {
  ENTER: "ENTER", RETURN: "ENTER", TAB: "TAB", SPACE: "SPACE", BACKSPACE: "DEL", DELETE: "FORWARD_DEL",
  ESC: "ESCAPE", ESCAPE: "ESCAPE", BACK: "BACK", HOME: "HOME", END: "MOVE_END",
  PAGEUP: "PAGE_UP", PAGEDOWN: "PAGE_DOWN", ARROWUP: "DPAD_UP", ARROWDOWN: "DPAD_DOWN",
  ARROWLEFT: "DPAD_LEFT", ARROWRIGHT: "DPAD_RIGHT", UP: "DPAD_UP", DOWN: "DPAD_DOWN",
  LEFT: "DPAD_LEFT", RIGHT: "DPAD_RIGHT", CTRL: "CTRL_LEFT", CONTROL: "CTRL_LEFT",
  SHIFT: "SHIFT_LEFT", ALT: "ALT_LEFT", META: "META_LEFT", SUPER: "META_LEFT",
  APPSWITCH: "APP_SWITCH", RECENTS: "APP_SWITCH", VOLUMEUP: "VOLUME_UP", VOLUMEDOWN: "VOLUME_DOWN",
  VOLUMEMUTE: "VOLUME_MUTE", POWER: "POWER", MENU: "MENU", INSERT: "INSERT"
};
export function androidKeyCode(value: string): string {
  const key = value.replace(/[\s_-]/g, "").toUpperCase();
  if (KEYS[key]) return "KEYCODE_" + KEYS[key];
  if (/^[A-Z0-9]$/.test(key)) return "KEYCODE_" + key;
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return "KEYCODE_" + key;
  throw new ComputerError("unsupported_key", "Android does not support this key name.", { key: value });
}

export function createAndroidBackend(runtime: AndroidBackendRuntime = {}): ComputerBackend {
  const run = runtime.run ?? runNative;
  const find = runtime.find ?? findExecutable;
  const env = runtime.env ?? process.env;
  const bridge = runtime.bridge ?? ANDROID_BRIDGE;
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let textTail: Promise<unknown> = Promise.resolve();

  const su = () => {
    const path = find(["su", "/system/bin/su", "/system/xbin/su", "/sbin/su"], env);
    if (!path) throw new ComputerError("su_unavailable", "Android computer use requires an existing su executable.");
    return path;
  };

  /** Root has its own watchdog. A dead Termux su client does not prove root work ended. */
  const rootCommand = async (
    command: string, context: NativeContext,
    options: { input?: string | Buffer; mutates?: boolean; packageInstall?: boolean; outputLimit?: number; cleanupSeconds?: number; watchdog?: boolean } = {}
  ): Promise<NativeResult> => {
    if (context.signal?.aborted) throw new ComputerError("cancelled", "Android action was cancelled before execution.", { mayHaveApplied: false });
    const cleanupSeconds = options.cleanupSeconds ?? 2;
    const seconds = Math.max(2, Math.min(12, Math.floor((context.timeoutMs - (cleanupSeconds + 1) * 1000) / 1000)));
    const watchdog = options.watchdog !== false;
    const rootDeadline = now() + (seconds + cleanupSeconds + 1) * 1000;
    const guarded = watchdog
      ? TOYBOX + " timeout -s TERM -k " + cleanupSeconds + " " + seconds + " " + command
      : command;
    try {
      const result = await run({
        command: su(), args: ["-c", guarded], input: options.input, env,
        maxOutputBytes: options.outputLimit ?? 2 * 1024 * 1024
      }, { ...context, timeoutMs: Math.min(120000, Math.max(context.timeoutMs, (seconds + cleanupSeconds + 1) * 1000)) });
      if (result.exitCode !== 0) {
        throw new ComputerError(result.exitCode === 124 || result.exitCode === 137 ? "android_root_timeout" : "android_command_failed",
          "The Android root command did not complete successfully.",
          { exitCode: result.exitCode, mayHaveApplied: Boolean(options.mutates),
            ...(options.packageInstall ? parseAndroidInstallFailure(result.stdout.toString("utf8"), result.stderr.toString("utf8")) : {}) });
      }
      return result;
    } catch (error) {
      if (options.mutates) {
        const remaining = error instanceof ComputerError && error.details?.mayHaveApplied === false ? 0 : rootDeadline - now();
        if (remaining > 0) await sleep(remaining);
        if (error instanceof ComputerError) {
          throw new ComputerError(error.code, error.message, { ...error.details, mayHaveApplied: error.details?.mayHaveApplied !== false });
        }
        throw new ComputerError("android_root_interrupted", "Android action completion could not be confirmed.", { mayHaveApplied: true });
      }
      throw error;
    }
  };

  const probe = async (context: NativeContext): Promise<Probe> => {
    // Capability detection is read-only and also bounded inside the root process.
    const result = await rootCommand(SHELL + " -s", context, { input: probeScript() });
    const value = parseProbe(result.stdout.toString("utf8"));
    if (value.uid !== 0) throw new ComputerError("su_denied", "Existing su permission did not provide root access; no permission dialog was accepted.");
    if (value.user < 0 || value.sdk < 23) throw new ComputerError("android_unsupported", "Could not identify an Android 6+ foreground user.");
    return value;
  };
  const requireActions = (value: Probe) => {
    if (value.locked === true) throw new ComputerError("android_locked", "Android keyguard is active; unlock the device locally before computer actions.", { locked: true, mayHaveApplied: false });
    if (value.interactive === false) throw new ComputerError("android_not_interactive", "Android is asleep or not interactive; wake it locally before computer actions.", { mayHaveApplied: false });
    if (!value.timeout) throw new ComputerError("android_watchdog_unavailable", "The Android root timeout watchdog is unavailable; input was not started.");
    if (!value.input) throw new ComputerError("android_input_unavailable", "Android's native input command is unavailable.");
  };
  const bridgeBundled = () => /^[a-f0-9]{64}$/.test(bridge.sha256) && bridge.base64.length > 0;
  const bridgeInstalled = (value: Probe) => bridgeBundled() && value.bridgeSha256 === bridge.sha256;

  const capture = async (value: Probe, context: NativeContext) => {
    if (!value.timeout || !value.capture) throw new ComputerError("android_capture_unavailable", "Native Android screen capture and its root watchdog are required.");
    const result = await rootCommand("/system/bin/screencap -p", context, { outputLimit: 24 * 1024 * 1024 });
    const dimensions = pngDimensions(result.stdout);
    const display: ComputerDisplay = {
      id: "0", x: 0, y: 0, ...dimensions, primary: true, name: "Android primary display",
      scaleX: value.geometry ? dimensions.width / value.geometry.width : 1,
      scaleY: value.geometry ? dimensions.height / value.geometry.height : 1,
      rotation: value.geometry?.rotation
    };
    return { data: result.stdout, mimeType: "image/png" as const, display, capturedAt: now(), app: value.app };
  };

  const assertDisplay = (display: ComputerDisplay, value: Probe) => {
    if (display.id !== "0") throw new ComputerError("display_unavailable", "Android input currently supports only the primary display.");
    if (!value.geometry) throw new ComputerError("display_geometry_unknown", "Android native input geometry could not be verified.");
    const width = display.width / (display.scaleX ?? 1), height = display.height / (display.scaleY ?? 1);
    if (Math.abs(width - value.geometry.width) > 1 || Math.abs(height - value.geometry.height) > 1
      || (display.rotation !== undefined && value.geometry.rotation !== undefined && display.rotation !== value.geometry.rotation)) {
      throw new ComputerError("display_changed", "Android display size or rotation changed; take a new screenshot before acting.");
    }
  };
  const point = (display: ComputerDisplay, x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= display.width || y >= display.height) {
      throw new ComputerError("invalid_coordinates", "Coordinates must be inside the supplied screenshot.");
    }
    return nativePoint(display, x, y);
  };

  const restoreScript = (value: Probe, request: string): string => {
    const original = value.selectedIme!;
    const initiallyEnabled = value.enabledImes.includes(ANDROID_INPUT_METHOD)
      || value.enabledImes.includes(ANDROID_INPUT_PACKAGE + "/" + ANDROID_INPUT_PACKAGE + ".RelayInputService");
    const bounded = (args: string[]) => TOYBOX + " timeout -s TERM -k 1 2 " + args.map(quote).join(" ");
    return [
      "relay_restore_input() {",
      "  trap - EXIT HUP INT TERM",
      "  relay_restore_ok=1",
      "  relay_current=$(" + bounded(["/system/bin/settings", "--user", String(value.user), "get", "secure", "default_input_method"]) + ") || relay_restore_ok=0",
      "  if [ \"$relay_current\" = " + quote(ANDROID_INPUT_METHOD) + " ] || [ \"$relay_current\" = " + quote(ANDROID_INPUT_PACKAGE + "/" + ANDROID_INPUT_PACKAGE + ".RelayInputService") + " ]; then",
      "    " + bounded(["/system/bin/ime", "set", "--user", String(value.user), original]) + " >/dev/null 2>&1 || relay_restore_ok=0",
      "  elif [ \"$relay_current\" != " + quote(original) + " ]; then",
      // Respect a newer manual IME choice; never overwrite unrelated settings.
      "    relay_restore_ok=2",
      "  fi",
      ...(initiallyEnabled ? [] : [
        "  " + bounded(["/system/bin/ime", "disable", "--user", String(value.user), ANDROID_INPUT_METHOD]) + " >/dev/null 2>&1 || relay_restore_ok=0"
      ]),
      "  printf '\\n__RELAY_IME_RESTORED__" + request + ":%s\\n' \"$relay_restore_ok\"",
      "}",
      "trap relay_restore_input EXIT",
      "trap 'exit 143' HUP INT TERM"
    ].join("\n");
  };

  const typeText = async (text: string, value: Probe, context: NativeContext): Promise<Record<string, unknown>> => {
    requireActions(value);
    if (!bridgeInstalled(value)) throw new ComputerError("android_setup_required", "Run computer_setup to install the bundled, verified Unicode input bridge.");
    if (/[\uD800-\uDFFF]/u.test(text)) throw new ComputerError("invalid_text", "Text contains an unpaired Unicode surrogate.");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_TEXT_BYTES) throw new ComputerError("text_too_large", "Android text input is limited to 65536 UTF-8 bytes per action.");
    if (bytes.length === 0) return { applied: false, utf8Bytes: 0, reason: "empty text" };
    if (!value.selectedIme) throw new ComputerError("android_original_ime_unknown", "The current input method could not be saved; no input method was changed.");
    const expectedPackage = value.app?.id.split("/")[0];
    if (!expectedPackage || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(expectedPackage)) {
      throw new ComputerError("android_focus_unknown", "The focused Android app could not be identified; focus an editable field before typing.");
    }
    const request = randomBytes(16).toString("hex");
    const payload = bytes.toString("base64");
    const restore = restoreScript(value, request);
    const script = [
      "export PATH=/system/bin:/system/xbin:/vendor/bin", "set -u", restore,
      "/system/bin/ime enable --user " + value.user + " " + quote(ANDROID_INPUT_METHOD) + " >/dev/null || exit 71",
      "/system/bin/ime set --user " + value.user + " " + quote(ANDROID_INPUT_METHOD) + " >/dev/null || exit 72",
      ["/system/bin/am", "broadcast", "--user", String(value.user), "--receiver-foreground", "-n", RECEIVER,
        "-a", ANDROID_INPUT_PACKAGE + ".COMMIT", "--es", "request_id", request, "--es", "expected_package", expectedPackage,
        "--es", "payload_b64", payload].map(quote).join(" "),
      ""
    ].join("\n");
    let output = "";
    let failure: unknown;
    try {
      const result = await rootCommand(SHELL + " -s", context, {
        input: script, mutates: true, cleanupSeconds: 6, outputLimit: 64 * 1024
      });
      output = result.stdout.toString("utf8");
      const ack = new RegExp('Broadcast completed: result=-1, data="relay-input:' + request + ':ok"');
      if (!ack.test(output)) {
        throw new ComputerError("android_text_unconfirmed", "The input bridge did not acknowledge this exact commit; text will not be replayed.", { mayHaveApplied: true, requestId: request });
      }
    } catch (error) { failure = error; }
    finally {
      if (!output.includes("__RELAY_IME_RESTORED__" + request + ":1") && !output.includes("__RELAY_IME_RESTORED__" + request + ":2")) {
        // This cleanup is independent of the cancelled caller and runs only after
        // the previous root command's bounded execution window has elapsed.
        try {
          const result = await rootCommand(SHELL + " -s", { timeoutMs: 12_000 }, {
            input: "export PATH=/system/bin:/system/xbin:/vendor/bin\n" + restore + "\nexit 0\n",
            mutates: true, cleanupSeconds: 6, outputLimit: 16 * 1024
          });
          output += result.stdout.toString("utf8");
        } catch {
          failure = new ComputerError("android_ime_restore_unconfirmed", "The original Android input-method state could not be confirmed restored.",
            { mayHaveApplied: true, originalInputMethod: value.selectedIme, requestId: request });
        }
      }
    }
    if (!output.includes("__RELAY_IME_RESTORED__" + request + ":1") && !output.includes("__RELAY_IME_RESTORED__" + request + ":2")) {
      throw new ComputerError("android_ime_restore_unconfirmed", "The original input-method state could not be confirmed restored.",
        { mayHaveApplied: true, originalInputMethod: value.selectedIme, requestId: request });
    }
    if (failure) throw failure;
    return { applied: true, utf8Bytes: bytes.length, requestId: request, acknowledged: true,
      inputMethodRestored: output.includes("__RELAY_IME_RESTORED__" + request + ":1"),
      inputMethodChangedExternally: output.includes("__RELAY_IME_RESTORED__" + request + ":2") };
  };

  const backend: ComputerBackend = {
    id: "android-su",
    async inspect(context): Promise<ComputerState> {
      const state: ComputerState = {
        platform: "android", backend: "android-su", available: false, displayKind: "unknown",
        inputKind: "touch", displays: [], actions: [], unicodeText: false,
        permissions: { su: "unknown", screenCapture: "unknown", inputInjection: "unknown" }
      };
      try {
        const value = await probe(context);
        state.permissions.su = "granted";
        const shot = await capture(value, context);
        state.permissions.screenCapture = "granted";
        state.displays = [shot.display];
        state.displayKind = "physical";
        state.app = value.app;
        state.available = value.input && value.timeout && value.locked !== true && value.interactive !== false;
        state.permissions.unlockedSession = value.locked === true || value.interactive === false ? "denied" : value.locked === false ? "granted" : "unknown";
        state.actions = state.available
          ? (value.geometry ? ["click", "drag", "scroll", "key", "text"] : ["key", "text"]) : [];
        state.unicodeText = bridgeInstalled(value);
        state.details = {
          androidSdk: value.sdk, androidUser: value.user, rootWatchdog: value.timeout,
          locked: value.locked ?? "unknown", interactive: value.interactive ?? "unknown", lockEvidence: value.lockEvidence,
          geometrySource: value.geometry?.source ?? "unknown", nativeWidth: value.geometry?.width,
          nativeHeight: value.geometry?.height, unicodeBridgeInstalled: bridgeInstalled(value),
          unicodeBridgeBundled: bridgeBundled(), setupRequiredForText: !bridgeInstalled(value),
          inputPermissionRequiresActualAction: true, primaryDisplayOnly: true,
          keyCombinations: value.inputHelp.includes("keycombination")
        };
        if (value.locked === true) state.reason = "Android keyguard is active; no computer action will unlock or bypass it.";
        else if (value.interactive === false) state.reason = "Android is asleep or not interactive; no automatic wake gesture is sent.";
        else if (!state.available) state.reason = "Native Android input or its root watchdog is unavailable.";
        else if (!state.unicodeText) state.reason = "Touch and keys are available; computer_setup installs the bundled Unicode bridge.";
        else if (value.locked === undefined) state.reason = "This Android ROM did not report a recognized keyguard state; lock status is unknown.";
        return state;
      } catch (error) {
        if (error instanceof ComputerError && error.code === "su_denied") state.permissions.su = "denied";
        state.reason = error instanceof Error ? error.message : "Android capability detection failed.";
        return state;
      }
    },
    async screenshot(displayId, context) {
      if (displayId !== undefined && displayId !== "0") throw new ComputerError("display_unavailable", "Android screenshots currently support only the primary display.");
      return capture(await probe(context), context);
    },
    async setup(context) {
      let phase: "preflight" | "install" | "verification" = "preflight";
      try {
        const value = await probe(context);
        requireActions(value);
        if (bridgeInstalled(value)) return { installed: true, changed: false, package: ANDROID_INPUT_PACKAGE, version: bridge.version, sha256: bridge.sha256 };
        if (!bridgeBundled()) throw new ComputerError("android_bridge_not_bundled", "This build does not contain a signed Android input bridge.");
        const apk = Buffer.from(bridge.base64, "base64");
        if (apk.length < 1000 || apk.length > 2 * 1024 * 1024 || createHash("sha256").update(apk).digest("hex") !== bridge.sha256) {
          throw new ComputerError("android_bridge_integrity_failed", "The bundled Android input bridge failed integrity verification.");
        }
        const command = ["/system/bin/pm", "install", "-r", "--user", String(value.user), "-S", String(apk.length), "-"].map(quote).join(" ");
        phase = "install";
        const result = await rootCommand(command, context, { input: apk, mutates: true, packageInstall: true, outputLimit: 64 * 1024, cleanupSeconds: 3 });
        if (!/^Success\s*$/m.test(result.stdout.toString("utf8"))) {
          throw new ComputerError("android_bridge_install_unconfirmed", "Android did not confirm installation of the input bridge.", {
            mayHaveApplied: true, ...parseAndroidInstallFailure(result.stdout.toString("utf8"), result.stderr.toString("utf8"))
          });
        }
        phase = "verification";
        const verified = await probe(context);
        if (!bridgeInstalled(verified)) throw new ComputerError("android_bridge_install_unconfirmed", "The installed bridge APK did not match the bundled SHA256.", { mayHaveApplied: true });
        return { installed: true, changed: true, package: ANDROID_INPUT_PACKAGE, version: bridge.version, sha256: bridge.sha256, inputMethodChanged: verified.selectedIme !== value.selectedIme };
      } catch (error) {
        const known = error instanceof ComputerError ? error : undefined;
        // Read-only verification cannot erase a preceding installation.
        // During install, retain an explicit pre-spawn/cancellation guarantee of no mutation.
        const mayHaveApplied = phase === "verification"
          || (phase === "install" && known?.details?.mayHaveApplied !== false);
        throw new ComputerError(known?.code ?? "android_setup_failed",
          known?.message ?? "Android input bridge setup did not complete successfully.",
          { ...known?.details, phase, mayHaveApplied });
      }
    },
    async act(action: ComputerAction, display: ComputerDisplay, context: NativeContext): Promise<Record<string, unknown>> {
      if (action.type === "move") throw new ComputerError("unsupported_action", "Android touch input has no hover pointer.");
      if (action.type === "text") {
        const operation = textTail.catch(() => {}).then(async () => {
          if (context.signal?.aborted) throw new ComputerError("cancelled", "Text input was cancelled before the input-method session.", { mayHaveApplied: false });
          return typeText(action.text, await probe(context), context);
        });
        textTail = operation.catch(() => {});
        return operation;
      }
      const value = await probe(context);
      requireActions(value);
      let args: string[];
      let finalTouch: { x: number; y: number } | undefined;
      if (action.type === "key") {
        if (action.keys.length < 1 || action.keys.length > 8) throw new ComputerError("invalid_keys", "Supply one to eight Android keys.");
        const keys = action.keys.map(androidKeyCode);
        if (keys.length > 1 && !value.inputHelp.includes("keycombination")) {
          throw new ComputerError("unsupported_key_combination", "This Android input command cannot inject simultaneous key combinations.");
        }
        args = ["/system/bin/input", keys.length === 1 ? "keyevent" : "keycombination", ...keys];
      } else {
        assertDisplay(display, value);
        if (action.type === "click") {
          if (action.button && action.button !== "left") throw new ComputerError("unsupported_button", "Android touch input supports primary taps; use a stationary drag for a long press.");
          const clicks = action.clicks ?? 1;
          if (!Number.isInteger(clicks) || clicks < 1 || clicks > 3) throw new ComputerError("invalid_clicks", "Android supports one to three taps per action.");
          const position = point(display, action.x, action.y);
          const command = ["/system/bin/input", "tap", String(position.x), String(position.y)].map(quote).join(" ");
          const script = Array.from({ length: clicks }, () => command + " || exit $?").join("\n") + "\n";
          await rootCommand(SHELL + " -s", context, { input: script, mutates: true, outputLimit: 16 * 1024 });
          return { applied: true, gesture: "tap", taps: clicks };
        }
        if (action.type === "drag") {
          const duration = action.durationMs ?? 350;
          if (!Number.isFinite(duration) || duration < 50 || duration > MAX_GESTURE_MS) {
            throw new ComputerError("invalid_duration", "Android touch gestures must last 50–5000 ms.");
          }
          const from = point(display, action.fromX, action.fromY), to = point(display, action.toX, action.toY);
          finalTouch = to;
          args = ["/system/bin/input", "swipe", String(from.x), String(from.y), String(to.x), String(to.y), String(Math.round(duration))];
        } else {
          const amount = action.amount ?? 400;
          if (!Number.isFinite(amount) || amount <= 0) throw new ComputerError("invalid_scroll", "Android scroll amount must be positive.");
          const horizontal = action.direction === "left" || action.direction === "right";
          const axisSize = horizontal ? display.width : display.height;
          const distance = Math.min(amount, axisSize * 0.75);
          let cx = action.x ?? display.width / 2, cy = action.y ?? display.height / 2;
          point(display, cx, cy);
          if (horizontal) cx = Math.min(display.width - 1 - distance / 2, Math.max(distance / 2, cx));
          else cy = Math.min(display.height - 1 - distance / 2, Math.max(distance / 2, cy));
          const sign = action.direction === "down" || action.direction === "right" ? 1 : -1;
          const from = point(display, cx + (horizontal ? sign * distance / 2 : 0), cy + (!horizontal ? sign * distance / 2 : 0));
          const to = point(display, cx - (horizontal ? sign * distance / 2 : 0), cy - (!horizontal ? sign * distance / 2 : 0));
          finalTouch = to;
          args = ["/system/bin/input", "swipe", String(from.x), String(from.y), String(to.x), String(to.y), "350"];
        }
      }
      const command = args.map(quote).join(" ");
      // input itself emits matching DOWN/UP events. A timeout is never treated as success.
      // Only this touch gesture's endpoint is eligible for emergency release.
      let script = "export PATH=/system/bin:/system/xbin:/vendor/bin\n";
      if (finalTouch && value.inputHelp.includes("motionevent")) {
        script += "relay_touch_started=0\ntrap 'if [ \"$relay_touch_started\" = 1 ]; then " + TOYBOX
          + " timeout -k 1 2 /system/bin/input motionevent UP " + finalTouch.x + " " + finalTouch.y + " >/dev/null 2>&1; fi' EXIT\n";
        script += "trap 'exit 143' HUP INT TERM\nrelay_touch_started=1\n";
      }
      script += command + "\nrelay_input_exit=$?\n";
      if (finalTouch) script += "if [ \"$relay_input_exit\" = 0 ]; then relay_touch_started=0; fi\n";
      script += "exit \"$relay_input_exit\"\n";
      await rootCommand(SHELL + " -s", context, { input: script, mutates: true, outputLimit: 16 * 1024, cleanupSeconds: 3 });
      return { applied: true, gesture: action.type === "key" ? "key" : "swipe" };
    }
  };
  return backend;
}
