/**
 * REAL Android acceptance, only against our own signed ProbeActivity.
 * Bundle in the development container; run on the authorized Android device.
 * Never use this harness against user chats, payments, or another app's fields.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ANDROID_BRIDGE } from "../src/computer/android-bridge.generated.js";
import { ANDROID_INPUT_PACKAGE, createAndroidBackend, parseAndroidApp } from "../src/computer/android.js";
import { findExecutable, runNative } from "../src/computer/native.js";
import { ComputerError, type ComputerAction, type ComputerDisplay, type NativeContext } from "../src/computer/types.js";

type Rectangle = { x: number; y: number; width: number; height: number };
type Probe = {
  utf8Bytes: number; textSha256: string; clicks: number; touches: number; moves: number; scrollY: number;
  editorFocused: boolean; editor: Rectangle; counterButton: Rectangle; touchPad: Rectangle; scroll: Rectangle;
};
type Phase = "initializing" | "inspect" | "setup" | "input-method-before" | "launch-probe" | "probe-settle"
  | "foreground-before-action" | "native-action" | "foreground-after-action"
  | "foreground-before-capture" | "capture" | "capture-metadata" | "foreground-after-capture" | "write-capture"
  | "probe-state" | "assertions" | "input-method-after-text" | "input-method-final"
  | "cleanup-foreground" | "cleanup-back" | "cleanup-after-back" | "lock-release";
type RootOperation = "ime-selected" | "ime-enabled" | "window-displays" | "window-windows" | "probe-start" | "probe-status" | "probe-back";
type StartResult = "status_ok" | "existing_activity" | "permission_denied" | "security_exception"
  | "activity_not_found" | "reported_error" | "unrecognized_result";
class OwnedFailure extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) {
    super("Owned Android acceptance stopped.");
    this.name = "OwnedFailure";
  }
}
const backend = createAndroidBackend();
const context: NativeContext = { timeoutMs: 30000 };
const su = findExecutable(["su", "/system/bin/su", "/system/xbin/su", "/sbin/su"]);
const component = ANDROID_INPUT_PACKAGE + "/.ProbeActivity";
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const outputOption = process.argv.indexOf("--out");
if (outputOption < 0 || !process.argv[outputOption + 1]) throw new Error("Pass --out <new evidence directory>; add --setup to explicitly install the bundled bridge.");
if (process.platform !== "android") throw new Error("This is real Android acceptance; a Linux mock/emulator result must not be recorded as this device.");
if (!su) throw new Error("No existing su executable.");
const output = resolve(process.argv[outputOption + 1]!);
mkdirSync(output, { recursive: false, mode: 0o700 });
const receipt: Record<string, unknown> = {
  schemaVersion: 2, startedAt: new Date().toISOString(), status: "running",
  platform: process.platform, node: process.version, package: ANDROID_INPUT_PACKAGE,
  bridgeVersion: ANDROID_BRIDGE.version, bridgeSha256: ANDROID_BRIDGE.sha256,
  onlyOwnedProbeUi: true, evidence: [], assertions: [], phases: []
};
const checks = receipt.assertions as string[];
const evidence = receipt.evidence as unknown[];
let phase: Phase = "initializing";
let rootOperation: RootOperation | undefined;
function enter(next: Phase): void {
  phase = next;
  rootOperation = undefined;
  receipt.phase = next;
  (receipt.phases as unknown[]).push({ phase: next, at: new Date().toISOString() });
}
function safeOwnedError(error: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = { phase, ...(rootOperation ? { rootOperation } : {}) };
  if (error instanceof ComputerError || error instanceof OwnedFailure) {
    result.name = error instanceof ComputerError ? "ComputerError" : "OwnedFailure";
    result.code = /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.code) ? error.code : "owned_harness_error";
    const detail = error.details ?? {};
    if (typeof detail.exitCode === "number" && Number.isInteger(detail.exitCode)
      && detail.exitCode >= -1 && detail.exitCode <= 255) result.exitCode = detail.exitCode;
    for (const key of ["mayHaveApplied", "locked"]) if (typeof detail[key] === "boolean") result[key] = detail[key];
    if (typeof detail.phase === "string" && ["preflight", "install", "verification"].includes(detail.phase)) result.backendPhase = detail.phase;
    if (typeof detail.guard === "string" && ["arguments", "platform", "identity", "home", "config_file", "config_sha256",
      "settings_file", "enabled", "paused", "revision", "settings_write"].includes(detail.guard)) result.guard = detail.guard;
    if (error instanceof OwnedFailure && typeof detail.assertion === "string") result.assertion = detail.assertion;
    if (error instanceof OwnedFailure && typeof detail.startResult === "string"
      && ["status_ok", "existing_activity", "permission_denied", "security_exception", "activity_not_found", "reported_error", "unrecognized_result"].includes(detail.startResult)) result.startResult = detail.startResult;
    return result;
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  result.name = error instanceof Error ? "Error" : "UnknownError";
  result.code = typeof code === "string" && ["EACCES", "EEXIST", "ENOENT", "ENOSPC", "EIO", "EPERM", "EMFILE", "ENFILE"].includes(code)
    ? code : "owned_harness_error";
  // No native stdout/stderr, filesystem paths, or input text is copied into errors.
  return result;
}
function classifyStartResult(stdout: string): StartResult {
  if (/\bSecurityException\b/.test(stdout)) return "security_exception";
  if (/Permission Denial|Permission denied/i.test(stdout)) return "permission_denied";
  if (/Error type 3|does not exist|unable to resolve Intent/i.test(stdout)) return "activity_not_found";
  if (/^Error:|Exception occurred while executing/im.test(stdout)) return "reported_error";
  if (/^Status:\s*ok\s*$/m.test(stdout)) return "status_ok";
  if (/Warning: Activity not started, (?:intent has been delivered|its current task has been brought)/i.test(stdout)) return "existing_activity";
  return "unrecognized_result";
}
async function root(args: string[], operation: RootOperation) {
  context.signal?.throwIfAborted();
  rootOperation = operation;
  const command = "/system/bin/toybox timeout -s TERM -k 2 10 " + args.map(quote).join(" ");
  const result = await runNative({ command: su!, args: ["-c", command], maxOutputBytes: 2 * 1024 * 1024 }, { timeoutMs: 14000, signal: context.signal });
  if (result.exitCode !== 0) throw new OwnedFailure("root_command_failed", { exitCode: result.exitCode });
  return result.stdout.toString("utf8");
}
async function inputMethods() {
  const selected = (await root(["/system/bin/settings", "--user", "current", "get", "secure", "default_input_method"], "ime-selected")).trim();
  const enabled = (await root(["/system/bin/ime", "list", "-s", "--user", "current"], "ime-enabled")).trim().split(/\r?\n/).sort();
  return { selected, enabled };
}
async function focusedApp() {
  // Match production's probe. Some Android versions emit focus only in "displays".
  const displays = await root(["/system/bin/dumpsys", "window", "displays"], "window-displays");
  const windows = await root(["/system/bin/dumpsys", "window", "windows"], "window-windows");
  return parseAndroidApp(displays + "\n" + windows);
}
async function probe(): Promise<Probe> {
  enter("probe-state");
  const stdout = await root(["/system/bin/am", "broadcast", "--user", "current", "--receiver-foreground",
    "-n", ANDROID_INPUT_PACKAGE + "/.ProbeReceiver", "-a", ANDROID_INPUT_PACKAGE + ".PROBE_STATUS"], "probe-status");
  const payload = /Broadcast completed: result=-1, data="relay-probe:([A-Za-z0-9+/=]+)"/.exec(stdout)?.[1];
  if (!payload) throw new OwnedFailure("probe_not_acknowledged");
  try { return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Probe; }
  catch { throw new OwnedFailure("probe_receipt_invalid"); }
}
function center(rect: Rectangle, display: ComputerDisplay) {
  return { x: (rect.x + rect.width / 2 - display.x) * (display.scaleX ?? 1),
    y: (rect.y + rect.height / 2 - display.y) * (display.scaleY ?? 1) };
}
function assert(condition: unknown, label: string) {
  if (!condition) throw new OwnedFailure("assertion_failed", { assertion: label });
  checks.push(label);
}
function isOwnedActivity(id: string | undefined): boolean {
  return id === component || id === ANDROID_INPUT_PACKAGE + "/" + ANDROID_INPUT_PACKAGE + ".ProbeActivity";
}
async function assertOwnedForeground(): Promise<void> {
  const current = await focusedApp();
  if (!isOwnedActivity(current?.id)) throw new OwnedFailure("foreground_not_owned");
}
async function actOwned(action: ComputerAction, display: ComputerDisplay) {
  enter("foreground-before-action");
  await assertOwnedForeground();
  enter("native-action");
  const result = await backend.act(action, display, context);
  // Never continue after a focus switch, including when input may have applied.
  enter("foreground-after-action");
  await assertOwnedForeground();
  return result;
}
async function saveShot(name: string) {
  enter("foreground-before-capture");
  await assertOwnedForeground();
  enter("capture");
  const screenshot = await backend.screenshot("0", context);
  enter("capture-metadata");
  if (!isOwnedActivity(screenshot.app?.id)) throw new OwnedFailure("capture_foreground_not_owned");
  // Capture remains in memory until its metadata and a fresh observation confirm our app.
  enter("foreground-after-capture");
  await assertOwnedForeground();
  enter("write-capture");
  writeFileSync(join(output, name), screenshot.data, { flag: "wx", mode: 0o600 });
  evidence.push({ file: name, sha256: sha(screenshot.data), bytes: screenshot.data.length, display: screenshot.display });
  return screenshot.display;
}

async function main(): Promise<void> {
let methodsBefore: Awaited<ReturnType<typeof inputMethods>> | undefined;
let openedProbe = false;
try {
  enter("inspect");
  const info = await backend.inspect(context);
  receipt.info = info;
  assert(info.available && info.inputKind === "touch", "native root screenshot/input capability is available");
  // Refuse before launching any UI when current default-display coordinates are unknown.
  assert(info.actions.includes("click"), "current default-display geometry supports native clicks");
  if (process.argv.includes("--setup")) { enter("setup"); receipt.setup = await backend.setup!(context); }
  enter("input-method-before");
  methodsBefore = await inputMethods();
  receipt.originalInputMethod = methodsBefore.selected;
  receipt.originalEnabledMethodsSha256 = sha(JSON.stringify(methodsBefore.enabled));
  enter("launch-probe");
  const startOutput = await root(["/system/bin/am", "start", "-W", "--user", "current", "-n", component], "probe-start");
  openedProbe = true;
  const startResult = classifyStartResult(startOutput);
  receipt.probeStart = { commandExitCode: 0, classification: startResult };
  if (["permission_denied", "security_exception", "activity_not_found", "reported_error"].includes(startResult)) {
    throw new OwnedFailure("activity_launch_failed", { startResult });
  }
  // Unknown command output is not proof of focus; the strict checks below still apply.
  enter("probe-settle");
  await new Promise(resolveWait => setTimeout(resolveWait, 500));
  const display = await saveShot("01-owned-probe-before.png");
  const initial = await probe();
  const editCenter = center(initial.editor, display);
  await actOwned({ type: "click", ...editCenter }, display);
  const text = "中文输入验收🙂\nMCP Relay Z";
  const textReceipt = await actOwned({ type: "text", text }, display);
  const typed = await probe();
  enter("assertions");
  assert(typed.utf8Bytes === Buffer.byteLength(text) && typed.textSha256 === sha(text), "Unicode and newline reached the owned editor exactly");
  receipt.text = textReceipt;
  enter("input-method-after-text");
  const methodsAfterText = await inputMethods();
  assert(methodsAfterText.selected === methodsBefore.selected, "the original selected IME was restored");
  assert(JSON.stringify(methodsAfterText.enabled) === JSON.stringify(methodsBefore.enabled), "the original enabled IME set was restored");
  await actOwned({ type: "key", keys: ["Backspace"] }, display);
  assert((await probe()).textSha256 === sha(text.slice(0, -1)), "native Backspace affected only the owned editor");
  await actOwned({ type: "click", ...center(initial.counterButton, display) }, display);
  assert((await probe()).clicks === initial.clicks + 1, "tap reached the owned counter button");
  const pad = initial.touchPad;
  const start = center({ ...pad, x: pad.x + pad.width * 0.1, width: 0 }, display);
  const end = center({ ...pad, x: pad.x + pad.width * 0.9, width: 0 }, display);
  await actOwned({ type: "drag", fromX: start.x, fromY: start.y, toX: end.x, toY: end.y, durationMs: 400 }, display);
  const dragged = await probe();
  assert(dragged.touches > initial.touches && dragged.moves > initial.moves, "touch drag produced events on the owned test pad");
  const scrollCenter = center(initial.scroll, display);
  await actOwned({ type: "scroll", direction: "down", amount: 3, ...scrollCenter }, display);
  assert((await probe()).scrollY > initial.scrollY, "scroll moved the owned scroll view downward");
  await saveShot("02-owned-probe-after.png");
  receipt.finalProbe = await probe();
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = safeOwnedError(error);
  process.exitCode = 1;
} finally {
  try {
    if (methodsBefore) {
      enter("input-method-final");
      const final = await inputMethods();
      receipt.finalInputMethod = final.selected;
      receipt.finalEnabledMethodsSha256 = sha(JSON.stringify(final.enabled));
      if (final.selected !== methodsBefore.selected || JSON.stringify(final.enabled) !== JSON.stringify(methodsBefore.enabled)) {
        receipt.status = "failed"; receipt.inputMethodRestoreVerified = false; process.exitCode = 1;
      } else receipt.inputMethodRestoreVerified = true;
    }
    if (openedProbe) {
      enter("cleanup-foreground");
      const app = await focusedApp();
      if (isOwnedActivity(app?.id)) {
        enter("cleanup-back");
        await root(["/system/bin/input", "keyevent", "KEYCODE_BACK"], "probe-back");
        enter("cleanup-after-back");
        const afterBack = await focusedApp();
        receipt.ownedProbeClosed = Boolean(afterBack?.id && !isOwnedActivity(afterBack.id));
      } else receipt.ownedProbeClosed = false;
    }
  } catch (error) {
    receipt.status = "failed"; receipt.cleanupError = safeOwnedError(error); process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: receipt.status, receipt: join(output, "receipt.json"), assertions: checks.length }) + "\n");
}

}
void main().catch(error => { process.stderr.write(JSON.stringify(safeOwnedError(error)) + "\n"); process.exitCode = 1; });
