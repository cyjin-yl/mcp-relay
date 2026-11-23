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
import type { ComputerAction, ComputerDisplay, NativeContext } from "../src/computer/types.js";

type Rectangle = { x: number; y: number; width: number; height: number };
type Probe = {
  utf8Bytes: number; textSha256: string; clicks: number; touches: number; moves: number; scrollY: number;
  editorFocused: boolean; editor: Rectangle; counterButton: Rectangle; touchPad: Rectangle; scroll: Rectangle;
};
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
  schemaVersion: 1, startedAt: new Date().toISOString(), status: "running",
  platform: process.platform, node: process.version, package: ANDROID_INPUT_PACKAGE,
  bridgeVersion: ANDROID_BRIDGE.version, bridgeSha256: ANDROID_BRIDGE.sha256,
  onlyOwnedProbeUi: true, evidence: [], assertions: []
};
const checks = receipt.assertions as string[];
const evidence = receipt.evidence as unknown[];

async function root(args: string[]) {
  const command = "/system/bin/toybox timeout -s TERM -k 2 10 " + args.map(quote).join(" ");
  const result = await runNative({ command: su!, args: ["-c", command], maxOutputBytes: 2 * 1024 * 1024 }, { timeoutMs: 14000 });
  if (result.exitCode !== 0) throw new Error("Root verification command failed; exit " + result.exitCode);
  return result.stdout.toString("utf8");
}
async function inputMethods() {
  const selected = (await root(["/system/bin/settings", "--user", "current", "get", "secure", "default_input_method"])).trim();
  const enabled = (await root(["/system/bin/ime", "list", "-s", "--user", "current"])).trim().split(/\r?\n/).sort();
  return { selected, enabled };
}
async function probe(): Promise<Probe> {
  const stdout = await root(["/system/bin/am", "broadcast", "--user", "current", "--receiver-foreground",
    "-n", ANDROID_INPUT_PACKAGE + "/.ProbeReceiver", "-a", ANDROID_INPUT_PACKAGE + ".PROBE_STATUS"]);
  const payload = /Broadcast completed: result=-1, data="relay-probe:([A-Za-z0-9+/=]+)"/.exec(stdout)?.[1];
  if (!payload) throw new Error("Our probe activity did not acknowledge a foreground status request.");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Probe;
}
function center(rect: Rectangle, display: ComputerDisplay) {
  return { x: (rect.x + rect.width / 2 - display.x) * (display.scaleX ?? 1),
    y: (rect.y + rect.height / 2 - display.y) * (display.scaleY ?? 1) };
}
function assert(condition: unknown, label: string) {
  if (!condition) throw new Error("Acceptance failed: " + label);
  checks.push(label);
}
function isOwnedActivity(id: string | undefined): boolean {
  return id === component || id === ANDROID_INPUT_PACKAGE + "/" + ANDROID_INPUT_PACKAGE + ".ProbeActivity";
}
async function assertOwnedForeground(): Promise<void> {
  const current = parseAndroidApp(await root(["/system/bin/dumpsys", "window", "windows"]));
  if (!isOwnedActivity(current?.id)) {
    throw new Error("The owned test activity is not the confirmed foreground app; acceptance stopped.");
  }
}
async function actOwned(action: ComputerAction, display: ComputerDisplay) {
  await assertOwnedForeground();
  const result = await backend.act(action, display, context);
  // Never continue after a focus switch, including when input may have applied.
  await assertOwnedForeground();
  return result;
}
async function saveShot(name: string) {
  await assertOwnedForeground();
  const screenshot = await backend.screenshot("0", context);
  if (!isOwnedActivity(screenshot.app?.id)) {
    throw new Error("Capture did not identify the owned test activity; the image was not saved.");
  }
  // Capture remains in memory until both its metadata and a fresh foreground
  // observation confirm our own app. No screenshot bytes are sent over stdout.
  await assertOwnedForeground();
  writeFileSync(join(output, name), screenshot.data, { flag: "wx", mode: 0o600 });
  evidence.push({ file: name, sha256: sha(screenshot.data), bytes: screenshot.data.length, display: screenshot.display });
  return screenshot.display;
}

async function main(): Promise<void> {
let methodsBefore: Awaited<ReturnType<typeof inputMethods>> | undefined;
let openedProbe = false;
try {
  const info = await backend.inspect(context);
  assert(info.available && info.inputKind === "touch", "native root screenshot/input capability is available");
  receipt.info = info;
  if (process.argv.includes("--setup")) receipt.setup = await backend.setup!(context);
  methodsBefore = await inputMethods();
  receipt.originalInputMethod = methodsBefore.selected;
  receipt.originalEnabledMethodsSha256 = sha(JSON.stringify(methodsBefore.enabled));
  await root(["/system/bin/am", "start", "-W", "--user", "current", "-n", component]);
  openedProbe = true;
  await new Promise(resolveWait => setTimeout(resolveWait, 500));
  const display = await saveShot("01-owned-probe-before.png");
  const initial = await probe();
  const editCenter = center(initial.editor, display);
  await actOwned({ type: "click", ...editCenter }, display);
  const text = "中文输入验收🙂\nMCP Relay Z";
  const textReceipt = await actOwned({ type: "text", text }, display);
  const typed = await probe();
  assert(typed.utf8Bytes === Buffer.byteLength(text) && typed.textSha256 === sha(text), "Unicode and newline reached the owned editor exactly");
  receipt.text = textReceipt;
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
  await actOwned({ type: "scroll", direction: "down", amount: 350, ...scrollCenter }, display);
  assert((await probe()).scrollY > initial.scrollY, "scroll moved the owned scroll view downward");
  await saveShot("02-owned-probe-after.png");
  receipt.finalProbe = await probe();
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
  process.exitCode = 1;
} finally {
  try {
    if (methodsBefore) {
      const final = await inputMethods();
      receipt.finalInputMethod = final.selected;
      receipt.finalEnabledMethodsSha256 = sha(JSON.stringify(final.enabled));
      if (final.selected !== methodsBefore.selected || JSON.stringify(final.enabled) !== JSON.stringify(methodsBefore.enabled)) {
        receipt.status = "failed"; receipt.inputMethodRestoreVerified = false; process.exitCode = 1;
      } else receipt.inputMethodRestoreVerified = true;
    }
    if (openedProbe) {
      const app = parseAndroidApp(await root(["/system/bin/dumpsys", "window", "windows"]));
      if (isOwnedActivity(app?.id)) {
        await root(["/system/bin/input", "keyevent", "KEYCODE_BACK"]);
        const afterBack = parseAndroidApp(await root(["/system/bin/dumpsys", "window", "windows"]));
        receipt.ownedProbeClosed = Boolean(afterBack?.id && !isOwnedActivity(afterBack.id));
      } else receipt.ownedProbeClosed = false;
    }
  } catch (error) {
    receipt.status = "failed"; receipt.cleanupError = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: receipt.status, receipt: join(output, "receipt.json"), assertions: checks.length }) + "\n");
}

}
void main().catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; });
