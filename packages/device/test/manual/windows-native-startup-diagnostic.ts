/**
 * One-shot read-only Windows PowerShell startup/stdio diagnostic.
 * Build in CT102; run the prebuilt CJS on an ephemeral native Windows runner.
 * No UI input, permission changes, business config reads, or environment values.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { createHash } from "node:crypto";
import { nativeEnvironment, runNative } from "../../src/computer/native.js";

type InputMode = "ignore" | "pipe" | "file" | "pipe-destroy-after-finish";
type Probe = { name: string; env: NodeJS.ProcessEnv; inputMode: InputMode; args: string[]; input?: string };
type ProbeResult = {
  name: string; inputMode: InputMode; events: Array<{ name: string; ms: number; code?: unknown }>;
  stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number;
  timedOut: boolean; exitCode?: number | null; signal?: string | null; cleanupUncertain?: boolean; elapsedMs?: number;
};
const LIMIT_MS = 8000;
const OUTPUT_CAP = 16384;
const PREFIX = ["-NoLogo", "-NoProfile", "-NonInteractive"];
const VERSION = "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;pshome=$PSHOME}|ConvertTo-Json -Compress";
const LOADER = "[Console]::Error.WriteLine('DIAG_LOADER_ENTER');[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);$s=[Console]::In.ReadToEnd();[Console]::Error.WriteLine('DIAG_STDIN_READ_COMPLETE:'+ $s.Length);& ([scriptblock]::Create($s))";
const encoded = (script: string) => [...PREFIX, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const name = Object.keys(env).find(item => item.toLowerCase() === key.toLowerCase());
  return name === undefined ? undefined : env[name];
}

async function rawProbe(command: string, probe: Probe, directory: string): Promise<ProbeResult> {
  const started = performance.now();
  const result: ProbeResult = { name: probe.name, inputMode: probe.inputMode, events: [],
    stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, timedOut: false };
  const event = (name: string, code?: unknown) => result.events.push({
    name, ms: Math.round(performance.now() - started), ...(code === undefined ? {} : { code })
  });
  let descriptor: number | undefined;
  if (probe.inputMode === "file") {
    const path = join(directory, probe.name + ".stdin.txt");
    writeFileSync(path, probe.input ?? "", { flag: "wx", mode: 0o600 });
    descriptor = openSync(path, "r");
  }
  return new Promise<ProbeResult>(resolveResult => {
    let child: ChildProcess;
    try {
      child = spawn(command, probe.args, { env: probe.env, shell: false, windowsHide: true,
        detached: false, stdio: [descriptor ?? (probe.inputMode === "ignore" ? "ignore" : "pipe"), "pipe", "pipe"] });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    let finished = false, exited = false;
    let grace: NodeJS.Timeout | undefined, hardStop: NodeJS.Timeout | undefined;
    let killer: ChildProcess | undefined, killerDeadline: NodeJS.Timeout | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      if (hardStop) clearTimeout(hardStop);
      if (killerDeadline) clearTimeout(killerDeadline);
      if (killer && killer.exitCode === null && killer.signalCode === null) killer.kill("SIGKILL");
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      result.elapsedMs = Math.round(performance.now() - started);
      resolveResult(result);
    };
    const deadline = setTimeout(() => {
      result.timedOut = true;
      event("deadline", LIMIT_MS);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const taskkill = win32.join(envValue(process.env, "SystemRoot") ?? "C:\\Windows", "System32", "taskkill.exe");
        killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"],
          { env: process.env, stdio: "ignore", windowsHide: true });
        killer.on("error", error => { event("taskkill-error", (error as NodeJS.ErrnoException).code); child.kill("SIGKILL"); });
        killer.once("exit", code => { event("taskkill-exit", code); if (!exited) child.kill("SIGKILL"); });
        killerDeadline = setTimeout(() => { killer?.kill("SIGKILL"); if (!exited) child.kill("SIGKILL"); }, 2000);
      }
      hardStop = setTimeout(() => {
        if (!exited) { result.cleanupUncertain = true; event("owned-child-exit-not-observed"); }
        finish();
      }, 2600);
    }, LIMIT_MS);
    child.once("spawn", () => event("spawn", child.pid));
    child.once("error", error => { event("spawn-or-process-error", (error as NodeJS.ErrnoException).code); if (!child.pid) finish(); });
    child.once("exit", (code, signal) => {
      exited = true; result.exitCode = code; result.signal = signal; event("exit", { code, signal });
      grace = setTimeout(() => { event("stdio-grace-expired"); finish(); }, 400);
    });
    child.once("close", (code, signal) => { event("close", { code, signal }); finish(); });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (result.stdoutBytes === 0) event("first-stdout");
      result.stdoutBytes += chunk.length;
      if (Buffer.byteLength(result.stdout) < OUTPUT_CAP) result.stdout += chunk.toString("utf8").slice(0, OUTPUT_CAP - result.stdout.length);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (result.stderrBytes === 0) event("first-stderr");
      result.stderrBytes += chunk.length;
      if (Buffer.byteLength(result.stderr) < OUTPUT_CAP) result.stderr += chunk.toString("utf8").slice(0, OUTPUT_CAP - result.stderr.length);
    });
    if (child.stdin) {
      child.stdin.once("finish", () => {
        event("stdin-finish");
        if (probe.inputMode === "pipe-destroy-after-finish") { event("stdin-explicit-destroy"); child.stdin!.destroy(); }
      });
      child.stdin.once("close", () => event("stdin-close"));
      child.stdin.on("error", error => event("stdin-error", (error as NodeJS.ErrnoException).code));
      child.stdin.end(probe.input);
    }
  });
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Run this prebuilt read-only diagnostic on Windows.");
  const directory = resolve(process.argv[2] ?? "windows-native-startup-diagnostic");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const command = win32.join(envValue(process.env, "SystemRoot") ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(command)) throw new Error("System Windows PowerShell executable is absent.");
  const full = { ...process.env }, minimal = nativeEnvironment(full);
  const fallbackSource = { ...full };
  for (const key of Object.keys(fallbackSource)) {
    if (["programfiles", "programw6432"].includes(key.toLowerCase())) delete fallbackSource[key];
    if (key.toLowerCase() === "path") fallbackSource[key] = (fallbackSource[key] ?? "").split(";")
      .filter(path => !existsSync(win32.join(path.replace(/^"|"$/g, ""), "pwsh.exe"))).join(";");
  }
  const fallback = nativeEnvironment(fallbackSource);
  const payload = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + VERSION + ";exit 0";
  const probes: Probe[] = [
    { name: "01-full-command-ignore", env: full, inputMode: "ignore", args: [...PREFIX, "-Command", VERSION] },
    { name: "02-native-command-ignore", env: minimal, inputMode: "ignore", args: [...PREFIX, "-Command", VERSION] },
    { name: "03-full-command-empty-pipe", env: full, inputMode: "pipe", args: [...PREFIX, "-Command", VERSION] },
    { name: "04-native-command-empty-pipe", env: minimal, inputMode: "pipe", args: [...PREFIX, "-Command", VERSION] },
    { name: "05-native-command-pure-version", env: minimal, inputMode: "pipe", args: [...PREFIX, "-Command", "[Console]::WriteLine($PSVersionTable.PSVersion.ToString())"] },
    { name: "06-full-loader-pipe", env: full, inputMode: "pipe", args: encoded(LOADER), input: payload },
    { name: "07-native-loader-pipe", env: minimal, inputMode: "pipe", args: encoded(LOADER), input: payload },
    { name: "08-native-loader-file", env: minimal, inputMode: "file", args: encoded(LOADER), input: payload },
  ];
  const report: Record<string, unknown> = {
    schemaVersion: 1, platform: process.platform, node: process.version, executable: command,
    startedAt: new Date().toISOString(), caseDeadlineMs: LIMIT_MS, totalCases: probes.length + 1,
    environmentSummary: Object.fromEntries(["SystemRoot", "UserProfile", "PSModulePath", "ProgramFiles", "ProgramW6432", "TEMP", "PATH"]
      .map(key => [key, { full: envValue(full, key) !== undefined, native: envValue(minimal, key) !== undefined, fallback: envValue(fallback, key) !== undefined }])),
    cases: [] as unknown[], capabilityVerdict: "not-assessed-by-this-read-only-diagnostic",
    uiInputPerformed: false, environmentValuesPrinted: false,
    diagnosticSha256: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex")
  };
  const results = report.cases as unknown[];
  try {
    for (const probe of probes) {
      const result = await rawProbe(command, probe, directory);
      results.push(result);
      writeFileSync(join(directory, "diagnostic-progress.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      if (result.cleanupUncertain) throw new Error("An owned child did not confirm exit; further probes stopped.");
    }
    const started = performance.now();
    try {
      const actual = await runNative({ command, args: [...PREFIX, "-Command", VERSION], maxOutputBytes: OUTPUT_CAP }, { timeoutMs: LIMIT_MS });
      results.push({ name: "09-actual-runNative-command", elapsedMs: Math.round(performance.now() - started),
        exitCode: actual.exitCode, stdout: actual.stdout.toString("utf8"), stderr: actual.stderr.toString("utf8") });
    } catch (error) {
      results.push({ name: "09-actual-runNative-command", elapsedMs: Math.round(performance.now() - started),
        error: String(error), code: (error as { code?: string }).code });
    }
    report.status = "diagnostic-completed";
  } catch (error) {
    report.status = "diagnostic-stopped"; report.error = String(error); process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    const path = join(directory, "diagnostic.json");
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}
main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
