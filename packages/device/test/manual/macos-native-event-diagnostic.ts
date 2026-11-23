/**
 * Read-only, bounded macOS CoreGraphics event bridge diagnostic.
 * Build only in CT102 and run the prebuilt file on the native CI runner.
 * No CGEventPost, screen capture, TCC request, UI input, or environment-value output.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { release } from "node:os";
import { createHash } from "node:crypto";
import { nativeEnvironment } from "../../src/computer/native.js";

const CASE_MS = 4000, CLEANUP_MS = 800, TOTAL_MS = 30000;
const BASE = "ObjC.import('Cocoa');ObjC.import('CoreGraphics');" +
  "function stage(s){console.log('DIAG:'+s);}" +
  "function coords(p){console.log('DIAG_COORDS:'+JSON.stringify({x:Number(p.x),y:Number(p.y)}));}" +
  "stage('FRAMEWORKS_READY');";
const CURRENT = "stage('CREATE_BEGIN');var sourceEvent=$.CGEventCreate(null);stage('CREATE_READY');" +
  "stage('LOCATION_BEGIN');var point=$.CGEventGetLocation(sourceEvent);coords(point);stage('LOCATION_READY');";
const probes = [
  { name: "01-create-location-no-explicit-release", code: CURRENT },
  { name: "02-create-location-explicit-release", code: CURRENT +
    "stage('RELEASE_BEGIN');$.CFRelease(sourceEvent);stage('RELEASE_READY');" },
  { name: "03-mouse-event-current-point-no-post", code: CURRENT +
    "stage('MOUSE_CREATE_BEGIN');var event=$.CGEventCreateMouseEvent(null,5,{x:point.x,y:point.y},0);stage('MOUSE_CREATE_READY');" +
    "stage('RELEASE_BEGIN');$.CFRelease(event);stage('RELEASE_READY');" },
  { name: "04-keyboard-event-no-post", code:
    "stage('KEYBOARD_CREATE_BEGIN');var event=$.CGEventCreateKeyboardEvent(null,0,true);stage('KEYBOARD_CREATE_READY');" +
    "stage('RELEASE_BEGIN');$.CFRelease(event);stage('RELEASE_READY');" },
  { name: "05-unicode-void-pointer-no-post", code:
    "stage('UNICODE_BIND_BEGIN');ObjC.bindFunction('CGEventKeyboardSetUnicodeString',['void',['void *','unsigned long','void *']]);stage('UNICODE_BIND_READY');" +
    "var text='relay 中文🙂';stage('DATA_BEGIN');var data=$(text).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);stage('DATA_READY');" +
    "stage('KEYBOARD_CREATE_BEGIN');var event=$.CGEventCreateKeyboardEvent(null,0,true);stage('KEYBOARD_CREATE_READY');" +
    "stage('UNICODE_SET_BEGIN');$.CGEventKeyboardSetUnicodeString(event,text.length,data.bytes);stage('UNICODE_SET_READY');" +
    "stage('RELEASE_BEGIN');$.CFRelease(event);stage('RELEASE_READY');" }
];
type Result = {
  name: string; events: Array<{ name: string; ms: number; code?: string | number | null }>;
  stages: string[]; coordinates: Array<{ x: number; y: number }>; stdoutBytes: number; stderrBytes: number;
  timedOut: boolean; exitCode?: number | null; signal?: string | null; elapsedMs?: number;
  cleanupUncertain?: boolean; completed?: boolean; errorClass?: string;
};
async function runProbe(name: string, code: string): Promise<Result> {
  const start = performance.now();
  const result: Result = { name, events: [], stages: [], coordinates: [], stdoutBytes: 0, stderrBytes: 0, timedOut: false };
  const event = (name: string, code?: string | number | null) => result.events.push({
    name, ms: Math.round(performance.now() - start), ...(code === undefined ? {} : { code })
  });
  return new Promise(resolveResult => {
    let child: ChildProcess;
    try {
      child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-"], {
        env: nativeEnvironment(), detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      event("spawn-throw", (error as NodeJS.ErrnoException).code ?? "unknown");
      result.elapsedMs = Math.round(performance.now() - start);
      resolveResult(result);
      return;
    }
    let finished = false, exited = false, captured = "";
    let grace: NodeJS.Timeout | undefined, force: NodeJS.Timeout | undefined, hard: NodeJS.Timeout | undefined;
    const signalOwned = (signal: NodeJS.Signals) => {
      if (!child.pid || exited) return;
      try { process.kill(-child.pid, signal); event("owned-group-signal", signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") event("signal-error", (error as NodeJS.ErrnoException).code ?? "unknown"); }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      if (force) clearTimeout(force);
      if (hard) clearTimeout(hard);
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (!exited && child.pid) child.unref();
      result.stages = [...captured.matchAll(/\bDIAG:[A-Z_]+\b/g)].map(match => match[0]).slice(0, 40);
      for (const match of captured.matchAll(/DIAG_COORDS:(\{"x":-?[0-9.eE+]+,"y":-?[0-9.eE+]+\})/g)) {
        try { const p = JSON.parse(match[1]!); if (Number.isFinite(p.x) && Number.isFinite(p.y)) result.coordinates.push({ x: p.x, y: p.y }); } catch { /* no raw text */ }
      }
      if (/Ref has incompatible type/i.test(captured)) result.errorClass = "BRIDGE_REF_TYPE_MISMATCH";
      else if (/Can't get object|cannot convert/i.test(captured)) result.errorClass = "BRIDGE_CONVERSION_ERROR";
      else if (result.exitCode && !result.signal) result.errorClass = "NATIVE_NONZERO_EXIT";
      result.elapsedMs = Math.round(performance.now() - start);
      result.completed = !result.timedOut && result.exitCode === 0 && result.stages.includes("DIAG:COMPLETE");
      resolveResult(result);
    };
    const deadline = setTimeout(() => {
      result.timedOut = true; event("deadline", CASE_MS); signalOwned("SIGTERM");
      force = setTimeout(() => signalOwned("SIGKILL"), 250);
      hard = setTimeout(() => {
        if (!exited) { result.cleanupUncertain = true; event("owned-child-exit-not-observed"); }
        finish();
      }, CLEANUP_MS);
    }, CASE_MS);
    child.once("spawn", () => event("spawn"));
    child.on("error", error => { event("child-error", (error as NodeJS.ErrnoException).code ?? "unknown"); if (!child.pid) finish(); });
    child.once("exit", (code, signal) => {
      exited = true; result.exitCode = code; result.signal = signal; event("exit", code);
      if (signal) event("exit-signal", signal);
      grace = setTimeout(() => { event("stdio-grace-expired"); finish(); }, 300);
    });
    child.once("close", code => { event("close", code); finish(); });
    const collect = (which: "stdoutBytes" | "stderrBytes", chunk: Buffer) => {
      if (!result[which]) event(which === "stdoutBytes" ? "first-stdout" : "first-stderr");
      result[which] += chunk.length;
      if (captured.length < 32768) captured += chunk.toString("utf8").slice(0, 32768 - captured.length);
    };
    child.stdout!.on("data", chunk => collect("stdoutBytes", chunk));
    child.stderr!.on("data", chunk => collect("stderrBytes", chunk));
    child.stdin!.once("finish", () => event("stdin-finish"));
    child.stdin!.on("error", error => event("stdin-error", (error as NodeJS.ErrnoException).code ?? "unknown"));
    child.stdin!.end(BASE + code + "stage('COMPLETE');'DIAG:SCRIPT_RETURNED';\n");
  });
}
async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Run this prebuilt diagnostic only on the native macOS runner.");
  const directory = resolve(process.argv[2] ?? "macos-native-event-diagnostic");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = performance.now();
  const results: Result[] = [];
  const report: Record<string, unknown> = {
    schemaVersion: 1, purpose: "read-only-CoreGraphics-event-ABI",
    platform: process.platform, architecture: process.arch, node: process.version, darwinRelease: release(),
    startedAt: new Date().toISOString(), caseDeadlineMs: CASE_MS, totalBudgetMs: TOTAL_MS,
    diagnosticSha256: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"),
    uiInputPerformed: false, eventPostCalled: false, tccRequestsPerformed: false,
    rawStderrPersisted: false, environmentValuesPrinted: false,
    capabilityVerdict: "not-assessed-by-this-read-only-diagnostic", cases: results
  };
  try {
    for (const entry of probes) {
      if (performance.now() - started + CASE_MS + CLEANUP_MS + 500 >= TOTAL_MS) {
        report.remainingCasesSkipped = "total-budget-reserved-for-cleanup"; break;
      }
      const result = await runProbe(entry.name, entry.code);
      results.push(result);
      writeFileSync(join(directory, "diagnostic-progress.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      if (result.cleanupUncertain) throw new Error("Owned child exit was not observed; further cases stopped.");
    }
    report.status = "diagnostic-completed";
  } catch (error) {
    report.status = "diagnostic-stopped"; report.error = error instanceof Error ? error.message : "diagnostic-failed";
    process.exitCode = 1;
  } finally {
    report.elapsedMs = Math.round(performance.now() - started);
    report.completedAt = new Date().toISOString();
    writeFileSync(join(directory, "diagnostic.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}
main().catch(error => { process.stderr.write(error instanceof Error ? error.message + "\n" : "diagnostic-failed\n"); process.exitCode = 1; });
